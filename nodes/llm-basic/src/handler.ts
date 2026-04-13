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
    model: (overrides.model as string | undefined) ?? "ollama/gemma4:e4b",
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

  // Persist conversation across iterations
  if (!ctx.state.conversation) {
    ctx.state.conversation = [];
  }
  const conversation = ctx.state.conversation as Array<{ role: "user" | "assistant"; content: string }>;

  // Add new incoming messages to history
  for (const msg of ctx.messages) {
    conversation.push({
      role: "user",
      content: `[from:${msg.from} topic:${msg.topic} crit:${msg.criticality}] ${extractContent(msg.payload as TextPayload)}`,
    });
  }

  // Trim to avoid context overflow
  while (conversation.length > 40) {
    conversation.shift();
  }

  try {
    await registry.initialize();
    ctx.log("info", `LLM call → ${config.model} (${conversation.length} turns)`);
    const model = registry.getModel(config.model);
    const result = await generateText({
      model,
      system: config.system_prompt,
      messages: conversation,
      maxOutputTokens: config.max_tokens,
      temperature: config.temperature,
    });

    const resultText = typeof result.text === "string" ? result.text : "";
    const reasoning = (result as unknown as { reasoning?: string }).reasoning;
    const resultReasoning = typeof reasoning === "string" ? reasoning : "";
    const content = resultText || resultReasoning || "";
    ctx.log("info", `LLM response (${content.length} chars): ${content.slice(0, 120)}`);

    // Store assistant response in conversation history
    conversation.push({ role: "assistant", content });

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
