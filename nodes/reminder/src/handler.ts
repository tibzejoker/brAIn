import type { NodeHandler, TextPayload } from "@brain/sdk";

interface Reminder {
  id: string;
  fireAt: number;
  message: string;
  topic: string;
  criticality: number;
  from: string;
  createdAt: number;
}

/**
 * Parse delay string: "30s", "5m", "1h", "2h30m", "90s"
 * Also accepts plain numbers as seconds.
 */
function parseDelay(input: string): number | null {
  // Try compound: "2h30m", "1h15m30s"
  const compound = input.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  if (compound) {
    const h = parseInt(compound[1] || "0", 10);
    const m = parseInt(compound[2] || "0", 10);
    const s = parseInt(compound[3] || "0", 10);
    const total = h * 3600000 + m * 60000 + s * 1000;
    if (total > 0) return total;
  }

  // Plain number = seconds
  const num = parseInt(input, 10);
  if (!isNaN(num) && num > 0) return num * 1000;

  return null;
}

/**
 * Parse incoming message content.
 * Formats accepted:
 *   - JSON: {"delay": "30m", "message": "Do the thing", "topic": "alerts.reminder", "criticality": 5}
 *   - Simple: "30m Do the thing"
 *   - Natural: "in 5m check the server"
 */
function parseRequest(content: string): { delayMs: number; message: string; topic?: string; criticality?: number } | null {
  // Try JSON first
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.delay === "string" && typeof parsed.message === "string") {
      const delayMs = parseDelay(parsed.delay);
      if (delayMs) {
        return {
          delayMs,
          message: parsed.message,
          topic: parsed.topic as string | undefined,
          criticality: parsed.criticality as number | undefined,
        };
      }
    }
  } catch {
    // Not JSON
  }

  // Try "in Xm message" format
  const naturalMatch = content.match(/^in\s+(\d+[hms]+)\s+(.+)$/i);
  if (naturalMatch) {
    const delayMs = parseDelay(naturalMatch[1]);
    if (delayMs) return { delayMs, message: naturalMatch[2] };
  }

  // Try "Xm message" format
  const simpleMatch = content.match(/^(\d+[hms]+)\s+(.+)$/);
  if (simpleMatch) {
    const delayMs = parseDelay(simpleMatch[1]);
    if (delayMs) return { delayMs, message: simpleMatch[2] };
  }

  return null;
}

let counter = 0;

export const handler: NodeHandler = (ctx) => {
  // Initialize reminders state
  if (!ctx.state.reminders) {
    ctx.state.reminders = [];
  }
  const reminders = ctx.state.reminders as Reminder[];

  // Process new reminder requests
  for (const msg of ctx.messages) {
    const payload = msg.payload as TextPayload;
    const parsed = parseRequest(payload.content);

    if (!parsed) {
      ctx.respond(JSON.stringify({
        error: "Invalid reminder format",
        hint: 'Use: "30m Do the thing" or JSON {"delay":"30m","message":"..."}',
        received: payload.content.slice(0, 100),
      }));
      continue;
    }

    counter++;
    const reminder: Reminder = {
      id: `rem-${counter}-${Date.now()}`,
      fireAt: Date.now() + parsed.delayMs,
      message: parsed.message,
      topic: parsed.topic ?? "reminder.fire",
      criticality: parsed.criticality ?? 5,
      from: msg.from,
      createdAt: Date.now(),
    };

    reminders.push(reminder);

    const fireTime = new Date(reminder.fireAt).toLocaleTimeString("fr-FR", {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });

    ctx.log("info", `Reminder set: "${parsed.message}" fires at ${fireTime}`);
    ctx.respond(`Reminder recorded for ${fireTime}: "${parsed.message}"`);
  }

  // Check and fire due reminders (including overdue from restart)
  const now = Date.now();
  const due = reminders.filter((r) => r.fireAt <= now);
  const remaining = reminders.filter((r) => r.fireAt > now);
  ctx.state.reminders = remaining;

  for (const reminder of due) {
    ctx.log("info", `Firing reminder: "${reminder.message}"`);
    ctx.publish(reminder.topic, {
      type: "text",
      criticality: reminder.criticality,
      payload: {
        content: `⏰ Reminder: ${reminder.message}`,
      },
      metadata: {
        reminder_id: reminder.id,
        requested_by: reminder.from,
        created_at: reminder.createdAt,
      },
    });
  }

  return Promise.resolve();
};
