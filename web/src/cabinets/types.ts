import type { ComponentType } from 'react';
import type { Layout } from '../scene/layout';
import type { CabinetId, WorldState } from '../types';

/** One block in the right-rail HUD: a kubectl-style table, a YAML dump or key/values. */
export type HudSection =
  | { kind: 'table'; title: string; command?: string; columns: string[]; rows: string[][]; highlight?: (row: string[]) => string | undefined }
  | { kind: 'yaml'; title: string; command?: string; value: unknown }
  | { kind: 'kv'; title: string; items: [string, string, string?][] }; // [key, value, tone]

export interface CabinetProps {
  world: WorldState;
}

/**
 * Every cabinet implements this. Scene is rendered inside the shared <Stage>
 * (3D), Controls in the left DOM panel, hud() feeds the right rail and
 * Status (optional) adds stopwatch/cost meters to the bottom bar.
 */
export interface CabinetModule {
  id: CabinetId;
  Scene: ComponentType<CabinetProps>;
  Controls: ComponentType<CabinetProps>;
  hud: (world: WorldState) => HudSection[];
  Status?: ComponentType<CabinetProps>;
  /** Short one-line hint shown under the cabinet title. */
  hint: string;
  /** Optional: widen the camera framing beyond the node layout (e.g. for a race track). */
  frame?: (bounds: Layout['bounds']) => Layout['bounds'];
}
