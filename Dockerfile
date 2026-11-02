# syntax=docker/dockerfile:1.7
# Single image for the Autoscale Arcade: `arcade server|pet|worker`.
# Stage 1 builds the R3F UI, stage 2 the static Go binary with the UI embedded,
# stage 3 is distroless. Build with BuildKit (Cloud Build: see cloudbuild.yaml).

# ---- UI -------------------------------------------------------------------
FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json* ./
# A lockfile generated behind a corporate npm proxy carries private `resolved`
# URLs. Drop those so npm ci fetches from the public registry (integrity hashes
# are kept and still verified).
RUN <<'SH'
set -e
if [ -f package-lock.json ]; then node <<'JS'
const fs = require("fs");
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
let n = 0;
for (const p of Object.values(lock.packages || {})) {
  if (p.resolved && !p.resolved.startsWith("https://registry.npmjs.org/")) { delete p.resolved; n++; }
}
fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 2));
console.log("normalised", n, "resolved urls");
JS
fi
SH
RUN --mount=type=cache,target=/root/.npm \
    npm config set registry https://registry.npmjs.org/ && \
    if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY web/ ./
RUN npm run build && test -f dist/index.html

# ---- Go --------------------------------------------------------------------
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
# Files copied from the build context keep the host's modes (often 0640 under
# umask 027); the runtime image is nonroot (65532), so make the scenario files
# world-readable before they are copied into the final stage.
RUN mkdir -p scenarios && chmod -R a+rX scenarios
# The server embeds internal/server/dist (see internal/server/ui.go); replace
# the placeholder with the real UI build.
COPY --from=web /src/web/dist/ ./internal/server/dist/
ARG VERSION=dev
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -trimpath \
      -ldflags="-s -w -X main.version=${VERSION}" \
      -o /out/arcade ./cmd/arcade

# ---- Runtime ---------------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot
LABEL org.opencontainers.image.source="https://github.com/gke-demos/autoscale-arcade" \
      org.opencontainers.image.title="autoscale-arcade" \
      org.opencontainers.image.description="Autoscale Arcade: arcade-server, pet and workers in one binary"
COPY --from=build /out/arcade /arcade
# Scenario YAML is read from disk at runtime (ARCADE_SCENARIOS).
COPY --from=build /src/scenarios/ /scenarios/
ENV ARCADE_SCENARIOS=/scenarios
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/arcade"]
CMD ["server"]
