import * as THREE from 'three'

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
export class ParticlePool {
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
