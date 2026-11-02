# ADR 0005: Public Gateway with IAP at autoscale-arcade.demo.gke.ninja

**Status:** Accepted · 2026-11-02

## Context
Presenters use Chromebooks on booth Wi-Fi; the action API is destructive; a real FQDN is wanted.

## Decision
GKE Gateway (`gke-l7-global-external-managed`) with the `star-demo-gke-ninja` certificate map (`*.demo.gke.ninja`), `HTTPRoute` for `autoscale-arcade.demo.gke.ninja`, `GCPBackendPolicy` enabling IAP with a long backend timeout for WebSockets. Presenters are granted IAP-secured Web App User. The server also verifies the IAP JWT on mutating calls.

## Open item
Certificate Manager maps are project-scoped; `kcna-2026-demos` needs its own map (DNS authorisation in the `demo.gke.ninja` zone) unless the Gateway is hosted in the project that owns the map. `kubectl port-forward` remains the fallback.
