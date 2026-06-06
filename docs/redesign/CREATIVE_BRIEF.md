# Creative Brief — "Watercolour Speed"

**Working title:** *Watercolour Speed* (from the user's own words: "We love the watercolour speed")
**Branch:** `redesign/visual-overhaul`
**Status:** North star. This is the contract the design/research swarm interprets and the build swarm implements against.

---

## North star

A music-driven racing visualiser that looks like a **moving Bill Sienkiewicz / Kent Williams gouache painting** — granulated watercolour, tinted grays, and ruthless colour harmony. It must read as *hand-painted fine art in motion*, a style **not seen in any racing game**.

The bar is the **quality and feel of mood board image `02-quality-target-sienkiewicz.png`** — verified by screenshotting the *running app* with Playwright and comparing back to that reference until they share the same soul.

## This is NOT synthwave. Forbidden forever:

- ❌ Striped retro sun
- ❌ Neon cyan perspective grid
- ❌ Magenta/cyan/purple synthwave gradient sky
- ❌ Chromatic-aberration "neon shimmer", heavy UnrealBloom glow
- ❌ Hard-edged vector flatness (image `03` is a *colour block-in only*, not the target)
- ❌ Any "dime-a-dozen synthwave" cliché

If a choice could appear in a stock synthwave demo, it is wrong.

---

## The visual DNA (from image `02`)

1. **Tinted grays, not neutrals.** The palette is desaturated but never dead — every gray leans warm (taupe) or cool (slate-blue) or dusty (mauve). Sophistication comes from *low saturation + precise hue*, with a *very few* surgical saturated accents (the deep lip-red).
2. **Granulated watercolour gradients.** Pigment settling into paper tooth; wet, blooming edges; visible brush/wash texture. Gradients and grain are the whole point.
3. **Lost-and-found edges.** Forms dissolve into their surroundings; outlines appear only as occasional dark accent strokes — never a uniform toon outline.
4. **"Watercolour speed."** Motion is painted as wet directional smear and blur, not speed-lines or glowing trails.
5. **The helmet shine.** A broad, soft specular highlight rolling across a dark curved form, carrying reflected colour. This is the reference for **car paint**: muted body, soft rolling sheen, reflected environment tint — *no chrome, no neon*.
6. **Painterly composition.** Strong diagonals, generous negative space, grain across the entire frame (paper + pigment).

## Palette (provisional — research swarm to refine into a locked set + LUT)

Muted, harmonious, analogous lavender → rose → putty, with slate + red accents. All values approximate, to be tuned against the references.

| Role | Hex (approx) | Notes |
|---|---|---|
| Sky upper | `#9DA2C4` | periwinkle / lavender-gray |
| Sky lower / field | `#D7AEB6` | dusty rose |
| Road / ground | `#D9C9A6` | putty / warm sand |
| Road edge | `#7E8473` | desaturated sage-gray |
| Car body | `#BD6E7C` | dusty mauve-rose |
| Car glass / cool accent | `#7C93AE` | grainy slate-blue |
| Slate shadow | `#62708A` | cool figure-shadow gray |
| Taupe mid | `#A99B8B` | warm neutral |
| Accent red | `#A8303B` | lips/scarf/blade — used sparingly |
| Ink dark | `#241F22` | near-black accent strokes |
| Paper cream | `#E9E1D2` | substrate / highlights |

## Technical thesis (research swarm to validate / improve)

Keep the working engine (self-driving car AI, audio analysis, physics, HUD plumbing). **Rip out the synthwave post-stack** (neon bloom isolation, chromatic aberration, retro-sun shader, cyan grid). **Replace** with a painterly NPR pipeline, roughly:

1. Render scene with **palette-driven, flat-ish materials** (no PBR neon).
2. **Anisotropic-Kuwahara-style paint pass** — smears the image into paint-like regions that follow local structure (the core "it looks painted" filter).
3. **Watercolour pigment pass** — edge-darkening, pigment **granulation** (multiply a paper-height field), low-freq **UV wobble** for wet edges.
4. **Paper-grain overlay** — cold-press paper tooth as the substrate.
5. **Palette harmonisation** — gradient-map / LUT pulling everything toward the locked muted palette (guarantees colour harmony).
6. **Soft vignette / edge bloom of paper**, no neon.

- **Car:** soft broad specular / matcap "helmet sheen" with reflected palette colour.
- **Motion:** painterly directional smear driven by velocity, replacing neon trails.
- **Obstacles:** painted blades, not glowing swords.
- **Sun/horizon:** a soft watercolour disc or atmospheric horizon — *no stripes* — or removed entirely in favour of a painterly sky wash.
- **Stack:** not married to Three.js, but the expected answer is "keep Three.js, replace the post-pipeline + materials" since the look is fundamentally a post-processing + palette + material problem. Research swarm to confirm with justification.

## Success bar

Screenshot the **running app** (Playwright), place it beside `02-quality-target-sienkiewicz.png`, and a fresh critic agent must judge them as sharing the same **medium, palette, grain, and light**. Iterate until that is true. **No mediocre result is acceptable.**
