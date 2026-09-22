import { impactLevel, type FeedbackEvent } from "./events.js";
import { SFX } from "./sfx.js";
export const MAX_VOICES = 16;
interface Voice {
  priority: number;
  stop: () => void;
}
/** Pure scheduling/voice policy; important cues can evict a quiet bump. */
export class VoicePool {
  readonly voices = new Map<number, Voice>();
  private next = 0;
  add(priority: number, stop: () => void): number | null {
    if (this.voices.size >= MAX_VOICES) {
      const victim = [...this.voices]
        .sort((a, b) => a[1].priority - b[1].priority)
        .find(([, voice]) => voice.priority < priority);
      if (!victim) return null;
      this.voices.delete(victim[0]);
      victim[1].stop();
    }
    const id = this.next++;
    this.voices.set(id, { priority, stop });
    return id;
  }
  remove(id: number) {
    this.voices.delete(id);
  }
  clear() {
    const old = [...this.voices.values()];
    this.voices.clear();
    old.forEach((v) => v.stop());
  }
}
export class EventGate {
  private last = new Map<string, number>();
  allow(event: FeedbackEvent, now: number) {
    const recipe = SFX[event.name];
    // Per-actor semantic cue gate, plus category cap across all characters.
    const key = `${event.name}:${event.actor ?? "ui"}`;
    if (now - (this.last.get(key) ?? -Infinity) < recipe.cooldown) return false;
    if (
      // Each player has an independent elimination, even in the same tick.
      event.name !== "fall" &&
      now - (this.last.get(event.name) ?? -Infinity) <
        Math.min(recipe.cooldown, 0.035)
    )
      return false;
    this.last.set(key, now);
    this.last.set(event.name, now);
    return true;
  }
  clear() {
    this.last.clear();
  }
}
export interface CollisionCandidate {
  pair: string;
  group: string;
  actor: number;
  x: number;
  part: string;
  floor: boolean;
  speed: number;
  impulse: number;
  intensity: number;
}
export class CollisionGate {
  private pairs = new Map<string, number>();
  private groups = new Map<string, number>();
  select(candidates: CollisionCandidate[], now: number) {
    for (const [key, time] of this.pairs)
      if (now - time > 1) this.pairs.delete(key);
    for (const [key, time] of this.groups)
      if (now - time > 1) this.groups.delete(key);
    const selected: CollisionCandidate[] = [];
    for (const c of candidates.sort((a, b) => b.intensity - a.intensity)) {
      if (c.speed < 1.1 || c.impulse < 0.045 || !Number.isFinite(c.intensity))
        continue;
      if (now - (this.pairs.get(c.pair) ?? -Infinity) < 0.24) continue;
      // At most one head + one body cue per character collapse window.
      const group = `${c.group}:${
        c.floor && c.part === "head" ? "head" : "body"
      }`;
      if (now - (this.groups.get(group) ?? -Infinity) < 0.22) continue;
      if (selected.length >= 2) break;
      this.pairs.set(c.pair, now);
      this.groups.set(group, now);
      selected.push(c);
    }
    return selected;
  }
  clear() {
    this.pairs.clear();
    this.groups.clear();
  }
}
export const collisionSound = (c: CollisionCandidate): FeedbackEvent["name"] =>
  c.part === "head"
    ? "headHit"
    : c.floor
    ? c.part === "torso" || c.part === "pelvis"
      ? "floorFlop"
      : "limbHit"
    : impactLevel(c.intensity) === "HEAVY"
    ? "heavyBump"
    : "lightBump";
