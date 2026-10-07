import { expectedValue, clearAngles } from "../../../../shared/party-lab/simulation/goldminer/field";
import type { GoldMinerGame } from "../../../../shared/party-lab/simulation/goldminer/game";
import { SWING_AMPLITUDE, SWING_MS, returnMs, shotMs, traceShot, type MineItem } from "../../../../shared/party-lab/simulation/goldminer/mine";

export const BOT_LEVELS = ["easy", "medium", "hard"] as const;
export type BotLevel = (typeof BOT_LEVELS)[number];
export const BOT_LEVEL_NAMES: Readonly<Record<BotLevel, string>> = { easy: "Kolay", medium: "Orta", hard: "Zor" };
/**
 * How each level plays. `jitter`: its press lands up to this many ms off the moment it aimed
 * for. `mistake`: the share of shots that go wrong on purpose (a press at a random moment,
 * or a rock picked as if it were worth it). `think`: ms it waits once its hook is back.
 * `choices`: it picks at random among this many of its best targets. `watch`: it leaves
 * alone an item another hook is already flying at.
 */
export const BOT_PLAY: Readonly<Record<BotLevel, { jitter: number; mistake: number; think: readonly [number, number]; choices: number; watch: boolean }>> = {
  easy: { jitter: 120, mistake: 0.25, think: [350, 750], choices: 3, watch: false },
  medium: { jitter: 60, mistake: 0.1, think: [200, 450], choices: 2, watch: true },
  hard: { jitter: 25, mistake: 0.03, think: [90, 220], choices: 1, watch: true },
};

/** The next moment at or after `after` (ms) a swing with `origin` points at `angle`. */
export function nextAngleTime(origin: number, angle: number, after: number) {
  const base = (Math.asin(Math.max(-1, Math.min(1, angle / SWING_AMPLITUDE))) * SWING_MS) / (2 * Math.PI),
    k = Math.floor((after - origin) / SWING_MS) - 1;
  let best = Infinity;
  for (let i = k; i <= k + 3; i++)
    for (const t of [origin + base + i * SWING_MS, origin + SWING_MS / 2 - base + i * SWING_MS]) if (t >= after && t < best) best = t;
  return best;
}
/** How fast the swing turns at `angle`, rad/ms (fastest straight down, zero at the ends). */
const swingRate = (angle: number) => ((2 * Math.PI) / SWING_MS) * Math.sqrt(Math.max(0, SWING_AMPLITUDE ** 2 - angle ** 2));

interface Plan {
  item: number;
  /** The press moment the bot aims for, and when it will really press (aim + its error). */
  aim: number;
  press: number;
}
/**
 * A local opponent that plays the mine for real: once its hook is back it looks at the items
 * it can hook with nothing in the way, scores each by points against the time to bring it up
 * (and the chance its timing hits it), picks one, waits for its swing to point there and
 * presses — a little off, by its level. Now and then it presses at a wrong moment or goes
 * for a rock.
 */
export class GoldBot {
  private plan: Plan | null = null;
  private ready = -Infinity;
  private shots = 0;
  readonly play: (typeof BOT_PLAY)[BotLevel];
  constructor(readonly level: BotLevel, private readonly random: () => number = Math.random) {
    this.play = BOT_PLAY[level];
  }
  /** Shots it meant to get wrong so far (tests). */
  mistakes = 0;
  /** The bot's press this step (a time ≤ `now`, ms after BAŞLA), or null. */
  step(game: GoldMinerGame, lane: number, now: number): number | null {
    const h = game.lanes[lane].hook;
    if (game.phase !== "mining" || game.lanes[lane].out || h.state !== "swing") {
      this.plan = null;
      this.ready = -Infinity;
      return null;
    }
    if (this.shots !== h.shots || this.ready === -Infinity) {
      // Back home: a moment to think.
      this.shots = h.shots;
      const [low, high] = this.play.think;
      this.ready = now + low + this.random() * (high - low);
      this.plan = null;
    }
    if (now < this.ready) return null;
    if (this.plan && game.items[this.plan.item]?.state !== "free" && this.plan.item >= 0) this.plan = null;
    this.plan ??= this.choose(game, lane, now);
    if (!this.plan || now < this.plan.press) return null;
    const at = this.plan.press;
    this.plan = null;
    return at;
  }
  private choose(game: GoldMinerGame, lane: number, now: number): Plan | null {
    const h = game.lanes[lane].hook,
      px = game.pivot(lane),
      items: MineItem[] = game.items,
      free = (i: number) => game.items[i].state === "free";
    // Items another hook is on its way to.
    const claimed = new Set<number>();
    if (this.play.watch)
      game.lanes.forEach((l, other) => {
        if (other === lane || l.out || l.hook.state !== "out") return;
        const path = traceShot(items, game.pivot(other), l.hook.angle, l.hook.fired, (i) => !free(i));
        if (path.item >= 0) claimed.add(path.item);
      });
    const options: { item: number; angle: number; score: number }[] = [];
    game.items.forEach((item, i) => {
      if (!free(i) || claimed.has(i)) return;
      const angles = clearAngles(items, i, px, (j) => !free(j));
      if (!angles.length) return;
      // Aim for the middle of what hits it; the wider that window in time, the surer the shot.
      const angle = angles.reduce((a, b) => a + b, 0) / angles.length,
        spread = angles.length > 1 ? Math.max(...angles) - Math.min(...angles) : 0.02,
        window = spread / Math.max(1e-4, swingRate(angle)),
        hit = Math.min(1, (window + 10) / (2 * this.play.jitter)),
        path = traceShot(items, px, angle, 0, (j) => !free(j)),
        wait = nextAngleTime(h.origin, angle, now) - now,
        time = wait + shotMs(path.reach) + returnMs(path.reach, item.kind);
      options.push({ item: i, angle, score: (expectedValue(item) * hit) / (time + 400) });
    });
    if (!options.length) return null;
    options.sort((a, b) => b.score - a.score);
    let pick = options[Math.min(options.length - 1, Math.floor(this.random() * this.play.choices))];
    let aim = nextAngleTime(h.origin, pick.angle, now);
    if (this.random() < this.play.mistake) {
      this.mistakes++;
      const rock = options.find((o) => game.items[o.item].kind === "rock");
      if (rock && this.random() < 0.5) {
        // Goes for a rock as if it were gold.
        pick = rock;
        aim = nextAngleTime(h.origin, rock.angle, now);
      } else {
        // Presses at a wrong moment.
        aim = now + this.random() * SWING_MS * 0.5;
        return { item: -1, aim, press: aim };
      }
    }
    const press = Math.max(now, aim + (this.random() * 2 - 1) * this.play.jitter);
    return { item: pick.item, aim, press };
  }
}

