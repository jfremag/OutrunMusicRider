import * as THREE from 'three'

/**
 * ParticlePool — pigment-spatter / dry-brush flecks (Watercolour Speed restyle).
 *
 * A fixed-capacity GPU particle system with ring-buffer pooling. All particles
 * live in a single `THREE.Points` backed by pre-allocated typed arrays, so
 * emitting a burst never allocates — it just stamps fields into the next free
 * slots. Dead particles collapse to size 0 (and alpha 0) and are skipped; the
 * geometry's draw range is shrunk to the live high-water mark so we never upload
 * more than we use. This avoids per-frame GC, the source of frame hitches.
 *
 * STYLE (STYLE_SPEC §4 "Particles", §5 obstacles, §2 palette #16/#17):
 * The old additive bright embers that fed the (now-deleted) bloom are replaced by
 * **tinted near-black pigment SPATTER / dry-brush flecks**: sparse ink punctuation
 * thrown off the car on drops / treble / collisions, reading as drips and spatter
 * on the gouache surface — NOT glow. Concretely:
 *   - Blending is **NormalBlending** (NOT additive) — ink sits ON the painting and
 *     darkens it; it must never add light or it re-creates the banned bloom glow.
 *   - Colour is forced to the two locked near-blacks #20211C (cool-lit, "ink/drip")
 *     and #1E1B22 (warm-side, "shadow ink"), regardless of the colour the caller
 *     passes. The incoming colour's warmth only nudges WHICH near-black is picked,
 *     so call sites in ThreeScene stay byte-for-byte unchanged while the look obeys
 *     the palette. Tiny per-particle value jitter keeps them near-black, never pure
 *     black, never tinted toward white.
 *   - The sprite is an **irregular dry-brush mark** (mottled, ragged, with a few
 *     satellite specks), not a clean glowing disc — so each fleck reads as a paint
 *     spatter rather than a dot. One texture / one draw call keeps it cheap.
 *   - Coverage is kept **low (~1–2%)**: flecks are small, and big incoming counts
 *     are thinned internally so a heavy drop sprays punctuation, not a carpet.
 *   - Per-particle opacity (a dedicated `aAlpha` attribute, multiplied into the
 *     fragment alpha) fades each fleck out independently. With NormalBlending the
 *     material's single global `opacity` cannot do per-particle fade, and tinting
 *     the colour toward "transparent" is impossible — so true ink dissolve needs
 *     this extra attribute. It stays allocation-free (one more pre-allocated array).
 *
 * PUBLIC API IS UNCHANGED: `points`, `emitBurst(count, origin, speed, color,
 * lifetime)`, `update(deltaSeconds)`, `reset()`, `constructor(capacity)`. The
 * `color` and `speed` arguments are still honoured (warmth picks the ink; speed
 * scales the throw), so ThreeScene's drop/treble/collision call sites are untouched.
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
  // Per-particle opacity, multiplied into the fragment alpha (NormalBlending has
  // only one global `opacity` uniform, so we need this to fade flecks individually).
  private readonly alphas: Float32Array
  private readonly baseAlpha: Float32Array
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
    this.alphas = new Float32Array(capacity)
    this.baseAlpha = new Float32Array(capacity)

    this.geometry = new THREE.BufferGeometry()
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3))
    // Per-vertex point size. Named `aSize` (not `size`) to avoid colliding with the
    // built-in `uniform float size` in the PointsMaterial vertex shader, which we
    // patch below to multiply by this attribute so each particle can size + fade
    // independently (stock PointsMaterial only supports one global size uniform).
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1))
    // Per-vertex opacity for true ink dissolve under NormalBlending (see field doc).
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1))
    this.geometry.setDrawRange(0, 0)

    // Irregular dry-brush / spatter sprite so particles read as flung ink flecks,
    // not glowing embers or hard squares.
    const texture = ParticlePool.createSpatterTexture()
    const material = new THREE.PointsMaterial({
      size: 1,
      map: texture,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      // NOT additive: ink pigment sits on the painting (NormalBlending), it must
      // not add light. Additive here would re-introduce the deleted bloom glow.
      blending: THREE.NormalBlending,
      sizeAttenuation: true,
      // Display-space pigment, not an HDR/bloom feeder: skip tone mapping so the
      // near-black stays near-black and the painterly post-stack treats it as paint.
      toneMapped: false
    })
    // Patch the shader to honour the per-vertex `aSize` and `aAlpha` attributes.
    // The stock vertex shader sets `gl_PointSize = size;`; we make `size` (=1) a
    // multiplier of aSize and forward aAlpha to the fragment stage, where we fold
    // it into the final alpha (the only way to fade individual flecks under
    // NormalBlending, whose material opacity is a single global value).
    material.onBeforeCompile = shader => {
      shader.vertexShader =
        'attribute float aSize;\n' +
        'attribute float aAlpha;\n' +
        'varying float vAlpha;\n' +
        shader.vertexShader
          .replace('void main() {', 'void main() {\n  vAlpha = aAlpha;')
          .replace('gl_PointSize = size;', 'gl_PointSize = size * aSize;')
      // `<opaque_fragment>` is where `gl_FragColor` is first ASSIGNED
      // (gl_FragColor = vec4(outgoingLight, diffuseColor.a)). The per-particle alpha
      // must be folded in AFTER that assignment (and before tonemapping/colorspace),
      // so we append our multiply to the include rather than prepend it.
      shader.fragmentShader =
        'varying float vAlpha;\n' +
        shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          '#include <opaque_fragment>\n  gl_FragColor.a *= vAlpha;'
        )
    }

    this.points = new THREE.Points(this.geometry, material)
    this.points.frustumCulled = false
    this.points.renderOrder = 5
  }

  /**
   * Bakes an irregular dry-brush / spatter alpha mask: a ragged dense core with a
   * scatter of small satellite specks and noisy edges, so each point reads as a
   * thrown ink fleck rather than a clean disc. White RGB (the vertex colour tints
   * it to the near-black pigment); only the alpha shape carries the "spatter".
   */
  private static createSpatterTexture(): THREE.CanvasTexture {
    const size = 64
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (ctx) {
      const cx = size / 2
      const cy = size / 2
      ctx.clearRect(0, 0, size, size)

      // Ragged main blot: a soft core whose edge is broken by a ring of overlapping
      // blobs of varying radius (dry-brush bite), kept off pure-white so the fleck
      // has soft, lost edges rather than a crisp dot.
      ctx.fillStyle = 'rgba(255,255,255,0.92)'
      ctx.beginPath()
      const lobes = 11
      const baseR = size * 0.2
      for (let i = 0; i <= lobes; i++) {
        const a = (i / lobes) * Math.PI * 2
        // Deterministic-but-irregular radius wobble (a couple of summed sines) so
        // the silhouette is ragged without needing RNG at bake time.
        const wob =
          0.62 +
          0.28 * Math.sin(a * 3.0 + 0.7) +
          0.16 * Math.sin(a * 7.0 + 2.1)
        const r = baseR * wob
        const x = cx + Math.cos(a) * r
        const y = cy + Math.sin(a) * r
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
      ctx.fill()

      // A denser inner pool so the centre holds the most pigment (Marangoni-ish).
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.16)
      core.addColorStop(0, 'rgba(255,255,255,1)')
      core.addColorStop(0.7, 'rgba(255,255,255,0.55)')
      core.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = core
      ctx.fillRect(0, 0, size, size)

      // Satellite specks: the flung droplets that sell "spatter". Fixed positions
      // (a small spiral) so the bake is deterministic; small and semi-opaque.
      const specks = 9
      for (let i = 0; i < specks; i++) {
        const a = i * 2.399963 // golden angle, even angular spread
        const rad = size * (0.24 + 0.16 * (i / specks))
        const sx = cx + Math.cos(a) * rad
        const sy = cy + Math.sin(a) * rad
        const sr = size * (0.012 + 0.03 * ((i * 37) % 5) / 5)
        const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr)
        g.addColorStop(0, 'rgba(255,255,255,0.85)')
        g.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(sx, sy, sr, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  }

  /**
   * Spawns up to `count` pigment flecks from `origin`, each flung outward with a
   * random direction scaled by `speed`, tinted to a locked near-black pigment,
   * living `lifetime` seconds. Uses the ring buffer so an over-emit simply
   * overwrites the oldest particles (graceful degradation) rather than allocating.
   *
   * `color` (the cyan/magenta the caller still passes) is NOT rendered as-is — it
   * only biases which of the two near-blacks (#20211C cool / #1E1B22 warm) the
   * fleck takes, so the call sites stay unchanged while the look obeys the palette.
   * The incoming `count` is thinned so coverage stays sparse (~1–2%), reading as
   * ink punctuation rather than a spray.
   */
  emitBurst(count: number, origin: THREE.Vector3, speed: number, color: THREE.Color, lifetime: number): void {
    // Thin the request: spatter is sparse punctuation, not a fountain. We emit a
    // fraction of the asked count (kept allocation-free; just fewer slots stamped).
    const requested = Math.max(0, Math.floor(count))
    const thinned = Math.round(requested * ParticlePool.COVERAGE_THIN)
    const n = Math.max(0, Math.min(this.capacity, thinned))
    if (n === 0) return

    // Pick the pigment from the caller's hue warmth: warm-ish incoming colour ->
    // warm near-black #1E1B22, cool-ish -> cool near-black #20211C. Both are
    // near-black, so the choice is a subtle temperature of the ink, never a bright
    // colour. (A red-dominant colour reads "warm"; otherwise "cool".)
    const warm = color.r >= color.b
    const pigment = warm ? ParticlePool.INK_WARM : ParticlePool.INK_COOL

    for (let k = 0; k < n; k++) {
      const idx = this.cursor
      this.cursor = (this.cursor + 1) % this.capacity

      // Random direction on a sphere, only a slight upward bias — flung ink scatters
      // outward and falls, it does not fountain like embers.
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      const dx = Math.sin(phi) * Math.cos(theta)
      const dy = Math.cos(phi) * 0.6 + 0.15 // mild upward bias
      const dz = Math.sin(phi) * Math.sin(theta)
      const spd = speed * (0.45 + Math.random() * 0.8)

      const p3 = idx * 3
      this.positions[p3] = origin.x
      this.positions[p3 + 1] = origin.y
      this.positions[p3 + 2] = origin.z
      this.velocities[p3] = dx * spd
      this.velocities[p3 + 1] = dy * spd
      this.velocities[p3 + 2] = dz * spd

      // Near-black pigment with a tiny per-particle value jitter so the spatter is a
      // mottled ink wash, NOT a flat fill and NOT toward white. Stays near-black.
      const vj = 0.85 + Math.random() * 0.3 // 0.85..1.15 value multiply, clamped
      this.scratch.setRGB(
        Math.min(1, pigment.r * vj),
        Math.min(1, pigment.g * vj),
        Math.min(1, pigment.b * vj)
      )
      this.baseColors[p3] = this.scratch.r
      this.baseColors[p3 + 1] = this.scratch.g
      this.baseColors[p3 + 2] = this.scratch.b
      this.colors[p3] = this.scratch.r
      this.colors[p3 + 1] = this.scratch.g
      this.colors[p3 + 2] = this.scratch.b

      // Small flecks (sizeAttenuation on) so coverage stays low (~1–2%) at the
      // ~8 m chase distance — dry-brush specks, not the old fat embers.
      const base = 1.1 + Math.random() * 2.0
      this.baseSize[idx] = base
      this.sizes[idx] = base

      // Per-particle opacity: ink is mostly opaque where it lands but varies a touch
      // so overlapping flecks build value naturally. Faded over life in update().
      const op = 0.7 + Math.random() * 0.3
      this.baseAlpha[idx] = op
      this.alphas[idx] = op

      this.age[idx] = 0
      this.lifetime[idx] = lifetime

      if (idx + 1 > this.liveHighWater) this.liveHighWater = idx + 1
    }
  }

  /**
   * Ages every live fleck, integrates gravity-damped motion, and fades opacity/size
   * toward end-of-life so the ink dissolves cleanly. Recomputes only the live slice
   * and flags the attributes for a single GPU upload. Dead particles collapse to
   * size 0 / alpha 0 so they draw nothing without being compacted out of the buffer.
   */
  update(deltaSeconds: number): void {
    if (deltaSeconds <= 0 || this.liveHighWater === 0) return

    const GRAVITY = 7 // a touch heavier than embers — droplets fall and settle fast
    // FLOATER FIX: heavier per-frame damping (0.9 -> 0.82) so a fleck throws then arrests
    // quickly — it travels a short distance and stops, rather than drifting across the frame
    // for its whole life (the drifting motion was the "floater" the user flagged).
    const DRAG = 0.82
    let anyAlive = false

    for (let i = 0; i < this.liveHighWater; i++) {
      const life = this.lifetime[i]
      if (life <= 0) continue
      let a = this.age[i]
      if (a >= life) {
        if (this.sizes[i] !== 0) this.sizes[i] = 0
        if (this.alphas[i] !== 0) this.alphas[i] = 0
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

      // Lifetime fade. Colour stays the SAME near-black (no brightness-to-zero glow
      // fade — that was the additive trick); instead the per-particle ALPHA fades so
      // the fleck dries/lifts off the paper. Size holds most of its mass then shrinks
      // slightly at the very end (ink mark doesn't balloon). Ease-out on alpha keeps
      // the mark crisp early then dissolves quickly.
      const fade = 1 - a / life
      const ease = fade * fade // quadratic ease-out for a quick clean dry-off
      this.sizes[i] = this.baseSize[i] * (0.6 + 0.4 * fade)
      this.alphas[i] = this.baseAlpha[i] * ease
      // Colour is held constant (re-copied in case it was zeroed by a prior reset).
      this.colors[p3] = this.baseColors[p3]
      this.colors[p3 + 1] = this.baseColors[p3 + 1]
      this.colors[p3 + 2] = this.baseColors[p3 + 2]
      anyAlive = true
    }

    if (!anyAlive) {
      this.liveHighWater = 0
    }

    const posAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute
    const colAttr = this.geometry.getAttribute('color') as THREE.BufferAttribute
    const sizeAttr = this.geometry.getAttribute('aSize') as THREE.BufferAttribute
    const alphaAttr = this.geometry.getAttribute('aAlpha') as THREE.BufferAttribute
    posAttr.needsUpdate = true
    colAttr.needsUpdate = true
    sizeAttr.needsUpdate = true
    alphaAttr.needsUpdate = true
    this.geometry.setDrawRange(0, this.liveHighWater)
  }

  reset(): void {
    this.cursor = 0
    this.liveHighWater = 0
    this.sizes.fill(0)
    this.alphas.fill(0)
    this.lifetime.fill(0)
    this.age.fill(0)
    this.geometry.setDrawRange(0, 0)
    const sizeAttr = this.geometry.getAttribute('aSize') as THREE.BufferAttribute
    const alphaAttr = this.geometry.getAttribute('aAlpha') as THREE.BufferAttribute
    sizeAttr.needsUpdate = true
    alphaAttr.needsUpdate = true
  }

  // Locked near-black pigments (STYLE_SPEC §2 #16 / #17). NEVER pure black.
  private static readonly INK_COOL = new THREE.Color(0x20211c) // cool-lit ink / drip
  private static readonly INK_WARM = new THREE.Color(0x1e1b22) // warm-side shadow ink
  // FLOATER FIX: the drifting dark flecks were the literal "eye floaters" — a persistent
  // field of dark specks crawling over the light frame. Thinned HARD (0.45 -> 0.18) so a
  // burst is sparse INK PUNCTUATION (a few flecks), not a spray that lingers and drifts.
  // Combined with the shortened lifetimes at the call sites, the spatter is now a brief
  // collision/beat accent that settles fast — no constant floating drift.
  private static readonly COVERAGE_THIN = 0.18
}
