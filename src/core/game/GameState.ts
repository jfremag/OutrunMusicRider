export interface CarState {
  distance: number
  laneOffsetIndex: -1 | 0 | 1
  laneOffset: number // interpolated x offset
  verticalOffset: number
  // Beat-sync state. `lastBeatTime` is a performance.now() timestamp (ms) recorded
  // when the audio clock crosses a detected beat; `beatStrength` is that beat's
  // normalized 0..1 intensity. The renderer reads these to drive FOV punch + bloom
  // pulses synchronized to the music. Recording wall-clock ms (not audio seconds)
  // lets the renderer compute the envelope phase without knowing the audio time.
  lastBeatTime: number
  beatStrength: number
  // Beat selectivity gate (iteration 6). True only when the most recent beat was a
  // STRONG beat (strength >= BEAT_STRENGTH_THRESHOLD, e.g. kicks/snares). The renderer
  // reads this to fire the flashy transient gestures (FOV punch, bloom pulse, camera
  // shake, beat-indicator glow) ONLY on emotionally significant beats, while weak beats
  // (hi-hats, light percussion) still update lastBeatTime/beatStrength for baseline mood
  // and particle effects. This is the "professional restraint" gate — set by the
  // controller, read-only in the renderer, with zero impact on physics/gameplay.
  beatFires: boolean
  // Mood signals sampled from the MusicMap at the current audio time and smoothed
  // by the controller. `spectralCentroid` (0..1) is perceived brightness and drives
  // the sky hue (cool cyan -> hot magenta), grid emissive, and bloom threshold.
  // `spectralFlux` (0..1) is brightness volatility (mood nuance). `dropIntensity`
  // (0..1) is a decay envelope that spikes to 1 on entering a detected drop and
  // eases back to 0, driving the cinematic FOV push + bloom expansion.
  spectralCentroid: number
  spectralFlux: number
  dropIntensity: number
  // Unified screen-shake envelope (iteration 3). `cameraShakeAmplitude` (0..1) is
  // the target intensity of the camera shake, set by the controller from beat +
  // spectral flux and spiked on collision; `lastShakeTime` is the performance.now()
  // timestamp it was (re)triggered. The renderer phases an ease-out envelope off
  // these, samples a multi-frequency oscillation, and applies a transient,
  // non-destructive position offset so beats punch and chaos jitters the view.
  cameraShakeAmplitude: number
  lastShakeTime: number
  // Treble-transient shimmer gate (iteration 7). The missing music-FREQUENCY signal:
  // beats drive the low/mid punch (FOV, bloom, shake) and centroid drives the slow
  // mood, but the fast high-frequency transients (hi-hats, cymbals, snare sizzle) had
  // no dedicated visual. `trebleFires` is set true for exactly one frame when the audio
  // clock crosses a detected treble peak; `trebleStrength` (0..1) is that peak's
  // normalized intensity. The renderer reads these to spray a tiny cyan/magenta
  // particle shimmer off the hero car — a direct, additive, beat-orthogonal gesture.
  // Set by the controller, read-only in the renderer, zero impact on physics/gameplay.
  trebleFires: boolean
  trebleStrength: number
  // Cinematic acceleration scalar (iteration 9). A smoothed multiplier on the car's
  // forward speed, ramped UP on drop entry (the car "hits the throttle" into the
  // emotional peak) and decayed back to 1.0 on exit. The controller binds the car's
  // targetDistance to `audioTime * BASE_SPEED * speedMultiplier`, so a drop visibly
  // accelerates the car down the track. Default 1.0; clamped to ~[0.8, 1.3]. NOTE:
  // because car distance is the integral of speed, a raw multiplier on `audioTime *
  // speed` would TELEPORT the car when the multiplier changes; the controller instead
  // integrates distance incrementally (see GameController.update) so speed changes are
  // continuous and never desync the car from the audio timeline's overall progress.
  speedMultiplier: number
}

export interface GameState {
  car: CarState
  // Camera choreography depth scalar (iteration 9). A smoothed multiplier on the chase
  // camera's pull-back distance, ramped UP on drop entry (camera pulls back ~1m and the
  // look-ahead widens, framing the car against the scenic vista) and decayed to 1.0 on
  // exit. Default 1.0; clamped to ~[0.9, 1.2]. Read-only in the renderer.
  cameraDepthScale: number
  // Drop-focus state machine flag (iteration 9). True while the cinematic "drop moment"
  // is active (between rising-edge entry and hysteresis-gated exit). The renderer reads
  // the rising edge of this flag to snap camera orbit square and begin the pull-back, and
  // sustains elevated bloom/FOV while it is held. Owned by the controller.
  isFocusedOnDrop: boolean
  // Drop transition lerp timer (iteration 9), 0..1. Advances on drop entry to drive the
  // eased camera-depth / FOV ramp, and is reused on exit for the decay. Owned by the
  // controller; informational for the renderer (the renderer phases its own envelopes).
  dropTransitionProgress: number
  // Live audio-playback clock in SECONDS (iteration 10), mirrored onto game state by
  // GameController.update each frame so read-only consumers (the HUD overlay) can sample
  // the MusicMap (beats, energy/treble bands) against the exact same clock the renderer
  // uses, without reaching into the AudioEngine. -1 until the first frame with audio.
  // Owned by the controller; read-only everywhere else (the HUD never mutates state).
  audioTime: number
}

export const LANE_WIDTH = 2.5

export function initGameState(): GameState {
  return {
    car: {
      distance: 0,
      laneOffsetIndex: 0,
      laneOffset: 0,
      verticalOffset: 0,
      lastBeatTime: -Infinity,
      beatStrength: 0,
      beatFires: false,
      spectralCentroid: 0,
      spectralFlux: 0,
      dropIntensity: 0,
      cameraShakeAmplitude: 0,
      lastShakeTime: -Infinity,
      trebleFires: false,
      trebleStrength: 0,
      speedMultiplier: 1
    },
    cameraDepthScale: 1,
    isFocusedOnDrop: false,
    dropTransitionProgress: 0,
    audioTime: -1
  }
}

export function applyLaneChange(state: GameState, targetLane: -1 | 0 | 1): void {
  // Clamp target lane to valid range
  const clampedLane = Math.max(-1, Math.min(1, targetLane)) as -1 | 0 | 1
  state.car.laneOffsetIndex = clampedLane
  // Lane offset will be interpolated in rendering
}

export function getLaneOffset(laneIndex: -1 | 0 | 1): number {
  return laneIndex * LANE_WIDTH
}

