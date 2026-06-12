import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/@xyflow/") || id.includes("\\@xyflow\\")) return "reactflow-vendor";
          if (id.includes("/yjs/") || id.includes("\\yjs\\") || id.includes("/y-protocols/") || id.includes("\\y-protocols\\")) return "yjs-vendor";
          if (id.includes("/react/") || id.includes("\\react\\") || id.includes("/react-dom/") || id.includes("\\react-dom\\") || id.includes("/scheduler/") || id.includes("\\scheduler\\")) return "react-vendor";
          if (id.includes("/weui/") || id.includes("\\weui\\")) return "ui-vendor";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5180,
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
