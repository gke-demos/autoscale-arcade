import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { ago, durationShort } from '../lib/format';
import { ClusterScene } from '../scene/ClusterScene';
import type { IslandLayout, Layout } from '../scene/layout';
import type { Node, Pod, WorldState } from '../types';
import { ActionButton, Badge, ControlGroup, Stat, Stopwatch, eventsSection, podTable, useCabinetLayout, useNow } from './common';
import type { CabinetModule, CabinetProps, HudSection } from './types';

const ACCENT = '#fbbf24';
const COIN = '#facc15';
const MAX_COINS = 60;
const TARGET_AVG = 5;

function coinPods(world: WorldState): Pod[] {
  return world.pods.filter((p) => p.cabinet === 'lights' && p.workload === 'coin-worker');
}
const isDefaultPool = (n: Node) => n.pool === 'default-pool';

// ---- 3D ---------------------------------------------------------------------

/** Dim translucent plane just above an island + pulsing 💤 label. */
function Blackout({ island }: { island: IslandLayout }) {
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    if (mat.current) mat.current.opacity = 0.55 + 0.08 * Math.sin(clock.elapsedTime * 1.5);
  });
  const [cx, cz] = island.center;
  return (
    <group position={[cx, 0, cz]}>
      <mesh position={[0, 0.95, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={5}>
        <planeGeometry args={[island.w + 0.6, island.d + 0.6]} />
        <meshBasicMaterial ref={mat} color="#000000" transparent opacity={0.6} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <Html position={[0, 1.6, 0]} center zIndexRange={[25, 0]} style={{ pointerEvents: 'none' }}>
        <div className="animate-pulse whitespace-nowrap rounded-full border border-slate-500/50 bg-black/80 px-4 py-1.5 font-mono text-[1rem] font-bold text-slate-300 shadow-[0_0_24px_rgba(0,0,0,0.9)]">
          💤 ScaledToZero
        </div>
      </Html>
    </group>
  );
}

/** One warm point light per ready coin-worker pod ("lights on"). */
function PodLights({ layout }: { layout: Layout }) {
  const lit = [...layout.pods.values()].filter((pl) => pl.pod.workload === 'coin-worker' && pl.pod.ready && !pl.pod.deleting);
  return (
    <>
      {lit.map((pl) => (
        <pointLight key={`l-${pl.pod.uid}`} position={[pl.pos[0], pl.pos[1] + 0.9, pl.pos[2]]} color={ACCENT} intensity={7} distance={5} decay={2} />
      ))}
    </>
  );
}

/** A staggered stack of gold coins, one per queued coin (capped). */
function CoinQueue({ depth, position }: { depth: number; position: [number, number, number] }) {
  const group = useRef<THREE.Group>(null);
  const shown = Math.min(depth, MAX_COINS);
  const offsets = useMemo(() => Array.from({ length: MAX_COINS }, (_, i) => ({ dx: 0.06 * Math.sin(i * 1.7), dz: 0.06 * Math.cos(i * 2.3), rot: i * 0.37 })), []);
  useFrame(({ clock }) => {
    if (group.current) group.current.rotation.y = clock.elapsedTime * 0.25;
  });
  const h = 0.09;
  return (
    <group position={position}>
      {/* tray */}
      <mesh position={[0, -0.02, 0]} receiveShadow>
        <cylinderGeometry args={[1.0, 1.1, 0.08, 32]} />
        <meshStandardMaterial color="#1e2742" roughness={0.8} />
      </mesh>
      <group ref={group}>
        {Array.from({ length: shown }, (_, i) => (
          <mesh key={i} position={[offsets[i].dx, h / 2 + i * (h + 0.012), offsets[i].dz]} rotation={[0, offsets[i].rot, 0]} castShadow>
            <cylinderGeometry args={[0.55, 0.55, h, 24]} />
            <meshStandardMaterial color={COIN} emissive={COIN} emissiveIntensity={0.25} metalness={0.9} roughness={0.25} />
          </mesh>
        ))}
      </group>
      {shown > 0 && <pointLight position={[0, shown * (h + 0.012) + 0.6, 0]} color={COIN} intensity={3} distance={4} />}
      <Html position={[0, Math.max(0.6, shown * (h + 0.012) + 0.5), 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <div className={`whitespace-nowrap rounded-full border px-3 py-1 font-mono text-[0.8rem] ${depth ? 'border-amber-300/50 bg-black/75 text-amber-200' : 'border-slate-600/50 bg-black/60 text-slate-400'}`}>
          🪙 queue depth {depth}
          {depth > MAX_COINS && <span className="ml-1 text-slate-400">(showing {MAX_COINS})</span>}
        </div>
      </Html>
    </group>
  );
}

function Scene({ world }: CabinetProps) {
  const l = world.cabinets.lights;
  const layout = useCabinetLayout(world, 'lights', { extraNodes: isDefaultPool });
  const dark = l.hpa.scaledToZero;
  const coinPos: [number, number, number] = [layout.bounds.maxX + 2.0, 0, 0];
  return (
    <>
      <ClusterScene layout={layout} dim={dark} />
      {dark && layout.islands.map((isl) => <Blackout key={`bo-${isl.key}`} island={isl} />)}
      {!dark && <PodLights layout={layout} />}
      <CoinQueue depth={l.queueDepth} position={coinPos} />
    </>
  );
}

// ---- Controls -----------------------------------------------------------------

/** Derive "lights on since": hpa.lastScale when we are not at zero. */
function lightsOnSince(world: WorldState): string | undefined {
  const l = world.cabinets.lights;
  if (l.hpa.scaledToZero) return undefined;
  const pods = coinPods(world).filter((p) => !p.deleting);
  const firstPod = pods.map((p) => Date.parse(p.created)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b)[0];
  const scale = l.hpa.lastScale ? Date.parse(l.hpa.lastScale) : undefined;
  // lastScale may be a later scale-up; the oldest surviving pod bounds the moment we left zero.
  const t = [firstPod, scale].filter((x): x is number => x !== undefined && !Number.isNaN(x)).sort((a, b) => a - b)[0];
  return t !== undefined ? new Date(t).toISOString() : undefined;
}

function Controls({ world }: CabinetProps) {
  const l = world.cabinets.lights;
  const now = useNow(250);
  const pods = coinPods(world).filter((p) => !p.deleting);
  const lit = pods.filter((p) => p.ready).length;
  const since = lightsOnSince(world);
  return (
    <>
      <ControlGroup title="Coin slot">
        <div className="grid grid-cols-2 gap-2">
          <ActionButton action="lights.coin" body={{ count: 1 }} accent={ACCENT} label="Insert coin" className="text-[1.2rem]">
            🪙 Insert coin
          </ActionButton>
          <ActionButton action="lights.coin" body={{ count: 50 }} label="Slam ×50" className="text-[1.2rem]">
            💥 Slam ×50
          </ActionButton>
        </div>
        <div className="flex flex-wrap gap-2">
          <Stat label="queue depth" value={<span className={l.queueDepth ? 'text-amber-300' : 'text-slate-300'}>{l.queueDepth}</span>} sub={<span className="font-mono">arcade_queue_depth</span>} />
          <Stat label="processed" value={l.processed} tone="text-emerald-300" sub="coins drained" />
          <Stat label="metric value" value={l.hpa.metricValue ?? '—'} sub={`target avg ${TARGET_AVG} / pod`} />
        </div>
      </ControlGroup>

      <ControlGroup title="HorizontalPodAutoscaler · coin-worker">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={l.hpa.scaledToZero ? 'bg-red-500/25 text-red-200 ring-1 ring-red-400/50' : 'bg-emerald-500/25 text-emerald-200 ring-1 ring-emerald-400/50'}>
            {l.hpa.scaledToZero ? '💤 ScaledToZero=True' : '💡 lights on · ScaledToZero=False'}
          </Badge>
          <Badge tone={l.hpa.scalingActive ? 'bg-sky-500/20 text-sky-200' : 'bg-slate-700 text-slate-300'}>ScalingActive={l.hpa.scalingActive ? 'True' : 'False'}</Badge>
          <span className="font-mono text-[0.72rem] text-slate-400">last scale {l.hpa.lastScale ? `${ago(l.hpa.lastScale, now)} ago` : '—'}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Stat label="replicas" value={<span className={lit ? 'text-amber-200' : 'text-slate-300'}>{l.hpa.current}</span>} sub={`desired ${l.hpa.desired}`} />
          <Stat label="min / max" value={`${l.hpa.min} / ${l.hpa.max}`} sub="minReplicas 0 = scale to zero" />
          <Stopwatch startedAt={since} label="lights on for" />
        </div>
        {/* pods lit vs max bar meter */}
        <div className="flex flex-col gap-1">
          <div className="flex justify-between font-mono text-[0.7rem] text-slate-400">
            <span>pods lit</span>
            <span>
              <span className={lit ? 'text-amber-200' : ''}>{lit}</span>/{l.hpa.max}
              {pods.length > lit && <span className="ml-1 text-amber-300">(+{pods.length - lit} warming)</span>}
            </span>
          </div>
          <div className="flex h-5 gap-[3px] rounded-lg bg-black/40 p-[3px]">
            {Array.from({ length: Math.max(1, l.hpa.max) }, (_, i) => {
              const on = i < lit;
              const warming = !on && i < pods.length;
              return <div key={i} className={`flex-1 rounded-sm transition-colors ${on ? 'bg-amber-300 shadow-[0_0_8px_rgba(251,191,36,0.9)]' : warming ? 'bg-amber-500/30 animate-blink' : 'bg-slate-800'}`} />;
            })}
          </div>
        </div>
        <div className="font-mono text-[0.7rem] text-slate-400">
          metric <span className="text-slate-200">{l.metricName}</span>
        </div>
      </ControlGroup>
    </>
  );
}

// ---- Status bar ---------------------------------------------------------------

function Status({ world }: CabinetProps) {
  const l = world.cabinets.lights;
  const since = lightsOnSince(world);
  return (
    <>
      <Stat label="queue depth" value={<span className={l.queueDepth ? 'text-amber-300' : 'text-slate-300'}>{l.queueDepth}</span>} sub={l.hpa.scaledToZero ? '💤 scaled to zero' : `${l.hpa.current} worker${l.hpa.current === 1 ? '' : 's'} lit`} />
      <Stopwatch startedAt={since} label="lights on for" />
    </>
  );
}

// ---- HUD ----------------------------------------------------------------------

function hud(world: WorldState): HudSection[] {
  const l = world.cabinets.lights;
  const now = Date.now();
  const pods = coinPods(world);
  const hpaAge = world.events.find((e) => e.cabinet === 'lights' && e.object.startsWith('horizontalpodautoscaler'))?.ts;
  const metric = { type: 'External', external: { metric: { name: l.metricName }, target: { type: 'AverageValue', averageValue: String(TARGET_AVG) } } };
  return [
    {
      kind: 'table',
      title: 'HPA',
      command: 'kubectl get hpa coin-worker -n arcade-lights',
      columns: ['NAME', 'REFERENCE', 'TARGETS', 'MINPODS', 'MAXPODS', 'REPLICAS', 'AGE'],
      rows: [['coin-worker', 'Deployment/coin-worker', `${l.hpa.metricValue ?? '<unknown>'}/${TARGET_AVG} (avg)`, String(l.hpa.min), String(l.hpa.max), String(l.hpa.current), hpaAge ? ago(hpaAge, now) : '—']],
      highlight: (r) => (r[5] === '0' ? 'text-slate-400' : 'text-amber-200'),
    },
    {
      kind: 'yaml',
      title: 'HorizontalPodAutoscaler/coin-worker',
      command: 'kubectl get hpa coin-worker -n arcade-lights -o yaml',
      value: {
        apiVersion: 'autoscaling/v2',
        kind: 'HorizontalPodAutoscaler',
        metadata: { name: 'coin-worker', namespace: 'arcade-lights', labels: { 'arcade.gke.io/cabinet': 'lights' } },
        spec: {
          scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'coin-worker' },
          minReplicas: l.hpa.min,
          maxReplicas: l.hpa.max,
          metrics: [metric],
          behavior: { scaleDown: { stabilizationWindowSeconds: 60 } },
        },
        status: {
          currentReplicas: l.hpa.current,
          desiredReplicas: l.hpa.desired,
          lastScaleTime: l.hpa.lastScale,
          currentMetrics: l.hpa.metricValue !== undefined ? [{ type: 'External', external: { metric: { name: l.metricName }, current: { averageValue: String(l.hpa.metricValue) } } }] : [],
          conditions: [
            { type: 'ScaledToZero', status: l.hpa.scaledToZero ? 'True' : 'False' },
            { type: 'ScalingActive', status: l.hpa.scalingActive ? 'True' : 'False' },
          ],
        },
      },
    },
    {
      kind: 'kv',
      title: 'AutoscalingMetric/coin-queue',
      items: [
        ['apiVersion', 'autoscaling.gke.io/v1beta1'],
        ['source', 'pod · arcade-server /metrics'],
        ['metric', 'arcade_queue_depth'],
        ['external name', l.metricName],
        ['value', String(l.hpa.metricValue ?? '—'), l.queueDepth ? 'text-amber-200' : undefined],
        ['queue / processed', `${l.queueDepth} / ${l.processed}`],
        ['scaledToZero', l.hpa.scaledToZero ? 'True' : 'False', l.hpa.scaledToZero ? 'text-red-300' : 'text-emerald-300'],
        ['lastScale', l.hpa.lastScale ? `${durationShort(Math.max(0, now - Date.parse(l.hpa.lastScale)))} ago` : '—'],
      ],
    },
    podTable(pods, now),
    eventsSection(world, 'lights', now),
  ];
}

export const lights: CabinetModule = {
  id: 'lights',
  Scene,
  Controls,
  hud,
  Status,
  hint: 'Insert coins to wake the workers from zero — the HPA scales 0 → N and back.',
};
