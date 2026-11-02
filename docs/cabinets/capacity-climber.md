# Capacity Climber — runbook

**Feature:** Custom Compute Classes (`cloud.google.com/v1 ComputeClass`) with node pool auto-creation and active migration.
**Namespace:** `arcade-climber` · **Manifests:** `manifests/01-climber` · **Scenario:** `scenarios/climber.yaml` (≈ 10 min)

## Objects

| Object | Where | Purpose |
| :--- | :--- | :--- |
| `ComputeClass/arcade-climber` (cluster-scoped) | `manifests/00-platform` | Rungs: n4d Spot → n4 Spot → n4 On-Demand; `nodePoolAutoCreation.enabled: true`; `activeMigration.optimizeRulePriority: true`; consolidation 1 min / 70 %; `whenUnsatisfiable: DoNotScaleUp` |
| `Deployment/climber` | `manifests/01-climber` | 0 replicas at rest; `nodeSelector: cloud.google.com/compute-class: arcade-climber`; 500m / 256Mi pause pods so 24 pods need several nodes |

Start state (`reset`): 0 replicas, rung 1 unlocked.

## What to click / say

1. **Scale 0 → 24** — *"One Compute Class, three rungs. No node pools exist for it yet; GKE creates them on demand, cheapest rung first."* Islands appear for the auto-created pool(s); pods fill the highest obtainable rung.
2. **Lock rung #1** — the server patches priority #1 to `reservations: {affinity: AnyThenFail}` against a non-existent reservation, so it becomes unobtainable. *"Pretend Spot N4D just ran out."*
3. **Scale → 32** — new pods land on rung 2. *"Nobody rewrote a node selector. The class fell through to the next rung."*
4. **Unlock rung #1** — active migration (`optimizeRulePriority`) drains rung-2 nodes and moves pods back up. *"Capacity came back; GKE moves the work back to the cheapest rung and deletes what it no longer needs."*
5. **Scale → 0** — consolidation deletes the empty nodes after ~1 min.

## What to watch

```sh
kubectl get nodes -L cloud.google.com/compute-class,cloud.google.com/machine-family,cloud.google.com/gke-spot,cloud.google.com/gke-nodepool
kubectl get pods -n arcade-climber -o wide -w
kubectl get events -n arcade-climber --field-selector reason=TriggeredScaleUp -w     # or NotTriggerScaleUp / FailedScaleUp
kubectl get configmap cluster-autoscaler-status -n kube-system -o jsonpath='{.data.status}' | head -40
kubectl get computeclass arcade-climber -o yaml | yq .spec.priorities              # see the lock
```

Timings seen on the real cluster: first node of a brand-new auto-created pool ≈ 2–3 min; additional nodes in an existing pool ≈ 60–90 s; consolidation ≈ 1–2 min after pods leave.

## Recovery

| Symptom | Fix |
| :--- | :--- |
| Pods Pending, event `NotTriggerScaleUp … untolerated taint` | A pod selected the class but GKE did not inject the compute-class toleration: make sure `nodeSelector` is in the Deployment template (not added by a webhook). |
| `FailedScaleUp … ZONE_RESOURCE_POOL_EXHAUSTED` on rung 1 | That is the demo. Point at the HUD; pods move to rung 2 after the CA backoff (~2–5 min). |
| Pods never climb back after unlock | `activeMigration.optimizeRulePriority` must be `true`; migration only starts once rung-1 capacity is actually obtainable. Give it 3–5 min. |
| Stuck nodes after Scale → 0 | `kubectl get nodes -l cloud.google.com/compute-class=arcade-climber`; the CA removes empty nodes after `consolidationDelayMinutes`. Check `scale-down-disabled` annotations and DaemonSet pods. |
| Reset everything | `POST /api/actions/reset {"cabinet":"climber"}` or `kubectl scale deploy/climber -n arcade-climber --replicas=0` and re-apply `manifests/00-platform` to restore the ComputeClass. |
