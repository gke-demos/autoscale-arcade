import { Html, Instance, Instances, RoundedBox } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Node, Pod } from '../types';
import { SLAB, type IslandLayout, type Layout, type NodeLayout, type PodLayout } from './layout';
import { BEAM_COLOR, CREATING_COLOR, DRAIN_COLOR, FLAME_COLOR, GHOST_COLOR, PENDING_COLOR, familyColor, podColor } from './palette';

// ---------------------------------------------------------------------------
// Shared 3D vocabulary (docs/design.md §3): islands, node slabs, pod cubes,
// ghosts, flames, beams. Everything here is driven purely by WorldState.
// ---------------------------------------------------------------------------

export type NodeHighlight = 'valid' | 'target' | 'origin' | undefined;

export interface SceneProps {
  layout: Layout;
  /** Called on pointer-down on a pod (used for drag-and-drop). */
  onPodPointerDown?: (pod: Pod, e: ThreeEvent<PointerEvent>) => void;
  onPodClick?: (pod: Pod) => void;
  onNodeClick?: (node: Node) => void;
  draggable?: (pod: Pod) => boolean;
  nodeHighlight?: (node: Node) => NodeHighlight;
  /** Hide this pod's cube (it is being dragged and rendered elsewhere). */
  hiddenPod?: string;
  selectedNode?: string;
  showLabels?: boolean;
  dim?: boolean;
}

const tmpColor = new THREE.Color();

// Diagonal stripe texture for Spot nodes, generated once.
let stripeTex: THREE.CanvasTexture | undefined;
function stripeTexture() {
  if (stripeTex) return stripeTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 128);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 10;
  for (let i = -128; i < 256; i += 32) {
    ctx.beginPath();
    ctx.moveTo(i, 128);
    ctx.lineTo(i + 128, 0);
    ctx.stroke();
  }
  stripeTex = new THREE.CanvasTexture(c);
  stripeTex.wrapS = stripeTex.wrapT = THREE.RepeatWrapping;
  stripeTex.repeat.set(3, 3);
  return stripeTex;
}

// ---- Island ---------------------------------------------------------------

export function Island({ island, showLabels = true }: { island: IslandLayout; showLabels?: boolean }) {
  const [cx, cz] = island.center;
  const anyCreating = island.nodes.some((n) => n.node.creating);
  return (
    <group position={[cx, 0, cz]}>
      <RoundedBox args={[island.w, 0.3, island.d]} radius={0.15} smoothness={3} position={[0, -0.45, 0]} receiveShadow>
        <meshStandardMaterial color="#121a30" roughness={0.9} metalness={0.1} emissive={anyCreating ? CREATING_COLOR : '#0b1020'} emissiveIntensity={anyCreating ? 0.15 : 0.6} />
      </RoundedBox>
      {/* neon edge */}
      <mesh position={[0, -0.3, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[Math.max(island.w, island.d) * 0.02, Math.max(island.w, island.d) * 0.021, 4]} />
        <meshBasicMaterial color="#1e293b" transparent opacity={0} />
      </mesh>
      {showLabels && (
        <Html position={[0, -0.2, island.d / 2 + 0.35]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
          <div className="whitespace-nowrap text-center" style={{ transform: 'translateY(-10%)' }}>
            <div className="font-mono text-[0.95rem] font-bold tracking-wide text-slate-100 drop-shadow-[0_0_6px_rgba(0,0,0,0.9)]">{island.label}</div>
            {island.sublabel && <div className="font-mono text-[0.7rem] text-slate-400 drop-shadow-[0_0_6px_rgba(0,0,0,0.9)]">{island.sublabel}</div>}
          </div>
        </Html>
      )}
    </group>
  );
}

// ---- Node slab ------------------------------------------------------------

export function NodeSlab({
  nl,
  highlight,
  selected,
  onClick,
  showLabel = true,
}: {
  nl: NodeLayout;
  highlight?: NodeHighlight;
  selected?: boolean;
  onClick?: (n: Node) => void;
  showLabel?: boolean;
}) {
  const n = nl.node;
  const ref = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshStandardMaterial>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const base = n.creating ? CREATING_COLOR : familyColor(n.machineFamily);
  const draining = n.deleting || n.unschedulable;
  const util = n.cpu.allocatable ? Math.min(1, n.cpu.requested / n.cpu.allocatable) : 0;

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const m = matRef.current;
    if (!m) return;
    if (n.creating) {
      // amber creation pulse
      m.emissive.set(CREATING_COLOR);
      m.emissiveIntensity = 0.35 + 0.35 * Math.sin(t * 4);
      m.opacity = 0.55 + 0.15 * Math.sin(t * 4);
    } else if (draining) {
      // red drain dissolve
      m.emissive.set(DRAIN_COLOR);
      m.emissiveIntensity = 0.5 + 0.3 * Math.sin(t * 6);
      m.opacity = n.deleting ? 0.25 + 0.2 * Math.sin(t * 3) : 0.6;
    } else if (n.suspended) {
      m.emissive.set('#0ea5e9');
      m.emissiveIntensity = 0.08;
      m.opacity = 0.35;
    } else {
      tmpColor.set(highlight === 'target' ? '#ffffff' : highlight === 'valid' ? '#a78bfa' : highlight === 'origin' ? '#facc15' : base);
      m.emissive.lerp(tmpColor, 0.15);
      const target = highlight === 'target' ? 1.2 : highlight === 'valid' ? 0.7 + 0.25 * Math.sin(t * 5) : highlight === 'origin' ? 0.6 : selected ? 0.7 : 0.4;
      m.emissiveIntensity += (target - m.emissiveIntensity) * 0.2;
      m.opacity += (0.9 - m.opacity) * 0.1;
    }
    if (ringRef.current) {
      const s = highlight === 'target' ? 1.08 + 0.03 * Math.sin(t * 10) : 1.04;
      ringRef.current.scale.set(s, 1, s);
      ringRef.current.visible = !!highlight;
    }
  });

  return (
    <group position={nl.pos}>
      <mesh
        ref={ref}
        castShadow
        receiveShadow
        onClick={(e) => {
          e.stopPropagation();
          onClick?.(n);
        }}
      >
        <boxGeometry args={[SLAB.w, SLAB.h, SLAB.d]} />
        <meshStandardMaterial ref={matRef} color={base} emissive={base} emissiveIntensity={0.2} roughness={0.25} metalness={0.3} transparent opacity={0.9} />
      </mesh>
      {/* glass top sheen */}
      <mesh position={[0, SLAB.h / 2 + 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[SLAB.w - 0.1, SLAB.d - 0.1]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.08} />
      </mesh>
      {/* spot stripe */}
      {n.spot && (
        <mesh position={[0, SLAB.h / 2 + 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[SLAB.w - 0.1, SLAB.d - 0.1]} />
          <meshBasicMaterial map={stripeTexture()} transparent opacity={0.35} depthWrite={false} />
        </mesh>
      )}
      {/* utilisation bar on the front face */}
      <mesh position={[-SLAB.w / 2 + (SLAB.w * util) / 2, -SLAB.h / 2 + 0.04, SLAB.d / 2 + 0.01]}>
        <planeGeometry args={[Math.max(0.01, SLAB.w * util), 0.07]} />
        <meshBasicMaterial color={util > 0.85 ? '#f87171' : '#22d3ee'} />
      </mesh>
      {/* highlight ring */}
      <mesh ref={ringRef} position={[0, -SLAB.h / 2 + 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <ringGeometry args={[SLAB.w * 0.68, SLAB.w * 0.74, 48]} />
        <meshBasicMaterial color={highlight === 'target' ? '#ffffff' : '#a78bfa'} transparent opacity={0.9} side={THREE.DoubleSide} />
      </mesh>
      {showLabel && (
        <Html position={[0, SLAB.h / 2 + 0.05, SLAB.d / 2 - 0.25]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
          <div className="flex items-center gap-1 whitespace-nowrap rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[0.62rem] text-slate-200">
            {n.suspended && <span title="Suspended">❄</span>}
            {n.creating && <span className="text-amber-300 animate-blink">●</span>}
            {draining && <span className="text-red-400">⛔</span>}
            {n.gvisor && <span className="text-violet-300">⬡</span>}
            <span>{shortNode(n.name)}</span>
            <span className="text-slate-400">{n.machineType}</span>
            {n.spot && <span className="text-amber-200">spot</span>}
          </div>
        </Html>
      )}
    </group>
  );
}

export function shortNode(name: string) {
  // gke-autoscale-arcade-gvisor-pool-1a2b3c4d-xyz1 → gvisor-pool…xyz1
  const m = name.match(/^gke-[^-]+(?:-[^-]+)*?-([a-z0-9-]+?)-([0-9a-f]{8})-([a-z0-9]{4})$/);
  if (m) return `${m[1]}…${m[3]}`;
  if (name.startsWith('pending-')) return name.replace(/^pending-/, '⏳ ');
  const g = name.match(/^gke-(?:autoscale-)?arcade-(.+)$/);
  if (g) return g[1];
  return name.length > 26 ? `…${name.slice(-22)}` : name;
}

// ---- Pods (instanced) -----------------------------------------------------

interface PodInstanceProps {
  pl: PodLayout;
  draggable?: boolean;
  hidden?: boolean;
  onPointerDown?: (pod: Pod, e: ThreeEvent<PointerEvent>) => void;
  onClick?: (pod: Pod) => void;
}

function PodInstance({ pl, draggable, hidden, onPointerDown, onClick }: PodInstanceProps) {
  const ref = useRef<THREE.Object3D & { color: THREE.Color }>(null);
  const spawn = useRef(true);
  const color = podColor(pl.pod);
  const target = useMemo(() => new THREE.Vector3(...pl.pos), [pl.pos]);
  const hover = useRef(false);

  useFrame((_, dt) => {
    const o = ref.current;
    if (!o) return;
    const k = 1 - Math.exp(-dt * 8);
    if (spawn.current) {
      o.position.set(pl.pos[0], pl.pos[1] + 4, pl.pos[2]);
      o.scale.setScalar(0.001);
      spawn.current = false;
    }
    o.position.lerp(target, k);
    const s = hidden ? 0.001 : pl.pod.deleting ? 0.001 : pl.size * (hover.current ? 1.15 : 1) * (pl.pod.ready ? 1 : 0.85);
    o.scale.x += (s - o.scale.x) * k;
    o.scale.y += (s - o.scale.y) * k;
    o.scale.z += (s - o.scale.z) * k;
    tmpColor.set(color);
    if (!pl.pod.ready && !pl.pod.deleting) tmpColor.lerp(new THREE.Color(PENDING_COLOR), 0.5);
    if (pl.pod.deleting) tmpColor.set(DRAIN_COLOR);
    o.color.lerp(tmpColor, 0.2);
  });

  return (
    <Instance
      ref={ref}
      onPointerDown={(e) => {
        if (!onPointerDown) return;
        e.stopPropagation();
        onPointerDown(pl.pod, e);
      }}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(pl.pod);
      }}
      onPointerOver={(e) => {
        if (draggable || onClick) {
          e.stopPropagation();
          hover.current = true;
          document.body.style.cursor = draggable ? 'grab' : 'pointer';
        }
      }}
      onPointerOut={() => {
        hover.current = false;
        document.body.style.cursor = 'auto';
      }}
    />
  );
}

function GhostInstance({ pl }: { pl: PodLayout }) {
  const ref = useRef<THREE.Object3D & { color: THREE.Color }>(null);
  useFrame(({ clock }) => {
    const o = ref.current;
    if (!o) return;
    o.position.set(pl.pos[0], pl.pos[1] + 0.03 * Math.sin(clock.elapsedTime * 2 + pl.pos[0]), pl.pos[2]);
    o.scale.setScalar(pl.size);
  });
  return <Instance ref={ref} color={GHOST_COLOR} />;
}

export function Pods({ layout, onPodPointerDown, onPodClick, draggable, hiddenPod }: SceneProps) {
  const all = [...layout.pods.values()];
  const solid = all.filter((p) => !p.pod.buffer);
  const ghosts = all.filter((p) => p.pod.buffer);
  return (
    <>
      <Instances limit={600} range={solid.length} castShadow receiveShadow frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.35} metalness={0.15} emissive="#ffffff" emissiveIntensity={0.18} toneMapped={false} />
        {solid.map((pl) => (
          <PodInstance key={pl.pod.uid} pl={pl} draggable={draggable?.(pl.pod)} hidden={hiddenPod === pl.pod.uid} onPointerDown={draggable?.(pl.pod) ? onPodPointerDown : undefined} onClick={onPodClick} />
        ))}
      </Instances>
      <Instances limit={200} range={ghosts.length} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial transparent opacity={0.22} roughness={0.1} metalness={0.4} emissive={GHOST_COLOR} emissiveIntensity={0.35} depthWrite={false} />
        {ghosts.map((pl) => (
          <GhostInstance key={pl.pod.uid} pl={pl} />
        ))}
      </Instances>
      {/* ghost wire outlines */}
      {ghosts.map((pl) => (
        <lineSegments key={`w-${pl.pod.uid}`} position={pl.pos} scale={pl.size}>
          <edgesGeometry args={[new THREE.BoxGeometry(1, 1, 1)]} />
          <lineBasicMaterial color={GHOST_COLOR} transparent opacity={0.5} />
        </lineSegments>
      ))}
      {/* pending halos */}
      {all
        .filter((p) => !p.pod.ready && !p.pod.deleting && !p.pod.buffer && p.pod.phase !== 'Succeeded')
        .map((pl) => (
          <Halo key={`h-${pl.pod.uid}`} pl={pl} />
        ))}
      {/* nitro flames */}
      {all
        .filter((p) => p.pod.boost?.active)
        .map((pl) => (
          <Flame key={`f-${pl.pod.uid}`} pl={pl} />
        ))}
    </>
  );
}

function Halo({ pl }: { pl: PodLayout }) {
  const ref = useRef<THREE.Mesh>(null);
  const unschedulable = pl.pod.pendingReason === 'Unschedulable' || pl.pod.pendingReason === 'TriggeredScaleUp';
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    const t = clock.elapsedTime * 2 + pl.pos[0];
    const s = pl.size * (1.3 + 0.35 * ((t % 1) + 0));
    m.scale.set(s, s, s);
    (m.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - (t % 1));
    m.position.set(pl.pos[0], pl.pos[1] - pl.size / 2 + 0.02, pl.pos[2]);
  });
  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.45, 0.55, 32]} />
      <meshBasicMaterial color={unschedulable ? '#fb923c' : PENDING_COLOR} transparent opacity={0.6} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  );
}

export function Flame({ pl, scale = 1 }: { pl: PodLayout; scale?: number }) {
  const g = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    g.current?.children.forEach((c, i) => {
      const s = 0.8 + 0.4 * Math.sin(t * 14 + i * 1.7);
      c.scale.set(s, 1 + 0.5 * Math.sin(t * 11 + i), s);
      c.position.y = 0.1 * Math.sin(t * 9 + i);
    });
  });
  const size = pl.size * scale;
  return (
    <group ref={g} position={[pl.pos[0], pl.pos[1] + size * 0.5, pl.pos[2]]}>
      <mesh position={[0, size * 0.6, 0]}>
        <coneGeometry args={[size * 0.45, size * 1.4, 10]} />
        <meshBasicMaterial color={FLAME_COLOR} transparent opacity={0.85} toneMapped={false} />
      </mesh>
      <mesh position={[0, size * 0.5, 0]}>
        <coneGeometry args={[size * 0.25, size * 0.9, 10]} />
        <meshBasicMaterial color="#fde68a" transparent opacity={0.95} toneMapped={false} />
      </mesh>
      <pointLight color={FLAME_COLOR} intensity={2.5} distance={4} decay={2} />
    </group>
  );
}

// ---- Particle beam (snapshot/restore) --------------------------------------

export function Beam({ from, to, active, color = BEAM_COLOR, count = 140, reverse = false }: { from: [number, number, number]; to: [number, number, number]; active: boolean; color?: string; count?: number; reverse?: boolean }) {
  const ref = useRef<THREE.Points>(null);
  const positions = useMemo(() => new Float32Array(count * 3), [count]);
  const seeds = useMemo(() => Array.from({ length: count }, () => ({ t: Math.random(), r: Math.random() * 0.35, a: Math.random() * Math.PI * 2, v: 0.25 + Math.random() * 0.4 })), [count]);
  const a = useMemo(() => new THREE.Vector3(...from), [from]);
  const b = useMemo(() => new THREE.Vector3(...to), [to]);
  const ctrl = useMemo(() => new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5).add(new THREE.Vector3(0, Math.max(3, a.distanceTo(b) * 0.45), 0)), [a, b]);
  const curve = useMemo(() => new THREE.QuadraticBezierCurve3(a, ctrl, b), [a, ctrl, b]);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    const p = ref.current;
    if (!p) return;
    const geo = p.geometry;
    const attr = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < count; i++) {
      const s = seeds[i];
      if (active) s.t = (s.t + dt * s.v) % 1;
      const tt = reverse ? 1 - s.t : s.t;
      curve.getPoint(tt, tmp);
      attr.setXYZ(i, tmp.x + Math.cos(s.a + tt * 10) * s.r, tmp.y + Math.sin(s.a + tt * 10) * s.r, tmp.z + Math.sin(s.a) * s.r);
    }
    attr.needsUpdate = true;
    const mat = p.material as THREE.PointsMaterial;
    mat.opacity += ((active ? 0.95 : 0) - mat.opacity) * 0.1;
    p.visible = mat.opacity > 0.02;
  });
  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} count={count} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial color={color} size={0.14} transparent opacity={0} sizeAttenuation depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
    </points>
  );
}

// ---- Whole cluster view ---------------------------------------------------

export function ClusterScene(props: SceneProps) {
  const { layout, nodeHighlight, onNodeClick, selectedNode, showLabels = true } = props;
  return (
    <group>
      {layout.islands.map((isl) => (
        <group key={isl.key}>
          <Island island={isl} showLabels={showLabels} />
          {isl.nodes.map((nl) => (
            <NodeSlab key={nl.node.name} nl={nl} highlight={nodeHighlight?.(nl.node)} selected={selectedNode === nl.node.name} onClick={onNodeClick} showLabel={showLabels} />
          ))}
        </group>
      ))}
      <Pods {...props} />
      {layout.pending.length > 0 && (
        <Html position={[0, 0.2, layout.bounds.maxZ - 0.6]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
          <div className="whitespace-nowrap rounded-full border border-amber-400/40 bg-black/60 px-3 py-1 font-mono text-[0.75rem] text-amber-200">
            ⏳ {layout.pending.length} Pending · {summarisePending(layout.pending.map((p) => p.pod))}
          </div>
        </Html>
      )}
    </group>
  );
}

function summarisePending(pods: Pod[]) {
  const counts = new Map<string, number>();
  pods.forEach((p) => counts.set(p.pendingReason ?? 'Pending', (counts.get(p.pendingReason ?? 'Pending') ?? 0) + 1));
  return [...counts.entries()].map(([k, v]) => `${k} ×${v}`).join(' · ');
}
