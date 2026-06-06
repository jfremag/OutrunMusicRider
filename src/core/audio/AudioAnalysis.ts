// Meyda is available for future real-time analysis features
// For Phase 1, we do offline buffer analysis with manual RMS calculation

export interface BeatMarker {
  time: number
  strength: number
}

export interface EnergySample {
  time: number
  rms: number
}

/**
 * A per-chunk spectral feature sample. `centroidNorm` approximates the spectral
 * centroid (perceived "brightness") normalized 0..1 across the whole track, and
 * `flux` is the per-chunk rate-of-change of that centroid (also 0..1). Bright,
 * treble-heavy sections (cymbals, leads, risers) push centroidNorm high; warm,
 * bass-heavy or sparse sections sit low. Flux distinguishes smooth/sustained
 * brightness from spiky/chaotic transitions, refining the mood read.
 */
export interface SpectralSample {
  time: number
  centroidNorm: number
  flux: number
}

/**
 * A contiguous span of the track flagged as a "drop": a sustained, high-energy
 * passage confirmed across multiple consecutive frames (so isolated noise spikes
 * are rejected). `strength` (0..1) is the normalized magnitude of the combined
 * RMS + centroid-velocity peak inside the region and drives downstream gestures
 * (obstacle density multiplier, camera FOV push, bloom expansion).
 */
export interface DropRegion {
  startTime: number
  endTime: number
  startIndex: number
  endIndex: number
  strength: number
}

export interface MusicMap {
  duration: number
  beats: BeatMarker[]
  energySamples: EnergySample[]
  trebleSamples: EnergySample[]
  treblePeaks: BeatMarker[]
  spectralSamples: SpectralSample[]
  dropRegions: DropRegion[]
  // Global tempo locked ONCE offline (onset-envelope autocorrelation), so the HUD shows a
  // steady BPM and consumers can phase a clean beat grid instead of a real-time estimate
  // that rattles between tempo octaves. 0 when undetectable (sparse/ambient material).
  // `beatPhase` (seconds) is the grid offset of the first beat: beat k = beatPhase + k·60/bpm.
  bpm: number
  beatPhase: number
}

export async function analyzeBuffer(buffer: AudioBuffer): Promise<MusicMap> {
  const duration = buffer.duration
  const sampleRate = buffer.sampleRate
  const channelData = buffer.getChannelData(0) // Use first channel

  const energySamples: EnergySample[] = []
  const trebleSamples: EnergySample[] = []
  const rmsValues: number[] = []
  const trebleRmsValues: number[] = []
  // Raw (un-normalized) spectral-centroid estimate per chunk, normalized in a
  // second pass once we know the track-wide min/max.
  const rawCentroids: number[] = []
  const sampleTimes: number[] = []

  // Process audio in chunks (50-100ms windows)
  const hopSize = Math.floor(sampleRate * 0.075) // 75ms windows
  let currentSample = 0

  // FFT-free spectral-centroid approximation. We split each chunk's energy into
  // three pseudo-bands using cascaded first differences: the raw signal carries
  // mostly low-frequency energy, one difference emphasizes mids, a second
  // difference emphasizes highs. The centroid is the energy-weighted mean of the
  // three band-center "frequencies" (arbitrary but monotonic units). This tracks
  // perceived brightness without a real FFT, matching the codebase's hand-rolled
  // DSP style. Band centers are weights, not Hz; only their ratio matters.
  const BAND_CENTER_LOW = 1
  const BAND_CENTER_MID = 4
  const BAND_CENTER_HIGH = 9

  // Process the buffer
  const processChunk = (startSample: number, endSample: number) => {
    const chunk = channelData.slice(startSample, endSample)
    const time = startSample / sampleRate

    // Calculate RMS for this chunk + band energies for the spectral centroid.
    let sumSquares = 0
    let trebleSumSquares = 0 // first-difference energy (mids/highs)
    let secondDiffSumSquares = 0 // second-difference energy (highs)
    let prev = chunk.length > 0 ? chunk[0] : 0
    let prevDiff = 0
    for (let i = 0; i < chunk.length; i++) {
      const s = chunk[i]
      sumSquares += s * s
      if (i > 0) {
        const diff = s - prev
        trebleSumSquares += diff * diff
        if (i > 1) {
          const diff2 = diff - prevDiff
          secondDiffSumSquares += diff2 * diff2
        }
        prevDiff = diff
      }
      prev = s
    }
    const rms = Math.sqrt(sumSquares / chunk.length)
    const trebleRms = Math.sqrt(trebleSumSquares / Math.max(1, chunk.length - 1))

    // Low band = total energy minus the higher-difference energies (clamped >= 0),
    // mid band = first-difference minus second-difference, high band = second diff.
    const highBand = secondDiffSumSquares / Math.max(1, chunk.length - 2)
    const midBand = Math.max(0, trebleSumSquares / Math.max(1, chunk.length - 1) - highBand)
    const lowBand = Math.max(0, sumSquares / chunk.length - midBand - highBand)
    const bandTotal = lowBand + midBand + highBand
    const centroid =
      bandTotal > 1e-9
        ? (lowBand * BAND_CENTER_LOW + midBand * BAND_CENTER_MID + highBand * BAND_CENTER_HIGH) /
          bandTotal
        : BAND_CENTER_LOW

    rmsValues.push(rms)
    trebleRmsValues.push(trebleRms)
    rawCentroids.push(centroid)
    sampleTimes.push(time)
    energySamples.push({
      time,
      rms
    })
    trebleSamples.push({
      time,
      rms: trebleRms
    })
  }

  // Process entire buffer in chunks
  while (currentSample < channelData.length) {
    const endSample = Math.min(currentSample + hopSize, channelData.length)
    processChunk(currentSample, endSample)
    currentSample = endSample
  }
  
  // Detect beats by finding local maxima in RMS
  const beats: BeatMarker[] = []
  const threshold = calculateRMSThreshold(rmsValues)
  const maxRMS = rmsValues.reduce((max, v) => Math.max(max, v), 0) || 1

  for (let i = 1; i < rmsValues.length - 1; i++) {
    const prevRMS = rmsValues[i - 1]
    const currRMS = rmsValues[i]
    const nextRMS = rmsValues[i + 1]

    // Local maximum and above threshold
    if (currRMS > prevRMS && currRMS > nextRMS && currRMS > threshold) {
      beats.push({
        time: energySamples[i].time,
        // Normalize to 0..1 so downstream visuals (bloom, FOV punch) get a
        // predictable intensity regardless of the track's absolute loudness.
        strength: Math.min(1, currRMS / maxRMS)
      })
    }
  }

  // Detect treble spikes (hi-hats / cymbals / snare sizzle) as local maxima of the
  // derivative-RMS envelope, using a LOCAL adaptive threshold (moving mean + k·std over a
  // ~3s window) instead of one global threshold. This spreads detections EVENLY across the
  // whole song: a loud, busy intro no longer hogs all the peaks (its high local mean culls
  // the weak ones) and a calmer later passage still yields peaks relative to its own level
  // — fixing the old "a ridiculous amount of swords up front, then almost none" problem. A
  // global floor still suppresses detections in genuine near-silence so obstacles never
  // spawn where there is no treble content at all.
  const treblePeaks: BeatMarker[] = []
  const trebleN = trebleRmsValues.length
  const trebleGlobalMean =
    trebleN > 0 ? trebleRmsValues.reduce((a, b) => a + b, 0) / trebleN : 0
  const LOCAL_HALF = 40 // ~3s half-window at the 75ms hop
  const LOCAL_K = 0.6 // sensitivity: a peak must exceed localMean + K·localStd

  for (let i = 1; i < trebleN - 1; i++) {
    const prev = trebleRmsValues[i - 1]
    const current = trebleRmsValues[i]
    const next = trebleRmsValues[i + 1]
    if (!(current > prev && current > next)) continue

    // Local window statistics (clamped at the track edges).
    const lo = Math.max(0, i - LOCAL_HALF)
    const hi = Math.min(trebleN - 1, i + LOCAL_HALF)
    const count = hi - lo + 1
    let sum = 0
    for (let k = lo; k <= hi; k++) sum += trebleRmsValues[k]
    const localMean = sum / count
    let varSum = 0
    for (let k = lo; k <= hi; k++) {
      const d = trebleRmsValues[k] - localMean
      varSum += d * d
    }
    const localStd = Math.sqrt(varSum / count)
    const localThreshold = localMean + LOCAL_K * localStd

    if (current > localThreshold && current > trebleGlobalMean * 0.6) {
      treblePeaks.push({
        time: trebleSamples[i].time,
        strength: current
      })
    }
  }

  // --- Spectral features (centroid + flux), normalized 0..1 across the track.
  const spectralSamples = buildSpectralSamples(rawCentroids, sampleTimes)

  // --- Drop regions: sustained high-energy passages confirmed over several frames.
  const dropRegions = detectDropRegions(rmsValues, spectralSamples, sampleTimes)

  // --- Global tempo + grid phase, locked once offline (steady BPM, no octave rattle).
  const tempo = detectTempo(channelData, sampleRate)

  return {
    duration,
    beats,
    energySamples,
    trebleSamples,
    treblePeaks,
    spectralSamples,
    dropRegions,
    bpm: tempo.bpm,
    beatPhase: tempo.beatPhase
  }
}

/**
 * Normalizes the raw per-chunk centroid estimates to 0..1 across the whole track
 * (so "bright" is relative to this song, not an absolute scale) and computes the
 * spectral flux as the absolute frame-to-frame change of the normalized centroid.
 * Flux is itself normalized 0..1 against its own track-wide max so it stays a
 * predictable mood-nuance signal for downstream visuals.
 */
function buildSpectralSamples(rawCentroids: number[], sampleTimes: number[]): SpectralSample[] {
  const n = rawCentroids.length
  if (n === 0) return []

  // Percentile-based normalization. Real music's centroid is heavily bass-skewed,
  // so absolute min/max normalization pins almost every frame near 0 (a handful of
  // bright transients claim the whole top of the range). Mapping the 5th->95th
  // percentile to 0..1 instead gives a centroid that actually moves with the music.
  const sorted = [...rawCentroids].sort((a, b) => a - b)
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]
  const loC = pct(0.05)
  const hiC = pct(0.95)
  const range = hiC - loC
  // Mild gamma lifts the bass-dominated low values into a perceptually useful
  // mid-range so brightness reads as a real mood axis rather than hugging zero.
  const GAMMA = 0.6
  const norm = (c: number) => {
    const linear = range > 1e-9 ? Math.min(1, Math.max(0, (c - loC) / range)) : 0
    return Math.pow(linear, GAMMA)
  }

  // First pass: normalized centroid + raw flux magnitude.
  const centroidNorms: number[] = new Array(n)
  const rawFlux: number[] = new Array(n)
  let maxFlux = 0
  for (let i = 0; i < n; i++) {
    centroidNorms[i] = norm(rawCentroids[i])
    const f = i > 0 ? Math.abs(centroidNorms[i] - centroidNorms[i - 1]) : 0
    rawFlux[i] = f
    if (f > maxFlux) maxFlux = f
  }

  const samples: SpectralSample[] = new Array(n)
  for (let i = 0; i < n; i++) {
    samples[i] = {
      time: sampleTimes[i],
      centroidNorm: centroidNorms[i],
      flux: maxFlux > 1e-9 ? rawFlux[i] / maxFlux : 0
    }
  }
  return samples
}

/**
 * Detects "drops" — sustained, high-energy passages — from the RMS loudness
 * envelope. Musically, a drop is fundamentally a section that gets and STAYS loud
 * (the bass/kick slams in), so energy is the primary, most-robust signal; the
 * spectral centroid is heavily bass-skewed and only used to *boost* a drop's
 * strength, never to gate entry (which previously rejected every drop).
 *
 * Pipeline:
 *  1. Smooth the per-frame RMS into a short envelope so single-frame transients
 *     don't trigger and momentary dips inside a sustained section don't fragment it.
 *  2. Gate the envelope above an adaptive threshold (mean + k·std).
 *  3. Require a CONFIRM-frame run above the gate (multi-frame confirmation rejects
 *     isolated spikes), with a small hysteresis gap so brief dips bridge.
 *  4. strength = peak RMS in the region (0..1) blended with that region's mean
 *     brightness, so brighter drops read hotter downstream.
 */
function detectDropRegions(
  rmsValues: number[],
  spectralSamples: SpectralSample[],
  sampleTimes: number[]
): DropRegion[] {
  const n = rmsValues.length
  if (n < 8 || spectralSamples.length !== n) return []

  // 1. Smooth RMS into a loudness envelope (centered moving average, ~5 frames).
  const env: number[] = new Array(n)
  const half = 2
  for (let i = 0; i < n; i++) {
    let sum = 0
    let count = 0
    for (let k = i - half; k <= i + half; k++) {
      if (k >= 0 && k < n) {
        sum += rmsValues[k]
        count++
      }
    }
    env[i] = sum / count
  }

  // 2. Adaptive gate on the envelope: clearly above the track's typical loudness.
  const mean = env.reduce((a, b) => a + b, 0) / n
  const variance = env.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n
  const std = Math.sqrt(variance)
  const enterGate = mean + 0.6 * std // enter a drop above this
  const exitGate = mean + 0.35 * std // stay in until we fall below this (hysteresis)
  const maxRms = rmsValues.reduce((m, v) => Math.max(m, v), 0) || 1

  const CONFIRM = 4 // frames above enterGate required to confirm a drop
  const MAX_GAP = 6 // frames below exitGate tolerated before ending a region (~0.45s)
  const MIN_LEN = 4 // discard regions shorter than this after merging

  const regions: DropRegion[] = []
  let i = 0
  while (i < n) {
    // Find the start of a confirmed loud run: CONFIRM consecutive frames > enterGate.
    if (env[i] <= enterGate) {
      i++
      continue
    }
    let run = 0
    let j = i
    while (j < n && env[j] > enterGate) {
      run++
      j++
    }
    if (run < CONFIRM) {
      i = j
      continue
    }

    // Confirmed. Extend the region forward while we stay above exitGate, allowing
    // short gaps (MAX_GAP frames below) to bridge dips inside the same drop.
    let end = j - 1
    let gap = 0
    let k = j
    while (k < n) {
      if (env[k] > exitGate) {
        end = k
        gap = 0
      } else {
        gap++
        if (gap > MAX_GAP) break
      }
      k++
    }

    const start = i
    if (end - start + 1 >= MIN_LEN) {
      // strength: peak loudness (normalized) blended with mean brightness in-region.
      let peakRms = 0
      let centroidSum = 0
      for (let m = start; m <= end; m++) {
        if (rmsValues[m] > peakRms) peakRms = rmsValues[m]
        centroidSum += spectralSamples[m].centroidNorm
      }
      const meanCentroid = centroidSum / (end - start + 1)
      const strength = Math.min(1, 0.75 * (peakRms / maxRms) + 0.25 * meanCentroid)
      regions.push({
        startTime: sampleTimes[start],
        endTime: sampleTimes[end],
        startIndex: start,
        endIndex: end,
        strength
      })
    }

    i = Math.max(k, end + 1)
  }

  // Merge regions separated by only a short quiet gap into one sustained drop. A
  // dense run of beat-clusters reads more cinematically as a single energized
  // passage (sustained FOV push + warm sky) than as rapid on/off flicker.
  const MERGE_GAP_S = 1.5
  const merged: DropRegion[] = []
  for (const region of regions) {
    const last = merged[merged.length - 1]
    if (last && region.startTime - last.endTime <= MERGE_GAP_S) {
      last.endTime = region.endTime
      last.endIndex = region.endIndex
      last.strength = Math.max(last.strength, region.strength)
    } else {
      merged.push({ ...region })
    }
  }

  return merged
}

function calculateRMSThreshold(rmsValues: number[]): number {
  if (rmsValues.length === 0) return 0
  
  // Calculate mean and standard deviation
  const mean = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length
  const variance = rmsValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / rmsValues.length
  const stdDev = Math.sqrt(variance)
  
  // Threshold is mean + 0.5 * stdDev
  return mean + 0.5 * stdDev
}

/**
 * Estimates a single, STABLE global tempo (BPM) and beat-grid phase from the raw PCM,
 * computed once offline at load. Method: build a half-wave-rectified onset-strength
 * envelope (the positive frame-to-frame rise of short-window energy), autocorrelate it
 * across the lag range for ~70-180 BPM, and pick the strongest periodicity. The
 * autocorrelation is normalized by overlap length (so it doesn't bias toward short lags)
 * and shaped by a gentle log-normal tempo prior around 120 BPM to resolve the half/double
 * octave ambiguity. A parabolic fit around the peak gives sub-bin precision, and a comb
 * search recovers the grid phase (offset of the first beat, in seconds). Returns {0,0}
 * when the track is too short or has no detectable pulse, so the HUD can fall back to its
 * rolling estimate. This is what stops the BPM readout from "jumping like a rattled animal".
 */
function detectTempo(channelData: Float32Array, sampleRate: number): { bpm: number; beatPhase: number } {
  const hop = 512
  const numFrames = Math.floor(channelData.length / hop)
  if (numFrames < 32) return { bpm: 0, beatPhase: 0 }
  const fsEnv = sampleRate / hop // onset-envelope sample rate (Hz)

  // 1. Short-window energy envelope (RMS per non-overlapping hop).
  const env = new Float32Array(numFrames)
  for (let f = 0; f < numFrames; f++) {
    let sum = 0
    const start = f * hop
    for (let i = 0; i < hop; i++) {
      const s = channelData[start + i]
      sum += s * s
    }
    env[f] = Math.sqrt(sum / hop)
  }

  // 2. Onset strength = half-wave-rectified first difference, then mean-subtracted and
  // re-rectified so only above-average accents drive the autocorrelation.
  const onset = new Float32Array(numFrames)
  let onsetMean = 0
  for (let f = 1; f < numFrames; f++) {
    const d = env[f] - env[f - 1]
    onset[f] = d > 0 ? d : 0
    onsetMean += onset[f]
  }
  onsetMean /= numFrames
  for (let f = 0; f < numFrames; f++) {
    const v = onset[f] - onsetMean
    onset[f] = v > 0 ? v : 0
  }

  // 3. Normalized autocorrelation across the tempo lag range, shaped by a tempo prior.
  const MIN_BPM = 70
  const MAX_BPM = 180
  const PREFERRED_BPM = 120
  const minLag = Math.max(2, Math.floor((fsEnv * 60) / MAX_BPM))
  const maxLag = Math.min(numFrames - 2, Math.ceil((fsEnv * 60) / MIN_BPM))
  const acAt = (lag: number): number => {
    let s = 0
    for (let f = lag; f < numFrames; f++) s += onset[f] * onset[f - lag]
    return s / (numFrames - lag) // normalize by overlap so different lags compare fairly
  }
  let bestLag = -1
  let bestScore = -Infinity
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fsEnv) / lag
    const ln = Math.log(bpm / PREFERRED_BPM) / 0.65
    const prior = Math.exp(-0.5 * ln * ln)
    const score = acAt(lag) * (0.7 + 0.3 * prior)
    if (score > bestScore) {
      bestScore = score
      bestLag = lag
    }
  }
  if (bestLag < 0 || bestScore <= 0) return { bpm: 0, beatPhase: 0 }

  // 4. Parabolic interpolation around the peak for sub-bin lag precision.
  let refinedLag = bestLag
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = acAt(bestLag - 1)
    const y1 = acAt(bestLag)
    const y2 = acAt(bestLag + 1)
    const denom = y0 - 2 * y1 + y2
    if (Math.abs(denom) > 1e-12) {
      const delta = (0.5 * (y0 - y2)) / denom
      if (delta > -1 && delta < 1) refinedLag = bestLag + delta
    }
  }

  // 5. Comb-filter phase search: the grid offset (frames) whose beat comb best aligns with
  // the onset accents. Converted to seconds for a clean beat clock downstream.
  const period = refinedLag
  const searchEnd = Math.min(numFrames, Math.ceil(period))
  let bestOffset = 0
  let bestComb = -Infinity
  for (let off = 0; off < searchEnd; off++) {
    let comb = 0
    for (let p = off; p < numFrames; p += period) comb += onset[Math.round(p)]
    if (comb > bestComb) {
      bestComb = comb
      bestOffset = off
    }
  }

  const bpm = Math.round(((60 * fsEnv) / refinedLag) * 10) / 10
  const beatPhase = bestOffset / fsEnv
  return { bpm, beatPhase }
}

