import type { Profile } from "./types";

export async function listProfiles(): Promise<Profile[]> {
  const res = await fetch("/api/profiles");
  if (!res.ok) throw new Error(`listProfiles: ${res.status}`);
  return res.json();
}

export async function renameProfile(id: string, name: string): Promise<Profile> {
  const res = await fetch(`/api/profiles/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`renameProfile: ${res.status}`);
  return res.json();
}

export async function deleteAllProfiles(): Promise<{ deleted: number }> {
  const res = await fetch("/api/profiles", { method: "DELETE" });
  if (!res.ok) throw new Error(`deleteAllProfiles: ${res.status}`);
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
