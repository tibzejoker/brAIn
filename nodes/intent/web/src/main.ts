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

  // "turn mic/cam on" — open the respective UI in a small popup with
  // ?auto_start=1. The voice / gaze web apps read that flag and fire
  // their own Start button as soon as they load, so the user gesture
  // of clicking here carries through the mic/camera permission prompt
  // without a second manual click.
  const micBtn = document.getElementById("mic-on");
  const camBtn = document.getElementById("cam-on");
  const openWith = (base: string, opts: { w: number; h: number; name: string }): void => {
    const url = new URL(base);
    url.searchParams.set("auto_start", "1");
    window.open(
      url.toString(),
      opts.name,
      `popup=yes,width=${opts.w},height=${opts.h}`,
    );
  };
  micBtn?.addEventListener("click", () => openWith(__VOICE_WEB__, { w: 520, h: 720, name: "voice" }));
  camBtn?.addEventListener("click", () => openWith(__GAZE_WEB__, { w: 640, h: 540, name: "gaze" }));

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
