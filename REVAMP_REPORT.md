# Revamp Report — Synthwave Outrun Visualizer

**Branch:** `revamp/synthwave-outrun`
**Date:** 2026-06-06
**Build:** Green (`npm run build` — vue-tsc strict + vite, zero type errors)

---

## Mission

Turn a basic music-driven driving game into a **music-input, rhythm-based, self-driving visualizer** that looks like it was made by *Nintendo meets Wipeout meets synthwave* (Prince — "Computer Blue") on a sunny outrun holiday. The bar: a premium, cinematic product film of the kind **Tesla or Porsche** would release to promote a new car model — one that drives itself through a neon world in perfect sync with the music, responsive to beats, tempo, temperament, and emotional mood, locked at 60fps with 8-bit Nintendo restraint and Wipeout cinematic language.

### North Star
A self-driving, music-reactive synthwave visualizer that feels like a premium automotive promo film: every camera pan, bloom pulse, particle burst, and track shape responds synergistically to beat timing, frequency energy, and emotional mood.

---

## Final Scoring vs. the Rubric

Scores are the autonomous judge's per-iteration ratings (0–100). The revamp ran 10 iterations.

| Axis | Status | Evidence |
|---|---|---|
| **Music input & analysis** | ✅ Strong | Hand-rolled offline DSP (`AudioAnalysis.ts`): RMS beats, derivative-RMS treble peaks, FFT-free spectral centroid + flux, hysteresis-confirmed drop regions. |
| **Rhythm / beat reactivity** | ✅ Strong | Beat-locked FOV punch, bloom pulse, camera shake, beat-indicator glow — gated to *strong* beats only (selectivity = restraint). |
| **Tempo awareness** | ✅ Good | Live rolling BPM in the HUD via median inter-onset interval + octave-folding (locks to a stable tempo). |
| **Temperament / mood** | ✅ Good | Spectral centroid drives sky hue (cyan→magenta), grid emissive, bloom threshold, car emissive; flux drives chromatic aberration + shake texture. |
| **Self-driving** | ✅ Strong | Audio clock is the single source of truth; car distance integrated from the clock; lane-safety auto-dodge; anticipatory look-ahead + banking; drop "throttle hit" acceleration. |
| **Cinematic polish** | ✅ Strong | Two-composer pipeline: ACES tone mapping + sRGB, UnrealBloom, film grain, vignette, chromatic aberration, plus a **selective neon-bloom isolation** pass for the hero car. |
| **Premium UI / HUD** | ✅ Good | Neon "AUDIO SYNC" HUD (BPM, beat-phase ring, 3-band meters) + synthwave loading overlay. |
| **60fps lock** | ✅ Verified | Locked 60fps confirmed in-browser across iterations; pooled GPU particles, allocation-free per-frame paths, shared shaken camera transform across both composer renders. |

**Score trajectory (before → after per iteration):** 57→88, 69→94, 81→94, 75→92, 75→92, 72→92, **85→100**, 83→89, 75→89, 82→92.

- **Starting baseline:** **57** (iteration 1 "before")
- **Final iteration result:** **92** (iteration 10 "after"); peak single-iteration result **100** (iteration 7)
- **Net change from baseline to final:** **+35**

> Note: the per-iteration "before" scores are re-baselined each round by the judge (they do not chain linearly), so the headline figure is the iteration-1 *before* (57) vs. the final iteration-10 *after* (92).

---

## Per-Iteration Changelog

| Iter | Before → After (Δ) | Build | What changed |
|---|---|---|---|
| 1 | 57 → 88 (+31) | ✅ | Post-processing pipeline (EffectComposer: RenderPass → UnrealBloomPass → OutputPass), ACES Filmic tone mapping + sRGB output, beat-synced FOV punch + bloom pulse driven by the audio clock. Commit `fefd95a`. |
| 2 | 69 → 94 (+25) | ✅ | Spectral mood analysis (centroid + flux) + drop-aware obstacle density. Binds sky color, grid glow, bloom, FOV, and obstacle clustering to one music-driven mood. Commit `d42fa09`. |
| 3 | 81 → 94 (+13) | ✅ | Unified music-driven camera shake (beats punch, flux jitters) + pooled GPU particle-burst system with cyan→magenta drop & collision feedback. Commit `2429d9e`. |
| 4 | 75 → 92 (+17) | ✅ | Cinematic post-FX: film grain, vignette, chromatic aberration; beat-locked Fresnel rim glow isolating the hero car (`RimGlowShell`). Commit `dfa65f8`. |
| 5 | 75 → 92 (+17) | ✅ | Flux→chromatic-aberration baseline (treble shimmer as lens fringing); centroid→hero-car emissive isolation; brighter/wider rim "product light". Commit `0775fb5`. |
| 6 | 72 → 92 (+20) | ✅ | Beat selectivity gate (only strong kicks/snares fire flashy gestures — "professional restraint") + anticipatory camera look-ahead and banking into curves. Commit `60dc677`. |
| 7 | 85 → 100 (+15) | ✅ | Hero-car focal bloom isolation + treble-transient particle shimmer (the missing frequency axis). Highest score of the run. Commit `83c73f4`. |
| 8 | 83 → 89 (+6) | ✅ | Real-time spectral-energy road morphing (CPU buffer morph of the road mesh) + synthwave loading-feedback overlay (`LoadingOverlay.vue`). Commit `f692fab`. |
| 9 | 75 → 89 (+14) | ✅ | Drop-boundary hysteresis state machine: car "hits the throttle" (speed 1.0→1.3) and camera pulls back into drops; **true selective bloom** via a second EffectComposer rendering only foreground heroes (HERO_LAYER) → `NeonCompositePass`. Distance now integrated from the audio-time delta with anti-drift self-heal. Commit `a49ee1d`. |
| 10 | 82 → 92 (+10) | ✅ | Premium neon "AUDIO SYNC" HUD overlay (`HudOverlay.ts`): rolling BPM, circular beat-phase ring, three smoothed bass/mid/treble meters, read-only against the MusicMap + audio clock. Commit `7315323`. |

Every iteration shipped a green build and was verified live in a real browser (Playwright). No regressions were recorded in any iteration.

---

## What Was Achieved vs. the Mission

**Delivered, and central to the mission:**

- **Music input → full DSP map.** Decode → analyze → procedural track, all hand-rolled (no DSP library). Beats, treble transients, spectral centroid/flux, and confirmed drop regions are all extracted offline and drive the visuals.
- **Rhythm reactivity with restraint.** FOV punch, bloom pulse, camera shake, and the beat indicator fire **only on strong beats** (kick/snare), while weak transients sustain mood — the "8-bit Nintendo restraint" that reads as premium rather than twitchy.
- **Tempo & frequency made visible.** A neon HUD shows a stable locked BPM, a beat-phase ring rotating once per beat, and three live frequency meters — the "sync transparency" of a polished product.
- **Emotional mood mapping.** Perceived brightness (centroid) sweeps the whole world cyan→magenta (sky, grid, car emissive, rim hue, bloom threshold); volatility (flux) adds lens fringing and shake texture.
- **Self-driving, cinematically.** The car auto-drives off the audio clock, auto-dodges upcoming obstacles via a lane-safety score, anticipates curves with look-ahead + banking, and **accelerates into drops** while the chase camera pulls back — the language of an automotive promo cut.
- **Cinematic image pipeline.** ACES tone mapping + sRGB, UnrealBloom, film grain, vignette, chromatic aberration, and a dedicated **selective neon-bloom isolation** pass that makes the hero car glow without washing out the road/grid.
- **60fps lock** maintained throughout, with pooled particles and allocation-free per-frame work.

**Net effect:** The visualizer now plausibly clears the "premium promo film" bar — a self-driving neon world in sync with the music, with a cohesive synthwave palette, cinematic grading, and a polished HUD.

---

## Known Gaps & Risks

1. **Spectral analysis is FFT-free (approximation).** Centroid/flux/treble are derived from cascaded first/second differences and RMS, not a real FFT. It's monotonic and effective for mood, but the "bands" are pseudo-bands. A true FFT (or the already-installed-but-unused intent behind the stale *Meyda* comment) would give more accurate, more separable frequency content.
2. **Single bundle, ~705 kB (193 kB gzip).** Vite warns the chunk exceeds 500 kB (Three.js dominates). Acceptable for a demo; code-splitting / manual chunks would improve first-load on slower connections.
3. **No automated test or lint coverage.** Type-checking (`vue-tsc` strict) is the only gate. All behavioral verification was manual/Playwright. There is no regression net for the DSP or render math.
4. **`ThreeScene.ts` is very large (~2,315 lines).** It owns the world build, both composers, particles, physics, camera, and the road morph. It is the natural next refactor target (e.g. split camera rig, particle system, and post-pipeline into modules).
5. **Two full-scene render passes per frame.** The selective-bloom isolation renders the scene twice (primary + HERO_LAYER neon). It holds 60fps on the test machine but is the most likely GPU cost on low-end hardware; worth profiling before shipping broadly.
6. **GSAP is still a dependency but unused.** All animation is manual `lerp`/`slerp`. Either adopt it for the timeline-style choreography or drop it to trim install size.
7. **Unused art assets.** `Sports Car.glb` and `Master Sword.glb` ship in `public/models/` but are never loaded.
8. **Sky/sun/starfield are excluded from the neon isolation bloom by design** (so the additive composite doesn't wash the frame). This is correct for legibility but means the *background* neon does not get the exaggerated hero glow — a deliberate trade-off, noted here so it isn't mistaken for a bug.

---

## Recommended Next Steps

1. **Profile on low-end GPU**, then decide whether the double-render selective bloom needs a cheaper path (e.g. a masked single-pass blur) — this is the main 60fps risk away from the dev machine.
2. **Code-split the bundle** (`manualChunks` for `three`) to cut first-load weight.
3. **Consider a real FFT** for analysis to sharpen frequency separation and unlock per-band reactivity (e.g. independent bass/mid/treble visual channels), and remove the stale Meyda comment.
4. **Refactor `ThreeScene.ts`** into focused modules (world, camera rig, particles, post-pipeline, road) before adding more features — it is now the architectural bottleneck.
5. **Add a smoke test / CI gate** that at minimum runs the build and a headless render-without-errors check, so future changes can't silently regress.
6. **Decide on GSAP and unused GLBs** — adopt or remove, to keep the dependency/asset surface honest.
7. **Polish pass on mobile/touch** — current input is keyboard (←/→) only; a self-driving promo should also look right with no input on a phone.

---

*Generated as the closing deliverable of the 10-iteration autonomous revamp on `revamp/synthwave-outrun`.*
