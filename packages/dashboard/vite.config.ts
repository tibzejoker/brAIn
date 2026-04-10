import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../../", ["API_", "DASHBOARD_"]);
  const apiPort = env.API_PORT || "3000";
  const dashboardPort = parseInt(env.DASHBOARD_PORT || "5173", 10);
  const apiTarget = `http://localhost:${apiPort}`;

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: dashboardPort,
      proxy: {
        "/nodes": { target: apiTarget, changeOrigin: true },
        "/types": { target: apiTarget, changeOrigin: true },
        "/network": { target: apiTarget, changeOrigin: true },
        "/seeds": { target: apiTarget, changeOrigin: true },
        "/socket.io": { target: apiTarget, changeOrigin: true, ws: true },
      },
    },
  };
});
