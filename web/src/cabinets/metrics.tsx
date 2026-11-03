import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { ago, durationShort } from '../lib/format';
import { ClusterScene } from '../scene/ClusterScene';
import type { Layout } from '../scene/layout';
import { useArcade } from '../store';
import type { Node, Pod, WorldState } from '../types';
import { ActionButton, Badge, ControlGroup, MissionCard, Stat, eventsSection, podTable, useCabinetLayout, useNow } from './common';
import type { CabinetModule, CabinetProps, HudSection } from './types';

const ACCENT = '#34a853'; // Google Green
const BLUE = '#4285f4';   // Google Blue
const YELLOW = '#fbbc04'; // Google Yellow
const RED = '#ea4335';    // Google Red
const MAX_PODS = 10;
const MAX_LOAD = 500;
const LOAD_PRESETS = [50, 100, 200, 300, 400, 500];

function metricPods(world: WorldState): Pod[] {
  return world.pods.filter((p) => p.cabinet === 'metrics' && p.workload === 'metric-worker');
}

const isDefaultPool = (n: Node) => n.pool === 'default-pool';

function desiredForLoad(load: number, targetAvg = 50, min = 1, max = 10): number {
  const avg = Math.max(1, targetAvg);
  const raw = load > 0 ? Math.ceil(load / avg) : 0;
  return Math.max(min, Math.min(max, raw));
}

// ---- 3D ---------------------------------------------------------------------

/** Point lights above each ready metric-worker pod. */
function MetricPodLights({ layout, onTarget }: { layout: Layout; onTarget: boolean }) {
  const lit = [...layout.pods.values()].filter((pl) => pl.pod.workload === 'metric-worker' && pl.pod.ready && !pl.pod.deleting);
  const color = onTarget ? ACCENT : BLUE;
  return (
    <>
      {lit.map((pl) => (
        <pointLight key={`ml-${pl.pod.uid}`} position={[pl.pos[0], pl.pos[1] + 0.9, pl.pos[2]]} color={color} intensity={onTarget ? 8 : 5} distance={5} decay={2} />
      ))}
    </>
  );
}

/** 3D 10-tier Prometheus metric gauge tower with a glowing target ring at targetPods. */
function MetricGaugeTower({
  load,
  targetPods,
  readyPods,
  desiredPods,
  onTarget,
  position,
}: {
  load: number;
  targetPods: number;
  readyPods: number;
  desiredPods: number;
  onTarget: boolean;
  position: [number, number, number];
}) {
  const ringRef = useRef<THREE.Mesh>(null);
  const stepH = 0.22;
  const gap = 0.05;
  const pitch = stepH + gap;

  useFrame(({ clock }) => {
    if (ringRef.current) {
      const s = 1 + 0.06 * Math.sin(clock.elapsedTime * (onTarget ? 7 : 3));
      ringRef.current.scale.set(s, s, 1);
    }
  });

  const targetY = 0.18 + (targetPods - 1) * pitch + stepH / 2;
  const topY = 0.18 + MAX_PODS * pitch + 0.45;

  return (
    <group position={position}>
      {/* pedestal */}
      <mesh position={[0, 0.04, 0]} receiveShadow>
        <cylinderGeometry args={[1.15, 1.25, 0.14, 32]} />
        <meshStandardMaterial color="#202124" roughness={0.6} metalness={0.3} />
      </mesh>

      {/* 10 pod tiers (1..10) */}
      {Array.from({ length: MAX_PODS }, (_, i) => {
        const idx = i + 1;
        const y = 0.18 + i * pitch + stepH / 2;
        const isTarget = idx === targetPods;
        const isReady = idx <= readyPods;
        const isDesired = idx <= desiredPods;
        const isOver = idx > targetPods && (isReady || isDesired);
        const color = isOver
          ? RED
          : isTarget && onTarget
            ? ACCENT
            : isReady
              ? onTarget
                ? ACCENT
                : BLUE
              : isDesired
                ? YELLOW
                : '#303134';
        const emissiveIntensity = isTarget && onTarget ? 0.85 : isReady ? 0.5 : isDesired ? 0.35 : isTarget ? 0.2 : 0.04;
        return (
          <mesh key={idx} position={[0, y, 0]} castShadow>
            <cylinderGeometry args={[0.72, 0.72, stepH, 28]} />
            <meshStandardMaterial
              color={color}
              emissive={isTarget && !isReady && !isDesired ? YELLOW : color}
              emissiveIntensity={emissiveIntensity}
              roughness={0.3}
              metalness={0.35}
            />
          </mesh>
        );
      })}

      {/* Target ring around the target pod tier */}
      <mesh ref={ringRef} position={[0, targetY, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.96, 0.055, 16, 48]} />
        <meshBasicMaterial color={onTarget ? ACCENT : YELLOW} toneMapped={false} />
      </mesh>

      <pointLight position={[0, targetY, 0.8]} color={onTarget ? ACCENT : YELLOW} intensity={onTarget ? 7 : 3.5} distance={5} />

      <Html position={[0, topY, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <div
          className={`whitespace-nowrap rounded-full border px-3.5 py-1 font-mono text-[0.78rem] font-bold shadow-lg ${
            onTarget
              ? 'border-[#34a853] bg-[#131314]/90 text-[#81c995]'
              : desiredPods > targetPods
                ? 'border-[#ea4335]/70 bg-[#131314]/90 text-[#f28b82]'
                : 'border-[#fbbc04]/60 bg-[#131314]/90 text-[#fde293]'
          }`}
        >
          {onTarget ? `🎯 BULLSEYE · ${readyPods}/${targetPods} PODS` : `🎯 TARGET ${targetPods} PODS · ${load} req/s → ${readyPods}/${MAX_PODS}`}
        </div>
      </Html>
    </group>
  );
}

function Scene({ world }: CabinetProps) {
  const m = world.cabinets.metrics;
  const layout = useCabinetLayout(world, 'metrics', { extraNodes: isDefaultPool });
  const gaugePos: [number, number, number] = [layout.bounds.minX - 1.9, 0, layout.bounds.maxZ - 1.4];
  return (
    <>
      <ClusterScene layout={layout} />
      <MetricPodLights layout={layout} onTarget={m.onTarget} />
      <MetricGaugeTower
        load={m.load}
        targetPods={m.targetPods}
        readyPods={m.readyPods}
        desiredPods={m.hpa.desired}
        onTarget={m.onTarget}
        position={gaugePos}
      />
    </>
  );
}

// ---- Controls -----------------------------------------------------------------

function Controls({ world }: CabinetProps) {
  const m = world.cabinets.metrics;
  const act = useArcade((st) => st.act);
  const busyLoad = useArcade((st) => st.busy['metrics.load']);
  const now = useNow(250);

  const [load, setLoad] = useState(m.load);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setLoad(m.load);
  }, [m.load]);

  const commit = (v: number) => {
    dragging.current = false;
    if (v !== m.load) void act('metrics.load', { load: v }, { label: `metric load → ${v} req/s` });
  };

  const avg = Math.max(1, m.targetAverage || 50);
  const previewDesired = desiredForLoad(load, avg, m.hpa.min || 1, m.hpa.max || MAX_PODS);
  const targetMin = (m.targetPods - 1) * avg + 1;
  const targetMax = m.targetPods * avg;
  const targetBandText = m.targetPods === 1 ? `0–${avg} req/s` : `${targetMin}–${targetMax} req/s`;
  const perPodAvg = m.readyPods > 0 ? Math.round((load / m.readyPods) * 10) / 10 : load;

  const sliderInBand = previewDesired === m.targetPods;
  const hpaMatched = m.hpa.desired === m.targetPods;

  return (
    <>
      <MissionCard
        accent={ACCENT}
        goal="Adjust the custom Prometheus metric load slider (arcade_metric_load) so GKE's AutoscalingMetric + HorizontalPodAutoscaler scale metric-worker to the exact target pod count (never more than 10 pods)."
        win={`Hit the exact target pod count (${m.targetPods} pods, ≤ 10) — ${m.hits} bullseye${m.hits === 1 ? '' : 's'} scored`}
        steps={[
          {
            label: `Slide metric load into the ${m.targetPods}-pod band (${targetBandText})`,
            detail: `HPA formula: desired = clamp(ceil(load / ${avg}), 1, 10).`,
            done: sliderInBand || m.onTarget,
            active: !sliderInBand && !m.onTarget,
          },
          {
            label: `AutoscalingMetric feeds HPA (desiredReplicas = ${m.targetPods})`,
            detail: `AutoscalingMetric/load-tuner exposes ${m.metricName} to HPA/metric-worker.`,
            done: hpaMatched || m.onTarget,
            active: sliderInBand && !hpaMatched,
          },
          {
            label: `Bullseye! Hit ${m.targetPods} Ready pods (max 10)`,
            detail: 'All target replicas reach Ready=True on the 3D cluster stage.',
            done: m.onTarget,
            active: hpaMatched && !m.onTarget,
          },
        ]}
      />

      <ControlGroup title="Target Challenge · Hit the Pod Count (1–10)">
        <div className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-[#131314]/80 px-3 py-2.5">
          <div>
            <div className="font-mono text-[0.65rem] uppercase tracking-wider text-[#9aa0a6]">🎯 Target Pods</div>
            <div className="font-mono text-[2.2rem] font-black leading-none text-[#fbbc04]">
              {m.targetPods} <span className="text-[0.95rem] font-bold text-[#9aa0a6]">/ {MAX_PODS}</span>
            </div>
            <div className="mt-1 font-mono text-[0.68rem] text-[#9aa0a6]">win band: {targetBandText}</div>
          </div>
          <div className="text-center">
            <div className="font-mono text-[0.65rem] uppercase tracking-wider text-[#9aa0a6]">⚡ Ready Pods</div>
            <div
              className="font-mono text-[2.2rem] font-black leading-none"
              style={{ color: m.onTarget ? ACCENT : m.readyPods > m.targetPods ? RED : BLUE }}
            >
              {m.readyPods}
            </div>
            <div className="mt-1 font-mono text-[0.68rem] text-[#9aa0a6]">desired {m.hpa.desired}</div>
          </div>
          <div className="text-right">
            <div className="font-mono text-[0.65rem] uppercase tracking-wider text-[#9aa0a6]">🏆 Bullseyes</div>
            <div className="font-mono text-[2.2rem] font-black leading-none text-[#81c995]">{m.hits}</div>
            <div className="mt-1 font-mono text-[0.68rem] text-[#9aa0a6]">hits</div>
          </div>
        </div>

        {/* Live feedback banner */}
        <div
          className={`rounded-lg border px-3 py-2 font-mono text-[0.76rem] font-semibold ${
            m.onTarget
              ? 'border-[#34a853]/60 bg-[#34a853]/15 text-[#81c995]'
              : previewDesired === m.targetPods
                ? 'border-[#fbbc04]/60 bg-[#fbbc04]/15 text-[#fde293]'
                : previewDesired < m.targetPods
                  ? 'border-[#4285f4]/60 bg-[#4285f4]/15 text-[#8ab4f8]'
                  : 'border-[#ea4335]/60 bg-[#ea4335]/15 text-[#f28b82]'
          }`}
        >
          {m.onTarget
            ? `🎯 BULLSEYE! ceil(${m.load} / ${avg}) = ${m.targetPods} pods Ready! Click "New Target" for another round.`
            : previewDesired === m.targetPods
              ? `⏳ On target band! ceil(${load} / ${avg}) = ${m.targetPods} pods (${m.readyPods}/${m.targetPods} Ready)…`
              : previewDesired < m.targetPods
                ? `▲ Too low: ceil(${load} / ${avg}) = ${previewDesired} pod${previewDesired === 1 ? '' : 's'} (need ${m.targetPods} pods → slide to ${targetBandText})`
                : `▼ Too high: ceil(${load} / ${avg}) = ${previewDesired} pods (need ${m.targetPods} pods → slide down to ${targetBandText})`}
        </div>

        <div className="flex items-center gap-2">
          <ActionButton action="metrics.target" body={{}} accent={YELLOW} label="New random target (1–10)" className="flex-1 text-[0.95rem]">
            🎯 New Target (1–10)
          </ActionButton>
        </div>
      </ControlGroup>

      <ControlGroup title="AutoscalingMetric/load-tuner · Metric Load Slider">
        <div className="flex items-end justify-between">
          <div>
            <div className="font-mono text-[2.4rem] font-black leading-none" style={{ color: sliderInBand ? ACCENT : BLUE }}>
              {load}
              <span className="ml-1.5 text-[1rem] font-bold text-[#9aa0a6]">req/s</span>
            </div>
            <div className="mt-1 font-mono text-[0.72rem] text-[#9aa0a6]">
              metric <span className="text-[#e8eaed]">arcade_metric_load</span> · avg <span className="text-[#e8eaed]">{perPodAvg}</span> / {avg} req/s per pod
            </div>
          </div>
          <div className="text-right font-mono text-[0.78rem]">
            <div className="text-[#9aa0a6]">HPA formula</div>
            <div className="font-bold text-[#e8eaed]">
              ⌈{load} / {avg}⌉ →{' '}
              <span style={{ color: previewDesired === m.targetPods ? ACCENT : previewDesired > m.targetPods ? RED : YELLOW }}>
                {previewDesired} pod{previewDesired === 1 ? '' : 's'}
              </span>
            </div>
          </div>
        </div>

        <input
          type="range"
          className="slider"
          min={0}
          max={MAX_LOAD}
          step={5}
          value={load}
          disabled={busyLoad}
          aria-label="custom metric load req/s"
          style={{ '--pct': `${(load / MAX_LOAD) * 100}%`, '--slider-accent': sliderInBand ? ACCENT : BLUE } as React.CSSProperties}
          onPointerDown={() => (dragging.current = true)}
          onChange={(e) => setLoad(Number(e.target.value))}
          onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
          onPointerCancel={(e) => commit(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
          onBlur={(e) => dragging.current && commit(Number(e.target.value))}
        />

        {/* 10-band pod ruler under the slider */}
        <div className="grid grid-cols-10 gap-1">
          {Array.from({ length: MAX_PODS }, (_, i) => {
            const podNum = i + 1;
            const isTarget = podNum === m.targetPods;
            const isCurrent = podNum === previewDesired;
            const bandLoad = podNum * avg - Math.floor(avg / 2);
            return (
              <button
                key={podNum}
                type="button"
                title={`Set load to ${bandLoad} req/s (${podNum} pod${podNum === 1 ? '' : 's'})`}
                disabled={busyLoad}
                onClick={() => {
                  setLoad(bandLoad);
                  void act('metrics.load', { load: bandLoad }, { label: `metric load → ${bandLoad} req/s` });
                }}
                className={`flex flex-col items-center rounded border py-1 font-mono text-[0.65rem] transition-all ${
                  isTarget && isCurrent
                    ? 'border-[#34a853] bg-[#34a853]/30 font-black text-white shadow-[0_0_10px_rgba(52,168,83,0.6)]'
                    : isTarget
                      ? 'border-[#fbbc04] bg-[#fbbc04]/20 font-bold text-[#fde293]'
                      : isCurrent
                        ? 'border-[#4285f4] bg-[#4285f4]/25 font-bold text-[#8ab4f8]'
                        : 'border-white/10 bg-[#131314]/60 text-[#9aa0a6] hover:border-white/30'
                }`}
              >
                <span>{isTarget ? `🎯${podNum}` : `${podNum}p`}</span>
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-6 gap-1.5">
          {LOAD_PRESETS.map((n) => (
            <ActionButton
              key={n}
              action="metrics.load"
              body={{ load: n }}
              label={`metric load → ${n} req/s`}
              accent={m.load === n ? ACCENT : undefined}
              className="!min-h-[2.3rem] !px-1.5 font-mono text-[0.75rem]"
              onDone={() => setLoad(n)}
            >
              {n}
            </ActionButton>
          ))}
        </div>
      </ControlGroup>

      <ControlGroup title="HorizontalPodAutoscaler · metric-worker (max 10)">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={m.onTarget ? 'bg-[#34a853]/25 text-[#81c995] ring-1 ring-[#34a853]/60' : 'bg-[#4285f4]/20 text-[#8ab4f8]'}>
            {m.onTarget ? `🎯 On Target (${m.readyPods}/${m.targetPods} pods)` : `⚡ Scaling (${m.readyPods} Ready / ${m.targetPods} Target)`}
          </Badge>
          <Badge tone="bg-[#303134] text-[#e8eaed]">min {m.hpa.min} · max {m.hpa.max}</Badge>
          <span className="font-mono text-[0.7rem] text-[#9aa0a6]">
            last scale {m.hpa.lastScale ? `${ago(m.hpa.lastScale, now)} ago` : '—'}
          </span>
        </div>

        {/* 10-slot visual pod meter */}
        <div className="flex flex-col gap-1">
          <div className="flex justify-between font-mono text-[0.7rem] text-[#9aa0a6]">
            <span>pods ready vs target ({m.targetPods})</span>
            <span>
              <span className={m.onTarget ? 'font-bold text-[#81c995]' : 'text-[#e8eaed]'}>{m.readyPods}</span> / {MAX_PODS} max
            </span>
          </div>
          <div className="flex h-6 gap-1 rounded-lg bg-[#131314] p-1">
            {Array.from({ length: MAX_PODS }, (_, i) => {
              const slot = i + 1;
              const ready = slot <= m.readyPods;
              const desired = slot <= m.hpa.desired;
              const isTarget = slot === m.targetPods;
              const over = slot > m.targetPods && (ready || desired);
              return (
                <div
                  key={slot}
                  className={`relative flex flex-1 items-center justify-center rounded-sm font-mono text-[0.6rem] font-bold transition-all ${
                    over
                      ? 'bg-[#ea4335] text-white'
                      : ready
                        ? m.onTarget
                          ? 'bg-[#34a853] text-black shadow-[0_0_8px_rgba(52,168,83,0.8)]'
                          : 'bg-[#4285f4] text-white'
                        : desired
                          ? 'animate-blink bg-[#fbbc04]/50 text-white'
                          : 'bg-[#303134] text-[#9aa0a6]'
                  } ${isTarget ? 'ring-2 ring-[#fbbc04]' : ''}`}
                >
                  {isTarget ? '🎯' : slot}
                </div>
              );
            })}
          </div>
        </div>
        <div className="font-mono text-[0.68rem] text-[#9aa0a6]">
          external metric <span className="text-[#e8eaed]">{m.metricName}</span>
        </div>
      </ControlGroup>
    </>
  );
}

// ---- Status bar ---------------------------------------------------------------

function Status({ world }: CabinetProps) {
  const m = world.cabinets.metrics;
  return (
    <>
      <Stat
        label="metric load"
        value={<span className="text-[#8ab4f8]">{m.load} req/s</span>}
        sub={`target avg ${m.targetAverage}/pod`}
      />
      <Stat
        label="target pods"
        value={
          <span className={m.onTarget ? 'text-[#81c995]' : 'text-[#fde293]'}>
            {m.readyPods} / {m.targetPods} 🎯
          </span>
        }
        sub={`${m.hits} bullseye${m.hits === 1 ? '' : 's'} (max 10)`}
      />
    </>
  );
}

// ---- HUD ----------------------------------------------------------------------

function hud(world: WorldState): HudSection[] {
  const m = world.cabinets.metrics;
  const now = Date.now();
  const pods = metricPods(world);
  const avg = m.targetAverage || 50;
  const hpaAge = world.events.find((e) => e.cabinet === 'metrics')?.ts;
  return [
    {
      kind: 'table',
      title: 'AutoscalingMetric',
      command: 'kubectl get autoscalingmetric load-tuner -n arcade-metrics',
      columns: ['NAME', 'METRIC', 'HPA-NAME', 'VALUE', 'TARGET-AVG'],
      rows: [['load-tuner', 'arcade_metric_load', m.metricName, `${m.load} req/s`, `${avg} / pod`]],
      highlight: () => (m.onTarget ? 'text-[#81c995]' : 'text-[#8ab4f8]'),
    },
    {
      kind: 'table',
      title: 'HPA',
      command: 'kubectl get hpa metric-worker -n arcade-metrics',
      columns: ['NAME', 'REFERENCE', 'TARGETS', 'MINPODS', 'MAXPODS', 'REPLICAS', 'AGE'],
      rows: [
        [
          'metric-worker',
          'Deployment/metric-worker',
          `${m.load}/${avg} (avg)`,
          String(m.hpa.min),
          String(m.hpa.max),
          `${m.readyPods} (target ${m.targetPods})`,
          hpaAge ? ago(hpaAge, now) : '—',
        ],
      ],
      highlight: () => (m.onTarget ? 'text-[#81c995]' : 'text-[#fde293]'),
    },
    {
      kind: 'yaml',
      title: 'AutoscalingMetric/load-tuner',
      command: 'kubectl get autoscalingmetric load-tuner -n arcade-metrics -o yaml',
      value: {
        apiVersion: 'autoscaling.gke.io/v1beta1',
        kind: 'AutoscalingMetric',
        metadata: { name: 'load-tuner', namespace: 'arcade-metrics', labels: { 'arcade.gke.io/cabinet': 'metrics' } },
        spec: {
          metrics: [
            {
              promql: {
                name: 'arcade_metric_load',
                type: 'External',
                query: 'max(arcade_metric_load{namespace="arcade-system"})',
              },
            },
          ],
        },
        status: {
          metricStatuses: [{ name: 'arcade_metric_load', hpaName: m.metricName }],
        },
      },
    },
    {
      kind: 'yaml',
      title: 'HorizontalPodAutoscaler/metric-worker',
      command: 'kubectl get hpa metric-worker -n arcade-metrics -o yaml',
      value: {
        apiVersion: 'autoscaling/v2',
        kind: 'HorizontalPodAutoscaler',
        metadata: { name: 'metric-worker', namespace: 'arcade-metrics', labels: { 'arcade.gke.io/cabinet': 'metrics' } },
        spec: {
          scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'metric-worker' },
          minReplicas: m.hpa.min,
          maxReplicas: m.hpa.max,
          metrics: [
            {
              type: 'External',
              external: {
                metric: { name: m.metricName },
                target: { type: 'AverageValue', averageValue: String(avg) },
              },
            },
          ],
        },
        status: {
          currentReplicas: m.hpa.current,
          desiredReplicas: m.hpa.desired,
          lastScaleTime: m.hpa.lastScale,
          currentMetrics: [
            {
              type: 'External',
              external: { metric: { name: m.metricName }, current: { value: String(m.load), averageValue: String(avg) } },
            },
          ],
          conditions: [{ type: 'ScalingActive', status: m.hpa.scalingActive ? 'True' : 'False', reason: 'ValidMetricFound' }],
        },
      },
    },
    {
      kind: 'kv',
      title: 'Metric Dialer Challenge',
      items: [
        ['apiVersion', 'autoscaling.gke.io/v1beta1'],
        ['metric', 'arcade_metric_load'],
        ['hpaName', m.metricName],
        ['current load', `${m.load} req/s`, 'text-[#8ab4f8]'],
        ['targetAverageValue', `${avg} req/s per pod`],
        ['formula', `clamp(ceil(${m.load} / ${avg}), ${m.hpa.min}, ${m.hpa.max}) = ${m.hpa.desired} pods`],
        ['target challenge', `${m.targetPods} pods (max 10)`, m.onTarget ? 'text-[#81c995]' : 'text-[#fde293]'],
        ['bullseyes scored', String(m.hits), 'text-[#81c995]'],
        ['lastScale', m.hpa.lastScale ? `${durationShort(Math.max(0, now - Date.parse(m.hpa.lastScale)))} ago` : '—'],
      ],
    },
    podTable(pods, now),
    eventsSection(world, 'metrics', now),
  ];
}

export const metrics: CabinetModule = {
  id: 'metrics',
  Scene,
  Controls,
  hud,
  Status,
  hint: 'Slide the custom Prometheus metric load so the HPA scales to the exact target pod count (1–10).',
  frame: (b) => ({ ...b, minX: b.minX - 3.8 }),
};
