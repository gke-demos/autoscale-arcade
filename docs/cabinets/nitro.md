# Nitro — runbook

**Feature:** VPA CPU startup boost (`autoscaling.k8s.io/v1 VerticalPodAutoscaler` `spec.startupBoost`) with in-place unboost.
**Namespace:** `arcade-nitro` · **Manifests:** `manifests/06-nitro` · **Scenario:** `scenarios/nitro.yaml` (≈ 2 min)

## Objects

| Object | Where | Purpose |
| :--- | :--- | :--- |
| `Deployment/stock` | `manifests/06-nitro` | 1 replica, `strategy: Recreate`, container `racer`: `arcade worker --mode=race`, `WARMUP_CPU_SECONDS=20`, requests = limits 250m / 128Mi, readiness `/ready` every 1 s |
| `Deployment/nitro` | same | Byte-identical to `stock` except the names |
| `VerticalPodAutoscaler/nitro` | same (applied **before** the Deployments — kustomize `sortOptions.order: fifo`) | `targetRef Deployment/nitro`, `updateMode: InPlaceOrRecreate`, `startupBoost.cpu: {type: Factor, factor: 4, durationSeconds: 0}`, `containerPolicies[racer].mode: "Off"` (no continuous right-sizing, so both lanes keep the same 250m baseline) |

Start state (`reset`): both Deployments at 1 replica, no race in progress.

Verified on the cluster: a nitro pod admitted while the VPA exists gets `requests.cpu: 1`, `limits.cpu: 1` and the annotations **`vpaCPUStartupBoost/racer`** = `{"requests":{"cpu":"250m","memory":"128Mi"},"limits":{"cpu":"250m","memory":"128Mi"}}` (note the capital CPU — the docs spell it `vpaCpuStartupBoost`), `vpaObservedContainers: racer`, `vpaUpdates: "Pod resources updated by nitro: container 0: cpu request, cpu limit"`. A pod created before the VPA existed is **not** boosted (admission-time only).

## What to click / say

1. **Start race** — rollout-restarts both Deployments. *"Two identical pods, a quarter core each, twenty seconds of single-core work before they say Ready. The nitro lane gets a 4× CPU boost at start-up — that is one line of VPA config."*
2. **Watch the lanes** — flame on the boosted pod; finish line = `Ready=True`. Expected: nitro ≈ 20–25 s, stock ≈ 80–90 s (250m = one quarter of a core for a 20 s single-core job).
3. **After the finish** — *"Now the boost goes away in place: the request drops back to 250m without a restart. `RESTARTS` stays 0."* HUD shows `spec.containers[].resources` vs `status.containerStatuses[].resources` and the `InPlaceResizedByVPA` event. The VPA updater runs on a 1-minute loop, so the unboost lands up to ~60 s after Ready.

## What to watch

```sh
kubectl get pods -n arcade-nitro -o wide -w
kubectl get pods -n arcade-nitro -o custom-columns='NAME:.metadata.name,REQ:.spec.containers[0].resources.requests.cpu,ACTUAL:.status.containerStatuses[0].resources.requests.cpu,READY:.status.conditions[?(@.type=="Ready")].status,RESTARTS:.status.containerStatuses[0].restartCount'
kubectl get pod -n arcade-nitro -l app=nitro -o jsonpath='{.items[0].metadata.annotations}'
kubectl get events -n arcade-nitro --field-selector reason=InPlaceResizedByVPA -w
kubectl get events -n arcade-nitro --sort-by=.lastTimestamp | grep -i -E 'resize|boost'
kubectl describe vpa nitro -n arcade-nitro
```

## Recovery

| Symptom | Fix |
| :--- | :--- |
| Nitro pod has no `vpaCPUStartupBoost/racer` annotation | Pod was created before the VPA, or the VPA admission webhook is down (`kubectl get pods -n kube-system -l app=vpa-admission-controller`… on GKE it is managed: `gcloud container clusters describe … --format='value(verticalPodAutoscaling)'`). `kubectl rollout restart deploy/nitro -n arcade-nitro`. |
| Boost capped below 4× | Node has no room for 1 core; GKE caps the boost to fit. Move the race off a crowded node or add a node. |
| Unboost never happens | `updateMode` must be `InPlaceOrRecreate`; check `kubectl get events -A --field-selector reason=InPlaceResizedByVPA` and the pod's `PodResizePending` condition. Wait a full VPA updater cycle (60 s). |
| Pod restarted during resize | In-place resize failed and VPA fell back to recreate; the HUD shows `RESTARTS 1`. Check `resizePolicy` (default `NotRequired`) and node kubelet version ≥ 1.37. |
| Both lanes equally slow/fast | Race pods landed on a node with spare CPU and the limit is not enforced? Limits are set (250m) so no; check that `WARMUP_CPU_SECONDS=20` and the image is the real arcade image (not a placeholder). |
| Reset | `POST /api/actions/reset {"cabinet":"nitro"}` (both at 1 replica, clears the race). Manual: `kubectl apply -k manifests/06-nitro`. |
