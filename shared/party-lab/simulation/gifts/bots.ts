import type { MovementInput } from "../../intent.js";
import { GIFT_SOLIDS } from "../../maps/gifts.js";
import { mulberry32 } from "../colors/layouts.js";
import type { PlayerId } from "../players.js";
import { GIFT } from "./config.js";
import type { GiftBox } from "./game.js";
import type { GiftReach } from "./reach.js";

/** What a bot reads of a round: the local game, or (debug autopilot online) the drawn snapshot. */
export interface GiftBotView {
  readonly round: { readonly phase: string; readonly tick: number };
  readonly seats: readonly PlayerId[];
  readonly pile: number;
  readonly home: readonly number[];
  readonly carrying: readonly boolean[];
  readonly boxes: readonly GiftBox[];
  /** Ticks left. */
  readonly stun: readonly number[];
  readonly guard: readonly number[];
  playing(slot: number): boolean;
  homeOf(slot: number): { x: number; z: number };
  /** Pelvis position and horizontal velocity. */
  position(slot: number): { x: number; y: number; z: number };
  velocity(slot: number): { x: number; z: number };
  reachOf(slot: PlayerId): GiftReach | null;
}

export const GIFT_BOT_LEVELS = ["easy", "medium", "hard"] as const;
export type GiftBotLevel = (typeof GIFT_BOT_LEVELS)[number];
export const GIFT_BOT_NAMES: Readonly<Record<GiftBotLevel, string>> = { easy: "Kolay", medium: "Orta", hard: "Zor" };

/**
 * How each level plays (seconds and metres):
 * - `think`: how often it picks a goal again; `react`: delay before it punches a target in reach;
 * - `punch`: chance it punches at all when it could; `chase`: how far it goes after a carrier;
 * - `defend`: how near its home a rival must come before it goes to meet them (0: never);
 * - `lead`: seconds it aims ahead of a moving target; `slip`: chance per goal of wandering off
 *   for a moment; `press`: delay before it presses Tut once something is in reach.
 */
export const GIFT_BOTS: Readonly<Record<GiftBotLevel, { think: number; react: number; punch: number; chase: number; defend: number; lead: number; slip: number; press: number }>> = {
  easy: { think: 0.6, react: 0.4, punch: 0.4, chase: 2.5, defend: 0, lead: 0, slip: 0.18, press: 0.3 },
  medium: { think: 0.3, react: 0.2, punch: 0.75, chase: 4.5, defend: 2.8, lead: 0.15, slip: 0.06, press: 0.12 },
  hard: { think: 0.12, react: 0.08, punch: 0.97, chase: 7, defend: 4.2, lead: 0.3, slip: 0, press: 0.03 },
};
const DT = 1 / 60;
/** Clearance kept round the stand and the obstacles (a body's width and a little). */
const CLEAR = 0.6;
const IDLE: MovementInput = { x: 0, z: 0, jump: false };

interface Goal {
  kind: "home" | "pile" | "loose" | "steal" | "chase" | "defend" | "wait" | "wander";
  x: number;
  z: number;
  /** The box, home owner or player it is about. */
  target: number;
}

/**
 * A rival that plays the round through the same inputs as a person (movement, Tut, Yumruk):
 * while the pile lasts it fetches boxes from the middle; then it steals from the rival with
 * the most at home; it picks up boxes lying near; it punches a carrier in reach, chases one
 * near enough, and goes to meet a rival closing on its own home. Never touches the game's state.
 */
export class GiftBot {
  goal: Goal = { kind: "wait", x: 0, z: 0, target: -1 };
  private readonly random: () => number;
  private thinkIn = 0;
  private punchIn = -1;
  private pressIn = -1;
  private pressCooldown = 0;
  private punchCooldown = 0;
  private stuck = { x: 0, z: 0, time: 0, side: 0, sideFor: 0 };
  constructor(readonly slot: PlayerId, readonly level: GiftBotLevel = "medium", seed = 1) {
    this.random = mulberry32((seed * 7919 + slot * 104729) >>> 0);
  }
  get tuning() {
    return GIFT_BOTS[this.level];
  }
  reset() {
    this.goal = { kind: "wait", x: 0, z: 0, target: -1 };
    this.thinkIn = this.random() * this.tuning.think;
    this.punchIn = this.pressIn = -1;
    this.pressCooldown = this.punchCooldown = 0;
    this.stuck = { x: 0, z: 0, time: 0, side: 0, sideFor: 0 };
  }
  update(game: GiftBotView): MovementInput {
    const me = this.slot;
    if (game.round.phase !== "playing" || !game.playing(me) || game.stun[me] > 0) {
      this.punchIn = this.pressIn = -1;
      return IDLE;
    }
    const t = this.tuning,
      p = game.position(me);
    this.pressCooldown = Math.max(0, this.pressCooldown - DT);
    this.punchCooldown = Math.max(0, this.punchCooldown - DT);
    if ((this.thinkIn -= DT) <= 0) {
      this.thinkIn = t.think * (0.75 + 0.5 * this.random());
      this.goal = this.choose(game);
    } else this.track(game);
    // Tut: as soon as something is in reach (after the level's delay).
    let pickup = false;
    if (!game.carrying[me] && this.pressCooldown <= 0 && game.reachOf(me)) {
      if (this.pressIn < 0) this.pressIn = t.press * (0.6 + 0.8 * this.random());
      else if ((this.pressIn -= DT) <= 0) {
        pickup = true;
        this.pressIn = -1;
        this.pressCooldown = 0.25;
      }
    } else if (!game.reachOf(me)) this.pressIn = -1;
    // Yumruk: a carrier in reach, or a rival in the bot's home.
    let punch = false;
    const victim = game.carrying[me] ? null : this.punchTarget(game);
    if (victim === null) this.punchIn = -1;
    else if (this.punchIn < 0) this.punchIn = this.random() < t.punch ? t.react * (0.6 + 0.8 * this.random()) : 0.6;
    else if ((this.punchIn -= DT) <= 0 && this.punchCooldown <= 0) {
      punch = this.random() < t.punch;
      this.punchIn = -1;
      this.punchCooldown = GIFT.punch.cooldown;
    }
    const move = this.drive(p.x, p.z);
    return { x: move.x, z: move.z, jump: false, punch, pickup };
  }
  /** Who the bot would punch now: the nearest carrier within the assist's reach, else a rival standing in its home close by. */
  private punchTarget(game: GiftBotView): PlayerId | null {
    const me = game.position(this.slot),
      home = game.homeOf(this.slot);
    let best: PlayerId | null = null,
      near = Infinity;
    for (const id of game.seats) {
      if (id === this.slot || !game.playing(id) || game.guard[id] > 0) continue;
      const q = game.position(id),
        d = Math.hypot(q.x - me.x, q.z - me.z),
        intruder = this.tuning.defend > 0 && game.home[this.slot] > 0 && Math.hypot(q.x - home.x, q.z - home.z) <= GIFT.homes.radius + 0.4;
      if ((game.carrying[id] && d <= GIFT.assist.range - 0.1) || (intruder && d <= 1.0)) if (d < near) {
        best = id;
        near = d;
      }
    }
    return best;
  }
  /** Keep a moving goal (a player) up to date between decisions. */
  private track(game: GiftBotView) {
    const g = this.goal;
    if (g.kind !== "chase" && g.kind !== "defend") return;
    if (!game.playing(g.target)) return;
    const q = game.position(g.target),
      v = game.velocity(g.target);
    g.x = q.x + v.x * this.tuning.lead;
    g.z = q.z + v.z * this.tuning.lead;
  }
  private choose(game: GiftBotView): Goal {
    const me = this.slot,
      t = this.tuning,
      p = game.position(me),
      tick = game.round.tick;
    const home = game.homeOf(me);
    if (game.carrying[me]) return { kind: "home", x: home.x, z: home.z, target: me };
    if (t.slip > 0 && this.random() < t.slip) {
      const a = this.random() * Math.PI * 2,
        r = 2 + this.random() * 5;
      return { kind: "wander", x: Math.sin(a) * r, z: Math.cos(a) * r, target: -1 };
    }
    const rivals = game.seats.filter((id) => id !== me && game.playing(id));
    const at = (id: number) => game.position(id);
    const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
    // A rival closing on (or inside) the home with boxes in it: go and meet them.
    if (t.defend > 0 && game.home[me] > 0) {
      const intruder = rivals
        .filter((id) => !game.carrying[id] && dist(at(id), home) <= GIFT.homes.radius + t.defend && dist(at(id), home) < dist(p, home) + 1.5)
        .sort((a, b) => dist(at(a), home) - dist(at(b), home))[0];
      if (intruder !== undefined) return this.toward("defend", game, intruder);
    }
    // A carrier near enough: knock the box off.
    const carrier = rivals
      .filter((id) => game.carrying[id] && game.guard[id] === 0 && dist(at(id), p) <= t.chase)
      .sort((a, b) => dist(at(a), p) - dist(at(b), p))[0];
    if (carrier !== undefined) return this.toward("chase", game, carrier);
    // A box on the floor, or about to land, close by (or anywhere once the pile is gone).
    const range = game.pile > 0 ? 4 : 20;
    const box = game.boxes
      .filter((b) => (b.land <= tick || t.lead > 0) && dist(b, p) <= range)
      .sort((a, b) => dist(a, p) - dist(b, p))[0];
    if (box) return { kind: "loose", x: box.x, z: box.z, target: box.id };
    if (game.pile > 0) {
      const d = Math.max(1e-3, Math.hypot(p.x, p.z)),
        r = GIFT.pedestal.radius + GIFT.reach.pile * 0.55;
      return { kind: "pile", x: (p.x / d) * r, z: (p.z / d) * r, target: -1 };
    }
    // Steal from the richest rival home (the nearer on a tie).
    const victim = game.seats
      .filter((id) => id !== me && game.home[id] > 0)
      .sort((a, b) => game.home[b] - game.home[a] || dist(game.homeOf(a), p) - dist(game.homeOf(b), p))[0];
    if (victim !== undefined) {
      const h = game.homeOf(victim);
      return { kind: "steal", x: h.x * 0.97, z: h.z * 0.97, target: victim };
    }
    // Nothing to take: wait at the edge of the home, facing the middle.
    return { kind: "wait", x: home.x * 0.72, z: home.z * 0.72, target: -1 };
  }
  private toward(kind: "chase" | "defend", game: GiftBotView, id: number): Goal {
    const q = game.position(id),
      v = game.velocity(id);
    return { kind, x: q.x + v.x * this.tuning.lead, z: q.z + v.z * this.tuning.lead, target: id };
  }
  /** Walk toward the goal round the stand and the obstacles; stop on arrival; sidestep when stuck. */
  private drive(x: number, z: number) {
    const g = this.goal,
      dx = g.x - x,
      dz = g.z - z,
      d = Math.hypot(dx, dz);
    const arrive = g.kind === "home" ? 0.35 : g.kind === "steal" ? 0.5 : g.kind === "wait" ? 0.6 : g.kind === "loose" ? 0.3 : g.kind === "pile" ? 0.25 : 0.15;
    // Stuck (pushed against someone or something): step aside for a moment.
    const s = this.stuck;
    s.time += DT;
    if (s.time >= 1.2) {
      const moved = Math.hypot(x - s.x, z - s.z);
      if (moved < 0.35 && d > 1) {
        s.side = this.random() < 0.5 ? -1 : 1;
        s.sideFor = 0.5;
      }
      s.x = x;
      s.z = z;
      s.time = 0;
    }
    if (d <= arrive) return { x: 0, z: 0 };
    let dir = steer(x, z, g.x, g.z);
    if (s.sideFor > 0) {
      s.sideFor -= DT;
      dir = { x: dir.x * 0.4 + -dir.z * s.side, z: dir.z * 0.4 + dir.x * s.side };
      const l = Math.hypot(dir.x, dir.z) || 1;
      dir = { x: dir.x / l, z: dir.z / l };
    }
    return dir;
  }
}

/**
 * Direction from (x, z) to (tx, tz) round the first solid circle (stand or obstacle, with
 * clearance) the straight line would cross: along the tangent on the nearer side.
 */
export function steer(x: number, z: number, tx: number, tz: number) {
  const dx = tx - x,
    dz = tz - z,
    length = Math.hypot(dx, dz);
  if (length < 1e-6) return { x: 0, z: 0 };
  let block: { x: number; z: number; r: number } | null = null,
    first = Infinity;
  for (const solid of GIFT_SOLIDS) {
    const r = solid.r + CLEAR,
      sx = solid.x - x,
      sz = solid.z - z,
      along = (sx * dx + sz * dz) / length;
    if (along <= 0 || along >= length + r) continue;
    const off = Math.abs(sx * dz - sz * dx) / length;
    if (off >= r || Math.hypot(tx - solid.x, tz - solid.z) < r) continue;
    if (along < first) {
      first = along;
      block = { ...solid, r };
    }
  }
  if (!block) return { x: dx / length, z: dz / length };
  const sx = block.x - x,
    sz = block.z - z,
    centre = Math.hypot(sx, sz),
    angle = Math.atan2(sx, sz),
    half = Math.asin(Math.min(1, block.r / Math.max(centre, 1e-6))) + 0.12,
    // The tangent nearer the straight line: the centre at a larger yaw than the path (cross > 0) → the smaller tangent.
    side = sx * dz - sz * dx > 0 ? -1 : 1,
    heading = angle + side * half;
  return { x: Math.sin(heading), z: Math.cos(heading) };
}
