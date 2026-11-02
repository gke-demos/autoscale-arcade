import { Html } from '@react-three/drei';
import { useEffect, useMemo, useRef } from 'react';
import { secs, usd } from '../lib/format';
import { ClusterScene } from '../scene/ClusterScene';
import { SLAB, defaultGroupLabel } from '../scene/layout';
import { useArcade } from '../store';
import type { AbsorberPreset, Node, Pod, WorldState } from '../types';
import { ActionButton, Badge, ControlGroup, CostMeter, MissionCard, Stat, Stopwatch, eventsSection, nodeTable, podTable, useCabinetLayout, useNow } from './common';
import type { CabinetModule, CabinetProps, HudSection } from './types';

const ACCENT = '#4285f4';
const BURST = 12;
const CC = 'arcade-absorber';

const PRESETS: { id: AbsorberPreset; label: string; sub: string }[] = [
  { id: 'none', label: 'None', sub: 'no buffer' },
  { id: 'active4', label: 'Active 4', sub: 'active-capacity' },
  { id: 'active8', label: 'Active 8', sub: 'active-capacity' },
  { id: 'standby8', label: 'Standby 8 ❄', sub: 'standby-capacity' },
];
const PRESET_LABEL: Record<AbsorberPreset, string> = { none: 'no', active4: 'active 4', active8: 'active 8', standby8: 'standby 8' };

// ---- data helpers -----------------------------------------------------------

function burstPods(world: WorldState): Pod[] {
  return world.pods.filter((p) => p.cabinet === 'absorber' && p.workload === 'burst-worker' && !p.buffer);
}
function ghostPods(world: WorldState): Pod[] {
  return world.pods.filter((p) => p.cabinet === 'absorber' && p.buffer);
}
function bufferStrategy(nodes: Node[]): 'active' | 'standby' | undefined {
  return nodes.find((n) => n.buffer)?.buffer;
}
/** Per-pod created → Ready latency (ms) for burst-worker pods, live from pod timestamps. */
function liveReadyMs(world: WorldState, nowMs: number): { name: string; ms: number; ready: boolean }[] {
  return burstPods(world)
    .filter((p) => !p.deleting)
    .map((p) => ({ name: p.name, ms: (p.readyAt ? Date.parse(p.readyAt) : nowMs) - Date.parse(p.created), ready: p.ready }))
    .sort((a, b) => a.ms - b.ms);
}

// ---- 3D ---------------------------------------------------------------------

function Scene({ world }: CabinetProps) {
  const a = world.cabinets.absorber;
  const layout = useCabinetLayout(world, 'absorber', {
    order: [`cc:${CC}`],
    groupLabel: (key, nodes) => {
      if (key !== `cc:${CC}`) return defaultGroupLabel(key, nodes);
      const strategy = bufferStrategy(nodes) ?? (a.preset.startsWith('standby') ? 'standby' : a.preset === 'none' ? undefined : 'active');
      const tag = strategy === 'standby' ? 'standby ❄' : strategy === 'active' ? 'active' : 'no buffer';
      return { label: CC, sublabel: `CapacityBuffer · ${tag} · ${[...new Set(nodes.map((n) => n.pool))].join(', ')}` };
    },
  });
  // headroom per buffer node: ghosts remaining / (ghosts + burst pods that snapped in)
  const headroom = useMemo(() => {
    const m = new Map<string, { ghosts: number; total: number }>();
    for (const p of world.pods) {
      if (p.cabinet !== 'absorber' || !p.node || p.deleting) continue;
      const e = m.get(p.node) ?? { ghosts: 0, total: 0 };
      if (p.buffer) e.ghosts++;
      if (p.buffer || p.workload === 'burst-worker') e.total++;
      m.set(p.node, e);
    }
    return m;
  }, [world.pods]);

  return (
    <>
      <ClusterScene layout={layout} />
      {[...layout.nodes.values()]
        .filter((nl) => nl.node.computeClass === CC && !nl.node.creating && (nl.node.buffer || (headroom.get(nl.node.name)?.ghosts ?? 0) > 0))
        .map((nl) => {
          const h = headroom.get(nl.node.name) ?? { ghosts: 0, total: 0 };
          const strategy = nl.node.buffer;
          return (
            <Html key={`hr-${nl.node.name}`} position={[nl.pos[0], SLAB.h / 2 + 0.05, nl.pos[2] - SLAB.d / 2 + 0.3]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
              <div className={`whitespace-nowrap rounded-md border px-1.5 py-0.5 font-mono text-[0.62rem] ${nl.node.suspended ? 'border-sky-300/40 bg-sky-950/70 text-sky-200' : h.ghosts ? 'border-cyan-300/40 bg-black/60 text-cyan-200' : 'border-slate-500/40 bg-black/60 text-slate-300'}`}>
                {nl.node.suspended ? '❄ suspended · ' : ''}
                headroom {h.ghosts}/{h.total}
                {strategy && <span className="ml-1 text-slate-400">{strategy}</span>}
              </div>
            </Html>
          );
        })}
    </>
  );
}

// ---- Controls -----------------------------------------------------------------

function Controls({ world }: CabinetProps) {
  const a = world.cabinets.absorber;
  const now = useNow(100);
  const live = liveReadyMs(world, now);
  const bursting = !!a.burst.startedAt && !a.burst.allReadyAt && a.burst.desired > 0;
  const finalMs = a.burst.startedAt && a.burst.allReadyAt ? Date.parse(a.burst.allReadyAt) - Date.parse(a.burst.startedAt) : undefined;
  const score = finalMs !== undefined ? +(finalMs / 1000).toFixed(1) : undefined;

  // leaderboard prompt when allReadyAt flips from undefined → value
  const setPrompt = useArcade((s) => s.setLeaderboardPrompt);
  const prevAllReady = useRef<string | undefined>(a.burst.allReadyAt);
  useEffect(() => {
    if (!prevAllReady.current && a.burst.allReadyAt && a.burst.startedAt) {
      const s = +((Date.parse(a.burst.allReadyAt) - Date.parse(a.burst.startedAt)) / 1000).toFixed(1);
      setPrompt({ cabinet: 'absorber', score: s, unit: 's', label: `${a.burst.desired} pods Ready in ${s}s with ${PRESET_LABEL[a.preset]} buffer (${usd(a.headroomCostPerHour, 2)}/h headroom)` });
    }
    prevAllReady.current = a.burst.allReadyAt;
  }, [a.burst.allReadyAt, a.burst.startedAt, a.burst.desired, a.preset, a.headroomCostPerHour, setPrompt]);

  const bars = a.burst.perPodReadyMs.length ? [...a.burst.perPodReadyMs].sort((x, y) => x - y).map((ms, i) => ({ name: `#${i + 1}`, ms, ready: true })) : live;
  const maxMs = Math.max(1000, ...bars.map((b) => b.ms));
  const ghosts = ghostPods(world).length;
  const hasBuffer = a.preset !== 'none';
  const burstDone = a.burst.desired > 0 && a.burst.ready >= a.burst.desired;

  return (
    <>
      <MissionCard
        accent={ACCENT}
        goal="Pre-warm ghost capacity with a CapacityBuffer so a sudden +12 pod traffic spike snaps into Ready in seconds instead of waiting ~50s for cold node scale-up."
        win="Fastest burst → all 12 pods Ready time (s) vs. headroom $/h"
        steps={[
          {
            label: 'Pick a CapacityBuffer preset (Active 4/8 or Standby 8)',
            detail: 'Reserves warm ghost pod slots (translucent blue wireframes) on the cluster.',
            done: hasBuffer,
            active: !hasBuffer && a.burst.desired === 0,
          },
          {
            label: `Fire burst +${BURST}`,
            detail: 'Launches 12 burst-worker pods that immediately claim the ghost headroom.',
            done: a.burst.desired > 0,
            active: hasBuffer && a.burst.desired === 0,
          },
          {
            label: 'All burst pods reach Ready=True',
            detail: 'Compare your stopwatch score with a buffer (~3s) vs. None (~50s)!',
            done: burstDone,
            active: bursting,
          },
        ]}
      />

      <ControlGroup title="1 · Pick a CapacityBuffer preset">
        <div className="grid grid-cols-2 gap-2">
          {PRESETS.map((p) => (
            <ActionButton key={p.id} action="absorber.preset" body={{ preset: p.id }} label={`Buffer ${p.label}`} accent={a.preset === p.id ? ACCENT : undefined} className="flex-col gap-0! leading-tight">
              <span>{p.label}</span>
              <span className={`text-[0.65rem] font-normal ${a.preset === p.id ? 'text-[#131314]/80' : 'text-slate-400'}`}>{p.sub}</span>
            </ActionButton>
          ))}
        </div>
        <div className="overflow-x-auto rounded-xl border border-line/80 bg-black/30">
          <table className="w-full font-mono text-[0.72rem]">
            <thead className="text-slate-400">
              <tr>
                {['buffer', 'strategy', 'replicas', 'status', 'Provisioning', 'LimitedByQuotas'].map((h) => (
                  <th key={h} className="px-2 py-1 text-left font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {a.buffers.map((b) => (
                <tr key={b.name} className={b.replicas ? 'text-slate-100' : 'text-slate-500'}>
                  <td className="px-2 py-1">{b.name}</td>
                  <td className="px-2 py-1">{b.strategy === 'standby' ? 'standby ❄' : b.strategy}</td>
                  <td className="px-2 py-1">{b.replicas}</td>
                  <td className="px-2 py-1">{b.statusReplicas}</td>
                  <td className="px-2 py-1">{b.replicas ? <Badge tone={b.ready ? 'bg-[#34a853]/25 text-[#81c995]' : 'bg-[#fbbc04]/25 text-[#fde293]'}>{b.ready ? 'True' : 'False'}</Badge> : '—'}</td>
                  <td className="px-2 py-1">{b.limitedByQuota ? <Badge tone="bg-[#ea4335]/25 text-red-200">True</Badge> : 'False'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap gap-2">
          <CostMeter perHour={a.headroomCostPerHour} label="headroom $/h" sub={ghosts ? `${ghosts} ghost pods reserved` : 'nothing reserved'} />
        </div>
      </ControlGroup>

      <ControlGroup title="2 · Fire the burst">
        <ActionButton action="absorber.burst" body={{ delta: BURST }} accent={ACCENT} label="Fire burst" className="text-[1.3rem]" disabled={bursting}>
          🔥 Fire burst +{BURST}
        </ActionButton>
        <div className="flex flex-wrap gap-2">
          <Stopwatch startedAt={a.burst.startedAt} stoppedAt={a.burst.allReadyAt} label="burst → all Ready" />
          <Stat label="burst pods" value={<span className={a.burst.desired && a.burst.ready >= a.burst.desired ? 'text-lime-300' : 'text-amber-300'}>{a.burst.ready}/{a.burst.desired}</span>} sub="ready / desired" />
          <Stat
            label="score"
            value={score !== undefined ? <span className="text-emerald-300">{score.toFixed(1)}s</span> : bursting ? <span className="text-amber-300 animate-blink">…</span> : '—'}
            sub={score !== undefined ? `vs ${usd(a.headroomCostPerHour, 2)}/h headroom · ${PRESET_LABEL[a.preset]}` : 'time-to-all-ready vs $/h'}
          />
        </div>
        <ActionButton action="absorber.reset" label="Reset burst" className="btn-sm self-start">
          Reset burst → 0
        </ActionButton>
      </ControlGroup>

      <ControlGroup title={`Per-pod created → Ready${a.burst.perPodReadyMs.length ? '' : ' (live)'}`}>
        {bars.length ? (
          <div className="flex flex-col gap-[3px] font-mono text-[0.7rem]">
            {bars.map((b, i) => (
              <div key={`${b.name}-${i}`} className="flex items-center gap-2">
                <span className="w-[4.5rem] truncate text-slate-400">{b.name.replace(/^burst-worker-/, '…')}</span>
                <div className="relative h-3 flex-1 overflow-hidden rounded bg-black/40">
                  <div className={`h-full rounded ${b.ready ? 'bg-emerald-400/80' : 'bg-amber-400/70 animate-pulse'}`} style={{ width: `${Math.min(100, (b.ms / maxMs) * 100)}%` }} />
                </div>
                <span className={`w-[3.2rem] text-right ${b.ready ? 'text-slate-100' : 'text-amber-300'}`}>{secs(b.ms)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[0.85rem] text-slate-400">No burst yet — ghosts show the reserved headroom; fire a burst and watch pods snap into them.</div>
        )}
      </ControlGroup>
    </>
  );
}

// ---- Status bar ---------------------------------------------------------------

function Status({ world }: CabinetProps) {
  const a = world.cabinets.absorber;
  return (
    <>
      <Stopwatch startedAt={a.burst.startedAt} stoppedAt={a.burst.allReadyAt} label="burst → all Ready" />
      <CostMeter perHour={a.headroomCostPerHour} label="headroom" sub={`${PRESET_LABEL[a.preset]} buffer`} />
    </>
  );
}

// ---- HUD ----------------------------------------------------------------------

function hud(world: WorldState): HudSection[] {
  const a = world.cabinets.absorber;
  const now = Date.now();
  const pods = world.pods.filter((p) => p.cabinet === 'absorber');
  const hosts = new Set(pods.map((p) => p.node));
  const nodes = world.nodes.filter((n) => n.computeClass === CC || hosts.has(n.name));
  const activeBuf = a.buffers.find((b) => b.strategy === 'active');
  const standbyBuf = a.buffers.find((b) => b.strategy === 'standby');
  const shown = a.preset === 'standby8' ? standbyBuf : activeBuf;
  const bufferYaml = (name: string, strategy: 'active' | 'standby', replicas: number, b?: AbsorberStateBuffer) => ({
    apiVersion: 'autoscaling.x-k8s.io/v1alpha1',
    kind: 'CapacityBuffer',
    metadata: { name, namespace: 'arcade-absorber', labels: { 'arcade.gke.io/cabinet': 'absorber' } },
    spec: {
      provisioningStrategy: strategy === 'active' ? 'buffer.x-k8s.io/active-capacity' : 'buffer.gke.io/standby-capacity',
      podTemplateRef: { name: 'burst-unit' },
      replicas,
    },
    status: b
      ? {
          replicas: b.statusReplicas,
          podTemplateRef: { name: 'burst-unit' },
          conditions: [
            { type: 'ReadyForProvisioning', status: 'True' },
            { type: 'Provisioning', status: b.ready ? 'True' : 'False' },
            { type: 'LimitedByQuotas', status: b.limitedByQuota ? 'True' : 'False' },
          ],
        }
      : undefined,
  });
  return [
    {
      kind: 'table',
      title: 'CapacityBuffers',
      command: 'kubectl get capacitybuffers -n arcade-absorber',
      columns: ['NAME', 'STRATEGY', 'REPLICAS', 'STATUS-REPLICAS', 'PROVISIONING', 'LIMITEDBYQUOTAS'],
      rows: a.buffers.map((b) => [b.name, b.strategy === 'active' ? 'active-capacity' : 'standby-capacity', String(b.replicas), String(b.statusReplicas), b.replicas ? (b.ready ? 'True' : 'False') : '', b.limitedByQuota ? 'True' : 'False']),
      highlight: (r) => (r[5] === 'True' ? 'text-red-300' : r[4] === 'False' ? 'text-amber-300' : r[2] !== '0' ? 'text-cyan-200' : undefined),
    },
    {
      kind: 'yaml',
      title: `CapacityBuffer/${shown?.name ?? 'absorber-active'}`,
      command: `kubectl get capacitybuffer ${shown?.name ?? 'absorber-active'} -n arcade-absorber -o yaml`,
      value: shown ? bufferYaml(shown.name, shown.strategy, shown.replicas, shown) : bufferYaml('absorber-active', 'active', 0),
    },
    {
      kind: 'kv',
      title: 'Burst',
      items: [
        ['deployment/burst-worker', `${a.burst.ready}/${a.burst.desired} ready`, a.burst.desired && a.burst.ready >= a.burst.desired ? 'text-lime-300' : undefined],
        ['preset', a.preset],
        ['headroom $/h', usd(a.headroomCostPerHour, 3)],
        ['burst → all Ready', a.burst.startedAt && a.burst.allReadyAt ? secs(Date.parse(a.burst.allReadyAt) - Date.parse(a.burst.startedAt)) : a.burst.startedAt ? 'running…' : '—'],
        ['perPodReadyMs', a.burst.perPodReadyMs.length ? [...a.burst.perPodReadyMs].sort((x, y) => x - y).map((m) => secs(m)).join(' ') : '—'],
      ],
    },
    podTable(pods, now),
    nodeTable(nodes, now),
    eventsSection(world, 'absorber', now),
  ];
}

type AbsorberStateBuffer = WorldState['cabinets']['absorber']['buffers'][number];

export const absorber: CabinetModule = {
  id: 'absorber',
  Scene,
  Controls,
  hud,
  Status,
  hint: 'Pick a buffer preset and fire a burst — pods snap into ghost headroom instead of waiting for nodes.',
};
