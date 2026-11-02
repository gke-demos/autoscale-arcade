//go:build !linux

package worker

import "time"

// threadCPUTime falls back to the monotonic wall clock on non-Linux platforms
// (local development only; the image is linux). Because Warmup is a busy loop
// this approximates thread CPU time closely on an idle machine.
func threadCPUTime() (time.Duration, error) {
	return time.Duration(time.Since(processStart)), nil
}

var processStart = time.Now()
