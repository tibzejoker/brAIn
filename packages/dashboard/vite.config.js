import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
    plugins: [react(), tailwindcss()],
    server: {
        port: 5173,
        proxy: {
            "/nodes": {
                target: "http://localhost:3000",
                changeOrigin: true,
            },
            "/types": {
                target: "http://localhost:3000",
                changeOrigin: true,
            },
            "/network": {
                target: "http://localhost:3000",
                changeOrigin: true,
            },
            "/socket.io": {
                target: "http://localhost:3000",
                changeOrigin: true,
                ws: true,
            },
        },
    },
});
//# sourceMappingURL=vite.config.js.map