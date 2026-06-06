import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'

/**
 * VignettePass — a soft radial edge darkening (iteration 4).
 *
 * Draws the eye inward to the hero car + road by gently dimming the screen corners,
 * the signature framing of a cinematic product shot. The falloff is a smoothstep on
 * normalized radial distance from screen center, aspect-corrected so the vignette is
 * an ellipse matching the viewport (not a circle that clips on wide screens). It is
 * fully opaque (no darkening) through the center and eases to `darkness` brightness
 * at the corners. The effect is idempotent — it holds no frame state — and is applied
 * after tone mapping so it compresses the final graded image. No external deps.
 *
 * Uniforms:
 *   tDiffuse  — input color (wired by EffectComposer automatically)
 *   darkness  — corner brightness multiplier, ~0.6..0.8 (default 0.7 = 30% darker)
 *   offset    — radius at which darkening begins, 0..1 (default 0.62)
 */
export function createVignettePass(darkness = 0.7, offset = 0.62): ShaderPass {
  return new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      darkness: { value: darkness },
      offset: { value: offset }
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
      uniform float darkness;
      uniform float offset;

      void main() {
        vec4 color = texture2D(tDiffuse, vUv);
        // Distance from center, with a mild aspect stretch so corners (not just the
        // top/bottom) are what gets darkened on widescreen.
        vec2 uv = (vUv - 0.5) * vec2(1.15, 1.0);
        float dist = length(uv);
        // 1.0 at/inside the offset radius, easing to the darkness floor by the corner.
        float vig = mix(1.0, darkness, smoothstep(offset, 0.78, dist));
        color.rgb *= vig;
        gl_FragColor = color;
      }
    `
  })
}
