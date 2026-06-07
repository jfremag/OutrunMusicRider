# CRITIQUE 2 — Re-Gate: "Watercolour Speed" Redesign

**Show-runner re-gate of the final P4.5 frames against reference `02-quality-target-sienkiewicz.png`.**

Frames reviewed:
- `docs/redesign/progress/final/p45-FINAL-static-hero.png` (static hero)
- `docs/redesign/progress/final/p45-FINAL-motion-cruise.png` (motion / cruise)
- `docs/redesign/progress/final/p45-p4-drop-ON-t47.png` (drop state, motion proof)

Reference: `docs/redesign/moodboard/02-quality-target-sienkiewicz.png`

---

## 1. Scorecard — new vs prior gate

| Dimension | Prior gate | New score | Delta | Status |
|---|---:|---:|---:|---|
| Medium & Brushwork | 38 | 58 | **+20** | Pass (just over bar) |
| Palette & Colour Harmony | 42 | 58 | **+16** | Pass (low-contrast version of target) |
| Value & Tonal Range | 29 | 52 | **+23** | Pass (half the range — darks only) |
| Lost-and-found Ink Edges | 52 | 64 | **+12** | Pass (best dimension; still even-ish) |
| Motion / Watercolour Speed | 32 | 48 | **+16** | **Below bar** — engineering pass, artistic fail |
| Composition & Negative Space | 38 | 52 | **+14** | Pass (just past halfway) |
| Hero Subject & Helmet Sheen | 38 | 50 | **+12** | Pass (hero shape, not hero chrome) |

Every single dimension improved. The two largest jumps are exactly the two that anchored the prior gate's failure: **Value (+23, from 29)** and **Medium (+20, from 38)**. Nothing regressed.

---

## 2. Panel average + holistic match-to-reference

| Metric | Prior | New | Delta |
|---|---:|---:|---:|
| **Panel average (7 dims)** | 38 | **55** | **+17** |
| **Holistic match-to-ref-02 (show-runner)** | 34 | **54** | **+20** |

My holistic number (54) sits a notch under the panel mean and I stand behind that: the dimension scores are individually fair, but holistically the frames still fail the single most-load-bearing test — *can you point to one hand-laid brush stroke, or one passage of paper-white light?* On both counts the answer in all three finals is still no. The reference passes both in its first square inch. So the *gestalt* lags the *components*, which is why I hold the overall a hair below the averaged 55.

That said: **this is a real, honest, large move.** +17 panel / +20 holistic in one round is not cosmetic. The frames are no longer a synthwave render. They read as a deliberate, muted, painterly racer on watercolour paper. The medium is genuinely present and in-key.

---

## 3. SHIP verdict

### Verdict: **SHIP — as a strong "v1 painterly racer," NOT as a Sienkiewicz match.**

This is now a **premium, un-synthwave, painterly driving visualiser** and it is worth shipping. The redesign's primary mandate — *kill the neon-synthwave look and replace it with a cohesive hand-medium aesthetic* — is **met**. Tooth, granulation, edge-pooling, bleed, a true warm-ground/cool-sky split, a surgical red accent, real punched darks, a found ink stroke, off-centre placement, a recognisable single hero mass, and live (if subtle) motion drag are all present and mutually coherent. Nothing in the frame screams "3D game render under a filter" the way the 38-gate did. For a real-time NPR pipeline this is a credible, shippable, distinctive look.

**What it is NOT, and shipping should not pretend otherwise:** it does not *match* the reference. The reference is a hand-painted master plate; the app is a real-time render convincingly *printed on* watercolour paper. That gap (~55 vs. an implied 90+ for the reference itself) is the honest ceiling here.

### What genuinely limits it (honest ceiling analysis)

1. **Real-time NPR vs. master-painting ceiling (structural, the dominant limiter).** The defining Sienkiewicz quality is *discrete, countable, form-following brush strokes* — pigment laid as individual lozenges with wet leading edges and dry tails, granulation living *inside* the stroke. The app inverts the hierarchy: a homogeneous high-frequency tooth blankets every region equally (sky, ground, kart, swords share one speckle) over smooth flat fills. `paperAniso=2.8` bristle-stretch is imperceptible at output scale; Kuwahara smooths *along* contours but never deposits a stroke *across* a flat wash. A per-pixel post-process fundamentally cannot synthesise authored brushwork — that needs a stroke-based renderer (oriented stroke splatting along the structure tensor / a "paint deposition" pass keyed to surface flow), which is a different engine, not a constant tweak. This single gap caps Medium, and through it caps the holistic.

2. **The value scale is open at the bottom but capped at the top.** All three finals clamp at luma ~0.92 with **0.0% above 0.92**; the ramp's sheen caps top out near 0.82–0.85 and never reach paper-white. The reference is a *luminous* mid-key (9% near-white: blown helmet sheen, lit chrome, paper margins). The app is a *closed* mid-key — darks arrived, the luminous apex did not. This is the highest-leverage *fixable* limiter: a true paper-white cap + one hero catch-light would lift Value and Hero together.

3. **The matte ground starves the motion system.** The smear machinery is correct and live, but the ground is a near-uniform brown with no value structure for the comet tail to drag — so the streak samples flat colour and can never become legible no matter how velocity is tuned. Motion can't reach the bar until the ground carries banded value/strokes for it to pull. (Fixable, but coupled to limiter #1.)

4. **The fixed kart asset (structural, un-fixable in-shader).** The hero is a low convex dome read from a high chase angle. The sheen lobe is camera-facing (`0.35,0.30,1.0`), so N·H crests at top-centre and *pools* into a circular cream puddle — it physically cannot roll off-flank like the chrome rider's torso sweep. The two pale wheel-pods also out-brighten the hull and fracture the "ONE body" silhouette. A broad off-axis cool-silver sweep wants either a more chrome-readable body or an authored sheen ramp decoupled from N·H; the rounded-kart geometry is a hard constraint on how "chrome hero" this can ever read. The brick-red/rose body + blue seat the colour-block target wanted was also never applied — the hero stays an un-tinted neutral, so the canvas carries only one accent.

**Net:** ship it as the new default look. It is a genuine, defensible aesthetic win and a complete departure from synthwave. Be explicit internally that it is **~55/100 against the master reference** — a strong v1, with a clear (and partly structural) road to a v2 that would need a stroke-based pass, an opened top value end, a value-bearing ground, and either a tinted hero or an authored sheen.

---

## 4. Remaining nits — ranked

Ranked by leverage (impact ÷ effort). Top entries are the cheapest real upgrades toward a v2.

1. **Open the top of the value scale.** Raise the ramp sheen caps and add a true paper-white cap; let the negative-space sky punch from pewter ~0.80 toward paper white. Single highest-ROI fix — directly lifts Value (52) and Hero (50). *Constants only.*
2. **Add one hero catch-light.** A small, bright, off-centre specular hit on the dome that reaches near-white — gives the hero its missing luminous apex without new geometry. Pairs with nit 1.
3. **Tint the hero.** Apply the colour-block target (brick-red/rose body + blue seat) so the canvas carries a *second* surgical accent instead of one lonely oxblood sword. Lifts Palette (58) cheaply. *Material re-tint, no geometry.*
4. **Inject a cool-violet shadow note** into the neutrals so the warm/cool split becomes peach-vs-periwinkle rather than warm-gray vs barely-cool-gray. Lifts Palette + Value perceived contrast.
5. **Defend the range under motion.** Cruise/drop regress to 1.1–1.7% deep blacks and lower std than the static hero — clamp/boost contrast in motion states so the watched image isn't flatter than the hero shot.
6. **Give the ground value structure to smear.** Band the ground wash (value-banded fingers / coarse strokes) so the comet tail has high-contrast material to drag — unblocks Motion (48). Couples to the stroke-pass work.
7. **Push motion drag visibility.** Stronger gain + injected value-banded fingers so the drag reads as wet gouache rather than a gradient; it's invisible at cruise and a soft blotch at drop today.
8. **Break the ink loop.** Fully lose the stroke along ~2–3 long even contours and add swell/taper to 4–5 found accents, so the hero stops reading as an even toon outline. Edges (64) is closest to bar — small editing wins here.
9. **Tilt the horizon / commit a diagonal.** The flat level horizon re-stabilises the composition; a raked horizon (or a larger, leaning hero) would deliver the reference's subject-driven diagonal. (Larger change — camera/layout, not constants.)
10. **De-emphasise the wheel-pods.** Darken them under the hull value so they stop out-brightening the body and fracturing the single-mass silhouette.

---

*Re-gate completed by show-runner. Prior gate: 38 panel / 34 holistic. This gate: 55 panel / 54 holistic. Verdict: SHIP v1 painterly racer; structural ceiling acknowledged.*
