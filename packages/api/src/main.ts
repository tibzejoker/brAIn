import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import * as fs from "fs";
import * as path from "path";
import { AppModule } from "./app.module";

const log = new Logger("brAIn");

const BANNER = `
  ██████╗ ██████╗  █████╗ ██╗███╗   ██╗
  ██╔══██╗██╔══██╗██╔══██╗██║████╗  ██║
  ██████╔╝██████╔╝███████║██║██╔██╗ ██║
  ██╔══██╗██╔══██╗██╔══██║██║██║╚██╗██║
  ██████╔╝██║  ██║██║  ██║██║██║ ╚████║
  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝
  Bus-Reactive Ambient Intelligent Nodes
`;

async function bootstrap(): Promise<void> {
  log.log(BANNER);

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors();
  // Required for OnModuleDestroy to fire on SIGINT/SIGTERM — without
  // this, the embedded NATS broker leaks as an orphan process.
  app.enableShutdownHooks();

  // Single-port dashboard: when BRAIN_DASHBOARD_DIR points at a built
  // dashboard (vite build output), serve it from the API as a static
  // SPA. Used by the production / Docker image — in dev the dashboard
  // is its own Vite server with its own proxy.
  const dashboardDir = process.env.BRAIN_DASHBOARD_DIR;
  if (dashboardDir && fs.existsSync(path.join(dashboardDir, "index.html"))) {
    app.useStaticAssets(dashboardDir);
    // SPA fallback — serve index.html for any GET that doesn't match an
    // API prefix or static asset. Note: NestJS mounts controller routes
    // during app.listen(), AFTER this app.use() is registered, so we
    // can't rely on "if no route matched, fall through". The explicit
    // prefix list is the reliable way to keep API routes addressable.
    const apiPrefixes = ["/nodes", "/network", "/types", "/store", "/agents", "/mcp", "/socket.io"];
    const indexHtml = path.join(dashboardDir, "index.html");
    app.use((req: { method: string; path: string }, res: { sendFile: (p: string) => void }, next: () => void) => {
      if (req.method !== "GET") return next();
      const p = req.path;
      if (apiPrefixes.some((prefix) => p === prefix || p.startsWith(prefix + "/"))) return next();
      // Anything with a real file extension is either served by static
      // (above) or should 404 — don't shadow with index.html.
      if (/\.[a-zA-Z0-9]{1,8}$/.test(p)) return next();
      res.sendFile(indexHtml);
    });
    log.log(`Serving dashboard from ${dashboardDir}`);
  }

  const port = process.env.API_PORT ?? 3000;
  await app.listen(port);
  log.log(`Listening on port ${port}`);
}

void bootstrap();
