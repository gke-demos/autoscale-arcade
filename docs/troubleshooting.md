# Troubleshooting

Platform-level problems, in the order they tend to appear. Per-cabinet symptoms live in `docs/cabinets/<cabinet>.md` → *Recovery*.

First look, always:

```sh
PROJECT_ID=gke-demos-345619 ./hack/preflight.sh            # APIs, quotas, assets
./hack/cluster.sh verify                                  # addon deployments + PodMigration config
kubectl get nodes -L cloud.google.com/compute-class,cloud.google.com/gke-spot,cloud.google.com/gke-provisioning,arcade.gke.io/pool
kubectl get pods -A | grep -vE 'Running|Completed'
kubectl get configmap cluster-autoscaler-status -n kube-system -o jsonpath='{.data.status}' | head -40
kubectl -n arcade-system logs deploy/arcade-server --tail=200
```

## Cluster & access

| Symptom | Cause / fix |
| :--- | :--- |
| `kubectl` hangs or `Unable to connect to the server` | The control plane has a **DNS endpoint only** (no public/private IP). Re-run `./hack/cluster.sh credentials` (adds `--dns-endpoint`), make sure `gke-gcloud-auth-plugin` is installed and your account has `container.clusters.get`. From inside the sandboxed agent shell, run `kubectl`/`gcloud` unsandboxed. |
| `gcloud container clusters describe` says `RECONCILING` for a long time | Node pool operations (gVisor pool creation, NPAC) keep the cluster reconciling; harmless. `gcloud container operations list --filter=STATUS!=DONE`. |
| gVisor pool has fewer than 3 nodes | A zone was out of `n4-standard-4` (`RESOURCE_POOL_EXHAUSTED` in `gcloud container operations describe`). Either wait (GKE retries) or recreate the pool with `--node-locations` on the zones that have stock. Pod migration still works with 2 nodes. |
| Images from ghcr.io / Docker Hub never pull on new nodes | Private nodes need Cloud NAT in the region (`gcloud compute routers list`). The arcade image is in Artifact Registry and pulls via Private Google Access regardless. |

## Addons (cert-manager, workload-class, pod-migration)

| Symptom | Cause / fix |
| :--- | :--- |
| `kubectl apply` of `dist/install.yaml` fails with `no matches for kind "Certificate"` | cert-manager CRDs not ready yet. `./hack/cluster.sh addons` is idempotent — run it again. |
| `pod-migration-controller` pods `ImagePullBackOff` | Default image is `us-central1-docker.pkg.dev/<project>/autoscale-arcade/pod-migration-controller:latest`, built with Cloud Build from gke-labs/pod-migration. Build it (`gcloud builds submit` in a checkout of that repo with `--tag` set) or set `POD_MIGRATION_IMAGE=ghcr.io/gke-labs/pod-migration-controller:latest` and re-run `addons`. |
| `PodMigration/arcade` exists but no `PodSnapshotPolicy` in `arcade-teleporter` | Controller not leader / not running: `kubectl -n pod-migration-system logs deploy/pod-migration-controller`. Deleting and re-creating the PodMigration re-reconciles. |
| Eviction of a labelled pod is **not** intercepted (pod just dies) | The webhook has `failurePolicy: Ignore`; if the controller is down evictions pass through. Check the `validating-webhook-configuration` CA bundle is injected (`cert-manager.io/inject-ca-from`) and the controller pods are Ready. Also: the pod must have `runtimeClassName: gvisor` **and** label `pod-migration.gke.io/enabled: "true"`. |
| `WorkloadClass` shows `VALIDATED False` | See docs/cabinets/spot-on.md. The guardrail requires `disruptionPolicy.maxNonDisruptionDurationDays` 1–30. |

## Pod migration

| Symptom | Cause / fix |
| :--- | :--- |
| PMJ `Failed`, reason `SnapshotTriggerFailed`, message `runsc error: exit status 128` and agent log `closing state file failed: input/output error` | **The snapshot bucket is missing or not writable.** Seen on day 1: the bucket had never been created. `./hack/cluster.sh storage` (creates `gs://<project>-autoscale-arcade-snapshots`, grants the GKE robot and every KSA in `arcade-teleporter`). IAM takes up to a minute to propagate. Check with `gcloud storage buckets get-iam-policy gs://…`. |
| Event `GKEPodSnapshotting … falling back to a cold start … resource name may not be empty` on a fresh pod | Normal noise on the *first* start of a pod that matches the policy (no snapshot to restore). Only matters if it appears on the replacement pod *after* a migration. |
| PMJ stuck in `Restoring` | Replacement pod cannot schedule on the pinned node (`kubectl describe pod pet-0`): wrong hostname in the StatefulSet `nodeSelector`, node cordoned, or node not gVisor. Fix the selector; the job times out after 10 min (`pod-migration.gke.io/timeout`). |
| `Restored=True` but reason `RestoreInferred` | Expected: GKE Pod Snapshots gives no positive restore signal; the controller infers success from 30 s of Ready without a restart. The pet detects the restore itself (tick gap) and bumps `lives`. |
| Replacement pod on the right node but state reset (`SucceededWithoutRestore`) | Restore degraded to a cold start: different machine series / CPU platform between nodes, or the snapshot was deleted. Keep the gVisor pool on one machine type (`n4-standard-4`) and autoscaling off. |
| `pet-0` stuck `Terminating` with label `pod-migration.gke.io/fenced=true` | The fence webhook (`failurePolicy: Fail`) holds status writes while the controller is down. Bring the controller back; as a last resort `kubectl label pod pet-0 pod-migration.gke.io/fenced-` **only** if you know its checkpoint never ran. |
| `PodMigration` wedged in `Terminating` | The storage-cleanup finalizer needs the controller. Start it, or `kubectl patch podmigration arcade -n arcade-teleporter --type=json -p='[{"op":"remove","path":"/metadata/finalizers"}]'`. |

## ComputeClasses / node pool auto-creation

| Symptom | Cause / fix |
| :--- | :--- |
| `ComputeClass … is invalid: MachineFamily and MachineType cannot be set together` | A priority rule may set one or the other. The arcade uses `machineType`. |
| `GKE Warden rejected … label/taint key cannot contain reserved gke.io substring` | Node labels/taints in a ComputeClass may not use `*.gke.io`. The absorber fence taint is `arcade.demo/buffer`. |
| Pods Pending, event `NotTriggerScaleUp` / CA `scaleUp.backoffInfo.errorCode: RESOURCE_POOL_EXHAUSTED` | A real stockout in that zone (seen for on-demand n4 in us-central1-c). The class falls through to the next rung / another zone by itself; nothing to do except wait or scale down. |
| Pod with `nodeSelector cloud.google.com/compute-class` **and** `cloud.google.com/gke-spot` is rejected at admission (`[denied by ccc-node-affinity-selector-limitation]`) | GKE Warden forbids `cloud.google.com/gke-spot` in required nodeAffinity/nodeSelector when a pod also selects a ComputeClass (upstream issue `gke-labs/workload-class#120`: the `gke-spot-placement` webhook injects `cloud.google.com/gke-spot NotIn [true]` for the On-Demand share). That is why Spot On uses dedicated `spot-spot` / `spot-od` node pools (`./hack/cluster.sh spotpools`, label `arcade.demo/cabinet=spot`) instead of a ComputeClass. |
| Spot pods stay Pending after a stockout was disengaged | The `CapacityQuota/arcade-spot-stockout` still exists (`kubectl get capacityquota`). Delete it (see docs/cabinets/spot-on.md). |
| Auto-created pools hang around after `make reset` | Consolidation is 1 min after the node drops under 70 % utilisation; system DaemonSets alone do not block it. If a node refuses to go: `kubectl describe node` → `cluster-autoscaler.kubernetes.io/scale-down-disabled`, PDBs, or a pod with local storage. |
| Absorber buffer pods / burst workers Pending with `untolerated taint arcade.demo/buffer` | Add the toleration (`key: arcade.demo/buffer, value: "true", effect: NoSchedule`) to the burst Deployment **and** the `PodTemplate/burst-unit`. |

## Gateway, DNS, IAP

| Symptom | Cause / fix |
| :--- | :--- |
| Gateway `Programmed=False` | `kubectl describe gateway arcade -n arcade-system`. Common: the named address `autoscale-arcade-ip` does not exist (`./hack/cluster.sh network`), or the certificate map `star-demo-gke-ninja` is in another project (docs/adr/0005). |
| Browser shows a certificate for the wrong host / `ERR_CERT_COMMON_NAME_INVALID` | The cert map covers `*.demo.gke.ninja` only; the hostname must be exactly `autoscale-arcade.demo.gke.ninja`. DNS A record: `gcloud dns record-sets list --zone demo-gke-ninja --name autoscale-arcade.demo.gke.ninja.` |
| `502` from the load balancer | Backend unhealthy: `arcade-server` not Ready (`kubectl -n arcade-system get pods`), or the health check path is not `/healthz` on 8080 (`HealthCheckPolicy/arcade-server`). NEG attachment can take 2–3 min after a rollout. `gcloud compute backend-services get-health <gkegw1-…-arcade-system-arcade-server-8080-…> --global`. |
| IAP page "You don't have access" | `./hack/iap.sh grant <email>`; propagation ≤ 1 min. The IAP OAuth brand must exist in the project (preflight checks). |
| IAP loops back to the sign-in page / `redirect_uri_mismatch` | Only with a custom OAuth client; the arcade uses the Google-managed client (`GCPBackendPolicy.iap` without `clientID`). Remove any stale `oauth2ClientSecret`. |
| Actions return `401` through IAP although the page loads | `IAP_AUDIENCE` in Secret `arcade-server` does not match `/projects/<number>/global/backendServices/<id>`. `./hack/iap.sh audience` rewrites it and restarts the server. |
| WebSocket drops every 30 s | `GCPBackendPolicy` `timeoutSec` not applied — `gcloud compute backend-services describe … --format='value(timeoutSec)'` should print `3600`. |
| `spot.preempt` fails with `403 … compute.instances.simulateMaintenanceEvent` | Workload Identity binding missing: `./hack/iap.sh wi` (roles/compute.instanceAdmin.v1, conditioned to `gke-autoscale-arcade-*` instances). |

## Cost guard

`make reset` scales every cabinet to zero; NPAC pools consolidate within ~2 min. `make teardown` deletes the cluster; the snapshot bucket and the static IP survive on purpose (`gcloud storage rm -r gs://…`, `gcloud compute addresses delete autoscale-arcade-ip --global` if you really want them gone).
