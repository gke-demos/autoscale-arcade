# ADR 0001: One cluster, one image, real objects only

**Status:** Accepted · 2026-11-02

## Context
The demo must show six autoscaling features at a conference kiosk, be run by many presenters, and be reproducible from the repo.

## Decision
- A single GKE Standard 1.37 (Rapid) cluster hosts every cabinet; namespaces separate them.
- One multi-command Go image (`server`, `pet`, `worker`) with the web UI embedded via `go:embed`; `kubectl apply -k` installs everything.
- Every visual is derived from real Kubernetes objects streamed through the arcade server. No mocked timelines; if a feature degrades (for example a cold-start restore), the UI says so.

## Consequences
- Simpler ops and cheaper; cabinets share the compute-class pools, so `make reset` must return the cluster to a known state.
- Scenes depend on real latency (NPAC 60–120 s); the UI must make waiting interesting (amber nodes, CA status, captions).
