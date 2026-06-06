# STYLE SPEC — "Watercolour Speed" (Wet Chrome Outrun)

> The definitive build contract. A swarm of engineers implements against this to turn the
> Three.js synthwave racer into a **moving Bill Sienkiewicz / Kent Williams gouache painting**.
> Reference anchor: `docs/redesign/moodboard/02-quality-target-sienkiewicz.png`. The block-in
> `03-*` is layout/hue-role guidance ONLY — ignore its striped sun, flat vector look, high-key
> brightness and even saturation.
>
> **Winning direction:** *Watercolour Speed — "Wet Chrome Outrun" (moving-Sienkiewicz NPR recipe)*.
> Stance: MAXIMUM painterly fidelity to ref 02, even at higher GPU cost. The whole synthwave
> post-stack is ripped out and replaced by a structure-tensor-steered **Anisotropic Kuwahara**
> filter (the single "it's a gouache painting" pass) wrapped by a watercolour pigment/granulation
> model, a luminance gradient-map LUT that **locks the palette by construction**, flow-based
> lost-and-found dark-accent edges, a velocity-driven asymmetric watercolour smear, and a final
> cold-press SubstratePaperPass.

---

## 1. THE LOOK IN ONE PARAGRAPH

A music-driven racer rendered as a **moving gouache painting on cold-press watercolour paper**:
a field of **tinted grays at ~10–14% median saturation** where colour is a scarce resource spent
only on a few small accents (a dusty-rose hot note, a steel-blue cool counterweight, one signal-red
obstacle). Forms are flattened into **directional gouache strokes that bend along contours**
(anisotropic Kuwahara), broken by **cold-press granulation** (pigment settling into paper valleys),
punctuated by **sparse calligraphic dark-accent edges** that are *found here and lost there*, and
dragged by a **wet, asymmetric directional speed-smear** of the value field — never speed-lines.
The hero car is a muted violet-gray body carrying **one broad soft rolling "helmet shine"** that
shifts cooler and desaturates as it brightens and **never reaches white**, held razor-sharp as the
single crisp focal anchor inside a smeared world. The whole picture sits on a frame-anchored paper
sheet. Music is expressed *through the medium* (longer wet smear, a breath of sheen, a touch more
accent chroma, sharper found gestures) — **never** through brightness or bloom flashes. Every
synthwave cliché (striped sun, neon grid, magenta/cyan/purple sky, chromatic aberration, heavy
bloom, vector flatness) is satisfied by **deletion, not suppression**.

---

## 2. LOCKED PALETTE

All hex are pixel-measured from ref 02, not eyeballed. These are the literal driver values for
uniforms and the gradient-map LUT stops. **The grays are TINTED toward the rose/steel axis — never
neutral RGB-equal gray. Nothing exceeds ~45% saturation except the obstacle red.**

| # | Name | Hex | Role |
|---|------|-----|------|
| 1 | Paper Putty / Highlight cap | `#D9D6CE` | Lightest value; gouache highlight & paper showing through; the "white" substitute. Helmet-shine core tints here. NEVER pure white except <2% razor sparks. |
| 2 | Warm Cream Sheet | `#EDE7D8` | Cold-press substrate tint soft-lit into highlights by the paper pass; the warm off-white the image sits on. |
| 3 | Steel-Violet Field (sky upper) | `#A7A3B1` | DOMINANT neutral / largest area. Tinted gray, hue ~259 S~8%. Sky upper band + base of cool negative space. LUT upper-mid stop. |
| 4 | Lit Steel-Blue Band (sky/reflection) | `#B8BBCE` | Cool sky band lower / cool reflected light on metal, hue ~232 S~11%. Cool side of the warm-light/cool-shadow axis. |
| 5 | Rose-Gray Field (ground) | `#CEB9B9` | Warm desaturated ground/horizon glaze, hue ~1 S~10%. Granulating wash; warm counterweight to steel sky. |
| 6 | Warm Sienna / Sand Road Bridge | `#C9B49E` | Road surface — the desaturated "sand" bridge. STRUCTURALLY REQUIRED: stops the rose/steel pair reading as a cold pink-blue cliché. Hue ~29. |
| 7 | Body Violet-Gray (car lit) | `#9F939E` | Hero car albedo on lit faces — near-neutral mauve-gray. The car is a GRAY WITH A HUE, never saturated paint. |
| 8 | Body Shadow Violet (car) | `#706675` | Shadow side of the car — desaturated violet, warmest/most-saturated part of the form (Sienkiewicz inversion). Floor for body shading. |
| 9 | Deep Body Near-Black (hue-preserving) | `#2C2A38` | Darkest the car may reach — deep violet-blue, NOT black; keeps hue+sat alive in the core shadow. |
| 10 | Sheen Peak (cool desaturated) | `#D7D7E6` | The broad rolling specular "helmet shine" — cool blue-violet, ~7% sat, value ~0.90. HARD CAP; desaturates AND cools as it brightens; never white. |
| 11 | Steel-Blue Accent (counterweight) | `#6A7AA4` | COOL ACCENT, hue ~223 S~35%. The one granulating steel-blue patch / cool rim / sky depth. Cool half of the split-complementary. |
| 12 | Rose-Magenta Accent (primary hot) | `#A96276` | PRIMARY HOT ACCENT (largest hot cluster in ref), hue ~343 S~42%. Dusty-rose "lips" note, focal rose, beat-pulse chroma. NOT neon magenta. |
| 13 | Warm Sienna Flesh Accent | `#C59076` | WARM BRIDGE accent, hue ~19 S~40%. Lit warm reflection / warm catch-light on the car. Keeps the scheme off the cold cliché. |
| 14 | Petrol-Teal Shadow Whisper | `#48677D` | Cool shadow whisper / road-edge in shade, hue ~204 S~42%. Used SPARINGLY in darks. Lane edges are this in shadow, never a neon line. |
| 15 | Signal Red (obstacle) | `#D6443B` | The single saturated high-chroma hit. Sword/obstacle. Always edged with a dark accent stroke. The ONLY thing past ~45% S. |
| 16 | Cool Tinted Near-Black (ink/drip) | `#20211C` | Found-edge dark accents, drips, spatter on cool-lit forms. Dark punctuation for edge MULTIPLY. NEVER pure black. |
| 17 | Warm Tinted Near-Black (shadow ink) | `#1E1B22` | Warm-side found-edge accents and deepest shadow pools / negative-space floor. Deep end of the granulated dark gradient. |

**Governing law:** scene-wide median saturation ~10–14%; only ~8–10% of pixels past ~30% S; only
the obstacle-red / car-sheen edge / key rose past ~40% S. Value mid-key (median ~65%) with **rare
punched darks** (`#1E1B22`, V<22%) the block-in lacks. Pair temperatures locally (cool sky beside
warm ground, bridged by sienna road).

---

## 3. RENDER + POST PIPELINE (exact order)

Everything after `OutputPass` runs in **display-space LDR** — mandatory: Kuwahara variance, the
gradient-map luminance lookup, granulation gating and edge thresholds are perceptual operations
that misbehave on linear HDR. Targets/uniforms with a resolution dependency must be updated in
`resize()`. Pass the **drawing-buffer** resolution (`width * min(dpr,2)`) into every `resolution`/
`texel` uniform.

```
[RENDER]  RenderPass (primary) ── colour target WITH DepthTexture attached
[AUX A]   Normal G-buffer  (scene.overrideMaterial = MeshNormalMaterial -> half-float RGBA RT)
[TONE]    OutputPass (ACES tone-map + sRGB)              <-- LDR boundary; all below is display-space
─────────────────────────────────────────────────────────────────────────────────────────────
PASS 1    PreBlurPass            (tiny 3x3/5x5 gaussian)            ~0.1 ms
PASS 2    StructureTensorPass    (HALF-RES, RGBA16F, Sobel->Jxx,Jyy,Jxy)   ~0.2 ms
PASS 3    TensorBlurPass         (separable gaussian sigma~2.5, 2x1D on tensor)  ~0.2 ms
PASS 4    AnisotropicKuwaharaPass (FULL-RES, 8-sector polynomial)   ~1.0–1.6 ms  ← KEYSTONE
PASS 5    WatercolourPigmentPass (wobble + edge-darken + granulate + bleed)  ~0.4 ms
PASS 6    PaintGradeLUTPass      (256x1 gradient-map + TPDF deband)  ~0.1 ms   ← PALETTE LOCK
PASS 7    PainterlyEdgePass      (flow-XDoG ∪ depth/normal edges, gated, MULTIPLY)  ~0.6 ms
PASS 8    VelocitySmearPass      (depth+prev-VP velocity, asymmetric wet drag, car masked sharp)  ~0.5 ms
PASS 9    SubstratePaperPass     (FINAL: granulation + tooth-light + micro-distort, Pegtop soft-light)  ~0.3 ms
```

> **Pass-order is load-bearing.** Kuwahara/gradient-map/granulation MUST be after OutputPass.
> Granulation is subtract+desaturate; the paper sheet is Pegtop SOFT-LIGHT (multiply-only goes
> muddy, additive can't, overlay clips). SubstratePaperPass MUST be the very last pass — grain or
> vignette after it would sit above the sheet and break the "printed on paper" illusion.

### [RENDER] Primary RenderPass + DepthTexture
Flat-lit, matte, mid-key scene into an HDR colour target that **also carries a DepthTexture**.
EffectComposer does not expose a usable scene depth texture by default — explicitly attach
`renderTarget1.depthTexture = new THREE.DepthTexture(w, h)` (or render a dedicated depth pre-pass).
**Tighten the depth far to ~2000** on a dedicated read or log-remap in-shader; the scene camera's
`near=0.1 / far=10000` (ThreeScene.ts:349-354) gives a terrible z-distribution that breaks both the
geometric edges and the velocity reconstruction. Scene fog stays but is **retinted to the
steel-violet field colour** so the far road dissolves into paper, not into black.

### [AUX A] Normal G-buffer
`scene.overrideMaterial = MeshNormalMaterial` → render into a **half-float RGBA target,
NearestFilter** → restore override. Feeds the geometric (silhouette/crease) half of PASS 7. This is
the cheapest aux (the hero geometry is small). Skippable on weak GPUs — PASS 7 can lean on the
luma-XDoG alone.

### PASS 1 — PreBlurPass
Tiny gaussian (3x3/5x5) or downsample+up. Kills render aliasing/specular sparkle so the structure
tensor is stable. **Replaces SMAA's job** — we WANT a soft input; AA-after-paper would smooth the
very tooth we add. Cheap, large quality win.
`uniforms: tDiffuse, texel`.

### PASS 2 — StructureTensorPass (HALF-RES, RGBA16F)
Sobel on luma → `gl_FragColor = vec4(dot(gx,gx), dot(gy,gy), dot(gx,gy), 1.0)` = (Jxx,Jyy,Jxy).
**MUST be a float target** (RGBA16F, LinearFilter) — these are squared gradients >1; 8-bit bands
the stroke directions. Half-res because orientation is low-frequency (quarters the heaviest math).
`uniforms: tDiffuse, texel`.

### PASS 3 — TensorBlurPass (separable, two 1D passes)
Separable gaussian, sigma ~2.5 px, on the tensor target. **THE step** that turns a noisy orientation
field into coherent brush strokes. **Blur the TENSOR, never the angle** (angles wrap at ±π/2 and
corrupt; the tensor averages correctly). Mandatory, not optional.
`uniforms: tDiffuse(=tensor), direction(vec2), texel`.

### PASS 4 — AnisotropicKuwaharaPass (FULL-RES) — KEYSTONE
Reads the pre-blurred colour + the blurred half-res tensor (linear-upscaled via a separate
`tensorTexel`). Per pixel: eigenanalysis → ellipse aligned to the edge **tangent** (long axis along
contours), 8 polynomial sectors (Kyprianidis 2010, convolution-free), variance-weighted combine
with sharpness `q`. Smooth combine `alpha_k = 1/(1+pow(std,q))` — **never argmin** (argmin flickers
on video).
- **Eigenanalysis:** `h=0.5(Jxx+Jyy); d=0.5*sqrt((Jxx-Jyy)^2+4Jxy^2); l1=h+d; l2=h-d; A=(l1-l2)/(l1+l2); phi=0.5*atan(2Jxy,Jxx-Jyy)`.
- **Ellipse:** `ea=(eccentricityClamp+A)/eccentricityClamp; axis=vec2(radius*ea, radius/ea)`; clamp `ea` to a max (~6) so strong edges don't make 1px-thin aliasing kernels.
- **GLSL ES 1.00 safe:** fixed compile-time loop bounds `for(int j=-7;j<=7;j++)` + runtime elliptical-reject `continue` (never `j<=int(radius)`).
- **Start:** `radius=6, q=12, eccentricityClamp=0.6`. `q` eases DOWN on drops (looser, wetter).
- **Uniforms:** `tDiffuse, tTensor, texel, tensorTexel, radius, sharpness(q), eccentricityClamp`.
- **Cost is O(radius² × 8 sectors).** This is the single biggest lever and the one we **refuse to
  cut for the look** — profile FIRST; on weak GPUs drop radius to 4–5 and tensor to quarter-res
  before anything else gives.

### PASS 5 — WatercolourPigmentPass
Four stacked ops on the display image (Bousseau/Montesdeoca model, screen-space, no fluid sim):
1. **Wet UV wobble** — low-freq 2D value-noise offset (hand tremor); sample everything through
   `vUv + wobble`. `wobbleSpeed<=0.15, wobbleAmp<=0.004` (faster/stronger = "boiling").
2. **Edge-darkening** — Sobel on luma → `col *= (1 - edge*0.55)` (Marangoni pigment buildup at value
   boundaries; MULTIPLY toward the local hue's tinted dark, **ceiling 0.55** or edges go inky).
3. **Pigment density** — `density = pow(1-luma, pigmentGamma) + sat*0.3` (dark/saturated = denser).
4. **Granulation** — `gran = 1 - granulation*density*(1-h)`; `col *= gran` (paper valleys hold
   pigment). Gated by a **luma bell** (peak ~0.45) so it bites in mid washes and fades in paper-white
   & dense darks.
5. **Density-gated 4-tap bleed** across found edges — `col = mix(col, bleed, density*0.4)`.
Value-noise only, chroma jitter ~0. **Optional depth-edge upgrade** (+4 taps from the DepthTexture)
gives true silhouette darkening on same-value contours.
`uniforms: tDiffuse, tPaper, resolution, time, paperScale, wobbleAmp, wobbleFreq, wobbleSpeed, edgeStrength, edgeWidth, granulation, bleedRadius, pigmentGamma`.

### PASS 6 — PaintGradeLUTPass (PALETTE LOCK) — replaces ColorGradePass
Remap pixel **luminance** through a hand-authored 256×1 gouache ramp (`THREE.DataTexture`,
`SRGBColorSpace`, **LinearFilter**, NO in-shader `pow(2.2)`). Blend toward it by
`uGradeAmount~0.82` with `uChromaPreserve~0.22` so the hero keeps local hue but **no disharmonious
colour can physically survive**. Optional soft posterize (~6–8 levels) for gouache value plateaus.
End with **TPDF dither** (two summed hashes → triangular noise ~1/255, scaled to the largest
quantiser) so the quantise/8-bit never bands.
```glsl
float luma = dot(src, vec3(0.2126,0.7152,0.0722));
vec3 graded = texture2D(tGradient, vec2(clamp(luma,0.,1.), 0.5)).rgb;
vec3 col = graded*(1.-uChromaPreserve) + src*uChromaPreserve;
col = mix(src, col, uGradeAmount);
if (uPosterize>0.5) col = floor(col*uPosterize)/uPosterize;
float tpdf = hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy+17.) - 1.0;
col += tpdf * (uDither/255.0);
```
**Authoring the LUT** is where harmony comes from: paint 3–5 stops from the table — deep
violet-blue shadow (`#1E1B22`/`#2C2A38`) → steel/rose mid (`#A7A3B1`/`#CEB9B9`) → putty highlight
(`#D9D6CE`), keep luminance **monotonic across the full 0..1 range** with the rare punched dark.
Music: cross-fade between two authored ramps or rotate a small `uHueShift` toward rose on drops —
**never hard-swap** (snaps the whole frame).
`uniforms: tDiffuse, tGradient, uGradeAmount, uChromaPreserve, uPosterize, uDither, uResolution`.

### PASS 7 — PainterlyEdgePass (lost-and-found dark accents)
Union of: **(a) flow-based XDoG** on luma (DoG sharpened by `tau`, `tanh(phi)` soft-threshold,
sampled along the gradient and accumulated along the tangent from PASS 2's flow); **(b) geometric
depth/normal edges** (2nd-derivative depth test **divided by depth** so the far road isn't
over-inked; normal crease from AUX A). **GATE** the union by `saliency × flow-coherence(anisotropy)
× slow-crawling value-noise breakup × depth-fade` so only **~25–40% of candidate contours ink** and
the SAME edge is found here / lost there. Composite by **MULTIPLY** toward tinted warm-black ink
(`#20211C`/`#1E1B22`), **never additive, never pure black**. Sparse calligraphic darks = the
"finished painting" cue.
- Hysteresis/EMA on a smoothed contrast field; breakup noise crawls slowly (`time × ~0.05`) or
  edges strobe.
- Music: drops widen the breakup threshold (more found ink) rather than strobing strength (±15% max).
- Optimise: structure tensor + flow at HALF res; cap DoG taps at 4–6; gate to foreground heroes/road,
  not the sky.
`uniforms: tDiffuse, tDepth, tNormal, uResolution, cameraNear, cameraFar, uInkColor, sigma_e, k, tau, phi, epsilon, normalThresh, depthThresh, salLo/salHi, cohLo/cohHi, noiseScale, uTime, uMusic`.

### PASS 8 — VelocitySmearPass ("watercolour speed")
Reconstruct a **screen-space velocity buffer** from DepthTexture + previous/current view-projection
(camera-relative: the static world rushing past is captured for free and grows with depth toward the
horizon). Cache `prevViewProj` each frame; in-shader unproject UV+depth with `invCurViewProj`,
reproject with `prevViewProj`, `velocity = vUv - prevUv`. **6–10 taps along velocity** with three
watercolour modifiers:
1. **Asymmetric tail** — trailing edge dissolves far more than leading (`w = smoothstep(0.5,-0.5,t)`,
   renormalised) → comet/dry-brush tail, not a symmetric photographic ghost.
2. **Perpendicular low-freq wobble** — `perp = normalize(vec2(-v.y,v.x))`, offset taps by
   `noise()*uWobble*perp` (~0.002 UV) → bristle drag.
3. **Granulation stretched along the streak** → pigment fingers.
**Streak VALUE far more than chroma** (desaturating the smear toward neutral = dead photo blur =
death). **Depth-bias** velocity by `(0.3 + 0.7*linearDepth)` so near tarmac stays readable and far
road dissolves. Hero car masked **SHARP** via the repurposed HERO_LAYER mask (the one crisp found
anchor). `smearLen = base*(0.6+0.4*speedMultiplier) + beatKick*0.5`. **Hard-clamp `|velocity|`
(~0.05 UV) and ZERO it on seek/rewind/large-delta frames** (the controller already re-baselines
those) so a stale prev-matrix can't smear the whole screen. `uVelocityScale = currentFps/targetFps`
so smear length is framerate-stable. Feed the matrices from the **shaken** camera transform (same
one the frame renders with).
`uniforms: tDiffuse, tDepth, tCarMask, uInvCurViewProj, uPrevViewProj, uTexelSize, uStrength, uMaxSmear, uWobble, uSpeedMul, uBeatKick`.

### PASS 9 — SubstratePaperPass (FINAL) — replaces FilmGrain
One cold-press paper height field `h` (procedural 3–4 octave value-noise fbm, rotated ~17°,
**frame-anchored / camera-static**, slow re-seed) drives THREE coupled effects:
1. **Granulation** — subtractive + desaturating pigment-settle in the valleys, gated by a luma bell.
2. **Tooth lighting** — faint signed raking light from the analytic height **gradient = normal**
   (peaks warm, valleys cool, ~0.04 strength).
3. **Micro-distortion** — nudge the colour fetch UV by the height gradient so painted edges break on
   the fibre.
Composited as **Pegtop soft-light** (harmony-preserving): `softLight(b,s) = (1-2s)*b*b + 2s*b`, over
a warm-cream tinted sheet (`#EDE7D8`), `paperStrength ~0.16`. Fold a **1/255 hashed dither** in (it
takes over FilmGrain's debanding role). Keep `granDensity 0.18–0.35` / `paperStrength 0.12–0.22` —
over-application (>0.4 / >0.3) reads as **dirt not paper**. Sample the noise field (not tDiffuse) for
the finite-difference gradient.
`uniforms: tDiffuse, resolution, paperScale, paperAngle, paperStrength, granDensity, distortAmt, grad_eps, paperLight, lightDir3, toothFlatness, paperTint, warmTint, coolTint, time`.

---

## 4. MATERIAL STRATEGY

**CORE PRINCIPLE:** every material renders **FLAT and MATTE** in the RenderPass — no emissive, no
envMap, no metalness, no bloom feeders. All "paint" character is added in post by
Kuwahara + pigment + granulation. The saturated `ANALOGOUS_PALETTE` (teal/cyan/red) re-applied onto
GLB materials in `applyPaletteToModel` (ThreeScene.ts:1036) is **REPLACED** by the tinted-gray
harmony palette: any imported material is desaturated toward gray (mix ~0.55) and retinted to the
violet-gray family, or the gouache read collapses into plastic toy colours.

**Lighting:** keep the soft cool ambient + warm low key but recolour to the harmony —
ambient = steel-violet `#A7A3B1` (cool shadow fill), key = a desaturated warm sienna (warm light) —
so form reads through the **warm-light / cool-shadow temperature axis**, not through saturation.

### Hero car — the "helmet-shine" paint (APPROACH B; per-OBJECT material, in the RenderPass)
Keep `MeshStandardMaterial` (grounded form takes the soft key + shadow) but force it **matte**:
`metalness 0, roughness ~0.85, envMapIntensity 0`, `color = #9F939E` lerped toward gray. Inject **ONE
broad soft specular lobe** via `onBeforeCompile` (the convention the road already uses at
ThreeScene.ts:1172), added to `totalEmissiveRadiance` as **unlit paint AFTER lighting accumulation
(NOT through the BRDF** — that re-introduces a tight CG glint).
- Uniforms: `uSheenDir` (view-space, ~`normalize(0.35,0.8,0.45)`), `uSheenColor=#D7D7E6`,
  `uSheenWidth` LOW **~6** (broad rolling lobe, NEVER 32–128), `uSheenStrength~0.6`,
  `uSheenWrap~0.5` (half-Lambert so the lobe bleeds softly past the terminator like wet paint).
- The CRITICAL Sienkiewicz move encoded in-shader: as the spec term `s` rises, **hue-lerp toward
  ~232°, multiply saturation by `(1-0.6*s)`, and clamp value at ~0.90** — warm/saturated shadow
  (`#706675`) ramps to cool/desaturated highlight (`#D7D7E6`) that **never hits white**.
- Darks lerp toward `#2C2A38`, **never black** (hue+sat preserved into near-black).
- Reflected catch-lights are **scene colour at low sat**: a cool `#B8C2D8` sliver and a faint warm
  `#C59076` hint — never a chrome mirror.
- Low-freq desaturating noise on the lobe (value variance ~±0.05) so the sheen is a mottled wash,
  not a clean CG gradient. Razor near-white edge sparks (`#F6F7F9`) only on the top ~2% of
  `(spec×fresnel)` on high-curvature silhouettes.
- The single hard **found** edge on the whole car is the spec streak; body-vs-background edges are
  deliberately **lost** (matched values + the edge pass feathering them).
- `material.customProgramCacheKey = () => 'carSheen'` so all submeshes share one program.
- Drive `uSheenStrength ≈ 0.45 + beatStrength*0.5 + spectralCentroid*0.25` (smoothed lerp ~0.3,
  clamped ≤~1.3) so the shine **breathes/rolls** on the beat — a saturation/value pulse of the
  existing hue, never a new colour or a bloom flash.
- **Matcap fallback (APPROACH A):** a hand-painted 256² gouache matcap on `MeshMatcapMaterial`
  (`SRGBColorSpace`) gives the body gradient + soft sheen for ~0 shader cost if onBeforeCompile is
  deferred. Camera-locked, not light-anchored — fallback only.

### Obstacles (swords)
The one saturated accent — signal red `#D6443B`, matte, with a **guaranteed dark accent stroke**
from PainterlyEdgePass on the shadow side. They enter **along the diagonal** (off the centerline),
reinforcing the speed vector.

### Retired
**RETIRE RimGlowShell entirely** (its `#00ffff→#ff00ff` additive Fresnel halo is banned and would
pump into a bloom that no longer exists); the in-material sheen replaces its hero-isolation role.

### Particles (ParticlePool)
Restyle from additive bright dots into **tinted near-black pigment SPATTER / dry-brush flecks** (drip
+ spatter primitives), low coverage ~1–2%, music-triggered punctuation — **not** additive glow.
Drop/treble/collision bursts become spatter/drip seeds in `#20211C`/`#1E1B22`. Switch the
`THREE.Points` blending off additive.

---

## 5. PER-ELEMENT TREATMENT

**Sky** — a quiet **granulated tinted-gray gradient dome**: steel-violet `#A7A3B1` up top easing to
lit steel-blue `#B8BBCE` near the horizon. NO synthwave gradient, NO stars. Deliberately empty
negative space (**50–70% of the frame stays quiet**) so the few found marks on the hero corner land.
Replace the emissive synthwave shader-dome with a flat matte vertical-gradient material; granulation
+ paper tooth in post give the watercolour mottle; the LUT's TPDF kills banding. Composed
**off-centre** — horizon pulled off the vertical centerline. Excluded from the heavy edge/smear
budget.

**Sun / horizon** — a soft **achromatic-to-cool luminous disc** (paper-putty `#D9D6CE` core easing
to the steel-violet field), with watercolour granulation, **NOT a striped/banded retro sun** (hard
ban). A low-contrast **value lift**, pulled **off the centerline** (never stacked on the vanishing
point), reading as a pale wet bloom of light dissolving into the sky wash. No glow/bloom.

**Ground** — warm rose-gray field `#CEB9B9`, the warm counterweight to the cool sky; a desaturated
granulating wash. The split-complementary balance is structural (warm rose ground beside cool steel
sky, bridged by the sand road). Mid-key with **rare punched darks** the block-in lacks. Y still
follows RMS loudness, shaded matte; dissolves into the field-tinted fog at distance (lost horizon),
not into black.

**Road** — the warm **sienna/sand bridge `#C9B49E`** (crushed in saturation and value). The
baked-neon emissive road shader (`onBeforeCompile`) is **REPLACED wholesale** with a matte painterly
material; the per-frame road-morph normal recompute must keep feeding clean normals to the edge pass.
Lane/road edges are **soft, value-based, lost-and-found** — often petrol-teal `#48677D` in shadow —
**NEVER bright neon cyan grid lines**. Near tarmac under the car stays readable while mid/far road
streaks toward the off-centre vanishing point and dissolves into wet pigment fingers.

**Car** — hero focal subject (materials §4): muted violet-gray body, ONE broad cool rolling sheen
capped `#D7D7E6` that breathes on the beat, faint reflected scene-colour catch-lights, razor sparks
on <2% of high-curvature silhouettes. Body-vs-background contours **lost**; spec streak the single
**found** edge. Kept **SHARP** by the HERO_LAYER mask through the velocity smear. Sits **off-axis** in
one quadrant, balanced by quiet negative space.

**Obstacles** — swords in signal red `#D6443B`, the single saturated narrative hit, each with a dark
accent stroke `#20211C` on the shadow side, entering **along the dominant diagonal**. Collision
triggers a tinted near-black pigment-spatter burst + a brief smear-length kick (a "wet drag" pulse),
**NOT** the deleted red bloom flash / chromatic kick.

**HUD** — pure Canvas 2D (`HudOverlay`, decoupled from Three) survives the rip-out functionally but
is **RESTYLED as ink/gouache marginalia on the same paper**. Drop cyan/magenta glow strokes and any
bloom-adjacent styling. Repaint in the locked palette: meters and BPM beat-phase ring as desaturated
tinted-gray strokes (steel-violet `#A7A3B1` / rose-gray) with a single dusty-rose `#A96276` accent
for the active beat and one obstacle-red `#D6443B` tick for a hazard. **Brush-like irregular weight,
soft (lost) ends**, not crisp vector lines; the beat ring is a hand-inked calligraphic arc whose
stroke **darkens (toward `#20211C`) on the beat instead of glowing**. Type in warm near-black
`#1E1B22` at low contrast. Sparse and **off to one side**, respecting the off-centre composition.
Keep the read-only contract (samples `gameState.audioTime`, never mutates). No new state.

---

## 6. MOTION — "WATERCOLOUR SPEED" LANGUAGE

Speed is painted as a **wet directional SMEAR of the already-painted value field** — never lines,
trails, or particle ribbons (the ref paints **zero** speed-lines; its chrome rider is a
low-coherence wet field, structure-tensor axis ~153°, coherence only 0.16). Implementation = PASS 8.

- **Camera-relative reconstruction** captures the static world rushing past **for free**, and the
  smear **grows with distance** toward the off-centre horizon — exactly a gouache speed painting.
- **Lost-and-found is the energy engine:** ONE small high-coherence **sharp** zone (the hero
  car/helmet + its sheen, masked sharp via HERO_LAYER) inside a large low-coherence **wet** field;
  blur ramps up toward frame edges and into the distance.
- **Compose OFF-CENTRE on a single dominant diagonal.** The block-in's dead-centre one-point stack
  of sun+sword+vanishing-point is the first thing broken: yaw the camera / bias the road so the
  vanishing point sits ~30% off-axis on a raking diagonal; obstacles enter on the diagonal.
- **Music through the medium, not brightness/bloom (banned):** louder/drops = a touch more chroma on
  the accents + lifted key value + a **longer wet smear** + sharper found gestures (raise found-zone
  coherence, ease Kuwahara `q` down for a wetter look, push rose toward S~45); quieter = washes back
  toward gray and a shorter smear. **A beat = a "wet drag + crisper gesture" pulse and a breath of
  the helmet sheen — never a flash.**
- Camera shake stays but feeds the smear's view-projection from the **shaken** transform; clamp
  `|velocity|` hard and **ZERO** on seek/rewind/large-delta frames.

---

## 7. PERFORMANCE BUDGET & KILL-LIST

**Target:** ~60fps in-browser; cap composer `pixelRatio` at 2. Net frame cost is **comparable to or
cheaper than** the deleted two-composer bloom stack (which did a whole second full-scene render +
exaggerated UnrealBloom). This scene is **fill-bound** (full-screen passes), not draw-call-bound.

| Stage | Est. cost @1080p | Notes |
|-------|------------------|-------|
| Primary RenderPass + DepthTexture | baseline | one render (was effectively two) |
| AUX A Normal G-buffer | ~0.2 ms | small hero geometry; skippable |
| PreBlur | ~0.1 ms | |
| StructureTensor (half-res) | ~0.2 ms | RGBA16F |
| TensorBlur (2×1D) | ~0.2 ms | |
| **Anisotropic Kuwahara** | **~1.0–1.6 ms** | **the keystone & first thing to profile; do NOT cut for the look** |
| WatercolourPigment | ~0.4 ms | ~12–17 taps |
| PaintGradeLUT + TPDF | ~0.1 ms | 1 ramp tap |
| PainterlyEdge | ~0.6 ms | half-res flow, 4–6 DoG taps |
| VelocitySmear | ~0.5 ms | 6–10 velocity-adaptive taps |
| SubstratePaper | ~0.3 ms | procedural fbm, no RT |

**Quality-scale knobs (claw back budget from the CHEAP passes first):** Kuwahara radius 6→4–5 and
tensor half→quarter-res are the **last** levers; before them: drop AUX A (luma-XDoG only), cut smear
to 6 taps, cap DoG to 4 taps, gate edge/smear to foreground only.

### KILL-LIST — delete these synthwave passes/fields/imports (compiling-at-each-step)
`tsconfig` is **strict + noUnusedLocals**; vue-tsc is the only gate. Deleting a pass means deleting
its **class field, import, `resize()` call, AND per-frame driver** together, or the build goes red.

- **Imports (ThreeScene.ts:5,12,13,14):** `UnrealBloomPass`, `createChromaticAberrationPass`,
  `createNeonCompositePass`, `RimGlowShell`. (Keep `SMAAPass` import only if reused; otherwise
  delete L8 too — PreBlur replaces it.)
- **Fields (ThreeScene.ts:219–239):** `bloomPass`, `neonRenderTarget`, `neonComposer`,
  `neonBloomPass`, `neonCompositePass`, `chromaticPass`, `colorGradePass` (replaced),
  `filmGrainPass` (replaced), `smaaPass`, `rimGlow`, `carEmissiveMaterials` (repurpose → `carSheenMaterials`).
- **Construction (ThreeScene.ts:373–458):** the bloom add, the SMAA add, the chromatic add, the
  Vignette add, the FilmGrain add, the entire **second neon composer** block (L413–458) and
  `NeonCompositePass`.
- **resize() (ThreeScene.ts:1394–1405):** `bloomPass.setSize`, `smaaPass.setSize`,
  `neonRenderTarget.setSize`, `neonComposer.setSize`, `neonBloomPass.setSize`. Add the new
  `resolution`/`texel`/tensor/normal/depth target updates here.
- **Per-frame drivers (ThreeScene.ts:1568–1645):** `neonCompositePass.uniforms.strength`,
  `chromaticPass.uniforms.intensity` (and the whole flux-CA block ~1592–1606), `filmGrainPass.uniforms.time`,
  `rimGlow.update`, the `carEmissiveMaterials` emissive scaling loop (~1618–1623), and
  `renderNeonIsolation()` (~1643, and its method ~1649).
- **Scene shaders:** the sky-dome emissive shader, the retro-sun shader plane, the neon grid helper,
  and the **baked-neon road `onBeforeCompile`** emissive (replace, don't half-remove).
- **Layers:** repurpose `HERO_LAYER` (2) into the smear sharp-mask; **drop `NEON_LAYER` (1)** tagging
  from all objects (no bloom to select for).

**Confirm:** nothing in `GameController`/`HudOverlay` reads bloom/CA-driven renderer state (those are
renderer-internal envelopes — they shouldn't). The 7-method facade
(`setTrack/renderFrame/resize/emitDropBurst/emitTrebleBurst/setCollisionCallback/particlePool`) is
unchanged.

---

## 8. RESEARCH APPENDIX (condensed)

### Technique catalog (with the parameters that matter)
- **Anisotropic Kuwahara (Kyprianidis 2009/2010)** — structure-tensor eigenanalysis → 8-sector
  elliptical kernel aligned to the edge tangent, polynomial (convolution-free) sector weights,
  variance-weighted smooth combine `1/(1+std^q)`. Start `radius=6, q=12, ecc=0.6, tensorSigma=2.5,
  half-res tensor`. Float tensor target mandatory. Cost O(r²·8). The "it's gouache" pass. Refs:
  kyprianidis.com/p/pg2009, diglib.eg.org 2010, maximeheckel.com painterly-shaders.
- **Watercolour pigment (Bousseau 2006 / Luft-Deussen / Montesdeoca MNPR)** — edge-darkening
  (Marangoni, MULTIPLY, ceiling 0.55), granulation (paper-height into shadows, luma-bell gated peak
  ~0.45), wet UV wobble (`speed<=0.15`), density-gated bleed. Screen-space, view-independent.
- **SubstratePaperPass (Curtis 1997 / Montesdeoca NPAR 2017)** — one fbm height field → subtractive
  granulation + signed tooth-light + UV micro-distortion, **Pegtop soft-light**, frame-anchored,
  final pass. `paperStrength 0.12–0.22, granDensity 0.18–0.35`.
- **Gradient-map LUT + TPDF** — luminance→256×1 ramp DataTexture (sRGB, LinearFilter, no in-shader
  pow), `uGradeAmount~0.82, uChromaPreserve~0.22`, optional posterize, TPDF (two summed hashes)
  scaled to the largest quantiser. Harmony by construction. Refs: maximeheckel dithering, Wikipedia
  Dither (TPDF).
- **Velocity smear (Chapman per-object / depth-reconstruction)** — depth + prev/cur view-projection
  → screen velocity; 6–10 taps; **asymmetric tail + perpendicular wobble + granulation-along-streak**;
  value-streak not chroma; depth-bias `(0.3+0.7*ld)`; car masked sharp; clamp+zero on seek;
  `velScale=fps/target`. **Perspective divide MUST be per-fragment.** Refs: john-chapman-graphics,
  gkjohnson threejs-sandbox MotionBlurPass.
- **Helmet-shine material** — matte MeshStandardMaterial + injected broad lobe (exponent ~6, half-
  Lambert wrap, cool-desaturate-on-brighten, value cap 0.90) into `totalEmissiveRadiance`; reflected
  scene catch not a mirror; sparks <2%. NOT a ShaderPass. Refs: three MeshMatcapMaterial,
  onBeforeCompile chunk-replacement.
- **Painterly edges (Winnemöller/Kyprianidis XDoG + Kang FDoG/ETF + depth/normal)** — flow-based
  XDoG `D_tau = G - tau·G_k`, `tanh(phi)` soft-threshold, accumulate along tangent; ∪ depth(2nd-
  deriv÷depth)+normal edges; gate by `saliency×coherence×slow-noise×depthFade`; MULTIPLY toward
  tinted warm-black. Refs: kyprianidis.com/p/cag2012, Codrops sketchy-pencil.

### Style DNA (the measured law)
- **Colour:** median saturation ~12%, 75th pct ~20%, only top 1% >58%; value mid-key (median ~65%,
  rare darks V~10%). **Muted split-complementary** (rose ~343 vs steel-blue ~223) bridged by sienna
  (~19), petrol-teal (~204) a shadow whisper. Grays are **tinted** toward the axis, never neutral.
  Desaturate globally, re-inject chroma surgically (`chromaMask 0.1–0.2` almost everywhere).
- **Medium:** opaque-to-translucent **gouache on cold-press paper**. Three separable layers: (1)
  value-quantized washes (gouache is stepped, not smooth), (2) granulation as **value noise** in
  paper valleys (12–28 V-pts, hue unchanged), (3) **lost-and-found edges** — most silhouettes
  dissolve, sparse highest-contrast contours get an **asymmetric dark accent stroke** on the shadow
  side. Drips/spatter are sparse music-driven punctuation. Granulate VALUE not hue. Anchor paper to
  the FRAME (re-seed slowly) — never scroll with geometry ("shower-door" death).
- **Specular:** a **broad soft rolling sheen** (tight 140–162/255 band, no point glint) that shifts
  **cooler and desaturates** as it brightens (shadow violet 280°/13% → highlight blue 240°/7%) and
  **caps at V~0.90 (`#D7D7E6`), never white**, over a body that keeps its hue into near-black. No
  metalness/envMap mirror.
- **Motion & composition:** speed = a single oblique **diagonal wet value-drag** (axis ~153°,
  coherence 0.16) with one held-sharp subject, never a line; off-centre on a dominant diagonal;
  negative space deep, tinted, 50–70% of the frame.
- **Top risks:** (1) **temporal flicker** in 3 places at once — Kuwahara stroke crawl (blur the
  TENSOR, sigma 2.5), edge strobe (hysteresis + slow breakup noise ×0.05), paper shower-door
  (frame-anchored, slow re-seed); (2) **60fps at 2×DPR** (profile Kuwahara first); (3) **depth
  precision** (tighten far ~2000 / log remap / 2nd-deriv÷depth, clamp+zero velocity); (4)
  **pass-order/double-encode** (paint after OutputPass, LUT tagged sRGB with no in-shader pow,
  granulation subtract / paper soft-light, paper LAST); (5) **art-direction knife-edge** (LUT
  luminance monotonic full-range with rare punched darks; `uChromaPreserve` ~0.22; granulation/paper
  <0.4/<0.3 or it's dirt); (6) **strict-build rip-out** (delete fields+imports+resize+drivers
  together).

---

## 9. PRIORITISED BUILD PLAN (parallelisable work units)

Each unit lists: **files**, **delivers**, **verify**. Units that touch **ThreeScene.ts** are the
contention point and **must be serialised in WAVE order** (a single owner integrates them, or each
rebases on the previous). Self-contained new files can be built **fully in parallel** by the swarm
and only need their one-line wiring merged during the matching ThreeScene wave.

**Shared verification harness (use throughout):** `npm run build` (vue-tsc strict — the only gate);
the `window.__game` runtime hook + Playwright (navigate, drive `speedMultiplier`/beats, screenshot)
per `memory/linerider-runtime-debug-hook.md`; compare against ref 02 at a near-white sky region AND a
dark area.

### Track A — Standalone pass modules (NEW files, FULLY PARALLEL, no ThreeScene edits)
These have zero collision; each is a `ShaderPass`/`Pass` factory mirroring the existing
`FilmGrainPass.ts`/`ColorGradePass.ts` shape. They are unit-built and visually proven in isolation
(a scratch composer or the Maxime-Heckel-style harness), then wired in their ThreeScene wave.

- **A1 — StructureTensor + TensorBlur + PreBlur passes**
  Files: `src/core/render/PreBlurPass.ts`, `StructureTensorPass.ts`, `TensorBlurPass.ts`.
  Delivers: half-res RGBA16F tensor field + its separable blur + the input pre-blur (PASS 1–3).
  Verify: render the tensor as false-colour; confirm a coherent, non-flickering orientation field on
  a still and a panning frame.
- **A2 — AnisotropicKuwaharaPass (KEYSTONE)**
  Files: `src/core/render/AnisotropicKuwaharaPass.ts`.
  Delivers: PASS 4 — the gouache flattener (8-sector polynomial, smooth combine, GLSL-ES-1.00 fixed
  loop). Depends on A1's tensor as an input uniform but is a separate module.
  Verify: feed a photo + A1 tensor; flat directional strokes that bend along contours, crisp-but-
  lost boundaries; **profile GPU ms first** (radius 6 vs 4–5).
- **A3 — WatercolourPigmentPass**
  Files: `src/core/render/WatercolourPigmentPass.ts` (+ optional `public/textures/paper.png` or
  procedural fallback).
  Delivers: PASS 5 — wobble + edge-darken + granulation + bleed.
  Verify: edge-darkening pools at value boundaries; granulation reads as paper tooth (not snow);
  wobble stable (no boiling) at `speed<=0.15`.
- **A4 — PaintGradeLUTPass + LUT authoring**
  Files: `src/core/render/PaintGradeLUTPass.ts`, `src/core/render/paintRamp.ts` (DataTexture builder
  from the §2 stops).
  Delivers: PASS 6 — palette lock + TPDF deband (replaces ColorGradePass).
  Verify: feed a saturated synthwave still → output collapses into the locked tinted-gray harmony,
  no banding, hero retains a sliver of local hue at `uChromaPreserve~0.22`.
- **A5 — SubstratePaperPass**
  Files: `src/core/render/SubstratePaperPass.ts`.
  Delivers: PASS 9 — frame-anchored paper (granulation + tooth-light + micro-distortion, Pegtop
  soft-light, folded dither).
  Verify: paper sits still while a test quad scrolls beneath (no shower-door); `paperStrength 0.16`
  reads as medium, not dirt.
- **A6 — PainterlyEdgePass**
  Files: `src/core/render/PainterlyEdgePass.ts` (Pass subclass — owns the normal-RT side render).
  Delivers: PASS 7 — flow-XDoG ∪ depth/normal edges, gated lost-and-found, MULTIPLY ink. Consumes
  A1's flow + the depth/normal targets (Track B).
  Verify: only ~25–40% of contours ink; the same edge is found here/lost there; no strobe across
  frames (hysteresis + slow breakup); ink is tinted near-black, never glow/black.
- **A7 — VelocitySmearPass**
  Files: `src/core/render/VelocitySmearPass.ts`.
  Delivers: PASS 8 — depth+prev-VP velocity, asymmetric wet drag, perpendicular wobble, depth-bias,
  car-mask sharp, clamp+zero-on-seek.
  Verify: with a synthetic prev/cur VP, world streaks while a masked region stays sharp; a one-frame
  huge delta produces **no** full-screen smear; smear streaks value not chroma.
- **A8 — Helmet-shine material module**
  Files: `src/core/render/CarSheenMaterial.ts` (onBeforeCompile injector + `carSheenMaterials`
  registry type + per-frame update helper) (+ optional `public/textures/sheen-matcap.png` fallback).
  Delivers: §4 broad rolling cool-desaturate-capped sheen + reflected catch + sparks, decoupled from
  ThreeScene so it can be unit-shaded.
  Verify: on a test sphere/car GLB, one broad lobe (not a dot), cools+desaturates+caps at V~0.90,
  darks stay violet; no envMap mirror; `customProgramCacheKey` shared.
- **A9 — Pigment-spatter ParticlePool restyle**
  Files: `src/core/render/ParticlePool.ts`.
  Delivers: additive→tinted-near-black spatter/dry-brush flecks, low coverage; same
  `emitBurst/update/reset` API so ThreeScene call sites are untouched.
  Verify: bursts read as ink spatter on a mid-gray background, not glowing dots; blending no longer
  additive.
- **A10 — HUD gouache restyle**
  Files: `src/core/render/HudOverlay.ts`.
  Delivers: §5 ink/gouache marginalia repaint (palette, brush-soft ends, beat ring darkens not
  glows, off to one side). Read-only contract preserved; **does not touch ThreeScene**.
  Verify: HUD renders in-key over a paper-tone canvas; no cyan/magenta; beat darkens the ring.

### Track B — ThreeScene integration (SERIALISED; single owner / rebasing waves)
All of these edit `src/core/render/ThreeScene.ts`. Run **in wave order**; each compiles green before
the next.

- **B1 (WAVE 1) — Rip-out + matte base** *(touches ThreeScene.ts)*
  Files: `ThreeScene.ts` (+ delete `ChromaticAberrationPass.ts`, `NeonCompositePass.ts`,
  `RimGlowShell.ts`, `VignettePass.ts`, `FilmGrainPass.ts`, `ColorGradePass.ts` once superseded).
  Delivers: the §7 kill-list executed as a compiling-at-each-step refactor — all bloom/neon/CA/SMAA/
  vignette/grain/RimGlow fields+imports+resize+drivers gone; sky/sun/grid emissive shaders and the
  baked-neon road `onBeforeCompile` replaced with matte materials; `applyPaletteToModel`/`buildFallbackCar`
  retinted to tinted-gray (desaturate ~0.55); ambient→steel-violet, key→warm sienna; fog retinted to
  the field colour; `HERO_LAYER` repurposed as the smear mask, `NEON_LAYER` tagging dropped.
  Verify: `npm run build` green; app runs showing a flat **matte tinted-gray** scene (no neon, no
  bloom) — intentionally "unfinished paint" before the post-stack lands.
- **B2 (WAVE 2) — Aux targets: DepthTexture + Normal G-buffer** *(touches ThreeScene.ts)*
  Files: `ThreeScene.ts`.
  Delivers: DepthTexture attached to the primary target (or depth pre-pass) with a tightened
  far (~2000) for edges/velocity; AUX A normal override-render into a half-float RT; both reallocated
  in `resize()`. These are the inputs A6/A7 consume.
  Verify: sample depth/normal to screen via a temp debug pass; correct linearised depth and view-
  normals; resize keeps them aligned.
- **B3 (WAVE 3) — Wire the painterly chain** *(touches ThreeScene.ts)*
  Files: `ThreeScene.ts`.
  Delivers: `addPass` the Track-A passes in the exact §3 order (PreBlur→Tensor→TensorBlur→Kuwahara→
  Pigment→PaintGradeLUT→PainterlyEdge→VelocitySmear→SubstratePaper); allocate the half-res tensor RT;
  set every `resolution`/`texel`/`tensorTexel` in constructor + `resize()` in drawing-buffer pixels;
  cap `pixelRatio` at 2.
  Verify: `npm run build` green; full painterly look on screen; toggle each pass's strength uniform
  to 0 to A/B; hold ~60fps (profile, apply §7 quality knobs if not).
- **B4 (WAVE 4) — Car sheen + per-frame music drivers** *(touches ThreeScene.ts)*
  Files: `ThreeScene.ts`.
  Delivers: apply A8's sheen material in `applyPaletteToModel(isPlayer)` + `buildFallbackCar`, store
  in `carSheenMaterials`; per-frame: drive `uSheenStrength/uSheenDir` (beat/centroid/banking,
  smoothed), Kuwahara `q` ease-down on drops, smear `uStrength/uBeatKick` (speedMultiplier + beat),
  edge breakup widen on drops, accent chroma push; cache `prevViewProj` (post-render copy) from the
  shaken camera and zero the smear on seek/large-delta (reuse the controller's re-baseline signal).
  Verify: sheen breathes on the beat (no flash); smear lengthens on drops and zeroes on seek; car
  stays sharp while the world streaks; everything stays under the saturation discipline.
- **B5 (WAVE 5) — Composition: off-centre diagonal** *(touches ThreeScene.ts)*
  Files: `ThreeScene.ts`.
  Delivers: yaw the chase camera / bias the road & horizon so the vanishing point sits ~30% off the
  vertical centerline on a raking diagonal; ensure obstacles enter on the diagonal; verify the
  road-morph normals still feed the edge pass cleanly under the new framing.
  Verify: screenshot shows the horizon/VP off-centre with 50–70% quiet negative space; the
  smear and found-edge rhythm read as a moving Sienkiewicz, not a centred one-point racer.

**Parallelism summary:** Track A (A1–A10) fans out immediately and in full parallel. Track B is the
serial spine: **B1 → B2 → B3 → B4 → B5**, each compiling green. A-units land their one-line wiring
during the matching B-wave (A1–A7 in B3; A8 in B4; A9/A10 anytime — A10 never touches ThreeScene).
The only hard ordering constraints: B1 before everything; B2 before A6/A7 can be wired (B3); A2
depends on A1's tensor; A6/A7 depend on B2's targets.
