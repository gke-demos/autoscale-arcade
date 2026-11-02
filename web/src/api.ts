import type { LeaderboardEntry, WorldState } from './types';

export const MOCK = import.meta.env.VITE_MOCK === '1' || import.meta.env.VITE_MOCK === 'true';
// In dev, Vite proxies /api and /ws to VITE_API_BASE, so the client stays same-origin.
// In a production build VITE_API_BASE may point at a remote arcade-server (default: same origin).
export const API_BASE: string = import.meta.env.DEV
  ? ''
  : ((import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '');
const DEV_TOKEN: string | undefined = import.meta.env.VITE_DEV_TOKEN as string | undefined;

export function wsUrl(): string {
  const base = API_BASE || window.location.origin;
  const u = new URL(base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = (u.pathname.replace(/\/$/, '') || '') + '/ws';
  u.search = '';
  return u.toString();
}

function headers(mutating: boolean): HeadersInit {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (mutating && DEV_TOKEN) h['Authorization'] = `Bearer ${DEV_TOKEN}`;
  return h;
}

export type ActionResult = { ok: true } | { ok: false; error: string };

// The mock server (web/src/mock) registers itself here when VITE_MOCK=1.
export type ActionHandler = (name: string, body: Record<string, unknown>) => Promise<ActionResult>;
let actionOverride: ActionHandler | null = null;
export function setActionHandler(h: ActionHandler | null) {
  actionOverride = h;
}

export async function postAction(name: string, body: Record<string, unknown> = {}): Promise<ActionResult> {
  if (actionOverride) return actionOverride(name, body);
  try {
    const res = await fetch(`${API_BASE}/api/actions/${name}`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: ActionResult | undefined;
    try {
      json = text ? (JSON.parse(text) as ActionResult) : undefined;
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) return { ok: false, error: (json && !json.ok && json.error) || `${res.status} ${text || res.statusText}` };
    return json ?? { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchState(): Promise<WorldState> {
  const res = await fetch(`${API_BASE}/api/state`, { headers: headers(false) });
  if (!res.ok) throw new Error(`GET /api/state ${res.status}`);
  return (await res.json()) as WorldState;
}

let leaderboardOverride: { get: () => Promise<LeaderboardEntry[]>; post: (e: LeaderboardEntry) => Promise<void> } | null = null;
export function setLeaderboardHandler(h: typeof leaderboardOverride) {
  leaderboardOverride = h;
}

export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  if (leaderboardOverride) return leaderboardOverride.get();
  const res = await fetch(`${API_BASE}/api/leaderboard`, { headers: headers(false) });
  if (!res.ok) throw new Error(`GET /api/leaderboard ${res.status}`);
  const json = await res.json();
  // Accept either a bare array or {entries: [...]}.
  return (Array.isArray(json) ? json : (json?.entries ?? [])) as LeaderboardEntry[];
}

export async function postLeaderboard(entry: LeaderboardEntry): Promise<void> {
  if (leaderboardOverride) return leaderboardOverride.post(entry);
  const res = await fetch(`${API_BASE}/api/leaderboard`, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify(entry),
  });
  if (!res.ok) throw new Error(`POST /api/leaderboard ${res.status}`);
}

export interface ScenarioInfo {
  name: string;
  cabinet?: string;
  title?: string;
  captions?: string[];
}

export async function getScenarios(): Promise<ScenarioInfo[]> {
  if (MOCK) return [];
  try {
    const res = await fetch(`${API_BASE}/api/scenarios`, { headers: headers(false) });
    if (!res.ok) return [];
    const json = await res.json();
    return (Array.isArray(json) ? json : (json?.scenarios ?? [])) as ScenarioInfo[];
  } catch {
    return [];
  }
}
