/**
 * Captures mic audio, downsamples to 16 kHz Int16 mono, streams over WebSocket.
 *
 * Browser typically delivers 48 kHz Float32 — we resample with a tiny linear
 * decimator inside an inline AudioWorklet, then ship binary frames to /ws/audio.
 */

const WORKLET_SRC = `
// Assumes AudioContext is created with sampleRate: 16000 — no resampling here.
// The browser does proper antialiased resampling upstream when needed.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buffer = [];
    this.flushEvery = 1600;                  // ~100ms at 16kHz
    this.gain = (options && options.processorOptions && options.processorOptions.gain) || 4.0;
    this.peakRms = 0;
    this.frameCount = 0;
    this.warnedRate = false;
    this.port.onmessage = (ev) => {
      const m = ev.data;
      if (m && m.type === "set-gain" && typeof m.value === "number") {
        this.gain = Math.max(0, Math.min(20, m.value));
      } else if (m && m.type === "reset-peak") {
        this.peakRms = 0;
      }
    };
    this.port.postMessage({ type: "info", sampleRate });
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    if (!this.warnedRate && sampleRate !== 16000) {
      this.warnedRate = true;
      this.port.postMessage({ type: "warn", message: "AudioContext sampleRate is " + sampleRate + ", expected 16000" });
    }

    for (let i = 0; i < channel.length; i++) {
      const boosted = channel[i] * this.gain;
      const s = Math.max(-1, Math.min(1, boosted));
      this.buffer.push(s < 0 ? s * 0x8000 : s * 0x7fff);
    }

    if (this.buffer.length >= this.flushEvery) {
      const out = new Int16Array(this.buffer);
      this.buffer = [];

      let sumSq = 0;
      for (let i = 0; i < out.length; i++) sumSq += out[i] * out[i];
      const rms = Math.sqrt(sumSq / out.length);
      if (rms > this.peakRms) this.peakRms = rms;
      this.frameCount += 1;
      if (this.frameCount % 20 === 0) {
        this.port.postMessage({ type: "rms", rms, peak: this.peakRms });
      }

      this.port.postMessage(out, [out.buffer]);
    }
    return true;
  }
}
registerProcessor("capture-processor", CaptureProcessor);
`;

export type MicHandle = {
  stop: () => Promise<void>;
  setGain: (value: number) => void;
};

type RmsReport = { type: "rms"; rms: number; peak: number };

export async function startMic(
  ws: WebSocket,
  onRms?: (rms: number, peak: number) => void,
): Promise<MicHandle> {
  // Disable echo cancellation + noise suppression — they kill VAD by attenuating
  // legitimate speech. Auto-gain off too so our explicit gain in the worklet wins.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  const ctx = new AudioContext({ sampleRate: 16000 });
  if (ctx.sampleRate !== 16000) {
    console.warn(
      `[voice] requested 16 kHz AudioContext but got ${ctx.sampleRate} Hz — VAD may misbehave`,
    );
  }
  const blob = new Blob([WORKLET_SRC], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "capture-processor", {
    processorOptions: { gain: 4.0 },
  });
  source.connect(node);

  node.port.onmessage = (ev: MessageEvent<Int16Array | RmsReport | { type: string; [k: string]: unknown }>) => {
    const data = ev.data;
    if (data instanceof Int16Array) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data.buffer);
      return;
    }
    const msg = data as { type?: string; rms?: number; peak?: number; sampleRate?: number; message?: string };
    if (msg.type === "rms") {
      onRms?.(msg.rms ?? 0, msg.peak ?? 0);
    } else if (msg.type === "info") {
      console.info(`[voice] worklet up — sampleRate=${msg.sampleRate}`);
    } else if (msg.type === "warn") {
      console.warn(`[voice] ${msg.message}`);
    }
  };

  return {
    stop: async () => {
      node.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
    },
    setGain: (value: number) => {
      node.port.postMessage({ type: "set-gain", value });
    },
  };
}
