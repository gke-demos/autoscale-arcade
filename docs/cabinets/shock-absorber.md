# Shock Absorber — runbook

**Feature:** Capacity Buffers (`autoscaling.x-k8s.io/v1beta1 CapacityBuffer`), active and standby.
**Namespace:** `arcade-absorber` · **Manifests:** `manifests/04-absorber` · **Scenario:** `scenarios/absorber.yaml` (≈ 6–8 min)

## Objects

| Object | Where | Purpose |
| :--- | :--- | :--- |
| `ComputeClass/arcade-absorber` (cluster) | `manifests/00-platform` | n4 On-Demand, node pool auto-creation, node taint `arcade.demo/buffer=true:NoSchedule` so nothing else steals the headroom (GKE rejects `*gke.io` taint keys) |
| `PodTemplate/burst-unit` | `manifests/04-absorber` | The unit the buffers reserve room for: 500m / 512Mi, `nodeSelector compute-class: arcade-absorber`, toleration `arcade.demo/buffer`. Same scheduling shape as the burst worker. |
| `CapacityBuffer/absorber-active` | same | `provisioningStrategy: buffer.x-k8s.io/active-capacity`, `podTemplateRef: burst-unit`, `replicas: 0` at rest |
| `CapacityBuffer/absorber-standby` | same | `provisioningStrategy: buffer.gke.io/standby-capacity`, annotation `buffer.gke.io/standby-capacity-init-time: 1m`, `replicas: 0` at rest |
| `Deployment/burst-worker` | same | 0 replicas; `arcade worker --mode=burst` (`WARMUP_CPU_SECONDS=10`, readiness `/ready` every 1 s), 500m / 512Mi |

Presets (`absorber.preset`): `none` 0/0 · `active4` 4/0 · `active8` 8/0 · `standby8` 0/8 (active/standby replicas). Start state: `none`, burst-worker 0.

Verified on the cluster: both buffers are accepted with `ReadyForProvisioning=True`; the status conditions are `ReadyForProvisioning`, `LimitedByQuotas` and **`Provisioning`** (reason `BufferIsEmpty` at 0 replicas) — there is no `Ready` condition. Before `ComputeClass/arcade-absorber` exists the condition reads `computeclass … not found`.

## What to click / say

1. **Preset: none → Fire burst (+8)** — *"Eight workers, no spare capacity. The autoscaler has to build nodes first."* Stopwatch runs until every pod is Ready (2–4 min: pool creation, boot, pull, 10 s warm-up).
2. **Reset → Preset: active 8** — ghost pods appear; nodes are created for them and sit empty. *"GKE simulates these placeholder pods and keeps real nodes warm for them. You pay for the headroom; you see it as ghosts."*
3. **Fire burst (+8)** — pods snap into the ghosts; all Ready in ~15–20 s (pull + warm-up only).
4. **Preset: standby 8** — nodes come up, then after ~1 min show ❄ (`Suspended=True`). *"Same headroom, suspended VMs: cheaper to hold, about 30 s to resume."* Fire again: watch ❄ nodes wake.
5. Score = time-to-all-Ready vs. headroom $/h; post initials to the leaderboard.

## What to watch

```sh
kubectl get capacitybuffer -n arcade-absorber -w                 # REPLICAS READYFORPROVISIONING PROVISIONING
kubectl get capacitybuffer -n arcade-absorber -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.replicas}{"\t"}{.status.conditions}{"\n"}{end}'
kubectl get nodes -l cloud.google.com/compute-class=arcade-absorber -o custom-columns='NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,SUSPENDED:.status.conditions[?(@.type=="Suspended")].status,TAINTS:.spec.taints[*].key'
kubectl get pods -n arcade-absorber -o wide -w
kubectl get pods -n arcade-absorber -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="PodScheduled")].lastTransitionTime}{"\t"}{.status.conditions[?(@.type=="Ready")].lastTransitionTime}{"\n"}{end}'
kubectl get configmap cluster-autoscaler-status -n kube-system -o jsonpath='{.data.status}' | grep -A12 absorber
```

## Recovery

| Symptom | Fix |
| :--- | :--- |
| `ReadyForProvisioning=False … computeclass "arcade-absorber" not found` | Apply `manifests/00-platform` first. |
| Buffer `replicas>0` but no nodes appear | Node pool auto-creation must be on in the ComputeClass; check `kubectl get events -A --field-selector reason=FailedScaleUp`; standby buffers *require* NPAC. |
| Burst pods Pending on buffer nodes: `untolerated taint` | Toleration key must be `arcade.demo/buffer` (not `arcade.gke.io/buffer`). Re-apply `manifests/04-absorber`. |
| Burst pods land on non-buffer nodes | The PodTemplate and the Deployment must have identical nodeSelector/tolerations/requests; diff `podtemplate.yaml` vs `deployment.yaml`. |
| Suspended nodes never resume | Resume needs the same machine type in the zone; check Compute audit logs for `compute.instances.resume` errors (`ZONE_RESOURCE_POOL_EXHAUSTED`). Fall back to the active preset. |
| Cost guard | `absorber.preset none` + `absorber.reset` (burst-worker 0); the CA deletes empty buffer nodes after the 1-min consolidation delay. |
