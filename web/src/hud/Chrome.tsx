import { useEffect, useState } from 'react';
import { getLeaderboard, postLeaderboard } from '../api';
import { cabinets } from '../cabinets';
import { useArcade } from '../store';
import { CABINETS, CABINET_IDS, type LeaderboardEntry, type WorldState } from '../types';

// ---- Top bar ------------------------------------------------------------------

export function TopBar({ world }: { world?: WorldState }) {
  const view = useArcade((s) => s.view);
  const setView = useArcade((s) => s.setView);
  const mode = useArcade((s) => s.mode);
  const setMode = useArcade((s) => s.setMode);
  const connected = useArcade((s) => s.connected);
  const setShowHelp = useArcade((s) => s.setShowHelp);
  const setShowLeaderboard = useArcade((s) => s.setShowLeaderboard);
  const isDemo = mode === 'demo';
  const meta = view === 'lobby' ? undefined : CABINETS[view];
  return (
    <header className="pointer-events-auto flex items-center gap-2.5">
      <button className="btn btn-ghost !min-w-0 gap-3 px-3.5" onClick={() => setView('lobby')} title={isDemo ? 'Cluster Overview (0 / Esc)' : 'Lobby (0 / Esc)'}>
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#303134] text-[1.2rem]">{isDemo ? '☸️' : '🕹️'}</span>
        <span className="flex flex-col items-start leading-none">
          <span className="font-display text-[1.05rem] font-black tracking-[0.13em] text-white">
            <span className="text-[#4285f4]">G</span>
            <span className="text-[#ea4335]">K</span>
            <span className="text-[#fbbc04]">E</span>
            <span className="ml-1.5 text-[#e8eaed]">{isDemo ? 'AUTOSCALING LAB' : 'AUTOSCALE ARCADE'}</span>
          </span>
          <span className="mt-0.5 font-mono text-[0.65rem] text-[#9aa0a6]">
            {world ? `${world.cluster.name} · GKE ${world.cluster.version}` : 'connecting…'}
            <span className={`ml-2 ${connected ? 'text-[#34a853]' : 'text-[#ea4335] animate-blink'}`}>●</span>
          </span>
        </span>
      </button>
      <nav className="flex gap-1">
        {CABINET_IDS.map((id) => {
          const c = CABINETS[id];
          const active = view === id;
          const title = isDemo ? c.demoTitle : c.title;
          const subtitle = isDemo ? c.demoSubtitle : c.subtitle;
          return (
            <button
              key={id}
              className={`btn !min-w-0 flex-col gap-0 px-2.5 ${active ? 'btn-accent' : 'btn-ghost'}`}
              style={{ '--btn-accent': c.accent } as React.CSSProperties}
              onClick={() => setView(id)}
              title={`${title} (${c.key})`}
            >
              <span className="text-[0.86rem] leading-tight">
                <span className="kbd mr-1 opacity-70">{c.key}</span>
                {title}
              </span>
              <span className={`text-[0.58rem] font-normal ${active ? 'text-black/70' : 'text-slate-400'}`}>{subtitle}</span>
            </button>
          );
        })}
      </nav>
      <div className="ml-auto flex items-center gap-1.5">
        {meta && (
          <div className="hidden max-w-[18rem] flex-col justify-center text-right 2xl:flex">
            <span className="font-mono text-[0.68rem] text-slate-300">{isDemo ? meta.crd : meta.feature}</span>
            <span className="truncate text-[0.68rem] text-slate-500">{isDemo ? meta.demoDescription : cabinets[meta.id].hint}</span>
          </div>
        )}
        {/* Mode Switcher: Arcade vs Demo Lab */}
        <div className="flex items-center rounded-xl border border-[#3c4043] bg-[#131314]/90 p-0.5 font-mono text-[0.72rem]" title="Switch between Arcade Game Mode and Pure Technical Demo Mode (M)">
          <button
            type="button"
            onClick={() => setMode('arcade')}
            className={`rounded-lg px-2.5 py-1.5 font-bold transition-colors ${
              !isDemo ? 'bg-[#4285f4] text-[#131314] shadow' : 'text-[#9aa0a6] hover:text-white'
            }`}
          >
            🕹️ Arcade
          </button>
          <button
            type="button"
            onClick={() => setMode('demo')}
            className={`rounded-lg px-2.5 py-1.5 font-bold transition-colors ${
              isDemo ? 'bg-[#34a853] text-[#131314] shadow' : 'text-[#9aa0a6] hover:text-white'
            }`}
          >
            ☸️ Demo Lab
          </button>
        </div>
        {!isDemo && (
          <button className="btn btn-ghost" title="Leaderboard" onClick={() => setShowLeaderboard(true)}>
            🏆
          </button>
        )}
        <button className="btn btn-ghost" title="Help (?)" onClick={() => setShowHelp(true)}>
          ?
        </button>
        <button className="btn btn-ghost" title="Fullscreen (F)" onClick={toggleFullscreen}>
          ⛶
        </button>
      </div>
    </header>
  );
}

export function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => {});
}

// ---- Bottom bar -----------------------------------------------------------------

export function BottomBar({ world }: { world: WorldState }) {
  const view = useArcade((s) => s.view);
  const mode = useArcade((s) => s.mode);
  const act = useArcade((s) => s.act);
  const busy = useArcade((s) => s.busy);
  const isDemo = mode === 'demo';
  const sc = world.scenario;
  const meta = view === 'lobby' ? undefined : CABINETS[view];
  const Status = meta ? cabinets[meta.id].Status : undefined;
  const runningHere = sc.running && (view === 'lobby' || sc.cabinet === view);
  const accent = meta?.accent ?? '#4285f4';

  return (
    <footer className="panel pointer-events-auto flex items-center gap-3 px-3 py-2">
      {sc.running ? (
        <button className="btn btn-accent !min-w-0" style={{ '--btn-accent': '#ea4335' } as React.CSSProperties} onClick={() => act('scenario.stop', {}, { label: 'Stop' })} disabled={busy['Stop']}>
          ■ Stop
        </button>
      ) : (
        <button className="btn btn-accent !min-w-0" style={{ '--btn-accent': accent } as React.CSSProperties} onClick={() => act('scenario.run', { name: meta ? meta.scenario : 'all' }, { label: 'Auto-run' })} disabled={busy['Auto-run']} title="Space">
          ▶ {meta ? (isDemo ? 'Run demo' : 'Auto-run demo') : isDemo ? 'Run all 7 demos' : 'Insert coin — play all'}
        </button>
      )}
      {!sc.running && meta && (
        <button className="btn btn-ghost !min-w-0" onClick={() => act('scenario.run', { name: 'all' }, { label: 'Play all' })} title="Run every demo in order">
          {isDemo ? '▶ Run all demos' : '🪙 Play all'}
        </button>
      )}
      <button className="btn btn-ghost !min-w-0" onClick={() => act('reset', meta ? { cabinet: meta.id } : {}, { label: 'Reset' })} disabled={busy['Reset']} title="R">
        ↺ Reset{meta ? '' : ' all'}
      </button>

      <div className="flex min-w-0 flex-1 flex-col justify-center px-2">
        {sc.running ? (
          <>
            <div className="flex items-center gap-2 font-mono text-[0.7rem] text-slate-400">
              <span className="animate-blink text-amber-300">●</span>
              {sc.attract && !isDemo ? 'ATTRACT MODE' : isDemo ? 'LIVE DEMO SCENARIO' : 'AUTO-RUN'} · {sc.name} · step {sc.step}/{sc.steps}
              {!runningHere && sc.cabinet && (
                <span className="text-slate-500">
                  (in {isDemo ? CABINETS[sc.cabinet as keyof typeof CABINETS]?.demoTitle : CABINETS[sc.cabinet as keyof typeof CABINETS]?.title ?? sc.cabinet})
                </span>
              )}
            </div>
            <div className="truncate text-[1.1rem] font-semibold text-slate-100">{sc.caption ?? '…'}</div>
            <div className="mt-1 h-1 w-full overflow-hidden rounded bg-white/10">
              <div className="h-full rounded transition-all duration-700" style={{ width: `${(sc.step / Math.max(1, sc.steps)) * 100}%`, background: accent }} />
            </div>
          </>
        ) : sc.error ? (
          <div className="truncate text-[0.95rem] text-red-300">Scenario error: {sc.error}</div>
        ) : (
          <div className="truncate text-[0.95rem] text-slate-400">
            {meta
              ? isDemo
                ? meta.demoDescription
                : cabinets[meta.id].hint
              : isDemo
                ? 'Select a GKE autoscaling demo from the catalog or top bar, or press ▶ to run all 7 demos.'
                : 'Pick a cabinet, or press ▶ to play them all.'}
          </div>
        )}
      </div>

      {Status && (
        <div className="flex items-center gap-2">
          <Status world={world} />
        </div>
      )}
      <ClusterMeter world={world} />
    </footer>
  );
}

function ClusterMeter({ world }: { world: WorldState }) {
  const ca = world.cluster.autoscaler;
  const creating = world.nodes.filter((n) => n.creating).length;
  const draining = world.nodes.filter((n) => n.deleting).length;
  return (
    <div className="hidden flex-col items-end font-mono text-[0.65rem] text-slate-400 xl:flex">
      <span>
        CA {ca.status} · up <span className={ca.scaleUp === 'InProgress' ? 'text-amber-300' : ''}>{ca.scaleUp}</span> · down{' '}
        <span className={ca.scaleDown !== 'NoCandidates' ? 'text-red-300' : ''}>{ca.scaleDown}</span>
      </span>
      <span>
        {world.nodes.filter((n) => n.ready).length} nodes ready{creating ? ` · ${creating} creating` : ''}
        {draining ? ` · ${draining} draining` : ''} · {world.pods.filter((p) => !p.buffer).length} pods
      </span>
    </div>
  );
}

// ---- Toasts ---------------------------------------------------------------------

export function Toasts() {
  const toasts = useArcade((s) => s.toasts);
  const dismiss = useArcade((s) => s.dismissToast);
  const tone: Record<string, string> = {
    info: 'border-sky-400/50 text-sky-100',
    success: 'border-emerald-400/50 text-emerald-100',
    warn: 'border-amber-400/60 text-amber-100',
    error: 'border-red-400/60 text-red-100',
  };
  return (
    <div className="pointer-events-none absolute right-[27%] top-[6rem] z-40 flex w-[22rem] flex-col gap-2">
      {toasts.map((t) => (
        <button key={t.id} onClick={() => dismiss(t.id)} className={`panel pointer-events-auto border px-3 py-2 text-left text-[0.9rem] ${tone[t.level]}`}>
          {t.level === 'error' ? '⚠ ' : t.level === 'success' ? '✓ ' : ''}
          {t.text}
        </button>
      ))}
    </div>
  );
}

// ---- Help overlay -----------------------------------------------------------------

export function HelpOverlay() {
  const show = useArcade((s) => s.showHelp);
  const setShow = useArcade((s) => s.setShowHelp);
  const isDemo = useArcade((s) => s.mode === 'demo');
  if (!show) return null;
  const rows: [string, string][] = [
    ['1–7', isDemo ? 'open a GKE autoscaling demo' : 'open a cabinet'],
    ['0 / Esc', isDemo ? 'cluster overview & demo catalog' : 'lobby'],
    ['Space', isDemo ? '▶ auto-run current demo' : '▶ auto-run current cabinet'],
    ['R', isDemo ? 'reset current demo workload' : 'reset current cabinet'],
    ['M', 'toggle Arcade Mode / Demo Lab'],
    ...(!isDemo ? ([['A', 'toggle attract mode (auto-start after idle only with ?kiosk=1)']] as [string, string][]) : []),
    ['F', 'fullscreen'],
    ['← →', isDemo ? 'previous / next demo' : 'previous / next cabinet'],
    ['?', 'this help'],
  ];
  return (
    <Modal onClose={() => setShow(false)} title={isDemo ? 'Keyboard shortcuts' : 'How to play'}>
      <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[1rem]">
        {rows.map(([k, v]) => (
          <KeyRow key={k} k={k} v={v} />
        ))}
      </div>
      <p className="mt-4 text-[0.9rem] text-slate-400">
        {isDemo
          ? 'Every demo drives real Kubernetes objects on a GKE 1.37 cluster. Nothing is faked: all state is streamed from client-go informers.'
          : 'Every cabinet drives real objects on a GKE cluster. Nothing is faked: if a feature degrades, the HUD shows it.'}
      </p>
    </Modal>
  );
}
function KeyRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <span className="kbd text-[1rem]">{k}</span>
      <span>{v}</span>
    </>
  );
}

export function Modal({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="panel w-[36rem] max-w-[90vw] p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center">
          <h2 className="text-[1.4rem] font-black tracking-wide text-neon neon-text">{title}</h2>
          <button className="btn btn-ghost ml-auto" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---- Leaderboard -------------------------------------------------------------------

export function LeaderboardOverlay() {
  const show = useArcade((s) => s.showLeaderboard);
  const setShow = useArcade((s) => s.setShowLeaderboard);
  const prompt = useArcade((s) => s.leaderboardPrompt);
  const setPrompt = useArcade((s) => s.setLeaderboardPrompt);
  const toast = useArcade((s) => s.toast);
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [initials, setInitials] = useState('');
  const open = show || !!prompt;

  useEffect(() => {
    if (!open) return;
    getLeaderboard()
      .then(setEntries)
      .catch((e) => toast('warn', `leaderboard: ${e.message}`));
  }, [open, toast]);

  if (!open) return null;
  const close = () => {
    setShow(false);
    setPrompt(undefined);
    setInitials('');
  };
  const submit = async () => {
    if (!prompt || initials.length < 1) return;
    try {
      await postLeaderboard({ cabinet: prompt.cabinet, initials: initials.toUpperCase(), score: prompt.score, unit: prompt.unit });
      toast('success', `${initials.toUpperCase()} added to the leaderboard`);
      setPrompt(undefined);
      setInitials('');
      setShow(true);
      setEntries(await getLeaderboard());
    } catch (e) {
      toast('error', `leaderboard: ${(e as Error).message}`);
    }
  };
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  return (
    <Modal onClose={close} title={prompt ? 'New score!' : 'Leaderboard'}>
      {prompt && (
        <div className="mb-4 rounded-xl border p-3" style={{ borderColor: CABINETS[prompt.cabinet].accent }}>
          <div className="text-[1rem] text-slate-200">{prompt.label}</div>
          <div className="font-mono text-[2rem] font-black" style={{ color: CABINETS[prompt.cabinet].accent }}>
            {prompt.score} {prompt.unit}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-slate-400">Initials</span>
            <span className="kbd !h-[3rem] !min-w-[6rem] text-[1.6rem] tracking-[0.4em]">{(initials + '___').slice(0, 3)}</span>
            <button className="btn btn-sm btn-ghost" onClick={() => setInitials((s) => s.slice(0, -1))}>
              ⌫
            </button>
            <button className="btn btn-sm btn-accent ml-auto" disabled={initials.length < 1} onClick={submit}>
              Save
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setPrompt(undefined)}>
              Skip
            </button>
          </div>
          <div className="mt-2 grid grid-cols-9 gap-1">
            {letters.map((l) => (
              <button key={l} className="btn btn-sm !min-h-[3rem] !min-w-0 !px-0" onClick={() => setInitials((s) => (s.length < 3 ? s + l : s))}>
                {l}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="scrollbar-thin max-h-[40vh] overflow-y-auto">
        <table className="w-full font-mono text-[0.9rem]">
          <thead className="text-left text-slate-400">
            <tr>
              <th>#</th>
              <th>CABINET</th>
              <th>WHO</th>
              <th className="text-right">SCORE</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={4} className="py-2 text-slate-500">
                  No scores yet — be the first.
                </td>
              </tr>
            )}
            {entries.map((e, i) => (
              <tr key={i} className="border-t border-white/5">
                <td className="py-1 text-slate-500">{i + 1}</td>
                <td style={{ color: CABINETS[e.cabinet as keyof typeof CABINETS]?.accent }}>{CABINETS[e.cabinet as keyof typeof CABINETS]?.title ?? e.cabinet}</td>
                <td className="font-black tracking-widest">{e.initials}</td>
                <td className="text-right">
                  {e.score} {e.unit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
