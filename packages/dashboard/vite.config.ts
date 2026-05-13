import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API_TARGET = `http://localhost:${process.env.API_PORT ?? 3000}`;
const PROXY_OPT = { target: API_TARGET, changeOrigin: true };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: parseInt(process.env.DASHBOARD_PORT ?? "5173", 10),
    // Bind to all interfaces so the dashboard is reachable from a phone
    // on the same Wi-Fi at http://<mac-LAN-ip>:5173. Vite defaults to
    // localhost-only. Override with DASHBOARD_HOST to lock it back down.
    // The proxy below means the dashboard keeps calling /network etc.
    // without an API_BASE rewrite — same-origin requests proxied to 3000.
    host: process.env.DASHBOARD_HOST ?? "0.0.0.0",
    proxy: {
      "/nodes": PROXY_OPT,
      "/types": PROXY_OPT,
      "/network": PROXY_OPT,
      "/store": PROXY_OPT,
      "/agents": PROXY_OPT,
      "/mcp": PROXY_OPT,
      "/llm": PROXY_OPT,
      "/tools": PROXY_OPT,
      "/socket.io": { ...PROXY_OPT, ws: true },
    },
  },
});
