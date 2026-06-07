import * as THREE from 'three'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'

/**
 * SubstratePaperPass — PASS 9, the FINAL pass of the "Watercolour Speed" stack.
 *
 * Replaces FilmGrainPass. This is the cold-press watercolour-paper substrate the whole
 * moving gouache painting is "printed" on. It MUST be the very last pass: any grain or
 * vignette layered on top of it would sit above the sheet and break the "painted on paper"
 * illusion (and it folds in the 1/255 dither that takes over FilmGrain's debanding role).
 *
 * One single procedural cold-press paper HEIGHT field `h` drives three coupled effects, so
 * granulation, tooth-light and edge break-up all agree about where the paper valleys/peaks
 * are (a real sheet has one tooth, not three):
 *
 *   1. GRANULATION   — subtractive + desaturating pigment-settle in the valleys. Pigment
 *                      pools and dries darker where the paper dips; gated by a luma BELL so
 *                      it bites in mid washes and fades out in paper-white and dense darks
 *                      (granulation in a blown highlight or a black reads as dirt).
 *   2. TOOTH LIGHT   — a faint SIGNED raking light computed from the SCREEN-SPACE GRADIENT of
 *                      the height field (gradient = surface normal). Peaks catch the warm light,
 *                      valleys fall into a cool micro-shadow (~0.04 strength). This is what
 *                      sells "paper fibre" rather than "noise texture".
 *   3. MICRO-DISTORT — nudge the colour-fetch UV by the height gradient so the already-
 *                      painted edges break a little on the fibre (wet pigment crawling into
 *                      the tooth), not on a clean pixel grid.
 *
 * The result is composited over a warm-cream sheet (`#EDE7D8`) with **Pegtop soft-light**
 * (`softLight(b,s) = (1-2s)*b*b + 2s*b`) — harmony-preserving: multiply-only goes muddy,
 * additive can't darken, overlay clips. paperStrength ~0.16. Keep granDensity in 0.18–0.40
 * and paperStrength in 0.12–0.22; over-application reads as **dirt, not paper**.
 *
 * GEOMETRY-LOCKED (world-space) GRAIN — the #1 paper fix. The grain used to be sampled in
 * SCREEN space (from gl_FragCoord/resolution), so on a moving 3D scene the road/ground slid
 * UNDERNEATH a screen-pinned grain layer — the print "swam"/shower-doored over the surfaces
 * (the "eye floaters"). Freezing the time-animation did NOT fix that, because the grain was
 * still locked to the screen, not the geometry. This pass now reconstructs each fragment's
 * WORLD position from the scene DEPTH + the inverse view-projection of the shaken camera
 * (the same reconstruction VelocitySmear/AerialPerspective do — RAW device depth, because
 * linearised depth collapses to ~const in this close chase view) and samples the print grain
 * as TRIPLANAR world-space noise: three axis-aligned 2D paper-height projections blended by
 * the surface normal (derived from screen-space derivatives of the reconstructed world
 * position, so no view→world matrix is needed). The grain is therefore ANCHORED to the world
 * surfaces — the road's grain travels WITH the road, the ground's with the ground, scaling
 * with distance like real print/tooth printed ON the surface (near a touch coarser, far
 * finer — correct texture perspective). It is also fully TIME-FREE: world-space sampling is
 * inherently non-boiling, so paused = no boil and MOVING = grain travels with the surfaces.
 *
 * SKY / far background (rawDepth ~= far / cleared): world-pos reconstruction blows up there
 * (the unproject diverges to the far plane), so sky pixels are detected (max depth) and fall
 * back to the original SCREEN-SPACE paper coordinate. The sky dome is camera-centred (it
 * barely moves relative to the camera), so screen-space is stable there and the sky does not
 * swim either.
 *
 * The grain CHARACTER is unchanged from the prior round (heavy, fine, near-isotropic offset-
 * print speckle): paperScale / paperAniso / granDensity / paperLight all carry the same
 * tuned feel — only the SAMPLING SPACE changed from screen to world. `uWorldGrainScale` maps
 * the world-space lattice frequency so it reads as the same fine print speckle on-screen at
 * the typical chase distance.
 *
 * Display-space LDR: runs after OutputPass like every painterly pass; all maths are
 * perceptual (luma bell, soft-light) and would misbehave on linear HDR.
 *
 * Uniforms (per STYLE_SPEC §3 PASS 9):
 *   tDiffuse        — input colour (auto-wired by EffectComposer)
 *   tDepth          — scene DepthTexture (RAW perspective device depth) for world reconstruction
 *   tNormal         — view-normal G-buffer (retained for reference; the triplanar blend weights
 *                     are taken from the screen-space derivative of the reconstructed world pos)
 *   uInvViewProj    — inverse of the SHAKEN camera view-projection (depth → world unproject)
 *   uCameraPos      — shaken camera world position (distance-based grain-frequency compensation)
 *   uWorldGrainScale— world-space grain lattice frequency (cells per world unit ×; bigger = finer)
 *   uWorldDistRef   — reference camera→surface distance at which the world grain ≈ the on-screen
 *                     fine speckle; nearer surfaces read a touch coarser, far ones finer
 *   useWorldGrain   — 1 = geometry-locked triplanar world grain (default); 0 = legacy screen grain
 *   resolution      — drawing-buffer pixel size (vec2); .set() in resize()
 *   paperScale      — paper tooth frequency in tiles across the screen (bigger = finer grain)
 *   paperAngle      — felt-grain rotation in radians (cold-press is anisotropic; ~17° = 0.30 rad)
 *   paperStrength   — soft-light sheet opacity, 0.12–0.22 (default 0.16). >0.3 = dirt.
 *   granDensity     — granulation (pigment-settle) strength, 0.18–0.40 (default 0.26). >0.4 = dirt.
 *   distortAmt      — UV micro-distortion amount in UV units (~0.0015; edges crawl into the tooth)
 *   grad_eps        — finite-difference step for the screen-space height gradient, in UV (~1px)
 *   paperLight      — tooth raking-light strength (~0.04; peaks warm / valleys cool)
 *   lightDir3       — raking light direction (vec2 in screen space; only x,y used for the slope)
 *   toothFlatness   — softens the height→slope response so the tooth-light isn't harsh (~0.6)
 *   paperTint       — the warm-cream substrate colour the image sits on (#EDE7D8)
 *   warmTint        — colour the PEAKS are pushed toward by the tooth-light (warm paper highlight)
 *   coolTint        — colour the VALLEYS are pushed toward (cool micro-shadow in the tooth)
 *   time            — inert (retained for back-compat); the grain is static/time-free
 */
export function createSubstratePaperPass(opts: {
  resolution?: [number, number]
  paperScale?: number
  paperAngle?: number
  paperAniso?: number
  paperStrength?: number
  granDensity?: number
  distortAmt?: number
  grad_eps?: number
  paperLight?: number
  lightDir3?: [number, number, number]
  toothFlatness?: number
  paperTint?: [number, number, number]
  warmTint?: [number, number, number]
  coolTint?: [number, number, number]
  worldGrainScale?: number
  worldDistRef?: number
} = {}): ShaderPass {
  // Destructure with tuple-typed defaults so the Vector ctors get exact arities (a
  // spread of `opts.x ?? [..]` widens to number[] and fails strict TS; these don't).
  const res: [number, number] = opts.resolution ?? [1920, 1080]
  const lightDir: [number, number, number] = opts.lightDir3 ?? [0.45, 0.7, 0.55]
  // #EDE7D8 warm-cream sheet (sRGB 0.929, 0.906, 0.847).
  const paperTint: [number, number, number] = opts.paperTint ?? [0.929, 0.906, 0.847]
  // Warm paper-putty highlight the tooth peaks lean toward (#D9D6CE-ish, warmed).
  const warmTint: [number, number, number] = opts.warmTint ?? [0.92, 0.88, 0.80]
  // Cool steel-violet micro-shadow the tooth valleys lean toward (#A7A3B1 family).
  const coolTint: [number, number, number] = opts.coolTint ?? [0.64, 0.62, 0.68]

  return new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      // World-reconstruction inputs (ThreeScene wires these each frame; see header).
      tDepth: { value: null as THREE.Texture | null },
      tNormal: { value: null as THREE.Texture | null },
      uInvViewProj: { value: new THREE.Matrix4() },
      uCameraPos: { value: new THREE.Vector3() },
      // World grain frequency (lattice cells per world unit, ×). Tuned so the on-screen
      // speckle at the typical chase distance reads as the same fine print as the screen grain.
      uWorldGrainScale: { value: opts.worldGrainScale ?? 1.7 },
      // Reference camera→surface distance at which the world grain matches the fine screen
      // speckle; the grain is scaled by uWorldDistRef/dist so near surfaces are a touch coarser
      // and far ones finer (correct texture perspective), clamped to a tasteful band.
      uWorldDistRef: { value: opts.worldDistRef ?? 26.0 },
      useWorldGrain: { value: 1 },
      // Drawing-buffer resolution (vec2); placeholder 1080p, ThreeScene .set()s it in resize().
      resolution: { value: new THREE.Vector2(res[0], res[1]) },
      paperScale: { value: opts.paperScale ?? 2.6 },
      paperAngle: { value: opts.paperAngle ?? 0.297 }, // ~17 degrees
      // R4 BRUSHWORK: anisotropic stretch of the tooth ALONG the felt-grain angle. 1.0 = round
      // (isotropic) tooth; >1 stretches the noise into directional brush/scumble streaks so the
      // flat fields read as BRUSHED gouache (ref 02), not airbrushed. In world-grain mode it is
      // applied INSIDE each triplanar plane along a fixed world axis, so the stretch sticks to
      // the surface (no shower-door) — it's the SAMPLE that's stretched, not scrolled.
      paperAniso: { value: opts.paperAniso ?? 2.6 },
      paperStrength: { value: opts.paperStrength ?? 0.16 },
      granDensity: { value: opts.granDensity ?? 0.26 },
      distortAmt: { value: opts.distortAmt ?? 0.0015 },
      grad_eps: { value: opts.grad_eps ?? 0.0009 },
      paperLight: { value: opts.paperLight ?? 0.04 },
      lightDir3: { value: new THREE.Vector3(lightDir[0], lightDir[1], lightDir[2]) },
      toothFlatness: { value: opts.toothFlatness ?? 0.6 },
      paperTint: { value: new THREE.Vector3(paperTint[0], paperTint[1], paperTint[2]) },
      warmTint: { value: new THREE.Vector3(warmTint[0], warmTint[1], warmTint[2]) },
      coolTint: { value: new THREE.Vector3(coolTint[0], coolTint[1], coolTint[2]) },
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
      precision highp float;

      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform sampler2D tDepth;
      uniform sampler2D tNormal;
      uniform mat4  uInvViewProj;
      uniform vec3  uCameraPos;
      uniform float uWorldGrainScale;
      uniform float uWorldDistRef;
      uniform float useWorldGrain;
      uniform vec2  resolution;
      uniform float paperScale;
      uniform float paperAngle;
      uniform float paperAniso;
      uniform float paperStrength;
      uniform float granDensity;
      uniform float distortAmt;
      uniform float grad_eps;
      uniform float paperLight;
      uniform vec3  lightDir3;
      uniform float toothFlatness;
      uniform vec3  paperTint;
      uniform vec3  warmTint;
      uniform vec3  coolTint;
      uniform float time;

      // --- hashing -----------------------------------------------------------------
      // 2D value hash -> [0,1). Cheap, decorrelated; integer-lattice seed for the noise.
      float hash21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      // 1D-ish hash on a 2D coord for the folded dither (decorrelated from hash21).
      float hash12(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
      }

      // --- value noise + fbm --------------------------------------------------------
      // Smooth value noise from the lattice hash (quintic fade for C2 continuity, so the
      // analytic-by-finite-difference gradient that feeds the tooth-light is clean).
      float valueNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0); // quintic
        float a = hash21(i + vec2(0.0, 0.0));
        float b = hash21(i + vec2(1.0, 0.0));
        float c = hash21(i + vec2(0.0, 1.0));
        float d = hash21(i + vec2(1.0, 1.0));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }

      // Cold-press paper HEIGHT field: 4-octave fbm, returns ~[0,1] (peaks high, valleys low).
      // Fixed compile-time octave count (GLSL ES 1.00 safe — no dynamic loop bound).
      float paperHeight(vec2 p) {
        float h = 0.0;
        float amp = 0.5;
        float sum = 0.0;
        // 4 octaves, each rotated + scaled to break axis-aligned lattice artefacts.
        for (int o = 0; o < 4; o++) {
          h   += amp * valueNoise(p);
          sum += amp;
          // 2.07 (not exactly 2.0) decorrelates octaves; small rotation per octave.
          p = mat2(0.80, 0.60, -0.60, 0.80) * p * 2.07;
          amp *= 0.5;
        }
        return h / sum;
      }

      // Apply the felt-grain ANISOTROPY (rotate + stretch along the grain) to a 2D paper
      // coordinate, so the brushed/scumble character is identical in the screen- and world-
      // space branches. Round at paperAniso==1, directional streaks at >1.
      vec2 anisoPaper(vec2 p) {
        float ca = cos(paperAngle);
        float sa = sin(paperAngle);
        p = mat2(ca, -sa, sa, ca) * p;        // felt-grain rotation
        p.x /= max(paperAniso, 0.25);          // stretch ALONG the grain -> directional fingers
        return p;
      }

      // --- SCREEN-SPACE paper coordinate (legacy / sky fallback) --------------------------
      // Frame-anchored, rotated paper-space sample built from gl_FragCoord/resolution (NOT
      // scene geometry). Used for the SKY (camera-centred dome → screen-stable) and when
      // useWorldGrain is off. Aspect-corrected so the tooth is round, not stretched on wide.
      vec2 paperCoordScreen(vec2 fragUv) {
        float aspect = resolution.x / max(resolution.y, 1.0);
        vec2 p = vec2(fragUv.x * aspect, fragUv.y);
        p = anisoPaper(p);
        p *= paperScale * 64.0;                 // tiles across screen -> lattice units
        return p;                               // TIME-FREE: 100% frame-anchored, never boils
      }

      // --- TRIPLANAR WORLD-SPACE paper height ---------------------------------------------
      // Sample the SAME 2D paperHeight field on the three world axis-planes (YZ, XZ, XY) and
      // blend by the (squared, normalised) surface normal so the grain is projected ONTO the
      // surface with no stretching on slopes — exactly the geometry-lock the swim needed. The
      // aniso/rotation is applied INSIDE each plane along a fixed world axis so the brushed
      // character travels with the surface. freqScale folds in the distance compensation.
      float paperHeightWorld(vec3 wp, vec3 n, float freqScale) {
        vec3 an = abs(n);
        // Slightly sharpen the blend so the dominant plane wins (less cross-plane haze), then
        // normalise so the three weights sum to 1 (energy-preserving height).
        vec3 w = an * an * an;
        w /= max(w.x + w.y + w.z, 1e-4);
        vec3 q = wp * freqScale;
        float hx = paperHeight(anisoPaper(q.zy)); // plane facing world X (project onto Z,Y)
        float hy = paperHeight(anisoPaper(q.xz)); // plane facing world Y (project onto X,Z)
        float hz = paperHeight(anisoPaper(q.xy)); // plane facing world Z (project onto X,Y)
        return hx * w.x + hy * w.y + hz * w.z;
      }

      // --- soft-light ---------------------------------------------------------------
      // Pegtop soft-light: harmony-preserving (multiply muddies, additive can't darken,
      // overlay clips). s = blend layer (paper), b = base (image). Per-channel.
      vec3 pegtopSoftLight(vec3 b, vec3 s) {
        return (1.0 - 2.0 * s) * b * b + 2.0 * s * b;
      }

      void main() {
        vec2 fragUv = gl_FragCoord.xy / resolution;

        // --- Resolve the PAPER HEIGHT field h (world-locked where there is geometry) ----------
        // World branch: reconstruct this fragment's world position from RAW device depth + the
        // inverse view-projection of the shaken camera (per-fragment perspective divide), derive
        // the geometric world normal from screen-space derivatives of that world position (no
        // view→world matrix needed), and sample the print grain as TRIPLANAR world-space noise.
        // The grain is then ANCHORED to the surface and travels with it (no shower-door swim).
        // Sky / cleared depth (== far) cannot be unprojected, so fall back to the screen-space
        // coordinate (the sky dome is camera-centred → stable, no swim).
        float rawDepth = texture2D(tDepth, fragUv).r;
        bool isSky = rawDepth >= 0.9999 || useWorldGrain < 0.5;

        // Screen-space paper coordinate (used directly for sky, and as the grazing-angle/far
        // fallback the world grain cross-fades into — both stable, no swim).
        float hScreen = paperHeight(paperCoordScreen(fragUv));

        float h;
        if (isSky) {
          h = hScreen;
        } else {
          vec4 ndc    = vec4(fragUv * 2.0 - 1.0, rawDepth * 2.0 - 1.0, 1.0);
          vec4 worldH = uInvViewProj * ndc;
          vec3 wp     = worldH.xyz / worldH.w;            // per-fragment divide
          // World-position derivatives across the 2x2 quad: the geometric world normal AND the
          // per-pixel world FOOTPRINT (how much world space one screen pixel covers).
          vec3 ddx = dFdx(wp);
          vec3 ddy = dFdy(wp);
          vec3 nrm = normalize(cross(ddx, ddy) + vec3(1e-6));
          // Distance compensation: scale the world frequency by ref/dist so the on-screen speckle
          // stays ~constant (near a hair coarser, far a hair finer — correct texture perspective),
          // clamped to a NARROW band so close tarmac doesn't go blocky.
          float dist  = max(length(wp - uCameraPos), 1e-3);
          // Distance comp band capped at 1.0 (NEVER boost the near frequency above base): boosting
          // it is what made the near grazing tarmac — where the per-pixel footprint is already
          // largest — run past Nyquist and STREAK. Near stays at base freq; far gets a hair finer.
          // The footprint cap + grazing fallback below own the grazing/far band-limiting.
          float fscaleTarget = uWorldGrainScale * clamp(uWorldDistRef / dist, 0.6, 1.0);
          float fscale = fscaleTarget;
          // ANALYTIC ANTI-ALIAS (mip-style band-limit): the ground is viewed at a grazing angle,
          // so a fixed world frequency projects to a runaway SCREEN frequency in the depth
          // direction and MOIRÉS/aliases against the pixel grid. Cap fscale so the grain never
          // exceeds ~Nyquist on screen — fscale * worldFootprint <= NYQ cells/pixel. Grazing/far
          // surfaces therefore use a slightly coarser (but stable, non-swimming) cell while near
          // face-on surfaces keep the full fine print. This is exactly how a mipmapped texture
          // behaves, and it kills most of the triplanar grazing-angle moiré without swim.
          float lddx = length(ddx);
          float lddy = length(ddy);
          float footprint = max(lddx, lddy);                    // world units per screen pixel
          const float NYQ = 0.5;
          float fcap = NYQ / max(footprint, 1e-5);
          fscale = min(fscale, fcap);
          float hWorld = paperHeightWorld(wp, nrm, fscale);
          // FOOTPRINT ANISOTROPY: a grazing surface (the ground) has a hugely anisotropic per-pixel
          // world footprint (one axis stretched), so the isotropic world noise PROJECTS to directional
          // screen streaks. The ratio of the two derivative lengths measures exactly that grazing
          // stretch — high on the streaking ground, ~1 on face-on surfaces. It drives the screen-grain
          // crossfade below, so the streaks are replaced by the stable, non-directional screen print
          // precisely where they would appear, while face-on surfaces stay fully world-locked.
          float fpAniso = max(lddx, lddy) / max(min(lddx, lddy), 1e-5);

          // GRAZING-ANGLE FALLBACK: when one pixel's world footprint approaches/exceeds a grain
          // CELL (footprint * fscale → ~Nyquist), the world lookup is maximally band-limited and a
          // single isotropic 2D noise can't represent the extreme anisotropic footprint without
          // residual directional streaks. There — and only there (the near grazing tarmac lip + the
          // horizon) — cross-fade to the STABLE screen-space grain. Those pixels sit near the
          // vanishing point / move little on screen, so screen-locked grain there does NOT visibly
          // swim (same rationale as the sky fallback). The bulk near→mid road, where the swim was
          // obvious, stays fully WORLD-LOCKED. cellsPerPixel is the on-screen grain rate; fade in the
          // screen fallback as it passes ~0.5 (Nyquist). Keyed off the UNCAPPED target frequency so
          // the worst grazing (where the cap pins hard) drives the mix fully to the screen grain.
          float cellsPerPixel = footprint * fscaleTarget;
          // Cross-fade to the stable screen grain at grazing angles so the near grazing tarmac reads
          // as a fine EVEN print, not directional brushed streaks (the critique's ground streak).
          // Two drivers, MAX-combined: (a) the on-screen grain rate (footprint×freq, the moiré/Nyquist
          // limit) and (b) the FOOTPRINT ANISOTROPY (the grazing stretch that turns isotropic world
          // noise into screen streaks). The anisotropy term catches the whole streaking mid-ground
          // — whose footprint is only moderate but is highly stretched — while leaving face-on
          // surfaces (car, props, sky) fully world-locked. Pixels that flip to screen grain sit near
          // the vanishing point / barely move, so there is no visible swim.
          float screenMix = max(
            smoothstep(0.22, 0.55, cellsPerPixel),
            smoothstep(2.5, 6.0, fpAniso)
          );
          h = mix(hWorld, hScreen, screenMix);
        }

        // SCREEN-SPACE gradient of the (world-locked) height field via hardware derivatives:
        // dFdx(h)/dFdy(h) is exactly the per-screen-pixel finite difference of the height field
        // that the tooth-light and UV micro-distortion both want (both operate in screen/UV
        // space), and it works identically for the world and sky branches with no view→world
        // matrix. A fixed GRAD_GAIN brings the per-pixel slope of a fine field into the same
        // gentle range the old explicit finite-difference produced; toothFlatness softens it
        // further and the clamp bounds a high-frequency spike. grad_eps/time are now inert.
        const float GRAD_GAIN = 9.0;
        vec2 grad = vec2(dFdx(h), dFdy(h)) * GRAD_GAIN * toothFlatness;
        grad = clamp(grad, vec2(-1.0), vec2(1.0));

        // (3) MICRO-DISTORTION — fetch the painted image through a UV nudged along the paper
        // slope, so painted edges crawl into the tooth instead of breaking on pixels.
        vec2 distUv = grad * distortAmt;
        vec3 col = texture2D(tDiffuse, vUv + distUv).rgb;

        // --- (1) GRANULATION: subtractive + desaturating pigment-settle in valleys ----
        // Centre the height around 0 so peaks (>0) and valleys (<0) are signed.
        float hSigned = h - 0.5;
        // Pigment pools in the VALLEYS (low height) -> settle increases as height drops.
        float settle = clamp(0.5 - hSigned, 0.0, 1.0); // 0 at peaks, ->1 in deep valleys
        // V2 CORRECTION 2: flatten the valley-pooling so the (fine) grain is an EVEN fine print
        // speckle across the frame, not discrete watercolour pools clumping into the tooth.
        settle = pow(settle, 1.15);
        // Luma bell — the tooth must BITE in the bright/mid washes (ref 02's bright sky carries
        // visible cold-press tooth). Matched to the WatercolourPigment bell.
        float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
        float bell = exp(-pow((luma - 0.58) / 0.24, 2.0));
        float gran = granDensity * settle * bell;
        // Subtractive: darken toward the local value (pigment drying denser).
        col *= (1.0 - gran);
        // Desaturating: pull the granulated patch slightly toward its own luma (VALUE noise,
        // hue ~unchanged — spec §8 "granulate VALUE not hue").
        col = mix(col, vec3(luma), gran * 0.25);

        // --- (2) TOOTH LIGHTING: faint SIGNED raking light from the height gradient -----
        // Slopes facing the light (rake > 0) catch a WARM micro-highlight; slopes facing away
        // (rake < 0) fall into a COOL micro-shadow. SIGNED: adds on the lit side, subtracts on
        // the shade side, so the fibre reads as a lit surface, not a uniform brightening haze.
        vec2 lDir = normalize(lightDir3.xy + vec2(1e-5));
        float rake = clamp(dot(grad, lDir), -1.0, 1.0); // signed: + toward light, - away
        // Bias the hue RELATIVE to the warm-cream sheet so the tint is a hue *direction*.
        vec3 toothHue = (rake >= 0.0 ? warmTint : coolTint) - paperTint;
        col += (vec3(rake) + toothHue * abs(rake)) * paperLight;

        // --- composite: Pegtop SOFT-LIGHT the paper sheet over the painted image --------
        // The sheet itself carries a faint tooth (lighter on peaks, darker in valleys).
        vec3 sheet = paperTint * (0.92 + 0.16 * hSigned);
        vec3 lit   = pegtopSoftLight(col, sheet);
        col = mix(col, lit, paperStrength);

        // --- folded 1/255 hashed dither (takes over FilmGrain's debanding role) ---------
        // Two summed hashes -> triangular (TPDF-ish) noise, folded to ~±0.5 LSB at 8-bit. The
        // dither is a per-pixel debanding device (NOT image grain), so it stays SCREEN-space.
        float d0 = hash12(gl_FragCoord.xy);
        float d1 = hash12(gl_FragCoord.xy + 19.19);
        float dither = (d0 + d1 - 1.0) / 255.0;
        col += dither;

        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }
    `
  })
}
