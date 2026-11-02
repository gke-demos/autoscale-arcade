# ADR 0002: Three.js via React Three Fiber for the UI

**Status:** Accepted · 2026-11-02

## Context
Preference for WebGL / Three.js spatial UIs; the kiosk is a landscape TV driven by a Chromebook with touch and mouse/keyboard.

## Decision
Vite + React + TypeScript + React Three Fiber + drei, state in zustand, HUD in Tailwind. Drag-and-drop uses R3F pointer events (works for touch and mouse). Device pixel ratio capped at 2.

## Alternatives
Plain Three.js (more boilerplate for HUD/state), Babylon.js (team familiarity lower), 2D canvas (not "spatial").
