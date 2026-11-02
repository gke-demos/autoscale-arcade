import type { Node, Pod } from '../types';

export const SLAB = { w: 3.2, h: 0.35, d: 3.2, gap: 0.9 };
export const ISLAND_GAP = 2.2;
export const POD_MAX = 0.62;

export interface PodLayout {
  pod: Pod;
  pos: [number, number, number];
  size: number;
}
export interface NodeLayout {
  node: Node;
  pos: [number, number, number];
  pods: PodLayout[];
}
export interface IslandLayout {
  key: string;
  label: string;
  sublabel?: string;
  center: [number, number];
  w: number;
  d: number;
  nodes: NodeLayout[];
}
export interface Layout {
  islands: IslandLayout[];
  nodes: Map<string, NodeLayout>;
  pods: Map<string, PodLayout>;
  pending: PodLayout[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export interface LayoutOptions {
  /** Island grouping key; default: compute class, else node pool. */
  groupKey?: (n: Node) => string;
  groupLabel?: (key: string, nodes: Node[]) => { label: string; sublabel?: string };
  /** Stable order of islands (keys listed first appear first). */
  order?: string[];
  /** Where pending pods are parked (z in front of the islands). */
  pendingColumns?: number;
}

export function defaultGroupKey(n: Node): string {
  return n.computeClass ? `cc:${n.computeClass}` : `pool:${n.pool}`;
}

export function defaultGroupLabel(key: string, nodes: Node[]) {
  const n = nodes[0];
  if (key.startsWith('cc:')) return { label: key.slice(3), sublabel: `ComputeClass · ${[...new Set(nodes.map((x) => x.pool))].join(', ')}` };
  return { label: n?.pool ?? key.slice(5), sublabel: n ? `${n.machineType}${n.gvisor ? ' · gVisor' : ''}` : undefined };
}

/** Deterministic grid layout: islands in a row along X, nodes in a grid per island, pods in a grid per node. */
export function computeLayout(nodes: Node[], pods: Pod[], opts: LayoutOptions = {}): Layout {
  const groupKey = opts.groupKey ?? defaultGroupKey;
  const groupLabel = opts.groupLabel ?? defaultGroupLabel;
  const groups = new Map<string, Node[]>();
  for (const n of nodes) {
    const k = groupKey(n);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(n);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = opts.order?.indexOf(a) ?? -1;
    const ib = opts.order?.indexOf(b) ?? -1;
    if (ia !== ib) return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
    return a.localeCompare(b);
  });

  const byNode = new Map<string, Pod[]>();
  const pending: Pod[] = [];
  for (const p of pods) {
    if (p.node) {
      if (!byNode.has(p.node)) byNode.set(p.node, []);
      byNode.get(p.node)!.push(p);
    } else pending.push(p);
  }

  const islands: IslandLayout[] = [];
  const nodeMap = new Map<string, NodeLayout>();
  const podMap = new Map<string, PodLayout>();

  // size each island
  const sized = keys.map((k) => {
    const ns = [...groups.get(k)!].sort((a, b) => a.name.localeCompare(b.name));
    const cols = Math.max(1, Math.ceil(Math.sqrt(ns.length)));
    const rows = Math.max(1, Math.ceil(ns.length / cols));
    const w = cols * SLAB.w + (cols - 1) * SLAB.gap + 1.2;
    const d = rows * SLAB.d + (rows - 1) * SLAB.gap + 1.2;
    return { k, ns, cols, rows, w, d };
  });
  const totalW = sized.reduce((a, s) => a + s.w, 0) + Math.max(0, sized.length - 1) * ISLAND_GAP;
  let x = -totalW / 2;
  let maxD = 0;
  for (const s of sized) {
    const cx = x + s.w / 2;
    const cz = 0;
    const island: IslandLayout = { key: s.k, ...groupLabel(s.k, s.ns), center: [cx, cz], w: s.w, d: s.d, nodes: [] };
    s.ns.forEach((n, i) => {
      const c = i % s.cols;
      const r = Math.floor(i / s.cols);
      const nx = cx - ((s.cols - 1) * (SLAB.w + SLAB.gap)) / 2 + c * (SLAB.w + SLAB.gap);
      const nz = cz - ((s.rows - 1) * (SLAB.d + SLAB.gap)) / 2 + r * (SLAB.d + SLAB.gap);
      const nl: NodeLayout = { node: n, pos: [nx, 0, nz], pods: [] };
      const ps = (byNode.get(n.name) ?? []).sort((a, b) => a.name.localeCompare(b.name));
      const k = Math.max(2, Math.ceil(Math.sqrt(ps.length)));
      const cell = (SLAB.w - 0.5) / k;
      const size = Math.min(POD_MAX, cell * 0.78);
      ps.forEach((p, j) => {
        const pc = j % k;
        const pr = Math.floor(j / k);
        const px = nx - ((k - 1) * cell) / 2 + pc * cell;
        const pz = nz - ((k - 1) * cell) / 2 + pr * cell;
        const pl: PodLayout = { pod: p, pos: [px, SLAB.h / 2 + size / 2 + 0.02, pz], size };
        nl.pods.push(pl);
        podMap.set(p.uid, pl);
      });
      island.nodes.push(nl);
      nodeMap.set(n.name, nl);
    });
    islands.push(island);
    x += s.w + ISLAND_GAP;
    maxD = Math.max(maxD, s.d);
  }

  // pending pods hover in a row in front of the islands
  const pcols = opts.pendingColumns ?? 12;
  const pendingLayout: PodLayout[] = pending
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p, i) => {
      const c = i % pcols;
      const r = Math.floor(i / pcols);
      const px = -((Math.min(pending.length, pcols) - 1) * 0.9) / 2 + c * 0.9;
      const pz = maxD / 2 + 2.2 + r * 0.9;
      const pl: PodLayout = { pod: p, pos: [px, 1.2, pz], size: 0.5 };
      podMap.set(p.uid, pl);
      return pl;
    });

  const halfW = Math.max(totalW / 2, 4);
  return {
    islands,
    nodes: nodeMap,
    pods: podMap,
    pending: pendingLayout,
    bounds: { minX: -halfW, maxX: halfW, minZ: -maxD / 2 - 1, maxZ: maxD / 2 + (pending.length ? 3.5 : 1) },
  };
}
