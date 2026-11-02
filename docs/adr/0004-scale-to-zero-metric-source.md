# ADR 0004: In-cluster AutoscalingMetric for scale to zero

**Status:** Accepted · 2026-11-02

## Context
GKE native scale-to-zero is `autoscaling/v2` HPA `minReplicas: 0` plus a GKE `AutoscalingMetric` source. The docs tutorial uses Pub/Sub via Cloud Monitoring, which lags 1–2 minutes — too slow for a kiosk.

## Decision
Use the `AutoscalingMetric` `pod:` source (GA in 1.37.0-gke.3100000) to scrape `arcade_queue_depth` from the arcade server's `/metrics`. The HPA uses the derived External metric `autoscaling.gke.io|coin-queue|arcade_queue_depth`. Document the Pub/Sub variant as the production pattern.

## Consequences
Reaction time ~15–30 s; no extra Google Cloud services; the arcade server is the single source of truth for "coins".

## Amendment 2026-11-02 — `promql` source over Managed Prometheus, not the `pod:` source

Validated on the real cluster (GKE 1.37.1-gke.1697000, HPA profile `PERFORMANCE`):

- The `pod:` source of `AutoscalingMetric` produces a **`Pods`-type** metric (per-pod values of the HPA target). The API server rejects `minReplicas: 0` without an `Object` or `External` metric (`spec.metrics: Forbidden: must specify at least one Object or External metric to support scaling to zero replicas`), and an `External` HPA metric pointed at a `pod:` source never receives a value (the managed `autoscaling-metrics-adapter` only starts scrapers for `promql` sources). So the in-cluster `pod:` source cannot wake a workload from zero.
- `promql` sources are served by the managed `kube-system/autoscaling-metrics-adapter` (scaled 0→1 on demand) against Cloud Monitoring, which includes Managed Service for Prometheus series.

Decision: `ClusterPodMonitoring/arcade-server` (10 s scrape of `/metrics` on `app=arcade-server`) → Cloud Monitoring → `AutoscalingMetric/coin-queue` `promql: max(arcade_queue_depth{namespace="arcade-system"})` → HPA External metric `autoscaling.gke.io|coin-queue|arcade_queue_depth`. The metric name in `docs/contracts.md` is unchanged.

Consequences: the first recommendation for a new HPA/metric pair took ~15 min to appear; steady-state reaction to a queue change is tens of seconds (scrape 10 s + ingest + adapter poll 15 s + HPA loop). The HPA must never be created against a Deployment that is already at 0 replicas (`ScalingActive=False/ScalingDisabled`); `coin-worker` ships at 1 replica and the HPA takes it to zero.
