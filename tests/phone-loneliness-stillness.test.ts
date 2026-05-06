import { describe, it, expect } from "vitest";
import {
  StillnessDetector,
  type AccelSample,
} from "../../brAIn-demo-loneliness/nodes/phone-loneliness/src/stillness";

function steady(t0: number, n: number, x: number, y: number, z: number, jitter = 0): AccelSample[] {
  const out: AccelSample[] = [];
  for (let i = 0; i < n; i++) {
    const j = jitter ? (Math.random() - 0.5) * 2 * jitter : 0;
    out.push({ t: t0 + i * 100, x: x + j, y: y + j, z: z + j });
  }
  return out;
}

function moving(t0: number, n: number): AccelSample[] {
  const out: AccelSample[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ t: t0 + i * 100, x: Math.sin(i) * 4, y: Math.cos(i) * 4, z: 9.81 + Math.sin(i / 2) * 3 });
  }
  return out;
}

describe("StillnessDetector", () => {
  it("does NOT call still on the first few samples (warm-up)", () => {
    const d = new StillnessDetector();
    let lastChange = false;
    for (const s of steady(0, 3, 0, 0, 9.81)) {
      lastChange = d.feed(s).changed;
    }
    expect(d.isStill).toBe(false);
    expect(lastChange).toBe(false);
  });

  it("flips to still once the window is full of low-variance samples", () => {
    const d = new StillnessDetector();
    let transitions = 0;
    for (const s of steady(0, 12, 0, 0, 9.81, 0.05)) {
      const v = d.feed(s);
      if (v.changed) transitions += 1;
    }
    expect(d.isStill).toBe(true);
    expect(transitions).toBe(1);
    expect(d.stillSince).toBeGreaterThanOrEqual(900);
  });

  it("rejects stillness when one axis swings beyond maxRange", () => {
    const d = new StillnessDetector({ maxRange: 0.5 });
    // y wobbles ±1 m/s² → 2 m/s² range → way over threshold
    const samples: AccelSample[] = [];
    for (let i = 0; i < 12; i++) samples.push({ t: i * 100, x: 0, y: i % 2 ? 1 : -1, z: 9.81 });
    for (const s of samples) d.feed(s);
    expect(d.isStill).toBe(false);
  });

  it("emits one transition when motion resumes after a still episode", () => {
    const d = new StillnessDetector();
    for (const s of steady(0, 12, 0, 0, 9.81, 0.05)) d.feed(s);
    expect(d.isStill).toBe(true);

    let transitionsAfter = 0;
    for (const s of moving(2000, 12)) {
      const v = d.feed(s);
      if (v.changed) transitionsAfter += 1;
    }
    expect(d.isStill).toBe(false);
    expect(transitionsAfter).toBe(1);
    expect(d.stillSince).toBeNull();
  });

  it("trims the buffer so only samples within windowMs participate", () => {
    const d = new StillnessDetector({ windowMs: 1000 });
    // First a full second of steady data, then big motion AT t = 2000ms.
    // The single new sample sits in a buffer that has been trimmed of
    // earlier steady data — but minSamples + window-span guards keep
    // the verdict at "still" until enough fresh samples arrive.
    for (const s of steady(0, 12, 0, 0, 9.81, 0.05)) d.feed(s);
    expect(d.isStill).toBe(true);
    d.feed({ t: 2000, x: 5, y: 5, z: 5 });
    // After one wild sample we don't have enough new samples to span
    // the window, so the verdict is held at the previous value.
    expect(d.isStill).toBe(true);
  });

  it("respects custom maxRange (a sensitive setting catches small wobble)", () => {
    const sensitive = new StillnessDetector({ maxRange: 0.1 });
    for (const s of steady(0, 12, 0, 0, 9.81, 0.2)) sensitive.feed(s);
    expect(sensitive.isStill).toBe(false);
  });

  it("reset() clears history + flag", () => {
    const d = new StillnessDetector();
    for (const s of steady(0, 12, 0, 0, 9.81)) d.feed(s);
    expect(d.isStill).toBe(true);
    d.reset();
    expect(d.isStill).toBe(false);
    expect(d.stillSince).toBeNull();
  });
});
