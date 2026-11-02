// Package worker implements the `arcade worker --mode=<mode>` subcommand used by
// the Lights Out (coin), Shock Absorber (burst) and Nitro (race) cabinets. See
// docs/contracts.md "Workers".
package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"sync/atomic"
	"time"
)

// Modes.
const (
	ModeCoin  = "coin"  // poll ARCADE_SERVER_URL/api/queue/claim and "process" coins
	ModeBurst = "burst" // CPU warm-up WARMUP_CPU_SECONDS (default 10) then /ready=200
	ModeRace  = "race"  // CPU warm-up WARMUP_CPU_SECONDS (default 20) then /ready=200
)

// Run dispatches on mode and blocks until ctx is cancelled or a fatal error.
func Run(ctx context.Context, mode string) error {
	log := slog.Default().With("component", "worker", "mode", mode)
	addr := envOr("WORKER_ADDR", ":8080")
	switch mode {
	case ModeCoin:
		c := CoinConfig{
			ServerURL:    os.Getenv("ARCADE_SERVER_URL"),
			WorkDuration: envSeconds("COIN_WORK_SECONDS", 8),
			PollInterval: envSeconds("COIN_POLL_SECONDS", 2),
			Logger:       log,
		}
		if c.ServerURL == "" {
			return errors.New("worker: ARCADE_SERVER_URL is required in coin mode")
		}
		ready := &atomic.Bool{}
		ready.Store(true)
		return serveAnd(ctx, addr, ready, log, func(ctx context.Context) error { return RunCoin(ctx, c) })
	case ModeBurst, ModeRace:
		def := 10.0
		if mode == ModeRace {
			def = 20
		}
		warm := envSeconds("WARMUP_CPU_SECONDS", def)
		ready := &atomic.Bool{}
		return serveAnd(ctx, addr, ready, log, func(ctx context.Context) error {
			start := time.Now()
			log.Info("warming up", "cpuSeconds", warm.Seconds())
			used, err := Warmup(ctx, warm)
			if err != nil {
				return err
			}
			ready.Store(true)
			wall := time.Since(start)
			log.Info("ready", "cpuSeconds", used.Seconds(), "wallSeconds", wall.Seconds(),
				"effectiveCores", float64(used)/float64(wall))
			<-ctx.Done()
			return nil
		})
	default:
		return fmt.Errorf("worker: unknown mode %q (want coin|burst|race)", mode)
	}
}

// serveAnd runs the probe server (/healthz always 200, /ready 200 once ready is
// true) alongside fn, and returns when either finishes.
func serveAnd(ctx context.Context, addr string, ready *atomic.Bool, log *slog.Logger, fn func(context.Context) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprintln(w, "ok") })
	mux.HandleFunc("GET /ready", func(w http.ResponseWriter, _ *http.Request) {
		if ready.Load() {
			fmt.Fprintln(w, "ready")
			return
		}
		http.Error(w, "warming up", http.StatusServiceUnavailable)
	})
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	errc := make(chan error, 2)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- fmt.Errorf("worker: http server: %w", err)
		}
	}()
	go func() { errc <- fn(ctx) }()
	var err error
	select {
	case <-ctx.Done():
	case err = <-errc:
	}
	shutdownCtx, c := context.WithTimeout(context.Background(), 2*time.Second)
	defer c()
	_ = srv.Shutdown(shutdownCtx)
	return err
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// envSeconds reads a float number of seconds from the environment.
func envSeconds(key string, def float64) time.Duration {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f >= 0 {
			return time.Duration(f * float64(time.Second))
		}
		slog.Warn("ignoring invalid duration", "env", key, "value", v)
	}
	return time.Duration(def * float64(time.Second))
}
