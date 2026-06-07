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
  lengthGain?: number
  depthFloor?: number
  depthNear?: number
  blendFloor?: number
  blendKnee?: number
  flowGain?: number
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
      uReset: { value: 0.0 },
      // R4 wet-drag controls (see shader): lengthGain stretches the physical comet so the per-
      // frame velocity reads as wet PAINT DRAG; depthFloor/Near shape the raw-depth weight so
      // near tarmac stays readable and the drag grows toward the horizon; blendFloor/Knee set how
      // little velocity is needed for the wet field to become visible (decoupled from the |v|
      // hard clamp, which the old build wrongly used as the blend opacity → near-invisible smear).
      uLengthGain: { value: opts.lengthGain ?? 2.5 },
      uDepthFloor: { value: opts.depthFloor ?? 0.5 },
      uDepthNear: { value: opts.depthNear ?? 0.88 },
      uBlendFloor: { value: opts.blendFloor ?? 0.4 },
      uBlendKnee: { value: opts.blendKnee ?? 0.016 },
      // P4 — INJECTED TRACK-FLOW DRAG. In this chase view the camera translates along its OWN
      // axis, so the camera-relative reprojection velocity is a near-zero radial zoom and the
      // smear is indistinguishable from OFF. A gouache speed painting depicts motion as a
      // DIRECTIONAL value-drag, so we inject a screen-space flow direction (a point ~80-120u
      // ahead down the centerline, projected to clip and subtracted from the car's clip position)
      // as a velocity FLOOR before the clamp. uFlowDir is that normalized screen direction;
      // uFlowGain sets the streak length (tuned so it ≈ SMEAR_MAX_REST at speedMultiplier≈1).
      uFlowDir: { value: new THREE.Vector2(0, 0) },
      uFlowGain: { value: opts.flowGain ?? 0.05 }
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
      uniform float uLengthGain;
      uniform float uDepthFloor;
      uniform float uDepthNear;
      uniform float uBlendFloor;
      uniform float uBlendKnee;
      uniform vec2  uFlowDir;
      uniform float uFlowGain;

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

        // Depth-weight (R4 fix): the previous build keyed this off LINEARISED depth, but in this
        // chase view perspective-linearised depth is ~0.0005..0.05 for the WHOLE visible scene,
        // so (0.3 + 0.7*linDepth) collapsed to a near-constant 0.30 — it just killed 70% of every
        // velocity uniformly and the "grows toward the horizon" gradient was DEAD (the smear was
        // effectively inert). RAW device depth, by contrast, spans ~0.9..1.0 meaningfully across
        // the road/ground from the car to the horizon, so we drive the depth weight from it: near
        // tarmac under the car stays the most readable, and the wet drag GROWS toward the off-
        // centre horizon as a gouache speed painting wants. uDepthFloor keeps near geometry from
        // going fully crisp (a little drag everywhere reads as a moving painting).
        float depthW = uDepthFloor + (1.0 - uDepthFloor) * smoothstep(uDepthNear, 1.0, rawDepth);
        velocity *= depthW;

        // Music-driven smear length: louder/faster/drops => longer wet drag; a beat is a brief
        // pulse, never a flash. Folded into the overall strength master. uLengthGain lengthens the
        // physical drag so it reads as WET PAINT DRAG (a long directional smear), not a 1-2px
        // photographic micro-blur. The per-frame reconstructed velocity is small (~0.02-0.05 UV at
        // 60fps), so without this gain the comet tail is too short to register as motion.
        float smearLen = (0.6 + 0.4 * uSpeedMul) + uBeatKick * 0.5;
        velocity *= uStrength * smearLen * uLengthGain;

        // --- P4: INJECTED TRACK-FLOW DRAG ---------------------------------------------------
        // The camera-relative reconstruction above is near-zero in this chase view (the camera
        // slides along its own axis), so on its own the smear reads as OFF. Inject a directional
        // FLOW velocity floor: uFlowDir is the screen-space direction of the track rushing past
        // (a point ~80-120u ahead down the centerline, projected to clip minus the car's clip
        // position, normalized — derived per-frame in ThreeScene from the cached shaken
        // curViewProj). It is added to the working velocity BEFORE the clamp so the world reads as
        // a wet directional paint-drag while the HERO mask below still holds the kart/swords razor-
        // sharp. A WIDENED raw-depth ramp (0.25 floor + 0.75*ramp from mid-depth) makes the drag
        // present even on near tarmac and GROW toward the off-centre horizon — a gouache speed
        // painting. Scaled by uSpeedMul (drops accelerate the car → a longer streak), the strength
        // master, framerate scale, and zeroed on reset (a stale frame must not drag the screen).
        // ralph(iter3): GATE THE FLOW DRAG PAST THE CAR. The injected drag was biting the near tarmac
        // directly behind the kart into a dark wake (the 0.25 near-floor dragged even the closest road).
        // Start the ramp WELL PAST the car (0.90, above the ~0.987 near-tarmac band stays inside it but
        // the floor is removed) and zero the floor so the drag is ~0 on near tarmac and only GROWS toward
        // the off-centre horizon — a clean road around the hero, wet drag only in the distance.
        // ralph(iter4): START THE FLOW DRAG FURTHER OUT (0.90 -> 0.994). The kart + the several
        // car-lengths of road directly behind it sit at raw ~0.987..0.993 in this chase view; a ramp
        // starting at 0.90 still bit that near band into a dark wet wake. Confining the drag to raw
        // >= 0.994 means it engages ONLY on the genuinely FAR road toward the horizon, so the tarmac
        // for several car-lengths behind the hero is provably untouched (drag ~0 there).
        float flowRamp = smoothstep(0.994, 0.999, rawDepth);      // drag confined to FAR ground only
        vec2  flowVel  = uFlowDir * uFlowGain * flowRamp * uSpeedMul;
        flowVel       *= uStrength * uVelocityScale * (1.0 - clamp(uReset, 0.0, 1.0));
        velocity      += flowVel;

        // Hero car kept SHARP via the HERO_LAYER mask — the one crisp found anchor. A PROTECTIVE
        // SHARP HALO surrounds the hero, not just its silhouette: dilate the mask by sampling a
        // small ring of neighbours (max-combined) so the kill region grows a few px AROUND the car,
        // and WIDEN the smoothstep so the transition feathers. This stops the wet drag from pooling
        // a dark comet on the tarmac DIRECTLY around/under the car (the silhouette-tight mask let
        // the smear bite right up to the body, dragging the road into a shadow smudge).
        // WIDENED PROTECTIVE HALO (smudge fix): the wet drag was pooling a dark comet on the tarmac
        // directly around/under the kart. Dilate the kill region by a LARGER ~6px ring (two radii of
        // taps) so the protected zone extends well clear of the body, and widen the feather, so the
        // road around the car is fully held crisp and the smear cannot bite into a shadow smudge.
        float carMask = texture2D(tCarMask, vUv).r;
        vec2  hpx = uTexelSize * 6.0;                     // halo dilation radius (~6 px)
        vec2  hpx2 = uTexelSize * 3.0;                    // inner ring (fills the dilation kernel)
        carMask = max(carMask, texture2D(tCarMask, vUv + vec2(hpx.x, 0.0)).r);
        carMask = max(carMask, texture2D(tCarMask, vUv - vec2(hpx.x, 0.0)).r);
        carMask = max(carMask, texture2D(tCarMask, vUv + vec2(0.0, hpx.y)).r);
        carMask = max(carMask, texture2D(tCarMask, vUv - vec2(0.0, hpx.y)).r);
        carMask = max(carMask, texture2D(tCarMask, vUv + hpx).r);
        carMask = max(carMask, texture2D(tCarMask, vUv - hpx).r);
        carMask = max(carMask, texture2D(tCarMask, vUv + vec2(hpx.x, -hpx.y)).r);
        carMask = max(carMask, texture2D(tCarMask, vUv + vec2(-hpx.x, hpx.y)).r);
        carMask = max(carMask, texture2D(tCarMask, vUv + vec2(hpx2.x, 0.0)).r);
        carMask = max(carMask, texture2D(tCarMask, vUv - vec2(hpx2.x, 0.0)).r);
        carMask = max(carMask, texture2D(tCarMask, vUv + vec2(0.0, hpx2.y)).r);
        carMask = max(carMask, texture2D(tCarMask, vUv - vec2(0.0, hpx2.y)).r);
        float sharp   = smoothstep(0.015, 0.6, carMask); // widened feather -> sharp HALO
        velocity     *= (1.0 - sharp);

        // NEAR-DEPTH FLOOR (smudge fix): kill the smear on the CLOSEST tarmac under/around the car
        // (where the dark comet pools). Keyed off RAW depth — the nearest road sits at the very top
        // of the raw-depth range in this chase view. The keep band is RAISED so the whole near-tarmac
        // band right under the kart (which sits at raw ~0.987) is fully protected and only the FAR
        // road past the car carries the wet drag — no dark wake pools on the ground around the hero.
        // ralph(iter3): WIDENED the protected near band 0.986..0.992 -> 0.988..0.996 so the whole stretch
        // of road directly behind the kart (which sits at raw ~0.987 and ramped UP toward the horizon for
        // a few car-lengths) is fully held crisp — the wet drag now only engages on the FAR road, so no
        // dark wake pools on the tarmac behind the hero. Combined with the gated flow ramp above the near
        // road around the car is clean.
        // ralph(iter4): RAISED the protected near band 0.988..0.996 -> 0.993..0.9985 so the whole
        // stretch of road for several car-lengths directly behind the kart (raw ~0.987..0.993) is
        // fully held crisp (nearKeep ~0) and ONLY the far road toward the horizon carries any wet
        // drag — the dark wake/smudge behind the hero is provably zero on the near/mid tarmac.
        float nearKeep = smoothstep(0.993, 0.9985, rawDepth);
        velocity      *= nearKeep;

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
        // ASYMMETRIC, BACKWARD-WEIGHTED comet: the smear is the WAKE behind a surface point, so
        // taps run from the trailing edge (t=-1, the longest dry-brush tail) up to just past the
        // current position (t=+0.15). Mapping t into [-1, +0.15] (instead of the old symmetric
        // [-0.5,+0.5]) doubles the trailing reach and biases the whole drag BEHIND the point —
        // a wet directional smear with a dissolving tail, never a symmetric photographic ghost.
        // The trailing weight curve dissolves the far tail (dry-brush) while keeping the body of
        // the stroke present.
        const float T_LEAD = 0.15;   // taps reach just past the leading edge
        const float T_TAIL = -1.0;   // taps reach a full velocity-length behind (long tail)
        vec3  accum   = vec3(0.0);
        float wsum    = 0.0;

        // Low-frequency wobble phase: anchored to this fragment's position (in texel units) so
        // the bristle pattern is stable frame-to-frame rather than crawling.
        vec2 noiseBase = vUv / max(uTexelSize, vec2(1e-6)) * 0.012;

        for (int i = 0; i < TAP_COUNT; i++) {
          // t spans [T_TAIL, T_LEAD] across the taps (mostly behind the point).
          float f = float(i) / (TAP_COUNTF - 1.0);          // 0..1
          float t = mix(T_TAIL, T_LEAD, f);

          // Asymmetric DRY-BRUSH tail weight: full weight at/just-behind the point, dissolving
          // toward the far trailing tip (a comet). smoothstep(T_LEAD, T_TAIL+0.35, t) is ~1 near
          // the head and eases to ~0 at the tail tip → renormalised wet drag with a dry tail.
          float w = smoothstep(T_TAIL + 0.35, T_LEAD, t);
          // Keep a faint floor so the tail tip still ghosts (dry-brush whisper, not a hard cut).
          w = 0.06 + 0.94 * w;

          // Tap position along the velocity vector.
          vec2 along = velocity * t;

          // (2) Perpendicular low-frequency wobble — value-noise nudge sideways for bristles.
          // Scaled a touch by |t| so the wobble fans out along the tail (bristle splay), not a
          // rigid parallel offset.
          float n = valueNoise(noiseBase + vec2(t * 3.7, 0.0)) - 0.5;
          vec2  wob = perp * (n * uWobble * (0.5 + abs(t)));

          vec2 tapUv = clamp(vUv + along + wob, vec2(0.0), vec2(1.0));
          vec3 tap   = texture2D(tDiffuse, tapUv).rgb;

          // (3) Granulation stretched ALONG the streak — faint pigment-finger value modulation
          // (value only, never chroma), gated by a mid-value bell so it bites in washes and
          // fades in paper-white & dense darks. Stronger toward the tail so the drag breaks into
          // dry-brush fingers as it dissolves.
          float gnoise = valueNoise(noiseBase * 2.3 + vec2(t * 9.0, 4.0));
          float bell   = 1.0 - abs(luma(tap) - 0.45) * 2.0;
          bell         = clamp(bell, 0.0, 1.0);
          float fingers = 1.0 - 0.16 * gnoise * bell * (0.4 + abs(t));
          tap *= fingers;

          accum += tap * w;
          wsum  += w;
        }

        vec3 smeared = accum / max(wsum, 1e-4);

        // --- Value, not chroma -------------------------------------------------------------
        // The smear must carry VALUE structure; pulling chroma into the streak reads as a dead
        // photo blur. Take the smeared LUMA but bias the colour back toward the original chroma
        // by recolouring the source to the smeared value, so the streak STREAKS VALUE while the
        // hue stays anchored. A small wet-chroma drag is mixed back proportional to the smear.
        float srcL  = max(luma(src), 1e-4);
        float smL   = luma(smeared);
        vec3  valued = src * (smL / srcL);          // source hue at the smeared value

        // R4 blend opacity (decoupled from the |v| HARD CLAMP). The old build set the blend to
        // vlen/uMaxSmear, so a real but moderate velocity (~0.013 after the broken depth-bias)
        // only blended ~26% over a 1-2px span → effectively invisible. Now the opacity ramps to
        // (near) full over a SMALL velocity KNEE (uBlendKnee, ~0.018 UV), with a floor so any
        // smear that survives the depth-weight is actually VISIBLE as wet drag — while still
        // easing to zero at true rest. The hard clamp still bounds the comet LENGTH separately.
        float reach  = smoothstep(0.0, uBlendKnee, vlen);
        float amount = clamp(uBlendFloor + (1.0 - uBlendFloor) * reach, 0.0, 1.0) * reach;

        // Blend smeared-chroma vs value-preserving smear: keep it value-led, with a small wet
        // chroma drag that grows with smear length.
        vec3  wet = mix(valued, smeared, 0.30 + 0.30 * reach);

        // Final composite: lerp from the crisp source into the wet value-drag by how much
        // velocity there was. Hero-masked fragments have velocity≈0 -> amount≈0 -> stay sharp.
        vec3 outColor = mix(src, wet, amount);

        gl_FragColor = vec4(outColor, 1.0);
      }
    `
  })
}
