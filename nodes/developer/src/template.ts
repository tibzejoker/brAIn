export const NODE_TEMPLATE_DOCS = `
## How to create a brAIn node

A node is a package with 3 files in a directory:

### 1. config.json
\`\`\`json
{
  "name": "my-node-name",
  "description": "What this node does in one sentence",
  "tags": ["relevant", "tags"],
  "default_authority": 0,
  "default_priority": 1,
  "default_subscriptions": [],
  "supports_transport": ["process"]
}
\`\`\`

### 2. package.json
\`\`\`json
{
  "name": "@brain/node-my-node-name",
  "version": "0.1.0",
  "private": true,
  "main": "dist/handler.js",
  "scripts": { "build": "tsc" },
  "dependencies": { "@brain/sdk": "workspace:*" },
  "devDependencies": { "typescript": "^5.4.0" }
}
\`\`\`

If you need @brain/core (for LLMRegistry, generateText, etc.), add it to dependencies too.

### 3. src/handler.ts
\`\`\`typescript
import type { NodeHandler, TextPayload } from "@brain/sdk";

export const handler: NodeHandler = async (ctx) => {
  // ctx.messages — array of unread messages
  // ctx.readMessages(opts) — read with filters
  // ctx.publish(topic, msg) — publish a message
  // ctx.subscribe(topic) — subscribe to a topic
  // ctx.sleep([conditions]) — sleep until condition met
  // ctx.state — persistent state between iterations
  // ctx.node — info about this node (id, name, config_overrides, etc.)

  if (ctx.messages.length === 0) {
    ctx.sleep([{ type: "any" }]);
    return;
  }

  for (const msg of ctx.messages) {
    const payload = msg.payload as TextPayload;
    // Process payload.content...

    ctx.publish("output.topic", {
      type: "text",
      criticality: 0,
      payload: { content: "result" },
    });
  }
};
\`\`\`

### 4. tsconfig.json
\`\`\`json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src"]
}
\`\`\`

## Important rules
- The handler MUST be exported as \`export const handler: NodeHandler\`
- If the handler does not use await, return Promise.resolve() instead of using async
- Never use console.log — use pino if logging is needed
- config_overrides from ctx.node.config_overrides can be used for runtime config
- A node must NOT subscribe to its own output topics (the framework prevents self-loops)
- Keep it minimal — one file handler, simple logic
`;
