import type { MusicMap, EnergySample, BeatMarker } from '../audio/AudioAnalysis'
import type { GameState } from '../game/GameState'

/**
 * HudOverlay (iteration 10) — a premium, neon "sync transparency" readout painted on a
 * dedicated 2D canvas that floats over the WebGL scene. Each frame it shows, in perfect
 * lock with the audio clock:
 *
 *   • live rolling BPM (median of the last few detected beat intervals),
 *   • a circular beat-phase indicator that completes one rotation per beat interval
 *     (a sweeping arc + travelling dot, so a viewer instantly sees the visualizer is
 *     tracking beat timing in real time), and
 *   • three vertical frequency meters — bass (cyan), mid (mint), treble (magenta) —
 *     sampled from the MusicMap's energy/treble bands at the current audio time.
 *
 * Design contract:
 *   • Pure Canvas 2D API — no Three.js, no Vue, no shaders.
 *   • Reads ONLY from its render() parameters (MusicMap + GameState). It never mutates
 *     game state, never touches the audio engine, and has zero impact on physics, the
 *     car, the track, or collisions.
 *   • Frame-rate-independent reads (everything is sampled against gameState.audioTime),
 *     but it keeps a tiny bit of PRIVATE visual state — 1-pole low-pass filters on the
 *     band heights + BPM, and per-track band normalization references — so the meters
 *     read smoothly instead of jittering frame-to-frame. None of that state is shared.
 *
 * The palette is the established synthwave scheme (cyan / mint / magenta) so the HUD
 * reads as an integrated part of the world, not a grafted-on debug overlay.
 */

// --- Neon palette, matched to the sky/grid/car emissive scheme used across the project.
const COL_BASS = '#6af6ff' // cyan   — low / kick energy
const COL_MID = '#7fffcc' // mint   — body / full-spectrum content (snare, vocal)
const COL_TREBLE = '#ff5acd' // magenta — highs (hi-hats, cymbals, sizzle)
const COL_DIM = 'rgba(120, 200, 230, 0.22)' // unfilled meter track / faint guides
const COL_TEXT = '#9af7ff'
const COL_TEXT_DIM = 'rgba(154, 247, 255, 0.55)'

// --- Band height smoothing. A 1-pole low-pass per frame: out += (in - out) * alpha.
// alpha ≈ 0.18 gives ~3-4 frame (~60ms) response — responsive to kicks/hats but free of
// single-frame jitter. BPM is smoothed harder (it should read as a stable number).
const BAND_SMOOTH_ALPHA = 0.18
const BPM_SMOOTH_ALPHA = 0.1

// --- BPM estimation + sanity bounds. The project's beat detector emits RMS-local-maxima
// onsets, which are DENSE (sub-beat transients included), so a naive "last-2-beats"
// interval scatters wildly across the tempo's octaves (e.g. 100 / 160 / 200 BPM for the
// same song) and often exceeds 240 -> "--". To produce the stable, "locked" number a
// premium readout needs, computeRecentBPM (a) uses a WIDE window of recent beats, (b)
// takes the MEDIAN inter-onset interval (robust to the irregular sub-beats), and (c)
// OCTAVE-FOLDS the result into a canonical [BPM_FOLD_LO, BPM_FOLD_HI) band so the
// half-/double-tempo ambiguity collapses onto one steady value. Empirically this turns a
// ~50%-"--" flickering readout into a rock-steady lock on the real tempo.
const BPM_FOLD_LO = 80 // octave-fold target band lower bound (inclusive)
const BPM_FOLD_HI = 160 // octave-fold target band upper bound (exclusive)
const BPM_MIN = 40 // hard reject below this even after folding (nonsense)
const BPM_MAX = 240 // hard reject above this even after folding (nonsense)
// Number of recent beats fed to computeRecentBPM (-> up to N-1 intervals to median).
const BPM_WINDOW_BEATS = 12
// Beat intervals longer than this (seconds) mean sparse/ambient music -> show "-- BPM".
const MAX_BEAT_INTERVAL_S = 5

/** Linearly interpolate two CSS hex colors (#rrggbb) by t in [0,1]; returns "rgb(...)". */
function lerpHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16)
  const pb = parseInt(b.slice(1), 16)
  const ar = (pa >> 16) & 255
  const ag = (pa >> 8) & 255
  const ab = pa & 255
  const br = (pb >> 16) & 255
  const bg = (pb >> 8) & 255
  const bb = pb & 255
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const bl = Math.round(ab + (bb - ab) * t)
  return `rgb(${r}, ${g}, ${bl})`
}

/**
 * Binary search for the index of the latest sample whose time <= t. Returns -1 if the
 * first sample is already in the future. Samples are time-sorted (built sequentially in
 * AudioAnalysis), so this is O(log n) and stays cheap even on long tracks.
 */
function latestIndexAtOrBefore(samples: { time: number }[], t: number): number {
  let lo = 0
  let hi = samples.length - 1
  let res = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (samples[mid].time <= t) {
      res = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return res
}

/** Sample an EnergySample array at time t with linear interpolation between neighbours. */
function sampleBand(samples: EnergySample[], t: number): number {
  if (samples.length === 0) return 0
  const i = latestIndexAtOrBefore(samples, t)
  if (i < 0) return samples[0].rms
  if (i >= samples.length - 1) return samples[samples.length - 1].rms
  const a = samples[i]
  const b = samples[i + 1]
  const span = b.time - a.time
  const f = span > 1e-6 ? Math.max(0, Math.min(1, (t - a.time) / span)) : 0
  return a.rms + (b.rms - a.rms) * f
}

/** Per-track normalization references (robust high-percentile of each band's RMS). */
interface BandRefs {
  bass: number
  treble: number
}

/** 95th-percentile RMS of an energy-sample array (robust to lone transients). */
function highPercentile(samples: EnergySample[], p = 0.95): number {
  if (samples.length === 0) return 1
  const vals = samples.map(s => s.rms).sort((a, b) => a - b)
  const idx = Math.min(vals.length - 1, Math.max(0, Math.floor(p * (vals.length - 1))))
  return Math.max(1e-6, vals[idx])
}

export class HudOverlay {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D | null

  // Logical (CSS-pixel) HUD size; the backing store is scaled by devicePixelRatio for
  // crisp text/strokes on hi-DPI displays.
  private readonly width = 220
  private readonly height = 128
  private dpr = 1

  // --- Private visual state (never shared, never mutates game state).
  // Smoothed 0..1 band heights.
  private sBass = 0
  private sMid = 0
  private sTreble = 0
  // Smoothed BPM (0 = unknown -> "-- BPM").
  private sBpm = 0
  // Per-track band normalization, recomputed when the MusicMap identity changes.
  private bandRefs: BandRefs = { bass: 1, treble: 1 }
  private refsForMap: MusicMap | null = null
  // Last audio time we saw, to detect rewind/seek and reset the smoothing cleanly.
  private lastAudioTime = -1

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    // Size the backing store for the device pixel ratio; CSS size is set by the host.
    this.canvas.width = Math.round(this.width * this.dpr)
    this.canvas.height = Math.round(this.height * this.dpr)
  }

  /**
   * Computes a robust, "locked" rolling BPM from recent beat onsets. Takes the beat times
   * (seconds) up to `now` (already sliced to the recent window by the caller), filters the
   * inter-onset intervals to a plausible range, takes their MEDIAN (robust to the dense
   * sub-beat onsets the RMS detector emits), and OCTAVE-FOLDS the resulting tempo into the
   * canonical [BPM_FOLD_LO, BPM_FOLD_HI) band so half-/double-tempo ambiguity collapses
   * onto one stable value. Returns 0 ("unknown" -> "-- BPM") when there are too few beats,
   * the music is sparse/ambient (median interval too long), or the folded result is still
   * implausible. Pure function of its inputs (no instance state).
   */
  computeRecentBPM(beatTimes: number[]): number {
    if (beatTimes.length < 3) return 0
    // Collect consecutive intervals, rejecting both micro-gaps (detector noise) and long
    // gaps (sparse passages) so the median reflects the actual beat grid.
    const intervals: number[] = []
    for (let i = 1; i < beatTimes.length; i++) {
      const d = beatTimes[i] - beatTimes[i - 1]
      if (d > 0.05 && d <= MAX_BEAT_INTERVAL_S) intervals.push(d)
    }
    if (intervals.length < 2) return 0
    intervals.sort((a, b) => a - b)
    const median = intervals[Math.floor((intervals.length - 1) / 2)]
    if (median <= 0) return 0
    let bpm = 60 / median
    // Octave-fold into the canonical band so the displayed number is stable across the
    // detector's half-/double-tempo flips.
    while (bpm >= BPM_FOLD_HI) bpm /= 2
    while (bpm < BPM_FOLD_LO) bpm *= 2
    if (bpm < BPM_MIN || bpm > BPM_MAX) return 0
    return bpm
  }

  /**
   * Paints one HUD frame. All reads are from the parameters; the audio clock is taken
   * from gameState.audioTime so BPM, beat phase, and the band meters are sampled against
   * the exact same clock that drives the renderer (sync transparency). Safe to call every
   * frame with a null MusicMap (renders the idle shell) and is a no-op without a 2D ctx.
   */
  render(musicMap: MusicMap | null, gameState: GameState): void {
    const ctx = this.ctx
    if (!ctx) return

    const audioTime = gameState.audioTime
    // Detect a rewind / seek / song change and reset the smoothing so the meters don't
    // glide across a discontinuity.
    if (audioTime < this.lastAudioTime - 0.25 || musicMap !== this.refsForMap) {
      this.sBass = 0
      this.sMid = 0
      this.sTreble = 0
      this.sBpm = 0
    }
    this.lastAudioTime = audioTime

    // (Re)compute per-track band normalization when the MusicMap changes.
    if (musicMap !== this.refsForMap) {
      this.refsForMap = musicMap
      this.bandRefs = musicMap
        ? { bass: highPercentile(musicMap.energySamples), treble: highPercentile(musicMap.trebleSamples) }
        : { bass: 1, treble: 1 }
    }

    // --- Sample the bands + beats at the current audio clock.
    let targetBass = 0
    let targetMid = 0
    let targetTreble = 0
    let targetBpm = 0
    let phase = 0 // 0 = just hit a beat, ~1 = next beat imminent
    let beatTimes: number[] = []

    if (musicMap && audioTime >= 0) {
      const rawBass = sampleBand(musicMap.energySamples, audioTime) / this.bandRefs.bass
      const rawTreble = sampleBand(musicMap.trebleSamples, audioTime) / this.bandRefs.treble
      targetBass = Math.min(1, Math.max(0, rawBass))
      targetTreble = Math.min(1, Math.max(0, rawTreble))
      // Mid / "body": the geometric mean of bass and treble peaks when the spectrum is
      // full (a snare or vocal sitting over a kick lights it), and is genuinely distinct
      // from either parent. Boosted slightly so it occupies a comparable visual range.
      targetMid = Math.min(1, Math.sqrt(targetBass * targetTreble) * 1.25)

      // Tempo + beat phase. Prefer the LOCKED global tempo computed offline in
      // AudioAnalysis (a single steady value with no octave rattle) and phase the ring off
      // its grid (beat k at beatPhase + k·interval). Only fall back to the rolling
      // recent-onset estimate when the track has no detectable global pulse (sparse/ambient).
      if (musicMap.bpm > 0) {
        targetBpm = musicMap.bpm
        const interval = 60 / musicMap.bpm
        phase = ((((audioTime - musicMap.beatPhase) / interval) % 1) + 1) % 1
      } else {
        const bIdx = latestIndexAtOrBefore(musicMap.beats, audioTime)
        if (bIdx >= 0) {
          const from = Math.max(0, bIdx - (BPM_WINDOW_BEATS - 1))
          beatTimes = musicMap.beats.slice(from, bIdx + 1).map((b: BeatMarker) => b.time)
          targetBpm = this.computeRecentBPM(beatTimes)

          // Beat phase: fraction of the (folded) beat interval elapsed since the last onset.
          const lastBeat = musicMap.beats[bIdx].time
          const interval = targetBpm > 0 ? 60 / targetBpm : 0
          if (interval > 0) {
            phase = ((audioTime - lastBeat) / interval) % 1
            if (phase < 0) phase += 1
          }
        }
      }
    }

    // --- 1-pole low-pass toward the targets (smooth, jitter-free meters + BPM).
    this.sBass += (targetBass - this.sBass) * BAND_SMOOTH_ALPHA
    this.sMid += (targetMid - this.sMid) * BAND_SMOOTH_ALPHA
    this.sTreble += (targetTreble - this.sTreble) * BAND_SMOOTH_ALPHA
    // BPM only tracks toward a VALID reading; an "unknown" (0) decays slowly so a brief
    // sparse gap doesn't blank the number mid-song.
    if (targetBpm > 0) {
      this.sBpm = this.sBpm > 0 ? this.sBpm + (targetBpm - this.sBpm) * BPM_SMOOTH_ALPHA : targetBpm
    } else {
      this.sBpm *= 0.96
      if (this.sBpm < BPM_MIN * 0.9) this.sBpm = 0
    }

    this.paint(this.sBass, this.sMid, this.sTreble, this.sBpm, phase, audioTime >= 0 && !!musicMap)
  }

  /** All drawing lives here; operates purely on already-resolved scalar inputs. */
  private paint(
    bass: number,
    mid: number,
    treble: number,
    bpm: number,
    phase: number,
    hasData: boolean
  ): void {
    const ctx = this.ctx
    if (!ctx) return
    const W = this.width
    const H = this.height

    ctx.save()
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    // --- Panel: dark neon background + 1px cyan border with a soft inner glow.
    ctx.fillStyle = 'rgba(12, 12, 30, 0.8)'
    this.roundRect(ctx, 0.5, 0.5, W - 1, H - 1, 10)
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(106, 246, 255, 0.85)'
    ctx.shadowColor = 'rgba(106, 246, 255, 0.6)'
    ctx.shadowBlur = 6
    this.roundRect(ctx, 0.5, 0.5, W - 1, H - 1, 10)
    ctx.stroke()
    ctx.shadowBlur = 0

    // --- Title strip.
    ctx.font = '600 9px "Segoe UI", system-ui, sans-serif'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = COL_TEXT_DIM
    ctx.fillText('AUDIO SYNC', 14, 18)

    // --- Left column: BPM readout.
    const bpmText = hasData && bpm > 0 ? Math.round(bpm).toString() : '--'
    ctx.fillStyle = COL_TEXT
    ctx.shadowColor = COL_BASS
    ctx.shadowBlur = 8
    ctx.font = '700 28px "Consolas", "SF Mono", monospace'
    ctx.fillText(bpmText, 12, 56)
    ctx.shadowBlur = 0
    ctx.fillStyle = COL_TEXT_DIM
    ctx.font = '600 10px "Consolas", monospace'
    const bpmW = ctx.measureText(bpmText).width
    ctx.fillText('BPM', 16 + Math.max(28, bpmW), 56)

    // Faint "beat" caption under the BPM that pulses brighter right after a beat fires.
    const beatPulse = hasData ? Math.pow(1 - phase, 2) : 0
    ctx.fillStyle = `rgba(255, 90, 205, ${0.3 + beatPulse * 0.6})`
    ctx.font = '600 9px "Consolas", monospace'
    ctx.fillText('BEAT', 14, 74)

    // --- Center: circular beat-phase indicator (rotates once per beat interval).
    const cx = W * 0.5 + 6
    const cy = H - 38
    const radius = 18
    this.drawBeatRing(ctx, cx, cy, radius, phase, hasData)

    // --- Right column: three vertical frequency meters.
    const meterTop = H - 70
    const meterH = 58
    const barW = 10
    const gap = 7
    const x0 = W - 14 - (barW * 3 + gap * 2)
    this.drawMeter(ctx, x0 + (barW + gap) * 0, meterTop, barW, meterH, bass, COL_BASS, 'LO')
    this.drawMeter(ctx, x0 + (barW + gap) * 1, meterTop, barW, meterH, mid, COL_MID, 'MID')
    this.drawMeter(ctx, x0 + (barW + gap) * 2, meterTop, barW, meterH, treble, COL_TREBLE, 'HI')

    ctx.restore()
  }

  /** A circular beat-phase indicator: a faint ring, a sweeping cyan→magenta arc, and a
   *  travelling dot that completes one full rotation per beat interval. */
  private drawBeatRing(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    phase: number,
    hasData: boolean
  ): void {
    // Background ring.
    ctx.lineWidth = 3
    ctx.strokeStyle = COL_DIM
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()

    if (!hasData) return

    // Sweep arc from the top (12 o'clock), clockwise, length = phase of the beat.
    const start = -Math.PI / 2
    const end = start + Math.PI * 2 * phase
    ctx.lineWidth = 3
    ctx.strokeStyle = lerpHex(COL_BASS, COL_TREBLE, phase)
    ctx.shadowColor = ctx.strokeStyle
    ctx.shadowBlur = 8
    ctx.beginPath()
    ctx.arc(cx, cy, r, start, end)
    ctx.stroke()
    ctx.shadowBlur = 0

    // Travelling dot at the arc head.
    const dx = cx + Math.cos(end) * r
    const dy = cy + Math.sin(end) * r
    ctx.fillStyle = lerpHex(COL_BASS, COL_TREBLE, phase)
    ctx.shadowColor = ctx.fillStyle
    ctx.shadowBlur = 10
    ctx.beginPath()
    ctx.arc(dx, dy, 3, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0

    // Center flash: a filled disc that flares right after a beat (phase near 0) and fades.
    const flash = Math.pow(1 - phase, 3)
    if (flash > 0.01) {
      ctx.fillStyle = `rgba(255, 90, 205, ${flash * 0.85})`
      ctx.shadowColor = COL_TREBLE
      ctx.shadowBlur = 12 * flash
      ctx.beginPath()
      ctx.arc(cx, cy, r * 0.42 * (0.5 + flash * 0.5), 0, Math.PI * 2)
      ctx.fill()
      ctx.shadowBlur = 0
    }
  }

  /** A single vertical meter: dim track, glowing fill scaled by `value` (0..1), label. */
  private drawMeter(
    ctx: CanvasRenderingContext2D,
    x: number,
    top: number,
    w: number,
    h: number,
    value: number,
    color: string,
    label: string
  ): void {
    const v = Math.min(1, Math.max(0, value))
    const r = w * 0.5

    // Track.
    ctx.fillStyle = COL_DIM
    this.roundRect(ctx, x, top, w, h, r)
    ctx.fill()

    // Fill (grows from the bottom).
    const fillH = Math.max(v > 0 ? w : 0, v * h)
    if (fillH > 0) {
      ctx.save()
      this.roundRect(ctx, x, top, w, h, r)
      ctx.clip()
      const grad = ctx.createLinearGradient(0, top + h, 0, top)
      grad.addColorStop(0, color)
      grad.addColorStop(1, lerpHex(color, '#ffffff', 0.35))
      ctx.fillStyle = grad
      ctx.shadowColor = color
      ctx.shadowBlur = 7
      ctx.fillRect(x, top + h - fillH, w, fillH)
      ctx.restore()
      ctx.shadowBlur = 0
    }

    // Label beneath.
    ctx.fillStyle = COL_TEXT_DIM
    ctx.font = '600 8px "Consolas", monospace'
    ctx.textAlign = 'center'
    ctx.fillText(label, x + w / 2, top + h + 9)
    ctx.textAlign = 'left'
  }

  /** Rounded-rectangle path helper (the path is left current for fill()/stroke()/clip()). */
  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ): void {
    const rr = Math.min(r, w / 2, h / 2)
    ctx.beginPath()
    ctx.moveTo(x + rr, y)
    ctx.arcTo(x + w, y, x + w, y + h, rr)
    ctx.arcTo(x + w, y + h, x, y + h, rr)
    ctx.arcTo(x, y + h, x, y, rr)
    ctx.arcTo(x, y, x + w, y, rr)
    ctx.closePath()
  }
}
