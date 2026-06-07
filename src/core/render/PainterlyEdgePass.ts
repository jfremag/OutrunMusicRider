import * as THREE from 'three'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'

/**
 * PainterlyEdgePass — STYLE_SPEC PASS 7, the "lost-and-found" dark-accent edges.
 *
 * The "finished painting" cue. After the gouache flattener (Kuwahara), the pigment wash,
 * and the palette-lock LUT, MOST silhouettes in the frame should simply dissolve (matched
 * values + soft washes); only a SPARSE few of the highest-contrast contours get a single
 * calligraphic dark accent stroke — and the SAME edge is *found here and lost there* along
 * its length. That asymmetric, partial inking is exactly what reads as a hand-painted
 * Sienkiewicz gouache rather than a CG cartoon outline (which inks every silhouette evenly).
 *
 * The pass builds ONE candidate-edge field as the UNION of two detectors, then GATES that
 * field down to ~25-40% coverage and composites the survivors by MULTIPLY toward a tinted
 * near-black ink:
 *
 *   (a) FLOW-BASED XDoG on luma (Winnemoller / Kyprianidis 2012; Kang FDoG/ETF flow).
 *       A Difference-of-Gaussians is sharpened by `tau` and soft-thresholded with
 *       `tanh(phi)`. The two DoG Gaussians are sampled ACROSS the edge (along the image
 *       gradient) and the response is then accumulated ALONG the edge TANGENT taken from
 *       PASS 2's structure tensor — this "flow" line-integral is what turns a noisy
 *       per-pixel DoG into long, coherent, calligraphic strokes instead of stipple.
 *
 *   (b) GEOMETRIC depth/normal edges. A 2nd-derivative (Laplacian-style) depth discontinuity
 *       test DIVIDED BY depth so the far road — where neighbouring depths are naturally far
 *       apart — is not over-inked; UNION a normal-crease test from the AUX A normal G-buffer
 *       (silhouettes + creases the luma DoG misses on same-value forms). Both are OPTIONAL:
 *       `tDepth`/`tNormal` start null and are wired by ThreeScene only once those targets
 *       exist (B2). The pass leans on the luma-XDoG alone until then (and on weak GPUs).
 *
 * The GATE is the heart of the look. The raw union is multiplied by:
 *     saliency  x  flow-coherence(anisotropy)  x  slow-crawling value-noise breakup  x  depthFade
 * so a contour only inks where it is locally salient, well-oriented, NOT masked out by the
 * breakup field, and near enough to matter. The breakup noise is FRAME-ANCHORED and STATIC
 * (the old `uTime` crawl was removed — drifting/swimming edges read as "eye floaters"); the
 * same physical edge therefore appears inked on one stretch and absent on the next, FIXED. A
 * hysteresis-style smoothstep band on a smoothed contrast field (`salLo..salHi`) keeps weak
 * speckle from flickering in and strong cores reliably present (the EMA/temporal smoothing of
 * that contrast field lives on the renderer side via the pre-blurred input; this pass keeps
 * only the slow-noise phase as state).
 *
 * COMPOSITE LAW (non-negotiable, from the spec): the ink is applied by MULTIPLY toward a
 * TINTED warm-black (`#20211C` cool-lit / `#1E1B22` warm-side, chosen per-pixel by local
 * temperature) — NEVER additive (that would glow, and bloom no longer exists), and NEVER pure
 * black (that kills the hue the whole palette is built to preserve). `col *= mix(1.0, ink, e)`
 * darkens toward the tinted ink by the gated edge strength `e`, so a found stroke is a deep
 * pool of warm-/cool-black, a lost stretch is untouched.
 *
 * MUSIC (`uMusic`, 0..1, smoothed by the renderer): drops WIDEN the breakup threshold so MORE
 * ink is found (more, sharper gestures) rather than strobing the strength — a +/-15% nudge at
 * most, per the spec, so the rhythm reads as the painter pressing harder, not a flicker.
 *
 * Runs in DISPLAY-SPACE LDR, late in the stack (after the LUT, before the velocity smear) so
 * the strokes sit on the final palette and then get dragged by the wet smear like real ink.
 *
 * Colour-space note: like the rest of the post-OutputPass stack, this reads and writes
 * display-space sRGB bytes and does NO in-shader pow(2.2); `uInkColorCool/Warm` are authored
 * in that same display space (raw hex / 255).
 *
 * --- Uniforms (spec PASS 7) ---
 * Auto-wired by EffectComposer:
 *   tDiffuse        input colour (the palette-locked image).
 * Wired by ThreeScene at construction / resize (start null/flag-off until their targets exist):
 *   tTensor         blurred half-res structure tensor (Jxx, Jyy, Jxy) in .rgb — gives the flow
 *                   tangent + coherence(anisotropy) for the gate. Same target PASS 4 consumes.
 *   tDepth          scene DepthTexture (B2). useDepth gates its branch on.
 *   tNormal         AUX A view-normal G-buffer (B2). useNormal gates its branch on.
 *   uResolution     drawing-buffer size in px (width*min(dpr,2), height*min(dpr,2)).
 *   texel           1 / colour target size (vec2) — XDoG tap spacing in colour-UV.
 *   tensorTexel     1 / tensor target size (vec2, half-res) — tensor upscale fetch.
 *   cameraNear/Far  for linearising tDepth (use a TIGHTENED far ~2000 per the spec so the
 *                   z-distribution doesn't break the depth edges).
 * Tunables (sensible defaults below; all live-dialable / music-drivable):
 *   uInkColorCool   tinted near-black for cool-lit forms (#20211C).
 *   uInkColorWarm   tinted near-black for warm-side forms (#1E1B22).
 *   sigma_e         base DoG sigma (px) — fine Gaussian radius.
 *   k               DoG sigma ratio (coarse = sigma_e*k); ~1.6 ≈ a Laplacian-of-Gaussian.
 *   tau             DoG sharpening (how much of the coarse blur is subtracted; ~0.95 → thin).
 *   phi             tanh soft-threshold steepness (higher = harder, inkier edge ramp).
 *   epsilon         XDoG threshold pivot (the DoG value the soft step crosses zero at).
 *   normalThresh    normal-crease cosine threshold (edge where neighbour normals diverge).
 *   depthThresh     2nd-derivative depth-edge threshold (after /depth normalisation).
 *   salLo/salHi     saliency hysteresis band on the smoothed contrast field.
 *   cohLo/cohHi     coherence (anisotropy) band — low-coherence wet zones ink LESS.
 *   noiseScale      spatial frequency of the slow breakup field (cells across the screen).
 *   uStrength       master ink amount (0 disables the pass for A/B; ~1 = full).
 *   uTime           seconds, advanced by the renderer (drives the slow ×0.05 breakup crawl).
 *   uMusic          0..1 smoothed music energy — WIDENS the breakup threshold on drops.
 */
export function createPainterlyEdgePass(opts: {
  resolution?: [number, number]
  texel?: [number, number]
  tensorTexel?: [number, number]
  cameraNear?: number
  cameraFar?: number
  inkColorCool?: number
  inkColorWarm?: number
  sigmaE?: number
  k?: number
  tau?: number
  phi?: number
  epsilon?: number
  normalThresh?: number
  depthThresh?: number
  salLo?: number
  salHi?: number
  cohLo?: number
  cohHi?: number
  noiseScale?: number
  strength?: number
  inkGain?: number
  edgeDilate?: number
  heroInkGain?: number
  heroDilate?: number
  lightDir2D?: [number, number]
} = {}): ShaderPass {
  const [rx, ry] = opts.resolution ?? [1920, 1080]
  const [tx, ty] = opts.texel ?? [1 / rx, 1 / ry]
  // Tensor target is half-res, so its texel defaults to twice the colour texel.
  const [ttx, tty] = opts.tensorTexel ?? [2 * tx, 2 * ty]

  return new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      // Flow field (structure tensor). Same RGBA16F half-res target PASS 4 reads; wired by
      // ThreeScene. Until then the flow falls back to an isotropic gradient estimate.
      tTensor: { value: null },
      // Optional geometric inputs — null + flag-off until B2 builds them.
      tDepth: { value: null },
      tNormal: { value: null },
      useDepth: { value: 0 },
      useNormal: { value: 0 },
      useTensor: { value: 0 },

      uResolution: { value: new THREE.Vector2(rx, ry) },
      texel: { value: new THREE.Vector2(tx, ty) },
      tensorTexel: { value: new THREE.Vector2(ttx, tty) },

      // Depth linearisation. far defaults TIGHT (2000) per the spec, not the scene's 10000.
      cameraNear: { value: opts.cameraNear ?? 0.1 },
      cameraFar: { value: opts.cameraFar ?? 2000.0 },

      // Tinted near-blacks (display-space sRGB). NEVER pure black.
      uInkColorCool: { value: new THREE.Color(opts.inkColorCool ?? 0x20211c) },
      uInkColorWarm: { value: new THREE.Color(opts.inkColorWarm ?? 0x1e1b22) },

      // XDoG controls.
      sigma_e: { value: opts.sigmaE ?? 1.1 },
      k: { value: opts.k ?? 1.6 },
      tau: { value: opts.tau ?? 0.97 },
      phi: { value: opts.phi ?? 4.0 },
      epsilon: { value: opts.epsilon ?? 0.0 },

      // Geometric thresholds.
      normalThresh: { value: opts.normalThresh ?? 0.30 },
      depthThresh: { value: opts.depthThresh ?? 0.45 },

      // Gate bands. The scene is a LOW-contrast luminous wash (ref 02's mid-key), so the
      // saliency band keys off the SMALL local contrasts that actually exist here — a band
      // of 0.18..0.55 (sensible for a punchy photo) gates to ~0% on this material. cohLo/Hi
      // keep low-coherence wet zones inking less, but with a generous floor so the strongest
      // road/car/sword contours still fire. noiseScale is LOWER => coarser found/lost patches
      // (longer inked stretches alternating with longer lost ones, like a brush lifting).
      salLo: { value: opts.salLo ?? 0.04 },
      salHi: { value: opts.salHi ?? 0.20 },
      cohLo: { value: opts.cohLo ?? 0.05 },
      cohHi: { value: opts.cohHi ?? 0.30 },
      noiseScale: { value: opts.noiseScale ?? 16.0 },

      uStrength: { value: opts.strength ?? 1.0 },
      // Debug visualiser: 0 = normal; 1 = show raw `candidate` edge field (white-on-black);
      // 2 = show gated `e`. Dev-only diagnostic, left at 0 in production.
      uDebug: { value: 0 },
      // Ink presence: how confidently a FOUND stroke darkens toward the tinted near-black.
      // >1 lets the gated edge `e` saturate so the survivors are a deep calligraphic pool
      // (ref 02's confident accent strokes), not a faint gray smudge. The lost-and-found
      // SPARSENESS comes from the gate (breakup), not from a weak ink — so we can ink the
      // ~30-45% that survive HARD while the rest stay fully lost.
      uInkGain: { value: opts.inkGain ?? 2.2 },
      // Edge dilation radius (px) — fattens the 1px detector scribble into a brush-width stroke.
      uEdgeDilate: { value: opts.edgeDilate ?? 2.0 },

      // --- R-FINAL P3: HERO-SILHOUETTE shadow-side ink -----------------------------------------
      // The hero kart reads "unfinished" because its silhouette is 100% lost (the round-3
      // normalThresh 0.55 / depthThresh 1.1 suppressed its busy interior, but that also killed
      // its OUTER edge). This adds ONE confident broken calligraphic stroke on the kart's outer
      // edge, biased to its SHADED side — the "finished Sienkiewicz" cue — WITHOUT reviving the
      // interior tangle, by gating the term to the HERO_LAYER coverage mask's BOUNDARY only.
      //   tHeroMask     the HERO_LAYER coverage mask (white over kart/swords) — same target the
      //                 velocity smear consumes; its 1->0 boundary IS the hero silhouette.
      //   useHeroMask   0 until ThreeScene wires the real mask (safe: term is skipped).
      //   uHeroInkGain  how hard the silhouette inks (~3.0 — a deep confident pool, sparser than
      //                 the global ink so it reads as the one found hero gesture).
      //   uHeroDilate   dilation (px) of the mask-edge detector — a brush-width hero stroke (~2.6).
      //   uLightDir2D   the key light projected to 2D screen space; the term inks where the local
      //                 luma gradient faces AWAY from it (the shadow side), so the stroke lands on
      //                 the kart's shaded edge like a painter's accent, not all the way round.
      tHeroMask: { value: null },
      useHeroMask: { value: 0 },
      uHeroInkGain: { value: opts.heroInkGain ?? 3.0 },
      uHeroDilate: { value: opts.heroDilate ?? 2.6 },
      uLightDir2D: { value: new THREE.Vector2(...(opts.lightDir2D ?? [-0.55, 0.84])) },

      uTime: { value: 0 },
      uMusic: { value: 0 }
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
      uniform sampler2D tTensor;
      uniform sampler2D tDepth;
      uniform sampler2D tNormal;
      uniform float useDepth;
      uniform float useNormal;
      uniform float useTensor;

      uniform vec2  uResolution;
      uniform vec2  texel;        // 1 / colour target size
      uniform vec2  tensorTexel;  // 1 / tensor target size (half-res)

      uniform float cameraNear;
      uniform float cameraFar;

      uniform vec3  uInkColorCool;
      uniform vec3  uInkColorWarm;

      uniform float sigma_e;
      uniform float k;
      uniform float tau;
      uniform float phi;
      uniform float epsilon;

      uniform float normalThresh;
      uniform float depthThresh;

      uniform float salLo;
      uniform float salHi;
      uniform float cohLo;
      uniform float cohHi;
      uniform float noiseScale;

      uniform float uStrength;
      uniform float uDebug;
      uniform float uInkGain;
      uniform float uEdgeDilate;
      uniform sampler2D tHeroMask;
      uniform float useHeroMask;
      uniform float uHeroInkGain;
      uniform float uHeroDilate;
      uniform vec2  uLightDir2D;
      uniform float uTime;
      uniform float uMusic;

      // ---- Compile-time constants (GLSL ES 1.00: loop bounds must be literals) -----------
      // The flow line-integral walks a fixed number of steps each side of the centre ALONG
      // the tangent; the DoG samples a fixed number of taps ACROSS the edge. Both are small
      // (spec: "cap DoG taps at 4-6", "structure tensor + flow at HALF res") for the budget.
      const int   FLOW_STEPS = 5;     // taps each side along the tangent (line-integral)
      const int   DOG_TAPS   = 3;     // taps each side across the edge (so 2*3+1 = 7 lobe)
      const float EPS        = 1e-5;

      // Rec.709 luma — matches every other pass so the edge "sees" the same value field.
      float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
      float lumaAt(vec2 uv) { return luma(texture2D(tDiffuse, uv).rgb); }

      // -- Value noise (same hash21/valueNoise idiom the pigment/paper passes use) ---------
      // Drives the STATIC breakup field that makes edges "found here / lost there". Frame-
      // anchored in screen UV with NO time term (the old uTime crawl caused drifting floaters).
      float hash21(vec2 p) {
        p = fract(p * vec2(123.34, 345.45));
        p += dot(p, p + 34.345);
        return fract(p.x * p.y);
      }
      float valueNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0); // quintic, C2 — no lattice creasing
        float a = hash21(i + vec2(0.0, 0.0));
        float b = hash21(i + vec2(1.0, 0.0));
        float c = hash21(i + vec2(0.0, 1.0));
        float d = hash21(i + vec2(1.0, 1.0));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }
      // 2-octave fbm for a slightly organic breakup mask (still cheap).
      float breakupFbm(vec2 p) {
        const mat2 ROT = mat2(0.80, -0.60, 0.60, 0.80);
        float h = valueNoise(p) * 0.65;
        p = ROT * p * 2.0;
        h += valueNoise(p) * 0.35;
        return h; // ~[0,1]
      }

      // -- Flow direction + coherence from the structure tensor ----------------------------
      // Returns the unit TANGENT (along the edge) in .xy and coherence(anisotropy) in .z.
      // When the tensor isn't wired yet (useTensor=0), fall back to a local luma-gradient
      // estimate so the flow XDoG still produces coherent-ish strokes standalone.
      vec3 flowTangentCoherence(vec2 uv) {
        float Jxx, Jyy, Jxy;
        if (useTensor > 0.5) {
          vec3 t = texture2D(tTensor, uv).rgb;   // bilinear upscale of the half-res tensor
          Jxx = t.r; Jyy = t.g; Jxy = t.b;
        } else {
          // Cheap 4-tap central-difference gradient, then its outer product = a 1-sample tensor.
          float gx = lumaAt(uv + vec2(texel.x, 0.0)) - lumaAt(uv - vec2(texel.x, 0.0));
          float gy = lumaAt(uv + vec2(0.0, texel.y)) - lumaAt(uv - vec2(0.0, texel.y));
          Jxx = gx * gx; Jyy = gy * gy; Jxy = gx * gy;
        }
        // Closed-form symmetric 2x2 eigenanalysis (identical math to PASS 4).
        float hh = 0.5 * (Jxx + Jyy);
        float dd = 0.5 * sqrt(max(0.0, (Jxx - Jyy) * (Jxx - Jyy) + 4.0 * Jxy * Jxy));
        float l1 = hh + dd;
        float l2 = hh - dd;
        float coh = (l1 + l2 > EPS) ? (l1 - l2) / (l1 + l2) : 0.0; // anisotropy in [0,1]
        // Gradient orientation; the TANGENT is perpendicular to it (rotate by 90 deg).
        float phiAng = 0.5 * atan(2.0 * Jxy, Jxx - Jyy);
        // gradient dir = (cos phi, sin phi) -> tangent = (-sin phi, cos phi).
        vec2 tang = vec2(-sin(phiAng), cos(phiAng));
        return vec3(tang, coh);
      }

      // -- Flow-based XDoG -----------------------------------------------------------------
      // For a 1D Difference-of-Gaussians ACROSS the edge (along the gradient), then a short
      // line-integral of that response ALONG the tangent (the FDoG flow accumulation) so the
      // strokes stay long and coherent. Returns the soft-thresholded edge response in [0,1]
      // (1 = strong dark stroke, 0 = no edge).
      float flowXDoG(vec2 uv, vec2 tang) {
        // Gradient (across-edge) direction is perpendicular to the tangent.
        vec2 grad = vec2(tang.y, -tang.x);
        float sigmaC = sigma_e * k; // coarse Gaussian sigma (k>1)

        // Precompute Gaussian normalisers for the two scales.
        float invS2e = 1.0 / max(EPS, 2.0 * sigma_e * sigma_e);
        float invS2c = 1.0 / max(EPS, 2.0 * sigmaC  * sigmaC);

        // Accumulate the DoG along a few tangent steps (the "flow" line integral). Each step
        // does its own across-edge DoG; averaging along the contour suppresses isolated noise
        // and reinforces genuine lines.
        float dogSum = 0.0;
        float dogW   = 0.0;
        // Tangent step length ~1px (in colour-UV). FLOW_STEPS each side.
        for (int s = -FLOW_STEPS; s <= FLOW_STEPS; s++) {
          float fs = float(s);
          // Weight tangent samples by a soft falloff so the centre dominates (still coherent).
          float tw = exp(-fs * fs * 0.08);
          vec2 base = uv + tang * (fs * texel);

          // 1D DoG across the edge at this tangent position.
          float sumE = 0.0; float wE = 0.0;
          float sumC = 0.0; float wC = 0.0;
          for (int d = -DOG_TAPS; d <= DOG_TAPS; d++) {
            float fd = float(d);
            float wfe = exp(-fd * fd * invS2e);
            float wfc = exp(-fd * fd * invS2c);
            float lv = lumaAt(base + grad * (fd * texel));
            sumE += lv * wfe; wE += wfe;
            sumC += lv * wfc; wC += wfc;
          }
          float gE = sumE / max(wE, EPS); // fine blur
          float gC = sumC / max(wC, EPS); // coarse blur
          // Sharpened DoG (XDoG form): (1+tau)*G_e - tau*G_c. >0 in the dark trough of an edge.
          float dog = (1.0 + tau) * gE - tau * gC;
          dogSum += dog * tw;
          dogW   += tw;
        }
        float dog = dogSum / max(dogW, EPS);

        // XDoG soft threshold (Winnemoller 2011). The canonical continuous form:
        //   xdog = (dog >= epsilon) ? 1 : 1 + tanh(phi * (dog - epsilon))
        // is 1 in flat regions and dips smoothly toward 0 in the dark trough of an edge
        // (where dog < epsilon, so tanh(phi*(dog-epsilon)) < 0). phi sets how hard the ramp
        // bites; epsilon is the pivot the soft step crosses zero at. EDGE strength is the
        // inverse so 1 = a firm dark stroke, 0 = no edge.
        float xdog = (dog >= epsilon) ? 1.0 : 1.0 + tanh(phi * (dog - epsilon));
        return clamp(1.0 - xdog, 0.0, 1.0);
      }

      // -- Linearise the hardware depth sample to a 0..1 normalised eye-depth ---------------
      // Standard perspective depth -> view-Z -> normalised. Uses the TIGHTENED far so the
      // z-distribution is usable for edges (the scene's real far=10000 is unusable here).
      float linearDepth(vec2 uv) {
        float zb = texture2D(tDepth, uv).r;              // [0,1] non-linear device depth
        float ndc = zb * 2.0 - 1.0;                       // -> NDC z
        float zEye = (2.0 * cameraNear * cameraFar) /
                     (cameraFar + cameraNear - ndc * (cameraFar - cameraNear));
        return clamp((zEye - cameraNear) / (cameraFar - cameraNear), 0.0, 1.0);
      }

      // -- Geometric depth edge: 2nd-derivative (Laplacian) DIVIDED BY depth ----------------
      // Dividing by depth stops the far road (where neighbouring depths are naturally far
      // apart) from over-inking. Returns an edge strength in [0,1].
      float depthEdge(vec2 uv) {
        float dc = linearDepth(uv);
        float dl = linearDepth(uv - vec2(texel.x, 0.0));
        float dr = linearDepth(uv + vec2(texel.x, 0.0));
        float dd = linearDepth(uv - vec2(0.0, texel.y));
        float du = linearDepth(uv + vec2(0.0, texel.y));
        // Discrete Laplacian: |4*c - neighbours|. Normalise by depth (+eps) so it is a
        // RELATIVE discontinuity, not an absolute one that grows with distance.
        float lap = abs(4.0 * dc - dl - dr - dd - du);
        float rel = lap / (dc + 0.02);
        return clamp((rel - depthThresh) / max(depthThresh, EPS), 0.0, 1.0);
      }

      // -- Geometric normal crease: divergence of neighbouring view-normals -----------------
      // The AUX A normal G-buffer stores view normals packed into RGB (n*0.5+0.5). A crease
      // is where the centre normal and its neighbours diverge past a cosine threshold.
      float normalEdge(vec2 uv) {
        vec3 nc = texture2D(tNormal, uv).rgb * 2.0 - 1.0;
        vec3 nl = texture2D(tNormal, uv - vec2(texel.x, 0.0)).rgb * 2.0 - 1.0;
        vec3 nr = texture2D(tNormal, uv + vec2(texel.x, 0.0)).rgb * 2.0 - 1.0;
        vec3 nd = texture2D(tNormal, uv - vec2(0.0, texel.y)).rgb * 2.0 - 1.0;
        vec3 nu = texture2D(tNormal, uv + vec2(0.0, texel.y)).rgb * 2.0 - 1.0;
        // 1 - dot measures angular divergence (0 = aligned). Take the max over neighbours so a
        // crease in ANY direction registers.
        float div = max(max(1.0 - dot(nc, nl), 1.0 - dot(nc, nr)),
                        max(1.0 - dot(nc, nd), 1.0 - dot(nc, nu)));
        return clamp((div - normalThresh) / max(1.0 - normalThresh, EPS), 0.0, 1.0);
      }

      // -- R-FINAL P3: hero-silhouette edge from the HERO_LAYER coverage mask --------------------
      // The mask is white (1) over the kart and 0 elsewhere; its BOUNDARY is the hero silhouette.
      // A small Sobel-ish gradient magnitude of the mask peaks exactly on that boundary and is ~0
      // both inside the solid kart (no interior tangle) and out in the empty field. Sampling a few
      // px out (uHeroDilate) gives a brush-width band hugging the outer edge.
      float heroMaskAt(vec2 uv) {
        return texture2D(tHeroMask, uv).r;
      }
      // Gradient of the mask (central differences at uHeroDilate spacing) → silhouette band + the
      // 2D direction pointing from the kart OUTWARD across the edge (mask decreasing).
      vec3 heroSilhouette(vec2 uv) {
        vec2 d = texel * uHeroDilate;
        float l = heroMaskAt(uv - vec2(d.x, 0.0));
        float r = heroMaskAt(uv + vec2(d.x, 0.0));
        float dn = heroMaskAt(uv - vec2(0.0, d.y));
        float up = heroMaskAt(uv + vec2(0.0, d.y));
        vec2 g = vec2(r - l, up - dn);          // points toward INCREASING mask (into the kart)
        float band = clamp(length(g), 0.0, 1.0); // peaks on the silhouette boundary
        // Outward normal of the silhouette (kart -> background) is -g.
        return vec3(band, -g);
      }

      // -- Combined candidate edge (luma XDoG ∪ near-foreground depth/normal) at one UV ------
      // Factored out so the candidate can be DILATED (a few offset samples, max-combined) into
      // a brush-WIDTH stroke. The raw XDoG/geo edges are 1px scribbles; ref 02's accent strokes
      // have real weight, so we fatten them morphologically (cheap dilation) before gating.
      float candidateAt(vec2 uv, vec2 tang) {
        float le = flowXDoG(uv, tang);
        float ge = 0.0;
        if (useDepth > 0.5)  ge = max(ge, depthEdge(uv));
        if (useNormal > 0.5) ge = max(ge, normalEdge(uv));
        if (useDepth > 0.5) {
          float ldg = linearDepth(uv);
          ge *= 1.0 - smoothstep(0.05, 0.11, ldg); // near-foreground silhouettes only
        }
        return max(le, ge);
      }

      void main() {
        vec3 src = texture2D(tDiffuse, vUv).rgb;

        // Master off-switch (also the A/B toggle) — pass through untouched.
        if (uStrength <= 0.001) {
          gl_FragColor = vec4(src, 1.0);
          return;
        }

        // --- Flow field (tangent + coherence) -------------------------------------------
        vec3 fc = flowTangentCoherence(vUv);
        vec2 tang = fc.xy;
        float coherence = fc.z;

        // --- CANDIDATE EDGE (luma XDoG ∪ near-foreground depth/normal), DILATED to brush width
        // The detectors carry the right contours (car/sword silhouettes, road value edges) but
        // as 1px scribbles. Sample the candidate at the centre + a ring of offsets along/across
        // the stroke and MAX-combine → a confident brush-WIDTH mark. The geometric branch is
        // depth-attenuated INSIDE candidateAt so the mid-distance sun plane never inks.
        float candidate = candidateAt(vUv, tang);
        // 1-ring dilation: 4 axis samples at uEdgeDilate px spacing, max-combined. This is the
        // single biggest lever turning thin scribble into a calligraphic stroke with weight.
        vec2 dpx = texel * uEdgeDilate;
        candidate = max(candidate, candidateAt(vUv + vec2(dpx.x, 0.0), tang));
        candidate = max(candidate, candidateAt(vUv - vec2(dpx.x, 0.0), tang));
        candidate = max(candidate, candidateAt(vUv + vec2(0.0, dpx.y), tang));
        candidate = max(candidate, candidateAt(vUv - vec2(0.0, dpx.y), tang));

        // --- THE GATE: saliency (lost-and-found driver) attenuated by coherence + depthFade --
        // Restructured from the old four-way PRODUCT (which multiplied four sub-1 terms into a
        // near-zero gate on this low-contrast wash => ~0% inked). The new shape:
        //   - SALIENCY decides "is this a strong enough contour to consider", on a band tuned
        //     to the SMALL contrasts this luminous mid-key scene actually has, and it counts
        //     the GEOMETRIC candidate too (car/sword silhouettes are same-value forms where
        //     luma contrast ~0 but depth/normal edges are strong — those must read as salient).
        //   - BREAKUP is the lost-and-found ENGINE — a slow-crawling field that keeps the ink
        //     on ~30-45% of the salient length and drops it on the rest, the SAME edge found
        //     here / lost there.
        //   - COHERENCE + DEPTHFADE are gentle ATTENUATORS with a high floor (not hard gates),
        //     so the strongest contours still ink even in lowish-coherence/mid-depth regions.

        // 1) SALIENCY. Local luma contrast (max-min over a + of taps) OR the geometric edge —
        //    whichever says "there is a real form boundary here". Banded so faint wash speckle
        //    stays lost and firm contours read as fully salient.
        float lc = lumaAt(vUv);
        float lmin = lc, lmax = lc;
        float ln1 = lumaAt(vUv + vec2(texel.x, 0.0));
        float ln2 = lumaAt(vUv - vec2(texel.x, 0.0));
        float ln3 = lumaAt(vUv + vec2(0.0, texel.y));
        float ln4 = lumaAt(vUv - vec2(0.0, texel.y));
        lmin = min(lmin, min(min(ln1, ln2), min(ln3, ln4)));
        lmax = max(lmax, max(max(ln1, ln2), max(ln3, ln4)));
        float contrast = lmax - lmin;
        float lumaSal = smoothstep(salLo, salHi, contrast);
        // The dilated candidate IS the "is there a real contour here" signal (it already unions
        // the luma XDoG and the near-foreground silhouettes). A strong candidate is salient even
        // where local luma contrast is tiny (same-value car/sword forms). Threshold it softly so
        // faint speckle still needs the luma-contrast band to qualify.
        float saliency = max(lumaSal, smoothstep(0.15, 0.45, candidate));

        // 2) FLOW COHERENCE (anisotropy) as a soft ATTENUATOR (floor 0.45, not 0). Low-coherence
        //    wet zones ink a little LESS; high-coherence true contours ink full.
        float cohGate = mix(0.45, 1.0, smoothstep(cohLo, cohHi, coherence));

        // 3) STATIC BREAKUP NOISE — the lost-and-found engine. A FRAME-ANCHORED fbm sampled in
        //    screen UV. FLOATER FIX: the old uTime crawl made masked edge segments drift, swim,
        //    and strobe frame-to-frame (the eye-floaters complaint). The time term is REMOVED
        //    so the found/lost pattern is FIXED in the frame — the SAME edge is inked where the
        //    field is high and lost where it is low, but that boundary never moves.
        //    Threshold ~0.42 calm so a healthy MINORITY (~35-45%) of the salient length survives.
        vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
        vec2 np = vUv * aspect * noiseScale;
        float n = breakupFbm(np);
        // Music WIDENS the threshold window so MORE ink survives on drops (never a strength
        // strobe). Lower threshold => more of the field passes => more found ink.
        float breakThresh = mix(0.42, 0.30, clamp(uMusic, 0.0, 1.0)); // calm -> drop
        // Soft step so the found/lost boundary is feathered (a brush lifting), not a hard cut.
        float breakup = smoothstep(breakThresh - 0.14, breakThresh + 0.14, n);

        // 4) DEPTH FADE — soft ATTENUATOR toward the far distance (sky excluded), floor 0.35 so
        //    mid-distance road still inks. Near = full, sky (ld -> 1) = fully out.
        float depthFade = 1.0;
        if (useDepth > 0.5) {
          float ld = linearDepth(vUv);
          depthFade = mix(1.0, 0.35, smoothstep(0.20, 0.80, ld));
          // Hard-exclude the true background (sky / far plane) entirely.
          depthFade *= 1.0 - smoothstep(0.90, 0.985, ld);
        }

        // Combine. Saliency AND breakup are the load-bearing lost-and-found pair; coherence and
        // depthFade only attenuate. This knocks the candidates down to a sparse, confident set.
        float gate = saliency * breakup * cohGate * depthFade;
        float e = clamp(candidate * gate * uStrength * uInkGain, 0.0, 1.0);

        // --- R-FINAL P3: HERO-SILHOUETTE shadow-side found stroke ------------------------------
        // Add ONE confident calligraphic accent on the kart's OUTER edge, biased to its SHADED
        // side, gated to the mask boundary so the interior stays lost. This is the single "found"
        // hero gesture that makes the kart read finished (its silhouette was 100% lost before).
        if (useHeroMask > 0.5) {
          vec3 sil = heroSilhouette(vUv);            // .x = boundary band, .yz = outward normal
          float band = sil.x;
          vec2 outN = sil.yz;
          // SHADOW-SIDE bias: the stroke lands where the silhouette's outward normal faces AWAY
          // from the key light (dot < 0 → shaded side). clamp(0.5 - dot,0,1) peaks there and
          // fades on the lit side, so the kart inks heavily on its shadow edge and lightly (or
          // not at all) on the lit edge — a painter's accent, never an even outline.
          float shadowSide = clamp(0.5 - dot(normalize(outN + 1e-5), normalize(uLightDir2D)), 0.0, 1.0);
          // Reuse the same slow breakup field so even the hero stroke is FOUND-here/LOST-there
          // (a broken brush line), not a continuous toon outline. A higher floor (0.45) keeps the
          // hero stroke more present than the global ink (it is THE focal gesture) while still
          // breaking. Multiply by the band so it only lives on the silhouette.
          float heroBreak = mix(0.45, 1.0, breakup);
          float heroE = clamp(band * shadowSide * heroBreak * uStrength * uHeroInkGain, 0.0, 1.0);
          // Union with the global edge — the hero stroke is additive presence, taking the stronger
          // of the two so a found global edge on the kart isn't weakened.
          e = max(e, heroE);
        }

        // --- DEV DIAGNOSTIC: visualise the edge fields as white-on-black ------------------
        if (uDebug > 0.5) {
          float v = (uDebug < 1.5) ? candidate : e;
          gl_FragColor = vec4(vec3(v), 1.0);
          return;
        }

        // --- COMPOSITE: MULTIPLY toward a TINTED warm-black (never additive, never black) --
        // Pick cool vs warm ink by the pixel's local temperature (R vs B): warm-lit forms get
        // the warm near-black, cool-lit forms the cool one. The ink is ~#20/#1E gray, so even a
        // full stroke (e=1) lands the pixel on a deep tinted near-black that KEEPS its hue —
        // it never reaches 0,0,0.
        float warmth = clamp((src.r - src.b) * 2.0 + 0.5, 0.0, 1.0);
        vec3 ink = mix(uInkColorCool, uInkColorWarm, warmth);
        // MULTIPLY toward the ink by the gated edge strength.
        vec3 col = src * mix(vec3(1.0), ink, e);

        gl_FragColor = vec4(col, 1.0);
      }
    `
  })
}
