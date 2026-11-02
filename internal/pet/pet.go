package pet

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// State is the PetState wire shape from docs/contracts.md.
type State struct {
	Pod        string  `json:"pod"`
	Node       string  `json:"node"`
	Ticks      uint64  `json:"ticks"`
	Score      uint64  `json:"score"`
	Lives      int     `json:"lives"`
	UptimeSec  float64 `json:"uptimeSec"`
	Ball       Ball    `json:"ball"`
	RestoredAt string  `json:"restoredAt,omitempty"`
	BornAt     string  `json:"bornAt"`
}

// Config controls a Pet. Zero values are replaced by defaults in New.
type Config struct {
	Pod          string        // POD_NAME, falls back to hostname
	Node         string        // NODE_NAME (downward API); stale after a restore, the server overrides it
	TickInterval time.Duration // 100ms => 10 ticks/s
	GapThreshold time.Duration // a tick gap longer than this counts as a migration (default 2s)
	ServerURL    string        // ARCADE_SERVER_URL; empty disables reporting
	ReportPath   string        // default /api/pet
	ReportToken  string        // ARCADE_PET_TOKEN; sent as a bearer token when set
	ListenAddr   string        // default :8080
	SpecEnviron  string        // file with the restored pod's env (default /proc/gvisor/spec_environ)
	Logger       *slog.Logger
}

// Pet is the running arcade pet.
type Pet struct {
	cfg Config

	mu         sync.Mutex
	sim        *Sim
	lives      int
	bornAt     time.Time
	restoredAt time.Time
	lastTick   time.Time
	frozen     time.Duration // total wall time spent frozen across all restores
}

// New creates a Pet with defaults filled in from the environment.
func New(cfg Config) *Pet {
	if cfg.Pod == "" {
		cfg.Pod = os.Getenv("POD_NAME")
	}
	if cfg.Pod == "" {
		cfg.Pod, _ = os.Hostname()
	}
	if cfg.Node == "" {
		cfg.Node = os.Getenv("NODE_NAME")
	}
	if cfg.TickInterval <= 0 {
		cfg.TickInterval = 100 * time.Millisecond
	}
	if cfg.GapThreshold <= 0 {
		cfg.GapThreshold = envDuration("PET_GAP_THRESHOLD", 2*time.Second)
	}
	if cfg.ServerURL == "" {
		cfg.ServerURL = os.Getenv("ARCADE_SERVER_URL")
	}
	if cfg.ReportPath == "" {
		cfg.ReportPath = envOr("PET_REPORT_PATH", "/api/pet")
	}
	if cfg.ReportToken == "" {
		cfg.ReportToken = os.Getenv("ARCADE_PET_TOKEN")
	}
	if cfg.ListenAddr == "" {
		cfg.ListenAddr = envOr("PET_ADDR", ":8080")
	}
	if cfg.SpecEnviron == "" {
		cfg.SpecEnviron = envOr("PET_SPEC_ENVIRON", "/proc/gvisor/spec_environ")
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	now := time.Now()
	return &Pet{cfg: cfg, sim: NewSim(), bornAt: now, lastTick: now}
}

// Tick advances the simulation by one tick at wall time now. If the gap since
// the previous tick exceeds GapThreshold the process was frozen (checkpointed
// and restored elsewhere): that is a life gained, not lost. Returns true when a
// restore was detected.
func (p *Pet) Tick(now time.Time) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	// Strip monotonic clock readings (.Round(0)) so wall-clock jumps across a
	// gVisor checkpoint/restore are measured even when CLOCK_MONOTONIC resumes
	// from its checkpointed value.
	gap := now.Round(0).Sub(p.lastTick.Round(0))
	if gap <= 0 {
		gap = now.Sub(p.lastTick)
	}
	p.lastTick = now
	p.sim.Step(p.cfg.TickInterval)
	if gap > p.cfg.GapThreshold {
		p.lives++
		p.restoredAt = now
		p.frozen += gap - p.cfg.TickInterval
		if newNode := specEnvironValue(p.cfg.SpecEnviron, "NODE_NAME"); newNode != "" {
			p.cfg.Node = newNode
		}
		return true
	}
	return false
}

// specEnvironValue reads KEY=VALUE pairs (NUL- or newline-separated, like
// /proc/<pid>/environ) from path and returns the value for key, or "" if the
// file is missing or the key is absent.
func specEnvironValue(path, key string) string {
	if path == "" {
		return ""
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	for _, kv := range strings.FieldsFunc(string(b), func(r rune) bool { return r == 0 || r == '\n' }) {
		if k, v, ok := strings.Cut(kv, "="); ok && k == key {
			return v
		}
	}
	return ""
}

// Snapshot returns the current PetState.
func (p *Pet) Snapshot(now time.Time) State {
	p.mu.Lock()
	defer p.mu.Unlock()
	s := State{
		Pod:       p.cfg.Pod,
		Node:      p.cfg.Node,
		Ticks:     p.sim.Ticks,
		Score:     p.sim.Score,
		Lives:     p.lives,
		UptimeSec: now.Sub(p.bornAt).Seconds(),
		Ball:      p.sim.Ball,
		BornAt:    p.bornAt.UTC().Format(time.RFC3339Nano),
	}
	if !p.restoredAt.IsZero() {
		s.RestoredAt = p.restoredAt.UTC().Format(time.RFC3339Nano)
	}
	return s
}

// Run is the `arcade pet` subcommand: ticks the simulation 10 times a second,
// serves /healthz and /state on :8080 and streams PetState to the arcade
// server at ARCADE_SERVER_URL/api/pet.
func Run(ctx context.Context) error {
	return New(Config{}).Run(ctx)
}

// Run ticks, serves and reports until ctx is cancelled.
func (p *Pet) Run(ctx context.Context) error { return p.runWithAddr(ctx, nil) }

// runWithAddr is Run; if addr is non-nil the bound listen address is sent on it.
func (p *Pet) runWithAddr(ctx context.Context, addr chan<- string) error {
	log := p.cfg.Logger.With("component", "pet", "pod", p.cfg.Pod)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprintln(w, "ok") })
	mux.HandleFunc("GET /state", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(p.Snapshot(time.Now()))
	})
	errc := make(chan error, 1)
	startHTTP := func(first bool) (*http.Server, error) {
		ln, err := net.Listen("tcp", p.cfg.ListenAddr)
		if err != nil {
			return nil, fmt.Errorf("pet: listen %s: %w", p.cfg.ListenAddr, err)
		}
		if first && addr != nil {
			addr <- ln.Addr().String()
		}
		srv := &http.Server{Addr: p.cfg.ListenAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
		go func() {
			if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) {
				select {
				case errc <- err:
				default:
				}
			}
		}()
		return srv, nil
	}
	srv, err := startHTTP(true)
	if err != nil {
		return err
	}
	defer func() {
		if srv != nil {
			shutdownCtx, c := context.WithTimeout(context.Background(), 2*time.Second)
			defer c()
			_ = srv.Shutdown(shutdownCtx)
		}
	}()

	var reporter *reporter
	if p.cfg.ServerURL != "" {
		reporter = newReporter(strings.TrimRight(p.cfg.ServerURL, "/")+p.cfg.ReportPath, p.cfg.ReportToken, log)
		log.Info("reporting pet state", "url", reporter.url)
	} else {
		log.Warn("ARCADE_SERVER_URL not set; pet state is only served on /state")
	}
	log.Info("pet born", "node", p.cfg.Node, "addr", p.cfg.ListenAddr, "tick", p.cfg.TickInterval)

	ticker := time.NewTicker(p.cfg.TickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Info("pet stopping", "ticks", p.Snapshot(time.Now()).Ticks)
			return nil
		case err := <-errc:
			return fmt.Errorf("pet: http server: %w", err)
		case now := <-ticker.C:
			if p.Tick(now) {
				s := p.Snapshot(now)
				log.Info("restored from snapshot: same memory, new life", "lives", s.Lives, "ticks", s.Ticks, "node", s.Node, "frozen", p.frozenTotal())
				if reporter != nil {
					reporter.resetClient()
				}
				// Re-bind the HTTP listener after a gVisor restore so the new
				// sandbox's netstack accepts probes on the restored pod IP.
				if srv != nil && addr == nil {
					_ = srv.Close()
					if next, err := startHTTP(false); err != nil {
						log.Warn("re-listen after restore failed", "err", err)
						srv = nil
					} else {
						srv = next
					}
				}
			}
			if reporter != nil {
				reporter.send(ctx, p.Snapshot(now))
			}
		}
	}
}

func (p *Pet) frozenTotal() time.Duration {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.frozen
}

// reporter POSTs PetState to the arcade server. Sends are fire-and-forget and
// coalesced: if a request is still in flight the tick is skipped, unless the
// in-flight request has been stuck for >800ms wall-clock (e.g. across a gVisor
// checkpoint/restore), in which case a fresh HTTP transport is created.
type reporter struct {
	url           string
	token         string
	log           *slog.Logger
	mu            sync.Mutex
	client        *http.Client
	inflight      bool
	inflightSince time.Time
	gen           uint64
	lastErr       time.Time
	errs          int
}

func newHTTPClient() *http.Client {
	return &http.Client{
		Timeout:   1500 * time.Millisecond,
		Transport: &http.Transport{DisableKeepAlives: true},
	}
}

func newReporter(url, token string, log *slog.Logger) *reporter {
	return &reporter{
		url:    url,
		token:  token,
		client: newHTTPClient(),
		log:    log,
	}
}

func (r *reporter) resetClient() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.client.CloseIdleConnections()
	r.client = newHTTPClient()
	r.inflight = false
	r.gen++
}

func (r *reporter) send(ctx context.Context, s State) {
	now := time.Now()
	r.mu.Lock()
	if r.inflight {
		if now.Round(0).Sub(r.inflightSince.Round(0)) < 800*time.Millisecond {
			r.mu.Unlock()
			return
		}
		// Previous request wedged across checkpoint/restore: swap client.
		r.client = newHTTPClient()
		r.gen++
	}
	r.inflight = true
	r.inflightSince = now
	client := r.client
	myGen := r.gen
	r.mu.Unlock()

	body, _ := json.Marshal(s)
	go func() {
		defer func() {
			r.mu.Lock()
			if r.gen == myGen {
				r.inflight = false
			}
			r.mu.Unlock()
		}()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.url, bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		if r.token != "" {
			req.Header.Set("Authorization", "Bearer "+r.token)
		}
		resp, err := client.Do(req)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode < 300 {
				r.mu.Lock()
				if r.errs > 0 {
					r.log.Info("pet report recovered", "after", r.errs)
					r.errs = 0
				}
				r.mu.Unlock()
				return
			}
			err = fmt.Errorf("status %s", resp.Status)
		}
		r.mu.Lock()
		r.errs++
		errs := r.errs
		shouldLog := time.Since(r.lastErr) > 10*time.Second
		if shouldLog {
			r.lastErr = time.Now()
		}
		r.mu.Unlock()
		if shouldLog {
			r.log.Warn("pet report failed", "err", err, "failures", errs)
		}
	}()
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	if d, err := time.ParseDuration(v); err == nil {
		return d
	}
	if secs, err := strconv.ParseFloat(v, 64); err == nil {
		return time.Duration(secs * float64(time.Second))
	}
	return def
}
