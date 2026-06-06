import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { createFilmGrainPass } from './FilmGrainPass'
import { createVignettePass } from './VignettePass'
import { createChromaticAberrationPass } from './ChromaticAberrationPass'
import { createNeonCompositePass } from './NeonCompositePass'
import { RimGlowShell } from './RimGlowShell'
import { TrackData } from '../track/TrackTypes'
import { GameState, getLaneOffset } from '../game/GameState'

// Beat-sync envelope tuning. The FOV "punch" zooms out fast on a beat onset then
// eases back; the bloom pulse spikes and decays. These are evaluated procedurally
// each frame from (now - lastBeatTime) so they are frame-rate independent and need
// no tween bookkeeping (matching the codebase's manual-lerp style).
const BASE_FOV = 75
const FOV_PUNCH = 9 // extra degrees added at peak of a full-strength beat
const FOV_ATTACK_MS = 90 // ramp up to peak
const FOV_DECAY_MS = 420 // ease back to base
const BLOOM_BASE_STRENGTH = 0.95
const BLOOM_BEAT_BOOST = 0.85 // added at peak of a full-strength beat
const BLOOM_DECAY_MS = 260

// Beat selectivity + anticipatory camera tuning (iteration 6).
//
// Beat selectivity: strong beats (kicks, snares) punch FOV/bloom/shake and glow the
// beat indicator; weak beats (hi-hats, transients) sustain the baseline mood without
// transient spikes. This "professional restraint" reads as premium (Wipeout, Nintendo,
// Tesla-promo aesthetic) rather than a generic visualizer that reacts to every tick.
// The strength gate itself (BEAT_STRENGTH_THRESHOLD = 0.5) lives in the controller,
// which sets car.beatFires; the renderer simply reads that flag to gate its transient
// gestures (FOV/bloom/shake/indicator) below.
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

// Mood-driven tuning (iteration 2). These layer on TOP of the beat-sync envelopes
// so the world reacts to both rhythm (fast, per-beat) and mood (slow, per-section).
// Cool intros sit at low centroid -> tight bloom + cyan sky; bright drops push high
// centroid -> looser glow + magenta sky, with an extra FOV expansion on drop entry.
const BLOOM_THRESHOLD_COOL = 0.85 // tight, controlled bloom on cool/quiet moods
const BLOOM_THRESHOLD_WARM = 0.62 // looser, blown-out glow on bright/hot moods
const FOV_DROP_PUNCH = 6 // extra degrees at full drop intensity (cinematic expand)
const GRID_EMISSIVE_MIN = 0.3 // dim grid in calm passages
const GRID_EMISSIVE_RANGE = 0.4 // -> up to 0.7 at peak brightness

// Cinematic drop-moment choreography (iteration 9). When the controller's drop-focus
// state machine engages (gameState.isFocusedOnDrop), the chase camera pulls back and the
// FOV widens together as one gesture, framing the accelerating car against the vista like
// an automotive promo cut. The camera pull-back is driven by gameState.cameraDepthScale
// (the controller-smoothed 0.9..1.2 multiplier) applied to the base chase distance; the
// extra FOV is a complementary widening bound to the SAME normalized depth excess, so the
// two always move in concert. On the rising edge of the focus flag the camera orbit angle
// is snapped square (one frame) so the car is framed head-on during the moment.
const BASE_CAMERA_DISTANCE = 8 // resting chase distance behind the car (units)
const FOV_DROP_BOOST_MAX = 7 // extra degrees of FOV at full camera pull-back (6-8° band)
const CAMERA_DEPTH_LERP = 0.12 // per-frame ease of the applied depth toward cameraDepthScale

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
const PARTICLES_PER_COLLISION = 80 // burst count on an obstacle hit
const PARTICLE_LIFETIME_DROP = 0.6 // seconds a drop-burst particle lives
const PARTICLE_LIFETIME_COLLISION = 0.5 // seconds a collision-burst particle lives

// Mood-burst colors keyed off spectral centroid (perceived brightness): dim/cool
// sections burst cyan, bright/hot sections burst magenta, matching the sky sweep.
const BURST_COLOR_COOL = new THREE.Color(0x6af6ff)
const BURST_COLOR_HOT = new THREE.Color(0xff00ff)

// Cinematic post-processing tuning (iteration 4). The film grain + vignette are
// always-on, subtle, and frame-state-free (the grain only animates via a time
// uniform). Chromatic aberration sits at 0 at rest and spikes briefly on impact for
// a Wipeout-style "lens kick" that decays over CHROMATIC_DECAY_MS — driven off the
// renderer's existing collision timestamp (no new game state needed).
const FILM_GRAIN_INTENSITY = 0.032 // tiny: reads as film texture, never as snow
const VIGNETTE_DARKNESS = 0.7 // corner brightness (30% darker) to frame the car
// Collision is now a punchy spike that STACKS on top of an always-present flux
// baseline (iteration 5), so it's pulled down from 1.0 -> 0.8: the lens kick still
// reads as a hard impact but no longer oversaturates against the live baseline.
const CHROMATIC_COLLISION_PEAK = 0.8 // max CA contribution at the instant of a hit
const CHROMATIC_DECAY_MS = 220 // ease the lens kick back to 0 over this window

// Spectral-flux -> chromatic-aberration tuning (iteration 5). Flux (treble
// volatility, 0..1) was computed and smoothed upstream but never made visible.
// Binding it to a CA *baseline* turns treble transients into a prismatic shimmer:
// a two-stage envelope sits gently at rest (BASELINE_MIN..MAX as flux climbs to the
// SPIKE_THRESHOLD) then ramps faster toward SPIKE_MAX on bright, volatile peaks, so
// the lens fringing breathes with the music instead of only kicking on collisions.
const CHROMATIC_FLUX_BASELINE_MIN = 0.1 // resting shimmer when flux ≈ 0
const CHROMATIC_FLUX_BASELINE_MAX = 0.3 // shimmer as flux approaches the spike knee
const CHROMATIC_FLUX_SPIKE_THRESHOLD = 0.6 // flux above this ramps harder (energy peak)
const CHROMATIC_FLUX_SPIKE_MAX = 0.5 // extra CA added across the post-threshold range
// Hero-car emissive isolation (iteration 5). The player body's emissive intensity is
// scaled each frame by (BASE + RANGE × centroid) so the car glows hotter during bright
// emotional peaks and settles to a calm floor in quiet passages — a centroid-driven
// focal "product light" that stacks orthogonally with the beat (FOV/bloom) and flux
// (CA) gestures. Applied to base intensities captured once at model load.
const CAR_EMISSIVE_CENTROID_BASE = 0.3 // floor multiplier on calm/dark sections
const CAR_EMISSIVE_CENTROID_RANGE = 0.5 // -> up to 0.8× at peak perceived brightness

// Focal-hierarchy layers (iteration 7). The neon/emissive "hero" objects live on
// NEON_LAYER (car, particles, obstacles, sky, sun, starfield, beat indicator, rim glow)
// and the sharp, non-glowing geometry (road, grid, ground, lane markers) stays on the
// default LAYER_DEFAULT. This is organizational scaffolding for the focal read: the
// actual bloom selectivity is delivered by the disciplined UnrealBloomPass threshold
// (the dim road/grid sit below it; the bright neon heroes sit above it) in ONE clean
// pass, which is the correct single-render mechanism here — wrapping the lone composer
// render in camera.layers.set(NEON_LAYER) would erase the road/grid from the frame, so
// the camera keeps layers.enableAll() and sees everything. Keeping the layer split in
// place future-proofs a true two-target selective-bloom upgrade with zero refactor.
const LAYER_DEFAULT = 0
const NEON_LAYER = 1
// Hero-isolation layer (iteration 9). The SELECTIVE-bloom isolation render (a second
// composer, additively composited on top) must draw ONLY the foreground hero objects —
// the car + rim glow, drop/treble/collision particles, the beat indicator, and the sword
// obstacles — and explicitly EXCLUDE the background neon (sky dome, sun disc, starfield),
// because the sky fills the whole frame and re-adding it additively would wash the image
// and erase the road's legibility. Hero objects are tagged onto this layer IN ADDITION to
// NEON_LAYER (via layers.enable, not set), so they still render normally in the all-layers
// primary pass while also appearing in the hero-only isolation pass.
const HERO_LAYER = 2

// Mood-scaled bloom base strength (iteration 7). The overall glow now BREATHES with the
// emotional arc: cool/dim intros sit tight at COOL, bright drops blow out toward HOT.
// This replaces the single hardcoded base; the per-beat pulse + drop expansion still
// STACK on top so rhythm punch and emotional peaks remain visible and distinct.
const BLOOM_STRENGTH_COOL = 0.9 // base glow on cool/dim sections (low centroid)
const BLOOM_STRENGTH_HOT = 1.6 // base glow on bright/hot sections (high centroid)

// Selective-bloom isolation tuning (iteration 9). A SECOND EffectComposer renders only
// the NEON_LAYER geometry through an exaggerated bloom into an offscreen target, which is
// then additively composited on top of the primary (full-scene) render. This delivers the
// premium focal hierarchy the mission calls for: the hero car's rim glow + drop-burst
// particles bloom dramatically while the road/grid (only present in the primary render,
// with its disciplined threshold) stay razor-sharp. The neon bloom uses a LOW threshold so
// the car's emissive/rim edges catch the glow aggressively, and its strength swells on
// drops (driven per-frame in renderComposite from the same mood/drop signals as the
// primary bloom). The composite is pure-additive so it is stable and flicker-free.
const NEON_BLOOM_STRENGTH_BASE = 1.1 // resting neon-glow strength (calm sections)
const NEON_BLOOM_STRENGTH_DROP = 2.0 // peak neon-glow strength at full drop intensity
const NEON_BLOOM_RADIUS = 0.85 // slightly wider than the primary for a softer hero halo
// Two-threshold split (iteration 9): the neon composer's threshold tracks mood DOWNWARD
// (cool 0.75 -> warm 0.52) so the hero car's emissive + rim edges catch bloom ever more
// aggressively as the music brightens, while the PRIMARY composer keeps its conservative
// threshold (0.35-floor mood lerp, unchanged) so the road/grid never smear.
const NEON_BLOOM_THRESHOLD_COOL = 0.75
const NEON_BLOOM_THRESHOLD_WARM = 0.52
// Composite contribution at rest vs. during a drop. Kept modest at rest so the neon glow
// reads as a tasteful focal light rather than a constant wash; lifts on drops so the hero
// car flares as the cinematic moment lands. Driven per-frame from the drop envelope.
const NEON_COMPOSITE_STRENGTH_BASE = 0.85
const NEON_COMPOSITE_STRENGTH_DROP = 1.25

// Treble shimmer tuning (iteration 7). On each high-frequency transient the hero car
// sprays a small additive burst that pumps straight into the bloom — the missing
// music-FREQUENCY signal. Cool moods spark cyan, hot moods magenta (matching the sky
// sweep). Kept tiny + short so it reads as a fast sparkle, orthogonal to the beat punch.
const TREBLE_BURST_COUNT_MIN = 6 // particles at threshold strength
const TREBLE_BURST_COUNT_MAX = 8 // particles at full-strength transient
const TREBLE_BURST_SPEED = 6 // outward fling speed (slower/tighter than drop bursts)
const TREBLE_BURST_LIFETIME = 0.25 // seconds — a quick sparkle, not a lingering plume

const ANALOGOUS_PALETTE = {
  abyss: new THREE.Color(0x041226),
  midnight: new THREE.Color(0x0a2f44),
  tealShadow: new THREE.Color(0x0f3c56),
  aquaCore: new THREE.Color(0x1ee0ff),
  cyanGlow: new THREE.Color(0x6af6ff),
  mintHighlight: new THREE.Color(0x30f3c8),
  redAccent: new THREE.Color(0xff3a53)
}

/**
 * A fixed-capacity GPU particle system with ring-buffer pooling (iteration 3).
 *
 * All particles live in a single `THREE.Points` backed by pre-allocated typed
 * arrays, so emitting a burst never allocates — it just stamps fields into the
 * next free slots. Dead particles are simply skipped (size 0), and the buffer
 * geometry's draw range is shrunk to the high-water mark so we never upload more
 * than we use. Additive blending makes live particles glow straight into the
 * bloom pass for free. This avoids per-frame GC, the source of frame hitches.
 */
class ParticlePool {
  readonly points: THREE.Points
  private readonly geometry: THREE.BufferGeometry
  private readonly positions: Float32Array
  private readonly colors: Float32Array
  private readonly baseColors: Float32Array
  private readonly sizes: Float32Array
  private readonly velocities: Float32Array
  private readonly age: Float32Array
  private readonly lifetime: Float32Array
  private readonly baseSize: Float32Array
  private readonly capacity: number
  private cursor = 0
  private liveHighWater = 0
  // Scratch color to avoid per-emit allocation.
  private readonly scratch = new THREE.Color()

  constructor(capacity = 280) {
    this.capacity = capacity
    this.positions = new Float32Array(capacity * 3)
    this.colors = new Float32Array(capacity * 3)
    this.baseColors = new Float32Array(capacity * 3)
    this.sizes = new Float32Array(capacity)
    this.velocities = new Float32Array(capacity * 3)
    this.age = new Float32Array(capacity)
    this.lifetime = new Float32Array(capacity)
    this.baseSize = new Float32Array(capacity)

    this.geometry = new THREE.BufferGeometry()
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3))
    // Per-vertex point size. Named `aSize` (not `size`) to avoid colliding with the
    // built-in `uniform float size` in the PointsMaterial vertex shader, which we
    // patch below to multiply by this attribute so each particle can size + fade
    // independently (stock PointsMaterial only supports one global size uniform).
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1))
    this.geometry.setDrawRange(0, 0)

    // Soft round sprite so particles read as glowing embers, not hard squares.
    const texture = ParticlePool.createSpriteTexture()
    const material = new THREE.PointsMaterial({
      size: 1,
      map: texture,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      toneMapped: false
    })
    // Patch the shader to honour the per-vertex `aSize` attribute. The stock vertex
    // shader sets `gl_PointSize = size;`; we make `size` (=1) a multiplier of aSize.
    material.onBeforeCompile = shader => {
      shader.vertexShader =
        'attribute float aSize;\n' +
        shader.vertexShader.replace(
          'gl_PointSize = size;',
          'gl_PointSize = size * aSize;'
        )
    }

    this.points = new THREE.Points(this.geometry, material)
    this.points.frustumCulled = false
    this.points.renderOrder = 5
  }

  private static createSpriteTexture(): THREE.CanvasTexture {
    const size = 64
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (ctx) {
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
      g.addColorStop(0, 'rgba(255,255,255,1)')
      g.addColorStop(0.4, 'rgba(255,255,255,0.6)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, size, size)
    }
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  }

  /**
   * Spawns `count` particles from `origin`, each flung outward with a random
   * radial direction scaled by `speed`, tinted `color`, living `lifetime` seconds.
   * Uses the ring buffer so an over-emit simply overwrites the oldest particles
   * (graceful degradation) rather than allocating.
   */
  emitBurst(count: number, origin: THREE.Vector3, speed: number, color: THREE.Color, lifetime: number): void {
    const n = Math.max(0, Math.min(this.capacity, Math.floor(count)))
    for (let k = 0; k < n; k++) {
      const idx = this.cursor
      this.cursor = (this.cursor + 1) % this.capacity

      // Random direction on a sphere, biased slightly upward for a fountain look.
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      const dx = Math.sin(phi) * Math.cos(theta)
      const dy = Math.abs(Math.cos(phi)) * 0.8 + 0.25 // upward bias
      const dz = Math.sin(phi) * Math.sin(theta)
      const spd = speed * (0.5 + Math.random() * 0.8)

      const p3 = idx * 3
      this.positions[p3] = origin.x
      this.positions[p3 + 1] = origin.y
      this.positions[p3 + 2] = origin.z
      this.velocities[p3] = dx * spd
      this.velocities[p3 + 1] = dy * spd
      this.velocities[p3 + 2] = dz * spd

      // Slight per-particle color jitter toward white core for a hotter center.
      this.scratch.copy(color).lerp(ParticlePool.WHITE, Math.random() * 0.3)
      this.baseColors[p3] = this.scratch.r
      this.baseColors[p3 + 1] = this.scratch.g
      this.baseColors[p3 + 2] = this.scratch.b
      this.colors[p3] = this.scratch.r
      this.colors[p3 + 1] = this.scratch.g
      this.colors[p3 + 2] = this.scratch.b

      // World-space-ish point size (sizeAttenuation on). Tuned to read clearly at
      // the ~8m chase-camera distance without blowing out the frame.
      const base = 2.5 + Math.random() * 3.5
      this.baseSize[idx] = base
      this.sizes[idx] = base
      this.age[idx] = 0
      this.lifetime[idx] = lifetime

      if (idx + 1 > this.liveHighWater) this.liveHighWater = idx + 1
    }
  }

  /**
   * Ages every live particle, integrates simple gravity-damped motion, and fades
   * opacity/size as it approaches end-of-life. Recomputes only the live slice and
   * flags the attributes for a single GPU upload. Dead particles collapse to size
   * 0 so they draw nothing without needing to be compacted out of the buffer.
   */
  update(deltaSeconds: number): void {
    if (deltaSeconds <= 0 || this.liveHighWater === 0) return

    const GRAVITY = 6 // gentle downward pull (metres/s^2) so embers arc and settle
    const DRAG = 0.94 // per-frame velocity damping for a soft, weighty decel
    let anyAlive = false

    for (let i = 0; i < this.liveHighWater; i++) {
      const life = this.lifetime[i]
      if (life <= 0) continue
      let a = this.age[i]
      if (a >= life) {
        if (this.sizes[i] !== 0) this.sizes[i] = 0
        continue
      }

      a += deltaSeconds
      this.age[i] = a

      const p3 = i * 3
      this.velocities[p3] *= DRAG
      this.velocities[p3 + 1] = this.velocities[p3 + 1] * DRAG - GRAVITY * deltaSeconds
      this.velocities[p3 + 2] *= DRAG
      this.positions[p3] += this.velocities[p3] * deltaSeconds
      this.positions[p3 + 1] += this.velocities[p3 + 1] * deltaSeconds
      this.positions[p3 + 2] += this.velocities[p3 + 2] * deltaSeconds

      // Lifetime lerp: size 1.0 -> 0.3, and brightness fades to 0 so the additive
      // glow vanishes cleanly (per-particle dim — material opacity would be global).
      // Ease-out (fade^1.5) keeps embers bright early then drops off fast at the end.
      const fade = 1 - a / life
      const glow = fade * Math.sqrt(fade)
      this.sizes[i] = this.baseSize[i] * (0.3 + 0.7 * fade)
      this.colors[p3] = this.baseColors[p3] * glow
      this.colors[p3 + 1] = this.baseColors[p3 + 1] * glow
      this.colors[p3 + 2] = this.baseColors[p3 + 2] * glow
      anyAlive = true
    }

    if (!anyAlive) {
      this.liveHighWater = 0
    }

    const posAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute
    const colAttr = this.geometry.getAttribute('color') as THREE.BufferAttribute
    const sizeAttr = this.geometry.getAttribute('aSize') as THREE.BufferAttribute
    posAttr.needsUpdate = true
    colAttr.needsUpdate = true
    sizeAttr.needsUpdate = true
    this.geometry.setDrawRange(0, this.liveHighWater)
  }

  reset(): void {
    this.cursor = 0
    this.liveHighWater = 0
    this.sizes.fill(0)
    this.lifetime.fill(0)
    this.age.fill(0)
    this.geometry.setDrawRange(0, 0)
    const sizeAttr = this.geometry.getAttribute('aSize') as THREE.BufferAttribute
    sizeAttr.needsUpdate = true
  }

  private static readonly WHITE = new THREE.Color(0xffffff)
}

export class ThreeScene {
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private composer: EffectComposer
  private bloomPass: UnrealBloomPass
  // Selective-bloom isolation pipeline (iteration 9). The neon composer renders ONLY the
  // NEON_LAYER geometry through an exaggerated bloom into `neonRenderTarget`; the result is
  // additively composited onto the primary render by `neonCompositePass` (the final pass of
  // the primary chain). See the NEON_BLOOM_* constants for the design rationale.
  private neonRenderTarget: THREE.WebGLRenderTarget
  private neonComposer: EffectComposer
  private neonBloomPass: UnrealBloomPass
  private neonCompositePass: ShaderPass
  // Cinematic post passes (iteration 4). CA intensity is driven per-frame from the
  // collision envelope; grain advances its time uniform each frame; vignette is static.
  private chromaticPass: ShaderPass
  private filmGrainPass: ShaderPass
  // Beat-locked hero-car rim glow (iteration 4). Built lazily once the car bounds are
  // known, parented under the car group, and updated each frame from beat + mood.
  private rimGlow: RimGlowShell | null = null
  // Player-car body materials + their base emissive intensities, captured when the
  // palette is applied (iteration 5). Per-frame, each base is scaled by a centroid-
  // driven multiplier so the hero car glows hotter on bright emotional peaks. Reset
  // and re-collected whenever the car model is (re)built so it never references stale
  // materials (e.g. when the GLB swaps in over the procedural fallback).
  private carEmissiveMaterials: { material: THREE.Material & { emissiveIntensity: number }; base: number }[] = []
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
  private skyMaterial: THREE.ShaderMaterial | null = null
  private starField: THREE.Points | null = null
  private sunMesh: THREE.Mesh | null = null
  private gridHelper: THREE.GridHelper | null = null
  private beatIndicator: THREE.Sprite | null = null
  private beatIndicatorMaterial: THREE.SpriteMaterial | null = null
  private trebleMeshes: THREE.Object3D[] = []
  private swordTemplate: THREE.Object3D | null = null
  private swordTemplatePromise: Promise<THREE.Object3D | null> | null = null
  private startTime = performance.now()
  private cameraOrbitAngle = 0
  // Cinematic drop-moment state (iteration 9). `appliedDepthScale` eases toward the
  // controller's gameState.cameraDepthScale so the camera pull-back glides; `prevFocused`
  // tracks the focus flag to detect its rising edge (snap orbit square on drop entry); and
  // `bloomFocusEnvelope` is a 0..1 sustain envelope that ramps up while focused and decays
  // on exit, holding the bloom elevated through the whole drop rather than per-beat-decaying.
  private appliedDepthScale = 1
  private prevFocused = false
  private bloomFocusEnvelope = 0
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
    this.renderer.setClearColor(ANALOGOUS_PALETTE.abyss.getHex(), 1)

    // Professional color grading: ACES filmic tone mapping + sRGB output gives the
    // scene a cinematic, "graded" look instead of flat linear rendering. The final
    // tone-map / color-space conversion is applied by OutputPass at the end of the
    // composer chain, but we set it on the renderer so OutputPass picks it up.
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.2

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
    // The PRIMARY render sees ALL layers (iteration 7): it draws the whole world (road,
    // grid, neon heroes) with a disciplined bloom threshold so the road/grid stay sharp.
    // Iteration 9 adds a SEPARATE hero-only render (camera.layers temporarily masked to
    // HERO_LAYER) that is additively composited on top for an exaggerated hero glow; that
    // masking is applied transiently per-frame in renderComposite, then restored here.
    this.camera.layers.enableAll()

    // Post-processing pipeline (iteration 4):
    //   RenderPass -> UnrealBloomPass -> OutputPass -> ChromaticAberration -> Vignette -> FilmGrain
    // Bloom makes the neon emissives glow like a premium synthwave promo film, and
    // OutputPass performs the ACES tone-map + sRGB conversion. The three cinematic
    // passes run AFTER OutputPass so they operate on the final, display-space graded
    // image — the correct place for lens/film effects: CA fringing, edge vignette,
    // and film grain all read as artifacts of the camera/stock, not of the linear
    // scene, and aren't re-tone-mapped. The last pass auto-renders to screen.
    this.composer = new EffectComposer(this.renderer)
    this.composer.setSize(width, height)
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      BLOOM_BASE_STRENGTH, // strength (re-driven per frame from mood + beat in renderComposite)
      0.8, // radius
      // Threshold raised 0.25 -> 0.35 (iteration 7) for a more disciplined, selective
      // bloom so dim geometry (road/grid) stays sharp while neon heroes glow. The
      // runtime mood lerp in renderComposite still drives the live threshold even higher
      // on cool sections and eases it down on hot ones; this is just the initial value.
      0.35
    )
    this.composer.addPass(this.bloomPass)
    this.composer.addPass(new OutputPass())

    // Chromatic aberration: 0 at rest, spiked on collision (driven in renderComposite).
    this.chromaticPass = createChromaticAberrationPass(0.0)
    this.composer.addPass(this.chromaticPass)
    // Vignette: static radial edge darkening to frame the hero car + road.
    this.composer.addPass(createVignettePass(VIGNETTE_DARKNESS))
    // Film grain: always-on subtle animated noise (time uniform advanced per frame).
    this.filmGrainPass = createFilmGrainPass(FILM_GRAIN_INTENSITY)
    this.composer.addPass(this.filmGrainPass)

    // --- Selective-bloom isolation (iteration 9). A second, offscreen composer renders
    // ONLY the NEON_LAYER geometry through an exaggerated bloom + tone-map into
    // `neonRenderTarget`. Its result is additively composited onto the primary, fully-graded
    // image by `neonCompositePass`, which we append as the FINAL pass of the primary chain
    // (so it renders to screen, adding the neon glow on top of the road/grid that stay sharp
    // in the primary render). Both composers tone-map to sRGB so the additive blend happens
    // in a consistent display space and reads cleanly with no banding.
    const dpr = Math.min(window.devicePixelRatio, 2)
    this.neonRenderTarget = new THREE.WebGLRenderTarget(
      Math.floor(width * dpr),
      Math.floor(height * dpr),
      {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        // sRGB so the neon target matches the primary's OutputPass display space.
        colorSpace: THREE.SRGBColorSpace,
        depthBuffer: true
      }
    )
    this.neonComposer = new EffectComposer(this.renderer, this.neonRenderTarget)
    this.neonComposer.setSize(width, height)
    this.neonComposer.setPixelRatio(dpr)
    // The neon RenderPass clears to transparent black so non-neon pixels contribute
    // nothing to the additive composite (only the neon heroes + their bloom carry light).
    const neonRenderPass = new RenderPass(this.scene, this.camera)
    neonRenderPass.clearColor = new THREE.Color(0x000000)
    neonRenderPass.clearAlpha = 1
    this.neonComposer.addPass(neonRenderPass)
    this.neonBloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      NEON_BLOOM_STRENGTH_BASE, // re-driven per frame from the drop envelope
      NEON_BLOOM_RADIUS,
      NEON_BLOOM_THRESHOLD_COOL // re-driven per frame (mood lerp toward WARM)
    )
    this.neonComposer.addPass(this.neonBloomPass)
    this.neonComposer.addPass(new OutputPass())
    // The neon composer renders to its target (never to screen), so its final pass must
    // NOT auto-blit to the canvas. EffectComposer sets renderToScreen on the last pass; we
    // force it off here because this composer's "output" is the offscreen texture.
    this.neonComposer.renderToScreen = false

    // Composite pass: samples the neon target and adds it over the primary graded image.
    // Appended LAST so it becomes the primary composer's renderToScreen pass.
    this.neonCompositePass = createNeonCompositePass(NEON_COMPOSITE_STRENGTH_BASE)
    this.neonCompositePass.uniforms.tNeon.value = this.neonRenderTarget.texture
    this.composer.addPass(this.neonCompositePass)

    // Lighting - brighter for better visibility
    const ambientLight = new THREE.AmbientLight(ANALOGOUS_PALETTE.cyanGlow, 0.4)
    this.scene.add(ambientLight)

    const directionalLight = new THREE.DirectionalLight(ANALOGOUS_PALETTE.mintHighlight, 1.15)
    directionalLight.position.set(10, 10, 10)
    this.scene.add(directionalLight)

    // Add a point light near the car for better visibility
    const pointLight = new THREE.PointLight(ANALOGOUS_PALETTE.redAccent, 1.5, 120)
    pointLight.position.set(0, 5, 2)
    this.scene.add(pointLight)

    // Create synthwave background
    this.createBackground()

    // GPU particle pool for beat-drop + collision bursts. Added to the scene once;
    // emits are stamped into pre-allocated buffers so there is no per-frame GC.
    this.particlePool = new ParticlePool(280)
    this.particlePool.points.layers.set(NEON_LAYER) // emissive hero (iteration 7)
    this.particlePool.points.layers.enable(HERO_LAYER) // hero-isolation bloom (iteration 9)
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

    // Do initial render through the composer so tone mapping / bloom apply.
    this.composer.render()
  }

  private createBackground(): void {
    // Create gradient sky dome with shader for synthwave hues
    const skyGeometry = new THREE.SphereGeometry(5000, 64, 64)
    const skyMaterial = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: ANALOGOUS_PALETTE.abyss.clone() },
        midColor: { value: ANALOGOUS_PALETTE.midnight.clone() },
        horizonColor: { value: ANALOGOUS_PALETTE.cyanGlow.clone() },
        glowIntensity: { value: 1.0 },
        // Mood uniforms (iteration 2): perceived brightness 0..1 and the drop
        // decay envelope 0..1. The fragment shader blends the horizon band from
        // cool cyan toward hot magenta in HSL as these rise, so the whole sky
        // emotionally tracks the music.
        spectralCentroidNorm: { value: 0.0 },
        dropIntensity: { value: 0.0 }
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
        uniform vec3 midColor;
        uniform vec3 horizonColor;
        uniform float glowIntensity;
        uniform float spectralCentroidNorm;
        uniform float dropIntensity;

        // Standard HSL->RGB so we can sweep hue/sat/lightness by mood directly.
        vec3 hsl2rgb(vec3 hsl) {
          float h = hsl.x;
          float s = hsl.y;
          float l = hsl.z;
          float c = (1.0 - abs(2.0 * l - 1.0)) * s;
          float hp = h * 6.0;
          float x = c * (1.0 - abs(mod(hp, 2.0) - 1.0));
          vec3 rgb;
          if (hp < 1.0) rgb = vec3(c, x, 0.0);
          else if (hp < 2.0) rgb = vec3(x, c, 0.0);
          else if (hp < 3.0) rgb = vec3(0.0, c, x);
          else if (hp < 4.0) rgb = vec3(0.0, x, c);
          else if (hp < 5.0) rgb = vec3(x, 0.0, c);
          else rgb = vec3(c, 0.0, x);
          return rgb + (l - 0.5 * c);
        }

        void main() {
          float h = normalize(vWorldPosition).y * 0.5 + 0.5;
          float horizonGlow = pow(clamp(1.0 - h, 0.0, 1.0), 2.0) * glowIntensity;

          // Mood drive: combine slow brightness with the drop spike for the warmth.
          float mood = clamp(spectralCentroidNorm + dropIntensity * 0.5, 0.0, 1.0);

          // Hue 200deg (cyan) -> 320deg (magenta); sat 0.4 -> 1.0; light 0.2 -> 0.35.
          float hue = mix(200.0, 320.0, mood) / 360.0;
          float sat = mix(0.4, 1.0, mood);
          float light = mix(0.2, 0.35, mood);
          vec3 moodHorizon = hsl2rgb(vec3(hue, sat, light));

          // Blend the static palette horizon toward the mood color as mood rises.
          vec3 horizon = mix(horizonColor, moodHorizon, mood);

          vec3 gradient = mix(horizon, midColor, smoothstep(0.05, 0.35, h));
          gradient = mix(gradient, topColor, smoothstep(0.35, 1.0, h));
          // Warm horizon glow tint also shifts toward magenta on hot moods.
          vec3 glowTint = mix(vec3(1.0, 0.23, 0.33), vec3(1.0, 0.15, 0.7), mood);
          gradient += glowTint * horizonGlow * (0.48 + dropIntensity * 0.25);
          gl_FragColor = vec4(gradient, 1.0);
        }
      `
    })

    this.skyMaterial = skyMaterial
    this.skyMesh = new THREE.Mesh(skyGeometry, skyMaterial)
    this.skyMesh.layers.set(NEON_LAYER) // glowing hero (iteration 7)
    this.scene.add(this.skyMesh)

    // Add star field to keep the sky lively without a texture
    const starGeometry = new THREE.BufferGeometry()
    const starCount = 600
    const starPositions = new Float32Array(starCount * 3)
    for (let i = 0; i < starCount; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(THREE.MathUtils.randFloat(-0.2, 1))
      const radius = 4800
      const x = radius * Math.sin(phi) * Math.cos(theta)
      const y = radius * Math.cos(phi)
      const z = radius * Math.sin(phi) * Math.sin(theta)
      starPositions[i * 3] = x
      starPositions[i * 3 + 1] = y
      starPositions[i * 3 + 2] = z
    }
    starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))
    const starMaterial = new THREE.PointsMaterial({
      color: ANALOGOUS_PALETTE.cyanGlow,
      size: 8,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    this.starField = new THREE.Points(starGeometry, starMaterial)
    this.starField.layers.set(NEON_LAYER) // glowing hero (iteration 7)
    this.scene.add(this.starField)

    // Add retro sun disc hovering on the horizon
    const sunGeometry = new THREE.PlaneGeometry(120, 120, 1, 1)
    const sunMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        innerColor: { value: ANALOGOUS_PALETTE.cyanGlow.clone() },
        rimColor: { value: ANALOGOUS_PALETTE.redAccent.clone() }
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
        uniform vec3 innerColor;
        uniform vec3 rimColor;

        void main() {
          vec2 center = vUv - 0.5;
          float dist = length(center);
          float alpha = smoothstep(0.5, 0.1, dist);
          float rim = smoothstep(0.35, 0.18, dist);
          vec3 color = mix(rimColor, innerColor, rim);
          gl_FragColor = vec4(color, alpha * 1.0);
        }
      `
    })
    this.sunMesh = new THREE.Mesh(sunGeometry, sunMaterial)
    this.sunMesh.position.set(0, 30, -250)
    this.sunMesh.lookAt(new THREE.Vector3(0, 15, 1000))
    this.sunMesh.renderOrder = 10
    this.sunMesh.frustumCulled = false
    this.sunMesh.layers.set(NEON_LAYER) // glowing hero (iteration 7)
    this.scene.add(this.sunMesh)

    // Add fog for depth effect aligned to new palette
    this.scene.fog = new THREE.Fog(ANALOGOUS_PALETTE.midnight.getHex(), 150, 2000)

    // Create neon grid plane - make it more visible
    const gridSize = 200
    const gridDivisions = 50
    const gridHelper = new THREE.GridHelper(
      gridSize,
      gridDivisions,
      ANALOGOUS_PALETTE.redAccent.getHex(),
      ANALOGOUS_PALETTE.cyanGlow.getHex()
    )
    gridHelper.position.y = 0
    // GridHelper uses a vertex-colored LineBasicMaterial (no emissive channel), so
    // we drive its "glow" by scaling the material color's brightness each frame —
    // brighter lines feed more energy into the bloom pass. Mark vertex colors so we
    // can multiply the whole material uniformly. Tone-map disabled keeps neon punchy.
    const gridMaterial = gridHelper.material as THREE.LineBasicMaterial
    gridMaterial.toneMapped = false
    gridMaterial.transparent = true
    // Sharp, non-neon geometry stays on the default layer (iteration 7): the focal
    // hierarchy keeps the grid crisp and below the bloom threshold so it doesn't smear.
    gridHelper.layers.set(LAYER_DEFAULT)
    this.gridHelper = gridHelper
    this.scene.add(gridHelper)
    
    // Add a ground plane for better visibility
    const groundGeometry = new THREE.PlaneGeometry(200, 200)
    const groundMaterial = new THREE.MeshStandardMaterial({
      color: ANALOGOUS_PALETTE.tealShadow,
      emissive: ANALOGOUS_PALETTE.abyss,
      emissiveIntensity: 0.5
    })
    const ground = new THREE.Mesh(groundGeometry, groundMaterial)
    ground.rotation.x = -Math.PI / 2
    ground.position.y = 0
    ground.layers.set(LAYER_DEFAULT) // sharp non-neon geometry (iteration 7)
    this.scene.add(ground)
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
      gradient.addColorStop(0, 'rgba(150, 250, 255, 1)')
      gradient.addColorStop(0.35, 'rgba(106, 246, 255, 0.85)')
      gradient.addColorStop(0.75, 'rgba(30, 224, 255, 0.25)')
      gradient.addColorStop(1, 'rgba(30, 224, 255, 0)')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, size, size)
    }

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace

    const material = new THREE.SpriteMaterial({
      map: texture,
      color: ANALOGOUS_PALETTE.cyanGlow,
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
    sprite.layers.set(NEON_LAYER) // glowing hero HUD element (iteration 7)
    sprite.layers.enable(HERO_LAYER) // also in the hero-isolation bloom (iteration 9)

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

    // Build a quick neon fallback while the glTF loads (or if it fails)
    this.buildFallbackCar(carGroup)
    // Hero car -> neon layer (iteration 7), incl. the freshly built fallback children.
    ThreeScene.setLayerRecursive(carGroup, NEON_LAYER)
    // ...and onto the hero-isolation layer (iteration 9) so it gets the exaggerated glow.
    ThreeScene.enableLayerRecursive(carGroup, HERO_LAYER)

    try {
      const template = await this.loadCarTemplate()
      if (template) {
        this.replaceCarWithTemplate(carGroup, template)
        // Re-tag the swapped-in GLB (and rim glow) onto the neon + hero layers.
        ThreeScene.setLayerRecursive(carGroup, NEON_LAYER)
        ThreeScene.enableLayerRecursive(carGroup, HERO_LAYER)
      }
    } catch (error) {
      console.warn('Falling back to procedural car because the GLB failed to load', error)
    }
  }

  /**
   * Sets `layer` on `root` and every descendant (iteration 7). Three.js tests each
   * object's own `layers` mask against the camera independently — children do NOT
   * inherit a parent's layer — so the hero car / obstacle groups must tag the whole
   * subtree. Used to place all neon/emissive heroes on NEON_LAYER for the focal split.
   */
  private static setLayerRecursive(root: THREE.Object3D, layer: number): void {
    root.traverse(obj => obj.layers.set(layer))
  }

  /**
   * Enables `layer` on `root` and every descendant ADDITIVELY (iteration 9), preserving
   * each object's existing layer membership (unlike setLayerRecursive, which replaces it).
   * Used to tag the foreground hero objects onto HERO_LAYER in addition to NEON_LAYER so
   * they appear in BOTH the all-layers primary render and the hero-only isolation render.
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

    // Re-fit the rim glow to the loaded model's real on-screen footprint. Center it
    // on the car body (lift by half its height + the ground offset) so the halo wraps
    // the silhouette rather than sitting on the floor.
    const glowSize = size.clone().multiplyScalar(scaleFactor)
    const centerY = Number.isNaN(baseOffset)
      ? glowSize.y * 0.5
      : baseOffset + glowSize.y * 0.5
    this.attachRimGlow(target, glowSize, centerY)
  }

  /**
   * Builds (or rebuilds) the hero-car rim-glow shell sized to `size` and parents it
   * under the car group at local height `centerY`, so it inherits the car transform
   * and frames the silhouette. Replaces any previous shell (e.g. when the GLB swaps
   * in over the fallback) to keep a single, correctly-sized halo.
   */
  private attachRimGlow(carGroup: THREE.Group, size: THREE.Vector3, centerY: number): void {
    if (this.rimGlow) {
      this.rimGlow.mesh.removeFromParent()
      this.rimGlow.dispose()
    }
    this.rimGlow = new RimGlowShell(size)
    this.rimGlow.mesh.position.y = centerY
    carGroup.add(this.rimGlow.mesh)
  }

  private buildFallbackCar(carGroup: THREE.Group): void {
    // Fresh emissive registry for the procedural hero car so the centroid glow drives
    // these materials (mirrors the reset in applyPaletteToModel for the GLB path).
    this.carEmissiveMaterials = []

    const bodyGeometry = new THREE.BoxGeometry(1.2, 0.4, 2)
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: ANALOGOUS_PALETTE.aquaCore,
      emissive: ANALOGOUS_PALETTE.redAccent,
      emissiveIntensity: 0.45
    })
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial)
    body.position.y = 0.2
    carGroup.add(body)

    const cabinGeometry = new THREE.BoxGeometry(0.9, 0.5, 1.2)
    const cabinMaterial = new THREE.MeshStandardMaterial({
      color: ANALOGOUS_PALETTE.cyanGlow,
      emissive: ANALOGOUS_PALETTE.mintHighlight,
      emissiveIntensity: 0.35
    })
    const cabin = new THREE.Mesh(cabinGeometry, cabinMaterial)
    cabin.position.set(0, 0.65, -0.2)
    carGroup.add(cabin)

    // Register both emissive bodies for the per-frame centroid-driven hero glow.
    this.carEmissiveMaterials.push(
      { material: bodyMaterial, base: bodyMaterial.emissiveIntensity },
      { material: cabinMaterial, base: cabinMaterial.emissiveIntensity }
    )

    const glowGeometry = new THREE.BoxGeometry(1.3, 0.5, 2.1)
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: ANALOGOUS_PALETTE.redAccent,
      transparent: true,
      opacity: 0.25
    })
    const glow = new THREE.Mesh(glowGeometry, glowMaterial)
    glow.position.y = 0.25
    carGroup.add(glow)

    // Beat-locked rim glow sized to the fallback car silhouette (swapped for a
    // model-fitted shell if the GLB later loads). Centered over the body+cabin.
    this.attachRimGlow(carGroup, new THREE.Vector3(1.3, 1.0, 2.1), 0.45)
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
    // Re-collecting the hero car's emissive materials from scratch each (re)build so
    // the per-frame centroid glow never targets disposed/stale materials.
    if (isPlayer) {
      this.carEmissiveMaterials = []
    }
    object.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true
        obj.receiveShadow = true

        const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
        for (const material of materials) {
          if (material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhysicalMaterial) {
            const hasTexture = Boolean(material.map)
            const baseTone = isPlayer ? ANALOGOUS_PALETTE.aquaCore : ANALOGOUS_PALETTE.tealShadow

            if (!hasTexture) {
              material.color.copy(baseTone)
            } else {
              material.color.lerp(baseTone, 0.45)
            }

            const isLightComponent =
              /light|lamp|emissive/i.test(obj.name) || (material.emissiveIntensity ?? 0) > 0.2
            const emissiveTarget = isLightComponent ? ANALOGOUS_PALETTE.redAccent : ANALOGOUS_PALETTE.cyanGlow

            material.emissive.copy(emissiveTarget)
            material.emissiveIntensity = Math.max(material.emissiveIntensity ?? 0, isLightComponent ? 0.7 : 0.3)
            material.needsUpdate = true
            // Record the hero car's emissive baseline so renderComposite can pump it
            // up on bright (high-centroid) moments and ease it back on calm sections.
            if (isPlayer) {
              this.carEmissiveMaterials.push({ material, base: material.emissiveIntensity })
            }
          } else if (material instanceof THREE.MeshBasicMaterial) {
            material.color.copy(isPlayer ? ANALOGOUS_PALETTE.cyanGlow : ANALOGOUS_PALETTE.mintHighlight)
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
    this.bloomFocusEnvelope = 0
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

    // Road material with synthwave colors
    const roadMaterial = new THREE.MeshStandardMaterial({
      color: ANALOGOUS_PALETTE.tealShadow,
      emissive: ANALOGOUS_PALETTE.midnight,
      emissiveIntensity: 0.55,
      roughness: 0.55,
      metalness: 0.25
    })

    this.roadMesh = new THREE.Mesh(roadGeometry, roadMaterial)
    this.roadMesh.layers.set(LAYER_DEFAULT) // sharp non-neon geometry (iteration 7)
    this.scene.add(this.roadMesh)

    // Cache the immutable base vertex positions for per-frame spectral elevation
    // morphing (iteration 8). We copy the whole [x,y,z,...] buffer so the morph can
    // always displace relative to the authored terrain rather than drifting. Resetting
    // the morph state here keeps each newly loaded track starting from a calm baseline.
    const basePosAttr = roadGeometry.getAttribute('position') as THREE.BufferAttribute
    this.baseRoadPositions = new Float32Array(basePosAttr.array as Float32Array)
    this.roadMorphAmplitude = 0
    this.roadMorphPhase = 0

    // Add lane markers
    this.addLaneMarkers(track, roadWidth)

    // Add treble-driven accents
    this.addTreblePulses(track)
  }

  setCollisionCallback(callback: (() => void) | null): void {
    this.collisionCallback = callback
  }

  /**
   * Fires a particle burst from the car marking an emotional peak (drop entry).
   * The controller supplies the musical drivers it owns — drop strength (count)
   * and spectral centroid (brightness->color) — while the renderer owns the pool,
   * the car's world transform, and the palette mapping (cyan when cool/dark,
   * magenta when bright/hot). Emitting slightly above the car fountains embers up
   * into the bloom. Count is scaled by strength so bigger drops spray harder.
   */
  emitDropBurst(dropStrength: number, spectralCentroid: number): void {
    const count = Math.round(dropStrength * PARTICLES_PER_DROP_UNIT)
    if (count <= 0) return

    // Centroid<0.4 -> cyan, >0.6 -> magenta, with a smooth blend across the middle.
    const t = THREE.MathUtils.clamp((spectralCentroid - 0.4) / 0.2, 0, 1)
    const color = BURST_COLOR_COOL.clone().lerp(BURST_COLOR_HOT, t)

    const origin = this.smoothedCarPosition.clone()
    origin.y += 0.6
    this.particlePool.emitBurst(count, origin, 11, color, PARTICLE_LIFETIME_DROP)
  }

  /**
   * Fires a tiny treble-transient shimmer off the hero car (iteration 7) — the missing
   * music-FREQUENCY signal. The controller crosses a detected treble peak and supplies
   * its normalized 0..1 `strength`; the renderer owns the pool, the car transform, and
   * the palette (cyan when cool, magenta when hot, matching the sky/rim sweep). Only
   * 6-8 fast, short-lived particles spawn from the car + a small random offset (so they
   * never cluster with the larger drop/collision bursts), reading as a quick sparkle
   * on hi-hats/cymbals/snare sizzle that pumps straight into the bloom — orthogonal to
   * the beat punch (FOV/bloom pulse) and the slow mood swell.
   */
  emitTrebleBurst(strength: number, spectralCentroid: number): void {
    const s = THREE.MathUtils.clamp(strength, 0, 1)
    const count = Math.round(
      TREBLE_BURST_COUNT_MIN + (TREBLE_BURST_COUNT_MAX - TREBLE_BURST_COUNT_MIN) * s
    )
    if (count <= 0) return

    // Cool moods spark cyan, hot moods magenta (same blend window as the drop burst).
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

  private addLaneMarkers(track: TrackData, roadWidth: number): void {
    const laneMarkerGeometry = new THREE.BoxGeometry(0.1, 0.05, 0.5)
    const laneMarkerMaterial = new THREE.MeshStandardMaterial({
      color: ANALOGOUS_PALETTE.redAccent,
      emissive: ANALOGOUS_PALETTE.redAccent,
      emissiveIntensity: 0.85
    })

    const laneWidth = roadWidth / 3
    const laneOffsets = [-laneWidth, 0, laneWidth]

    // Add markers periodically along the track
    for (let i = 0; i < track.nodes.length; i += 5) {
      const node = track.nodes[i]
      const direction = node.forward
      const right = new THREE.Vector3().crossVectors(direction, node.up).normalize()

      for (const offset of laneOffsets) {
        const markerPos = new THREE.Vector3()
          .addVectors(node.pos, right.clone().multiplyScalar(offset))

        const marker = new THREE.Mesh(laneMarkerGeometry, laneMarkerMaterial)
        marker.position.copy(markerPos)
        marker.lookAt(markerPos.clone().add(direction))
        this.scene.add(marker)
      }
    }
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

        // Obstacles are emissive neon heroes -> neon layer (iteration 7) + the
        // hero-isolation layer (iteration 9) so their blades flare in the focal bloom.
        ThreeScene.setLayerRecursive(hazardGroup, NEON_LAYER)
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

    this.applyPaletteToModel(clone)

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
              material.color.copy(ANALOGOUS_PALETTE.redAccent)
              material.emissive.copy(ANALOGOUS_PALETTE.redAccent)
              material.emissiveIntensity = 1.8
              material.transparent = true
              material.opacity = Math.max(material.opacity ?? 0.72, 0.72)
              if ('transmission' in material) {
                // @ts-expect-error transmission exists on physical materials
                material.transmission = Math.max(material.transmission ?? 0.35, 0.35)
              }
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
    this.bloomPass.setSize(width, height)
    // Keep the neon-isolation pipeline (iteration 9) in lock-step with the primary so the
    // additive composite samples a matching-resolution texture (no scaling artifacts).
    const dpr = Math.min(window.devicePixelRatio, 2)
    this.neonRenderTarget.setSize(Math.floor(width * dpr), Math.floor(height * dpr))
    this.neonComposer.setSize(width, height)
    this.neonBloomPass.setSize(width, height)
  }

  private handleObstacleCollision(carPosition: THREE.Vector3, gameState: GameState): void {
    if (!this.trackData) return

    // Allow the car to clear hazards when sufficiently airborne
    if (this.carVerticalOffset > 0.5) return

    const now = performance.now()
    const cooldownMs = 400

    if (now - this.lastCollisionTime < cooldownMs) return

    const hazardRadius = 1.3
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
      // Emit just above the contact point so embers spray off the car/blade.
      const burstPos = carPosition.clone()
      burstPos.y += 0.4
      this.particlePool.emitBurst(PARTICLES_PER_COLLISION, burstPos, 9, burstColor, PARTICLE_LIFETIME_COLLISION)

      this.collisionCallback?.()
    }
  }

  /**
   * Evaluates the beat-sync envelopes from the audio clock and applies them to the
   * camera FOV and bloom strength, then renders the composed (bloom + tone-mapped)
   * frame. Centralizing the render call here means every early-return path in
   * renderFrame still gets bloom + tone mapping + beat reactivity for free.
   */
  private renderComposite(gameState: GameState): void {
    // Milliseconds since the last beat onset. lastBeatTime is a performance.now()
    // timestamp recorded by the controller when the audio clock crosses a beat, so
    // we can compute the envelope phase without the renderer knowing the audio time.
    // It starts at -Infinity, so before any beat this is huge and envelopes sit at
    // baseline.
    const beatAgeMs = performance.now() - gameState.car.lastBeatTime
    const strength = gameState.car.beatStrength

    // Mood signals (smoothed upstream by the controller). centroid drives the slow,
    // sectional warmth; dropIntensity is the fast cinematic spike on drop entry; flux
    // (treble volatility) drives the chromatic-aberration shimmer baseline below.
    const centroid = gameState.car.spectralCentroid
    const dropIntensity = gameState.car.dropIntensity
    const flux = gameState.car.spectralFlux

    // --- FOV punch: fast attack to a strength-scaled peak, eased decay back to base.
    // Iteration 2 adds a drop-driven expansion ON TOP so the camera reacts to both
    // rhythm (beat) and the music's emotional peaks (drops).
    // Beat selectivity (iteration 6): the FOV punch only FIRES on strong beats
    // (car.beatFires). Its amplitude still scales by strength, so a 0.9 kick punches
    // harder than a 0.6 snare, but weak beats produce zero FOV delta. The drop-driven
    // expansion below is unaffected and keeps reacting to emotional peaks.
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
    // Cinematic FOV widening paired with the camera pull-back (iteration 9). The depth
    // scale sits at 1.0 at rest and rises to ~1.15 during a drop; we map that excess over
    // the controller's [1.0, DROP_DEPTH_SCALE=1.15] band to a 0..1 factor and scale
    // FOV_DROP_BOOST_MAX (≈7°) by it, so the lens widens in lock-step with the camera
    // easing back — a single complementary "open up into the vista" gesture. Read directly
    // off the same eased depth the camera uses (this.appliedDepthScale) so FOV and distance
    // never desync. Clamped to [0,1] so it contributes nothing at rest.
    const depthExcess = THREE.MathUtils.clamp((this.appliedDepthScale - 1) / 0.15, 0, 1)
    const targetFov = BASE_FOV + fovOffset + dropIntensity * FOV_DROP_PUNCH + depthExcess * FOV_DROP_BOOST_MAX
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = targetFov
      this.camera.updateProjectionMatrix()
    }

    // --- Bloom pulse: spike on the beat, exponential-ish decay back to baseline.
    // Beat selectivity (iteration 6): gated to strong beats only, so weak beats do not
    // pump the glow. The drop-driven bloom widening below is unaffected.
    let bloomBoost = 0
    if (gameState.car.beatFires && Number.isFinite(beatAgeMs) && beatAgeMs >= 0 && beatAgeMs < BLOOM_DECAY_MS) {
      const d = beatAgeMs / BLOOM_DECAY_MS
      bloomBoost = (1 - d) * (1 - d) * BLOOM_BEAT_BOOST * strength
    }
    // Mood-scaled base glow (iteration 7): the resting bloom strength now BREATHES with
    // the emotional arc — tight (COOL) on cool/dim intros, blown-out (HOT) on bright
    // drops — driven by the same smoothed spectral centroid that warms the sky/grid. The
    // per-beat pulse + drop expansion STACK on top, so rhythm punch and emotional peaks
    // stay visible and distinct from the slow mood swell.
    const bloomBase = THREE.MathUtils.lerp(BLOOM_STRENGTH_COOL, BLOOM_STRENGTH_HOT, centroid)

    // Cinematic bloom SUSTAIN (iteration 9). Ease a 0..1 focus envelope toward 1 while the
    // controller's drop-focus flag is held and toward 0 on exit, with a fast attack
    // (~150ms) and a slower release (~400ms). This LIFTS the bloom base toward HOT (1.6)
    // for the WHOLE drop — not just the entry beat — so the glow holds through the moment
    // and eases out cleanly afterward, reinforcing the cinematic "hold" of the peak. It
    // composes additively with the centroid-driven base via lerp-to-HOT, so on already-hot
    // sections it is a gentle confirm rather than a double-count.
    const focusAttack = this.lastFrameDelta > 0 ? 1 - Math.exp(-this.lastFrameDelta / 0.15) : 0.18
    const focusRelease = this.lastFrameDelta > 0 ? 1 - Math.exp(-this.lastFrameDelta / 0.4) : 0.08
    const focusTarget = gameState.isFocusedOnDrop ? 1 : 0
    const focusRate = gameState.isFocusedOnDrop ? focusAttack : focusRelease
    this.bloomFocusEnvelope += (focusTarget - this.bloomFocusEnvelope) * focusRate
    const sustainedBase = THREE.MathUtils.lerp(bloomBase, BLOOM_STRENGTH_HOT, this.bloomFocusEnvelope)

    this.bloomPass.strength = sustainedBase + bloomBoost + dropIntensity * 0.5
    // Bloom threshold tracks mood: tight/controlled on cool sections, looser (more
    // of the frame glows) as the music brightens or drops. Drives the "wider glow
    // on hot moods" feel without touching the beat-sync strength envelope.
    const warmth = Math.min(1, centroid + dropIntensity * 0.6)
    this.bloomPass.threshold = THREE.MathUtils.lerp(
      BLOOM_THRESHOLD_COOL,
      BLOOM_THRESHOLD_WARM,
      warmth
    )

    // --- Neon-isolation bloom drive (iteration 9). The dedicated neon composer's bloom
    // swells with the drop envelope so the hero car + particles flare on emotional peaks,
    // and its threshold tracks mood DOWNWARD (cool->warm) so the car's emissive/rim edges
    // catch the glow ever more aggressively as the music brightens — a focal hierarchy
    // distinct from the primary road/grid bloom. The additive composite strength likewise
    // lifts on drops so the flare lands as part of the unified cinematic moment, then eases
    // back to a tasteful resting glow. All driven from the same mood/drop signals so the
    // two bloom layers (full-scene + neon-isolated) stay perceptually synchronized.
    this.neonBloomPass.strength = THREE.MathUtils.lerp(
      NEON_BLOOM_STRENGTH_BASE,
      NEON_BLOOM_STRENGTH_DROP,
      dropIntensity
    )
    this.neonBloomPass.threshold = THREE.MathUtils.lerp(
      NEON_BLOOM_THRESHOLD_COOL,
      NEON_BLOOM_THRESHOLD_WARM,
      warmth
    )
    this.neonCompositePass.uniforms.strength.value = THREE.MathUtils.lerp(
      NEON_COMPOSITE_STRENGTH_BASE,
      NEON_COMPOSITE_STRENGTH_DROP,
      dropIntensity
    )

    // --- Sky + grid mood binding.
    this.applyMoodVisuals(centroid, dropIntensity)

    // --- Rhythm-locked beat indicator glow (bottom-right).
    this.updateBeatIndicator(gameState)

    // --- Collision "lens kick" + hero-car flash envelope. 1 at the instant of an
    // impact, decaying to 0 over CHROMATIC_DECAY_MS, phased off the renderer's own
    // collision timestamp (set in handleObstacleCollision) so no extra game state is
    // needed and there is no risk of cross-system mutation. Drives both the chromatic
    // aberration spike and the rim-glow white flash from one shared envelope.
    const collisionAge = performance.now() - this.lastCollisionTime
    let collisionEnvelope = 0
    if (this.lastCollisionTime > 0 && collisionAge >= 0 && collisionAge < CHROMATIC_DECAY_MS) {
      const d = collisionAge / CHROMATIC_DECAY_MS
      collisionEnvelope = (1 - d) * (1 - d)
    }

    // --- Chromatic aberration is now a music-driven shimmer (iteration 5): a two-stage
    // flux baseline that is always present (treble transients fringe the frame) with the
    // collision lens-kick STACKED on top via max(), so impacts still punch but no longer
    // own the effect. Stage 1 (flux below the spike knee) lerps MIN..MAX; stage 2 (above
    // the knee, an energy peak) ramps harder by SPIKE_MAX across the remaining range.
    const fluxBaseline =
      flux < CHROMATIC_FLUX_SPIKE_THRESHOLD
        ? CHROMATIC_FLUX_BASELINE_MIN +
          (flux * (CHROMATIC_FLUX_BASELINE_MAX - CHROMATIC_FLUX_BASELINE_MIN)) /
            CHROMATIC_FLUX_SPIKE_THRESHOLD
        : CHROMATIC_FLUX_BASELINE_MAX +
          (Math.max(0, flux - CHROMATIC_FLUX_SPIKE_THRESHOLD) * CHROMATIC_FLUX_SPIKE_MAX) /
            (1 - CHROMATIC_FLUX_SPIKE_THRESHOLD)
    const totalCA = Math.max(fluxBaseline, collisionEnvelope * CHROMATIC_COLLISION_PEAK)
    this.chromaticPass.uniforms.intensity.value = THREE.MathUtils.clamp(totalCA, 0, 1.2)

    // --- Animate film grain (re-seed the noise each frame so it shimmers like film).
    this.filmGrainPass.uniforms.time.value = (performance.now() % 100000) / 1000

    // --- Beat-locked, mood-colored hero-car rim glow. Pulses on kicks (beatStrength),
    // swells with brightness (spectralCentroid), and washes hot-white on collision.
    this.rimGlow?.update(gameState.car.beatStrength, centroid, collisionEnvelope)

    // --- Hero-car emissive isolation (iteration 5). Scale each captured body-material
    // base emissive by a centroid-driven multiplier so the car body glows hotter on
    // bright emotional peaks and eases back to a calm floor in quiet passages.
    if (this.carEmissiveMaterials.length > 0) {
      const carEmissiveScale = CAR_EMISSIVE_CENTROID_BASE + CAR_EMISSIVE_CENTROID_RANGE * centroid
      for (const entry of this.carEmissiveMaterials) {
        entry.material.emissiveIntensity = entry.base * carEmissiveScale
      }
    }

    // --- Treble shimmer (iteration 7): the controller sets a one-frame trebleFires
    // pulse the instant the audio clock crosses a high-frequency transient. Emit the
    // sparkle here (centrally, so every render path consumes it exactly once) and clear
    // the flag so a paused/early-return frame can't re-emit a stale pulse.
    if (gameState.car.trebleFires) {
      this.emitTrebleBurst(gameState.car.trebleStrength, centroid)
      gameState.car.trebleFires = false
    }

    // --- Advance the GPU particle simulation (drop + collision + treble bursts).
    this.particlePool.update(this.lastFrameDelta)

    // --- Camera shake: a transient world-space offset added to the camera right
    // before rendering, then reverted, so it never accumulates into the lerp-driven
    // chase position on the next frame (clean settle, no residual drift). Applied once
    // here so BOTH the neon-isolation render and the primary render share the exact same
    // shaken camera transform (they must stay pixel-aligned for the additive composite).
    this.applyCameraShake(gameState)
    this.renderNeonIsolation()
    this.composer.render()
    this.camera.position.sub(this.shakeOffset)
  }

  /**
   * Renders the HERO_LAYER-only pass into `neonRenderTarget` (iteration 9). Temporarily
   * masks the camera to HERO_LAYER so only the FOREGROUND heroes draw (car + rim glow,
   * particles, beat indicator, sword obstacles) — explicitly NOT the sky/sun/starfield,
   * which would otherwise fill the frame and wash the additive composite — runs them
   * through the exaggerated neon bloom, then restores the camera to all-layers so the
   * subsequent primary render draws the full world. The resulting texture is wired into
   * `neonCompositePass` (set once at construction; the target's texture handle is stable)
   * and additively blended onto the primary image as the final primary pass. Allocation-
   * free and flicker-free: the same shaken camera transform is shared with both renders.
   */
  private renderNeonIsolation(): void {
    this.camera.layers.set(HERO_LAYER)
    this.neonComposer.render()
    this.camera.layers.enableAll()
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

  /**
   * Pushes the mood signals into the sky shader uniforms and the neon grid's
   * brightness so the whole world emotionally tracks the music as one gesture:
   * cool/dim during intros, warm/bright during drops.
   */
  private applyMoodVisuals(centroid: number, dropIntensity: number): void {
    if (this.skyMaterial) {
      this.skyMaterial.uniforms.spectralCentroidNorm.value = centroid
      this.skyMaterial.uniforms.dropIntensity.value = dropIntensity
    }

    if (this.gridHelper) {
      const material = this.gridHelper.material as THREE.LineBasicMaterial
      // Map centroid -> a brightness multiplier in the 0.3..0.7 "emissive" range the
      // plan calls for (here applied as color opacity, which scales bloom feed for a
      // line material), with an extra kick from the drop envelope.
      const glow = GRID_EMISSIVE_MIN + centroid * GRID_EMISSIVE_RANGE + dropIntensity * 0.3
      material.opacity = Math.min(1, glow)
    }
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
    const cameraHeight = 3
    const baseCameraOffset = this.smoothedCarForward
      .clone()
      .multiplyScalar(-cameraDistance)
      .add(currentNode.up.clone().multiplyScalar(cameraHeight))

    baseCameraOffset.applyAxisAngle(currentNode.up, this.cameraOrbitAngle)

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

    // Keep a gentle east-west sweep and vertical drift so the sun returns regularly
    const horizonWave = Math.sin(elapsed * 0.2) * 0.35
    const heightWave = Math.sin(elapsed * 0.12) * 20

    const right = new THREE.Vector3().crossVectors(viewDir, new THREE.Vector3(0, 1, 0)).normalize()

    const targetPos = this.camera.position
      .clone()
      .add(viewDir.clone().multiplyScalar(sunDistance))
      .add(right.multiplyScalar(sunDistance * 0.2 * horizonWave))

    const horizonBase = Math.max(20, this.camera.position.y * 0.2)
    targetPos.y = Math.max(horizonBase, horizonBase + heightWave)

    this.sunMesh.position.copy(targetPos)
    this.sunMesh.quaternion.copy(this.camera.quaternion)
  }
}

