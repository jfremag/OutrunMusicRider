<template>
  <transition name="fade">
    <div v-show="isLoading" class="loading-overlay">
      <div class="spinner-container">
        <div class="spinner"></div>
        <div class="status-text">{{ statusText }}</div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
defineProps<{
  isLoading: boolean
  statusText: string
}>()
</script>

<style scoped>
/* "Watercolour Speed" loading screen: a warm-cream PAPER backdrop with a quiet
   ink spinner and ink status text. No neon, no glow — the decode/analyse pipeline
   reads as marks being laid down on the same sheet the painting sits on. */
.loading-overlay {
  position: fixed;
  inset: 0;
  background: rgba(233, 225, 210, 0.94);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
  pointer-events: auto;
}

.spinner-container {
  text-align: center;
}

/* A thin ink ring drawn on paper: faint warm-ink track, a darker warm-ink leading
   arc, with one dusty-rose accent tick on the opposite side. No box-shadow bloom. */
.spinner {
  width: 110px;
  height: 110px;
  margin: 0 auto 24px;
  border: 2px solid rgba(30, 27, 34, 0.14);
  border-top-color: rgba(30, 27, 34, 0.78);
  border-right-color: rgba(169, 98, 118, 0.7);
  border-radius: 50%;
  animation: spin 2.5s linear infinite;
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

.status-text {
  font-family: 'Courier New', monospace;
  font-size: 13px;
  color: #1e1b22;
  opacity: 0.78;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  animation: pulse 1.1s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.55;
  }
  50% {
    opacity: 0.82;
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
