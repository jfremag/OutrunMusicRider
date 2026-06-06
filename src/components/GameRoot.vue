<template>
  <div class="game-root">
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
          class="control-button"
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
    <div class="damage-flash" :class="{ 'is-visible': showDamageFlash }"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, markRaw, onMounted, onUnmounted } from 'vue'
import { GameController } from '../core/game/GameController'

const canvasEl = ref<HTMLCanvasElement | null>(null)
const gameController = shallowRef<GameController | null>(null)
const isReady = ref(false)
const isPlaying = ref(false)
const loadedFileName = ref<string>('')
const showDamageFlash = ref(false)
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
      await gameController.value.loadFile(file)
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

const handleFileSelect = async (e: Event) => {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file || !gameController.value) return

  try {
    isReady.value = false
    loadedFileName.value = ''
    await gameController.value.loadFile(file)
    isReady.value = true
    loadedFileName.value = file.name
  } catch (error) {
    console.error('Failed to load file:', error)
    alert('Failed to load audio file. Please try another file.')
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

.damage-flash {
  position: absolute;
  inset: 0;
  background: rgba(255, 58, 83, 0.4);
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.18s ease;
  z-index: 15;
}

.damage-flash.is-visible {
  opacity: 1;
}

.controls {
  position: absolute;
  top: 20px;
  left: 20px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 15px;
  background: rgba(4, 18, 38, 0.82);
  padding: 20px;
  border-radius: 8px;
  border: 1px solid rgba(106, 246, 255, 0.35);
  box-shadow: 0 0 22px rgba(255, 58, 83, 0.25);
}

.file-input-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.file-label {
  color: #30f3c8;
  font-size: 14px;
  font-weight: bold;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.file-input {
  color: #e5faff;
  background: rgba(10, 47, 68, 0.7);
  border: 1px solid rgba(30, 224, 255, 0.65);
  padding: 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.file-input:hover {
  border-color: rgba(255, 58, 83, 0.7);
  box-shadow: 0 0 12px rgba(255, 58, 83, 0.35);
}

.playback-controls {
  display: flex;
  gap: 10px;
}

.control-button {
  padding: 10px 20px;
  background: linear-gradient(135deg, #0db5d6, #6af6ff);
  border: none;
  border-radius: 4px;
  color: #fff;
  font-weight: bold;
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 1px;
  transition: all 0.3s;
  box-shadow: 0 0 12px rgba(106, 246, 255, 0.45);
}

.control-button:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 0 18px rgba(255, 58, 83, 0.45);
}

.control-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.status-message {
  color: #6af6ff;
  font-size: 12px;
  text-align: center;
  padding: 8px;
  background: rgba(14, 181, 214, 0.18);
  border-radius: 4px;
}

.file-name-display {
  color: #30f3c8;
  font-size: 12px;
  margin-top: 8px;
  padding: 6px;
  background: rgba(48, 243, 200, 0.15);
  border-radius: 4px;
  border: 1px solid rgba(48, 243, 200, 0.35);
}
</style>
