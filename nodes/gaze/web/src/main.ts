import {
  deleteAllProfiles,
  detectBase64,
  getTuning,
  patchTuning,
} from "./api";
import { FacesPanel } from "./faces";
import { Overlay } from "./overlay";
import type { DetectResponse, Tuning } from "./types";
import { startWebcam, type WebcamHandle } from "./webcam";

const $btn = document.getElementById("cam-toggle") as HTMLButtonElement;
const $upload = document.getElementById("image-upload") as HTMLInputElement;
const $remember = document.getElementById("remember") as HTMLInputElement;
const $status = document.getElementById("status") as HTMLSpanElement;
const $video = document.getElementById("video") as HTMLVideoElement;
const $still = document.getElementById("still") as HTMLImageElement;
const $overlay = document.getElementById("overlay") as HTMLCanvasElement;
const $wrap = $video.parentElement as HTMLDivElement;
const $perf = document.getElementById("perf") as HTMLDivElement;
const $facesList = document.getElementById("faces-list") as HTMLUListElement;

const $knobInterval = document.getElementById("knob-interval") as HTMLInputElement;
const $knobIntervalVal = document.getElementById("knob-interval-val") as HTMLOutputElement;
const $knobMatch = document.getElementById("knob-match") as HTMLInputElement;
const $knobMatchVal = document.getElementById("knob-match-val") as HTMLOutputElement;
const $knobUncertain = document.getElementById("knob-uncertain") as HTMLInputElement;
const $knobUncertainVal = document.getElementById("knob-uncertain-val") as HTMLOutputElement;
const $knobEma = document.getElementById("knob-ema") as HTMLInputElement;
const $knobEmaVal = document.getElementById("knob-ema-val") as HTMLOutputElement;
const $knobMargin = document.getElementById("knob-margin") as HTMLInputElement;
const $knobMarginVal = document.getElementById("knob-margin-val") as HTMLOutputElement;
const $resetBtn = document.getElementById("reset-profiles") as HTMLButtonElement;

const facesPanel = new FacesPanel($facesList);
const overlay = new Overlay($overlay);

let webcam: WebcamHandle | null = null;
let loopTimer: number | null = null;
let loopInFlight = false;
let intervalMs = parseInt($knobInterval.value, 10);

function setStatus(state: "idle" | "live" | "error", message?: string): void {
  $status.dataset.state = state;
  $status.textContent = message ? `${state} — ${message}` : state;
  $btn.dataset.state = state;
  $btn.textContent = state === "live" ? "Stop webcam" : "Start webcam";
}

function resizeOverlayToDisplay(width: number, height: number): void {
  overlay.resize(width, height);
}

function refitOverlay(): void {
  const rect = $wrap.getBoundingClientRect();
  const source = $wrap.classList.contains("mode-still") ? $still : $video;
  const sw = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
  const sh = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
  if (!sw || !sh) {
    resizeOverlayToDisplay(rect.width, rect.height);
    return;
  }
  const srcRatio = sw / sh;
  const boxRatio = rect.width / rect.height;
  const displayW = srcRatio > boxRatio ? rect.width : rect.height * srcRatio;
  const displayH = srcRatio > boxRatio ? rect.width / srcRatio : rect.height;
  resizeOverlayToDisplay(displayW, displayH);
  $overlay.style.left = `${(rect.width - displayW) / 2}px`;
  $overlay.style.top = `${(rect.height - displayH) / 2}px`;
  $overlay.style.width = `${displayW}px`;
  $overlay.style.height = `${displayH}px`;
}

function renderResult(result: DetectResponse): void {
  refitOverlay();
  const widthCss = parseFloat($overlay.style.width || "0") || $overlay.clientWidth;
  const heightCss = parseFloat($overlay.style.height || "0") || $overlay.clientHeight;
  overlay.draw(result, widthCss, heightCss);
  facesPanel.upsertLive(result.faces);
  const { detect, match, gaze } = result.elapsed_ms;
  $perf.textContent = `${result.faces.length} face(s) · detect ${detect}ms · match ${match}ms · gaze ${gaze}ms`;
}

async function detectOnce(dataUrl: string): Promise<void> {
  try {
    const result = await detectBase64(dataUrl, $remember.checked);
    renderResult(result);
  } catch (e) {
    setStatus("error", String(e));
  }
}

async function loop(): Promise<void> {
  if (!webcam || loopInFlight) {
    loopTimer = window.setTimeout(loop, intervalMs);
    return;
  }
  loopInFlight = true;
  try {
    const dataUrl = webcam.snapshot();
    await detectOnce(dataUrl);
  } finally {
    loopInFlight = false;
    if (webcam) loopTimer = window.setTimeout(loop, intervalMs);
  }
}

async function startCam(): Promise<void> {
  $btn.disabled = true;
  try {
    $wrap.classList.remove("mode-still");
    webcam = await startWebcam($video);
    setStatus("live");
    refitOverlay();
    loopTimer = window.setTimeout(loop, 100);
  } catch (e) {
    setStatus("error", String(e));
  } finally {
    $btn.disabled = false;
  }
}

function stopCam(): void {
  if (loopTimer !== null) window.clearTimeout(loopTimer);
  loopTimer = null;
  if (webcam) {
    webcam.stop();
    webcam = null;
  }
  overlay.clear();
  setStatus("idle");
  $perf.textContent = "—";
}

$btn.addEventListener("click", () => {
  if ($btn.dataset.state === "live") stopCam();
  else void startCam();
});

$upload.addEventListener("change", async () => {
  const file = $upload.files?.[0];
  if (!file) return;
  stopCam();
  $wrap.classList.add("mode-still");
  const url = URL.createObjectURL(file);
  $still.src = url;
  await new Promise<void>((resolve, reject) => {
    $still.onload = () => resolve();
    $still.onerror = () => reject(new Error("could not load image"));
  });
  const reader = new FileReader();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("FileReader error"));
    reader.readAsDataURL(file);
  });
  setStatus("live", "still image");
  await detectOnce(dataUrl);
  URL.revokeObjectURL(url);
  $upload.value = "";
});

$knobInterval.addEventListener("input", () => {
  const v = parseInt($knobInterval.value, 10);
  $knobIntervalVal.value = String(v);
  intervalMs = v;
});

let matchDebounce: number | undefined;
$knobMatch.addEventListener("input", () => {
  const v = parseFloat($knobMatch.value);
  $knobMatchVal.value = v.toFixed(2);
  if (matchDebounce) window.clearTimeout(matchDebounce);
  matchDebounce = window.setTimeout(() => { void patchTuning({ match_threshold: v }); }, 150);
});

let uncertainDebounce: number | undefined;
$knobUncertain.addEventListener("input", () => {
  const v = parseFloat($knobUncertain.value);
  $knobUncertainVal.value = v.toFixed(2);
  if (uncertainDebounce) window.clearTimeout(uncertainDebounce);
  uncertainDebounce = window.setTimeout(() => { void patchTuning({ uncertain_threshold: v }); }, 150);
});

let emaDebounce: number | undefined;
$knobEma.addEventListener("input", () => {
  const v = parseFloat($knobEma.value);
  $knobEmaVal.value = v.toFixed(2);
  if (emaDebounce) window.clearTimeout(emaDebounce);
  emaDebounce = window.setTimeout(() => { void patchTuning({ ema_decay: v }); }, 150);
});

let marginDebounce: number | undefined;
$knobMargin.addEventListener("input", () => {
  const v = parseFloat($knobMargin.value);
  $knobMarginVal.value = v.toFixed(2);
  if (marginDebounce) window.clearTimeout(marginDebounce);
  marginDebounce = window.setTimeout(() => { void patchTuning({ looking_at_margin: v }); }, 150);
});

$resetBtn.addEventListener("click", async () => {
  if (!confirm("Delete ALL face profiles? This cannot be undone.")) return;
  await deleteAllProfiles();
  await facesPanel.refresh();
});

window.addEventListener("resize", () => {
  if (webcam || $wrap.classList.contains("mode-still")) refitOverlay();
});

function applyTuning(t: Partial<Tuning>): void {
  if (typeof t.match_threshold === "number") {
    $knobMatch.value = String(t.match_threshold);
    $knobMatchVal.value = t.match_threshold.toFixed(2);
  }
  if (typeof t.uncertain_threshold === "number") {
    $knobUncertain.value = String(t.uncertain_threshold);
    $knobUncertainVal.value = t.uncertain_threshold.toFixed(2);
  }
  if (typeof t.ema_decay === "number") {
    $knobEma.value = String(t.ema_decay);
    $knobEmaVal.value = t.ema_decay.toFixed(2);
  }
  if (typeof t.looking_at_margin === "number") {
    $knobMargin.value = String(t.looking_at_margin);
    $knobMarginVal.value = t.looking_at_margin.toFixed(2);
  }
}

async function bootstrap(): Promise<void> {
  try {
    const t = await getTuning();
    applyTuning(t);
  } catch {
    /* tuning endpoint may be missing briefly during server startup */
  }
  await facesPanel.refresh();
  setStatus("idle");
}

void bootstrap();
