import * as THREE from 'three'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'

/**
 * NeonCompositePass — additive overlay of the isolated neon-bloom render (iteration 9).
 *
 * This is the final pass of the primary post chain. It samples the primary (full-scene,
 * conservatively-bloomed, graded) image via the composer-wired `tDiffuse` and ADDS a
 * second texture `tNeon` — the output of a separate EffectComposer that rendered ONLY the
 * NEON_LAYER geometry (hero car, rim glow, particles, beat indicator, sky, sun) through an
 * exaggerated UnrealBloomPass. The result is a true selective-bloom focal hierarchy: the
 * neon heroes get a dramatic, blown-out glow that spikes on drops, while the road/grid —
 * which only ever live in the primary render with its disciplined threshold — stay sharp
 * and never wash out. Additive blending in display space means the overlay only ever adds
 * light (never darkens), so the composite is stable and flicker-free across scene cuts.
 *
 * `strength` scales the neon contribution so the renderer can keep it tasteful at rest and
 * lean on the bloom pass's own threshold/strength for the dynamics; it defaults to 1.
 *
 * Uniforms:
 *   tDiffuse  — primary graded image (wired by EffectComposer automatically)
 *   tNeon     — isolated neon-bloom texture (set by the renderer each frame)
 *   strength  — multiplier on the additive neon contribution (default 1.0)
 */
export function createNeonCompositePass(strength = 1.0): ShaderPass {
  return new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      tNeon: { value: null as THREE.Texture | null },
      strength: { value: strength }
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
      uniform sampler2D tNeon;
      uniform float strength;

      void main() {
        vec4 base = texture2D(tDiffuse, vUv);
        vec3 neon = texture2D(tNeon, vUv).rgb;
        // Pure additive screen-space glow: only ever brightens, so the hero car's rim
        // and the drop-burst particles spike without affecting the road/grid legibility.
        gl_FragColor = vec4(base.rgb + neon * strength, base.a);
      }
    `
  })
}
