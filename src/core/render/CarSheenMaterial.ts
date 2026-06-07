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
  /**
   * View-space light direction the broad lobe wraps around. P5: re-aimed from the old sky-biased
   * normalize(0.30,0.62,0.95) (which caught the up-facing wheel TOPS — four neutral caps, cool
   * fraction ~6%) toward a CAMERA-FACING normalize(0.35,0.30,1.0): a small lateral bias, a modest
   * UP, and a DOMINANT +Z so the broad "helmet shine" sweeps the VIEWER-FACING body/cowl — the
   * way the chrome rider's sheen turns toward us in ref 02. Now that P5 adds a continuous rounded
   * cowl hull over the open frame, the lobe rolls across ONE broad form facing the camera instead
   * of scattering over the wheel blobs.
   */
  dir: new THREE.Vector3(0.35, 0.30, 1.0).normalize(),
  /** LOW exponent -> a broad rolling lobe (NOT a tight CG glint). */
  width: 6.0,
  /** Base lobe intensity; driven up on the beat by `updateCarSheen`. A confident resting sheen so
   *  the broad cool roll on the rounded forms is the hero read that out-glows the dark frame core. */
  strength: 1.05,
  /** Generous half-Lambert wrap so the broad lobe bleeds well past the terminator like wet paint. */
  wrap: 0.75
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

    // Inject the lobe AFTER the BRDF lighting is fully composed into `outgoingLight`, i.e. right
    // before `#include <opaque_fragment>` (which writes gl_FragColor). Operating on the final
    // `outgoingLight` (not just `totalEmissiveRadiance`, which is only ADDED) lets the broad sheen
    // OVERPAINT the body like wet paint and lets the value cap actually hold — adding to emissive
    // could only ever lift the dark body, never own it. The view-space `normal` and `vViewPosition`
    // (= surface->camera) are function-scope locals still valid here.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      /* glsl */ `
      {
        // View-space frame. 'normal' is the (possibly normal-mapped) surface normal; vViewPosition
        // points from the surface toward the camera, so its normalization is the view direction.
        vec3 sN = normalize(normal);
        vec3 sV = normalize(vViewPosition);
        vec3 sL = normalize(uSheenDir);

        // ONE broad soft ROLLING lobe — the chrome-rider "helmet shine" of ref 02. The brightest
        // pass of the band must cover a BROAD swathe of the form (the upper/facing shoulder), not
        // a tight CG glint, so it is built primarily from a WRAPPED hemisphere gradient and only
        // gently shaped by a wide specular core. Half-Lambert WRAP of N·L gives a soft, very broad
        // light-facing gradient that bleeds past the terminator like wet paint; a LOW-exponent
        // half-vector term adds the rolling brightest core on top. Neither is a BRDF term.
        float ndl = dot(sN, sL);
        float wrapped = clamp((ndl + uSheenWrap) / (1.0 + uSheenWrap), 0.0, 1.0); // half-Lambert
        vec3  sH = normalize(sL + sV);
        float ndh = clamp(dot(sN, sH), 0.0, 1.0);
        // The broad core: a WIDE specular band (low exponent) AND a strong broad floor from the
        // wrapped gradient itself, so the lobe is a big soft swathe over the form. The wrapped^1.3
        // shaping keeps it reading as a single directional roll rather than flat fill, while the
        // specular core (smoothed against the wrap so it can only live on the lit side) supplies
        // the brightest crest. Combine so the band is broad (not pow(ndh,6) alone — that was too
        // tight + double-attenuated the contribution below).
        float broadCore = pow(ndh, uSheenWidth);                                   // wide spec crest
        // P5: a BROAD luminous rolling band — now that the lobe sweeps one continuous camera-facing
        // cowl (not scattered wheel caps) we want the WRAPPED hemisphere gradient to OWN a large
        // soft swathe of the form (the bright cool sheen covers ~40-50% of the chrome reference),
        // with the specular core adding the brightest crest on top. Squaring the wrap concentrates
        // it toward the light-facing crown (a clear directional roll, dark flanks) while the higher
        // floor + crest keep the band confidently bright. Still low-exponent/wrapped — never a glint.
        float band = wrapped * wrapped;                                            // broad soft swathe
        float lobe = clamp(band * (0.55 + 1.05 * broadCore) + band * 0.25, 0.0, 1.0);

        // Fresnel for the grazing catch-lights + the razor spark gate (silhouette emphasis).
        float fres = pow(1.0 - clamp(dot(sN, sV), 0.0, 1.0), 3.0);

        // Low-frequency desaturating mottle: a slow value-noise wash across the lobe (~+-0.05 in
        // value) so the sheen is a hand-laid wash, not a clean CG gradient. Sampled in screen
        // space and crawled by uTime (slow -> no boiling).
        float mottle = sheenNoise(gl_FragCoord.xy * 0.012 + uTime * 0.05) - 0.5; // ~[-0.5, 0.5]

        // COVERAGE: how strongly the broad sheen owns this fragment, 0..1. Strength widens AND
        // deepens the band (a louder beat = a bigger, brighter roll), mottle breaks its edge so it
        // is a hand-laid wash. This single term drives BOTH the colour ramp and how much the body
        // is overpainted, so the lobe is applied ONCE (the old code multiplied lobe*strength into
        // the colour AND again into the contribution, double-attenuating the shine into nothing).
        float cov = clamp(lobe * uSheenStrength + mottle * 0.10, 0.0, 1.0);
        // The brightness ramp s lifts faster than coverage so even the broad mid-band of the lobe
        // reads as a luminous cool sheen (a gentle ramp left the whole band dim/dark-gray).
        float s = clamp(pow(cov, 0.6), 0.0, 1.0);

        // SIENKIEWICZ MOVE: as s rises, hue-lerp toward ~232deg (steel-blue), multiply saturation
        // by (1 - 0.6*s), and HARD-CAP value at ~0.90 -> the lobe cools+desaturates as it
        // brightens and NEVER reaches white.
        vec3  baseHsv = sheenRgb2hsv(uSheenColor);
        float targetHue = 232.0 / 360.0;                         // steel-blue target hue
        float hue = mix(baseHsv.x, targetHue, s);                // cool toward 232deg as it lifts
        // P5: BOOST the base saturation toward the steel-blue accent as the band brightens (instead
        // of desaturating it to ~0) so the bright crest reads as a clearly COOL blue-violet sheen,
        // NOT a desaturated near-white blob (the ref-chrome peaks are blue, never white). A small
        // desaturate factor keeps it from going chalky, but the floor is well above zero.
        float sat = clamp(baseHsv.y * (1.0 + 1.6 * s), 0.06, 0.20);
        // P5: a luminous broad band, but cap the crest a touch BELOW the 0.90 ceiling so the peak
        // reads as a bright cool sheen rather than tipping into white; flanks fall to the dark body
        // via low coverage below. (ref chrome's brightest sheen sits ~0.82-0.85, not paper-white.)
        // A LOWER floor (0.50) with a steeper rise so the bright crest concentrates on the light-
        // facing crown (a clear directional ROLL) and side/down-facing flanks (e.g. the wheels)
        // stay darker and read as part of the body, not four competing bright blocks.
        float val = min(baseHsv.z, 0.85) * (0.50 + 0.42 * s);   // luminous cool crest, darker flanks
        val += mottle * 0.05;                                    // +-0.05 value variance (mottle)
        val = clamp(val, 0.0, 0.90);                             // HARD value cap (never white)
        vec3 sheenCol = sheenHsv2rgb(vec3(hue, clamp(sat, 0.0, 1.0), val));

        // Faint reflected scene catch-lights — scene COLOUR at low saturation, not a mirror:
        // a cool sliver on the grazing edge + a warm hint biased to the lit side. P5: gate the warm
        // hint to the DIMMER flanks (×(1-s)) so it never washes the bright cool crown toward a warm
        // white hotspot — the crest stays a pure cool sheen — and trim both weights so they read as
        // slivers, not a central bloom that breaks the value cap.
        float litSide = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
        vec3  catchLights =
            uCatchCool * (fres * 0.06) +                         // cool grazing reflection sliver
            uCatchWarm * (litSide * lobe * (1.0 - s) * 0.035);   // warm hint on the dim lit flanks only

        // BODY BASE: settle the un-sheened body to a CONFIDENT, READABLE violet-gray a notch above
        // the deep body (#2C2A38 ×1.55). P5: CLAMP the lit base DOWN to this violet (min) as well as
        // up (max) so the strong warm directional KEY cannot punch a bright warm hotspot through the
        // body where the sheen coverage dips (the old code only raised a floor with max(), so a hot
        // Lambert highlight on the cowl crown bled through a mottle dip as a warm-white blob). Now
        // the body is a flat violet base and the COOL SHEEN is the only thing that brightens it — so
        // the crown reads as one clean cool rolling band, the interior stays lost, and hue+sat live
        // into the shadow. Contours read mostly LOST (spec §4); the sheen crest is the found mark.
        vec3 bodyBase = uDeepBody * 1.55;
        outgoingLight = mix(outgoingLight, bodyBase, 0.82);

        // OVERPAINT the body with the broad cool sheen where coverage is high — like wet paint laid
        // over the form — so the lobe DOMINATES the upper/facing surface as the hero feature rather
        // than glazing faintly over an already-dark body. LERP the (now flat-violet) base toward the
        // (value-capped) sheen colour by coverage; the cap guarantees the sheen never reaches white.
        outgoingLight = mix(outgoingLight, sheenCol, cov);
        outgoingLight += catchLights;

        // HERO CATCH-LIGHT (P45-APEX): ONE small, crisp, off-centre near-white glint — the single
        // luminous focal accent on the canopy, the hero's bright apex. The previous gate keyed on
        // (ndh*fres): fresnel ~0 except at extreme grazing, so on this convex canopy read from a
        // chase angle the product never reached [0.985,1.0] and the spark NEVER FIRED — leaving the
        // canopy a soft cream PUDDLE with no glint (the critique's nit). This re-gate keys on a
        // TIGHT high-exponent specular hotspot about an OFF-CENTRE half-vector that reliably lands
        // on the canopy crest, so the spark actually reads as one crisp catch-light. It is gated to
        // sit WHERE the broad sheen already lives (cov) so it is the bright peak OF the sheen, not a
        // stray dot, and kept to the top ~1-2% by the smoothstep window. Additive paper-white
        // (#F6F7F9). It is added AFTER the sheen's 0.90 value cap, so this tiny spot is the one place
        // on the car allowed past the cap into the near-paper-white apex — surgical, no bloom.
        // The catch-light is gated to the TOP SLIVER OF THE SHEEN ITSELF (the lobe-coverage crest),
        // exactly per spec ("the top ~1-2% of the sheen"). This is the robust read: the broad lobe
        // coverage (cov) is guaranteed to peak on the camera-facing canopy crown, so smoothstep'ing
        // its very top reliably lands ONE bright spot ON the canopy at every chase angle — the prior
        // tight half-vector specular (pow of N dot H) depended on an exact normal alignment the dome
        // never quite hit from the chase camera, so it produced only a soft cream puddle and never a
        // glint (the critique's nit). A mild off-centre half-vector specular only SHAPES it (tightens
        // the spot + nudges it off the dead-centre of the crown) so it reads as a crisp off-centre
        // glint rather than a centred ring.
        vec3  sparkH = normalize(sL + sV + vec3(0.12, 0.07, 0.0)); // off-centre half-vector (shaping)
        // A TIGHT off-centre specular (exponent 80) is the PRIMARY shape of the glint: it falls to ~0
        // within a few degrees of one orientation, so it concentrates the spark into ONE small spot on
        // the canopy crown (and, having a single preferred normal, it does NOT also light the wheel-pod
        // tops, whose normals differ) rather than washing the whole dome. The cov crest is only a
        // PRESENCE gate (the spot must sit on the lit sheen, never on a shadow flank).
        float sparkShape = pow(clamp(dot(sN, sparkH), 0.0, 1.0), 80.0);
        float sparkCrest = smoothstep(0.86, 0.99, cov);          // narrow: only the very lobe peak
        float spark = clamp(sparkShape * sparkCrest, 0.0, 1.0);  // tight spot ∩ lit crest -> one glint
        outgoingLight += uSparkColor * spark * 1.35;             // additive; pushes the spot to ~paper-white
      }
      #include <opaque_fragment>`
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

/** Lower bound the lobe never drops below — the shine is always confidently present (R3: the broad
 *  cool roll is the HERO read on the rounded forms, so it rests luminous, not faint). */
const SHEEN_BASE = 0.95
/** Upper clamp on the driven lobe strength (kept below a bloom-flash level; the value cap in-shader
 *  still guarantees the crest never reaches white however hard this is driven). */
const SHEEN_MAX = 1.6
/** Smoothing factor — fast attack, soft settle (matches the codebase's lerp feel). */
const SHEEN_EASE = 0.3

/**
 * Per-frame driver for the helmet-shine lobe. Drives `uSheenStrength` so the shine
 * **breathes/rolls on the beat** — a saturation/value pulse of the existing hue, never a new
 * colour and never a bloom flash:
 *
 *   target ≈ 0.95 + beatStrength*0.5 + spectralCentroid*0.25   (clamped ≤ ~1.6)
 *
 * The high resting floor (R3) keeps the broad cool roll a confident HERO feature; the beat adds a
 * subtle swell on top (the in-shader value cap means even the peak never reaches white). Eased
 * toward by ~0.3. Also crawls the mottle noise via `uTime` and, if supplied, rolls the lobe
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
