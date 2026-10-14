import { BOX_TOWER as T } from "../../../../shared/party-lab/simulation/boxtower/config";
import { BoxTowerGame, type TowerPress } from "../../../../shared/party-lab/simulation/boxtower/game";
import { columnAt, slideX, type Slide } from "../../../../shared/party-lab/simulation/boxtower/motion";
import { TowerBot, TOWER_BOT_NAMES, type TowerBotLevel, type TowerBotView } from "../../../../shared/party-lab/simulation/boxtower/bots";
import { laneHeights, towerSection, wireSlide, type TowerWire } from "../../../../shared/party-lab/simulation/boxtower/wire";
import type { TowerInputPacket } from "../../../../shared/party-lab/network/towerInput";
import type { AnyInputPacket } from "../../../../shared/party-lab/network/protocol";
import type { MovementInput } from "../../../../shared/party-lab/intent";
import type { GameStream } from "../../network/gameStream";
import { PLAYERS } from "../players";
import { localCostumeForSlot, type CostumeId, type SelectableCostumeId } from "../visual/costumes";

/** A drop this player made that the server has not shown yet: drawn as falling at once. */
export interface PendingDrop {
  drop: number;
  at: number;
  column: number;
  land: number;
}
/** One frame of the yards to show. */
export interface TowerFrame {
  wire: TowerWire;
  /** The moment to draw, ms after BAŞLA (negative during the countdown). */
  now: number;
  /** The winning lane at results (−1 none or a draw). */
  winner: number;
  round: number;
  /** This player's lane (−1 watching) and their unconfirmed drop. */
  self: number;
  pending: PendingDrop | null;
}
/** Where the yards come from: the server (online) or a local game with bots. */
export interface TowerSource {
  frame(dt: number, paused: boolean): TowerFrame | null;
  /** A press now (performance.now()); true when it dropped this player's box. */
  press(now: number): boolean;
}
/** A player as drawn: colour, character, name. */
export interface TowerLook {
  color: string;
  costume: CostumeId;
  name: string;
}

/** Can `lane` drop at `t`: stacking, still in, nothing in the air, its box sliding then, before the time is up. */
export function canDrop(wire: TowerWire, lane: number, t: number) {
  return (
    wire.phase === "stacking" &&
    lane >= 0 &&
    lane < wire.seats.length &&
    !wire.out[lane] &&
    wire.fallColumn[lane] < 0 &&
    t >= wire.spawn[lane] &&
    t >= 0 &&
    t < wire.limit * 1000
  );
}

/**
 * The client half of the aim (as Altın Madenci): a clock in ms after BAŞLA, and the drop it
 * stamps with it. BAŞLA on this clock is the earliest `received − stacking clock` seen: a
 * snapshot always arrives after it was sent, so this clock never leads the server's. A press is
 * stamped on it and drawn at once into the column under the box on screen; the server drops it
 * from that moment when it is at most `aimToleranceMs` old.
 */
export class TowerClient {
  private round = -1;
  private goAt = Infinity;
  /** The countdown's BAŞLA estimate (only to draw the countdown smoothly). */
  private countdownGo = Infinity;
  pending: PendingDrop | null = null;
  private sent = false;
  observe(wire: TowerWire, round: number, received: number, lane: number) {
    if (round !== this.round) {
      this.round = round;
      this.goAt = this.countdownGo = Infinity;
      this.pending = null;
    }
    if (wire.phase === "countdown") this.countdownGo = Math.min(this.countdownGo, received + wire.countdown * 1000);
    else this.goAt = Math.min(this.goAt, received - wire.elapsed);
    const p = this.pending;
    // Confirmed (the server counts it), or refused: it never showed up in time.
    if (p && lane >= 0 && (wire.drops[lane] >= p.drop || wire.phase !== "stacking" || wire.elapsed > p.at + 1000)) this.pending = null;
  }
  get started() {
    return Number.isFinite(this.goAt);
  }
  /** The stacking clock at `now` (performance.now()), ms after BAŞLA. */
  clock(now: number) {
    if (Number.isFinite(this.goAt)) return now - this.goAt;
    if (Number.isFinite(this.countdownGo)) return Math.min(0, now - this.countdownGo);
    return 0;
  }
  /** A press at `now` by `lane`: drops (and waits to be sent) when its box slides on screen. */
  press(now: number, wire: TowerWire | undefined, lane: number) {
    if (!wire || !this.started || this.pending) return false;
    const t = this.clock(now);
    if (!canDrop(wire, lane, t)) return false;
    this.pending = { drop: wire.drops[lane] + 1, at: t, column: columnAt(wireSlide(wire, lane), t), land: t + T.fallMs };
    this.sent = false;
    return true;
  }
  /** Sends the pending drop once; a refused send is tried again next frame. */
  flush(send: (drop: { drop: number; at: number }) => boolean) {
    if (this.pending && !this.sent) this.sent = send({ drop: this.pending.drop, at: this.pending.at });
  }
}

/** The moment to draw: results freeze the yards; boxes pressed in time may land a little after the limit. */
export const drawTime = (wire: TowerWire, t: number) =>
  wire.phase === "results" ? wire.elapsed : wire.phase === "countdown" ? Math.min(0, t) : Math.min(t, wire.limit * 1000 + T.aimToleranceMs + T.fallMs + 100);

export interface TowerOnline {
  stream: GameStream;
  sendInput: (input: MovementInput) => AnyInputPacket | null | undefined;
}
/** Online: drops go to the server stamped; the yards shown are the server's. */
export class OnlineTowerSource implements TowerSource {
  readonly client = new TowerClient();
  private wire: TowerWire | undefined;
  /** The arena refreshes this every render (the stream and sender it should use now). */
  constructor(public online: TowerOnline, readonly round: number, readonly self: number) {}
  frame(): TowerFrame | null {
    const latest = this.online.stream.snapshots.latest,
      wire = latest?.snapshot.tower;
    if (!latest || !wire || latest.snapshot.round !== this.round) return null;
    this.wire = wire;
    this.client.observe(wire, this.round, latest.received, this.self);
    this.client.flush(({ drop, at }) => !!this.online.sendInput({ x: 0, z: 0, jump: false, tower: { seq: 0, round: this.round, drop, at } satisfies TowerInputPacket }));
    const now = this.client.clock(performance.now());
    return { wire, now: drawTime(wire, now), winner: wire.seats.indexOf(latest.snapshot.winner), round: this.round, self: this.self, pending: this.client.pending };
  }
  press(now: number) {
    return this.client.press(now, this.wire, this.self);
  }
}

const STEP = 1 / T.hz;
/**
 * Yerel Test Arenası: the server's rules (BoxTowerGame) run here, with the player in lane 0 and
 * bots that really play in the others. It pauses while the menu is open.
 */
export class LocalTower implements TowerSource {
  readonly game: BoxTowerGame;
  readonly bots: TowerBot[];
  private acc = 0;
  private press_: TowerPress | null = null;
  constructor(readonly lanes: number, level: TowerBotLevel, random: () => number = Math.random) {
    this.game = new BoxTowerGame(lanes, random);
    this.bots = Array.from({ length: lanes - 1 }, () => new TowerBot(level, random));
  }
  /** The stacking clock now (between steps), ms after BAŞLA; negative in the countdown. */
  get now() {
    const g = this.game;
    return g.phase === "countdown" ? -(g.countdownTicks * 1000) / T.hz + this.acc * 1000 : g.elapsedMs + (g.phase === "stacking" ? this.acc * 1000 : 0);
  }
  private wire() {
    return towerSection(this.game, this.game.lanes.map((_, lane) => lane));
  }
  step() {
    const g = this.game,
      due = g.elapsedMs + 1000 / T.hz;
    const presses: (TowerPress | undefined)[] = [this.press_ ?? undefined];
    this.press_ = null;
    this.bots.forEach((bot, i) => {
      const lane = i + 1,
        l = g.lanes[lane];
      const at = bot.next({ playing: g.phase === "stacking" && !l.out, busy: !!l.falling, heights: l.heights, slide: l.slide }, due);
      presses[lane] = at === null ? undefined : { drop: l.drops + 1, at };
    });
    g.step(presses);
  }
  frame(dt: number, paused: boolean): TowerFrame {
    if (!paused) {
      this.acc += Math.min(dt, 0.25);
      while (this.acc >= STEP) {
        this.acc -= STEP;
        this.step();
      }
    }
    const wire = this.wire();
    return { wire, now: this.game.phase === "results" ? wire.elapsed : this.now, winner: this.game.winner(), round: 1, self: 0, pending: null };
  }
  press() {
    const t = this.now;
    if (this.press_ || !canDrop(this.wire(), 0, t)) return false;
    this.press_ = { drop: this.game.lanes[0].drops + 1, at: t };
    return true;
  }
}

/** A local round for `players` (the player plus bots of `level`): its source and the looks. */
export function localTower(players: 2 | 3, level: TowerBotLevel, costume: SelectableCostumeId) {
  const source = new LocalTower(players, level);
  const looks: TowerLook[] = source.game.lanes.map((_, lane) => ({
    color: PLAYERS[lane].color,
    costume: localCostumeForSlot(costume, lane),
    name: lane === 0 ? "Sen" : `${TOWER_BOT_NAMES[level]} Bot${players > 2 ? ` ${lane}` : ""}`,
  }));
  const first = towerSection(source.game, looks.map((_, lane) => lane));
  return { source, looks, first };
}

/** One yard as drawn at the frame's moment. */
export interface YardView {
  /** Boxes standing per column (a box this screen has seen land is in, before the server says so). */
  heights: number[];
  best: number;
  /** The sliding box: its middle (columns) and the column under it; null while none slides. */
  slider: { x: number; column: number; age: number } | null;
  /** The box in the air: its column and how far down (0 … 1). */
  falling: { column: number; progress: number } | null;
  /** The newest box down on this screen: its drop number, column, landing and whether it made the tallest column taller. */
  landed: { drop: number; column: number; land: number; good: boolean } | null;
}
/** The box in the air for `lane`: this player's unconfirmed drop, or the server's falling box. */
function airborne(frame: TowerFrame, lane: number) {
  const { wire, self, pending } = frame;
  if (lane === self && pending && wire.drops[lane] < pending.drop) return { ...pending, own: true };
  if (wire.fallColumn[lane] >= 0) return { drop: wire.drops[lane], column: wire.fallColumn[lane], at: wire.fallAt[lane], land: wire.fallLand[lane], own: false };
  return null;
}
/** Every yard at the frame's moment: the server's columns, carried on between snapshots. */
export function yardViews(frame: TowerFrame): YardView[] {
  const { wire, now: t } = frame;
  return wire.seats.map((_, lane) => {
    const heights = laneHeights(wire, lane);
    let best = wire.best[lane],
      falling: YardView["falling"] = null,
      landed: YardView["landed"] = wire.lastColumn[lane] >= 0 ? { drop: wire.placed[lane], column: wire.lastColumn[lane], land: wire.lastLand[lane], good: wire.lastGood[lane] } : null;
    const air = wire.phase === "results" ? null : airborne(frame, lane);
    if (air && t >= air.land) {
      const height = ++heights[air.column],
        good = height > best;
      if (good) best = height;
      landed = { drop: air.drop, column: air.column, land: air.land, good };
    } else if (air) falling = { column: air.column, progress: Math.max(0, Math.min(1, (t - air.at) / T.fallMs)) };
    let slider: YardView["slider"] = null;
    const s: Slide = wireSlide(wire, lane);
    if (!wire.out[lane] && !air) {
      if (wire.phase === "countdown") slider = { x: s.from, column: s.from, age: 1e9 };
      else if (wire.phase === "stacking" && t >= s.spawn && t < wire.limit * 1000) slider = { x: slideX(s, t), column: columnAt(s, t), age: t - s.spawn };
    }
    return { heights, best, slider, falling, landed };
  });
}

/** What the autopilot bot (and the local bots) see of `lane`'s yard in a frame. */
export function botView(frame: TowerFrame, lane: number): TowerBotView {
  const { wire, pending } = frame;
  return {
    playing: wire.phase === "stacking" && !wire.out[lane],
    busy: (lane === frame.self && !!pending) || wire.fallColumn[lane] >= 0,
    heights: laneHeights(wire, lane),
    slide: wireSlide(wire, lane),
  };
}
/** Seconds of stacking left at `t`. */
export const timeLeft = (wire: TowerWire, t: number) => Math.max(0, wire.limit - Math.max(0, t) / 1000);
