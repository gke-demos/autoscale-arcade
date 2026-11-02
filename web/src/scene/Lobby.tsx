import { Html, RoundedBox } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useArcade } from '../store';
import { CABINETS, CABINET_IDS, type CabinetId, type WorldState } from '../types';
import { ClusterScene } from './ClusterScene';
import { computeLayout } from './layout';
import { CameraRig } from './Stage';

/** Lobby: six arcade cabinets in a semicircle around a live overview of the whole cluster. */
export function Lobby({ world }: { world: WorldState }) {
  const layout = useMemo(() => computeLayout(world.nodes, world.pods, {}), [world.nodes, world.pods]);
  const setView = useArcade((s) => s.setView);
  const clusterW = layout.bounds.maxX - layout.bounds.minX;
  const spacing = 5.6;
  const rowW = spacing * (CABINET_IDS.length - 1);
  const halfW = Math.max(clusterW / 2, rowW / 2 + 2.5);
  const clusterZ = -(layout.bounds.maxZ + 5);
  const framed = useMemo(
    () => ({ ...layout, bounds: { minX: -halfW - 2, maxX: halfW + 2, minZ: clusterZ + layout.bounds.minZ, maxZ: 5 } }),
    [layout, halfW, clusterZ],
  );

  return (
    <>
      <CameraRig layout={framed} viewKey="lobby" elevation={0.62} visible={[0.01, 0.74]} />
      <group position={[0, 0, clusterZ]}>
        <ClusterScene layout={layout} showLabels={false} />
        <Html position={[0, 0.3, layout.bounds.maxZ + 0.8]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
          <div className="whitespace-nowrap rounded-full border border-cyan-300/30 bg-black/60 px-3 py-1 font-mono text-[0.7rem] tracking-[0.25em] text-cyan-200">
            CLUSTER OVERVIEW · {world.nodes.length} NODES · {world.pods.filter((p) => !p.buffer).length} PODS
          </div>
        </Html>
      </group>
      {CABINET_IDS.map((id, i) => {
        const x = -rowW / 2 + i * spacing;
        const z = 2 + Math.abs(x) * 0.08; // gentle arc, outer cabinets slightly closer
        return <Cabinet key={id} id={id} position={[x, 0, z]} rotation={[0, -x * 0.035, 0]} world={world} onOpen={() => setView(id)} />;
      })}
    </>
  );
}

function Cabinet({ id, position, rotation, world, onOpen }: { id: CabinetId; position: [number, number, number]; rotation: [number, number, number]; world: WorldState; onOpen: () => void }) {
  const meta = CABINETS[id];
  const g = useRef<THREE.Group>(null);
  const hover = useRef(false);
  const screenRef = useRef<THREE.MeshStandardMaterial>(null);
  const running = world.scenario.running && world.scenario.cabinet === id;
  const pods = world.pods.filter((p) => p.cabinet === id && !p.buffer);
  const pending = pods.filter((p) => !p.node).length;
  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    if (g.current) {
      const s = hover.current ? 1.06 : 1;
      g.current.scale.lerp(new THREE.Vector3(s, s, s), 1 - Math.exp(-dt * 10));
      g.current.position.y = position[1] + (hover.current ? 0.15 : 0) + 0.03 * Math.sin(t * 1.5 + position[0]);
    }
    if (screenRef.current) screenRef.current.emissiveIntensity = (running ? 1.2 : 0.55) + 0.15 * Math.sin(t * (running ? 8 : 2) + position[0]);
  });
  return (
    <group ref={g} position={position} rotation={rotation}>
      {/* body */}
      <RoundedBox args={[3.2, 4.4, 2.2]} radius={0.12} position={[0, 1.6, 0]} castShadow receiveShadow
        onClick={(e) => { e.stopPropagation(); onOpen(); }}
        onPointerOver={(e) => { e.stopPropagation(); hover.current = true; document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { hover.current = false; document.body.style.cursor = 'auto'; }}>
        <meshStandardMaterial color="#1b2747" roughness={0.5} metalness={0.35} emissive={meta.accent} emissiveIntensity={0.06} />
      </RoundedBox>
      {/* screen */}
      <mesh position={[0, 2.5, 1.12]} rotation={[-0.25, 0, 0]}>
        <planeGeometry args={[2.6, 1.7]} />
        <meshStandardMaterial ref={screenRef} color={meta.accent} emissive={meta.accent} emissiveIntensity={0.6} toneMapped={false} />
      </mesh>
      {/* marquee */}
      <mesh position={[0, 4.0, 1.12]}>
        <planeGeometry args={[3.0, 0.5]} />
        <meshBasicMaterial color={meta.accent} toneMapped={false} />
      </mesh>
      {/* control deck */}
      <mesh position={[0, 1.35, 1.3]} rotation={[-0.9, 0, 0]}>
        <boxGeometry args={[2.8, 0.9, 0.2]} />
        <meshStandardMaterial color="#1e293b" />
      </mesh>
      <mesh position={[-0.7, 1.75, 1.55]}>
        <sphereGeometry args={[0.18, 16, 16]} />
        <meshStandardMaterial color="#ef4444" emissive="#ef4444" emissiveIntensity={0.4} />
      </mesh>
      <mesh position={[0.6, 1.72, 1.5]}>
        <cylinderGeometry args={[0.2, 0.2, 0.1, 20]} />
        <meshStandardMaterial color={meta.accent} emissive={meta.accent} emissiveIntensity={0.5} />
      </mesh>
      <pointLight position={[0, 3.6, 2]} color={meta.accent} intensity={running ? 14 : 6} distance={8} decay={2} />
      <Html position={[0, 2.5, 1.2]} center transform={false} zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
        <div className="w-[14rem] text-center" style={{ transform: 'translateY(-10%)' }}>
          <div className="font-mono text-[0.6rem] tracking-[0.3em] text-slate-300">
            <span className="kbd mr-1">{meta.key}</span>
            {meta.subtitle.toUpperCase()}
          </div>
          <div className="text-[1.25rem] font-black leading-tight text-white drop-shadow-[0_0_12px_rgba(0,0,0,1)]">{meta.title}</div>
          <div className="mt-1 font-mono text-[0.62rem] text-slate-200/80">
            {pods.length} pod{pods.length === 1 ? '' : 's'}
            {pending ? ` · ${pending} pending` : ''}
            {running && <span className="ml-1 animate-blink text-amber-200">▶ running</span>}
          </div>
        </div>
      </Html>
    </group>
  );
}
