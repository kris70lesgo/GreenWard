import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ["maplibre-gl"],
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/sam-api": {
        target: "http://localhost:8788",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/sam-api/, ""),
      },
    },
  },
});
