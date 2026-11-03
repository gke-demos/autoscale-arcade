// Mirrors docs/contracts.md — keep in sync (contracts.md is the source of truth).

export type Message =
  | { type: 'snapshot'; state: WorldState }
  | { type: 'pet'; pet: PetState }
  | { type: 'scenario'; scenario: ScenarioState }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; text: string };

export interface WorldState {
  ts: string;
  cluster: {
    name: string;
    version: string;
    project: string;
    region: string;
    autoscaler: {
      status: string;
      scaleUp: string;
      scaleDown: string;
      scaleDownCandidates: number;
      nodeGroups: NodeGroup[];
      updated: string;
    };
  };
  nodes: Node[];
  pods: Pod[];
  cabinets: {
    climber: ClimberState;
    spot: SpotState;
    teleporter: TeleporterState;
    absorber: AbsorberState;
    lights: LightsState;
    nitro: NitroState;
    metrics: MetricsState;
  };
  scenario: ScenarioState;
  events: ArcadeEvent[];
}

export interface NodeGroup {
  name: string;
  pool: string;
  zone: string;
  ready: number;
  total: number;
  target: number;
  min: number;
  max: number;
  scaleUp: string;
  backoff?: string;
}

export interface Node {
  name: string;
  pool: string;
  zone: string;
  machineType: string;
  machineFamily: string;
  spot: boolean;
  computeClass?: string;
  gvisor: boolean;
  buffer?: 'active' | 'standby';
  ready: boolean;
  unschedulable: boolean;
  suspended: boolean;
  creating: boolean;
  deleting: boolean;
  created: string;
  cpu: { allocatable: number; requested: number };
  memory: { allocatable: number; requested: number };
}

export type PodPhase = 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown';

export interface Pod {
  uid: string;
  name: string;
  namespace: string;
  cabinet: string;
  workload: string;
  node?: string;
  phase: PodPhase;
  ready: boolean;
  deleting: boolean;
  pendingReason?: string;
  created: string;
  scheduledAt?: string;
  readyAt?: string;
  spot?: boolean;
  placement?: 'spot' | 'on-demand';
  fallback?: boolean;
  boost?: { active: boolean; cpuRequest: string; cpuOriginal: string };
  cpu: { request: string; actual?: string };
  migration?: { job: string; phase: string };
  buffer?: boolean;
}

export interface ArcadeEvent {
  ts: string;
  type: 'Normal' | 'Warning';
  reason: string;
  object: string;
  message: string;
  cabinet?: string;
}

export interface ClimberState {
  replicas: number;
  desired: number;
  ready: number;
  computeClass: {
    name: string;
    locked: boolean;
    priorities: { machineFamily: string; spot: boolean; locked: boolean }[];
  };
  rungs: { index: number; label: string; nodes: string[]; pods: number }[];
}

export interface SpotState {
  replicas: number;
  spotRatio: number;
  action: 'Fail' | 'FallbackToOnDemand';
  validated: boolean;
  inFallback: boolean;
  counts: { spot: number; onDemand: number; fallback: number; pending: number };
  stockout: boolean;
  costPerHour: { current: number; allOnDemand: number };
  guardrail: { minSpotRatio: string; maxFallbackRatio: string };
  policy: { name: string; reversion: string };
}

export interface MigrationJob {
  name: string;
  phase: string;
  originNode?: string;
  snapshot?: string;
  startedAt: string;
  snapshottingAt?: string;
  evictingAt?: string;
  restoringAt?: string;
  completedAt?: string;
  restoredReason?: string;
  restoredPod?: string;
}

export interface TeleporterState {
  pet: { pod?: string; node?: string; connected: boolean; uid?: string };
  gvisorNodes: string[];
  jobs: MigrationJob[];
  lastMigration?: {
    from: string;
    to: string;
    downtimeMs: number;
    restored: 'verified' | 'inferred' | 'lost' | 'failed';
    at: string;
  };
}

export interface PetState {
  pod: string;
  node: string;
  ticks: number;
  score: number;
  lives: number;
  uptimeSec: number;
  ball: { x: number; y: number; vx: number; vy: number };
  restoredAt?: string;
  bornAt: string;
}

export type AbsorberPreset = 'none' | 'active4' | 'active8' | 'standby8';

export interface AbsorberState {
  preset: AbsorberPreset;
  buffers: {
    name: string;
    strategy: 'active' | 'standby';
    replicas: number;
    statusReplicas: number;
    ready: boolean;
    limitedByQuota: boolean;
  }[];
  burst: {
    desired: number;
    ready: number;
    startedAt?: string;
    allReadyAt?: string;
    perPodReadyMs: number[];
  };
  headroomCostPerHour: number;
}

export interface LightsState {
  queueDepth: number;
  processed: number;
  hpa: {
    current: number;
    desired: number;
    min: number;
    max: number;
    scaledToZero: boolean;
    scalingActive: boolean;
    metricValue?: number;
    lastScale?: string;
  };
  metricName: string;
}

export interface NitroLane {
  name: 'stock' | 'nitro';
  boosted: boolean;
  pod?: string;
  createdAt?: string;
  readyAt?: string;
  cpuRequest?: string;
  cpuOriginal?: string;
  unboostedAt?: string;
}

export interface NitroState {
  race?: { startedAt: string; lanes: NitroLane[]; winner?: string };
  vpa: { factor: number; durationSeconds: number; updateMode: string };
}

export interface MetricsState {
  load: number;
  targetAverage: number;
  targetPods: number;
  readyPods: number;
  onTarget: boolean;
  hits: number;
  hpa: {
    current: number;
    desired: number;
    min: number;
    max: number;
    scaledToZero: boolean;
    scalingActive: boolean;
    metricValue?: number;
    lastScale?: string;
  };
  metricName: string;
}

export interface ScenarioState {
  running: boolean;
  name?: string;
  cabinet?: string;
  step: number;
  steps: number;
  caption?: string;
  startedAt?: string;
  error?: string;
  attract: boolean;
}

export interface LeaderboardEntry {
  cabinet: string;
  initials: string;
  score: number;
  unit: string;
  at?: string;
}

export type CabinetId = 'climber' | 'spot' | 'teleporter' | 'absorber' | 'lights' | 'nitro' | 'metrics';

export const CABINET_IDS: CabinetId[] = ['climber', 'spot', 'teleporter', 'absorber', 'lights', 'nitro', 'metrics'];

export interface CabinetMeta {
  id: CabinetId;
  key: string; // keyboard digit
  title: string;
  subtitle: string;
  feature: string;
  goal: string;
  namespace: string;
  scenario: string;
  accent: string; // hex colour
}

export const CABINETS: Record<CabinetId, CabinetMeta> = {
  climber: {
    id: 'climber',
    key: '1',
    title: 'Capacity Climber',
    subtitle: 'Custom Compute Classes',
    feature: 'ComputeClass priorities · node pool auto-creation · active migration',
    goal: 'Scale across a 3-rung node priority ladder, survive a rung-1 outage, and auto-migrate back.',
    namespace: 'arcade-climber',
    scenario: 'climber',
    accent: '#4285f4',
  },
  spot: {
    id: 'spot',
    key: '2',
    title: 'Spot On',
    subtitle: 'Workload Class spot ratio',
    feature: 'WorkloadClass capacityStrategy · fallback · active reversion',
    goal: 'Save 50%+ on Spot while surviving preemptions and stockouts with On-Demand fallback.',
    namespace: 'arcade-spot',
    scenario: 'spot',
    accent: '#34a853',
  },
  teleporter: {
    id: 'teleporter',
    key: '3',
    title: 'Pod Teleporter',
    subtitle: 'Live Pod Migration',
    feature: 'PodMigrationJob · gVisor snapshot / restore',
    goal: 'Drag & drop a live stateful pet pod across nodes without losing its in-memory counter.',
    namespace: 'arcade-teleporter',
    scenario: 'teleporter',
    accent: '#fbbc04',
  },
  absorber: {
    id: 'absorber',
    key: '4',
    title: 'Shock Absorber',
    subtitle: 'Capacity Buffers',
    feature: 'CapacityBuffer active / standby headroom',
    goal: 'Pre-warm ghost capacity so a +12 pod traffic burst becomes Ready in seconds.',
    namespace: 'arcade-absorber',
    scenario: 'absorber',
    accent: '#4285f4',
  },
  lights: {
    id: 'lights',
    key: '5',
    title: 'Lights Out',
    subtitle: 'Scale to zero',
    feature: 'HPA minReplicas: 0 · AutoscalingMetric',
    goal: 'Drop coins to wake a zero-pod deployment from sleep, drain the queue, and scale back to 0.',
    namespace: 'arcade-lights',
    scenario: 'lights',
    accent: '#fbbc04',
  },
  nitro: {
    id: 'nitro',
    key: '6',
    title: 'Nitro',
    subtitle: 'CPU startup boost',
    feature: 'VPA startupBoost · in-place resize',
    goal: 'Win the cold-start drag race with a 4× VPA CPU Startup Boost, then resize in-place with 0 restarts.',
    namespace: 'arcade-nitro',
    scenario: 'nitro',
    accent: '#ea4335',
  },
  metrics: {
    id: 'metrics',
    key: '7',
    title: 'Metric Dialer',
    subtitle: 'Prometheus HPA',
    feature: 'AutoscalingMetric (pod / promql) · HPA maxReplicas: 10',
    goal: 'Slide the custom Prometheus metric load to scale the HPA to the exact target pod count (1–10 pods).',
    namespace: 'arcade-metrics',
    scenario: 'metrics',
    accent: '#34a853',
  },
};
