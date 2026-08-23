import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// L'interface parle a l'API locale. En developpement, Vite relaie /api et /ws
// vers le backend Python pour eviter toute question de CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
