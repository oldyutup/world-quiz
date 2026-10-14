import { MARKSMAN as M } from "./config.js";
import { BOMB, EMPTY, TARGET, type Wave } from "./waves.js";
import type { MarksmanShot } from "./game.js";

export const MARKSMAN_BOT_LEVELS = ["easy", "medium", "hard"] as const;
export type MarksmanBotLevel = (typeof MARKSMAN_BOT_LEVELS)[number];
export const MARKSMAN_BOT_NAMES: Readonly<Record<MarksmanBotLevel, string>> = { easy: "Kolay", medium: "Orta", hard: "Zor" };

/** What a bot sees of its own stretch (what a player sees on screen). */
export interface MarksmanBotView {
  /** Shooting, and this lane is still in the round. */
  playing: boolean;
  /** The waves it knows of, by id (it only reacts once one is up). */
  waves: readonly { id: number; wave: Wave }[];
  /** Its stun ends at this moment (ms after BAŞLA). */
  stunUntil: number;
}
/** One planned shot: the bot turns to `aim` at `turn` and fires at `at`. */
interface Action {
  turn: number;
  at: number;
  aim: number;
}

/**
 * A Yerel Test Arenası opponent that really plays: when a wave is up it notices it after its
 * reaction time, turns to the nearest target and fires, then moves on to the next target
 * (config `bots`). It mistakes a bomb for a target now and then (the easy bot more often), and
 * sometimes fires into the wrong slot first. Its aim moves before every shot, so the laser shows
 * what it is doing, and goes back to the middle once its wave is done.
 */
export class MarksmanBot {
  private planned = new Set<number>();
  private queue: Action[] = [];
  private rest = 0;
  private last = -1e9;
  private lastAim = 0;
  constructor(readonly level: MarksmanBotLevel, private readonly random: () => number = Math.random) {}
  private spread(width: number) {
    return (this.random() * 2 - 1) * width;
  }
  /** Plans the shots for wave `id` once it is up. */
  private plan(id: number, wave: Wave) {
    const k = M.bots[this.level],
      aims: number[] = [];
    wave.kinds.forEach((kind, slot) => {
      if (kind === TARGET || (kind === BOMB && this.random() < k.bombFire)) aims.push(slot - 1);
    });
    // Nearest first from the middle, then on along the row.
    aims.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
    // The wrong slot first: an empty one (a wasted shot), corrected after a move.
    const empty = wave.kinds.flatMap((kind, slot) => (kind === EMPTY ? [slot - 1] : []));
    if (aims.length && empty.length && this.random() < k.wrong) aims.unshift(empty[Math.min(empty.length - 1, Math.floor(this.random() * empty.length))]);
    let at = wave.open + k.reaction + this.spread(k.spread);
    const actions = aims.map((aim, i) => {
      if (i > 0) at += Math.max(M.cooldownMs + 5, k.move + this.spread(k.spread / 2));
      return { turn: at - Math.min(110, k.move * 0.6), at, aim };
    });
    this.planned.add(id);
    this.queue.push(...actions);
    this.queue.sort((a, b) => a.at - b.at);
  }
  /** The shots this bot fires by `due` (ms after BAŞLA), in order. */
  next(view: MarksmanBotView, due: number): MarksmanShot[] {
    if (!view.playing) return [];
    for (const { id, wave } of view.waves) if (!this.planned.has(id) && wave.open <= due) this.plan(id, wave);
    const out: MarksmanShot[] = [];
    while (this.queue.length && this.queue[0].at <= due) {
      const a = this.queue.shift()!;
      // Stunned: it waits it out (the moment may have passed by then).
      let at = Math.max(a.at, this.last + M.cooldownMs + 1);
      if (at < view.stunUntil) at = view.stunUntil + 40;
      if (at > due) {
        this.queue.unshift({ ...a, at });
        break;
      }
      out.push({ at, aim: a.aim });
      // The laser stays on this slot a moment before it turns to the next one.
      const next = this.queue[0];
      if (next) {
        next.turn = Math.max(next.turn, at + 30);
        next.at = Math.max(next.at, next.turn + 40);
      }
      this.last = at;
      this.lastAim = a.aim;
      this.rest = at + 220;
    }
    return out;
  }
  /** Where the bot aims at `t`: at its next shot once it turned, else back in the middle after a pause. */
  aim(t: number) {
    const a = this.queue[0];
    if (a && t >= a.turn) return a.aim;
    if (t < this.rest) return this.lastAim;
    return 0;
  }
}
