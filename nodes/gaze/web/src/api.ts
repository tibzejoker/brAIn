import type { DetectResponse, Faceprint, Profile, Tuning } from "./types";

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

export async function deleteProfile(id: string): Promise<{ deleted: boolean }> {
  const res = await fetch(`/api/profiles/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`deleteProfile: ${res.status}`);
  return res.json();
}

export async function deleteAllProfiles(): Promise<{ deleted: number }> {
  const res = await fetch("/api/profiles", { method: "DELETE" });
  if (!res.ok) throw new Error(`deleteAllProfiles: ${res.status}`);
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

export async function listFaceprints(profileId: string): Promise<Faceprint[]> {
  const res = await fetch(`/api/profiles/${profileId}/faceprints`);
  if (!res.ok) throw new Error(`listFaceprints: ${res.status}`);
  return res.json();
}

export async function extractFaceprint(faceprintId: string): Promise<Profile> {
  const res = await fetch(`/api/faceprints/${faceprintId}/extract`, { method: "POST" });
  if (!res.ok) throw new Error(`extractFaceprint: ${res.status}`);
  return res.json();
}

export async function deleteFaceprint(faceprintId: string): Promise<{ deleted: boolean }> {
  const res = await fetch(`/api/faceprints/${faceprintId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`deleteFaceprint: ${res.status}`);
  return res.json();
}

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

export async function detectBase64(
  dataUrl: string,
  remember: boolean,
): Promise<DetectResponse> {
  const res = await fetch("/api/detect/base64", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: dataUrl, remember }),
  });
  if (!res.ok) throw new Error(`detectBase64: ${res.status}`);
  return res.json();
}

export async function detectMultipart(
  blob: Blob,
  remember: boolean,
): Promise<DetectResponse> {
  const form = new FormData();
  form.append("image", blob, "frame.jpg");
  const res = await fetch(`/api/detect?remember=${remember}`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`detectMultipart: ${res.status}`);
  return res.json();
}
