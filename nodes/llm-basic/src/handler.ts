import type { NodeHandler, TextPayload, AlertPayload } from "@brain/sdk";
import { LLMRegistry, generateText } from "@brain/core";

interface LLMConfig {
  model: string;
  system_prompt: string;
  response_topic: string;
  max_tokens: number;
  temperature: number;
}

function getConfig(overrides: Record<string, unknown>): LLMConfig {
  return {
    model: (overrides.model as string | undefined) ?? "anthropic/claude-haiku-4-5-20251001",
    system_prompt: (overrides.system_prompt as string | undefined) ?? "You are a helpful assistant. Respond concisely.",
    response_topic: (overrides.response_topic as string | undefined) ?? "llm.response",
    max_tokens: (overrides.max_tokens as number | undefined) ?? 1024,
    temperature: (overrides.temperature as number | undefined) ?? 0.7,
  };
}

function extractContent(payload: TextPayload | AlertPayload | Record<string, unknown>): string {
  if ("content" in payload && typeof payload.content === "string") {
    return payload.content;
  }
  if ("title" in payload && typeof payload.title === "string") {
    const desc = "description" in payload ? ` ${String(payload.description)}` : "";
    return `${payload.title}${desc}`;
  }
  return JSON.stringify(payload);
}

export const handler: NodeHandler = async (ctx) => {
  if (ctx.messages.length === 0) {
    ctx.sleep([{ type: "any" }]);
    return;
  }

  const config = getConfig(ctx.node.config_overrides ?? {} as Record<string, unknown>);
  const registry = LLMRegistry.getInstance();

  // Build conversation from incoming messages
  const userMessages = ctx.messages.map((msg) => ({
    role: "user" as const,
    content: `[from:${msg.from} topic:${msg.topic} crit:${msg.criticality}] ${extractContent(msg.payload as TextPayload)}`,
  }));

  try {
    await registry.initialize();
    const model = registry.getModel(config.model);

    const result = await generateText({
      model,
      system: config.system_prompt,
      messages: userMessages,
      maxOutputTokens: config.max_tokens,
      temperature: config.temperature,
    });

    // Some models (e.g. gemma4:e2b) may put output in reasoning instead of text
    const reasoning = (result as unknown as { reasoning?: string }).reasoning;
    const content = result.text || reasoning || "";

    ctx.publish(config.response_topic, {
      type: "text",
      criticality: Math.max(...ctx.messages.map((m) => m.criticality)),
      payload: { content },
      metadata: {
        model: config.model,
        usage: result.usage,
        input_messages: ctx.messages.length,
        has_reasoning: Boolean(reasoning),
      },
    });
  } catch (err) {
    ctx.publish(config.response_topic, {
      type: "alert",
      criticality: 5,
      payload: {
        title: "LLM call failed",
        description: err instanceof Error ? err.message : String(err),
      },
    });
  }
};
