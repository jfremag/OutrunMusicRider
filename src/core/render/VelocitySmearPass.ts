import * as THREE from 'three'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'

/**
 * VelocitySmearPass — PASS 8 of the "Watercolour Speed" painterly stack ("watercolour speed").
 *
 * Speed in this look is NOT speed-lines or particle ribbons — it is a wet, asymmetric
 * directional DRAG of the already-painted value field, exactly as a gouache speed painting
 * smears the value structure of the scene rather than streaking light. This pass reconstructs
 * a screen-space velocity buffer from the scene DEPTH texture plus the previous and current
 * camera view-projection matrices (camera-relative), so the static world rushing past the
 * camera is captured for free and the smear GROWS with depth toward the off-centre horizon.
 *
 * The reconstruction is the standard depth + prev/cur view-projection reprojection (Chapman):
 *   - take this fragment's UV and its sampled depth,
 *   - unproject to a world-space point with uInvCurViewProj  (PER-FRAGMENT perspective divide),
 *   - reproject that world point with uPrevViewProj           (PER-FRAGMENT perspective divide),
 *   - velocity = currentUV - previousUV.
 * The per-fragment divide is mandatory: doing it per-vertex (or skipping it) shears the smear
 * across the frame and breaks the depth-correct growth toward the horizon.
 *
 * Three watercolour modifiers turn the photographic reprojection into wet pigment:
 *   1. ASYMMETRIC TAIL — the trailing edge dissolves far more than the leading edge via a
 *      smoothstep(0.5,-0.5,t) weight (renormalised over the taps), giving a comet / dry-brush
 *      tail instead of a symmetric photographic ghost.
 *   2. PERPENDICULAR LOW-FREQ WOBBLE — taps are nudged sideways (perp = normalize(-v.y, v.x))
 *      by a low-frequency value-noise term so the streak reads as dragged bristles, not a clean
 *      motion-blur smear.
 *   3. GRANULATION ALONG THE STREAK — a faint pigment-finger modulation stretched along the
 *      smear direction, so the drag breaks into fingers like wet pigment pulled across paper.
 *
 * Discipline that keeps it a painting (per the STYLE_SPEC):
 *   - STREAK VALUE, NOT CHROMA. The smeared colour is recombined toward the original chroma so
 *     the streak carries value structure; desaturating the smear toward neutral reads as a dead
 *     photo blur ("= death"). We lerp the accumulated colour back toward the source hue/sat.
 *   - DEPTH-BIAS the velocity by (0.3 + 0.7*linearDepth) so near tarmac under the car stays
 *     readable and only the mid/far road dissolves into pigment fingers.
 *   - The HERO CAR is kept SHARP via tCarMask (the repurposed HERO_LAYER mask) — the single
 *     crisp found anchor inside the smeared world. Where the mask is lit, smear length → 0.
 *   - HARD-CLAMP |velocity| to ~uMaxSmear UV and ZERO it entirely when uReset is set (seek /
 *     rewind / large-delta frames — the controller already re-baselines those), so a stale
 *     prev-matrix can never smear the whole screen.
 *   - smearLen = base*(0.6 + 0.4*speedMultiplier) + beatKick*0.5  — louder/faster/drops give a
 *     longer wet smear; a beat is a brief "wet drag" pulse, never a flash.
 *
 * GLSL ES 1.00: fixed compile-time loop bound (TAP_COUNT taps, runtime weighting) — no dynamic
 * loop limit. Runs in display-space LDR, after the gradient-map LUT / edge pass.
 *
 * Uniforms (per STYLE_SPEC PASS 8; ThreeScene wires the textures/matrices/drivers at runtime):
 *   tDiffuse         — input colour (the painted, graded image; wired by EffectComposer)
 *   tDepth           — scene DepthTexture from the primary render target (perspective depth)
 *   tCarMask         — hero (HERO_LAYER) mask; >0 keeps the fragment sharp
 *   uInvCurViewProj  — inverse of the CURRENT (shaken) camera view-projection
 *   uPrevViewProj    — the PREVIOUS frame's (shaken) camera view-projection (cached post-render)
 *   uTexelSize       — 1/resolution in drawing-buffer pixels (for noise/wobble sampling)
 *   uStrength        — overall smear master (0 = off)
 *   uMaxSmear        — hard clamp on |velocity| in UV (~0.05)
 *   uWobble          — perpendicular bristle wobble amplitude in UV (~0.002)
 *   uSpeedMul        — car speedMultiplier (drives smear length 0.6 + 0.4*speedMul)
 *   uBeatKick        — transient beat / collision "wet drag" pulse added to smear length
 *   uCameraNear      — camera near plane (depth linearisation)
 *   uCameraFar       — camera far plane (depth linearisation; tightened ~2000 per spec)
 *   uVelocityScale   — currentFps/targetFps so smear length is framerate-stable
 *   uReset           — 1.0 on seek/rewind/large-delta frames → velocity forced to zero
 */
export function createVelocitySmearPass(opts: {
  strength?: number
  maxSmear?: number
  wobble?: number
  speedMul?: number
  beatKick?: number
  cameraNear?: number
  cameraFar?: number
  velocityScale?: number
} = {}): ShaderPass {
  return new ShaderPass({
    uniforms: {
      // Auto-wired by EffectComposer.
      tDiffuse: { value: null },
      // Set by ThreeScene at wiring time (see header).
      tDepth: { value: null as THREE.Texture | null },
      tCarMask: { value: null as THREE.Texture | null },
      uInvCurViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uTexelSize: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
      uStrength: { value: opts.strength ?? 1.0 },
      uMaxSmear: { value: opts.maxSmear ?? 0.05 },
      uWobble: { value: opts.wobble ?? 0.002 },
      uSpeedMul: { value: opts.speedMul ?? 1.0 },
      uBeatKick: { value: opts.beatKick ?? 0.0 },
      uCameraNear: { value: opts.cameraNear ?? 0.1 },
      uCameraFar: { value: opts.cameraFar ?? 2000.0 },
      uVelocityScale: { value: opts.velocityScale ?? 1.0 },
      uReset: { value: 0.0 }
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
      uniform sampler2D tCarMask;

      uniform mat4  uInvCurViewProj;
      uniform mat4  uPrevViewProj;
      uniform vec2  uTexelSize;
      uniform float uStrength;
      uniform float uMaxSmear;
      uniform float uWobble;
      uniform float uSpeedMul;
      uniform float uBeatKick;
      uniform float uCameraNear;
      uniform float uCameraFar;
      uniform float uVelocityScale;
      uniform float uReset;

      // Fixed compile-time tap count (GLSL ES 1.00: no dynamic loop bound). 8 taps is the
      // sweet spot in the spec's 6-10 range: enough for a smooth comet tail, cheap enough
      // to stay inside the ~0.5 ms budget.
      const int   TAP_COUNT  = 8;
      const float TAP_COUNTF = 8.0;

      // Cheap hash-based value noise (no texture), used for the low-frequency perpendicular
      // wobble and the along-streak granulation fingers. Value-noise only — never chroma.
      float hash21(vec2 p) {
        p = fract(p * vec2(123.34, 345.45));
        p += dot(p, p + 34.345);
        return fract(p.x * p.y);
      }

      float valueNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        // Smootherstep for a low-frequency, non-blocky field.
        f = f * f * (3.0 - 2.0 * f);
        float a = hash21(i);
        float b = hash21(i + vec2(1.0, 0.0));
        float c = hash21(i + vec2(0.0, 1.0));
        float d = hash21(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }

      // Linearise a perspective depth-buffer sample to [0,1] over [near, far]. The spec
      // tightens far to ~2000 precisely so this distribution is usable for the depth-bias.
      float linearizeDepth(float d) {
        float z = d * 2.0 - 1.0;                 // NDC z in [-1, 1]
        float lin = (2.0 * uCameraNear * uCameraFar) /
                    (uCameraFar + uCameraNear - z * (uCameraFar - uCameraNear));
        return clamp((lin - uCameraNear) / (uCameraFar - uCameraNear), 0.0, 1.0);
      }

      // Standard luma for the value-vs-chroma recombination.
      float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

      void main() {
        vec3  src      = texture2D(tDiffuse, vUv).rgb;
        float rawDepth = texture2D(tDepth, vUv).r;

        // Background / cleared depth (==1.0): no geometry, no reliable reprojection. Leave the
        // sky wash untouched (it is excluded from the smear budget per the spec).
        if (rawDepth >= 0.9999) {
          gl_FragColor = vec4(src, 1.0);
          return;
        }

        float linDepth = linearizeDepth(rawDepth);

        // --- Reconstruct screen-space velocity (camera-relative) ----------------------------
        // PER-FRAGMENT perspective divide on both ends (mandatory): unproject this UV+depth to
        // a world point with the current inverse VP, reproject it with the previous VP, and the
        // UV difference is how far this surface point slid on screen between frames.
        vec4 ndc      = vec4(vUv * 2.0 - 1.0, rawDepth * 2.0 - 1.0, 1.0);
        vec4 worldH   = uInvCurViewProj * ndc;
        vec3 worldPos = worldH.xyz / worldH.w;                 // <-- per-fragment divide (cur)

        vec4 prevClip = uPrevViewProj * vec4(worldPos, 1.0);
        vec2 prevUv   = (prevClip.xy / prevClip.w) * 0.5 + 0.5; // <-- per-fragment divide (prev)

        vec2 velocity = vUv - prevUv;

        // Framerate-stable: scale by currentFps/targetFps so a 30fps frame smears the same
        // on-screen distance as a 60fps one.
        velocity *= uVelocityScale;

        // ZERO on seek / rewind / large-delta frames — a stale prev-matrix would otherwise
        // smear the whole screen. The controller re-baselines these; uReset signals them.
        velocity *= (1.0 - clamp(uReset, 0.0, 1.0));

        // Depth-bias: near tarmac stays readable, far road dissolves into pigment fingers.
        velocity *= (0.3 + 0.7 * linDepth);

        // Music-driven smear length: louder/faster/drops => longer wet drag; a beat is a brief
        // pulse, never a flash. Folded into the overall strength master.
        float smearLen = (0.6 + 0.4 * uSpeedMul) + uBeatKick * 0.5;
        velocity *= uStrength * smearLen;

        // Hero car kept SHARP via the HERO_LAYER mask — the one crisp found anchor. Smooth the
        // mask edge so the car silhouette doesn't get a hard cut.
        float carMask = texture2D(tCarMask, vUv).r;
        float sharp   = smoothstep(0.05, 0.5, carMask);
        velocity     *= (1.0 - sharp);

        // HARD-CLAMP |velocity| so nothing (a depth-edge spike, a stale matrix slipping past
        // uReset) can drag the frame across itself.
        float vlen = length(velocity);
        if (vlen > uMaxSmear) {
          velocity *= uMaxSmear / vlen;
          vlen = uMaxSmear;
        }

        // Negligible motion: cheap exit, no smear.
        if (vlen < 1e-5) {
          gl_FragColor = vec4(src, 1.0);
          return;
        }

        // Perpendicular bristle-drag direction (low-freq wobble offsets taps sideways).
        vec2 vdir = velocity / vlen;
        vec2 perp = vec2(-vdir.y, vdir.x);

        // --- Accumulate the asymmetric wet drag --------------------------------------------
        // Sample TAP_COUNT taps from the trailing edge (t=-0.5, dissolves most) through to just
        // past the leading edge (t≈+0.5). The smoothstep(0.5,-0.5,t) weight is high at the
        // trailing edge and low at the leading edge -> comet / dry-brush tail, NOT a symmetric
        // ghost. Weights are renormalised by the accumulated total.
        vec3  accum   = vec3(0.0);
        float wsum    = 0.0;

        // Low-frequency wobble phase: anchored to this fragment's position (in texel units) so
        // the bristle pattern is stable frame-to-frame rather than crawling.
        vec2 noiseBase = vUv / max(uTexelSize, vec2(1e-6)) * 0.012;

        for (int i = 0; i < TAP_COUNT; i++) {
          // t in [-0.5, +0.5] across the taps.
          float t = (float(i) / (TAP_COUNTF - 1.0)) - 0.5;

          // Asymmetric tail weight: trailing (t<0) heavy, leading (t>0) light.
          float w = smoothstep(0.5, -0.5, t);

          // Tap position along the velocity vector.
          vec2 along = velocity * t;

          // (2) Perpendicular low-frequency wobble — value-noise nudge sideways for bristles.
          float n = valueNoise(noiseBase + vec2(t * 3.7, 0.0)) - 0.5;
          vec2  wob = perp * (n * uWobble);

          vec2 tapUv = clamp(vUv + along + wob, vec2(0.0), vec2(1.0));
          vec3 tap   = texture2D(tDiffuse, tapUv).rgb;

          // (3) Granulation stretched ALONG the streak — faint pigment-finger value modulation
          // (value only, never chroma), gated by a mid-value bell so it bites in washes and
          // fades in paper-white & dense darks.
          float gnoise = valueNoise(noiseBase * 2.3 + vec2(t * 9.0, 4.0));
          float bell   = 1.0 - abs(luma(tap) - 0.45) * 2.0;
          bell         = clamp(bell, 0.0, 1.0);
          float fingers = 1.0 - 0.10 * gnoise * bell;
          tap *= fingers;

          accum += tap * w;
          wsum  += w;
        }

        vec3 smeared = accum / max(wsum, 1e-4);

        // --- Value, not chroma -------------------------------------------------------------
        // The smear must carry VALUE structure; pulling chroma into the streak reads as a dead
        // photo blur. Take the smeared LUMA but bias the colour back toward the original chroma
        // by recolouring the source to the smeared value. Stronger smears stay a touch wetter
        // (more of the smeared chroma) so motion still feels fluid, but never neutral.
        float srcL  = max(luma(src), 1e-4);
        float smL   = luma(smeared);
        vec3  valued = src * (smL / srcL);          // source hue at the smeared value

        // How much actual smear happened (0 at rest, 1 at the clamp) — drives both how much we
        // blend in the smeared field and how "wet" (chroma-carrying) it is.
        float amount = clamp(vlen / max(uMaxSmear, 1e-4), 0.0, 1.0);

        // Blend smeared-chroma vs value-preserving smear: keep it value-led, with a small wet
        // chroma drag that grows with smear length.
        vec3  wet = mix(valued, smeared, 0.25 + 0.25 * amount);

        // Final composite: lerp from the crisp source into the wet value-drag by how much
        // velocity there was. Hero-masked fragments have velocity≈0 -> amount≈0 -> stay sharp.
        vec3 outColor = mix(src, wet, amount);

        gl_FragColor = vec4(outColor, 1.0);
      }
    `
  })
}
