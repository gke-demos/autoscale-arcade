# Contracts

Shared interfaces between `arcade-server` (Go), `web/` (R3F UI), `manifests/` and `scenarios/`. Change this file first, then the code.

## Namespaces, labels, names

| Cabinet id | Namespace | Workloads |
| :--- | :--- | :--- |
| `climber` (Capacity Climber) | `arcade-climber` | `Deployment/climber`, `ComputeClass/arcade-climber` (cluster-scoped) |
| `spot` (Spot On) | `arcade-spot` | `Deployment/checkout`, `WorkloadClass/checkout`, `GKESpotPlacementPolicy/arcade-spot`, `ComputeClass/arcade-spot`, `WorkloadClassGuardrail/arcade` |
| `teleporter` (Pod Teleporter) | `arcade-teleporter` | `StatefulSet/pet` (pod `pet-0`), `PodMigration/arcade` |
| `absorber` (Shock Absorber) | `arcade-absorber` | `Deployment/burst-worker`, `PodTemplate/burst-unit`, `CapacityBuffer/absorber-active`, `CapacityBuffer/absorber-standby`, `ComputeClass/arcade-absorber` |
| `lights` (Lights Out) | `arcade-lights` | `Deployment/coin-worker`, `HorizontalPodAutoscaler/coin-worker`, `AutoscalingMetric/coin-queue` |
| `nitro` (Nitro) | `arcade-nitro` | `Deployment/stock`, `Deployment/nitro`, `VerticalPodAutoscaler/nitro` |
| — | `arcade-system` | `Deployment/arcade-server`, `Service/arcade-server`, Gateway, HTTPRoute, policies, RBAC |

Every arcade object carries `app.kubernetes.io/part-of: autoscale-arcade` and `arcade.gke.io/cabinet: <cabinet id>`.
Pods get `arcade.gke.io/workload: <name>` so the UI can colour by workload without parsing owner refs.

Image: one image, `IMAGE` (default `us-central1-docker.pkg.dev/$PROJECT_ID/autoscale-arcade/arcade:latest`; CI also publishes `ghcr.io/gke-demos/autoscale-arcade`). Entrypoint `arcade` with subcommands `server`, `pet`, `worker`.

Workers (`arcade worker --mode=<mode>`): `coin` (polls `ARCADE_SERVER_URL/api/queue/claim`, "processes" a coin for `COIN_WORK_SECONDS`, default 8), `burst` (busy warm-up `WARMUP_CPU_SECONDS`, default 10, then ready on `:8080/ready`), `race` (same as burst but `WARMUP_CPU_SECONDS` ≈ 20 of single-core CPU work so a 4× boost is visible).

## WebSocket stream — `GET /ws`

Server pushes JSON messages. The first message is a full `snapshot`; after that a new `snapshot` is sent whenever anything changes (coalesced to ≤ 4/s). Pet telemetry is a separate high-frequency message.

```ts
type Message =
  | { type: "snapshot"; state: WorldState }
  | { type: "pet"; pet: PetState }                 // ≤ 10/s while the pet is connected
  | { type: "scenario"; scenario: ScenarioState }  // caption/step changes
  | { type: "toast"; level: "info"|"warn"|"error"; text: string };

interface WorldState {
  ts: string;                       // RFC3339
  cluster: {
    name: string; version: string; project: string; region: string;
    autoscaler: {                   // from kube-system/cluster-autoscaler-status
      status: string;               // Running | Initializing
      scaleUp: string;              // NoActivity | InProgress | Backoff
      scaleDown: string;            // NoCandidates | CandidatesPresent | InProgress
      scaleDownCandidates: number;
      nodeGroups: NodeGroup[];
      updated: string;
    };
  };
  nodes: Node[];
  pods: Pod[];
  cabinets: {
    climber: ClimberState; spot: SpotState; teleporter: TeleporterState;
    absorber: AbsorberState; lights: LightsState; nitro: NitroState;
  };
  scenario: ScenarioState;
  events: Event[];                  // last 50 relevant k8s events, newest first
}

interface NodeGroup { name: string; pool: string; zone: string; ready: number; total: number; target: number; min: number; max: number; scaleUp: string; backoff?: string }

interface Node {
  name: string; pool: string; zone: string; machineType: string; machineFamily: string;
  spot: boolean; computeClass?: string; gvisor: boolean; buffer?: "active"|"standby";
  ready: boolean; unschedulable: boolean; suspended: boolean;   // suspended = Node condition Suspended=True
  creating: boolean;                 // present in CA target but not yet Ready (synthesised placeholder nodes have name "pending-<pool>-<n>")
  deleting: boolean;                 // ToBeDeletedByClusterAutoscaler taint or deletion in progress
  created: string;
  cpu: { allocatable: number; requested: number };   // cores
  memory: { allocatable: number; requested: number }; // GiB
}

interface Pod {
  uid: string; name: string; namespace: string; cabinet: string; workload: string;
  node?: string; phase: "Pending"|"Running"|"Succeeded"|"Failed"|"Unknown";
  ready: boolean; deleting: boolean; pendingReason?: string;   // e.g. Unschedulable, TriggeredScaleUp, SchedulingGated
  created: string; scheduledAt?: string; readyAt?: string;
  spot?: boolean;                    // derived from node
  placement?: "spot"|"on-demand";   // Spot On: intent injected by workload-class webhook (from nodeSelector/affinity)
  fallback?: boolean;                // Spot On: spot-targeted pod running on on-demand
  boost?: { active: boolean; cpuRequest: string; cpuOriginal: string };  // Nitro
  cpu: { request: string; actual?: string };                              // actual from status.containerStatuses[].resources
  migration?: { job: string; phase: string };                             // Teleporter
  buffer?: boolean;                  // true for synthesised buffer placeholder "ghost" pods (name "ghost-<buffer>-<n>")
}

interface Event { ts: string; type: "Normal"|"Warning"; reason: string; object: string; message: string; cabinet?: string }

interface ClimberState {
  replicas: number; desired: number; ready: number;
  computeClass: { name: string; locked: boolean; priorities: { machineFamily: string; spot: boolean; locked: boolean }[] };
  rungs: { index: number; label: string; nodes: string[]; pods: number }[];   // which pods sit on which rung
}
interface SpotState {
  replicas: number; spotRatio: number; action: "Fail"|"FallbackToOnDemand"; validated: boolean; inFallback: boolean;
  counts: { spot: number; onDemand: number; fallback: number; pending: number };
  stockout: boolean;                 // the arcade's own "stockout lever" is engaged
  costPerHour: { current: number; allOnDemand: number };   // list-price estimate, USD
  guardrail: { minSpotRatio: string; maxFallbackRatio: string };
  policy: { name: string; reversion: string };
}
interface TeleporterState {
  pet: { pod?: string; node?: string; connected: boolean; uid?: string };
  gvisorNodes: string[];
  jobs: MigrationJob[];              // newest first, last 10
  lastMigration?: { from: string; to: string; downtimeMs: number; restored: "verified"|"inferred"|"lost"|"failed"; at: string };
}
interface MigrationJob { name: string; phase: string; originNode?: string; snapshot?: string; startedAt: string; snapshottingAt?: string; evictingAt?: string; restoringAt?: string; completedAt?: string; restoredReason?: string; restoredPod?: string }
interface PetState { pod: string; node: string; ticks: number; score: number; lives: number; uptimeSec: number; ball: { x: number; y: number; vx: number; vy: number }; restoredAt?: string; bornAt: string }
interface AbsorberState {
  preset: "none"|"active4"|"active8"|"standby8";
  buffers: { name: string; strategy: "active"|"standby"; replicas: number; statusReplicas: number; ready: boolean; limitedByQuota: boolean }[];
  burst: { desired: number; ready: number; startedAt?: string; allReadyAt?: string; perPodReadyMs: number[] };
  headroomCostPerHour: number;
}
interface LightsState {
  queueDepth: number; processed: number;
  hpa: { current: number; desired: number; min: number; max: number; scaledToZero: boolean; scalingActive: boolean; metricValue?: number; lastScale?: string };
  metricName: string;                // autoscaling.gke.io|coin-queue|arcade_queue_depth
}
interface NitroState {
  race?: { startedAt: string; lanes: { name: "stock"|"nitro"; boosted: boolean; pod?: string; createdAt?: string; readyAt?: string; cpuRequest?: string; cpuOriginal?: string; unboostedAt?: string }[]; winner?: string };
  vpa: { factor: number; durationSeconds: number; updateMode: string };
}
interface ScenarioState { running: boolean; name?: string; cabinet?: string; step: number; steps: number; caption?: string; startedAt?: string; error?: string; attract: boolean }
```

## Actions — `POST /api/actions/<name>` (JSON body → `{ ok: true } | { ok: false, error }`)

| Action | Body | Effect |
| :--- | :--- | :--- |
| `climber.scale` | `{replicas}` | scale `Deployment/climber` |
| `climber.lock` | `{locked}` | patch `ComputeClass/arcade-climber` priority #1 to `reservations: {affinity: AnyThenFail}` (locked) or back to Spot (unlocked) |
| `spot.scale` | `{replicas}` | scale `Deployment/checkout` |
| `spot.ratio` | `{spotRatio}` 0–100 | patch `WorkloadClass/checkout` `capacityStrategy.spotRatio` |
| `spot.preempt` | `{node}` | `compute.instances.simulateMaintenanceEvent` on the Spot node's VM |
| `spot.stockout` | `{enabled}` | engage/disengage the stockout lever (implementation decided by the platform owner; see docs/cabinets/spot-on.md) |
| `teleporter.migrate` | `{toNode}` | patch `StatefulSet/pet` template `nodeSelector[kubernetes.io/hostname]=toNode`, then create `Eviction` for `pet-0` |
| `teleporter.random` | `{}` | same, to a random other gVisor node |
| `absorber.preset` | `{preset}` | set `CapacityBuffer` replicas (`none`: 0/0, `active4`: 4/0, `active8`: 8/0, `standby8`: 0/8) |
| `absorber.burst` | `{delta}` | scale `Deployment/burst-worker` by +delta (records `burst.startedAt`) |
| `absorber.reset` | `{}` | burst-worker → 0 |
| `lights.coin` | `{count}` | enqueue `count` coins (increments `arcade_queue_depth`) |
| `nitro.race` | `{}` | rollout-restart `stock` and `nitro`, record race start |
| `reset` | `{cabinet?: id}` | return one or all cabinets to their start state (see "Start state") |
| `scenario.run` | `{name}` | run `scenarios/<name>.yaml`; `{name: "all"}` runs every cabinet; `{name:"attract"}` loops |
| `scenario.stop` | `{}` | cancel the running scenario |

Other endpoints: `GET /api/state` (latest `WorldState`), `GET /api/scenarios` (names + captions), `GET|POST /api/leaderboard` (`{cabinet, initials, score, unit}`; stored in `ConfigMap/arcade-leaderboard`), `GET /api/queue/claim` (workers claim a coin; `204` when empty), `GET /metrics` (Prometheus text; includes `arcade_queue_depth` gauge), `GET /healthz`.

Mutating endpoints require either a valid IAP JWT (`x-goog-iap-jwt-assertion`, audience from `IAP_AUDIENCE`) or, when `ARCADE_DEV_TOKEN` is set, `Authorization: Bearer <token>`; rate limit 5 req/s per client.

### Start state (what `reset` restores)
`climber`: 0 replicas, unlocked · `spot`: 10 replicas, ratio 80, stockout off · `teleporter`: `pet-0` running, no nodeSelector pin · `absorber`: preset `none`, burst-worker 0 · `lights`: queue 0 (HPA will scale to 0) · `nitro`: both deployments at 1 replica, no race.

## Scenario files — `scenarios/<name>.yaml`

```yaml
name: pod-teleporter
cabinet: teleporter
title: "Pod Teleporter"
steps:
  - caption: "All of the pet's state lives in memory on {{ .pet.node }}."
    wait: 5s
  - caption: "Teleporting… snapshot → evict → restore on another node."
    action: { name: teleporter.random }
    waitFor: { path: "cabinets.teleporter.jobs[0].phase", in: ["Succeeded", "SucceededWithoutRestore", "Failed"], timeout: 180s }
  - caption: "Same ticks, new node: {{ .lastMigration.downtimeMs }} ms of downtime."
    wait: 6s
```
- `action` is any action above. `waitFor.path` is a dotted path into `WorldState` (cabinet-relative paths may omit `cabinets.<id>.`); matchers: `equals`, `in`, `gte`, `lte`, `truthy`; `timeout` fails the step unless `onTimeout: continue`.
- Captions are Go templates over the cabinet's state (`.` = `cabinets.<id>`), plus `.lastMigration`, `.now`.
- `scenarios/all.yaml` lists cabinets in order; `scenarios/attract.yaml` is `all` with `loop: true` and `resetBetween: true`.

## Keyboard / input (UI)
`1`–`6` open cabinets, `0`/`Esc` lobby, `Space` ▶ auto-run current cabinet, `R` reset current cabinet, `A` toggle attract mode, `F` fullscreen. All controls are also touch targets ≥ 64 px.
