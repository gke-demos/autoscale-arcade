# Autoscale Arcade — developer entry points. See AGENTS.md.
#
#   make cluster | teardown        bootstrap / delete the GKE cluster (hack/cluster.sh)
#   make build | test | web-dev    local development
#   make image                     build + push the image with Cloud Build
#   make deploy | reset            apply manifests/ ; return every cabinet to its start state
#   make play-<cabinet> | play-all run scenarios from the terminal
#   make verify-<cabinet>          end-to-end checks
#
SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

PROJECT_ID ?= $(shell gcloud config get-value project 2>/dev/null)
REGION     ?= us-central1
CLUSTER    ?= autoscale-arcade
REPO       ?= $(REGION)-docker.pkg.dev/$(PROJECT_ID)/autoscale-arcade
TAG        ?= latest
IMAGE      ?= $(REPO)/arcade
REV        := $(shell git rev-parse --short HEAD 2>/dev/null || echo local)
VERSION    ?= $(TAG)-$(REV)

# How the terminal reaches the arcade-server. Default: a port-forward opened
# per invocation. Set ARCADE_URL (and ARCADE_DEV_TOKEN) to talk to a running
# server directly, e.g. ARCADE_URL=http://localhost:8080 make play-nitro.
ARCADE_URL       ?=
ARCADE_DEV_TOKEN ?= $(shell kubectl -n arcade-system get secret arcade-server -o jsonpath='{.data.ARCADE_DEV_TOKEN}' 2>/dev/null | base64 -d)
PF_PORT          ?= 18080
# arcade-server Service port
SVC_PORT         ?= 8080

CABINETS := climber spot teleporter absorber lights nitro
BIN      := bin/arcade
GOFLAGS  ?= -trimpath
LDFLAGS  ?= -s -w -X main.version=$(VERSION)

.PHONY: help cluster teardown credentials build build-go test lint web web-dev image deploy undeploy reset stop \
        play-all status logs
# play-<cabinet> / verify-<cabinet> are pattern rules (not listed in .PHONY on purpose).

help: ## list targets
	@grep -E '^[a-zA-Z_%-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*## "}{printf "  \033[36m%-18s\033[0m %s\n",$$1,$$2}'

# ---- cluster ---------------------------------------------------------------
cluster: ## bootstrap the GKE cluster (idempotent)
	PROJECT_ID=$(PROJECT_ID) REGION=$(REGION) CLUSTER=$(CLUSTER) ./hack/cluster.sh all

credentials: ## fetch kubeconfig for the cluster
	PROJECT_ID=$(PROJECT_ID) REGION=$(REGION) CLUSTER=$(CLUSTER) ./hack/cluster.sh credentials

teardown: ## delete the GKE cluster and its snapshot bucket
	PROJECT_ID=$(PROJECT_ID) REGION=$(REGION) CLUSTER=$(CLUSTER) ./hack/cluster.sh teardown

# ---- build -----------------------------------------------------------------
web: ## build the UI into web/dist and stage it for go:embed
	cd web && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npm run build
	@mkdir -p internal/server/dist
	rm -rf internal/server/dist/* && cp -r web/dist/. internal/server/dist/

build: ## Go binary with the embedded UI (runs `make web` first when web/ exists)
	@if [ -f web/package.json ]; then $(MAKE) --no-print-directory web; fi
	CGO_ENABLED=0 go build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $(BIN) ./cmd/arcade
	@echo "built $(BIN) ($(VERSION))"

build-go: ## Go binary only (whatever is in internal/server/dist is embedded)
	CGO_ENABLED=0 go build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $(BIN) ./cmd/arcade

test: ## go vet + go test
	go vet ./...
	go test -race -count=1 ./...

lint: ## gofmt check
	@test -z "$$(gofmt -l cmd internal)" || { gofmt -l cmd internal; echo 'run gofmt -w'; exit 1; }

web-dev: ## Vite dev server proxied to a port-forwarded arcade-server (:$(PF_PORT))
	@$(call with_portforward, cd web && VITE_API_BASE=http://localhost:$(PF_PORT) VITE_DEV_TOKEN="$(ARCADE_DEV_TOKEN)" npm run dev)

image: ## build + push $(IMAGE):$(TAG) with Cloud Build (no local docker)
	gcloud builds submit --project $(PROJECT_ID) --config cloudbuild.yaml \
	  --substitutions=_IMAGE=$(IMAGE),_TAG=$(TAG),_REV=$(REV) .
	@gcloud artifacts docker images describe $(IMAGE):$(TAG) --project $(PROJECT_ID) --format='value(image_summary.digest)' 2>/dev/null | sed 's|^|$(IMAGE)@|' || true

# ---- deploy ----------------------------------------------------------------
deploy: ## apply manifests/ with kustomize (image pinned in manifests/; TAG=<tag> to override)
	@if [ "$(TAG)" = "latest" ]; then kubectl apply -k manifests/ --server-side --force-conflicts; else \
	  kubectl kustomize manifests/ | sed -E 's|(image: .*/autoscale-arcade/arcade):[^[:space:]"]+|\1:$(TAG)|' | kubectl apply --server-side --force-conflicts -f -; fi
	kubectl -n arcade-system rollout status deploy/arcade-server --timeout=180s

undeploy: ## delete everything in manifests/
	kubectl kustomize manifests/ | kubectl delete --ignore-not-found -f -

status: ## quick look at every cabinet's pods
	kubectl get pods -A -l app.kubernetes.io/part-of=autoscale-arcade -o wide

logs: ## tail the arcade-server
	kubectl -n arcade-system logs deploy/arcade-server -f --tail=200

# ---- play ------------------------------------------------------------------
# api <method> <path> [json-body]
define api
curl -fsS -X $(1) -H 'Content-Type: application/json' $(if $(ARCADE_DEV_TOKEN),-H 'Authorization: Bearer $(ARCADE_DEV_TOKEN)') \
  $(if $(3),-d '$(3)') "$$ARCADE_URL$(2)"
endef

# with_portforward <command>: run the command with $$ARCADE_URL set, opening a
# port-forward to the arcade-server unless ARCADE_URL is already given.
define with_portforward
if [ -n "$(ARCADE_URL)" ]; then export ARCADE_URL="$(ARCADE_URL)"; $(1); else \
  kubectl -n arcade-system port-forward svc/arcade-server $(PF_PORT):$(SVC_PORT) >/dev/null 2>&1 & pf=$$!; \
  trap 'kill $$pf 2>/dev/null || true' EXIT; \
  for i in $$(seq 1 30); do curl -fs "http://localhost:$(PF_PORT)/healthz" >/dev/null 2>&1 && break; sleep 0.5; done; \
  export ARCADE_URL="http://localhost:$(PF_PORT)"; $(1); fi
endef

play-all: ## run every cabinet's scenario in order
	@$(call with_portforward, $(call api,POST,/api/actions/scenario.run,{"name":"all"}) && echo)

play-%: ## run scenarios/<cabinet>.yaml (SCENARIO=<name> to override)
	@$(call with_portforward, $(call api,POST,/api/actions/scenario.run,{"name":"$(or $(SCENARIO),$*)"}) && echo)

stop: ## cancel the running scenario
	@$(call with_portforward, $(call api,POST,/api/actions/scenario.stop,{}) && echo)

reset: ## return every cabinet to its start state (CABINET=<id> for one)
	@$(call with_portforward, $(call api,POST,/api/actions/reset,{$(if $(CABINET),"cabinet":"$(CABINET)")}) && echo)

# ---- verify ----------------------------------------------------------------
# hack/verify-<cabinet>.sh when present, otherwise a generic check that the
# server streams state for the cabinet and its namespace is healthy.
verify-%: ## end-to-end checks for one cabinet
	@if [ -x hack/verify-$*.sh ]; then $(call with_portforward, hack/verify-$*.sh); else \
	  $(call with_portforward, $(call api,GET,/api/state) | jq -e '.cabinets.$*' >/dev/null && echo "✔ $*: state present"); \
	  kubectl get ns arcade-$* >/dev/null && echo "✔ $*: namespace arcade-$*"; \
	  kubectl -n arcade-$* get pods -o wide; fi
