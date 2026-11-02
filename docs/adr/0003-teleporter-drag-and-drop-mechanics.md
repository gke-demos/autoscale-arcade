# ADR 0003: Drag-and-drop pod migration mechanics

**Status:** Accepted · 2026-11-02

## Context
The pod-migration controller migrates on *eviction*; it has no "move pod X to node Y" API. A dropped pod must land on the chosen node and keep its memory.

## Decision
- Run the pet as a `StatefulSet` with `updateStrategy.type: OnDelete` so template changes do not trigger a rollout (a rollout would `DELETE`, bypassing the eviction webhook).
- On drop: patch the template `nodeSelector` to `kubernetes.io/hostname: <target>`, then create an `Eviction` for `pet-0`. The webhook turns the eviction into a `PodMigrationJob`; the replacement pod (same name) is created from the patched template and is gated until the snapshot is ready, then restored on the target node.
- Fixed 3-node gVisor pool on a single machine type (`n4-standard-4`) so whole-pod snapshots always restore.

## Alternatives considered
Cordon every node except the target (slower, noisy, affects other cabinets); a `Deployment` with node affinity (ReplicaSet rollout deletes instead of evicting).
