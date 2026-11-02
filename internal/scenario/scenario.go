// Package scenario runs scenarios/<name>.yaml: the scripts behind every ▶
// button, "play all" and attract mode (docs/contracts.md).
package scenario

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"text/template"
	"time"

	"sigs.k8s.io/yaml"

	"github.com/gke-demos/autoscale-arcade/internal/world"
)

// Scenario is one YAML file.
type Scenario struct {
	Name         string   `json:"name"`
	Cabinet      string   `json:"cabinet,omitempty"`
	Title        string   `json:"title,omitempty"`
	Steps        []Step   `json:"steps,omitempty"`
	Cabinets     []string `json:"cabinets,omitempty"`  // all.yaml / attract.yaml: cabinet ids in order
	Scenarios    []string `json:"scenarios,omitempty"` // alternative to Cabinets: scenario names
	Loop         bool     `json:"loop,omitempty"`
	ResetBetween bool     `json:"resetBetween,omitempty"`
}

// Step is one scripted step.
type Step struct {
	Caption   string   `json:"caption,omitempty"`
	Wait      Duration `json:"wait,omitempty"`
	Action    *Action  `json:"action,omitempty"`
	WaitFor   *WaitFor `json:"waitFor,omitempty"`
	OnTimeout string   `json:"onTimeout,omitempty"` // "continue" | "" (fail)
}

// Action is `{name: climber.scale, replicas: 24}`: name plus inline body
// fields (or an explicit `body:` map).
type Action struct {
	Name string
	Body map[string]any
}

func (a *Action) UnmarshalJSON(b []byte) error {
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return err
	}
	a.Name, _ = m["name"].(string)
	a.Body = map[string]any{}
	if body, ok := m["body"].(map[string]any); ok {
		for k, v := range body {
			a.Body[k] = v
		}
	}
	for k, v := range m {
		if k == "name" || k == "body" {
			continue
		}
		a.Body[k] = v
	}
	return nil
}

// WaitFor polls a dotted path into WorldState until the matcher holds.
type WaitFor struct {
	Path    string   `json:"path"`
	Equals  any      `json:"equals,omitempty"`
	In      []any    `json:"in,omitempty"`
	Gte     *float64 `json:"gte,omitempty"`
	Lte     *float64 `json:"lte,omitempty"`
	Truthy  *bool    `json:"truthy,omitempty"`
	Timeout Duration `json:"timeout,omitempty"`
}

// Duration parses "5s" / "180s" / "2m".
type Duration time.Duration

func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		if s == "" {
			*d = 0
			return nil
		}
		v, err := time.ParseDuration(s)
		if err != nil {
			return err
		}
		*d = Duration(v)
		return nil
	}
	var f float64
	if err := json.Unmarshal(b, &f); err != nil {
		return err
	}
	*d = Duration(time.Duration(f * float64(time.Second)))
	return nil
}

// Info is what GET /api/scenarios returns.
type Info struct {
	Name     string   `json:"name"`
	Cabinet  string   `json:"cabinet,omitempty"`
	Title    string   `json:"title,omitempty"`
	Steps    int      `json:"steps"`
	Captions []string `json:"captions"`
	Loop     bool     `json:"loop,omitempty"`
}

// Env is what the runner needs from the rest of the server.
type Env struct {
	State   func() *world.WorldState
	Act     func(ctx context.Context, name string, body json.RawMessage) error
	Reset   func(ctx context.Context, cabinet string) error
	OnState func(world.ScenarioState)
	Log     *slog.Logger
}

// Runner loads and runs scenarios. One scenario runs at a time.
type Runner struct {
	dir string
	env Env

	mu     sync.Mutex
	cancel context.CancelFunc
	done   chan struct{}
	state  world.ScenarioState
}

// NewRunner creates a runner for the YAML files in dir.
func NewRunner(dir string, env Env) *Runner {
	if env.Log == nil {
		env.Log = slog.Default()
	}
	return &Runner{dir: dir, env: env}
}

// Load reads scenarios/<name>.yaml.
func (r *Runner) Load(name string) (*Scenario, error) {
	name = strings.TrimSuffix(filepath.Base(name), ".yaml")
	b, err := os.ReadFile(filepath.Join(r.dir, name+".yaml"))
	if err != nil {
		if name == "attract" {
			// attract = all with loop + resetBetween when no file exists.
			all, err2 := r.Load("all")
			if err2 == nil {
				all.Name, all.Loop, all.ResetBetween = "attract", true, true
				return all, nil
			}
		}
		return nil, fmt.Errorf("scenario %q: %w", name, err)
	}
	return Parse(b, name)
}

// Parse parses a scenario YAML document.
func Parse(b []byte, defaultName string) (*Scenario, error) {
	var s Scenario
	if err := yaml.Unmarshal(b, &s); err != nil {
		return nil, fmt.Errorf("parse scenario %s: %w", defaultName, err)
	}
	if s.Name == "" {
		s.Name = defaultName
	}
	for i, st := range s.Steps {
		if st.Action != nil && st.Action.Name == "" {
			return nil, fmt.Errorf("scenario %s step %d: action without name", s.Name, i+1)
		}
	}
	return &s, nil
}

// List returns every scenario in the directory, sorted by name.
func (r *Runner) List() []Info {
	var out []Info
	entries, _ := os.ReadDir(r.dir)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".yaml") {
			continue
		}
		s, err := r.Load(e.Name())
		if err != nil {
			r.env.Log.Warn("scenario", "file", e.Name(), "err", err)
			continue
		}
		info := Info{Name: s.Name, Cabinet: s.Cabinet, Title: s.Title, Steps: len(s.Steps), Loop: s.Loop, Captions: []string{}}
		for _, st := range s.Steps {
			if st.Caption != "" {
				info.Captions = append(info.Captions, st.Caption)
			}
		}
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	if out == nil {
		out = []Info{}
	}
	return out
}

// State returns the current scenario state.
func (r *Runner) State() world.ScenarioState {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.state
}

func (r *Runner) publish(mut func(*world.ScenarioState)) {
	r.mu.Lock()
	mut(&r.state)
	st := r.state
	r.mu.Unlock()
	if r.env.OnState != nil {
		r.env.OnState(st)
	}
}

// Run starts a scenario by name ("all" runs every cabinet, "attract" loops).
// A running scenario is stopped first.
func (r *Runner) Run(name string) error {
	if name == "" {
		return errors.New("scenario name required")
	}
	s, err := r.Resolve(name)
	if err != nil {
		return err
	}
	r.Stop()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	r.mu.Lock()
	r.cancel, r.done = cancel, done
	r.mu.Unlock()
	go func() {
		defer close(done)
		err := r.run(ctx, s)
		r.publish(func(st *world.ScenarioState) {
			st.Running = false
			st.Attract = false
			if err != nil && ctx.Err() == nil {
				st.Error = err.Error()
			} else if ctx.Err() != nil {
				st.Caption = ""
			}
		})
	}()
	return nil
}

// Stop cancels the running scenario (no-op when idle).
func (r *Runner) Stop() {
	r.mu.Lock()
	cancel, done := r.cancel, r.done
	r.cancel, r.done = nil, nil
	r.mu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
}

func (r *Runner) run(ctx context.Context, s *Scenario) error {
	attract := s.Loop
	for {
		if err := r.runOnce(ctx, s, attract); err != nil {
			if !s.Loop || ctx.Err() != nil {
				return err
			}
			r.env.Log.Warn("scenario failed; attract loop continues", "scenario", s.Name, "err", err)
			r.publish(func(st *world.ScenarioState) { st.Error = err.Error() })
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(5 * time.Second):
			}
		}
		if !s.Loop {
			return nil
		}
	}
}

func (r *Runner) runOnce(ctx context.Context, s *Scenario, attract bool) error {
	children := s.Scenarios
	for _, c := range s.Cabinets {
		children = append(children, c)
	}
	if len(children) == 0 {
		return r.runSteps(ctx, s, attract)
	}
	for _, childName := range children {
		child, err := r.loadChild(childName)
		if err != nil {
			return err
		}
		if s.ResetBetween && r.env.Reset != nil && child.Cabinet != "" {
			_ = r.env.Reset(ctx, child.Cabinet)
		}
		if err := r.runSteps(ctx, child, attract); err != nil {
			return err
		}
		if s.ResetBetween && r.env.Reset != nil && child.Cabinet != "" {
			_ = r.env.Reset(ctx, child.Cabinet)
		}
	}
	return nil
}

// aliases map the cabinets' display slugs to their ids so either naming works
// from the UI, the Makefile and the terminal.
var aliases = map[string]string{
	"capacity-climber": world.CabinetClimber,
	"spot-on":          world.CabinetSpot,
	"pod-teleporter":   world.CabinetTeleporter,
	"shock-absorber":   world.CabinetAbsorber,
	"lights-out":       world.CabinetLights,
}

// Resolve finds a scenario by file name, by its `name:`/`cabinet:` field, or
// by a well-known alias (capacity-climber → climber, ...).
func (r *Runner) Resolve(name string) (*Scenario, error) {
	if s, err := r.Load(name); err == nil {
		return s, nil
	}
	if s, err := r.loadChild(name); err == nil {
		return s, nil
	}
	if id, ok := aliases[name]; ok {
		return r.loadChild(id)
	}
	return nil, fmt.Errorf("scenario %q not found in %s", name, r.dir)
}

// loadChild resolves an entry of all.yaml: a scenario name or a cabinet id.
func (r *Runner) loadChild(name string) (*Scenario, error) {
	if s, err := r.Load(name); err == nil {
		return s, nil
	}
	entries, _ := os.ReadDir(r.dir)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".yaml") {
			continue
		}
		s, err := r.Load(e.Name())
		if err == nil && (s.Cabinet == name || s.Name == name) && len(s.Cabinets) == 0 && len(s.Scenarios) == 0 {
			return s, nil
		}
	}
	return nil, fmt.Errorf("no scenario for %q", name)
}

func (r *Runner) runSteps(ctx context.Context, s *Scenario, attract bool) error {
	started := time.Now()
	r.publish(func(st *world.ScenarioState) {
		*st = world.ScenarioState{Running: true, Name: s.Name, Cabinet: s.Cabinet, Steps: len(s.Steps), StartedAt: started.UTC().Format(time.RFC3339), Attract: attract}
	})
	for i, step := range s.Steps {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		caption := r.caption(step.Caption, s.Cabinet)
		r.publish(func(st *world.ScenarioState) { st.Step = i + 1; st.Caption = caption; st.Error = "" })
		r.env.Log.Info("scenario step", "scenario", s.Name, "step", i+1, "caption", caption)
		prevJob := ""
		if step.Action != nil {
			if strings.HasPrefix(step.Action.Name, "teleporter.") {
				if v, ok := Lookup(toMap(r.env.State()), "cabinets.teleporter.jobs[0].name"); ok {
					prevJob, _ = v.(string)
				}
			}
			body, _ := json.Marshal(step.Action.Body)
			if err := r.env.Act(ctx, step.Action.Name, body); err != nil {
				return fmt.Errorf("step %d (%s): %w", i+1, step.Action.Name, err)
			}
			if step.WaitFor != nil {
				// Let the server's 250ms coalesced snapshot loop publish the
				// post-action WorldState before polling waitFor.
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(300 * time.Millisecond):
				}
			}
		}
		if step.WaitFor != nil {
			if err := r.waitFor(ctx, step.WaitFor, s.Cabinet, prevJob); err != nil {
				if step.OnTimeout == "continue" && errors.Is(err, errTimeout) {
					r.env.Log.Warn("waitFor timed out; continuing", "scenario", s.Name, "step", i+1, "path", step.WaitFor.Path)
				} else {
					return fmt.Errorf("step %d: %w", i+1, err)
				}
			}
		}
		if step.Wait > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(step.Wait)):
			}
		}
	}
	return nil
}

var errTimeout = errors.New("timeout")

func (r *Runner) waitFor(ctx context.Context, wf *WaitFor, cabinet, prevJob string) error {
	timeout := time.Duration(wf.Timeout)
	if timeout == 0 {
		timeout = 3 * time.Minute
	}
	deadline := time.Now().Add(timeout)
	for {
		st := r.env.State()
		skipStaleJob := false
		if prevJob != "" && strings.Contains(wf.Path, "jobs[0]") {
			curJob, _ := Lookup(toMap(st), "cabinets.teleporter.jobs[0].name")
			if curJob == nil || curJob == prevJob {
				skipStaleJob = true
			}
		}
		if !skipStaleJob && Match(wf, st, cabinet) {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%w waiting for %s", errTimeout, wf.Path)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// caption renders a Go template over the cabinet's state (`.` =
// cabinets.<id>) plus .lastMigration and .now.
func (r *Runner) caption(tmpl, cabinet string) string {
	if tmpl == "" || !strings.Contains(tmpl, "{{") {
		return tmpl
	}
	return RenderCaption(tmpl, r.env.State(), cabinet)
}

// RenderCaption renders a caption template; errors fall back to the raw text.
func RenderCaption(tmpl string, st *world.WorldState, cabinet string) string {
	data := templateData(st, cabinet)
	t, err := template.New("caption").Option("missingkey=zero").Funcs(template.FuncMap{
		"ms":   func(v any) string { return fmt.Sprintf("%.0f", toFloat(v)) },
		"secs": func(v any) string { return fmt.Sprintf("%.1f", toFloat(v)/1000) },
		"len":  func(v any) int { s, _ := v.([]any); return len(s) },
	}).Parse(tmpl)
	if err != nil {
		return tmpl
	}
	var buf bytes.Buffer
	// On a mid-template error (e.g. a field of a nil map) keep the partial
	// render: a caption with a blank is better than raw template syntax.
	_ = t.Execute(&buf, data)
	return strings.ReplaceAll(buf.String(), "<no value>", "")
}

func templateData(st *world.WorldState, cabinet string) map[string]any {
	m := toMap(st)
	data := map[string]any{}
	if cabs, ok := m["cabinets"].(map[string]any); ok {
		if c, ok := cabs[cabinet].(map[string]any); ok {
			for k, v := range c {
				data[k] = v
			}
		}
		if tp, ok := cabs["teleporter"].(map[string]any); ok {
			data["lastMigration"] = tp["lastMigration"]
			if cabinet == "" {
				data["pet"] = tp["pet"]
			}
		}
		data["cabinets"] = cabs
	}
	data["cluster"] = m["cluster"]
	data["now"] = time.Now().UTC().Format(time.RFC3339)
	return data
}

// toMap converts WorldState to a generic JSON map for path lookups.
func toMap(st *world.WorldState) map[string]any {
	if st == nil {
		return map[string]any{}
	}
	b, _ := json.Marshal(st)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}

// Match evaluates a waitFor matcher against the state. Cabinet-relative paths
// may omit the "cabinets.<id>." prefix.
func Match(wf *WaitFor, st *world.WorldState, cabinet string) bool {
	m := toMap(st)
	v, ok := Lookup(m, wf.Path)
	if !ok && cabinet != "" && !strings.HasPrefix(wf.Path, "cabinets.") {
		v, ok = Lookup(m, "cabinets."+cabinet+"."+wf.Path)
	}
	if wf.Truthy != nil {
		return truthy(v) == *wf.Truthy
	}
	if !ok {
		return false
	}
	if wf.Equals != nil {
		return looseEqual(v, wf.Equals)
	}
	if len(wf.In) > 0 {
		for _, x := range wf.In {
			if looseEqual(v, x) {
				return true
			}
		}
		return false
	}
	f, isNum := asFloat(v)
	if wf.Gte != nil && (!isNum || f < *wf.Gte) {
		return false
	}
	if wf.Lte != nil && (!isNum || f > *wf.Lte) {
		return false
	}
	if wf.Gte == nil && wf.Lte == nil {
		return truthy(v)
	}
	return true
}

// Lookup resolves "cabinets.teleporter.jobs[0].phase" style paths.
func Lookup(m any, path string) (any, bool) {
	cur := m
	for _, seg := range strings.Split(path, ".") {
		if seg == "" {
			continue
		}
		key := seg
		var idx []int
		for strings.HasSuffix(key, "]") {
			open := strings.LastIndex(key, "[")
			if open < 0 {
				return nil, false
			}
			var n int
			if _, err := fmt.Sscanf(key[open+1:len(key)-1], "%d", &n); err != nil {
				return nil, false
			}
			idx = append([]int{n}, idx...)
			key = key[:open]
		}
		if key != "" {
			obj, ok := cur.(map[string]any)
			if !ok {
				return nil, false
			}
			cur, ok = obj[key]
			if !ok {
				return nil, false
			}
		}
		for _, n := range idx {
			arr, ok := cur.([]any)
			if !ok || n < 0 || n >= len(arr) {
				return nil, false
			}
			cur = arr[n]
		}
	}
	return cur, true
}

func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != "" && t != "false" && t != "0"
	case float64:
		return t != 0
	case []any:
		return len(t) > 0
	case map[string]any:
		return len(t) > 0
	}
	return true
}

func asFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case int:
		return float64(t), true
	case int64:
		return float64(t), true
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	case string:
		var f float64
		if _, err := fmt.Sscanf(t, "%g", &f); err == nil {
			return f, true
		}
	}
	return 0, false
}

func toFloat(v any) float64 { f, _ := asFloat(v); return f }

func looseEqual(a, b any) bool {
	if fa, ok := asFloat(a); ok {
		if fb, ok := asFloat(b); ok {
			return fa == fb
		}
	}
	return fmt.Sprint(a) == fmt.Sprint(b)
}
