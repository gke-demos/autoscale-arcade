package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/gke-demos/autoscale-arcade/internal/world"
)

// Entry is one leaderboard row.
type Entry struct {
	Cabinet  string  `json:"cabinet"`
	Initials string  `json:"initials"`
	Score    float64 `json:"score"`
	Unit     string  `json:"unit,omitempty"`
	At       string  `json:"at"`
}

// Leaderboard persists entries in ConfigMap/arcade-leaderboard (arcade-system),
// so they survive server restarts and are visible with kubectl.
type Leaderboard struct {
	clients *world.Clients
	log     *slog.Logger
	mu      sync.Mutex
}

const (
	leaderboardName = "arcade-leaderboard"
	leaderboardKey  = "entries.json"
	maxEntries      = 200
)

// NewLeaderboard creates a leaderboard store.
func NewLeaderboard(c *world.Clients, log *slog.Logger) *Leaderboard {
	return &Leaderboard{clients: c, log: log}
}

func (l *Leaderboard) load(ctx context.Context) ([]Entry, *corev1.ConfigMap, error) {
	cm, err := l.clients.Kube.CoreV1().ConfigMaps(world.NamespaceSystem).Get(ctx, leaderboardName, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return []Entry{}, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	var entries []Entry
	if raw := cm.Data[leaderboardKey]; raw != "" {
		if err := json.Unmarshal([]byte(raw), &entries); err != nil {
			l.log.Warn("leaderboard: bad JSON in ConfigMap; starting fresh", "err", err)
		}
	}
	if entries == nil {
		entries = []Entry{}
	}
	return entries, cm, nil
}

// List returns entries (optionally filtered by cabinet), best first.
func (l *Leaderboard) List(ctx context.Context, cabinet string) ([]Entry, error) {
	entries, _, err := l.load(ctx)
	if err != nil {
		return nil, err
	}
	var out []Entry
	for _, e := range entries {
		if cabinet == "" || e.Cabinet == cabinet {
			out = append(out, e)
		}
	}
	sortEntries(out)
	if out == nil {
		out = []Entry{}
	}
	return out, nil
}

// lowerIsBetter cabinets score in milliseconds / dollars.
func lowerIsBetter(cabinet, unit string) bool {
	switch unit {
	case "ms", "s", "sec", "usd", "$":
		return true
	}
	return cabinet == world.CabinetTeleporter || cabinet == world.CabinetAbsorber || cabinet == world.CabinetNitro
}

func sortEntries(es []Entry) {
	sort.SliceStable(es, func(i, j int) bool {
		if es[i].Cabinet != es[j].Cabinet {
			return es[i].Cabinet < es[j].Cabinet
		}
		if lowerIsBetter(es[i].Cabinet, es[i].Unit) {
			return es[i].Score < es[j].Score
		}
		return es[i].Score > es[j].Score
	})
}

// Add appends an entry and writes the ConfigMap (create or update).
func (l *Leaderboard) Add(ctx context.Context, e Entry) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	entries, cm, err := l.load(ctx)
	if err != nil {
		return err
	}
	e.At = time.Now().UTC().Format(time.RFC3339)
	entries = append(entries, e)
	if len(entries) > maxEntries {
		entries = entries[len(entries)-maxEntries:]
	}
	raw, _ := json.Marshal(entries)
	cms := l.clients.Kube.CoreV1().ConfigMaps(world.NamespaceSystem)
	if cm == nil {
		cm = &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: leaderboardName, Namespace: world.NamespaceSystem,
				Labels: map[string]string{world.LabelPartOf: world.PartOfValue}},
			Data: map[string]string{leaderboardKey: string(raw)},
		}
		_, err = cms.Create(ctx, cm, metav1.CreateOptions{FieldManager: "arcade"})
		return err
	}
	if cm.Data == nil {
		cm.Data = map[string]string{}
	}
	cm.Data[leaderboardKey] = string(raw)
	_, err = cms.Update(ctx, cm, metav1.UpdateOptions{FieldManager: "arcade"})
	return err
}

func (s *Server) handleLeaderboardGet(w http.ResponseWriter, r *http.Request) {
	entries, err := s.leaders.List(r.Context(), r.URL.Query().Get("cabinet"))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *Server) handleLeaderboardPost(w http.ResponseWriter, r *http.Request) {
	var e Entry
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&e); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "bad body: " + err.Error()})
		return
	}
	e.Initials = strings.ToUpper(strings.TrimSpace(e.Initials))
	if len(e.Initials) > 3 {
		e.Initials = e.Initials[:3]
	}
	if e.Initials == "" {
		e.Initials = "???"
	}
	valid := false
	for _, id := range world.CabinetIDs {
		if e.Cabinet == id {
			valid = true
		}
	}
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "unknown cabinet"})
		return
	}
	if err := s.leaders.Add(r.Context(), e); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	s.hub.Broadcast(map[string]any{"type": "toast", "level": "info", "text": e.Initials + " joined the " + e.Cabinet + " leaderboard"})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
