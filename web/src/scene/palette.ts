import type { Pod } from '../types';

/** Node colour by `cloud.google.com/machine-family` */
export const FAMILY_COLORS: Record<string, string> = {
  n4: '#3b82f6',
  n4d: '#8b5cf6',
  n2: '#0ea5e9',
  n2d: '#6366f1',
  e2: '#64748b',
  c3: '#10b981',
  c4: '#14b8a6',
  c4d: '#0d9488',
  t2d: '#84cc16',
  pending: '#f59e0b',
};
export function familyColor(family: string | undefined): string {
  return FAMILY_COLORS[family ?? ''] ?? '#475569';
}

/** Pod colour by workload (contracts: `arcade.gke.io/workload`). */
export const WORKLOAD_COLORS: Record<string, string> = {
  climber: '#f59e0b',
  checkout: '#22d3ee',
  pet: '#a78bfa',
  'burst-worker': '#34d399',
  'burst-unit': '#34d399',
  'coin-worker': '#fbbf24',
  stock: '#94a3b8',
  nitro: '#fb7185',
  'arcade-server': '#e2e8f0',
};
const FALLBACK = ['#f472b6', '#38bdf8', '#4ade80', '#facc15', '#c084fc', '#fb923c'];
export function workloadColor(workload: string): string {
  if (WORKLOAD_COLORS[workload]) return WORKLOAD_COLORS[workload];
  let h = 0;
  for (let i = 0; i < workload.length; i++) h = (h * 31 + workload.charCodeAt(i)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}

export function podColor(p: Pod): string {
  if (p.buffer) return '#67e8f9';
  if (p.fallback) return '#fb923c';
  return workloadColor(p.workload);
}

export const PENDING_COLOR = '#fde047';
export const SPOT_STRIPE = '#f8fafc';
export const CREATING_COLOR = '#f59e0b';
export const DRAIN_COLOR = '#ef4444';
export const GHOST_COLOR = '#67e8f9';
export const FLAME_COLOR = '#fb923c';
export const BEAM_COLOR = '#c4b5fd';
