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

  // Detect treble spikes using derivative-based RMS
  const treblePeaks: BeatMarker[] = []
  const trebleThreshold = calculateRMSThreshold(trebleRmsValues)

  for (let i = 1; i < trebleRmsValues.length - 1; i++) {
    const prev = trebleRmsValues[i - 1]
    const current = trebleRmsValues[i]
    const next = trebleRmsValues[i + 1]

    if (current > prev && current > next && current > trebleThreshold) {
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

  return {
    duration,
    beats,
    energySamples,
    trebleSamples,
    treblePeaks,
    spectralSamples,
    dropRegions
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

