# Autoscale Arcade (`gke-demos/autoscale-arcade`)

Interactive WebGL kiosk demo of GKE autoscaling (Compute Classes, Workload Class spot ratio, live Pod Migration, Capacity Buffers, scale to zero, CPU startup boost) on one GKE Standard 1.37 cluster.

## Read first
- `docs/design.md` — the design; `docs/adr/` — decisions. Keep both current when behaviour changes.
- `docs/cabinets/<cabinet>.md` — per-cabinet runbook (objects, actions, what to watch, troubleshooting).

## Commands
- `make cluster` / `make teardown` — bootstrap or delete the GKE cluster (`PROJECT_ID`, `REGION`, `CLUSTER` env vars).
- `make build` — Go binary with the embedded UI; `make web-dev` — Vite dev server proxied to a port-forwarded arcade-server.
- `make deploy` — apply `manifests/` with kustomize; `make play-<cabinet>` / `make play-all` — run scenarios from the terminal; `make reset` — return every cabinet to its start state; `make verify-<cabinet>` — end-to-end checks.

## Conventions
- Go 1.24+, `controller-runtime`-free (plain client-go informers + dynamic client). Frontend: Vite + React + TypeScript + React Three Fiber.
- Namespaces: `arcade-system` (server, gateway), `arcade-<cabinet>` for workloads. Labels: `app.kubernetes.io/part-of: autoscale-arcade`, `arcade.gke.io/cabinet: <cabinet>`.
- Never fake cluster state in the UI. If a feature degrades, show it.
- Every ▶ action must be expressible as a `scenarios/*.yaml` step so it can run without the UI.
- Issues and plan live in GitHub Issues; label cabinets with `cabinet/<name>`.
