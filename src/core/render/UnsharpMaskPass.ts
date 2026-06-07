import * as THREE from 'three'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'

/**
 * UnsharpMaskPass — a SUBTLE final crisp-up for "Watercolour Speed".
 *
 * ref 02's Sienkiewicz print is knife-CLEAN and print-sharp; the Kuwahara + pigment + paper
 * stack, while correctly painterly, leaves edges a touch soft. This adds a classic unsharp-mask
 * (sharpen = base + amount*(base - blur)) tuned to crisp the painted FORMS without the two
 * failure modes the brief calls out:
 *
 *   - NO HALOS: the high-frequency detail is taken from a small 5-tap blur and the boost is
 *     clamped (`maxBoost`), so a strong contour gets a clean crisp-up, never a bright/dark ring.
 *   - NO AMPLIFIED GRAIN: the sharpen is gated by a `threshold` (a soft deadzone on the detail
 *     magnitude) so flat-field micro-texture (the fine print grain / paper tooth) is left ALONE
 *     and only genuine edges above the threshold are sharpened. This is why it must run on the
 *     painted CONTENT, BEFORE the SubstratePaper grain is laid down (so paper grain is untouched).
 *
 * Operates on LUMA only by sharpening the value and re-applying it to the original chroma
 * (`out = base * (sharpenedLuma / luma)`), so there is zero chroma fringing — the palette's hues
 * are preserved exactly; only value contrast at edges is crisped. Runs in display-space LDR like
 * the rest of the post-OutputPass stack.
 *
 * Uniforms:
 *   tDiffuse   input colour (auto-wired by EffectComposer)
 *   texel      1 / drawing-buffer size (vec2) — blur tap spacing
 *   amount     unsharp strength (how hard edges are crisped; subtle, ~0.6)
 *   radius     blur tap spacing multiplier in px (how wide an "edge" is; ~1.0)
 *   threshold  detail-magnitude deadzone (below this the pixel is NOT sharpened → grain safe)
 *   maxBoost   hard clamp on the value boost so a strong contour can't ring/halo
 */
export function createUnsharpMaskPass(opts: {
  resolution?: [number, number]
  amount?: number
  radius?: number
  threshold?: number
  maxBoost?: number
} = {}): ShaderPass {
  const [rx, ry] = opts.resolution ?? [1920, 1080]
  return new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      texel: { value: new THREE.Vector2(1 / rx, 1 / ry) },
      amount: { value: opts.amount ?? 0.6 },
      radius: { value: opts.radius ?? 1.0 },
      threshold: { value: opts.threshold ?? 0.015 },
      maxBoost: { value: opts.maxBoost ?? 0.16 }
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform vec2  texel;
      uniform float amount;
      uniform float radius;
      uniform float threshold;
      uniform float maxBoost;
      float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
      void main() {
        vec3 base = texture2D(tDiffuse, vUv).rgb;
        float lc = luma(base);

        // Small symmetric 5-tap (+ shape) blur of LUMA → the low-frequency reference.
        vec2 r = texel * radius;
        float lb = lc * 0.4;
        lb += luma(texture2D(tDiffuse, vUv + vec2(r.x, 0.0)).rgb) * 0.15;
        lb += luma(texture2D(tDiffuse, vUv - vec2(r.x, 0.0)).rgb) * 0.15;
        lb += luma(texture2D(tDiffuse, vUv + vec2(0.0, r.y)).rgb) * 0.15;
        lb += luma(texture2D(tDiffuse, vUv - vec2(0.0, r.y)).rgb) * 0.15;

        // High-frequency detail = value minus its local blur.
        float detail = lc - lb;

        // GRAIN-SAFE DEADZONE: soft-threshold the detail magnitude so flat-field micro-texture
        // (print grain / paper tooth) below the threshold contributes ~0 boost, while genuine
        // edges pass through. A smoothstep ramp keeps the onset gentle (no switching artefact).
        float keep = smoothstep(threshold, threshold * 3.0, abs(detail));
        float boost = clamp(detail * amount * keep, -maxBoost, maxBoost);

        // Re-apply the sharpened VALUE to the original chroma (no chroma fringing).
        float newL = max(lc + boost, 1e-4);
        vec3 outC = base * (newL / max(lc, 1e-4));
        gl_FragColor = vec4(clamp(outC, 0.0, 1.0), 1.0);
      }
    `
  })
}
