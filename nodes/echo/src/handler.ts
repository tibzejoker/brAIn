import type { NodeHandler } from "@brain/sdk";
import pino from "pino";

const log = pino({ name: "echo-node" });

export const handler: NodeHandler = (ctx) => {
  if (ctx.messages.length === 0) {
    ctx.sleep([{ type: "any" }]);
    return Promise.resolve();
  }

  for (const msg of ctx.messages) {
    log.info(
      { from: msg.from, topic: msg.topic, payload: msg.payload },
      "Received message",
    );

    ctx.publish("echo.output", {
      type: "text",
      criticality: 0,
      payload: { content: `Echo: ${JSON.stringify(msg.payload)}` },
    });
  }
  return Promise.resolve();
};
