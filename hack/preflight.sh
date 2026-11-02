#!/usr/bin/env bash
# Preflight for the Autoscale Arcade: APIs, quotas, versions, project assets.
# Read-only; exits non-zero when something would block `hack/cluster.sh all`.
#
#   PROJECT_ID=… REGION=us-central1 ./hack/preflight.sh
set -uo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
CLUSTER="${CLUSTER:-autoscale-arcade}"
CLUSTER_VERSION="${CLUSTER_VERSION:-1.37.1-gke.1697000}"
CERT_MAP="${CERT_MAP:-star-demo-gke-ninja}"
DNS_ZONE="${DNS_ZONE:-demo-gke-ninja}"
IMAGE_REPO="${IMAGE_REPO:-us-central1-docker.pkg.dev/${PROJECT_ID}/autoscale-arcade}"
# Rough peak: 3 system + 3 gVisor n4-standard-4 (24 vCPU) + climber 24 pods on n4d/n4-standard-2 (~16)
# + spot 10 pods (~6) + absorber 8 buffer + 12 burst (~12) + nitro/lights (~4)  => ~64 vCPU, mostly Spot.
NEED_CPUS="${NEED_CPUS:-64}"
NEED_PREEMPTIBLE_CPUS="${NEED_PREEMPTIBLE_CPUS:-40}"
NEED_N4_CPUS="${NEED_N4_CPUS:-48}"
NEED_N4D_CPUS="${NEED_N4D_CPUS:-24}"

fail=0
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✘\033[0m %s\n' "$*"; fail=1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
hdr()  { printf '\n\033[1;36m%s\033[0m\n' "$*"; }

hdr "Tools"
for t in gcloud kubectl git; do command -v "$t" >/dev/null && ok "$t $(command -v "$t")" || bad "$t missing"; done
kubectl version --client -o json 2>/dev/null | grep -q '"gitVersion"' && ok "kubectl $(kubectl version --client -o json | sed -n 's/.*"gitVersion": "\([^"]*\)".*/\1/p' | head -1)"
if kubectl kustomize --help >/dev/null 2>&1; then ok "kubectl kustomize available"; else bad "kubectl kustomize missing"; fi
gcloud components list --format='value(id,state.name)' 2>/dev/null | grep -q '^gke-gcloud-auth-plugin.*Installed' \
  && ok "gke-gcloud-auth-plugin installed" || warn "gke-gcloud-auth-plugin not installed via gcloud components (fine if from a package)"

hdr "Project ${PROJECT_ID}"
gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)' >/dev/null 2>&1 && ok "project reachable" || bad "cannot describe project"
hdr "APIs"
enabled="$(gcloud services list --enabled --project "${PROJECT_ID}" --format='value(config.name)' 2>/dev/null)"
for api in container.googleapis.com compute.googleapis.com storage.googleapis.com certificatemanager.googleapis.com \
           iap.googleapis.com dns.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
           monitoring.googleapis.com logging.googleapis.com iamcredentials.googleapis.com; do
  grep -qx "${api}" <<<"${enabled}" && ok "${api}" || bad "${api} not enabled (gcloud services enable ${api})"
done

hdr "GKE version ${CLUSTER_VERSION} on the Rapid channel in ${REGION}"
versions="$(gcloud container get-server-config --location "${REGION}" --project "${PROJECT_ID}" --format='value(channels.validVersions)' 2>/dev/null)"
if grep -q "${CLUSTER_VERSION}" <<<"${versions}"; then ok "version available"; else bad "version ${CLUSTER_VERSION} not offered in ${REGION}"; fi

hdr "Regional quotas in ${REGION} (need ≈ CPUS ${NEED_CPUS}, PREEMPTIBLE_CPUS ${NEED_PREEMPTIBLE_CPUS}, N4 ${NEED_N4_CPUS}, N4D ${NEED_N4D_CPUS})"
check_quota() { # metric need
  local line limit usage free
  line="$(gcloud compute regions describe "${REGION}" --project "${PROJECT_ID}" --format=json 2>/dev/null \
          | python3 -c "import json,sys; q=[x for x in json.load(sys.stdin)['quotas'] if x['metric']=='$1']; print(f\"{q[0]['limit']:.0f} {q[0]['usage']:.0f}\" if q else '')")"
  if [[ -z "${line}" ]]; then ok "$1: no family-specific quota (counts against CPUS)"; return; fi
  limit="${line% *}"; usage="${line#* }"; free=$((limit - usage))
  if (( free >= $2 )); then ok "$1 limit=${limit} used=${usage} free=${free}"; else bad "$1 limit=${limit} used=${usage} free=${free} (< $2)"; fi
}
check_quota CPUS "${NEED_CPUS}"
check_quota PREEMPTIBLE_CPUS "${NEED_PREEMPTIBLE_CPUS}"
# N4/N4D have no family quota in the Compute "regions" API (they count against CPUS); checked for completeness.
check_quota N4_CPUS "${NEED_N4_CPUS}"
check_quota N4D_CPUS "${NEED_N4D_CPUS}"
check_quota IN_USE_ADDRESSES 4
check_quota SSD_TOTAL_GB 1000
gcloud compute project-info describe --project "${PROJECT_ID}" --format=json 2>/dev/null \
  | python3 -c "import json,sys; q={x['metric']:x for x in json.load(sys.stdin)['quotas']}; a=q.get('STATIC_ADDRESSES_GLOBAL') or q.get('STATIC_ADDRESSES'); print('ok' if a and a['limit']-a['usage']>=1 else 'bad')" 2>/dev/null \
  | grep -q ok && ok "global static address quota" || warn "could not verify global static address quota"

hdr "Machine types in every zone of ${REGION}"
for zone in $(gcloud compute zones list --project "${PROJECT_ID}" --filter="region:${REGION}" --format='value(name)'); do
  have="$(gcloud compute machine-types list --project "${PROJECT_ID}" --zones "${zone}" --filter='name=(n4-standard-2,n4-standard-4,n4d-standard-2)' --format='value(name)' | sort | tr '\n' ' ')"
  [[ "${have}" == *n4-standard-2* && "${have}" == *n4-standard-4* && "${have}" == *n4d-standard-2* ]] && ok "${zone}: ${have}" || warn "${zone}: only ${have:-nothing} (NPAC will skip this zone)"
done

hdr "Networking"
gcloud compute routers list --project "${PROJECT_ID}" --filter="region:${REGION}" --format='value(name,nats[].name)' 2>/dev/null | grep -q . \
  && ok "Cloud NAT present in ${REGION} (private nodes pull from ghcr.io / Docker Hub)" || bad "no Cloud NAT in ${REGION}: private nodes cannot pull cert-manager / valkey images"
gcloud certificate-manager maps describe "${CERT_MAP}" --project "${PROJECT_ID}" >/dev/null 2>&1 \
  && ok "certificate map ${CERT_MAP}" || bad "certificate map ${CERT_MAP} missing (docs/adr/0005)"
gcloud dns managed-zones describe "${DNS_ZONE}" --project "${PROJECT_ID}" >/dev/null 2>&1 \
  && ok "DNS zone ${DNS_ZONE}" || bad "DNS zone ${DNS_ZONE} missing"
brand="$(gcloud iap oauth-brands list --project "${PROJECT_ID}" --format='value(name)' 2>/dev/null | head -1)"
[[ -n "${brand}" ]] && ok "IAP OAuth brand ${brand}" || bad "no IAP OAuth brand: gcloud iap oauth-brands create --application_title='GKE Ninja' --support_email=…"

hdr "Images"
gcloud artifacts repositories describe autoscale-arcade --location "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1 \
  && ok "Artifact Registry repo ${IMAGE_REPO%/*}" || bad "Artifact Registry repo autoscale-arcade missing in ${REGION}"
for img in arcade pod-migration-controller; do
  gcloud artifacts docker images describe "${IMAGE_REPO}/${img}:latest" --project "${PROJECT_ID}" >/dev/null 2>&1 \
    && ok "${IMAGE_REPO}/${img}:latest" || warn "${IMAGE_REPO}/${img}:latest not built yet (make image / Cloud Build)"
done

hdr "Existing cluster"
if gcloud container clusters describe "${CLUSTER}" --location "${REGION}" --project "${PROJECT_ID}" --format='value(currentMasterVersion,status)' 2>/dev/null | grep -q .; then
  ok "cluster ${CLUSTER}: $(gcloud container clusters describe "${CLUSTER}" --location "${REGION}" --project "${PROJECT_ID}" --format='value(currentMasterVersion,status)')"
  kubectl get nodes >/dev/null 2>&1 && ok "kubectl reaches the cluster" || warn "kubectl cannot reach the cluster: ./hack/cluster.sh credentials"
else
  warn "cluster ${CLUSTER} does not exist yet (./hack/cluster.sh all)"
fi

echo
if (( fail )); then echo "PREFLIGHT FAILED"; exit 1; else echo "PREFLIGHT OK"; fi
