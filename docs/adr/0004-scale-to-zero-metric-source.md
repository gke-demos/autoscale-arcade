# ADR 0004: In-cluster AutoscalingMetric for scale to zero

**Status:** Accepted · 2026-11-02

## Context
GKE native scale-to-zero is `autoscaling/v2` HPA `minReplicas: 0` plus a GKE `AutoscalingMetric` source. The docs tutorial uses Pub/Sub via Cloud Monitoring, which lags 1–2 minutes — too slow for a kiosk.

## Decision
Use the `AutoscalingMetric` `pod:` source (GA in 1.37.0-gke.3100000) to scrape `arcade_queue_depth` from the arcade server's `/metrics`. The HPA uses the derived External metric `autoscaling.gke.io|coin-queue|arcade_queue_depth`. Document the Pub/Sub variant as the production pattern.

## Consequences
Reaction time ~15–30 s; no extra Google Cloud services; the arcade server is the single source of truth for "coins".
