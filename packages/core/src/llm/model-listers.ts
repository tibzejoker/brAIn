/**
 * Live model-discovery helpers, one per provider family.
 *
 * Each provider exposes a "list models" endpoint we can hit to populate
 * the real model catalog instead of a hardcoded snapshot. These also
 * serve as the availability probe — if the call returns 200 we know
 * the API key + base URL are good, and we get the real models for free.
 *
 * Most providers (Mistral, xAI, Groq, Cerebras, DeepSeek, Together,
 * Fireworks, OpenRouter, LM Studio, vLLM, LocalAI) are OpenAI-API-
 * compatible — they all reuse `listModelsOpenAIStyle`. The dedicated
 * helpers below cover the few that aren't.
 */

const LIST_TIMEOUT_MS = 8_000;

export async function listModelsOpenAI(baseURL: string, apiKey: string): Promise<{ models: string[] }> {
  const { models } = await listModelsOpenAIStyle(baseURL, apiKey);
  // OpenAI ships embeddings, TTS, image, audio and other model families
  // on the same endpoint that aren't usable via generateText. Filter to
  // chat-capable identifiers.
  return { models: models.filter((id) => /^(gpt-|o[134]|chatgpt-)/.test(id)) };
}

/** Generic OpenAI-style `/models` lister — `GET <base>/models` with
 *  `Authorization: Bearer <key>`. Returns the raw list (no filtering);
 *  the caller can post-filter if its API spits out non-chat entries. */
export async function listModelsOpenAIStyle(baseURL: string, apiKey: string): Promise<{ models: string[] }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIST_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await safeText(res)}`);
    const body = (await res.json()) as { data?: { id: string }[] };
    return { models: (body.data ?? []).map((m) => m.id).sort() };
  } finally {
    clearTimeout(timer);
  }
}

export async function listModelsCohere(baseURL: string, apiKey: string): Promise<{ models: string[] }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIST_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseURL.replace(/\/+$/, "")}/v1/models?page_size=1000`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await safeText(res)}`);
    const body = (await res.json()) as { models?: { name: string; endpoints?: string[] }[] };
    const ids = (body.models ?? [])
      .filter((m) => !m.endpoints || m.endpoints.includes("chat"))
      .map((m) => m.name)
      .sort();
    return { models: ids };
  } finally {
    clearTimeout(timer);
  }
}

export async function listModelsAnthropic(baseURL: string, apiKey: string): Promise<{ models: string[] }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIST_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseURL.replace(/\/+$/, "")}/v1/models`, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await safeText(res)}`);
    const body = (await res.json()) as { data?: { id: string }[] };
    return { models: (body.data ?? []).map((m) => m.id).sort() };
  } finally {
    clearTimeout(timer);
  }
}

export async function listModelsGoogle(baseURL: string, apiKey: string): Promise<{ models: string[] }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIST_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${baseURL.replace(/\/+$/, "")}/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      { signal: ctrl.signal },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await safeText(res)}`);
    const body = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    // Google returns names like "models/gemini-1.5-flash" — trim the prefix.
    // Also drop entries that don't support generateContent (embeddings etc.).
    const ids = (body.models ?? [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => n.length > 0)
      .sort();
    return { models: ids };
  } finally {
    clearTimeout(timer);
  }
}

async function safeText(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 200); } catch { return ""; }
}
