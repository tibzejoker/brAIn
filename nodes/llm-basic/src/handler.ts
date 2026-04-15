import type { NodeHandler, TextPayload, AlertPayload } from "@brain/sdk";
import { LLMRegistry, generateText } from "@brain/core";

function extractContent(payload: TextPayload | AlertPayload | Record<string, unknown>): string {
  if ("content" in payload && typeof payload.content === "string") return payload.content;
  if ("title" in payload && typeof payload.title === "string") {
    const desc = "description" in payload ? ` ${String(payload.description)}` : "";
    return `${payload.title}${desc}`;
  }
  return JSON.stringify(payload);
}

export const handler: NodeHandler = async (ctx) => {
  const overrides = ctx.node.config_overrides ?? {} as Record<string, unknown>;
  const model = (overrides.model as string | undefined) ?? "ollama/gemma4:e4b";
  const systemPrompt = (overrides.system_prompt as string | undefined) ?? "You are a helpful assistant. Respond concisely.";

  const registry = LLMRegistry.getInstance();

  // Persist conversation across iterations
  if (!ctx.state.conversation) ctx.state.conversation = [];
  const conversation = ctx.state.conversation as Array<{ role: "user" | "assistant"; content: string }>;

  for (const msg of ctx.messages) {
    conversation.push({
      role: "user",
      content: `[from:${msg.from} topic:${msg.topic}] ${extractContent(msg.payload as TextPayload)}`,
    });
  }

  while (conversation.length > 40) conversation.shift();

  try {
    await registry.initialize();
    ctx.log("info", `LLM call → ${model} (${conversation.length} turns)`);
    const llm = registry.getModel(model);
    const result = await generateText({ model: llm, system: systemPrompt, messages: conversation });

    const r = result as unknown as Record<string, unknown>;
    let content = "";
    if (typeof result.text === "string" && result.text) {
      content = result.text;
    } else if (Array.isArray(r.steps) && r.steps.length > 0) {
      const s = r.steps[0] as Record<string, unknown>;
      if (typeof s.text === "string" && s.text) content = s.text;
      if (!content && typeof s.reasoning === "string") content = s.reasoning;
    }
    if (!content && typeof r.reasoning === "string") content = r.reasoning;

    ctx.log("info", `LLM response (${content.length} chars): ${content.slice(0, 120)}`);
    conversation.push({ role: "assistant", content });

    ctx.respond(content, { model, usage: result.usage });
  } catch (err) {
    ctx.respond(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
};
