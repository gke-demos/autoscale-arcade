# Pod Teleporter — runbook

**Feature:** live Pod Migration (gke-labs/pod-migration) on GKE Pod Snapshots + gVisor. The headline cabinet.
**Namespace:** `arcade-teleporter` · **Manifests:** `manifests/03-teleporter` · **Scenario:** `scenarios/teleporter.yaml` (≈ 1.5 min)

## Objects

| Object | Where | Purpose |
| :--- | :--- | :--- |
| Node pool `gvisor` (3 × `n4-standard-4`, `--sandbox type=gvisor`, autoscaling off, label `arcade.gke.io/pool=gvisor`) | `hack/cluster.sh` | Identical machine series so whole-pod snapshots always restore |
| `PodMigration/arcade`, `PodSnapshotPolicy`, `PodSnapshotStorageConfig`, GCS bucket + IAM | `hack/cluster.sh` / `manifests/00-platform` | Snapshot storage and the eviction webhook config |
| `ServiceAccount/pet` | `manifests/00-platform` | Pod KSA; the whole namespace has `storage.objectUser` on the bucket via a Workload Identity principalSet |
| `Service/pet` (headless) | `manifests/03-teleporter` | Governing service for the StatefulSet |
| `StatefulSet/pet` → pod `pet-0` | `manifests/03-teleporter` | 1 replica, `updateStrategy.type: OnDelete`, `runtimeClassName: gvisor`, label `pod-migration.gke.io/enabled: "true"`, `nodeSelector arcade.gke.io/pool: gvisor`, 100m / 256Mi, `arcade pet` (no `httpGet` readinessProbe — gVisor's restored netstack keeps the origin Pod IP, so inbound kubelet HTTP probes to the new Pod IP time out after restore and hold `Ready=False`) |

Start state (`reset`): `pet-0` Running, no `kubernetes.io/hostname` pin in the template.

## How a teleport works (ADR 0003)

1. Server patches the StatefulSet template `nodeSelector[kubernetes.io/hostname]=<target>`. `OnDelete` means no rollout.
2. Server POSTs `pods/pet-0/eviction` (policy/v1). The pod-migration webhook answers 429 "migration job spawned" and creates `PodMigrationJob/pmj-pet-0-<hash>`.
3. Phases seen on this cluster: `Snapshotting` → `Restoring` → `Succeeded` (there is no separate `Evicting` phase; use `status.evictingStartTime`). Restore takes ≈ 5–7 s; `Succeeded` is set ≈ 30 s after the restored pod is Ready; `Restored` condition reason is `RestoreInferred` (GKE Pod Snapshots offers no positive restore signal, so `RestoreVerified` never appears).
4. The replacement pod has the same name, a new IP, and the same memory: ticks, score, ball position continue.

## What to click / say

- **Drag `pet-0` onto another gVisor island** — *"All of this pet's state is in memory. No disk, no database. Watch the counter."* Beam animation follows `PodMigrationJob` phases; the counter freezes for a few seconds and resumes from the same value; the stopwatch posts the downtime to the leaderboard.
- **Random teleport** — same, to a random other gVisor node. Use when the touch screen misbehaves.
- *"Lives"* on the pet = migrations survived (the pet counts a > 2 s tick gap as a restore).

## What to watch

```sh
kubectl get pod pet-0 -n arcade-teleporter -o wide -w
kubectl get podmigrationjobs -n arcade-teleporter -w
kubectl get podmigrationjob -n arcade-teleporter -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{.status.snapshottingStartTime}{"\t"}{.status.restoringStartTime}{"\t"}{.status.completionTime}{"\n"}{end}'
kubectl get podsnapshots -n arcade-teleporter
kubectl get events -n arcade-teleporter --field-selector reason=GKEPodSnapshotting
kubectl get statefulset pet -n arcade-teleporter -o jsonpath='{.spec.template.spec.nodeSelector}'   # the current pin
kubectl -n pod-migration-system logs deploy/pod-migration-controller -f
```

## Recovery

| Symptom | Fix |
| :--- | :--- |
| Migration `Failed`, controller log `runsc checkpoint … closing state file failed: input/output error` | The snapshot bucket is missing or the KSA cannot write to it. `hack/cluster.sh storage`; check `gcloud storage buckets get-iam-policy gs://<bucket>`. |
| `SucceededWithoutRestore` | Cold start: the snapshot could not be restored (different machine type/CPU platform, or snapshot not Ready). All three gVisor nodes must be `n4-standard-4`. The UI says so honestly. |
| `pet-0` Pending after a drag | Template pinned to a node that is cordoned/full/gone. `kubectl patch statefulset pet -n arcade-teleporter --type=json -p='[{"op":"remove","path":"/spec/template/spec/nodeSelector/kubernetes.io~1hostname"}]'` then `kubectl delete pod pet-0 -n arcade-teleporter`. |
| Eviction returns 200 and the pod is simply recreated (no PMJ) | Webhook not intercepting: label `pod-migration.gke.io/enabled: "true"` missing, or `PodMigration/arcade` absent, or controller down (`kubectl get pods -n pod-migration-system`). |
| Pod `ImagePullBackOff` | Image not pushed yet / tag wrong; `kubectl rollout restart` is **not** safe here (OnDelete) — `kubectl delete pod pet-0` after fixing the image. |
| Full reset | `POST /api/actions/reset {"cabinet":"teleporter"}` (removes the pin). Manual: the patch above + `kubectl apply -k manifests/03-teleporter`. Old `PodMigrationJob`s can be deleted freely. |

> [!IMPORTANT]
> Never `kubectl rollout restart` or edit the container spec of `pet` during the show: with `OnDelete` nothing happens until the pod is deleted, and a plain delete bypasses the migration webhook (the pet starts from zero).
