import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Workspace packages ship TypeScript source, so they are bundled, not required at runtime.
const workspace = { exclude: ["@chiefbot/contracts"] };

export default defineConfig({
  main: { build: { externalizeDeps: workspace } },
  // Sandboxed preloads must be CommonJS.
  preload: {
    build: {
      externalizeDeps: workspace,
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: { plugins: [react()] },
});
