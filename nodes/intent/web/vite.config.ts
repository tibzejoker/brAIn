import { defineConfig } from "vite";

const SERVER = process.env.INTENT_SERVER_URL ?? "http://localhost:8767";
const VOICE_WEB = process.env.VOICE_WEB_URL ?? "http://localhost:5174";
const GAZE_WEB = process.env.GAZE_WEB_URL ?? "http://localhost:5175";

export default defineConfig({
  define: {
    __VOICE_WEB__: JSON.stringify(VOICE_WEB),
    __GAZE_WEB__: JSON.stringify(GAZE_WEB),
  },
  server: {
    port: 5176,
    proxy: {
      "/api": SERVER,
      "/ws": { target: SERVER.replace("http", "ws"), ws: true },
    },
  },
});
