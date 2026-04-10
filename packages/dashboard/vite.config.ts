import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API_TARGET = `http://localhost:${process.env.API_PORT ?? 3000}`;
const PROXY_OPT = { target: API_TARGET, changeOrigin: true };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: parseInt(process.env.DASHBOARD_PORT ?? "5173", 10),
    proxy: {
      "/nodes": PROXY_OPT,
      "/types": PROXY_OPT,
      "/network": PROXY_OPT,
      "/socket.io": { ...PROXY_OPT, ws: true },
    },
  },
});
