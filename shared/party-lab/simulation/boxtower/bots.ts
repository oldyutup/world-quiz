import { BOX_TOWER as T } from "./config.js";
import { crossings, travelMs, type Slide } from "./motion.js";

export const TOWER_BOT_LEVELS = ["easy", "medium", "hard"] as const;
export type TowerBotLevel = (typeof TOWER_BOT_LEVELS)[number];
export const TOWER_BOT_NAMES: Readonly<Record<TowerBotLevel, string>> = { easy: "Kolay", medium: "Orta", hard: "Zor" };

/** What a bot sees of its own yard (what a player sees on screen). */
export interface TowerBotView {
  /** Stacking, and this lane is still in the round. */
  playing: boolean;
  /** Its own box is in the air (or pressed and not shown yet). */
  busy: boolean;
  heights: readonly number[];
  slide: Slide;
}

/** A standard normal draw (Box–Muller). */
function gaussian(random: () => number) {
  const u = Math.max(1e-9, random()),
    v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * A Yerel Test Arenası opponent that really plays: for every new box it picks its tallest
 * column (any tallest one, whichever the box reaches first after its reaction) and plans one
 * press for the moment the box is over it, off by a timing error that grows with the speed
 * (config `bots`). A miss simply lands elsewhere, as a player's would.
 */
export class TowerBot {
  private plan: { spawn: number; at: number } | null = null;
  constructor(readonly level: TowerBotLevel, private readonly random: () => number = Math.random) {}
  /** The press moment (ms after BAŞLA) this bot makes by `due`, or null. One press per box. */
  next(view: TowerBotView, due: number): number | null {
    if (!view.playing || view.busy) return null;
    const s = view.slide;
    if (!this.plan || this.plan.spawn !== s.spawn) this.plan = { spawn: s.spawn, at: this.aim(view) };
    if (this.plan.at > due) return null;
    const at = this.plan.at;
    this.plan.at = Infinity;
    return at;
  }
  /** The planned press for the current box. */
  private aim(view: TowerBotView) {
    const k = T.bots[this.level],
      s = view.slide,
      best = Math.max(...view.heights),
      after = s.spawn + k.reaction * (0.8 + 0.4 * this.random());
    let target = Infinity;
    view.heights.forEach((height, column) => {
      if (height !== best) return;
      const first = crossings(s, column, after, after + 2 * s.travel + 1)[0];
      if (first !== undefined && first < target) target = first;
    });
    const error = k.error * Math.pow(travelMs(0) / s.travel, k.speedGain);
    return Math.max(s.spawn, target + gaussian(this.random) * error);
  }
}
