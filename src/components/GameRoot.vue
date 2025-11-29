<template>
  <div class="game-root">
    <div class="controls">
      <div class="file-input-container">
        <label for="audio-file" class="file-label">
          Choose Audio File
        </label>
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
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { GameController } from '../core/game/GameController'

const canvasEl = ref<HTMLCanvasElement | null>(null)
const gameController = ref<GameController | null>(null)
const isReady = ref(false)
const isPlaying = ref(false)
const loadedFileName = ref<string>('')
let animationFrameId: number | null = null
let lastTime = 0

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
  gameController.value = new GameController(canvasEl.value)

  // Start animation loop
  lastTime = performance.now()
  const animate = (currentTime: number) => {
    const dt = (currentTime - lastTime) / 1000 // Convert to seconds
    lastTime = currentTime

    if (gameController.value) {
      gameController.value.update(dt)
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
      console.warn('Default audio file not found at', audioPath, '- user can upload one manually')
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

.controls {
  position: absolute;
  top: 20px;
  left: 20px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 15px;
  background: rgba(10, 10, 26, 0.8);
  padding: 20px;
  border-radius: 8px;
  border: 1px solid rgba(255, 0, 255, 0.3);
  box-shadow: 0 0 20px rgba(255, 0, 255, 0.2);
}

.file-input-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.file-label {
  color: #00ffff;
  font-size: 14px;
  font-weight: bold;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.file-input {
  color: #fff;
  background: rgba(26, 10, 46, 0.6);
  border: 1px solid rgba(255, 0, 255, 0.5);
  padding: 8px;
  border-radius: 4px;
  cursor: pointer;
}

.file-input:hover {
  border-color: rgba(255, 0, 255, 0.8);
}

.playback-controls {
  display: flex;
  gap: 10px;
}

.control-button {
  padding: 10px 20px;
  background: linear-gradient(135deg, #ff0066, #ff00ff);
  border: none;
  border-radius: 4px;
  color: #fff;
  font-weight: bold;
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 1px;
  transition: all 0.3s;
  box-shadow: 0 0 10px rgba(255, 0, 255, 0.3);
}

.control-button:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 0 15px rgba(255, 0, 255, 0.5);
}

.control-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.status-message {
  color: #00ffff;
  font-size: 12px;
  text-align: center;
  padding: 8px;
  background: rgba(0, 255, 255, 0.1);
  border-radius: 4px;
}

.file-name-display {
  color: #00ff00;
  font-size: 12px;
  margin-top: 8px;
  padding: 6px;
  background: rgba(0, 255, 0, 0.1);
  border-radius: 4px;
  border: 1px solid rgba(0, 255, 0, 0.3);
}
</style>

