# Autoscale Arcade — web UI

Vite + React 19 + TypeScript + React Three Fiber (+ drei) + zustand + Tailwind v4.
Built output goes to `web/dist`; the Go server embeds it (copied to `internal/server/dist/` at image build time).

## Run

```bash
cd web
npm ci

# 1) No cluster needed: in-browser mock arcade-server (all six cabinets, actions, scenarios, pet telemetry)
VITE_MOCK=1 npm run dev          # http://localhost:5173

# 2) Against a real arcade-server (port-forwarded or local `go run ./cmd/arcade server`)
kubectl port-forward -n arcade-system svc/arcade-server 8080:80
VITE_API_BASE=http://localhost:8080 VITE_DEV_TOKEN=<ARCADE_DEV_TOKEN> npm run dev

# 3) Production build (what the Dockerfile / `make web-build` run)
npm run build                    # -> web/dist
```

Environment (`.env.local` works too):

| Var | Effect |
| :-- | :-- |
| `VITE_MOCK=1` | use `src/mock/server.ts` instead of `/ws` + `/api` |
| `VITE_API_BASE` | dev: Vite proxies `/api`, `/ws`, `/metrics` there; prod build: absolute base for API calls (default same origin) |
| `VITE_DEV_TOKEN` | sent as `Authorization: Bearer …` on mutating calls (IAP handles auth in prod) |

Deep links: `/#/teleporter` (or `?view=teleporter`) opens a cabinet directly.

## Layout

```
src/
  types.ts            TypeScript mirror of docs/contracts.md (WorldState, actions, cabinets)
  api.ts              fetch helpers (/api/actions/*, /api/state, /api/leaderboard, /api/scenarios)
  connection.ts       WebSocket client with reconnect (or the mock) → zustand store
  store.ts            zustand store: world, pet, view, drag, toasts, idle timer, act()
  App.tsx             shell: canvas + overlay grid, keyboard map, attract mode, #/routes
  scene/              shared 3D vocabulary (design.md §3)
    layout.ts         deterministic islands → node slabs → pod cubes grid layout
    ClusterScene.tsx  Island, NodeSlab (family colour, spot stripe, ❄, amber pulse, red drain), instanced pod cubes, halos, ghosts, Flame, Beam
    Stage.tsx         Canvas (DPR ≤ 2), lights, grid, OrbitControls, CameraRig
    usePodDrag.ts     mouse+touch drag-and-drop of pod cubes onto node slabs
    Lobby.tsx         six cabinets + cluster overview
  hud/                RightRail (kubectl tables / YAML / events), TopBar, BottomBar, toasts, help, leaderboard
  cabinets/           one module per cabinet: Scene + Controls + hud() (+ Status)
  mock/server.ts      simulated arcade-server for VITE_MOCK=1
```

## Keyboard (contracts.md)

`1`–`6` cabinets · `0`/`Esc` lobby · `Space` ▶ auto-run · `R` reset · `A` attract · `F` fullscreen · `←/→` prev/next · `?` help.

## Performance notes

Designed for 1080p/4K landscape TVs on a Chromebook GPU: DPR capped at 2, pods rendered with instanced meshes, no post-processing, UI sized in `vmin`-scaled rem so touch targets stay ≥ 64 px.
