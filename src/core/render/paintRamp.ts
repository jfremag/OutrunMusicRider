import * as THREE from 'three'

/**
 * paintRamp.ts — authors the 256x1 gouache luminance ramp consumed by
 * PaintGradeLUTPass (STYLE_SPEC PASS 6, "PALETTE LOCK").
 *
 * The ramp is a hand-painted value gradient built ONLY from the locked palette
 * stops in STYLE_SPEC §2. Sampling scene luminance through it remaps every pixel
 * onto the harmony by construction: no disharmonious colour can physically
 * survive the lookup, so the whole frame is dragged into the tinted-gray
 * "Watercolour Speed" world while the hero keeps a sliver of local hue (the
 * pass blends back toward the source by uChromaPreserve).
 *
 * Authoring law (from the spec):
 *   - Stops walk deep violet-blue shadow (#1E1B22 / #2C2A38) -> steel/rose mid
 *     (#A7A3B1 / #CEB9B9) -> putty highlight (#D9D6CE).
 *   - Luminance MONOTONIC across the full 0..1 range (a luminance LUT MUST be
 *     non-decreasing or it folds the value scale and flickers), with one RARE
 *     PUNCHED DARK near the bottom (the V<22% accent the block-in lacks).
 *   - Tinted grays only — every mid stop carries a rose/steel hue, never neutral
 *     RGB-equal gray.
 *
 * Colour-space contract (load-bearing — see PaintGradeLUTPass for the matching
 * shader note):
 *   PASS 6 runs in DISPLAY-SPACE LDR (after OutputPass has already done the ACES
 *   tone-map + sRGB encode). The pass samples this ramp and blends it DIRECTLY
 *   against the display-space source with NO in-shader pow(2.2). For that blend
 *   to be in one space, the value this texture returns on `texture2D` must be the
 *   display-space (sRGB-encoded) float of the authored hex. We therefore store
 *   the raw sRGB hex bytes verbatim. The texture is tagged `SRGBColorSpace` to
 *   declare intent per the spec; LinearFilter gives the smooth 256-step ramp.
 *
 *   NOTE for the integrator (ThreeScene wiring): EffectComposer's intermediate
 *   render targets are non-colour (no implicit sRGB conversion), so `tDiffuse`
 *   arrives as raw display-space bytes and this ramp's stored bytes line up with
 *   it 1:1. If a future Three.js upgrade starts linearising sampled gradient
 *   reads (double-darkening the graded image), flip `RAMP_COLOR_SPACE` to
 *   `THREE.NoColorSpace` below — the stored bytes are already display-space, so
 *   that is the only change required.
 */

/** Declared colour space for the ramp texture (see the colour-space contract above). */
export const RAMP_COLOR_SPACE = THREE.SRGBColorSpace

/** Number of texels in the 1-D ramp. 256 = one entry per 8-bit luminance level. */
export const RAMP_WIDTH = 256

/**
 * A control stop on the ramp.
 *  - `pos`   : luminance position in 0..1 where this colour lands.
 *  - `hex`   : sRGB hex from the locked palette (STYLE_SPEC §2).
 *  - `label` : palette role, for readability only.
 */
interface RampStop {
  pos: number
  hex: number
  label: string
}

/**
 * The default gouache ramp stops.
 *
 * V2 CORRECTION 3 (PALETTE → GRAYISH-GREEN / DUSTY-PURPLE / WARM-BEIGE). Re-authored
 * away from the old steel-blue / rose axis toward the gradient the user loves in ref 02:
 *
 *   warm tinted near-black  ->  dusty PURPLE/mauve shadow  ->  deep sage-GREEN  ->
 *   grayish-GREEN field (the broad mid)  ->  warm BEIGE  ->  light cream  ->  near-white apex
 *
 * The hue glides SMOOTHLY purple ↔ green ↔ beige (smoothstep per segment in the builder),
 * which is the gradient character of image 02. Perceived LUMINANCE still rises monotonically
 * (each stop lighter than the last) — mandatory for a luminance LUT — and there is exactly ONE
 * rare punched warm near-black anchoring the bottom for the deep darks (correction 4). The
 * green field sits in the broad lower-mid (most scene pixels), beige in the upper-mid, so the
 * frame reads as a muted sage/olive field warming to beige toward the light, with mauve darks.
 */
const DEFAULT_STOPS: RampStop[] = [
  // ralph(iter 5) PALETTE ENRICH: the frame read flat gray-beige rather than ref-02's deliberate
  // gouache with coloured warm/cool drama. The reopened contrast lands on a RICHER harmony now —
  // the darks carry more violet CHROMA (coloured darks, not neutral near-black), the mid mauve/sage
  // stops are nudged a touch more saturated, and the upper-cream stops are cooled toward a luminous
  // (not amber-dingy) cream. Luminance stays monotonic; the single punched dark is preserved.
  //
  // Rare punched dark — deepest COLOURED mauve near-black shadow pool. ralph(iter5): more violet
  // chroma (#1A1422, slightly bluer/redder than green) so the darkest darks read as a deep coloured
  // shadow (ref 02's coloured shattered-glass darks), never a flat neutral black. L still ~0.09.
  { pos: 0.0, hex: 0x1a1422, label: 'coloured mauve near-black' },
  // Deep mauve shadow. ralph(iter5): #382F44 — a touch more violet chroma + value than #322C3A so
  // the sub-0.18 dark band reads as a rich coloured shadow climbing into the field.
  { pos: 0.14, hex: 0x382f44, label: 'deep coloured mauve shadow' },
  // Dusty PURPLE/mauve mid-shadow. ralph(iter5): #504658 — more chroma than #4A4252, the warm-
  // saturated coloured dark bridging into the field.
  { pos: 0.26, hex: 0x504658, label: 'dusty purple shadow' },
  // Dusty purple/mauve mid-shadow. ralph(iter5): #7C7088 — more violet chroma than #7E7488 while
  // held a hair below the sage above it (monotonic), the mauve note bridging into the green field
  // with visible warm/cool drama.
  { pos: 0.34, hex: 0x7c7088, label: 'dusty mauve (#8B7E92 fam)' },
  // Deep sage-GREEN. ralph(iter5): #727F68 — more green chroma than #717C69 AND a touch brighter so
  // it clears the mauve below (keeps the LUT monotonic) — the lower-mid field reads as a deliberate
  // sage, not gray. Sits just above the mauve (mauve -> green glide).
  { pos: 0.46, hex: 0x727f68, label: 'deep sage-green (#6E7A66 fam)' },
  // Grayish-GREEN field LOW. ralph(iter5): #8B9B82 — a touch more sage chroma than #8C9A86 so the
  // DOMINANT mid field (most ground/road pixels) reads as a clear muted green, not gray-beige.
  { pos: 0.6, hex: 0x8b9b82, label: 'grayish-green field low (#8C9A86)' },
  // Grayish-GREEN field HIGH. ralph(iter5): #9BA489 — slightly more sage chroma than #9AA38C; the
  // field plateaus here as the muted green over a wide swath of the value scale.
  { pos: 0.72, hex: 0x9ba489, label: 'sage field high (#9AA38C)' },
  // ralph(iter5): upper-mid cream COOLED further #CCC6AC -> #C9C7B0 (lift green/blue relative to red
  // so it reads as a LUMINOUS COOL cream, not an amber-dingy beige). The sky/bright field lands here;
  // this is ref 02's luminous mid-key cool. Luminance still rises monotonically into the apex.
  { pos: 0.84, hex: 0xc9c7b0, label: 'luminous cool-cream' },
  // ralph(iter5): upper sky/lit negative-space band cooled #DDDAC6 -> #DBDBC8 — a luminous cool cream
  // (green/blue >= red) so the bright sky reads luminous, never dingy beige.
  { pos: 0.91, hex: 0xdbdbc8, label: 'luminous cool-cream light' },
  // Light cream highlight. ralph(iter5): #E6DCC4 -> #E7E2D2 — cooled toward a luminous neutral cream
  // (the warm "white" substitute) so the brightest field/sky resolves luminous-cool, not amber.
  { pos: 0.96, hex: 0xe7e2d2, label: 'light cream highlight' },
  // Near-white APEX — luminous near-neutral paper-white cap (a whisper of warmth). Only the very
  // brightest hero pixels (sun core, helmet-sheen spark) reach it, giving the frame its luminous
  // APEX while the field stays at/below the cream stop.
  { pos: 1.0, hex: 0xf6f4ee, label: 'warm paper-white apex' }
]

/** Unpack a 0xRRGGBB integer into a normalised sRGB triplet (display-space). */
function hexToSrgb(hex: number): [number, number, number] {
  return [
    ((hex >> 16) & 0xff) / 255,
    ((hex >> 8) & 0xff) / 255,
    (hex & 0xff) / 255
  ]
}

/** Smoothstep easing for perceptually gentler stop-to-stop transitions. */
function smoothstep(t: number): number {
  return t * t * (3.0 - 2.0 * t)
}

/**
 * Build the 256x1 gouache ramp as a THREE.DataTexture.
 *
 * Each texel is a piecewise-smooth interpolation between the surrounding palette
 * stops (smoothstep on each segment so the washes plateau like gouache rather
 * than reading as a clean linear gradient). The result is monotonic in luminance
 * by construction of the stop ordering.
 *
 * @param stops Optional custom stop list (e.g. a drop-warmed alternate ramp to
 *              cross-fade toward — the spec mandates a cross-fade, never a hard
 *              swap). Must be sorted ascending by `pos`, span 0..1, and stay
 *              luminance-monotonic. Defaults to {@link DEFAULT_STOPS}.
 */
export function buildPaintRamp(stops: RampStop[] = DEFAULT_STOPS): THREE.DataTexture {
  // RGBA8 so the texture is a plain, widely-supported display-space target.
  const data = new Uint8Array(RAMP_WIDTH * 4)

  // Walk the ramp left-to-right, advancing the active segment as we pass each stop.
  let seg = 0
  for (let i = 0; i < RAMP_WIDTH; i++) {
    const x = i / (RAMP_WIDTH - 1) // luminance position 0..1 for this texel

    // Advance to the segment [stops[seg], stops[seg+1]] that contains x.
    while (seg < stops.length - 2 && x > stops[seg + 1].pos) {
      seg++
    }

    const a = stops[seg]
    const b = stops[seg + 1]
    const span = b.pos - a.pos
    // Local 0..1 within the segment; guard a zero-width span.
    const tRaw = span > 1e-6 ? (x - a.pos) / span : 0.0
    const t = smoothstep(Math.min(Math.max(tRaw, 0.0), 1.0))

    const ca = hexToSrgb(a.hex)
    const cb = hexToSrgb(b.hex)

    const r = ca[0] + (cb[0] - ca[0]) * t
    const g = ca[1] + (cb[1] - ca[1]) * t
    const bl = ca[2] + (cb[2] - ca[2]) * t

    const o = i * 4
    // Store the raw display-space sRGB bytes (see colour-space contract above).
    data[o] = Math.round(r * 255)
    data[o + 1] = Math.round(g * 255)
    data[o + 2] = Math.round(bl * 255)
    data[o + 3] = 255
  }

  const texture = new THREE.DataTexture(
    data,
    RAMP_WIDTH,
    1,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  )
  texture.colorSpace = RAMP_COLOR_SPACE
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  // Clamp so luma exactly 0 or 1 reads the end stops without wrap bleed.
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}
