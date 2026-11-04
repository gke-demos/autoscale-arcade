import { Html, RoundedBoxGeometry } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { MOCK } from '../api';
import { ago, secs, stopwatch } from '../lib/format';
import { ClusterScene, Flame } from '../scene/ClusterScene';
import { SLAB } from '../scene/layout';
import { useArcade } from '../store';
import type { NitroLane, Pod, WorldState } from '../types';
import { ActionButton, Badge, ControlGroup, MissionCard, Stat, eventsSection, nodeTable, shortNodeName, useCabinetLayout, useNow } from './common';
import type { CabinetModule, CabinetProps, HudSection } from './types';

const ACCENT = '#4285f4';
const STOCK = '#9aa0a6';

function lanePod(world: WorldState, lane: NitroLane): Pod | undefined {
  return (lane.pod && world.pods.find((p) => p.name === lane.pod)) || world.pods.find((p) => p.cabinet === 'nitro' && p.workload === lane.name && !p.deleting);
}
function laneMs(lane: NitroLane, nowMs: number): number | undefined {
  const start = lane.createdAt;
  if (!start) return undefined;
  const end = lane.readyAt ? Date.parse(lane.readyAt) : nowMs;
  return Math.max(0, end - Date.parse(start));
}

function laneProgress(lane: NitroLane, lanes: NitroLane[], factor: number, nowMs: number): number {
  if (lane.readyAt) return 1;
  const elapsed = laneMs(lane, nowMs) ?? 0;
  if (elapsed <= 0) return 0;
  const nitroLane = lanes.find((l) => l.name === 'nitro');
  const nitroReadyMs = nitroLane?.readyAt ? laneMs(nitroLane, nowMs) : undefined;
  const boostFactor = Math.max(2, factor || 4);
  const mockSpeed = (typeof window !== 'undefined' && (window as unknown as { __MOCK_SPEED?: number }).__MOCK_SPEED) || 1;
  // Nitro (4x CPU boost: 1000m) finishes warm-up in ~22s on-cluster (~5.9s in mock); Stock (1x CPU: 250m) takes 4x longer.
  const defaultNitroMs = MOCK ? 5900 / mockSpeed : 22000;
  const baseNitroMs = nitroReadyMs && nitroReadyMs > 0 ? nitroReadyMs : defaultNitroMs;
  const expectedMs = lane.name === 'nitro' || lane.boosted ? baseNitroMs : baseNitroMs * boostFactor;
  return Math.min(0.95, elapsed / expectedMs);
}

// ---- 3D: two race lanes in front of the node island --------------------------------

function Scene({ world }: CabinetProps) {
  const layout = useCabinetLayout(world, 'nitro', { extraNodes: (n) => n.pool === 'default-pool' });
  const race = world.cabinets.nitro.race;
  const factor = world.cabinets.nitro.vpa.factor || 4;
  const now = useNow(100);
  const lanes = useMemo<NitroLane[]>(() => race?.lanes ?? [{ name: 'stock', boosted: false }, { name: 'nitro', boosted: true }], [race]);
  const trackLen = 10;
  const z0 = layout.bounds.maxZ + 2.5;

  return (
    <>
      <ClusterScene layout={layout} />
      <group position={[0, 0, z0]}>
        {/* smoked-glass race track */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.44, 1.2]} receiveShadow>
          <planeGeometry args={[trackLen + 2, 4.2]} />
          <meshPhysicalMaterial color="#141821" roughness={0.18} metalness={0.2} clearcoat={0.9} clearcoatRoughness={0.1} transparent opacity={0.92} />
        </mesh>
        {/* finish line (Google Green & Gold) */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[trackLen / 2, -0.43, 1.2]}>
          <planeGeometry args={[0.35, 4.2]} />
          <meshBasicMaterial color="#34a853" transparent opacity={0.85} />
        </mesh>
        <Html position={[trackLen / 2, 0.6, -1]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
          <div className="whitespace-nowrap font-mono text-[0.7rem] tracking-[0.3em] text-emerald-300">🏁 READY=TRUE</div>
        </Html>
        {lanes.map((lane, i) => (
          <Lane key={lane.name} lane={lane} index={i} pod={lanePod(world, lane)} trackLen={trackLen} progress={laneProgress(lane, lanes, factor, now)} winner={race?.winner === lane.name} />
        ))}
      </group>
    </>
  );
}

function Lane({ lane, index, pod, trackLen, progress, winner }: { lane: NitroLane; index: number; pod?: Pod; trackLen: number; progress: number; winner: boolean }) {
  const g = useRef<THREE.Group>(null);
  const z = index === 0 ? 0.2 : 2.2;
  const color = lane.name === 'nitro' ? ACCENT : STOCK;
  const boosted = !!(pod?.boost?.active || (lane.boosted && !lane.readyAt && pod && !pod.ready));
  const x = -trackLen / 2 + progress * trackLen;
  useFrame((_, dt) => {
    if (!g.current) return;
    g.current.position.x += (x - g.current.position.x) * (1 - Math.exp(-dt * 4));
  });
  const size = 0.7;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.42, z]}>
        <planeGeometry args={[trackLen, 1.6]} />
        <meshBasicMaterial color={color} transparent opacity={lane.name === 'nitro' ? 0.16 : 0.08} />
      </mesh>
      <Html position={[-trackLen / 2 - 1.2, 0.2, z]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <div className="whitespace-nowrap text-right font-mono text-[0.75rem]" style={{ color }}>
          <div className="font-black tracking-widest">{lane.name.toUpperCase()}</div>
          <div className="text-[0.6rem] text-slate-400">{lane.name === 'nitro' ? 'VPA startupBoost ×4' : '250m, no boost'}</div>
        </div>
      </Html>
      <group ref={g} position={[x, SLAB.h / 2 + size / 2 + 0.05, z]}>
        <mesh castShadow>
          <RoundedBoxGeometry args={[size, size, size]} radius={0.1} smoothness={3} />
          <meshPhysicalMaterial color={color} emissive={color} emissiveIntensity={pod?.ready ? 0.35 : 0.12} roughness={0.08} metalness={0.14} clearcoat={1} clearcoatRoughness={0.05} reflectivity={1} />
        </mesh>
        {boosted && <Flame pl={{ pod: pod!, pos: [0, 0, 0], size }} scale={1.4} />}
        {pod && !pod.ready && !boosted && (
          <mesh position={[0, size * 0.9, 0]}>
            <sphereGeometry args={[0.08, 8, 8]} />
            <meshBasicMaterial color="#fde047" />
          </mesh>
        )}
        <Html position={[0, size + 0.5, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
          <div className={`whitespace-nowrap rounded-md bg-black/60 px-1.5 py-0.5 font-mono text-[0.65rem] ${winner ? 'text-amber-200' : 'text-slate-200'}`}>
            {winner && '🏆 '}
            {pod ? `${pod.ready ? 'Ready' : (pod.pendingReason ?? (pod.node ? 'warming up' : 'Pending'))} · cpu ${pod.cpu.actual ?? pod.cpu.request}` : 'no pod'}
          </div>
        </Html>
      </group>
    </group>
  );
}

// ---- Controls --------------------------------------------------------------------------

function Controls({ world }: CabinetProps) {
  const n = world.cabinets.nitro;
  const race = n.race;
  const now = useNow(100);
  const racing = !!race && race.lanes.some((l) => !l.readyAt);
  const setPrompt = useArcade((s) => s.setLeaderboardPrompt);
  const prevWinner = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (race && race.lanes.every((l) => l.readyAt) && race.startedAt !== prevWinner.current) {
      prevWinner.current = race.startedAt;
      const nitro = race.lanes.find((l) => l.name === 'nitro');
      const stock = race.lanes.find((l) => l.name === 'stock');
      const nm = nitro ? laneMs(nitro, now) : undefined;
      const sm = stock ? laneMs(stock, now) : undefined;
      if (nm !== undefined && sm !== undefined) setPrompt({ cabinet: 'nitro', score: +(nm / 1000).toFixed(1), unit: 's', label: `Nitro ready in ${secs(nm)} vs stock ${secs(sm)} (${(sm / nm).toFixed(1)}× faster)` });
    }
  }, [race, now, setPrompt]);

  const nitroLane = race?.lanes.find((l) => l.name === 'nitro');
  const stockLane = race?.lanes.find((l) => l.name === 'stock');
  const nitroPod = nitroLane ? lanePod(world, nitroLane) : world.pods.find((p) => p.cabinet === 'nitro' && p.workload === 'nitro' && !p.deleting);
  const unboosted = !!(nitroLane?.unboostedAt || (nitroPod?.boost && !nitroPod.boost.active));
  const isDemo = useArcade((s) => s.mode === 'demo');

  return (
    <>
      <MissionCard
        accent={ACCENT}
        goal={
          isDemo
            ? 'Compare cold-start latency between two identical CPU-bound pods (2M PBKDF2 SHA-256 rounds): stock (250m CPU) vs. nitro with a 4× VPA CPU Startup Boost (250m → 1000m) and in-place resize back to 250m after readiness.'
            : 'Win the cold-start drag race! Both pods run the exact same CPU-bound startup (2M PBKDF2 rounds), but NITRO gets a 4× VPA CPU Startup Boost (250m → 1000m) and then resizes back in-place with 0 restarts.'
        }
        win="Fastest NITRO cold-start time (s) & speedup multiplier vs. STOCK"
        steps={[
          {
            label: isDemo ? 'Rollout-restart both deployments' : 'Start the drag race (🏁 Start race)',
            detail: 'Rollout-restarts both stock (250m) and nitro (boosted to 1000m) simultaneously.',
            done: !!race,
            active: !race,
          },
          {
            label: isDemo ? 'NITRO reaches Ready=True ~3.5× faster' : 'NITRO crosses the Ready=True finish line first',
            detail: '4× CPU boost lets nitro finish its warm-up ~3–4× faster than stock.',
            done: !!nitroLane?.readyAt || race?.winner === 'nitro',
            active: racing && !nitroLane?.readyAt,
          },
          {
            label: 'In-place CPU resize back to 250m (RESTARTS 0)',
            detail: `After ${n.vpa.durationSeconds}s, VPA shrinks nitro's CPU request in-place without restarting the pod.`,
            done: unboosted,
            active: !!nitroLane?.readyAt && !unboosted && !!stockLane,
          },
        ]}
      />

      <ControlGroup title={isDemo ? 'Cold-Start Comparison Trigger' : 'Race'}>
        <ActionButton action="nitro.race" accent={ACCENT} disabled={racing} label={isDemo ? 'Restart both pods' : 'Start race'} className={isDemo ? 'text-[1.05rem]' : 'text-[1.3rem]'}>
          {isDemo ? '▶ Restart Both Pods (Compare Startup)' : '🏁 Start race'}
        </ActionButton>
        <div className="text-[0.85rem] text-slate-400">Rollout-restarts <code>stock</code> and <code>nitro</code>. Both do the same CPU-bound warm-up before Ready; VPA boosts nitro's CPU request ×{n.vpa.factor} at startup, then shrinks it in place.</div>
      </ControlGroup>
      <ControlGroup title={isDemo ? 'Workloads (stock vs. nitro)' : 'Lanes'}>
        <div className="flex flex-col gap-2">
          {(race?.lanes ?? ([{ name: 'stock', boosted: false }, { name: 'nitro', boosted: true }] as NitroLane[])).map((l, _, allLanes) => {
            const ms = laneMs(l, now);
            const pod = lanePod(world, l);
            const color = l.name === 'nitro' ? ACCENT : STOCK;
            const prog = race ? laneProgress(l, allLanes, n.vpa.factor || 4, now) : 0;
            return (
              <div key={l.name} className="rounded-xl border border-line/80 bg-black/30 p-2">
                <div className="flex items-center gap-2">
                  <span className="font-black tracking-widest" style={{ color }}>
                    {l.name.toUpperCase()}
                  </span>
                  {l.boosted && <Badge tone="bg-[#fbbc04]/25 text-[#fde293]">⚡ boost ×{n.vpa.factor}</Badge>}
                  {race?.winner === l.name && <Badge tone="bg-emerald-500/30 text-emerald-100">{isDemo ? '✓ Ready first' : '🏆 winner'}</Badge>}
                  <span className={`ml-auto font-mono text-[1.3rem] font-bold ${l.readyAt ? 'text-lime-300' : ms !== undefined ? 'text-amber-300' : 'text-slate-500'}`}>{ms !== undefined ? stopwatch(ms) : '--:--.-'}</span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full transition-all duration-150"
                    style={{
                      width: `${Math.round(prog * 100)}%`,
                      backgroundColor: l.readyAt ? '#34a853' : color,
                    }}
                  />
                </div>
                <div className="mt-1 grid grid-cols-3 gap-1 font-mono text-[0.68rem] text-slate-400">
                  <span>
                    req <span className="text-slate-100">{pod?.cpu.request ?? l.cpuRequest ?? '—'}</span>
                  </span>
                  <span>
                    actual <span className="text-slate-100">{pod?.cpu.actual ?? pod?.cpu.request ?? '—'}</span>
                  </span>
                  <span>
                    orig <span className="text-slate-100">{pod?.boost?.cpuOriginal ?? l.cpuOriginal ?? '250m'}</span>
                  </span>
                </div>
                {l.unboostedAt && <div className="mt-1 text-[0.68rem] text-emerald-300">↓ unboosted in place {ago(l.unboostedAt, now)} ago · RESTARTS 0</div>}
                {pod && <div className="truncate font-mono text-[0.62rem] text-slate-500">{pod.name} · {pod.node ? shortNodeName(pod.node) : 'unscheduled'}</div>}
              </div>
            );
          })}
        </div>
      </ControlGroup>
      <ControlGroup title="VerticalPodAutoscaler/nitro">
        <div className="flex flex-wrap gap-2">
          <Stat label="startupBoost" value={`×${n.vpa.factor}`} tone="text-[#fde293]" sub={`durationSeconds ${n.vpa.durationSeconds}`} />
          <Stat label="updateMode" value={<span className="text-[0.95rem]">{n.vpa.updateMode}</span>} />
        </div>
      </ControlGroup>
    </>
  );
}

function Status({ world }: CabinetProps) {
  const race = world.cabinets.nitro.race;
  const now = useNow(100);
  if (!race) return null;
  const nitro = race.lanes.find((l) => l.name === 'nitro');
  const stock = race.lanes.find((l) => l.name === 'stock');
  return (
    <>
      <Stat label="nitro" value={<span className={nitro?.readyAt ? 'text-lime-300' : 'text-amber-300'}>{secs(nitro ? laneMs(nitro, now) : undefined)}</span>} tone="text-[#8ab4f8]" />
      <Stat label="stock" value={<span className={stock?.readyAt ? 'text-lime-300' : 'text-amber-300'}>{secs(stock ? laneMs(stock, now) : undefined)}</span>} />
    </>
  );
}

// ---- HUD ---------------------------------------------------------------------------------

function hud(world: WorldState): HudSection[] {
  const n = world.cabinets.nitro;
  const now = Date.now();
  const pods = world.pods.filter((p) => p.cabinet === 'nitro');
  const hosts = new Set(pods.map((p) => p.node));
  return [
    {
      kind: 'table',
      title: 'Pods',
      command: 'kubectl get pods -n arcade-nitro -o custom-columns=NAME:.metadata.name,CPU-REQ:.spec.containers[0].resources.requests.cpu,CPU-ACTUAL:.status.containerStatuses[0].resources.requests.cpu',
      columns: ['NAME', 'READY', 'STATUS', 'CPU-REQ', 'CPU-ACTUAL', 'BOOST', 'AGE'],
      rows: pods.map((p) => [p.name, p.ready ? '1/1' : '0/1', p.deleting ? 'Terminating' : p.phase, p.cpu.request, p.cpu.actual ?? '', p.boost ? (p.boost.active ? `active (${p.boost.cpuOriginal}→${p.boost.cpuRequest})` : 'ended') : '', ago(p.created, now)]),
      highlight: (r) => (r[5].startsWith('active') ? 'text-[#8ab4f8]' : r[1] === '0/1' ? 'text-amber-300' : undefined),
    },
    {
      kind: 'yaml',
      title: 'VerticalPodAutoscaler/nitro',
      command: 'kubectl get vpa nitro -n arcade-nitro -o yaml',
      value: {
        apiVersion: 'autoscaling.k8s.io/v1',
        kind: 'VerticalPodAutoscaler',
        metadata: { name: 'nitro', namespace: 'arcade-nitro' },
        spec: {
          targetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'nitro' },
          updatePolicy: { updateMode: n.vpa.updateMode },
          startupBoost: { cpu: { type: 'Factor', factor: n.vpa.factor, durationSeconds: n.vpa.durationSeconds } },
        },
      },
    },
    {
      kind: 'yaml',
      title: 'Boost annotation on the nitro pod',
      command: "kubectl get pod -n arcade-nitro -l arcade.gke.io/workload=nitro -o jsonpath='{.items[0].metadata.annotations}'",
      value: Object.fromEntries(
        pods
          .filter((p) => p.boost)
          .map((p) => [`${p.name}`, { 'vpaCPUStartupBoost/racer': { requests: { cpu: p.boost!.cpuOriginal } }, boostActive: p.boost!.active, currentRequest: p.boost!.cpuRequest }]),
      ),
    },
    nodeTable(world.nodes.filter((x) => hosts.has(x.name)), now),
    eventsSection(world, 'nitro', now),
  ];
}

export const nitro: CabinetModule = {
  id: 'nitro',
  Scene,
  Controls,
  hud,
  Status,
  hint: 'Start the race: same warm-up, but one pod gets a 4× CPU startup boost.',
  frame: (b) => ({ ...b, minX: Math.min(b.minX, -8), maxX: Math.max(b.maxX, 8), maxZ: b.maxZ + 7 }),
};
