import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'

/**
 * AnisotropicKuwaharaPass — PASS 4, the KEYSTONE of the "Watercolour Speed" pipeline.
 *
 * This is the single "it's a gouache painting" pass. It flattens the tone-mapped,
 * display-space image into broad, directional gouache strokes that BEND ALONG CONTOURS
 * (Kyprianidis 2009/2010, "Anisotropic Kuwahara Filtering with Polynomial Weighting
 * Functions"). Each output pixel is the mean of whichever of 8 angular sectors of an
 * edge-aligned ellipse has the lowest colour variance — but combined SMOOTHLY
 * (variance-weighted, `1/(1+std^q)`), never by hard argmin, because argmin flickers
 * frame-to-frame on video.
 *
 * Per pixel:
 *   1. Read the (half-res, linear-upscaled) structure tensor (Jxx, Jyy, Jxy) for this
 *      pixel and do a closed-form 2x2 symmetric eigenanalysis to recover the local
 *      anisotropy `A` and the gradient angle `phi`.
 *   2. Build an ellipse whose LONG axis lies along the edge TANGENT (perpendicular to
 *      the gradient) so strokes elongate along contours; eccentricity scales with `A`
 *      and is clamped so strong edges can't collapse the kernel to a 1px aliasing sliver.
 *   3. Walk a fixed compile-time square neighbourhood, reject samples outside the ellipse
 *      at runtime (GLSL ES 1.00 has no dynamic loop bounds), weight each in-ellipse sample
 *      by a radial Gaussian × its 8 smooth polynomial sector weights, and accumulate
 *      per-sector colour sums + squared-colour sums.
 *   4. Per sector compute mean + std (from E[x^2] - E[x]^2); combine all 8 means weighted
 *      by `1/(1+std^q)` — high-variance (busy) sectors are softly suppressed so the
 *      output settles into the flat, low-variance region: a gouache stroke.
 *
 * Reads the PRE-BLURRED colour (PASS 1) as `tDiffuse` and the BLURRED tensor field
 * (PASS 3, half-res RGBA16F) as `tTensor`. The tensor packs the spec contract
 * `vec4(Jxx, Jyy, Jxy, 1.0)` so we read `.r=Jxx, .g=Jyy, .b=Jxy`. `tensorTexel` is the
 * tensor target's texel size (typically the colour texel × 2 because the tensor is
 * half-res); bilinear sampling of the half-res float tensor upscales the low-frequency
 * orientation field for free.
 *
 * Runs FULL-RES in display space (after OutputPass) — the variance/eigenanalysis are
 * perceptual operations that misbehave on linear HDR. Cost is O(radius^2 * 8 sectors);
 * this is the biggest lever in the pipeline and the one we refuse to cut for the look.
 *
 * Uniforms (set `tDiffuse` auto-wired by EffectComposer; `tTensor`/texels wired by
 * ThreeScene at construction/resize):
 *   tDiffuse          — pre-blurred display-space colour (auto-wired)
 *   tTensor           — blurred half-res structure tensor (Jxx, Jyy, Jxy) in .rgb
 *   texel             — 1/drawingBufferSize of the colour target (vec2)
 *   tensorTexel       — 1/size of the (half-res) tensor target (vec2)
 *   radius            — kernel radius in colour pixels (default 6; <= 7, the loop cap)
 *   sharpness         — `q`: variance combine exponent (default 12; ease DOWN on drops
 *                       for a looser, wetter look)
 *   eccentricityClamp — `ecc` in the ellipse term `(ecc + A)/ecc` (default 0.6); also the
 *                       basis of the kept eccentricity, hard-clamped to MAX_ECC (~6).
 */
export function createAnisotropicKuwaharaPass(opts: {
  radius?: number
  sharpness?: number
  eccentricityClamp?: number
  texel?: [number, number]
  tensorTexel?: [number, number]
} = {}): ShaderPass {
  return new ShaderPass({
    uniforms: {
      // Pre-blurred colour — wired automatically by EffectComposer.
      tDiffuse: { value: null },
      // Blurred half-res structure tensor (Jxx, Jyy, Jxy); wired by ThreeScene.
      tTensor: { value: null },
      // Texel sizes in drawing-buffer pixels; set in constructor + resize() by ThreeScene.
      texel: { value: opts.texel ?? [1 / 1920, 1 / 1080] },
      tensorTexel: { value: opts.tensorTexel ?? [2 / 1920, 2 / 1080] },
      // Painterly controls (spec PASS 4 defaults).
      radius: { value: opts.radius ?? 6.0 },
      sharpness: { value: opts.sharpness ?? 12.0 },
      eccentricityClamp: { value: opts.eccentricityClamp ?? 0.6 }
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
      uniform vec2 texel;        // 1 / colour target size
      uniform vec2 tensorTexel;  // 1 / tensor target size (half-res)
      uniform float radius;      // kernel radius in colour pixels (<= LOOP_R)
      uniform float sharpness;   // q
      uniform float eccentricityClamp; // ecc

      // ---- Compile-time constants (GLSL ES 1.00: loop bounds must be literals) -------
      // The square neighbourhood scanned each frame is fixed at [-7, 7]; samples that
      // fall outside the (smaller, runtime-sized) ellipse are rejected with continue.
      const int   LOOP_R    = 7;       // matches the radius=6 default with margin
      const int   N_SECTORS = 8;       // 8 angular sectors of the ellipse
      const float MAX_ECC   = 6.0;     // clamp so strong edges keep a >1px minor axis
      const float PI        = 3.14159265358979;
      const float TWO_PI    = 6.28318530717959;
      const float EPS       = 1e-4;

      void main() {
        // ---- 1. Structure-tensor eigenanalysis (spec PASS 4 math, verbatim) ----------
        // Bilinear fetch of the half-res float tensor upscales the orientation field.
        vec3 t = texture2D(tTensor, vUv).rgb;
        float Jxx = t.r;
        float Jyy = t.g;
        float Jxy = t.b;

        float h = 0.5 * (Jxx + Jyy);
        float d = 0.5 * sqrt(max(0.0, (Jxx - Jyy) * (Jxx - Jyy) + 4.0 * Jxy * Jxy));
        float l1 = h + d;           // larger eigenvalue (across the edge)
        float l2 = h - d;           // smaller eigenvalue (along the edge)
        // Anisotropy in [0,1]: 0 = isotropic (flat region), ->1 = strong oriented edge.
        float A = (l1 + l2 > EPS) ? (l1 - l2) / (l1 + l2) : 0.0;
        // Gradient orientation. Ellipse must align its LONG axis to the TANGENT, i.e.
        // perpendicular to the gradient, so strokes run ALONG contours.
        float phi = 0.5 * atan(2.0 * Jxy, Jxx - Jyy);

        // ---- 2. Edge-aligned ellipse -------------------------------------------------
        // ea grows with anisotropy; (ecc + A)/ecc gives ea>=1, clamped to MAX_ECC so a
        // razor edge can't shrink the minor axis to a 1px aliasing kernel.
        float ecc = max(eccentricityClamp, EPS);
        float ea = clamp((ecc + A) / ecc, 1.0, MAX_ECC);
        // Long axis along the tangent (radius*ea), short axis across it (radius/ea).
        vec2 axis = vec2(radius * ea, radius / ea);

        // Rotate so the ellipse minor axis is along the gradient and the major axis is
        // along the tangent. We sample in pixel space and map each offset into this
        // ellipse-aligned frame to (a) reject outside the unit disc and (b) get its angle
        // for the sector weights. cphi/sphi rotate pixel offsets INTO kernel space.
        float cphi = cos(phi);
        float sphi = sin(phi);
        // Inverse-scaled rotation rows: maps a pixel offset (in px) to normalised ellipse
        // coordinates. Major axis aligned with the tangent direction (-sin, cos).
        // u = ( cphi*x + sphi*y) / axis.y   (across edge, short)
        // v = (-sphi*x + cphi*y) / axis.x   (along edge,  long)
        // (axis.y on the across component, axis.x on the along component, so the disc
        //  becomes the intended elongated-along-tangent ellipse in pixel space.)

        // ---- 3/4. Per-sector accumulation, then smooth variance-weighted combine -----
        // mean[k] = sum(w*c)/sum(w);  std from sum(w*c*c)/sum(w) - mean^2.
        vec3  mSum[N_SECTORS];   // weighted colour sum per sector
        vec3  sSum[N_SECTORS];   // weighted squared-colour sum per sector
        float wSum[N_SECTORS];   // weight sum per sector
        for (int k = 0; k < N_SECTORS; k++) {
          mSum[k] = vec3(0.0);
          sSum[k] = vec3(0.0);
          wSum[k] = 0.0;
        }

        // Radial Gaussian: 2-sigma reaches the kernel rim (smooth, no hard edge ring).
        float invSigma2 = 1.0 / max(EPS, 0.25 * radius * radius);
        // Sector half-width control for the smooth polynomial weights. Each sample's
        // angle is folded into 8 overlapping cosine^2 lobes spaced TWO_PI/8 apart so a
        // sample near a boundary contributes (smoothly) to both neighbouring sectors —
        // this is the convolution-free polynomial weighting that removes the seams a hard
        // sector assignment would leave.
        float sectorSharp = 8.0; // exponent on the cosine lobe; higher = tighter sectors

        for (int jy = -LOOP_R; jy <= LOOP_R; jy++) {
          for (int jx = -LOOP_R; jx <= LOOP_R; jx++) {
            vec2 off = vec2(float(jx), float(jy)); // pixel-space offset

            // Map into normalised ellipse coordinates (kernel space).
            float ex = ( cphi * off.x + sphi * off.y) / axis.y; // across-edge component
            float ey = (-sphi * off.x + cphi * off.y) / axis.x; // along-edge  component
            float r2 = ex * ex + ey * ey;
            // Runtime elliptical reject: skip anything outside the unit ellipse. This is
            // what makes the fixed [-7,7] loop behave like the runtime 'radius'.
            if (r2 > 1.0) continue;

            // Sample the pre-blurred colour at this neighbour.
            vec2 sampUv = vUv + off * texel;
            vec3 c = texture2D(tDiffuse, sampUv).rgb;

            // Radial Gaussian falloff (in pixel space) — peak at centre, ~0 at the rim.
            float pr2 = dot(off, off);
            float wr = exp(-pr2 * invSigma2);

            // Angle of this sample within the ellipse frame, for the sector lobes.
            float ang = atan(ey, ex); // [-PI, PI]

            // Distribute into the 8 sectors via smooth overlapping cosine^2 lobes.
            // sectorAngle(k) = -PI + k*TWO_PI/8 . The fixed inner loop keeps GLSL ES happy.
            for (int k = 0; k < N_SECTORS; k++) {
              float sectorAngle = -PI + float(k) * (TWO_PI / float(N_SECTORS));
              // Smallest signed angular distance to this sector centre.
              float da = ang - sectorAngle;
              da = mod(da + PI, TWO_PI) - PI; // wrap to [-PI, PI]
              // Cosine lobe, raised to a power for tighter sectors; clamped >= 0.
              float lobe = max(0.0, cos(da));
              float ws = pow(lobe, sectorSharp);
              float w = wr * ws;

              mSum[k] += w * c;
              sSum[k] += w * c * c;
              wSum[k] += w;
            }
          }
        }

        // Combine the 8 sector means weighted by 1/(1+std^q) — SMOOTH, never argmin.
        vec3  colSum = vec3(0.0);
        float alphaSum = 0.0;
        for (int k = 0; k < N_SECTORS; k++) {
          float wk = max(wSum[k], EPS);
          vec3 mean = mSum[k] / wk;
          // Variance per channel = E[x^2] - E[x]^2 (clamped against tiny negatives).
          vec3 var = max(vec3(0.0), sSum[k] / wk - mean * mean);
          // Scalar std as the luma-ish magnitude of the per-channel std.
          float std = sqrt(var.r + var.g + var.b);
          // Low variance -> alpha ~1 (favoured); high variance -> alpha ~0 (suppressed).
          float alpha = 1.0 / (1.0 + pow(std, sharpness));
          colSum += alpha * mean;
          alphaSum += alpha;
        }

        vec3 result = colSum / max(alphaSum, EPS);
        gl_FragColor = vec4(result, 1.0);
      }
    `
  })
}
