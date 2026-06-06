import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'

/**
 * FilmGrainPass — a subtle, always-on procedural film-grain overlay (iteration 4).
 *
 * Adds the fine, animated luminance noise that gives luxury automotive promo films
 * their cinematic "shot on film" texture instead of a clinically clean render. The
 * grain is generated entirely in-shader (a hashed fract(sin()) value seeded by the
 * pixel coordinate AND a per-frame time uniform) so it shimmers frame-to-frame like
 * real grain rather than sitting as a static dot pattern. Intensity is intentionally
 * tiny (default 0.03) so it reads as texture, never as snow, and it is applied AFTER
 * tone mapping (operating on the final display-space image) so it compresses the
 * graded picture exactly as a film stock would. No external assets/dependencies.
 *
 * Uniforms:
 *   tDiffuse        — input color (wired by EffectComposer automatically)
 *   noiseIntensity  — grain amount, 0..~0.06 (default 0.03)
 *   time            — seconds, advanced by the renderer so the grain animates
 */
export function createFilmGrainPass(noiseIntensity = 0.03): ShaderPass {
  return new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      noiseIntensity: { value: noiseIntensity },
      time: { value: 0 }
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
      uniform float noiseIntensity;
      uniform float time;

      // Cheap hash noise: high-frequency, decorrelated per pixel, re-seeded each
      // frame by the time uniform so the grain shimmers instead of standing still.
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233)) + time) * 43758.5453);
      }

      void main() {
        vec4 color = texture2D(tDiffuse, vUv);
        float grain = hash(vUv * vec2(1920.0, 1080.0)) - 0.5;
        // Slightly reduce grain in the brightest highlights so blown-out neon stays
        // clean, and let it sit fully in the mids/shadows where film grain lives.
        float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
        float weight = mix(1.0, 0.6, smoothstep(0.7, 1.0, luma));
        color.rgb += grain * noiseIntensity * weight;
        gl_FragColor = color;
      }
    `
  })
}
