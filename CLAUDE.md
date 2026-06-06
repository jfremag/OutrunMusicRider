# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Synthwave Outrun Rider — a browser music visualizer that loads an audio file, analyzes it, and procedurally generates a 3D synthwave driving track from the music. A kart auto-drives the track in sync with playback, dodging beat-driven sword obstacles, while the whole world (camera, bloom, color, particles, track shape) reacts to beats, tempo, frequency energy, and emotional mood. The aim is a premium, cinematic "automotive promo film" feel. Pure client-side; no backend.

> The `revamp/synthwave-outrun` branch carried a 10-iteration cinematic revamp. See `REVAMP_REPORT.md` for the full changelog, scoring, gaps, and next steps.

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
`GameRoot.vue` drives `requestAnimationFrame` → `GameController.update()` → `ThreeScene.renderFrame(gameState)`, then paints the 2D `HudOverlay` from read-only controller getters. The audio clock is the single source of truth for progress. Car distance is **integrated from the per-frame audio-time delta** — `distance += Δaudio × 50 × car.speedMultiplier` — not the old absolute `audioTime × 50`, so the cinematic drop acceleration can speed the car up/down without teleporting it; an anti-drift self-heal relaxes the integral back toward the absolute position when not in a drop, and a re-baseline handles seek/rewind/tab-throttle. There is no score or win/lose state — collisions only trigger a red screen flash (plus a particle burst, chromatic-aberration kick, and rim-glow white flash).

### Layers
- **`src/components/GameRoot.vue`** — the only real component. Owns the canvas, RAF loop, keyboard input (←/→), file picker, damage-flash overlay, loading overlay, and the HUD canvas. Preloads `/06 boxing day.mp3` on mount. Holds the controller in `shallowRef` + `markRaw` — **Three.js objects must never enter Vue's reactivity system**; preserve this. The `HudOverlay` is held in a plain (non-reactive) variable for the same reason (it caches a 2D context).
- **`src/components/LoadingOverlay.vue`** — neon spinner + status-text overlay shown during the ~2-3s decode→analyze→track-gen pipeline. Driven by the `onStatus` callback `GameController.loadFile` invokes at each milestone (and finally `null` to fade out).
- **`src/core/game/GameController.ts`** — orchestrator between subsystems. `update()`: mirrors the audio clock onto `gameState.audioTime`, samples spectral mood + the drop state machine (`updateMood`/`updateCinematicDrive`), integrates car distance, fires per-frame beat/treble sync (`updateBeatSync`/`updateTrebleSync`), runs `maybeAutoDodge` (lane-safety score), then renders. Exposes read-only `getMusicMap()` / `getState()` for the HUD. `handleInput` performs manual lane changes.
- **`src/core/game/GameState.ts`** — plain (non-reactive) game state. Lanes are the integer set `{-1, 0, 1}`; `LANE_WIDTH = 2.5`; `getLaneOffset` maps lane index → world-X offset. Now also carries the many music-reactive scalars the controller writes and the renderer/HUD read: `beatStrength`/`beatFires`, `spectralCentroid`/`spectralFlux`/`dropIntensity`, `cameraShakeAmplitude`/`lastShakeTime`, `trebleFires`/`trebleStrength`, `speedMultiplier`, `cameraDepthScale`, `isFocusedOnDrop`, `dropTransitionProgress`, and `audioTime`. All are documented inline.
- **`src/core/audio/AudioEngine.ts`** — Web Audio API wrapper (decode, play/pause). `getCurrentTime()` is the clock that drives the entire game.
- **`src/core/audio/AudioAnalysis.ts`** — hand-rolled offline DSP (no library, despite the stale Meyda comment). Walks PCM in 75ms windows computing overall RMS and a derivative-based "treble" RMS; beats and treble peaks are local maxima above a `mean + 0.5·stdDev` threshold. Also computes, **all FFT-free**: an approximate **spectral centroid** (energy-weighted mean over low/mid/high pseudo-bands from cascaded first/second differences, percentile-normalized 0..1 with a gamma lift) and **spectral flux** (frame-to-frame centroid change), plus **drop regions** (sustained loud passages confirmed over several frames with hysteresis + merging). These populate `MusicMap.spectralSamples` and `MusicMap.dropRegions`.
- **`src/core/track/TrackGenerator.ts`** — builds `TrackData` from the `MusicMap`. Centerline nodes (~10/sec): X = fixed sinusoid, **Y = smoothed RMS energy** (hills track loudness), Z = linear distance. Strong beats mark jump nodes; treble peaks become `TreblePulse` obstacles placed in a cycling lane pattern. **Drop-aware density**: inside confirmed drop regions, obstacle clustering is raised (`dropDensityAt`) so the track gets busier on the music's peaks.
- **`src/core/track/TrackTypes.ts`** — shared data contracts (`TrackNode`, `TreblePulse`, `TrackData`).
- **`src/core/render/ThreeScene.ts`** — by far the largest file (~2,300 lines) and where most behavior lives. Builds the synthwave world (shader sky dome, starfield, retro-sun shader plane, fog, neon grid, ground), the road as a custom `BufferGeometry` ribbon from track nodes, loads GLB models via `GLTFLoader`, owns a pooled GPU particle system (`emitDropBurst` + collision bursts), the **two-composer post pipeline**, the chase camera (look-ahead + banking + drop pull-back), the non-destructive music-driven **camera shake**, the real-time **road morph** (`morphRoadToMusic`), and the **jump/gravity physics**.
- **`src/core/render/` post-processing modules** — small factory/class files composed by `ThreeScene`:
  - `FilmGrainPass.ts`, `VignettePass.ts`, `ChromaticAberrationPass.ts` — `ShaderPass` factories for the cinematic grade (applied **after** tone mapping). Chromatic aberration is driven up by flux + collisions.
  - `NeonCompositePass.ts` — `ShaderPass` that **additively** blends the isolated neon-bloom texture (`tNeon`) onto the primary graded image; the final pass of the selective-bloom hierarchy.
  - `RimGlowShell.ts` — additive Fresnel halo around the hero car (beat/centroid/collision driven, cyan→magenta), parented under the car group; blooms for free via the neon pass.
- **`src/core/render/HudOverlay.ts`** — a pure **Canvas 2D** overlay (no Three.js/Vue). Reads only its `render(musicMap, gameState)` params; never mutates state. Paints a locked rolling BPM (median inter-onset + octave-fold), a beat-phase ring, and bass/mid/treble meters, all sampled against `gameState.audioTime`. Keeps private smoothing state only.

### Render pipeline (two composers + layers)
`ThreeScene` renders each frame in two stages, sharing one shaken camera transform:
1. **Neon isolation (offscreen):** the camera is masked to `HERO_LAYER` and the scene is rendered through `neonComposer` (`RenderPass → exaggerated UnrealBloomPass → OutputPass`) into an offscreen sRGB target. Only the **foreground heroes** (car, rim glow, particles, beat indicator, sword obstacles) carry `HERO_LAYER`, so the sky/sun/starfield are deliberately excluded — otherwise they would fill and wash the additive composite.
2. **Primary (to screen):** the camera is restored to all layers and `composer` renders `RenderPass → UnrealBloomPass → OutputPass → ChromaticAberration → Vignette → FilmGrain`, with `NeonCompositePass` additively blending the offscreen neon texture on top. `OutputPass` does the ACES tone-map + sRGB; the three cinematic passes run **after** it on the display-space image.

Layer scheme: `NEON_LAYER` (1) marks all glowing/emissive objects for the conservative primary bloom; `HERO_LAYER` (2) is the strict foreground subset used for the offscreen isolation render. New emissive objects generally want `layers.set(NEON_LAYER)` and, if they're a foreground hero, `layers.enable(HERO_LAYER)` (use the `setLayerRecursive`/`enableLayerRecursive` helpers for GLB subtrees). Both composers must be resized together (`resize` updates both).

Most music reactivity is **non-destructive and phased off `performance.now()`** against timestamps the controller stamps on game state (`lastBeatTime`, `lastShakeTime`, drop envelope), so the renderer computes envelopes without knowing audio time. The camera shake offset is added before render and subtracted after.

### Cross-cutting things to know
- **The speed constant `50` is duplicated** in `GameController` (`BASE_SPEED_U_PER_SEC`) and `TrackGenerator.generateTrack()`. They must stay equal or the car desyncs from track length. Likewise, road width `7.5` (= 3 × `LANE_WIDTH`) appears as a literal in `ThreeScene`.
- **Car distance is integrated, not absolute.** `GameController.update()` accumulates `distance += Δaudio × 50 × speedMultiplier` (so drops can accelerate the car) and clamps a *separate* render value to track length, keeping the integral uncorrupted. Do **not** revert to `audioTime × 50` — a raw multiplier on that would teleport the car when `speedMultiplier` changes. Seek/rewind/large-Δ frames re-baseline the integral.
- **Jump physics flow render → state → controller.** `ThreeScene.renderFrame` computes vertical motion and writes `gameState.car.verticalOffset`; `GameController.canSteer()` reads it to disable steering while airborne. Vertical state lives in the renderer, not in GameState/Controller.
- **Models** (`public/models/`): code loads `Kart.glb` (player) and `Claymore.glb` (obstacle). `Sports Car.glb` and `Master Sword.glb` exist but are unused. A procedural neon car is built as a fallback if the GLB fails to load. The shared `ANALOGOUS_PALETTE` (teal/cyan/red) is re-applied onto loaded model materials so imported assets match the scene.
- **GSAP** is a dependency but currently unused — all animation is manual `lerp`/`slerp` in `ThreeScene`.
