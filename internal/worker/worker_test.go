package worker

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

func TestWarmupBurnsRequestedCPUTime(t *testing.T) {
	const want = 300 * time.Millisecond
	wallStart := time.Now()
	used, err := Warmup(context.Background(), want)
	wall := time.Since(wallStart)
	if err != nil {
		t.Fatal(err)
	}
	if used < want {
		t.Fatalf("used %v CPU, want >= %v", used, want)
	}
	// Overshoot is bounded by one hashing batch (~1 ms) plus scheduler noise.
	if used > want+50*time.Millisecond {
		t.Fatalf("used %v CPU, overshoot too large (want ≈ %v)", used, want)
	}
	// Single-threaded busy work cannot finish faster than its CPU time.
	if wall < want {
		t.Fatalf("wall %v < cpu %v: warm-up is not single-core CPU bound", wall, want)
	}
}

func TestWarmupIsCancellable(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := Warmup(ctx, 30*time.Second)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want deadline exceeded", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("cancel took %v", time.Since(start))
	}
}

func TestWarmupZeroIsNoop(t *testing.T) {
	if used, err := Warmup(context.Background(), 0); err != nil || used != 0 {
		t.Fatalf("got %v, %v", used, err)
	}
}

func TestReadyFlipsAfterWarmup(t *testing.T) {
	t.Setenv("WARMUP_CPU_SECONDS", "0.2")
	t.Setenv("WORKER_ADDR", "127.0.0.1:18089")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- Run(ctx, ModeBurst) }()

	// Wait for the probe server to come up: it must answer 503 while warming.
	var sawNotReady bool
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get("http://127.0.0.1:18089/ready")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusServiceUnavailable {
				sawNotReady = true
				break
			}
			if resp.StatusCode == http.StatusOK {
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !sawNotReady {
		t.Log("warm-up finished before the first probe; readiness gating not observed")
	}
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get("http://127.0.0.1:18089/ready")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				cancel()
				if err := <-done; err != nil {
					t.Fatalf("Run returned %v", err)
				}
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("/ready never became 200")
}

func TestCoinWorkerClaimsAndWorks(t *testing.T) {
	var claims, coins atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/queue/claim" {
			http.NotFound(w, r)
			return
		}
		n := claims.Add(1)
		if n <= 3 {
			coins.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"coin":` + strconv.Itoa(int(n)) + `}`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	start := time.Now()
	err := RunCoin(ctx, CoinConfig{ServerURL: srv.URL, WorkDuration: 50 * time.Millisecond, PollInterval: 20 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if coins.Load() != 3 {
		t.Fatalf("claimed %d coins, want 3", coins.Load())
	}
	// Three coins × 50 ms of work must have elapsed, then polling until timeout.
	if elapsed := time.Since(start); elapsed < 150*time.Millisecond {
		t.Fatalf("finished in %v, work time not honoured", elapsed)
	}
	if claims.Load() < 10 {
		t.Fatalf("only %d claim polls on an empty queue", claims.Load())
	}
}

func TestRunRejectsUnknownMode(t *testing.T) {
	if err := Run(context.Background(), "bogus"); err == nil {
		t.Fatal("expected error for unknown mode")
	}
}
