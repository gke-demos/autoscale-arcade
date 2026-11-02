package scenario

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/gke-demos/autoscale-arcade/internal/world"
)

func sampleState() *world.WorldState {
	return &world.WorldState{
		Ts: "2026-11-02T12:00:00Z",
		Cabinets: world.Cabinets{
			Teleporter: world.TeleporterState{
				Pet:  world.PetRef{Pod: "pet-0", Node: "gke-gvisor-1", Connected: true},
				Jobs: []world.MigrationJob{{Name: "pmj-1", Phase: "Succeeded"}},
				LastMigration: &world.LastMigration{From: "a", To: "b", DowntimeMs: 6900, Restored: "inferred"},
			},
			Lights: world.LightsState{QueueDepth: 3, HPA: world.HPAState{ScaledToZero: true, Current: 0}},
			Spot:   world.SpotState{SpotRatio: 80, Counts: world.SpotCounts{Spot: 4, OnDemand: 2}},
		},
	}
}

func TestLookup(t *testing.T) {
	m := toMap(sampleState())
	cases := []struct {
		path string
		want any
		ok   bool
	}{
		{"cabinets.teleporter.jobs[0].phase", "Succeeded", true},
		{"cabinets.teleporter.pet.node", "gke-gvisor-1", true},
		{"cabinets.lights.queueDepth", float64(3), true},
		{"cabinets.teleporter.jobs[5].phase", nil, false},
		{"cabinets.nope.x", nil, false},
	}
	for _, c := range cases {
		got, ok := Lookup(m, c.path)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("%s: got %v,%v want %v,%v", c.path, got, ok, c.want, c.ok)
		}
	}
}

func TestMatch(t *testing.T) {
	st := sampleState()
	f := func(v float64) *float64 { return &v }
	tr := true
	fa := false
	cases := []struct {
		name    string
		wf      WaitFor
		cabinet string
		want    bool
	}{
		{"in", WaitFor{Path: "cabinets.teleporter.jobs[0].phase", In: []any{"Succeeded", "Failed"}}, "", true},
		{"in-miss", WaitFor{Path: "cabinets.teleporter.jobs[0].phase", In: []any{"Failed"}}, "", false},
		{"equals", WaitFor{Path: "jobs[0].phase", Equals: "Succeeded"}, "teleporter", true},
		{"equals-num", WaitFor{Path: "queueDepth", Equals: 3}, "lights", true},
		{"gte", WaitFor{Path: "counts.spot", Gte: f(4)}, "spot", true},
		{"gte-fail", WaitFor{Path: "counts.spot", Gte: f(5)}, "spot", false},
		{"lte", WaitFor{Path: "hpa.current", Lte: f(0)}, "lights", true},
		{"truthy", WaitFor{Path: "hpa.scaledToZero", Truthy: &tr}, "lights", true},
		{"falsy-missing", WaitFor{Path: "race", Truthy: &fa}, "nitro", true},
		{"truthy-missing", WaitFor{Path: "race", Truthy: &tr}, "nitro", false},
		{"default-truthy", WaitFor{Path: "pet.connected"}, "teleporter", true},
	}
	for _, c := range cases {
		if got := Match(&c.wf, st, c.cabinet); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestRenderCaption(t *testing.T) {
	st := sampleState()
	got := RenderCaption("All of the pet's state lives in memory on {{ .pet.node }}.", st, "teleporter")
	if got != "All of the pet's state lives in memory on gke-gvisor-1." {
		t.Errorf("caption: %q", got)
	}
	got = RenderCaption("{{ .lastMigration.downtimeMs }} ms of downtime ({{ .lastMigration.restored }})", st, "teleporter")
	if got != "6900 ms of downtime (inferred)" {
		t.Errorf("caption: %q", got)
	}
	got = RenderCaption("ratio {{ .spotRatio }}% → {{ .counts.spot }} spot", st, "spot")
	if got != "ratio 80% → 4 spot" {
		t.Errorf("caption: %q", got)
	}
	if got = RenderCaption("{{ .missing.deep }}", st, "spot"); got != "" {
		t.Errorf("missing should render empty, got %q", got)
	}
}

func TestParse(t *testing.T) {
	src := []byte(`
name: pod-teleporter
cabinet: teleporter
title: "Pod Teleporter"
steps:
  - caption: "hello {{ .pet.node }}"
    wait: 5s
  - caption: "Teleporting…"
    action: { name: teleporter.random }
    waitFor: { path: "cabinets.teleporter.jobs[0].phase", in: ["Succeeded", "Failed"], timeout: 180s }
  - action: { name: climber.scale, replicas: 24 }
    waitFor: { path: "ready", gte: 24, timeout: 2m, }
    onTimeout: continue
`)
	s, err := Parse(src, "x")
	if err != nil {
		t.Fatal(err)
	}
	if s.Name != "pod-teleporter" || s.Cabinet != "teleporter" || len(s.Steps) != 3 {
		t.Fatalf("%+v", s)
	}
	if time.Duration(s.Steps[0].Wait) != 5*time.Second {
		t.Errorf("wait: %v", s.Steps[0].Wait)
	}
	if s.Steps[1].Action.Name != "teleporter.random" || time.Duration(s.Steps[1].WaitFor.Timeout) != 180*time.Second {
		t.Errorf("step 2: %+v", s.Steps[1])
	}
	if s.Steps[2].Action.Body["replicas"] != float64(24) || *s.Steps[2].WaitFor.Gte != 24 || s.Steps[2].OnTimeout != "continue" {
		t.Errorf("step 3: %+v %+v", s.Steps[2].Action, s.Steps[2].WaitFor)
	}
}

// TestRunnerEndToEnd runs a two-cabinet "all" scenario with a fake Act/State.
func TestRunnerEndToEnd(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("lights-out.yaml", `
name: lights-out
cabinet: lights
steps:
  - caption: "coins: {{ .queueDepth }}"
    action: { name: lights.coin, count: 5 }
    waitFor: { path: "queueDepth", gte: 5, timeout: 5s }
  - caption: done
`)
	write("nitro.yaml", `
name: nitro
cabinet: nitro
steps:
  - action: { name: nitro.race }
    waitFor: { path: "race.winner", truthy: true, timeout: 200ms }
    onTimeout: continue
`)
	write("all.yaml", "name: all\ncabinets: [lights, nitro]\n")

	var mu sync.Mutex
	st := sampleState()
	st.Cabinets.Lights.QueueDepth = 0
	var acted []string
	var resets []string
	var states []world.ScenarioState
	env := Env{
		State: func() *world.WorldState { mu.Lock(); defer mu.Unlock(); cp := *st; return &cp },
		Act: func(ctx context.Context, name string, body json.RawMessage) error {
			mu.Lock()
			defer mu.Unlock()
			acted = append(acted, name+string(body))
			if name == "lights.coin" {
				st.Cabinets.Lights.QueueDepth += 5
			}
			return nil
		},
		Reset:   func(ctx context.Context, cab string) error { mu.Lock(); resets = append(resets, cab); mu.Unlock(); return nil },
		OnState: func(s world.ScenarioState) { mu.Lock(); states = append(states, s); mu.Unlock() },
	}
	r := NewRunner(dir, env)
	if infos := r.List(); len(infos) != 3 {
		t.Fatalf("list: %+v", infos)
	}
	if err := r.Run("all"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for r.State().Running || len(states) == 0 {
		if time.Now().After(deadline) {
			t.Fatalf("scenario did not finish: %+v", r.State())
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	if len(acted) != 2 || acted[0] != `lights.coin{"count":5}` || acted[1] != "nitro.race{}" {
		t.Errorf("actions: %v", acted)
	}
	final := states[len(states)-1]
	if final.Running || final.Error != "" {
		t.Errorf("final: %+v", final)
	}
	sawCaption := false
	for _, s := range states {
		if s.Caption == "coins: 0" && s.Cabinet == "lights" && s.Name == "lights-out" && s.Steps == 2 && s.Step == 1 {
			sawCaption = true
		}
	}
	if !sawCaption {
		t.Errorf("caption not published: %+v", states)
	}
	if len(resets) != 0 {
		t.Errorf("all.yaml must not reset: %v", resets)
	}
	mu.Unlock()

	// attract = all + loop + resetBetween; Stop() must end it.
	if err := r.Run("attract"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if !r.State().Running || !r.State().Attract {
		t.Errorf("attract should be running: %+v", r.State())
	}
	r.Stop()
	if r.State().Running {
		t.Errorf("still running after stop")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(resets) == 0 {
		t.Errorf("attract should reset between cabinets")
	}
}
