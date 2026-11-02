#!/usr/bin/env bash
# IAP + Workload Identity wiring for the Autoscale Arcade.
#
#   PROJECT_ID=… ./hack/iap.sh grant  alice@google.com [bob@google.com …]   # presenters: IAP-secured Web App User
#   PROJECT_ID=… ./hack/iap.sh revoke alice@google.com
#   PROJECT_ID=… ./hack/iap.sh audience                                      # print/write IAP_AUDIENCE into Secret arcade-server
#   PROJECT_ID=… ./hack/iap.sh wi                                            # Workload Identity: arcade-server KSA -> compute.instanceAdmin.v1 (condition-scoped)
#   PROJECT_ID=… ./hack/iap.sh status
#
# The Gateway controller creates the backend service for Service/arcade-server
# with a generated name (k8s1-…-arcade-system-arcade-server-8080-…). IAP's JWT
# audience is /projects/<NUMBER>/global/backendServices/<BACKEND_SERVICE_NUMERIC_ID>.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
CLUSTER="${CLUSTER:-autoscale-arcade}"
NAMESPACE="${NAMESPACE:-arcade-system}"
SERVICE="${SERVICE:-arcade-server}"
PORT="${PORT:-8080}"
KSA="${KSA:-arcade-server}"
DEV_TOKEN="${ARCADE_DEV_TOKEN:-}"

cmd="${1:-status}"; shift || true
log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

project_number() { gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)'; }

backend_service() {
  # The Gateway controller names it gkegw1-<hash>-<namespace>-<service>-<port>-<hash>.
  gcloud compute backend-services list --global --project "${PROJECT_ID}" \
    --filter="name~^gkegw1-.*-${NAMESPACE}-${SERVICE}-${PORT}-" --format='value(name)' 2>/dev/null | head -1 || true
}

wait_backend_service() {
  local bs=""
  for _ in $(seq 1 60); do
    bs="$(backend_service)"
    [[ -n "${bs}" ]] && break
    sleep 10
  done
  [[ -n "${bs}" ]] || { echo "no backend service for ${NAMESPACE}/${SERVICE}:${PORT} yet (is the Gateway programmed?)" >&2; exit 1; }
  echo "${bs}"
}

cmd_grant() {
  [[ $# -gt 0 ]] || { echo "usage: iap.sh grant user@domain [...]" >&2; exit 1; }
  local bs; bs="$(wait_backend_service)"
  for user in "$@"; do
    local member="user:${user}"
    [[ "${user}" == *:* ]] && member="${user}"   # allow group:/serviceAccount:/domain: as-is
    log "Granting IAP-secured Web App User on ${bs} to ${member}"
    gcloud iap web add-iam-policy-binding --project "${PROJECT_ID}" \
      --resource-type backend-services --service "${bs}" \
      --member "${member}" --role roles/iap.httpsResourceAccessor >/dev/null
  done
  cmd_status
}

cmd_revoke() {
  local bs; bs="$(wait_backend_service)"
  for user in "$@"; do
    local member="user:${user}"; [[ "${user}" == *:* ]] && member="${user}"
    gcloud iap web remove-iam-policy-binding --project "${PROJECT_ID}" \
      --resource-type backend-services --service "${bs}" \
      --member "${member}" --role roles/iap.httpsResourceAccessor >/dev/null
  done
  cmd_status
}

cmd_audience() {
  local bs num id aud
  bs="$(wait_backend_service)"
  num="$(project_number)"
  id="$(gcloud compute backend-services describe "${bs}" --global --project "${PROJECT_ID}" --format='value(id)')"
  aud="/projects/${num}/global/backendServices/${id}"
  log "IAP_AUDIENCE=${aud}"
  local dev="${DEV_TOKEN}"
  if [[ -z "${dev}" ]]; then
    dev="$(kubectl get secret arcade-server -n "${NAMESPACE}" -o jsonpath='{.data.ARCADE_DEV_TOKEN}' 2>/dev/null | base64 -d || true)"
    [[ -n "${dev}" ]] || dev="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' )"
  fi
  kubectl create secret generic arcade-server -n "${NAMESPACE}" \
    --from-literal=IAP_AUDIENCE="${aud}" --from-literal=ARCADE_DEV_TOKEN="${dev}" \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl rollout restart deployment/"${SERVICE}" -n "${NAMESPACE}" >/dev/null
  echo "Secret ${NAMESPACE}/arcade-server updated (IAP_AUDIENCE, ARCADE_DEV_TOKEN); ${SERVICE} restarted."
}

cmd_wi() {
  local num principal
  num="$(project_number)"
  principal="principal://iam.googleapis.com/projects/${num}/locations/global/workloadIdentityPools/${PROJECT_ID}.svc.id.goog/subject/ns/${NAMESPACE}/sa/${KSA}"
  log "Workload Identity: ${NAMESPACE}/${KSA} -> roles/compute.instanceAdmin.v1 on instances of cluster ${CLUSTER} (spot.preempt = simulateMaintenanceEvent)"
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member "${principal}" \
    --role roles/compute.instanceAdmin.v1 \
    --condition="title=autoscale-arcade-nodes,description=Only VMs of GKE cluster ${CLUSTER},expression=resource.type == 'compute.googleapis.com/Instance' && resource.name.extract('/instances/{name}').startsWith('gke-${CLUSTER}-')" >/dev/null
  log "Workload Identity: ${NAMESPACE}/${KSA} -> roles/container.clusterViewer, roles/compute.viewer (read-only)"
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member "${principal}" --role roles/container.clusterViewer --condition=None >/dev/null
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member "${principal}" --role roles/compute.viewer --condition=None >/dev/null
  echo "done: ${principal}"
}

cmd_status() {
  local bs; bs="$(backend_service)"
  log "Gateway"
  kubectl get gateway -n "${NAMESPACE}" -o wide 2>/dev/null || true
  [[ -n "${bs}" ]] || { echo "backend service not created yet"; return; }
  log "Backend service ${bs}"
  gcloud compute backend-services describe "${bs}" --global --project "${PROJECT_ID}" --format='yaml(iap,timeoutSec,healthChecks)'
  log "IAP policy"
  gcloud iap web get-iam-policy --project "${PROJECT_ID}" --resource-type backend-services --service "${bs}" --format=yaml
}

case "${cmd}" in
  grant)    cmd_grant "$@" ;;
  revoke)   cmd_revoke "$@" ;;
  audience) cmd_audience ;;
  wi)       cmd_wi ;;
  status)   cmd_status ;;
  *) echo "unknown command ${cmd}"; exit 1 ;;
esac
