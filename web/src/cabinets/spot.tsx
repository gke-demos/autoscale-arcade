import { useEffect, useMemo, useRef, useState } from 'react';
import { ago } from '../lib/format';
import { ClusterScene } from '../scene/ClusterScene';
import { useArcade } from '../store';
import type { Node, Pod, WorldState } from '../types';
import { ActionButton, Badge, ControlGroup, CostMeter, Stat, eventsSection, shortNodeName, useCabinetLayout } from './common';
import type { CabinetModule, CabinetProps, HudSection } from './types';

const ACCENT = '#22d3ee';
const FALLBACK_COLOR = '#fb923c';
const STOCKOUT_COLOR = '#ef4444';
const PRESETS = [0, 20, 50, 80, 100];

// ---- data helpers ---------------------------------------------------------

function checkoutPods(world: WorldState): Pod[] {
  return world.pods.filter((p) => p.cabinet === 'spot');
}
function isSpotNode(n: Node) {
  return n.computeClass === 'arcade-spot';
}
function spotCabinetNodes(world: WorldState): Node[] {
  const hosts = new Set(checkoutPods(world).map((p) => p.node));
  return world.nodes.filter((n) => isSpotNode(n) || hosts.has(n.name));
}
/** Spot nodes ranked by how many checkout pods they host (most first). */
function preemptCandidates(world: WorldState): { node: Node; pods: number }[] {
  const pods = checkoutPods(world);
  return spotCabinetNodes(world)
    .filter((n) => n.spot && n.ready && !n.creating && !n.deleting)
    .map((node) => ({ node, pods: pods.filter((p) => p.node === node.name && !p.deleting).length }))
    .sort((a, b) => b.pods - a.pods || a.node.name.localeCompare(b.node.name));
}
function groupKey(n: Node) {
  return `${n.spot ? 'spot' : 'od'}:${n.pool}`;
}

// ---- 3D ---------------------------------------------------------------------

function Scene({ world }: CabinetProps) {
  const order = useMemo(() => {
    const keys = [...new Set(spotCabinetNodes(world).map(groupKey))];
    return [...keys.filter((k) => k.startsWith('spot:')).sort(), ...keys.filter((k) => k.startsWith('od:')).sort()];
  }, [world]);
  const layout = useCabinetLayout(world, 'spot', {
    extraNodes: isSpotNode,
    groupKey,
    groupLabel: (key, nodes) => {
      const spot = key.startsWith('spot:');
      const pool = key.slice(key.indexOf(':') + 1);
      const mt = [...new Set(nodes.map((n) => n.machineType))].join(', ');
      return { label: spot ? `⚡ Spot · ${pool}` : `On-demand · ${pool}`, sublabel: `${mt}${spot ? ' · preemptible' : ' · fallback target'}` };
    },
    order,
  });
  return <ClusterScene layout={layout} />;
}

// ---- Controls -----------------------------------------------------------------

function Controls({ world }: CabinetProps) {
  const s = world.cabinets.spot;
  const act = useArcade((st) => st.act);
  const busy = useArcade((st) => st.busy['spot.ratio']);

  // Ratio dial: local value while dragging, synced to spotRatio otherwise; commit on release.
  const [ratio, setRatio] = useState(s.spotRatio);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setRatio(s.spotRatio);
  }, [s.spotRatio]);
  const commit = (v: number) => {
    dragging.current = false;
    if (v !== s.spotRatio) void act('spot.ratio', { spotRatio: v }, { label: `spotRatio → ${v}%` });
  };

  const candidates = preemptCandidates(world);
  const best = candidates[0];
  const [pickNode, setPickNode] = useState(false);
  const savings = s.costPerHour.allOnDemand > 0 ? Math.round((1 - s.costPerHour.current / s.costPerHour.allOnDemand) * 100) : 0;
  const total = s.counts.spot + s.counts.onDemand + s.counts.fallback;
  const realised = total ? Math.round((s.counts.spot / total) * 100) : 0;

  return (
    <>
      <ControlGroup title="WorkloadClass/checkout · spotRatio">
        <div className="flex items-end justify-between">
          <div className="font-mono text-[2.6rem] font-black leading-none" style={{ color: ACCENT }}>
            {ratio}
            <span className="text-[1.4rem]">%</span>
            <span className="ml-2 text-[1rem] font-bold text-slate-400">Spot</span>
          </div>
          <div className="font-mono text-[0.8rem] text-slate-400">
            realised <span className={realised >= s.spotRatio ? 'text-lime-300' : 'text-amber-300'}>{realised}%</span> · action <span className="text-slate-100">{s.action}</span>
          </div>
        </div>
        <input
          type="range"
          className="slider"
          min={0}
          max={100}
          step={5}
          value={ratio}
          disabled={busy}
          aria-label="spot ratio percent"
          style={{ '--pct': `${ratio}%`, '--slider-accent': ACCENT } as React.CSSProperties}
          onPointerDown={() => (dragging.current = true)}
          onChange={(e) => setRatio(Number(e.target.value))}
          onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
          onPointerCancel={(e) => commit(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
          onBlur={(e) => dragging.current && commit(Number(e.target.value))}
        />
        <div className="grid grid-cols-5 gap-2">
          {PRESETS.map((n) => (
            <ActionButton key={n} action="spot.ratio" body={{ spotRatio: n }} label={`spotRatio → ${n}%`} accent={s.spotRatio === n ? ACCENT : undefined} className="font-mono px-2" onDone={() => setRatio(n)}>
              {n}%
            </ActionButton>
          ))}
        </div>
        <div className="text-[0.78rem] text-slate-400">
          Guardrail: minSpotRatio <span className="text-slate-100">{s.guardrail.minSpotRatio}</span> · maxFallbackRatio <span className="text-slate-100">{s.guardrail.maxFallbackRatio}</span>
          {parseInt(s.guardrail.minSpotRatio, 10) > s.spotRatio && <span className="ml-2 text-amber-300">⚠ below guardrail minimum</span>}
        </div>
      </ControlGroup>

      <ControlGroup title="Deployment/checkout replicas">
        <div className="flex items-center gap-2">
          <ActionButton action="spot.scale" body={{ replicas: Math.max(0, s.replicas - 1) }} label="checkout −1" disabled={s.replicas <= 0} className="font-mono">
            −
          </ActionButton>
          <Stat label="replicas" value={s.replicas} sub={`${s.counts.pending} pending`} />
          <ActionButton action="spot.scale" body={{ replicas: Math.min(30, s.replicas + 1) }} label="checkout +1" disabled={s.replicas >= 30} className="font-mono">
            +
          </ActionButton>
        </div>
      </ControlGroup>

      <ControlGroup title="Chaos">
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <ActionButton
              action="spot.preempt"
              body={{ node: best?.node.name ?? '' }}
              disabled={!best}
              accent="#facc15"
              label={best ? `Preempt ${shortNodeName(best.node.name)}` : 'Preempt'}
              className="flex-1"
              confirm={best ? `Simulate a maintenance event on ${shortNodeName(best.node.name)} (${best.pods} checkout pods)?` : undefined}
            >
              ⚡ Preempt a Spot node
            </ActionButton>
            <button className={`btn ${pickNode ? 'btn-accent' : ''}`} style={pickNode ? ({ '--btn-accent': '#facc15' } as React.CSSProperties) : undefined} onClick={() => setPickNode((v) => !v)} disabled={candidates.length < 2} aria-label="choose which Spot node to preempt">
              ⋯
            </button>
          </div>
          {best ? (
            <div className="text-[0.78rem] text-slate-400">
              Target: <span className="text-slate-100">{shortNodeName(best.node.name)}</span> ({best.pods} checkout pod{best.pods === 1 ? '' : 's'}) — compute.instances.simulateMaintenanceEvent, a real Spot preemption.
            </div>
          ) : (
            <div className="text-[0.78rem] text-amber-300">No ready Spot nodes to preempt{s.stockout ? ' (stockout engaged)' : ''}.</div>
          )}
          {pickNode && (
            <div className="grid grid-cols-2 gap-2">
              {candidates.map(({ node, pods }) => (
                <ActionButton key={node.name} action="spot.preempt" body={{ node: node.name }} label={`Preempt ${shortNodeName(node.name)}`} className="font-mono text-[0.85rem]" onDone={() => setPickNode(false)}>
                  {shortNodeName(node.name)} · {pods} pod{pods === 1 ? '' : 's'}
                </ActionButton>
              ))}
            </div>
          )}
          <ActionButton action="spot.stockout" body={{ enabled: !s.stockout }} accent={s.stockout ? STOCKOUT_COLOR : undefined} label={s.stockout ? 'Capacity returns' : 'Stockout'}>
            {s.stockout ? '🟢 Capacity returns' : '🛑 Stockout'}
          </ActionButton>
          <div className="text-[0.78rem] text-slate-400">
            {s.stockout ? (
              <>
                <span className="text-red-300">Spot capacity held at 0.</span> Spot nodes drain; checkout pods fall back to on-demand (InFallback=True). Disengage to let the {s.policy.reversion} reversion evict fallback pods back onto Spot, oldest first.
              </>
            ) : (
              <>Stockout drains the Spot nodes and holds Spot capacity at 0 so pods fall back to on-demand.</>
            )}
          </div>
        </div>
      </ControlGroup>

      <ControlGroup title="Placement">
        <div className="flex flex-wrap gap-2">
          <Stat label="spot" value={s.counts.spot} tone="text-cyan-300" />
          <Stat label="on-demand" value={s.counts.onDemand} tone="text-sky-200" />
          <Stat label="fallback" value={s.counts.fallback} tone={s.counts.fallback ? 'text-orange-300' : 'text-slate-500'} sub={s.counts.fallback ? <span style={{ color: FALLBACK_COLOR }}>spot-targeted, on on-demand</span> : undefined} />
          <Stat label="pending" value={s.counts.pending} tone={s.counts.pending ? 'text-amber-300' : 'text-slate-500'} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[0.8rem]">
          <Badge tone={s.inFallback ? 'bg-orange-500/30 text-orange-200' : 'bg-slate-700 text-slate-300'}>InFallback={s.inFallback ? 'True' : 'False'}</Badge>
          <Badge tone={s.validated ? 'bg-lime-500/25 text-lime-200' : 'bg-red-500/30 text-red-200'}>Validated={s.validated ? 'True' : 'False'}</Badge>
          <Badge tone={s.stockout ? 'bg-red-500/30 text-red-200' : 'bg-slate-700 text-slate-300'}>stockout {s.stockout ? 'ON' : 'off'}</Badge>
          <Badge>
            {s.policy.name} · reversion {s.policy.reversion}
          </Badge>
        </div>
      </ControlGroup>

      <ControlGroup title="Cost">
        <div className="flex flex-wrap gap-2">
          <CostMeter perHour={s.costPerHour.current} label="current $/h" sub={`${savings}% below all on-demand`} />
          <Stat label="all on-demand" value={<span className="text-slate-300">${s.costPerHour.allOnDemand.toFixed(3)}/h</span>} sub="same nodes, list price" />
          <Stat label="saving" value={<span className={savings > 0 ? 'text-emerald-300' : 'text-slate-400'}>{savings}%</span>} sub={`spot ≈ 35% of list`} />
        </div>
      </ControlGroup>
    </>
  );
}

// ---- Status (bottom bar) ----------------------------------------------------

function Status({ world }: CabinetProps) {
  const s = world.cabinets.spot;
  const savings = s.costPerHour.allOnDemand > 0 ? Math.round((1 - s.costPerHour.current / s.costPerHour.allOnDemand) * 100) : 0;
  return (
    <>
      <CostMeter perHour={s.costPerHour.current} label="checkout $/h" sub={`−${savings}% vs on-demand`} />
      <Stat label="all on-demand" value={<span className="text-slate-400">${s.costPerHour.allOnDemand.toFixed(3)}/h</span>} sub="comparison" />
    </>
  );
}

// ---- HUD --------------------------------------------------------------------

function hud(world: WorldState): HudSection[] {
  const s = world.cabinets.spot;
  const now = Date.now();
  const pods = checkoutPods(world);
  const nodes = spotCabinetNodes(world);

  const wc: HudSection = {
    kind: 'table',
    title: 'WorkloadClass',
    command: 'kubectl get workloadclass checkout -n arcade-spot',
    columns: ['NAME', 'CAPACITY', 'SPOTRATIO', 'PROFILE', 'VALIDATED'],
    rows: [['checkout', 'Spot', `${s.spotRatio}%`, 'arcade-spot', s.validated ? 'True' : 'False']],
    highlight: (r) => (r[4] === 'False' ? 'text-red-300' : undefined),
  };

  const yaml: HudSection = {
    kind: 'yaml',
    title: 'WorkloadClass/checkout',
    command: 'kubectl get workloadclass checkout -n arcade-spot -o yaml',
    value: {
      apiVersion: 'workload.gke.io/v1alpha1',
      kind: 'WorkloadClass',
      metadata: { name: 'checkout', namespace: 'arcade-spot', labels: { 'arcade.gke.io/cabinet': 'spot' } },
      spec: {
        capacityStrategy: { type: 'Spot', spotRatio: `${s.spotRatio}%`, action: s.action },
        infrastructureProfileRef: { kind: 'GKESpotPlacementPolicy', name: 'arcade-spot' },
        disruptionPolicy: { maxNonDisruptionDurationDays: 7 },
      },
      status: {
        conditions: [
          { type: 'Validated', status: s.validated ? 'True' : 'False' },
          { type: 'InFallback', status: s.inFallback ? 'True' : 'False' },
        ],
      },
    },
  };

  const policy: HudSection = {
    kind: 'kv',
    title: 'GKESpotPlacementPolicy',
    items: [
      ['name', s.policy.name],
      ['customComputeClass', 'arcade-spot'],
      ['reversion.action', s.policy.reversion, s.policy.reversion === 'Active' ? 'text-lime-300' : undefined],
      ['guardrail.minSpotRatio', s.guardrail.minSpotRatio],
      ['guardrail.maxFallbackRatio', s.guardrail.maxFallbackRatio],
      ['stockout lever', s.stockout ? 'engaged' : 'off', s.stockout ? 'text-red-300' : undefined],
    ],
  };

  const podsTable: HudSection = {
    kind: 'table',
    title: 'Pods',
    command: 'kubectl get pods -n arcade-spot -o wide -L workload.gke.io/placement',
    columns: ['NAME', 'READY', 'STATUS', 'AGE', 'NODE', 'PLACEMENT', 'FALLBACK'],
    rows: pods.map((p) => [
      p.name,
      p.ready ? '1/1' : '0/1',
      p.deleting ? 'Terminating' : p.phase === 'Pending' ? (p.pendingReason ?? 'Pending') : p.phase,
      ago(p.created, now),
      p.node ? shortNodeName(p.node) : '<none>',
      p.placement ?? '',
      p.fallback ? 'true' : '',
    ]),
    highlight: (r) => (r[2] === 'Terminating' ? 'text-red-300' : r[6] === 'true' ? 'text-orange-300' : r[1] === '0/1' ? 'text-amber-300' : undefined),
  };

  const nodesTable: HudSection = {
    kind: 'table',
    title: 'Nodes',
    command: 'kubectl get nodes -l cloud.google.com/compute-class=arcade-spot -L cloud.google.com/gke-spot',
    columns: ['NAME', 'STATUS', 'AGE', 'MACHINE', 'GKE-SPOT', 'PODS'],
    rows: nodes.map((n) => [
      shortNodeName(n.name),
      n.creating ? 'Creating' : n.deleting ? 'Draining' : n.unschedulable ? 'Ready,SchedulingDisabled' : n.ready ? 'Ready' : 'NotReady',
      n.creating ? '—' : ago(n.created, now),
      n.machineType,
      n.spot ? 'true' : '',
      String(pods.filter((p) => p.node === n.name && !p.deleting).length),
    ]),
    highlight: (r) => (r[1] === 'Creating' ? 'text-amber-300' : r[1] === 'Draining' || r[1] === 'NotReady' ? 'text-red-300' : undefined),
  };

  return [wc, yaml, policy, podsTable, nodesTable, eventsSection(world, 'spot', now)];
}

export const spot: CabinetModule = {
  id: 'spot',
  Scene,
  Controls,
  hud,
  Status,
  hint: 'Dial the Spot ratio, preempt a node, trigger a stockout.',
};
