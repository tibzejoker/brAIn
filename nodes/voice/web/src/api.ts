import type { Profile } from "./types";

export async function listProfiles(): Promise<Profile[]> {
  const res = await fetch("/api/profiles");
  if (!res.ok) throw new Error(`listProfiles: ${res.status}`);
  return res.json();
}

export async function renameProfile(id: string, name: string): Promise<Profile> {
  return patchProfile(id, { name });
}

export async function recolorProfile(id: string, color: string): Promise<Profile> {
  return patchProfile(id, { color });
}

export async function patchProfile(
  id: string,
  body: Partial<Pick<Profile, "name" | "color">>,
): Promise<Profile> {
  const res = await fetch(`/api/profiles/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`patchProfile: ${res.status}`);
  return res.json();
}

export async function deleteAllProfiles(): Promise<{ deleted: number }> {
  const res = await fetch("/api/profiles", { method: "DELETE" });
  if (!res.ok) throw new Error(`deleteAllProfiles: ${res.status}`);
  return res.json();
}

export async function deleteProfile(id: string): Promise<{ deleted: boolean }> {
  const res = await fetch(`/api/profiles/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`deleteProfile: ${res.status}`);
  return res.json();
}

export async function mergeProfiles(sourceId: string, targetId: string): Promise<Profile> {
  const res = await fetch("/api/profiles/merge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source_id: sourceId, target_id: targetId }),
  });
  if (!res.ok) throw new Error(`mergeProfiles: ${res.status}`);
  return res.json();
}

export type Voiceprint = {
  id: string;
  sample_count: number;
  created_at: string;
  updated_at: string;
};

export async function listVoiceprints(profileId: string): Promise<Voiceprint[]> {
  const res = await fetch(`/api/profiles/${profileId}/voiceprints`);
  if (!res.ok) throw new Error(`listVoiceprints: ${res.status}`);
  return res.json();
}

export async function extractVoiceprint(voiceprintId: string): Promise<Profile> {
  const res = await fetch(`/api/voiceprints/${voiceprintId}/extract`, { method: "POST" });
  if (!res.ok) throw new Error(`extractVoiceprint: ${res.status}`);
  return res.json();
}

export async function deleteVoiceprint(voiceprintId: string): Promise<{ deleted: boolean }> {
  const res = await fetch(`/api/voiceprints/${voiceprintId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`deleteVoiceprint: ${res.status}`);
  return res.json();
}

export async function controlEngine(
  action: "start" | "stop" | "status",
  sessionId?: string,
): Promise<{ state: string; session_id?: string }> {
  const res = await fetch("/api/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, session_id: sessionId }),
  });
  if (!res.ok) throw new Error(`controlEngine: ${res.status}`);
  return res.json();
}

export type Tuning = Record<string, number>;

export async function getTuning(): Promise<Tuning> {
  const res = await fetch("/api/tuning");
  if (!res.ok) throw new Error(`getTuning: ${res.status}`);
  return res.json();
}

export async function patchTuning(updates: Partial<Tuning>): Promise<Tuning> {
  const res = await fetch("/api/tuning", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`patchTuning: ${res.status}`);
  return res.json();
}
