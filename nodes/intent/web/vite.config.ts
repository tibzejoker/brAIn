import { defineConfig } from "vite";

const SERVER = process.env.INTENT_SERVER_URL ?? "http://localhost:8767";

export default defineConfig({
  server: {
    port: 5176,
    proxy: {
      "/api": SERVER,
      "/ws": { target: SERVER.replace("http", "ws"), ws: true },
    },
  },
});
