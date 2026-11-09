import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

// Tauri runs the frontend on a fixed port. 3042 keeps Calc clear of
// Open PDF Studio (3041) so both can run side-by-side during development.
const PORT = 3042;

export default defineConfig({
  plugins: [solidPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
  },
  // Tauri expects a fixed dev server. Fail loudly instead of hopping ports.
  clearScreen: false,
  server: {
    port: PORT,
    strictPort: true,
    // Loopback only (Tauri's own template): '0.0.0.0' offered the dev server —
    // and with it the whole source tree — to every machine on the network.
    // TAURI_DEV_HOST is set by the Tauri CLI when it needs another address.
    host: process.env.TAURI_DEV_HOST || false,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    hmr: {
      protocol: 'ws',
      host: 'localhost',
      port: PORT,
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
  // The suite covers the pure logic where a silent mistake is most expensive:
  // finding the cells, translating build lines back to source lines, resolving
  // \py{}, and deciding what may be skipped or restored. All of it runs without
  // a DOM, a kernel or a LaTeX install.
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
  },
});
