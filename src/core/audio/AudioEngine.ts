export class AudioEngine {
  private audioContext: AudioContext | null = null
  private audioBuffer: AudioBuffer | null = null
  private sourceNode: AudioBufferSourceNode | null = null
  private startTime: number = 0
  private pausedTime: number = 0
  private isPlaying: boolean = false

  constructor() {
    // AudioContext will be created on first use
  }

  private getContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
    }
    return this.audioContext
  }

  async loadFile(file: File): Promise<AudioBuffer> {
    const arrayBuffer = await file.arrayBuffer()
    const context = this.getContext()
    this.audioBuffer = await context.decodeAudioData(arrayBuffer)
    return this.audioBuffer
  }

  play(): void {
    if (!this.audioBuffer) {
      throw new Error('No audio file loaded')
    }

    if (this.isPlaying) {
      return
    }

    const context = this.getContext()
    
    // Resume context if suspended (required by some browsers)
    if (context.state === 'suspended') {
      context.resume()
    }

    this.sourceNode = context.createBufferSource()
    this.sourceNode.buffer = this.audioBuffer
    this.sourceNode.connect(context.destination)

    const offset = this.pausedTime
    this.startTime = context.currentTime - offset
    this.sourceNode.start(0, offset)
    this.isPlaying = true
  }

  pause(): void {
    if (!this.isPlaying || !this.sourceNode) {
      return
    }

    this.pausedTime = this.getCurrentTime()
    this.sourceNode.stop()
    this.sourceNode = null
    this.isPlaying = false
  }

  getCurrentTime(): number {
    if (!this.audioBuffer) {
      return 0
    }

    if (!this.isPlaying) {
      return this.pausedTime
    }

    const context = this.getContext()
    const elapsed = context.currentTime - this.startTime
    return Math.min(elapsed, this.audioBuffer.duration)
  }

  getDuration(): number {
    return this.audioBuffer?.duration ?? 0
  }

  isAudioPlaying(): boolean {
    return this.isPlaying
  }
}

