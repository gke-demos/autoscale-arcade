#!/usr/bin/env bash
# Bootstraps the Autoscale Arcade GKE cluster.
#
#   PROJECT_ID=… REGION=us-central1 CLUSTER=autoscale-arcade ./hack/cluster.sh [all|cluster|gvisor|spotpools|storage|credentials|addons|verify|network]
#
# Idempotent: every phase checks before it creates. Private nodes, DNS-only
# control-plane endpoint (no public or private IP endpoint), Workload Identity,
# Pod Snapshots, VPA, Gateway API, optimize-utilization autoscaling profile.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
CLUSTER="${CLUSTER:-autoscale-arcade}"
NETWORK="${NETWORK:-default}"
SUBNET="${SUBNET:-default}"
CLUSTER_VERSION="${CLUSTER_VERSION:-1.37.1-gke.1697000}"
SYSTEM_MACHINE_TYPE="${SYSTEM_MACHINE_TYPE:-n4-standard-4}"
GVISOR_MACHINE_TYPE="${GVISOR_MACHINE_TYPE:-n4-standard-4}"   # whole-pod snapshots: no E2, one series only
GVISOR_NODES_PER_ZONE="${GVISOR_NODES_PER_ZONE:-1}"            # regional cluster: 1 per zone = 3 nodes
BUCKET="${BUCKET:-${PROJECT_ID}-${CLUSTER}-snapshots}"
CERT_MANAGER_VERSION="${CERT_MANAGER_VERSION:-v1.20.2}"
WORKLOAD_CLASS_REF="${WORKLOAD_CLASS_REF:-main}"
POD_MIGRATION_REF="${POD_MIGRATION_REF:-main}"
# Built from gke-labs/pod-migration@eab05c0 with Cloud Build (see hack/preflight.sh for the build command).
POD_MIGRATION_IMAGE="${POD_MIGRATION_IMAGE:-us-central1-docker.pkg.dev/${PROJECT_ID}/autoscale-arcade/pod-migration-controller:latest}"
SNAPSHOT_NAMESPACES="${SNAPSHOT_NAMESPACES:-arcade-teleporter}"
GATEWAY_IP_NAME="${GATEWAY_IP_NAME:-autoscale-arcade-ip}"
HOSTNAME_FQDN="${HOSTNAME_FQDN:-autoscale-arcade.demo.gke.ninja}"
DNS_ZONE="${DNS_ZONE:-demo-gke-ninja}"
CERT_MAP="${CERT_MAP:-star-demo-gke-ninja}"
SPOT_POOL_ZONE="${SPOT_POOL_ZONE:-${REGION}-b}"
SPOT_POOL_MAX="${SPOT_POOL_MAX:-6}"
SPOT_OD_MACHINE_TYPE="${SPOT_OD_MACHINE_TYPE:-n4-standard-2}"
SPOT_SPOT_MACHINE_TYPE="${SPOT_SPOT_MACHINE_TYPE:-n4d-standard-2}"

phase="${1:-all}"
log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

ensure_apis() {
  log "Enabling APIs in ${PROJECT_ID}"
  gcloud services enable container.googleapis.com compute.googleapis.com storage.googleapis.com \
    certificatemanager.googleapis.com iap.googleapis.com monitoring.googleapis.com logging.googleapis.com \
    --project "${PROJECT_ID}" >/dev/null
}

create_cluster() {
  if gcloud container clusters describe "${CLUSTER}" --location "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    log "Cluster ${CLUSTER} already exists"; return
  fi
  log "Creating GKE Standard cluster ${CLUSTER} (${CLUSTER_VERSION}, Rapid, private nodes, DNS endpoint only)"
  gcloud container clusters create "${CLUSTER}" \
    --project "${PROJECT_ID}" --location "${REGION}" \
    --release-channel rapid --cluster-version "${CLUSTER_VERSION}" \
    --network "${NETWORK}" --subnetwork "${SUBNET}" --enable-ip-alias \
    --enable-private-nodes --enable-dns-access --no-enable-ip-access \
    --machine-type "${SYSTEM_MACHINE_TYPE}" --num-nodes 1 \
    --workload-pool "${PROJECT_ID}.svc.id.goog" --workload-metadata GKE_METADATA \
    --enable-pod-snapshots \
    --enable-vertical-pod-autoscaling \
    --autoscaling-profile optimize-utilization \
    --gateway-api standard \
    --enable-managed-prometheus \
    --logging SYSTEM,WORKLOAD,KCP_VPA \
    --monitoring SYSTEM,HPA,CADVISOR,KUBELET,POD,DEPLOYMENT,STATEFULSET \
    --labels demo=autoscale-arcade \
    --quiet
}

create_gvisor_pool() {
  if gcloud container node-pools describe gvisor --cluster "${CLUSTER}" --location "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    log "Node pool gvisor already exists"; return
  fi
  log "Creating gVisor node pool (${GVISOR_MACHINE_TYPE}, ${GVISOR_NODES_PER_ZONE}/zone, no autoscaling)"
  gcloud container node-pools create gvisor \
    --cluster "${CLUSTER}" --location "${REGION}" --project "${PROJECT_ID}" \
    --sandbox type=gvisor --image-type cos_containerd \
    --machine-type "${GVISOR_MACHINE_TYPE}" --num-nodes "${GVISOR_NODES_PER_ZONE}" \
    --workload-metadata GKE_METADATA \
    --node-labels arcade.gke.io/pool=gvisor \
    --quiet
}

create_storage() {
  if ! gcloud storage buckets describe "gs://${BUCKET}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    log "Creating snapshot bucket gs://${BUCKET}"
    gcloud storage buckets create "gs://${BUCKET}" --project "${PROJECT_ID}" --location "${REGION}" \
      --uniform-bucket-level-access --enable-hierarchical-namespace
  fi
  gcloud storage buckets update "gs://${BUCKET}" --clear-soft-delete >/dev/null
  local project_number
  project_number="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
  log "Granting bucket access to the GKE robot and to all KSAs in: ${SNAPSHOT_NAMESPACES}"
  gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
    --member "serviceAccount:service-${project_number}@container-engine-robot.iam.gserviceaccount.com" \
    --role roles/storage.objectUser >/dev/null
  for ns in ${SNAPSHOT_NAMESPACES}; do
    for role in roles/storage.objectUser roles/storage.bucketViewer; do
      gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
        --member "principalSet://iam.googleapis.com/projects/${project_number}/locations/global/workloadIdentityPools/${PROJECT_ID}.svc.id.goog/namespace/${ns}" \
        --role "${role}" >/dev/null
    done
  done
}

get_credentials() {
  log "Fetching credentials via the DNS endpoint"
  gcloud container clusters get-credentials "${CLUSTER}" --location "${REGION}" --project "${PROJECT_ID}" --dns-endpoint
}

install_addons() {
  log "Installing cert-manager ${CERT_MANAGER_VERSION}"
  kubectl apply -f "https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml"
  kubectl wait --for=condition=Available --timeout=5m -n cert-manager deployment/cert-manager-webhook

  log "Installing workload-class controller (${WORKLOAD_CLASS_REF})"
  kubectl apply -f "https://raw.githubusercontent.com/gke-labs/workload-class/${WORKLOAD_CLASS_REF}/dist/install.yaml"
  kubectl rollout status -n workload-class-system deployment --timeout=5m

  log "Installing pod-migration controller (${POD_MIGRATION_REF}, image ${POD_MIGRATION_IMAGE})"
  local tmp; tmp="$(mktemp -d)"
  git clone --depth 1 -q --branch "${POD_MIGRATION_REF}" https://github.com/gke-labs/pod-migration "${tmp}/pm"
  kubectl apply -f "${tmp}/pm/controller/config/crd/bases/"
  sed "s|<YOUR_CONTROLLER_IMAGE>|${POD_MIGRATION_IMAGE}|" "${tmp}/pm/controller/deploy.yaml" | kubectl apply -f -
  kubectl rollout status -n pod-migration-system deployment/pod-migration-controller --timeout=5m
  rm -rf "${tmp}"

  for ns in ${SNAPSHOT_NAMESPACES}; do
    kubectl create namespace "${ns}" --dry-run=client -o yaml | kubectl apply -f -
    log "PodMigration config for ${ns} -> gs://${BUCKET}/snapshots"
    kubectl apply -f - <<EOF
apiVersion: podmigration.gke.io/v1alpha1
kind: PodMigration
metadata:
  name: arcade
  namespace: ${ns}
  labels:
    app.kubernetes.io/part-of: autoscale-arcade
    arcade.gke.io/cabinet: teleporter
spec:
  storage:
    location: gs://${BUCKET}/snapshots
EOF
  done
}

# Spot On runs on two fixed, autoscaled node pools instead of a ComputeClass:
# GKE Warden forbids combining a compute-class selector with the required
# cloud.google.com/gke-spot node affinity that the workload-class webhook
# emits for the on-demand share (docs/cabinets/spot-on.md). Both pools carry
# the same label/taint so only checkout pods land on them; one zone keeps the
# islands deterministic.
create_spot_pools() {
  local common=(--cluster "${CLUSTER}" --location "${REGION}" --project "${PROJECT_ID}"
    --node-locations "${SPOT_POOL_ZONE}" --num-nodes 0
    --enable-autoscaling --min-nodes 0 --max-nodes "${SPOT_POOL_MAX}" --location-policy ANY
    --image-type cos_containerd --workload-metadata GKE_METADATA
    --node-labels "arcade.demo/cabinet=spot" --node-taints "arcade.demo/spot-cabinet=true:NoSchedule"
    --quiet)
  if gcloud container node-pools describe spot-od --cluster "${CLUSTER}" --location "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    log "Node pool spot-od already exists"
  else
    log "Creating node pool spot-od (${SPOT_OD_MACHINE_TYPE}, on-demand, 0-${SPOT_POOL_MAX} in ${SPOT_POOL_ZONE})"
    gcloud container node-pools create spot-od --machine-type "${SPOT_OD_MACHINE_TYPE}" "${common[@]}"
  fi
  if gcloud container node-pools describe spot-spot --cluster "${CLUSTER}" --location "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    log "Node pool spot-spot already exists"
  else
    log "Creating node pool spot-spot (${SPOT_SPOT_MACHINE_TYPE}, Spot, 0-${SPOT_POOL_MAX} in ${SPOT_POOL_ZONE})"
    gcloud container node-pools create spot-spot --machine-type "${SPOT_SPOT_MACHINE_TYPE}" --spot "${common[@]}"
  fi
  gcloud container node-pools list --cluster "${CLUSTER}" --location "${REGION}" --project "${PROJECT_ID}" \
    --filter='name~^spot-' --format='table(name,config.machineType,config.spot,autoscaling.minNodeCount,autoscaling.maxNodeCount,locations,status)'
}

verify_addons() {
  log "Addon health"
  kubectl get deploy -n cert-manager
  kubectl get deploy -n workload-class-system
  kubectl get deploy -n pod-migration-system
  for ns in ${SNAPSHOT_NAMESPACES}; do
    kubectl get podmigration -n "${ns}" arcade -o wide
    kubectl get podsnapshotpolicy -n "${ns}"
  done
  kubectl get podsnapshotstorageconfig
  kubectl get validatingwebhookconfiguration,mutatingwebhookconfiguration | grep -E 'podmigration|workload-class|cert-manager|^.*webhook-configuration ' || true
}

# Static global IP + DNS A record for the Gateway (manifests/90-gateway).
# The certificate map (CERT_MAP) and the DNS zone must already exist in the
# project; see docs/adr/0005 for the project caveat.
create_network() {
  if ! gcloud compute addresses describe "${GATEWAY_IP_NAME}" --global --project "${PROJECT_ID}" >/dev/null 2>&1; then
    log "Reserving global static IP ${GATEWAY_IP_NAME}"
    gcloud compute addresses create "${GATEWAY_IP_NAME}" --global --ip-version IPV4 --project "${PROJECT_ID}" \
      --description "Autoscale Arcade Gateway (${HOSTNAME_FQDN})"
  fi
  local ip
  ip="$(gcloud compute addresses describe "${GATEWAY_IP_NAME}" --global --project "${PROJECT_ID}" --format='value(address)')"
  log "Gateway IP ${ip}"
  if ! gcloud certificate-manager maps describe "${CERT_MAP}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    echo "certificate map ${CERT_MAP} not found in ${PROJECT_ID}; create one for *.demo.gke.ninja first (docs/adr/0005)" >&2
    return 1
  fi
  local current
  current="$(gcloud dns record-sets list --zone "${DNS_ZONE}" --project "${PROJECT_ID}" --name "${HOSTNAME_FQDN}." --type A --format='value(rrdatas[0])' 2>/dev/null || true)"
  if [[ "${current}" == "${ip}" ]]; then
    log "DNS ${HOSTNAME_FQDN} already -> ${ip}"
  elif [[ -z "${current}" ]]; then
    log "Creating DNS A ${HOSTNAME_FQDN} -> ${ip}"
    gcloud dns record-sets create "${HOSTNAME_FQDN}." --zone "${DNS_ZONE}" --project "${PROJECT_ID}" --type A --ttl 60 --rrdatas "${ip}"
  else
    log "Updating DNS A ${HOSTNAME_FQDN} ${current} -> ${ip}"
    gcloud dns record-sets update "${HOSTNAME_FQDN}." --zone "${DNS_ZONE}" --project "${PROJECT_ID}" --type A --ttl 60 --rrdatas "${ip}"
  fi
}

case "${phase}" in
  cluster)     ensure_apis; create_cluster ;;
  gvisor)      create_gvisor_pool ;;
  storage)     create_storage ;;
  credentials) get_credentials ;;
  addons)      get_credentials; install_addons; verify_addons ;;
  verify)      verify_addons ;;
  network)     create_network ;;
  spotpools)   create_spot_pools ;;
  all)         ensure_apis; create_cluster; create_gvisor_pool; create_spot_pools; create_storage; get_credentials; install_addons; verify_addons; create_network ;;
  *) echo "unknown phase ${phase}"; exit 1 ;;
esac
log "Done (${phase})"
