import * as THREE from 'three'

export interface TrackNode {
  t: number        // 0..1 along track
  s: number        // distance in meters
  pos: THREE.Vector3
  forward: THREE.Vector3
  up: THREE.Vector3
  isJump: boolean
}

export interface TreblePulse {
  time: number
  pos: THREE.Vector3
  intensity: number
  laneIndex: -1 | 0 | 1
  // 0..1 mood/drop weighting baked at generation time. Higher inside detected
  // drop regions (denser, heavier obstacles); ~0 in calm intro/verse passages.
  // Lets the renderer scale obstacle visual weight to match the music's energy.
  density: number
}

export interface TrackData {
  nodes: TrackNode[]
  treblePulses: TreblePulse[]
  length: number
}

