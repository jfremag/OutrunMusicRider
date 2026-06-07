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
  /** Base lobe intensity; driven a touch up on the beat by `updateCarSheen`. A QUIET resting glaze
   *  — the subtle cool roll sits just above the dark body, never a bright crest (the value cap +
   *  the in-shader coverage scale keep it a whisper). */
  strength: 0.7,
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
        // A BROAD, smooth COOL roll across the UPPER body — the subtle sheen of the chrome rider
        // (ref 02), NOT a bright filled bowl. The band is ANCHORED to the surface's UP-FACING-ness
        // (view-space normal .y) so the whole top of the cowl catches a soft cool film and the
        // side/down flanks (incl. the wheels) stay dark; the half-Lambert wrap biases that roll
        // toward the light side so it is a directional sheen, not a flat cap. A wide specular core
        // only adds a gentle crest. None is a BRDF/mirror term. This replaces the old wrapped^2 band
        // that landed blotchy from the chase angle and the cov→1 fill that dumped a cream puddle.
        float upFace = smoothstep(-0.35, 0.9, sN.y);                               // top + upper flanks of the cowl (broadened so more of the visible body catches the rolling sheen)
        float band = clamp(upFace * (0.55 + 0.55 * wrapped), 0.0, 1.0);            // broad upper roll
        float lobe = clamp(band * (0.70 + 0.40 * broadCore), 0.0, 1.0);

        // Fresnel for the faint grazing cool sliver (silhouette breath only — NO spark).
        float fres = pow(1.0 - clamp(dot(sN, sV), 0.0, 1.0), 3.0);

        // Low-frequency mottle: a value-noise wash so the sheen reads as a hand-laid wash, not a CG
        // gradient. STATIC (frame-anchored to gl_FragCoord — no per-frame boil). VERY low amplitude
        // so it never carves the concentric "tree-ring" bowl the old strong lobe produced.
        float mottle = sheenNoise(gl_FragCoord.xy * 0.012) - 0.5; // ~[-0.5, 0.5], static

        // COVERAGE: how strongly the cool sheen owns this fragment, 0..1. A BROAD luminous roll
        // (TESLA hero): the lobe×strength reaches a confident coverage so the upper body catches a
        // clearly-lighter-than-body cool film that survives the Kuwahara/LUT flatten and reads as a
        // DIMENSIONAL light-catching chrome form — not the dark glaze the over-corrected build made.
        // mottle only feathers it. Capped < 0.75 so the sheen is a strong roll over the form, never a
        // flat fill that erases the modelling.
        float cov = clamp(lobe * uSheenStrength * 0.82 + mottle * 0.03, 0.0, 0.80);
        // A gentle ramp — a smooth luminous cool roll with a brighter crest toward full coverage.
        float s = clamp(pow(cov, 0.80), 0.0, 1.0);

        // SIENKIEWICZ MOVE: a COOL blue-violet -> luminous chrome glaze. Hue leans toward ~232deg
        // (steel-blue), saturation stays modest (chrome is near-neutral), VALUE now reaches a
        // LUMINOUS high (~0.90) on the crest so the hero CATCHES LIGHT (ref 02's polished metal),
        // while the broad mid-band sits at a clearly-lighter-than-body cool value.
        vec3  baseHsv = sheenRgb2hsv(uSheenColor);
        float targetHue = 232.0 / 360.0;                         // steel-blue target hue
        float hue = mix(baseHsv.x, targetHue, 0.6 + 0.4 * s);    // firmly cool blue-violet
        float sat = clamp(baseHsv.y * (1.0 - 0.5 * s), 0.03, 0.18); // desaturate toward the crest (chrome)
        // A luminous cool film: floor ~0.58 (was 0.50) so the broad mid-band reads as a clearly
        // bright rolling sheen that survives the Kuwahara/LUT flatten; the crest climbs toward 0.92
        // so the rolling highlight CATCHES light like polished chrome (the dimensional hero read).
        float val = mix(0.58, 0.92, s);                          // luminous cool roll, bright crest
        val += mottle * 0.03;                                    // small value variance (mottle)
        val = clamp(val, 0.0, 0.92);                             // cap just below white
        vec3 sheenCol = sheenHsv2rgb(vec3(hue, clamp(sat, 0.0, 1.0), val));

        // Reflected catch-lights: a cool grazing sliver on the silhouette PLUS a faint warm sienna
        // hint on the lit shoulder — a hint of a reflected world (ref 02's chrome catches both the
        // cool sky and a warm ground bounce), not a flat matte. ralph(iter6): the cool fresnel sliver
        // is lifted 0.10 -> 0.18 so the rounded camera-facing cowl EDGES catch more reflected bright
        // sky — the strongest cheap "polished chrome" cue (a dimensional metal form reflecting its
        // environment), turning the dark-blob silhouette into a light-catching hero edge. The warm
        // ground-bounce hint is also nudged up a hair (0.05 -> 0.07) for the reflected-world read.
        vec3  catchLights = uCatchCool * (fres * 0.18) + uCatchWarm * (broadCore * wrapped * 0.07);

        // BODY: KEEP the BRDF-lit 3D FORM (light side / shadow side) so the car reads as a
        // DIMENSIONAL body, and LIFT its base value so it is a luminous dusky chrome — NOT the flat
        // near-black blob it had become. TESLA-HERO LIFT: a brighter dusky base (×7.2 → ×8.6) and a
        // higher floor (×0.62 → ×0.78) seat the WHOLE form well above the palette-LUT black point so
        // even the shadow side reads as a LIT, light-catching metal flank — the hero is dimensional
        // and luminous from every angle, never a dark silhouette.
        vec3 dusky = uDeepBody * 8.6;                      // luminous dusky blue-violet (brighter body)
        outgoingLight = mix(outgoingLight, dusky, 0.34);   // keep ~66% of the lit FORM shading
        outgoingLight = max(outgoingLight, dusky * 0.78);  // floor — a clearly LIT flank, never dark

        // GLAZE the luminous cool sheen over the upper body where coverage is high — a confident wash
        // that lifts the form toward a light-catching chrome read while the BRDF modelling stays
        // visible underneath. The bright crest is the rolling highlight; the dark flanks stay dusky.
        outgoingLight = mix(outgoingLight, sheenCol, cov);
        outgoingLight += catchLights;

        // HERO SPARK (restored, disciplined): a small razor near-white catch on the top ~3% of the
        // (broad-core × fresnel) — the single hard "found" highlight on a high-curvature silhouette
        // that sells polished metal. Gated tight so it is a sparkle on an edge, never a filled puddle.
        float sparkGate = smoothstep(0.85, 1.0, broadCore * (0.4 + 0.6 * fres)) * s;
        outgoingLight = mix(outgoingLight, uSparkColor, clamp(sparkGate * 0.6, 0.0, 0.6));
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

/** Lower bound the lobe never drops below. The sheen is a SUBTLE broad cool glaze (not a hero
 *  crest), so it rests quiet; the in-shader coverage scale + low value cap keep it a whisper. */
const SHEEN_BASE = 0.85
/** Upper clamp on the driven lobe strength. The in-shader coverage/value caps still bound the
 *  crest below white, so the beat adds a confident swell of the rolling highlight (the hero
 *  catching more light on emphasis), never a flat blowout. */
const SHEEN_MAX = 1.3
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
  // FLOATER FIX: the mottle noise is now STATIC (frame-anchored, no uTime), so `entry.time` is
  // no longer advanced and uTime is left inert — the sheen breathes via uSheenStrength only (a
  // value pulse), never a crawling texture. The dt driver is unused here now.
  void drivers.dt

  const u = entry.uniforms
  if (!u) return

  const beat = THREE.MathUtils.clamp(drivers.beatStrength ?? 0, 0, 1)
  const centroid = THREE.MathUtils.clamp(drivers.spectralCentroid ?? 0, 0, 1)

  // The breathing target (a small value pulse of the existing cool hue, never a colour/bloom flash).
  // Modest beat/centroid contributions so the subtle sheen only swells a touch on the beat.
  const target = THREE.MathUtils.clamp(
    SHEEN_BASE + beat * 0.22 + centroid * 0.12,
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
