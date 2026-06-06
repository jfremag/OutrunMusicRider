import { TrackData } from '../track/TrackTypes'

/**
 * PathPlanner — the car's "brain". It solves a single, globally-optimal self-driving racing
 * line offline (once, at track load) so the car behaves like a professional driver who has
 * already walked the course: it anticipates obstacles and vacates a threatened lane EARLY,
 * commits to whichever lane stays clear longest through a cluster (rather than darting into a
 * lane that's blocked just downstream), and never needs to steer mid-air.
 *
 * Model: a dynamic program over a lane × distance grid.
 *   • State  = (lane ∈ {-1,0,1}, recentlyChanged ∈ {0,1}). The recent flag enforces a one-cell
 *     cooldown after a lane change, so changes are ≥2 cells (~0.32s) apart — matching the car's
 *     real lateral speed and producing deliberate, non-twitchy moves.
 *   • Cost   = hard collision cost (sharing a cell with an obstacle) + a soft "lead" penalty for
 *     sitting in a lane with an obstacle just ahead (this is what makes the car leave EARLY) +
 *     a per-change cost (keeps the line smooth and committed).
 *   • Rules  = at most one lane-step per cell; no lane change while airborne (the planner must
 *     already be in a safe lane before each jump); holding a lane is always allowed.
 * The DP is globally optimal, so the resulting line minimizes total collisions + effort over the
 * WHOLE song — which is exactly why it reads as intelligent rather than reactive. When a cluster
 * is genuinely unavoidable (no lane stays clear long enough given the car's turn rate), it eats
 * the single least-bad graze instead of flailing.
 */
export interface RacingLine {
  /** Planning cell size in track units. */
  step: number
  /** Target lane per cell, value in {-1,0,1}; cell c covers [c*step, (c+1)*step). */
  lanes: Int8Array
  /** Target lane the car should hold at a given track distance (units). */
  laneAt(distance: number): -1 | 0 | 1
}

// --- Planner tuning (distance units; the car travels at ~50 u/s). ---
const STEP = 8 // planning cell (~0.16s); a lane change resolves over >=2 cells (cooldown)
const FOOT = 3 // obstacle half-footprint that counts as a hard collision
const LEAD = 26 // how far ahead the car starts vacating an obstacle's lane (~0.5s of warning)
const COLLISION_COST = 1000 // hard cost for sharing a cell with an obstacle (avoid at all costs)
const LEAD_COST = 4 // soft per-cell cost for sitting in a lane with an obstacle just ahead
const CHANGE_COST = 3 // cost per lane change (favours smooth, committed driving)
const AIR_PRE = 8 // airborne window starts this far before a jump node (launch lead-in)
const AIR_DIST = 58 // airborne window length after launch (~1.15s of hang time at 50 u/s)

/**
 * Solves the racing line for a track. Pure and deterministic (no randomness), so a given
 * track always yields the same line. Cost is O(cells × states × lanes) — trivial even for a
 * long song (a few thousand cells).
 */
export function planRacingLine(track: TrackData): RacingLine {
  const numCells = Math.max(1, Math.ceil(track.length / STEP) + 1)

  // --- Hard occupancy + soft lead penalty, per lane (indexed lane+1 -> 0..2) per cell.
  const hard: Uint8Array[] = [
    new Uint8Array(numCells),
    new Uint8Array(numCells),
    new Uint8Array(numCells)
  ]
  const lead: Float32Array[] = [
    new Float32Array(numCells),
    new Float32Array(numCells),
    new Float32Array(numCells)
  ]
  for (const pulse of track.treblePulses) {
    const laneIdx = pulse.laneIndex + 1
    const d = pulse.pos.z
    // Hard footprint: cells within FOOT of the obstacle are a collision in that lane.
    const c0 = Math.max(0, Math.floor((d - FOOT) / STEP))
    const c1 = Math.min(numCells - 1, Math.floor((d + FOOT) / STEP))
    for (let c = c0; c <= c1; c++) hard[laneIdx][c] = 1
    // Soft lead: the cells just BEFORE the obstacle (in its lane) get a discouraging cost so
    // the DP prefers to have already vacated this lane by the time the obstacle arrives.
    const l0 = Math.max(0, Math.floor((d - LEAD) / STEP))
    const l1 = Math.min(numCells - 1, Math.floor((d - FOOT) / STEP) - 1)
    for (let c = l0; c <= l1; c++) lead[laneIdx][c] += LEAD_COST
  }

  // --- Airborne cells: lane changes are forbidden while jumping (the car can't steer in
  // mid-air), so the planner must already be in a safe lane before each jump launches.
  const air = new Uint8Array(numCells)
  for (const node of track.nodes) {
    if (!node.isJump) continue
    const a0 = Math.max(0, Math.floor((node.s - AIR_PRE) / STEP))
    const a1 = Math.min(numCells - 1, Math.floor((node.s + AIR_DIST) / STEP))
    for (let c = a0; c <= a1; c++) air[c] = 1
  }

  // --- DP. State index = lane(0..2)*2 + recent(0/1).
  const INF = Infinity
  const S = 6
  const stateIdx = (lane: number, recent: number) => lane * 2 + recent
  const cellCost = (c: number, lane: number) => (hard[lane][c] ? COLLISION_COST : 0) + lead[lane][c]

  const cost = new Float32Array(numCells * S).fill(INF)
  const back = new Int8Array(numCells * S).fill(-1)
  // The car starts centered (lane 0 -> laneIdx 1), with no recent change.
  cost[0 * S + stateIdx(1, 0)] = cellCost(0, 1)

  for (let c = 0; c < numCells - 1; c++) {
    const blockChange = air[c] === 1 || air[c + 1] === 1
    for (let s = 0; s < S; s++) {
      const cur = cost[c * S + s]
      if (cur === INF) continue
      const lane = Math.floor(s / 2)
      const recent = s % 2
      for (let nl = 0; nl < 3; nl++) {
        const diff = nl - lane
        const adiff = diff < 0 ? -diff : diff
        if (adiff > 1) continue // at most one lane-step per cell
        let nrecent = 0
        let stepCost = 0
        if (adiff === 1) {
          if (recent === 1) continue // cooldown: no two changes back-to-back
          if (blockChange) continue // can't steer mid-air
          stepCost = CHANGE_COST
          nrecent = 1
        }
        const ns = stateIdx(nl, nrecent)
        const cand = cur + stepCost + cellCost(c + 1, nl)
        if (cand < cost[(c + 1) * S + ns]) {
          cost[(c + 1) * S + ns] = cand
          back[(c + 1) * S + ns] = s
        }
      }
    }
  }

  // --- Pick the cheapest end state and backtrack the lane held in each cell.
  let bestS = stateIdx(1, 0)
  let bestCost = INF
  for (let s = 0; s < S; s++) {
    const v = cost[(numCells - 1) * S + s]
    if (v < bestCost) {
      bestCost = v
      bestS = s
    }
  }
  const lanes = new Int8Array(numCells)
  let s = bestS
  for (let c = numCells - 1; c >= 0; c--) {
    lanes[c] = Math.floor(s / 2) - 1 // back to {-1,0,1}
    const prev = back[c * S + s]
    if (prev < 0) break // reached the start cell
    s = prev
  }

  return {
    step: STEP,
    lanes,
    laneAt(distance: number): -1 | 0 | 1 {
      const c = Math.max(0, Math.min(numCells - 1, Math.floor(distance / STEP)))
      return lanes[c] as -1 | 0 | 1
    }
  }
}
