package worker

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"runtime"
	"time"
)

// Warmup burns exactly cpu seconds of CPU time on a single OS thread, then
// returns the CPU time actually consumed. It is deliberately CPU-bound (SHA-256
// over a small buffer, single goroutine) so that wall time depends only on how
// much CPU the container is allowed: at a 250m limit 20 CPU-seconds take ~80 s,
// with a 4x startup boost ~20 s. That ratio is what the Nitro race shows and
// what the readiness probe measures.
func Warmup(ctx context.Context, cpu time.Duration) (time.Duration, error) {
	if cpu <= 0 {
		return 0, nil
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	start, err := threadCPUTime()
	if err != nil {
		return 0, err
	}
	var buf [64]byte
	h := sha256.New()
	var iter uint64
	for {
		// ~1 ms of hashing between clock reads keeps the overhead negligible
		// without overshooting the target by more than a few hundred µs.
		for i := 0; i < 4096; i++ {
			binary.LittleEndian.PutUint64(buf[:], iter)
			iter++
			h.Reset()
			h.Write(buf[:])
			h.Sum(buf[:0])
		}
		now, err := threadCPUTime()
		if err != nil {
			return 0, err
		}
		if used := now - start; used >= cpu {
			return used, nil
		}
		if err := ctx.Err(); err != nil {
			return now - start, err
		}
	}
}
