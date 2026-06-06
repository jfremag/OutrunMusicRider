import * as THREE from 'three'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'

/**
 * TensorBlurPass — PASS 3 of the "Watercolour Speed" painterly stack.
 *
 * A SEPARABLE 1D gaussian (sigma ~2.5 px) run over the STRUCTURE TENSOR target from PASS 2.
 * THE step that turns a noisy, per-pixel orientation field into coherent, brush-stroke-
 * length flow: without it, the Kuwahara keystone's stroke directions crawl and shimmer; with
 * it, neighbouring pixels agree on orientation and the gouache strokes read as deliberate,
 * contour-following marks. Mandatory, not optional.
 *
 * CRITICAL — BLUR THE TENSOR, NEVER THE ANGLE. Edge orientation is an angle that wraps at
 * ±pi/2 (a stroke at +89 deg and one at -89 deg are nearly parallel, yet their angles are far
 * apart). Averaging angles across that wrap corrupts the field into garbage at every near-
 * vertical edge. The structure tensor (Jxx, Jyy, Jxy) is a smooth, wrap-free quadratic form,
 * so a plain linear blur of its three components averages orientations *correctly* (the
 * dominant direction falls out of the eigen-analysis of the blurred tensor in PASS 4). That
 * is the entire reason a tensor is used instead of storing the angle directly.
 *
 * Use: add this pass TWICE in sequence with the same target, flipping `direction`:
 *   pass A -> direction = (1, 0)   (horizontal)
 *   pass B -> direction = (0, 1)   (vertical)
 * The two 1D passes compose into a full 2D gaussian at O(2*N) taps instead of O(N*N).
 *
 * Runs at HALF RESOLUTION on the half-res RGBA16F tensor target (its `texel` is the
 * half-res texel). The target MUST stay float (RGBA16F) — see StructureTensorPass; the
 * squared/signed tensor terms cannot survive an 8-bit round-trip mid-blur.
 *
 * Uniforms:
 *   tDiffuse  — input = the tensor target (PASS 2 output, or this pass's own first axis).
 *               Wired by EffectComposer.
 *   direction — vec2 axis of this 1D pass: (1,0) horizontal then (0,1) vertical. Multiplied
 *               by `texel` to step one tensor-texel per tap.
 *   texel     — texel size of the tensor target = 1 / tensorResolution (vec2). ThreeScene
 *               sets + updates this in resize() in (half-res) drawing-buffer pixels.
 *   sigma     — gaussian std-dev in tensor texels (default 2.5). Weights are computed
 *               analytically in-shader; the loop radius is fixed at 7 (covers ~2.8*sigma at
 *               sigma=2.5), so keep sigma <= ~2.5 or the tail is truncated.
 */

// Fixed compile-time half-width of the kernel (GLSL ES 1.00 requires constant loop bounds).
// 7 -> 15 taps per axis; at sigma 2.5 that reaches ~2.8 sigma, capturing >99% of the gaussian.
const KERNEL_RADIUS = 7

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// NOTE: `${KERNEL_RADIUS}` is interpolated into the source as an integer LITERAL (7), so the
// resulting GLSL `for (int i = -7; i <= 7; i++)` has fixed compile-time bounds — ES-1.00 legal.
// We accumulate the RGB (= Jxx, Jyy, Jxy) tensor components and divide by the summed weights
// (analytic normalization, robust to any sigma within the fixed radius). Alpha is written 1.0.
const FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform vec2 direction;
  uniform vec2 texel;
  uniform float sigma;

  void main() {
    // Per-tap UV step along the chosen axis (one tensor texel per integer offset).
    // NB: not named 'step' — that shadows the GLSL built-in step() and some drivers reject it.
    vec2 axisStep = direction * texel;

    // Guard against a degenerate sigma so the exp() and the normalization stay well-defined.
    float s = max(sigma, 1e-3);
    float twoSigma2 = 2.0 * s * s;

    vec3 tensor = vec3(0.0);
    float wsum = 0.0;

    // Symmetric 1D gaussian; weights computed analytically per offset.
    for (int i = -${KERNEL_RADIUS}; i <= ${KERNEL_RADIUS}; i++) {
      float fi = float(i);
      float w = exp(-(fi * fi) / twoSigma2);
      // Sample only the tensor channels (Jxx, Jyy, Jxy); alpha is metadata, not blurred.
      tensor += texture2D(tDiffuse, vUv + axisStep * fi).rgb * w;
      wsum += w;
    }

    gl_FragColor = vec4(tensor / wsum, 1.0);
  }
`

/**
 * Build a TensorBlur pass (one separable axis).
 *
 * @param opts.direction  axis of this 1D pass: [1, 0] horizontal (default) or [0, 1]
 *                        vertical. Create two passes — one of each — and run them in sequence.
 * @param opts.texel      initial tensor texel = 1/tensorResolution (vec2 as [x, y]).
 *                        ThreeScene overwrites this in its constructor + resize().
 * @param opts.sigma      gaussian std-dev in tensor texels (default 2.5).
 */
export function createTensorBlurPass(opts: {
  direction?: [number, number]
  texel?: [number, number]
  sigma?: number
} = {}): ShaderPass {
  const [dx, dy] = opts.direction ?? [1, 0]
  const [tx, ty] = opts.texel ?? [1 / 960, 1 / 540] // half-res default (mirrors a 1920x1080 buffer)

  return new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      direction: { value: new THREE.Vector2(dx, dy) },
      texel: { value: new THREE.Vector2(tx, ty) },
      sigma: { value: opts.sigma ?? 2.5 }
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER
  })
}
