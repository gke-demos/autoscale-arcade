# Kiosk setup (booth Chromebook)

The arcade is served at **https://autoscale-arcade.demo.gke.ninja** behind Identity-Aware Proxy. One sign-in per device; the IAP session cookie also covers the WebSocket upgrade.

## Before the show (once per presenter / device)

1. Ask the project owner to run, from a checkout of this repo:
   ```sh
   PROJECT_ID=gke-demos-345619 ./hack/iap.sh grant alice@google.com bob@google.com
   ```
   This grants *IAP-secured Web App User* on the Gateway's backend service. `./hack/iap.sh status` shows the current allow-list; `revoke` removes a presenter.
2. On the Chromebook, sign in to Chrome with the presenter's Google account (or add it as a secondary account; IAP shows an account chooser).
3. Open https://autoscale-arcade.demo.gke.ninja — you should see the IAP sign-in, then the lobby. If you get **"You don't have access"**, the account is not on the allow-list (step 1) or the grant is <1 min old.
4. Open the page once more in a **normal** window (not Incognito/Guest: IAP needs a persistent cookie).

## Full-screen / kiosk mode

- Quickest: open the site, press **`F`** (the UI's own fullscreen toggle) or Chrome's `Fullscreen` (`⛶` key / `F11` on an external keyboard). Esc leaves fullscreen but the UI keeps running.
- Hide the shelf: right-click the shelf → **Autohide shelf**.
- Keep the screen awake: Settings → Device → Power → *Sleep when idle: Keep display on*, and *Never* lock the screen while charging. Plug it in.
- Zoom: the UI is designed for 1920×1080 at 100 %; use `Ctrl+-`/`Ctrl+=` to fit other panels. Touch targets are ≥ 64 px, so a touchscreen works without a mouse.
- Keyboard: `1`–`6` cabinets, `0`/`Esc` lobby, `Space` ▶ run the cabinet's scenario, `R` reset it, `A` attract mode, `F` fullscreen.
- Attract mode (`A`, or `POST /api/actions/scenario.run {"name":"attract"}`) loops every cabinet with resets in between — leave it on when nobody is playing.

Managed ChromeOS kiosk apps (Admin console → Devices → Chrome → Apps & extensions → Kiosks) **do not work** with IAP: the kiosk session has no Google account to present. Use a normal signed-in session.

## Fallback 1 — port-forward (no IAP, no public DNS)

Any laptop with `kubectl` access to the cluster (`./hack/cluster.sh credentials`):

```sh
kubectl -n arcade-system port-forward svc/arcade-server 8080:8080
open http://localhost:8080
```

Mutating calls need the dev token because there is no IAP JWT on this path:

```sh
TOKEN=$(kubectl -n arcade-system get secret arcade-server -o jsonpath='{.data.ARCADE_DEV_TOKEN}' | base64 -d)
curl -X POST -H "Authorization: Bearer $TOKEN" localhost:8080/api/actions/reset -d '{}'
```

The UI reads the token from the `?token=` query parameter on first load (`http://localhost:8080/?token=$TOKEN`) and keeps it in `localStorage`.

## Fallback 2 — run the scenarios from a terminal

If the browser is dead but the cluster is fine, the show goes on from a shell:

```sh
make play-teleporter          # one cabinet, prints captions as it goes
make play-all                 # all six in order
make reset                    # back to the start state
```

## Fallback 3 — the UI without a cluster

`cd web && VITE_MOCK=1 npx vite` serves the UI against an in-browser mock of the WorldState. Say so on stage; never pass it off as the real thing (AGENTS.md: *never fake cluster state*).

## Network notes for booth Wi-Fi

- Only outbound 443 to `autoscale-arcade.demo.gke.ninja` (136.82.230.71) and `accounts.google.com` is needed.
- The WebSocket uses the same origin and port; captive portals that strip `Upgrade` headers break it — tether to a phone instead.
- The backend timeout is 3600 s; the UI reconnects automatically and re-requests a snapshot.

## Day-of checklist

- [ ] `PROJECT_ID=gke-demos-345619 ./hack/preflight.sh` is green.
- [ ] `./hack/cluster.sh verify` — addons healthy; `kubectl get nodes -l arcade.gke.io/pool=gvisor` shows 3 Ready nodes.
- [ ] `make reset`; `kubectl get pods -A | grep -v Running | grep arcade-` is empty.
- [ ] `./hack/iap.sh status` lists today's presenters.
- [ ] https://autoscale-arcade.demo.gke.ninja/healthz returns `ok` after IAP sign-in.
- [ ] Attract mode running; Chromebook plugged in, display never sleeps.
