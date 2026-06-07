import * as THREE from 'three'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'

/**
 * AerialPerspectivePass — the DEPTH-RESTORE pass for "Watercolour Speed".
 *
 * The frame had lost all sense of receding space: a flat light foreground field met a flat
 * dark wedge with no gradation, so it read as two zones, not a deep painting. Atmospheric
 * (aerial) perspective is the single strongest depth cue a painter has — distant forms wash
 * progressively LIGHTER, COOLER/HAZIER and LOWER-CONTRAST as the intervening air veils them,
 * dissolving the horizon into the field ("lost horizon", exactly ref 02's deep space). This
 * pass reintroduces that recession as a depth-gated haze, driven off the scene DEPTH texture
 * (the same `sceneDepthTexture` G-buffer the painterly edge / velocity smear consume), so it
 * is a true 3D distance cue and not a flat screen gradient.
 *
 * For each fragment it linearises the device depth (over the TIGHTENED near..far the depth was
 * captured with, so the z-distribution is usable), shapes it into a 0..1 haze weight `w` over
 * a [near, far] band with a gamma, and then applies THREE coupled veils that all grow with `w`:
 *
 *   1. WASH toward the haze colour — lerp the painted colour toward `uHazeColor` (the sky /
 *      field tint the far world dissolves into). This is the dominant "distance goes pale".
 *   2. DESATURATE — pull the colour toward its own luma by `w` so far forms lose chroma (the
 *      air greys them), while the near foreground keeps its full painted saturation.
 *   3. LOWER CONTRAST — lift the far values toward a mid pivot (reduce the value spread) so the
 *      distance flattens in contrast and the punched darks live only in the NEAR foreground.
 *      A small overall LIFT is folded in so the far band reads luminous/hazy, never a dark fill.
 *
 * NEAR-FAR weighting falls out for free: at `w≈0` (foreground) the fragment is returned almost
 * untouched (richer, darker, sharper, higher-contrast); at `w≈1` (horizon) it is washed, greyed
 * and flattened into the field. The sky / cleared-depth background (rawDepth≈1) is left ALONE
 * (it is already the haze target, and veiling it again would double-pale it).
 *
 * STATIC / frame-anchored: the only spatial input is the per-fragment SCENE DEPTH, which is a
 * geometric property of the frame — there is NO noise, NO time term, NO per-frame crawl, so it
 * can never reintroduce the drifting-grain "floaters" the rest of the stack was careful to kill.
 * It is a smooth analytic function of depth, so it also adds no grain of its own; the static
 * paper grain is laid AFTER it (this pass slots before SubstratePaper).
 *
 * Runs in display-space LDR like every post-OutputPass pass (all maths perceptual: luma,
 * lerps). Colours are authored in that same display space.
 *
 * Uniforms (ThreeScene wires tDepth + the camera planes; the rest are static tunables):
 *   tDiffuse      input colour (auto-wired by EffectComposer)
 *   tDepth        scene DepthTexture (perspective device depth)
 *   uCameraNear   camera near plane (retained for reference; weight keys off RAW depth)
 *   uCameraFar    camera far plane (retained for reference; weight keys off RAW depth)
 *   uHazeColor    the pale field/sky colour distance dissolves toward
 *   uHazeNear     RAW device-depth where the haze STARTS (~0.6 = near tarmac under the kart)
 *   uHazeFar      RAW device-depth where the haze reaches FULL strength (~0.995 = horizon)
 *   uHazeGamma    shaping exponent on the 0..1 band (>1 keeps the near foreground clearer)
 *   uHazeStrength master wash amount toward uHazeColor at full distance (0..1)
 *   uDesat        max desaturation toward luma at full distance (0..1)
 *   uContrast     max contrast compression toward uPivot at full distance (0..1)
 *   uLift         small luminance lift folded into the far band so it reads hazy, not dark
 *   uPivot        the value the far contrast compresses toward (mid-key)
 */
export function createAerialPerspectivePass(opts: {
  cameraNear?: number
  cameraFar?: number
  hazeColor?: THREE.Color
  hazeNear?: number
  hazeFar?: number
  hazeGamma?: number
  hazeStrength?: number
  desat?: number
  contrast?: number
  lift?: number
  pivot?: number
  foreRich?: number
  foreSat?: number
  foreFade?: number
  horizonHaze?: number
  horizonBand?: number
} = {}): ShaderPass {
  return new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      tDepth: { value: null as THREE.Texture | null },
      uCameraNear: { value: opts.cameraNear ?? 0.1 },
      uCameraFar: { value: opts.cameraFar ?? 2000.0 },
      uHazeColor: { value: (opts.hazeColor ?? new THREE.Color(0xc4ccb8)).clone() },
      uHazeNear: { value: opts.hazeNear ?? 0.6 },
      uHazeFar: { value: opts.hazeFar ?? 0.992 },
      uHazeGamma: { value: opts.hazeGamma ?? 1.35 },
      uHazeStrength: { value: opts.hazeStrength ?? 0.72 },
      uDesat: { value: opts.desat ?? 0.6 },
      uContrast: { value: opts.contrast ?? 0.5 },
      uLift: { value: opts.lift ?? 0.06 },
      uPivot: { value: opts.pivot ?? 0.62 },
      // NEAR-FAR WEIGHT (foreground enrichment). A depth-gated counter-veil on the NEAREST band:
      // the immediate foreground is deepened in value + lifted a hair in saturation so it reads
      // RICHER, DARKER and more CONTRASTY than the receding mid/far (the prompt's "more value
      // weight to the foreground"). Peaks at the camera, fades out by the haze-near start (so the
      // two bands meet smoothly). Static (depth-only). 0 = off.
      uForeRich: { value: opts.foreRich ?? 0.16 },
      uForeSat: { value: opts.foreSat ?? 0.18 },
      // RAW device-depth where the foreground enrichment has faded to 0 (≈ the haze-near start, so
      // foreground-rich and haze hand off across the mid band with no overlap seam).
      uForeFade: { value: opts.foreFade ?? 0.978 },
      // HORIZON-BAND HAZE: depth-independent screen-space wash that hugs the horizon line (the far
      // ground packs beyond the depth far plane, so the depth wash can't reach it). uHorizonHaze is
      // the max wash toward the haze colour right at the horizon; uHorizonBand is how far below the
      // horizon (in UV) the band extends. 0 = off.
      uHorizonHaze: { value: opts.horizonHaze ?? 0.0 },
      uHorizonBand: { value: opts.horizonBand ?? 0.06 },
      // Dev-only depth calibration: 0 = normal; 1 = visualise the haze weight `w` as grayscale
      // (white = full haze); 2 = visualise RAW device depth remapped over [0.95,1.0] so the
      // road's depth spread is readable. Left at 0 in production.
      uDebug: { value: 0 }
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
      uniform sampler2D tDepth;
      uniform float uCameraNear;
      uniform float uCameraFar;
      uniform vec3  uHazeColor;
      uniform float uHazeNear;
      uniform float uHazeFar;
      uniform float uHazeGamma;
      uniform float uHazeStrength;
      uniform float uDesat;
      uniform float uContrast;
      uniform float uLift;
      uniform float uPivot;
      uniform float uForeRich;
      uniform float uForeSat;
      uniform float uForeFade;
      uniform float uHorizonHaze;
      uniform float uHorizonBand;
      uniform float uDebug;

      float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

      void main() {
        vec3 src = texture2D(tDiffuse, vUv).rgb;
        float rawDepth = texture2D(tDepth, vUv).r;

        // Sky / cleared depth: already the haze target — leave it untouched (re-veiling the
        // pale field would double-pale it and crush the deliberate negative-space value).
        if (rawDepth >= 0.9999) {
          gl_FragColor = vec4(src, 1.0);
          return;
        }

        // Haze weight from RAW DEVICE DEPTH. In this chase view the perspective-LINEARISED depth
        // collapses to ~0.0005..0.05 for the WHOLE visible scene (a near-constant), so a wash
        // keyed off it is invisible — exactly the trap the velocity smear documents. RAW device
        // depth, by contrast, spans ~0.5 (near tarmac under the kart) .. ~0.9995 (the horizon)
        // meaningfully across the road/ground, so the haze GROWS with real distance off it. The
        // [near, far] band + gamma keep the immediate foreground clear/rich and ramp the veil in
        // toward the off-centre horizon (the lost-horizon recession).
        float w = smoothstep(uHazeNear, uHazeFar, rawDepth);
        w = pow(w, uHazeGamma);

        // Dev depth calibration.
        if (uDebug > 0.5) {
          if (uDebug < 1.5) { gl_FragColor = vec4(vec3(w), 1.0); return; }
          // Remap raw depth over [0.95,1.0] so the road's near..far spread is readable.
          float dd = clamp((rawDepth - 0.95) / 0.05, 0.0, 1.0);
          gl_FragColor = vec4(vec3(dd), 1.0);
          return;
        }

        vec3 col = src;
        float l = luma(col);

        // (0) NEAR-FAR WEIGHT: enrich the NEAREST foreground (deepen value + lift saturation) so it
        // reads richer/darker/contrastier than the receding mid/far. fw: ~1 at the nearest tarmac →
        // 0 by uForeFade (the haze-near start), so foreground-rich hands off to the haze across the
        // mid band with no seam. The ~0.016 raw-depth ramp matches this view's tight near window.
        float fw = 1.0 - smoothstep(uForeFade - 0.016, uForeFade, rawDepth);
        // Deepen value about the mid pivot (push darks down, keep lights ~put → more contrast) and
        // lift chroma away from luma. Both scaled by fw so only the near foreground is affected.
        float deepened = l - (uPivot - l) * uForeRich * fw * step(l, uPivot);
        col = (col - vec3(l)) * (1.0 + uForeSat * fw) + vec3(deepened);

        // (2) DESATURATE toward luma with distance (the air greys far forms).
        l = luma(col);
        col = mix(col, vec3(l), uDesat * w);

        // (3) LOWER CONTRAST: compress the value (luma) toward a mid pivot by amt (0 near ->
        //     uContrast far) while PRESERVING the per-channel chroma offsets, so the far band
        //     flattens in contrast (the punched darks stay in the near foreground). A small
        //     luminance LIFT is folded in so the distance reads HAZY/luminous, never a dark fill.
        float amt = uContrast * w;
        float newL = mix(l, uPivot, amt) + uLift * w;            // value pulled toward mid + lifted
        col = (col - vec3(l)) + vec3(newL);                      // re-seat the chroma at the new value

        // (1) WASH toward the pale haze colour — the dominant "distance dissolves into field".
        col = mix(col, uHazeColor, uHazeStrength * w);

        // (4) HORIZON-BAND HAZE (SMOOTH screen-space seam dissolve, NO hard depth gate). In this low
        // chase view the far ground packs BEYOND the depth far plane (raw → ~1.0), so the depth-keyed
        // wash above can't reach the rows right under the horizon and a hard dark-ground / light-sky
        // seam remained. The old build keyed the band off a hard raw-depth far-gate
        // (smoothstep(0.992,0.9985,rawDepth)) AND hard-excluded the car — both produced a visible
        // STEP sitting right on the horizon (geometry above vs below the line treated differently).
        // This replaces it with a SMOOTH screen-space horizon falloff: walk MANY taps UP from this
        // fragment and measure the (feathered) fraction that are sky. That fraction is a smooth
        // distance-BELOW-the-horizon-line gradient (1 right under the line → 0 deep in the
        // foreground) with NO step. The car is NO LONGER excluded — hazeColor IS the bright sky, so a
        // form silhouetted against the sky hazes CONSISTENTLY whether it is above or below the line
        // (the swords/car read identical across the seam). The band still fades to 0 well down the
        // frame where no sky sits above, so the near foreground keeps its full painted value.
        if (uHorizonHaze > 0.001) {
          float skyAbove = 0.0;
          float wA = 0.0;
          for (int i = 1; i <= 12; i++) {
            float fi = float(i) / 12.0;
            float dy = uHorizonBand * fi;
            float rd = texture2D(tDepth, vec2(vUv.x, vUv.y + dy)).r;
            // Weight nearer taps more so the gradient is strongest right at the line and dissolves
            // smoothly downward — a continuous falloff, never a hard band edge.
            float w = 1.0 - fi;
            skyAbove += step(0.9997, rd) * w;
            wA += w;
          }
          skyAbove /= max(wA, 1e-4);                      // smooth fraction of upward sky (0..1)
          // Smooth proximity gradient (a soft gamma so the lower edge dissolves, not steps). NO
          // far-gate, NO car-exclusion — the wash is driven purely by this smooth screen-space
          // measure so it dissolves the seam continuously for every form crossing the horizon.
          float horizonW = smoothstep(0.04, 0.9, skyAbove);
          horizonW *= horizonW;
          col = mix(col, uHazeColor, uHorizonHaze * horizonW);
        }

        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }
    `
  })
}
