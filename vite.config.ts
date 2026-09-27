import { defineConfig } from "vite";

export default defineConfig({
  // MapLibre v6 loads its web worker relative to its own module; pre-bundling breaks that path.
  optimizeDeps: { exclude: ["maplibre-gl"] },
});
