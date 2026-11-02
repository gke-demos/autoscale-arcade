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

**Decision (validated on the real cluster, 2026-11-02): a cluster-scoped `CapacityQuota` that caps Spot nodes of the Spot On pools (`arcade.demo/cabinet=spot`) at 0, plus cordon + evict of the existing Spot nodes.** `spot.stockout {enabled:true}` creates the quota and drains; `{enabled:false}` deletes the quota and uncordons.

```yaml
apiVersion: autoscaling.x-k8s.io/v1beta1
kind: CapacityQuota
metadata:
  name: arcade-spot-stockout
  labels: {app.kubernetes.io/part-of: autoscale-arcade, arcade.gke.io/cabinet: spot}
spec:
  selector:
    matchLabels:
      arcade.demo/cabinet: spot
      cloud.google.com/gke-spot: "true"
  limits:
    resources:
      nodes: "0"
```

Engage (what the server does, in order):
1. `kubectl apply` the quota above (RBAC: `capacityquotas` create/delete in ClusterRole `arcade-server-cluster-writer`).
2. For every node with `arcade.demo/cabinet=spot,cloud.google.com/gke-spot=true`: cordon, then evict its arcade pods (`pods/eviction`). The replacements schedule onto `spot-od` (or trigger CA scale-up on `spot-od` if full); the Workload Class controller reports `InFallback=True`.

Disengage: delete the quota, uncordon the `spot-spot` nodes. With `reversion: {action: Active, minDurationOnFallback: 0s}` on `GKESpotPlacementPolicy/arcade-spot`, the Workload Class controller evicts fallback pods oldest-first so they reschedule onto `spot-spot`.

Evidence (validated on the non-CCC `spot-spot` / `spot-od` pools, 2026-11-02):

| Time (UTC) | Event |
| :--- | :--- |
| 13:18 | 8-replica test Deployment (`nodeSelector: {arcade.demo/cabinet: spot}` + preferred Spot affinity), no quota → triggered CA scale-up on `spot-spot` (`gke-autoscale-arcade-spot-spot-88332450-grp`: `1→3` Ready, `ScaleUp: InProgress`) while `spot-od` stayed at 2 |
| 13:19:45 | `CapacityQuota/arcade-spot-stockout` applied (`arcade.demo/cabinet: spot`, `cloud.google.com/gke-spot: "true"`, `nodes: "0"`), scaled to 16 replicas → CA status held `spot-spot` at `ScaleUp: NoActivity` (3/6, max 6) and triggered `ScaleUp: InProgress` (`2→3` Ready) on `spot-od` (`04d665b6-grp`, on-demand) |
| 12:41–12:52 | Earlier CCC run also verified `CapacityQuota` against NPAC pools (`nap-n4d-standard-2-spot-…` held at `NoActivity` while on-demand `nap-n4-standard-2-…` scaled up) |

Why `CapacityQuota`:
- Matches regular GKE node pool labels (`arcade.demo/cabinet: spot`) directly without needing a ComputeClass or Compute/Container IAM on `arcade-server`.
- Immediate effect (first CA loop ≈ 10 s), single Kubernetes object create/delete, and `kubectl get capacityquota` is visible in the HUD.

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
