import { RHYTHM as R } from "./config.js";
import type { RhythmPress } from "./game.js";

export const RHYTHM_BOT_LEVELS = ["easy", "medium", "hard"] as const;
export type RhythmBotLevel = (typeof RHYTHM_BOT_LEVELS)[number];
export const RHYTHM_BOT_NAMES: Readonly<Record<RhythmBotLevel, string>> = { easy: "Kolay", medium: "Orta", hard: "Zor" };

/**
 * A Yerel Test Arenası opponent that really plays the chart: a moment before every note it
 * decides how it will go (config `bots`): missed, a wrong key, or the right key off by a
 * normal spread around its bias; now and then it also presses between two notes. Its presses
 * go through the same rules as a player's.
 */
export class RhythmBot {
  private planned = 0;
  private queue: RhythmPress[] = [];
  constructor(readonly level: RhythmBotLevel, private readonly random: () => number = Math.random) {}
  /** A normal deviate (Box–Muller). */
  private normal() {
    const u = Math.max(1e-12, this.random()),
      v = this.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  private plan(notes: readonly { t: number; key: number }[], i: number) {
    const k = R.bots[this.level],
      note = notes[i],
      roll = this.random();
    if (roll < k.miss) {
      // Nothing: the note goes by.
    } else if (roll < k.miss + k.wrong) {
      const other = (note.key + 1 + Math.min(2, Math.floor(this.random() * 3))) % R.keys;
      this.queue.push({ at: note.t + k.bias + this.normal() * k.sigma * 0.6, key: other });
    } else {
      const off = Math.max(-150, Math.min(150, k.bias + this.normal() * k.sigma));
      this.queue.push({ at: note.t + off, key: note.key });
    }
    const next = notes[i + 1];
    if (next && this.random() < k.stray) this.queue.push({ at: (note.t + next.t) / 2, key: Math.min(R.keys - 1, Math.floor(this.random() * R.keys)) });
    this.queue.sort((a, b) => a.at - b.at);
  }
  /** The presses this bot makes by `due` (ms after BAŞLA), in order; none while not playing. */
  next(notes: readonly { t: number; key: number }[], due: number, playing: boolean): RhythmPress[] {
    if (!playing) return [];
    // Notes already gone by are skipped (a bot that starts late); the rest are decided a little ahead (a press may come before its note).
    while (this.planned < notes.length && notes[this.planned].t < due - R.windows.good) this.planned++;
    while (this.planned < notes.length && notes[this.planned].t - 200 <= due) this.plan(notes, this.planned++);
    const out: RhythmPress[] = [];
    while (this.queue.length && this.queue[0].at <= due) {
      const p = this.queue.shift()!;
      if (p.at >= 0) out.push(p);
    }
    return out;
  }
}
