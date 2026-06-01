/**
 * Skills (procedural-memory) library endpoints. Read spans every source
 * (root + lib-bundled + personal); writes only touch personal skills.
 */
import { request } from "./request";

export interface SkillInfo {
  name: string;
  description: string;
  version: string;
  source: string;
}

export interface SkillContent extends SkillInfo {
  content: string;
  /** Only personal skills are editable / deletable; bundled are read-only. */
  editable?: boolean;
}

export function getSkills(): Promise<SkillInfo[]> {
  return request("/skills");
}

export function getSkill(name: string): Promise<SkillContent> {
  return request(`/skills/${encodeURIComponent(name)}`);
}

export function saveSkill(name: string, content: string): Promise<SkillContent> {
  return request("/skills", { method: "POST", body: JSON.stringify({ name, content }) });
}

export function deleteSkill(name: string): Promise<{ deleted: string }> {
  return request(`/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
}
