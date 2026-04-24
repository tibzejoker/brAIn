import { getHealth } from "./api";
import { IntentsFeed } from "./intents";
import { PersonsPanel } from "./persons";
import { TimelineView } from "./timeline";

declare const __VOICE_WEB__: string;
declare const __GAZE_WEB__: string;

async function main(): Promise<void> {
  const personsHost = document.getElementById("persons-list");
  const timelineHost = document.getElementById("timeline-svg");
  const intentsHost = document.getElementById("intents-list");
  const healthEl = document.getElementById("health");
  const newBtn = document.getElementById("person-new");
  const clearBtn = document.getElementById("intents-clear");

  if (!personsHost || !timelineHost || !intentsHost || !healthEl || !newBtn || !clearBtn) {
    throw new Error("missing required DOM nodes");
  }
  const healthOut: HTMLElement = healthEl;

  const voiceLink = document.getElementById("voice-link") as HTMLAnchorElement | null;
  const gazeLink = document.getElementById("gaze-link") as HTMLAnchorElement | null;
  if (voiceLink) voiceLink.href = __VOICE_WEB__;
  if (gazeLink) gazeLink.href = __GAZE_WEB__;

  const persons = new PersonsPanel(personsHost);
  const timeline = new TimelineView(timelineHost, () => persons.all);
  const intents = new IntentsFeed(intentsHost, () => persons.all);

  persons.onChanged(() => {
    timeline.refresh();
  });

  newBtn.addEventListener("click", () => persons.promptCreate());
  clearBtn.addEventListener("click", () => intents.clear());

  await persons.refresh();
  await intents.start();

  async function updateHealth(): Promise<void> {
    try {
      const h = await getHealth();
      healthOut.innerHTML =
        `<span class="dot ${h.voice_up ? "up" : "down"}" title="voice"></span>voice ` +
        `<span class="dot ${h.gaze_up ? "up" : "down"}" title="gaze"></span>gaze ` +
        `<span class="count">${h.persons} person${h.persons === 1 ? "" : "s"}</span>`;
    } catch {
      healthOut.textContent = "health unreachable";
    }
  }
  await updateHealth();
  setInterval(updateHealth, 4000);

  async function tick(): Promise<void> {
    await persons.refresh().catch(() => undefined);
    await timeline.refresh();
  }
  setInterval(tick, 1500);
  await timeline.refresh();
}

main().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="color:#fca5a5;padding:20px">${(e as Error).message}</pre>`;
});
