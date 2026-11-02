import type { Pod } from '../types';

/**
 * Primary Google color palette:
 *   Blue   #4285f4
 *   Green  #34a853
 *   Yellow #fbbc04
 *   Red    #ea4335
 *   Grey   #5f6368 / #9aa0a6
 */

/** Node colour by `cloud.google.com/machine-family` */
export const FAMILY_COLORS: Record<string, string> = {
  n4: '#4285f4',
  n4d: '#34a853',
  n2: '#1a73e8',
  n2d: '#1e8e3e',
  e2: '#5f6368',
  c3: '#fbbc04',
  c4: '#fbbc04',
  c4d: '#34a853',
  t2d: '#34a853',
  pending: '#fbbc04',
};
export function familyColor(family: string | undefined): string {
  return FAMILY_COLORS[family ?? ''] ?? '#5f6368';
}

/** Pod colour by workload (contracts: `arcade.gke.io/workload`). */
export const WORKLOAD_COLORS: Record<string, string> = {
  climber: '#4285f4',
  checkout: '#34a853',
  pet: '#fbbc04',
  'burst-worker': '#4285f4',
  'burst-unit': '#8ab4f8',
  'coin-worker': '#fbbc04',
  stock: '#9aa0a6',
  nitro: '#ea4335',
  'arcade-server': '#e8eaed',
};
const FALLBACK = ['#4285f4', '#34a853', '#fbbc04', '#ea4335', '#8ab4f8', '#81c995'];
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
export const FLAME_COLOR = '#ea4335';
export const BEAM_COLOR = '#4285f4';
