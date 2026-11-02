//go:build linux

package worker

import (
	"syscall"
	"time"
	"unsafe"
)

const clockThreadCPUTimeID = 3 // CLOCK_THREAD_CPUTIME_ID from <time.h>

// threadCPUTime returns user+system CPU time consumed by the calling OS thread.
// The caller must hold runtime.LockOSThread. Uses the raw syscall so the worker
// needs nothing outside the standard library.
func threadCPUTime() (time.Duration, error) {
	var ts syscall.Timespec
	_, _, errno := syscall.Syscall(syscall.SYS_CLOCK_GETTIME, clockThreadCPUTimeID, uintptr(unsafe.Pointer(&ts)), 0)
	if errno != 0 {
		return 0, errno
	}
	return time.Duration(ts.Nano()), nil
}
