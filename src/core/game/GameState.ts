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
}

export interface GameState {
  car: CarState
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
      trebleStrength: 0
    }
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

