import { AudioEngine } from '../audio/AudioEngine'
import { analyzeBuffer, MusicMap } from '../audio/AudioAnalysis'
import { TrackData } from '../track/TrackTypes'
import { generateTrack } from '../track/TrackGenerator'
import { GameState, initGameState } from './GameState'
import { ThreeScene } from '../render/ThreeScene'

export class GameController {
  private audioEngine: AudioEngine
  private threeScene: ThreeScene
  private musicMap: MusicMap | null = null
  private trackData: TrackData | null = null
  private gameState: GameState
  private lastAutoLaneChange = 0
  // Cursor into musicMap.beats so we only fire each beat once as the clock passes it.
  private nextBeatIndex = 0

  constructor(canvas: HTMLCanvasElement) {
    this.audioEngine = new AudioEngine()
    this.threeScene = new ThreeScene(canvas)
    this.gameState = initGameState()
  }

  async loadFile(file: File): Promise<void> {
    try {
      // Decode audio
      const buffer = await this.audioEngine.loadFile(file)

      // Analyze audio
      this.musicMap = await analyzeBuffer(buffer)

      // Generate track
      this.trackData = generateTrack(this.musicMap)

      // Set track in scene
      this.threeScene.setTrack(this.trackData)

      // Reset game state
      this.gameState = initGameState()
      this.nextBeatIndex = 0
    } catch (error) {
      console.error('Error loading file:', error)
      throw error
    }
  }

  play(): void {
    this.audioEngine.play()
  }

  pause(): void {
    this.audioEngine.pause()
  }

  handleInput(key: string): void {
    if (!this.canSteer()) {
      return
    }

    if (key === 'ArrowLeft') {
      const currentLane = this.gameState.car.laneOffsetIndex
      const newLane = Math.max(-1, currentLane - 1) as -1 | 0 | 1
      this.gameState.car.laneOffsetIndex = newLane
    } else if (key === 'ArrowRight') {
      const currentLane = this.gameState.car.laneOffsetIndex
      const newLane = Math.min(1, currentLane + 1) as -1 | 0 | 1
      this.gameState.car.laneOffsetIndex = newLane
    }
  }

  update(): void {
    // Always render, regardless of track or playback state
    if (!this.trackData || !this.audioEngine.isAudioPlaying()) {
      // Still render even if not playing
      this.threeScene.renderFrame(this.gameState)
      return
    }

    // Get current audio time
    const audioTime = this.audioEngine.getCurrentTime()

    // Map audio time to car distance
    // Assuming constant speed of 50 units/sec
    const speed = 50
    const targetDistance = audioTime * speed

    // Update car distance
    this.gameState.car.distance = Math.min(targetDistance, this.trackData.length)

    // Detect beats crossing the audio clock and record them for the renderer.
    this.updateBeatSync(audioTime)

    // Anticipate treble obstacles and dodge within the lane grid
    this.maybeAutoDodge(audioTime)

    // Render frame
    this.threeScene.renderFrame(this.gameState)
  }

  resize(width: number, height: number): void {
    this.threeScene.resize(width, height)
  }

  isReady(): boolean {
    return this.trackData !== null
  }

  private maybeAutoDodge(audioTime: number): void {
    if (!this.canSteer()) return

    if (!this.trackData) return

    const carDistance = this.gameState.car.distance
    const lookAhead = 25
    const conflictRange = 8
    const cooldown = 0.4

    if (audioTime - this.lastAutoLaneChange < cooldown) {
      return
    }

    const upcomingPulses = this.trackData.treblePulses.filter(pulse => {
      const delta = pulse.pos.z - carDistance
      return delta > 0 && delta < lookAhead
    })

    const blockingPulse = upcomingPulses.find(pulse =>
      pulse.laneIndex === this.gameState.car.laneOffsetIndex &&
      pulse.pos.z - carDistance < conflictRange
    )

    if (!blockingPulse) return

    const candidateLanes: Array<-1 | 0 | 1> = [-1, 0, 1]
    const safeLanes = candidateLanes.filter(lane =>
      lane !== blockingPulse.laneIndex &&
      !upcomingPulses.some(pulse =>
        pulse.laneIndex === lane &&
        pulse.pos.z - carDistance < conflictRange
      )
    )

    if (safeLanes.length === 0) return

    const scoredLanes = safeLanes.map(lane => {
      const lanePulses = upcomingPulses.filter(pulse => pulse.laneIndex === lane)
      const nearestObstacle = lanePulses.reduce((nearest, pulse) => {
        const delta = pulse.pos.z - carDistance
        return delta > 0 ? Math.min(nearest, delta) : nearest
      }, lookAhead)

      const obstaclePressure = lanePulses.reduce((pressure, pulse) => {
        const delta = pulse.pos.z - carDistance
        return pressure + (delta > 0 ? 1 / Math.max(1, delta) : 0)
      }, 0)

      const laneChangeCost = Math.abs(lane - this.gameState.car.laneOffsetIndex) * 0.35
      const randomness = Math.random() * 0.15

      const safetyScore = nearestObstacle - obstaclePressure - laneChangeCost + randomness

      return { lane, safetyScore }
    })

    scoredLanes.sort((a, b) => b.safetyScore - a.safetyScore)

    this.gameState.car.laneOffsetIndex = scoredLanes[0].lane
    this.lastAutoLaneChange = audioTime
  }

  /**
   * Walks the beat list against the audio clock and records the most recent beat
   * onset on the car state. A ±75ms window keeps the trigger tight to the kick/snare
   * so the renderer's FOV punch + bloom pulse land in sync with the music.
   */
  private updateBeatSync(audioTime: number): void {
    if (!this.musicMap) return
    const beats = this.musicMap.beats
    if (beats.length === 0) return

    const windowSec = 0.075

    // Handle rewind / replay: if the clock moved well behind the cursor, rewind it.
    if (this.nextBeatIndex > 0 && audioTime + windowSec < beats[this.nextBeatIndex - 1].time) {
      this.nextBeatIndex = 0
    }

    // Consume every beat the clock has now reached (within the leading window).
    while (
      this.nextBeatIndex < beats.length &&
      beats[this.nextBeatIndex].time <= audioTime + windowSec
    ) {
      const beat = beats[this.nextBeatIndex]
      // Only fire if we're genuinely near the onset (not catching up after a seek).
      if (Math.abs(beat.time - audioTime) <= windowSec) {
        // Record a wall-clock timestamp so the renderer can phase the FOV/bloom
        // envelopes directly against performance.now().
        this.gameState.car.lastBeatTime = performance.now()
        this.gameState.car.beatStrength = beat.strength
      }
      this.nextBeatIndex++
    }
  }

  setCollisionHandler(handler: (() => void) | null): void {
    this.threeScene.setCollisionCallback(handler)
  }

  private canSteer(): boolean {
    return this.gameState.car.verticalOffset <= 0.05
  }
}

