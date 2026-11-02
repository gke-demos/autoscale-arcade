#!/usr/bin/env bash
# Bootstraps the Autoscale Arcade GKE cluster.
#
#   PROJECT_ID=… REGION=us-central1 CLUSTER=autoscale-arcade ./hack/cluster.sh [all|cluster|gvisor|storage|addons|credentials]
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
POD_MIGRATION_IMAGE="${POD_MIGRATION_IMAGE:-ghcr.io/gke-labs/pod-migration-controller:latest}"
SNAPSHOT_NAMESPACES="${SNAPSHOT_NAMESPACES:-arcade-teleporter}"

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

  log "Installing pod-migration controller"
  local tmp; tmp="$(mktemp -d)"
  git clone --depth 1 -q https://github.com/gke-labs/pod-migration "${tmp}/pm"
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
spec:
  storage:
    location: gs://${BUCKET}/snapshots
EOF
  done
}

case "${phase}" in
  cluster)     ensure_apis; create_cluster ;;
  gvisor)      create_gvisor_pool ;;
  storage)     create_storage ;;
  credentials) get_credentials ;;
  addons)      get_credentials; install_addons ;;
  all)         ensure_apis; create_cluster; create_gvisor_pool; create_storage; get_credentials; install_addons ;;
  *) echo "unknown phase ${phase}"; exit 1 ;;
esac
log "Done (${phase})"
