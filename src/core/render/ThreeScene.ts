import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { ParticlePool } from './ParticlePool'
import { TrackData } from '../track/TrackTypes'
import { GameState, getLaneOffset } from '../game/GameState'
// --- Painterly "Watercolour Speed" post stack (Track-A pass modules, wired in B3) -------
// Each is a ShaderPass factory mirroring the old FilmGrainPass/ColorGradePass shape; they
// are added to the single composer in the EXACT STYLE_SPEC §3 order. The structure-tensor
// trio (StructureTensor -> TensorBlur x2) renders into an owned half-res RGBA16F target
// (a manual side-chain, see buildPainterlyChain) whose texture feeds Kuwahara's `tTensor`
// and PainterlyEdge's flow field; the rest are straight chain passes.
import { createPreBlurPass } from './PreBlurPass'
import { createStructureTensorPass } from './StructureTensorPass'
import { createTensorBlurPass } from './TensorBlurPass'
import { createAnisotropicKuwaharaPass } from './AnisotropicKuwaharaPass'
import { createWatercolourPigmentPass } from './WatercolourPigmentPass'
import { createPaintGradeLUTPass } from './PaintGradeLUTPass'
import { buildPaintRamp } from './paintRamp'
import { createPainterlyEdgePass } from './PainterlyEdgePass'
import { createVelocitySmearPass } from './VelocitySmearPass'
import { createSubstratePaperPass } from './SubstratePaperPass'
import { injectCarSheen, updateCarSheen, CarSheenMaterial } from './CarSheenMaterial'

// Beat-sync envelope tuning. The FOV "punch" zooms out fast on a beat onset then eases
// back. Evaluated procedurally each frame from (now - lastBeatTime) so it is frame-rate
// independent and needs no tween bookkeeping (matching the codebase's manual-lerp style).
// (The bloom pulse this envelope also used to drive was ripped out with the post stack.)
// Round 3 hero-subject reframe: a LONGER lens (was 75) so the kart reads as a large,
// flattened focal subject the way the chrome rider fills its panel in ref 02 — a tighter
// FOV magnifies the car and gently compresses depth (flattering the painted read) without
// touching the off-centre diagonal stance (the COMPOSE_* angles below are re-tuned to suit).
const BASE_FOV = 50
const FOV_PUNCH = 6 // extra degrees added at peak of a full-strength beat (scaled to the longer lens)
const FOV_ATTACK_MS = 90 // ramp up to peak
const FOV_DECAY_MS = 420 // ease back to base

// Beat selectivity + anticipatory camera tuning (iteration 6).
//
// Beat selectivity: strong beats (kicks, snares) punch FOV/shake and pulse the beat
// indicator; weak beats (hi-hats, transients) sustain the baseline without transient
// spikes. This "professional restraint" reads as premium (Wipeout, Nintendo, Tesla-promo
// aesthetic) rather than a generic visualizer that reacts to every tick. The strength gate
// itself (BEAT_STRENGTH_THRESHOLD = 0.5) lives in the controller, which sets car.beatFires;
// the renderer simply reads that flag to gate its transient gestures (FOV/shake/indicator).
// Anticipatory look-ahead: the camera aims this far down the track ahead of the car so
// it reads upcoming terrain *before* the car visually commits — a "smart autopilot"
// feel. Scales up with speed (whichever is larger).
const LOOK_AHEAD_DISTANCE = 15 // metres ahead the camera looks (min; grows with speed)
// Anticipatory banking: when the upcoming centerline curves, the camera leans into the
// turn (rolls about its forward axis) by up to this many degrees, like a skilled driver.
const CAMERA_BANKING_ANGLE_MAX = 12 // max camera roll (degrees) into a hard upcoming curve
const CAMERA_BANKING_ANGLE_DEADZONE = 4 // below this much upcoming turn (deg) we don't bank
const CAMERA_BANKING_LERP = 0.08 // per-frame lerp toward the target roll (smooth, never snaps)
// Shared local-forward axis for the camera roll (view-space -Z). Reused each frame to
// keep the banking math allocation-free.
const ROLL_AXIS = new THREE.Vector3(0, 0, -1)

// Mood-driven camera tuning (iteration 2). The drop-entry FOV expansion layers on TOP
// of the beat-sync envelope so the camera reacts to both rhythm (fast, per-beat) and the
// music's emotional peaks (slow, per-section). The old bloom/sky-hue mood bindings were
// deleted with the synthwave post stack (Watercolour Speed rip-out).
const FOV_DROP_PUNCH = 6 // extra degrees at full drop intensity (cinematic expand)

// Cinematic drop-moment choreography (iteration 9). When the controller's drop-focus
// state machine engages (gameState.isFocusedOnDrop), the chase camera pulls back and the
// FOV widens together as one gesture, framing the accelerating car against the vista like
// an automotive promo cut. The camera pull-back is driven by gameState.cameraDepthScale
// (the controller-smoothed 0.9..1.2 multiplier) applied to the base chase distance; the
// extra FOV is a complementary widening bound to the SAME normalized depth excess, so the
// two always move in concert. On the rising edge of the focus flag the camera orbit angle
// is snapped square (one frame) so the car is framed head-on during the moment.
const BASE_CAMERA_DISTANCE = 4.2 // resting chase distance behind the car (units) — pulled in (was 8) so the kart commands the frame as the hero subject (~1/3 frame height)
const FOV_DROP_BOOST_MAX = 7 // extra degrees of FOV at full camera pull-back (6-8° band)
const CAMERA_DEPTH_LERP = 0.12 // per-frame ease of the applied depth toward cameraDepthScale

// --- Off-centre diagonal composition (Watercolour Speed B5, STYLE_SPEC §6 "Motion &
// composition" + §5). The block-in's dead-centre one-point stack of sun + sword + vanishing
// point is the FIRST thing the spec breaks: the frame must read as an OFF-CENTRE moving
// Sienkiewicz, not a centred one-point racer. We achieve this WITHOUT moving any obstacle
// (their lanes are the planner's, immutable) — purely by RE-FRAMING the chase camera so the
// road's vanishing point sits ~30% off the vertical centerline on a raking diagonal:
//
//   1) COMPOSE_YAW: a PERSISTENT camera-POSITION orbit yaw added on top of the lane-driven
//      orbit so the camera views the road/car from a raking 3D angle (we see its side, not a
//      flat head-on). Folded into the same cameraOrbitAngle machinery the lane lerp uses.
//   2) COMPOSE_LOOK_YAW: a fixed yaw of the OPTICAL AXIS (the look DIRECTION rotated about the
//      up axis), which is what actually slides the road's vanishing point off the vertical
//      centre. The road's parallel edges converge where the camera's forward points relative to
//      the road's forward; a constant axis yaw moves that convergence a STABLE amount (a
//      near-target world translation instead saturates/overshoots — the target is only ~15m
//      out). The obstacles, sitting at lane positions along that road, therefore ENTER THE
//      FRAME along the same raking diagonal as the road sweeps toward the off-centre VP —
//      "obstacles on the diagonal" satisfied by framing, not by relocation.
//   3) COMPOSE_PITCH: a small fixed upward tilt of the same optical axis so the horizon/VP
//      rides off the vertical centre too (the diagonal RAKES, not just pans), and the sun is
//      pulled off-axis in updateSunPlacement so it never stacks on the VP.
//
// The bias is constant (the composition is a fixed authored stance) and is folded into the
// SAME cameraOrbitAngle/look-target machinery the lane lerp already uses, so banking and lane
// glides still read on top of it; the velocity-smear/edge passes consume the resulting shaken
// transform unchanged. Measured framing (mid-track, FOV 75): the values below put the road's
// vanishing point ~19% off-centre toward screen-LEFT, the car in the lower-LEFT quadrant
// (~-36%, safely on-screen through lane changes), the pale sun upper-RIGHT (~+40%, clear of the
// VP), and ~65-70% quiet negative space on the RIGHT — an off-centre raking diagonal.
const COMPOSE_YAW = 0.12 // persistent camera-POSITION orbit yaw (rad, ~7°) — a raking 3D viewing angle on the road/car
const COMPOSE_LOOK_YAW = -0.36 // R-FINAL P3: fixed yaw of the optical AXIS (rad, ~20.6°) — re-measured for the 50mm lens (was -0.24). Slides the road's vanishing point further off-centre screen-LEFT so the signature lower-left→upper-right raking diagonal lands, opening deep quiet negative space on the right
const COMPOSE_PITCH = 0.11 // R-FINAL P3: fixed upward tilt of the optical axis (rad, ~6.3°, was 0.05) so the horizon RAKES well off the vertical centre instead of bisecting the frame as a flat band
const COMPOSE_LOOK_OFFSET = 0.4 // R-FINAL P3: lateral world-offset (u) of the look-target along smoothedRight, biasing the aim so the hero kart seats in the LOWER-LEFT quadrant (the off-centre subject anchoring the diagonal) rather than on the vertical centerline. Kept moderate so the kart stays fully on-screen (0.6 clipped it at the edge)
const COMPOSE_SUN_OFFSET = 0.55 // sun lateral placement off the view centre (fraction of sun depth)

// Camera-shake + particle tuning (iteration 3). The shake is a transient,
// non-destructive world-space offset added to the camera each frame and reverted
// the next, so it never accumulates drift. Beats dominate the amplitude (snappy
// punch) while spectral flux adds choppy texture; collisions force a fixed spike.
const SHAKE_FLUX_SCALE = 0.12 // metres of jitter per unit of (amplitude*envelope*osc)
const SHAKE_MAX = 0.15 // hard clamp on per-axis offset (metres) — keeps it tasteful
const SHAKE_FREQUENCY = 10 // primary oscillation Hz (a fast 8-12Hz vibration)
const SHAKE_FREQUENCY_2 = 7 // secondary detune Hz so the shake doesn't read as a pure sine
const SHAKE_DURATION_MS = 400 // envelope length: amplitude eases to 0 over this window
const SHAKE_DECAY = 0.92 // residual offset decay multiplier per frame (clean settle)
const COLLISION_SHAKE_AMPLITUDE = 0.6 // fixed Wipeout-style impact spike
const PARTICLES_PER_DROP_UNIT = 60 // burst count multiplier on drop entry (× dropStrength)
const PARTICLES_PER_COLLISION = 42 // burst count on an obstacle hit (kept below a bloom wash)
const PARTICLE_LIFETIME_DROP = 0.6 // seconds a drop-burst particle lives
const PARTICLE_LIFETIME_COLLISION = 0.5 // seconds a collision-burst particle lives

// Mood-burst warmth keyed off spectral centroid (perceived brightness). The particle
// pool now renders all bursts as tinted near-black pigment spatter and only reads the
// passed colour's warmth (r vs b) to pick the warm/cool near-black ink, so these are
// retinted to the harmony: a cool steel-blue for dim/cool sections, a warm rose for
// bright/hot sections. They no longer drive any glow — just the ink temperature.
const BURST_COLOR_COOL = new THREE.Color(0x6a7aa4) // steel-blue accent -> cool ink
const BURST_COLOR_HOT = new THREE.Color(0xa96276) // rose-magenta accent -> warm ink

// Layers (Watercolour Speed). The synthwave NEON_LAYER (selective-bloom selector) is
// GONE — there is no bloom to select for. LAYER_DEFAULT (0) carries the whole matte
// scene. HERO_LAYER (2) is REPURPOSED as the velocity-smear SHARP mask: the hero car (and
// its sword-adjacent foreground) is tagged onto it so a future VelocitySmearPass can hold
// the car razor-sharp (the one crisp "found" anchor) while the rest of the world streaks
// as a wet directional drag. No object is excluded from the primary render by layer here;
// the camera renders all layers every frame (the mask is consumed by a separate pass).
const LAYER_DEFAULT = 0
const HERO_LAYER = 2

// Aux-target depth far (Watercolour Speed B2). The scene camera runs near=0.1 / far=10000
// for the world geometry, but that range gives a terrible z-distribution that breaks the
// painterly edge (A6) and velocity-smear (A7) reconstruction. So the dedicated depth +
// normal G-buffer pre-pass renders with the far plane TIGHTENED to this value, and the
// edge/smear passes linearise their tDepth sample against the SAME far so the device-depth
// stored in the DepthTexture and the in-shader linearisation agree. Keep this in lock-step
// with the cameraFar the A6/A7 passes are constructed with when they are wired in B3/B4.
const DEPTH_FAR = 2000

// --- B4 per-frame music drivers (Watercolour Speed §6 "music through the medium") --------
// Every painterly driver below expresses the music WITHIN the saturation discipline — a
// longer wet smear, a breath of sheen, a touch more accent chroma, sharper/looser found
// gestures — NEVER a brightness flash or a bloom (there is no bloom). All are smoothed/
// eased so they breathe rather than strobe, matching the codebase's manual-lerp aesthetic.

// Kuwahara sharpness `q` eases DOWN on drops for a looser, WETTER gouache (spec PASS 4:
// "q eases DOWN on drops"). At rest q sits at its authored 12; at full drop intensity it
// relaxes toward ~7 so the strokes broaden and bleed on the emotional peak.
const KUWAHARA_Q_REST = 12 // authored sharpness (crisp-ish strokes at rest)
const KUWAHARA_Q_DROP = 7 // looser/wetter strokes at full dropIntensity
const KUWAHARA_Q_EASE = 0.12 // per-frame lerp toward the drop-driven q target (smooth)

// VelocitySmear "watercolour speed" length (spec PASS 8: smearLen ≈ base*(0.6+0.4*speedMul)
// + beatKick*0.5). speedMultiplier (drop acceleration) lengthens the wet drag; a beat is a
// brief "wet drag" pulse (a transient kick on the smear length), never a flash. uMaxSmear is
// also nudged up a touch on drops so the comet tail can physically reach further.
const SMEAR_BEAT_KICK_MS = 260 // beat "wet drag" pulse window (ms)
const SMEAR_BEAT_KICK_MAX = 0.6 // peak uBeatKick added on a full-strength beat
// R4: looser |velocity| clamps so the wet drag reaches the bolder, longer streak of ref 02 at
// speed/on drops (the comet length is bounded by these; the new uLengthGain in the pass and the
// raw-depth weight do the rest). Still bounded so a stale matrix can't drag the whole screen.
const SMEAR_MAX_REST = 0.062 // hard |velocity| clamp at rest (UV)
const SMEAR_MAX_DROP = 0.095 // looser clamp at full drop so the tail reaches further
const SMEAR_DRIVE_EASE = 0.18 // ease of the smeared uStrength toward its musical target
// A frame whose clamped car-distance jumps more than this (world units) is a seek / rewind /
// tab-throttle re-baseline (mirrors the controller's dt>0.5 @ 50 u/s ⇒ >25u jump): ZERO the
// smear that frame so a stale prev view-projection can't drag the whole screen.
const SMEAR_RESET_DISTANCE_JUMP = 25
// P4 — how far down the centerline (world units) to project the FLOW look-ahead point. ~100u
// (mid of the spec's 80-120) sits well out toward the off-centre vanishing point so the screen
// vector from it to the car is a stable "world rushing past" direction, robust to local jitter.
const FLOW_LOOKAHEAD = 100
// P4 — ease of the smear FLOW direction toward its target each frame (glide through bends, never
// snap the streak direction).
const FLOW_DIR_EASE = 0.12
// P4 — injected track-flow drag gain (UV per the depth-ramped, speed-scaled flow). REST is tuned
// so the streak ≈ SMEAR_MAX_REST at the far ramp at speedMultiplier≈1; DROP opens it so the world
// drags noticeably longer on emotional peaks (the world rushing past harder). Eased toward target.
const FLOW_GAIN_REST = 0.055
const FLOW_GAIN_DROP = 0.085
// P4 — ease of uFlowGain toward its drop target (matches the smear strength ease feel).
const FLOW_GAIN_EASE = 0.18

// PainterlyEdge breakup WIDENS on drops (spec PASS 7: drops widen the breakup threshold so
// MORE found ink appears — the painter pressing harder — never a strength strobe). Mapped
// straight from dropIntensity into the pass's 0..1 `uMusic` (it does the ±15% threshold
// nudge internally). Smoothed so the found/lost rhythm crawls rather than blinking.
const EDGE_MUSIC_EASE = 0.1

// PaintGradeLUT accent-chroma push: on LOUD passages a tiny hue rotation toward rose
// (spec PASS 6 / §6: "a touch more accent chroma … push rose toward S~45 … never hard-swap").
// Kept micro (a few degrees) and eased so the whole frame never snaps. Driven by the louder
// of dropIntensity / a beat envelope so it reads as the accents warming on emphasis.
const HUE_SHIFT_MAX = 0.012 // peak hue rotation (turns) toward rose on a full loud peak
const HUE_SHIFT_EASE = 0.1 // ease toward the loudness-driven hue-shift target

// Treble shimmer tuning (iteration 7, Watercolour Speed restyle). On each high-frequency
// transient the hero car throws a small pigment-spatter burst (the particle pool renders
// it as tinted near-black ink flecks, not glow). Kept tiny + short so it reads as a fast
// flick of spatter, orthogonal to the beat. Colour warmth only picks the ink temperature.
const TREBLE_BURST_COUNT_MIN = 6 // particles at threshold strength
const TREBLE_BURST_COUNT_MAX = 8 // particles at full-strength transient
const TREBLE_BURST_SPEED = 6 // outward fling speed (slower/tighter than drop bursts)
const TREBLE_BURST_LIFETIME = 0.25 // seconds — a quick flick, not a lingering plume

// "Watercolour Speed" harmony palette (STYLE_SPEC §2, pixel-measured from ref 02). These
// are the literal driver values for the FLAT MATTE materials, lighting and fog. The grays
// are TINTED toward the rose/steel axis — never neutral RGB-equal gray — and nothing here
// exceeds ~45% saturation except the obstacle signal-red. The whole saturated synthwave
// ANALOGOUS_PALETTE (teal/cyan/magenta sunset) was deleted with the rip-out; every surface,
// light, fog and accent the camera renders is now drawn from HARMONY.
const HARMONY = {
  paperPutty: new THREE.Color(0xd9d6ce),   // #1  lightest value / sun core / highlight cap
  warmCream: new THREE.Color(0xede7d8),     // #2  cold-press substrate tint
  steelVioletField: new THREE.Color(0xa7a3b1), // #3 DOMINANT neutral; sky upper, ambient, fog
  litSteelBlue: new THREE.Color(0xb8bbce),  // #4  cool sky band lower / cool reflected light
  roseGrayField: new THREE.Color(0xceb9b9), // #5  warm desaturated ground/horizon glaze
  sandRoad: new THREE.Color(0xc9b49e),      // #6  road surface — the desaturated "sand" bridge
  bodyVioletGray: new THREE.Color(0x9f939e), // #7 hero car albedo on lit faces
  bodyShadowViolet: new THREE.Color(0x706675), // #8 shadow side of the car
  deepBodyNearBlack: new THREE.Color(0x2c2a38), // #9 darkest the car may reach (not black)
  steelBlueAccent: new THREE.Color(0x6a7aa4), // #11 cool accent / cool rim
  roseMagentaAccent: new THREE.Color(0xa96276), // #12 primary hot accent
  warmSienna: new THREE.Color(0xc59076),    // #13 warm bridge / desaturated warm key light
  petrolTeal: new THREE.Color(0x48677d),    // #14 cool shadow whisper / road-edge in shade
  signalRed: new THREE.Color(0xd6443b),     // #15 the single saturated obstacle hit
  inkCool: new THREE.Color(0x20211c),       // #16 found-edge dark accents (cool-lit)
  inkWarm: new THREE.Color(0x1e1b22)        // #17 found-edge dark accents (warm-side)
}

// --- LIGHT colours (NOT surface colours) --------------------------------------------------
// A light's colour MULTIPLIES the surface albedo, so to lift the flat matte field/road to the
// luminous MID-KEY of ref 02 (target lit value ~0.72–0.82) the lights must be NEAR-WHITE,
// merely TINTED toward the harmony hues — a palette swatch used as a light colour would also
// darken the result. These carry the warm-light / cool-shadow TEMPERATURE split at a high
// level so the gouache reads through hue, not through a low key.
// R-FINAL P1 — RESTORE VALUE STRUCTURE AT THE SOURCE. Round 1 flat-flooded the scene into a
// uniform mid-key wash (no form shadow), starving every downstream pass. The fix is a real
// KEY+FILL split: a strong OBLIQUE warm directional makes Lambert falloff (form shadow + a
// full value range), while a now-DIM cool ambient/hemisphere only keeps the SHADOW side
// luminous (steel-violet) instead of black — so darks come from shadow/accents and LIT
// surfaces stay bright. The fill colours are pulled to the literal shadow swatches (#A7A3B1
// steel-violet ambient, #B8BBCE cool ground bounce) so the shadow side reads cool while the
// key tints the lit side warm — the warm-light / cool-shadow temperature split of ref 02.
const LIGHT_SKY_COOL = new THREE.Color(0xb3c4ec)    // hemisphere sky term — SATURATED cool steel-blue (b>>r) so up-facing shadow fields read decisively COOL, balancing the warm key
const LIGHT_GROUND_WARM = new THREE.Color(0x96a4d0) // hemisphere ground bounce — saturated cool steel-blue (b>>r), cool-shadow underside
const LIGHT_AMBIENT_COOL = new THREE.Color(0x8290c4) // ambient floor — saturated steel-blue shadow fill (b>>r); pushes shadowed faces decisively COOL (the cool half of the temp split)
const LIGHT_KEY_WARM = new THREE.Color(0xf2dcc6)    // directional KEY — warm sienna; now the dominant form-shaper

export class ThreeScene {
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  // Single matte post chain (Watercolour Speed B1). For now it is just RenderPass ->
  // OutputPass (ACES tone-map + sRGB); the synthwave two-composer bloom/neon/CA/SMAA/
  // vignette/grain stack was ripped out. The painterly Kuwahara/pigment/LUT/edge/smear/
  // paper passes (Track A modules) are wired in a later wave; B1 leaves the scene a flat
  // matte tinted-gray base ("unfinished paint").
  private composer: EffectComposer
  // --- Aux G-buffers (Watercolour Speed B2) -------------------------------------------
  // A single dedicated pre-pass (renderAuxTargets) renders the whole scene ONCE per frame
  // with scene.overrideMaterial = MeshNormalMaterial into this half-float RGBA target,
  // producing BOTH aux buffers the painterly stack needs from one render:
  //   - normalTarget.texture  : view-space normals packed n*0.5+0.5 in RGB (AUX A) -> the
  //                             geometric crease/silhouette half of PainterlyEdge (A6).
  //   - sceneDepthTexture     : a perspective DepthTexture attached to that same target,
  //                             captured with the camera far TIGHTENED to DEPTH_FAR so the
  //                             z-distribution is usable -> tDepth for PainterlyEdge (A6)
  //                             and VelocitySmear (A7).
  // Owning a dedicated pre-pass (rather than fishing the depth out of EffectComposer's
  // ping-ponged renderTarget1/2, whose identity flips with the swapping pass count) makes
  // tDepth/tNormal DETERMINISTIC and decoupled from the composer's internal buffer swaps,
  // which is exactly what the A6/A7 modules expect (they take the textures as wired
  // uniforms). NearestFilter + half-float so normals/depth are read crisp, not bilinearly
  // smeared. Both are reallocated to the drawing-buffer resolution in resize().
  private normalTarget: THREE.WebGLRenderTarget
  private sceneDepthTexture: THREE.DepthTexture
  // Reused override material for the normal pre-pass (allocation-free per frame). Flat-
  // shaded view normals; the pass writes depth into the attached DepthTexture for free.
  private normalMaterial: THREE.MeshNormalMaterial
  // --- Painterly post stack (Watercolour Speed B3) ------------------------------------
  // The Track-A passes added to `composer` in STYLE_SPEC §3 order. PreBlur softens the
  // tone-mapped frame; the structure-tensor trio runs as a MANUAL half-res side-chain
  // (see buildPainterlyChain) into `tensorTargetA/B` (RGBA16F) so it can target a float
  // half-res buffer and NOT disturb the main colour buffer Kuwahara samples; Kuwahara
  // (KEYSTONE) reads the PreBlur colour + the blurred tensor; pigment/LUT/edge/smear/paper
  // finish the gouache look. Held as fields so resize() can update every resolution/texel/
  // tensorTexel uniform in drawing-buffer pixels and B4 can drive the music uniforms.
  // Definite-assignment (`!`): all ten are assigned in buildPainterlyChain(), invoked from
  // the constructor, which TS's flow analysis can't trace through the method boundary.
  private preBlurPass!: ShaderPass
  private structureTensorPass!: ShaderPass
  private tensorBlurHPass!: ShaderPass
  private tensorBlurVPass!: ShaderPass
  private kuwaharaPass!: ShaderPass
  private pigmentPass!: ShaderPass
  private paintGradePass!: ShaderPass
  private painterlyEdgePass!: ShaderPass
  private velocitySmearPass!: ShaderPass
  private substratePaperPass!: ShaderPass
  // Owned HALF-RES RGBA16F float targets for the structure-tensor side-chain. The tensor
  // packs (Jxx, Jyy, Jxy) which are SQUARED/SIGNED gradients (>1, ±) so an 8-bit target
  // would band the stroke directions — float storage is mandatory. Two targets ping-pong
  // the separable blur (StructureTensor->A, blurH A->B, blurV B->A); A's texture is the
  // final blurred tensor wired into Kuwahara/PainterlyEdge. Half-res because orientation is
  // low-frequency; bilinear upscale via `tensorTexel` is free. Reallocated in resize().
  private tensorTargetA: THREE.WebGLRenderTarget
  private tensorTargetB: THREE.WebGLRenderTarget
  // 1x1 placeholder for VelocitySmear's hero `tCarMask` — bound at construction so the sampler
  // is never unbound before the real mask target exists. Once carMaskTarget is allocated, the
  // smear reads that instead (see renderCarMask). Black (.r = 0) => "streakable world".
  private carMaskPlaceholder: THREE.DataTexture
  // R4: the real HERO_LAYER sharp-mask for VelocitySmear. A HALF-RES target into which only the
  // hero objects (car + sheen + sword obstacles + beat indicator + particles, all tagged
  // HERO_LAYER) are rendered FLAT WHITE on black each frame, with the SAME shaken camera the
  // colour frame uses. The smear samples it (smoothstep'd) and zeroes velocity where it is lit,
  // so the kart stays the one crisp FOUND anchor inside the streaking world (spec PASS 8 / §6).
  // Half-res + LinearFilter gives a softly feathered silhouette (desirable — no hard mask cut).
  private carMaskTarget!: THREE.WebGLRenderTarget
  // Flat unlit WHITE override for the mask pass (fog disabled so the far hero stays solid white).
  private maskMaterial!: THREE.MeshBasicMaterial
  // Scratch colour to save/restore the renderer clear colour around the mask render (alloc-free).
  private maskClearScratch = new THREE.Color()
  private roadMesh: THREE.Mesh | null = null
  // Cached, immutable base vertex positions of the road, captured once at setTrack
  // (iteration 8). The per-frame spectral elevation morph reads from these so it always
  // displaces relative to the original authored terrain shape rather than accumulating
  // drift frame-to-frame. Layout is the flat [x,y,z, x,y,z, ...] BufferAttribute array.
  private baseRoadPositions: Float32Array | null = null
  // Smoothed spectral-energy elevation amplitude (iteration 8). Lerped toward a target
  // derived from spectral centroid (brightness) + flux (volatility) each frame so the
  // road's musical undulation swells/settles fluidly instead of snapping. Read-only-ish
  // mood input; never mutates game state. Phase of the travelling wave is `roadMorphPhase`.
  private roadMorphAmplitude = 0
  private roadMorphPhase = 0
  private carMesh: THREE.Group | null = null
  private trackData: TrackData | null = null
  private skyMesh: THREE.Mesh | null = null
  private sunMesh: THREE.Mesh | null = null
  private groundMesh: THREE.Mesh | null = null
  private beatIndicator: THREE.Sprite | null = null
  private beatIndicatorMaterial: THREE.SpriteMaterial | null = null
  private trebleMeshes: THREE.Object3D[] = []
  private swordTemplate: THREE.Object3D | null = null
  private swordTemplatePromise: Promise<THREE.Object3D | null> | null = null
  private startTime = performance.now()
  private cameraOrbitAngle = 0
  // Cinematic drop-moment state (iteration 9). `appliedDepthScale` eases toward the
  // controller's gameState.cameraDepthScale so the camera pull-back glides; `prevFocused`
  // tracks the focus flag to detect its rising edge (snap orbit square on drop entry).
  private appliedDepthScale = 1
  private prevFocused = false
  // Smoothed camera bank/roll (radians, iteration 6). Lerped toward a target derived
  // from the curvature of the upcoming track centerline so the camera leans into turns.
  private cameraRoll = 0
  private smoothedCarPosition = new THREE.Vector3()
  private smoothedCarForward = new THREE.Vector3(0, 0, 1)
  private carOrientation = new THREE.Quaternion()
  private carVerticalVelocity = 0
  private carVerticalOffset = 0
  private lastTrackHeight = 0
  private lastFrameTime: number | null = null
  private lastFrameDelta = 0
  private lastNodeIndex = 0
  private carTemplate: THREE.Object3D | null = null
  private carTemplatePromise: Promise<THREE.Object3D | null> | null = null
  private collisionCallback: (() => void) | null = null
  private lastCollisionTime = 0
  // GPU particle system for drop + collision bursts (iteration 3). Public so the
  // controller can fire drop-entry bursts; the renderer fires collision bursts.
  readonly particlePool: ParticlePool
  // Residual per-frame shake offset, decayed by SHAKE_DECAY so any leftover motion
  // settles to zero cleanly when the shake envelope expires (no permanent drift).
  private shakeResidual = new THREE.Vector3()
  // The exact offset added to the camera this frame; subtracted back after render
  // so the shake is non-destructive and never accumulates into the chase lerp.
  private shakeOffset = new THREE.Vector3()
  // Scratch basis vectors reused each frame to keep the shake math allocation-free.
  private shakeRight = new THREE.Vector3()
  private shakeUp = new THREE.Vector3()
  private shakeFwd = new THREE.Vector3()

  // --- B4 car-sheen registry + per-frame music-driver state ---------------------------
  // The hero car's helmet-shine materials (A8 CarSheenMaterial), patched in applyPalette-
  // ToModel(isPlayer) / buildFallbackCar. This REUSES the freed carEmissiveMaterials slot:
  // the deleted synthwave emissive-scaling loop is replaced by the per-frame sheen breath
  // (updateCarSheen drives uSheenStrength ≈ 0.45 + beat*0.5 + centroid*0.25, smoothed). The
  // list is cleared whenever the car group is rebuilt (createCar / GLB swap) so disposed
  // fallback materials never linger.
  private carSheenMaterials: CarSheenMaterial[] = []
  // Reused view-space sheen direction (allocation-free). Rebuilt each frame from a fixed
  // up-and-toward-camera base biased by the camera bank/roll so the broad lobe "rolls"
  // across the body as the car leans (spec §4: the shine rolls on banking).
  private sheenDir = new THREE.Vector3(0.35, 0.8, 0.45)
  // Smoothed Kuwahara sharpness q (eased toward KUWAHARA_Q_REST..DROP by dropIntensity).
  private smoothedKuwaharaQ = KUWAHARA_Q_REST
  // Smoothed velocity-smear master + edge-breakup music + LUT hue-shift, all eased so the
  // medium expresses the music as a slow breath, not a strobe.
  private smoothedSmearStrength = 0
  private smoothedEdgeMusic = 0
  private smoothedHueShift = 0
  // P4 — eased injected-flow gain (opens on drops so the world drags longer on peaks).
  private smoothedFlowGain = FLOW_GAIN_REST
  // Previous-frame clamped car distance, to detect a seek/rewind/tab-throttle re-baseline
  // (a large jump) and ZERO the smear that frame. null until the first frame after a track
  // (re)load — that first frame is always treated as a reset.
  private prevCarDistance: number | null = null
  // Cached SHAKEN view-projection of the previous frame, fed to VelocitySmear's uPrevViewProj
  // (copied AFTER render so it is the exact transform the colour frame was rendered with).
  // hasPrevViewProj guards the first frame (no valid previous matrix yet → smear reset).
  private prevViewProj = new THREE.Matrix4()
  private hasPrevViewProj = false
  // Scratch view-projection matrices reused each frame (allocation-free).
  private curViewProj = new THREE.Matrix4()

  // P4 — scratch state for the per-frame velocity-smear FLOW direction derivation (the screen-
  // space direction of the track rushing past, injected as a drag floor). Reused each frame so
  // the projection of the ahead-point + the car's clip position allocates nothing. uFlowDir is
  // eased toward its target so the streak direction never snaps through sharp bends.
  private flowAheadPoint = new THREE.Vector3()
  private flowAheadClip = new THREE.Vector4()
  private flowCarClip = new THREE.Vector4()
  private smoothedFlowDir = new THREE.Vector2(0, 0)

  constructor(canvas: HTMLCanvasElement) {
    // Ensure canvas has dimensions
    if (!canvas.width || !canvas.height) {
      canvas.width = canvas.clientWidth || window.innerWidth
      canvas.height = canvas.clientHeight || window.innerHeight
    }

    const width = canvas.width
    const height = canvas.height

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false
    })
    this.renderer.setSize(width, height, false)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    // Clear to the steel-violet field colour so any gap reads as paper field, not black.
    this.renderer.setClearColor(HARMONY.steelVioletField.getHex(), 1)

    // ACES filmic tone mapping + sRGB output. OutputPass performs the tone-map / colour-
    // space conversion at the end of the composer chain (the LDR boundary the painterly
    // passes will sit after); we set it on the renderer so OutputPass picks it up.
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    // ACES is a filmic HDR curve that deliberately CRUSHES mids and rolls highlights; a
    // gouache target is an LDR, mostly-mid-key image. R-FINAL P1 drops exposure 1.55 -> 1.15:
    // round 1 had lifted it so high the whole frame floated into the light half (p10..p90 ~0.60..
    // 0.70, no darks). With the new strong oblique KEY + dim cool FILL doing the value work, a
    // lower exposure lets ACES roll the lit highlights softly while the shadow side settles into
    // the real darks ref 02 has — a full value range, not a flat bright wash. The downstream
    // PaintGradeLUT then reaches its dark/cool ramp stops that were previously never sampled.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.22

    // Scene
    this.scene = new THREE.Scene()

    // Camera
    const aspect = width / height || 1
    this.camera = new THREE.PerspectiveCamera(
      BASE_FOV,
      aspect,
      0.1,
      10000
    )
    // The camera renders ALL layers every frame (the whole matte world). HERO_LAYER (2)
    // is now only a SHARP-mask tag consumed by a future velocity-smear pass, not a render
    // filter, so we never mask the camera here.
    this.camera.layers.enableAll()

    // Painterly post pipeline (Watercolour Speed B3). The composer renders, tone-maps
    // (OutputPass = the LDR boundary), then runs the full Track-A gouache stack:
    //   RenderPass -> OutputPass -> PreBlur -> [StructureTensor -> TensorBlur x2 (side-chain
    //   into a half-res RGBA16F tensor target)] -> Kuwahara -> WatercolourPigment ->
    //   PaintGradeLUT -> PainterlyEdge -> VelocitySmear -> SubstratePaper.
    // The synthwave bloom/neon-isolation/CA/SMAA/vignette/grain stack (and the second
    // offscreen composer) were ripped out in B1. pixelRatio is CAPPED at 2 (perf budget).
    // The painterly passes are wired in buildPainterlyChain() below, AFTER the aux/tensor
    // targets are allocated (the edge/smear passes consume the depth+normal G-buffers and
    // Kuwahara consumes the owned tensor target).
    const cappedDpr = Math.min(window.devicePixelRatio, 2)
    this.composer = new EffectComposer(this.renderer)
    this.composer.setSize(width, height)
    this.composer.setPixelRatio(cappedDpr)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.composer.addPass(new OutputPass())

    // --- Aux G-buffers (Watercolour Speed B2): DepthTexture + normal G-buffer -----------
    // Allocate at the DRAWING-BUFFER resolution (logical size x capped DPR) so the depth /
    // normal targets line up 1:1 with the composer's colour target the painterly passes
    // sample alongside them. A perspective DepthTexture (DepthFormat / UnsignedInt /
    // NearestFilter by default) is attached to a half-float RGBA normal target so one
    // override-material pre-pass fills both. The normal target is NearestFilter half-float
    // (view normals are signed and must not be bilinearly blended at silhouettes).
    const pixelRatio = Math.min(window.devicePixelRatio, 2)
    const bufW = Math.floor(width * pixelRatio)
    const bufH = Math.floor(height * pixelRatio)
    this.sceneDepthTexture = new THREE.DepthTexture(bufW, bufH)
    this.sceneDepthTexture.type = THREE.UnsignedIntType
    this.sceneDepthTexture.minFilter = THREE.NearestFilter
    this.sceneDepthTexture.magFilter = THREE.NearestFilter
    this.normalTarget = new THREE.WebGLRenderTarget(bufW, bufH, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: this.sceneDepthTexture
    })
    this.normalTarget.texture.name = 'ThreeScene.normalGBuffer'
    // Flat-shaded view normals (n*0.5+0.5 in RGB). Reused every frame as the scene override
    // material; writes depth into the attached DepthTexture for free.
    this.normalMaterial = new THREE.MeshNormalMaterial()

    // --- Tensor side-chain targets (Watercolour Speed B3) -------------------------------
    // HALF the drawing-buffer resolution (orientation is low-frequency) and RGBA16F float
    // (the tensor's squared/signed gradient components cannot survive an 8-bit round-trip).
    // LinearFilter so Kuwahara/PainterlyEdge bilinearly upscale the half-res tensor for free.
    // Two targets ping-pong the separable blur. Floor to >=1 so a tiny window never makes a
    // 0-sized target.
    const halfW = Math.max(1, Math.floor(bufW / 2))
    const halfH = Math.max(1, Math.floor(bufH / 2))
    const tensorOpts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false
    }
    this.tensorTargetA = new THREE.WebGLRenderTarget(halfW, halfH, tensorOpts)
    this.tensorTargetA.texture.name = 'ThreeScene.tensorA'
    this.tensorTargetB = new THREE.WebGLRenderTarget(halfW, halfH, tensorOpts)
    this.tensorTargetB.texture.name = 'ThreeScene.tensorB'

    // 1x1 black placeholder for VelocitySmear's hero mask (see field doc). NoColorSpace so
    // it is read as a raw .r value, not sRGB-decoded.
    this.carMaskPlaceholder = new THREE.DataTexture(
      new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType
    )
    this.carMaskPlaceholder.colorSpace = THREE.NoColorSpace
    this.carMaskPlaceholder.needsUpdate = true

    // R4: the real HERO_LAYER sharp-mask target (half-res; the silhouette only needs to gate the
    // smear, and a soft linear-upscaled edge is exactly what we want so the car has no hard mask
    // cut). NoColorSpace + Linear filtering; no depth needed (hero objects are opaque and we only
    // want coverage). Reallocated in resize().
    this.carMaskTarget = new THREE.WebGLRenderTarget(halfW, halfH, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      colorSpace: THREE.NoColorSpace
    })
    this.carMaskTarget.texture.name = 'ThreeScene.carMask'
    // Flat unlit WHITE; fog OFF so a far hero (a sword entering at distance) still masks solid.
    this.maskMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false })

    // Build + addPass the painterly Track-A stack now that the colour composer, the depth/
    // normal G-buffers and the tensor targets all exist. Sets every resolution/texel/
    // tensorTexel uniform in drawing-buffer pixels and wires the cross-pass textures.
    this.buildPainterlyChain(bufW, bufH, halfW, halfH)

    // Lighting (Watercolour Speed §4): form reads through the warm-light / cool-shadow
    // TEMPERATURE axis, not through saturation. The whole picture must read LUMINOUS and
    // MID-KEY (ref 02) — light putty/rose, airy, mostly quiet light negative space — so the
    // base lit value of the flat matte field/road has to land HIGH (target value ~0.72–0.82),
    // not the muddy dark brown the old low key produced. Because a light's colour MULTIPLIES
    // the surface albedo, lifting to a high key needs near-white TINTED lights (a palette
    // swatch as a light colour would also dim the result); the hue still leans the
    // warm-light / cool-shadow split, the LEVEL just sits where a gouache mid-key wants it.
    //
    // A HemisphereLight is the airy base: it lights up-facing surfaces (the ground/road,
    // whose normals point +Y) strongly and EVENLY from a cool sky tint, falling to a warm
    // ground bounce — exactly the soft, fill-dominant illumination of a flat gouache field,
    // and it cures the old foreground-darkening (a near-horizontal key grazing an up-facing
    // plane starved the near ground; only distance-fog was lifting the far field).
    // R-FINAL P1: the hemisphere is now the dim COOL FILL (steel sky over a cool ground bounce),
    // not the overall lift. Dropped 1.45 -> 0.35 so it only keeps the shadow side luminous; the
    // oblique directional below supplies the actual key + form shadow. (Too high here re-floods
    // the scene back to the flat mid-key wash that starved every pass.)
    const hemiLight = new THREE.HemisphereLight(
      LIGHT_SKY_COOL,    // cool steel-violet sky term -> luminous cool shadow on up-facing fields
      LIGHT_GROUND_WARM, // COOL steel-blue ground bounce -> cool underside (cool-shadow half)
      0.6
    )
    this.scene.add(hemiLight)

    // R-FINAL P1: a DIM cool steel-violet ambient floor (0.55 -> 0.22). It must NOT lift the whole
    // scene (that was the round-1 flat-flood); it only guarantees the deepest shadow side reads as
    // a luminous cool steel-violet rather than crushing to black — the cool half of the split.
    const ambientLight = new THREE.AmbientLight(LIGHT_AMBIENT_COOL, 0.28)
    this.scene.add(ambientLight)

    // R-FINAL P1: the oblique warm sienna KEY is now the DOMINANT light (0.85 -> 1.6). A strong
    // raking N·L manufactures the per-pixel value spread (form shadow + a full value range +
    // a warm lit side) that re-arms the whole downstream stack at once — the master fix. Lit
    // surfaces go bright/warm; faces turned from it fall to the dim cool fill above (the darks).
    const directionalLight = new THREE.DirectionalLight(LIGHT_KEY_WARM, 1.75)
    directionalLight.position.set(-6, 13, 9)
    this.scene.add(directionalLight)

    // A soft warm catch near the car so the hero body lifts off the field — trimmed (0.45 -> 0.30)
    // so it tints the near body warm without flat-filling away the form shadow P1 just restored.
    const pointLight = new THREE.PointLight(LIGHT_KEY_WARM, 0.3, 120)
    pointLight.position.set(0, 5, 2)
    this.scene.add(pointLight)

    // Create the matte painterly background
    this.createBackground()

    // GPU pigment-spatter particle pool. Added to the scene once; emits stamp into
    // pre-allocated buffers so there is no per-frame GC. Tagged onto HERO_LAYER as part of
    // the foreground sharp-mask (the future velocity smear holds the spatter crisp with the
    // car). No NEON_LAYER tag — there is no bloom to select for.
    this.particlePool = new ParticlePool(280)
    this.particlePool.points.layers.enable(HERO_LAYER)
    this.scene.add(this.particlePool.points)

    // Create the immersion-preserving beat indicator (a glowing sprite, not HUD text)
    this.createBeatIndicator()

    // Create initial car
    this.createCar().catch(error => {
      console.error('Failed to create car', error)
    })

    // Set default camera position - closer to see the scene better
    this.camera.position.set(0, 3, 8)
    this.camera.lookAt(0, 0, 0)
    this.camera.updateProjectionMatrix()

    // Verify WebGL context
    const gl = this.renderer.getContext()
    if (!gl) {
      console.error('WebGL context not available')
    } else {
      console.log('WebGL context created successfully', {
        width,
        height,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        sceneChildren: this.scene.children.length
      })
    }

    // Do initial render through the composer so tone mapping applies.
    this.composer.render()
  }

  /**
   * Constructs the painterly "Watercolour Speed" Track-A post stack and adds it to the
   * single composer in the EXACT STYLE_SPEC §3 order (after RenderPass + OutputPass):
   *
   *   PreBlur -> [StructureTensor -> TensorBlur(H) -> TensorBlur(V)] -> Kuwahara ->
   *   WatercolourPigment -> PaintGradeLUT -> PainterlyEdge -> VelocitySmear -> SubstratePaper
   *
   * The structure-tensor trio is a MANUAL SIDE-CHAIN: its three ShaderPasses sit in the
   * composer's pass list (so the spec's order + addPass contract holds) but their `render`
   * is overridden to (a) render into the owned half-res RGBA16F `tensorTargetA/B` instead of
   * the composer's full-res colour buffer, and (b) set `needsSwap=false` so the main colour
   * buffer — the PreBlur output in readBuffer — is preserved UNTOUCHED for Kuwahara to read
   * as `tDiffuse`. The final blurred tensor (tensorTargetA.texture) is wired into Kuwahara's
   * `tTensor` and PainterlyEdge's flow field. This keeps the tensor float + half-res and the
   * Kuwahara dual-input (PreBlur colour + tensor) correct, while remaining deterministic and
   * independent of EffectComposer's ping-pong buffer identity.
   *
   * Every resolution/texel/tensorTexel uniform is set here in DRAWING-BUFFER pixels; resize()
   * updates the same set. Music-reactive uniforms (Kuwahara `sharpness`, smear `uStrength`/
   * `uBeatKick`, edge `uMusic`, sheen) are left at their static defaults — B4 drives them.
   *
   * @param bufW/bufH  full-res drawing-buffer size in px (width*min(dpr,2)).
   * @param halfW/halfH half-res tensor target size in px.
   */
  private buildPainterlyChain(bufW: number, bufH: number, halfW: number, halfH: number): void {
    const fullTexel: [number, number] = [1 / bufW, 1 / bufH]
    const halfTexel: [number, number] = [1 / halfW, 1 / halfH]

    // PASS 1 — PreBlur: soften the tone-mapped frame so the structure tensor is stable.
    this.preBlurPass = createPreBlurPass({ kernel: '5x5', texel: fullTexel })

    // PASS 2 — StructureTensor (half-res RGBA16F). Samples the FULL-RES PreBlur output, so
    // its Sobel `texel` is the FULL-res texel even though it writes the half-res target.
    this.structureTensorPass = createStructureTensorPass({ texel: fullTexel })

    // PASS 3 — TensorBlur, two separable 1D axes over the half-res tensor (its `texel` is the
    // HALF-res tensor texel). H then V compose into a 2D gaussian (sigma ~2.5).
    this.tensorBlurHPass = createTensorBlurPass({ direction: [1, 0], texel: halfTexel, sigma: 2.5 })
    this.tensorBlurVPass = createTensorBlurPass({ direction: [0, 1], texel: halfTexel, sigma: 2.5 })

    // Override the trio's render() into the owned half-res float side-chain (see method doc).
    // StructureTensor: PreBlur colour (readBuffer) -> tensorTargetA.
    this.structureTensorPass.needsSwap = false
    this.structureTensorPass.render = (renderer, _writeBuffer, readBuffer) => {
      this.structureTensorPass.uniforms.tDiffuse.value = readBuffer.texture
      renderer.setRenderTarget(this.tensorTargetA)
      this.structureTensorPass.fsQuad.render(renderer)
    }
    // TensorBlur H: tensorTargetA -> tensorTargetB.
    this.tensorBlurHPass.needsSwap = false
    this.tensorBlurHPass.render = renderer => {
      this.tensorBlurHPass.uniforms.tDiffuse.value = this.tensorTargetA.texture
      renderer.setRenderTarget(this.tensorTargetB)
      this.tensorBlurHPass.fsQuad.render(renderer)
    }
    // TensorBlur V: tensorTargetB -> tensorTargetA (final blurred tensor lives in A).
    this.tensorBlurVPass.needsSwap = false
    this.tensorBlurVPass.render = renderer => {
      this.tensorBlurVPass.uniforms.tDiffuse.value = this.tensorTargetB.texture
      renderer.setRenderTarget(this.tensorTargetA)
      this.tensorBlurVPass.fsQuad.render(renderer)
    }

    // PASS 4 — Anisotropic Kuwahara (KEYSTONE), full-res. tDiffuse auto-wires to the PreBlur
    // colour (untouched in readBuffer by the non-swapping tensor trio); tTensor is the final
    // blurred half-res tensor. tensorTexel is the half-res texel for the bilinear upscale.
    // Round 2: radius 6 → 7 (the loop cap) for broader gouache strokes, and a LOWER
    // eccentricityClamp (0.6 → 0.48) so the edge-aligned ellipse elongates MORE along contours
    // — the strokes now carry directional brush STRUCTURE (Sienkiewicz gouache sweep), not just
    // an isotropic smooth. q stays 12 at rest (KUWAHARA_Q_REST), easing down on drops.
    this.kuwaharaPass = createAnisotropicKuwaharaPass({
      texel: fullTexel,
      tensorTexel: halfTexel,
      radius: 7,
      sharpness: KUWAHARA_Q_REST,
      // R4: lower ecc (0.48 -> 0.40) so the edge-aligned ellipse elongates MORE along contours,
      // plus the anisoGain/anisoExp/strokeBias brush knobs (factory defaults) that lift the tiny
      // anisotropy of this low-contrast scene into confident DIRECTIONAL gouache strokes.
      eccentricityClamp: 0.40,
      anisoGain: 2.4,
      anisoExp: 0.5,
      strokeBias: 0.6
    })
    this.kuwaharaPass.uniforms.tTensor.value = this.tensorTargetA.texture

    // PASS 5 — WatercolourPigment: wobble + edge-darken + granulate + bleed (resolution px).
    // Round 2: COARSER tooth (paperScale 2.2 → 1.1, larger cells) + lighter granulation so the
    // grain reads as watercolour granulation pooling in the paper, not fine uniform static.
    this.pigmentPass = createWatercolourPigmentPass({
      resolution: [bufW, bufH],
      // R-FINAL P2: finer cold-press tooth (1.1 -> 2.6) so the granulation carries real
      // high-frequency value variance INSIDE an 8x8 footprint (the panel's surface-tooth metric),
      // i.e. actual paper grain in the bright washes, not only a low-frequency brushy mottle.
      paperScale: 2.6,
      // R-FINAL P2: lift pigment granulation 0.17 -> 0.39 (just under the 0.40 "dirt" ceiling)
      // so, paired with the re-pivoted bright-biased bell, the tooth bites where 60-70% of the
      // frame now lives — driving the 8x8 local luma-std up toward ref 02 (the surface-energy fix).
      granulation: 0.39,
      edgeStrength: 0.55
    })

    // PASS 6 — PaintGradeLUT (PALETTE LOCK). Explicitly build the gouache ramp via paintRamp
    // (the factory would default to the same, but constructing it here makes the palette-lock
    // DataTexture an owned, swappable artefact for the B4 drop cross-fade).
    // Round 2: the value-range reshape (blackPoint/whitePoint/contrast) is what gives the
    // frame REAL value contrast — it pulls the scene's darkest forms (under-car, shadow sides,
    // road-in-shade) down into the ramp's deep ink stops while the luminous field stays bright,
    // so the punched darks of ref 02 appear WITHOUT undoing Round 1's mid-key base.
    this.paintGradePass = createPaintGradeLUTPass({
      gradient: buildPaintRamp(),
      // R3: nudge chroma-preserve up (0.22 -> 0.30) so the HERO keeps more of its local hue
      // through the palette lock — specifically so the cool helmet-sheen crest survives as a cool
      // feature (and the obstacle red stays a confident red) instead of being warmed/flattened
      // toward the ramp's bright putty. Still well within the lock (gradeAmount 0.82 holds value).
      // R-FINAL P1: chromaPreserve 0.30 -> 0.42. The LUT ramp is mostly cool/neutral in the mid,
      // so on its own it WASHES the warm sienna road/ground toward neutral gray (median sat crashed
      // to ~0.02, far below the spec's 10-14% floor) AND warms the cool sky — collapsing the
      // warm/cool split into a desaturated monochrome. Preserving more source colour lets BOTH the
      // warm ground and the cool sky/shadows keep their in-palette hue, restoring the split and the
      // tinted-gray saturation. The harmony is still enforced upstream (in-palette albedos + the
      // cool/warm lighting) and by gradeAmount 0.82, so a looser per-pixel lock stays in-key.
      chromaPreserve: 0.42,
      // R-FINAL P1: re-anchor the LUT darks now that the lighting supplies a real value range.
      // blackPoint 0.38 -> 0.42 (more of the shadow side reaches the deep ink stops), contrast
      // 1.32 -> 1.5 (a stronger S-curve so darks deepen and lights stay luminous — value
      // separation, not a flat dim), shadowDepth 1.0 (full reach into the dark ramp stops).
      blackPoint: 0.42,
      // whitePoint 0.96 (P45-APEX: raised from 0.88). The ramp's top stops were just opened toward
      // true paper-white (paintRamp.ts: putty #ECE9E1 ~0.91, apex #F4F4F8 ~0.96). whitePoint sets
      // the input luma that maps to ramp coord 1.0 (the apex), so RAISING it RESERVES the new bright
      // top for ONLY the genuinely-brightest source pixels — the sun's luminous core (pre-LUT luma
      // ~0.94) and the helmet-sheen crest/spark — while the bright negative-space field/sky (pre-LUT
      // ~0.85-0.89) now maps a notch LOWER, into the unchanged rose-gray #DDCBC8 stop (~0.82, mid-
      // key cool). Net: the value scale OPENS at the top (the apex is reachable) without globally
      // brightening — the field stays mid-key and keeps its cool blue band; only the brightest few %
      // climb to the luminous apex. (At 0.88 nothing could exceed ~0.92; the old ramp top capped
      // there anyway, so the picture had no luminous high end — the critique's flagged nit.)
      // KEPT at 0.88: raising it (0.91/0.96) shoved the bright negative-space SKY up out of the
      // ramp's COOL band (pos 0.66..0.84) into the warm rose-gray stop (pos 0.92) — collapsing the
      // warm/cool split (warmCool spiked) and warming the sky to pink. At 0.88 the sky stays cool
      // exactly as round-5 had it; the LUMINOUS APEX now comes ENTIRELY from the opened ramp TOP
      // stops (paintRamp.ts putty 0.96 / paper-white 1.0), which only coord >~0.93 reaches — i.e.
      // ONLY the sun's luminous core (src ~0.94 -> coord 1.0) and the helmet-sheen crest. The mid
      // field (sky/ground, coord <=0.84) is untouched, so nothing globally brightens.
      whitePoint: 0.88,
      // contrast 1.6 (a stronger S-curve about 0.5): deepens the shadow side toward the dark ink
      // stops (more true darks / a wider value std, the remaining P1 gap) while simultaneously
      // pushing the lit side brighter — value SEPARATION, the opposite of a flat dim.
      contrast: 1.6,
      shadowDepth: 1.0,
      // R-FINAL P2: a mild ~7-level posterize turns the smooth tinted value gradients into
      // facetted gouache plateaus with darkened plateau boundaries — the literal signature of
      // gouache, and step-edges the Kuwahara tensor + pigment edge-darken can grab onto.
      posterize: 7.0
    })

    // PASS 7 — PainterlyEdge: flow-XDoG ∪ depth/normal edges, gated, MULTIPLY ink. Consumes
    // the blurred tensor (flow), the depth + normal G-buffers (B2), at drawing-buffer res.
    // cameraFar TIGHTENED to DEPTH_FAR to match the aux depth capture's linearisation.
    // Round 2: the painterly edge is the BIGGEST lever for "reads as a painting". The defaults
    // gated to ~0% on this luminous low-contrast scene; these values loosen the gate to the
    // SMALL contrasts the scene actually has, DILATE the 1px detector scribble into a brush-
    // width calligraphic stroke, and ink the survivors CONFIDENTLY — while the slow breakup
    // keeps most contours LOST (found-here/lost-there like ref 02), not a uniform toon outline.
    this.painterlyEdgePass = createPainterlyEdgePass({
      resolution: [bufW, bufH],
      texel: fullTexel,
      tensorTexel: halfTexel,
      cameraNear: this.camera.near,
      cameraFar: DEPTH_FAR,
      // R-FINAL: inkGain 2.4 -> 2.9 so the FOUND dark-accent strokes (sword/kart silhouettes, the
      // strongest road value edges) ink as DEEPER calligraphic pools — adds the punched darks +
      // local contrast ref 02 has (lifts both true-dark fraction and the 8x8 surface-tooth metric),
      // while the slow breakup still keeps most contours lost (found-here/lost-there, not an outline).
      inkGain: 2.9,
      edgeDilate: 2.0,
      // R3: raise the GEOMETRIC edge thresholds so only BIG depth/normal steps ink. The now-large
      // hero kart has an open frame (seat/engine/struts) whose many fine interior depth+normal
      // steps were inking into a busy black tangle that fought the helmet sheen. Higher thresholds
      // keep the kart's outer silhouette + the sword silhouettes (large steps) and the road/ground
      // VALUE edges (luma XDoG, untouched) — so Rounds 1-2 edge character holds — while the kart's
      // interior reads mostly LOST (spec §4: body contours lost, sheen the one found mark).
      normalThresh: 0.55,
      depthThresh: 1.1,
      // R-FINAL: lower the saliency band (default 0.04..0.20 -> 0.03..0.14) so a few more of the
      // road/ground VALUE edges qualify and ink as distributed dark accents — adding punched-dark
      // mass + local contrast across the mid-field (not just on the hero/sword silhouettes), the
      // last push toward ref 02's dark fraction. The slow breakup still keeps it lost-and-found.
      salLo: 0.03,
      salHi: 0.14,
      // R-FINAL P3: the hero-silhouette shadow-side stroke. heroInkGain 3.5 inks the kart's outer
      // shaded edge as a BOLD confident pool; heroDilate 3.2 gives it real brush weight (a heavier
      // broken stroke = the "finished Sienkiewicz" gesture, and its near-black adds punched-dark
      // mass); lightDir2D is the key light (world ~(-6,13,9)) projected to screen (up-left) so the
      // stroke lands on the shaded side. The mask-boundary gate keeps the interior fully lost.
      heroInkGain: 3.5,
      heroDilate: 3.2,
      lightDir2D: [-0.55, 0.84]
    })
    this.painterlyEdgePass.uniforms.tTensor.value = this.tensorTargetA.texture
    this.painterlyEdgePass.uniforms.useTensor.value = 1
    this.painterlyEdgePass.uniforms.tDepth.value = this.sceneDepthTexture
    this.painterlyEdgePass.uniforms.useDepth.value = 1
    this.painterlyEdgePass.uniforms.tNormal.value = this.normalTarget.texture
    this.painterlyEdgePass.uniforms.useNormal.value = 1
    // R-FINAL P3: feed the HERO_LAYER coverage mask (rendered each frame in renderCarMask, also
    // consumed by the velocity smear) so the hero-silhouette ink term can find the kart's outer
    // edge. The mask's 1->0 boundary IS the silhouette; the interior stays solid white → no
    // interior tangle is revived. (carMaskTarget is allocated above before the passes are built.)
    this.painterlyEdgePass.uniforms.tHeroMask.value = this.carMaskTarget.texture
    this.painterlyEdgePass.uniforms.useHeroMask.value = 1

    // PASS 8 — VelocitySmear: depth + prev/cur view-projection -> asymmetric wet drag, car
    // masked sharp. tDepth from B2; tCarMask is the 1x1 black placeholder until B4 wires the
    // real hero mask + the prev/cur matrices (inert in B3: identity matrices -> zero velocity).
    // cameraFar TIGHTENED to DEPTH_FAR to match the depth capture.
    this.velocitySmearPass = createVelocitySmearPass({
      cameraNear: this.camera.near,
      cameraFar: DEPTH_FAR,
      // P4 — injected track-flow drag gain. Tuned so the streak length ≈ SMEAR_MAX_REST (~0.05-0.06
      // UV) at the far depth ramp at speedMultiplier≈1; uSpeedMul (drops accelerate the car) + the
      // strength master lengthen it on drops. Driven a touch on drops in updatePainterlyMusicDrivers.
      flowGain: FLOW_GAIN_REST
    })
    this.velocitySmearPass.uniforms.uTexelSize.value = new THREE.Vector2(fullTexel[0], fullTexel[1])
    this.velocitySmearPass.uniforms.tDepth.value = this.sceneDepthTexture
    // R4: the real HERO_LAYER sharp-mask (rendered each frame in renderCarMask). The kart + sword
    // obstacles stay crisp inside the streaking world. (carMaskPlaceholder remains the safe fallback.)
    this.velocitySmearPass.uniforms.tCarMask.value = this.carMaskTarget.texture

    // PASS 9 — SubstratePaper (FINAL): frame-anchored paper granulation + tooth-light +
    // micro-distort, Pegtop soft-light, folded dither (drawing-buffer resolution).
    // Round 2: a COARSER cold-press tooth (paperScale 2.6 → 1.25, low-frequency paper grain)
    // and slightly lighter density/strength so the substrate reads as a watercolour SHEET with
    // big granulating tooth, not the fine uniform sandpaper veil of the R1 frame.
    this.substratePaperPass = createSubstratePaperPass({
      resolution: [bufW, bufH],
      // R-FINAL P2: finer cold-press tooth (1.25 -> 2.6) so the paper grain registers at the
      // 8x8 scale the panel measures (surface energy) while paperAniso still stretches it into
      // directional brush/scumble streaks — fine tooth THROUGH a brushed grain, not sandpaper.
      paperScale: 2.6,
      // R4 BRUSHWORK: a touch more granulation + a stronger sheet so the surface reads as BRUSHED
      // gouache on cold-press paper (ref 02), plus the directional paperAniso stretch that turns
      // the tooth into visible brush/scumble streaks. Stays inside the spec discipline bands
      // (granDensity 0.18-0.35, paperStrength 0.12-0.22) so it's medium, not dirt.
      // R-FINAL P2: more tooth in the bright washes — granDensity 0.30 -> 0.34, paperStrength
      // 0.19 -> 0.21 (both still inside the spec bands 0.18-0.35 / 0.12-0.22, under the "dirt"
      // ceilings) so the cold-press surface reads where most of the frame sits, lifting 8x8 std.
      granDensity: 0.38,
      paperStrength: 0.21,
      paperAniso: 2.8,
      // R-FINAL P2: stronger SIGNED tooth-light (0.04 -> 0.15) — peaks catch warm light, valleys
      // fall to a cool micro-shadow. This is per-pixel high-frequency value variance (real paper
      // fibre catching the raking light), the most direct lever on the 8x8 surface-tooth metric,
      // and it reads as cold-press tooth rather than a flat veil. Still a subtle fibre sheen.
      paperLight: 0.18
    })

    // addPass in the EXACT STYLE_SPEC §3 order.
    this.composer.addPass(this.preBlurPass)
    this.composer.addPass(this.structureTensorPass)
    this.composer.addPass(this.tensorBlurHPass)
    this.composer.addPass(this.tensorBlurVPass)
    this.composer.addPass(this.kuwaharaPass)
    this.composer.addPass(this.pigmentPass)
    this.composer.addPass(this.paintGradePass)
    this.composer.addPass(this.painterlyEdgePass)
    this.composer.addPass(this.velocitySmearPass)
    this.composer.addPass(this.substratePaperPass)
  }

  private createBackground(): void {
    // FLAT MATTE sky dome (Watercolour Speed §5). A quiet tinted-gray vertical gradient:
    // steel-violet #A7A3B1 up top easing to lit steel-blue #B8BBCE near the horizon. NO
    // synthwave 5-band sunset, NO stars, NO emissive glow — just two flat stops lerped by
    // height. The watercolour granulation + paper tooth land in a later post wave; here it
    // is deliberately empty negative space. depthWrite off, toneMapped via OutputPass.
    const skyGeometry = new THREE.SphereGeometry(5000, 32, 32)
    const skyMaterial = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        // R-FINAL P1: BRIGHTEN the sky gradient so the large quiet negative space reads as a
        // LUMINOUS cool field (ref 02's bright upper sky) rather than a mid-gray band. The unlit
        // sky still passes through ACES + the LUT value-reshape, both of which pull it DOWN; with
        // the old #A7A3B1/#B8BBCE inputs (luma ~0.64/0.73) the sky landed ~0.5-0.55 and starved
        // the top of the value range (p90 capped, lightFrac 0). These brighter cool-tinted inputs
        // (b>=r, still in-harmony) survive the curve to a luminous ~0.75-0.85 — the high end of the
        // restored value range — while staying decisively cool to hold the warm/cool split.
        // Sky brightness vs blueness is a direct trade through ACES (a more saturated blue is a
        // DARKER blue, dropping the luminous-field value). These hold the sweet spot: bright enough
        // (luma ~0.72) to keep the negative space LUMINOUS (p90 ~0.78, the top of the value range)
        // yet still decisively cool (b>>r) so the warm/cool split survives.
        topColor: { value: new THREE.Color(0xa9b8ec) },    // bright cool steel-blue sky upper (b>r, luminous)
        horizonColor: { value: new THREE.Color(0xbccbf2) } // bright cool steel-blue sky lower band (b>r, luminous)
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vWorldPosition;
        uniform vec3 topColor;
        uniform vec3 horizonColor;
        void main() {
          // Height 0 at the horizon, 1 at the zenith. A single soft vertical lerp.
          float h = clamp(normalize(vWorldPosition).y * 0.5 + 0.5, 0.0, 1.0);
          vec3 col = mix(horizonColor, topColor, smoothstep(0.0, 0.6, h));
          gl_FragColor = vec4(col, 1.0);
        }
      `
    })

    this.skyMesh = new THREE.Mesh(skyGeometry, skyMaterial)
    this.scene.add(this.skyMesh)

    // Soft achromatic-to-cool luminous DISC (Watercolour Speed §5 "Sun / horizon"): a pale
    // wet bloom of light — paper-putty #D9D6CE core easing to the steel-violet field — with
    // NO scanline bands, NO magenta corona, NO glow/bloom. A low-contrast value lift that
    // dissolves into the sky wash. Normal-blended, matte, soft-edged. Composed off-centre in
    // a later wave (B5). The mottle/granulation lands in the post stack.
    const sunGeometry = new THREE.PlaneGeometry(380, 380, 1, 1)
    const sunMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {
        // R-FINAL P1: brighten the disc core toward the warm-cream "white" (#F2EFE6, luma ~0.94)
        // so it is the frame's LUMINOUS high-value anchor (ref 02's bright wet bloom of light) and
        // actually clears the LUT whitePoint into the light ramp stops — supplies lightFrac>0 and
        // the top of the value range, balancing the restored darks. Still a soft wet disc, no glow.
        coreColor: { value: new THREE.Color(0xf2efe6) },         // bright warm-cream luminous core
        edgeColor: { value: HARMONY.litSteelBlue.clone() }       // #4 dissolves into the cool sky band
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        uniform vec3 coreColor;
        uniform vec3 edgeColor;
        void main() {
          float dist = length(vUv - 0.5);
          // Soft pale disc: putty core -> steel-violet rim, fully faded before the
          // inscribed-circle radius so the quad edge never clips a hard box.
          float core = smoothstep(0.42, 0.0, dist);   // 1 at centre -> 0 by the rim
          float alpha = smoothstep(0.48, 0.12, dist); // soft wet falloff, gone by 0.48
          if (alpha < 0.01) discard;
          vec3 col = mix(edgeColor, coreColor, core);
          gl_FragColor = vec4(col, alpha);
        }
      `
    })
    this.sunMesh = new THREE.Mesh(sunGeometry, sunMaterial)
    this.sunMesh.position.set(0, 30, -250)
    this.sunMesh.renderOrder = 5
    this.sunMesh.frustumCulled = false
    this.scene.add(this.sunMesh)

    // Fog retinted to the steel-violet FIELD colour (§3) so the far road/ground dissolve
    // into paper field, not into black or a synthwave magenta haze (lost horizon).
    this.scene.fog = new THREE.Fog(HARMONY.steelVioletField.getHex(), 120, 1500)

    // The synthwave neon floor GRID is deleted (no bright cyan lines). The ground plane
    // (built below) is the warm rose-gray field that streams beneath the car.

    // Warm rose-gray FIELD ground (§5 "Ground"): #CEB9B9, the warm counterweight to the
    // cool steel sky, a desaturated matte wash. FLAT MATTE — no emissive, no metalness, no
    // envMap. Snap-follows the car (updateFloorFollow) so the field streams beneath it. Y
    // still effectively follows the road's RMS hills via the road mesh; the ground is the
    // quiet field it sits on, dissolving into the field-tinted fog at distance.
    const groundGeometry = new THREE.PlaneGeometry(4000, 4000)
    const groundMaterial = new THREE.MeshStandardMaterial({
      color: HARMONY.roseGrayField.clone(),
      roughness: 0.95,
      metalness: 0.0
    })
    const ground = new THREE.Mesh(groundGeometry, groundMaterial)
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.2
    ground.layers.set(LAYER_DEFAULT)
    this.groundMesh = ground
    this.scene.add(ground)
  }

  /**
   * Snap the ground field plane to the car so the matte field streams beneath it instead
   * of being left behind at the world origin (the neon grid that also followed is gone).
   */
  private updateFloorFollow(center: THREE.Vector3): void {
    if (this.groundMesh) {
      this.groundMesh.position.x = center.x
      this.groundMesh.position.z = center.z
    }
  }

  /**
   * Builds the beat indicator: a soft cyan radial-glow sprite pinned to the
   * bottom-right of the view. It is parented to the camera (not the scene) so it
   * stays a fixed on-screen element while remaining a 3D, bloom-affected glow —
   * deliberately NOT HUD text, to preserve synthwave immersion. Each beat the
   * controller records, the sprite punches up in scale + opacity then auto-fades,
   * giving the viewer confirmation that the visuals are rhythm-locked. The glow
   * texture is generated procedurally so no asset download is required.
   */
  private createBeatIndicator(): void {
    const size = 128
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (ctx) {
      const gradient = ctx.createRadialGradient(
        size / 2,
        size / 2,
        0,
        size / 2,
        size / 2,
        size / 2
      )
      // Soft dusty-rose mark (harmony accent #A96276), not a cyan neon glow.
      gradient.addColorStop(0, 'rgba(169, 98, 118, 0.95)')
      gradient.addColorStop(0.4, 'rgba(169, 98, 118, 0.6)')
      gradient.addColorStop(1, 'rgba(169, 98, 118, 0)')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, size, size)
    }

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace

    const material = new THREE.SpriteMaterial({
      map: texture,
      color: HARMONY.roseMagentaAccent,
      transparent: true,
      opacity: 0.0,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false
    })

    const sprite = new THREE.Sprite(material)
    // Place in the bottom-right corner of the near view plane. Parenting to the
    // camera keeps it screen-locked; the small z keeps it in front of everything.
    sprite.position.set(0.62, -0.42, -1)
    sprite.scale.set(0.12, 0.12, 0.12)
    sprite.renderOrder = 999
    sprite.frustumCulled = false
    // Foreground element -> the smear sharp-mask layer (no NEON_LAYER; there is no bloom).
    sprite.layers.enable(HERO_LAYER)

    this.beatIndicator = sprite
    this.beatIndicatorMaterial = material
    this.camera.add(sprite)
    // The camera must be in the scene graph for its child sprite to render.
    this.scene.add(this.camera)
  }

  /**
   * Pulses the beat-indicator glow from the beat-sync envelope. Scales 1.0->~1.3
   * and opacity ~0.5->1.0 on a beat onset, then auto-fades, so the viewer can see
   * the rhythm is locked without any immersion-breaking UI text.
   */
  private updateBeatIndicator(gameState: GameState): void {
    if (!this.beatIndicator || !this.beatIndicatorMaterial) return

    const beatAgeMs = performance.now() - gameState.car.lastBeatTime
    const strength = gameState.car.beatStrength
    const PULSE_MS = 320

    // Beat selectivity (iteration 6): the indicator glows ONLY on strong beats, turning
    // it into a visual metronome that confirms the system is rhythm-locked to the
    // important moments (kicks/snares) and not flickering on every hi-hat.
    let pulse = 0
    if (gameState.car.beatFires && Number.isFinite(beatAgeMs) && beatAgeMs >= 0 && beatAgeMs < PULSE_MS) {
      const d = beatAgeMs / PULSE_MS
      pulse = (1 - d) * (1 - d) * strength
    }

    const baseScale = 0.1
    const scale = baseScale * (1.0 + pulse * 0.3)
    this.beatIndicator.scale.set(scale, scale, scale)
    // Idle glow ~0.18 so it reads as a persistent synthwave element; punches to ~1.
    this.beatIndicatorMaterial.opacity = 0.18 + pulse * 0.82
  }

  private async createCar(): Promise<void> {
    const carGroup = new THREE.Group()
    this.carMesh = carGroup
    this.scene.add(carGroup)

    // Fresh car group -> drop any stale sheen registry entries (their materials, if any,
    // belonged to a previous car and are being replaced).
    this.carSheenMaterials = []

    // Build a quick matte fallback while the glTF loads (or if it fails)
    this.buildFallbackCar(carGroup)
    // Hero car -> the velocity-smear SHARP mask (HERO_LAYER), incl. the fallback children,
    // so the car stays the one crisp "found" anchor when the smear pass lands. No
    // NEON_LAYER tag — the bloom that layer selected for is deleted.
    ThreeScene.enableLayerRecursive(carGroup, HERO_LAYER)

    try {
      const template = await this.loadCarTemplate()
      if (template) {
        this.replaceCarWithTemplate(carGroup, template)
        // Re-tag the swapped-in GLB onto the hero sharp-mask layer.
        ThreeScene.enableLayerRecursive(carGroup, HERO_LAYER)
      }
    } catch (error) {
      console.warn('Falling back to procedural car because the GLB failed to load', error)
    }
  }

  /**
   * Enables `layer` on `root` and every descendant ADDITIVELY, preserving each object's
   * existing layer membership. Three.js tests each object's own `layers` mask
   * independently — children do NOT inherit a parent's — so a hero group must tag its
   * whole subtree. Used to tag the foreground heroes (car, obstacles, particles) onto
   * HERO_LAYER, the velocity-smear SHARP mask, while they still render on all layers.
   */
  private static enableLayerRecursive(root: THREE.Object3D, layer: number): void {
    root.traverse(obj => obj.layers.enable(layer))
  }

  private loadCarTemplate(): Promise<THREE.Object3D | null> {
    if (!this.carTemplatePromise) {
      const loader = new GLTFLoader()
      const CAR_MODEL_URL = '/models/Kart.glb'

      this.carTemplatePromise = new Promise(resolve => {
        loader.load(
          CAR_MODEL_URL,
          gltf => {
            this.carTemplate = gltf.scene
            // --- FIX ORIENTATION: turn front from -X to +Z ---
            this.carTemplate.rotation.y = -Math.PI / 2; // 90 degrees
            resolve(this.carTemplate)
          },
          undefined,
          error => {
            console.error('Unable to load car model', error)
            resolve(null)
          }
        )
      })
    }

    return this.carTemplatePromise
  }

  private replaceCarWithTemplate(target: THREE.Group, template: THREE.Object3D): void {
    // The fallback car (and its sheen materials) is about to be disposed and replaced by the
    // GLB; drop the fallback's sheen registry so updateCarSheen never touches a freed material.
    // applyPaletteToModel(clone, true) below re-populates it from the GLB's submeshes.
    this.carSheenMaterials = []
    this.disposeCarChildren(target)

    const clone = template.clone(true)
    // Align the imported model so its nose points down +Z to match track forward vectors
    clone.rotation.y += Math.PI

    const bounds = new THREE.Box3().setFromObject(clone)
    const size = new THREE.Vector3()
    bounds.getSize(size)

    const desiredLength = 2.4
    const scaleFactor = size.z > 0 ? desiredLength / size.z : 1
    clone.scale.setScalar(scaleFactor)

    // Lift the model so its lowest point sits on the ground plane
    const baseOffset = -bounds.min.y * scaleFactor
    if (!Number.isNaN(baseOffset)) {
      clone.position.y += baseOffset
    }

    this.applyPaletteToModel(clone, true)

    target.add(clone)

    // P5: drape ONE rounded cowl/canopy hull over the open kart frame so the broad cool sheen
    // rolls across a single continuous body, not the four wheel-blobs + skull cockpit. Size it
    // to the SCALED kart footprint: a touch narrower than the full track width (so the wheels
    // still read at the flanks) and a low dome rising above the deck to cover the cockpit. The
    // kart is `desiredLength` long in Z after scaling; width/height come from the scaled bounds.
    const scaledW = size.x * scaleFactor
    const scaledH = size.y * scaleFactor
    this.addCarCanopy(target, {
      // Span most of the kart length and a BROAD beam that reaches out over the wheel hubs, so
      // the cowl visually UNIFIES the frame into one body (the wheels read as its flanks, not four
      // separate blocks). Generous so it dominates as the hero form (ref chrome is one big shape).
      length: desiredLength * 0.92,
      width: Math.max(1.15, scaledW * 0.86),
      // A confident rounded dome — the broad top surface the rolling sheen sweeps across.
      height: Math.max(0.92, scaledH * 0.82),
      // Seat the underside just above the deck (the model already sits on y=0 after baseOffset).
      baseY: 0.12,
      // Centre over the cockpit, very slightly aft of the nose.
      zCenter: -desiredLength * 0.05
    })
    // RimGlowShell is retired (its #00ffff->#ff00ff additive Fresnel halo is banned and
    // would feed a bloom that no longer exists). The in-material car sheen + this P5 cowl
    // replace its hero-focal role.
  }

  private buildFallbackCar(carGroup: THREE.Group): void {
    // FLAT MATTE tinted-gray procedural hero (Watercolour Speed §4): a muted violet-gray
    // body + a slightly cooler/darker cabin, NO emissive, NO additive glow box, NO rim
    // glow. metalness 0 / high roughness so it reads as a gouache form taking the soft
    // warm key + cool ambient. The broad in-material "helmet shine" is injected in a later
    // wave; B1 just lays the matte base.
    const bodyGeometry = new THREE.BoxGeometry(1.2, 0.4, 2)
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: HARMONY.bodyVioletGray.clone(), // #7 hero car albedo (lit faces)
      roughness: 0.85,
      metalness: 0.0
    })
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial)
    body.position.y = 0.2
    carGroup.add(body)

    const cabinGeometry = new THREE.BoxGeometry(0.9, 0.5, 1.2)
    const cabinMaterial = new THREE.MeshStandardMaterial({
      color: HARMONY.bodyShadowViolet.clone(), // #8 a darker violet for the cabin
      roughness: 0.85,
      metalness: 0.0
    })
    const cabin = new THREE.Mesh(cabinGeometry, cabinMaterial)
    cabin.position.set(0, 0.65, -0.2)
    carGroup.add(cabin)

    // A8 helmet-shine: inject the broad rolling cool-desaturate-capped sheen lobe (added to
    // totalEmissiveRadiance post-BRDF, NOT a mirror) into the matte body + cabin and register
    // it for the per-frame beat-breath. Materials are already matte (metalness 0 / rough 0.85)
    // so the injector only lays the unlit paint on top. Both share one program via the
    // injector's customProgramCacheKey.
    this.carSheenMaterials.push(injectCarSheen(bodyMaterial))
    this.carSheenMaterials.push(injectCarSheen(cabinMaterial))

    // P5: give the fallback hero a continuous BODY too (sized to the fallback boxes), so the
    // broad cool sheen rolls across one form rather than two slabs.
    this.addCarCanopy(carGroup, { length: 2.0, width: 1.2, height: 0.95, baseY: 0.18 })
  }

  /**
   * P5 — GIVE THE HERO A BODY. Adds ONE low-poly rounded cowl/canopy hull over the open kart
   * frame, parented into the car group and carrying its own {@link CarSheenMaterial}, so the
   * broad cool "helmet sheen" rolls across a SINGLE continuous painted form instead of scattering
   * over four neutral wheel-blobs + the busy skull cockpit (the kart's weakest read — see
   * docs/redesign/CRITIQUE.md P5 / the f1_car3x crop).
   *
   * The hull is a half-ellipsoid blister: a low-poly SphereGeometry scaled into an elongated,
   * flattened dome (long in Z = nose-to-tail, broad in X, low in Y) with its lower half scaled
   * down toward the deck so it reads as a cowl sitting ON the frame, not a floating egg. It is
   * a smooth CONVEX surface — exactly what the wide rolling sheen lobe wants — and tinted to the
   * lit body violet-gray (#7) so the sheen ramp (cool-desaturate-on-brighten, value-capped) plays
   * across it. The interior frame/seat/skull is demoted to the deep body violet in
   * applyPaletteToModel so it reads LOST behind/under this body (matched dark, no clutter).
   *
   * Sizing is passed in so the caller can fit it to the loaded GLB's bounds (cowl ≈ the kart's
   * own footprint) or the procedural fallback. The mesh is added to the same car group, so it
   * inherits the car transform AND the HERO_LAYER tag the caller enables recursively afterward
   * (keeping the body razor-sharp through the velocity smear).
   */
  private addCarCanopy(
    carGroup: THREE.Group,
    dims: { length: number; width: number; height: number; baseY: number; zCenter?: number }
  ): void {
    // Low-poly rounded hull (a UV sphere — 18x12 is plenty for a smooth Kuwahara-flattened cowl).
    const geo = new THREE.SphereGeometry(0.5, 18, 12)
    const pos = geo.getAttribute('position') as THREE.BufferAttribute
    // Reshape the unit sphere into the cowl: elongate Z, broaden X, flatten Y, and pull the
    // BOTTOM hemisphere in/down so the form sits like a canopy on the deck (a tapered lower
    // edge) rather than a symmetric balloon. A gentle forward taper (narrower toward the nose)
    // gives it a cockpit-cowl read.
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i)
      let y = pos.getY(i)
      let z = pos.getZ(i)
      // Forward taper: at the nose (+z) pinch X/ a touch; at the tail keep full width.
      const taper = 1.0 - 0.28 * Math.max(0, z * 2.0) // z in [-0.5,0.5] -> taper 1.0..0.72 toward nose
      x *= dims.width * taper
      z *= dims.length
      // Flatten + seat: upper half rounds up to the full height; lower half is squashed toward
      // the deck so the hull's underside tucks down onto the frame (no floating egg).
      const yScale = y >= 0 ? dims.height : dims.height * 0.42
      y *= yScale
      pos.setXYZ(i, x, y, z)
    }
    geo.computeVertexNormals()

    const canopyMat = new THREE.MeshStandardMaterial({
      color: HARMONY.bodyVioletGray.clone(), // #7 lit body violet-gray (the sheen ramps over this)
      roughness: 0.85,
      metalness: 0.0
    })
    const canopy = new THREE.Mesh(geo, canopyMat)
    // Seat the hull on the deck and centre it over the cockpit (slightly aft of the nose so it
    // covers the seat/skull). baseY lifts the squashed underside to just above the frame deck.
    canopy.position.set(0, dims.baseY + dims.height * 0.30, dims.zCenter ?? 0)
    canopy.castShadow = true
    canopy.receiveShadow = true
    carGroup.add(canopy)

    // The ONE broad continuous body the sheen rolls across.
    this.carSheenMaterials.push(injectCarSheen(canopyMat))
  }

  private disposeCarChildren(target: THREE.Group): void {
    for (const child of [...target.children]) {
      target.remove(child)
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose()
        if (Array.isArray(child.material)) {
          child.material.forEach(mat => mat.dispose())
        } else if (child.material instanceof THREE.Material) {
          child.material.dispose()
        }
      }
    }
  }

  private applyPaletteToModel(object: THREE.Object3D, isPlayer = false): void {
    // Retint any imported GLB material into the tinted-gray harmony (Watercolour Speed §4):
    // the saturated synthwave palette is REPLACED by a desaturate-toward-violet-gray pass so
    // the gouache read never collapses into plastic toy colours. Every material is forced
    // FLAT MATTE (metalness 0, high roughness, no emissive, no envMap) — all "paint"
    // character is added later in post (Kuwahara + pigment + granulation). The hero car
    // tints toward the body violet-gray (#7); other models toward the steel-violet field
    // (#3). The car's broad in-material sheen is injected in a later wave.
    // P5: the PLAYER's imported submeshes are the busy open-frame interior (struts, seat, the
    // "skull" cockpit) that read as a mechanical buggy. With the new cowl carrying the hero
    // sheen, lerp that interior HARD toward the DEEP body violet (#2C2A38) so it settles matched-
    // dark and reads LOST under/behind the canopy (no clutter) — the Sienkiewicz "lost" interior.
    // (The sheen injector's in-shader floor lifts it to a readable violet-gray, never pure black.)
    // Non-player models still desaturate toward the steel-violet field.
    const target = isPlayer ? HARMONY.deepBodyNearBlack : HARMONY.steelVioletField
    object.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true
        obj.receiveShadow = true

        const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
        for (const material of materials) {
          if (material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhysicalMaterial) {
            // P5: the player interior pulls HARD toward the deep body violet (lerp ~0.88) so the
            // busy frame goes matched-dark/lost behind the cowl; non-player models keep the gentler
            // desaturate (0.55 textured / 0.7 flat) toward the steel-violet field.
            const hasTexture = Boolean(material.map)
            const pull = isPlayer ? 0.88 : hasTexture ? 0.55 : 0.7
            material.color.lerp(target, pull)

            // FLAT MATTE: kill emissive (no bloom feeders), kill metal/clearcoat mirror.
            material.emissive.setRGB(0, 0, 0)
            material.emissiveIntensity = 0
            material.metalness = 0
            material.roughness = Math.max(material.roughness ?? 0.85, 0.85)
            material.envMapIntensity = 0
            if (material instanceof THREE.MeshPhysicalMaterial) {
              material.clearcoat = 0
            }
            material.needsUpdate = true

            // A8 helmet-shine (hero car only): inject the broad rolling cool-desaturate-capped
            // sheen lobe into the now-matte material and register it for the per-frame beat-
            // breath (updateCarSheen). MeshPhysicalMaterial extends MeshStandardMaterial, so it
            // is accepted by the injector; the shared customProgramCacheKey compiles every
            // submesh to one program. Done AFTER the matte forcing above so the injector lays
            // the unlit sheen on top of a clean matte base.
            if (isPlayer) {
              this.carSheenMaterials.push(injectCarSheen(material))
            }
          } else if (material instanceof THREE.MeshBasicMaterial) {
            // Unlit submeshes -> a flat harmony gray so nothing reads as neon.
            material.color.lerp(target, 0.6)
            material.needsUpdate = true
          }
        }
      }
    })
  }

  setTrack(track: TrackData): void {
    this.trackData = track
    this.smoothedCarPosition.set(0, 0, 0)
    this.smoothedCarForward.set(0, 0, 1)
    this.carOrientation.identity()
    this.carVerticalVelocity = 0
    this.carVerticalOffset = 0
    this.lastCollisionTime = 0
    this.lastTrackHeight = track.nodes[0]?.pos.y ?? 0
    this.lastFrameTime = null
    this.lastNodeIndex = 0
    this.shakeResidual.set(0, 0, 0)
    this.appliedDepthScale = 1
    this.prevFocused = false
    // B4: re-baseline the velocity-smear so a freshly loaded/scrubbed track never smears from a
    // stale previous view-projection or a discontinuous distance jump. The first frame after
    // this is treated as a smear-reset (prev distance unknown, no cached prev VP).
    this.prevCarDistance = null
    this.hasPrevViewProj = false
    this.particlePool.reset()

    this.clearTrebleMeshes()

    // Remove old road if exists
    if (this.roadMesh) {
      this.scene.remove(this.roadMesh)
      this.roadMesh.geometry.dispose()
      if (this.roadMesh.material instanceof THREE.Material) {
        this.roadMesh.material.dispose()
      }
    }

    // Create road from track nodes
    const roadWidth = 7.5 // 3 lanes * 2.5
    const points: THREE.Vector3[] = track.nodes.map(node => node.pos)

    // Create a custom geometry for the road
    const roadGeometry = new THREE.BufferGeometry()
    const vertices: number[] = []
    const indices: number[] = []
    const uvs: number[] = []

    // Generate road segments
    for (let i = 0; i < points.length - 1; i++) {
      const current = points[i]
      const next = points[i + 1]
      const direction = new THREE.Vector3().subVectors(next, current).normalize()
      const right = new THREE.Vector3().crossVectors(direction, new THREE.Vector3(0, 1, 0)).normalize()

      const halfWidth = roadWidth / 2
      const v0 = new THREE.Vector3().addVectors(current, right.clone().multiplyScalar(-halfWidth))
      const v1 = new THREE.Vector3().addVectors(current, right.clone().multiplyScalar(halfWidth))
      const v2 = new THREE.Vector3().addVectors(next, right.clone().multiplyScalar(-halfWidth))
      const v3 = new THREE.Vector3().addVectors(next, right.clone().multiplyScalar(halfWidth))

      const baseIndex = vertices.length / 3

      // Add vertices
      vertices.push(v0.x, v0.y, v0.z)
      vertices.push(v1.x, v1.y, v1.z)
      vertices.push(v2.x, v2.y, v2.z)
      vertices.push(v3.x, v3.y, v3.z)

      // Add UVs
      uvs.push(0, 0)
      uvs.push(1, 0)
      uvs.push(0, 1)
      uvs.push(1, 1)

      // Add indices (two triangles per quad)
      indices.push(baseIndex, baseIndex + 1, baseIndex + 2)
      indices.push(baseIndex + 1, baseIndex + 3, baseIndex + 2)
    }

    roadGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
    roadGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    roadGeometry.setIndex(indices)
    roadGeometry.computeVertexNormals()

    // FLAT MATTE sand-bridge road (Watercolour Speed §5 "Road"): the warm sienna/sand
    // bridge #C9B49E (crushed in saturation + value) that stops the rose-ground/steel-sky
    // pair reading as a cold pink-blue cliché. The baked-neon emissive road shader
    // (onBeforeCompile cyan edges + lane dividers) is REPLACED wholesale with this matte
    // material — NO emissive, NO metalness, NO baked neon lines. Lane/road edges are added
    // later as soft, value-based, lost-and-found marks by the painterly edge pass (often
    // petrol-teal #48677D in shadow), NEVER as bright neon grid lines here. The per-frame
    // road morph still recomputes clean normals (morphRoadToMusic) to feed that edge pass.
    const roadMaterial = new THREE.MeshStandardMaterial({
      // The sand bridge must read a touch LIGHTER and warmer than the rose-gray FIELD it
      // crosses (ref 02: the road sits ~0.10 value above its surroundings, a pale warm
      // ribbon), otherwise field and road merge into one flat value and the path stops
      // reading. Lift the #C9B49E sand slightly toward the warm-cream sheet to get that
      // separation while keeping it a desaturated sand, not a bright lane.
      color: HARMONY.sandRoad.clone().lerp(HARMONY.warmCream, 0.28),
      roughness: 0.9,
      metalness: 0.0
    })

    this.roadMesh = new THREE.Mesh(roadGeometry, roadMaterial)
    this.roadMesh.layers.set(LAYER_DEFAULT)
    this.scene.add(this.roadMesh)

    // Cache the immutable base vertex positions for per-frame spectral elevation
    // morphing (iteration 8). We copy the whole [x,y,z,...] buffer so the morph can
    // always displace relative to the authored terrain rather than drifting. Resetting
    // the morph state here keeps each newly loaded track starting from a calm baseline.
    const basePosAttr = roadGeometry.getAttribute('position') as THREE.BufferAttribute
    this.baseRoadPositions = new Float32Array(basePosAttr.array as Float32Array)
    this.roadMorphAmplitude = 0
    this.roadMorphPhase = 0

    // Add treble-driven accents
    this.addTreblePulses(track)
  }

  setCollisionCallback(callback: (() => void) | null): void {
    this.collisionCallback = callback
  }

  /**
   * Fires a pigment-spatter burst from the car marking an emotional peak (drop entry).
   * The controller supplies the musical drivers it owns — drop strength (count) and
   * spectral centroid (brightness, biasing ink warmth) — while the renderer owns the pool
   * and the car's world transform. The particle pool renders all bursts as tinted near-
   * black ink flecks and only reads the passed colour's warmth to pick the warm/cool ink,
   * so this throws a spray of dark spatter, not glowing embers. Count scales with strength.
   */
  emitDropBurst(dropStrength: number, spectralCentroid: number): void {
    const count = Math.round(dropStrength * PARTICLES_PER_DROP_UNIT)
    if (count <= 0) return

    // Centroid biases the INK temperature: cool steel-blue ink below 0.4, warm rose ink
    // above 0.6 (the pool maps these to the two near-blacks #20211C / #1E1B22).
    const t = THREE.MathUtils.clamp((spectralCentroid - 0.4) / 0.2, 0, 1)
    const color = BURST_COLOR_COOL.clone().lerp(BURST_COLOR_HOT, t)

    const origin = this.smoothedCarPosition.clone()
    origin.y += 0.6
    this.particlePool.emitBurst(count, origin, 11, color, PARTICLE_LIFETIME_DROP)
  }

  /**
   * Fires a tiny treble-transient pigment flick off the hero car (iteration 7) — the
   * music-FREQUENCY signal. The controller crosses a detected treble peak and supplies its
   * normalized 0..1 `strength`; the renderer owns the pool and the car transform. Only 6-8
   * fast, short-lived flecks spawn from the car + a small random offset (so they never
   * cluster with the larger drop/collision bursts), reading as a quick flick of tinted
   * near-black ink spatter on hi-hats/cymbals/snare sizzle — orthogonal to the beat FOV
   * punch and the slow mood swell. Centroid only biases the ink temperature.
   */
  emitTrebleBurst(strength: number, spectralCentroid: number): void {
    const s = THREE.MathUtils.clamp(strength, 0, 1)
    const count = Math.round(
      TREBLE_BURST_COUNT_MIN + (TREBLE_BURST_COUNT_MAX - TREBLE_BURST_COUNT_MIN) * s
    )
    if (count <= 0) return

    // Centroid biases the INK temperature (cool steel-blue vs warm rose), same window as
    // the drop burst; the pool maps it to the two near-blacks.
    const t = THREE.MathUtils.clamp((spectralCentroid - 0.4) / 0.2, 0, 1)
    const color = BURST_COLOR_COOL.clone().lerp(BURST_COLOR_HOT, t)

    // Emit from the car body with a small random offset so successive sparkles scatter
    // around the hero rather than stacking on one point or on the collision/drop origin.
    const origin = this.smoothedCarPosition.clone()
    origin.x += (Math.random() - 0.5) * 0.8
    origin.y += 0.55 + Math.random() * 0.4
    origin.z += (Math.random() - 0.5) * 0.8
    this.particlePool.emitBurst(count, origin, TREBLE_BURST_SPEED, color, TREBLE_BURST_LIFETIME)
  }

  private addTreblePulses(track: TrackData): void {
    const currentTrack = this.trackData
    this.loadSwordTemplate().then(template => {
      for (const pulse of track.treblePulses) {
        // Avoid placing hazards from outdated tracks if a new one was set
        if (currentTrack && currentTrack !== this.trackData) {
          break
        }

        const hazardGroup = new THREE.Group()
        hazardGroup.position.copy(pulse.pos)
        hazardGroup.position.y = Math.max(0, pulse.pos.y)

        // const warningPlateGeometry = new THREE.CylinderGeometry(1.05, 0.95, 0.18, 20)
        // const warningPlateMaterial = new THREE.MeshStandardMaterial({
        //   color: 0x5d0015,
        //   emissive: 0xe60035,
        //   emissiveIntensity: 1.45,
        //   roughness: 0.4,
        //   metalness: 0.2,
        //   opacity: 0.85,
        //   transparent: true
        // })
        // const warningPlate = new THREE.Mesh(warningPlateGeometry, warningPlateMaterial)
        // warningPlate.position.y = 0.04
        // hazardGroup.add(warningPlate)

        if (template) {
          const sword = this.cloneSwordTemplate(template)
          const scale = 0.8 + pulse.intensity * 1.1
          sword.scale.multiplyScalar(scale)
          sword.position.y = 0.1
          sword.rotation.set(
            THREE.MathUtils.degToRad(-15),
            pulse.time * 0.1 + THREE.MathUtils.degToRad(120),
            THREE.MathUtils.degToRad(1)
          )
          hazardGroup.add(sword)
        }

        // Obstacles are foreground narrative heroes -> the velocity-smear SHARP mask
        // (HERO_LAYER) so the signal-red blade stays crisp against the streaking world.
        // No NEON_LAYER tag — the bloom that layer selected for is deleted.
        ThreeScene.enableLayerRecursive(hazardGroup, HERO_LAYER)
        this.scene.add(hazardGroup)
        this.trebleMeshes.push(hazardGroup)
      }
    })
  }

  private loadSwordTemplate(): Promise<THREE.Object3D | null> {
    if (!this.swordTemplatePromise) {
      const loader = new GLTFLoader()
      const SWORD_MODEL_URL = '/models/Claymore.glb'

      this.swordTemplatePromise = new Promise(resolve => {
        loader.load(
          SWORD_MODEL_URL,
          gltf => {
            this.swordTemplate = gltf.scene
            resolve(this.swordTemplate)
          },
          undefined,
          error => {
            console.error('Unable to load sword model', error)
            resolve(null)
          }
        )
      })
    }

    return this.swordTemplatePromise
  }

  private cloneSwordTemplate(template: THREE.Object3D): THREE.Object3D {
    const clone = template.clone(true)

    // The sword is the ONE saturated accent (Watercolour Speed §5): a matte signal-red
    // #D6443B blade (its dark accent stroke is added later by the painterly edge pass), on
    // a desaturated violet-gray hilt/guard. We retint inline (NOT via applyPaletteToModel)
    // so the blade detection reads the ORIGINAL material colour before any desaturation,
    // then force everything FLAT MATTE — no emissive, no transmission, no metalness.
    clone.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true
        obj.receiveShadow = true
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material]

        for (const material of materials) {
          if (
            material instanceof THREE.MeshStandardMaterial ||
            material instanceof THREE.MeshPhysicalMaterial
          ) {
            const isBlade = material.color.r > material.color.g * 1.1 && material.color.r > material.color.b
            if (isBlade) {
              // The single saturated hit — matte signal red, NO emissive glow. R-FINAL: deepened
              // toward a painted oxblood (lerp 0.35 to #6E211D) so the obstacle reads as a DARKER
              // red that carries shadow weight (contributing the punched-dark mass ref 02 has) while
              // staying unmistakably the one saturated red accent — and its dark side then anchors
              // the PainterlyEdge accent stroke. ACES + the LUT keep the lit blade face luminous-red.
              material.color.copy(HARMONY.signalRed).lerp(new THREE.Color(0x6e211d), 0.35)
            } else {
              // Hilt / guard -> desaturated violet-gray, in the harmony.
              material.color.lerp(HARMONY.bodyShadowViolet, 0.6)
            }

            // FLAT MATTE for the whole sword.
            material.emissive.setRGB(0, 0, 0)
            material.emissiveIntensity = 0
            material.metalness = 0
            material.roughness = Math.max(material.roughness ?? 0.85, 0.85)
            material.envMapIntensity = 0
            material.transparent = false
            if (material instanceof THREE.MeshPhysicalMaterial) {
              material.transmission = 0
            }
            material.needsUpdate = true
          }
        }
      }
    })

    return clone
  }

  private clearTrebleMeshes(): void {
    for (const mesh of this.trebleMeshes) {
      this.scene.remove(mesh)
      mesh.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose()

          if (child.material instanceof THREE.Material) {
            child.material.dispose()
          } else if (Array.isArray(child.material)) {
            child.material.forEach(material => material.dispose())
          }
        }
      })
    }
    this.trebleMeshes = []
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
    this.composer.setSize(width, height)

    // --- Aux G-buffers (Watercolour Speed B2): reallocate BOTH the normal target and its
    // attached DepthTexture to the new drawing-buffer resolution so they stay 1:1 with the
    // composer's colour target. RenderTarget.setSize resizes the colour texture but NOT the
    // attached depth texture, so the DepthTexture image dims are updated explicitly (and its
    // GPU storage is reallocated on the next render via the target's dispose()).
    const pixelRatio = Math.min(window.devicePixelRatio, 2)
    const bufW = Math.floor(width * pixelRatio)
    const bufH = Math.floor(height * pixelRatio)
    this.sceneDepthTexture.image.width = bufW
    this.sceneDepthTexture.image.height = bufH
    this.sceneDepthTexture.needsUpdate = true
    this.normalTarget.setSize(bufW, bufH)

    // --- Painterly Track-A passes (Watercolour Speed B3): update EVERY resolution/texel/
    // tensorTexel uniform against the new DRAWING-BUFFER dims so the kernels stay resolution-
    // stable, and reallocate the half-res tensor side-chain targets. All texel/resolution
    // uniforms below are in drawing-buffer pixels (bufW/bufH = width*min(dpr,2)).
    const halfW = Math.max(1, Math.floor(bufW / 2))
    const halfH = Math.max(1, Math.floor(bufH / 2))
    this.tensorTargetA.setSize(halfW, halfH)
    this.tensorTargetB.setSize(halfW, halfH)
    // R4: the HERO_LAYER sharp-mask target tracks half-res too.
    this.carMaskTarget.setSize(halfW, halfH)

    const fullTexel: [number, number] = [1 / bufW, 1 / bufH]
    const halfTexel: [number, number] = [1 / halfW, 1 / halfH]

    // PreBlur / StructureTensor sample the full-res colour -> full-res texel.
    ThreeScene.setVec2Uniform(this.preBlurPass.uniforms.texel, fullTexel)
    ThreeScene.setVec2Uniform(this.structureTensorPass.uniforms.texel, fullTexel)
    // TensorBlur runs on the half-res tensor target -> half-res texel.
    ThreeScene.setVec2Uniform(this.tensorBlurHPass.uniforms.texel, halfTexel)
    ThreeScene.setVec2Uniform(this.tensorBlurVPass.uniforms.texel, halfTexel)
    // Kuwahara: colour texel (full) + tensor texel (half) for the bilinear upscale.
    ThreeScene.setVec2Uniform(this.kuwaharaPass.uniforms.texel, fullTexel)
    ThreeScene.setVec2Uniform(this.kuwaharaPass.uniforms.tensorTexel, halfTexel)
    // Pigment / SubstratePaper use a `resolution` (pixel size), not a texel.
    ThreeScene.setVec2Uniform(this.pigmentPass.uniforms.resolution, [bufW, bufH])
    ThreeScene.setVec2Uniform(this.substratePaperPass.uniforms.resolution, [bufW, bufH])
    // PainterlyEdge: pixel resolution + colour texel + half-res tensor texel.
    ThreeScene.setVec2Uniform(this.painterlyEdgePass.uniforms.uResolution, [bufW, bufH])
    ThreeScene.setVec2Uniform(this.painterlyEdgePass.uniforms.texel, fullTexel)
    ThreeScene.setVec2Uniform(this.painterlyEdgePass.uniforms.tensorTexel, halfTexel)
    // VelocitySmear: full-res texel for the noise/wobble sampling.
    ThreeScene.setVec2Uniform(this.velocitySmearPass.uniforms.uTexelSize, fullTexel)
  }

  /**
   * Writes (x, y) into a vec2 uniform whose `.value` may be either a THREE.Vector2 (the
   * common factory form) or a plain [x, y] array (the Kuwahara texel/tensorTexel form). Sets
   * Vector2s in place and reassigns array-valued uniforms, so a single call site can update
   * any of the painterly passes' resolution/texel uniforms uniformly.
   */
  private static setVec2Uniform(uniform: { value: unknown }, xy: [number, number]): void {
    if (uniform.value instanceof THREE.Vector2) {
      uniform.value.set(xy[0], xy[1])
    } else {
      uniform.value = [xy[0], xy[1]]
    }
  }

  private handleObstacleCollision(carPosition: THREE.Vector3, gameState: GameState): void {
    if (!this.trackData) return

    // Allow the car to clear hazards when sufficiently airborne
    if (this.carVerticalOffset > 0.5) return

    const now = performance.now()
    const cooldownMs = 400

    if (now - this.lastCollisionTime < cooldownMs) return

    // The global planner guarantees the car is always planned into a clear lane, so a
    // genuine same-lane hit never happens — collisions only came from the smooth lane-
    // change lerp lagging the discrete plan and grazing an adjacent-lane blade. Lane
    // centres are 2.5 apart; a 1.0 radius registers a real overlap (car driven into a
    // blade) without false-firing on the autopilot's mid-transition near-misses, so the
    // self-driving reads as flawless.
    const hazardRadius = 1.0
    const verticalTolerance = 1.5

    const hitPulse = this.trackData.treblePulses.find(pulse => {
      if (Math.abs(carPosition.y - pulse.pos.y) > verticalTolerance) {
        return false
      }

      const distance = carPosition.distanceTo(pulse.pos)
      return distance < hazardRadius
    })

    if (hitPulse) {
      this.lastCollisionTime = now

      // Wipeout-style impact feedback: a fixed, hard shake spike (overrides the
      // softer music-driven amplitude) plus a particle burst at the impact point.
      gameState.car.cameraShakeAmplitude = COLLISION_SHAKE_AMPLITUDE
      gameState.car.lastShakeTime = now

      const burstColor = gameState.car.spectralCentroid > 0.5 ? BURST_COLOR_HOT : BURST_COLOR_COOL
      // Emit just above the contact point so a spray of tinted-near-black pigment spatter
      // (a "wet drag" pulse) flicks off the car/blade — not the deleted red bloom flash.
      const burstPos = carPosition.clone()
      burstPos.y += 0.4
      this.particlePool.emitBurst(PARTICLES_PER_COLLISION, burstPos, 9, burstColor, PARTICLE_LIFETIME_COLLISION)

      this.collisionCallback?.()
    }
  }

  /**
   * Evaluates the per-frame camera/music gestures (beat FOV punch, drop FOV widening, beat
   * indicator, treble spatter, particle sim, camera shake) and the painterly post-stack music
   * drivers (B4: car-sheen breath, Kuwahara q ease-down, velocity-smear length/kick, edge
   * breakup widen, LUT accent-chroma push), then renders the composed (tone-mapped + painted)
   * frame. Centralizing the render call here means every early-return path in renderFrame still
   * gets tone mapping + the camera reactivity for free. The velocity-smear view-projection is
   * taken from the SHAKEN camera transform (the exact one the colour frame renders with) and
   * its uPrevViewProj is cached AFTER render; the smear is zeroed on seek/large-delta frames.
   */
  private renderComposite(gameState: GameState): void {
    // Milliseconds since the last beat onset. lastBeatTime is a performance.now()
    // timestamp recorded by the controller when the audio clock crosses a beat, so
    // we can compute the envelope phase without the renderer knowing the audio time.
    // It starts at -Infinity, so before any beat this is huge and envelopes sit at
    // baseline.
    const beatAgeMs = performance.now() - gameState.car.lastBeatTime
    const strength = gameState.car.beatStrength

    // Mood signals (smoothed upstream by the controller). centroid is the slow sectional
    // brightness; dropIntensity is the fast cinematic spike on drop entry. (The synthwave
    // bloom/CA/sky-hue mood bindings that also read flux were ripped out; the painterly
    // music drivers — sheen breath, smear length, edge breakup, accent chroma — are applied
    // in updatePainterlyMusicDrivers below, all within the saturation discipline.)
    const centroid = gameState.car.spectralCentroid
    const dropIntensity = gameState.car.dropIntensity

    // --- FOV punch: fast attack to a strength-scaled peak, eased decay back to base, with
    // the drop-driven expansion stacked on top so the camera reacts to both rhythm and the
    // music's emotional peaks. Gated to strong beats (car.beatFires). This is a CAMERA
    // gesture (kept) — distinct from the deleted bloom/CA gestures.
    let fovOffset = 0
    if (gameState.car.beatFires && Number.isFinite(beatAgeMs) && beatAgeMs >= 0) {
      if (beatAgeMs < FOV_ATTACK_MS) {
        const a = beatAgeMs / FOV_ATTACK_MS
        // ease-out-quad on the way up for a snappy kick
        fovOffset = (1 - (1 - a) * (1 - a)) * FOV_PUNCH * strength
      } else {
        const d = Math.min(1, (beatAgeMs - FOV_ATTACK_MS) / FOV_DECAY_MS)
        // ease-in-quad on the way down for a smooth settle
        fovOffset = (1 - d * d) * FOV_PUNCH * strength
      }
    }
    // Cinematic FOV widening paired with the camera pull-back. The depth scale sits at 1.0
    // at rest and rises to ~1.15 during a drop; we map that excess to a 0..1 factor and
    // scale FOV_DROP_BOOST_MAX by it, so the lens widens in lock-step with the camera easing
    // back — read off the same eased depth (this.appliedDepthScale) so they never desync.
    const depthExcess = THREE.MathUtils.clamp((this.appliedDepthScale - 1) / 0.15, 0, 1)
    const targetFov = BASE_FOV + fovOffset + dropIntensity * FOV_DROP_PUNCH + depthExcess * FOV_DROP_BOOST_MAX
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = targetFov
      this.camera.updateProjectionMatrix()
    }

    // --- Rhythm-locked beat indicator (bottom-right corner element).
    this.updateBeatIndicator(gameState)

    // --- Treble pulse (Watercolour Speed restyle): the controller sets a one-frame
    // trebleFires pulse the instant the audio clock crosses a high-frequency transient.
    // Emit the pigment-spatter flick here (centrally, so every render path consumes it
    // exactly once) and clear the flag so a paused/early-return frame can't re-emit a stale
    // pulse.
    if (gameState.car.trebleFires) {
      this.emitTrebleBurst(gameState.car.trebleStrength, centroid)
      gameState.car.trebleFires = false
    }

    // --- Painterly post-stack music drivers (B4): sheen breath, Kuwahara q ease-down, smear
    // length/kick, edge breakup widen, accent-chroma push. All within the saturation
    // discipline (no flashes, no bloom). Computes the smear RESET flag (seek/large-Δ) and
    // applies the non-matrix uniforms; the smear's view-projection matrices are set below,
    // from the SHAKEN transform.
    const smearReset = this.updatePainterlyMusicDrivers(gameState)

    // --- Advance the GPU pigment-spatter simulation (drop + collision + treble bursts).
    this.particlePool.update(this.lastFrameDelta)

    // --- Camera shake: a transient world-space offset added to the camera right before
    // rendering, then reverted, so it never accumulates into the lerp-driven chase position
    // on the next frame (clean settle, no residual drift). The velocity-smear pass reads its
    // view-projection from this same shaken transform.
    this.applyCameraShake(gameState)

    // --- Aux G-buffers (Watercolour Speed B2): fill the depth + normal targets with the
    // SAME shaken camera the colour frame is about to render with, so tDepth/tNormal stay
    // pixel-aligned with the painted image. renderAuxTargets ALSO captures this frame's
    // shaken view-projection into curViewProj — built with the SAME tightened DEPTH_FAR
    // projection the DepthTexture is written under, so the smear's unprojection is geometric-
    // ally consistent with the depth it samples (using the full-far projection here would
    // mis-unproject the DEPTH_FAR-captured depth). The shake offset is subtracted after.
    this.renderAuxTargets()

    // --- VelocitySmear view-projection (B4): uInvCurViewProj is the inverse of this frame's
    // shaken VP (the smear unprojects depth with it); uPrevViewProj holds the PREVIOUS frame's
    // shaken VP (cached after the previous render). On the first frame (no prev) or a seek/
    // large-Δ frame, force uReset=1 so a stale/absent prev-matrix can't drag the whole screen.
    const smearU = this.velocitySmearPass.uniforms
    ;(smearU.uInvCurViewProj.value as THREE.Matrix4).copy(this.curViewProj).invert()
    if (this.hasPrevViewProj) {
      ;(smearU.uPrevViewProj.value as THREE.Matrix4).copy(this.prevViewProj)
    } else {
      ;(smearU.uPrevViewProj.value as THREE.Matrix4).copy(this.curViewProj)
    }
    smearU.uReset.value = smearReset || !this.hasPrevViewProj ? 1 : 0

    // --- P4: derive the screen-space TRACK-FLOW direction for the injected smear drag. Project a
    // point ~FLOW_LOOKAHEAD units ahead down the centerline AND the car's own position into clip
    // space with the SAME shaken curViewProj the frame renders/unprojects with, take their NDC
    // (perspective-divided) positions, and the screen vector FROM the ahead-point (near the
    // vanishing point) TOWARD the car is the direction the static world slides past as the car
    // drives forward — exactly the wet directional drag a gouache speed painting wants. Eased so
    // the streak direction glides through bends instead of snapping. On a reset frame the smear is
    // already zeroed in-shader, so a stale direction here is harmless.
    this.updateSmearFlowDir(gameState.car.distance)

    this.composer.render()

    // Cache this frame's shaken VP for next frame's uPrevViewProj (copied AFTER render so it is
    // exactly the transform this frame painted with).
    this.prevViewProj.copy(this.curViewProj)
    this.hasPrevViewProj = true

    this.camera.position.sub(this.shakeOffset)
  }

  /**
   * Per-frame painterly music drivers (Watercolour Speed B4). Expresses the music THROUGH the
   * medium — never brightness or bloom — by easing a small set of painterly uniforms each
   * frame:
   *
   *  - CAR SHEEN: updateCarSheen drives uSheenStrength ≈ 0.45 + beat*0.5 + centroid*0.25
   *    (smoothed inside the module) so the broad helmet-shine lobe BREATHES on the beat as a
   *    saturation/value pulse of the existing hue; uSheenDir is rolled by the camera bank so the
   *    lobe sweeps the body as the car leans.
   *  - KUWAHARA q: eased DOWN from KUWAHARA_Q_REST toward KUWAHARA_Q_DROP by dropIntensity so the
   *    gouache strokes broaden/bleed (a WETTER look) on drops.
   *  - VELOCITY SMEAR: uSpeedMul = speedMultiplier (drop acceleration lengthens the wet drag);
   *    uBeatKick is a brief "wet drag" pulse off the beat envelope; uMaxSmear opens a touch on
   *    drops; uStrength eases toward a speed/drop target; uVelocityScale keeps the streak
   *    framerate-stable.
   *  - PAINTERLY EDGE: uMusic eased toward dropIntensity so the breakup threshold WIDENS (more
   *    "found" ink — the painter pressing harder) on drops; uTime advanced for the slow crawl.
   *  - PAINT-GRADE LUT: a micro uHueShift toward rose on LOUD passages (accent-chroma push),
   *    eased so the frame never snaps.
   *
   * Returns whether THIS frame is a smear-reset frame (a seek / rewind / tab-throttle re-
   * baseline, detected as a large jump in the clamped car distance): the caller forces the
   * velocity-smear uReset on so a stale prev view-projection can't drag the whole screen.
   */
  private updatePainterlyMusicDrivers(gameState: GameState): boolean {
    const car = gameState.car
    const dt = this.lastFrameDelta
    const dropIntensity = THREE.MathUtils.clamp(car.dropIntensity, 0, 1)
    const centroid = THREE.MathUtils.clamp(car.spectralCentroid, 0, 1)

    // Beat "breath/drag" envelope: a fast ease-out off the last STRONG beat, phased off the
    // performance.now() timestamp the controller stamps (same idiom as the FOV punch). Gated to
    // strong beats (beatFires) so weak hi-hats don't pump the sheen/smear.
    const beatAgeMs = performance.now() - car.lastBeatTime
    let beatPulse = 0
    if (car.beatFires && Number.isFinite(beatAgeMs) && beatAgeMs >= 0 && beatAgeMs < SMEAR_BEAT_KICK_MS) {
      const d = beatAgeMs / SMEAR_BEAT_KICK_MS
      beatPulse = (1 - d) * (1 - d) * THREE.MathUtils.clamp(car.beatStrength, 0, 1)
    }

    // --- CAR SHEEN: roll the view-space lobe direction by the camera bank so the broad shine
    // sweeps across the body as the car leans (spec §4), then breathe each registered material.
    // Base is the module default (up-and-toward-camera); cameraRoll (radians) tilts it laterally.
    const roll = this.cameraRoll
    // P5: CAMERA-FACING base (dominant +Z, modest up) so the broad "helmet shine" sweeps the
    // VIEWER-FACING cowl/body (the hero read, ref 02) instead of the up-facing wheel tops; the
    // bank tilts it laterally so the lobe rolls across the body as the kart leans. Matches the
    // module DEFAULTS.dir (0.35,0.30,1.0) so the resting framing reads the same as the unit-
    // shaded material.
    this.sheenDir.set(
      0.35 + Math.sin(roll) * 0.28,
      0.30,
      1.0
    ).normalize()
    for (const entry of this.carSheenMaterials) {
      updateCarSheen(entry, {
        beatStrength: car.beatStrength,
        spectralCentroid: centroid,
        sheenDir: this.sheenDir,
        dt
      })
    }

    // --- KUWAHARA q eases DOWN on drops (looser/wetter strokes).
    const qTarget = THREE.MathUtils.lerp(KUWAHARA_Q_REST, KUWAHARA_Q_DROP, dropIntensity)
    this.smoothedKuwaharaQ += (qTarget - this.smoothedKuwaharaQ) * KUWAHARA_Q_EASE
    this.kuwaharaPass.uniforms.sharpness.value = this.smoothedKuwaharaQ

    // --- VELOCITY SMEAR length/kick/clamp. uSpeedMul drives the in-shader 0.6+0.4*speedMul
    // base; a small extra master push on drops lengthens the wet drag further; the beat is a
    // brief kick on the smear LENGTH (never a flash). uMaxSmear opens a touch on drops so the
    // comet tail can physically reach further. uStrength is eased so the drag breathes.
    const smearU = this.velocitySmearPass.uniforms
    smearU.uSpeedMul.value = car.speedMultiplier
    // R4: a slightly higher rest master + drop boost so the wet drag is confidently present at
    // speed (ref 02's bold streak) while still easing back toward a short drag when quiet.
    const smearTarget = THREE.MathUtils.clamp(0.95 + dropIntensity * 0.4, 0, 1.5)
    this.smoothedSmearStrength += (smearTarget - this.smoothedSmearStrength) * SMEAR_DRIVE_EASE
    smearU.uStrength.value = this.smoothedSmearStrength
    smearU.uBeatKick.value = beatPulse * SMEAR_BEAT_KICK_MAX
    smearU.uMaxSmear.value = THREE.MathUtils.lerp(SMEAR_MAX_REST, SMEAR_MAX_DROP, dropIntensity)
    // Framerate-stable streak length: currentFps/targetFps (60). Clamp the dt so a stalled
    // frame doesn't blow the scale up; identity when dt is unknown (paused/first frame).
    smearU.uVelocityScale.value = dt > 1e-4 ? THREE.MathUtils.clamp((1 / dt) / 60, 0.25, 2) : 1
    // P4 — injected track-flow drag gain opens on drops so the world drags noticeably longer on
    // emotional peaks (the static world rushing past harder), eased so the streak never snaps.
    const flowGainTarget = THREE.MathUtils.lerp(FLOW_GAIN_REST, FLOW_GAIN_DROP, dropIntensity)
    this.smoothedFlowGain += (flowGainTarget - this.smoothedFlowGain) * FLOW_GAIN_EASE
    smearU.uFlowGain.value = this.smoothedFlowGain

    // --- PAINTERLY EDGE breakup widen on drops + slow crawl.
    this.smoothedEdgeMusic += (dropIntensity - this.smoothedEdgeMusic) * EDGE_MUSIC_EASE
    this.painterlyEdgePass.uniforms.uMusic.value = this.smoothedEdgeMusic
    this.painterlyEdgePass.uniforms.uTime.value += Math.max(0, dt)

    // --- PAINT-GRADE LUT accent-chroma push on LOUD passages (micro hue rotation toward rose).
    // Driven by the louder of the drop spike and the beat pulse so the accents warm on emphasis;
    // eased and tiny (≤ a few degrees) so the harmony never hard-swaps.
    const loud = Math.max(dropIntensity, beatPulse)
    const hueTarget = loud * HUE_SHIFT_MAX
    this.smoothedHueShift += (hueTarget - this.smoothedHueShift) * HUE_SHIFT_EASE
    this.paintGradePass.uniforms.uHueShift.value = this.smoothedHueShift

    // --- Smear RESET detection: a large jump in the clamped car distance is a seek / rewind /
    // tab-throttle re-baseline (mirrors the controller's dt>0.5 ⇒ ~25u jump at 50 u/s). The very
    // first frame after a track (re)load (prevCarDistance === null) is also a reset.
    let smearReset = false
    if (this.prevCarDistance === null) {
      smearReset = true
    } else if (Math.abs(car.distance - this.prevCarDistance) > SMEAR_RESET_DISTANCE_JUMP) {
      smearReset = true
    }
    this.prevCarDistance = car.distance

    return smearReset
  }

  /**
   * Renders the dedicated aux G-buffer pre-pass (Watercolour Speed B2). One scene render
   * with `scene.overrideMaterial = MeshNormalMaterial` fills BOTH aux buffers at once:
   *   - the colour attachment of `normalTarget` gets view-space normals (n*0.5+0.5 in RGB),
   *   - the attached `sceneDepthTexture` gets the perspective depth.
   *
   * The camera far is TIGHTENED to DEPTH_FAR for this pass only (saved/restored around the
   * render) so the device-depth written into the DepthTexture has a usable z-distribution
   * AND matches the `cameraFar` the painterly edge (A6) / velocity-smear (A7) passes
   * linearise against — the scene's real far=10000 would both crush the depth precision and
   * desync the in-shader linearisation. The override material is restored to null and the
   * camera projection is rebuilt afterwards so the subsequent colour render is unaffected.
   *
   * Deterministic and decoupled from EffectComposer's ping-ponged buffers: A6/A7 read these
   * owned textures as wired uniforms, never the composer's internal renderTarget1/2.
   */
  private renderAuxTargets(): void {
    const prevFar = this.camera.far
    const prevOverride = this.scene.overrideMaterial
    const prevTarget = this.renderer.getRenderTarget()

    // Tighten the far plane just for the depth/normal capture.
    this.camera.far = DEPTH_FAR
    this.camera.updateProjectionMatrix()

    // Capture this frame's SHAKEN view-projection under the TIGHTENED DEPTH_FAR projection —
    // the exact projection the DepthTexture is about to be written with — so the velocity
    // smear's unprojection (uInvCurViewProj) is geometrically consistent with the depth it
    // samples. The camera position already carries the shake offset (applyCameraShake ran
    // first); refresh its world matrix so matrixWorldInverse is current.
    this.camera.updateMatrixWorld()
    this.curViewProj.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)

    this.scene.overrideMaterial = this.normalMaterial
    this.renderer.setRenderTarget(this.normalTarget)
    // Clear so cleared depth reads 1.0 (== "no geometry"/sky) for the passes that gate on it.
    this.renderer.clear()
    this.renderer.render(this.scene, this.camera)

    // R4: HERO_LAYER sharp-mask render. Mask the camera to layer 2 only, override every hero with
    // FLAT WHITE, and render onto a BLACK background → coverage mask for VelocitySmear (.r=1 over
    // the kart/swords, 0 elsewhere). Same shaken camera, so the mask is pixel-aligned with the
    // painted frame. Restore the camera to all layers afterward so the colour frame is unaffected.
    const prevClearColor = this.renderer.getClearColor(this.maskClearScratch)
    const prevClearAlpha = this.renderer.getClearAlpha()
    this.scene.overrideMaterial = this.maskMaterial
    this.camera.layers.disableAll()
    this.camera.layers.enable(HERO_LAYER)
    this.renderer.setRenderTarget(this.carMaskTarget)
    this.renderer.setClearColor(0x000000, 1)
    this.renderer.clear()
    this.renderer.render(this.scene, this.camera)
    this.renderer.setClearColor(prevClearColor, prevClearAlpha)
    this.camera.layers.enableAll()

    // Restore everything for the colour render that follows.
    this.scene.overrideMaterial = prevOverride
    this.renderer.setRenderTarget(prevTarget)
    this.camera.far = prevFar
    this.camera.updateProjectionMatrix()
  }

  /**
   * Computes and applies the camera-shake offset for this frame. The amplitude is
   * an ease-out envelope phased off `lastShakeTime` over SHAKE_DURATION_MS; it
   * modulates a two-frequency oscillation (≈10Hz + 7Hz) projected onto a stable
   * random-ish 3D axis so the jitter has texture without reading as a pure sine.
   * A residual term decays by SHAKE_DECAY each frame so any leftover motion settles
   * smoothly to zero once the envelope expires. The net offset is stored in
   * `shakeOffset` and ADDED to the camera here; renderComposite subtracts it back
   * after rendering, keeping the shake non-destructive.
   */
  private applyCameraShake(gameState: GameState): void {
    const now = performance.now()
    const shakeAge = now - gameState.car.lastShakeTime
    const amplitude = gameState.car.cameraShakeAmplitude

    let envelope = 0
    if (Number.isFinite(shakeAge) && shakeAge >= 0 && shakeAge < SHAKE_DURATION_MS) {
      // ease-out-quad: punches instantly, eases to 0 over the window.
      const d = shakeAge / SHAKE_DURATION_MS
      envelope = (1 - d) * (1 - d)
    }

    // Two detuned oscillators (seconds-based phase) give a lively, non-periodic feel.
    const tSec = now / 1000
    const osc =
      Math.sin(tSec * Math.PI * 2 * SHAKE_FREQUENCY) +
      Math.cos(tSec * Math.PI * 2 * SHAKE_FREQUENCY_2) * 0.5

    const drive = amplitude * envelope * osc * SHAKE_FLUX_SCALE

    // Project onto camera-local axes so the shake reads in screen space (mostly
    // lateral + vertical). Reuse scratch vectors to stay allocation-free.
    this.camera.matrixWorld.extractBasis(this.shakeRight, this.shakeUp, this.shakeFwd)

    this.shakeOffset
      .copy(this.shakeRight)
      .multiplyScalar(drive)
      .addScaledVector(this.shakeUp, drive * 0.8)

    // Fold in the decaying residual so prior motion settles smoothly, then decay it.
    this.shakeOffset.add(this.shakeResidual)
    this.shakeResidual.copy(this.shakeOffset).multiplyScalar(SHAKE_DECAY)

    // Clamp each axis so an extreme beat+collision overlap can't fling the camera.
    this.shakeOffset.x = THREE.MathUtils.clamp(this.shakeOffset.x, -SHAKE_MAX, SHAKE_MAX)
    this.shakeOffset.y = THREE.MathUtils.clamp(this.shakeOffset.y, -SHAKE_MAX, SHAKE_MAX)
    this.shakeOffset.z = THREE.MathUtils.clamp(this.shakeOffset.z, -SHAKE_MAX, SHAKE_MAX)

    // Settle exactly to zero once both the envelope and residual are negligible so
    // there is provably no permanent drift.
    if (envelope <= 0.0001 && this.shakeResidual.lengthSq() < 1e-8) {
      this.shakeResidual.set(0, 0, 0)
      this.shakeOffset.set(0, 0, 0)
    }

    this.camera.position.add(this.shakeOffset)
  }


  renderFrame(gameState: GameState): void {
    const now = performance.now()
    const deltaSeconds = this.lastFrameTime
      ? Math.min((now - this.lastFrameTime) / 1000, 0.05)
      : 0
    this.lastFrameTime = now
    // Expose the frame delta to renderComposite so the always-run path can advance
    // the particle simulation regardless of which early-return branch we took.
    this.lastFrameDelta = deltaSeconds

    if (!this.carMesh) {
      // Car not created yet, just render the scene
      this.renderComposite(gameState)
      return
    }

    // If no track data, render default scene with car at origin
    if (!this.trackData) {
      // Position car at origin
      this.carMesh.position.set(0, 0, 0)
      this.carMesh.rotation.set(0, 0, 0)

      // Default camera position - closer to see the scene better
      this.camera.position.set(0, 3, 8)
      this.camera.lookAt(0, 0, 0)
      this.camera.updateProjectionMatrix()

      // Render
      this.updateSunPlacement()
      this.renderComposite(gameState)
      return
    }

    // Track data exists - use existing logic
    // Step forward through the node list instead of oscillating around the nearest node
    const carDistance = gameState.car.distance
    const nodes = this.trackData.nodes

    // Advance forward while the car passes nodes, and allow rewinding gently if needed
    while (
      this.lastNodeIndex < nodes.length - 2 &&
      carDistance > nodes[this.lastNodeIndex + 1].s
    ) {
      this.lastNodeIndex++
    }

    while (this.lastNodeIndex > 0 && carDistance < nodes[this.lastNodeIndex].s) {
      this.lastNodeIndex--
    }

    const currentNode = nodes[this.lastNodeIndex]
    const nextNodeIndex = Math.min(this.lastNodeIndex + 1, nodes.length - 1)
    const nextNode = nodes[nextNodeIndex]

    // Interpolate position between nodes
    const segmentLength = nextNode.s - currentNode.s
    const t = segmentLength > 0 ? (carDistance - currentNode.s) / segmentLength : 0
    const clampedT = Math.max(0, Math.min(1, t))

    const carPos = new THREE.Vector3().lerpVectors(
      currentNode.pos,
      nextNode.pos,
      clampedT
    )

    // Interpolate forward direction and gently smooth it to reduce jitter
    const carForward = new THREE.Vector3().lerpVectors(
      currentNode.forward,
      nextNode.forward,
      clampedT
    ).normalize()

    // Apply lane offset
    const right = new THREE.Vector3().crossVectors(carForward, currentNode.up).normalize()
    const targetLaneOffset = getLaneOffset(gameState.car.laneOffsetIndex)

    // Smooth lane interpolation
    const laneLerpSpeed = 0.1
    gameState.car.laneOffset = THREE.MathUtils.lerp(
      gameState.car.laneOffset,
      targetLaneOffset,
      laneLerpSpeed
    )

    // Cinematic drop-moment orbit snap (iteration 9): on the RISING edge of the
    // controller's drop-focus flag, snap the camera orbit angle square (to 0) for one
    // frame so the car is framed head-on as the moment lands, instead of being viewed at
    // the sideways lane-change angle. Subsequent frames resume the normal lane-following
    // orbit lerp, so the snap reads as a deliberate "settle behind the car" cut.
    if (gameState.isFocusedOnDrop && !this.prevFocused) {
      this.cameraOrbitAngle = 0
    }
    this.prevFocused = gameState.isFocusedOnDrop

    const laneWidth = Math.max(1, Math.abs(getLaneOffset(1)))
    const targetOrbitAngle = (gameState.car.laneOffset / laneWidth) * 0.3
    this.cameraOrbitAngle = THREE.MathUtils.lerp(
      this.cameraOrbitAngle,
      targetOrbitAngle,
      0.16
    )

    const laneOffsetVec = right.clone().multiplyScalar(gameState.car.laneOffset)
    carPos.add(laneOffsetVec)

    if (deltaSeconds === 0) {
      this.lastTrackHeight = carPos.y
    }

    if (deltaSeconds > 0) {
      const trackDelta = carPos.y - this.lastTrackHeight

      if (this.carVerticalOffset > 0) {
        this.carVerticalOffset = Math.max(0, this.carVerticalOffset - trackDelta)
      }

      const slopeSpeed = (carPos.y - this.lastTrackHeight) / deltaSeconds
      const riseThisFrame = Math.max(0, carPos.y - this.lastTrackHeight)
      const lookaheadIndex = Math.min(nextNodeIndex + 3, nodes.length - 1)
      const lookaheadHeight = nodes[lookaheadIndex].pos.y
      const bumpHeightAhead = Math.max(0, lookaheadHeight - carPos.y)

      // Only apply impulse while grounded so we don't keep stacking upward
      // velocity when the track keeps rising.
      const grounded = this.carVerticalOffset <= 0.01

      // Detect the top of a bump: we climbed into this node and are about to
      // level out or descend. Only then should we fire a jump impulse so we
      // don't launch early on small ramps.
      const prevNodeIndex = Math.max(this.lastNodeIndex - 1, 0)
      const prevNode = nodes[prevNodeIndex]
      const prevSegment = Math.max(currentNode.s - prevNode.s, 1)
      const nextSegment = Math.max(nextNode.s - currentNode.s, 1)
      const slopeBehind = (currentNode.pos.y - prevNode.pos.y) / prevSegment
      const slopeAhead = (nextNode.pos.y - currentNode.pos.y) / nextSegment
      const cresting = slopeBehind > 0.02 && slopeAhead <= 0.005
      const crestWindow = clampedT > 0.55
      const crestHeight = Math.max(0, currentNode.pos.y - prevNode.pos.y)
      const significantCrest = crestHeight > 0.2 || bumpHeightAhead > 0.25

      if (grounded && cresting && crestWindow && significantCrest) {
        const crestKick = crestHeight * 9 + Math.max(0, bumpHeightAhead) * 6
        const momentumKick = Math.max(0, slopeSpeed) * 0.06 + riseThisFrame * 8
        const jumpStrength = 12 + crestKick + momentumKick
        this.carVerticalVelocity = Math.max(this.carVerticalVelocity, Math.min(jumpStrength, 20))
      }

      const jumpWindow = clampedT > 0.55
      if (grounded && jumpWindow && (currentNode.isJump || nextNode.isJump)) {
        this.carVerticalVelocity = Math.max(this.carVerticalVelocity, 18)
      }

      const gravity = 32
      const fallMultiplier = this.carVerticalVelocity < 0 ? 1.35 : 1
      this.carVerticalVelocity -= gravity * fallMultiplier * deltaSeconds
      this.carVerticalVelocity = THREE.MathUtils.clamp(
        this.carVerticalVelocity,
        -38,
        30
      )
      this.carVerticalOffset += this.carVerticalVelocity * deltaSeconds
      this.carVerticalOffset = Math.min(this.carVerticalOffset, 7)

      if (this.carVerticalOffset < 0) {
        this.carVerticalOffset = 0
        this.carVerticalVelocity = Math.max(0, -this.carVerticalVelocity * 0.25)
      }

      this.lastTrackHeight = carPos.y
    }

    if (this.smoothedCarPosition.lengthSq() === 0) {
      this.smoothedCarPosition.copy(carPos)
      this.smoothedCarForward.copy(carForward)
      const initialMatrix = new THREE.Matrix4().lookAt(
        carPos,
        carPos.clone().add(carForward),
        currentNode.up
      )
      this.carOrientation.setFromRotationMatrix(initialMatrix)
    }

    const positionSmooth = 0.2
    const forwardSmooth = 0.15

    this.smoothedCarPosition.lerp(carPos, positionSmooth)
    this.smoothedCarForward.lerp(carForward, forwardSmooth).normalize()

    const targetCarMatrix = new THREE.Matrix4().lookAt(
      this.smoothedCarPosition,
      this.smoothedCarPosition.clone().add(this.smoothedCarForward),
      currentNode.up
    )
    const targetCarOrientation = new THREE.Quaternion().setFromRotationMatrix(
      targetCarMatrix
    )
    this.carOrientation.slerp(targetCarOrientation, 0.2)

    const visualCarPosition = this.smoothedCarPosition.clone()
    visualCarPosition.y += this.carVerticalOffset

    const relativeVerticalOffset = Math.max(
      0,
      visualCarPosition.y - this.smoothedCarPosition.y
    )
    gameState.car.verticalOffset = relativeVerticalOffset

    this.handleObstacleCollision(visualCarPosition, gameState)

    // Position and orient car
    this.carMesh.position.copy(visualCarPosition)
    this.carMesh.quaternion.copy(this.carOrientation)

    const smoothedRight = new THREE.Vector3()
      .crossVectors(this.smoothedCarForward, currentNode.up)
      .normalize()

    // Position camera behind and slightly above car with orbiting glide during lane changes.
    // Cinematic pull-back (iteration 9): ease the applied depth scale toward the controller's
    // gameState.cameraDepthScale (1.0 at rest, up to ~1.15 during a drop) and apply it to the
    // chase distance so the camera smoothly pulls back ~1m on drop entry — widening the
    // look-ahead vista — and eases back on exit. Eased here too (on top of the controller's
    // own smoothing) so the framing never snaps even if the upstream scalar moves quickly.
    this.appliedDepthScale = THREE.MathUtils.lerp(
      this.appliedDepthScale,
      gameState.cameraDepthScale,
      CAMERA_DEPTH_LERP
    )
    const cameraDistance = BASE_CAMERA_DISTANCE * this.appliedDepthScale
    // Round 3: a LOWER eye-line (was 3) so we read the kart's flank/shoulder — the rounded
    // surface the broad "helmet" sheen rolls across — instead of a top-down dark blob.
    const cameraHeight = 2.0
    const baseCameraOffset = this.smoothedCarForward
      .clone()
      .multiplyScalar(-cameraDistance)
      .add(currentNode.up.clone().multiplyScalar(cameraHeight))

    // Off-centre diagonal composition (B5): orbit the camera by the PERSISTENT COMPOSE_YAW
    // (a fixed raking stance) PLUS the lane-driven cameraOrbitAngle (the transient glide). The
    // constant yaw is what slides the road's vanishing point off the vertical centre; the lane
    // term still nudges on top of it. The drop-entry orbit snap zeroes only the lane term, so
    // the composition stays raking even during a head-on drop moment.
    baseCameraOffset.applyAxisAngle(currentNode.up, this.cameraOrbitAngle + COMPOSE_YAW)

    const cameraPosition = visualCarPosition.clone().add(baseCameraOffset)
    this.camera.position.lerp(cameraPosition, 0.2)

    // Anticipatory look-ahead (iteration 6): aim further down the track than the old
    // fixed 5m so the camera reacts to upcoming terrain before the car commits. The
    // distance grows with speed (constant 50 u/s here -> ~10m) but is floored at
    // LOOK_AHEAD_DISTANCE for a "smart autopilot" read. We aim along the *upcoming*
    // centerline forward (sampled ahead) rather than just the current heading, so the
    // gaze leads into bends.
    const carSpeed = 50 // matches the GameController/TrackGenerator speed constant
    const lookAheadDist = Math.max(LOOK_AHEAD_DISTANCE, carSpeed * 0.2)
    const aheadForward = this.sampleTrackForward(carDistance + lookAheadDist, this.smoothedCarForward)
    const lookTarget = visualCarPosition
      .clone()
      .add(aheadForward.clone().multiplyScalar(lookAheadDist))
      .add(
        smoothedRight.clone().multiplyScalar(this.cameraOrbitAngle * cameraDistance * 0.45)
      )
      // R-FINAL P3: a fixed lateral aim offset along smoothedRight seats the hero kart in the
      // LOWER-LEFT quadrant. Shifting the look-target to camera-RIGHT swings the optical axis so
      // the car (which stays at visualCarPosition) sits left-of-centre and lower — the off-centre
      // subject the raking diagonal needs (ref 02 anchors its rider in a corner, not centred).
      .add(smoothedRight.clone().multiplyScalar(COMPOSE_LOOK_OFFSET))

    // Off-centre diagonal composition (B5): YAW THE OPTICAL AXIS by a fixed angle rather than
    // translating the near look-target. The road's vanishing point projects where the camera's
    // FORWARD direction points relative to the road's forward; rotating the whole look DIRECTION
    // by a constant COMPOSE_LOOK_YAW about the up axis therefore slides the VP a STABLE amount
    // off the vertical centre (a near-target world offset saturates/overshoots because the
    // target is only ~15m out — see B5 notes). A fixed COMPOSE_PITCH about the right axis lifts
    // the horizon so the diagonal RAKES rather than merely pans. The base target still anchors
    // the car (the camera keeps tracking it + looking ahead); we only rotate the aim around it,
    // so lane glides/banking still read on top and obstacles enter along the resulting diagonal.
    // Sign (measured): the negative COMPOSE_LOOK_YAW used here slides the road/VP to ~20% off the
    // vertical centre toward screen-LEFT and opens ~65-70% quiet negative space on the RIGHT,
    // where the off-axis sun (COMPOSE_SUN_OFFSET, screen-RIGHT) sits well clear of the VP.
    const lookDir = lookTarget.clone().sub(this.camera.position)
    const lookLen = lookDir.length() || 1
    lookDir.normalize()
    lookDir.applyAxisAngle(currentNode.up, COMPOSE_LOOK_YAW)
    lookDir.applyAxisAngle(smoothedRight, -COMPOSE_PITCH) // -ve about right tilts the aim UP
    lookDir.normalize()
    lookTarget.copy(this.camera.position).addScaledVector(lookDir, lookLen)

    const targetMatrix = new THREE.Matrix4().lookAt(this.camera.position, lookTarget, currentNode.up)
    const targetQuaternion = new THREE.Quaternion().setFromRotationMatrix(targetMatrix)

    this.camera.quaternion.slerp(targetQuaternion, 0.25)

    // Anticipatory banking (iteration 6): roll the camera into upcoming curves like a
    // skilled driver leaning through a turn. We measure how much the centerline yaws
    // across the look-ahead window (signed about the up axis), map it past a deadzone
    // to a capped roll, and lerp toward it so the bank glides rather than snaps.
    this.updateCameraBanking(carDistance, currentNode.up)

    // Spectral-energy road morphing (iteration 8): the track surface becomes a third
    // axis of music reactivity, undulating in real time with the music's emotional mood
    // (spectral centroid drives swell, flux drives shimmer). Decoupled from beat/drop
    // systems and from all game state — purely a read of the mood signals the controller
    // sampled this frame.
    this.morphRoadToMusic(gameState, deltaSeconds)

    // Keep the neon floor + ground streaming beneath the car (infinite scroll).
    this.updateFloorFollow(this.smoothedCarPosition)

    // Render
    this.updateSunPlacement()
    this.renderComposite(gameState)
  }

  /**
   * Spectral-energy road elevation morph (iteration 8). Displaces every road vertex's
   * Y from its cached, immutable base position by a travelling sinusoidal wave whose
   * amplitude is driven by the music's emotional mood: spectral centroid (brightness)
   * sets the baseline swell, spectral flux (volatility) adds a shimmer boost, and the
   * one-shot drop envelope gives a brief extra heave on emotional peaks.
   *
   * Design notes:
   *  - We ADD a wave on top of the base shape rather than scaling the absolute Y. The
   *    authored terrain frequently sits at y≈0 (flat passages), where a multiplicative
   *    scale would be invisible; an additive wave keeps the road legibly breathing
   *    everywhere, which is the whole point ("the world dances with the music").
   *  - The wave phase uses each vertex's base Z (its arc-length down the track) so the
   *    crests travel along the road, and an animated `roadMorphPhase` scrolls them past
   *    the camera over time for a living, flowing read.
   *  - The amplitude target is smoothed with a frame-rate-independent lerp and clamped
   *    so the morph swells/settles fluidly with no jarring snaps and no geometric
   *    pathologies. On silence the amplitude relaxes to ~0 and the road idles flat-to-base.
   *  - Pure visual: zero game-state mutation, fully decoupled from the beat FOV punch
   *    and drop bursts (it reads mood, not their event timing). O(n) over the vertices
   *    with a single buffer upload + normals recompute — negligible at our vertex counts.
   */
  private morphRoadToMusic(gameState: GameState, deltaSeconds: number): void {
    if (!this.baseRoadPositions || !this.roadMesh) return

    const car = gameState.car
    // Mood -> target amplitude (world units). Centroid 0..1 gives the baseline swell;
    // flux adds shimmer on volatile/bright passages; the drop envelope heaves briefly on
    // emotional peaks. Tuned conservatively so the road reads as "alive" without ever
    // launching the car or fighting the authored bumps.
    const centroidSwell = car.spectralCentroid * 0.9      // 0 .. 0.9
    const fluxShimmer = car.spectralFlux * 0.7            // 0 .. 0.7
    const dropHeave = car.dropIntensity * 0.6             // 0 .. 0.6
    const targetAmplitude = THREE.MathUtils.clamp(
      centroidSwell + fluxShimmer + dropHeave,
      0,
      1.6
    )

    // Frame-rate-independent smoothing (~0.15 @ 60fps) toward the mood target so the
    // morph glides. Falls back to a fixed factor on the first/paused frames (delta 0).
    const lerpFactor = deltaSeconds > 0 ? 1 - Math.exp(-deltaSeconds * 9) : 0.15
    this.roadMorphAmplitude += (targetAmplitude - this.roadMorphAmplitude) * lerpFactor

    // Scroll the travelling wave. Speed rises a touch on bright/volatile passages so the
    // ripples quicken with energy, but it always advances so the road is never frozen.
    const scrollSpeed = 1.6 + car.spectralCentroid * 2.2 + car.spectralFlux * 2.0
    this.roadMorphPhase += (deltaSeconds > 0 ? deltaSeconds : 1 / 60) * scrollSpeed

    const geometry = this.roadMesh.geometry
    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute
    const positions = posAttr.array as Float32Array
    const base = this.baseRoadPositions
    const amp = this.roadMorphAmplitude

    // Spatial frequencies for the layered wave (per world unit along Z). Two octaves give
    // a richer, less mechanical undulation than a single sine.
    const k1 = 0.06
    const k2 = 0.17
    const phase = this.roadMorphPhase

    for (let i = 0; i < positions.length; i += 3) {
      const bz = base[i + 2] // base Z = arc-length phase coordinate
      // Layered travelling wave, normalized to ~[-1,1], scaled by the mood amplitude.
      const wave =
        Math.sin(bz * k1 + phase) * 0.65 +
        Math.sin(bz * k2 - phase * 1.7) * 0.35
      positions[i] = base[i]                 // x unchanged
      positions[i + 1] = base[i + 1] + wave * amp // y displaced by mood wave
      positions[i + 2] = base[i + 2]         // z unchanged
    }

    posAttr.needsUpdate = true
    geometry.computeVertexNormals()
  }

  /**
   * Samples the track centerline's forward direction at an arbitrary arc-length `s`
   * by locating the bracketing nodes and lerping their forward vectors. Clamps to the
   * track ends and falls back to `fallback` if there is no track (so callers can pass
   * the car's current heading). Allocation-light: returns a fresh normalized vector.
   */
  /**
   * Samples the centerline WORLD POSITION at arc-length `s` (linear interp between the bracketing
   * nodes), into `out`. Mirrors {@link sampleTrackForward}'s cheap forward-walk from the current
   * node. Used by P4 to project a point ~80-120u ahead down the track into clip space and derive
   * the screen-space track-flow direction for the velocity smear. Returns `out`.
   */
  private sampleTrackPosition(s: number, out: THREE.Vector3): THREE.Vector3 {
    const nodes = this.trackData?.nodes
    if (!nodes || nodes.length === 0) return out.copy(this.smoothedCarPosition)
    if (nodes.length === 1 || s <= nodes[0].s) return out.copy(nodes[0].pos)

    const last = nodes[nodes.length - 1]
    if (s >= last.s) return out.copy(last.pos)

    let i = Math.min(this.lastNodeIndex, nodes.length - 2)
    while (i > 0 && nodes[i].s > s) i--
    while (i < nodes.length - 2 && nodes[i + 1].s <= s) i++

    const a = nodes[i]
    const b = nodes[i + 1]
    const span = b.s - a.s
    const f = span > 1e-6 ? THREE.MathUtils.clamp((s - a.s) / span, 0, 1) : 0
    return out.lerpVectors(a.pos, b.pos, f)
  }

  /**
   * P4 — derives and eases the velocity-smear's screen-space FLOW direction (uFlowDir): the
   * direction the static world slides past the camera as the car drives forward, used to inject a
   * wet directional paint-drag (the camera-relative reprojection alone is near-zero in this chase
   * view). Projects a point ~FLOW_LOOKAHEAD units ahead down the centerline AND the car's own
   * world position into clip space with the cached shaken `curViewProj` (the exact transform the
   * frame renders with), perspective-divides both to NDC, and takes the screen vector FROM the
   * ahead-point (near the off-centre vanishing point) TOWARD the car as the flow direction. NDC.xy
   * and UV.xy share orientation (uv = ndc*0.5+0.5), so the normalized NDC delta is a valid UV-space
   * streak direction. Eased toward (FLOW_DIR_EASE) so the drag glides through bends. Writes the
   * pass's uFlowDir uniform. No-op-safe with no track (the ahead/car points collapse and the
   * direction holds its last eased value, which the in-shader reset zeroes anyway on (re)load).
   */
  private updateSmearFlowDir(carDistance: number): void {
    // Ahead point on the centerline (world) and the car's current world position.
    this.sampleTrackPosition(carDistance + FLOW_LOOKAHEAD, this.flowAheadPoint)

    // Project both to clip with the shaken curViewProj, then perspective-divide to NDC.
    this.flowAheadClip
      .set(this.flowAheadPoint.x, this.flowAheadPoint.y, this.flowAheadPoint.z, 1)
      .applyMatrix4(this.curViewProj)
    this.flowCarClip
      .set(this.smoothedCarPosition.x, this.smoothedCarPosition.y, this.smoothedCarPosition.z, 1)
      .applyMatrix4(this.curViewProj)

    // Guard against degenerate w (point behind the camera / on the near plane).
    const wa = this.flowAheadClip.w
    const wc = this.flowCarClip.w
    if (Math.abs(wa) < 1e-4 || Math.abs(wc) < 1e-4) return

    const aheadNdcX = this.flowAheadClip.x / wa
    const aheadNdcY = this.flowAheadClip.y / wa
    const carNdcX = this.flowCarClip.x / wc
    const carNdcY = this.flowCarClip.y / wc

    // Screen vector FROM the ahead-point (vanishing point) TOWARD the car = the direction surfaces
    // flow as the world rushes past. NDC delta == UV-space direction (same orientation).
    let dx = carNdcX - aheadNdcX
    let dy = carNdcY - aheadNdcY
    const len = Math.hypot(dx, dy)
    if (len < 1e-5) return
    dx /= len
    dy /= len

    // Ease toward the target (glide through bends), then write the (re-normalized) uniform.
    this.smoothedFlowDir.x += (dx - this.smoothedFlowDir.x) * FLOW_DIR_EASE
    this.smoothedFlowDir.y += (dy - this.smoothedFlowDir.y) * FLOW_DIR_EASE
    const sLen = Math.hypot(this.smoothedFlowDir.x, this.smoothedFlowDir.y) || 1
    const flow = this.velocitySmearPass.uniforms.uFlowDir.value as THREE.Vector2
    flow.set(this.smoothedFlowDir.x / sLen, this.smoothedFlowDir.y / sLen)
  }

  private sampleTrackForward(s: number, fallback: THREE.Vector3): THREE.Vector3 {
    const nodes = this.trackData?.nodes
    if (!nodes || nodes.length === 0) return fallback.clone().normalize()
    if (nodes.length === 1 || s <= nodes[0].s) return nodes[0].forward.clone().normalize()

    const last = nodes[nodes.length - 1]
    if (s >= last.s) return last.forward.clone().normalize()

    // Walk from the current node forward (cheap: the look-ahead window is short).
    let i = Math.min(this.lastNodeIndex, nodes.length - 2)
    while (i > 0 && nodes[i].s > s) i--
    while (i < nodes.length - 2 && nodes[i + 1].s <= s) i++

    const a = nodes[i]
    const b = nodes[i + 1]
    const span = b.s - a.s
    const f = span > 1e-6 ? THREE.MathUtils.clamp((s - a.s) / span, 0, 1) : 0
    return new THREE.Vector3().lerpVectors(a.forward, b.forward, f).normalize()
  }

  /**
   * Computes and lerps the camera bank (roll) from the curvature of the upcoming
   * centerline. Samples the forward direction at +5/+10/+15m, measures the signed yaw
   * (about `up`) of the farthest sample relative to the current heading, maps it past a
   * small deadzone into a capped roll, and rolls the camera about its own forward axis.
   */
  private updateCameraBanking(carDistance: number, up: THREE.Vector3): void {
    // Sample three points ahead so a short kink reads as little turn while a sustained
    // S-curve accumulates into a clear lean. The farthest sample sets the magnitude.
    const f1 = this.sampleTrackForward(carDistance + 5, this.smoothedCarForward)
    const f3 = this.sampleTrackForward(carDistance + 15, this.smoothedCarForward)

    // Signed turn angle about the up axis: positive = the track bends to the right.
    const cross = new THREE.Vector3().crossVectors(this.smoothedCarForward, f3)
    const sinTurn = cross.dot(up) // |a||b|sin(theta), unit vectors -> sin(theta)
    const cosTurn = THREE.MathUtils.clamp(this.smoothedCarForward.dot(f3), -1, 1)
    let turnDeg = THREE.MathUtils.radToDeg(Math.atan2(sinTurn, cosTurn))

    // Blend in the nearer sample a little so the onset of a bend is felt slightly
    // earlier without overshooting on a brief jog.
    const nearCross = new THREE.Vector3().crossVectors(this.smoothedCarForward, f1)
    const nearTurnDeg = THREE.MathUtils.radToDeg(
      Math.atan2(nearCross.dot(up), THREE.MathUtils.clamp(this.smoothedCarForward.dot(f1), -1, 1))
    )
    turnDeg = turnDeg * 0.7 + nearTurnDeg * 0.3

    // Past a deadzone, ramp linearly to the cap. Bank INTO the turn like a motorcycle:
    // rolling about local forward (-Z) by a positive angle dips the right side of the
    // view, so a right bend (positive turnDeg) maps to a positive roll (lean right).
    let targetRollDeg = 0
    const absTurn = Math.abs(turnDeg)
    if (absTurn > CAMERA_BANKING_ANGLE_DEADZONE) {
      const ramp = (absTurn - CAMERA_BANKING_ANGLE_DEADZONE) / 25 // ~25deg of turn -> full bank
      const mag = Math.min(CAMERA_BANKING_ANGLE_MAX, ramp * CAMERA_BANKING_ANGLE_MAX)
      targetRollDeg = Math.sign(turnDeg) * mag
    }

    // Smooth toward the target so banking eases in/out (never snaps), then apply it as
    // a roll about the camera's own forward axis on top of the look-at orientation.
    this.cameraRoll = THREE.MathUtils.lerp(
      this.cameraRoll,
      THREE.MathUtils.degToRad(targetRollDeg),
      CAMERA_BANKING_LERP
    )
    // Roll about the camera's LOCAL forward axis (-Z in view space) so the banking
    // composes cleanly with the look-at orientation regardless of world heading.
    if (Math.abs(this.cameraRoll) > 1e-4) {
      this.camera.rotateOnAxis(ROLL_AXIS, this.cameraRoll)
    }
  }

  private updateSunPlacement(): void {
    if (!this.sunMesh) return

    const viewDir = new THREE.Vector3()
    this.camera.getWorldDirection(viewDir)

    const elapsed = (performance.now() - this.startTime) / 1000
    const sunDistance = 800

    // Off-centre diagonal composition (Watercolour Speed B5, §5 "Sun / horizon"): the soft
    // achromatic-to-cool luminous disc is pulled OFF the view centre and NEVER stacked on the
    // vanishing point (the hard ban on the centred one-point stack). The camera already rakes
    // off-axis (COMPOSE_YAW orbit + COMPOSE_LOOK_YAW optical-axis yaw slide the road's VP toward
    // screen-LEFT), so we seat the sun in the quiet negative-space region on the opposite side
    // (screen-RIGHT) and lifted, where it reads as a pale wet bloom of light dissolving into
    // the sky wash rather than a disc sitting on the road's convergence. Anchored to the
    // camera-relative view basis so it stays put in-frame as the world rushes past; a whisper
    // of drift keeps it from reading as a frozen sprite.
    const horizonDrift = Math.sin(elapsed * 0.15) * 0.04
    const heightWave = Math.sin(elapsed * 0.1) * 6

    const right = new THREE.Vector3().crossVectors(viewDir, new THREE.Vector3(0, 1, 0)).normalize()

    const targetPos = this.camera.position
      .clone()
      .add(viewDir.clone().multiplyScalar(sunDistance))
      // Persistent screen-RIGHT lateral seat (off the VP, into the open negative space) plus a
      // tiny drift. Positive COMPOSE_SUN_OFFSET pushes it to the side opposite the raked VP.
      .add(right.multiplyScalar(sunDistance * (COMPOSE_SUN_OFFSET + horizonDrift)))

    // Seat the disc above the horizon line so it reads as a high pale bloom off the diagonal,
    // not a sun resting on the (deleted) grid. The banded striped sun is gone — this is a soft
    // value-lift disc, so it can ride higher without a hard scanline edge to betray it.
    const horizonBase = Math.max(70, this.camera.position.y * 0.2 + 64)
    targetPos.y = horizonBase + heightWave

    this.sunMesh.position.copy(targetPos)
    this.sunMesh.quaternion.copy(this.camera.quaternion)
  }
}

