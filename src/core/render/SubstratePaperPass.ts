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
 *   2. TOOTH LIGHT   — a faint SIGNED raking light computed from the analytic height
 *                      GRADIENT (gradient = surface normal). Peaks catch the warm light,
 *                      valleys fall into a cool micro-shadow (~0.04 strength). This is what
 *                      sells "paper fibre" rather than "noise texture".
 *   3. MICRO-DISTORT — nudge the colour-fetch UV by the height gradient so the already-
 *                      painted edges break a little on the fibre (wet pigment crawling into
 *                      the tooth), not on a clean pixel grid.
 *
 * The result is composited over a warm-cream sheet (`#EDE7D8`) with **Pegtop soft-light**
 * (`softLight(b,s) = (1-2s)*b*b + 2s*b`) — harmony-preserving: multiply-only goes muddy,
 * additive can't darken, overlay clips. paperStrength ~0.16. Keep granDensity in 0.18–0.35
 * and paperStrength in 0.12–0.22; over-application (>0.4 / >0.3) reads as **dirt, not paper**.
 *
 * FRAME-ANCHORED (the #1 paper risk): the height field is sampled from `gl_FragCoord` /
 * resolution, i.e. screen-static. It is NOT tied to scene geometry, so it does not scroll
 * with the road ("shower-door" death). `time` only drives a very slow, low-amplitude re-seed
 * (a barely-perceptible drift of a new sheet) — never a per-frame boil. The finite-difference
 * gradient is taken from the NOISE FIELD itself (not from tDiffuse), so the tooth-light and
 * micro-distortion describe the paper, not the image content.
 *
 * Display-space LDR: runs after OutputPass like every painterly pass; all maths are
 * perceptual (luma bell, soft-light) and would misbehave on linear HDR.
 *
 * Uniforms (per STYLE_SPEC §3 PASS 9):
 *   tDiffuse       — input colour (auto-wired by EffectComposer)
 *   resolution     — drawing-buffer pixel size (vec2; width*min(dpr,2), height*min(dpr,2)); .set() in resize()
 *   paperScale     — paper tooth frequency in tiles across the screen (bigger = finer grain)
 *   paperAngle     — felt-grain rotation in radians (cold-press is anisotropic; ~17° = 0.30 rad)
 *   paperStrength  — soft-light sheet opacity, 0.12–0.22 (default 0.16). >0.3 = dirt.
 *   granDensity    — granulation (pigment-settle) strength, 0.18–0.35 (default 0.26). >0.4 = dirt.
 *   distortAmt     — UV micro-distortion amount in UV units (~0.0015; edges crawl into the tooth)
 *   grad_eps       — finite-difference step for the height gradient, in UV (~1px)
 *   paperLight     — tooth raking-light strength (~0.04; peaks warm / valleys cool)
 *   lightDir3      — raking light direction (vec2 in paper space; only x,y used, z ignored for slope)
 *   toothFlatness  — softens the height→slope response so the tooth-light isn't harsh (~0.6)
 *   paperTint      — the warm-cream substrate colour the image sits on (#EDE7D8)
 *   warmTint       — colour the PEAKS are pushed toward by the tooth-light (warm paper highlight)
 *   coolTint       — colour the VALLEYS are pushed toward (cool micro-shadow in the tooth)
 *   time           — seconds; drives only the slow paper re-seed, NOT a per-frame boil
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
      // Drawing-buffer resolution (vec2); placeholder 1080p, ThreeScene .set()s it in resize().
      resolution: { value: new THREE.Vector2(res[0], res[1]) },
      paperScale: { value: opts.paperScale ?? 2.6 },
      paperAngle: { value: opts.paperAngle ?? 0.297 }, // ~17 degrees
      // R4 BRUSHWORK: anisotropic stretch of the tooth ALONG the felt-grain angle. 1.0 = round
      // (isotropic) tooth; >1 stretches the noise into directional brush/scumble streaks so the
      // flat fields read as BRUSHED gouache (ref 02), not airbrushed. Keeps the paper frame-
      // anchored (no shower-door) — it's the SAMPLE that's stretched, not scrolled.
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

      // Map screen UV -> frame-anchored, rotated paper-space sample coordinate.
      // Built from gl_FragCoord/resolution (NOT scene geometry) => screen-static "tooth".
      // 'time' adds an almost-imperceptible slow drift = a fresh sheet, never a per-frame boil.
      vec2 paperCoord(vec2 fragUv) {
        // Aspect-correct so the tooth is round, not stretched on widescreen.
        float aspect = resolution.x / max(resolution.y, 1.0);
        vec2 p = vec2(fragUv.x * aspect, fragUv.y);
        float ca = cos(paperAngle);
        float sa = sin(paperAngle);
        p = mat2(ca, -sa, sa, ca) * p;             // felt-grain anisotropy rotation
        // R4: stretch the noise ALONG the grain (x after rotation) so the tooth becomes
        // directional brush/scumble streaks instead of a round dot field. Dividing the
        // along-grain coordinate makes the lattice repeat slower in that direction = elongated
        // pigment fingers; the across-grain axis stays fine, so strokes read as bristle marks.
        p.x /= max(paperAniso, 0.25);
        p *= paperScale * 64.0;                     // tiles across screen -> lattice units
        p += vec2(time * 0.013, time * -0.009);     // slow re-seed drift (shower-door safe)
        return p;
      }

      // --- soft-light ---------------------------------------------------------------
      // Pegtop soft-light: harmony-preserving (multiply muddies, additive can't darken,
      // overlay clips). s = blend layer (paper), b = base (image). Per-channel.
      vec3 pegtopSoftLight(vec3 b, vec3 s) {
        return (1.0 - 2.0 * s) * b * b + 2.0 * s * b;
      }

      void main() {
        // Frame-anchored paper sample coordinate (screen-static).
        vec2 fragUv = gl_FragCoord.xy / resolution;
        vec2 pc = paperCoord(fragUv);

        // Central paper height + finite-difference GRADIENT of the NOISE FIELD (not the
        // image): gradient == surface normal slope, which drives BOTH the tooth-light and
        // the UV micro-distortion. Step is in UV, converted into paper-lattice units so a
        // single eps stays ~1px regardless of paperScale.
        float aspect = resolution.x / max(resolution.y, 1.0);
        float epsLat = grad_eps * paperScale * 64.0 * max(aspect, 1.0);
        float h  = paperHeight(pc);
        float hx = paperHeight(pc + vec2(epsLat, 0.0));
        float hy = paperHeight(pc + vec2(0.0, epsLat));
        // Slope of the height field; softened by toothFlatness so the tooth-light is gentle.
        vec2 grad = vec2(hx - h, hy - h) / max(epsLat, 1e-5);
        grad *= toothFlatness;

        // (3) MICRO-DISTORTION — fetch the painted image through a UV nudged along the
        // paper slope, so painted edges crawl into the tooth instead of breaking on pixels.
        // Convert the lattice-space gradient back to UV-ish (undo aspect on x).
        vec2 distUv = vec2(grad.x / max(aspect, 1.0), grad.y) * distortAmt;
        vec3 col = texture2D(tDiffuse, vUv + distUv).rgb;

        // --- (1) GRANULATION: subtractive + desaturating pigment-settle in valleys ----
        // Centre the height around 0 so peaks (>0) and valleys (<0) are signed.
        float hSigned = h - 0.5;
        // Pigment pools in the VALLEYS (low height) -> settle increases as height drops.
        // SHARPENED (pow > 1) so the granulation reads as discrete pools settling into the
        // tooth (real watercolour granulation) rather than a uniform fine veil over everything.
        float settle = clamp(0.5 - hSigned, 0.0, 1.0); // 0 at peaks, ->1 in deep valleys
        settle = pow(settle, 1.8);                      // pool in the deep valleys, clear the peaks
        // Luma BELL gate: bite in the mid washes, fade in paper-white & darks. NARROWED and
        // pivoted a touch DOWN (peak ~0.40, width ~0.20) so the luminous negative space / bright
        // sky stays CLEAN (ref 02's quiet field is ungranulated) and the granulation concentrates
        // in the mid-value washes (ground, road, forms) where watercolour granulation lives.
        float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
        float bell = exp(-pow((luma - 0.40) / 0.20, 2.0));
        float gran = granDensity * settle * bell;
        // Subtractive: darken toward the local value (pigment drying denser).
        col *= (1.0 - gran);
        // Desaturating: pull the granulated patch slightly toward its own luma (pigment
        // settling kills a little chroma in the valley — value noise, hue ~unchanged).
        col = mix(col, vec3(luma), gran * 0.5);

        // --- (2) TOOTH LIGHTING: faint SIGNED raking light from the height gradient -----
        // Slopes facing the light (rake > 0) catch a WARM micro-highlight and brighten;
        // slopes facing away (rake < 0) fall into a COOL micro-shadow and darken. This is
        // the SIGNED tooth-light: it adds on the lit side and subtracts on the shade side,
        // so the cold-press fibre reads as a lit surface, not a uniform brightening haze.
        vec2 lDir = normalize(lightDir3.xy + vec2(1e-5));
        float rake = clamp(dot(grad, lDir), -1.0, 1.0); // signed: + toward light, - away
        // Pick the warm (peak) or cool (valley) hue by sign, but bias it RELATIVE to the
        // warm-cream sheet so the tint is a hue *direction*, not a big DC brightening.
        vec3 toothHue = (rake >= 0.0 ? warmTint : coolTint) - paperTint;
        // Signed scalar light + the hue direction => peaks warm-up, valleys cool-down.
        col += (vec3(rake) + toothHue * abs(rake)) * paperLight;

        // --- composite: Pegtop SOFT-LIGHT the paper sheet over the painted image --------
        // Build the per-pixel paper layer: warm-cream tint modulated by the height field so
        // the sheet itself carries a faint tooth (lighter on peaks, darker in valleys).
        vec3 sheet = paperTint * (0.92 + 0.16 * hSigned);
        vec3 lit   = pegtopSoftLight(col, sheet);
        col = mix(col, lit, paperStrength);

        // --- folded 1/255 hashed dither (takes over FilmGrain's debanding role) ---------
        // Two summed hashes -> triangular (TPDF-ish) noise, folded to ~±0.5 LSB at 8-bit.
        float d0 = hash12(gl_FragCoord.xy);
        float d1 = hash12(gl_FragCoord.xy + 19.19);
        float dither = (d0 + d1 - 1.0) / 255.0;
        col += dither;

        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }
    `
  })
}
