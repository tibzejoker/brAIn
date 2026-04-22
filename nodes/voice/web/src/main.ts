import { controlEngine, deleteAllProfiles, getTuning, patchTuning } from "./api";
import { startMic, type MicHandle } from "./audio";
import { SpeakersPanel } from "./speakers";
import { Timeline } from "./timeline";
import { Transcript } from "./transcript";
import type { VoiceEvent } from "./types";

const SESSION_ID = "default";

const $btn = document.getElementById("mic-toggle") as HTMLButtonElement;
const $status = document.getElementById("status") as HTMLSpanElement;
const $speakers = document.getElementById("speakers-list") as HTMLUListElement;
const $canvas = document.getElementById("timeline-canvas") as HTMLCanvasElement;
const $transcript = document.getElementById("transcript-list") as HTMLOListElement;

const $meterFill = document.getElementById("meter-rms") as HTMLDivElement;
const $meterValue = document.getElementById("meter-value") as HTMLSpanElement;
const $meterReset = document.getElementById("meter-reset") as HTMLButtonElement;
const $knobGain = document.getElementById("knob-gain") as HTMLInputElement;
const $knobGainVal = document.getElementById("knob-gain-val") as HTMLOutputElement;
const $knobVad = document.getElementById("knob-vad") as HTMLInputElement;
const $knobVadVal = document.getElementById("knob-vad-val") as HTMLOutputElement;
const $knobMatch = document.getElementById("knob-match") as HTMLInputElement;
const $knobMatchVal = document.getElementById("knob-match-val") as HTMLOutputElement;
const $knobUncertain = document.getElementById("knob-uncertain") as HTMLInputElement;
const $knobUncertainVal = document.getElementById("knob-uncertain-val") as HTMLOutputElement;
const $knobMinSeg = document.getElementById("knob-minseg") as HTMLInputElement;
const $knobMinSegVal = document.getElementById("knob-minseg-val") as HTMLOutputElement;
const $resetBtn = document.getElementById("reset-profiles") as HTMLButtonElement;

const speakers = new SpeakersPanel($speakers);
const timeline = new Timeline($canvas);
const transcript = new Transcript($transcript);

let mic: MicHandle | null = null;
let audioWs: WebSocket | null = null;
let eventsWs: WebSocket | null = null;
let peakRms = 0;

function setStatus(state: "idle" | "listening" | "error", message?: string): void {
  $status.dataset.state = state;
  $status.textContent = message ? `${state} — ${message}` : state;
  $btn.dataset.state = state;
  $btn.textContent = state === "listening" ? "Stop mic" : "Start mic";
}

function wsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}?session_id=${encodeURIComponent(SESSION_ID)}`;
}

function connectEvents(): WebSocket {
  const ws = new WebSocket(wsUrl("/ws/events"));
  ws.onmessage = (ev) => handleEvent(JSON.parse(ev.data) as VoiceEvent);
  ws.onclose = () => { if (mic) setStatus("error", "events ws closed"); };
  ws.onerror = () => setStatus("error", "events ws error");
  return ws;
}

function handleEvent(event: VoiceEvent): void {
  switch (event.type) {
    case "speaker_new":
      speakers.upsert({ id: event.speaker_id, name: event.name });
      void speakers.refresh();
      break;
    case "speaker_renamed":
      speakers.upsert({ id: event.speaker_id, name: event.name });
      break;
    case "segment": {
      speakers.upsert({ id: event.speaker_id, name: event.name });
      const color = speakers.getColor(event.speaker_id);
      timeline.add(event, color);
      transcript.add(event, color);
      speakers.bumpSampleCount(event.speaker_id);
      break;
    }
    case "status":
      setStatus(event.state, event.message);
      break;
  }
}

function updateMeter(rms: number, peak: number): void {
  // Display range: 0–6000 (Int16 RMS). Above ~3000 = strong speech.
  const norm = Math.min(1, rms / 6000);
  $meterFill.style.width = `${(norm * 100).toFixed(1)}%`;
  $meterValue.textContent = `${Math.round(rms)}`;
  if (peak > peakRms) peakRms = peak;
}

async function start(): Promise<void> {
  $btn.disabled = true;
  try {
    await controlEngine("start", SESSION_ID);
    eventsWs = connectEvents();
    audioWs = new WebSocket(wsUrl("/ws/audio"));
    audioWs.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      audioWs!.onopen = () => resolve();
      audioWs!.onerror = () => reject(new Error("audio ws error"));
    });
    mic = await startMic(audioWs, updateMeter);
    mic.setGain(parseFloat($knobGain.value));
    setStatus("listening");
  } catch (e) {
    setStatus("error", String(e));
  } finally {
    $btn.disabled = false;
  }
}

async function stop(): Promise<void> {
  $btn.disabled = true;
  try {
    if (mic) await mic.stop();
    if (audioWs) audioWs.close();
    if (eventsWs) eventsWs.close();
    await controlEngine("stop", SESSION_ID);
    setStatus("idle");
    $meterFill.style.width = "0%";
    $meterValue.textContent = "--";
  } finally {
    mic = null;
    audioWs = null;
    eventsWs = null;
    $btn.disabled = false;
  }
}

$btn.addEventListener("click", () => {
  if ($btn.dataset.state === "listening") void stop();
  else void start();
});

$meterReset.addEventListener("click", () => {
  peakRms = 0;
});

$knobGain.addEventListener("input", () => {
  const v = parseFloat($knobGain.value);
  $knobGainVal.value = `${v.toFixed(1)}×`;
  mic?.setGain(v);
});

let vadDebounce: number | undefined;
$knobVad.addEventListener("input", () => {
  const v = parseFloat($knobVad.value);
  $knobVadVal.value = v.toFixed(2);
  if (vadDebounce) window.clearTimeout(vadDebounce);
  vadDebounce = window.setTimeout(() => {
    void patchTuning({ vad_speech_threshold: v });
  }, 150);
});

let matchDebounce: number | undefined;
$knobMatch.addEventListener("input", () => {
  const v = parseFloat($knobMatch.value);
  $knobMatchVal.value = v.toFixed(2);
  if (matchDebounce) window.clearTimeout(matchDebounce);
  matchDebounce = window.setTimeout(() => {
    void patchTuning({ match_threshold: v });
  }, 150);
});

let uncertainDebounce: number | undefined;
$knobUncertain.addEventListener("input", () => {
  const v = parseFloat($knobUncertain.value);
  $knobUncertainVal.value = v.toFixed(2);
  if (uncertainDebounce) window.clearTimeout(uncertainDebounce);
  uncertainDebounce = window.setTimeout(() => {
    void patchTuning({ uncertain_threshold: v });
  }, 150);
});

let minsegDebounce: number | undefined;
$knobMinSeg.addEventListener("input", () => {
  const v = parseInt($knobMinSeg.value, 10);
  $knobMinSegVal.value = String(v);
  if (minsegDebounce) window.clearTimeout(minsegDebounce);
  minsegDebounce = window.setTimeout(() => {
    void patchTuning({ min_segment_ms: v });
  }, 150);
});

$resetBtn.addEventListener("click", async () => {
  if (!confirm("Delete ALL speaker profiles? This cannot be undone.")) return;
  await deleteAllProfiles();
  await speakers.refresh();
  timeline.reset();
});

async function bootstrap(): Promise<void> {
  await speakers.refresh();
  setStatus("idle");
  try {
    const t = await getTuning();
    if (typeof t.vad_speech_threshold === "number") {
      $knobVad.value = String(t.vad_speech_threshold);
      $knobVadVal.value = t.vad_speech_threshold.toFixed(2);
    }
    if (typeof t.match_threshold === "number") {
      $knobMatch.value = String(t.match_threshold);
      $knobMatchVal.value = t.match_threshold.toFixed(2);
    }
    if (typeof t.uncertain_threshold === "number") {
      $knobUncertain.value = String(t.uncertain_threshold);
      $knobUncertainVal.value = t.uncertain_threshold.toFixed(2);
    }
    if (typeof t.min_segment_ms === "number") {
      $knobMinSeg.value = String(t.min_segment_ms);
      $knobMinSegVal.value = String(t.min_segment_ms);
    }
  } catch {
    /* tuning endpoint may be absent if engine doesn't expose it */
  }
}

void bootstrap();
