import type { NodeHandler, TextPayload } from "@brain/sdk";

/**
 * Chat node handler.
 * The actual chat UI is served from ui/index.html.
 * This handler listens for responses from other nodes and keeps them
 * in state so the UI can poll them.
 */
export const handler: NodeHandler = (ctx) => {
  if (ctx.messages.length === 0) {
    ctx.sleep([{ type: "any" }]);
    return Promise.resolve();
  }

  // Store incoming responses in state for the UI to read
  const history = (ctx.state.history ?? []) as Array<{
    from: string;
    topic: string;
    content: string;
    timestamp: number;
  }>;

  for (const msg of ctx.messages) {
    const payload = msg.payload as TextPayload;
    history.push({
      from: msg.from,
      topic: msg.topic,
      content: payload.content,
      timestamp: msg.timestamp,
    });
  }

  // Keep last 100 messages
  if (history.length > 100) {
    ctx.state.history = history.slice(-100);
  } else {
    ctx.state.history = history;
  }

  return Promise.resolve();
};
