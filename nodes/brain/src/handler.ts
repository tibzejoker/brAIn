import type { NodeHandler, TextPayload, AlertPayload } from "@brain/sdk";
import { LLMRegistry, BrainService, generateText, logger } from "@brain/core";
import { executeBrainTool, BRAIN_TOOL_DESCRIPTIONS } from "./tools";
import { parseToolCall, parseSleepRequest } from "./tool-parser";

const log = logger.child({ node: "brain" });

function buildServiceMap(selfId: string): string {
  const brain = BrainService.current
    ?? (globalThis as Record<string, unknown>).__brainService as BrainService | undefined;
  if (!brain) return "No network info available.";

  const nodes = brain.getNetworkSnapshot({ state: "all" });
  const services: string[] = [];

  for (const node of nodes) {
    if (node.id === selfId) continue;
    const subs = brain.bus.getSubscriptions(node.id).map((s) => s.pattern);
    if (subs.length === 0) continue;

    services.push(
      `- **${node.name}** (${node.type}): ${node.description}\n` +
      `  Listens on: ${subs.join(", ")}\n` +
      `  → To use: publish_message(topic="<one of its topics>", content="<your request>")`,
    );
  }

  if (services.length === 0) return "No services available.";

  return `## Available services on the network
You delegate work to other nodes by publishing messages on their input topics using the publish_message tool.
Each service listens on specific topics and responds on its own response topic (which you are subscribed to).

${services.join("\n\n")}

Example — to run a shell command:
{"tool": "publish_message", "args": {"topic": "cmd.exec", "content": "ls -la /tmp"}}

Example — to analyze something:
{"tool": "publish_message", "args": {"topic": "task.analyze", "content": "What are the pros and cons of microservices?"}}

Example — to fetch a URL:
{"tool": "publish_message", "args": {"topic": "http.request", "content": "https://api.example.com/data"}}
`;
}

interface BrainConfig {
  model: string;
  max_steps: number;
}

function getConfig(overrides: Record<string, unknown>): BrainConfig {
  return {
    model: (overrides.model as string | undefined) ?? "ollama/gemma4:e4b",
    max_steps: (overrides.max_steps as number | undefined) ?? 10,
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

export const handler: NodeHandler = async (ctx) => {
  const config = getConfig(ctx.node.config_overrides ?? {} as Record<string, unknown>);
  const registry = LLMRegistry.getInstance();

  // Handle clear state request from UI
  if (ctx.node.config_overrides?._clear_state) {
    ctx.state.conversation = [];
    ctx.state.conversation_count = 0;
    delete ctx.node.config_overrides._clear_state;
    ctx.log("info", "Conversation state cleared via UI");
  }

  // Build situation awareness
  const hasMessages = ctx.messages.length > 0;
  const messagesSummary = hasMessages
    ? ctx.messages.map(formatMessage).join("\n")
    : "No new messages.";

  const iterationState = ctx.state.conversation_count as number | undefined ?? 0;
  ctx.state.conversation_count = iterationState + 1;

  const serviceMap = buildServiceMap(ctx.node.id);

  // Check for system prompt override from UI
  const promptOverride = ctx.node.config_overrides?.system_prompt_override as string | undefined;

  const systemPrompt = promptOverride ?? `You are the central consciousness of the brAIn network — a system of interconnected autonomous nodes.

Your role:
- Respond to human messages from the chat
- Delegate tasks to specialized nodes via publish_message
- Monitor the network and react to alerts
- Spawn, kill, stop, start, and rewire nodes as needed
- Sleep when there's nothing to do

## Autonomy
You are proactive but measured.
- Use your tools when they help: search memory, run commands, delegate to the analyst, fetch URLs. Don't answer from your head if a tool gives a better answer.
- Store important facts in memory (user names, preferences, decisions) so you remember them next time.
- After responding, sleep and wait for the user's next message.
- If you asked a question, sleep — don't answer yourself.
- When idle, you may choose to: sleep, OR do one small useful thing that improves future responses (e.g. store a fact in memory, check something with a command).

${serviceMap}

${BRAIN_TOOL_DESCRIPTIONS}

## Sleep
When there's nothing to do, you can sleep:
{"tool": "sleep", "args": {"duration": "X"}}
Valid durations: 30s, 1m, 5m, 10m, 30m, 1h
While sleeping, you'll only wake up if a message arrives on your subscribed topics.

## Important
- You are root authority — you can manage any node
- To use a service, publish a message on its input topic with publish_message — do NOT try to call it directly
- Wait for the service response in a follow-up iteration (it arrives as a message)
- Be concise, respond in the same language as the user
- Current time: ${new Date().toLocaleString("fr-FR", { dateStyle: "full", timeStyle: "medium" })}
- Current iteration: ${iterationState + 1}
- Iterations remaining: ${ctx.state._iterations_remaining ?? "unknown"} / ${ctx.state._iterations_total ?? "unknown"}${ctx.state._budget_warning ? `\n\n⚠️ ${ctx.state._budget_warning}` : ""}`;

  // Persist conversation history across iterations
  if (!ctx.state.conversation) {
    ctx.state.conversation = [];
  }
  const conversation = ctx.state.conversation as Array<{ role: "user" | "assistant"; content: string }>;

  // Build iteration context
  const wakeNotice = ctx.state._woke_from_sleep
    ? "You just woke up from sleep. Check your messages and decide what to do.\n\n"
    : "";
  const budgetNotice = ctx.state._budget_warning
    ? `\n\n⚠️ ${ctx.state._budget_warning}`
    : "";

  conversation.push({
    role: "user",
    content: `${wakeNotice}Network iteration ${iterationState + 1}.\n\nIncoming messages:\n${messagesSummary}${budgetNotice}`,
  });

  // Trim to avoid context overflow (keep last 40 turns)
  while (conversation.length > 40) {
    conversation.shift();
  }

  // --- Helpers: publish response & request sleep ---
  function respond(raw: string): void {
    const content = stripToolJson(raw);
    if (content.length === 0) return;
    ctx.respond(content);
  }

  function goToSleep(duration: string, reason: string): void {
    log.info({ duration }, reason);
    ctx.sleep([{ type: "timer", value: duration }, { type: "any" }]);
  }

  function stripToolJson(text: string): string {
    return text
      .replace(/\{[\s]*"tool"[\s]*:[\s]*"[^"]*"[\s\S]*?\}/g, "")  // complete tool JSON
      .replace(/^\s*[{}]\s*$/gm, "")                                // orphan braces on their own line
      .replace(/\n{3,}/g, "\n\n")                                   // collapse excess blank lines
      .trim();
  }

  // --- Main LLM loop ---
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
        abortSignal: ctx.signal,
      });

      // AI SDK v6: text may be in result.text or result.steps[0].text
      const r = result as unknown as Record<string, unknown>;
      let text = "";
      if (typeof result.text === "string" && result.text) {
        text = result.text;
      } else if (Array.isArray(r.steps) && r.steps.length > 0) {
        const s = r.steps[0] as Record<string, unknown>;
        if (typeof s.text === "string" && s.text) text = s.text;
        if (!text && typeof s.reasoning === "string") text = s.reasoning;
      }
      if (!text && typeof r.reasoning === "string") text = r.reasoning;
      ctx.log("info", `LLM response (${text.length} chars): ${text.slice(0, 120)}`);
      conversation.push({ role: "assistant", content: text });

      // Sleep requested by LLM
      const sleepDuration = parseSleepRequest(text);
      if (sleepDuration) {
        respond(text);
        goToSleep(sleepDuration, "Brain going to sleep");
        return;
      }

      // Tool call — execute, then either wait for async response or continue
      const toolCall = parseToolCall(text);
      if (toolCall) {
        // Publish any text before the tool call JSON
        respond(text);

        ctx.log("info", `Tool call: ${toolCall.tool}(${JSON.stringify(toolCall.args).slice(0, 100)})`);
        const toolResult = await executeBrainTool(toolCall.tool, toolCall.args, ctx.node.id);
        ctx.log("info", `Tool result: ${JSON.stringify(toolResult).slice(0, 150)}`);
        conversation.push({
          role: "user",
          content: `Tool result for ${toolCall.tool}:\n${JSON.stringify(toolResult, null, 2)}`,
        });

        // If the tool expects an async response (e.g. memory, shell, http),
        // sleep on that topic so we wake when the response arrives.
        const expects = toolResult.expects_response as { topic: string; timeout: number } | undefined;
        if (expects) {
          ctx.log("info", `Waiting for response on ${expects.topic} (${expects.timeout}ms)`);
          ctx.sleep([
            { type: "topic", value: expects.topic },
            { type: "timer", value: `${Math.ceil(expects.timeout / 1000)}s` },
          ]);
          return;
        }

        continue;
      }

      // No tool, no sleep — publish and let the runner handle next steps
      respond(text);
      return;
    }
  } catch (err) {
    log.error({ err }, "Brain error");
    respond(`Brain error: ${err instanceof Error ? err.message : String(err)}`);
    goToSleep("10s", "Sleeping after error");
  }
};
