import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { buildPaintRamp } from './paintRamp'

/**
 * PaintGradeLUTPass — STYLE_SPEC PASS 6, "PALETTE LOCK". REPLACES ColorGradePass.
 *
 * Remaps each pixel's LUMINANCE through a hand-authored 256x1 gouache ramp
 * (see paintRamp.ts) and blends toward that ramp so the entire frame is pulled
 * onto the locked tinted-gray harmony BY CONSTRUCTION — no disharmonious colour
 * can physically survive the lookup. A small `uChromaPreserve` keeps a sliver of
 * the source's local hue alive (so the hero car/accents read as colour, not flat
 * gray), an optional soft posterize gives gouache value plateaus, and a final
 * TPDF (triangular) dither stops the 8-bit quantise from banding.
 *
 * Runs in DISPLAY-SPACE LDR (inserted after the Kuwahara/pigment passes, which
 * are all after OutputPass). Holds no per-frame state (idempotent); every knob is
 * a uniform so it can be dialled live or driven by music (the spec rotates a tiny
 * `uHueShift` toward rose on drops — exposed here for that, kept at 0 by default).
 *
 * Colour-space note (must stay in sync with paintRamp.ts): the ramp stores raw
 * display-space sRGB bytes and the shader does NO in-shader pow(2.2), so `graded`
 * and `src` are blended in the same display space. See paintRamp.ts for the full
 * contract and the one-line toggle if a Three.js upgrade changes sampled-texture
 * colour conversion.
 *
 * Uniforms:
 *   tDiffuse        — input colour (auto-wired by EffectComposer).
 *   tGradient       — the 256x1 ramp DataTexture. Defaults to buildPaintRamp();
 *                     ThreeScene may overwrite `.value` to cross-fade ramps.
 *   uGradeAmount    — blend toward the graded result (~0.82). 1 = full lock.
 *   uChromaPreserve — how much source colour survives inside the graded mix
 *                     (~0.22). Higher = the hero keeps more local hue.
 *   uPosterize      — gouache value plateaus: >0.5 enables, and the VALUE is the
 *                     level count (e.g. 7.0 => 7 levels). 0 = off (smooth).
 *   uDither         — TPDF dither amplitude in 1/255 units (~1.0 = ~1 LSB).
 *   uHueShift       — small hue rotation (radians) toward rose for drops; 0 = off.
 */
export function createPaintGradeLUTPass(opts: {
  gradeAmount?: number
  chromaPreserve?: number
  posterize?: number
  dither?: number
  hueShift?: number
  /** Provide a custom ramp DataTexture; otherwise the default gouache ramp is built. */
  gradient?: import('three').DataTexture | null
} = {}): ShaderPass {
  return new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      // Build the default locked-palette ramp so the pass works standalone; the
      // integrator can still overwrite `.value` later (e.g. to swap/cross-fade).
      tGradient: { value: opts.gradient ?? buildPaintRamp() },
      uGradeAmount: { value: opts.gradeAmount ?? 0.82 },
      uChromaPreserve: { value: opts.chromaPreserve ?? 0.22 },
      uPosterize: { value: opts.posterize ?? 0.0 },
      uDither: { value: opts.dither ?? 1.0 },
      uHueShift: { value: opts.hueShift ?? 0.0 }
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform sampler2D tGradient;
      uniform float uGradeAmount;
      uniform float uChromaPreserve;
      uniform float uPosterize;
      uniform float uDither;
      uniform float uHueShift;

      // Cheap hash for the dither (two summed evaluations make it triangular).
      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      // --- RGB <-> HSV, used only for the tiny optional hue rotation toward rose. ---
      vec3 rgb2hsv(vec3 c) {
        vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
        vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
        vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
        float d = q.x - min(q.w, q.y);
        float e = 1.0e-10;
        return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
      }
      vec3 hsv2rgb(vec3 c) {
        vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
        vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
        return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
      }

      void main() {
        vec3 src = texture2D(tDiffuse, vUv).rgb;

        // Rec.709 luminance — the lookup coordinate into the gouache ramp.
        float luma = dot(src, vec3(0.2126, 0.7152, 0.0722));

        // PALETTE LOCK: map luminance through the hand-authored ramp.
        // LinearFilter on the 256x1 ramp gives a smooth value gradient; sample at
        // row centre (v = 0.5). NO in-shader pow — ramp + src share display space.
        vec3 graded = texture2D(tGradient, vec2(clamp(luma, 0.0, 1.0), 0.5)).rgb;

        // Keep a sliver of the source's local hue so the hero/accents stay colour,
        // not dead gray; then blend the whole thing toward the locked grade.
        vec3 col = graded * (1.0 - uChromaPreserve) + src * uChromaPreserve;
        col = mix(src, col, uGradeAmount);

        // Optional tiny hue rotation toward rose (music drives this on drops).
        // Branch is uniform-controlled (every fragment takes the same path).
        if (abs(uHueShift) > 0.0001) {
          vec3 hsv = rgb2hsv(col);
          hsv.x = fract(hsv.x + uHueShift);
          col = hsv2rgb(hsv);
        }

        // Optional soft posterize for gouache value plateaus. The uniform doubles
        // as enable flag (>0.5) and as the level count, matching the spec snippet.
        if (uPosterize > 0.5) {
          col = floor(col * uPosterize) / uPosterize;
        }

        // TPDF (triangular) dither: two summed hashes in [0,1) -> noise in [-1,1),
        // scaled to ~1 LSB so the quantise / 8-bit output never bands.
        float tpdf = hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + 17.0) - 1.0;
        col += tpdf * (uDither / 255.0);

        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }
    `
  })
}
