import { hookPose, pivotX, swingAngle, tipAt, traceShot, type HookMotion, type MineItem } from "../../../../shared/party-lab/simulation/goldminer/mine";
import { hookState, itemKind, itemState, type GoldWire } from "../../../../shared/party-lab/simulation/goldminer/wire";
import type { AnyInputPacket } from "../../../../shared/party-lab/network/protocol";
import type { MovementInput } from "../../../../shared/party-lab/intent";
import type { GoldInputPacket } from "../../../../shared/party-lab/network/goldInput";
import type { GameStream } from "../../network/gameStream";

/** A shot this player made that the server has not shown yet: drawn as fired at once. */
export interface PendingShot {
  shot: number;
  at: number;
  angle: number;
  /** The swing origin it was fired from (after the last return). */
  origin: number;
}
/** One frame of a mine to show. */
export interface GoldFrame {
  wire: GoldWire;
  /** The moment to draw, ms after BAŞLA (negative during the countdown). */
  now: number;
  /** The winning lane at results (−1 none or a draw). */
  winner: number;
  round: number;
  /** This player's lane (−1 watching) and their unconfirmed shot. */
  self: number;
  pending: PendingShot | null;
}
/** Where the arena's mine comes from: the server (online) or a local game with bots. */
export interface GoldSource {
  frame(dt: number, paused: boolean): GoldFrame | null;
  /** A press now (performance.now()); true when it fired this player's hook. */
  press(now: number): boolean;
}

/** The hook's motion after it came home at `home`: swinging on from its shot's angle. */
const swingingAfter = (wire: GoldWire, lane: number) => wire.origin[lane] + (wire.home[lane] - wire.fired[lane]);
/** Can `lane` fire at `t`: mining, still in, and its hook is swinging then (home by `t`). */
export function canFire(wire: GoldWire, lane: number, t: number) {
  if (wire.phase !== "mining" || lane < 0 || lane >= wire.seats.length || wire.out[lane] || t < 0 || t > wire.limit * 1000) return false;
  const state = hookState(wire, lane);
  return state === "swing" || (state === "back" && t >= wire.home[lane]);
}
/** The swing origin `lane`'s hook has at `t` (it changes once a shot is home). */
export const originAt = (wire: GoldWire, lane: number) => (hookState(wire, lane) === "back" ? swingingAfter(wire, lane) : wire.origin[lane]);

/**
 * The client half of the aim: a clock in ms after BAŞLA, and the shot it stamps with it.
 * BAŞLA on this clock is the earliest `received − mining clock` seen: a snapshot always
 * arrives after it was sent, so this clock never leads the server's (it trails it by about
 * the one-way delay). A press is stamped on it and drawn at once at the angle on screen; the
 * server fires it from that moment and angle when it is at most `aimToleranceMs` old.
 */
export class GoldMinerClient {
  private round = -1;
  private goAt = Infinity;
  /** The countdown's BAŞLA estimate (only to keep the hooks swinging smoothly before it). */
  private countdownGo = Infinity;
  pending: PendingShot | null = null;
  private sent = false;
  observe(wire: GoldWire, round: number, received: number, lane: number) {
    if (round !== this.round) {
      this.round = round;
      this.goAt = this.countdownGo = Infinity;
      this.pending = null;
    }
    if (wire.phase === "countdown") this.countdownGo = Math.min(this.countdownGo, received + wire.countdown * 1000);
    else this.goAt = Math.min(this.goAt, received - wire.elapsed);
    const p = this.pending;
    // Confirmed (the server's hook shows it), or refused: it never showed up in time.
    if (p && lane >= 0 && (wire.shots[lane] >= p.shot || wire.phase !== "mining" || wire.elapsed > p.at + 1000)) this.pending = null;
  }
  get started() {
    return Number.isFinite(this.goAt);
  }
  /** The mining clock at `now` (performance.now()), ms after BAŞLA. */
  clock(now: number) {
    if (Number.isFinite(this.goAt)) return now - this.goAt;
    if (Number.isFinite(this.countdownGo)) return Math.min(0, now - this.countdownGo);
    return 0;
  }
  /** A press at `now` by `lane`: fires (and waits to be sent) when its hook is swinging on screen. */
  press(now: number, wire: GoldWire | undefined, lane: number) {
    if (!wire || !this.started || this.pending) return false;
    const t = this.clock(now);
    if (!canFire(wire, lane, t)) return false;
    const origin = originAt(wire, lane);
    this.pending = { shot: wire.shots[lane] + 1, at: t, angle: swingAngle(t, origin), origin };
    this.sent = false;
    return true;
  }
  /** Sends the pending shot once; a refused send is tried again next frame. */
  flush(send: (shot: { shot: number; at: number }) => boolean) {
    if (this.pending && !this.sent) this.sent = send({ shot: this.pending.shot, at: this.pending.at });
  }
}

export interface GoldMinerOnline {
  stream: GameStream;
  sendInput: (input: MovementInput) => AnyInputPacket | null | undefined;
}
/** Online: shots go to the server stamped; the mine shown is the server's. */
export class OnlineGoldSource implements GoldSource {
  readonly client = new GoldMinerClient();
  private wire: GoldWire | undefined;
  /** The arena refreshes this every render (the stream and sender it should use now). */
  constructor(public online: GoldMinerOnline, readonly round: number, readonly self: number) {}
  frame(): GoldFrame | null {
    const latest = this.online.stream.snapshots.latest,
      wire = latest?.snapshot.gold;
    if (!latest || !wire || latest.snapshot.round !== this.round) return null;
    this.wire = wire;
    this.client.observe(wire, this.round, latest.received, this.self);
    this.client.flush(({ shot, at }) => !!this.online.sendInput({ x: 0, z: 0, jump: false, gold: { seq: 0, round: this.round, shot, at } satisfies GoldInputPacket }));
    const now = this.client.clock(performance.now());
    return { wire, now: drawTime(wire, now), winner: wire.seats.indexOf(latest.snapshot.winner), round: this.round, self: this.self, pending: this.client.pending };
  }
  press(now: number) {
    return this.client.press(now, this.wire, this.self);
  }
}
/** The moment to draw: never past the end (results freeze the mine), never past the limit. */
export const drawTime = (wire: GoldWire, t: number) => (wire.phase === "results" ? wire.elapsed : wire.phase === "countdown" ? Math.min(0, t) : Math.min(t, wire.limit * 1000));

/** A hook as drawn: its pose, the item on it (index, −1 none) and whether it is reeling in. */
export interface HookView {
  angle: number;
  length: number;
  state: "swing" | "out" | "back";
  item: number;
  /** Where the item sat relative to the tip when it was caught (it rides there). */
  carry: { x: number; y: number } | null;
  /** An item this hook has already brought up on this screen, before the server says so (−1 none). */
  landed: number;
}
const motion = (wire: GoldWire, lane: number): HookMotion => ({
  state: hookState(wire, lane),
  origin: wire.origin[lane],
  angle: wire.angle[lane],
  fired: wire.fired[lane],
  turn: wire.turn[lane],
  reach: wire.reach[lane],
  home: wire.home[lane],
});
export const wireItems = (wire: GoldWire): MineItem[] => wire.kind.map((_, i) => ({ kind: itemKind(wire, i), x: wire.x[i], y: wire.y[i], r: wire.r[i] }));

/**
 * Every hook at `t`, as the server has it, carried on between snapshots: a hook still going
 * out takes the first free item on its line (what the server will decide unless two hooks
 * race for it), and this player's unconfirmed shot is drawn as fired.
 */
export function hookViews(frame: GoldFrame): HookView[] {
  const { wire, now: t, self, pending } = frame,
    lanes = wire.seats.length,
    items = wireItems(wire);
  return wire.seats.map((_, lane) => {
    const px = pivotX(lane, lanes);
    let m = motion(wire, lane),
      item = wire.item[lane];
    if (lane === self && pending && wire.shots[lane] < pending.shot) {
      m = { state: "out", origin: pending.origin, angle: pending.angle, fired: pending.at, turn: 0, reach: 0, home: 0 };
      item = -1;
    }
    let landed = -1;
    if (m.state === "out") {
      const path = traceShot(items, px, m.angle, m.fired, (i) => itemState(wire, i) !== "free");
      if (t >= path.turn) {
        m = { ...m, state: "back", turn: path.turn, reach: path.reach, home: path.home };
        item = path.item;
      }
    }
    if (m.state === "back" && t >= m.home) {
      landed = item;
      m = { ...m, state: "swing", origin: m.origin + (m.home - m.fired) };
    }
    const pose = hookPose(m, t);
    let carry: HookView["carry"] = null;
    if (m.state === "back" && item >= 0) {
      const at = tipAt(px, { angle: m.angle, length: m.reach });
      carry = { x: wire.x[item] - at.x, y: wire.y[item] - at.y };
    } else item = -1;
    return { ...pose, state: m.state, item, carry, landed };
  });
}

/** This lane is still mining and can play (BAŞLA seen, not left). */
export const mining = (wire: GoldWire | undefined, lane: number) => !!wire && wire.phase === "mining" && lane >= 0 && !wire.out[lane];
/** Seconds of mining left at `t`. */
export const timeLeft = (wire: GoldWire, t: number) => Math.max(0, wire.limit - Math.max(0, t) / 1000);
