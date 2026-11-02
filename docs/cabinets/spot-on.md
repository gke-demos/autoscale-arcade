# Spot On — runbook

**Feature:** Workload Class (`workloads.gke.io/v1`, gke-labs/workload-class) Spot placement with an On-Demand / Spot ratio, fallback and active reversion.
**Namespace:** `arcade-spot` · **Manifests:** `manifests/02-spot` · **Scenario:** `scenarios/spot.yaml` (≈ 6–8 min)

## Objects

| Object | Where | Purpose |
| :--- | :--- | :--- |
| Node pools `spot-spot` (n4d-standard-2 Spot, autoscaling 0–6) and `spot-od` (n4-standard-2 on-demand, autoscaling 0–6), us-central1-b | `hack/cluster.sh` phase `spotpools` | Labels `arcade.demo/cabinet=spot`, taint `arcade.demo/spot-cabinet=true:NoSchedule`. **No ComputeClass** for this cabinet: GKE Warden rejects the required `cloud.google.com/gke-spot` node affinity the webhook emits for the on-demand share whenever the pod also selects a ComputeClass (`[denied by ccc-node-affinity-selector-limitation]`), so the ratio dial is unrealisable on a CCC-backed profile. |
| `WorkloadClassGuardrail/arcade` (cluster) | `manifests/02-spot/guardrail.yaml` | Platform persona: `pluginConstraints.placement[gke-spot-placement]` → `enforcementMode: Allowed`, `minSpotRatio: 20%`, `fallback.allowFallbackToOnDemand: true`, `fallback.maxFallbackRatio: 100%`, `reversion.requiredReversionAction: Active`; mandatory `constraints.disruption.maxNonDisruptionDurationDays: 30` |
| `GKESpotPlacementPolicy/arcade-spot` (cluster) | `spot-placement-policy.yaml` | `reversion: {action: Active, minDurationOnFallback: 0s}`; deliberately no `customComputeClass` |
| `WorkloadClass/checkout` | `workloadclass.yaml` | `podSelector app=checkout`, `capacityStrategy: {type: Spot, spotRatio: "80%", action: FallbackToOnDemand}`, `infrastructureProfileRef → GKESpotPlacementPolicy/arcade-spot`, `disruptionPolicy.maxNonDisruptionDurationDays: 30` (guardrail requires 1–30) |
| `Deployment/checkout` | `deployment.yaml` | 10 pause pods, 100m, `nodeSelector arcade.demo/cabinet: spot`, toleration `arcade.demo/spot-cabinet` |

Start state (`reset`): 10 replicas (80 % → 8 Spot / 2 on-demand), ratio 80, stockout off.

Why `maxFallbackRatio: 100%` and not the 50 % from the design: with 50 % a stockout left checkout at 4/6 with `FallbackBudgetExhausted` events (live run 13:08–13:10 UTC; at the time the CCC profile also made the "budget exhausted" strict-Spot selector unadmittable). 100 % lets every pod fall back and Active reversion bring every pod home — the cleaner beat on stage. To show the budget cap instead, lower it in `guardrail.yaml` and caption the Pending pods honestly.

What the webhook injects on each pod (verified): spot-targeted pods get `nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution` weight 100 `cloud.google.com/gke-spot In [true]` (preferred, because the action is `FallbackToOnDemand`) plus toleration `cloud.google.com/gke-spot=true:NoSchedule`; on-demand-targeted pods get a *required* `gke-spot` term (the one Warden refuses next to a ComputeClass selector). Because the Spot pods only *prefer* Spot, the `spot-od` pool must not have idle room when Spot capacity exists, otherwise the scheduler may place a Spot-share pod on-demand; keep `spot-od` autoscaled from 0.

## What to click / say

1. **Look** — *"Ten checkout pods. The workload owner wrote one line: 80 % Spot, fall back to On-Demand. The webhook placed each pod to hit that mix."* HUD: `kubectl get workloadclass` with `VALIDATED True`, pods coloured spot / on-demand, $/h meter.
2. **Ratio dial** (0–100) — patches `spec.capacityStrategy.spotRatio`. *"Change the number, the pods re-balance — a rolling replacement, not a redeploy."* Guardrail refuses < 20 %.
3. **Preempt a Spot node** — `compute.instances.simulateMaintenanceEvent` on a Spot VM: a real preemption. Pods reschedule onto other Spot capacity (or fall back).
4. **Stockout** — engage the lever (section below); Spot becomes unobtainable → pods fall back On-Demand, `InFallback=True`. *"Nobody paged. Checkout kept running at On-Demand prices."*
5. **Capacity returns** — disengage; Active reversion evicts fallback pods oldest-first back onto Spot (`minDurationOnFallback: 0s`).

## What to watch

```sh
kubectl get workloadclass -n arcade-spot -w            # MAINTENANCE CAPACITY SPOTRATIO PROFILE VALIDATED
kubectl get workloadclass checkout -n arcade-spot -o jsonpath='{.status.conditions}' | jq
kubectl get pods -n arcade-spot -o wide -L cloud.google.com/gke-spot
kubectl get nodes -l arcade.demo/cabinet=spot -L cloud.google.com/gke-nodepool,cloud.google.com/gke-spot,cloud.google.com/machine-family
kubectl get pod -n arcade-spot -l app=checkout -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.affinity.nodeAffinity}{"\n"}{end}'
kubectl get events -n arcade-spot --sort-by=.lastTimestamp | grep -i -E 'fallback|revers|preempt'
kubectl -n workload-class-system logs deploy/workload-class-controller-manager -f
```

## Stockout lever

**Decision (validated on the real cluster, 2026-11-02): a cluster-scoped `CapacityQuota` that caps Spot nodes of `ComputeClass/arcade-spot` at 0, plus cordon + evict of the existing Spot nodes.** `spot.stockout {enabled:true}` creates the quota and drains; `{enabled:false}` deletes the quota and uncordons.

```yaml
apiVersion: autoscaling.x-k8s.io/v1beta1
kind: CapacityQuota
metadata:
  name: arcade-spot-stockout
  labels: {app.kubernetes.io/part-of: autoscale-arcade, arcade.gke.io/cabinet: spot}
spec:
  selector:
    matchLabels:
      cloud.google.com/compute-class: arcade-spot
      cloud.google.com/gke-spot: "true"
  limits:
    resources:
      nodes: "0"
```

Engage (what the server does, in order):
1. `kubectl apply` the quota above (RBAC: `capacityquotas` create/delete in ClusterRole `arcade-server-cluster-writer`).
2. For every node with `cloud.google.com/compute-class=arcade-spot,cloud.google.com/gke-spot=true`: cordon, then evict its arcade pods (`pods/eviction`). The replacements are Pending for ~60–90 s while NPAC creates an **on-demand** `n4-standard-2` pool; the Workload Class controller reports `InFallback=True`.

Disengage: delete the quota, uncordon. With `activeMigration.optimizeRulePriority: true` on the ComputeClass and `reversion: Active` on the placement policy, GKE moves the pods back to Spot and consolidates the on-demand nodes (observed: ~5–6 min after the delete). Empty Spot nodes left by step 2 are consolidated after `consolidationDelayMinutes: 1`.

Evidence (test Deployment, 8 × 500m pods, `nodeSelector cloud.google.com/compute-class: arcade-spot`):

| Time | Event |
| :--- | :--- |
| 12:41:04 | 2 pods created, no quota → NPAC pool `nap-n4d-standard-2-spot-…` (rung 1), node Ready at ~12:41:55 with `gke-spot=true`, `machine-family=n4d` |
| 12:43:51 | quota created; 12:44:00 scaled to 8 |
| 12:44:29 | CA status: the n4d-spot node group stays `NoActivity`; new groups `nap-n4-standard-2-…` (SPOT column empty = on-demand) scale up `InProgress` — rung 2 (n4 Spot) was skipped too because the quota matches any Spot node of the class |
| 12:45:10 | 2 on-demand nodes Ready (`cloud.google.com/gke-provisioning=standard`), all 8 pods Running |
| 12:46:06 | quota deleted |
| ~12:51–12:52 | active migration: all 8 pods back on `n4d` Spot nodes (3 new spot nodes), on-demand pool empties |

Why not the alternatives:
- **Patching the Spot rules out of the ComputeClass**: works, but it rewrites the object the audience is looking at (the "rungs" disappear from the HUD), the restore is a second patch that can race with `climber.lock`-style edits, and it changes the class for *all* pods, not just capacity. The quota leaves the ComputeClass untouched and is a single create/delete.
- **Capping the auto-created pool** (`gcloud container node-pools update … --max-nodes`): the pool name is generated (`nap-n4d-standard-2-spot-<hash>`), there is one per rung, and a cap only exists once NPAC has created the pool; also needs Compute/Container IAM on the server. Not deterministic before the first scale-up.
- `CapacityQuota` is the GA, in-cluster, label-selected mechanism meant exactly for "this class may not grow"; it is immediate (first CA loop ≈ 10 s), needs only Kubernetes RBAC, and `kubectl get capacityquota` is itself a nice thing to show.

Gotchas: `limits.resources.nodes` counts *existing* nodes too, so with the quota in place CA never adds a Spot node even after the drain empties them; the quota must be deleted (not set to a higher number) to restore the start state. A real stockout (`RESOURCE_POOL_EXHAUSTED`, seen for on-demand n4 in us-central1-c during the test) shows up in the CA status ConfigMap as `scaleUp.backoffInfo.errorCode` — the HUD should surface it the same way.

## Recovery

| Symptom | Fix |
| :--- | :--- |
| `VALIDATED False`, condition `ValidationFailed: maxNonDisruptionDurationDays must be between 1 and 30` | The WorkloadClass needs `disruptionPolicy.maxNonDisruptionDurationDays` (the guardrail makes it mandatory). Re-apply `manifests/02-spot`. |
| Pods Pending with `untolerated taint` / `didn't match node selector` | Template needs `nodeSelector arcade.demo/cabinet: spot` + toleration `arcade.demo/spot-cabinet`; the pools must exist (`gcloud container node-pools list --cluster autoscale-arcade --location us-central1`). Re-apply and `kubectl rollout restart deploy/checkout -n arcade-spot`. |
| ReplicaSet `FailedCreate … warden-validating … ccc-node-affinity-selector-limitation … gke-spot` | A ComputeClass selector crept back into the pod (template or `customComputeClass` on the placement policy). Remove it; this cabinet must not use a ComputeClass. |
| Pods on the default pool with no injected affinity | Created before the WorkloadClass validated or webhook down. `kubectl rollout restart deploy/checkout -n arcade-spot`; check `kubectl get pods -n workload-class-system`. |
| Ratio dial does nothing | Guardrail rejected it (below `minSpotRatio`) — see the WorkloadClass conditions; or no Spot capacity obtainable (check CA events). |
| Cabinet reset | `POST /api/actions/reset {"cabinet":"spot"}`: ratio 80, stockout off, 10 replicas. Manual: `kubectl apply -k manifests/02-spot` then disengage the stockout lever. |
