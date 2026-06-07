# "Watercolour Speed" — Final Gate Critique

Redesign target: a Three.js racer reskinned as a moving Sienkiewicz gouache painting.
Reference: `docs/redesign/moodboard/02-quality-target-sienkiewicz.png`
Frames judged: `docs/redesign/progress/final/f1-t6.png`, `f2-t11.png`, `f3-t16.png`

---

## 1. Panel Scorecard

| # | Dimension | Score | Verdict (one-liner) |
|---|-----------|------:|---------------------|
| 1 | Medium & Brushwork (gouache surface vs clean render) | **38** | FAIL — surface carries ~1/5 of ref's texture energy (8x8 luma-std 0.015 vs 0.070); brush/granulation machinery present but starved into a razor-thin high-key band. |
| 2 | Palette & Colour Harmony | **42** | SHIP-BLOCKER — one-temperature warm wash; warm/cool ratio 367–2291x vs ref 0.9x; cool counterweight and signal-red accent effectively absent. |
| 3 | Value & Tonal Range | **29** | FAIL — flat mid-key wash; global luma std ~0.08 vs ref 0.243; ~1% true darks vs 10.7%; whole ground/sky tiles dead-flat. Deficit is upstream (flat fill lighting), not the LUT. |
| 4 | Lost-and-found Ink Edges | **52** | PARTIAL — swords carry confident broken ink, but the HERO CAR has zero found weight (silhouette 100% lost); reads unfinished. |
| 5 | Motion / Watercolour Speed | **32** | FAIL — keystone velocity-smear ships inert (smearON ≈ smearOFF); world held razor-sharp; reads as a static gouache, not a moving one. |
| 6 | Composition & Negative Space | **38** | FAIL — signature lower-left→upper-right raking diagonal absent; hero on the vertical centerline, horizon a dead-flat bisecting band (COMPOSE_* tuned for FOV 75, lens is now 50). |
| 7 | Hero Subject & Helmet Sheen | **38** | PARTIAL — sheen shader correct but mounted on an open-frame kart that can't host one broad rolling cool lobe; reads as four neutral wheel-blobs (cool fraction ~6%), simultaneously weak AND over-busy. |

---

## 2. Scores

- **Panel average: 38 / 100**
- **Show-runner holistic match-to-ref-02: 34 / 100**

Holistic note: I score slightly *below* the panel average because the three judged frames share two cross-cutting failures that several panelists flagged as "off my dimension" but which compound into a worse whole-frame read than any single axis suggests:
1. **The painterly post-stack is barely landing in these frames.** The fields read as a near-raw, glassy 3D render with a faint grain — the Kuwahara/pigment/paper/LUT stack that the whole redesign depends on is not visibly biting. Every "surface/value/medium" critique independently triangulates the same root cause (a structureless, crushed mid-key field starves every pass downstream), which is why four separate dimensions all fail for one upstream reason.
2. **The file-picker + BPM/HUD UI is still on screen** in all three frames. A premium "automotive promo film" final frame cannot ship with the dev chrome composited over the painting.

The good news the panel is unanimous on: this is **not** a missing-feature problem. Every pass needed (anisotropic Kuwahara, pigment, substrate paper, edge ink, velocity smear, paint-grade LUT, car-sheen) is built, ordered correctly, and capable. The failure is a **starvation/tuning** failure concentrated upstream in lighting and the value range, plus three localized retunes. That makes this recoverable in one focused round, not a rebuild.

---

## 3. Prioritised Final-Polish Punch List (highest impact first)

These are ordered so that fixing #1 unblocks and amplifies #2 and #3 — they are not independent. Do them in order.

### P1 — Restore real value structure at the SOURCE (lighting), then re-anchor the LUT darks
**What:** Stop flat-flooding the scene. In `ThreeScene.ts`: drop `AmbientLight` 0.55 → ~0.22 and recolor it to the steel-violet shadow fill `#A7A3B1`; drop `HemisphereLight` to ~0.35 and cool its ground-bounce (`#f0e3d6` → ~`#B8BBCE`); raise the oblique `DirectionalLight` 0.85 → ~1.6; lower `toneMappingExposure` 1.55 → ~1.15. Then in `PaintGradeLUTPass.ts` lift `uBlackPoint` 0.34 → ~0.42, `uShadowDepth` → 1.0, `uContrast` 1.22 → ~1.5.
**Why:** This is the master fix. Dimensions 3 (Value, 29), 1 (Medium, 38) and 2 (Palette, 42) ALL fail for the same upstream reason — the matte flat-lit scene crushes every pixel into a 7-point mid-key band (p10–p90 ≈ 0.60–0.74), so the LUT's cool/dark/ink ramp stops are never sampled, the granulation bells fire at ~10–20% gain, and the Kuwahara tensor has no gradient to orient on. Restoring Lambert falloff manufactures the per-pixel value spread that re-arms all three downstream stacks at once.
**Pass/file/uniform:** `ThreeScene.ts` (AmbientLight, HemisphereLight, DirectionalLight intensities + colors, toneMappingExposure); `PaintGradeLUTPass.ts` (uBlackPoint, uShadowDepth, uContrast).
**Expected gain:** Value 29 → ~60+ (target global std ≥0.18, darks ≥6%, no ground/sky tile under std 0.10). Directly lifts Medium and Palette by feeding them structure. Single biggest panel-average mover.

### P2 — Re-pivot/widen the granulation bells + lift surface energy + add a posterize step
**What:** In `WatercolourPigmentPass.ts:231` and `SubstratePaperPass.ts:247` change the granulation luma-bell from `exp(-pow((luma-0.40)/0.20, 2.0))` to `exp(-pow((luma-0.62)/0.30, 2.0))`. Raise `SubstratePaperPass` `granDensity` 0.26 → 0.34 and `paperStrength` 0.16 → 0.21; raise `WatercolourPigmentPass` `granulation` 0.28 → 0.36. Add a mild ~7-level posterize to `PaintGradeLUTPass` so smooth gouache value plateaus become step-edges the Kuwahara tensor and pigment edge-darken can grab.
**Why:** Even after P1 widens the value range, the bells still peak at 0.40 — below where most of the frame sits. Re-pivoting them to the frame's median (~0.62) makes the tooth and granulation bite in the BRIGHT washes where 60–70% of the picture lives (ref 02's bright sky is alive with tooth; ours is dead-smooth). The posterize converts smooth tinted gradients into facetted washes with darkened plateau boundaries — the literal signature of gouache.
**Pass/file/uniform:** `WatercolourPigmentPass.ts` (line 231 bell, line 93 granulation); `SubstratePaperPass.ts` (line 247 bell, line 99 paperStrength, line 100 granDensity); `PaintGradeLUTPass.ts` (new posterize). Stay under the 0.4/0.22 "dirt" ceilings.
**Expected gain:** Medium 38 → ~60 (target 8x8 luma-std ≥0.045). Sharpens every form via the re-armed tensor.

### P3 — Land the raking diagonal + give the hero ONE shadow-side found stroke + hide dev UI
**What:** Three coordinated stance fixes. (a) `ThreeScene.ts` composition, re-measured for the 50mm lens: `COMPOSE_LOOK_YAW` -0.24 → ~-0.36, `COMPOSE_PITCH` 0.05 → ~0.11 rad, add a `COMPOSE_LOOK_OFFSET` (~+0.6u along smoothedRight) to seat the kart in the lower-left quadrant. (b) `PainterlyEdgePass.ts`: add a shadow-side-biased hero-silhouette ink term (per-pixel `clamp(0.5 - dot(grad-luma, uLightDir2D),0,1)`), gated to a new `tHeroMask` (reuse the HERO_LAYER mask already wired for the smear) with a separate `heroInkGain` ~3.0 / `uEdgeDilate` ~2.6, so the kart's outer edge inks heavily on its shaded side without reviving the interior tangle the current normalThresh 0.55/depthThresh 1.1 was suppressing. (c) Hide the file-picker panel and HUD/BPM chrome for the final/promo capture.
**Why:** Composition (38) and Hero edges (52) are the two dimensions that read "unfinished" rather than "wrong." The raking diagonal is the reference's compositional spine; the hero's one heavy broken shadow-side stroke is what says "finished Sienkiewicz." And no final frame ships with dev chrome over the painting.
**Pass/file/uniform:** `ThreeScene.ts` (COMPOSE_LOOK_YAW, COMPOSE_PITCH, new COMPOSE_LOOK_OFFSET; UI visibility for capture); `PainterlyEdgePass.ts` (shadow-side term, tHeroMask, heroInkGain, uEdgeDilate).
**Expected gain:** Composition 38 → ~58, Hero edges 52 → ~65. Converts a centered one-point racer into a dynamic, anchored composition.

### P4 — Turn the velocity smear ON with an injected track-flow drag
**What:** In `VelocitySmearPass.ts` add `uFlowDir` (vec2) + `uFlowGain`; compute `flowVel = uFlowDir * uFlowGain * (0.25 + 0.75*rawDepthRamp) * uSpeedMul` with a widened depth ramp, and set working velocity = reconstructed + flowVel BEFORE the clamp. Derive `uFlowDir` each frame in `ThreeScene.ts` by projecting a point ~80–120u ahead down the centerline into clip space (using the cached shaken `curViewProj` ~line 1920) minus the car's clip position. Keep the asymmetric tail, HERO_LAYER sharp mask, and value-not-chroma rule.
**Why:** Motion (32) fails because in this chase view the camera translates along its own axis, so the natural reprojection velocity is a sub-pixel radial zoom — smearON is indistinguishable from smearOFF. A gouache speed painting depicts motion as a directional value-drag, not literal inter-frame displacement, so injecting a track-aligned flow floor is the correct (and only) way to make the keystone "world rushes past, hero held sharp" read actually happen.
**Pass/file/uniform:** `VelocitySmearPass.ts` (uFlowDir, uFlowGain, depth ramp, velocity combine); `ThreeScene.ts` (per-frame uFlowDir derivation). Tune uFlowGain so streak length ≈ SMEAR_MAX_REST (~0.05 UV) at speedMultiplier≈1.
**Expected gain:** Motion 32 → ~60. Lower priority than P1–P3 because it does not show in stills; verify in motion capture.

### P5 (optional, if time) — Give the sheen a body to roll across
**What:** In `ThreeScene.ts` add one low-poly rounded cowl/canopy hull over the open kart frame carrying `CarSheenMaterial`, and lerp the inner struts/seat/skull albedo hard toward deep-body violet so the busy interior reads lost. In `CarSheenMaterial.ts` re-aim `DEFAULTS.dir` from `normalize(0.30,0.62,0.95)` (sky-biased, catches wheel tops) toward ~`normalize(0.35,0.30,1.0)` (camera-facing).
**Why:** Hero sheen (38) fails because the lobe lands on four horizontal wheel caps (neutral gray, cool fraction ~6%) instead of one continuous body. The shader is correct; it just needs a canopy to sweep and a camera-facing aim.
**Pass/file/uniform:** `ThreeScene.ts` (canopy mesh, interior albedo demotion); `CarSheenMaterial.ts` (DEFAULTS.dir).
**Expected gain:** Hero sheen 38 → ~58 (cool fraction well above 6%, one rolling band not four dots).

---

## 4. Verdict

**NOT SHIP-READY.** One more focused polish round is warranted before this can be called a premium, un-synthwave painterly racer.

Panel average 38/100, holistic 34/100. Five of seven dimensions FAIL or are PARTIAL, and the two highest-weighted axes for "is this a painting" — Value (29) and Medium/Brushwork (38) — are the weakest. In the judged frames the picture currently reads as a **flat mid-key 3D render with a faint grain and dev UI on top**, not a Sienkiewicz gouache: no value structure, one warm temperature, no surface tooth in the bright fields, a static (un-smeared) world, a centered composition, and a hero with no calligraphic anchor.

**But the diagnosis is encouraging and consistent.** Every panelist independently confirms the full painterly pipeline is built, correctly ordered, and capable — the ramp spans 0.11–0.85, the comet machinery is sound, the sheen maths is right. This is a **starvation-and-tuning** failure, not a missing-feature one, and four of the failures share a single upstream root cause (flat fill lighting crushing the value range), so **P1 alone re-arms three dimensions at once.**

**Recommended round (≈1–1.5 days):** Execute P1→P2→P3 (the still-visible fixes: value/lighting, surface tooth, composition + hero stroke + hide UI), re-shoot t6/t11/t16 via the `window.__game` + Playwright hook, and re-measure the three objective metrics the panel anchored on — global luma std (target ≥0.18), 8x8 local luma-std (target ≥0.045), and warm/cool chroma ratio (drive toward ~1). Then add P4 (motion) and verify in a moving capture, and P5 (sheen) if time allows. Re-gate after the re-shoot; do not ship on the current frames.
