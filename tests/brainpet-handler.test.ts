import { describe, it, expect } from "vitest";

import {
  newPet,
  ageMinutes,
  stageOf,
  applyDecay,
  firstCrossedThreshold,
  minutesToNextThreshold,
  parseControl,
  parseReplyAndEffects,
  defaultPersonality,
  pushHistory,
  MAX_HISTORY_TURNS,
} from "../../storeprojects/brAIn-games/nodes/brainpet/src/handler";

describe("newPet + stageOf", () => {
  it("births a fresh pet with full-ish stats and an egg stage", () => {
    const pet = newPet("Pip", "fluffball");
    expect(pet.name).toBe("Pip");
    expect(pet.species).toBe("fluffball");
    expect(pet.alive).toBe(true);
    expect(pet.hunger).toBeGreaterThan(50);
    expect(pet.happiness).toBeGreaterThan(50);
    expect(stageOf(pet)).toBe("egg");
  });

  it("ageMinutes is ~0 for a newborn", () => {
    const pet = newPet("X", "y");
    expect(ageMinutes(pet)).toBeLessThan(0.1);
  });
});

describe("applyDecay", () => {
  it("drains stats over elapsed time at the configured rates", () => {
    const pet = newPet("X", "y");
    pet.hunger = 100; pet.happiness = 100; pet.energy = 100; pet.cleanliness = 100;
    pet.last_tick = Date.now() - 10 * 60_000; // 10 min ago
    applyDecay(pet, Date.now());
    // hunger decays at 0.6/min → 100 - 6 = 94
    expect(pet.hunger).toBeCloseTo(94, 0);
    expect(pet.happiness).toBeCloseTo(97, 0); // 0.3/min → 100 - 3
    expect(pet.energy).toBeCloseTo(96, 0);    // 0.4/min → 100 - 4
    expect(pet.cleanliness).toBeCloseTo(98.5, 0); // 0.15/min → 100 - 1.5
  });

  it("reverses energy decay while sleeping", () => {
    const pet = newPet("X", "y");
    pet.energy = 40; pet.sleeping = true;
    pet.last_tick = Date.now() - 5 * 60_000;
    applyDecay(pet, Date.now());
    expect(pet.energy).toBeGreaterThan(44); // +1/min → 40 + 5
  });

  it("respects decayMul (e.g. accelerated test mode)", () => {
    const pet = newPet("X", "y");
    pet.hunger = 100;
    pet.last_tick = Date.now() - 10 * 60_000;
    applyDecay(pet, Date.now(), 2);
    // hunger decays 2x faster → 100 - 12 = 88
    expect(pet.hunger).toBeCloseTo(88, 0);
  });

  it("clamps stats to [0, 100]", () => {
    const pet = newPet("X", "y");
    pet.hunger = 1;
    pet.last_tick = Date.now() - 200 * 60_000; // way more than enough to bottom out
    applyDecay(pet, Date.now());
    expect(pet.hunger).toBe(0);
  });

  it("personality moves slowly (sticky EMA)", () => {
    const pet = newPet("X", "y");
    pet.personality.cheerful = 50;
    pet.happiness = 100;
    pet.last_tick = Date.now() - 60 * 60_000; // 1 hour
    applyDecay(pet, Date.now());
    // 60 min * 0.004 inertia = 0.24 EMA alpha → cheerful pulled ~12 toward 100
    expect(pet.personality.cheerful).toBeGreaterThan(50);
    expect(pet.personality.cheerful).toBeLessThan(75); // proves it's slow
  });
});

describe("firstCrossedThreshold", () => {
  it("returns the threshold a downward step crosses", () => {
    expect(firstCrossedThreshold(60, 49)).toBe(50);
    expect(firstCrossedThreshold(26, 24)).toBe(25);
    expect(firstCrossedThreshold(11, 9)).toBe(10);
    expect(firstCrossedThreshold(2, 0)).toBe(1);
  });

  it("returns null when no threshold was crossed", () => {
    expect(firstCrossedThreshold(60, 55)).toBeNull();
    expect(firstCrossedThreshold(30, 27)).toBeNull();
  });

  it("returns null when the move was upward (after care)", () => {
    expect(firstCrossedThreshold(20, 80)).toBeNull();
  });
});

describe("minutesToNextThreshold", () => {
  it("schedules a short wake when a stat is near a threshold", () => {
    const pet = newPet("X", "y");
    pet.hunger = 26; pet.happiness = 80; pet.energy = 80; pet.cleanliness = 80;
    // hunger 26 → next threshold 25, decay 0.6/min → ~1.67 min
    const m = minutesToNextThreshold(pet);
    expect(m).toBeGreaterThan(1);
    expect(m).toBeLessThan(3);
  });

  it("caps the wake at 60 minutes even when everything is plump", () => {
    const pet = newPet("X", "y");
    pet.hunger = 100; pet.happiness = 100; pet.energy = 100; pet.cleanliness = 100;
    expect(minutesToNextThreshold(pet)).toBeLessThanOrEqual(60);
  });

  it("never returns less than ~20 seconds", () => {
    const pet = newPet("X", "y");
    pet.hunger = 1; pet.happiness = 1; pet.energy = 1; pet.cleanliness = 1;
    expect(minutesToNextThreshold(pet)).toBeGreaterThanOrEqual(20 / 60);
  });
});

describe("parseControl", () => {
  it("parses JSON envelopes", () => {
    expect(parseControl('{"action":"feed","food":"strawberry"}')).toEqual({ action: "feed", food: "strawberry" });
    expect(parseControl('{"action":"rename","name":"Mochi"}')).toEqual({ action: "rename", name: "Mochi" });
  });

  it("accepts loose verb strings", () => {
    expect(parseControl("feed")).toEqual({ action: "feed", food: undefined });
    expect(parseControl("feed cookie")).toEqual({ action: "feed", food: "cookie" });
    expect(parseControl("play")).toEqual({ action: "play" });
    expect(parseControl("rename Pixel")).toEqual({ action: "rename", name: "Pixel" });
  });

  it("normalises `pet` to `cuddle`", () => {
    expect(parseControl("pet")).toEqual({ action: "cuddle" });
  });

  it("returns the metadata fallback on junk content", () => {
    expect(parseControl("???", { action: "kill" })).toEqual({ action: "kill" });
    expect(parseControl(undefined)).toEqual({});
  });
});

describe("parseReplyAndEffects", () => {
  it("splits a tagged LLM reply into prose + effects", () => {
    const raw = `Mmm, yum! Thanks!\n<effects>{"hunger":+15,"bond":+2,"animation":"eating"}</effects>`;
    const { reply, effects } = parseReplyAndEffects(raw);
    expect(reply).toBe("Mmm, yum! Thanks!");
    expect(effects).toEqual({ hunger: 15, bond: 2, animation: "eating" });
  });

  it("falls back to a trailing bare JSON object if no <effects> tag", () => {
    const raw = `So sad…\n{"happiness":-5,"animation":"sad"}`;
    const { reply, effects } = parseReplyAndEffects(raw);
    expect(reply).toBe("So sad…");
    expect(effects).toEqual({ happiness: -5, animation: "sad" });
  });

  it("ignores junk bare JSON that doesn't look like effects", () => {
    const raw = `Random thought {"foo":"bar"}`;
    const { reply, effects } = parseReplyAndEffects(raw);
    expect(reply).toBe(raw);
    expect(effects).toEqual({});
  });

  it("returns empty effects + verbatim reply when no JSON at all", () => {
    const raw = `Plain prose, nothing fancy.`;
    const { reply, effects } = parseReplyAndEffects(raw);
    expect(reply).toBe("Plain prose, nothing fancy.");
    expect(effects).toEqual({});
  });

  it("returns empty effects when the JSON is malformed", () => {
    const raw = `Hi!\n<effects>{not json}</effects>`;
    const { reply, effects } = parseReplyAndEffects(raw);
    expect(reply).toBe("Hi!");
    expect(effects).toEqual({});
  });

  it("repairs a truncated <effects> tag (model hit max_tokens mid-JSON)", () => {
    // Exact shape we saw in the wild: open tag + partial key, no close.
    const raw = `*Huddles*... Eep! 🥺\n\n<effects>{"happiness":-10,"`;
    const { reply, effects } = parseReplyAndEffects(raw);
    expect(reply).toBe("*Huddles*... Eep! 🥺");
    expect(effects).toEqual({ happiness: -10 });
  });

  it("repairs a truncated open-only tag that ends mid-comma", () => {
    const raw = `So sad\n<effects>{"happiness":-5,"animation":"sad",`;
    const { reply, effects } = parseReplyAndEffects(raw);
    expect(reply).toBe("So sad");
    expect(effects).toEqual({ happiness: -5, animation: "sad" });
  });
});

describe("pushHistory", () => {
  it("appends turns in order", () => {
    const pet = newPet("X", "y");
    pushHistory(pet, { role: "user", content: "hi", ts: 1 });
    pushHistory(pet, { role: "assistant", content: "*waves*", ts: 2 });
    expect(pet.history.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(pet.history[1].content).toBe("*waves*");
  });

  it("caps the history to MAX_HISTORY_TURNS (oldest first dropped)", () => {
    const pet = newPet("X", "y");
    for (let i = 0; i < MAX_HISTORY_TURNS + 5; i++) {
      pushHistory(pet, { role: i % 2 === 0 ? "user" : "assistant", content: `m${i}`, ts: i });
    }
    expect(pet.history).toHaveLength(MAX_HISTORY_TURNS);
    // The earliest 5 should have been evicted.
    expect(pet.history[0].content).toBe("m5");
  });

  it("seeds an empty history when the state predates the field", () => {
    const pet = newPet("X", "y");
    // Simulate a legacy state loaded from disk without history.
    delete (pet as Partial<typeof pet>).history;
    pushHistory(pet, { role: "user", content: "hello", ts: 1 });
    expect(pet.history).toEqual([{ role: "user", content: "hello", ts: 1 }]);
  });
});

describe("defaultPersonality", () => {
  it("starts every dimension around the middle", () => {
    const p = defaultPersonality();
    for (const v of Object.values(p)) {
      expect(v).toBeGreaterThanOrEqual(20);
      expect(v).toBeLessThanOrEqual(80);
    }
  });
});
