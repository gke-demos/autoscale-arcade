import { useThree, type ThreeEvent } from '@react-three/fiber';
import { useCallback, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useArcade } from '../store';
import type { Node, Pod } from '../types';
import { SLAB, type Layout } from './layout';

/**
 * Drag-and-drop for pod cubes that works for mouse, pen and touch.
 * The pointer-down comes from an R3F event on the pod; after that we listen on
 * the window (so the gesture survives leaving the object/canvas), project the
 * pointer onto the slab-top plane with a raycaster and pick the nearest valid
 * node slab as the drop target.
 */
export function usePodDrag(layout: Layout, opts: { canDrag: (pod: Pod) => boolean; isTarget: (node: Node, pod: Pod) => boolean; onDrop: (pod: Pod, node: Node) => void }) {
  const { camera, gl } = useThree();
  const setDrag = useArcade((s) => s.setDrag);
  const plane = useRef(new THREE.Plane(new THREE.Vector3(0, 1, 0), -(SLAB.h / 2 + 0.6)));
  const ray = useRef(new THREE.Raycaster());
  const ndc = useRef(new THREE.Vector2());
  const hit = useRef(new THREE.Vector3());
  const active = useRef<{ pod: Pod; pointerId: number } | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const project = useCallback(
    (clientX: number, clientY: number) => {
      const r = gl.domElement.getBoundingClientRect();
      ndc.current.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      ray.current.setFromCamera(ndc.current, camera);
      return ray.current.ray.intersectPlane(plane.current, hit.current) ? hit.current : null;
    },
    [camera, gl],
  );

  const nearestTarget = useCallback((x: number, z: number, pod: Pod) => {
    let best: { node: Node; d: number } | undefined;
    for (const nl of layoutRef.current.nodes.values()) {
      if (!optsRef.current.isTarget(nl.node, pod)) continue;
      const dx = x - nl.pos[0];
      const dz = z - nl.pos[2];
      const d = Math.hypot(dx, dz);
      if (d < SLAB.w * 0.85 && (!best || d < best.d)) best = { node: nl.node, d };
    }
    return best?.node;
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const a = active.current;
      if (!a || e.pointerId !== a.pointerId) return;
      e.preventDefault();
      const p = project(e.clientX, e.clientY);
      if (!p) return;
      const target = nearestTarget(p.x, p.z, a.pod);
      setDrag({ podUid: a.pod.uid, from: a.pod.node, pos: [p.x, p.y, p.z], target: target?.name });
      useArcade.getState().touch();
    };
    const up = (e: PointerEvent) => {
      const a = active.current;
      if (!a || e.pointerId !== a.pointerId) return;
      active.current = null;
      document.body.style.cursor = 'auto';
      const d = useArcade.getState().drag;
      setDrag(undefined);
      if (d?.target) {
        const node = layoutRef.current.nodes.get(d.target)?.node;
        if (node) optsRef.current.onDrop(a.pod, node);
      }
    };
    const cancel = () => {
      active.current = null;
      document.body.style.cursor = 'auto';
      setDrag(undefined);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [project, nearestTarget, setDrag]);

  const onPodPointerDown = useCallback(
    (pod: Pod, e: ThreeEvent<PointerEvent>) => {
      if (!optsRef.current.canDrag(pod)) return;
      e.stopPropagation();
      active.current = { pod, pointerId: e.pointerId };
      document.body.style.cursor = 'grabbing';
      const p = project(e.clientX, e.clientY) ?? new THREE.Vector3(e.point.x, SLAB.h / 2 + 0.6, e.point.z);
      setDrag({ podUid: pod.uid, from: pod.node, pos: [p.x, p.y, p.z] });
    },
    [project, setDrag],
  );

  return { onPodPointerDown };
}
