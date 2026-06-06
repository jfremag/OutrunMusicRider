import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'

/**
 * ColorGradePass — the cinematic "grade" that lifts the image from a clean render to a
 * premium, professionally-finished frame (live-tuning pass).
 *
 * Runs on the tone-mapped, display-space image (inserted right after OutputPass, before
 * SMAA/lens FX) and applies, in order:
 *   1. Vibrance — saturation that is stronger on dull pixels and gentler on already-
 *      saturated neon, so the sky/road gain richness without the neon clipping to mush.
 *   2. Teal–orange split-tone — the signature blockbuster/synthwave separation: shadows
 *      drift toward teal, highlights toward warm orange, so the warm sun and cool neon
 *      read as one deliberate "sunny outrun" colour language instead of two palettes.
 *   3. Warmth — a small global temperature push (R up, B down) for the holiday-sun feel.
 *   4. Contrast + lift — a gentle S-curve around mid-grey for punch without crushing.
 *
 * Holds no frame state (idempotent). All amounts are uniforms so they can be dialled in
 * live. Defaults are intentionally subtle — a grade should be felt, not seen.
 *
 * Uniforms:
 *   tDiffuse   — input colour (wired by EffectComposer automatically)
 *   saturation — vibrance amount (0 = off; ~0.2 = lush)
 *   splitTone  — teal/orange split-tone strength (0 = off)
 *   warmth     — global temperature push toward orange (small, ~0.01–0.03)
 *   contrast   — gentle contrast around 0.5 (0 = off)
 *   lift       — flat brightness add (usually 0)
 */
export function createColorGradePass(opts: {
  saturation?: number
  splitTone?: number
  warmth?: number
  contrast?: number
  lift?: number
} = {}): ShaderPass {
  return new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      saturation: { value: opts.saturation ?? 0.2 },
      splitTone: { value: opts.splitTone ?? 0.5 },
      warmth: { value: opts.warmth ?? 0.018 },
      contrast: { value: opts.contrast ?? 0.07 },
      lift: { value: opts.lift ?? 0.0 }
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
      uniform float saturation;
      uniform float splitTone;
      uniform float warmth;
      uniform float contrast;
      uniform float lift;

      void main() {
        vec3 c = texture2D(tDiffuse, vUv).rgb;
        float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));

        // 1. Vibrance: push dull pixels harder than already-saturated neon.
        float curSat = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
        c = mix(vec3(luma), c, 1.0 + saturation * (1.0 - curSat));

        // 2. Teal-orange split-tone, weighted by where the pixel sits tonally.
        float hi = smoothstep(0.35, 0.95, luma);
        float lo = 1.0 - smoothstep(0.04, 0.55, luma);
        vec3 teal = vec3(-0.05, 0.03, 0.07);   // shadows drift teal
        vec3 orange = vec3(0.08, 0.025, -0.06); // highlights drift warm
        c += (teal * lo + orange * hi) * splitTone;

        // 3. Global warmth (holiday-sun temperature).
        c += vec3(warmth, warmth * 0.15, -warmth);

        // 4. Gentle contrast around mid-grey + flat lift.
        c = (c - 0.5) * (1.0 + contrast) + 0.5 + lift;

        gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
      }
    `
  })
}
