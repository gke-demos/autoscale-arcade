package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
	kubefake "k8s.io/client-go/kubernetes/fake"

	"github.com/gke-demos/autoscale-arcade/internal/world"
)

func newTestServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	kube := kubefake.NewSimpleClientset()
	clients := &world.Clients{Kube: kube, Discovery: kube.Discovery()}
	w := world.New(world.Config{Cluster: "test"}, clients, slog.Default())
	s := New(Config{DevToken: "secret", RateLimit: 5, ScenarioDir: t.TempDir()}, w, slog.Default())
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return s, ts
}

func TestAuthAndRateLimit(t *testing.T) {
	_, ts := newTestServer(t)
	post := func(token string) int {
		req, _ := http.NewRequest("POST", ts.URL+"/api/actions/lights.coin", strings.NewReader(`{"count":1}`))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if code := post(""); code != http.StatusUnauthorized {
		t.Errorf("no token: %d", code)
	}
	if code := post("wrong"); code != http.StatusUnauthorized {
		t.Errorf("wrong token: %d", code)
	}
	if code := post("secret"); code != http.StatusOK {
		t.Errorf("dev token: %d", code)
	}
	limited := false
	for i := 0; i < 20; i++ {
		if post("secret") == http.StatusTooManyRequests {
			limited = true
		}
	}
	if !limited {
		t.Error("expected 429 after a burst")
	}
}

func TestStateMetricsAndClaim(t *testing.T) {
	s, ts := newTestServer(t)
	s.world.Memory.Enqueue(2)
	resp, _ := http.Get(ts.URL + "/metrics")
	body := readAll(t, resp)
	if !strings.Contains(body, "arcade_queue_depth 2") {
		t.Errorf("metrics: %s", body)
	}
	resp, _ = http.Get(ts.URL + "/api/queue/claim")
	if resp.StatusCode != 200 || !strings.Contains(readAll(t, resp), `"coin":1`) {
		t.Errorf("claim: %d", resp.StatusCode)
	}
	http.Get(ts.URL + "/api/queue/claim")
	resp, _ = http.Get(ts.URL + "/api/queue/claim")
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("empty claim: %d", resp.StatusCode)
	}
	resp, _ = http.Get(ts.URL + "/api/state")
	var st world.WorldState
	if err := json.NewDecoder(resp.Body).Decode(&st); err != nil {
		t.Fatal(err)
	}
	if st.Cluster.Name != "test" || st.Nodes == nil || st.Pods == nil || st.Events == nil || st.Cabinets.Lights.Processed != 2 {
		t.Errorf("state: %+v", st.Cluster)
	}
	resp, _ = http.Get(ts.URL + "/healthz")
	if resp.StatusCode != 200 {
		t.Error("healthz")
	}
	resp, _ = http.Get(ts.URL + "/some/spa/route")
	if resp.StatusCode != 200 || !strings.Contains(readAll(t, resp), "Autoscale Arcade") {
		t.Error("UI fallback should serve the placeholder")
	}
}

func TestPetRelayOverWS(t *testing.T) {
	_, ts := newTestServer(t)
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(ts.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	var first map[string]any
	if err := ws.ReadJSON(&first); err != nil || first["type"] != "snapshot" {
		t.Fatalf("first message must be a snapshot: %v %v", first["type"], err)
	}
	resp, err := http.Post(ts.URL+"/api/pet", "application/json", strings.NewReader(`{"pod":"pet-0","node":"n1","ticks":5,"score":1,"lives":0,"uptimeSec":1,"ball":{"x":0,"y":0,"vx":1,"vy":1},"bornAt":"2026-11-02T00:00:00Z"}`))
	if err != nil || resp.StatusCode != http.StatusAccepted {
		t.Fatalf("pet post: %v %v", err, resp.StatusCode)
	}
	var msg struct {
		Type string         `json:"type"`
		Pet  world.PetState `json:"pet"`
	}
	for i := 0; i < 5; i++ {
		if err := ws.ReadJSON(&msg); err != nil {
			t.Fatal(err)
		}
		if msg.Type == "pet" {
			break
		}
	}
	if msg.Type != "pet" || msg.Pet.Ticks != 5 {
		t.Errorf("pet relay: %+v", msg)
	}
	resp, _ = http.Get(ts.URL + "/api/pet")
	if !strings.Contains(readAll(t, resp), `"connected":true`) {
		t.Error("pet should be connected")
	}
}

func TestLeaderboard(t *testing.T) {
	_, ts := newTestServer(t)
	req, _ := http.NewRequest("POST", ts.URL+"/api/leaderboard", strings.NewReader(`{"cabinet":"absorber","initials":"abc","score":42.5,"unit":"s"}`))
	req.Header.Set("Authorization", "Bearer secret")
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("post: %v %d", err, resp.StatusCode)
	}
	req, _ = http.NewRequest("POST", ts.URL+"/api/leaderboard", strings.NewReader(`{"cabinet":"absorber","initials":"zz","score":12,"unit":"s"}`))
	req.Header.Set("Authorization", "Bearer secret")
	http.DefaultClient.Do(req)
	resp, _ = http.Get(ts.URL + "/api/leaderboard?cabinet=absorber")
	var entries []Entry
	json.NewDecoder(resp.Body).Decode(&entries)
	if len(entries) != 2 || entries[0].Initials != "ZZ" || entries[1].Initials != "ABC" {
		t.Errorf("lower-is-better ordering: %+v", entries)
	}
	req, _ = http.NewRequest("POST", ts.URL+"/api/leaderboard", strings.NewReader(`{"cabinet":"nope","initials":"x","score":1}`))
	req.Header.Set("Authorization", "Bearer secret")
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("unknown cabinet: %d", resp.StatusCode)
	}
}

func readAll(t *testing.T, resp *http.Response) string {
	t.Helper()
	defer resp.Body.Close()
	var sb strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		sb.Write(buf[:n])
		if err != nil {
			break
		}
	}
	return sb.String()
}
