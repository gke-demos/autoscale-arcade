import type { CabinetId } from '../types';
import { eventsSection, nodeTable, podTable, useCabinetLayout } from './common';
import { ClusterScene } from '../scene/ClusterScene';
import type { CabinetModule, CabinetProps } from './types';

/** Minimal cabinet used until the real module lands: generic scene + kubectl tables. */
export function placeholder(id: CabinetId, hint: string): CabinetModule {
  function Scene({ world }: CabinetProps) {
    const layout = useCabinetLayout(world, id);
    return <ClusterScene layout={layout} />;
  }
  function Controls() {
    return <div className="text-slate-400">Controls for {id} coming soon.</div>;
  }
  return {
    id,
    Scene,
    Controls,
    hint,
    hud: (world) => {
      const now = Date.now();
      const pods = world.pods.filter((p) => p.cabinet === id);
      const hosts = new Set(pods.map((p) => p.node));
      return [podTable(pods, now), nodeTable(world.nodes.filter((n) => hosts.has(n.name) || n.computeClass === `arcade-${id}`), now), eventsSection(world, id, now)];
    },
  };
}
