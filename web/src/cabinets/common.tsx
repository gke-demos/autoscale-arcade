import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ago, stopwatch, table, usd } from '../lib/format';
import { computeLayout, type Layout, type LayoutOptions } from '../scene/layout';
import { useArcade } from '../store';
import type { Node, Pod, WorldState } from '../types';
import type { HudSection } from './types';

// ---- data helpers ---------------------------------------------------------

/** Nodes relevant to a cabinet: the ones hosting its pods plus pools/classes it owns. */
export function cabinetNodes(world: WorldState, cabinet: string, extra?: (n: Node) => boolean): Node[] {
  const hosts = new Set(world.pods.filter((p) => p.cabinet === cabinet && p.node).map((p) => p.node));
  return world.nodes.filter((n) => hosts.has(n.name) || n.computeClass === `arcade-${cabinet}` || extra?.(n));
}
export function cabinetPods(world: WorldState, cabinet: string): Pod[] {
  return world.pods.filter((p) => p.cabinet === cabinet);
}

export function useCabinetLayout(world: WorldState, cabinet: string, opts: LayoutOptions & { extraNodes?: (n: Node) => boolean; pods?: (p: Pod) => boolean } = {}): Layout {
  const { extraNodes, pods: podFilter, ...layoutOpts } = opts;
  return useMemo(() => {
    const nodes = cabinetNodes(world, cabinet, extraNodes);
    const pods = world.pods.filter((p) => (podFilter ? podFilter(p) : p.cabinet === cabinet));
    return computeLayout(nodes, pods, layoutOpts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world.nodes, world.pods, cabinet]);
}

/** Re-render every `ms` (for stopwatches / ages). */
export function useNow(ms = 100): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** kubectl get pods -style rows for a set of pods. */
export function podTable(pods: Pod[], nowMs = Date.now()): HudSection {
  return {
    kind: 'table',
    title: 'Pods',
    command: 'kubectl get pods -o wide',
    columns: ['NAME', 'READY', 'STATUS', 'AGE', 'NODE'],
    rows: pods.map((p) => [
      p.name,
      p.ready ? '1/1' : '0/1',
      p.deleting ? 'Terminating' : p.phase === 'Pending' ? (p.pendingReason ?? 'Pending') : p.phase,
      ago(p.created, nowMs),
      p.node ? shortNodeName(p.node) : '<none>',
    ]),
    highlight: (r) => (r[2] === 'Terminating' ? 'text-red-300' : r[1] === '0/1' ? 'text-amber-300' : undefined),
  };
}

export function nodeTable(nodes: Node[], nowMs = Date.now()): HudSection {
  return {
    kind: 'table',
    title: 'Nodes',
    command: 'kubectl get nodes -L cloud.google.com/machine-family,cloud.google.com/gke-spot',
    columns: ['NAME', 'STATUS', 'AGE', 'FAMILY', 'SPOT', 'CPU'],
    rows: nodes.map((n) => [
      shortNodeName(n.name),
      n.creating ? 'Creating' : n.deleting ? 'Draining' : n.suspended ? 'Suspended' : n.unschedulable ? 'Ready,SchedulingDisabled' : n.ready ? 'Ready' : 'NotReady',
      n.creating ? '—' : ago(n.created, nowMs),
      n.machineFamily,
      n.spot ? 'true' : '',
      `${n.cpu.requested.toFixed(1)}/${n.cpu.allocatable.toFixed(1)}`,
    ]),
    highlight: (r) => (r[1] === 'Creating' ? 'text-amber-300' : r[1] === 'Draining' ? 'text-red-300' : r[1] === 'Suspended' ? 'text-sky-300' : undefined),
  };
}

export function eventsSection(world: WorldState, cabinet?: string, nowMs = Date.now()): HudSection {
  const evs = world.events.filter((e) => !cabinet || e.cabinet === cabinet || !e.cabinet).slice(0, 12);
  return {
    kind: 'table',
    title: 'Events',
    command: `kubectl get events${cabinet ? ` -n arcade-${cabinet}` : ' -A'} --sort-by=.lastTimestamp`,
    columns: ['AGE', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'],
    rows: evs.map((e) => [ago(e.ts, nowMs), e.type, e.reason, e.object, e.message]),
    highlight: (r) => (r[1] === 'Warning' ? 'text-amber-300' : undefined),
  };
}

export function shortNodeName(name: string) {
  const m = name.match(/^gke-[^-]+(?:-[^-]+)*?-([a-z0-9-]+?)-([0-9a-f]{8})-([a-z0-9]{4})$/);
  if (m) return `${m[1]}-${m[3]}`;
  const g = name.match(/^gke-(?:autoscale-)?arcade-(.+)$/);
  if (g) return g[1];
  return name;
}

export { table };

// ---- UI atoms used by every cabinet's controls --------------------------

export function ControlGroup({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {title && <div className="text-[0.75rem] font-bold uppercase tracking-[0.2em] text-slate-400">{title}</div>}
      {children}
    </div>
  );
}

export function ActionButton({
  action,
  body,
  children,
  accent,
  className = '',
  disabled,
  label,
  onDone,
  confirm,
}: {
  action: string;
  body?: Record<string, unknown>;
  children: ReactNode;
  accent?: string;
  className?: string;
  disabled?: boolean;
  label?: string;
  onDone?: () => void;
  confirm?: string;
}) {
  const act = useArcade((s) => s.act);
  const busy = useArcade((s) => s.busy[label ?? action]);
  const toast = useArcade((s) => s.toast);
  return (
    <button
      className={`btn ${accent ? 'btn-accent' : ''} ${className}`}
      style={accent ? ({ '--btn-accent': accent } as React.CSSProperties) : undefined}
      disabled={disabled || busy}
      onClick={async () => {
        if (confirm && !window.confirm(confirm)) return;
        const r = await act(action, body, { label });
        if (r.ok) onDone?.();
        else toast('error', r.error);
      }}
    >
      {busy ? <span className="animate-blink">…</span> : children}
    </button>
  );
}

export function Stat({ label, value, tone = 'text-slate-100', sub }: { label: string; value: ReactNode; tone?: string; sub?: ReactNode }) {
  return (
    <div className="flex min-w-[6rem] flex-col rounded-xl border border-line/80 bg-black/30 px-3 py-2">
      <div className="text-[0.65rem] uppercase tracking-widest text-slate-400">{label}</div>
      <div className={`font-mono text-[1.35rem] font-bold leading-tight ${tone}`}>{value}</div>
      {sub && <div className="text-[0.65rem] text-slate-400">{sub}</div>}
    </div>
  );
}

export function Stopwatch({ startedAt, stoppedAt, label = 'Stopwatch', tone }: { startedAt?: string; stoppedAt?: string; label?: string; tone?: string }) {
  const now = useNow(100);
  const start = startedAt ? Date.parse(startedAt) : undefined;
  const end = stoppedAt ? Date.parse(stoppedAt) : now;
  const ms = start ? end - start : 0;
  const running = !!start && !stoppedAt;
  return <Stat label={label} value={<span className={running ? 'text-amber-300' : (tone ?? 'text-lime-300')}>{stopwatch(ms)}</span>} sub={running ? 'running' : stoppedAt ? 'final' : 'idle'} />;
}

export function CostMeter({ perHour, label = 'Cost', sub }: { perHour: number; label?: string; sub?: ReactNode }) {
  return <Stat label={label} value={<span className="text-emerald-300">{usd(perHour, 3)}/h</span>} sub={sub ?? 'list price estimate'} />;
}

export function Badge({ children, tone = 'bg-slate-700 text-slate-100' }: { children: ReactNode; tone?: string }) {
  return <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-[0.7rem] font-bold ${tone}`}>{children}</span>;
}
