import * as THREE from 'three'
import { BeatMarker, MusicMap, EnergySample, DropRegion } from '../audio/AudioAnalysis'
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
    treblePulses: createTreblePulses(musicMap.treblePeaks, nodes, duration, musicMap.dropRegions),
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
  duration: number,
  dropRegions: DropRegion[]
): TreblePulse[] {
  if (treblePeaks.length === 0 || nodes.length === 0 || duration <= 0) {
    return []
  }

  const maxStrength = Math.max(...treblePeaks.map(peak => peak.strength))

  const lanePattern: Array<-1 | 0 | 1> = [-1, 1, 0]

  // Build one pulse anchored to a track node, honoring the cycling lane pattern.
  const buildPulse = (
    peak: BeatMarker,
    laneIndex: -1 | 0 | 1,
    density: number
  ): TreblePulse => {
    const normalizedTime = Math.max(0, Math.min(1, peak.time / duration))
    const nodeIndex = Math.min(nodes.length - 1, Math.round(normalizedTime * (nodes.length - 1)))
    const node = nodes[nodeIndex]

    const right = new THREE.Vector3().crossVectors(node.forward, node.up).normalize()
    const lateralOffset = laneIndex * LANE_WIDTH
    const normalizedIntensity = maxStrength > 0 ? peak.strength / maxStrength : 0

    const pos = node.pos
      .clone()
      .add(right.clone().multiplyScalar(lateralOffset))
      .add(new THREE.Vector3(0, 0.6 + normalizedIntensity * 1.8, 0))

    return {
      time: peak.time,
      pos,
      intensity: normalizedIntensity,
      laneIndex,
      density
    }
  }

  // Fair, dodgeable placement (distance units; the car travels at 50 u/s). The course must
  // ALWAYS leave at least one escape lane so a smart driver can clear it, while still getting
  // denser through drops. We thin obstacles to a minimum spacing, never let all three lanes
  // be blocked within a short window (an impossible "wall"), and spread lanes so the field
  // stays readable. The PathPlanner then solves the actual smooth racing line through whatever
  // survives — this just guarantees a fair, non-degenerate layout for it to work with.
  const WALL_WINDOW = 8        // all 3 lanes blocked within ±this distance = impossible wall
  const MIN_GAP_BASE = 13      // min distance between ANY two obstacles in calm passages (~0.26s)
  const MIN_GAP_DROP = 8       // tighter spacing tolerated inside drops (denser, still fair)
  const MIN_SAME_LANE_GAP = 15 // min distance between two obstacles sharing a lane

  // Candidate obstacles in distance order, tagged with drop density + a music-cycling lane.
  const candidates = treblePeaks
    .map((peak, index) => {
      const normalizedTime = Math.max(0, Math.min(1, peak.time / duration))
      const nodeIndex = Math.min(nodes.length - 1, Math.round(normalizedTime * (nodes.length - 1)))
      return {
        peak,
        dist: nodes[nodeIndex].pos.z,
        density: dropDensityAt(peak.time, dropRegions),
        natural: lanePattern[index % lanePattern.length]
      }
    })
    .sort((a, b) => a.dist - b.dist)

  const pulses: TreblePulse[] = []
  // Indexed by lane+1 (so lanes -1,0,1 map to 0,1,2): last accepted distance per lane.
  const lastByLane = [-Infinity, -Infinity, -Infinity]
  let lastAny = -Infinity
  const lanes: Array<-1 | 0 | 1> = [-1, 0, 1]

  for (const cand of candidates) {
    const minGap = MIN_GAP_BASE + (MIN_GAP_DROP - MIN_GAP_BASE) * Math.min(1, cand.density)
    // Global thinning: skip obstacles packed tighter than the (drop-aware) minimum spacing.
    if (cand.dist - lastAny < minGap) continue

    // Which lanes are already blocked within the wall window (scan back while in range)?
    const blocked = [false, false, false]
    for (let k = pulses.length - 1; k >= 0; k--) {
      if (cand.dist - pulses[k].pos.z > WALL_WINDOW) break // sorted; everything older is behind
      blocked[pulses[k].laneIndex + 1] = true
    }

    // Choose the most-rested lane that is free in-window, honors the same-lane gap, and does
    // NOT seal the last open lane (which would be an unavoidable wall). The music-cycling
    // natural lane gets a tie-break nudge so the layout still tracks the song.
    let chosen: -1 | 0 | 1 | null = null
    let bestScore = -Infinity
    for (const lane of lanes) {
      if (blocked[lane + 1]) continue
      if (cand.dist - lastByLane[lane + 1] < MIN_SAME_LANE_GAP) continue
      if (lanes.every(l => l === lane || blocked[l + 1])) continue // would wall off all 3 lanes
      const score = cand.dist - lastByLane[lane + 1] + (lane === cand.natural ? 6 : 0)
      if (score > bestScore) {
        bestScore = score
        chosen = lane
      }
    }
    if (chosen === null) continue // no fair lane -> drop this obstacle to keep the course clean

    pulses.push(buildPulse(cand.peak, chosen, cand.density))
    lastByLane[chosen + 1] = cand.dist
    lastAny = cand.dist
  }

  return pulses
}

/**
 * Returns the drop-density envelope at a given time: 0 outside any drop region,
 * rising toward the region's `strength` as you approach its temporal center and
 * fading back toward the edges. This keeps the obstacle-density increase smooth
 * across region boundaries instead of a hard step.
 */
function dropDensityAt(time: number, dropRegions: DropRegion[]): number {
  let best = 0
  for (const region of dropRegions) {
    if (time < region.startTime || time > region.endTime) continue
    const span = Math.max(1e-3, region.endTime - region.startTime)
    const phase = (time - region.startTime) / span // 0..1 across the region
    // Triangular window peaking at the center, scaled by region strength.
    const window = 1 - Math.abs(phase - 0.5) * 2
    const value = region.strength * Math.max(0, window)
    if (value > best) best = value
  }
  return best
}

