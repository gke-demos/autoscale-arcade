# GKE Autoscaling Feature Facts for KubeCon NA 2026 Demo (GKE Standard 1.37, Rapid)

> Reference notes compiled 2026-11-02 from the public GKE documentation and release notes. Versions quoted are the documented minimums; all are below 1.37.

---

## 1. Custom Compute Classes (`cloud.google.com/v1` `ComputeClass`)

**Docs:** https://docs.cloud.google.com/kubernetes-engine/docs/concepts/about-custom-compute-classes · CRD ref: https://docs.cloud.google.com/kubernetes-engine/docs/reference/crds/computeclass · Troubleshooting: https://docs.cloud.google.com/kubernetes-engine/docs/troubleshooting/custom-computeclass

### (a) API & minimal YAML (cluster‑scoped)
```yaml
apiVersion: cloud.google.com/v1
kind: ComputeClass
metadata:
  name: cost-optimized
spec:
  priorities:                      # ordered, first = most preferred
  - machineFamily: n4
    spot: true
  - machineFamily: n2
    spot: true
  - machineFamily: n4
    spot: false                    # on-demand fallback
  nodePoolAutoCreation:
    enabled: true
  activeMigration:
    optimizeRulePriority: true     # move Pods back to higher-priority rule when capacity returns
  autoscalingPolicy:
    consolidationDelayMinutes: 5
    consolidationThreshold: 70     # % CPU AND memory; node is a scale-down candidate only below this
    # gpuConsolidationThreshold: 100
  whenUnsatisfiable: DoNotScaleUp  # or ScaleUpAnyway
  priorityDefaults:                # defaults applied to every priority rule (>= 1.32.1-gke.1729000)
    nodeSystemConfig:
      linuxNodeConfig:
        sysctls:
          net.core.somaxconn: "256"
```
Workload selects it with `nodeSelector: {cloud.google.com/compute-class: cost-optimized}`.
Other priority-rule fields: `machineType`, `minCores`, `minMemoryGb`, `minCpuPlatform`, `gpu{type,count,driverVersion}`, `tpu{...}`, `nodepools: [...]` (existing pools, Standard only), `priorityScore` (1–1000, ≥1.35.2-gke.1842000), `reservations`, `storage{bootDiskType,bootDiskSize,localSSDCount}`, `location{zones,locationPolicy}`, `nodeLabels`, `taints`, `flexStart`, `maxRunDurationSeconds`.
Other top-level: `nodePoolConfig{imageType, serviceAccount, sandbox{type: gvisor|microvm}, nodeLabels, taints, instanceMetadata, ...}`, `minimumCapacity`, `autopilot.enabled`.

### (b) Prerequisites / flags
- Base version: 1.30.3-gke.1451000+. Cluster must use cluster autoscaler (CCC relies on it).
- **Node pool auto‑creation without cluster‑level NAP ("NAPless") requires GKE ≥ `1.33.3-gke.1136000`** – just set `nodePoolAutoCreation.enabled: true`. Earlier versions also require `gcloud container clusters update CLUSTER --enable-autoprovisioning --min-cpu/--max-cpu/--min-memory/--max-memory ...`.
- Manually created node pools must be tagged to be usable by a class: `--node-labels=cloud.google.com/compute-class=NAME` **and** `--node-taints=cloud.google.com/compute-class=NAME:NoSchedule` (not needed for the cluster-default class).
- Pods must NOT also select `cloud.google.com/gke-spot`, `cloud.google.com/machine-family`, `cloud.google.com/machine-type`, `cloud.google.com/gke-accelerator`, etc. — GKE **rejects** Pods that select a ComputeClass and one of those system labels (table in docs §"Node selectors for system node labels").
- Default class for a namespace/cluster: label `cloud.google.com/default-compute-class` (docs: run-pods-default-compute-classes).

### (c) Observable signals
- Node labels GKE writes on CCC nodes: `cloud.google.com/compute-class=<name>` (always), `cloud.google.com/machine-family=<n4|n2…>`, `node.kubernetes.io/instance-type=<n4-standard-4>`, `cloud.google.com/gke-spot=true` (+ taint `cloud.google.com/gke-spot=true:NoSchedule`) on Spot nodes, `cloud.google.com/gke-nodepool=<auto-created pool name>`, `cloud.google.com/gke-provisioning=spot|standard`. List: `kubectl get nodes -l cloud.google.com/compute-class=NAME`.
- Node taint: `cloud.google.com/compute-class=<name>:NoSchedule` (Pods selecting the class get a matching toleration injected).
- Pod events from CA: `TriggeredScaleUp` / `NotTriggerScaleUp` (also `FailedScaleUp` with `ZONE_RESOURCE_POOL_EXHAUSTED` / `GCE out of resources`), node events `ScaleDown`.
- ComputeClass `status.conditions[]` (type/status/reason/message/observedGeneration).
- Cloud Monitoring (GKE ≥1.37): `kubernetes.io/autoscaler/cluster_pending_pods_per_ccc`, `.../cluster_node_provisioning_attempts_count_per_ccc`, `.../cluster_node_provisioning_failed_attempts_count_per_ccc` (resource `k8s_entity`, `entity_name` = ComputeClass name). Logs: `container.googleapis.com/cluster-autoscaler-visibility`.
- Active migration is visible as: new node appears → old node cordoned (`SchedulingDisabled`) → drained → deleted.

### (d) Gotchas
- `whenUnsatisfiable` default **changed in 1.33**: now `DoNotScaleUp` (was `ScaleUpAnyway`). Set it explicitly. `ScaleUpAnyway` on Standard+NPAC may create an **E2** pool.
- Active migration + Spot high priority + standby buffers = suspended Spot nodes can't resume as on‑demand (see §2).
- Active migration evicts Pods (respects PDBs, `safe-to-evict: "false"`); don't use for stateful.
- `priorityDefaults` not compatible with `nodepools` rules. `priorityScore` must be on all rules or none.
- CRD defaults shown in ref: `consolidationDelayMinutes: 1`, `consolidationThreshold: 0`, `gpuConsolidationThreshold: 0`, `optimizeRulePriority: false`, `nodePoolAutoCreation.enabled: false`.

---

## 2. Capacity Buffers (`autoscaling.x-k8s.io/v1beta1` `CapacityBuffer`) — Preview

**Docs:** concept https://docs.cloud.google.com/kubernetes-engine/docs/concepts/capacity-buffer · how‑to https://docs.cloud.google.com/kubernetes-engine/docs/how-to/configure-capacity-buffer · CRD https://docs.cloud.google.com/kubernetes-engine/docs/reference/crds/capacitybuffer · simulator https://github.com/gke-labs/buffers-simulator

GKE implements the SIG‑Autoscaling CapacityBuffer API; the GKE **cluster autoscaler** reads the CRs and simulates placeholder Pods (not visible as real Pods) to keep spare nodes.

### (a) API & YAML (namespaced; PodTemplate must be in same namespace)
```yaml
apiVersion: v1
kind: PodTemplate
metadata:
  name: buffer-unit-template
  namespace: demo
template:
  spec:
    terminationGracePeriodSeconds: 0
    nodeSelector:
      cloud.google.com/compute-class: cost-optimized   # optional: shape buffer nodes via CCC
    containers:
    - name: buffer-container
      image: registry.k8s.io/pause:3.9
      resources:
        requests: {cpu: "1", memory: "1Gi"}
        limits:   {cpu: "1", memory: "1Gi"}
---
apiVersion: autoscaling.x-k8s.io/v1beta1
kind: CapacityBuffer
metadata:
  name: active-buffer
  namespace: demo
spec:
  provisioningStrategy: "buffer.x-k8s.io/active-capacity"   # default; or "buffer.gke.io/standby-capacity"
  podTemplateRef:
    name: buffer-unit-template
  replicas: 3
  limits:                 # optional upper bound
    cpu: "20"
    memory: "20Gi"
---
apiVersion: autoscaling.x-k8s.io/v1beta1
kind: CapacityBuffer
metadata:
  name: standby-buffer
  namespace: demo
  annotations:
    buffer.gke.io/standby-capacity-init-time: "5m"        # default 5m: time node stays active before suspend
    buffer.gke.io/standby-capacity-refresh-frequency: "24h" # default 24h, max 120h
spec:
  provisioningStrategy: "buffer.gke.io/standby-capacity"
  podTemplateRef: {name: buffer-unit-template}
  replicas: 5
---
# percentage-based (scalableRef XOR podTemplateRef)
apiVersion: autoscaling.x-k8s.io/v1beta1
kind: CapacityBuffer
metadata: {name: percentage-buffer, namespace: demo}
spec:
  scalableRef: {apiGroup: apps, kind: Deployment, name: frontend}
  percentage: 20         # may exceed 100; rounds up
  replicas: 3            # ≥1.36.3-gke.1244000: max(replicas, percentage) used as floor
  provisioningStrategy: "buffer.x-k8s.io/active-capacity"
```
Spec fields: `provisioningStrategy`, `podTemplateRef.name`, `scalableRef{apiGroup,kind,name}` (Deployment/ReplicaSet/StatefulSet/ReplicationController/Job/any CRD with scale subresource), `replicas`, `percentage`, `limits{cpu,memory}`. If neither replicas nor percentage: fill up to `limits`.

### (b) Prerequisites
- Active buffers: GKE ≥ `1.35.2-gke.1842000`. Standby buffers: Standard ≥ `1.36.0-gke.2253000` (Autopilot w/ CCC ≥ 1.36.0-gke.2853000).
- Standard: node pool auto‑creation recommended for active, **required for standby**. Without it CA only scales existing pools.
- Node‑based billing only (no Autopilot pay‑per‑Pod).
- Standby limits: no GPU/TPU, no Local SSD, no Confidential nodes, COS/Ubuntu only, ≤208 GB RAM, resume needs same machine type+CPU platform in zone; suspended Spot can't resume as on‑demand.
- Custom scalableRef CRDs on < 1.36.0-gke.2459000 need extra RBAC for CA.

### (c) Observable signals
- `kubectl get capacitybuffer -A` → columns incl. STATUS `ReadyForProvisioning`.
- `status.replicas` (computed units), `status.podTemplateRef`, `status.podTemplateGeneration`, `status.provisioningStrategy`, `status.conditions[]` with types **`ReadyForProvisioning`** (billing‑model compat), **`Ready`** (buffer provisioned), **`LimitedByQuotas`** (namespace ResourceQuota capped `status.replicas`).
- Standby nodes carry Node condition **`type: Suspended` status True** → `kubectl get nodes -o custom-columns='NAME:.metadata.name,SUSPENDED:.status.conditions[?(@.type=="Suspended")].status'`; taint `buffer.gke.io/standby-capacity-node-suspended` (DaemonSets need a toleration to stay on them).
- Scheduling priority on scale‑up: active buffer nodes → standby not‑yet‑suspended → suspended standby (≈30–35 s resume) → new nodes (60–120 s).
- Metric: `kubernetes.io/pod/latencies/pod_first_ready`; CA visibility log `no.scale.up.nap.quota.exceeded`; Compute audit logs `compute.instances.resume` with `ZONE_RESOURCE_POOL_EXHAUSTED`/`QUOTA_EXCEEDED`.

### (d) Gotchas
- Buffer capacity is **not reserved** to the scalableRef workload — any Pod whose selectors/tolerations match can take it; use workload separation (taints/tolerations) to fence it.
- If the PodTemplate selects a gVisor CCC, add `runtimeClassName: gvisor` or a toleration for `sandbox.gke.io/runtime=gvisor:NoSchedule`, otherwise CA loops creating/deleting pools.
- Buffer units count against Kubernetes ResourceQuota as if running; suspended VMs still consume IP quota and PD‑standard quota (memory image).
- Pair with `--autoscaling-profile=optimize-utilization` for quicker scale‑down. Scaled‑down nodes are deleted, not re‑suspended; standby is refilled with fresh nodes.

---

## 3. Native Scale‑to‑Zero (HPA `minReplicas: 0` + `AutoscalingMetric`)

**Docs:** tutorial https://docs.cloud.google.com/kubernetes-engine/docs/tutorials/scale-to-from-zero-hpa · concept https://docs.cloud.google.com/kubernetes-engine/docs/concepts/horizontalpodautoscaler#scaling-to-and-from-zero · how‑to https://docs.cloud.google.com/kubernetes-engine/docs/how-to/horizontal-pod-autoscaling#scale-to-from-zero-hpa · metrics https://docs.cloud.google.com/kubernetes-engine/docs/how-to/autoscale-using-metrics · troubleshooting https://docs.cloud.google.com/kubernetes-engine/docs/troubleshooting/horizontal-pod-autoscaling#troubleshoot-scale-to-from-zero-hpa · blog https://cloud.google.com/blog/products/containers-kubernetes/gke-adds-native-scale-to-zero-capabilities

**What it is:** NOT a new API. It is the standard `autoscaling/v2` HPA with `minReplicas: 0` (upstream K8s 1.37 enables HPAScaleToZero beta; GKE release note "New features in 1.37": "HorizontalPodAutoscaler enables beta support for scaling to zero"). GKE's managed HPA controller handles it, and the metric source is GKE's own managed `AutoscalingMetric` CRD (`autoscaling.gke.io/v1beta1`) — no KEDA / no custom‑metrics adapter.

### (a) YAML
```yaml
apiVersion: autoscaling.gke.io/v1beta1
kind: AutoscalingMetric
metadata:
  name: pubsub-queue-depth
  namespace: default
spec:
  metrics:
  - promql:
      name: pubsub-undelivered
      query: >
        {
          "pubsub.googleapis.com/subscription/num_undelivered_messages",
          subscription_id="my-worker-subscription"
        }
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: async-worker-hpa
  namespace: default
spec:
  scaleTargetRef: {apiVersion: apps/v1, kind: Deployment, name: async-worker}
  minReplicas: 0
  maxReplicas: 20
  metrics:
  - type: External
    external:
      metric:
        name: autoscaling.gke.io|pubsub-queue-depth|pubsub-undelivered   # autoscaling.gke.io|<CR name>|<metric name>
      target: {type: AverageValue, averageValue: "10"}
```
Other `AutoscalingMetric` sources: `promql` (any Cloud Monitoring / Managed Prometheus series incl. LB metrics), or `pod:` (scrape Prometheus gauge from the workload's own `/metrics`, ≥1.37.0-gke.3100000 GA; needs HPA performance profile). Get the exact HPA metric name from `kubectl describe autoscalingmetric X` → `Status.Metric Statuses.Hpa Name`.

### (b) Prerequisites
- Control plane **and nodes** on GKE ≥ **1.37**. `apiVersion: autoscaling/v2`. At least one `External` or `Object` metric (Resource metrics can't wake from 0).
- AutoscalingMetric, HPA and Deployment in the **same namespace**. GKE auths to Cloud Monitoring automatically for same‑project metrics. (Workload Identity for the app to consume Pub/Sub.)
- No gcloud flag needed. (Performance HPA profile is auto‑enabled on Standard ≥1.33; `--hpa-profile=performance` to force.)

### (c) Observable signals
- HPA `status.conditions`: `AbleToScale`, `ScalingActive` (stays **True** while at 0), new **`ScaledToZero: True` reason `ScaledToZero`** ("the HPA has scaled the target resource to 0 replicas due to zero metric demand"); `ScaledToZero: False` once ≥1 replica.
- `status.currentReplicas/desiredReplicas`, `status.currentMetrics[]` external value.
- Behaviour defaults: `scaleUp.stabilizationWindowSeconds: 0`, `scaleDown.stabilizationWindowSeconds: 300`; at 0 replicas the 10% tolerance is **bypassed** (any value >0 → scale to ≥1 immediately).
- HPA events (`SuccessfulRescale`), Deployment replica count, plus Pod `Scheduled` events for latency.

### (d) Gotchas
- `kubectl scale --replicas=0` by hand ⇒ `ScalingActive: False` and HPA pauses until you scale back to ≥1.
- Before downgrading nodes below 1.37 set `minReplicas` ≥1 or workloads get stuck at 0.
- Cold start: pair with Capacity Buffers (docs explicitly recommend).

---

## 4. CPU Startup Boost (VPA `startupBoost`) — Preview

**Docs:** https://docs.cloud.google.com/kubernetes-engine/docs/how-to/boost-application-startup · concept https://docs.cloud.google.com/kubernetes-engine/docs/concepts/verticalpodautoscaler#cpu-startup-boost

### (a) API & YAML — standard `autoscaling.k8s.io/v1 VerticalPodAutoscaler`, new `startupBoost` block (Pod‑level) or `resourcePolicy.containerPolicies[].startupBoost` (container‑level)
```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: example-vpa
spec:
  targetRef: {apiVersion: apps/v1, kind: Deployment, name: example}
  updatePolicy:
    updateMode: "Off"            # boost only; or "InPlaceOrRecreate" to also right-size afterwards
  startupBoost:
    cpu:
      type: "Factor"             # or "Quantity"
      factor: 2                  # with Quantity: quantity: "2"
      durationSeconds: 10        # keep boost N s after Pod Ready; 0 = unboost as soon as Ready
  resourcePolicy:                # optional per-container override
    containerPolicies:
    - containerName: sidecar
      startupBoost:
        cpu: {type: Factor, factor: 1}   # opt this container out
```
### (b) Prerequisites
- GKE ≥ `1.36.0-gke.4447000` (Standard & Autopilot). Standard: VPA enabled on cluster (`gcloud container clusters update CLUSTER --enable-vertical-pod-autoscaling`). Workload must be managed by a controller (Deployment/StatefulSet). Node must have room; otherwise GKE caps the boost to fit.
- `InPlaceOrRecreate` VPA mode requires ≥ 1.34.0-gke.2201000 (Preview); relies on in‑place pod resize (`resizePolicy` default `NotRequired`).

### (c) Observable signals
- Pod annotation injected by VPA admission webhook: **`vpaCpuStartupBoost/<CONTAINER_NAME>`** = JSON of original requests/limits (present ⇒ boost applied; absent ⇒ ignored).
- Pod `spec.containers[].resources.requests.cpu` is the boosted value; after unboost it returns to baseline in place. Compare `spec...resources` vs `status.containerStatuses[].resources` (actual) and `status.resize`/`PodResizePending`/`PodResizeInProgress` conditions during the resize.
- Events: **`InPlaceResizedByVPA`** (`kubectl get events --field-selector reason=InPlaceResizedByVPA`) on unboost; also kubelet `ResizeCompleted`.
- `kubectl describe vpa` shows the config.

### (d) Gotchas
- VPA Updater runs on a **1‑minute** loop ⇒ boost may persist up to ~60 s longer than `durationSeconds`.
- Applies only at Pod creation (admission); container restarts (e.g., OOMKill) are NOT re‑boosted.
- With CPU‑based HPA: define a `readinessProbe` and set `durationSeconds: 0` to avoid false scale‑outs.
- Standard + CA: boost may cause a node scale‑up, then scale‑down/eviction loop; docs recommend Autopilot to avoid. Container `mode: "Off"` in containerPolicies is used to disable continuous VPA for that container while still boosting.

---

## 5. Pod Snapshots (`podsnapshot.gke.io/v1`) — GA since 1.35.3-gke.1234000

**Docs:** concept https://docs.cloud.google.com/kubernetes-engine/docs/concepts/pod-snapshots · prepare https://docs.cloud.google.com/kubernetes-engine/docs/how-to/pod-snapshots-prepare · trigger https://docs.cloud.google.com/kubernetes-engine/docs/how-to/pod-snapshots-trigger · restore/manage https://docs.cloud.google.com/kubernetes-engine/docs/how-to/pod-snapshots · CRDs https://docs.cloud.google.com/kubernetes-engine/docs/reference/crds/podsnapshot · GKE Sandbox https://docs.cloud.google.com/kubernetes-engine/docs/how-to/sandbox-pods

### (a) CRDs (all `apiVersion: podsnapshot.gke.io/v1`)
```yaml
kind: PodSnapshotStorageConfig          # cluster-scoped
metadata: {name: example-pod-snapshot-storage-config}
spec:
  snapshotStorageConfig:
    gcs:
      bucket: BUCKET_NAME
      path: FOLDER_PATH                 # optional
      tokenSource: podKSA               # default; or federatedP4SA (multi-tenant, ≥1.35.3-gke.1737000)
---
kind: PodSnapshotPolicy                 # namespaced
metadata: {name: example-pod-snapshot-policy, namespace: demo}
spec:
  storageConfigName: example-pod-snapshot-storage-config
  selector: {matchLabels: {app: my-app}}
  triggerConfig:
    type: workload                      # workload | manual
    postCheckpoint: resume              # resume (default) | stop
  snapshotScope: whole-pod              # whole-pod (default) | rootfs-only (≥1.35.3-gke.1031000)
  retentionConfig: {lastAccessTimeout: 7d}        # optional; units y/mo/d/h/min
  snapshotGroupingRules:                          # optional (≥1.35.0-gke.3047000)
    groupByLabelValue:
      labels: ["tenant"]
      groupRetentionPolicy: {maxSnapshotCountPerGroup: 5}
---
kind: PodSnapshotManualTrigger          # namespaced; only when triggerConfig.type: manual
metadata: {name: example-manual-trigger, namespace: demo}
spec:
  targetPod: my-pod
---
kind: PodSnapshot                        # created by GKE, read-only; spec.policyName
```
Workload trigger from inside the Pod: write `1` to `/proc/gvisor/checkpoint` (read on same fd blocks until done; returns `restore` on restore). Pod needs `runtimeClassName: gvisor`, a KSA with GCS access, matching labels. Restore = create a Pod with identical distilled spec; pin a specific snapshot with annotation `podsnapshot.gke.io/ps-name: <PodSnapshot name>`.

### (b) Prerequisites / flags
- Cluster ≥ **1.35.3-gke.1234000**; Standard: `gcloud container clusters create CLUSTER --enable-pod-snapshots --cluster-version=… --workload-pool=PROJECT.svc.id.goog --workload-metadata=GKE_METADATA --location=…`; existing: `gcloud beta container clusters update CLUSTER --enable-pod-snapshots --location=…`.
- gVisor node pool (Standard): `gcloud container node-pools create NP --cluster=C --location=L --machine-type=MT --image-type=cos_containerd --sandbox type=gvisor` (cluster must keep ≥1 non‑sandbox pool for system workloads). Or via **ComputeClass** (≥1.36.2-gke.1368000): `spec.nodePoolConfig.sandbox.type: gvisor` + `nodePoolAutoCreation.enabled: true` (docs example uses `machineFamily: n4/c4`, `whenUnsatisfiable: DoNotScaleUp`). Pods then use `runtimeClassName: gvisor` (taint `sandbox.gke.io/runtime=gvisor:NoSchedule` is auto‑tolerated via RuntimeClass).
- GCS bucket: `gcloud storage buckets create gs://B --uniform-bucket-level-access --enable-hierarchical-namespace --location=<same as cluster>` + soft‑delete disabled; IAM for the Pod KSA (objectUser etc.) and for the Pod‑snapshot controller P4SA.
- **Machine types:** `whole-pod` scope does **not** support E2 (or any series mixing CPU vendors/generations); use N2, C3, N4, etc. — docs' Autopilot example CCC: `priorities: [n2, c3]`, `activeMigration.optimizeRulePriority: false`, `whenUnsatisfiable: DoNotScaleUp`. Restore node must have the same machine series, CPU vendor and CPUID feature set and same gVisor kernel/GPU driver version. `rootfs-only` works on any family incl. E2. GPU: g2-standard-4/8/12/16/32/48/96, a2-highgpu-1g, a2-ultragpu-1g, a3-highgpu-1g; multi‑GPU Pods only on L4; no MIG, no TPU, no GCSFuse sidecar.
- Regions: docs impose no region allow‑list beyond "bucket in same location as cluster" and the machine‑type availability.
- Spot/NAP: not prohibited in the docs; gVisor via CCC + NPAC is the supported path. Spot works but note (a) CCC + `priorities[].spot: true` is fine, and (b) whole‑pod restores need identical CPU platform, so keep rules narrow (`machineType` or `minCpuPlatform`) and disable `optimizeRulePriority` to avoid migrations across platforms.

### (c) Observable signals
- Events on the Pod: reason **`GKEPodSnapshotting`**, message `Successfully checkpointed the pod to PodSnapshot` (`kubectl get events --field-selector involvedObject.name=POD,reason=GKEPodSnapshotting`).
- `kubectl get podsnapshots.podsnapshot.gke.io -n NS` → columns NAME (UUID) / STATUS (e.g. `AllSnapshotsAvailable`) / POLICY / AGE. `status.conditions` (must be `Ready` for restore), `status.lastAccessTime`, `status.observedCheckpointRetryCount`, `status.storageStatus.gcs.observedGCSPath`.
- `PodSnapshotManualTrigger.status.conditions` (checkpoint completed) and `status.snapshotCreated` (PodSnapshot name).
- `PodSnapshotPolicy/StorageConfig.status.conditions`, `observedGeneration`.
- App logs: `GKE Pod Snapshot: restore`. Readiness/TTFT to measure true restore (memory & GPU state stream lazily in background).

### (d) Gotchas
- Restored Pod gets a new IP/hostname; open connections closed; env vars baked into memory (new ones at `/proc/gvisor/spec_environ`); secrets/keys must be regenerated.
- Snapshot ≈ memory + rootfs/tmpfs changes (+GPU state copied to memory) — delete model files pre‑checkpoint to halve size; raise memory limits for GPU snapshots.
- `postCheckpoint: resume` + PVC mutations after checkpoint can break restores.
- Deleting the PodSnapshotPolicy mid‑operation may fail the Pod; deleting a PodSnapshot deletes its GCS objects.
- Workload trigger fires once per workload cycle; manual trigger reusable.

---

## 6. What's new in GKE 1.37 for autoscaling (demo‑worthy)

Release notes: https://docs.cloud.google.com/kubernetes-engine/docs/release-notes (Rapid: `…/release-notes-rapid`, New features: `…/release-notes-new-features`). Kubernetes 1.37 reached Rapid on 2026‑09‑04.

- **HPA scale to/from zero** – upstream beta in K8s 1.37; GKE native support via `AutoscalingMetric`, `ScaledToZero` condition (§3). Requires 1.37 CP + nodes.
- **AutoscalingMetric in‑cluster Pod metric scraping GA** at 1.37.0-gke.3100000 (`spec.metrics[].pod.containers[].endpoint` + `gauge`); PromQL/Cloud Monitoring source already available.
- **New CA metrics (1.37+)**: `kubernetes.io/autoscaler/cluster_pending_pods_per_ccc`, `cluster_node_provisioning_attempts_count_per_ccc`, `cluster_node_provisioning_failed_attempts_count_per_ccc` (per‑ComputeClass) — great for a dashboard.
- **ComputeClass additions**: `nodePoolConfig.sandbox.type: microvm` + `priorityDefaults.enableNestedVirtualization` (1.37.0-gke.4713000, microVM GA); Z4M & C4D‑metal via CCC/NPAC (1.37.0-gke.4713000); CapacityQuota per‑class limits (1.36.2-gke.2064000); `priorityScore` (1.35.2+); `AnyThenFail` reservation affinity (1.36.0-gke.3204000); `shieldedInstanceConfig` under `nodePoolAutoCreation` (1.36.3-gke.1244000).
- **Capacity buffers** active (1.35.2+) and standby (1.36.0+), `replicas`+`percentage` floor (1.36.3-gke.1244000).
- **VPA**: CPU startup boost (1.36.0-gke.4447000, Preview); `InPlaceOrRecreate` (1.34.0-gke.2201000, Preview) using in‑place pod resize — verify with `ResizeCompleted` / `InPlaceResizedByVPA` events; HPA‑rightsizing with VPA (1.36.3-gke.1630000, Preview).
- **Node upgrades in place** (Standard CPU pools keep the VM when `maxUnavailable>0`, all versions, Oct 2026) and **new, lower system reservation formula** on node pools created at 1.37+.
- Upstream K8s 1.37 (per kubernetes.io) adds alpha `InPlacePodVerticalScalingSchedulerPreemption`; not a GKE‑exposed flag on a managed cluster — treat as background only.

> [!WARNING]
> In‑place pod resize GA status: GKE docs still mark `InPlaceOrRecreate` VPA mode Preview; the docs I read do not state an in‑place‑resize GA milestone for 1.37. Don't claim "GA" on stage without checking the K8s 1.37 changelog.

---

## 7. Cluster‑autoscaler status in‑cluster (`kube-system/cluster-autoscaler-status` ConfigMap)

Docs: https://docs.cloud.google.com/kubernetes-engine/docs/concepts/cluster-autoscaler#observability and `…/troubleshooting/cluster-autoscaler-scale-up#unhealthy-clusters`. GKE's CA (37.x) publishes the **upstream YAML format** (CA ≥1.30; GKE internal tests parse it with `yaml:"time"`, `yaml:"autoscalerStatus"`, `nodeGroups[].scaleUp.status`). Read it with:
```sh
kubectl get configmap cluster-autoscaler-status -n kube-system -o jsonpath='{.data.status}'
```
Annotation `cluster-autoscaler.kubernetes.io/last-updated` on the ConfigMap; CA also emits Events on this ConfigMap (e.g. `Warning ClusterUnhealthy`, `ScaledUpGroup`, `ScaleDownEmpty`, `ScaleDown`).

Schema of `data.status` (upstream `cluster-autoscaler/clusterstate/api/types.go`):
```yaml
time: "2026-11-02 11:00:00.000000000 +0000 UTC"
autoscalerStatus: Running            # Initializing | Running
message: ""
clusterWide:
  health:
    status: Healthy                  # Healthy | Unhealthy
    nodeCounts:
      registered:
        total: 5
        ready: 5
        notStarted: 0
        beingDeleted: 0
        unready: {total: 0, resourceUnready: 0}
      longUnregistered: 0
      unregistered: 0
    lastProbeTime: "2026-11-02T11:00:00Z"
    lastTransitionTime: "…"
  scaleUp:
    status: NoActivity               # InProgress | NoActivity | Backoff
    lastProbeTime: "…"
    lastTransitionTime: "…"
  scaleDown:
    status: NoCandidates             # CandidatesPresent | NoCandidates | InProgress
    candidates: 0
    lastProbeTime: "…"
    lastTransitionTime: "…"
nodeGroups:
- name: https://www.googleapis.com/compute/v1/projects/P/zones/Z/instanceGroups/gke-C-pool-abc-grp
  health:
    status: Healthy
    nodeCounts: {registered: {total: 2, ready: 2, notStarted: 0, beingDeleted: 0, unready: {total: 0, resourceUnready: 0}}, longUnregistered: 0, unregistered: 0}
    cloudProviderTarget: 2
    minSize: 0
    maxSize: 1000
    lastProbeTime: "…"
    lastTransitionTime: "…"
  scaleUp:
    status: NoActivity
    backoffInfo: {errorCode: "", errorMessage: ""}   # populated on Backoff (e.g. ZONE_RESOURCE_POOL_EXHAUSTED)
    lastProbeTime: "…"
    lastTransitionTime: "…"
  scaleDown:
    status: NoCandidates
    candidates: 0
    lastProbeTime: "…"
    lastTransitionTime: "…"
```
Node group names are GCE MIG URLs; map to pool via node label `cloud.google.com/gke-nodepool`. Also useful for the UI: Pod events `TriggeredScaleUp`/`NotTriggerScaleUp`/`FailedScaleUp`, node annotation `cluster-autoscaler.kubernetes.io/scale-down-disabled`, Node taint `ToBeDeletedByClusterAutoscaler`, and Cloud Logging `container.googleapis.com/cluster-autoscaler-visibility` (decision/noDecisionStatus/resultInfo).

> [!TIP]
> For visualization pick: per node group `health.nodeCounts.registered.{total,ready}` vs `cloudProviderTarget` (shows nodes being created), `scaleUp.status`, `scaleDown.{status,candidates}`, plus Node `Suspended` condition (standby buffers) and `cloud.google.com/compute-class` label to colour nodes by class/spot.
