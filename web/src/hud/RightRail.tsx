import { useMemo } from 'react';
import { cabinets } from '../cabinets';
import { eventsSection, nodeTable, podTable, useNow } from '../cabinets/common';
import type { HudSection } from '../cabinets/types';
import { toYaml } from '../lib/format';
import { useArcade } from '../store';
import { CABINETS, type WorldState } from '../types';

/** Right rail: the real kubectl-style tables / YAML for what is on screen. */
export function RightRail({ world }: { world: WorldState }) {
  const view = useArcade((s) => s.view);
  const tab = useArcade((s) => s.hudTab);
  const setTab = useArcade((s) => s.setHudTab);
  useNow(1000); // ages tick
  const sections = useMemo<HudSection[]>(() => {
    if (view === 'lobby') return lobbyHud(world);
    return cabinets[view].hud(world);
  }, [view, world]);

  const tables = sections.filter((s) => s.kind !== 'yaml' && s.title !== 'Events');
  const yamls = sections.filter((s) => s.kind === 'yaml');
  const events = sections.filter((s) => s.title === 'Events');
  const shown = tab === 'table' ? tables : tab === 'yaml' ? yamls : events;
  const accent = view === 'lobby' ? '#22d3ee' : CABINETS[view].accent;

  return (
    <aside className="panel pointer-events-auto flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-1 border-b border-line/80 px-3 py-2">
        <span className="mr-auto font-mono text-[0.8rem] text-slate-400">
          <span style={{ color: accent }}>❯</span> kubectl
        </span>
        {(['table', 'yaml', 'events'] as const).map((t) => (
          <button key={t} className={`btn btn-sm !min-h-[2.4rem] !min-w-[3.6rem] !px-3 !text-[0.75rem] ${tab === t ? 'btn-accent' : 'btn-ghost'}`} style={{ '--btn-accent': accent } as React.CSSProperties} onClick={() => setTab(t)}>
            {t === 'table' ? 'get' : t === 'yaml' ? '-o yaml' : 'events'}
          </button>
        ))}
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto overflow-x-hidden px-3 py-2 font-mono text-[0.72rem] leading-[1.35]">
        {shown.length === 0 && <div className="text-slate-500">nothing to show</div>}
        {shown.map((s, i) => (
          <Section key={`${s.title}-${i}`} s={s} />
        ))}
      </div>
    </aside>
  );
}

function Section({ s }: { s: HudSection }) {
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[0.8rem] font-bold text-slate-200">{s.title}</span>
        {'command' in s && s.command && <span className="truncate text-[0.65rem] text-slate-500">$ {s.command}</span>}
      </div>
      {s.kind === 'table' && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse whitespace-nowrap">
            <thead>
              <tr className="text-left text-slate-400">
                {s.columns.map((c) => (
                  <th key={c} className="pr-3 font-normal">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.rows.length === 0 && (
                <tr>
                  <td colSpan={s.columns.length} className="text-slate-500">
                    No resources found.
                  </td>
                </tr>
              )}
              {s.rows.map((r, i) => (
                <tr key={i} className={`${s.highlight?.(r) ?? 'text-slate-100'} border-t border-white/5`}>
                  {r.map((c, j) => (
                    <td key={j} className="max-w-[16rem] truncate pr-3 align-top" title={c}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {s.kind === 'yaml' && <pre className="whitespace-pre-wrap break-all rounded-lg bg-black/40 p-2 text-[0.7rem] text-sky-100">{toYaml(s.value)}</pre>}
      {s.kind === 'kv' && (
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {s.items.map(([k, v, tone]) => (
            <KV key={k} k={k} v={v} tone={tone} />
          ))}
        </div>
      )}
    </div>
  );
}
function KV({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <>
      <span className="text-slate-400">{k}</span>
      <span className={tone ?? 'text-slate-100'}>{v}</span>
    </>
  );
}

function lobbyHud(world: WorldState): HudSection[] {
  const now = Date.now();
  const ca = world.cluster.autoscaler;
  return [
    {
      kind: 'kv',
      title: `Cluster ${world.cluster.name}`,
      items: [
        ['version', world.cluster.version],
        ['project', world.cluster.project],
        ['region', world.cluster.region],
        ['nodes', `${world.nodes.filter((n) => n.ready).length} ready / ${world.nodes.length}`],
        ['pods', `${world.pods.filter((p) => !p.buffer).length} (${world.pods.filter((p) => !p.node && !p.buffer).length} pending)`],
      ],
    },
    {
      kind: 'kv',
      title: 'cluster-autoscaler-status',
      items: [
        ['status', ca.status, ca.status === 'Running' ? 'text-lime-300' : 'text-amber-300'],
        ['scaleUp', ca.scaleUp, ca.scaleUp === 'InProgress' ? 'text-amber-300' : undefined],
        ['scaleDown', ca.scaleDown, ca.scaleDown !== 'NoCandidates' ? 'text-red-300' : undefined],
        ['candidates', String(ca.scaleDownCandidates)],
      ],
    },
    {
      kind: 'table',
      title: 'Node groups',
      command: 'kubectl -n kube-system get cm cluster-autoscaler-status -o yaml',
      columns: ['GROUP', 'READY', 'TARGET', 'MIN', 'MAX', 'SCALEUP'],
      rows: ca.nodeGroups.map((g) => [g.pool, `${g.ready}/${g.total}`, String(g.target), String(g.min), String(g.max), g.backoff ? `Backoff (${g.backoff})` : g.scaleUp]),
      highlight: (r) => (r[5] === 'InProgress' ? 'text-amber-300' : r[5].startsWith('Backoff') ? 'text-red-300' : undefined),
    },
    nodeTable(world.nodes, now),
    podTable(
      world.pods.filter((p) => !p.buffer),
      now,
    ),
    eventsSection(world, undefined, now),
  ];
}
