import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'

/**
 * ChromaticAberrationPass — radial RGB channel separation (iteration 4).
 *
 * Mimics the prismatic lens fringing of a real camera: the red and blue channels are
 * sampled at a slight outward/inward radial offset from screen center while green
 * stays put, so the separation grows toward the frame edges (where real lenses
 * disperse most) and vanishes at the focal center. At rest `intensity` is 0 (no
 * artifact); the renderer drives it up to a brief spike on collisions for a punchy,
 * Wipeout-style impact "lens kick" that decays in ~200ms. Applied after tone mapping
 * so the fringing reads on the final graded image. No external dependencies.
 *
 * Uniforms:
 *   tDiffuse   — input color (wired by EffectComposer automatically)
 *   intensity  — 0 = off; scales the max edge offset (default 0.0)
 */
export function createChromaticAberrationPass(intensity = 0.0): ShaderPass {
  return new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      intensity: { value: intensity }
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
      uniform float intensity;

      void main() {
        // Direction + magnitude of separation grows with distance from center.
        vec2 dir = vUv - 0.5;
        // Base lens offset (px-ish in UV space) scaled by the driven intensity. The
        // r^1.5 falloff keeps the center crisp and pushes fringing to the edges.
        float falloff = pow(length(dir) * 2.0, 1.5);
        vec2 offset = dir * intensity * 0.012 * falloff;

        float r = texture2D(tDiffuse, vUv + offset).r;
        float g = texture2D(tDiffuse, vUv).g;
        float b = texture2D(tDiffuse, vUv - offset).b;
        float a = texture2D(tDiffuse, vUv).a;
        gl_FragColor = vec4(r, g, b, a);
      }
    `
  })
}
