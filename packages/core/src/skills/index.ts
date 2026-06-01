export { SkillStore } from "./skill-store";
export type { SkillMeta, SkillFull, SkillRoots } from "./skill-store";

/** NATS request/reply subjects for the network-wide skills service. Dedicated
 *  `skills.rpc.*` namespace so it never collides with a pub/sub topic. */
export const SKILLS_SEARCH_SUBJECT = "skills.rpc.search";
export const SKILLS_LOAD_SUBJECT = "skills.rpc.load";
/** Write side: distil / edit a personal skill from a node (LLM-authored). */
export const SKILLS_SAVE_SUBJECT = "skills.rpc.save";
/** Delete a personal skill from a node. Personal-only (bundled stay safe). */
export const SKILLS_DELETE_SUBJECT = "skills.rpc.delete";
/** The whole catalog (name+description only) — the progressive-disclosure
 *  tier-1 a node injects so the model can pick, Claude/Hermes style. */
export const SKILLS_LIST_SUBJECT = "skills.rpc.list";
