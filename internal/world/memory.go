package world

import (
	"sync"
	"time"
)

// Memory is the arcade server's own bookkeeping: things that are not cluster
// objects but that the UI needs (the coin queue behind arcade_queue_depth, the
// stockout lever, race/burst stopwatches, pet telemetry). Everything here is
// surfaced in WorldState explicitly so the UI never has to guess.
type Memory struct {
	mu sync.Mutex

	queue     []time.Time // pending coins (enqueue time)
	processed int

	stockout bool

	burstStartedAt time.Time
	burstTarget    int
	burstPriorUIDs map[string]bool
	raceStartedAt  time.Time
	racePriorUIDs  map[string]bool

	pet         *PetState
	petSeen     time.Time
	petHandlers []func(PetState)

	onChange func()
}

// NewMemory returns an empty Memory. onChange (may be nil) is called after any
// mutation that should trigger a new WorldState snapshot.
func NewMemory(onChange func()) *Memory { return &Memory{onChange: onChange} }

func (m *Memory) changed() {
	if m.onChange != nil {
		m.onChange()
	}
}

// Enqueue adds n coins to the queue.
func (m *Memory) Enqueue(n int) {
	m.mu.Lock()
	now := time.Now()
	for i := 0; i < n; i++ {
		m.queue = append(m.queue, now)
	}
	m.mu.Unlock()
	m.changed()
}

// Claim pops one coin; ok is false when the queue is empty.
func (m *Memory) Claim() (ok bool) {
	m.mu.Lock()
	if len(m.queue) == 0 {
		m.mu.Unlock()
		return false
	}
	m.queue = m.queue[1:]
	m.processed++
	m.mu.Unlock()
	m.changed()
	return true
}

// DrainQueue empties the queue (used by reset).
func (m *Memory) DrainQueue() {
	m.mu.Lock()
	m.queue = nil
	m.mu.Unlock()
	m.changed()
}

// QueueDepth returns pending coins and the number processed so far.
func (m *Memory) QueueDepth() (depth, processed int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.queue), m.processed
}

func (m *Memory) SetStockout(on bool) {
	m.mu.Lock()
	m.stockout = on
	m.mu.Unlock()
	m.changed()
}

func (m *Memory) Stockout() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.stockout
}

func (m *Memory) StartBurst(t time.Time, target int, priorUIDs map[string]bool) {
	m.mu.Lock()
	m.burstStartedAt = t
	m.burstTarget = target
	m.burstPriorUIDs = priorUIDs
	m.mu.Unlock()
	m.changed()
}

func (m *Memory) SetBurstStarted(t time.Time) {
	m.StartBurst(t, 0, nil)
}

func (m *Memory) BurstStarted() time.Time {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.burstStartedAt
}

func (m *Memory) BurstInfo() (time.Time, int, map[string]bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.burstStartedAt, m.burstTarget, m.burstPriorUIDs
}

func (m *Memory) StartRace(t time.Time, priorUIDs map[string]bool) {
	m.mu.Lock()
	m.raceStartedAt = t
	m.racePriorUIDs = priorUIDs
	m.mu.Unlock()
	m.changed()
}

func (m *Memory) SetRaceStarted(t time.Time) {
	m.StartRace(t, nil)
}

func (m *Memory) RaceStarted() time.Time {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.raceStartedAt
}

func (m *Memory) RaceInfo() (time.Time, map[string]bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.raceStartedAt, m.racePriorUIDs
}

// PetTelemetry records the latest PetState from the pet and fans it out to
// subscribers (the WebSocket hub).
func (m *Memory) PetTelemetry(p PetState) {
	m.mu.Lock()
	prevPod := ""
	if m.pet != nil {
		prevPod = m.pet.Pod + "@" + m.pet.Node
	}
	wasConnected := time.Since(m.petSeen) < PetTimeout
	m.pet = &p
	m.petSeen = time.Now()
	handlers := append([]func(PetState){}, m.petHandlers...)
	m.mu.Unlock()
	for _, h := range handlers {
		h(p)
	}
	if !wasConnected || prevPod != p.Pod+"@"+p.Node {
		m.changed()
	}
}

// OnPet registers a handler for pet telemetry.
func (m *Memory) OnPet(h func(PetState)) {
	m.mu.Lock()
	m.petHandlers = append(m.petHandlers, h)
	m.mu.Unlock()
}

// PetTimeout is how long after the last telemetry message the pet counts as connected.
const PetTimeout = 5 * time.Second

// Pet returns the latest pet telemetry and whether it is fresh.
func (m *Memory) Pet() (p *PetState, connected bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pet == nil {
		return nil, false
	}
	cp := *m.pet
	return &cp, time.Since(m.petSeen) < PetTimeout
}
