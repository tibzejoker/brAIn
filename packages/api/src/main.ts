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
  Bridged Reactive Artificial Intelligence Network
`;

async function bootstrap(): Promise<void> {
  log.log(BANNER);

  const app = await NestFactory.create(AppModule);
  app.enableCors();

  const port = process.env.API_PORT ?? 3000;
  await app.listen(port);
  log.log(`Listening on port ${port}`);
}

void bootstrap();
