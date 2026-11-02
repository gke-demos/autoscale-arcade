import { ContactShadows, Grid, OrbitControls, PerspectiveCamera } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { useArcade } from '../store';
import type { Layout } from './layout';

/** Full-screen R3F canvas with the shared lights/floor. DPR is capped at 2 for the Chromebook GPU. */
export function Stage({ children, autoRotate = false }: { children: ReactNode; autoRotate?: boolean }) {
  const dragging = useArcade((s) => !!s.drag);
  return (
    <Canvas
      shadows={{ type: THREE.PCFSoftShadowMap }}
      dpr={[1, 2]}
      gl={{ antialias: true, powerPreference: 'high-performance', alpha: false }}
      onCreated={({ gl }) => {
        gl.setClearColor('#070a14');
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.35;
      }}
      onPointerMissed={() => useArcade.getState().touch()}
      style={{ position: 'absolute', inset: 0 }}
    >
      <PerspectiveCamera makeDefault fov={38} position={[0, 14, 22]} near={0.1} far={200} />
      <fog attach="fog" args={['#070a14', 45, 110]} />
      <ambientLight intensity={0.7} />
      <hemisphereLight args={['#bfdbfe', '#1e293b', 0.8]} />
      <directionalLight position={[12, 20, 8]} intensity={2.2} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-25} shadow-camera-right={25} shadow-camera-top={25} shadow-camera-bottom={-25} />
      <pointLight position={[-15, 8, -10]} intensity={60} color="#22d3ee" />
      <pointLight position={[15, 6, -12]} intensity={50} color="#a78bfa" />
      <Grid position={[0, -0.6, 0]} args={[120, 120]} cellSize={1} cellThickness={0.6} cellColor="#16213d" sectionSize={6} sectionThickness={1.1} sectionColor="#1e3a8a" fadeDistance={60} fadeStrength={1.5} infiniteGrid />
      <ContactShadows position={[0, -0.59, 0]} opacity={0.5} scale={60} blur={2.4} far={6} color="#000000" />
      <OrbitControls makeDefault enabled={!dragging} enablePan={false} minDistance={8} maxDistance={60} minPolarAngle={0.35} maxPolarAngle={Math.PI / 2.25} autoRotate={autoRotate && !dragging} autoRotateSpeed={0.5} enableDamping dampingFactor={0.08} />
      {children}
    </Canvas>
  );
}

/**
 * Smoothly frames the camera on a layout's bounds whenever the view changes.
 * xShift moves the framed centre to the right (fraction of span) so the scene
 * sits in the gap between the left controls panel and the right HUD rail.
 */
export function CameraRig({ layout, viewKey, elevation = 0.75, xShift = 0.08 }: { layout: Layout; viewKey: string; elevation?: number; xShift?: number }) {
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null;
  const camera = useThree((s) => s.camera);
  const goal = useRef({ pos: new THREE.Vector3(0, 14, 22), target: new THREE.Vector3(0, 0, 0), active: false, started: 0 });
  const lastKey = useRef('');

  useEffect(() => {
    const b = layout.bounds;
    const w = b.maxX - b.minX;
    const d = b.maxZ - b.minZ;
    const span = Math.max(w, d * 1.3, 10);
    const cx = (b.maxX + b.minX) / 2 + span * xShift;
    const cz = (b.maxZ + b.minZ) / 2;
    const dist = span * 0.95 + 6;
    goal.current.target.set(cx, 0.3, cz);
    goal.current.pos.set(cx, dist * elevation, cz + dist * 0.85);
    if (lastKey.current !== viewKey) {
      goal.current.active = true;
      goal.current.started = performance.now();
      lastKey.current = viewKey;
    }
  }, [layout, viewKey, elevation, xShift]);

  useFrame((_, dt) => {
    const g = goal.current;
    if (!g.active || !controls) return;
    const k = 1 - Math.exp(-dt * 3);
    camera.position.lerp(g.pos, k);
    controls.target.lerp(g.target, k);
    controls.update();
    if (camera.position.distanceTo(g.pos) < 0.05 || performance.now() - g.started > 2500) g.active = false;
  });
  return null;
}
