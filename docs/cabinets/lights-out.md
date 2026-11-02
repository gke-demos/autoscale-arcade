# Lights Out — runbook

**Feature:** native scale to zero — `autoscaling/v2` HPA with `minReplicas: 0` (Kubernetes 1.37 `HPAScaleToZero`) fed by a GKE `AutoscalingMetric`.
**Namespace:** `arcade-lights` · **Manifests:** `manifests/05-lights` · **Scenario:** `scenarios/lights.yaml` (≈ 4–5 min)

## Objects

| Object | Where | Purpose |
| :--- | :--- | :--- |
| `ClusterPodMonitoring/arcade-server` (cluster) | `manifests/05-lights` | Managed Prometheus scrapes `arcade-server` pods (`app=arcade-server`, container port `http` = 8080, path `/metrics`) every 10 s |
| `AutoscalingMetric/coin-queue` | same | `promql: max(arcade_queue_depth{namespace="arcade-system"})` → External metric `autoscaling.gke.io\|coin-queue\|arcade_queue_depth` (see `.status.metricStatuses[].hpaName`) |
| `Deployment/coin-worker` | same | `arcade worker --mode=coin`, `ARCADE_SERVER_URL=http://arcade-server.arcade-system/`, `COIN_WORK_SECONDS=8`; **ships with 1 replica** |
| `HorizontalPodAutoscaler/coin-worker` | same | `minReplicas: 0`, `maxReplicas: 12`, External `AverageValue: 2`, `scaleDown.stabilizationWindowSeconds: 60`, scale-up 12 pods / 15 s |

Start state (`reset`): queue 0 → the HPA scales to 0 by itself after the 60 s window. `reset` must **not** `kubectl scale` the Deployment to 0: an HPA whose target is already at 0 reports `ScalingActive=False / ScalingDisabled` and never wakes it (verified). If that happens, `kubectl scale deploy/coin-worker -n arcade-lights --replicas=1` and let the HPA take it down.

## Why Managed Prometheus and not the `pod:` source (ADR 0004 amendment)

The `pod:` source of `AutoscalingMetric` produces a **`Pods`-type** metric (per-pod values of the target workload). Kubernetes rejects `minReplicas: 0` without an `Object` or `External` metric (`spec.metrics: Forbidden: must specify at least one Object or External metric to support scaling to zero replicas`), and a Pods metric cannot be computed when there are no pods. So the queue depth goes arcade-server → Managed Prometheus (`ClusterPodMonitoring`, 10 s) → Cloud Monitoring → `promql` source → External metric. Expect ~30–90 s from "insert coin" to the first pod; the script's captions are written for that. The Pub/Sub tutorial variant is the production pattern.

## What to click / say

1. **Look at zero** — *"Minimum replicas: zero. Not one idle pod. And the autoscaler is still watching — `ScaledToZero: True`, `ScalingActive: True`."*
2. **Insert coin** (+1) — queue depth 1 → the 10 % tolerance is bypassed at zero → desired 1. *"One coin woke one worker from nothing."*
3. **Slam** (+50) — desired = ceil(50 / 2) capped at 12. Workers each take 8 s per coin; the queue drains in ~40 s.
4. **Wait** — 60 s stabilization after the queue hits 0 → back to zero. *"Lights out."*

## What to watch

```sh
kubectl get hpa coin-worker -n arcade-lights -w
kubectl describe hpa coin-worker -n arcade-lights | sed -n '/Metrics/,/Events/p'     # conditions: AbleToScale ScalingActive ScalingLimited ScaledToZero
kubectl get autoscalingmetric coin-queue -n arcade-lights -o yaml | yq .status
kubectl get pods -n arcade-lights -w
kubectl get events -n arcade-lights --field-selector reason=SuccessfulRescale -w
kubectl -n kube-system logs deploy/autoscaling-metrics-adapter -f | grep coin-queue   # GKE's managed adapter; scaled 0→1 on demand
kubectl get clusterpodmonitoring arcade-server -o jsonpath='{.status.endpointStatuses}'  # needs OperatorConfig features.targetStatus.enabled
curl -s http://arcade-server.arcade-system/metrics | grep arcade_queue_depth             # from inside the cluster
```

## Recovery

| Symptom | Fix |
| :--- | :--- |
| `ScalingActive False / ScalingDisabled … replica count of the target is zero` | Someone scaled the Deployment to 0 by hand. `kubectl scale deploy/coin-worker -n arcade-lights --replicas=1`. |
| `FailedGetExternalMetric: No recommendation` | Metric not flowing: check the ClusterPodMonitoring target status (`health: up`), that arcade-server exposes `arcade_queue_depth` on the container port named `http` (8080), and the adapter log for `Error fetching metrics`. After the first coin it can take ~1–2 min for the first value. |
| Pods never come back to 0 | Queue not empty (`/metrics`), or `COIN_WORK_SECONDS` too long; wait for the 60 s stabilization window. |
| Workers Running but queue not draining | They cannot reach `arcade-server.arcade-system` (Service ports 80 and 8080) (`/api/queue/claim` returns `{"coin":n}` or 204). Check network policy / server logs. |
| Reset | `POST /api/actions/reset {"cabinet":"lights"}` (server empties the queue). Manual: nothing else needed; never scale to 0 manually. |
