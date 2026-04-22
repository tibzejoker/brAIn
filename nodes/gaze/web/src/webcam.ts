export type WebcamHandle = {
  stream: MediaStream;
  video: HTMLVideoElement;
  snapshot: () => string; // returns a data URL (image/jpeg)
  stop: () => void;
};

export async function startWebcam(
  video: HTMLVideoElement,
  opts: { width?: number; height?: number; facingMode?: "user" | "environment" } = {},
): Promise<WebcamHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: opts.width ?? 960 },
      height: { ideal: opts.height ?? 540 },
      facingMode: opts.facingMode ?? "user",
    },
    audio: false,
  });
  video.srcObject = stream;
  video.playsInline = true;
  video.muted = true;
  await video.play();

  const canvas = document.createElement("canvas");

  function snapshot(): string {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  }

  function stop(): void {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  }

  return { stream, video, snapshot, stop };
}
