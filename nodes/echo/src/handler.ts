import type { NodeHandler } from "@brain/sdk";

export const handler: NodeHandler = (ctx) => {
  for (const msg of ctx.messages) {
    ctx.respond(`Echo: ${JSON.stringify(msg.payload)}`);
  }
  return Promise.resolve();
};
