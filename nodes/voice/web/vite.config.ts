import { defineConfig } from "vite";

const SERVER = process.env.VOICE_SERVER_URL ?? "http://localhost:8765";

export default defineConfig({
  server: {
    port: 5174,
    proxy: {
      "/api": SERVER,
      "/ws": { target: SERVER.replace("http", "ws"), ws: true },
    },
  },
});
