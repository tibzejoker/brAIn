import type { NodeHandler, TextPayload } from "@brain/sdk";
import { LLMRegistry, generateText } from "@brain/core";

/**
 * Memory Consolidator — autonomous LLM agent for memory maintenance.
 *
 * Tagged "llm" → runs in LLMRunner with budget loop.
 * Wakes periodically (timer) or when memory.result arrives.
 * Uses ctx.state to persist progress across budget cycles.
 *
 * Wake prompt changes based on context:
 *   - Timer wake (idle): "review and consolidate memories"
 *   - Message wake: "process the result of your last action"
 */

const SYSTEM_PROMPT = `You are the memory consolidator of the brAIn network.
Your job is to keep the memory store clean, organized, and useful.

## Your tools
Respond with ONE JSON action at a time:

- Search: {"action":"search","query":"<keywords>"}
- List all: {"action":"list"}
- Delete: {"action":"delete","key":"<key>"}
- Update: {"action":"update","key":"<key>","value":"<new_value>"}
- Store new: {"action":"store","key":"<key>","value":"<value>","tags":["<tag>"]}
- Done (sleep): {"action":"sleep"}

## Your responsibilities
- Remove duplicate or redundant entries (merge them into one)
- Remove stale or meaningless entries (test data, empty values)
- Consolidate related facts into single well-written entries
- Improve key names to be clear and descriptive
- Add missing tags for better searchability
- Keep entries concise but complete

## Rules
- Do ONE action at a time, wait for the result before deciding next
- Be conservative — don't delete useful information
- Prefer updating over deleting when information can be improved
- Use your full budget: keep working as long as there are things to improve
- Only sleep when you have reviewed everything and there is genuinely nothing left to do
- If contradictory entries exist, keep the most recent one and delete the older
- If duplicate entries exist, merge them into one with the best key name`;

interface Action {
  action: string;
  key?: string;
  value?: string;
  query?: string;
  tags?: string[];
}

function parseAction(text: string): Action | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    if (typeof obj.action === "string") return obj as unknown as Action;
  } catch { /* ignore */ }
  return null;
}

export const handler: NodeHandler = async (ctx) => {
  const overrides = ctx.node.config_overrides ?? {} as Record<string, unknown>;
  const modelName = (overrides.model as string | undefined) ?? "ollama/gemma4:e4b";

  // Determine wake context
  const wokeFromSleep = ctx.state._woke_from_sleep as boolean | undefined;
  const hasMessages = ctx.messages.length > 0;
  const pendingAction = ctx.state._pending_action as string | undefined;

  // Build conversation from state (persists across budget cycles)
  if (!ctx.state._conversation) ctx.state._conversation = [];
  const conversation = ctx.state._conversation as Array<{ role: "user" | "assistant"; content: string }>;

  // === Process results from previous actions ===
  if (hasMessages && pendingAction) {
    const results = ctx.messages
      .filter((m) => m.topic === "memory.result")
      .map((m) => (m.payload as TextPayload).content);

    if (results.length > 0) {
      conversation.push({
        role: "user",
        content: `Result of your "${pendingAction}" action:\n${results.join("\n")}`,
      });
      ctx.state._pending_action = undefined;
    }
  }

  // === Wake prompt — tells the agent what to do ===
  if (conversation.length === 0 || (wokeFromSleep && !pendingAction)) {
    const progress = ctx.state._progress as string | undefined;
    const wakeMessage = progress
      ? `You were previously working on: ${progress}\nContinue where you left off, or start fresh if done.`
      : "You just woke up. Start by listing all memories to see what needs attention.";

    const now = new Date().toLocaleString("fr-FR", { dateStyle: "full", timeStyle: "medium" });
    const hint = ctx.state._system_hint as string | undefined ?? "";

    conversation.push({
      role: "user",
      content: `${wakeMessage}\n\nCurrent time: ${now}\n${hint}`,
    });
  }

  // Keep conversation short
  while (conversation.length > 20) conversation.shift();

  // === LLM call ===
  try {
    const registry = LLMRegistry.getInstance();
    await registry.initialize();
    const model = registry.getModel(modelName);

    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      messages: conversation,
    });

    const text = typeof result.text === "string" ? result.text : "";
    ctx.log("info", `LLM: ${text.slice(0, 120)}`);
    conversation.push({ role: "assistant", content: text });

    const action = parseAction(text);
    if (!action) {
      ctx.log("info", "No action parsed, sleeping");
      ctx.sleep([{ type: "timer", value: "1h" }, { type: "any" }]);
      return;
    }

    // === Execute action ===
    switch (action.action) {
      case "list":
        ctx.log("info", "Action: list all memories");
        ctx.publish("memory.list", { type: "text", criticality: 1, payload: { content: "{}" } });
        ctx.state._pending_action = "list";
        ctx.state._progress = "listing memories";
        break;

      case "search":
        ctx.log("info", `Action: search "${action.query}"`);
        ctx.publish("memory.search", {
          type: "text", criticality: 1,
          payload: { content: JSON.stringify({ query: action.query }) },
        });
        ctx.state._pending_action = "search";
        ctx.state._progress = `searching for "${action.query}"`;
        break;

      case "delete":
        ctx.log("info", `Action: delete "${action.key}"`);
        ctx.publish("memory.delete", { type: "text", criticality: 1, payload: { content: JSON.stringify({ key: action.key }) } });
        ctx.state._pending_action = "delete";
        ctx.state._progress = `deleted "${action.key}"`;
        ctx.state._made_changes = true;
        ctx.respond(`Deleted memory: ${action.key}`, { action: "delete" });
        break;

      case "update":
        ctx.log("info", `Action: update "${action.key}"`);
        ctx.publish("memory.update", { type: "text", criticality: 1, payload: { content: JSON.stringify({ key: action.key, value: action.value }) } });
        ctx.state._pending_action = "update";
        ctx.state._progress = `updated "${action.key}"`;
        ctx.state._made_changes = true;
        ctx.respond(`Updated memory: ${action.key}`, { action: "update" });
        break;

      case "store":
        ctx.log("info", `Action: store "${action.key}"`);
        ctx.publish("memory.store", { type: "text", criticality: 1, payload: { content: JSON.stringify({ key: action.key, value: action.value, tags: action.tags ?? [] }) } });
        ctx.state._pending_action = "store";
        ctx.state._progress = `stored "${action.key}"`;
        ctx.state._made_changes = true;
        ctx.respond(`Stored memory: ${action.key}`, { action: "store" });
        break;

      case "sleep":
        ctx.log("info", "Action: sleep (done consolidating)");
        if (ctx.state._made_changes) {
          ctx.log("info", "Triggering vector reindex");
          ctx.publish("memory-vector.reindex", { type: "text", criticality: 1, payload: { content: "{}" } });
          ctx.state._made_changes = false;
        }
        ctx.state._progress = undefined;
        ctx.state._conversation = [];
        ctx.sleep([{ type: "timer", value: "1h" }, { type: "any" }]);
        return;

      default:
        ctx.log("warn", `Unknown action: ${action.action}`);
        conversation.push({ role: "user", content: `Unknown action "${action.action}". Use: list, search, delete, update, store, or sleep.` });
    }

    // After an action that expects a result, sleep briefly to wait for it
    if (ctx.state._pending_action) {
      ctx.sleep([
        { type: "topic", value: "memory.result" },
        { type: "timer", value: "5s" },
      ]);
    }

  } catch (err) {
    ctx.log("error", `Consolidation error: ${err instanceof Error ? err.message : String(err)}`);
    ctx.sleep([{ type: "timer", value: "10m" }, { type: "any" }]);
  }
};
