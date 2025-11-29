import * as THREE from 'three'
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
  private gridMesh: THREE.Mesh | null = null
  private starField: THREE.Points | null = null
  private sunMesh: THREE.Mesh | null = null
  private trebleMeshes: THREE.Mesh[] = []

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
    this.createCar()

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
    this.sunMesh.renderOrder = -5
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

  private createCar(): void {
    const carGroup = new THREE.Group()

    // Car body (lower box) - make it more visible with emissive
    const bodyGeometry = new THREE.BoxGeometry(1.2, 0.4, 2)
    const bodyMaterial = new THREE.MeshStandardMaterial({ 
      color: 0xff0066,
      emissive: 0xff0066,
      emissiveIntensity: 0.3
    })
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial)
    body.position.y = 0.2
    carGroup.add(body)

    // Car cabin (upper box) - make it more visible with emissive
    const cabinGeometry = new THREE.BoxGeometry(0.9, 0.5, 1.2)
    const cabinMaterial = new THREE.MeshStandardMaterial({ 
      color: 0x00ffff,
      emissive: 0x00ffff,
      emissiveIntensity: 0.3
    })
    const cabin = new THREE.Mesh(cabinGeometry, cabinMaterial)
    cabin.position.set(0, 0.65, -0.2)
    carGroup.add(cabin)

    // Add some neon glow effect
    const glowGeometry = new THREE.BoxGeometry(1.3, 0.5, 2.1)
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0xff00ff,
      transparent: true,
      opacity: 0.2
    })
    const glow = new THREE.Mesh(glowGeometry, glowMaterial)
    glow.position.y = 0.25
    carGroup.add(glow)

    this.carMesh = carGroup
    this.scene.add(carGroup)
  }

  setTrack(track: TrackData): void {
    this.trackData = track

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
      const pulseGeometry = new THREE.ConeGeometry(0.35, 1.6, 12)
      const pulseMaterial = new THREE.MeshStandardMaterial({
        color: 0x00e5ff,
        emissive: 0xffffff,
        emissiveIntensity: 1.3,
        transparent: true,
        opacity: 0.9,
        roughness: 0.3,
        metalness: 0.4
      })

      const pulseMesh = new THREE.Mesh(pulseGeometry, pulseMaterial)
      const scale = 0.85 + pulse.intensity * 1.3
      pulseMesh.scale.set(scale, scale, scale)
      pulseMesh.position.copy(pulse.pos)
      pulseMesh.rotation.x = Math.PI
      pulseMesh.rotation.y = pulse.time

      this.scene.add(pulseMesh)
      this.trebleMeshes.push(pulseMesh)
    }
  }

  private clearTrebleMeshes(): void {
    for (const mesh of this.trebleMeshes) {
      this.scene.remove(mesh)
      mesh.geometry.dispose()

      if (mesh.material instanceof THREE.Material) {
        mesh.material.dispose()
      } else if (Array.isArray(mesh.material)) {
        mesh.material.forEach(material => material.dispose())
      }
    }
    this.trebleMeshes = []
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
  }

  renderFrame(gameState: GameState): void {
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
      this.renderer.render(this.scene, this.camera)
      return
    }

    // Track data exists - use existing logic
    // Find nearest track node
    const carDistance = gameState.car.distance
    let nearestNodeIndex = 0
    let minDist = Infinity

    for (let i = 0; i < this.trackData.nodes.length; i++) {
      const node = this.trackData.nodes[i]
      const dist = Math.abs(node.s - carDistance)
      if (dist < minDist) {
        minDist = dist
        nearestNodeIndex = i
      }
    }

    const currentNode = this.trackData.nodes[nearestNodeIndex]
    const nextNodeIndex = Math.min(nearestNodeIndex + 1, this.trackData.nodes.length - 1)
    const nextNode = this.trackData.nodes[nextNodeIndex]

    // Interpolate position between nodes
    const segmentLength = nextNode.s - currentNode.s
    const t = segmentLength > 0 ? (carDistance - currentNode.s) / segmentLength : 0
    const clampedT = Math.max(0, Math.min(1, t))

    const carPos = new THREE.Vector3().lerpVectors(
      currentNode.pos,
      nextNode.pos,
      clampedT
    )

    // Interpolate forward direction
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

    const laneOffsetVec = right.clone().multiplyScalar(gameState.car.laneOffset)
    carPos.add(laneOffsetVec)

    // Position and orient car
    this.carMesh.position.copy(carPos)
    this.carMesh.lookAt(carPos.clone().add(carForward))

    // Position camera behind and slightly above car
    const cameraDistance = 8
    const cameraHeight = 3
    const cameraOffset = carForward.clone().multiplyScalar(-cameraDistance)
    cameraOffset.y = cameraHeight

    this.camera.position.copy(carPos.clone().add(cameraOffset))
    this.camera.lookAt(carPos.clone().add(carForward.clone().multiplyScalar(5)))

    // Render
    this.updateSunPlacement()
    this.renderer.render(this.scene, this.camera)
  }

  private updateSunPlacement(): void {
    if (!this.sunMesh) return

    const viewDir = new THREE.Vector3()
    this.camera.getWorldDirection(viewDir)

    const sunDistance = 800
    const sunHeight = 40

    const targetPos = this.camera.position
      .clone()
      .add(viewDir.clone().multiplyScalar(sunDistance))
    targetPos.y = Math.max(targetPos.y, sunHeight)

    this.sunMesh.position.copy(targetPos)
    this.sunMesh.lookAt(targetPos.clone().add(viewDir.clone().multiplyScalar(200)))
  }
}

