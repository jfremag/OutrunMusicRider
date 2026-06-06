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

// Base forward speed in track units per second of audio (matches the value baked into
// TrackGenerator.generateTrack so the car traverses the whole track over the song). The
// car's effective speed is BASE_SPEED_U_PER_SEC × car.speedMultiplier, integrated from
// the audio-time delta each frame so the cinematic acceleration never teleports the car.
const BASE_SPEED_U_PER_SEC = 50

// Cinematic acceleration + camera-choreography tuning (iteration 9). On drop entry the
// car "hits the throttle" (speedMultiplier ramps toward DROP_SPEED_MULTIPLIER) and the
// chase camera pulls back (cameraDepthScale ramps toward DROP_DEPTH_SCALE), then both
// decay to their resting 1.0 on drop exit. Rising-edge entry is detected when the
// drop-intensity envelope first crosses DROP_ENTER_THRESHOLD; exit is detected when it
// falls below DROP_EXIT_THRESHOLD (a hysteresis band that prevents jitter from brief
// dips inside a sustained drop). The ramps use frame-rate-independent 1-pole smoothing
// whose rate is tuned so entry resolves in ~200-250ms and decay in ~400ms.
const DROP_ENTER_THRESHOLD = 0.3   // rising-edge: dropIntensity above this -> focus on
const DROP_EXIT_THRESHOLD = 0.15   // falling-edge: dropIntensity below this -> focus off
const DROP_SPEED_MULTIPLIER = 1.3  // peak forward-speed multiplier during a drop
const DROP_DEPTH_SCALE = 1.15      // peak camera pull-back multiplier during a drop
const SPEED_RAMP_TAU_S = 0.07      // 1-pole time constant for the speed/depth attack (~200ms to settle)
const SPEED_DECAY_TAU_S = 0.18     // slower time constant for the decay back to rest (~400ms)

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
  // Last audio-clock timestamp seen in update(), used to integrate car distance from the
  // per-frame audio-time delta so the cinematic speedMultiplier modulates forward motion
  // continuously (never teleports the car, never desyncs overall progress from audio).
  private lastAudioTime = -1
  // Accumulated forward distance (units), integrated as Σ(Δaudio × BASE_SPEED × mult).
  // Kept separate from gameState.car.distance (which is the clamped, render-facing value)
  // so a track-length clamp can't corrupt the running integral.
  private accumulatedDistance = 0
  // Drop-focus state machine (iteration 9). `dropFocusActive` mirrors
  // gameState.isFocusedOnDrop; tracked here too so the rising/falling-edge transitions are
  // computed from a controller-owned value (the renderer never writes game state).
  private dropFocusActive = false
  // Wall-clock (performance.now) timestamp of the previous updateMood call, used to make
  // the speed/depth ramps frame-rate-independent (the smoothing rate is derived from the
  // real elapsed time, not assumed 60fps). -1 until the first mood update.
  private lastMoodTime = -1

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
      this.lastAudioTime = -1
      this.accumulatedDistance = 0
      this.dropFocusActive = false
      this.lastMoodTime = -1

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
    // Mirror the audio clock onto game state every frame (iteration 10) so the read-only
    // HUD overlay can sample the MusicMap against the exact clock the renderer uses. This
    // runs on BOTH paths (playing and paused/no-track) so the HUD stays correct while the
    // song is paused at a position or before a track exists (-> 0).
    this.gameState.audioTime = this.audioEngine.getCurrentTime()

    // Always render, regardless of track or playback state
    if (!this.trackData || !this.audioEngine.isAudioPlaying()) {
      // Still render even if not playing
      this.threeScene.renderFrame(this.gameState)
      return
    }

    // Get current audio time
    const audioTime = this.gameState.audioTime

    // Sample spectral mood + drop envelope and the cinematic acceleration/camera scalars
    // FIRST, so this frame's car.speedMultiplier reflects the current drop phase before we
    // integrate forward motion with it.
    this.updateMood(audioTime)

    // Map audio time to car distance by INTEGRATING the audio-time delta scaled by the
    // drop-driven speed multiplier (iteration 9): distance += Δaudio × BASE_SPEED × mult.
    // Integrating (rather than the old absolute `audioTime × speed`) lets the cinematic
    // acceleration accelerate/decelerate the car continuously without teleporting it, while
    // keeping overall progress locked to the audio timeline (mult averages ~1 over a song,
    // and the drop ramps are brief). On the first frame after a (re)load or a seek/rewind we
    // re-baseline the integral to the absolute position so it never drifts after scrubbing.
    const speed = BASE_SPEED_U_PER_SEC
    const dt = audioTime - this.lastAudioTime
    if (this.lastAudioTime < 0 || dt < 0 || dt > 0.5) {
      // First frame, rewind, or a large jump (tab-throttle / seek): re-anchor to absolute.
      this.accumulatedDistance = audioTime * speed
    } else {
      this.accumulatedDistance += dt * speed * this.gameState.car.speedMultiplier
      // Anti-drift self-heal: a drop's elevated speed makes the car run slightly AHEAD of
      // the absolute audio position. When back at rest (multiplier ≈ 1, i.e. not focused on
      // a drop) we gently relax the integral toward the absolute position so the small lead
      // dissolves over a few seconds and the car never desyncs from the music's BPM grid
      // over a long song. The pull is tiny (≈2%/frame, frame-rate-scaled) so it is invisible
      // and never fights the active drop acceleration.
      if (!this.gameState.isFocusedOnDrop) {
        const absolute = audioTime * speed
        this.accumulatedDistance += (absolute - this.accumulatedDistance) * Math.min(1, dt * 1.2)
      }
    }
    this.lastAudioTime = audioTime

    // Update car distance (clamped to the track for rendering; the running integral above
    // is kept separate so the clamp can't corrupt continued integration near the end).
    this.gameState.car.distance = Math.min(this.accumulatedDistance, this.trackData.length)

    // Detect beats crossing the audio clock and record them for the renderer.
    this.updateBeatSync(audioTime)

    // Detect treble transients crossing the clock and fire the one-frame shimmer pulse.
    this.updateTrebleSync(audioTime)

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

  /**
   * Read-only access to the analyzed MusicMap for the HUD overlay (iteration 10). The
   * HUD samples beats (for rolling BPM + beat phase) and the energy/treble bands (for the
   * 3-band meters) against the audio clock. Returns null until a file has been analyzed.
   * Encapsulation is preserved — the HUD only reads; it never mutates the map or state.
   */
  getMusicMap(): MusicMap | null {
    return this.musicMap
  }

  /**
   * Read-only access to the live game state for the HUD overlay (iteration 10). The HUD
   * reads gameState.audioTime (the mirrored audio clock) for BPM/phase/band sampling. The
   * caller must treat the returned object as immutable; the HUD never writes to it.
   */
  getState(): GameState {
    return this.gameState
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

    // --- Cinematic acceleration + camera choreography (iteration 9).
    this.updateCinematicDrive(dropIntensity)
  }

  /**
   * Drives the iteration-9 "drop moment" gesture: a hysteresis state machine on the
   * drop-intensity envelope that, on entry, ramps the car's forward speed UP (so the car
   * visibly hits the throttle into the emotional peak) and the chase camera's pull-back
   * distance OUT (so it frames the car against the vista), then decays both back to rest
   * on exit. Rising edge fires when dropIntensity first exceeds DROP_ENTER_THRESHOLD;
   * falling edge fires when it drops below DROP_EXIT_THRESHOLD — the gap between the two
   * is the hysteresis band that holds the focus flag stable through brief dips inside a
   * sustained drop. The ramps are frame-rate-independent 1-pole filters (attack vs decay
   * time constants) so the gesture lands smoothly at any frame rate. Writes only the three
   * additive cinematic scalars on game state; never touches physics/lane/beat logic.
   */
  private updateCinematicDrive(dropIntensity: number): void {
    const now = performance.now()
    let dt = this.lastMoodTime < 0 ? 1 / 60 : (now - this.lastMoodTime) / 1000
    this.lastMoodTime = now
    // Guard against tab-throttle / first-frame spikes so the lerp can't overshoot.
    dt = Math.max(0, Math.min(dt, 0.1))

    // Hysteresis state machine: enter on a rising edge above ENTER, exit on a falling
    // edge below EXIT. Between the two thresholds the flag holds its current value, so a
    // momentary dip inside a long drop doesn't flicker the focus off and snap the camera.
    if (!this.dropFocusActive && dropIntensity >= DROP_ENTER_THRESHOLD) {
      this.dropFocusActive = true
      this.gameState.dropTransitionProgress = 0
    } else if (this.dropFocusActive && dropIntensity < DROP_EXIT_THRESHOLD) {
      this.dropFocusActive = false
      this.gameState.dropTransitionProgress = 0
    }
    this.gameState.isFocusedOnDrop = this.dropFocusActive

    // Targets: elevated while focused, resting (1.0) otherwise. The attack uses the fast
    // time constant on the way up and the slower one on the way down for a punchy "throttle
    // hit" followed by a graceful settle — the language of an automotive promo cut.
    const speedTarget = this.dropFocusActive ? DROP_SPEED_MULTIPLIER : 1
    const depthTarget = this.dropFocusActive ? DROP_DEPTH_SCALE : 1
    const tau = this.dropFocusActive ? SPEED_RAMP_TAU_S : SPEED_DECAY_TAU_S
    // Frame-rate-independent 1-pole coefficient: alpha = 1 - e^(-dt/tau).
    const alpha = tau > 1e-4 ? 1 - Math.exp(-dt / tau) : 1

    const car = this.gameState.car
    car.speedMultiplier += (speedTarget - car.speedMultiplier) * alpha
    this.gameState.cameraDepthScale += (depthTarget - this.gameState.cameraDepthScale) * alpha

    // Clamp to the documented safe ranges so no downstream consumer (distance integral,
    // camera distance) can ever be driven out of bounds by accumulated float error.
    car.speedMultiplier = Math.max(0.8, Math.min(1.3, car.speedMultiplier))
    this.gameState.cameraDepthScale = Math.max(0.9, Math.min(1.2, this.gameState.cameraDepthScale))

    // Advance the transition progress timer (informational; renderer phases its own).
    this.gameState.dropTransitionProgress = Math.min(1, this.gameState.dropTransitionProgress + dt * 4)
  }

  setCollisionHandler(handler: (() => void) | null): void {
    this.threeScene.setCollisionCallback(handler)
  }

  private canSteer(): boolean {
    return this.gameState.car.verticalOffset <= 0.05
  }
}

