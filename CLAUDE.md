# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Synthwave Outrun Rider — a browser game that loads an audio file, analyzes it, and procedurally generates a 3D synthwave driving track from the music. A kart auto-drives the track in sync with playback, dodging beat-driven sword obstacles. Pure client-side; no backend.

## Commands

```
npm run dev        # Vite dev server (alias: npm run serve)
npm run build      # Type-check with vue-tsc, then vite build
npm run preview    # Serve the production build
```

- **Type-checking is the only automated check.** Run `npm run build` (or `npx vue-tsc --noEmit`) to validate types. tsconfig is `strict` with `noUnusedLocals`/`noUnusedParameters`, so an unused variable or import fails the build.
- **No test framework and no linter are configured.** `npm test` / `npm run lint` do not exist — don't reference them.

## Architecture

Everything hangs off one data pipeline, driven by the audio playback clock.

### Load pipeline (runs once per audio file)
`AudioEngine.loadFile` (decode → `AudioBuffer`) → `analyzeBuffer` (→ `MusicMap`) → `generateTrack` (→ `TrackData`) → `ThreeScene.setTrack`. Orchestrated by `GameController.loadFile`.

### Per-frame loop
`GameRoot.vue` drives `requestAnimationFrame` → `GameController.update()` → `ThreeScene.renderFrame(gameState)`. The audio clock is the single source of truth for progress: `car.distance = audioTime × 50` (units/sec). There is no score or win/lose state — collisions only trigger a red screen flash.

### Layers
- **`src/components/GameRoot.vue`** — the only real component. Owns the canvas, RAF loop, keyboard input (←/→), file picker, and damage-flash overlay. Preloads `/06 boxing day.mp3` on mount. Holds the controller in `shallowRef` + `markRaw` — **Three.js objects must never enter Vue's reactivity system**; preserve this.
- **`src/core/game/GameController.ts`** — orchestrator between subsystems. `update()` converts audio time to distance and runs `maybeAutoDodge` (car auto-steers to avoid upcoming treble obstacles via a lane-safety score). `handleInput` performs manual lane changes.
- **`src/core/game/GameState.ts`** — plain (non-reactive) game state. Lanes are the integer set `{-1, 0, 1}`; `LANE_WIDTH = 2.5`; `getLaneOffset` maps lane index → world-X offset.
- **`src/core/audio/AudioEngine.ts`** — Web Audio API wrapper (decode, play/pause). `getCurrentTime()` is the clock that drives the entire game.
- **`src/core/audio/AudioAnalysis.ts`** — hand-rolled offline DSP (no library, despite the Meyda comment). Walks PCM in 75ms windows computing overall RMS and a derivative-based "treble" RMS; beats and treble peaks are local maxima above a `mean + 0.5·stdDev` threshold.
- **`src/core/track/TrackGenerator.ts`** — builds `TrackData` from the `MusicMap`. Centerline nodes (~10/sec): X = fixed sinusoid, **Y = smoothed RMS energy** (hills track loudness), Z = linear distance. Strong beats mark jump nodes; treble peaks become `TreblePulse` obstacles placed in a cycling lane pattern `[-1, 1, 0]`.
- **`src/core/track/TrackTypes.ts`** — shared data contracts (`TrackNode`, `TreblePulse`, `TrackData`).
- **`src/core/render/ThreeScene.ts`** — by far the largest file and where most behavior lives. Builds the synthwave world (shader sky dome, starfield, retro-sun shader plane, fog, neon grid, ground), the road as a custom `BufferGeometry` ribbon from track nodes, and loads GLB models via `GLTFLoader`. `renderFrame` also owns the **jump/gravity physics** and chase camera.

### Cross-cutting things to know
- **The speed constant `50` is duplicated** in `GameController.update()` and `TrackGenerator.generateTrack()`. They must stay equal or the car desyncs from track length. Likewise, road width `7.5` (= 3 × `LANE_WIDTH`) appears as a literal in `ThreeScene`.
- **Jump physics flow render → state → controller.** `ThreeScene.renderFrame` computes vertical motion and writes `gameState.car.verticalOffset`; `GameController.canSteer()` reads it to disable steering while airborne. Vertical state lives in the renderer, not in GameState/Controller.
- **Models** (`public/models/`): code loads `Kart.glb` (player) and `Claymore.glb` (obstacle). `Sports Car.glb` and `Master Sword.glb` exist but are unused. A procedural neon car is built as a fallback if the GLB fails to load. The shared `ANALOGOUS_PALETTE` (teal/cyan/red) is re-applied onto loaded model materials so imported assets match the scene.
- **GSAP** is a dependency but currently unused — all animation is manual `lerp`/`slerp` in `ThreeScene`.
