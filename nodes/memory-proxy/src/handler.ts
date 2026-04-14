import type { NodeHandler, TextPayload, Message } from "@brain/sdk";
import { LLMRegistry, generateText } from "@brain/core";

interface ProxyConfig {
  model: string;
  response_topic: string;
}

function getConfig(overrides: Record<string, unknown>): ProxyConfig {
  return {
    model: (overrides.model as string | undefined) ?? "ollama/gemma4:e4b",
    response_topic: (overrides.response_topic as string | undefined) ?? "mem.response",
  };
}

/**
 * Memory proxy — deterministic router + LLM for synthesis only.
 *
 * On mem.store: writes to BOTH KV and vector, no LLM needed.
 * On mem.ask: broadcasts search to BOTH backends, waits for results,
 *             then uses LLM to synthesize a human-readable answer.
 */
export const handler: NodeHandler = async (ctx) => {
  if (ctx.messages.length === 0) {
    ctx.sleep([{ type: "any" }]);
    return;
  }

  const config = getConfig(ctx.node.config_overrides ?? {} as Record<string, unknown>);

  // Separate messages by type
  const requests: Message[] = [];
  const kvResults: Message[] = [];
  const vecResults: Message[] = [];

  for (const msg of ctx.messages) {
    if (msg.topic === "memory.result") kvResults.push(msg);
    else if (msg.topic === "memory-vector.result") vecResults.push(msg);
    else requests.push(msg);
  }

  // === Phase 1: Handle backend results (we were waiting for them) ===
  if (kvResults.length > 0 || vecResults.length > 0) {
    const pendingQuery = ctx.state.pending_query as string | undefined;
    const pendingFrom = ctx.state.pending_from as string | undefined;

    if (pendingQuery) {
      // Synthesize results with LLM
      const kvData = kvResults.map((m) => (m.payload as TextPayload).content).join("\n");
      const vecData = vecResults.map((m) => (m.payload as TextPayload).content).join("\n");

      ctx.log("info", `Synthesizing: KV=${kvData.length}chars Vec=${vecData.length}chars`);

      try {
        const registry = LLMRegistry.getInstance();
        await registry.initialize();
        const model = registry.getModel(config.model);

        const result = await generateText({
          model,
          system: "You synthesize memory search results into a concise answer. Respond in the same language as the query. If no results found, say so clearly.",
          messages: [{
            role: "user",
            content: `Query: "${pendingQuery}"\n\nKey-value results:\n${kvData || "(empty)"}\n\nVector search results:\n${vecData || "(empty)"}\n\nSynthesize a clear answer.`,
          }],
        });

        const text = typeof result.text === "string" ? result.text : "";
        ctx.log("info", `Response: ${text.slice(0, 120)}`);

        ctx.publish(config.response_topic, {
          type: "text",
          criticality: 2,
          payload: { content: text || "No relevant memories found." },
          metadata: { query: pendingQuery, requested_by: pendingFrom },
        });
      } catch (err) {
        ctx.publish(config.response_topic, {
          type: "text",
          criticality: 3,
          payload: { content: `Memory synthesis error: ${err instanceof Error ? err.message : String(err)}` },
        });
      }

      ctx.state.pending_query = undefined;
      ctx.state.pending_from = undefined;
    }
  }

  // === Phase 2: Handle new requests ===
  for (const req of requests) {
    const p = req.payload as TextPayload;
    const content = p.content;

    if (req.topic === "mem.store") {
      // STORE: write to BOTH backends deterministically
      ctx.log("info", `Storing: ${content.slice(0, 80)}`);

      // Try to parse as JSON for KV, otherwise use content as value
      let key: string;
      let value: string;
      let tags: string[] = [];

      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        key = parsed.key ? String(parsed.key) : `auto_${Date.now()}`;
        value = parsed.value ? String(parsed.value) : content;
        tags = Array.isArray(parsed.tags) ? parsed.tags as string[] : [];
      } catch {
        // Natural language store — generate a key
        key = `fact_${Date.now()}`;
        value = content;
      }

      // Write to KV
      ctx.publish("memory.store", {
        type: "text",
        criticality: 2,
        payload: { content: JSON.stringify({ key, value, tags }) },
      });

      // Write to vector (for semantic search later)
      ctx.publish("memory-vector.store", {
        type: "text",
        criticality: 2,
        payload: { content: JSON.stringify({ text: `${key}: ${value}`, tags }) },
      });

      ctx.publish(config.response_topic, {
        type: "text",
        criticality: 1,
        payload: { content: `Stored: "${key}" = "${value.slice(0, 80)}"` },
      });

    } else if (req.topic === "mem.ask") {
      // ASK: LLM reformulates the question into search keywords, then broadcast
      ctx.log("info", `Query: ${content.slice(0, 80)}`);

      let kvQuery = content;
      let vecQuery = content;

      try {
        const registry = LLMRegistry.getInstance();
        await registry.initialize();
        const model = registry.getModel(config.model);

        const reformulation = await generateText({
          model,
          system: "Extract search keywords from the user question. ALWAYS produce keywords in English, even if the question is in another language. Keys and tags in the memory store are in English. Respond with ONLY a JSON object: {\"kv\": \"short english keywords for key-value search\", \"vec\": \"english natural language query for semantic vector search\"}. No explanation.",
          messages: [{ role: "user", content }],
        });

        const raw = typeof reformulation.text === "string" ? reformulation.text : "";
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as { kv?: string; vec?: string };
          if (parsed.kv) kvQuery = parsed.kv;
          if (parsed.vec) vecQuery = parsed.vec;
        }
      } catch {
        ctx.log("warn", "Query reformulation failed, using raw query");
      }

      ctx.log("info", `KV search: "${kvQuery}" | Vec search: "${vecQuery}"`);

      // Search KV
      ctx.publish("memory.search", {
        type: "text",
        criticality: 2,
        payload: { content: JSON.stringify({ query: kvQuery }) },
      });

      // Search vector
      ctx.publish("memory-vector.search", {
        type: "text",
        criticality: 2,
        payload: { content: JSON.stringify({ query: vecQuery, limit: 5 }) },
      });

      // Save pending query and wait for both results
      ctx.state.pending_query = content;
      ctx.state.pending_from = req.from;

      ctx.sleep([
        { type: "topic", value: "memory.result" },
        { type: "topic", value: "memory-vector.result" },
        { type: "timer", value: "10s" },
      ]);
      return;
    }
  }

  // Sleep until next request
  ctx.sleep([
    { type: "topic", value: "mem.ask" },
    { type: "topic", value: "mem.store" },
  ]);
};
