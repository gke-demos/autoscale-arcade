import { create } from 'zustand';
import { postAction, type ActionResult } from './api';
import type { CabinetId, PetState, ScenarioState, WorldState } from './types';
import { CABINET_IDS } from './types';

export type View = 'lobby' | CabinetId;
export type AppMode = 'arcade' | 'demo';

export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error' | 'success';
  text: string;
  until: number;
}

export interface DragState {
  podUid: string;
  from?: string;
  pos: [number, number, number];
  target?: string; // node name under the pointer
}

export interface LeaderboardPrompt {
  cabinet: CabinetId;
  score: number;
  unit: string;
  label: string;
}

function detectInitialMode(): AppMode {
  if (typeof window === 'undefined') return 'arcade';
  const qs = new URLSearchParams(window.location.search).get('mode');
  const h = window.location.hash.replace(/^#\/?/, '');
  if (qs === 'demo' || qs === 'demos' || h === 'demo' || h === 'demos' || h.startsWith('demo/') || h.startsWith('demos/')) {
    return 'demo';
  }
  return 'arcade';
}

// Auto-attract (idle loop over all cabinets) is opt-in: it starts scenarios
// server-side, so an idle browser anywhere would hijack every screen watching
// the cluster. Enable it only on the unattended booth kiosk with `?kiosk=1`
// (or `?attract=<seconds>`); it is remembered in localStorage until `?kiosk=0`.
function detectAttract(): { auto: boolean; idleMs: number } {
  const off = { auto: false, idleMs: 90_000 };
  if (typeof window === 'undefined') return off;
  const qs = new URLSearchParams(window.location.search);
  const kiosk = qs.get('kiosk');
  const attract = qs.get('attract');
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem('arcade.kiosk');
  } catch {
    /* private mode */
  }
  if (kiosk === '0' || attract === '0' || kiosk === 'false') {
    try {
      window.localStorage.removeItem('arcade.kiosk');
    } catch {
      /* ignore */
    }
    return off;
  }
  const secs = attract ? Number(attract) : kiosk ? 90 : stored ? Number(stored) : NaN;
  if (!Number.isFinite(secs) || secs <= 0) return off;
  try {
    window.localStorage.setItem('arcade.kiosk', String(secs));
  } catch {
    /* ignore */
  }
  return { auto: true, idleMs: secs * 1000 };
}
const initialAttract = detectAttract();

interface ArcadeStore {
  world?: WorldState;
  pet?: PetState;
  petSeenAt: number;
  connected: boolean;
  view: View;
  mode: AppMode;
  toasts: Toast[];
  drag?: DragState;
  lastInput: number;
  attractAuto: boolean; // kiosk only: start attract mode after attractIdleMs idle
  attractIdleMs: number;
  busy: Record<string, boolean>;
  leaderboardPrompt?: LeaderboardPrompt;
  showLeaderboard: boolean;
  showHelp: boolean;
  hudTab: 'table' | 'yaml' | 'events';

  setWorld: (w: WorldState) => void;
  setPet: (p: PetState) => void;
  setScenario: (s: ScenarioState) => void;
  setConnected: (c: boolean) => void;
  setView: (v: View) => void;
  setMode: (m: AppMode) => void;
  nextCabinet: (dir: 1 | -1) => void;
  toast: (level: Toast['level'], text: string, ms?: number) => void;
  dismissToast: (id: number) => void;
  setDrag: (d: DragState | undefined) => void;
  touch: () => void;
  act: (name: string, body?: Record<string, unknown>, opts?: { quiet?: boolean; label?: string }) => Promise<ActionResult>;
  setLeaderboardPrompt: (p: LeaderboardPrompt | undefined) => void;
  setShowLeaderboard: (b: boolean) => void;
  setShowHelp: (b: boolean) => void;
  setHudTab: (t: ArcadeStore['hudTab']) => void;
}

let toastSeq = 0;

export const useArcade = create<ArcadeStore>((set, get) => ({
  world: undefined,
  pet: undefined,
  petSeenAt: 0,
  connected: false,
  view: 'lobby',
  mode: detectInitialMode(),
  toasts: [],
  drag: undefined,
  lastInput: Date.now(),
  attractAuto: initialAttract.auto,
  attractIdleMs: initialAttract.idleMs,
  busy: {},
  leaderboardPrompt: undefined,
  showLeaderboard: false,
  showHelp: false,
  hudTab: 'table',

  setWorld: (world) => set({ world }),
  setPet: (pet) => set({ pet, petSeenAt: Date.now() }),
  setScenario: (scenario) => {
    const w = get().world;
    if (w) set({ world: { ...w, scenario } });
  },
  setConnected: (connected) => set({ connected }),
  setView: (view) => set({ view, drag: undefined, hudTab: 'table' }),
  setMode: (mode) =>
    set({
      mode,
      ...(mode === 'demo' ? { leaderboardPrompt: undefined, showLeaderboard: false } : {}),
    }),
  nextCabinet: (dir) => {
    const v = get().view;
    const i = v === 'lobby' ? (dir === 1 ? -1 : CABINET_IDS.length) : CABINET_IDS.indexOf(v);
    const n = (i + dir + CABINET_IDS.length) % CABINET_IDS.length;
    set({ view: CABINET_IDS[n], drag: undefined });
  },
  toast: (level, text, ms = 5000) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-5), { id, level, text, until: Date.now() + ms }] }));
    window.setTimeout(() => get().dismissToast(id), ms);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setDrag: (drag) => set({ drag }),
  touch: () => set({ lastInput: Date.now() }),
  act: async (name, body = {}, opts = {}) => {
    const key = opts.label ?? name;
    set((s) => ({ busy: { ...s.busy, [key]: true } }));
    const res = await postAction(name, body);
    set((s) => ({ busy: { ...s.busy, [key]: false } }));
    if (!res.ok) get().toast('error', `${name}: ${res.error}`, 8000);
    else if (!opts.quiet) get().toast('success', opts.label ?? name.replace('.', ' → '), 2500);
    return res;
  },
  setLeaderboardPrompt: (leaderboardPrompt) => {
    if (get().mode === 'demo' && leaderboardPrompt) return;
    set({ leaderboardPrompt });
  },
  setShowLeaderboard: (showLeaderboard) => set({ showLeaderboard }),
  setShowHelp: (showHelp) => set({ showHelp }),
  setHudTab: (hudTab) => set({ hudTab }),
}));

/** Convenience selectors */
export const useWorld = () => useArcade((s) => s.world);
export const useMode = () => useArcade((s) => s.mode);
export const useCabinet = <K extends CabinetId>(id: K) => useArcade((s) => s.world?.cabinets[id]);
