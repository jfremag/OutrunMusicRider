import type { MusicMap, EnergySample, BeatMarker } from '../audio/AudioAnalysis'
import type { GameState } from '../game/GameState'

/**
 * HudOverlay ("Watercolour Speed" restyle) — the sync readout repainted as quiet
 * ink/gouache MARGINALIA in the corner of the same cold-press paper the scene sits on.
 *
 * It still shows, in perfect lock with the audio clock:
 *
 *   • the offline-locked global BPM (steady; falls back to a rolling recent-onset median
 *     only when the track has no detectable global pulse),
 *   • a hand-inked calligraphic beat-phase ARC that sweeps once per beat interval — but it
 *     DARKENS toward the warm near-black ink on the beat instead of glowing, and
 *   • three slender frequency washes — bass / mid / treble — drawn as brushed columns,
 *     plus a single obstacle-red hazard tick that flicks in on treble transients (the same
 *     signal that seeds the sword obstacles), so a hazard reads as one signal-red mark.
 *
 * STYLE CONTRACT ("Watercolour Speed", STYLE_SPEC §2/§5 HUD):
 *   • LOCKED palette only. Desaturated tinted-gray strokes (steel-violet #A7A3B1 /
 *     rose-gray #CEB9B9), ONE dusty-rose #A96276 active-beat accent, ONE obstacle-red
 *     #D6443B hazard tick. Type in warm near-black #1E1B22 at LOW contrast.
 *   • NO glow, NO bloom-adjacent styling, NO cyan/magenta. `shadowBlur` is never used —
 *     painted marks, not neon. The beat ring's stroke darkens toward #20211C on the beat;
 *     it must never brighten/glow.
 *   • Brush-like IRREGULAR weight with soft (LOST) ends — strokes taper to nothing at the
 *     tips via deterministic per-mark jitter (seeded, so marks don't "boil" frame-to-frame)
 *     and an alpha falloff toward the ends — not crisp vector lines.
 *   • Sits on the warm-cream paper as a faint wash, OFF TO ONE SIDE (right), respecting the
 *     off-centre composition. No dark panel, no hard border.
 *
 * READ-ONLY CONTRACT (unchanged):
 *   • Pure Canvas 2D — no Three.js, no Vue, no shaders.
 *   • Reads ONLY from its render() parameters (MusicMap + GameState). Never mutates game
 *     state, never touches the audio engine, zero impact on physics/car/track/collisions.
 *   • Frame-rate-independent reads (sampled against gameState.audioTime). Keeps only a tiny
 *     bit of PRIVATE visual state — 1-pole low-pass filters on the band heights + BPM, a
 *     decaying hazard-flash scalar, and per-track band normalization references — so the
 *     marks read smoothly. None of that state is shared, and none of it is game state.
 */

// --- LOCKED palette (pixel-measured from the Sienkiewicz target; see STYLE_SPEC §2).
// Tinted grays — never neutral RGB-equal. Colour is a scarce resource here.
const INK_WARM = '#1E1B22' // warm tinted near-black — type + warm-side found accents
const INK_COOL = '#20211C' // cool tinted near-black — the beat-ring "darken" target
const STEEL_VIOLET = '#A7A3B1' // dominant neutral stroke (sky-field tint, hue ~259 S~8%)
const ROSE_GRAY = '#CEB9B9' // warm desaturated stroke / ground glaze (hue ~1 S~10%)
const ROSE_ACCENT = '#A96276' // THE dusty-rose active-beat accent (hue ~343 S~42%)
const SIGNAL_RED = '#D6443B' // THE one obstacle-red hazard tick (the only >45% S mark)
const PAPER_CREAM = '#EDE7D8' // warm-cream sheet the marginalia sits on (faint wash only)

// --- Band height smoothing. A 1-pole low-pass per frame: out += (in - out) * alpha.
// alpha ≈ 0.18 gives ~3-4 frame (~60ms) response — responsive to kicks/hats but free of
// single-frame jitter. BPM is smoothed harder (it should read as a stable number).
const BAND_SMOOTH_ALPHA = 0.18
const BPM_SMOOTH_ALPHA = 0.1

// --- Hazard tick decay. The obstacle-red mark flicks to full when a treble transient fires
// (the same signal that seeds sword obstacles) and eases out over ~12 frames. Per-frame
// multiplicative decay so it is framerate-independent enough for a quick flick and never
// lingers; purely private visual state, NOT game state.
const HAZARD_DECAY = 0.86

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

/** Parse a #rrggbb CSS hex into an [r,g,b] byte triple. */
function hexToRgb(hex: string): [number, number, number] {
  const p = parseInt(hex.slice(1), 16)
  return [(p >> 16) & 255, (p >> 8) & 255, p & 255]
}

/** Linearly interpolate two CSS hex colors (#rrggbb) by t in [0,1]; returns "rgb(...)". */
function lerpHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a)
  const [br, bg, bb] = hexToRgb(b)
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const bl = Math.round(ab + (bb - ab) * t)
  return `rgb(${r}, ${g}, ${bl})`
}

/** An "rgba(...)" string for a #rrggbb hex at a given alpha — for translucent washes/inks. */
function hexA(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`
}

/**
 * Cheap deterministic value-noise in [-1,1] from one seed. Used to give marks an irregular
 * brush weight and slightly wandering tips WITHOUT randomness — the same seed always yields
 * the same wobble, so a mark drawn at the same logical position every frame does NOT boil
 * (the "shower-door" failure the style spec warns about). Hash by sin-fract; quality is
 * irrelevant, stability and zero allocation are the point.
 */
function wobble(seed: number): number {
  const s = Math.sin(seed * 12.9898) * 43758.5453
  return (s - Math.floor(s)) * 2 - 1
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
  // crisp text/strokes on hi-DPI displays. Kept compact — marginalia, not a dashboard.
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
  // Decaying 0..1 hazard-flash envelope (drives the single obstacle-red tick).
  private sHazard = 0
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
   * from gameState.audioTime so BPM, beat phase, and the band washes are sampled against
   * the exact same clock that drives the renderer (sync transparency). Safe to call every
   * frame with a null MusicMap (renders the idle marginalia) and is a no-op without a 2D ctx.
   */
  render(musicMap: MusicMap | null, gameState: GameState): void {
    const ctx = this.ctx
    if (!ctx) return

    const audioTime = gameState.audioTime
    // Detect a rewind / seek / song change and reset the smoothing so the marks don't
    // glide across a discontinuity.
    if (audioTime < this.lastAudioTime - 0.25 || musicMap !== this.refsForMap) {
      this.sBass = 0
      this.sMid = 0
      this.sTreble = 0
      this.sBpm = 0
      this.sHazard = 0
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

    // --- Hazard flash: re-seed to (a fraction of) full on a treble transient — the same
    // signal that becomes a sword obstacle — then ease out. One read-only signal in, one
    // private decaying scalar out; never written back to game state.
    if (gameState.car.trebleFires) {
      this.sHazard = Math.max(this.sHazard, 0.55 + 0.45 * Math.min(1, gameState.car.trebleStrength))
    } else {
      this.sHazard *= HAZARD_DECAY
      if (this.sHazard < 0.02) this.sHazard = 0
    }

    this.paint(
      this.sBass,
      this.sMid,
      this.sTreble,
      this.sBpm,
      phase,
      this.sHazard,
      audioTime >= 0 && !!musicMap
    )
  }

  /** All drawing lives here; operates purely on already-resolved scalar inputs. */
  private paint(
    bass: number,
    mid: number,
    treble: number,
    bpm: number,
    phase: number,
    hazard: number,
    hasData: boolean
  ): void {
    const ctx = this.ctx
    if (!ctx) return
    const W = this.width
    const H = this.height

    ctx.save()
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    // Painted marks, never neon: no shadow/glow anywhere in this overlay.
    ctx.shadowBlur = 0
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    // --- The "sheet": only a whisper of warm-cream paper so the marginalia reads as ink
    // ON the same paper as the scene, not a floating panel. No hard border, no dark box —
    // the negative space stays quiet (STYLE_SPEC: 50–70% of the frame quiet).
    ctx.fillStyle = hexA(PAPER_CREAM, 0.05)
    this.roundRect(ctx, 1, 1, W - 2, H - 2, 7)
    ctx.fill()

    // Everything is pushed to the RIGHT margin (off-centre composition). A single faint
    // steel-violet rule down the left edge of the marginalia "ties" the marks to a margin
    // like a hand-ruled notebook gutter — brushed, irregular, lost at both ends.
    this.brushStroke(ctx, W - 96, 14, W - 96, H - 14, STEEL_VIOLET, 0.9, 0.18, 911)

    // --- Title: small warm near-black caps, low contrast, set against the gutter.
    ctx.font = '600 8px "Segoe UI", system-ui, sans-serif'
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    ctx.fillStyle = hexA(INK_WARM, 0.55)
    ctx.fillText('TEMPO', W - 86, 22)

    // --- BPM readout: warm near-black ink, low contrast (no glow). The active beat lifts
    // it a touch toward the dusty-rose accent so the number "breathes" on the beat through
    // a small HUE/contrast shift — never a flash.
    const beatLift = hasData ? Math.pow(1 - phase, 2.2) : 0
    const bpmText = hasData && bpm > 0 ? Math.round(bpm).toString() : '--'
    ctx.textAlign = 'left'
    ctx.font = '700 26px "Consolas", "SF Mono", monospace'
    ctx.fillStyle = lerpHex(INK_WARM, ROSE_ACCENT, beatLift * 0.5)
    ctx.globalAlpha = 0.78 + beatLift * 0.18
    ctx.fillText(bpmText, W - 88, 50)
    ctx.globalAlpha = 1

    ctx.font = '600 9px "Consolas", monospace'
    ctx.fillStyle = hexA(INK_WARM, 0.45)
    const bpmW = ctx.measureText(bpmText).width
    ctx.fillText('BPM', W - 86 + Math.max(34, bpmW + 6), 50)

    // --- Beat-phase ARC: a hand-inked calligraphic sweep that DARKENS toward the cool ink
    // on the beat (phase→0) and washes back to a faint steel-violet between beats. Off to
    // the left of the marginalia, balancing the right-hand washes.
    const cx = W - 70
    const cy = H - 30
    const radius = 17
    this.drawBeatArc(ctx, cx, cy, radius, phase, hazard, hasData)

    // --- Frequency washes: three slender brushed columns hard against the right margin.
    // Steel-violet (LO), rose-gray (MID), and a rose-gray->rose column for HI whose label
    // tick turns obstacle-red when a hazard fires.
    const colTop = 30
    const colH = 70
    const colW = 7
    const gap = 9
    const x2 = W - 12 - colW // rightmost column's left edge
    this.drawWash(ctx, x2 - (colW + gap) * 2, colTop, colW, colH, bass, STEEL_VIOLET, 'LO', 0, hasData)
    this.drawWash(ctx, x2 - (colW + gap) * 1, colTop, colW, colH, mid, ROSE_GRAY, 'MID', 0, hasData)
    this.drawWash(ctx, x2, colTop, colW, colH, treble, ROSE_GRAY, 'HI', hazard, hasData)

    ctx.restore()
  }

  /**
   * A hand-inked calligraphic beat-phase arc. Unlike the old neon ring it NEVER glows: a
   * faint steel-violet "ghost" ring underlies a single brushed sweep that runs from 12
   * o'clock clockwise over `phase` of the beat, and the sweep's colour DARKENS toward the
   * cool tinted near-black as the beat lands (phase→0) and fades back to steel-violet as it
   * fills. The arc head carries the one dusty-rose accent. A hazard nudges the head red.
   */
  private drawBeatArc(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    phase: number,
    hazard: number,
    hasData: boolean
  ): void {
    // Faint ghost ring — a broken, brushed circle (drawn as short tangential dabs with
    // wandering weight so it reads as ink, not a printed circle).
    const DABS = 28
    for (let i = 0; i < DABS; i++) {
      const a0 = (i / DABS) * Math.PI * 2
      const a1 = ((i + 0.62) / DABS) * Math.PI * 2 // leave gaps -> broken, hand-drawn ring
      const jit = wobble(i * 3.3) * 0.7
      ctx.lineWidth = 1.1 + Math.abs(wobble(i * 5.1)) * 0.7
      ctx.strokeStyle = hexA(STEEL_VIOLET, 0.16)
      ctx.beginPath()
      ctx.arc(cx, cy, r + jit, a0, a1)
      ctx.stroke()
    }

    if (!hasData) return

    // The sweep. As the beat lands (phase near 0) the freshly-laid ink is darkest (cool
    // near-black) and at its heaviest weight; it lightens toward steel-violet and thins as
    // the phase fills — a calligraphic pressure stroke that fades, never a glowing arc.
    const darken = Math.pow(1 - phase, 1.6) // 1 right on the beat, 0 just before the next
    const sweepCol = lerpHex(STEEL_VIOLET, INK_COOL, 0.35 + darken * 0.6)
    const start = -Math.PI / 2
    const end = start + Math.PI * 2 * Math.max(0.0001, phase)

    // Draw the sweep as a chain of short segments whose weight wanders and whose ENDS taper
    // to nothing (soft / lost ends) via per-segment alpha falloff.
    const SEG = 26
    const lastSeg = Math.max(1, Math.round(SEG * phase))
    for (let i = 0; i < lastSeg; i++) {
      const t0 = i / SEG
      const t1 = (i + 1.05) / SEG
      const s0 = start + (end - start) * (t0 / Math.max(1e-3, phase))
      const s1 = start + (end - start) * Math.min(1, t1 / Math.max(1e-3, phase))
      // Tip falloff: alpha rises off the tail and eases off near the head -> lost ends.
      const along = i / Math.max(1, lastSeg - 1)
      const ends = Math.sin(Math.min(1, Math.max(0, along)) * Math.PI) // 0 at both tips
      const a = (0.28 + 0.55 * darken) * (0.35 + 0.65 * ends)
      ctx.lineWidth = (2.0 + darken * 1.4) * (0.55 + 0.45 * Math.abs(wobble(i * 2.7 + 1)))
      ctx.strokeStyle = hexA(sweepCol, a)
      ctx.beginPath()
      ctx.arc(cx, cy, r + wobble(i * 1.9) * 0.6, s0, s1)
      ctx.stroke()
    }

    // The single accent: a small dusty-rose dab at the arc head (or obstacle-red while a
    // hazard is active) — the one spot of chroma on the whole readout.
    const headCol = lerpHex(ROSE_ACCENT, SIGNAL_RED, Math.min(1, hazard))
    const hx = cx + Math.cos(end) * r
    const hy = cy + Math.sin(end) * r
    // Soft round dab (no glow) — slight irregular size.
    const dab = 2.2 + 0.7 * Math.abs(wobble(Math.round(phase * 97)))
    ctx.fillStyle = hexA(headCol, 0.85)
    ctx.beginPath()
    ctx.arc(hx, hy, dab, 0, Math.PI * 2)
    ctx.fill()
  }

  /**
   * A single slender frequency WASH: a faint brushed track, a brushed pigment column that
   * grows from the bottom by `value` (0..1), and a small label below in warm ink. The
   * column is laid as a translucent gradient (denser at the base, washing out toward the
   * wet top edge) with a soft (lost) top — gouache, not an LED bar. When `hazard` > 0 the
   * label gets one obstacle-red tick (the single signal-red mark).
   */
  private drawWash(
    ctx: CanvasRenderingContext2D,
    x: number,
    top: number,
    w: number,
    h: number,
    value: number,
    color: string,
    label: string,
    hazard: number,
    hasData: boolean
  ): void {
    const v = Math.min(1, Math.max(0, value))
    const cxLine = x + w / 2

    // Track: a faint dry-brush column (short broken dabs, wandering weight).
    const TRACK_DABS = 9
    for (let i = 0; i < TRACK_DABS; i++) {
      const y0 = top + (h * i) / TRACK_DABS
      const y1 = top + (h * (i + 0.7)) / TRACK_DABS
      ctx.lineWidth = w * (0.7 + Math.abs(wobble(i * 4.4 + x)) * 0.25)
      ctx.strokeStyle = hexA(STEEL_VIOLET, 0.1)
      ctx.beginPath()
      ctx.moveTo(cxLine + wobble(i * 2.1 + x) * 0.6, y0)
      ctx.lineTo(cxLine + wobble(i * 2.1 + x + 9) * 0.6, y1)
      ctx.stroke()
    }

    if (hasData && v > 0.001) {
      const fillH = Math.max(w, v * h)
      const baseY = top + h
      const topY = baseY - fillH
      // Pigment column: a vertical gradient that is densest at the base and washes toward
      // the wet rising edge. Mixed slightly toward rose-gray at the top so it reads warm
      // and painted rather than a flat fill.
      const grad = ctx.createLinearGradient(0, baseY, 0, topY)
      grad.addColorStop(0, hexA(color, 0.62))
      grad.addColorStop(0.65, hexA(color, 0.42))
      grad.addColorStop(1, hexA(lerpHex(color, ROSE_GRAY, 0.4), 0.12))
      ctx.fillStyle = grad
      // The column itself is a brushed rectangle with a slightly wandering width.
      ctx.beginPath()
      ctx.moveTo(x + wobble(x) * 0.4, baseY)
      ctx.lineTo(x + w + wobble(x + 5) * 0.4, baseY)
      ctx.lineTo(x + w + wobble(topY + 3) * 0.5, topY)
      ctx.lineTo(x + wobble(topY) * 0.5, topY)
      ctx.closePath()
      ctx.fill()

      // Wet top edge: a soft brushed cap that loses itself (lost end), darkened a touch
      // toward the cool ink for the Marangoni "pigment rim" read at the value boundary.
      this.brushStroke(
        ctx,
        x - 0.5,
        topY,
        x + w + 0.5,
        topY,
        lerpHex(color, INK_COOL, 0.3),
        0.5,
        0.6,
        Math.round(topY * 7 + x)
      )
    }

    // Label beneath, warm near-black, low contrast. The HI column's label carries the lone
    // obstacle-red hazard tick when a treble transient (-> sword) is firing.
    ctx.textAlign = 'center'
    ctx.font = '600 7px "Consolas", monospace'
    ctx.fillStyle = hexA(INK_WARM, 0.5)
    ctx.fillText(label, cxLine, top + h + 9)
    if (hazard > 0.02) {
      // One short signal-red tick under the label — the single saturated hazard mark.
      this.brushStroke(
        ctx,
        cxLine - 4,
        top + h + 13,
        cxLine + 4,
        top + h + 13,
        SIGNAL_RED,
        0.55 + 0.45 * Math.min(1, hazard),
        0.4,
        Math.round(top)
      )
    }
    ctx.textAlign = 'left'
  }

  /**
   * Draws a single straight BRUSH stroke from (x0,y0) to (x1,y1): a chain of short segments
   * whose weight wanders (irregular, hand-laid) and whose ENDS taper to nothing via an
   * alpha bell (soft / LOST ends). `seed` makes the wobble deterministic per logical stroke
   * so it never boils frame-to-frame. No glow — paint only.
   */
  private brushStroke(
    ctx: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: string,
    alpha: number,
    weight: number,
    seed: number
  ): void {
    const SEG = 12
    const dx = x1 - x0
    const dy = y1 - y0
    // Perpendicular unit for a tiny sideways wander so the stroke isn't ruler-straight.
    const len = Math.hypot(dx, dy) || 1
    const px = -dy / len
    const py = dx / len
    for (let i = 0; i < SEG; i++) {
      const t0 = i / SEG
      const t1 = (i + 1) / SEG
      const tm = (t0 + t1) * 0.5
      const wob = wobble(seed + i * 1.7)
      const off = wob * 0.8 // sideways wander in px
      const ax = x0 + dx * t0 + px * off
      const ay = y0 + dy * t0 + py * off
      const bx = x0 + dx * t1 + px * off
      const by = y0 + dy * t1 + py * off
      // Alpha bell -> both ends lost; weight wanders around the requested base weight.
      const bell = Math.sin(tm * Math.PI)
      ctx.lineWidth = Math.max(0.4, weight + Math.abs(wobble(seed + i * 3.1)) * weight * 0.8)
      ctx.strokeStyle = hexA(color, alpha * (0.2 + 0.8 * bell))
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(bx, by)
      ctx.stroke()
    }
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
