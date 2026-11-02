// Mock arcade-server: a deterministic in-browser simulation of the WorldState
// so the UI can be built and demoed without a cluster (VITE_MOCK=1).
// It is intentionally "honest": every action goes through the same phases the
// real cluster would show (pending pods → creating nodes → ready → scheduled).

import type {
  AbsorberPreset,
  ArcadeEvent,
  LeaderboardEntry,
  Message,
  Node,
  PetState,
  Pod,
  ScenarioState,
  WorldState,
} from '../types';
import { CABINETS, CABINET_IDS, type CabinetId } from '../types';

type Listener = (m: Message) => void;

const now = () => new Date().toISOString();
const uid = () => Math.random().toString(36).slice(2, 10);
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

const PRICE: Record<string, number> = {
  'n4-standard-4': 0.19,
  'n4-standard-2': 0.095,
  'n4d-standard-4': 0.17,
  'n4d-standard-2': 0.085,
  'e2-standard-4': 0.134,
};
const SPOT_DISCOUNT = 0.35; // spot ≈ 35% of list

function nodeCost(n: Node) {
  const p = PRICE[n.machineType] ?? 0.15;
  return n.spot ? p * SPOT_DISCOUNT : p;
}

interface Timer {
  at: number;
  fn: () => void;
}

export class MockServer {
  private listeners = new Set<Listener>();
  private nodes: Node[] = [];
  private pods: Pod[] = [];
  private events: ArcadeEvent[] = [];
  private timers: Timer[] = [];
  private dirty = true;
  private pet: PetState;
  private petRunning = true;
  private petBounds = { w: 100, h: 60 };
  private leaderboard: LeaderboardEntry[] = [
    { cabinet: 'teleporter', initials: 'GKE', score: 1430, unit: 'ms', at: now() },
    { cabinet: 'absorber', initials: 'CAP', score: 9.4, unit: 's', at: now() },
    { cabinet: 'nitro', initials: 'VPA', score: 6.1, unit: 's', at: now() },
  ];

  // cabinet state
  private climber = { desired: 0, locked: false };
  private spot = { replicas: 10, ratio: 80, stockout: false };
  private tele = { jobs: [] as WorldState['cabinets']['teleporter']['jobs'], last: undefined as WorldState['cabinets']['teleporter']['lastMigration'] };
  private absorber = { preset: 'none' as AbsorberPreset, burstDesired: 0, startedAt: undefined as string | undefined, allReadyAt: undefined as string | undefined, perPodReadyMs: [] as number[] };
  private lights = { queue: 0, processed: 0, desired: 0, lastScale: undefined as string | undefined, scaledToZeroSince: Date.now() };
  private nitro = { race: undefined as WorldState['cabinets']['nitro']['race'] };
  private scenario: ScenarioState = { running: false, step: 0, steps: 0, attract: false };
  private scenarioAbort?: () => void;
  private caStatus = { scaleUp: 'NoActivity', scaleDown: 'NoCandidates', candidates: 0 };

  constructor() {
    this.seed();
    this.pet = {
      pod: 'pet-0',
      node: 'gke-arcade-gvisor-pool-1a2b-0001',
      ticks: 184_210,
      score: 42_870,
      lives: 3,
      uptimeSec: 18_421,
      ball: { x: 40, y: 20, vx: 23, vy: 17 },
      bornAt: new Date(Date.now() - 18_421_000).toISOString(),
    };
    window.setInterval(() => this.tick(), 100);
    window.setInterval(() => this.flush(), 250);
  }

  // ---- public API -------------------------------------------------------

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l({ type: 'snapshot', state: this.snapshot() });
    return () => this.listeners.delete(l);
  }

  getLeaderboard = async () => [...this.leaderboard].sort((a, b) => a.score - b.score);
  postLeaderboard = async (e: LeaderboardEntry) => {
    this.leaderboard.push({ ...e, at: now() });
  };

  action = async (name: string, body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> => {
    await new Promise((r) => setTimeout(r, rnd(80, 220)));
    try {
      switch (name) {
        case 'climber.scale':
          this.scaleClimber(Number(body.replicas ?? 0));
          break;
        case 'climber.lock':
          this.lockClimber(Boolean(body.locked));
          break;
        case 'spot.scale':
          this.spot.replicas = Number(body.replicas ?? 10);
          this.reconcileSpot();
          break;
        case 'spot.ratio':
          this.spot.ratio = Math.max(0, Math.min(100, Number(body.spotRatio ?? 80)));
          this.event('Normal', 'WorkloadClassUpdated', 'workloadclass/checkout', `spotRatio set to ${this.spot.ratio}%`, 'spot');
          this.reconcileSpot();
          break;
        case 'spot.preempt':
          this.preempt(String(body.node ?? ''));
          break;
        case 'spot.stockout':
          this.stockout(Boolean(body.enabled));
          break;
        case 'teleporter.migrate':
          this.migrate(String(body.toNode ?? ''));
          break;
        case 'teleporter.random': {
          const others = this.gvisorNodes().filter((n) => n !== this.pet.node);
          this.migrate(others[Math.floor(Math.random() * others.length)]);
          break;
        }
        case 'absorber.preset':
          this.preset(String(body.preset ?? 'none') as AbsorberPreset);
          break;
        case 'absorber.burst':
          this.burst(Number(body.delta ?? 12));
          break;
        case 'absorber.reset':
          this.absorber.burstDesired = 0;
          this.absorber.startedAt = undefined;
          this.absorber.allReadyAt = undefined;
          this.absorber.perPodReadyMs = [];
          this.reconcileBurst();
          break;
        case 'lights.coin':
          this.coin(Number(body.count ?? 1));
          break;
        case 'nitro.race':
          this.race();
          break;
        case 'reset':
          this.reset(body.cabinet as CabinetId | undefined);
          break;
        case 'scenario.run':
          this.runScenario(String(body.name ?? 'all'));
          break;
        case 'scenario.stop':
          this.stopScenario();
          break;
        default:
          return { ok: false, error: `unknown action ${name}` };
      }
      this.dirty = true;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  // ---- seed world -------------------------------------------------------

  private mkNode(p: Partial<Node> & Pick<Node, 'name' | 'pool' | 'machineType'>): Node {
    const n: Node = {
      zone: 'us-central1-a',
      machineFamily: p.machineType.split('-')[0],
      spot: false,
      gvisor: false,
      ready: true,
      unschedulable: false,
      suspended: false,
      creating: false,
      deleting: false,
      created: new Date(Date.now() - rnd(3600e3, 86400e3)).toISOString(),
      cpu: { allocatable: 3.92, requested: 0.4 },
      memory: { allocatable: 13.6, requested: 1.2 },
      ...p,
    };
    this.nodes.push(n);
    return n;
  }

  private mkPod(p: Partial<Pod> & Pick<Pod, 'name' | 'cabinet' | 'workload'>): Pod {
    const pod: Pod = {
      uid: uid(),
      namespace: p.cabinet === 'system' ? 'arcade-system' : `arcade-${p.cabinet}`,
      phase: 'Running',
      ready: true,
      deleting: false,
      created: now(),
      scheduledAt: now(),
      readyAt: now(),
      cpu: { request: '250m' },
      ...p,
    };
    if (pod.node) pod.spot = this.node(pod.node)?.spot ?? false;
    this.pods.push(pod);
    return pod;
  }

  private seed() {
    this.nodes = [];
    this.pods = [];
    // system pool
    this.mkNode({ name: 'gke-arcade-default-pool-9f1c-0001', pool: 'default-pool', machineType: 'n4-standard-4', zone: 'us-central1-a' });
    this.mkNode({ name: 'gke-arcade-default-pool-9f1c-0002', pool: 'default-pool', machineType: 'n4-standard-4', zone: 'us-central1-b' });
    // gVisor pool (teleporter)
    for (let i = 1; i <= 3; i++)
      this.mkNode({ name: `gke-arcade-gvisor-pool-1a2b-000${i}`, pool: 'gvisor-pool', machineType: 'n4-standard-4', gvisor: true, zone: ['us-central1-a', 'us-central1-b', 'us-central1-c'][i - 1] });
    // spot-on NAP pools
    this.mkNode({ name: 'gke-arcade-nap-n4d-spot-7d3e-0001', pool: 'nap-n4d-spot-7d3e', machineType: 'n4d-standard-4', spot: true, computeClass: 'arcade-spot' });
    this.mkNode({ name: 'gke-arcade-nap-n4d-spot-7d3e-0002', pool: 'nap-n4d-spot-7d3e', machineType: 'n4d-standard-4', spot: true, computeClass: 'arcade-spot', zone: 'us-central1-b' });
    this.mkNode({ name: 'gke-arcade-nap-n4-od-5c2a-0001', pool: 'nap-n4-od-5c2a', machineType: 'n4-standard-4', computeClass: 'arcade-spot', zone: 'us-central1-c' });

    this.mkPod({ name: 'arcade-server-6d9f8b7c4-x2k9p', cabinet: 'system', workload: 'arcade-server', node: 'gke-arcade-default-pool-9f1c-0001', cpu: { request: '500m' } });
    this.mkPod({ name: 'pet-0', cabinet: 'teleporter', workload: 'pet', node: 'gke-arcade-gvisor-pool-1a2b-0001', cpu: { request: '100m' }, created: new Date(Date.now() - 18_421_000).toISOString() });
    this.mkPod({ name: 'stock-5f6d7c8b9-abcde', cabinet: 'nitro', workload: 'stock', node: 'gke-arcade-default-pool-9f1c-0002', cpu: { request: '250m' } });
    this.mkPod({ name: 'nitro-7a8b9c0d1-fghij', cabinet: 'nitro', workload: 'nitro', node: 'gke-arcade-default-pool-9f1c-0002', cpu: { request: '250m' }, boost: { active: false, cpuRequest: '250m', cpuOriginal: '250m' } });
    this.reconcileSpot(true);
    this.event('Normal', 'Started', 'arcade-server', 'Mock arcade-server started (VITE_MOCK=1)');
  }

  // ---- helpers ----------------------------------------------------------

  private node(name: string) {
    return this.nodes.find((n) => n.name === name);
  }
  private gvisorNodes() {
    return this.nodes.filter((n) => n.gvisor && n.ready && !n.unschedulable).map((n) => n.name);
  }
  private after(ms: number, fn: () => void) {
    this.timers.push({ at: Date.now() + ms, fn });
  }
  private event(type: ArcadeEvent['type'], reason: string, object: string, message: string, cabinet?: string) {
    this.events.unshift({ ts: now(), type, reason, object, message, cabinet });
    this.events = this.events.slice(0, 50);
    this.dirty = true;
  }
  private emit(m: Message) {
    this.listeners.forEach((l) => l(m));
  }
  private podsOf(workload: string) {
    return this.pods.filter((p) => p.workload === workload && !p.deleting);
  }
  private removePod(p: Pod, graceMs = 1500) {
    p.deleting = true;
    this.dirty = true;
    this.after(graceMs, () => {
      this.pods = this.pods.filter((x) => x.uid !== p.uid);
      this.dirty = true;
    });
  }
  /** Node creation lifecycle: placeholder → creating → ready. */
  private createNode(spec: Partial<Node> & Pick<Node, 'pool' | 'machineType'>, cabinet: string, readyIn = rnd(14000, 22000)) {
    const idx = this.nodes.filter((n) => n.pool === spec.pool).length + 1;
    const placeholder = this.mkNode({ ...spec, name: `pending-${spec.pool}-${idx}`, creating: true, ready: false, created: now() });
    this.caStatus.scaleUp = 'InProgress';
    this.event('Normal', 'ScaleUp', `nodegroup/${spec.pool}`, `Scale-up: setting group ${spec.pool} size to ${idx}`, cabinet);
    const finalName = `gke-arcade-${spec.pool}-${uid().slice(0, 4)}-${String(idx).padStart(4, '0')}`;
    this.after(readyIn * 0.4, () => {
      const old = placeholder.name;
      placeholder.name = finalName;
      this.pods.forEach((p) => {
        if (p.node === old) p.node = finalName;
      });
      this.dirty = true;
    });
    this.after(readyIn, () => {
      placeholder.creating = false;
      placeholder.ready = true;
      this.event('Normal', 'NodeReady', `node/${finalName}`, `Node ${finalName} status is now: NodeReady`, cabinet);
      if (!this.nodes.some((n) => n.creating)) this.caStatus.scaleUp = 'NoActivity';
      this.dirty = true;
    });
    return placeholder;
  }
  private drainNode(n: Node, cabinet: string, ms = 6000) {
    if (n.deleting) return;
    n.deleting = true;
    n.unschedulable = true;
    this.caStatus.scaleDown = 'InProgress';
    this.event('Normal', 'ScaleDown', `node/${n.name}`, `node removed by cluster autoscaler`, cabinet);
    this.pods.filter((p) => p.node === n.name).forEach((p) => this.evictAndReplace(p));
    this.after(ms, () => {
      this.nodes = this.nodes.filter((x) => x !== n);
      if (!this.nodes.some((x) => x.deleting)) this.caStatus.scaleDown = 'NoCandidates';
      this.dirty = true;
    });
  }
  private evictAndReplace(p: Pod) {
    this.removePod(p, 1200);
    const w = p.workload;
    this.after(300, () => this.reconcile(w));
  }
  private reconcile(workload: string) {
    if (workload === 'climber') this.reconcileClimber();
    else if (workload === 'checkout') this.reconcileSpot();
    else if (workload === 'burst-worker') this.reconcileBurst();
    else if (workload === 'coin-worker') this.reconcileLights();
    else if (workload === 'stock' || workload === 'nitro') this.ensureNitro(workload);
  }
  /** Schedule a pending pod on a fitting node, else trigger scale-up. */
  private place(p: Pod, fits: (n: Node) => boolean, capacity: number, scaleUp: () => void) {
    const candidates = this.nodes.filter((n) => n.ready && !n.unschedulable && !n.deleting && !n.suspended && fits(n));
    const target = candidates.find((n) => this.pods.filter((x) => x.node === n.name && !x.deleting && !x.buffer).length < capacity);
    if (target) {
      // snap into a ghost if one is there
      const ghost = this.pods.find((x) => x.buffer && x.node === target.name);
      if (ghost) this.pods = this.pods.filter((x) => x !== ghost);
      p.node = target.name;
      p.spot = target.spot;
      p.pendingReason = undefined;
      p.scheduledAt = now();
      this.event('Normal', 'Scheduled', `pod/${p.name}`, `Successfully assigned ${p.namespace}/${p.name} to ${target.name}`, p.cabinet);
      const warm = p.workload === 'burst-worker' ? 10000 : p.workload === 'stock' ? 20000 : p.workload === 'nitro' ? 5500 : rnd(2000, 4000);
      this.after(warm, () => {
        if (p.deleting) return;
        p.phase = 'Running';
        p.ready = true;
        p.readyAt = now();
        if (p.workload === 'burst-worker') {
          const ms = Date.parse(p.readyAt) - Date.parse(p.created);
          this.absorber.perPodReadyMs = [...this.absorber.perPodReadyMs, ms];
          const all = this.podsOf('burst-worker');
          if (all.length >= this.absorber.burstDesired && all.every((x) => x.ready) && !this.absorber.allReadyAt) this.absorber.allReadyAt = now();
        }
        if (p.workload === 'stock' || p.workload === 'nitro') this.laneReady(p);
        this.dirty = true;
      });
      return true;
    }
    p.pendingReason = 'TriggeredScaleUp';
    scaleUp();
    return false;
  }

  // ---- Capacity Climber --------------------------------------------------

  private climberRungs() {
    const pri = [
      { machineFamily: 'n4d', spot: true, pool: 'nap-n4d-spot-climber', mt: 'n4d-standard-4' },
      { machineFamily: 'n4', spot: true, pool: 'nap-n4-spot-climber', mt: 'n4-standard-4' },
      { machineFamily: 'n4', spot: false, pool: 'nap-n4-od-climber', mt: 'n4-standard-4' },
    ];
    return pri;
  }
  private scaleClimber(replicas: number) {
    this.climber.desired = Math.max(0, Math.min(24, replicas));
    this.event('Normal', 'ScalingReplicaSet', 'deployment/climber', `Scaled replica set climber to ${this.climber.desired}`, 'climber');
    this.reconcileClimber();
  }
  private lockClimber(locked: boolean) {
    this.climber.locked = locked;
    this.event('Normal', 'ComputeClassUpdated', 'computeclass/arcade-climber', locked ? 'priority #1 pinned to reservation affinity AnyThenFail (unobtainable)' : 'priority #1 restored to Spot', 'climber');
    if (locked) {
      // pods on rung 1 are no longer eligible → active migration drains them
      this.nodes.filter((n) => n.pool === 'nap-n4d-spot-climber').forEach((n) => this.drainNode(n, 'climber', 8000));
    } else {
      // active migration: optimizeRulePriority moves pods back up after new nodes appear
      const rung2 = this.nodes.filter((n) => n.pool !== 'nap-n4d-spot-climber' && n.computeClass === 'arcade-climber');
      if (rung2.length) {
        this.after(500, () => {
          const r = this.climberRungs()[0];
          const needed = Math.ceil(this.podsOf('climber').length / 8);
          for (let i = 0; i < needed; i++) this.createNode({ pool: r.pool, machineType: r.mt, spot: r.spot, computeClass: 'arcade-climber' }, 'climber');
        });
        this.after(24000, () => rung2.forEach((n) => this.drainNode(n, 'climber', 9000)));
      }
    }
  }
  private reconcileClimber() {
    const pods = this.podsOf('climber');
    const desired = this.climber.desired;
    for (let i = pods.length; i < desired; i++) {
      this.mkPod({ name: `climber-7c9d8e6f5-${uid().slice(0, 5)}`, cabinet: 'climber', workload: 'climber', phase: 'Pending', ready: false, pendingReason: 'Unschedulable', scheduledAt: undefined, readyAt: undefined, cpu: { request: '500m' } });
    }
    for (let i = desired; i < pods.length; i++) this.removePod(pods[pods.length - 1 - (i - desired)]);
    this.after(1200, () => this.scheduleClimber());
    this.after(5000, () => this.consolidateClimber());
  }
  private scheduleClimber() {
    const pending = this.podsOf('climber').filter((p) => !p.node);
    if (!pending.length) return;
    const rungs = this.climberRungs();
    const rung = this.climber.locked ? rungs[1] : rungs[0];
    let triggered = false;
    pending.forEach((p) =>
      this.place(
        p,
        (n) => n.computeClass === 'arcade-climber' && (n.pool === rung.pool || (this.climber.locked && n.pool !== rungs[0].pool)),
        8,
        () => {
          if (triggered) return;
          triggered = true;
          const needed = Math.ceil(pending.length / 8);
          this.event('Normal', 'TriggeredScaleUp', `pod/${p.name}`, `pod triggered scale-up: [{${rung.pool} 0->${needed} (max: 10)}]`, 'climber');
          for (let i = 0; i < needed; i++) this.createNode({ pool: rung.pool, machineType: rung.mt, spot: rung.spot, computeClass: 'arcade-climber' }, 'climber');
          this.after(23000, () => this.scheduleClimber());
        },
      ),
    );
  }
  private consolidateClimber() {
    this.nodes
      .filter((n) => n.computeClass === 'arcade-climber' && n.ready && !n.deleting && !this.pods.some((p) => p.node === n.name && !p.deleting))
      .forEach((n) => {
        this.caStatus.scaleDown = 'CandidatesPresent';
        this.caStatus.candidates++;
        this.after(8000, () => {
          this.caStatus.candidates = Math.max(0, this.caStatus.candidates - 1);
          if (!this.pods.some((p) => p.node === n.name && !p.deleting)) this.drainNode(n, 'climber', 5000);
        });
      });
  }

  // ---- Spot On ------------------------------------------------------------

  private reconcileSpot(initial = false) {
    const pods = this.podsOf('checkout');
    const { replicas, ratio } = this.spot;
    for (let i = replicas; i < pods.length; i++) this.removePod(pods[pods.length - 1 - (i - replicas)]);
    const wantSpot = Math.round((replicas * ratio) / 100);
    const existing = this.podsOf('checkout');
    let spotCount = existing.filter((p) => p.placement === 'spot').length;
    for (let i = existing.length; i < replicas; i++) {
      const placement = spotCount < wantSpot ? 'spot' : 'on-demand';
      if (placement === 'spot') spotCount++;
      const p = this.mkPod({ name: `checkout-5b6c7d8e9-${uid().slice(0, 5)}`, cabinet: 'spot', workload: 'checkout', phase: 'Pending', ready: false, placement, pendingReason: 'Unschedulable', scheduledAt: undefined, readyAt: undefined });
      if (initial) {
        this.placeSpot(p);
        p.phase = 'Running';
        p.ready = true;
        p.readyAt = now();
      } else this.after(rnd(400, 1500), () => this.placeSpot(p));
    }
    // ratio changed on existing pods: the webhook re-injects placement on new pods only,
    // so the plugin rolls pods whose placement no longer matches the target split.
    if (!initial) {
      const cur = this.podsOf('checkout');
      const curSpot = cur.filter((p) => p.placement === 'spot').length;
      const diff = curSpot - wantSpot;
      const victims = diff > 0 ? cur.filter((p) => p.placement === 'spot').slice(0, diff) : cur.filter((p) => p.placement === 'on-demand').slice(0, -diff);
      victims.forEach((v, i) =>
        this.after(800 + i * 700, () => {
          this.removePod(v, 900);
          const p = this.mkPod({ name: `checkout-5b6c7d8e9-${uid().slice(0, 5)}`, cabinet: 'spot', workload: 'checkout', phase: 'Pending', ready: false, placement: diff > 0 ? 'on-demand' : 'spot', scheduledAt: undefined, readyAt: undefined });
          this.after(600, () => this.placeSpot(p));
        }),
      );
    }
  }
  private placeSpot(p: Pod) {
    if (p.deleting || p.node) return;
    const wantsSpot = p.placement === 'spot';
    const spotAvailable = !this.spot.stockout;
    const fits = (n: Node) => n.computeClass === 'arcade-spot' && (wantsSpot && spotAvailable ? n.spot : !n.spot);
    const ok = this.place(p, fits, 4, () => {
      const spot = wantsSpot && spotAvailable;
      this.createNode({ pool: spot ? 'nap-n4d-spot-7d3e' : 'nap-n4-od-5c2a', machineType: spot ? 'n4d-standard-4' : 'n4-standard-4', spot, computeClass: 'arcade-spot' }, 'spot', rnd(12000, 18000));
      this.after(17000, () => this.placeSpot(p));
    });
    if (ok) p.fallback = wantsSpot && !spotAvailable;
  }
  private preempt(name: string) {
    const n = this.node(name);
    if (!n) throw new Error(`node ${name} not found`);
    if (!n.spot) throw new Error(`${name} is not a Spot node`);
    this.event('Warning', 'PreemptScheduled', `node/${name}`, 'Instance was preempted (simulateMaintenanceEvent)', 'spot');
    this.after(2500, () => {
      n.ready = false;
      n.deleting = true;
      this.event('Warning', 'NodeNotReady', `node/${name}`, 'Node is not ready: Spot VM preempted', 'spot');
      this.pods.filter((p) => p.node === name).forEach((p) => this.evictAndReplace(p));
      this.after(5000, () => {
        this.nodes = this.nodes.filter((x) => x !== n);
        this.dirty = true;
      });
    });
  }
  private stockout(enabled: boolean) {
    this.spot.stockout = enabled;
    if (enabled) {
      this.event('Warning', 'Stockout', 'computeclass/arcade-spot', 'Spot rules removed; Spot nodes cordoned and draining', 'spot');
      this.nodes.filter((n) => n.computeClass === 'arcade-spot' && n.spot).forEach((n) => this.drainNode(n, 'spot', 7000));
    } else {
      this.event('Normal', 'CapacityReturned', 'computeclass/arcade-spot', 'Spot rules restored; active reversion evicting fallback pods oldest-first', 'spot');
      const fallback = this.podsOf('checkout').filter((p) => p.fallback).sort((a, b) => a.created.localeCompare(b.created));
      fallback.forEach((p, i) =>
        this.after(2000 + i * 1200, () => {
          this.event('Normal', 'Reverted', `pod/${p.name}`, 'Evicted by GKESpotPlacementPolicy reversion (Active)', 'spot');
          this.evictAndReplace(p);
        }),
      );
    }
  }

  // ---- Pod Teleporter -----------------------------------------------------

  private migrate(toNode: string) {
    if (!toNode) throw new Error('toNode required');
    if (!this.gvisorNodes().includes(toNode)) throw new Error(`${toNode} is not a ready gVisor node`);
    if (toNode === this.pet.node) throw new Error('pet is already on that node');
    if (this.tele.jobs[0] && !['Succeeded', 'SucceededWithoutRestore', 'Failed'].includes(this.tele.jobs[0].phase)) throw new Error('migration already in progress');
    const pet = this.pods.find((p) => p.name === 'pet-0')!;
    const from = this.pet.node;
    const job: WorldState['cabinets']['teleporter']['jobs'][number] = {
      name: `pet-0-${uid().slice(0, 5)}`,
      phase: 'Pending',
      originNode: from,
      startedAt: now(),
    };
    this.tele.jobs = [job, ...this.tele.jobs].slice(0, 10);
    pet.migration = { job: job.name, phase: job.phase };
    this.event('Normal', 'EvictionIntercepted', 'pod/pet-0', `Eviction converted to PodMigrationJob ${job.name}`, 'teleporter');
    const setPhase = (ph: string) => {
      job.phase = ph;
      pet.migration = { job: job.name, phase: ph };
      this.dirty = true;
    };
    this.after(900, () => {
      setPhase('Snapshotting');
      job.snapshottingAt = now();
      job.snapshot = `pet-0-snap-${uid().slice(0, 4)}`;
      this.event('Normal', 'GKEPodSnapshotting', 'pod/pet-0', `Snapshotting pod to gs://arcade-snapshots/${job.snapshot}`, 'teleporter');
    });
    const freezeAt = 2600;
    this.after(freezeAt, () => {
      this.petRunning = false;
    });
    this.after(4200, () => {
      setPhase('Evicting');
      job.evictingAt = now();
      pet.deleting = true;
    });
    this.after(5400, () => {
      setPhase('Restoring');
      job.restoringAt = now();
      pet.deleting = false;
      pet.node = toNode;
      pet.phase = 'Pending';
      pet.ready = false;
      pet.created = now();
      pet.uid = uid();
      pet.pendingReason = 'SchedulingGated';
      this.event('Normal', 'Scheduled', 'pod/pet-0', `Successfully assigned arcade-teleporter/pet-0 to ${toNode}`, 'teleporter');
    });
    const restoreAt = 5400 + rnd(900, 2200);
    this.after(restoreAt, () => {
      pet.phase = 'Running';
      pet.ready = true;
      pet.pendingReason = undefined;
      pet.readyAt = now();
      pet.scheduledAt = now();
      this.pet.node = toNode;
      this.pet.lives += 1;
      this.pet.restoredAt = now();
      this.petRunning = true;
      setPhase('Succeeded');
      job.completedAt = now();
      job.restoredReason = 'RestoreVerified';
      job.restoredPod = 'pet-0';
      this.tele.last = { from, to: toNode, downtimeMs: Math.round(restoreAt - freezeAt), restored: 'verified', at: now() };
      this.event('Normal', 'Restored', 'pod/pet-0', `Restored from ${job.snapshot} on ${toNode} (RestoreVerified)`, 'teleporter');
      this.after(4000, () => {
        pet.migration = undefined;
        this.dirty = true;
      });
    });
  }

  // ---- Shock Absorber -----------------------------------------------------

  private preset(preset: AbsorberPreset) {
    this.absorber.preset = preset;
    const active = preset === 'active4' ? 4 : preset === 'active8' ? 8 : 0;
    const standby = preset === 'standby8' ? 8 : 0;
    this.event('Normal', 'BufferUpdated', 'capacitybuffer/absorber-active', `replicas ${active}`, 'absorber');
    this.event('Normal', 'BufferUpdated', 'capacitybuffer/absorber-standby', `replicas ${standby}`, 'absorber');
    // ghosts: 4 per node
    const ghosts = this.pods.filter((p) => p.buffer);
    this.pods = this.pods.filter((p) => !p.buffer);
    void ghosts;
    const bufferNodes = this.nodes.filter((n) => n.computeClass === 'arcade-absorber');
    const want = Math.ceil((active + standby) / 4);
    const strategy: Node['buffer'] = standby ? 'standby' : 'active';
    bufferNodes.forEach((n) => (n.buffer = strategy));
    for (let i = bufferNodes.length; i < want; i++) {
      const n = this.createNode({ pool: 'nap-n4-absorber', machineType: 'n4-standard-4', computeClass: 'arcade-absorber', buffer: strategy }, 'absorber', rnd(15000, 20000));
      if (standby) this.after(26000, () => {
        if (!this.pods.some((p) => p.node === n.name && !p.buffer)) {
          n.suspended = true;
          this.event('Normal', 'NodeSuspended', `node/${n.name}`, 'Standby capacity: node suspended', 'absorber');
        }
      });
    }
    for (let i = want; i < bufferNodes.length; i++) this.drainNode(bufferNodes[bufferNodes.length - 1 - (i - want)], 'absorber', 5000);
    if (!standby) bufferNodes.forEach((n) => (n.suspended = false));
    const total = active + standby;
    const allBuffer = this.nodes.filter((n) => n.computeClass === 'arcade-absorber' && !n.deleting);
    for (let i = 0; i < total; i++) {
      const n = allBuffer[Math.floor(i / 4)];
      this.mkPod({ name: `ghost-${standby ? 'absorber-standby' : 'absorber-active'}-${i + 1}`, cabinet: 'absorber', workload: 'burst-unit', buffer: true, node: n?.name, phase: 'Running', ready: true, cpu: { request: '900m' } });
    }
    this.dirty = true;
  }
  private burst(delta: number) {
    this.absorber.burstDesired += delta;
    this.absorber.startedAt = now();
    this.absorber.allReadyAt = undefined;
    this.absorber.perPodReadyMs = [];
    this.event('Normal', 'ScalingReplicaSet', 'deployment/burst-worker', `Scaled up replica set burst-worker to ${this.absorber.burstDesired}`, 'absorber');
    this.reconcileBurst();
  }
  private reconcileBurst() {
    const pods = this.podsOf('burst-worker');
    const d = this.absorber.burstDesired;
    for (let i = d; i < pods.length; i++) this.removePod(pods[pods.length - 1 - (i - d)]);
    for (let i = pods.length; i < d; i++)
      this.mkPod({ name: `burst-worker-4e5f6a7b8-${uid().slice(0, 5)}`, cabinet: 'absorber', workload: 'burst-worker', phase: 'Pending', ready: false, pendingReason: 'Unschedulable', scheduledAt: undefined, readyAt: undefined, cpu: { request: '900m' } });
    // standby nodes resume first
    this.nodes.filter((n) => n.computeClass === 'arcade-absorber' && n.suspended).forEach((n) =>
      this.after(2500, () => {
        n.suspended = false;
        this.event('Normal', 'NodeResumed', `node/${n.name}`, 'Standby capacity: node resumed', 'absorber');
      }),
    );
    this.after(600, () => this.scheduleBurst());
    if (d === 0) this.after(4000, () => this.nodes.filter((n) => n.computeClass === 'arcade-absorber' && !this.pods.some((p) => p.node === n.name && !p.deleting) && this.absorber.preset === 'none').forEach((n) => this.drainNode(n, 'absorber', 4000)));
  }
  private scheduleBurst() {
    const pending = this.podsOf('burst-worker').filter((p) => !p.node);
    if (!pending.length) return;
    let triggered = false;
    const suspended = this.nodes.some((n) => n.computeClass === 'arcade-absorber' && n.suspended);
    if (suspended) {
      this.after(2800, () => this.scheduleBurst());
      return;
    }
    pending.forEach((p) =>
      this.place(p, (n) => n.computeClass === 'arcade-absorber', 4, () => {
        if (triggered) return;
        triggered = true;
        const stillPending = this.podsOf('burst-worker').filter((x) => !x.node).length;
        const needed = Math.ceil(stillPending / 4);
        this.event('Normal', 'TriggeredScaleUp', `pod/${p.name}`, `pod triggered scale-up: [{nap-n4-absorber +${needed}}]`, 'absorber');
        for (let i = 0; i < needed; i++) this.createNode({ pool: 'nap-n4-absorber', machineType: 'n4-standard-4', computeClass: 'arcade-absorber' }, 'absorber');
        this.after(21000, () => this.scheduleBurst());
      }),
    );
  }

  // ---- Lights Out ---------------------------------------------------------

  private coin(count: number) {
    this.lights.queue += count;
    this.event('Normal', 'CoinInserted', 'arcade-server', `${count} coin(s) queued (arcade_queue_depth=${this.lights.queue})`, 'lights');
    this.after(count >= 50 ? 1200 : 4000, () => this.hpaTick());
  }
  private hpaTick() {
    const q = this.lights.queue;
    const want = Math.min(10, Math.ceil(q / 5));
    if (want > this.lights.desired) {
      this.lights.desired = want;
      this.lights.lastScale = now();
      this.event('Normal', 'SuccessfulRescale', 'horizontalpodautoscaler/coin-worker', `New size: ${want}; reason: external metric autoscaling.gke.io|coin-queue|arcade_queue_depth above target`, 'lights');
      this.reconcileLights();
    }
  }
  private reconcileLights() {
    const pods = this.podsOf('coin-worker');
    const d = this.lights.desired;
    for (let i = d; i < pods.length; i++) this.removePod(pods[pods.length - 1 - (i - d)]);
    for (let i = pods.length; i < d; i++) {
      const p = this.mkPod({ name: `coin-worker-8f9a0b1c2-${uid().slice(0, 5)}`, cabinet: 'lights', workload: 'coin-worker', phase: 'Pending', ready: false, scheduledAt: undefined, readyAt: undefined, cpu: { request: '100m' } });
      this.after(rnd(300, 900), () => this.place(p, (n) => n.pool === 'default-pool', 12, () => {}));
    }
  }
  private ensureNitro(workload: 'stock' | 'nitro') {
    if (this.podsOf(workload).length) return;
    const p = this.mkPod({ name: `${workload}-${uid().slice(0, 9)}-${uid().slice(0, 5)}`, cabinet: 'nitro', workload, phase: 'Pending', ready: false, scheduledAt: undefined, readyAt: undefined });
    this.after(300, () => this.place(p, (n) => n.pool === 'default-pool', 12, () => {}));
  }

  // ---- Nitro --------------------------------------------------------------

  private race() {
    this.podsOf('stock').forEach((p) => this.removePod(p, 800));
    this.podsOf('nitro').forEach((p) => this.removePod(p, 800));
    this.event('Normal', 'ScalingReplicaSet', 'deployment/stock', 'rollout restart', 'nitro');
    this.event('Normal', 'ScalingReplicaSet', 'deployment/nitro', 'rollout restart', 'nitro');
    const mk = (workload: 'stock' | 'nitro') => {
      const p = this.mkPod({ name: `${workload}-${uid().slice(0, 9)}-${uid().slice(0, 5)}`, cabinet: 'nitro', workload, phase: 'Pending', ready: false, scheduledAt: undefined, readyAt: undefined, cpu: { request: workload === 'nitro' ? '1' : '250m' } });
      if (workload === 'nitro') p.boost = { active: true, cpuRequest: '1', cpuOriginal: '250m' };
      this.after(400, () => this.place(p, (n) => n.pool === 'default-pool', 12, () => {}));
      return p;
    };
    const stock = mk('stock');
    const nitro = mk('nitro');
    this.event('Normal', 'StartupBoost', `pod/${nitro.name}`, 'vpaCpuStartupBoost/app: cpu request boosted 250m → 1 (factor 4)', 'nitro');
    this.nitro.race = {
      startedAt: now(),
      lanes: [
        { name: 'stock', boosted: false, pod: stock.name, createdAt: stock.created, cpuRequest: '250m', cpuOriginal: '250m' },
        { name: 'nitro', boosted: true, pod: nitro.name, createdAt: nitro.created, cpuRequest: '1', cpuOriginal: '250m' },
      ],
    };
  }
  private laneReady(p: Pod) {
    const r = this.nitro.race;
    if (!r) return;
    const lane = r.lanes.find((l) => l.pod === p.name);
    if (!lane) return;
    lane.readyAt = p.readyAt;
    if (!r.winner) r.winner = lane.name;
    if (lane.name === 'nitro') {
      this.after(4000, () => {
        lane.unboostedAt = now();
        lane.cpuRequest = '250m';
        if (p.boost) p.boost = { active: false, cpuRequest: '250m', cpuOriginal: '250m' };
        p.cpu = { request: '250m', actual: '250m' };
        this.event('Normal', 'InPlaceResizedByVPA', `pod/${p.name}`, 'cpu request resized in place 1 → 250m (startup boost ended, RESTARTS 0)', 'nitro');
        this.dirty = true;
      });
    }
  }

  // ---- reset / scenarios ---------------------------------------------------

  private reset(cabinet?: CabinetId) {
    const ids = cabinet ? [cabinet] : CABINET_IDS;
    ids.forEach((id) => {
      switch (id) {
        case 'climber':
          this.climber = { desired: 0, locked: false };
          this.reconcileClimber();
          break;
        case 'spot':
          this.spot = { replicas: 10, ratio: 80, stockout: false };
          this.reconcileSpot();
          break;
        case 'teleporter':
          break;
        case 'absorber':
          this.absorber.burstDesired = 0;
          this.absorber.startedAt = undefined;
          this.absorber.allReadyAt = undefined;
          this.absorber.perPodReadyMs = [];
          this.reconcileBurst();
          this.preset('none');
          break;
        case 'lights':
          this.lights.queue = 0;
          break;
        case 'nitro':
          this.nitro.race = undefined;
          break;
      }
      this.event('Normal', 'Reset', `cabinet/${id}`, 'returned to start state', id);
    });
  }

  private captions: Record<string, { cabinet: CabinetId; steps: { caption: string; action?: () => void; wait: number }[] }> = {
    climber: {
      cabinet: 'climber',
      steps: [
        { caption: 'ComputeClass arcade-climber prefers n4d Spot, then n4 Spot, then n4 on-demand.', wait: 4000 },
        { caption: 'Scale to 12: pending pods trigger node pool auto-creation on the top rung.', action: () => this.scaleClimber(12), wait: 26000 },
        { caption: 'Lock rung #1 (reservation AnyThenFail): pods migrate down to rung #2.', action: () => this.lockClimber(true), wait: 28000 },
        { caption: 'Unlock: active migration moves pods back up; old nodes consolidate.', action: () => this.lockClimber(false), wait: 30000 },
        { caption: 'Scale to 0 → consolidation removes the auto-created pools.', action: () => this.scaleClimber(0), wait: 12000 },
      ],
    },
    spot: {
      cabinet: 'spot',
      steps: [
        { caption: 'WorkloadClass checkout: 80% Spot, fallback to on-demand allowed.', wait: 4000 },
        { caption: 'Dial the ratio to 40%: the plugin re-balances placement.', action: () => { this.spot.ratio = 40; this.reconcileSpot(); }, wait: 12000 },
        { caption: 'Stockout! Spot nodes drain; pods fall back to on-demand (InFallback=True).', action: () => this.stockout(true), wait: 22000 },
        { caption: 'Capacity returns: active reversion evicts fallback pods back onto Spot.', action: () => this.stockout(false), wait: 22000 },
        { caption: 'Back to 80% Spot.', action: () => { this.spot.ratio = 80; this.reconcileSpot(); }, wait: 6000 },
      ],
    },
    teleporter: {
      cabinet: 'teleporter',
      steps: [
        { caption: 'All of the pet’s state lives in memory on its node.', wait: 4000 },
        { caption: 'Teleporting… snapshot → evict → restore on another node.', action: () => this.action('teleporter.random', {}), wait: 10000 },
        { caption: 'Same ticks, new node — only a moment of downtime.', wait: 6000 },
      ],
    },
    absorber: {
      cabinet: 'absorber',
      steps: [
        { caption: 'No buffer: a burst of 12 pods has to wait for new nodes.', action: () => this.burst(12), wait: 34000 },
        { caption: 'Reset, then reserve 8 active replicas of headroom (ghost pods).', action: () => { this.action('absorber.reset', {}); this.preset('active8'); }, wait: 24000 },
        { caption: 'Fire the same burst: pods snap into the ghosts instantly.', action: () => this.burst(12), wait: 16000 },
      ],
    },
    lights: {
      cabinet: 'lights',
      steps: [
        { caption: 'HPA minReplicas: 0 — the lights are out and nothing is running.', wait: 4000 },
        { caption: 'Slam 50 coins: arcade_queue_depth jumps and the HPA scales from zero.', action: () => this.coin(50), wait: 20000 },
        { caption: 'Workers drain the queue; after the stabilisation window the lights go out again.', wait: 40000 },
      ],
    },
    nitro: {
      cabinet: 'nitro',
      steps: [
        { caption: 'Two identical pods — one with a 4× CPU startup boost from VPA.', wait: 4000 },
        { caption: 'Start race: rollout restart both; first to Ready wins.', action: () => this.race(), wait: 26000 },
        { caption: 'After readiness VPA shrinks the boosted pod in place (RESTARTS 0).', wait: 8000 },
      ],
    },
  };

  private runScenario(name: string) {
    this.stopScenario();
    // scenarios/<name>.yaml is named after the cabinet id; accept the old long names too.
    const alias: Record<string, string> = { 'capacity-climber': 'climber', 'spot-on': 'spot', 'pod-teleporter': 'teleporter', 'shock-absorber': 'absorber', 'lights-out': 'lights' };
    const names = name === 'all' || name === 'attract' ? [...CABINET_IDS] : [alias[name] ?? name];
    const loop = name === 'attract';
    let cancelled = false;
    this.scenarioAbort = () => {
      cancelled = true;
    };
    const run = async () => {
      do {
        for (const n of names) {
          const sc = this.captions[n];
          if (!sc) {
            this.scenario = { running: false, name: n, step: 0, steps: 0, error: `unknown scenario ${n}`, attract: false };
            this.emit({ type: 'scenario', scenario: this.scenario });
            this.emit({ type: 'toast', level: 'error', text: `scenario ${n} not found` });
            return;
          }
          if (loop) this.reset(sc.cabinet);
          for (let i = 0; i < sc.steps.length; i++) {
            if (cancelled) return;
            const st = sc.steps[i];
            this.scenario = { running: true, name: n, cabinet: sc.cabinet, step: i + 1, steps: sc.steps.length, caption: st.caption, startedAt: this.scenario.startedAt ?? now(), attract: loop };
            this.emit({ type: 'scenario', scenario: this.scenario });
            st.action?.();
            this.dirty = true;
            await new Promise((r) => setTimeout(r, st.wait));
          }
        }
      } while (loop && !cancelled);
      this.scenario = { running: false, name, step: 0, steps: 0, attract: false };
      this.emit({ type: 'scenario', scenario: this.scenario });
    };
    void run();
  }
  private stopScenario() {
    this.scenarioAbort?.();
    this.scenarioAbort = undefined;
    if (this.scenario.running) {
      this.scenario = { running: false, step: 0, steps: 0, attract: false };
      this.emit({ type: 'scenario', scenario: this.scenario });
    }
  }

  // ---- simulation loop ----------------------------------------------------

  private petTickCount = 0;
  private tick() {
    const t = Date.now();
    const due = this.timers.filter((x) => x.at <= t);
    this.timers = this.timers.filter((x) => x.at > t);
    due.forEach((x) => x.fn());
    if (due.length) this.dirty = true;

    // pet: 10 ticks/s, bouncing ball
    if (this.petRunning) {
      const p = this.pet;
      p.ticks += 1;
      p.uptimeSec = Math.round((t - Date.parse(p.bornAt)) / 1000);
      const b = p.ball;
      b.x += b.vx * 0.1;
      b.y += b.vy * 0.1;
      if (b.x < 0 || b.x > this.petBounds.w) {
        b.vx = -b.vx;
        b.x = Math.max(0, Math.min(this.petBounds.w, b.x));
        p.score += 10;
      }
      if (b.y < 0 || b.y > this.petBounds.h) {
        b.vy = -b.vy;
        b.y = Math.max(0, Math.min(this.petBounds.h, b.y));
        p.score += 10;
      }
      this.emit({ type: 'pet', pet: { ...p, ball: { ...b } } });
    }

    // lights: workers drain the queue (one coin / 8 s / worker ≈ 0.0125/s/worker → speed up for demo: 1 coin / 2 s)
    this.petTickCount++;
    if (this.petTickCount % 20 === 0) {
      const workers = this.podsOf('coin-worker').filter((p) => p.ready).length;
      if (workers && this.lights.queue > 0) {
        const n = Math.min(this.lights.queue, workers);
        this.lights.queue -= n;
        this.lights.processed += n;
        this.dirty = true;
      }
      if (this.lights.queue === 0 && this.lights.desired > 0) {
        // stabilisation window 60s → shortened to 20s for the mock
        if (!this.lights.scaledToZeroSince || t - this.lights.scaledToZeroSince > 20000) {
          this.lights.desired = 0;
          this.lights.lastScale = now();
          this.event('Normal', 'SuccessfulRescale', 'horizontalpodautoscaler/coin-worker', 'New size: 0; reason: All metrics below target (ScaledToZero)', 'lights');
          this.reconcileLights();
        }
      } else this.lights.scaledToZeroSince = t;
      if (this.lights.queue > 0) this.hpaTick();
    }
  }

  private flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.emit({ type: 'snapshot', state: this.snapshot() });
  }

  // ---- derive WorldState --------------------------------------------------

  private snapshot(): WorldState {
    const climberPods = this.podsOf('climber');
    const rungs = this.climberRungs().map((r, i) => {
      const nodes = this.nodes.filter((n) => n.pool === r.pool).map((n) => n.name);
      return { index: i + 1, label: `${r.machineFamily} ${r.spot ? 'Spot' : 'on-demand'}`, nodes, pods: climberPods.filter((p) => p.node && nodes.includes(p.node)).length };
    });
    const checkout = this.podsOf('checkout');
    const spotNodes = this.nodes.filter((n) => n.computeClass === 'arcade-spot' && !n.deleting && !n.creating);
    const cost = spotNodes.reduce((a, n) => a + nodeCost(n), 0);
    const allOD = spotNodes.reduce((a, n) => a + (PRICE[n.machineType] ?? 0.15), 0);
    const bufNodes = this.nodes.filter((n) => n.computeClass === 'arcade-absorber' && !n.deleting);
    const burstPods = this.podsOf('burst-worker');
    const coinPods = this.podsOf('coin-worker');
    const inFallback = checkout.some((p) => p.fallback);
    const pending = this.pods.filter((p) => !p.node && !p.deleting).length;
    const pools = [...new Set(this.nodes.map((n) => n.pool))];
    return {
      ts: now(),
      cluster: {
        name: 'autoscale-arcade',
        version: '1.37.1-gke.1000',
        project: 'gke-demos-345619',
        region: 'us-central1',
        autoscaler: {
          status: 'Running',
          scaleUp: pending ? 'InProgress' : this.caStatus.scaleUp,
          scaleDown: this.caStatus.scaleDown,
          scaleDownCandidates: this.caStatus.candidates,
          nodeGroups: pools.map((pool) => {
            const ns = this.nodes.filter((n) => n.pool === pool);
            return { name: pool, pool, zone: ns[0]?.zone ?? 'us-central1', ready: ns.filter((n) => n.ready).length, total: ns.length, target: ns.length, min: pool === 'gvisor-pool' ? 3 : 0, max: pool === 'gvisor-pool' ? 3 : 10, scaleUp: ns.some((n) => n.creating) ? 'InProgress' : 'NoActivity' };
          }),
          updated: now(),
        },
      },
      nodes: this.nodes.map((n) => ({
        ...n,
        cpu: { allocatable: n.cpu.allocatable, requested: Math.min(n.cpu.allocatable, 0.3 + this.pods.filter((p) => p.node === n.name && !p.buffer).reduce((a, p) => a + cpuOf(p.cpu.request), 0)) },
      })),
      pods: this.pods.map((p) => ({ ...p })),
      cabinets: {
        climber: {
          replicas: climberPods.length,
          desired: this.climber.desired,
          ready: climberPods.filter((p) => p.ready).length,
          computeClass: {
            name: 'arcade-climber',
            locked: this.climber.locked,
            priorities: [
              { machineFamily: 'n4d', spot: true, locked: this.climber.locked },
              { machineFamily: 'n4', spot: true, locked: false },
              { machineFamily: 'n4', spot: false, locked: false },
            ],
          },
          rungs,
        },
        spot: {
          replicas: this.spot.replicas,
          spotRatio: this.spot.ratio,
          action: 'FallbackToOnDemand',
          validated: true,
          inFallback,
          counts: {
            spot: checkout.filter((p) => p.node && p.spot).length,
            onDemand: checkout.filter((p) => p.node && !p.spot && !p.fallback).length,
            fallback: checkout.filter((p) => p.fallback).length,
            pending: checkout.filter((p) => !p.node).length,
          },
          stockout: this.spot.stockout,
          costPerHour: { current: +cost.toFixed(3), allOnDemand: +allOD.toFixed(3) },
          guardrail: { minSpotRatio: '20%', maxFallbackRatio: '50%' },
          policy: { name: 'arcade-spot', reversion: 'Active' },
        },
        teleporter: {
          pet: { pod: 'pet-0', node: this.pet.node, connected: this.petRunning, uid: this.pods.find((p) => p.name === 'pet-0')?.uid },
          gvisorNodes: this.gvisorNodes(),
          jobs: this.tele.jobs.map((j) => ({ ...j })),
          lastMigration: this.tele.last,
        },
        absorber: {
          preset: this.absorber.preset,
          buffers: [
            { name: 'absorber-active', strategy: 'active', replicas: this.absorber.preset === 'active4' ? 4 : this.absorber.preset === 'active8' ? 8 : 0, statusReplicas: this.pods.filter((p) => p.buffer && p.name.includes('active')).length, ready: bufNodes.length > 0 && bufNodes.every((n) => n.ready), limitedByQuota: false },
            { name: 'absorber-standby', strategy: 'standby', replicas: this.absorber.preset === 'standby8' ? 8 : 0, statusReplicas: this.pods.filter((p) => p.buffer && p.name.includes('standby')).length, ready: bufNodes.length > 0 && bufNodes.every((n) => n.ready), limitedByQuota: false },
          ],
          burst: { desired: this.absorber.burstDesired, ready: burstPods.filter((p) => p.ready).length, startedAt: this.absorber.startedAt, allReadyAt: this.absorber.allReadyAt, perPodReadyMs: this.absorber.perPodReadyMs },
          headroomCostPerHour: +bufNodes.reduce((a, n) => a + (n.suspended ? nodeCost(n) * 0.1 : nodeCost(n)), 0).toFixed(3),
        },
        lights: {
          queueDepth: this.lights.queue,
          processed: this.lights.processed,
          hpa: { current: coinPods.length, desired: this.lights.desired, min: 0, max: 10, scaledToZero: this.lights.desired === 0 && coinPods.length === 0, scalingActive: true, metricValue: this.lights.queue, lastScale: this.lights.lastScale },
          metricName: 'autoscaling.gke.io|coin-queue|arcade_queue_depth',
        },
        nitro: {
          race: this.nitro.race ? { ...this.nitro.race, lanes: this.nitro.race.lanes.map((l) => ({ ...l })) } : undefined,
          vpa: { factor: 4, durationSeconds: 0, updateMode: 'InPlaceOrRecreate' },
        },
      },
      scenario: { ...this.scenario },
      events: [...this.events],
    };
  }
}

function cpuOf(s: string) {
  if (s.endsWith('m')) return parseInt(s, 10) / 1000;
  return parseFloat(s) || 0;
}

let instance: MockServer | undefined;
export function mockServer() {
  if (!instance) instance = new MockServer();
  return instance;
}

export { CABINETS };
