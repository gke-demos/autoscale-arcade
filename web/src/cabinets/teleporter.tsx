import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { ago, secs, stopwatch } from '../lib/format';
import { Beam, ClusterScene, type NodeHighlight } from '../scene/ClusterScene';
import { SLAB } from '../scene/layout';
import { usePodDrag } from '../scene/usePodDrag';
import { useArcade } from '../store';
import type { Node, PetState, Pod, WorldState } from '../types';
import { ActionButton, ControlGroup, MissionCard, Stat, eventsSection, nodeTable, podTable, shortNodeName, useCabinetLayout, useNow } from './common';
import type { CabinetModule, CabinetProps } from './types';

const ACCENT = '#fbbc04';
const ACTIVE_PHASES = ['Pending', 'Snapshotting', 'Evicting', 'Restoring'];

function petPod(world: WorldState): Pod | undefined {
  const name = world.cabinets.teleporter.pet.pod ?? 'pet-0';
  return world.pods.find((p) => p.cabinet === 'teleporter' && p.name === name) ?? world.pods.find((p) => p.workload === 'pet');
}

function currentJob(world: WorldState) {
  return world.cabinets.teleporter.jobs[0];
}

/**
 * Returns false as soon as the replacement pet-0 pod is Ready on a destination
 * node or pet telemetry has resumed after job.startedAt, even if the controller
 * hasn't flipped PodMigrationJob.status.phase from Restoring to Succeeded yet.
 */
function isJobMigrating(world: WorldState, pet?: PetState): boolean {
  const job = currentJob(world);
  if (!job || !ACTIVE_PHASES.includes(job.phase)) return false;
  if (job.phase === 'Restoring') {
    const p = petPod(world);
    if (p && p.ready && !p.deleting && p.node && p.node !== job.originNode) return false;
    if (pet?.restoredAt && Date.parse(pet.restoredAt) > Date.parse(job.startedAt)) return false;
  }
  return true;
}

// ---- 3D ---------------------------------------------------------------------

function Scene({ world }: CabinetProps) {
  const t = world.cabinets.teleporter;
  const layout = useCabinetLayout(world, 'teleporter', { extraNodes: (n) => n.gvisor });
  const act = useArcade((s) => s.act);
  const drag = useArcade((s) => s.drag);
  const petTelemetry = useArcade((s) => s.pet);
  const pet = petPod(world);
  const job = currentJob(world);
  const migrating = isJobMigrating(world, petTelemetry);
  const gvisor = new Set(t.gvisorNodes);

  const canDrag = useCallback((p: Pod) => p.workload === 'pet' && !migrating && p.ready, [migrating]);
  const isTarget = useCallback((n: Node, p: Pod) => gvisor.has(n.name) && n.name !== p.node && n.ready && !n.unschedulable && !n.deleting, [t.gvisorNodes]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastDrop = useRef<string | undefined>(undefined);
  const { onPodPointerDown } = usePodDrag(layout, {
    canDrag,
    isTarget,
    onDrop: (_pod, node) => {
      lastDrop.current = node.name;
      void act('teleporter.migrate', { toNode: node.name }, { label: `Teleport → ${shortNodeName(node.name)}` });
    },
  });

  const nodeHighlight = useCallback(
    (n: Node): NodeHighlight => {
      if (drag) {
        if (drag.target === n.name) return 'target';
        if (n.name === drag.from) return 'origin';
        if (gvisor.has(n.name) && n.name !== drag.from && n.ready) return 'valid';
      }
      if (migrating && job?.originNode === n.name) return 'origin';
      if (migrating && pet?.node === n.name && pet.node !== job?.originNode) return 'target';
      return undefined;
    },
    [drag, migrating, job, pet, t.gvisorNodes], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // beam endpoints: snapshot goes up to the bucket ("cloud" point above the origin), restore comes down onto the target
  const from = job?.originNode ? layout.nodes.get(job.originNode)?.pos : undefined;
  const toName = pet?.node && pet.node !== job?.originNode ? pet.node : lastDrop.current;
  useEffect(() => {
    if (!migrating) lastDrop.current = undefined;
  }, [migrating]);
  const to = toName ? layout.nodes.get(toName)?.pos : undefined;
  const beamFrom = useMemo<[number, number, number] | undefined>(() => (from ? [from[0], SLAB.h + 0.4, from[2]] : undefined), [from]);
  const cloud = useMemo<[number, number, number] | undefined>(() => (from ? [from[0] + (to ? (to[0] - from[0]) / 2 : 0), SLAB.h + 4.2, from[2] + (to ? (to[2] - from[2]) / 2 : 0)] : undefined), [from, to]);
  const beamTo = useMemo<[number, number, number] | undefined>(() => (to ? [to[0], SLAB.h + 0.4, to[2]] : undefined), [to]);
  const restoring = job?.phase === 'Restoring';

  return (
    <>
      <ClusterScene layout={layout} draggable={canDrag} onPodPointerDown={onPodPointerDown} nodeHighlight={nodeHighlight} hiddenPod={drag?.podUid} />
      {drag && <DragGhost />}
      {beamFrom && cloud && <Beam from={beamFrom} to={cloud} active={migrating && !restoring} color={ACCENT} />}
      {cloud && beamTo && <Beam from={cloud} to={beamTo} active={migrating && restoring} color="#34a853" />}
      {cloud && migrating && (
        <Html position={[cloud[0], cloud[1] + 0.6, cloud[2]]} center zIndexRange={[30, 0]} style={{ pointerEvents: 'none' }}>
          <div className="whitespace-nowrap rounded-md bg-black/75 px-2 py-0.5 font-mono text-[0.65rem] text-[#fde293]">☁ PodSnapshot {job?.snapshot ? `· ${job.snapshot}` : '· gs://…/snapshots'}</div>
        </Html>
      )}
      {beamFrom && migrating && (
        <Html position={[beamFrom[0], beamFrom[1] + 2.4, beamFrom[2]]} center zIndexRange={[30, 0]} style={{ pointerEvents: 'none' }}>
          <PhaseChip phase={job!.phase} />
        </Html>
      )}
      {pet && <PetHalo world={world} />}
    </>
  );
}

function DragGhost() {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const d = useArcade.getState().drag;
    const g = ref.current;
    if (!d || !g) return;
    g.position.set(d.pos[0], d.pos[1] + 0.2 + 0.08 * Math.sin(clock.elapsedTime * 6), d.pos[2]);
    g.rotation.y += 0.04;
    const s = d.target ? 0.85 : 0.7;
    g.scale.lerp(new THREE.Vector3(s, s, s), 0.2);
  });
  return (
    <group ref={ref}>
      <mesh castShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={ACCENT} emissive={ACCENT} emissiveIntensity={0.9} toneMapped={false} />
      </mesh>
      <pointLight color={ACCENT} intensity={6} distance={6} />
      <Html position={[0, 1.1, 0]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
        <div className="whitespace-nowrap rounded-full border border-[#fbbc04]/60 bg-black/80 px-3 py-1 font-mono text-[0.75rem] text-[#fde293]">drop on a gVisor node ⬡</div>
      </Html>
    </group>
  );
}

function PetHalo({ world }: { world: WorldState }) {
  // A soft light on the node currently hosting the pet.
  const layout = useCabinetLayout(world, 'teleporter', { extraNodes: (n) => n.gvisor });
  const node = world.cabinets.teleporter.pet.node;
  const pos = node ? layout.nodes.get(node)?.pos : undefined;
  if (!pos) return null;
  return <pointLight position={[pos[0], 2.5, pos[2]]} color={ACCENT} intensity={8} distance={8} decay={2} />;
}

function PhaseChip({ phase }: { phase: string }) {
  const idx = ACTIVE_PHASES.indexOf(phase);
  return (
    <div className="flex items-center gap-2 rounded-full border border-[#fbbc04]/60 bg-black/80 px-3 py-1 font-mono text-[0.8rem] text-[#fde293] shadow-[0_0_20px_rgba(251,188,4,0.45)]">
      {['Snapshotting', 'Evicting', 'Restoring'].map((p, i) => (
        <span key={p} className={`${i + 1 <= idx ? 'text-[#fde293]' : 'text-slate-500'} ${p === phase ? 'animate-blink font-bold text-white' : ''}`}>
          {p}
          {i < 2 && <span className="ml-2 text-slate-500">→</span>}
        </span>
      ))}
    </div>
  );
}

// ---- Controls -----------------------------------------------------------------

function Controls({ world }: CabinetProps) {
  const t = world.cabinets.teleporter;
  const pet = useArcade((s) => s.pet);
  const petSeenAt = useArcade((s) => s.petSeenAt);
  const now = useNow(100);
  const job = currentJob(world);
  const migrating = isJobMigrating(world, pet);
  const live = pet && now - petSeenAt < 1500;
  const lastTickAt = useRef(0);
  const lastTicks = useRef(0);
  useEffect(() => {
    if (pet && pet.ticks !== lastTicks.current) {
      lastTicks.current = pet.ticks;
      lastTickAt.current = Date.now();
    }
  }, [pet]);
  const frozenMs = migrating || !live ? now - lastTickAt.current : 0;
  const setPrompt = useArcade((s) => s.setLeaderboardPrompt);
  const lastLM = useRef<{ at?: string; init: boolean }>({ init: false });
  useEffect(() => {
    const lm = t.lastMigration;
    if (lastLM.current.init && lm && lm.at !== lastLM.current.at && (lm.restored === 'verified' || lm.restored === 'inferred')) {
      setPrompt({ cabinet: 'teleporter', score: lm.downtimeMs, unit: 'ms', label: `Teleported with ${lm.downtimeMs} ms of downtime` });
    }
    lastLM.current = { at: lm?.at, init: true };
  }, [t.lastMigration, setPrompt]);

  const everMigrated = useRef(false);
  if (t.lastMigration && (t.lastMigration.restored === 'verified' || t.lastMigration.restored === 'inferred')) {
    everMigrated.current = true;
  }

  return (
    <>
      <MissionCard
        accent={ACCENT}
        goal="Teleport the stateful pet-0 pod across gVisor nodes without losing its in-memory counter, score, or bouncing ball trajectory!"
        win="Shortest migration downtime (ms) with in-memory ticks & lives preserved"
        steps={[
          {
            label: 'Watch pet-0 accumulate in-memory state',
            detail: `Ticks (${pet ? pet.ticks.toLocaleString() : '—'}) & ball velocity live purely in RAM — a normal restart wipes them to 0.`,
            done: (pet?.ticks ?? 0) >= 20,
            active: (pet?.ticks ?? 0) < 20,
          },
          {
            label: 'Drag & drop pet-0 onto another ⬡ gVisor node',
            detail: 'Or press Random teleport to trigger a GKE Pod Snapshot to GCS.',
            done: migrating || everMigrated.current || (pet?.lives ?? 1) > 1,
            active: !migrating && !everMigrated.current && (pet?.ticks ?? 0) >= 20,
          },
          {
            label: 'Verify memory survived on the new node',
            detail: 'pet-0 resumes from its exact tick count and gains a ♥ life!',
            done: everMigrated.current || (pet?.lives ?? 1) > 1,
            active: migrating,
          },
        ]}
      />

      <ControlGroup title="Arcade pet · pet-0 (in-memory state)">
        <div className="flex flex-wrap gap-2">
          <Stat label="ticks" value={<span className={migrating || !live ? 'text-[#fbbc04]' : 'text-[#81c995]'}>{pet ? pet.ticks.toLocaleString() : '—'}</span>} sub={live ? '10/s live' : 'no telemetry'} />
          <Stat label="score" value={pet?.score.toLocaleString() ?? '—'} />
          <Stat label="lives" value={pet ? '♥'.repeat(Math.min(pet.lives, 8)) + (pet.lives > 8 ? `+${pet.lives - 8}` : '') : '—'} tone="text-[#ea4335]" sub="migrations survived" />
          <Stat label="uptime" value={pet ? stopwatch(pet.uptimeSec * 1000).slice(0, 5) : '—'} sub={pet ? `since ${ago(pet.bornAt, now)} ago` : undefined} />
        </div>
        <PetBall />
        <div className="font-mono text-[0.75rem] text-slate-400">
          on <span className="text-slate-100">{t.pet.node ? shortNodeName(t.pet.node) : '—'}</span>
          {t.pet.connected ? <span className="ml-2 text-[#34a853]">● connected</span> : <span className="ml-2 text-[#fbbc04]">○ disconnected</span>}
        </div>
      </ControlGroup>

      <ControlGroup title="Teleport">
        <div className="rounded-xl border border-[#fbbc04]/40 bg-[#fbbc04]/10 p-3 text-[0.85rem] text-[#fde293]">
          <b>Drag the glowing yellow pet cube</b> onto another ⬡ gVisor node slab. The server pins the StatefulSet to that node and evicts <code>pet-0</code>; the pod-migration webhook checkpoints RAM to GCS and restores it on the target node.
        </div>
        <ActionButton action="teleporter.random" accent={ACCENT} disabled={migrating || t.gvisorNodes.length < 2} label="Random teleport">
          🎲 Random teleport
        </ActionButton>
        <div className="flex flex-wrap gap-2">
          <Stopwatch2 job={job} migrating={migrating} frozenMs={frozenMs} pet={pet} />
          {t.lastMigration && (
            <Stat
              label="last downtime"
              value={`${t.lastMigration.downtimeMs} ms`}
              tone={t.lastMigration.restored === 'verified' || t.lastMigration.restored === 'inferred' ? 'text-[#34a853]' : 'text-[#ea4335]'}
              sub={`${shortNodeName(t.lastMigration.from)} → ${shortNodeName(t.lastMigration.to)} · Restore${t.lastMigration.restored === 'verified' ? 'Verified' : t.lastMigration.restored === 'inferred' ? 'Inferred' : ` ${t.lastMigration.restored}`}`}
            />
          )}
        </div>
        {t.lastMigration && (t.lastMigration.restored === 'lost' || t.lastMigration.restored === 'failed') && (
          <div className="rounded-xl border border-red-400/40 bg-red-500/10 p-2 text-[0.85rem] text-red-200">Restore degraded to {t.lastMigration.restored}: cold start, in-memory ticks were lost.</div>
        )}
      </ControlGroup>

      <ControlGroup title="PodMigrationJob">
        {job ? <JobTimeline job={job} now={now} migrating={migrating} /> : <div className="text-[0.85rem] text-slate-400">No migration yet.</div>}
      </ControlGroup>
    </>
  );
}

function Stopwatch2({ job, migrating, frozenMs, pet }: { job?: WorldState['cabinets']['teleporter']['jobs'][number]; migrating: boolean; frozenMs: number; pet?: PetState }) {
  const now = useNow(100);
  const start = job?.snapshottingAt ?? job?.startedAt;
  const startMs = start ? Date.parse(start) : undefined;
  const restoredMs = pet?.restoredAt ? Date.parse(pet.restoredAt) : undefined;
  const completedMs = job?.completedAt ? Date.parse(job.completedAt) : undefined;
  const endMs = restoredMs && startMs && restoredMs > startMs ? restoredMs : completedMs;
  const ms = migrating && startMs ? now - startMs : endMs && startMs ? endMs - startMs : 0;
  return (
    <Stat
      label="downtime stopwatch"
      value={<span className={migrating ? 'text-[#fbbc04]' : 'text-[#34a853]'}>{stopwatch(migrating ? Math.max(ms, frozenMs) : ms)}</span>}
      sub={migrating ? (job?.phase ?? 'migrating') : job ? 'Succeeded' : 'idle'}
    />
  );
}

function JobTimeline({ job, now, migrating }: { job: WorldState['cabinets']['teleporter']['jobs'][number]; now: number; migrating: boolean }) {
  const effectivePhase = !migrating && job.phase === 'Restoring' ? 'Succeeded' : job.phase;
  const steps: [string, string | undefined][] = [
    ['Started', job.startedAt],
    ['Snapshotting', job.snapshottingAt],
    ['Evicting', job.evictingAt],
    ['Restoring', job.restoringAt],
    [effectivePhase === 'Failed' ? 'Failed' : 'Completed', job.completedAt ?? (!migrating ? new Date(now).toISOString() : undefined)],
  ];
  const t0 = Date.parse(job.startedAt);
  return (
    <div className="flex flex-col gap-1 font-mono text-[0.78rem]">
      <div className="flex justify-between text-slate-400">
        <span>{job.name}</span>
        <span className={effectivePhase === 'Succeeded' ? 'text-[#34a853]' : effectivePhase === 'Failed' ? 'text-[#ea4335]' : 'text-[#fbbc04]'}>{effectivePhase}</span>
      </div>
      {steps.map(([label, at], i) => {
        const done = !!at;
        const active = !done && steps[i - 1]?.[1] && ACTIVE_PHASES.includes(effectivePhase);
        return (
          <div key={label} className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${done ? 'bg-[#34a853]' : active ? 'bg-[#fbbc04] animate-blink' : 'bg-slate-600'}`} />
            <span className={done ? 'text-slate-100' : 'text-slate-500'}>{label}</span>
            <span className="ml-auto text-slate-400">{at ? `+${secs(Date.parse(at) - t0)}` : active ? `+${secs(now - t0)}` : ''}</span>
          </div>
        );
      })}
      {job.restoredReason && <div className="text-[0.72rem] text-slate-400">Restored: {job.restoredReason}</div>}
    </div>
  );
}

/** The pet's 2D bouncing ball, drawn from {type:"pet"} telemetry. */
function PetBall() {
  const ref = useRef<HTMLCanvasElement>(null);
  const bounds = useRef({ w: 0, h: 0 });
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const c = ref.current;
      const pet = useArcade.getState().pet;
      if (c) {
        const ctx = c.getContext('2d')!;
        const w = c.width;
        const h = c.height;
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = 'rgba(251,188,4,0.35)';
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, w - 2, h - 2);
        if (pet) {
          // The pet's box is implementation-defined (the real pet uses 0..1, the mock 100×60):
          // normalise by the largest coordinates seen so far.
          const b = bounds.current;
          b.w = Math.max(b.w, pet.ball.x, 1e-6);
          b.h = Math.max(b.h, pet.ball.y, 1e-6);
          const bx = (pet.ball.x / b.w) * w;
          const by = (pet.ball.y / b.h) * h;
          const g = ctx.createRadialGradient(bx, by, 1, bx, by, 12);
          g.addColorStop(0, '#fff');
          g.addColorStop(0.4, '#fbbc04');
          g.addColorStop(1, 'rgba(251,188,4,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(bx, by, 12, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} width={300} height={180} className="w-full rounded-xl bg-black/40" style={{ aspectRatio: '5/3' }} />;
}

// ---- HUD --------------------------------------------------------------------

function hud(world: WorldState) {
  const t = world.cabinets.teleporter;
  const now = Date.now();
  const nodes = world.nodes.filter((n) => n.gvisor || t.gvisorNodes.includes(n.name));
  return [
    {
      kind: 'table' as const,
      title: 'PodMigrationJobs',
      command: 'kubectl get podmigrationjobs -n arcade-teleporter',
      columns: ['NAME', 'PHASE', 'ORIGIN', 'RESTORED', 'AGE'],
      rows: t.jobs.slice(0, 5).map((j) => [j.name, j.phase, j.originNode ? shortNodeName(j.originNode) : '', j.restoredReason ?? '', ago(j.startedAt, now)]),
      highlight: (r: string[]) => (ACTIVE_PHASES.includes(r[1]) ? 'text-amber-300' : r[1] === 'Failed' ? 'text-red-300' : undefined),
    },
    podTable(world.pods.filter((p) => p.cabinet === 'teleporter'), now),
    nodeTable(nodes, now),
    {
      kind: 'yaml' as const,
      title: 'StatefulSet/pet (relevant fields)',
      command: 'kubectl get statefulset pet -n arcade-teleporter -o yaml',
      value: {
        apiVersion: 'apps/v1',
        kind: 'StatefulSet',
        metadata: { name: 'pet', namespace: 'arcade-teleporter', labels: { 'arcade.gke.io/cabinet': 'teleporter' } },
        spec: {
          replicas: 1,
          updateStrategy: { type: 'OnDelete' },
          template: {
            metadata: { labels: { 'pod-migration.gke.io/enabled': 'true' } },
            spec: { runtimeClassName: 'gvisor', nodeSelector: t.pet.node ? { 'kubernetes.io/hostname': t.pet.node } : {} },
          },
        },
      },
    },
    eventsSection(world, 'teleporter', now),
  ];
}

export const teleporter: CabinetModule = {
  id: 'teleporter',
  Scene,
  Controls,
  hud,
  hint: 'Drag the pet onto another gVisor node — its memory comes along.',
};
