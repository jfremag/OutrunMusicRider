import * as THREE from 'three'

/**
 * CarSheenMaterial — the hero car's "helmet-shine" paint (STYLE_SPEC §4, "Watercolour Speed").
 *
 * The car must read as a muted violet-gray *gouache* form, not chrome. So instead of a tight
 * CG specular glint we inject, via `onBeforeCompile`, ONE broad, soft, rolling specular lobe and
 * add it to `totalEmissiveRadiance` **after** the BRDF lighting accumulation (NOT through the
 * BRDF — that re-introduces a hard mirror highlight). The lobe is a wide half-Lambert wrap around
 * a fixed view-space light direction, so it bleeds softly past the terminator like wet paint and
 * "rolls" across the body as the car banks.
 *
 * The critical Sienkiewicz move is encoded entirely in-shader: as the lobe term `s` rises the
 * sheen colour HUE-LERPS toward ~232deg (steel-blue), its SATURATION is multiplied by `(1-0.6*s)`,
 * and its VALUE is hard-CAPPED at ~0.90 — a warm/saturated shadow violet ramps to a cool,
 * desaturated highlight (`#D7D7E6`) that **never reaches white**. Darks lerp toward a deep
 * violet-blue (`#2C2A38`), never black, so hue+saturation stay alive into the core shadow. Faint
 * reflected scene catch-lights (a cool `#B8C2D8` sliver + a warm `#C59076` hint) are added at low
 * intensity — a hint of a reflected world, not a chrome mirror. A slow low-frequency value-noise
 * mottles the lobe so it reads as a hand-laid wash rather than a clean CG gradient. The only true
 * near-white on the whole car is a razor spark (`#F6F7F9`) gated to the top ~2% of `(spec×fresnel)`
 * on high-curvature silhouettes — the single hard "found" edge inside an otherwise "lost" form.
 *
 * Per-frame the lobe `uSheenStrength` is driven so the shine **breathes/rolls on the beat** as a
 * saturation/value pulse of the *existing* hue — never a new colour, never a bloom flash
 * (`updateCarSheen`). The injector uses a shared `customProgramCacheKey` so every submesh of the
 * GLB compiles to a single program.
 *
 * Usage from ThreeScene (wiring lives there; this module is self-contained and unit-shadable):
 *   const mat = obj.material as THREE.MeshStandardMaterial
 *   mat.color.set(0x9f939e); mat.metalness = 0; mat.roughness = 0.85; mat.envMapIntensity = 0
 *   const entry = injectCarSheen(mat)            // returns a CarSheenMaterial registry entry
 *   carSheenMaterials.push(entry)                // store the registry for the per-frame update
 *   // each frame:
 *   updateCarSheen(entry, { beatStrength, spectralCentroid, dt })
 */

// ---------------------------------------------------------------------------------------------
// Palette constants (pixel-measured §2 stops). sRGB hex; converted to linear at upload time so
// the lobe maths happen in the same space the standard shader accumulates lighting in.
// ---------------------------------------------------------------------------------------------

/** #D7D7E6 — Sheen Peak: cool blue-violet, ~7% sat, value ~0.90. The lobe's base tint + HARD CAP. */
const SHEEN_COLOR_HEX = 0xd7d7e6
/** #2C2A38 — Deep Body Near-Black: darkest the car may reach (hue-preserving violet-blue, never black). */
const DEEP_BODY_HEX = 0x2c2a38
/** #B8C2D8 — cool reflected scene catch-light (low sat sliver, not a mirror). */
const CATCH_COOL_HEX = 0xb8c2d8
/** #C59076 — warm reflected scene catch-light (sienna flesh hint). */
const CATCH_WARM_HEX = 0xc59076
/** #F6F7F9 — razor near-white spark, top ~2% of (spec*fresnel) on high-curvature silhouettes only. */
const SPARK_HEX = 0xf6f7f9

/** Helper: convert an sRGB hex to a linear-space THREE.Color (renderer accumulates in linear). */
function linearColor(hex: number): THREE.Color {
  return new THREE.Color(hex).convertSRGBToLinear()
}

// ---------------------------------------------------------------------------------------------
// Per-frame drivers + registry types
// ---------------------------------------------------------------------------------------------

/**
 * The music/animation drivers `updateCarSheen` consumes each frame. All optional except `dt` so
 * a caller can pulse just the beat. Values are the controller's normalized 0..1 signals.
 */
export interface CarSheenDrivers {
  /** 0..1 beat envelope — the primary "breath" of the shine. */
  beatStrength?: number
  /** 0..1 perceived brightness — a slow swell of the lobe with the music's spectral lift. */
  spectralCentroid?: number
  /**
   * Optional new view-space light direction (e.g. biased by car banking so the lobe rolls across
   * the body as the car leans). Copied into `uSheenDir` and normalized. If omitted the dir holds.
   */
  sheenDir?: THREE.Vector3
  /** Frame delta in seconds — advances the lobe's low-frequency mottle noise (a slow boil). */
  dt: number
}

/**
 * A registry entry returned by `injectCarSheen`, stored by ThreeScene (repurposing the old
 * `carEmissiveMaterials` slot as `carSheenMaterials`). Holds the patched material, a direct handle
 * to the shader uniforms object (populated once `onBeforeCompile` runs), and the renderer-side
 * smoothing/time state so the per-frame update has no per-call allocation and eases rather than
 * snapping (matching the codebase's lerp-driven motion aesthetic).
 */
export interface CarSheenMaterial {
  /** The patched MeshStandardMaterial (still takes the soft key + shadow through the BRDF). */
  readonly material: THREE.MeshStandardMaterial
  /**
   * The live uniforms object. `null` until the program first compiles (after the material is added
   * to the scene and rendered once); `updateCarSheen` guards on this. Shared across submeshes via
   * the common `customProgramCacheKey`, but each material instance still owns its own uniform set.
   */
  uniforms: { [key: string]: THREE.IUniform } | null
  /** Smoothed lobe strength so the shine eases toward its musical target rather than snapping. */
  smoothedStrength: number
  /** Accumulated seconds, fed to `uTime` to crawl the mottle noise slowly (no per-frame boiling). */
  time: number
}

// ---------------------------------------------------------------------------------------------
// Default lobe parameters (STYLE_SPEC §4). Deliberately a BROAD lobe (width ~6, never 32-128).
// ---------------------------------------------------------------------------------------------

const DEFAULTS = {
  /** View-space light direction the lobe wraps around (up-and-slightly-toward-camera). */
  dir: new THREE.Vector3(0.35, 0.8, 0.45).normalize(),
  /** LOW exponent -> a broad rolling lobe (NOT a tight CG glint). */
  width: 6.0,
  /** Base lobe intensity; driven up on the beat by `updateCarSheen`. */
  strength: 0.6,
  /** Half-Lambert wrap so the lobe bleeds softly past the terminator like wet paint. */
  wrap: 0.5
}

/**
 * Injects the broad helmet-shine lobe into a MeshStandardMaterial via `onBeforeCompile`.
 *
 * The caller is responsible for first forcing the material matte (the spec's
 * `metalness 0, roughness ~0.85, envMapIntensity 0, color #9F939E lerped to gray`) — this injector
 * only adds the unlit sheen on top. It returns a {@link CarSheenMaterial} registry entry to store
 * for the per-frame {@link updateCarSheen} call.
 *
 * @param material the (already-matte) hero car material to patch.
 * @param opts optional overrides for the lobe direction/shape/strength.
 */
export function injectCarSheen(
  material: THREE.MeshStandardMaterial,
  opts: {
    sheenDir?: THREE.Vector3
    sheenColor?: number
    sheenWidth?: number
    sheenStrength?: number
    sheenWrap?: number
  } = {}
): CarSheenMaterial {
  // The uniforms we own. Captured in the closure so we can hand the live object back to the
  // registry once `onBeforeCompile` splices them into the compiled shader's uniform set.
  const sheenUniforms: { [key: string]: THREE.IUniform } = {
    uSheenDir: { value: (opts.sheenDir ? opts.sheenDir.clone().normalize() : DEFAULTS.dir.clone()) },
    uSheenColor: { value: linearColor(opts.sheenColor ?? SHEEN_COLOR_HEX) },
    uSheenWidth: { value: opts.sheenWidth ?? DEFAULTS.width },
    uSheenStrength: { value: opts.sheenStrength ?? DEFAULTS.strength },
    uSheenWrap: { value: opts.sheenWrap ?? DEFAULTS.wrap },
    uDeepBody: { value: linearColor(DEEP_BODY_HEX) },
    uCatchCool: { value: linearColor(CATCH_COOL_HEX) },
    uCatchWarm: { value: linearColor(CATCH_WARM_HEX) },
    uSparkColor: { value: linearColor(SPARK_HEX) },
    uTime: { value: 0 }
  }

  const entry: CarSheenMaterial = {
    material,
    uniforms: null,
    smoothedStrength: sheenUniforms.uSheenStrength.value as number,
    time: 0
  }

  // Preserve any pre-existing onBeforeCompile (defensive — the spec applies this to GLB materials
  // that may already be patched). We chain rather than clobber.
  const prevOnBeforeCompile = material.onBeforeCompile

  material.onBeforeCompile = (shader, renderer) => {
    if (prevOnBeforeCompile) prevOnBeforeCompile(shader, renderer)

    // Splice our uniforms into the compiled program's uniform set, then expose the SAME live
    // objects on the registry so per-frame writes reach the GPU. (Assigning the value objects
    // keeps a single source of truth shared between `shader.uniforms` and `sheenUniforms`.)
    for (const key in sheenUniforms) {
      shader.uniforms[key] = sheenUniforms[key]
    }
    entry.uniforms = sheenUniforms

    // Declare our uniforms + helpers at the top of the fragment program.
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      /* glsl */ `
      uniform vec3  uSheenDir;     // view-space light direction the broad lobe wraps around
      uniform vec3  uSheenColor;   // #D7D7E6 cool sheen peak (also the hard value cap tint)
      uniform float uSheenWidth;   // LOW exponent -> broad rolling lobe (NOT a CG glint)
      uniform float uSheenStrength;// driven up on the beat (the shine "breathes")
      uniform float uSheenWrap;    // half-Lambert wrap (lobe bleeds past the terminator)
      uniform vec3  uDeepBody;     // #2C2A38 darks lerp toward this, never black
      uniform vec3  uCatchCool;    // #B8C2D8 cool reflected catch-light (low sat sliver)
      uniform vec3  uCatchWarm;    // #C59076 warm reflected catch-light (sienna hint)
      uniform vec3  uSparkColor;   // #F6F7F9 razor near-white spark (top ~2% only)
      uniform float uTime;         // crawls the low-freq mottle noise (a slow boil)

      // --- tiny RGB<->HSV (so we can desaturate/cool the lobe AS it brightens) ---
      vec3 sheenRgb2hsv(vec3 c) {
        vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
        vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
        vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
        float d = q.x - min(q.w, q.y);
        float e = 1.0e-10;
        return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
      }
      vec3 sheenHsv2rgb(vec3 c) {
        vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
        vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
        return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
      }

      // Cheap value-noise (hashed lattice + smooth interp) for the low-freq desaturating mottle.
      float sheenHash(vec2 p) {
        p = fract(p * vec2(123.34, 345.45));
        p += dot(p, p + 34.345);
        return fract(p.x * p.y);
      }
      float sheenNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        float a = sheenHash(i + vec2(0.0, 0.0));
        float b = sheenHash(i + vec2(1.0, 0.0));
        float c = sheenHash(i + vec2(0.0, 1.0));
        float d = sheenHash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }

      void main() {`
    )

    // Inject the lobe AFTER lighting accumulation (post-BRDF) but while `totalEmissiveRadiance`
    // is still folded into `outgoingLight`. `#include <aomap_fragment>` is the last chunk before
    // the diffuse/specular sums, and at this point the view-space `normal` and `vViewPosition`
    // (= -mvPosition.xyz, i.e. surface->camera) are both valid.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <aomap_fragment>',
      /* glsl */ `#include <aomap_fragment>

      {
        // View-space frame. 'normal' is the (possibly normal-mapped) surface normal; vViewPosition
        // points from the surface toward the camera, so its normalization is the view direction.
        vec3 sN = normalize(normal);
        vec3 sV = normalize(vViewPosition);
        vec3 sL = normalize(uSheenDir);

        // ONE broad soft lobe. Half-Lambert WRAP first (lobe bleeds softly past the terminator
        // like wet paint), then a LOW-exponent specular-ish falloff around the half-vector so it
        // is a wide rolling band, never a tight glint. This is deliberately NOT a BRDF term.
        float ndl = dot(sN, sL);
        float wrapped = clamp((ndl + uSheenWrap) / (1.0 + uSheenWrap), 0.0, 1.0); // half-Lambert
        vec3  sH = normalize(sL + sV);
        float ndh = clamp(dot(sN, sH), 0.0, 1.0);
        float lobe = pow(ndh, uSheenWidth) * wrapped;                              // broad band

        // Fresnel for the grazing catch-lights + the razor spark gate (silhouette emphasis).
        float fres = pow(1.0 - clamp(dot(sN, sV), 0.0, 1.0), 3.0);

        // Low-frequency desaturating mottle: a slow value-noise wash across the lobe (~+-0.05 in
        // value) so the sheen is a hand-laid wash, not a clean CG gradient. Sampled in screen
        // space and crawled by uTime (slow -> no boiling).
        float mottle = sheenNoise(gl_FragCoord.xy * 0.012 + uTime * 0.05) - 0.5; // ~[-0.5, 0.5]

        // The spec term s: how lit this fragment's sheen is, 0..~1. Strength scales the lobe;
        // mottle nudges it; clamp keeps the ramp in range. Darken s slightly in the mottle's
        // troughs so the wash both lightens AND desaturates unevenly.
        float s = clamp(lobe * uSheenStrength + mottle * 0.10, 0.0, 1.0);

        // SIENKIEWICZ MOVE: as s rises, hue-lerp toward ~232deg (steel-blue), multiply saturation
        // by (1 - 0.6*s), and HARD-CAP value at ~0.90 -> the lobe cools+desaturates as it
        // brightens and NEVER reaches white.
        vec3  baseHsv = sheenRgb2hsv(uSheenColor);
        float targetHue = 232.0 / 360.0;                         // steel-blue target hue
        float hue = mix(baseHsv.x, targetHue, s);                // cool toward 232deg as it lifts
        float sat = baseHsv.y * (1.0 - 0.6 * s);                 // desaturate as it brightens
        float val = min(baseHsv.z, 0.90) * (0.55 + 0.45 * s);   // cap ~0.90, lift with s
        val += mottle * 0.05;                                    // +-0.05 value variance (mottle)
        val = clamp(val, 0.0, 0.90);                             // HARD value cap (never white)
        vec3 sheenCol = sheenHsv2rgb(vec3(hue, clamp(sat, 0.0, 1.0), val));

        // Faint reflected scene catch-lights — scene COLOUR at low saturation, not a mirror:
        // a cool sliver on the grazing edge + a warm hint biased to the lit side. Tiny weights.
        float litSide = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
        vec3  catchLights =
            uCatchCool * (fres * 0.08) +                         // cool grazing reflection sliver
            uCatchWarm * (litSide * lobe * 0.05);                // warm hint on the lit lobe

        // The broad sheen contribution, added as UNLIT paint to the emissive radiance (post-BRDF).
        vec3 sheenContribution = sheenCol * (lobe * uSheenStrength) + catchLights;

        // DARKS: where the form is in shadow and unlit by the lobe, lerp the *output* toward the
        // deep violet-blue body floor (#2C2A38) instead of letting the BRDF crush it to black —
        // hue+sat preserved into the core shadow. We pull totalEmissiveRadiance toward the floor
        // in proportion to how dark+un-sheened this fragment is (the BRDF result is summed after).
        float shade = (1.0 - litSide) * (1.0 - lobe);            // 1 in un-lit, un-sheened cores
        totalEmissiveRadiance = mix(totalEmissiveRadiance, uDeepBody, shade * 0.18);

        // Add the broad lobe + catch-lights as unlit paint.
        totalEmissiveRadiance += sheenContribution;

        // RAZOR SPARKS: the ONLY near-white on the car. Gate to the top ~2% of (spec*fresnel) on
        // high-curvature silhouettes. Use the *un-attenuated* specular peak (ndh, not the broad
        // width-shaped lobe) so the gate can actually reach the razor [0.985,1.0] window where
        // surface/light/grazing all align — keeping sparks rare (<2%) but possible. additive #F6F7F9.
        float sparkTerm = ndh * fres;                            // spec peak * fresnel, 0..1
        float spark = smoothstep(0.985, 1.0, sparkTerm);         // top ~2% only
        totalEmissiveRadiance += uSparkColor * spark * 0.9;
      }`
    )
  }

  // Share ONE compiled program across every submesh of the car (the spec's explicit requirement)
  // — without this each material instance would trigger its own shader compile.
  material.customProgramCacheKey = () => 'carSheen'

  // Force a recompile if the material was already used before injection.
  material.needsUpdate = true

  return entry
}

// ---------------------------------------------------------------------------------------------
// Per-frame update
// ---------------------------------------------------------------------------------------------

/** Lower bound the lobe never drops below — the shine is always faintly present (a wet body). */
const SHEEN_BASE = 0.45
/** Upper clamp on the driven lobe strength (kept below a bloom-flash level). */
const SHEEN_MAX = 1.3
/** Smoothing factor — fast attack, soft settle (matches the codebase's lerp feel). */
const SHEEN_EASE = 0.3

/**
 * Per-frame driver for the helmet-shine lobe. Drives `uSheenStrength` so the shine
 * **breathes/rolls on the beat** — a saturation/value pulse of the existing hue, never a new
 * colour and never a bloom flash:
 *
 *   target ≈ 0.45 + beatStrength*0.5 + spectralCentroid*0.25   (clamped ≤ ~1.3)
 *
 * eased toward by ~0.3. Also crawls the mottle noise via `uTime` and, if supplied, rolls the lobe
 * direction (`uSheenDir`). No-ops safely until the program has compiled (`entry.uniforms` set).
 *
 * @param entry the registry entry from {@link injectCarSheen}.
 * @param drivers the current music/animation drivers (see {@link CarSheenDrivers}).
 */
export function updateCarSheen(entry: CarSheenMaterial, drivers: CarSheenDrivers): void {
  // Advance time even before the shader compiles so the mottle is already crawling on first frame.
  entry.time += Math.max(0, drivers.dt)

  const u = entry.uniforms
  if (!u) return

  const beat = THREE.MathUtils.clamp(drivers.beatStrength ?? 0, 0, 1)
  const centroid = THREE.MathUtils.clamp(drivers.spectralCentroid ?? 0, 0, 1)

  // The breathing target (saturation/value pulse of the existing hue, never a colour/bloom flash).
  const target = THREE.MathUtils.clamp(
    SHEEN_BASE + beat * 0.5 + centroid * 0.25,
    0,
    SHEEN_MAX
  )
  // Ease toward it (fast attack, soft settle).
  entry.smoothedStrength += (target - entry.smoothedStrength) * SHEEN_EASE

  ;(u.uSheenStrength as THREE.IUniform).value = entry.smoothedStrength
  ;(u.uTime as THREE.IUniform).value = entry.time

  // Optionally roll the lobe direction (e.g. biased by car banking) so the shine sweeps the body.
  if (drivers.sheenDir) {
    const dir = (u.uSheenDir as THREE.IUniform).value as THREE.Vector3
    dir.copy(drivers.sheenDir).normalize()
  }
}
