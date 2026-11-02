package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/gke-demos/autoscale-arcade/internal/world"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 64 << 10,
	// The UI is served from the same origin (behind IAP) and the Vite dev
	// server proxies /ws; allow any origin so port-forward + dev work.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Hub fans WorldState snapshots, scenario updates, toasts and pet telemetry
// out to the connected UI WebSocket clients.
type Hub struct {
	log     *slog.Logger
	mu      sync.RWMutex
	clients map[*client]struct{}

	petMu   sync.Mutex
	lastPet time.Time
}

type client struct {
	conn *websocket.Conn
	send chan []byte
}

// NewHub creates an empty hub.
func NewHub(log *slog.Logger) *Hub {
	return &Hub{log: log, clients: map[*client]struct{}{}}
}

// Count returns the number of connected clients.
func (h *Hub) Count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// Broadcast sends a JSON message to every client (dropping it for slow ones).
func (h *Hub) Broadcast(msg any) {
	b, err := json.Marshal(msg)
	if err != nil {
		h.log.Error("marshal ws message", "err", err)
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		select {
		case c.send <- b:
		default:
			// Slow consumer: drop this frame; the next snapshot supersedes it.
		}
	}
}

// BroadcastPet relays pet telemetry at ≤ 10/s.
func (h *Hub) BroadcastPet(p world.PetState) {
	h.petMu.Lock()
	if time.Since(h.lastPet) < 100*time.Millisecond {
		h.petMu.Unlock()
		return
	}
	h.lastPet = time.Now()
	h.petMu.Unlock()
	h.Broadcast(map[string]any{"type": "pet", "pet": p})
}

// handleWS upgrades the connection, sends a full snapshot first, then streams.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.log.Warn("ws upgrade", "err", err)
		return
	}
	c := &client{conn: conn, send: make(chan []byte, 32)}
	first, _ := json.Marshal(map[string]any{"type": "snapshot", "state": s.State()})
	c.send <- first
	if sc := s.runner.State(); sc.Running {
		b, _ := json.Marshal(map[string]any{"type": "scenario", "scenario": sc})
		c.send <- b
	}
	if pet, connected := s.world.Memory.Pet(); connected && pet != nil {
		b, _ := json.Marshal(map[string]any{"type": "pet", "pet": pet})
		c.send <- b
	}
	s.hub.mu.Lock()
	s.hub.clients[c] = struct{}{}
	n := len(s.hub.clients)
	s.hub.mu.Unlock()
	s.log.Info("ws client connected", "clients", n, "remote", clientKey(r))

	go s.hub.writePump(c)
	s.hub.readPump(c)
}

func (h *Hub) remove(c *client) {
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.send)
	}
	h.mu.Unlock()
}

func (h *Hub) readPump(c *client) {
	defer func() {
		h.remove(c)
		c.conn.Close()
	}()
	c.conn.SetReadLimit(1 << 16)
	_ = c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	c.conn.SetPongHandler(func(string) error { return c.conn.SetReadDeadline(time.Now().Add(90 * time.Second)) })
	for {
		// The UI sends nothing meaningful; reads only detect close/pong.
		if _, _, err := c.conn.ReadMessage(); err != nil {
			return
		}
		_ = c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	}
}

func (h *Hub) writePump(c *client) {
	ping := time.NewTicker(30 * time.Second)
	defer func() {
		ping.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				h.remove(c)
				return
			}
		case <-ping.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				h.remove(c)
				return
			}
		}
	}
}
