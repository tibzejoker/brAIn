import type { Intent, Person, TimelineSnapshot } from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export async function getHealth(): Promise<{ status: string; voice_up: boolean; gaze_up: boolean; persons: number }> {
  return json(await fetch("/api/health"));
}

export async function listPersons(): Promise<Person[]> {
  return json(await fetch("/api/persons"));
}

export async function createPerson(body: Partial<Person>): Promise<Person> {
  return json(await fetch("/api/persons", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

export async function patchPerson(id: string, body: Partial<Person>): Promise<Person> {
  return json(await fetch(`/api/persons/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

export async function deletePerson(id: string): Promise<void> {
  await fetch(`/api/persons/${id}`, { method: "DELETE" });
}

export async function listVoiceProfiles(): Promise<{ id: string; name: string; color: string }[]> {
  return json(await fetch("/api/voice/profiles"));
}

export async function listGazeProfiles(): Promise<{ id: string; name: string; color: string }[]> {
  return json(await fetch("/api/gaze/profiles"));
}

export async function renameVoiceProfile(id: string, name: string): Promise<void> {
  await fetch(`/api/voice/profiles/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function renameGazeProfile(id: string, name: string): Promise<void> {
  await fetch(`/api/gaze/profiles/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function listIntents(sinceId?: number): Promise<Intent[]> {
  const u = new URL("/api/intents", window.location.origin);
  if (sinceId !== undefined) u.searchParams.set("since_id", String(sinceId));
  return json(await fetch(u.toString()));
}

export async function clearIntents(): Promise<void> {
  await fetch("/api/intents", { method: "DELETE" });
}

export async function getTimeline(window_s = 60): Promise<TimelineSnapshot> {
  return json(await fetch(`/api/timeline?window_s=${window_s}`));
}

export function openIntentStream(onIntent: (i: Intent) => void): WebSocket {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${window.location.host}/ws/intents`);
  ws.onmessage = (ev) => {
    try {
      onIntent(JSON.parse(ev.data) as Intent);
    } catch (e) {
      console.error("bad intent payload", e);
    }
  };
  return ws;
}
