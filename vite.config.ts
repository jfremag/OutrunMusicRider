import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Vendor code-splitting: Three.js is a large 3D engine and dominates the bundle.
// Splitting it (and its postprocessing examples) into stable vendor chunks lets the
// browser cache them across app-code changes and load them in parallel with app code.
// The three-core chunk is still inherently large; that is expected for a WebGL engine.
export default defineConfig({
  plugins: [vue()],
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three/examples')) return 'three-examples'
          if (id.includes('node_modules/three')) return 'three-core'
          if (id.includes('node_modules/@vue') || id.includes('node_modules/vue')) return 'vue'
        },
      },
    },
  },
})

