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

  update(dt: number): void {
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

    // Render frame
    this.threeScene.renderFrame(this.gameState)
  }

  resize(width: number, height: number): void {
    this.threeScene.resize(width, height)
  }

  isReady(): boolean {
    return this.trackData !== null
  }
}

