export function ago(iso?: string, nowMs = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  return durationShort(Math.max(0, nowMs - t));
}

/** kubectl-style age: 12s, 3m, 2h, 5d */
export function durationShort(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? (s % 60) + 's' : ''}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? (m % 60) + 'm' : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? (h % 24) + 'h' : ''}`;
}

/** stopwatch mm:ss.t */
export function stopwatch(ms: number): string {
  const t = Math.max(0, ms);
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const d = Math.floor((t % 1000) / 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${d}`;
}

export function secs(ms?: number): string {
  if (ms === undefined || Number.isNaN(ms)) return '—';
  return `${(ms / 1000).toFixed(1)}s`;
}

export function usd(n?: number, digits = 2): string {
  if (n === undefined) return '—';
  return `$${n.toFixed(digits)}`;
}

export function num(n: number): string {
  return n.toLocaleString('en-US');
}

export function cpuCores(s?: string): number {
  if (!s) return 0;
  if (s.endsWith('m')) return parseInt(s, 10) / 1000;
  return parseFloat(s) || 0;
}

/** Minimal YAML emitter for HUD display (objects, arrays, scalars). */
export function toYaml(v: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return v
      .map((item) => {
        const s = toYaml(item, indent + 1);
        if (typeof item === 'object' && item !== null) return `${pad}- ${s.trimStart()}`;
        return `${pad}- ${s}`;
      })
      .join('\n');
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (!entries.length) return '{}';
    return entries
      .map(([k, x]) => {
        if (x !== null && typeof x === 'object' && (Array.isArray(x) ? x.length : Object.keys(x as object).length)) return `${pad}${k}:\n${toYaml(x, indent + 1)}`;
        return `${pad}${k}: ${toYaml(x, indent + 1)}`;
      })
      .join('\n');
  }
  if (typeof v === 'string') return /^[\w.\-/:%|]+$/.test(v) && !/^(true|false|null|\d+)$/.test(v) ? v : JSON.stringify(v);
  return String(v);
}

/** Pad columns like kubectl get. */
export function table(columns: string[], rows: string[][]): string {
  const widths = columns.map((c, i) => Math.max(c.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : (c ?? '').padEnd(widths[i] + 3))).join('');
  return [line(columns), ...rows.map(line)].join('\n');
}
