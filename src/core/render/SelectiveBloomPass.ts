import * as THREE from 'three'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

/**
 * SelectiveBloomPass — a tasteful, HIGH-THRESHOLD, SELECTIVE bloom for "Watercolour Speed".
 *
 * The painterly stack is a deliberately MATTE, muted, mid-key gouache — a global bloom would
 * wash and soften that (and read as banned synthwave glow). But ref 02's print has a LIVELY
 * WET LUMINOSITY on its genuine lights: the sun disc, the hero's chrome sheen/glint, the
 * brightest crimson-sword highlights. This pass adds exactly that and nothing else.
 *
 * It is NOT three's UnrealBloomPass (which composites a whole-frame threshold bloom that would
 * also bloom the bright negative-space sky/field). Instead it is a cheap, explicitly SELECTIVE
 * 3-step side-chain run by ThreeScene as a manual pass:
 *
 *   1. BRIGHT-PASS (half-res): extract only the genuinely bright accents from the FINAL painted
 *      image — `bright = smoothstep(threshold, threshold+knee, luma) * (luma - threshold)` — so
 *      the muted mid-key field (luma <= threshold) contributes ZERO. A HERO_LAYER coverage mask
 *      (`tHeroMask`, the same one the velocity smear/edge consume) BOOSTS the heroes (car sheen,
 *      sword tips) by `heroBoost` and can be used to keep the sky from over-blooming. The result
 *      is written to a half-res target (bloom is low-frequency → half-res upscales for free).
 *   2. SEPARABLE BLUR (half-res, H then V): two cheap 9-tap Gaussian passes over the bright
 *      target give a soft, rounded halo. Half-res + 9 taps keeps it inside budget.
 *   3. ADDITIVE COMPOSITE (full-res): `out = base + bloom * strength` — additive so it only ADDS
 *      light to the lights; it can never darken or soften the matte field. Bloom is clamped so a
 *      bright core can't blow out, and the composite is the ONE pass added to the composer.
 *
 * Cheap: one half-res bright extract + two half-res blurs per frame, plus the full-res additive
 * composite. No extra scene render (it works on the already-painted post-stack output). No tone
 * mapping is re-applied (we are in display-space LDR after OutputPass, like the painterly stack).
 *
 * ThreeScene just `composer.addPass(bloom.composite)` (in the spec order, as the FINAL pass),
 * sizes the targets in `setSize`, and binds the hero mask via `setHeroMask`. The composite pass
 * SELF-CONTAINS the side-chain: its overridden `render` first runs the bright-pass + blur on the
 * composer's current `readBuffer` (the substrate output — deterministic, no buffer-identity
 * guessing) into the owned half-res targets, then does the additive composite into `writeBuffer`.
 */
export interface SelectiveBloom {
  /** The composite ShaderPass to add to the EffectComposer (self-contained additive bloom). */
  composite: ShaderPass
  /** Resize the half-res side-chain targets (call from ThreeScene.resize with full drawing-buffer px). */
  setSize(bufW: number, bufH: number): void
  /** Bind the HERO_LAYER coverage mask (boosts heroes / can gate the sky). Safe before it exists. */
  setHeroMask(mask: THREE.Texture | null): void
  /** Free the owned GPU targets + quads. */
  dispose(): void
}

export function createSelectiveBloomPass(opts: {
  resolution?: [number, number]
  /** Luma above which a pixel starts to bloom (high → only the genuinely bright accents). */
  threshold?: number
  /** Soft knee width above the threshold (smoothstep ramp) so the bloom onset isn't a hard edge. */
  knee?: number
  /** Additive bloom strength in the composite. Subtle. */
  strength?: number
  /** Blur tap spacing in half-res px (the halo radius). */
  radius?: number
  /** Extra bloom multiplier on HERO_LAYER pixels (car sheen / sword tips) for a wet hero glint. */
  heroBoost?: number
  /** Downscale factor for the bloom side-chain (2 = half-res). */
  scale?: number
} = {}): SelectiveBloom {
  const [rx, ry] = opts.resolution ?? [1920, 1080]
  const SCALE = Math.max(1, opts.scale ?? 2)
  let hw = Math.max(1, Math.floor(rx / SCALE))
  let hh = Math.max(1, Math.floor(ry / SCALE))

  // Half-res sRGB-byte targets for the bright extract + ping-pong blur. LinearFilter so the
  // upscale in the composite is smooth; NoColorSpace (we operate on already-display-space bytes).
  const targetOpts: THREE.RenderTargetOptions = {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    colorSpace: THREE.NoColorSpace
  }
  let brightTarget = new THREE.WebGLRenderTarget(hw, hh, targetOpts)
  brightTarget.texture.name = 'SelectiveBloom.bright'
  let blurTarget = new THREE.WebGLRenderTarget(hw, hh, targetOpts)
  blurTarget.texture.name = 'SelectiveBloom.blur'

  // 1x1 black placeholder so the hero-mask sampler is always bound (heroBoost off until wired).
  const heroPlaceholder = new THREE.DataTexture(
    new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType
  )
  heroPlaceholder.colorSpace = THREE.NoColorSpace
  heroPlaceholder.needsUpdate = true

  const VERT = /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `

  // --- BRIGHT-PASS material: extract only luma > threshold, hero-boosted -------------------
  const brightMaterial = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null as THREE.Texture | null },
      tHeroMask: { value: heroPlaceholder as THREE.Texture },
      useHeroMask: { value: 0 },
      threshold: { value: opts.threshold ?? 0.80 },
      knee: { value: opts.knee ?? 0.08 },
      heroBoost: { value: opts.heroBoost ?? 1.8 }
    },
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform sampler2D tHeroMask;
      uniform float useHeroMask;
      uniform float threshold;
      uniform float knee;
      uniform float heroBoost;
      float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
      void main() {
        vec3 c = texture2D(tDiffuse, vUv).rgb;
        float l = luma(c);
        // Soft high-pass: zero below threshold, ramping up over the knee, then the over-threshold
        // amount. Only the genuinely bright accents (sun, sheen crest, sword glint) survive.
        float w = smoothstep(threshold, threshold + knee, l) * max(l - threshold, 0.0);
        // HERO_LAYER boost: the car sheen + sword tips bloom more than an equally-bright field
        // pixel, so the lights LIVE while the muted negative space stays matte. The mask is the
        // hero coverage (1 over heroes); lerp the multiplier from 1 (field) to heroBoost (hero).
        float hero = useHeroMask > 0.5 ? texture2D(tHeroMask, vUv).r : 0.0;
        float boost = mix(1.0, heroBoost, clamp(hero, 0.0, 1.0));
        // Keep the bright accent's own hue (a warm sun stays warm, a crimson tip stays crimson).
        vec3 bright = c * (w * boost);
        gl_FragColor = vec4(bright, 1.0);
      }
    `
  })

  // --- SEPARABLE BLUR material (reused for H and V) ----------------------------------------
  const blurMaterial = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null as THREE.Texture | null },
      direction: { value: new THREE.Vector2(1, 0) },
      texel: { value: new THREE.Vector2(1 / hw, 1 / hh) },
      radius: { value: opts.radius ?? 2.0 }
    },
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform vec2 direction;
      uniform vec2 texel;
      uniform float radius;
      void main() {
        // 9-tap Gaussian (normalised weights). Cheap, soft, no ringing.
        vec2 d = direction * texel * radius;
        vec3 sum = vec3(0.0);
        sum += texture2D(tDiffuse, vUv).rgb * 0.2270270270;
        sum += texture2D(tDiffuse, vUv + d * 1.3846153846).rgb * 0.3162162162 * 0.5;
        sum += texture2D(tDiffuse, vUv - d * 1.3846153846).rgb * 0.3162162162 * 0.5;
        sum += texture2D(tDiffuse, vUv + d * 3.2307692308).rgb * 0.0702702703 * 0.5;
        sum += texture2D(tDiffuse, vUv - d * 3.2307692308).rgb * 0.0702702703 * 0.5;
        // The 0.5 splits keep symmetric weights summing ~1 across the two sides.
        gl_FragColor = vec4(sum * 1.0, 1.0);
      }
    `
  })

  const brightQuad = new FullScreenQuad(brightMaterial)
  const blurQuad = new FullScreenQuad(blurMaterial)

  // --- COMPOSITE pass: additive blurred bloom onto the base painted image ------------------
  const composite = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },                 // base image (auto-wired by EffectComposer)
      tBloom: { value: blurTarget.texture },     // the blurred bloom from the side-chain
      strength: { value: opts.strength ?? 0.85 },
      // Hard cap on the additive bloom so a bright core can't blow the highlight to flat white.
      maxAdd: { value: 0.8 }
    },
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform sampler2D tBloom;
      uniform float strength;
      uniform float maxAdd;
      void main() {
        vec3 base = texture2D(tDiffuse, vUv).rgb;
        vec3 bloom = texture2D(tBloom, vUv).rgb * strength;
        // ADDITIVE — only adds light to the lights; never darkens/softens the matte field.
        // Clamp the added energy so a hot core glints rather than blowing to a flat white disc.
        bloom = min(bloom, vec3(maxAdd));
        gl_FragColor = vec4(base + bloom, 1.0);
      }
    `
  })

  // SELF-CONTAINED render override: run the bright-pass + separable blur on the composer's
  // current readBuffer (the substrate output), then additive-composite into writeBuffer (or to
  // screen). Mirrors the structure-tensor side-chain pattern already used in ThreeScene, so the
  // bloom source is ALWAYS the real painted image, with no EffectComposer buffer-identity guess.
  const baseRender = composite.render.bind(composite)
  composite.render = (renderer, writeBuffer, readBuffer, deltaTime, maskActive) => {
    // 1) BRIGHT-PASS: the painted image (readBuffer) -> brightTarget (half-res).
    brightMaterial.uniforms.tDiffuse.value = readBuffer.texture
    renderer.setRenderTarget(brightTarget)
    brightQuad.render(renderer)
    // 2a) BLUR H: brightTarget -> blurTarget.
    blurMaterial.uniforms.tDiffuse.value = brightTarget.texture
    ;(blurMaterial.uniforms.direction.value as THREE.Vector2).set(1, 0)
    renderer.setRenderTarget(blurTarget)
    blurQuad.render(renderer)
    // 2b) BLUR V: blurTarget -> brightTarget. tBloom then points at brightTarget (final blur).
    blurMaterial.uniforms.tDiffuse.value = blurTarget.texture
    ;(blurMaterial.uniforms.direction.value as THREE.Vector2).set(0, 1)
    renderer.setRenderTarget(brightTarget)
    blurQuad.render(renderer)
    composite.uniforms.tBloom.value = brightTarget.texture
    // 3) ADDITIVE COMPOSITE via the stock ShaderPass.render (reads tDiffuse=readBuffer, tBloom).
    baseRender(renderer, writeBuffer, readBuffer, deltaTime, maskActive)
  }

  const setSize = (bufW: number, bufH: number) => {
    hw = Math.max(1, Math.floor(bufW / SCALE))
    hh = Math.max(1, Math.floor(bufH / SCALE))
    brightTarget.setSize(hw, hh)
    blurTarget.setSize(hw, hh)
    ;(blurMaterial.uniforms.texel.value as THREE.Vector2).set(1 / hw, 1 / hh)
  }

  const setHeroMask = (mask: THREE.Texture | null) => {
    brightMaterial.uniforms.tHeroMask.value = mask ?? heroPlaceholder
    brightMaterial.uniforms.useHeroMask.value = mask ? 1 : 0
  }

  const dispose = () => {
    brightTarget.dispose()
    blurTarget.dispose()
    heroPlaceholder.dispose()
    brightMaterial.dispose()
    blurMaterial.dispose()
    brightQuad.dispose()
    blurQuad.dispose()
  }

  return { composite, setSize, setHeroMask, dispose }
}
