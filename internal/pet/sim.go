// Package pet implements the Pod Teleporter's "arcade pet": a tiny process
// whose entire state lives in memory (ticks, score, lives, a bouncing ball).
// A successful live migration is visible because the state simply continues;
// a cold start is visible because it goes back to zero.
package pet

import "time"

// Ball is the 2D bouncing-ball simulation state. Coordinates are normalised to
// the unit square [0,1]x[0,1]; velocities are in units per second.
type Ball struct {
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
	VX float64 `json:"vx"`
	VY float64 `json:"vy"`
}

// Sim is the deterministic game simulation. It is not safe for concurrent use;
// Pet guards it with a mutex.
type Sim struct {
	Ticks uint64
	Score uint64
	Ball  Ball
}

// NewSim returns a simulation with the ball in the centre moving diagonally.
func NewSim() *Sim {
	return &Sim{Ball: Ball{X: 0.5, Y: 0.5, VX: 0.37, VY: 0.23}}
}

// Step advances the simulation by one tick of duration dt. Each wall bounce
// scores a point; a corner hit (both walls in one tick) scores a bonus.
func (s *Sim) Step(dt time.Duration) {
	secs := dt.Seconds()
	b := &s.Ball
	b.X += b.VX * secs
	b.Y += b.VY * secs
	bounces := 0
	if b.X < 0 {
		b.X, b.VX = -b.X, -b.VX
		bounces++
	} else if b.X > 1 {
		b.X, b.VX = 2-b.X, -b.VX
		bounces++
	}
	if b.Y < 0 {
		b.Y, b.VY = -b.Y, -b.VY
		bounces++
	} else if b.Y > 1 {
		b.Y, b.VY = 2-b.Y, -b.VY
		bounces++
	}
	switch bounces {
	case 1:
		s.Score++
	case 2:
		s.Score += 10
	}
	s.Ticks++
}
