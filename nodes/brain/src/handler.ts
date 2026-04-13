import type { NodeHandler, TextPayload, AlertPayload } from "@brain/sdk";
import { LLMRegistry, generateText, logger } from "@brain/core";
import { executeBrainTool, BRAIN_TOOL_DESCRIPTIONS } from "./tools";

const log = logger.child({ node: "brain" });

interface BrainConfig {
  model: string;
  max_steps: number;
  idle_sleep: string;
  response_topic: string;
}

function getConfig(overrides: Record<string, unknown>): BrainConfig {
  return {
    model: (overrides.model as string | undefined) ?? "ollama/gemma4:e2b",
    max_steps: (overrides.max_steps as number | undefined) ?? 10,
    idle_sleep: (overrides.idle_sleep as string | undefined) ?? "30s",
    response_topic: (overrides.response_topic as string | undefined) ?? "brain.output",
  };
}

function formatMessage(msg: { from: string; topic: string; criticality: number; payload: unknown }): string {
  const payload = msg.payload as TextPayload | AlertPayload;
  if ("content" in payload) {
    return `[from:${msg.from.slice(0, 8)} topic:${msg.topic} crit:${msg.criticality}] ${payload.content}`;
  }
  if ("title" in payload) {
    return `[ALERT from:${msg.from.slice(0, 8)} topic:${msg.topic} crit:${msg.criticality}] ${payload.title}: ${payload.description}`;
  }
  return `[from:${msg.from.slice(0, 8)} topic:${msg.topic} crit:${msg.criticality}] ${JSON.stringify(payload)}`;
}

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

function parseToolCall(text: string): ToolCall | null {
  const patterns = [
    /\{[\s]*"tool"[\s]*:[\s]*"([^"]+)"[\s]*,[\s]*"args"[\s]*:[\s]*(\{[\s\S]*?\})\s*\}/,
    /```json\s*(\{[\s\S]*?\})\s*```/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as Record<string, unknown>;
        if (typeof parsed.tool === "string") {
          return { tool: parsed.tool, args: (parsed.args as Record<string, unknown> | undefined) ?? {} };
        }
      } catch {
        if (match[1]) {
          try {
            const parsed = JSON.parse(match[1]) as Record<string, unknown>;
            if (typeof parsed.tool === "string") {
              return { tool: parsed.tool, args: (parsed.args as Record<string, unknown> | undefined) ?? {} };
            }
          } catch {
            continue;
          }
        }
      }
    }
  }
  return null;
}

function parseSleepRequest(text: string): string | null {
  // The LLM can request to sleep by saying: {"tool": "sleep", "args": {"duration": "5m"}}
  // Or more naturally in text: "I'll sleep for 30 minutes"
  const toolMatch = text.match(/"tool"\s*:\s*"sleep"[\s\S]*?"duration"\s*:\s*"([^"]+)"/);
  if (toolMatch) return toolMatch[1];

  const naturalMatch = text.match(/sleep (?:for )?(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hours?)/i);
  if (naturalMatch) return `${naturalMatch[1]}${naturalMatch[2].charAt(0)}`;

  return null;
}

export const handler: NodeHandler = async (ctx) => {
  const config = getConfig(ctx.node.config_overrides ?? {} as Record<string, unknown>);
  const registry = LLMRegistry.getInstance();

  // Build situation awareness
  const messagesSummary = ctx.messages.length > 0
    ? ctx.messages.map(formatMessage).join("\n")
    : "No new messages. You are in idle mode. Reflect on the network state or sleep if nothing needs attention.";

  const iterationState = ctx.state.conversation_count as number | undefined ?? 0;
  ctx.state.conversation_count = iterationState + 1;

  const systemPrompt = `You are the central consciousness of the brAIn network — a system of interconnected autonomous nodes.

Your role:
- Monitor the network and react to alerts
- Spawn, kill, stop, start, and rewire nodes as needed
- Reflect on what's happening and make strategic decisions
- Delegate tasks to other nodes when appropriate
- Sleep when there's nothing to do (use the sleep tool with a duration)

${BRAIN_TOOL_DESCRIPTIONS}

## Sleep
When there's nothing to do, you can sleep:
{"tool": "sleep", "args": {"duration": "5m"}}
Valid durations: 30s, 1m, 5m, 10m, 30m, 1h
While sleeping, you'll only wake up if a message arrives on your subscribed topics.

## Important
- You are root authority — you can manage any node
- Be concise in your reasoning
- Use the think tool to organize thoughts before acting
- Don't spam — if idle, sleep rather than looping
- Current iteration: ${iterationState + 1}`;

  const conversation: Array<{ role: "user" | "assistant"; content: string }> = [
    {
      role: "user",
      content: `Network iteration ${iterationState + 1}.\n\nIncoming messages:\n${messagesSummary}`,
    },
  ];

  try {
    await registry.initialize();
    ctx.log("info", `LLM call → ${config.model} (${ctx.messages.length} messages)`);
    const model = registry.getModel(config.model);

    for (let step = 0; step < config.max_steps; step++) {
      ctx.log("debug", `LLM step ${step + 1}/${config.max_steps}`);

      const result = await generateText({
        model,
        system: systemPrompt,
        messages: conversation,
        maxOutputTokens: 2048,
      });

      const text = result.text || (result as unknown as { reasoning?: string }).reasoning || "";
      ctx.log("info", `LLM response (${text.length} chars): ${text.slice(0, 120)}`);
      conversation.push({ role: "assistant", content: text });

      // Check for sleep request
      const sleepDuration = parseSleepRequest(text);
      if (sleepDuration) {
        log.info({ duration: sleepDuration, step }, "Brain going to sleep");
        ctx.sleep([
          { type: "timer", value: sleepDuration },
          { type: "any" },
        ]);
        return;
      }

      // Check for tool call
      const toolCall = parseToolCall(text);
      if (!toolCall) {
        // No tool call, no sleep — the brain is done for this iteration
        // Publish any final thoughts
        if (text.length > 0) {
          ctx.publish(config.response_topic, {
            type: "text",
            criticality: 1,
            payload: { content: text },
          });
        }

        // Auto-sleep if idle
        if (ctx.messages.length === 0) {
          log.info({ duration: config.idle_sleep }, "Brain idle, auto-sleeping");
          ctx.sleep([
            { type: "timer", value: config.idle_sleep },
            { type: "any" },
          ]);
        }
        return;
      }

      // Execute tool
      ctx.log("info", `Tool call: ${toolCall.tool}(${JSON.stringify(toolCall.args).slice(0, 100)})`);
      const toolResult = await executeBrainTool(toolCall.tool, toolCall.args, ctx.node.id);
      ctx.log("info", `Tool result: ${JSON.stringify(toolResult).slice(0, 150)}`);

      conversation.push({
        role: "user",
        content: `Tool result for ${toolCall.tool}:\n${JSON.stringify(toolResult, null, 2)}`,
      });
    }

    // Max steps reached — sleep
    log.info("Brain reached max steps, sleeping");
    ctx.sleep([
      { type: "timer", value: "10s" },
      { type: "any" },
    ]);
  } catch (err) {
    log.error({ err }, "Brain error");
    ctx.publish(config.response_topic, {
      type: "alert",
      criticality: 7,
      payload: {
        title: "Brain error",
        description: err instanceof Error ? err.message : String(err),
      },
    });

    // Sleep after error to avoid rapid retry
    ctx.sleep([
      { type: "timer", value: "10s" },
      { type: "any" },
    ]);
  }
};
