package pet

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestSimStaysInBoundsAndScores(t *testing.T) {
	s := NewSim()
	for i := 0; i < 10_000; i++ {
		s.Step(100 * time.Millisecond)
		if s.Ball.X < 0 || s.Ball.X > 1 || s.Ball.Y < 0 || s.Ball.Y > 1 {
			t.Fatalf("tick %d: ball out of bounds: %+v", i, s.Ball)
		}
	}
	if s.Ticks != 10_000 {
		t.Fatalf("ticks = %d, want 10000", s.Ticks)
	}
	// 1000 s at |vx|=0.37 crosses the box ~370 times, |vy|=0.23 ~230 times.
	if s.Score < 500 || s.Score > 700 {
		t.Fatalf("score = %d, want roughly 600", s.Score)
	}
}

func TestSimIsDeterministic(t *testing.T) {
	a, b := NewSim(), NewSim()
	for i := 0; i < 5000; i++ {
		a.Step(100 * time.Millisecond)
		b.Step(100 * time.Millisecond)
	}
	if *a != *b {
		t.Fatalf("simulations diverged: %+v vs %+v", a, b)
	}
}

func TestSimCornerBonus(t *testing.T) {
	s := &Sim{Ball: Ball{X: 0.99, Y: 0.99, VX: 1, VY: 1}}
	s.Step(100 * time.Millisecond)
	if s.Score != 10 {
		t.Fatalf("corner hit score = %d, want 10", s.Score)
	}
	if s.Ball.VX != -1 || s.Ball.VY != -1 {
		t.Fatalf("velocity not reflected: %+v", s.Ball)
	}
}

func TestTickDetectsRestoreGap(t *testing.T) {
	p := New(Config{Pod: "pet-0", Node: "n1", TickInterval: 100 * time.Millisecond, GapThreshold: 2 * time.Second})
	start := p.lastTick
	now := start
	for i := 0; i < 20; i++ {
		now = now.Add(100 * time.Millisecond)
		if p.Tick(now) {
			t.Fatalf("tick %d: spurious restore", i)
		}
	}
	// The pod is frozen for 7 s (snapshot → restore on another node) and the
	// process resumes with its memory intact: that's a life, not a reset.
	now = now.Add(7 * time.Second)
	if !p.Tick(now) {
		t.Fatal("7 s gap not detected as a restore")
	}
	s := p.Snapshot(now)
	if s.Lives != 1 || s.Ticks != 21 || s.RestoredAt == "" || s.Pod != "pet-0" {
		t.Fatalf("unexpected state after restore: %+v", s)
	}
	if got := p.frozenTotal(); got < 6*time.Second || got > 7*time.Second {
		t.Fatalf("frozen = %v, want ≈6.9s", got)
	}
	if p.Tick(now.Add(100 * time.Millisecond)) {
		t.Fatal("second restore reported without a gap")
	}
}

func TestRunServesAndReports(t *testing.T) {
	var reports atomic.Int64
	var last atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/pet" || r.Method != http.MethodPost {
			t.Errorf("unexpected report %s %s", r.Method, r.URL.Path)
		}
		b, _ := io.ReadAll(r.Body)
		last.Store(b)
		reports.Add(1)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	p := New(Config{Pod: "pet-0", Node: "n1", TickInterval: 20 * time.Millisecond, ServerURL: srv.URL, ListenAddr: "127.0.0.1:0"})
	// Use an ephemeral port: bind first so we know the address.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	addr := make(chan string, 1)
	go func() { _ = p.runWithAddr(ctx, addr) }()
	base := <-addr

	deadline := time.Now().Add(3 * time.Second)
	for reports.Load() < 5 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if reports.Load() < 5 {
		t.Fatalf("only %d reports received", reports.Load())
	}
	var st State
	if err := json.Unmarshal(last.Load().([]byte), &st); err != nil {
		t.Fatal(err)
	}
	if st.Pod != "pet-0" || st.Ticks == 0 || st.BornAt == "" {
		t.Fatalf("bad report: %+v", st)
	}

	resp, err := http.Get("http://" + base + "/state")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var served State
	if err := json.NewDecoder(resp.Body).Decode(&served); err != nil {
		t.Fatal(err)
	}
	if served.Ticks < st.Ticks {
		t.Fatalf("/state ticks %d went backwards vs report %d", served.Ticks, st.Ticks)
	}
	hz, err := http.Get("http://" + base + "/healthz")
	if err != nil || hz.StatusCode != 200 {
		t.Fatalf("healthz: %v %v", err, hz)
	}
	hz.Body.Close()
}
