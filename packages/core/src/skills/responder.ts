import {
  SKILLS_SEARCH_SUBJECT,
  SKILLS_LOAD_SUBJECT,
  SKILLS_SAVE_SUBJECT,
  SKILLS_DELETE_SUBJECT,
  SKILLS_LIST_SUBJECT,
} from "./index";
import type { SkillStore } from "./skill-store";

type Responder = {
  respondToRequests?: (subject: string, handler: (p: unknown) => unknown) => void;
};

/**
 * Register the network-wide skills request/reply responders on `bus`, so any
 * node (local or remote brain-agent) resolves `ctx.skills.*` against this one
 * shared library. Returns `true` once wired; `false` (no-op) on a bus without
 * `respondToRequests` (the in-memory test fixture) or before NATS is connected
 * — callers retry. `store()` is invoked per request so the roots can be set in
 * any order; `liveTypes()` scopes `requires_node` skills to spawned node types.
 */
export function registerSkillsResponder(
  bus: unknown,
  store: () => SkillStore,
  liveTypes: () => Set<string>,
): boolean {
  const b = bus as Responder;
  if (typeof b.respondToRequests !== "function") return false;
  const respond = b.respondToRequests.bind(b);
  try {
    respond(SKILLS_SEARCH_SUBJECT, (p) => {
      const { query, limit } = (p ?? {}) as { query?: string; limit?: number };
      // Semantic (embeddings) with keyword fallback; the handler may return a
      // Promise — respondToRequests awaits it.
      return store().searchSemantic(String(query ?? ""), typeof limit === "number" ? limit : 5, liveTypes());
    });
    respond(SKILLS_LOAD_SUBJECT, (p) => {
      const { name } = (p ?? {}) as { name?: string };
      return store().load(String(name ?? ""));
    });
    respond(SKILLS_LIST_SUBJECT, () => store().list(liveTypes()));
    respond(SKILLS_SAVE_SUBJECT, (p) => {
      const { name, content } = (p ?? {}) as { name?: string; content?: string };
      return store().savePersonal(String(name ?? ""), String(content ?? ""));
    });
    respond(SKILLS_DELETE_SUBJECT, (p) => {
      const { name } = (p ?? {}) as { name?: string };
      return store().deletePersonal(String(name ?? ""));
    });
    return true;
  } catch {
    return false; // NATS not connected yet; the caller retries.
  }
}
