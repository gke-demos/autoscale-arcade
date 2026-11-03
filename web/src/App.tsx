import { useEffect, useMemo, useRef } from 'react';
import { cabinets } from './cabinets';
import { useCabinetLayout } from './cabinets/common';
import { useArcadeConnection } from './connection';
import { BottomBar, HelpOverlay, LeaderboardOverlay, Toasts, TopBar, toggleFullscreen } from './hud/Chrome';
import { ErrorBoundary } from './hud/ErrorBoundary';
import { RightRail } from './hud/RightRail';
import { Lobby } from './scene/Lobby';
import { CameraRig, Stage } from './scene/Stage';
import { useArcade } from './store';
import { CABINETS, CABINET_IDS, type CabinetId, type WorldState } from './types';
import { MOCK } from './api';

export default function App() {
  useArcadeConnection();
  useKeyboard();
  useAttractMode();
  useHashRoute();
  const world = useArcade((s) => s.world);
  const view = useArcade((s) => s.view);
  const mode = useArcade((s) => s.mode);
  const touch = useArcade((s) => s.touch);
  const isDemo = mode === 'demo';

  return (
    <div className="relative h-full w-full overflow-hidden bg-ink" onPointerDownCapture={touch} onKeyDownCapture={touch}>
      {world ? (
        <ErrorBoundary label="3D scene">
          <Stage autoRotate={view === 'lobby' && !world.scenario.running}>
            <ErrorBoundary label="scene" canvas>
              {view === 'lobby' ? <Lobby world={world} /> : <CabinetView id={view} world={world} />}
            </ErrorBoundary>
          </Stage>
        </ErrorBoundary>
      ) : (
        <Connecting />
      )}

      {/* DOM overlay */}
      <div className="pointer-events-none absolute inset-0 grid grid-cols-[minmax(0,1fr)_26%] grid-rows-[auto_minmax(0,1fr)_auto] gap-3 p-3">
        <div className="col-span-2">
          <TopBar world={world} />
        </div>
        <div className="relative min-h-0">
          {world && view !== 'lobby' && (
            <ErrorBoundary label="controls">
              <ControlsPanel id={view} world={world} />
            </ErrorBoundary>
          )}
          {world && view === 'lobby' && isDemo && (
            <ErrorBoundary label="demo catalog">
              <DemoCatalogPanel world={world} />
            </ErrorBoundary>
          )}
        </div>
        <div className="min-h-0">
          {world && (
            <ErrorBoundary label="HUD">
              <RightRail world={world} />
            </ErrorBoundary>
          )}
        </div>
        <div className="col-span-2">
          {world && (
            <ErrorBoundary label="bottom bar">
              <BottomBar world={world} />
            </ErrorBoundary>
          )}
        </div>
      </div>
      <Toasts />
      <HelpOverlay />
      {!isDemo && <LeaderboardOverlay />}
      {!isDemo && world?.scenario.attract && <AttractBanner />}
      {MOCK && <div className="pointer-events-none absolute bottom-1 left-1/2 -translate-x-1/2 rounded bg-amber-500/80 px-2 font-mono text-[0.6rem] text-black">MOCK DATA · VITE_MOCK=1</div>}
    </div>
  );
}

function CabinetView({ id, world }: { id: CabinetId; world: WorldState }) {
  const mod = cabinets[id];
  const layout = useCabinetLayout(world, id, { extraNodes: id === 'teleporter' ? (n) => n.gvisor : id === 'nitro' || id === 'lights' || id === 'metrics' ? (n) => n.pool === 'default-pool' : undefined });
  const framed = useMemo(() => (mod.frame ? { ...layout, bounds: mod.frame(layout.bounds) } : layout), [layout, mod]);
  (window as unknown as { __layout: unknown }).__layout = layout; // dev hook for automated checks
  return (
    <>
      <CameraRig layout={framed} viewKey={id} />
      <mod.Scene world={world} />
    </>
  );
}

function ControlsPanel({ id, world }: { id: CabinetId; world: WorldState }) {
  const mod = cabinets[id];
  const meta = CABINETS[id];
  const isDemo = useArcade((s) => s.mode === 'demo');
  return (
    <section className="panel pointer-events-auto absolute bottom-0 left-0 top-0 flex w-[25rem] max-w-[35vw] flex-col overflow-hidden" style={{ borderColor: `${meta.accent}66` }}>
      <div className="google-bar h-[3px] w-full shrink-0" />
      <div className="flex flex-col border-b border-line/80 px-4 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[1.18rem] font-black tracking-wide" style={{ color: meta.accent }}>
            {isDemo ? meta.demoTitle : meta.title}
          </span>
          <span className="font-mono text-[0.65rem] text-[#9aa0a6]">{meta.namespace}</span>
        </div>
        {isDemo && <div className="font-mono text-[0.65rem] text-[#8ab4f8]">{meta.crd}</div>}
      </div>
      <div className="scrollbar-thin flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
        <mod.Controls world={world} />
      </div>
    </section>
  );
}

function DemoCatalogPanel({ world }: { world: WorldState }) {
  const setView = useArcade((s) => s.setView);
  const act = useArcade((s) => s.act);
  const sc = world.scenario;

  return (
    <section className="panel pointer-events-auto absolute bottom-0 left-0 top-0 flex w-[27rem] max-w-[36vw] flex-col overflow-hidden border-[#34a853]/50">
      <div className="google-bar h-[3px] w-full shrink-0" />
      <div className="flex items-center justify-between border-b border-line/80 px-4 py-2.5">
        <div>
          <div className="text-[1.1rem] font-black tracking-wide text-[#e8eaed]">☸️ GKE 1.37 Autoscaling Demos</div>
          <div className="font-mono text-[0.65rem] text-[#9aa0a6]">7 live Kubernetes controller demos · zero game framing</div>
        </div>
        <button
          type="button"
          onClick={() => void act('scenario.run', { name: 'all' }, { label: 'Run all 7 demos' })}
          disabled={sc.running}
          className="btn btn-accent !min-h-[2rem] !min-w-0 !px-2.5 !py-1 font-mono text-[0.72rem]"
          style={{ '--btn-accent': '#34a853' } as React.CSSProperties}
        >
          ▶ Run All
        </button>
      </div>
      <div className="scrollbar-thin flex flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-2">
        {CABINET_IDS.map((id) => {
          const c = CABINETS[id];
          const pods = world.pods.filter((p) => p.cabinet === id && !p.buffer);
          const ready = pods.filter((p) => p.ready).length;
          const runningHere = sc.running && sc.cabinet === id;
          return (
            <div
              key={id}
              className="flex flex-col gap-1 rounded-xl border border-[#3c4043] bg-[#131314]/85 px-2.5 py-2 transition-colors hover:border-white/30"
              style={{ borderLeftWidth: '4px', borderLeftColor: c.accent }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="kbd text-[0.65rem]">{c.key}</span>
                  <span className="text-[0.88rem] font-black text-white">{c.demoTitle}</span>
                  <span className="text-[0.7rem] font-medium text-[#9aa0a6]">· {c.demoSubtitle}</span>
                </div>
                <span className="rounded bg-[#202124] px-1.5 py-0.5 font-mono text-[0.6rem] text-[#81c995]">
                  {ready}/{pods.length} Ready
                </span>
              </div>
              <div className="font-mono text-[0.62rem] text-[#8ab4f8]">
                {c.crd} · <span className="text-[#9aa0a6]">ns/{c.namespace}</span>
              </div>
              <div className="line-clamp-1 text-[0.7rem] leading-snug text-[#e8eaed]/90">{c.demoDescription}</div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setView(id);
                    void act('scenario.run', { name: c.scenario }, { label: `Run ${c.demoTitle} demo` });
                  }}
                  disabled={runningHere}
                  className="btn btn-accent !min-h-[1.75rem] !min-w-0 !px-2.5 !py-0.5 font-mono text-[0.68rem]"
                  style={{ '--btn-accent': c.accent } as React.CSSProperties}
                >
                  {runningHere ? '● Running…' : '▶ Run Demo'}
                </button>
                <button
                  type="button"
                  onClick={() => setView(id)}
                  className="btn btn-ghost !min-h-[1.75rem] !min-w-0 !px-2.5 !py-0.5 font-mono text-[0.68rem]"
                >
                  Interactive Controls →
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Connecting() {
  const connected = useArcade((s) => s.connected);
  const isDemo = useArcade((s) => s.mode === 'demo');
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4">
      <div className="text-[3rem] font-black tracking-[0.22em] text-white">
        <span className="text-[#4285f4]">G</span>
        <span className="text-[#ea4335]">K</span>
        <span className="text-[#fbbc04]">E</span>
        <span className="ml-3 text-[#e8eaed]">{isDemo ? 'AUTOSCALING LAB' : 'AUTOSCALE ARCADE'}</span>
      </div>
      <div className="font-mono text-[#9aa0a6]">{connected ? 'waiting for the first WorldState snapshot…' : 'connecting to arcade-server…'}</div>
      <div className="h-1.5 w-[20rem] overflow-hidden rounded bg-white/10">
        <div className="google-bar h-full w-1/2 animate-marquee" />
      </div>
    </div>
  );
}

function AttractBanner() {
  return (
    <div className="pointer-events-none absolute left-1/2 top-[5.5rem] z-30 -translate-x-1/2 rounded-full border border-amber-300/50 bg-black/70 px-5 py-2 font-mono text-[0.9rem] tracking-[0.3em] text-amber-200 animate-blink">
      ATTRACT MODE · TOUCH TO PLAY
    </div>
  );
}

// ---- #/<cabinet> and #/demos | #/demo/<cabinet> deep links ----------------------

function useHashRoute() {
  const view = useArcade((s) => s.view);
  const mode = useArcade((s) => s.mode);
  const setView = useArcade((s) => s.setView);
  const setMode = useArcade((s) => s.setMode);
  const applied = useRef(false);
  useEffect(() => {
    const apply = () => {
      const qs = new URLSearchParams(window.location.search);
      const qsMode = qs.get('mode');
      const rawHash = window.location.hash.replace(/^#\/?/, '') || qs.get('view') || '';
      if (rawHash === 'demo' || rawHash === 'demos') {
        setMode('demo');
        setView('lobby');
      } else if (rawHash.startsWith('demo/') || rawHash.startsWith('demos/')) {
        const sub = rawHash.replace(/^demos?\//, '');
        setMode('demo');
        if (CABINET_IDS.includes(sub as CabinetId)) setView(sub as CabinetId);
        else setView('lobby');
      } else if (rawHash === 'arcade') {
        setMode('arcade');
        setView('lobby');
      } else {
        if (qsMode === 'demo' || qsMode === 'demos') setMode('demo');
        else if (qsMode === 'arcade') setMode('arcade');
        if (CABINET_IDS.includes(rawHash as CabinetId)) setView(rawHash as CabinetId);
        else if (rawHash === '' || rawHash === 'lobby') setView('lobby');
      }
      applied.current = true;
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, [setView, setMode]);
  useEffect(() => {
    if (!applied.current) return;
    const { view: v, mode: m } = useArcade.getState();
    const want = m === 'demo' ? (v === 'lobby' ? '#/demos' : `#/demo/${v}`) : v === 'lobby' ? '#/' : `#/${v}`;
    if (window.location.hash !== want) window.history.replaceState(null, '', want);
  }, [view, mode]);
}

// ---- keyboard map (docs/contracts.md) -----------------------------------------

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useArcade.getState();
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      s.touch();
      const meta = s.view === 'lobby' ? undefined : CABINETS[s.view];
      const idx = CABINET_IDS.findIndex((id) => CABINETS[id].key === e.key);
      if (idx >= 0) return s.setView(CABINET_IDS[idx]);
      switch (e.key) {
        case '0':
        case 'Escape':
          if (s.showHelp) return s.setShowHelp(false);
          if (s.showLeaderboard || s.leaderboardPrompt) {
            s.setShowLeaderboard(false);
            s.setLeaderboardPrompt(undefined);
            return;
          }
          return s.setView('lobby');
        case ' ':
          e.preventDefault();
          if (s.world?.scenario.running) return void s.act('scenario.stop', {}, { label: 'Stop' });
          return void s.act('scenario.run', { name: meta ? meta.scenario : 'all' }, { label: 'Auto-run' });
        case 'r':
        case 'R':
          return void s.act('reset', meta ? { cabinet: meta.id } : {}, { label: 'Reset' });
        case 'm':
        case 'M':
          return s.setMode(s.mode === 'demo' ? 'arcade' : 'demo');
        case 'a':
        case 'A':
          if (s.mode === 'demo') return;
          if (s.world?.scenario.attract) return void s.act('scenario.stop', {}, { label: 'Stop attract' });
          return void s.act('scenario.run', { name: 'attract' }, { label: 'Attract mode' });
        case 'f':
        case 'F':
          return toggleFullscreen();
        case 'ArrowRight':
          return s.nextCabinet(1);
        case 'ArrowLeft':
          return s.nextCabinet(-1);
        case '?':
        case 'h':
          return s.setShowHelp(!s.showHelp);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// ---- attract mode after 90 s idle; any input exits ----------------------------------

function useAttractMode() {
  const idleMs = useArcade((s) => s.attractIdleMs);
  const attract = useArcade((s) => s.world?.scenario.attract ?? false);
  const running = useArcade((s) => s.world?.scenario.running ?? false);
  const setView = useArcade((s) => s.setView);
  const cabinet = useArcade((s) => s.world?.scenario.cabinet);

  // start attract after idle (only in Arcade mode)
  useEffect(() => {
    const id = window.setInterval(() => {
      const s = useArcade.getState();
      if (s.mode === 'demo') return;
      if (!s.world || s.world.scenario.running || s.drag) return;
      if (Date.now() - s.lastInput > idleMs) {
        // an abandoned score prompt / modal must not keep the kiosk out of attract mode
        if (s.leaderboardPrompt || s.showLeaderboard || s.showHelp) {
          s.setLeaderboardPrompt(undefined);
          s.setShowLeaderboard(false);
          s.setShowHelp(false);
        }
        void s.act('scenario.run', { name: 'attract' }, { quiet: true });
      }
    }, 5000);
    return () => window.clearInterval(id);
  }, [idleMs]);

  // exit attract on any input
  useEffect(() => {
    if (!attract) return;
    const stop = () => {
      const s = useArcade.getState();
      if (s.world?.scenario.attract) void s.act('scenario.stop', {}, { quiet: true });
    };
    const opts = { capture: true } as const;
    window.addEventListener('pointerdown', stop, opts);
    window.addEventListener('keydown', stop, opts);
    return () => {
      window.removeEventListener('pointerdown', stop, opts);
      window.removeEventListener('keydown', stop, opts);
    };
  }, [attract]);

  // follow the scenario's cabinet while a scenario drives the show
  const follow = useMemo(() => running && cabinet && CABINET_IDS.includes(cabinet as CabinetId), [running, cabinet]);
  useEffect(() => {
    if (follow && (attract || useArcade.getState().view === 'lobby' || useArcade.getState().view !== cabinet)) {
      if (attract || Date.now() - useArcade.getState().lastInput > 3000) setView(cabinet as CabinetId);
    }
  }, [follow, cabinet, attract, setView]);
}
