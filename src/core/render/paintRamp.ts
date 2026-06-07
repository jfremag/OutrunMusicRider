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
 * Hand-placed so perceived LUMINANCE rises monotonically from shadow to
 * highlight (each successive stop is lighter than the last), the hue glides
 * shadow-violet -> steel/rose mid -> warm putty, and there is exactly ONE rare
 * punched dark anchoring the very bottom. Positions are slightly eased toward the
 * mid so the dominant steel-violet field (palette #3, the largest area in ref 02)
 * occupies the broad middle of the value scale where most scene pixels sit.
 */
const DEFAULT_STOPS: RampStop[] = [
  // Rare punched dark — deepest warm shadow pool / negative-space floor (V<22%).
  { pos: 0.0, hex: 0x1e1b22, label: 'warm tinted near-black (#17)' },
  // Deep body near-black — hue-preserving violet-blue core shadow.
  { pos: 0.14, hex: 0x2c2a38, label: 'deep body near-black (#9)' },
  // Body shadow violet — warmest/most-saturated dark of the form (Sienkiewicz inversion).
  { pos: 0.3, hex: 0x706675, label: 'body shadow violet (#8)' },
  // Steel-violet field — DOMINANT neutral; anchors the lower-mid of the value scale.
  { pos: 0.52, hex: 0xa7a3b1, label: 'steel-violet field (#3)' },
  // Lit steel-blue — the COOL upper-mid. This is the broad band most bright negative-space
  // pixels (the airy sky + cool field, ref 02's largest quiet area) land in, so the luminous
  // negative space reads COOL steel-blue like the reference. R-FINAL P1 WIDENS the cool band a
  // touch (0.66..0.84) and cools the hex slightly so the now-brighter sky holds its cool against
  // ACES/tooth desaturation instead of warming into a rosy putty haze (which collapsed the split).
  { pos: 0.66, hex: 0xb6bdd2, label: 'lit steel-blue (#4) — cool band low' },
  { pos: 0.84, hex: 0xc4cadd, label: 'lit steel-blue (#4) — cool band high' },
  // Rose-gray field — the WARM desaturated counterweight, a narrow warm note near the highlight cap
  // (the warm half of the split). Brightened to #DDCBC8 (luma ~0.82) so the ramp stays luminance-
  // MONOTONIC between the cool-band-high stop (~0.79) and the putty cap (~0.84).
  { pos: 0.92, hex: 0xddcbc8, label: 'rose-gray field (#5)' },
  // Paper putty — the warm "white" substitute / gouache highlight cap. Sits just under the very top.
  { pos: 0.96, hex: 0xd9d6ce, label: 'paper putty highlight (#1)' },
  // Sheen Peak — the COOL blue-violet highlight cap (STYLE_SPEC §2 #10: "Helmet-shine core tints
  // here"). Placed at the very top so ONLY the brightest hero pixels — the helmet sheen crest and
  // the sun's achromatic-to-cool core (§5) — resolve COOL rather than being warmed into putty by
  // the luminance lock. Luma (~0.85) sits just above putty so the ramp stays monotonic. This is
  // what lets the broad rolling sheen survive the palette lock as a cool feature, not a warm glaze.
  { pos: 1.0, hex: 0xd7d7e6, label: 'sheen peak cool highlight (#10)' }
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
