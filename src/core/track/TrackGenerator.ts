import * as THREE from 'three'
import { BeatMarker, MusicMap, EnergySample } from '../audio/AudioAnalysis'
import { TrackData, TrackNode, TreblePulse } from './TrackTypes'
import { LANE_WIDTH } from '../game/GameState'

export function generateTrack(musicMap: MusicMap): TrackData {
  const duration = musicMap.duration
  const speed = 50 // units per second
  const totalLength = duration * speed
  const numNodes = Math.max(100, Math.floor(duration * 10)) // ~10 nodes per second, minimum 100
  
  const nodes: TrackNode[] = []
  const baseY = 0
  const amplitude = 6
  const xFrequency = 0.1 // Frequency of horizontal curve
  
  // Smooth RMS values for vertical variation
  const smoothedRMS = smoothRMS(musicMap.energySamples, numNodes)
  
  // Identify strong beats for jumps (every 4th strong beat)
  const strongBeats = musicMap.beats
    .filter(beat => beat.strength > calculateBeatThreshold(musicMap.beats))
    .sort((a, b) => a.time - b.time)
  
  const jumpTimes = new Set<number>()
  for (let i = 3; i < strongBeats.length; i += 4) {
    jumpTimes.add(strongBeats[i].time)
  }
  
  for (let i = 0; i < numNodes; i++) {
    const t = i / (numNodes - 1) // 0 to 1
    const time = t * duration
    const s = t * totalLength
    
    // X: sinusoidal curve
    const x = Math.sin(time * xFrequency) * 2
    
    // Y: base + smoothed RMS * amplitude
    const rmsIndex = Math.floor(t * (smoothedRMS.length - 1))
    const rms = smoothedRMS[rmsIndex] || 0
    const y = baseY + rms * amplitude
    
    // Z: increases with distance
    const z = s
    
    const pos = new THREE.Vector3(x, y, z)
    
    // Calculate forward vector (will be computed after all nodes are created)
    const forward = new THREE.Vector3(0, 0, 1) // placeholder
    const up = new THREE.Vector3(0, 1, 0)
    
    // Check if this is a jump point
    const isJump = jumpTimes.has(time) || 
                   jumpTimes.has(time - 0.1) || 
                   jumpTimes.has(time + 0.1)
    
    nodes.push({
      t,
      s,
      pos,
      forward,
      up,
      isJump
    })
  }
  
  // Calculate forward vectors
  for (let i = 0; i < nodes.length - 1; i++) {
    const current = nodes[i]
    const next = nodes[i + 1]
    const direction = new THREE.Vector3().subVectors(next.pos, current.pos)
    current.forward = direction.normalize()
  }
  
  // Last node forward is same as previous
  if (nodes.length > 1) {
    nodes[nodes.length - 1].forward = nodes[nodes.length - 2].forward.clone()
  }

  return {
    nodes,
    treblePulses: createTreblePulses(musicMap.treblePeaks, nodes, duration),
    length: totalLength
  }
}

function smoothRMS(energySamples: EnergySample[], targetCount: number): number[] {
  if (energySamples.length === 0) {
    return new Array(targetCount).fill(0)
  }
  
  const smoothed: number[] = []
  const duration = energySamples[energySamples.length - 1].time
  
  for (let i = 0; i < targetCount; i++) {
    const t = i / (targetCount - 1)
    const targetTime = t * duration
    
    // Find surrounding samples
    let sum = 0
    let count = 0
    const windowSize = duration / energySamples.length * 2 // 2 sample window
    
    for (const sample of energySamples) {
      const dist = Math.abs(sample.time - targetTime)
      if (dist < windowSize) {
        const weight = 1 - (dist / windowSize)
        sum += sample.rms * weight
        count += weight
      }
    }
    
    smoothed.push(count > 0 ? sum / count : 0)
  }
  
  return smoothed
}

function calculateBeatThreshold(beats: { strength: number }[]): number {
  if (beats.length === 0) return 0

  const strengths = beats.map(b => b.strength).sort((a, b) => a - b)
  const median = strengths[Math.floor(strengths.length / 2)]
  return median * 1.2 // 20% above median
}

function createTreblePulses(
  treblePeaks: BeatMarker[],
  nodes: TrackNode[],
  duration: number
): TreblePulse[] {
  if (treblePeaks.length === 0 || nodes.length === 0 || duration <= 0) {
    return []
  }

  const maxStrength = Math.max(...treblePeaks.map(peak => peak.strength))

  const lanePattern: Array<-1 | 0 | 1> = [-1, 1, 0]

  return treblePeaks.map((peak, index) => {
    const normalizedTime = Math.max(0, Math.min(1, peak.time / duration))
    const nodeIndex = Math.min(nodes.length - 1, Math.round(normalizedTime * (nodes.length - 1)))
    const node = nodes[nodeIndex]

    const right = new THREE.Vector3().crossVectors(node.forward, node.up).normalize()
    const laneIndex = lanePattern[index % lanePattern.length]
    const lateralOffset = laneIndex * LANE_WIDTH
    const normalizedIntensity = maxStrength > 0 ? peak.strength / maxStrength : 0

    const pos = node.pos.clone()
      .add(right.clone().multiplyScalar(lateralOffset))
      .add(new THREE.Vector3(0, 0.6 + normalizedIntensity * 1.8, 0))

    return {
      time: peak.time,
      pos,
      intensity: normalizedIntensity,
      laneIndex
    }
  })
}

