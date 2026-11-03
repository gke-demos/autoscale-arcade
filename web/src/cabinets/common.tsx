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

export function Badge({ children, tone = 'bg-[#303134] text-[#e8eaed]' }: { children: ReactNode; tone?: string }) {
  return <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-[0.7rem] font-bold ${tone}`}>{children}</span>;
}

export interface MissionStep {
  label: string;
  detail?: string;
  done: boolean;
  active?: boolean;
}

/**
 * Prominent "How to Play / Mission" card rendered at the top of every cabinet's
 * left control rail so players immediately understand the goal, steps, and win condition.
 */
export function MissionCard({
  goal,
  win,
  steps,
  accent = '#4285f4',
}: {
  goal: ReactNode;
  win: ReactNode;
  steps: MissionStep[];
  accent?: string;
}) {
  const mode = useArcade((s) => s.mode);
  const view = useArcade((s) => s.view);
  const act = useArcade((s) => s.act);
  const running = useArcade((s) => s.world?.scenario.running ?? false);
  const runningCabinet = useArcade((s) => s.world?.scenario.cabinet);
  const isDemo = mode === 'demo';
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length && steps.length > 0;
  const runningThis = running && runningCabinet === view;

  return (
    <div
      className="flex flex-col gap-2 rounded-xl border bg-[#131314]/85 p-3"
      style={{ borderColor: allDone ? '#34a853' : `${accent}66` }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[0.68rem] font-bold uppercase tracking-[0.18em]" style={{ color: allDone ? '#34a853' : accent }}>
          {isDemo
            ? allDone
              ? '✓ WORKFLOW VERIFIED'
              : '☸️ GKE CONTROLLER WORKFLOW'
            : allDone
              ? '★ MISSION COMPLETE'
              : '🎯 MISSION · HOW TO PLAY'}
        </span>
        <span className="rounded-full bg-[#303134] px-2 py-0.5 font-mono text-[0.65rem] font-bold text-[#e8eaed]">
          {doneCount}/{steps.length} {isDemo ? 'stages' : 'steps'}
        </span>
      </div>
      <div className="text-[0.82rem] leading-snug text-[#e8eaed]">{goal}</div>
      <div className="flex flex-col gap-1.5 pt-0.5">
        {steps.map((s, i) => (
          <div
            key={i}
            className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[0.76rem] leading-tight transition-colors ${
              s.done
                ? 'border-[#34a853]/60 bg-[#34a853]/15 text-[#e8eaed]'
                : s.active
                  ? 'border-[#fbbc04]/60 bg-[#fbbc04]/10 text-[#e8eaed]'
                  : 'border-[#3c4043] bg-[#202124]/80 text-[#9aa0a6]'
            }`}
          >
            <span
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full font-mono text-[0.65rem] font-bold ${
                s.done ? 'bg-[#34a853] text-[#131314]' : s.active ? 'bg-[#fbbc04] text-[#131314]' : 'bg-[#3c4043] text-[#e8eaed]'
              }`}
            >
              {s.done ? '✓' : i + 1}
            </span>
            <div className="flex flex-col">
              <span className="font-semibold text-[#e8eaed]">{s.label}</span>
              {s.detail && <span className="mt-0.5 text-[0.68rem] text-[#9aa0a6]">{s.detail}</span>}
            </div>
          </div>
        ))}
      </div>
      {isDemo ? (
        view !== 'lobby' && (
          <div className="flex items-center gap-2 border-t border-[#3c4043]/80 pt-2">
            {runningThis ? (
              <button
                type="button"
                onClick={() => void act('scenario.stop', {}, { label: 'Stop demo' })}
                className="btn btn-accent !min-h-[2.2rem] flex-1 !py-1 font-mono text-[0.78rem]"
                style={{ '--btn-accent': '#ea4335' } as React.CSSProperties}
              >
                ■ Stop Automated Demo
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void act('scenario.run', { name: view }, { label: `Run ${view} demo` })}
                className="btn btn-accent !min-h-[2.2rem] flex-1 !py-1 font-mono text-[0.78rem]"
                style={{ '--btn-accent': accent } as React.CSSProperties}
              >
                ▶ Run Automated Demo
              </button>
            )}
            <button
              type="button"
              onClick={() => void act('reset', { cabinet: view }, { label: `Reset ${view}` })}
              className="btn btn-ghost !min-h-[2.2rem] !min-w-0 !px-3 !py-1 font-mono text-[0.76rem]"
            >
              ↺ Reset
            </button>
          </div>
        )
      ) : (
        <div className="flex items-center gap-1.5 border-t border-[#3c4043]/80 pt-1.5 font-mono text-[0.68rem] text-[#9aa0a6]">
          <span className="text-[#fbbc04]">🏆</span>
          <span className="font-bold text-[#e8eaed]">Win / Score:</span>
          <span className="truncate">{win}</span>
        </div>
      )}
    </div>
  );
}
