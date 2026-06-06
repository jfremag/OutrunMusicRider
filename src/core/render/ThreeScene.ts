import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
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

const ANALOGOUS_PALETTE = {
  abyss: new THREE.Color(0x041226),
  midnight: new THREE.Color(0x0a2f44),
  tealShadow: new THREE.Color(0x0f3c56),
  aquaCore: new THREE.Color(0x1ee0ff),
  cyanGlow: new THREE.Color(0x6af6ff),
  mintHighlight: new THREE.Color(0x30f3c8),
  redAccent: new THREE.Color(0xff3a53)
}

export class ThreeScene {
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private composer: EffectComposer
  private bloomPass: UnrealBloomPass
  private roadMesh: THREE.Mesh | null = null
  private carMesh: THREE.Group | null = null
  private trackData: TrackData | null = null
  private skyMesh: THREE.Mesh | null = null
  private starField: THREE.Points | null = null
  private sunMesh: THREE.Mesh | null = null
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
  private lastNodeIndex = 0
  private carTemplate: THREE.Object3D | null = null
  private carTemplatePromise: Promise<THREE.Object3D | null> | null = null
  private collisionCallback: (() => void) | null = null
  private lastCollisionTime = 0

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

    // Post-processing pipeline: RenderPass -> UnrealBloomPass -> OutputPass.
    // Bloom makes the neon emissives glow like a premium synthwave promo film.
    // OutputPass performs the ACES tone-map + sRGB conversion as the final step
    // (correct placement when rendering through a composer).
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
        glowIntensity: { value: 1.0 }
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

        void main() {
          float h = normalize(vWorldPosition).y * 0.5 + 0.5;
          float horizonGlow = pow(clamp(1.0 - h, 0.0, 1.0), 2.0) * glowIntensity;
          vec3 gradient = mix(horizonColor, midColor, smoothstep(0.05, 0.35, h));
          gradient = mix(gradient, topColor, smoothstep(0.35, 1.0, h));
          gradient += vec3(1.0, 0.23, 0.33) * horizonGlow * 0.48;
          gl_FragColor = vec4(gradient, 1.0);
        }
      `
    })

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

  private handleObstacleCollision(carPosition: THREE.Vector3): void {
    if (!this.trackData || !this.collisionCallback) return

    // Allow the car to clear hazards when sufficiently airborne
    if (this.carVerticalOffset > 0.5) return

    const now = performance.now()
    const cooldownMs = 400

    if (now - this.lastCollisionTime < cooldownMs) return

    const hazardRadius = 1.3
    const verticalTolerance = 1.5

    const collision = this.trackData.treblePulses.some(pulse => {
      if (Math.abs(carPosition.y - pulse.pos.y) > verticalTolerance) {
        return false
      }

      const distance = carPosition.distanceTo(pulse.pos)
      return distance < hazardRadius
    })

    if (collision) {
      this.lastCollisionTime = now
      this.collisionCallback()
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

    // --- FOV punch: fast attack to a strength-scaled peak, eased decay back to base.
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
    const targetFov = BASE_FOV + fovOffset
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
    this.bloomPass.strength = BLOOM_BASE_STRENGTH + bloomBoost

    this.composer.render()
  }

  renderFrame(gameState: GameState): void {
    const now = performance.now()
    const deltaSeconds = this.lastFrameTime
      ? Math.min((now - this.lastFrameTime) / 1000, 0.05)
      : 0
    this.lastFrameTime = now

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

    this.handleObstacleCollision(visualCarPosition)

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

