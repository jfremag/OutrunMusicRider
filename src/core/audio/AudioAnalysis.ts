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

export interface MusicMap {
  duration: number
  beats: BeatMarker[]
  energySamples: EnergySample[]
  trebleSamples: EnergySample[]
  treblePeaks: BeatMarker[]
}

export async function analyzeBuffer(buffer: AudioBuffer): Promise<MusicMap> {
  const duration = buffer.duration
  const sampleRate = buffer.sampleRate
  const channelData = buffer.getChannelData(0) // Use first channel

  const energySamples: EnergySample[] = []
  const trebleSamples: EnergySample[] = []
  const rmsValues: number[] = []
  const trebleRmsValues: number[] = []
  
  // Process audio in chunks (50-100ms windows)
  const hopSize = Math.floor(sampleRate * 0.075) // 75ms windows
  let currentSample = 0
  
  // Process the buffer
  const processChunk = (startSample: number, endSample: number) => {
    const chunk = channelData.slice(startSample, endSample)
    const time = startSample / sampleRate
    
    // Calculate RMS for this chunk
    let sumSquares = 0
    let trebleSumSquares = 0
    for (let i = 0; i < chunk.length; i++) {
      sumSquares += chunk[i] * chunk[i]
      if (i > 0) {
        const diff = chunk[i] - chunk[i - 1]
        trebleSumSquares += diff * diff
      }
    }
    const rms = Math.sqrt(sumSquares / chunk.length)
    const trebleRms = Math.sqrt(trebleSumSquares / Math.max(1, chunk.length - 1))

    rmsValues.push(rms)
    trebleRmsValues.push(trebleRms)
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
  
  for (let i = 1; i < rmsValues.length - 1; i++) {
    const prevRMS = rmsValues[i - 1]
    const currRMS = rmsValues[i]
    const nextRMS = rmsValues[i + 1]
    
    // Local maximum and above threshold
    if (currRMS > prevRMS && currRMS > nextRMS && currRMS > threshold) {
      beats.push({
        time: energySamples[i].time,
        strength: currRMS
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

  return {
    duration,
    beats,
    energySamples,
    trebleSamples,
    treblePeaks
  }
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

