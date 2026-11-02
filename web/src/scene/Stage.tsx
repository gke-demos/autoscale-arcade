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
        gl.setClearColor('#131314');
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.3;
      }}
      onPointerMissed={() => useArcade.getState().touch()}
      style={{ position: 'absolute', inset: 0 }}
    >
      <PerspectiveCamera makeDefault fov={38} position={[0, 14, 22]} near={0.1} far={200} />
      <fog attach="fog" args={['#131314', 45, 110]} />
      <ambientLight intensity={0.75} />
      <hemisphereLight args={['#e8eaed', '#202124', 0.85]} />
      <directionalLight position={[12, 20, 8]} intensity={2.2} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-25} shadow-camera-right={25} shadow-camera-top={25} shadow-camera-bottom={-25} />
      <pointLight position={[-15, 8, -10]} intensity={55} color="#4285f4" />
      <pointLight position={[15, 6, -12]} intensity={45} color="#34a853" />
      <Grid position={[0, -0.6, 0]} args={[120, 120]} cellSize={1} cellThickness={0.6} cellColor="#202124" sectionSize={6} sectionThickness={1.1} sectionColor="#3c4043" fadeDistance={60} fadeStrength={1.5} infiniteGrid />
      <ContactShadows position={[0, -0.59, 0]} opacity={0.5} scale={60} blur={2.4} far={6} color="#000000" />
      <OrbitControls makeDefault enabled={!dragging} enablePan={false} minDistance={8} maxDistance={60} minPolarAngle={0.35} maxPolarAngle={Math.PI / 2.25} autoRotate={autoRotate && !dragging} autoRotateSpeed={0.5} enableDamping dampingFactor={0.08} />
      {children}
      <DebugProjector />
    </Canvas>
  );
}

/** Dev hook: window.__project([x,y,z]) → {x,y} CSS pixels, used by automated UI checks. */
function DebugProjector() {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const v = new THREE.Vector3();
    (window as unknown as { __project: (p: [number, number, number]) => { x: number; y: number } }).__project = (p) => {
      const r = gl.domElement.getBoundingClientRect();
      v.set(p[0], p[1], p[2]).project(camera);
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    };
  }, [camera, gl]);
  return null;
}

/**
 * Smoothly frames the camera on a layout's bounds whenever the view changes.
 * `visible` is the horizontal band of the viewport not covered by DOM panels
 * (fractions 0..1): the scene is centred and fitted inside it.
 */
export function CameraRig({ layout, viewKey, elevation = 0.75, visible = [0.21, 0.74] }: { layout: Layout; viewKey: string; elevation?: number; visible?: [number, number] }) {
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null;
  const camera = useThree((s) => s.camera);
  const goal = useRef({ pos: new THREE.Vector3(0, 14, 22), target: new THREE.Vector3(0, 0, 0), active: false, started: 0 });
  const lastKey = useRef('');
  const [vl, vr] = visible;

  useEffect(() => {
    const b = layout.bounds;
    const w = Math.max(b.maxX - b.minX, 6) + 2;
    const d = Math.max(b.maxZ - b.minZ, 6) + 2;
    const cam = camera as THREE.PerspectiveCamera;
    const tanV = Math.tan(((cam.fov ?? 38) * Math.PI) / 360);
    const tanH = tanV * (cam.aspect || 16 / 9);
    const frac = Math.max(0.3, vr - vl);
    // distance so the width fits the visible band and the depth fits ~75% of the height
    const distW = w / (2 * tanH * frac);
    const distD = (d * 0.95) / (2 * tanV * 0.75);
    const dist = Math.max(distW, distD, 10);
    // shift the target so the scene centre lands in the middle of the visible band
    const shift = (0.5 - (vl + vr) / 2) * 2 * tanH * dist;
    const cx = (b.maxX + b.minX) / 2 + shift;
    const cz = (b.maxZ + b.minZ) / 2;
    goal.current.target.set(cx, 0.3, cz);
    const dir = new THREE.Vector3(0, elevation, 0.85).normalize();
    goal.current.pos.copy(goal.current.target).addScaledVector(dir, dist);
    if (lastKey.current !== viewKey) {
      goal.current.active = true;
      goal.current.started = performance.now();
      lastKey.current = viewKey;
    }
  }, [layout, viewKey, elevation, vl, vr, camera]);

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
