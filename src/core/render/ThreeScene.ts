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

// Mood-driven tuning (iteration 2). These layer on TOP of the beat-sync envelopes
// so the world reacts to both rhythm (fast, per-beat) and mood (slow, per-section).
// Cool intros sit at low centroid -> tight bloom + cyan sky; bright drops push high
// centroid -> looser glow + magenta sky, with an extra FOV expansion on drop entry.
const BLOOM_THRESHOLD_COOL = 0.85 // tight, controlled bloom on cool/quiet moods
const BLOOM_THRESHOLD_WARM = 0.62 // looser, blown-out glow on bright/hot moods
const FOV_DROP_PUNCH = 6 // extra degrees at full drop intensity (cinematic expand)
const GRID_EMISSIVE_MIN = 0.3 // dim grid in calm passages
const GRID_EMISSIVE_RANGE = 0.4 // -> up to 0.7 at peak brightness

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
const CHROMATIC_COLLISION_PEAK = 1.0 // max CA intensity at the instant of a hit
const CHROMATIC_DECAY_MS = 220 // ease the lens kick back to 0 over this window

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
  // Cinematic post passes (iteration 4). CA intensity is driven per-frame from the
  // collision envelope; grain advances its time uniform each frame; vignette is static.
  private chromaticPass: ShaderPass
  private filmGrainPass: ShaderPass
  // Beat-locked hero-car rim glow (iteration 4). Built lazily once the car bounds are
  // known, parented under the car group, and updated each frame from beat + mood.
  private rimGlow: RimGlowShell | null = null
  private roadMesh: THREE.Mesh | null = null
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
      BLOOM_BASE_STRENGTH, // strength
      0.8, // radius
      0.25 // threshold — bloom bright neon while keeping the car silhouette legible
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

    let pulse = 0
    if (Number.isFinite(beatAgeMs) && beatAgeMs >= 0 && beatAgeMs < PULSE_MS) {
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

    try {
      const template = await this.loadCarTemplate()
      if (template) {
        this.replaceCarWithTemplate(carGroup, template)
      }
    } catch (error) {
      console.warn('Falling back to procedural car because the GLB failed to load', error)
    }
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
    this.scene.add(this.roadMesh)

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
    // sectional warmth; dropIntensity is the fast cinematic spike on drop entry.
    const centroid = gameState.car.spectralCentroid
    const dropIntensity = gameState.car.dropIntensity

    // --- FOV punch: fast attack to a strength-scaled peak, eased decay back to base.
    // Iteration 2 adds a drop-driven expansion ON TOP so the camera reacts to both
    // rhythm (beat) and the music's emotional peaks (drops).
    let fovOffset = 0
    if (Number.isFinite(beatAgeMs) && beatAgeMs >= 0) {
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
    const targetFov = BASE_FOV + fovOffset + dropIntensity * FOV_DROP_PUNCH
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = targetFov
      this.camera.updateProjectionMatrix()
    }

    // --- Bloom pulse: spike on the beat, exponential-ish decay back to baseline.
    let bloomBoost = 0
    if (Number.isFinite(beatAgeMs) && beatAgeMs >= 0 && beatAgeMs < BLOOM_DECAY_MS) {
      const d = beatAgeMs / BLOOM_DECAY_MS
      bloomBoost = (1 - d) * (1 - d) * BLOOM_BEAT_BOOST * strength
    }
    // Drops also widen the overall glow for a blown-out, euphoric peak.
    this.bloomPass.strength = BLOOM_BASE_STRENGTH + bloomBoost + dropIntensity * 0.5
    // Bloom threshold tracks mood: tight/controlled on cool sections, looser (more
    // of the frame glows) as the music brightens or drops. Drives the "wider glow
    // on hot moods" feel without touching the beat-sync strength envelope.
    const warmth = Math.min(1, centroid + dropIntensity * 0.6)
    this.bloomPass.threshold = THREE.MathUtils.lerp(
      BLOOM_THRESHOLD_COOL,
      BLOOM_THRESHOLD_WARM,
      warmth
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
    this.chromaticPass.uniforms.intensity.value = collisionEnvelope * CHROMATIC_COLLISION_PEAK

    // --- Animate film grain (re-seed the noise each frame so it shimmers like film).
    this.filmGrainPass.uniforms.time.value = (performance.now() % 100000) / 1000

    // --- Beat-locked, mood-colored hero-car rim glow. Pulses on kicks (beatStrength),
    // swells with brightness (spectralCentroid), and washes hot-white on collision.
    this.rimGlow?.update(gameState.car.beatStrength, centroid, collisionEnvelope)

    // --- Advance the GPU particle simulation (drop + collision bursts).
    this.particlePool.update(this.lastFrameDelta)

    // --- Camera shake: a transient world-space offset added to the camera right
    // before rendering, then reverted, so it never accumulates into the lerp-driven
    // chase position on the next frame (clean settle, no residual drift).
    this.applyCameraShake(gameState)
    this.composer.render()
    this.camera.position.sub(this.shakeOffset)
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

    // Position camera behind and slightly above car with orbiting glide during lane changes
    const cameraDistance = 8
    const cameraHeight = 3
    const baseCameraOffset = this.smoothedCarForward
      .clone()
      .multiplyScalar(-cameraDistance)
      .add(currentNode.up.clone().multiplyScalar(cameraHeight))

    baseCameraOffset.applyAxisAngle(currentNode.up, this.cameraOrbitAngle)

    const cameraPosition = visualCarPosition.clone().add(baseCameraOffset)
    this.camera.position.lerp(cameraPosition, 0.2)

    const lookTarget = visualCarPosition
      .clone()
      .add(this.smoothedCarForward.clone().multiplyScalar(5))
      .add(
        smoothedRight.clone().multiplyScalar(this.cameraOrbitAngle * cameraDistance * 0.45)
      )

    const targetMatrix = new THREE.Matrix4().lookAt(this.camera.position, lookTarget, currentNode.up)
    const targetQuaternion = new THREE.Quaternion().setFromRotationMatrix(targetMatrix)

    this.camera.quaternion.slerp(targetQuaternion, 0.25)

    // Render
    this.updateSunPlacement()
    this.renderComposite(gameState)
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

