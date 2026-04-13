import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { Server } from "socket.io";
import { BrainService } from "@brain/core";

@WebSocketGateway({ cors: true })
export class DashboardGateway implements OnGatewayInit {
  private readonly log = new Logger(DashboardGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private readonly brain: BrainService) {}

  afterInit(): void {
    this.brain.on("node:spawned", (node) => {
      this.server.emit("node:spawned", node);
    });

    this.brain.on("node:killed", (data) => {
      this.server.emit("node:killed", data);
    });

    this.brain.on("node:state_changed", (data) => {
      this.server.emit("node:state_changed", data);
    });

    this.brain.on("message:published", (msg) => {
      this.server.emit("message:published", msg);
    });

    this.brain.on("devmode:changed", (data) => {
      this.server.emit("devmode:changed", data);
    });

    this.log.log("WebSocket gateway initialized");
  }
}
