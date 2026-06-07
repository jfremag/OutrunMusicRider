import * as THREE from 'three'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'

/**
 * WatercolourPigmentPass — PASS 5 of the "Watercolour Speed" painterly pipeline.
 *
 * Runs on the tone-mapped, display-space LDR image (after OutputPass and the
 * Anisotropic Kuwahara keystone, before the gradient-map palette lock). Implements a
 * lightweight, screen-space, fluid-sim-free watercolour pigment model (Bousseau 2006 /
 * Luft-Deussen / Montesdeoca MNPR) that turns the flattened gouache washes coming out of
 * Kuwahara into pigment sitting on cold-press paper. Five stacked ops, in order:
 *
 *   1. STATIC UV WOBBLE — a low-frequency 2D value-noise offset (a baked "hand tremor") added
 *      to the sample UV so every subsequent fetch reads through `vUv + wobble`. FRAME-ANCHORED
 *      and TIME-FREE (the old `uTime/wobbleSpeed` boiling was removed — drifting grain reads as
 *      motion sickness); it is now a fixed spatial offset, never animated. `wobbleAmp <= 0.004`.
 *      (`time`/`wobbleSpeed` are retained as inert uniforms only for call-site/back-compat.)
 *   2. EDGE-DARKENING — a Sobel gradient on luma marks value boundaries; pigment piles up
 *      there (the Marangoni effect), so the colour is MULTIPLIED toward its own darker self
 *      by `(1 - edge*edgeStrength)`. The darkening is hard-capped at 0.55 (`EDGE_CEILING`)
 *      so even the strongest contour cannot go inky/black — a watercolour edge is a tinted
 *      pool, not a line of ink.
 *   3. PIGMENT DENSITY — `density = pow(1-luma, pigmentGamma) + sat*0.3`: dark and saturated
 *      pixels carry more pigment. Drives both the granulation bite and the bleed amount.
 *   4. GRANULATION — heavy pigment particles settle into the paper valleys. A paper height
 *      field `h` subtracts pigment in the troughs: `gran = 1 - granulation*density*(1-h)`.
 *      Gated by a LUMA BELL so it bites in the mid/bright washes and fades out in paper-white
 *      and in the dense darks — otherwise it reads as snow over the whole frame. The tooth is
 *      now GEOMETRY-LOCKED: `paperToothAt` reconstructs the world position from the scene DEPTH
 *      + inverse view-projection and samples a TRIPLANAR world-space tooth so the granulation
 *      travels WITH the road/ground (no screen-space swim); sky/cleared-depth pixels fall back
 *      to the screen-space tooth (`tPaper` if supplied, else a procedural 3-octave fbm).
 *   5. DENSITY-GATED BLEED — a cheap 4-tap box gather across found edges, mixed back in by
 *      `density*0.4` so colour bleeds further where the wash is heavy and stays crisp where
 *      it is thin: `col = mix(col, bleed, density*0.4)`.
 *
 * Chroma is deliberately untouched — this is a VALUE/pigment operation (the §8 law:
 * "granulate VALUE not hue"); there is no chroma jitter. The granulation tooth is sampled in
 * WORLD space (triplanar, geometry-locked) so it sticks to and travels with the surfaces
 * instead of "shower-door" sliding over them; the final SubstratePaperPass owns the
 * authoritative (also world-locked) sheet, this one only needs a tooth to settle pigment into.
 *
 * Holds one frame-state value (`time`, advanced by the renderer) for the slow wobble; every
 * other parameter is a tunable uniform. `tPaper` is OPTIONAL: leave it null (the default)
 * and the procedural fallback supplies the height field. To upgrade the tooth with a real
 * cold-press paper texture, set `tPaper.value = texture` AND flip `usePaper.value = 1` at
 * wiring time — both paths are compiled, so the switch is runtime with zero recompile, and
 * the texture fetch is only reached once a texture is actually bound (no undefined sampler).
 *
 * Uniforms (per STYLE_SPEC PASS 5):
 *   tDiffuse     — input colour (wired by EffectComposer automatically)
 *   tPaper       — optional cold-press paper height texture; null → procedural fallback
 *   usePaper     — 0 = procedural fbm tooth (default), 1 = sample tPaper instead
 *   tDepth       — scene DepthTexture (RAW device depth) for the world-locked tooth reconstruction
 *   uInvViewProj — inverse of the SHAKEN camera view-projection (depth → world unproject)
 *   uCameraPos   — shaken camera world position (distance-based grain-frequency compensation)
 *   uWorldGrainScale — world-space tooth lattice frequency (cells per world unit ×)
 *   uWorldDistRef    — reference camera→surface distance where the world tooth ≈ the screen tooth
 *   useWorldGrain — 1 = geometry-locked triplanar world tooth (default); 0 = legacy screen tooth
 *   resolution   — drawing-buffer size in pixels (width*min(dpr,2), height*min(dpr,2))
 *   time         — seconds, advanced by the renderer so the wet wobble drifts
 *   paperScale   — paper-tooth frequency multiplier (valleys per screen); higher = finer
 *   wobbleAmp    — wet UV tremor amplitude in UV units (<= 0.004, or it boils)
 *   wobbleFreq   — wet UV tremor spatial frequency (cells across the screen)
 *   wobbleSpeed  — wet UV tremor temporal speed (<= 0.15, or it boils)
 *   edgeStrength — Marangoni edge-darkening amount before the 0.55 ceiling
 *   edgeWidth    — Sobel sample spacing in pixels (how wide a value boundary "reads")
 *   granulation  — pigment-settling strength into the paper valleys
 *   bleedRadius  — bleed gather tap spacing in pixels
 *   pigmentGamma — density curve exponent on (1-luma); higher = denser only in the darks
 */
export function createWatercolourPigmentPass(opts: {
  resolution?: [number, number]
  paperScale?: number
  wobbleAmp?: number
  wobbleFreq?: number
  wobbleSpeed?: number
  edgeStrength?: number
  edgeWidth?: number
  granulation?: number
  bleedRadius?: number
  pigmentGamma?: number
  worldGrainScale?: number
  worldDistRef?: number
} = {}): ShaderPass {
  return new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      // Optional paper height field. ThreeScene may set this later together with
      // usePaper=1; while null/usePaper=0 the shader uses the procedural fbm fallback and
      // never samples tPaper (so an unbound sampler is never read).
      tPaper: { value: null },
      usePaper: { value: 0 },
      // GEOMETRY-LOCKED grain inputs (ThreeScene wires these each frame). The granulation
      // tooth is sampled in WORLD space (triplanar) from depth + the inverse view-projection
      // so it travels WITH the road/ground instead of swimming in screen space. Sky pixels
      // (rawDepth==far) fall back to the screen-space tooth. useWorldGrain=0 keeps the legacy
      // screen tooth.
      tDepth: { value: null as THREE.Texture | null },
      uInvViewProj: { value: new THREE.Matrix4() },
      uCameraPos: { value: new THREE.Vector3() },
      uWorldGrainScale: { value: opts.worldGrainScale ?? 1.7 },
      uWorldDistRef: { value: opts.worldDistRef ?? 26.0 },
      useWorldGrain: { value: 1 },
      resolution: { value: opts.resolution ?? [1920, 1080] },
      time: { value: 0 },
      paperScale: { value: opts.paperScale ?? 2.2 },
      // Wet tremor — clamped low/slow by default so it reads as wet paper, not boiling.
      wobbleAmp: { value: opts.wobbleAmp ?? 0.003 },
      wobbleFreq: { value: opts.wobbleFreq ?? 3.0 },
      wobbleSpeed: { value: opts.wobbleSpeed ?? 0.12 },
      // Edge-darkening (Marangoni). The 0.55 ceiling is baked into the shader.
      edgeStrength: { value: opts.edgeStrength ?? 0.55 },
      edgeWidth: { value: opts.edgeWidth ?? 1.3 },
      // Granulation + bleed.
      granulation: { value: opts.granulation ?? 0.28 },
      bleedRadius: { value: opts.bleedRadius ?? 1.5 },
      pigmentGamma: { value: opts.pigmentGamma ?? 1.4 }
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
      uniform sampler2D tPaper;
      uniform float usePaper;
      uniform sampler2D tDepth;
      uniform mat4  uInvViewProj;
      uniform vec3  uCameraPos;
      uniform float uWorldGrainScale;
      uniform float uWorldDistRef;
      uniform float useWorldGrain;
      uniform vec2  resolution;
      uniform float time;
      uniform float paperScale;
      uniform float wobbleAmp;
      uniform float wobbleFreq;
      uniform float wobbleSpeed;
      uniform float edgeStrength;
      uniform float edgeWidth;
      uniform float granulation;
      uniform float bleedRadius;
      uniform float pigmentGamma;

      // Rec.709 luma — the value channel everything keys off.
      float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

      // -- Value noise (Morgan McJones / IQ style) ---------------------------------------
      // 2D hash → [0,1); smooth bilinear interpolation of a lattice of hashes. Used both
      // for the wet UV wobble and as the procedural paper-tooth fallback. Cheap, no texture.
      float hash21(vec2 p) {
        p = fract(p * vec2(123.34, 345.45));
        p += dot(p, p + 34.345);
        return fract(p.x * p.y);
      }
      float valueNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        // Quintic (smootherstep) fade — C2 continuous, so no lattice creasing in the wobble.
        vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
        float a = hash21(i + vec2(0.0, 0.0));
        float b = hash21(i + vec2(1.0, 0.0));
        float c = hash21(i + vec2(0.0, 1.0));
        float d = hash21(i + vec2(1.0, 1.0));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }

      // 3-octave fbm — the procedural cold-press paper-tooth fallback (frame-anchored).
      // Rotated per octave so the grain has no obvious axis. Returns a height field in [0,1].
      float paperFbm(vec2 p) {
        const mat2 ROT = mat2(0.80, -0.60, 0.60, 0.80); // ~37deg, decorrelates octaves
        float h = 0.0;
        float amp = 0.5;
        for (int o = 0; o < 3; o++) {
          h += valueNoise(p) * amp;
          p = ROT * p * 2.0;
          amp *= 0.5;
        }
        return h; // sum of 0.5+0.25+0.125 = ~[0, 0.875], near-normalised to [0,1]
      }

      // Resolve the paper height field at a screen UV. Uses tPaper when wired (usePaper=1);
      // otherwise the procedural fbm so this pass stands alone. Aspect-corrected so the tooth
      // is square (not stretched) on wide screens, and anchored to the frame (no geometry
      // scroll). The tPaper fetch is guarded by the runtime branch and only evaluated when a
      // texture has actually been bound, so a null/unbound sampler is never read.
      float paperHeight(vec2 uv) {
        if (usePaper > 0.5) {
          return texture2D(tPaper, uv * paperScale).r;
        }
        vec2 aspect = vec2(resolution.x / resolution.y, 1.0);
        // Multiply UV up into "paper cells across the screen". 22 cells * paperScale
        // gives a fine cold-press tooth at the default paperScale ~2.2.
        return paperFbm(uv * aspect * paperScale * 22.0);
      }

      // TRIPLANAR WORLD-SPACE paper height: sample the SAME paperFbm tooth on the three world
      // axis-planes and blend by the (cubed, normalised) surface normal, so the granulation
      // tooth is projected ONTO the surface and travels WITH it (no screen-space swim). The
      // world frequency folds in a ref/dist compensation so the on-screen tooth stays ~fine.
      float paperHeightWorld(vec3 wp, vec3 n, float freqScale) {
        vec3 an = abs(n);
        vec3 w = an * an * an;
        w /= max(w.x + w.y + w.z, 1e-4);
        vec3 q = wp * freqScale;
        float hx = paperFbm(q.zy);
        float hy = paperFbm(q.xz);
        float hz = paperFbm(q.xy);
        return hx * w.x + hy * w.y + hz * w.z;
      }

      // Resolve the paper-tooth height at this fragment, GEOMETRY-LOCKED where there is scene
      // geometry: reconstruct the world position from RAW device depth + the inverse view-
      // projection (per-fragment divide), derive the world normal from screen-space derivatives,
      // and sample the triplanar world tooth. Sky / cleared depth (== far) cannot be unprojected,
      // so fall back to the screen-space tooth (the camera-centred sky dome is screen-stable).
      float paperToothAt(vec2 fragUv, vec2 sampleUv) {
        float hScreen = paperHeight(sampleUv);
        float rawDepth = texture2D(tDepth, fragUv).r;
        if (useWorldGrain < 0.5 || rawDepth >= 0.9999) {
          return hScreen;
        }
        vec4 ndc    = vec4(fragUv * 2.0 - 1.0, rawDepth * 2.0 - 1.0, 1.0);
        vec4 worldH = uInvViewProj * ndc;
        vec3 wp     = worldH.xyz / worldH.w;
        vec3 ddx = dFdx(wp);
        vec3 ddy = dFdy(wp);
        vec3 nrm = normalize(cross(ddx, ddy) + vec3(1e-6));
        float dist  = max(length(wp - uCameraPos), 1e-3);
        // Distance comp capped at 1.0 (never boost near freq above base — boosting it streaks the
        // near grazing tarmac, see SubstratePaperPass). Far gets a hair finer; footprint cap +
        // grazing fallback own the band-limiting.
        float fscaleTarget = uWorldGrainScale * clamp(uWorldDistRef / dist, 0.6, 1.0);
        float fscale = fscaleTarget;
        // ANALYTIC ANTI-ALIAS (mip-style band-limit, see SubstratePaperPass): cap the world
        // frequency to ~Nyquist on screen so the grazing-angle ground tooth never moirés/aliases.
        float lddx = length(ddx);
        float lddy = length(ddy);
        float footprint = max(lddx, lddy);
        float fcap = 0.5 / max(footprint, 1e-5);
        fscale = min(fscale, fcap);
        float hWorld = paperHeightWorld(wp, nrm, fscale);
        // Footprint anisotropy (the grazing stretch that streaks isotropic world noise on screen);
        // see SubstratePaperPass. Drives the screen-tooth crossfade on the streaking grazing ground.
        float fpAniso = max(lddx, lddy) / max(min(lddx, lddy), 1e-5);
        // GRAZING-ANGLE FALLBACK (see SubstratePaperPass): at the extreme grazing tarmac lip /
        // horizon, where a pixel's world footprint exceeds a grain cell and the band-limited world
        // lookup can only streak, cross-fade to the stable screen tooth (those pixels sit near the
        // vanishing point and barely move on screen, so no visible swim). The bulk near→mid road
        // stays world-locked.
        float cellsPerPixel = footprint * fscaleTarget;
        // Cross-fade to the stable screen tooth on grazing surfaces (matched to SubstratePaperPass):
        // MAX of the on-screen grain rate and the footprint anisotropy, so the streaking grazing
        // ground reads as fine even print while face-on surfaces stay world-locked.
        float screenMix = max(
          smoothstep(0.22, 0.55, cellsPerPixel),
          smoothstep(2.5, 6.0, fpAniso)
        );
        return mix(hWorld, hScreen, screenMix);
      }

      void main() {
        vec2 texel = 1.0 / resolution;

        // -- OP 1: STATIC FRAME-ANCHORED UV WOBBLE -----------------------------------------
        // FLOATER FIX: the wet wobble was time-driven (vec2(0,t) / (5.2,1.3-t)), which made the
        // whole frame "boil" frame-to-frame (drifting grain == motion sickness). The time term
        // is REMOVED so the wobble is a STATIC spatial offset anchored to vUv — a fixed hand-
        // tremor baked into the sheet, never an animated one. Two decorrelated low-frequency
        // value-noise lookups give a smooth 2D offset; amplitude in UV units, clamped <= 0.004.
        vec2 wob;
        wob.x = valueNoise(vUv * wobbleFreq + vec2(0.0, 0.0)) - 0.5;
        wob.y = valueNoise(vUv * wobbleFreq + vec2(5.2, 1.3)) - 0.5;
        wob *= 2.0;
        vec2 uv = vUv + wob * min(wobbleAmp, 0.004);

        vec3 col = texture2D(tDiffuse, uv).rgb;

        // -- OP 2: EDGE-DARKENING (Marangoni pigment buildup) -----------------------------
        // 3x3 Sobel on luma at the wobbled UV → gradient magnitude marks value boundaries.
        vec2 e = texel * edgeWidth;
        float l00 = luma(texture2D(tDiffuse, uv + vec2(-e.x, -e.y)).rgb);
        float l10 = luma(texture2D(tDiffuse, uv + vec2( 0.0, -e.y)).rgb);
        float l20 = luma(texture2D(tDiffuse, uv + vec2( e.x, -e.y)).rgb);
        float l01 = luma(texture2D(tDiffuse, uv + vec2(-e.x,  0.0)).rgb);
        float l21 = luma(texture2D(tDiffuse, uv + vec2( e.x,  0.0)).rgb);
        float l02 = luma(texture2D(tDiffuse, uv + vec2(-e.x,  e.y)).rgb);
        float l12 = luma(texture2D(tDiffuse, uv + vec2( 0.0,  e.y)).rgb);
        float l22 = luma(texture2D(tDiffuse, uv + vec2( e.x,  e.y)).rgb);
        float gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
        float gy = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);
        float edge = clamp(length(vec2(gx, gy)), 0.0, 1.0);
        // MULTIPLY toward a darker version of the SAME colour (preserves the local hue's
        // tint — a watercolour edge is a deeper pool of the wash, not added ink). Hard
        // ceiling 0.55: the darkest an edge may pull a pixel is 55%, never inky/black.
        float darken = 1.0 - min(edge * edgeStrength, 0.55);
        col *= darken;

        // -- OP 3: PIGMENT DENSITY --------------------------------------------------------
        // Dark + saturated = denser pigment. 'sat' is the cheap chroma estimate (max-min);
        // we read it AFTER edge-darkening so freshly-pooled edges count as denser too.
        float lum = luma(col);
        float mx = max(max(col.r, col.g), col.b);
        float mn = min(min(col.r, col.g), col.b);
        float sat = mx - mn;
        float density = pow(1.0 - lum, pigmentGamma) + sat * 0.3;
        density = clamp(density, 0.0, 1.0);

        // -- OP 4: GRANULATION (pigment settling into paper valleys) ----------------------
        // Paper height h: high = peaks (fibre tops, little pigment), low = valleys (pigment
        // pools). '1-h' is therefore "valley depth"; granulation subtracts pigment-as-value
        // there, scaled by how much pigment is present (density). Gate by a LUMA BELL peaking
        // at ~0.45 so the tooth bites in the mid washes and fades out in paper-white and in
        // the dense darks (a Gaussian bell on luma, width ~0.30).
        float h = paperToothAt(vUv, uv);
        // R-FINAL P2: RE-PIVOT the luma bell from peak 0.40 to 0.62 / width 0.30. After P1
        // restored the value range, 60-70% of the frame now lives in the BRIGHT washes (~0.6-0.8)
        // — but the old bell peaked at 0.40, below where the picture sits, so the tooth never
        // bit where most pixels are (ref 02's bright sky is alive with tooth; ours was dead-
        // smooth). Pivoting to the new median (~0.62) and widening to 0.30 makes the granulation
        // bite across the bright AND mid fields. Matched to the SubstratePaper bell so the two
        // tooth layers agree.
        float bell = exp(-pow((lum - 0.58) / 0.24, 2.0));
        // Sharpen the valley response (1-h)^1.6 so pigment POOLS in the deep tooth rather than
        // veiling evenly — reads as watercolour granulation, not sandpaper static.
        float valley = pow(clamp(1.0 - h, 0.0, 1.0), 1.6);
        float gran = 1.0 - granulation * density * valley * bell;
        col *= gran;

        // -- OP 5: DENSITY-GATED 4-TAP BLEED ----------------------------------------------
        // Cheap diagonal box gather (4 taps) approximates pigment bleeding across the found
        // edges. Mixed back by density*0.4 so heavy washes bleed and thin ones stay crisp.
        vec2 b = texel * bleedRadius;
        vec3 bleed =
            texture2D(tDiffuse, uv + vec2( b.x,  b.y)).rgb +
            texture2D(tDiffuse, uv + vec2(-b.x,  b.y)).rgb +
            texture2D(tDiffuse, uv + vec2( b.x, -b.y)).rgb +
            texture2D(tDiffuse, uv + vec2(-b.x, -b.y)).rgb;
        bleed *= 0.25;
        // Re-apply the same edge-darkening to the bleed sample so mixing toward it does not
        // lift the pooled edges back up (keeps the value boundary honest).
        bleed *= darken;
        col = mix(col, bleed, density * 0.4);

        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }
    `
  })
}
