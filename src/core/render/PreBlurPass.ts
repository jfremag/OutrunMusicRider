import * as THREE from 'three'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'

/**
 * PreBlurPass — PASS 1 of the "Watercolour Speed" painterly stack.
 *
 * A tiny separable-weight gaussian (selectable 3x3 or 5x5 footprint, applied as a
 * single 2D tap kernel) that softens the tone-mapped display-space image *before* the
 * structure tensor is computed. Its only job is to kill render aliasing and specular
 * sparkle so PASS 2's Sobel gradients — and therefore the stroke-orientation field that
 * steers the whole gouache look — are STABLE and don't crawl frame-to-frame.
 *
 * This deliberately replaces SMAA's role: the painterly pipeline *wants* a soft input.
 * Anti-aliasing applied AFTER the paper pass would smooth away the very cold-press tooth
 * we add, so all softening happens here, up front. Cheap (~0.1 ms), large quality win.
 *
 * Runs in display-space LDR (after OutputPass), like every pass in this stack.
 *
 * The kernel size is chosen at construction time so the GLSL loop bounds stay
 * compile-time constant (GLSL ES 1.00 forbids dynamic loop limits): we ship two
 * separate fragment shaders rather than a runtime-variable loop.
 *
 * Uniforms:
 *   tDiffuse — input colour (wired automatically by EffectComposer)
 *   texel    — 1 / drawingBufferResolution (vec2), set/updated by ThreeScene.resize()
 *              in drawing-buffer pixels so the blur footprint is resolution-stable.
 */

// Standard normalized 1D gaussian weights (sigma chosen so the small footprint is a
// gentle smooth — not a box). The full 2D kernel is the separable outer product
// w[x] * w[y]; we bake the 1D weights as plain float literals and form the taps
// explicitly (NO GLSL-ES-3.00 array constructors — ShaderPass compiles ES 1.00).
//   3x3 (radius 1): sigma ~1.0  -> [0.25, 0.5, 0.25]
//   5x5 (radius 2): sigma ~1.4  -> [0.0625, 0.25, 0.375, 0.25, 0.0625]
// We index the 1D weight by integer offset via a tiny branch helper so the loops stay
// fixed compile-time bounded and ES-1.00-legal (no const-array initializers).

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

/** 3x3 footprint — gaussian sigma ~1.0. Cheapest; use when the render is already clean. */
const FRAGMENT_3X3 = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform vec2 texel;

  // 1D gaussian weight for radius-1 (sigma ~1.0) by integer offset i in [-1, 1].
  float w1(int i) {
    if (i == 0) return 0.5;
    return 0.25; // |i| == 1
  }

  void main() {
    vec3 sum = vec3(0.0);
    // Fixed compile-time bounds (GLSL ES 1.00 safe). 9 taps total, separable weights.
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 off = vec2(float(x), float(y)) * texel;
        sum += texture2D(tDiffuse, vUv + off).rgb * (w1(x) * w1(y));
      }
    }
    gl_FragColor = vec4(sum, 1.0);
  }
`

/** 5x5 footprint — gaussian sigma ~1.4. A touch softer; the default for stable tensors. */
const FRAGMENT_5X5 = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform vec2 texel;

  // 1D gaussian weight for radius-2 (sigma ~1.4) by integer offset i in [-2, 2].
  // [0.0625, 0.25, 0.375, 0.25, 0.0625] (sums to 1.0).
  float w2(int i) {
    if (i == 0) return 0.375;
    if (i == -1 || i == 1) return 0.25;
    return 0.0625; // |i| == 2
  }

  void main() {
    vec3 sum = vec3(0.0);
    // Fixed compile-time bounds (GLSL ES 1.00 safe). 25 taps total, separable weights.
    for (int y = -2; y <= 2; y++) {
      for (int x = -2; x <= 2; x++) {
        vec2 off = vec2(float(x), float(y)) * texel;
        sum += texture2D(tDiffuse, vUv + off).rgb * (w2(x) * w2(y));
      }
    }
    gl_FragColor = vec4(sum, 1.0);
  }
`

/**
 * Build the PreBlur pass.
 *
 * @param opts.kernel  '3x3' (sigma ~1.0) or '5x5' (sigma ~1.4, default). Fixed at
 *                     construction so the GLSL loop stays compile-time bounded.
 * @param opts.texel   initial 1/resolution (vec2 as [x, y]); ThreeScene overwrites this
 *                     in its constructor + resize() with the real drawing-buffer texel.
 */
export function createPreBlurPass(opts: {
  kernel?: '3x3' | '5x5'
  texel?: [number, number]
} = {}): ShaderPass {
  const kernel = opts.kernel ?? '5x5'
  const [tx, ty] = opts.texel ?? [1 / 1920, 1 / 1080]

  return new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      texel: { value: new THREE.Vector2(tx, ty) }
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: kernel === '3x3' ? FRAGMENT_3X3 : FRAGMENT_5X5
  })
}
