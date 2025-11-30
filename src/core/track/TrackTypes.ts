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
}

export interface TrackData {
  nodes: TrackNode[]
  treblePulses: TreblePulse[]
  length: number
}

