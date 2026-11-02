import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { ago } from '../lib/format';
import { ClusterScene } from '../scene/ClusterScene';
import { useArcade } from '../store';
import type { ClimberState, Node, WorldState } from '../types';
import { ActionButton, Badge, ControlGroup, CostMeter, MissionCard, Stat, Stopwatch, eventsSection, podTable, shortNodeName, useCabinetLayout } from './common';
import type { CabinetModule, CabinetProps, HudSection } from './types';

const ACCENT = '#4285f4';
const LOCK_COLOR = '#ea4335';
const MAX_REPLICAS = 32;
const QUICK = [0, 6, 12, 24];

/** List prices (USD/h, us-central1) used for the cost meter; Spot ≈ 35 % of list. */
const PRICE: Record<string, number> = {
  'n4-standard-2': 0.095,
  'n4d-standard-2': 0.085,
  'n4-standard-4': 0.19,
  'n4d-standard-4': 0.17,
};
const SPOT_DISCOUNT = 0.35;
function nodeCost(n: Node): number {
  const list = PRICE[n.machineType] ?? 0.15;
  return n.spot ? list * SPOT_DISCOUNT : list;
}

// ---- data helpers ---------------------------------------------------------

/** The server numbers rungs from 0 (priority array index); the UI talks about "rung #1". */
function climberState(world: WorldState): ClimberState {
  const c = world.cabinets.climber;
  if (!c.rungs.length || !c.rungs.some((r) => r.index === 0)) return c;
  return { ...c, rungs: c.rungs.map((r) => ({ ...r, index: r.index + 1 })) };
}

/** Node name → rung index (1-based) from `world.cabinets.climber.rungs`, falling back to pool membership. */
function rungOfNode(world: WorldState): (n: Node) => number | undefined {
  const byName = new Map<string, number>();
  const byPool = new Map<string, number>();
  for (const r of climberState(world).rungs) {
    for (const name of r.nodes) {
      byName.set(name, r.index);
      const n = world.nodes.find((x) => x.name === name);
      if (n && !byPool.has(n.pool)) byPool.set(n.pool, r.index);
    }
  }
  return (n) => byName.get(n.name) ?? byPool.get(n.pool);
}

function isClimberNode(world: WorldState): (n: Node) => boolean {
  const rung = rungOfNode(world);
  return (n) => n.computeClass === 'arcade-climber' || rung(n) !== undefined;
}

function climberNodes(world: WorldState): Node[] {
  return world.nodes.filter(isClimberNode(world));
}

// ---- 3D ---------------------------------------------------------------------

function Scene({ world }: CabinetProps) {
  const c = climberState(world);
  const rung = useMemo(() => rungOfNode(world), [world]);
  const rungLabel = useMemo(() => new Map(c.rungs.map((r) => [r.index, r.label])), [c.rungs]);
  const layout = useCabinetLayout(world, 'climber', {
    extraNodes: isClimberNode(world),
    groupKey: (n) => {
      const r = rung(n);
      return r !== undefined ? `rung:${r}:${n.pool}` : `pool:${n.pool}`;
    },
    groupLabel: (key, nodes) => {
      const m = key.match(/^rung:(\d+):(.*)$/);
      const n0 = nodes[0];
      if (m) return { label: `Rung #${m[1]} · ${rungLabel.get(Number(m[1])) ?? m[2]}`, sublabel: `${m[2]}${n0 ? ` · ${n0.machineType}` : ''}` };
      return { label: key.replace(/^pool:/, ''), sublabel: n0?.machineType };
    },
    // rung islands first, in priority order; anything unranked trails behind
    order: [...new Set(world.nodes.filter((n) => rung(n) !== undefined).map((n) => `rung:${rung(n)}:${n.pool}`))].sort(),
  });
  const lockedRungs = new Set(c.computeClass.priorities.map((p, i) => (p.locked ? i + 1 : 0)).filter(Boolean));
  if (c.computeClass.locked) lockedRungs.add(1);

  return (
    <>
      <ClusterScene layout={layout} />
      {layout.islands
        .filter((isl) => {
          const m = isl.key.match(/^rung:(\d+):/);
          return m && lockedRungs.has(Number(m[1]));
        })
        .map((isl) => (
          <Padlock key={`lock-${isl.key}`} center={isl.center} w={isl.w} d={isl.d} />
        ))}
      {/* Locked rung with no island yet (e.g. nothing scaled): still say so in-world. */}
      {c.computeClass.locked && !layout.islands.some((isl) => /^rung:1:/.test(isl.key)) && (
        <Html position={[layout.bounds.minX, 1.2, 0]} center zIndexRange={[25, 0]} style={{ pointerEvents: 'none' }}>
          <LockChip label={`Rung #1 · ${rungLabel.get(1) ?? 'n4d Spot'} locked`} />
        </Html>
      )}
    </>
  );
}

/** Translucent red cover + 🔒 over a locked rung island. */
function Padlock({ center, w, d }: { center: [number, number]; w: number; d: number }) {
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    if (mat.current) mat.current.opacity = 0.18 + 0.08 * Math.sin(clock.elapsedTime * 3);
  });
  return (
    <group position={[center[0], 0, center[1]]}>
      <mesh position={[0, 0.9, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w, d]} />
        <meshBasicMaterial ref={mat} color={LOCK_COLOR} transparent opacity={0.22} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <lineSegments position={[0, 0.9, 0]}>
        <edgesGeometry args={[new THREE.BoxGeometry(w, 0.02, d)]} />
        <lineBasicMaterial color={LOCK_COLOR} transparent opacity={0.8} />
      </lineSegments>
      <pointLight position={[0, 2.5, 0]} color={LOCK_COLOR} intensity={5} distance={8} decay={2} />
      <Html position={[0, 1.6, 0]} center zIndexRange={[25, 0]} style={{ pointerEvents: 'none' }}>
        <LockChip label="locked · reservations Specific (arcade-locked)" />
      </Html>
    </group>
  );
}

function LockChip({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 whitespace-nowrap rounded-full border border-red-400/60 bg-black/75 px-3 py-1 font-mono text-[0.8rem] text-red-100 shadow-[0_0_20px_rgba(239,68,68,0.6)]">
      <span className="text-[1.1rem]">🔒</span>
      {label}
    </div>
  );
}

// ---- Controls -----------------------------------------------------------------

function Controls({ world }: CabinetProps) {
  const c = climberState(world);
  const act = useArcade((s) => s.act);
  const busy = useArcade((s) => s.busy['climber.scale']);
  const locked = c.computeClass.locked;

  // Slider: local value while dragging, synced to desired otherwise; commit on release.
  const [value, setValue] = useState(c.desired);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setValue(c.desired);
  }, [c.desired]);
  const commit = (v: number) => {
    dragging.current = false;
    if (v !== c.desired) void act('climber.scale', { replicas: v }, { label: `Scale climber → ${v}` });
  };
  const pct = (value / MAX_REPLICAS) * 100;

  const podsOnRung = (idx: number) => c.rungs.find((r) => r.index === idx)?.pods ?? 0;
  const pending = world.pods.filter((p) => p.cabinet === 'climber' && !p.node && !p.deleting).length;
  const rung1Pods = podsOnRung(1);
  const fallbackPods = podsOnRung(2) + podsOnRung(3);

  const everScaled = useRef(false);
  const everLocked = useRef(false);
  const everMigratedBack = useRef(false);
  if (c.desired === 0 && c.replicas === 0 && !locked) {
    everScaled.current = false;
    everLocked.current = false;
    everMigratedBack.current = false;
  }
  if (c.ready >= 6) everScaled.current = true;
  if (locked || fallbackPods > 0) everLocked.current = true;
  if (everLocked.current && !locked && rung1Pods > 0) everMigratedBack.current = true;

  return (
    <>
      <MissionCard
        accent={ACCENT}
        goal="Scale a workload up a 3-rung ComputeClass priority ladder (n4d Spot → n4 Spot → n4 On-Demand), lock Rung #1 to force fallback, then unlock to watch activeMigration move pods back."
        win="Fastest scale-up time (s) at the lowest $/h node cost"
        steps={[
          {
            label: 'Scale replicas to ≥ 6',
            detail: 'Triggers Node Pool Auto-Creation on Rung #1 (n4d Spot).',
            done: everScaled.current || c.ready >= 6,
            active: !everScaled.current && c.desired >= 6,
          },
          {
            label: 'Lock Rung #1 (simulate Spot stockout)',
            detail: 'Pins priority #1 to an unobtainable reservation so pods fall back to Rung #2.',
            done: everLocked.current,
            active: everScaled.current && !everLocked.current,
          },
          {
            label: 'Unlock Rung #1 & watch active migration',
            detail: 'optimizeRulePriority: true moves pods from Rung #2 back onto Rung #1.',
            done: everMigratedBack.current,
            active: everLocked.current && !everMigratedBack.current,
          },
        ]}
      />

      <ControlGroup title="Scale Deployment/climber">
        <div className="flex items-end justify-between">
          <div className="font-mono text-[2.6rem] font-black leading-none" style={{ color: ACCENT }}>
            {value}
            <span className="ml-2 text-[1rem] font-bold text-slate-400">replicas</span>
          </div>
          <div className="font-mono text-[0.8rem] text-slate-400">
            desired <span className="text-slate-100">{c.desired}</span> · ready <span className={c.ready === c.desired ? 'text-lime-300' : 'text-amber-300'}>{c.ready}</span>
          </div>
        </div>
        <input
          type="range"
          className="slider"
          min={0}
          max={MAX_REPLICAS}
          step={1}
          value={value}
          disabled={busy}
          aria-label="climber replicas"
          style={{ '--pct': `${pct}%`, '--slider-accent': ACCENT } as React.CSSProperties}
          onPointerDown={() => (dragging.current = true)}
          onChange={(e) => setValue(Number(e.target.value))}
          onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
          onPointerCancel={(e) => commit(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
          onBlur={(e) => dragging.current && commit(Number(e.target.value))}
        />
        <div className="grid grid-cols-4 gap-2">
          {QUICK.map((n) => (
            <ActionButton key={n} action="climber.scale" body={{ replicas: n }} label={`Scale climber → ${n}`} accent={c.desired === n ? ACCENT : undefined} className="font-mono" onDone={() => setValue(n)}>
              {n}
            </ActionButton>
          ))}
        </div>
      </ControlGroup>

      <ControlGroup title="ComputeClass/arcade-climber priorities">
        <div className="flex flex-col gap-1 font-mono text-[0.85rem]">
          {c.computeClass.priorities.map((p, i) => {
            const idx = i + 1;
            const isLocked = p.locked || (idx === 1 && locked);
            const pods = podsOnRung(idx);
            return (
              <div key={idx} className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 ${isLocked ? 'border-[#ea4335]/60 bg-[#ea4335]/15 text-red-100' : pods ? 'border-[#4285f4]/50 bg-[#4285f4]/15 text-blue-100' : 'border-line/70 bg-black/30 text-slate-300'}`}>
                <span className="w-5 text-center">{isLocked ? '🔒' : pods ? '✓' : '·'}</span>
                <span className="text-slate-400">#{idx}</span>
                <span className="font-bold">{p.machineFamily}</span>
                <Badge tone={p.spot ? 'bg-[#34a853]/25 text-[#81c995]' : 'bg-[#4285f4]/25 text-[#8ab4f8]'}>{p.spot ? 'Spot' : 'on-demand'}</Badge>
                {isLocked && <span className="text-[0.7rem] text-red-300">Specific (arcade-locked)</span>}
                <span className="ml-auto">
                  {pods} pod{pods === 1 ? '' : 's'}
                </span>
              </div>
            );
          })}
          {pending > 0 && <div className="text-[0.8rem] text-[#fbbc04]">⏳ {pending} pending — waiting for node pool auto-creation</div>}
        </div>
        <ActionButton action="climber.lock" body={{ locked: !locked }} accent={locked ? LOCK_COLOR : undefined} label={locked ? 'Unlock rung #1' : 'Lock rung #1'}>
          {locked ? '🔓 Unlock rung #1' : '🔒 Lock rung #1'}
        </ActionButton>
        <div className="text-[0.8rem] text-slate-400">
          {locked
            ? 'Rung #1 is pinned to a non-existent reservation (arcade-locked) → unobtainable. Active migration moves pods down to rung #2.'
            : 'Locking patches priority #1 to a Specific reservation (arcade-locked); pods climb back when unlocked (activeMigration.optimizeRulePriority).'}
        </div>
      </ControlGroup>

      <ControlGroup title="Rungs">
        <div className="flex flex-wrap gap-2">
          <Stat label="desired / ready" value={<span className={c.ready === c.desired ? 'text-lime-300' : 'text-amber-300'}>{c.ready}/{c.desired}</span>} sub={`${c.replicas} pods exist`} />
          {c.rungs.map((r) => (
            <Stat key={r.index} label={`rung #${r.index}`} value={r.pods} sub={`${r.label} · ${r.nodes.length} node${r.nodes.length === 1 ? '' : 's'}`} tone={r.pods ? 'text-amber-200' : 'text-slate-500'} />
          ))}
        </div>
      </ControlGroup>
    </>
  );
}

// ---- Status (bottom bar) ----------------------------------------------------

function Status({ world }: CabinetProps) {
  const c = climberState(world);
  const setPrompt = useArcade((s) => s.setLeaderboardPrompt);
  const [startedAt, setStartedAt] = useState<string | undefined>(undefined);
  const [stoppedAt, setStoppedAt] = useState<string | undefined>(undefined);
  const lastDesired = useRef(c.desired);
  const running = useRef(false);
  const scaledUp = useRef(false);

  useEffect(() => {
    if (c.desired !== lastDesired.current) {
      scaledUp.current = c.desired > lastDesired.current;
      lastDesired.current = c.desired;
      if (c.ready !== c.desired) {
        setStartedAt(new Date().toISOString());
        setStoppedAt(undefined);
        running.current = true;
        return;
      }
    }
    if (running.current && c.ready === c.desired) {
      running.current = false;
      const end = new Date().toISOString();
      setStoppedAt(end);
      if (startedAt && scaledUp.current && c.desired > 0) {
        const s = +((Date.parse(end) - Date.parse(startedAt)) / 1000).toFixed(1);
        setPrompt({ cabinet: 'climber', score: s, unit: 's', label: `${c.desired} replicas ready in ${s}s` });
      }
    }
  }, [c.desired, c.ready, startedAt, setPrompt]);

  const nodes = climberNodes(world).filter((n) => !n.creating);
  const cost = nodes.reduce((a, n) => a + nodeCost(n), 0);
  const spotCount = nodes.filter((n) => n.spot).length;
  return (
    <>
      <Stopwatch startedAt={startedAt} stoppedAt={stoppedAt} label="scale → all ready" />
      <CostMeter perHour={cost} label="climber nodes" sub={`${nodes.length} node${nodes.length === 1 ? '' : 's'} · ${spotCount} spot`} />
    </>
  );
}

// ---- HUD --------------------------------------------------------------------

function hud(world: WorldState): HudSection[] {
  const c = climberState(world);
  const now = Date.now();
  const nodes = climberNodes(world);
  const pools = new Set(nodes.map((n) => n.pool));
  const ca = world.cluster.autoscaler;
  const groups = ca.nodeGroups.filter((g) => pools.has(g.pool));

  const yaml: HudSection = {
    kind: 'yaml',
    title: 'ComputeClass/arcade-climber',
    command: 'kubectl get computeclass arcade-climber -o yaml',
    value: {
      apiVersion: 'cloud.google.com/v1',
      kind: 'ComputeClass',
      metadata: { name: c.computeClass.name, labels: { 'arcade.gke.io/cabinet': 'climber' } },
      spec: {
        priorities: c.computeClass.priorities.map((p, i) =>
          p.locked || (i === 0 && c.computeClass.locked)
            ? { machineFamily: p.machineFamily, reservations: { affinity: 'Specific', specific: [{ name: 'arcade-locked' }] } }
            : { machineFamily: p.machineFamily, spot: p.spot },
        ),
        nodePoolAutoCreation: { enabled: true },
        activeMigration: { optimizeRulePriority: true },
        autoscalingPolicy: { consolidationDelayMinutes: 1, consolidationThreshold: 70 },
        whenUnsatisfiable: 'DoNotScaleUp',
      },
    },
  };

  const nodesTable: HudSection = {
    kind: 'table',
    title: 'Nodes',
    command: 'kubectl get nodes -L cloud.google.com/compute-class,cloud.google.com/machine-family,cloud.google.com/gke-spot',
    columns: ['NAME', 'STATUS', 'AGE', 'COMPUTE-CLASS', 'MACHINE-FAMILY', 'GKE-SPOT'],
    rows: nodes.map((n) => [
      shortNodeName(n.name),
      n.creating ? 'Creating' : n.deleting ? 'Draining' : n.unschedulable ? 'Ready,SchedulingDisabled' : n.ready ? 'Ready' : 'NotReady',
      n.creating ? '—' : ago(n.created, now),
      n.computeClass ?? '',
      n.machineFamily,
      n.spot ? 'true' : '',
    ]),
    highlight: (r) => (r[1] === 'Creating' ? 'text-amber-300' : r[1] === 'Draining' ? 'text-red-300' : undefined),
  };

  const caSection: HudSection = {
    kind: 'kv',
    title: 'cluster-autoscaler-status',
    items: [
      ['status', ca.status],
      ['scaleUp', ca.scaleUp, ca.scaleUp === 'InProgress' ? 'text-amber-300' : ca.scaleUp === 'Backoff' ? 'text-red-300' : undefined],
      ['scaleDown', `${ca.scaleDown}${ca.scaleDownCandidates ? ` (${ca.scaleDownCandidates})` : ''}`, ca.scaleDown !== 'NoCandidates' ? 'text-sky-300' : undefined],
      ...groups.map<[string, string, string?]>((g) => [g.pool, `ready ${g.ready}/${g.total} → target ${g.target} (${g.min}–${g.max}) ${g.scaleUp}${g.backoff ? ` backoff: ${g.backoff}` : ''}`, g.scaleUp === 'InProgress' ? 'text-amber-300' : g.backoff ? 'text-red-300' : undefined]),
      ['updated', ago(ca.updated, now) + ' ago'],
    ],
  };

  return [yaml, podTable(world.pods.filter((p) => p.cabinet === 'climber'), now), nodesTable, caSection, eventsSection(world, 'climber', now)];
}

export const climber: CabinetModule = {
  id: 'climber',
  Scene,
  Controls,
  hud,
  Status,
  hint: 'Scale 0–24 and lock rung #1 to watch pods climb the ComputeClass priorities.',
};
