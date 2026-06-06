import * as THREE from 'three'

// Mood-driven rim color endpoints: calm/dark sections glow cyan, bright/intense
// sections glow magenta, matching the sky + particle-burst palette sweep so the
// hero car reads as part of one coherent emotional gesture.
const RIM_COLOR_COOL = new THREE.Color(0x00ffff)
const RIM_COLOR_HOT = new THREE.Color(0xff00ff)
const WHITE = new THREE.Color(0xffffff)

/**
 * RimGlowShell — a beat-locked, mood-colored Fresnel halo around the hero car
 * (iteration 4).
 *
 * This isolates the player vehicle as the cinematic focal "product" the way a Tesla
 * or Porsche promo lights its hero car: a thin additive shell hugging the car whose
 * brightness is driven by a Fresnel term, so it glows ONLY at the grazing silhouette
 * edges (a true rim light) and stays transparent across the faces pointing at the
 * camera — it frames the car instead of painting a solid box over it. The shell uses
 * additive blending + `toneMapped: false`, exactly like the particle pool and beat
 * indicator, so its edge light pumps straight into the existing UnrealBloomPass and
 * blooms for free, with no second selective-bloom render pass (keeps 60fps). The glow:
 *   - pulses on every kick/snare (scaled by beatStrength),
 *   - swells with perceived brightness (spectralCentroid),
 *   - flashes hot-white on collision (a decay envelope the renderer supplies),
 *   - and shifts hue cyan -> magenta as the music brightens.
 *
 * The shell is a single rounded box (one cheap draw call) sized to the car's bounding
 * box, working for both the procedural fallback and the loaded GLB. It is parented
 * under the car group so it inherits the car transform.
 */
export class RimGlowShell {
  readonly mesh: THREE.Mesh
  private readonly material: THREE.ShaderMaterial
  // Smoothed emissive driver so the glow eases rather than snapping frame-to-frame,
  // matching the codebase's lerp-driven motion aesthetic.
  private smoothedIntensity = 0.8
  private readonly color = RIM_COLOR_COOL.clone()

  constructor(size: THREE.Vector3) {
    // A smooth ellipsoid (unit sphere scaled to the car footprint) gives a rounded,
    // flat-face-free halo: the Fresnel rim wraps the silhouette cleanly instead of
    // exposing a box's top/side planes at grazing angles. Slightly inflated past the
    // car, and a touch flattened in Y so it reads as a low, car-shaped aura.
    const geometry = new THREE.SphereGeometry(0.5, 24, 16)
    geometry.scale(
      size.x * 1.35 + 0.35,
      size.y * 1.15 + 0.3,
      size.z * 1.15 + 0.35
    )
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      // FrontSide so the Fresnel uses outward-facing normals; the rim lights the
      // edges of the visible hull facing away from the eye.
      side: THREE.FrontSide,
      uniforms: {
        glowColor: { value: this.color.clone() },
        glowStrength: { value: 0.8 },
        // Fresnel sharpness: higher = thinner, more concentrated rim at the edge.
        fresnelPower: { value: 3.2 }
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormalW;
        varying vec3 vViewDirW;
        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vViewDirW = normalize(cameraPosition - worldPos.xyz);
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vNormalW;
        varying vec3 vViewDirW;
        uniform vec3 glowColor;
        uniform float glowStrength;
        uniform float fresnelPower;
        void main() {
          // Fresnel: ~0 when the surface faces the camera, ~1 at grazing angles.
          float f = 1.0 - max(dot(normalize(vNormalW), normalize(vViewDirW)), 0.0);
          f = pow(f, fresnelPower);
          // Additive: alpha is largely cosmetic with additive blending; we modulate
          // the emitted color by the Fresnel term so only the rim contributes light.
          vec3 col = glowColor * f * glowStrength;
          gl_FragColor = vec4(col, f);
        }
      `
    })
    this.mesh = new THREE.Mesh(geometry, this.material)
    // Behind the solid car (renderOrder 0) but additive so it haloes around it.
    this.mesh.renderOrder = 1
    this.mesh.frustumCulled = false
  }

  /**
   * Per-frame drive. `beatStrength` (0..1) and `spectralCentroid` (0..1) come from
   * game state; `collisionEnvelope` (0..1) is a renderer-computed decay that is 1
   * immediately on impact and falls to 0 over ~200ms. Emissive ≈ base 0.8 +
   * beat·0.9 + centroid·0.4, spiked on collision; hue lerps cyan->magenta across
   * centroid 0.4..0.6 and washes white on a hit.
   */
  update(beatStrength: number, spectralCentroid: number, collisionEnvelope: number): void {
    const target =
      0.8 +
      beatStrength * 0.9 +
      spectralCentroid * 0.4 +
      collisionEnvelope * 1.4 // hard, bright flash on a hit
    // Ease toward the target (fast attack feel, soft settle).
    this.smoothedIntensity += (target - this.smoothedIntensity) * 0.4

    // Color: cyan when calm/dark, magenta when bright/intense; collisions wash hot
    // toward white for a hard impact flash.
    const hueT = THREE.MathUtils.clamp((spectralCentroid - 0.4) / 0.2, 0, 1)
    this.color.copy(RIM_COLOR_COOL).lerp(RIM_COLOR_HOT, hueT)
    if (collisionEnvelope > 0) {
      this.color.lerp(WHITE, collisionEnvelope * 0.8)
    }
    const u = this.material.uniforms
    ;(u.glowColor.value as THREE.Color).copy(this.color)
    u.glowStrength.value = THREE.MathUtils.clamp(this.smoothedIntensity, 0, 2.6)
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
