export interface CarState {
  distance: number
  laneOffsetIndex: -1 | 0 | 1
  laneOffset: number // interpolated x offset
  verticalOffset: number
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
      verticalOffset: 0
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

