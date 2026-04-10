import type { NodeHandler } from "@brain/sdk";

export const handler: NodeHandler = (ctx) => {
  ctx.publish("time.tick", {
    type: "text",
    criticality: 0,
    payload: { content: new Date().toISOString() },
  });
  return Promise.resolve();
};
