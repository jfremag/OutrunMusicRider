import * as THREE from 'three'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'

/**
 * StructureTensorPass — PASS 2 of the "Watercolour Speed" painterly stack.
 *
 * Computes the per-pixel STRUCTURE TENSOR of image luminance with a 3x3 Sobel, packing
 *   gl_FragColor = vec4(gx*gx, gy*gy, gx*gy, 1.0)  =  (Jxx, Jyy, Jxy, 1)
 * where (gx, gy) is the Sobel luma gradient. This local outer product of the gradient is
 * the raw material the Anisotropic Kuwahara keystone (PASS 4) eigen-analyses to find each
 * pixel's dominant edge orientation + anisotropy, so the gouache strokes bend ALONG the
 * contours instead of sitting as an axis-aligned grid.
 *
 * CRITICAL — this pass MUST render into a FLOAT target (RGBA16F, LinearFilter):
 *   - The packed values are SQUARED gradients (gx*gx, gy*gy, gx*gy). On a strong edge these
 *     blow well past 1.0, so an 8-bit (UNSIGNED_BYTE) target would clamp/quantise them and
 *     band the stroke directions into ugly stair-steps. Float storage is non-negotiable.
 *   - gx*gy is SIGNED (negative on edges of one diagonal orientation); a UNORM target can't
 *     even represent it. Another reason the target must be float.
 *
 * Intended to run at HALF RESOLUTION: orientation is a low-frequency field, so computing it
 * at half-res quarters the heaviest tensor math for no visible quality loss (PASS 4 samples
 * it back with LinearFilter via its own `tensorTexel`). The pass itself is resolution-
 * agnostic — it just samples `tDiffuse` (the full-res PreBlur output) using `texel` offsets.
 *
 * Runs in display-space LDR (after OutputPass), on the PreBlur'd image so the Sobel
 * gradients are stable and don't crawl frame-to-frame.
 *
 * Uniforms:
 *   tDiffuse — input colour = the PASS 1 PreBlur output (wired by EffectComposer).
 *   texel    — texel size of the SOURCE being sampled (tDiffuse), i.e. 1 / sourceResolution
 *              (vec2). The Sobel taps are offsets in source-UV space, so this is the
 *              full-res texel even though the output target is half-res. ThreeScene sets +
 *              updates this in resize() in drawing-buffer pixels.
 */

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform vec2 texel;

  // Rec. 709 luma — matches the luminance used by the grade/edge passes downstream so the
  // tensor "sees" the same brightness field the gouache flattener will operate on.
  float luma(vec2 uv) {
    return dot(texture2D(tDiffuse, uv).rgb, vec3(0.2126, 0.7152, 0.0722));
  }

  void main() {
    // Sample the 3x3 luma neighbourhood (named by compass direction).
    //   tl t tr
    //   l  c r
    //   bl b br
    float tl = luma(vUv + texel * vec2(-1.0,  1.0));
    float t  = luma(vUv + texel * vec2( 0.0,  1.0));
    float tr = luma(vUv + texel * vec2( 1.0,  1.0));
    float l  = luma(vUv + texel * vec2(-1.0,  0.0));
    float r  = luma(vUv + texel * vec2( 1.0,  0.0));
    float bl = luma(vUv + texel * vec2(-1.0, -1.0));
    float b  = luma(vUv + texel * vec2( 0.0, -1.0));
    float br = luma(vUv + texel * vec2( 1.0, -1.0));

    // Sobel gradients. Standard 1/8 normalization keeps the operator a true derivative
    // estimate (sum of |weights| on a side = 4, /8 -> unit-ish scale) so the squared
    // products that follow have a sane magnitude range for the float target.
    //   Gx kernel:           Gy kernel:
    //   -1 0 +1              +1 +2 +1
    //   -2 0 +2               0  0  0
    //   -1 0 +1              -1 -2 -1
    float gx = ((tr + 2.0 * r + br) - (tl + 2.0 * l + bl)) * 0.125;
    float gy = ((tl + 2.0 * t + tr) - (bl + 2.0 * b + br)) * 0.125;

    // Pack the structure tensor: (Jxx, Jyy, Jxy). Note Jxy is signed -> needs a float,
    // signed-capable target (RGBA16F). Alpha is 1.0 (unused, keeps the write well-defined).
    gl_FragColor = vec4(gx * gx, gy * gy, gx * gy, 1.0);
  }
`

/**
 * Build the StructureTensor pass.
 *
 * @param opts.texel  initial source texel = 1/sourceResolution (vec2 as [x, y]).
 *                    ThreeScene overwrites this in its constructor + resize() with the real
 *                    drawing-buffer texel of the PreBlur source.
 *
 * REMINDER for the wiring side: render this pass into a HALF-RES RGBA16F target with
 * LinearFilter (type: THREE.HalfFloatType, format: THREE.RGBAFormat). An 8-bit target
 * will band the stroke directions and cannot store the signed Jxy term.
 */
export function createStructureTensorPass(opts: {
  texel?: [number, number]
} = {}): ShaderPass {
  const [tx, ty] = opts.texel ?? [1 / 1920, 1 / 1080]

  return new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      texel: { value: new THREE.Vector2(tx, ty) }
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER
  })
}
