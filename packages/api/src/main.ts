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
    // SPA fallback — forward any HTML-accept request that isn't already
    // routed to a controller back to index.html. Express middleware
    // runs after the controller stack, so /nodes, /network, /socket.io
    // etc. take priority.
    const indexHtml = path.join(dashboardDir, "index.html");
    app.use((req: { method: string; path: string; accepts: (t: string) => boolean }, res: { sendFile: (p: string) => void }, next: () => void) => {
      if (req.method !== "GET") return next();
      if (req.path.startsWith("/socket.io")) return next();
      if (req.accepts("html")) { res.sendFile(indexHtml); return; }
      next();
    });
    log.log(`Serving dashboard from ${dashboardDir}`);
  }

  const port = process.env.API_PORT ?? 3000;
  await app.listen(port);
  log.log(`Listening on port ${port}`);
}

void bootstrap();
