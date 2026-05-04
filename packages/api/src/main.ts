import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
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

  const app = await NestFactory.create(AppModule);
  app.enableCors();
  // Required for OnModuleDestroy to fire on SIGINT/SIGTERM — without
  // this, the embedded NATS broker leaks as an orphan process.
  app.enableShutdownHooks();

  const port = process.env.API_PORT ?? 3000;
  await app.listen(port);
  log.log(`Listening on port ${port}`);
}

void bootstrap();
