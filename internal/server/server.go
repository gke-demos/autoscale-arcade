// Package server is the arcade-server HTTP surface: WebSocket WorldState
// stream, actions, scenarios, leaderboard, coin queue, metrics and the
// embedded UI (docs/contracts.md).
package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
	"google.golang.org/api/idtoken"

	"github.com/gke-demos/autoscale-arcade/internal/actions"
	"github.com/gke-demos/autoscale-arcade/internal/scenario"
	"github.com/gke-demos/autoscale-arcade/internal/world"
)

// Config configures Run.
type Config struct {
	Addr        string
	Kubeconfig  string
	DevToken    string
	IAPAudience string
	PetToken    string
	ScenarioDir string
	Cluster     string
	Project     string
	Region      string
	RateLimit   float64
	Version     string
}

// Server holds the wired components.
type Server struct {
	cfg     Config
	log     *slog.Logger
	world   *world.World
	actions *actions.Actions
	runner  *scenario.Runner
	hub     *Hub
	limiter *clientLimiter
	leaders *Leaderboard
	started time.Time

	mu     sync.RWMutex
	latest *world.WorldState
}

// Run wires everything and serves until ctx is done.
func Run(ctx context.Context, cfg Config, log *slog.Logger) error {
	clients, err := world.NewClients(cfg.Kubeconfig)
	if err != nil {
		return err
	}
	w := world.New(world.Config{Kubeconfig: cfg.Kubeconfig, Cluster: cfg.Cluster, Project: cfg.Project, Region: cfg.Region}, clients, log.With("component", "world"))
	s := New(cfg, w, log)
	go func() {
		if err := w.Run(ctx); err != nil {
			log.Error("world", "err", err)
		}
	}()
	go s.loop(ctx)

	srv := &http.Server{Addr: cfg.Addr, Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}
	errCh := make(chan error, 1)
	go func() {
		log.Info("arcade-server listening", "addr", cfg.Addr, "version", cfg.Version, "dev_token", cfg.DevToken != "", "iap_audience", cfg.IAPAudience)
		errCh <- srv.ListenAndServe()
	}()
	select {
	case <-ctx.Done():
		s.runner.Stop()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	case err := <-errCh:
		return err
	}
}

// New builds a Server around an existing World (used by Run and tests).
func New(cfg Config, w *world.World, log *slog.Logger) *Server {
	if cfg.RateLimit <= 0 {
		cfg.RateLimit = 5
	}
	s := &Server{cfg: cfg, log: log, world: w, hub: NewHub(log), limiter: newClientLimiter(cfg.RateLimit), started: time.Now()}
	s.actions = actions.New(w, log.With("component", "actions"))
	s.runner = scenario.NewRunner(cfg.ScenarioDir, scenario.Env{
		State: s.State,
		Act:   s.actions.Do,
		Reset: s.actions.Reset,
		OnState: func(st world.ScenarioState) {
			w.SetScenario(st)
			s.hub.Broadcast(map[string]any{"type": "scenario", "scenario": st})
		},
		Log: log.With("component", "scenario"),
	})
	s.actions.Scenario = s.runner
	s.leaders = NewLeaderboard(w.Clients, log)
	w.Memory.OnPet(func(p world.PetState) { s.hub.BroadcastPet(s.petView(p)) })
	return s
}

// petView overrides pod/node in pet telemetry from the pet-0 informer: the
// pet's NODE_NAME env is restored with its memory and is stale after a live
// migration.
func (s *Server) petView(p world.PetState) world.PetState {
	if st := s.State(); st != nil {
		if pet := st.Cabinets.Teleporter.Pet; pet.Pod != "" {
			p.Pod = pet.Pod
			if pet.Node != "" {
				p.Node = pet.Node
			}
		}
	}
	return p
}

// State returns the latest snapshot (computing one if none yet).
func (s *Server) State() *world.WorldState {
	s.mu.RLock()
	st := s.latest
	s.mu.RUnlock()
	if st == nil {
		st = s.world.Snapshot()
		s.mu.Lock()
		s.latest = st
		s.mu.Unlock()
	}
	return st
}

// loop recomputes the snapshot when the world changes, coalesced to ≤ 4/s.
func (s *Server) loop(ctx context.Context) {
	const minInterval = 250 * time.Millisecond
	var last time.Time
	changed := s.world.Changed()
	for {
		select {
		case <-ctx.Done():
			return
		case <-changed:
		}
		if d := minInterval - time.Since(last); d > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(d):
			}
		}
		select { // fold any signal that arrived while debouncing
		case <-changed:
		default:
		}
		st := s.world.Snapshot()
		s.mu.Lock()
		s.latest = st
		s.mu.Unlock()
		last = time.Now()
		s.hub.Broadcast(map[string]any{"type": "snapshot", "state": st})
	}
}

// Handler builds the HTTP mux.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /metrics", s.handleMetrics)
	mux.HandleFunc("GET /ws", s.handleWS)
	mux.HandleFunc("GET /api/state", s.handleState)
	mux.HandleFunc("GET /api/scenarios", s.handleScenarios)
	mux.HandleFunc("GET /api/leaderboard", s.handleLeaderboardGet)
	mux.HandleFunc("GET /api/queue/claim", s.handleClaim)
	mux.HandleFunc("POST /api/pet", s.handlePetPost)
	mux.HandleFunc("GET /api/pet/ws", s.handlePetWS)
	mux.HandleFunc("GET /api/pet", s.handlePetGet)
	mux.Handle("POST /api/leaderboard", s.mutating(http.HandlerFunc(s.handleLeaderboardPost)))
	mux.Handle("POST /api/actions/{name}", s.mutating(http.HandlerFunc(s.handleAction)))
	mux.Handle("/", UIHandler())
	return logging(s.log, mux)
}

// ---- auth + rate limiting ----

// mutating wraps a handler with IAP-JWT / dev-token auth and a per-client rate limit.
func (s *Server) mutating(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.limiter.allow(clientKey(r)) {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"ok": false, "error": "rate limited (5 req/s)"})
			return
		}
		if err := s.authorize(r); err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) authorize(r *http.Request) error {
	if s.cfg.DevToken != "" {
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") && strings.TrimPrefix(h, "Bearer ") == s.cfg.DevToken {
			return nil
		}
	}
	if jwt := r.Header.Get("x-goog-iap-jwt-assertion"); jwt != "" {
		if s.cfg.IAPAudience == "" {
			return errors.New("IAP_AUDIENCE not configured")
		}
		if _, err := idtoken.Validate(r.Context(), jwt, s.cfg.IAPAudience); err != nil {
			return fmt.Errorf("invalid IAP JWT: %w", err)
		}
		return nil
	}
	if s.cfg.DevToken == "" && s.cfg.IAPAudience == "" {
		// Neither configured: refuse rather than run an open actuator.
		return errors.New("no auth configured (set ARCADE_DEV_TOKEN or IAP_AUDIENCE)")
	}
	return errors.New("unauthorized")
}

func clientKey(r *http.Request) string {
	if xf := r.Header.Get("X-Forwarded-For"); xf != "" {
		return strings.TrimSpace(strings.Split(xf, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

type clientLimiter struct {
	mu    sync.Mutex
	rps   float64
	seen  map[string]*rate.Limiter
	since map[string]time.Time
}

func newClientLimiter(rps float64) *clientLimiter {
	return &clientLimiter{rps: rps, seen: map[string]*rate.Limiter{}, since: map[string]time.Time{}}
}

func (c *clientLimiter) allow(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	l, ok := c.seen[key]
	if !ok {
		l = rate.NewLimiter(rate.Limit(c.rps), int(c.rps)+1)
		c.seen[key] = l
		if len(c.seen) > 10000 { // crude GC
			c.seen = map[string]*rate.Limiter{key: l}
		}
	}
	return l.Allow()
}

// ---- handlers ----

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": s.cfg.Version, "uptime": time.Since(s.started).Round(time.Second).String(), "missingCRDs": s.world.Missing()})
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.State())
}

func (s *Server) handleScenarios(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.runner.List())
}

func (s *Server) handleAction(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	if err := s.actions.Do(ctx, name, body); err != nil {
		code := http.StatusInternalServerError
		if errors.Is(err, actions.ErrUnknown) {
			code = http.StatusNotFound
		} else if strings.Contains(err.Error(), "required") || strings.Contains(err.Error(), "bad body") || strings.Contains(err.Error(), "unknown preset") {
			code = http.StatusBadRequest
		}
		s.log.Warn("action failed", "action", name, "err", err)
		s.hub.Broadcast(map[string]any{"type": "toast", "level": "error", "text": name + ": " + err.Error()})
		writeJSON(w, code, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleClaim lets a coin worker claim one coin: 200 {"coin":n} or 204.
func (s *Server) handleClaim(w http.ResponseWriter, r *http.Request) {
	if !s.world.Memory.Claim() {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	_, processed := s.world.Memory.QueueDepth()
	writeJSON(w, http.StatusOK, map[string]any{"coin": processed, "workSeconds": 8})
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	depth, processed := s.world.Memory.QueueDepth()
	metricLoad, targetPods, metricHits, _ := s.world.Memory.MetricsGame()
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	fmt.Fprintf(w, "# HELP arcade_queue_depth Coins waiting in the Lights Out queue.\n# TYPE arcade_queue_depth gauge\narcade_queue_depth %d\n", depth)
	fmt.Fprintf(w, "# HELP arcade_coins_processed_total Coins claimed by workers.\n# TYPE arcade_coins_processed_total counter\narcade_coins_processed_total %d\n", processed)
	fmt.Fprintf(w, "# HELP arcade_metric_load Custom Prometheus metric load set by the Metric Dialer slider (req/s).\n# TYPE arcade_metric_load gauge\narcade_metric_load %d\n", metricLoad)
	fmt.Fprintf(w, "# HELP arcade_metric_target_pods Current target pod count challenge in Metric Dialer (1..10).\n# TYPE arcade_metric_target_pods gauge\narcade_metric_target_pods %d\n", targetPods)
	fmt.Fprintf(w, "# HELP arcade_metric_hits_total Target pod count bullseyes scored in Metric Dialer.\n# TYPE arcade_metric_hits_total counter\narcade_metric_hits_total %d\n", metricHits)
	fmt.Fprintf(w, "# HELP arcade_ws_clients Connected UI WebSocket clients.\n# TYPE arcade_ws_clients gauge\narcade_ws_clients %d\n", s.hub.Count())
	_, petConnected := s.world.Memory.Pet()
	fmt.Fprintf(w, "# HELP arcade_pet_connected 1 while the pet streams telemetry.\n# TYPE arcade_pet_connected gauge\narcade_pet_connected %d\n", b2i(petConnected))
	fmt.Fprintf(w, "# HELP arcade_scenario_running 1 while a scenario runs.\n# TYPE arcade_scenario_running gauge\narcade_scenario_running %d\n", b2i(s.runner.State().Running))
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// ---- pet telemetry ----

func (s *Server) petAuthorized(r *http.Request) bool {
	if s.cfg.PetToken == "" {
		return true
	}
	return r.Header.Get("Authorization") == "Bearer "+s.cfg.PetToken || r.URL.Query().Get("token") == s.cfg.PetToken
}

func (s *Server) handlePetPost(w http.ResponseWriter, r *http.Request) {
	if !s.petAuthorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var p world.PetState
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&p); err != nil {
		http.Error(w, "bad PetState: "+err.Error(), http.StatusBadRequest)
		return
	}
	s.world.Memory.PetTelemetry(p)
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) handlePetGet(w http.ResponseWriter, r *http.Request) {
	p, connected := s.world.Memory.Pet()
	if p != nil {
		v := s.petView(*p)
		p = &v
	}
	writeJSON(w, http.StatusOK, map[string]any{"connected": connected, "pet": p})
}

func (s *Server) handlePetWS(w http.ResponseWriter, r *http.Request) {
	if !s.petAuthorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(1 << 16)
	for {
		var p world.PetState
		if err := conn.ReadJSON(&p); err != nil {
			return
		}
		s.world.Memory.PetTelemetry(p)
	}
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

type statusWriter struct {
	http.ResponseWriter
	code int
}

func (s *statusWriter) WriteHeader(c int) { s.code = c; s.ResponseWriter.WriteHeader(c) }

// Hijack is needed so WebSocket upgrades work through the logging wrapper.
func (s *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := s.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("not a hijacker")
	}
	return h.Hijack()
}

func (s *statusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func logging(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/pet" || r.URL.Path == "/api/queue/claim" || r.URL.Path == "/healthz" || r.URL.Path == "/metrics" {
			next.ServeHTTP(w, r) // high-frequency / probe endpoints: don't log
			return
		}
		sw := &statusWriter{ResponseWriter: w, code: 200}
		start := time.Now()
		next.ServeHTTP(sw, r)
		log.Debug("http", "method", r.Method, "path", r.URL.Path, "code", sw.code, "ms", time.Since(start).Milliseconds())
	})
}
