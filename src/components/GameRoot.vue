<template>
  <div class="game-root">
    <LoadingOverlay :is-loading="isLoading" :status-text="loadingStatus" />
    <div class="controls">
      <div class="file-input-container">
        <label for="audio-file" class="file-label"> Choose Audio File </label>
        <input
          id="audio-file"
          type="file"
          accept="audio/*"
          @change="handleFileSelect"
          class="file-input"
        />
        <div v-if="isReady && loadedFileName" class="file-name-display">
          Loaded: {{ loadedFileName }}
        </div>
      </div>
      <div class="playback-controls">
        <button
          @click="handlePlay"
          :disabled="!isReady || isPlaying"
          class="control-button control-button--primary"
        >
          Play
        </button>
        <button
          @click="handlePause"
          :disabled="!isReady || !isPlaying"
          class="control-button"
        >
          Pause
        </button>
      </div>
      <div v-if="!isReady" class="status-message">
        Please select an audio file to begin
      </div>
    </div>
    <canvas ref="canvasEl" class="game-canvas"></canvas>
    <!-- Iteration 10: neon audio-sync HUD (live BPM, beat-phase ring, 3-band meters).
         A separate 2D canvas floating top-right; pointer-events:none lets clicks pass
         through to the game canvas. Its backing-store resolution is set in HudOverlay. -->
    <canvas ref="hudCanvasEl" id="hud-overlay" class="hud-overlay"></canvas>
    <div class="damage-flash" :class="{ 'is-visible': showDamageFlash }"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, markRaw, onMounted, onUnmounted } from 'vue'
import { GameController } from '../core/game/GameController'
import { HudOverlay } from '../core/render/HudOverlay'
import LoadingOverlay from './LoadingOverlay.vue'

const canvasEl = ref<HTMLCanvasElement | null>(null)
const hudCanvasEl = ref<HTMLCanvasElement | null>(null)
const gameController = shallowRef<GameController | null>(null)
// HudOverlay is stateless w.r.t. game state and must NOT enter Vue's reactivity system
// (it caches a 2D canvas context). Hold it in a plain module-scoped variable.
let hudOverlay: HudOverlay | null = null
const isReady = ref(false)
const isPlaying = ref(false)
const loadedFileName = ref<string>('')
const showDamageFlash = ref(false)
// Loading overlay state (iteration 8): premium feedback during the audio decode +
// analysis + track-generation pipeline, which takes ~2-3s. The GameController drives
// these via its onStatus callback (status strings, then null on completion).
const isLoading = ref(false)
const loadingStatus = ref('')
let animationFrameId: number | null = null
let flashTimeoutId: number | null = null

let resizeCanvas: (() => void) | null = null
let handleKeyDown: ((e: KeyboardEvent) => void) | null = null

onMounted(async () => {
  if (!canvasEl.value) {
    console.error('Canvas element not found')
    return
  }

  // Set canvas size immediately
  const setCanvasSize = () => {
    if (canvasEl.value) {
      const width = window.innerWidth
      const height = window.innerHeight
      canvasEl.value.width = width
      canvasEl.value.height = height
      canvasEl.value.style.width = width + 'px'
      canvasEl.value.style.height = height + 'px'
    }
  }

  setCanvasSize()

  // Set canvas size handler
  resizeCanvas = () => {
    if (canvasEl.value) {
      const width = window.innerWidth
      const height = window.innerHeight
      canvasEl.value.width = width
      canvasEl.value.height = height
      canvasEl.value.style.width = width + 'px'
      canvasEl.value.style.height = height + 'px'
      gameController.value?.resize(width, height)
    }
  }

  window.addEventListener('resize', resizeCanvas)

  // Create game controller - this will initialize Three.js
  gameController.value = markRaw(new GameController(canvasEl.value))

  // Create the neon audio-sync HUD overlay (iteration 10) on its own 2D canvas. It reads
  // only from the controller's MusicMap + GameState each frame and never mutates them.
  if (hudCanvasEl.value) {
    hudOverlay = new HudOverlay(hudCanvasEl.value)
  }

  // Dev-only debug handle so the running scene can be inspected from the console /
  // automated checks (e.g. confirming the road elevation morph). Guarded by the Vite
  // DEV flag so it is dead-code-eliminated from production builds.
  if (import.meta.env.DEV) {
    ;(window as unknown as { __game?: GameController }).__game = gameController.value
  }

  gameController.value.setCollisionHandler(() => {
    showDamageFlash.value = true
    if (flashTimeoutId !== null) {
      window.clearTimeout(flashTimeoutId)
    }
    flashTimeoutId = window.setTimeout(() => {
      showDamageFlash.value = false
      flashTimeoutId = null
    }, 180)
  })

  // Start animation loop
  const animate = () => {
    if (gameController.value) {
      gameController.value.update()
      // Paint the audio-sync HUD AFTER the game update so it samples the freshly
      // mirrored audio clock (gameState.audioTime) and reads the same frame the
      // renderer just drew — keeping BPM / phase / band meters perfectly in sync.
      hudOverlay?.render(gameController.value.getMusicMap(), gameController.value.getState())
    }

    animationFrameId = requestAnimationFrame(animate)
  }
  animationFrameId = requestAnimationFrame(animate)

  // Keyboard input
  handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      gameController.value?.handleInput(e.key)
    }
  }

  window.addEventListener('keydown', handleKeyDown)

  // Preload default audio file from public directory
  try {
    isReady.value = false
    const audioPath = '/06 boxing day.mp3'
    console.log('Attempting to load audio from:', audioPath)
    const response = await fetch(audioPath)
    if (response.ok) {
      const blob = await response.blob()
      const file = new File([blob], '06 boxing day.mp3', { type: 'audio/mpeg' })
      console.log('Audio file loaded, analyzing...')
      isLoading.value = true
      loadingStatus.value = 'Decoding audio...'
      await gameController.value.loadFile(file, onLoadStatus)
      isReady.value = true
      loadedFileName.value = '06 boxing day.mp3'
      console.log('Audio file loaded and analyzed successfully')
    } else {
      console.warn(
        'Default audio file not found at',
        audioPath,
        '- user can upload one manually'
      )
    }
  } catch (error) {
    console.error('Failed to load default audio file:', error)
    // Continue without preloaded file - user can still upload one
  } finally {
    // Always dismiss the loading overlay, even if the default song was missing or
    // failed to decode (the user can still upload a file manually).
    isLoading.value = false
  }
})

onUnmounted(() => {
  if (resizeCanvas) {
    window.removeEventListener('resize', resizeCanvas)
  }
  if (handleKeyDown) {
    window.removeEventListener('keydown', handleKeyDown)
  }
  if (flashTimeoutId !== null) {
    window.clearTimeout(flashTimeoutId)
  }
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId)
  }
})

// Bridges the GameController's loadFile pipeline milestones to the loading overlay.
// A status string updates the overlay text; a null signals completion -> fade out.
const onLoadStatus = (status: string | null) => {
  if (status === null) {
    isLoading.value = false
  } else {
    loadingStatus.value = status
  }
}

const handleFileSelect = async (e: Event) => {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file || !gameController.value) return

  try {
    isReady.value = false
    loadedFileName.value = ''
    isLoading.value = true
    loadingStatus.value = 'Decoding audio...'
    await gameController.value.loadFile(file, onLoadStatus)
    isReady.value = true
    loadedFileName.value = file.name
  } catch (error) {
    console.error('Failed to load file:', error)
    alert('Failed to load audio file. Please try another file.')
  } finally {
    // Guarantee the overlay is dismissed even on error or if completion never fired.
    isLoading.value = false
  }
}

const handlePlay = () => {
  if (gameController.value) {
    gameController.value.play()
    isPlaying.value = true
  }
}

const handlePause = () => {
  if (gameController.value) {
    gameController.value.pause()
    isPlaying.value = false
  }
}
</script>

<style scoped>
.game-root {
  width: 100vw;
  height: 100vh;
  position: relative;
  overflow: hidden;
}

.game-canvas {
  display: block;
  width: 100%;
  height: 100%;
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
}

.hud-overlay {
  position: fixed;
  top: 20px;
  right: 20px;
  width: 220px;
  height: 128px;
  /* Above the game canvas (z-index 1) but below the controls (z-index 10). The HUD sits
     top-right and the controls top-left, so they never overlap regardless. */
  z-index: 5;
  /* Let every click/drag fall through to the game canvas underneath. */
  pointer-events: none;
  /* "Watercolour Speed": the HUD is ink marginalia painted directly on the same paper.
     No neon glow — just a faint warm ink drop to seat the marks on the sheet. */
  filter: drop-shadow(0 1px 1px rgba(30, 27, 34, 0.18));
}

/* A collision is a brief "wet" painterly hit, not a neon strobe: a soft muted
   obstacle-red (#D6443B) wash that pools toward the edges and clears quickly,
   like pigment dropped on a wet sheet. Low alpha keeps it over the painting. */
.damage-flash {
  position: absolute;
  inset: 0;
  background: radial-gradient(
    circle at 50% 60%,
    rgba(214, 68, 59, 0.06) 0%,
    rgba(214, 68, 59, 0.16) 55%,
    rgba(214, 68, 59, 0.32) 100%
  );
  mix-blend-mode: multiply;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.22s ease-out;
  z-index: 15;
}

.damage-flash.is-visible {
  opacity: 1;
}

/* "Watercolour Speed" chrome: a quiet translucent PAPER card pinned to the corner
   of the painting — warm cream sheet, soft thin ink border, a faint ink drop to lift
   it off the canvas. No neon, no cyan, no bloom. Low contrast, unobtrusive marginalia. */
.controls {
  position: absolute;
  top: 20px;
  left: 20px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 14px;
  background: rgba(237, 231, 216, 0.86);
  padding: 18px 20px;
  border-radius: 3px;
  border: 1px solid rgba(30, 27, 34, 0.18);
  box-shadow: 0 1px 3px rgba(30, 27, 34, 0.16);
  color: #1e1b22;
  backdrop-filter: blur(1px);
}

.file-input-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.file-label {
  color: #1e1b22;
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  opacity: 0.82;
}

.file-input {
  color: #1e1b22;
  background: rgba(217, 214, 206, 0.6);
  border: 1px solid rgba(30, 27, 34, 0.22);
  padding: 7px 8px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  transition: border-color 0.2s ease, background-color 0.2s ease;
}

/* The native button half of the file input — make it read as a small putty chip. */
.file-input::-webkit-file-upload-button,
.file-input::file-selector-button {
  color: #1e1b22;
  background: rgba(237, 231, 216, 0.9);
  border: 1px solid rgba(30, 27, 34, 0.2);
  border-radius: 2px;
  padding: 4px 10px;
  margin-right: 10px;
  cursor: pointer;
  font-size: 11px;
  letter-spacing: 0.5px;
  transition: background-color 0.2s ease;
}

.file-input::-webkit-file-upload-button:hover,
.file-input::file-selector-button:hover {
  background: rgba(217, 214, 206, 0.95);
}

.file-input:hover {
  border-color: rgba(30, 27, 34, 0.4);
  background: rgba(217, 214, 206, 0.78);
}

.playback-controls {
  display: flex;
  gap: 10px;
}

/* Buttons are paper chips with ink text. Secondary (PAUSE) is muted putty;
   hover = a subtle ink darkening of the paper, never a glow. */
.control-button {
  padding: 9px 20px;
  background: rgba(217, 214, 206, 0.85);
  border: 1px solid rgba(30, 27, 34, 0.22);
  border-radius: 3px;
  color: #1e1b22;
  font-weight: 600;
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  font-size: 12px;
  transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

.control-button:hover:not(:disabled) {
  background: rgba(201, 196, 184, 0.95);
  border-color: rgba(30, 27, 34, 0.4);
}

/* Primary / active (PLAY): the single dusty-rose accent note. Muted gouache rose,
   not neon — paper-light ink text over it, a quiet darkening on hover. */
.control-button--primary {
  background: rgba(169, 98, 118, 0.85);
  border-color: rgba(132, 74, 92, 0.6);
  color: #ede7d8;
}

.control-button--primary:hover:not(:disabled) {
  background: rgba(151, 86, 105, 0.92);
  border-color: rgba(110, 60, 76, 0.7);
  color: #ede7d8;
}

.control-button:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

.status-message {
  color: #1e1b22;
  opacity: 0.7;
  font-size: 11px;
  font-style: italic;
  text-align: center;
  padding: 7px 8px;
  background: rgba(217, 214, 206, 0.45);
  border-radius: 3px;
}

.file-name-display {
  color: #20211c;
  font-size: 11px;
  margin-top: 6px;
  padding: 6px 8px;
  background: rgba(217, 214, 206, 0.5);
  border-radius: 3px;
  border: 1px solid rgba(30, 27, 34, 0.16);
}
</style>
