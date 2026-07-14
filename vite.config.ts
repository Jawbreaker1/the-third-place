import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { configDefaults } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4000",
      "/socket.io": {
        target: "http://127.0.0.1:4000",
        ws: true,
      },
    },
  },
  build: {
    sourcemap: true,
  },
  test: {
    // Server builds contain compiled copies of source tests; never execute the
    // stale artifacts as a second test suite.
    exclude: [...configDefaults.exclude, "dist-server/**"],
  },
});
