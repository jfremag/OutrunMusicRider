import { AudioEngine } from '../audio/AudioEngine'
import { analyzeBuffer, MusicMap } from '../audio/AudioAnalysis'
import { TrackData } from '../track/TrackTypes'
import { generateTrack } from '../track/TrackGenerator'
import { GameState, initGameState } from './GameState'
import { ThreeScene } from '../render/ThreeScene'

// Beat selectivity threshold (iteration 6). A detected beat only "fires" the flashy
// transient gestures (FOV punch, bloom pulse, camera shake, beat-indicator glow) when
// its normalized strength is at or above this value. Strong beats (kicks, snares) sit
// in 0.5..1.0; weak beats (hi-hats, light percussion, string pizz) sit in 0.2..0.5 and
// only sustain the baseline mood. Reserving visual emphasis for the strong beats is the
// "professional restraint" that reads as premium (Wipeout / Nintendo / Tesla-promo
// aesthetic) instead of a generic visualizer that twitches on every transient.
const BEAT_STRENGTH_THRESHOLD = 0.5

// Treble-transient gate (iteration 7). A detected treble peak only "fires" the particle
// shimmer when its NORMALIZED strength (0..1, scaled against the track's loudest treble
// peak in loadFile) is at or above this value, so the hero car sparks on the prominent
// hi-hat/cymbal/snare-sizzle transients rather than on every faint high-frequency wiggle.
// Treble peaks are already gated upstream to local maxima above a mean+0.5·std threshold,
// so this is a light secondary cull tuned for "premium restraint" — a steady stream of
// shimmer on busy treble passages, near-silence on sparse/warm ones.
const TREBLE_STRENGTH_THRESHOLD = 0.25

export class GameController {
  private audioEngine: AudioEngine
  private threeScene: ThreeScene
  private musicMap: MusicMap | null = null
  private trackData: TrackData | null = null
  private gameState: GameState
  private lastAutoLaneChange = 0
  // Cursor into musicMap.beats so we only fire each beat once as the clock passes it.
  private nextBeatIndex = 0
  // Cursor into musicMap.treblePeaks (iteration 7), mirroring nextBeatIndex: we fire each
  // treble transient's particle shimmer exactly once as the audio clock crosses it.
  private nextTrebleIndex = 0
  // Track-wide loudest treble peak, captured in loadFile, used to normalize each peak's
  // raw derivative-RMS strength into a predictable 0..1 the shimmer + gate can reason about.
  private maxTrebleStrength = 1
  // Wall-clock (performance.now) timestamp of the most recent drop-region entry,
  // and that drop's strength. The renderer-facing dropIntensity is a decay
  // envelope phased off this so it spikes on entry and eases back to 0.
  private lastDropTime = -Infinity
  private lastDropStrength = 0
  // Index of the drop region we're currently inside (-1 = none), used to fire the
  // "drop entered" envelope exactly once per region as the clock crosses into it.
  private activeDropIndex = -1
  // Smoothed spectral centroid (rolling 1-pole filter) for calm mood transitions.
  private smoothedCentroid = 0
  private smoothedFlux = 0

  constructor(canvas: HTMLCanvasElement) {
    this.audioEngine = new AudioEngine()
    this.threeScene = new ThreeScene(canvas)
    this.gameState = initGameState()
  }

  /**
   * Loads, decodes, analyzes, and builds a track from an audio file. The optional
   * `onStatus` callback (iteration 8) is invoked at each pipeline milestone with a
   * human-readable status string, and finally with `null` to signal completion, so the
   * UI can show a premium loading overlay during the 2-3s analysis gap. Passing the
   * callback is purely additive — existing callers that omit it are unaffected.
   */
  async loadFile(file: File, onStatus?: (status: string | null) => void): Promise<void> {
    try {
      // Decode audio
      onStatus?.('Decoding audio...')
      const buffer = await this.audioEngine.loadFile(file)

      // Analyze audio
      onStatus?.('Analyzing waveform...')
      this.musicMap = await analyzeBuffer(buffer)

      // Generate track
      onStatus?.('Detecting beats & tempo...')
      this.trackData = generateTrack(this.musicMap)

      // Set track in scene
      onStatus?.('Generating track geometry...')
      this.threeScene.setTrack(this.trackData)

      // Reset game state
      this.gameState = initGameState()
      this.nextBeatIndex = 0
      this.nextTrebleIndex = 0
      // Capture the track's loudest treble peak so trebleStrength normalizes to 0..1.
      this.maxTrebleStrength = this.musicMap.treblePeaks.reduce(
        (max, peak) => Math.max(max, peak.strength),
        1e-6
      )
      this.lastDropTime = -Infinity
      this.lastDropStrength = 0
      this.activeDropIndex = -1
      this.smoothedCentroid = 0
      this.smoothedFlux = 0

      // Signal completion so the loading overlay can fade out.
      onStatus?.(null)
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

    // Detect treble transients crossing the clock and fire the one-frame shimmer pulse.
    this.updateTrebleSync(audioTime)

    // Sample spectral mood + drop envelope and write them onto the car state so
    // the renderer can drive sky/grid/bloom/FOV from a single mood north-star.
    this.updateMood(audioTime)

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
        // envelopes directly against performance.now(). Both weak and strong beats
        // stamp the timestamp/strength so baseline mood + particle effects still see
        // every onset...
        this.gameState.car.lastBeatTime = performance.now()
        this.gameState.car.beatStrength = beat.strength
        // ...but the selectivity gate only opens for STRONG beats, so the renderer
        // reserves its FOV/bloom/shake/indicator punches for the kicks and snares.
        this.gameState.car.beatFires = beat.strength >= BEAT_STRENGTH_THRESHOLD
      }
      this.nextBeatIndex++
    }
  }

  /**
   * Walks the treble-peak list against the audio clock (iteration 7), mirroring
   * updateBeatSync but for high-frequency transients. Fires a one-frame `trebleFires`
   * pulse (with the peak's normalized 0..1 `trebleStrength`) the instant the clock
   * crosses a peak, so the renderer can spray a tiny cyan/magenta shimmer off the hero
   * car on hi-hats/cymbals/snare sizzle. A ±75ms window keeps the trigger tight; a
   * cursor advances monotonically so each peak fires once, and a rewind resets it on
   * replay/seek. `trebleFires` is reset to false every frame this runs (and again by the
   * renderer after it emits), making it a true single-shot event with no double-emit.
   */
  private updateTrebleSync(audioTime: number): void {
    // One-frame pulse: clear first, set only if a peak is crossed this frame.
    this.gameState.car.trebleFires = false
    if (!this.musicMap) return
    const peaks = this.musicMap.treblePeaks
    if (peaks.length === 0) return

    const windowSec = 0.075

    // Handle rewind / replay: if the clock moved well behind the cursor, rewind it.
    if (this.nextTrebleIndex > 0 && audioTime + windowSec < peaks[this.nextTrebleIndex - 1].time) {
      this.nextTrebleIndex = 0
    }

    // Consume every treble peak the clock has now reached (within the leading window).
    // Track the strongest peak crossed this frame so a dense cluster still fires one
    // proportional burst rather than spamming the pool.
    let firedStrength = 0
    let fired = false
    while (
      this.nextTrebleIndex < peaks.length &&
      peaks[this.nextTrebleIndex].time <= audioTime + windowSec
    ) {
      const peak = peaks[this.nextTrebleIndex]
      if (Math.abs(peak.time - audioTime) <= windowSec) {
        const norm = Math.min(1, peak.strength / this.maxTrebleStrength)
        if (norm >= TREBLE_STRENGTH_THRESHOLD && norm > firedStrength) {
          firedStrength = norm
          fired = true
        }
      }
      this.nextTrebleIndex++
    }

    if (fired) {
      this.gameState.car.trebleFires = true
      this.gameState.car.trebleStrength = firedStrength
    }
  }

  /**
   * Samples the spectral mood signals (centroid + flux) at the current audio time
   * and maintains the drop-intensity decay envelope, writing all three onto the
   * car state. The centroid/flux are linearly interpolated between the two nearest
   * 75ms spectral samples, then run through a 1-pole low-pass so mood transitions
   * glide rather than snap (matching the renderer's lerp-driven aesthetic). The
   * drop envelope spikes to the region's strength on entry (detected via a cursor
   * that crosses into a new region) and decays toward 0 over DROP_DECAY_MS.
   */
  private updateMood(audioTime: number): void {
    if (!this.musicMap) return

    // --- Interpolate spectral centroid + flux at the playback time.
    const samples = this.musicMap.spectralSamples
    let centroid = 0
    let flux = 0
    if (samples.length > 0) {
      // 75ms hop -> direct index estimate, then refine to the bracketing pair.
      const approx = Math.min(samples.length - 1, Math.max(0, Math.floor(audioTime / 0.075)))
      let i = approx
      while (i > 0 && samples[i].time > audioTime) i--
      while (i < samples.length - 1 && samples[i + 1].time <= audioTime) i++
      const a = samples[i]
      const b = samples[Math.min(i + 1, samples.length - 1)]
      const span = b.time - a.time
      const f = span > 1e-6 ? Math.max(0, Math.min(1, (audioTime - a.time) / span)) : 0
      centroid = a.centroidNorm + (b.centroidNorm - a.centroidNorm) * f
      flux = a.flux + (b.flux - a.flux) * f
    }

    // 1-pole smoothing (≈2-3 frame window) for calm mood drift.
    const smoothing = 0.12
    this.smoothedCentroid += (centroid - this.smoothedCentroid) * smoothing
    this.smoothedFlux += (flux - this.smoothedFlux) * smoothing
    this.gameState.car.spectralCentroid = this.smoothedCentroid
    this.gameState.car.spectralFlux = this.smoothedFlux

    // --- Unified camera-shake amplitude (iteration 3). Beats dominate (0.7) so the
    // shake punches fast and legibly on each kick/snare, while spectral flux (0.5)
    // layers in choppy treble texture: busy, bright sections jitter more than calm
    // ones. The renderer phases an ease-out envelope off lastShakeTime, so we only
    // (re)stamp the timestamp when the music actually drives a fresh punch — a quick
    // beat or a flux surge — rather than every frame, which would freeze the
    // envelope at full and produce a constant rattle. A hard collision spike
    // (handled in the renderer) overrides this softer musical amplitude.
    // Beat selectivity (iteration 6): only STRONG beats contribute their punch to the
    // shake, so the snappy kick-jolt is reserved for emotionally significant moments.
    // The flux term (treble texture) is unaffected and keeps busy sections jittering,
    // and a hard collision spike (handled in the renderer) still overrides this.
    const beatShake = this.gameState.car.beatFires ? this.gameState.car.beatStrength * 0.7 : 0
    const musicalShake = beatShake + this.smoothedFlux * 0.5
    const beatAgeMs = performance.now() - this.gameState.car.lastBeatTime
    const freshStrongBeat =
      this.gameState.car.beatFires && Number.isFinite(beatAgeMs) && beatAgeMs >= 0 && beatAgeMs < 60
    if (freshStrongBeat || this.smoothedFlux > 0.45) {
      this.gameState.car.cameraShakeAmplitude = Math.min(1, musicalShake)
      this.gameState.car.lastShakeTime = performance.now()
    }

    // --- Drop envelope: detect entry into a new region, then decay.
    const regions = this.musicMap.dropRegions
    let insideIndex = -1
    for (let r = 0; r < regions.length; r++) {
      if (audioTime >= regions[r].startTime && audioTime <= regions[r].endTime) {
        insideIndex = r
        break
      }
    }

    if (insideIndex !== -1 && insideIndex !== this.activeDropIndex) {
      // Just crossed into a new drop: fire the envelope...
      this.lastDropTime = performance.now()
      this.lastDropStrength = regions[insideIndex].strength
      // ...and spray a one-shot particle burst marking the emotional peak. Color is
      // chosen by the renderer from the current brightness (cyan when cool/dark,
      // magenta when bright/hot); count scales with the drop's strength.
      this.threeScene.emitDropBurst(this.lastDropStrength, this.smoothedCentroid)
    }
    this.activeDropIndex = insideIndex

    const DROP_DECAY_MS = 500
    const dropAge = performance.now() - this.lastDropTime
    let dropIntensity = 0
    if (Number.isFinite(dropAge) && dropAge >= 0 && dropAge < DROP_DECAY_MS) {
      const d = dropAge / DROP_DECAY_MS
      dropIntensity = (1 - d) * (1 - d) * this.lastDropStrength
    }
    // While still physically inside a long drop region, hold a sustained floor so
    // the world stays energized for the whole passage, not just the entry spike.
    if (insideIndex !== -1) {
      dropIntensity = Math.max(dropIntensity, this.lastDropStrength * 0.55)
    }
    this.gameState.car.dropIntensity = dropIntensity
  }

  setCollisionHandler(handler: (() => void) | null): void {
    this.threeScene.setCollisionCallback(handler)
  }

  private canSteer(): boolean {
    return this.gameState.car.verticalOffset <= 0.05
  }
}

