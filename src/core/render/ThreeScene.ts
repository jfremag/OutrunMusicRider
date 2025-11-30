import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { TrackData } from '../track/TrackTypes'
import { GameState, getLaneOffset } from '../game/GameState'

export class ThreeScene {
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private roadMesh: THREE.Mesh | null = null
  private carMesh: THREE.Group | null = null
  private trackData: TrackData | null = null
  private skyMesh: THREE.Mesh | null = null
  private starField: THREE.Points | null = null
  private sunMesh: THREE.Mesh | null = null
  private trebleMeshes: THREE.Object3D[] = []
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
    this.renderer.setClearColor(0x0a0a1a, 1)

    // Scene
    this.scene = new THREE.Scene()

    // Camera
    const aspect = width / height || 1
    this.camera = new THREE.PerspectiveCamera(
      75,
      aspect,
      0.1,
      10000
    )

    // Lighting - brighter for better visibility
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.0)
    this.scene.add(ambientLight)

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0)
    directionalLight.position.set(10, 10, 10)
    this.scene.add(directionalLight)
    
    // Add a point light near the car for better visibility
    const pointLight = new THREE.PointLight(0x00ffff, 1, 100)
    pointLight.position.set(0, 5, 0)
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

    // Do initial render
    this.renderer.render(this.scene, this.camera)
  }

  private createBackground(): void {
    // Create gradient sky dome with shader for synthwave hues
    const skyGeometry = new THREE.SphereGeometry(5000, 64, 64)
    const skyMaterial = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x0a0324) },
        midColor: { value: new THREE.Color(0x1a0a4a) },
        horizonColor: { value: new THREE.Color(0xff55d3) },
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
          gradient += vec3(1.0, 0.35, 0.6) * horizonGlow * 0.35;
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
      color: 0xffffff,
      size: 8,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.8,
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
        innerColor: { value: new THREE.Color(0xffe066) },
        rimColor: { value: new THREE.Color(0xff4fd8) }
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
          gl_FragColor = vec4(color, alpha * 0.95);
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
    this.scene.fog = new THREE.Fog(0x0a0324, 150, 2000)

    // Create neon grid plane - make it more visible
    const gridSize = 200
    const gridDivisions = 50
    const gridHelper = new THREE.GridHelper(gridSize, gridDivisions, 0xff00ff, 0x00ffff)
    gridHelper.position.y = 0
    this.scene.add(gridHelper)
    
    // Add a ground plane for better visibility
    const groundGeometry = new THREE.PlaneGeometry(200, 200)
    const groundMaterial = new THREE.MeshStandardMaterial({
      color: 0x1a1a2e,
      emissive: 0x0a0a1a,
      emissiveIntensity: 0.2
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
      const CAR_MODEL_URL = '/models/Sports%20Car.glb'

      this.carTemplatePromise = new Promise(resolve => {
        loader.load(
          CAR_MODEL_URL,
          gltf => {
            this.carTemplate = gltf.scene
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

    clone.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true
        obj.receiveShadow = true
        if (Array.isArray(obj.material)) {
          obj.material.forEach(mat => {
            if (mat instanceof THREE.Material) {
              mat.needsUpdate = true
            }
          })
        } else if (obj.material instanceof THREE.Material) {
          obj.material.needsUpdate = true
        }
      }
    })

    target.add(clone)
  }

  private buildFallbackCar(carGroup: THREE.Group): void {
    const bodyGeometry = new THREE.BoxGeometry(1.2, 0.4, 2)
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0xff0066,
      emissive: 0xff0066,
      emissiveIntensity: 0.3
    })
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial)
    body.position.y = 0.2
    carGroup.add(body)

    const cabinGeometry = new THREE.BoxGeometry(0.9, 0.5, 1.2)
    const cabinMaterial = new THREE.MeshStandardMaterial({
      color: 0x00ffff,
      emissive: 0x00ffff,
      emissiveIntensity: 0.3
    })
    const cabin = new THREE.Mesh(cabinGeometry, cabinMaterial)
    cabin.position.set(0, 0.65, -0.2)
    carGroup.add(cabin)

    const glowGeometry = new THREE.BoxGeometry(1.3, 0.5, 2.1)
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0xff00ff,
      transparent: true,
      opacity: 0.2
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

  setTrack(track: TrackData): void {
    this.trackData = track
    this.smoothedCarPosition.set(0, 0, 0)
    this.smoothedCarForward.set(0, 0, 1)
    this.carOrientation.identity()
    this.carVerticalVelocity = 0
    this.carVerticalOffset = 0
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
      color: 0x1a1a2e,
      emissive: 0x0a0a1a,
      roughness: 0.8,
      metalness: 0.2
    })

    this.roadMesh = new THREE.Mesh(roadGeometry, roadMaterial)
    this.scene.add(this.roadMesh)

    // Add lane markers
    this.addLaneMarkers(track, roadWidth)

    // Add treble-driven accents
    this.addTreblePulses(track)
  }

  private addLaneMarkers(track: TrackData, roadWidth: number): void {
    const laneMarkerGeometry = new THREE.BoxGeometry(0.1, 0.05, 0.5)
    const laneMarkerMaterial = new THREE.MeshStandardMaterial({
      color: 0xffff00,
      emissive: 0xffff00,
      emissiveIntensity: 0.5
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
    for (const pulse of track.treblePulses) {
      const hazardGroup = new THREE.Group()

      const bladeHeight = 5.5
      const bladeGeometry = new THREE.CylinderGeometry(0.55, 0.18, bladeHeight, 10, 6, true)
      bladeGeometry.translate(0, bladeHeight / 2, 0)

      const bladePosition = bladeGeometry.getAttribute('position')
      const workingVec = new THREE.Vector3()

      for (let i = 0; i < bladePosition.count; i++) {
        workingVec.fromBufferAttribute(bladePosition, i)
        const heightT = THREE.MathUtils.clamp(workingVec.y / bladeHeight, 0, 1)
        const twist = THREE.MathUtils.lerp(0, Math.PI * 0.55, heightT)
        const jagged = 0.08 + (1 - heightT) * 0.16

        const radius = new THREE.Vector2(workingVec.x, workingVec.z).length()
        const angle = Math.atan2(workingVec.z, workingVec.x) + twist
        const warpedRadius = radius + (Math.random() - 0.5) * jagged

        workingVec.x = Math.cos(angle) * warpedRadius
        workingVec.z = Math.sin(angle) * warpedRadius
        workingVec.y += (Math.random() - 0.5) * jagged * 0.35

        bladePosition.setXYZ(i, workingVec.x, workingVec.y, workingVec.z)
      }

      bladePosition.needsUpdate = true
      bladeGeometry.computeVertexNormals()

      const crystalMaterial = new THREE.MeshPhysicalMaterial({
        color: 0xff204d,
        emissive: 0x9f002c,
        emissiveIntensity: 1.6,
        roughness: 0.18,
        metalness: 0.25,
        transmission: 0.48,
        thickness: 0.65,
        clearcoat: 0.65,
        clearcoatRoughness: 0.08,
        flatShading: false
      })

      const blade = new THREE.Mesh(bladeGeometry, crystalMaterial)
      const scale = 0.9 + pulse.intensity * 1.2
      blade.scale.set(scale, scale * 1.2, scale)
      blade.position.y = 0.35
      blade.rotation.y = pulse.time * 0.9 + THREE.MathUtils.degToRad(20)
      blade.rotation.x = THREE.MathUtils.degToRad(-96)

      const sideShardGeometry = new THREE.ConeGeometry(0.16, 2.8, 6)
      const shardA = new THREE.Mesh(sideShardGeometry, crystalMaterial)
      shardA.position.set(0.5, 0.9, -0.2)
      shardA.rotation.set(Math.PI * 0.94, pulse.time * 1.2, Math.PI * 0.18)
      shardA.scale.setScalar(0.8 + pulse.intensity * 0.6)

      const shardB = shardA.clone()
      shardB.position.set(-0.42, 0.7, 0.25)
      shardB.rotation.set(Math.PI * 0.9, pulse.time * 1.05, Math.PI * -0.25)

      const warningPlateGeometry = new THREE.CylinderGeometry(1.05, 0.95, 0.18, 20)
      const warningPlateMaterial = new THREE.MeshStandardMaterial({
        color: 0x5d0015,
        emissive: 0xe60035,
        emissiveIntensity: 1.45,
        roughness: 0.4,
        metalness: 0.2,
        opacity: 0.85,
        transparent: true
      })
      const warningPlate = new THREE.Mesh(warningPlateGeometry, warningPlateMaterial)
      warningPlate.position.y = 0.04

      hazardGroup.add(warningPlate)
      hazardGroup.add(blade)
      hazardGroup.add(shardA)
      hazardGroup.add(shardB)
      hazardGroup.position.copy(pulse.pos)
      hazardGroup.position.y = Math.max(0, pulse.pos.y)

      this.scene.add(hazardGroup)
      this.trebleMeshes.push(hazardGroup)
    }
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
  }

  renderFrame(gameState: GameState): void {
    const now = performance.now()
    const deltaSeconds = this.lastFrameTime
      ? Math.min((now - this.lastFrameTime) / 1000, 0.05)
      : 0
    this.lastFrameTime = now

    if (!this.carMesh) {
      // Car not created yet, just render the scene
      this.renderer.render(this.scene, this.camera)
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
      this.renderer.render(this.scene, this.camera)
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
      const slopeSpeed = (carPos.y - this.lastTrackHeight) / deltaSeconds
      const upwardKick = Math.max(0, slopeSpeed - 2) * 0.08

      if (upwardKick > 0) {
        this.carVerticalVelocity += upwardKick
      }

      if (currentNode.isJump || nextNode.isJump) {
        this.carVerticalVelocity = Math.max(this.carVerticalVelocity, 12)
      }

      const gravity = 28
      this.carVerticalVelocity -= gravity * deltaSeconds
      this.carVerticalOffset += this.carVerticalVelocity * deltaSeconds

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
    this.renderer.render(this.scene, this.camera)
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

