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
.loading-overlay {
  position: fixed;
  inset: 0;
  background: rgba(6, 14, 32, 0.92);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
  pointer-events: auto;
}

.spinner-container {
  text-align: center;
}

.spinner {
  width: 120px;
  height: 120px;
  margin: 0 auto 24px;
  border: 3px solid rgba(48, 243, 200, 0.18);
  border-top-color: rgba(48, 243, 200, 1);
  border-right-color: rgba(255, 0, 255, 0.8);
  border-radius: 50%;
  animation: spin 2.5s linear infinite;
  box-shadow: 0 0 14px rgba(48, 243, 200, 0.6), 0 0 28px rgba(255, 0, 255, 0.3);
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
  color: #30f3c8;
  letter-spacing: 1px;
  text-transform: uppercase;
  text-shadow: 0 0 8px rgba(48, 243, 200, 0.7);
  animation: pulse 0.8s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.7;
  }
  50% {
    opacity: 1;
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
