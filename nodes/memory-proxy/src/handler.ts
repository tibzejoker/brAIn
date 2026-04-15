import type { NodeHandler, TextPayload, Message } from "@brain/sdk";
import { LLMRegistry, generateText } from "@brain/core";

function getModel(overrides: Record<string, unknown>): string {
  return (overrides.model as string | undefined) ?? "ollama/gemma4:e4b";
}

/**
 * Memory proxy — reactive gateway to the memory subsystem.
 *
 * On mem.store: writes to BOTH KV and vector backends.
 * On mem.ask: broadcasts search to BOTH, waits for results, synthesizes answer.
 *
 * Pure ServiceRunner — no maintenance, no autonomous behavior.
 */
export const handler: NodeHandler = async (ctx) => {
  if (ctx.messages.length === 0) return;

  const modelName = getModel(ctx.node.config_overrides ?? {} as Record<string, unknown>);

  // Sort messages by type
  const requests: Message[] = [];
  const kvResults: Message[] = [];
  const vecResults: Message[] = [];

  for (const msg of ctx.messages) {
    if (msg.topic === "memory.result") kvResults.push(msg);
    else if (msg.topic === "memory-vector.result") vecResults.push(msg);
    else requests.push(msg);
  }

  // === Handle backend results (we were waiting for them) ===
  if (kvResults.length > 0 || vecResults.length > 0) {
    const pendingQuery = ctx.state.pending_query as string | undefined;
    const pendingFrom = ctx.state.pending_from as string | undefined;

    if (pendingQuery) {
      // Accumulate results across wakes (messages are read-once)
      if (kvResults.length > 0) {
        ctx.state._kv_data = kvResults.map((m) => (m.payload as TextPayload).content).join("\n");
      }
      if (vecResults.length > 0) {
        ctx.state._vec_data = vecResults.map((m) => (m.payload as TextPayload).content).join("\n");
      }

      const hasKv = typeof ctx.state._kv_data === "string";
      const hasVec = typeof ctx.state._vec_data === "string";

      // Wait for both backends (max 3 re-sleeps of 3s)
      if (!hasKv || !hasVec) {
        const waited = (ctx.state._wait_count as number | undefined) ?? 0;
        if (waited < 3) {
          ctx.state._wait_count = waited + 1;
          ctx.log("info", `Waiting for ${!hasKv ? "KV" : "vector"} results (${waited + 1}/3)`);
          ctx.sleep([
            { type: "topic", value: !hasKv ? "memory.result" : "memory-vector.result" },
            { type: "timer", value: "3s" },
          ]);
          return;
        }
        ctx.log("info", "Proceeding with partial results");
      }

      // Synthesize
      const kvData = (ctx.state._kv_data as string | undefined) ?? "";
      const vecData = (ctx.state._vec_data as string | undefined) ?? "";
      ctx.log("info", `Synthesizing: KV=${kvData.length}chars Vec=${vecData.length}chars`);

      try {
        const registry = LLMRegistry.getInstance();
        await registry.initialize();
        const model = registry.getModel(modelName);

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
        ctx.respond(text || "No relevant memories found.", { query: pendingQuery, requested_by: pendingFrom });
      } catch (err) {
        ctx.respond(`Memory synthesis error: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Cleanup
      ctx.state.pending_query = undefined;
      ctx.state.pending_from = undefined;
      ctx.state._kv_data = undefined;
      ctx.state._vec_data = undefined;
      ctx.state._wait_count = undefined;
    }
  }

  // === Handle new requests ===
  for (const req of requests) {
    const content = (req.payload as TextPayload).content;

    if (req.topic === "mem.store") {
      ctx.log("info", `Storing: ${content.slice(0, 80)}`);

      let key: string;
      let value: string;
      let tags: string[] = [];

      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        key = parsed.key ? String(parsed.key) : `auto_${Date.now()}`;
        value = parsed.value ? String(parsed.value) : content;
        tags = Array.isArray(parsed.tags) ? parsed.tags as string[] : [];
      } catch {
        key = `fact_${Date.now()}`;
        value = content;
      }

      ctx.publish("memory.store", {
        type: "text", criticality: 2,
        payload: { content: JSON.stringify({ key, value, tags }) },
      });
      ctx.publish("memory-vector.store", {
        type: "text", criticality: 2,
        payload: { content: JSON.stringify({ text: `${key}: ${value}`, tags }) },
      });
      ctx.respond(`Stored: "${key}" = "${value.slice(0, 80)}"`);

    } else if (req.topic === "mem.ask") {
      ctx.log("info", `Query: ${content.slice(0, 80)}`);

      let kvQuery = content;
      let vecQuery = content;

      try {
        const registry = LLMRegistry.getInstance();
        await registry.initialize();
        const model = registry.getModel(modelName);

        const reformulation = await generateText({
          model,
          system: "Extract search keywords from the user question. ALWAYS produce keywords in English. Respond with ONLY a JSON object: {\"kv\": \"short keywords\", \"vec\": \"natural language query\"}. No explanation.",
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

      ctx.log("info", `KV: "${kvQuery}" | Vec: "${vecQuery}"`);

      ctx.publish("memory.search", {
        type: "text", criticality: 2,
        payload: { content: JSON.stringify({ query: kvQuery }) },
      });
      ctx.publish("memory-vector.search", {
        type: "text", criticality: 2,
        payload: { content: JSON.stringify({ query: vecQuery, limit: 5 }) },
      });

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
};
