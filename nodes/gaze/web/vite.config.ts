import { defineConfig } from "vite";

const SERVER = process.env.GAZE_SERVER_URL ?? "http://localhost:8766";

export default defineConfig({
  server: {
    port: 5175,
    proxy: {
      "/api": SERVER,
    },
  },
});
