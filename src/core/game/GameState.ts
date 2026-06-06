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
      beatStrength: 0
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

