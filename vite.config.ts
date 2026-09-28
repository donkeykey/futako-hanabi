import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages serves the site from /<repo>/; set BASE_PATH in CI.
  base: process.env.BASE_PATH ?? "/",
  // MapLibre v6 loads its web worker relative to its own module; pre-bundling breaks that path.
  optimizeDeps: { exclude: ["maplibre-gl"] },
  worker: { format: "es" },
});
