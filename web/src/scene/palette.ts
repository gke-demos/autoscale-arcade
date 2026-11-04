import type { Pod } from '../types';

/**
 * Primary Google color palette for features & 3D elements:
 *   Blue   #4285f4  (accent / sapphire glass / electric cyan #669df6 / #8ab4f8)
 *   Green  #34a853  (accent / emerald glass / mint #5bb974 / #81c995)
 *   Yellow #fbbc04  (accent / amber-gold glass / solar #fde293)
 *   Grey   #5f6368 / #9aa0a6
 *
 * Note: Google Red (#ea4335) is reserved strictly for negative/fault states
 * (node draining/deleting, stockout, or locked rung) — never as a feature highlight.
 */

/** Deep smoked-glass body tint for 3D Node slabs (creates rich contrast beneath jewel pod cubes) */
export const NODE_GLASS_COLORS: Record<string, string> = {
  n4: '#0e1b33',      // Deep Sapphire Smoked Glass (Google Blue family)
  n4d: '#0c2118',     // Deep Emerald Smoked Glass (Google Green family)
  n2: '#112240',      // Deep Cobalt Smoked Glass
  n2d: '#0d241c',     // Deep Jade Smoked Glass
  e2: '#141923',      // Obsidian Slate Smoked Glass
  c3: '#241b0b',      // Deep Amber Smoked Glass (Google Yellow family)
  c4: '#241b0b',
  c4d: '#0c2118',
  t2d: '#0c2118',
  pending: '#241b0b',
};

export function nodeGlassColor(family: string | undefined): string {
  return NODE_GLASS_COLORS[family ?? ''] ?? '#141923';
}

/** Luminous Google-color neon edge-rim & glow by `cloud.google.com/machine-family` */
export const FAMILY_COLORS: Record<string, string> = {
  n4: '#4285f4',
  n4d: '#34a853',
  n2: '#669df6',
  n2d: '#5bb974',
  e2: '#8ab4f8',
  c3: '#fbbc04',
  c4: '#fbbc04',
  c4d: '#34a853',
  t2d: '#34a853',
  pending: '#fbbc04',
};
export function familyColor(family: string | undefined): string {
  return FAMILY_COLORS[family ?? ''] ?? '#8ab4f8';
}

/** High-gloss jewel pod colour by workload (contracts: `arcade.gke.io/workload`). */
export const WORKLOAD_COLORS: Record<string, string> = {
  climber: '#4285f4',
  checkout: '#34a853',
  pet: '#fbbc04',
  'burst-worker': '#4285f4',
  'burst-unit': '#8ab4f8',
  'coin-worker': '#fbbc04',
  stock: '#9aa0a6',
  nitro: '#4285f4',
  'metric-worker': '#34a853',
  'arcade-server': '#e8eaed',
};
const FALLBACK = ['#4285f4', '#34a853', '#fbbc04', '#669df6', '#5bb974'];
export function workloadColor(workload: string): string {
  if (WORKLOAD_COLORS[workload]) return WORKLOAD_COLORS[workload];
  let h = 0;
  for (let i = 0; i < workload.length; i++) h = (h * 31 + workload.charCodeAt(i)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}

export function podColor(p: Pod): string {
  if (p.buffer) return '#8ab4f8';
  if (p.fallback) return '#fbbc04';
  if (p.workload === 'checkout' && p.spot === false) return '#4285f4';
  return workloadColor(p.workload);
}

export const PENDING_COLOR = '#fbbc04';
export const SPOT_STRIPE = '#f8f9fa';
export const CREATING_COLOR = '#fbbc04';
export const DRAIN_COLOR = '#ea4335';
export const GHOST_COLOR = '#8ab4f8';
export const FLAME_COLOR = '#fbbc04';
export const FLAME_CORE_COLOR = '#8ab4f8';
export const BEAM_COLOR = '#4285f4';
