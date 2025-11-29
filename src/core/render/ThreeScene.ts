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
    // Create gradient sky using a large sphere with simpler material
    const skyGeometry = new THREE.SphereGeometry(5000, 32, 32)
    
    // Use MeshBasicMaterial for now to avoid shader proxy issues
    // We can enhance with shaders later if needed
    const skyMaterial = new THREE.MeshBasicMaterial({
      color: 0x0a0a1a, // Dark blue-black base
      side: THREE.BackSide,
      fog: false
    })

    this.skyMesh = new THREE.Mesh(skyGeometry, skyMaterial)
    this.scene.add(this.skyMesh)

    // Add fog for depth effect
    this.scene.fog = new THREE.Fog(0x0a0a1a, 100, 2000)

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
    this.renderer.render(this.scene, this.camera)
  }
}

