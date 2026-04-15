import type { NodeHandler } from "@brain/sdk";

export const handler: NodeHandler = (ctx) => {
  ctx.publish("time.tick", {
    type: "text",
    criticality: 0,
    payload: { content: new Date().toISOString() },
  });
  // Tick every second
  ctx.sleep([{ type: "timer", value: "1s" }]);
  return Promise.resolve();
};
