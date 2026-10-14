import type { FeedbackEvent } from "../../../../shared/party-lab/feedback/events";
import type { MovementInput } from "../../../../shared/party-lab/intent";
import { homeAngle } from "../../../../shared/party-lab/maps/gifts";
import { LAYER_RESULTS, NET, neutralIntent, type AnyInputPacket } from "../../../../shared/party-lab/network/protocol";
import { GiftBot, type GiftBotLevel, GIFT_BOT_NAMES } from "../../../../shared/party-lab/simulation/gifts/bots";
import { GiftGame } from "../../../../shared/party-lab/simulation/gifts/game";
import { GIFT_TICKS } from "../../../../shared/party-lab/simulation/gifts/config";
import { decodeGiftWire, giftFlags, giftWire, type DecodedGift } from "../../../../shared/party-lab/simulation/gifts/wire";
import { IDLE_INPUT, PHYSICS } from "../../../../shared/party-lab/simulation/physics";
import { PARTS } from "../../../../shared/party-lab/simulation/ragdoll/config";
import type { GameStream } from "../../network/gameStream";
import { LocalPrediction } from "../../network/prediction/localPrediction";
import { ACCUMULATOR_START, FrameClock, frameTime } from "../frameClock";
import { layerIntent } from "../layers/controls";
import { PLAYERS } from "../players";
import { localCostumeForSlot, type CostumeId, type SelectableCostumeId } from "../visual/costumes";

/** Raw controls since the last frame: movement in device axes (x right, z down the screen), and the presses. */
export interface GiftControls {
  x: number;
  z: number;
  jump: boolean;
  punch: boolean;
  pickup: boolean;
}
export const NO_GIFT_CONTROLS: GiftControls = { x: 0, z: 0, jump: false, punch: false, pickup: false };
/** How a seat looks: its colour, character and name. */
export interface GiftLook {
  color: string;
  costume: CostumeId;
  name: string;
}
/** One frame of the yard to draw. */
export interface GiftFrame {
  round: number;
  /** This player's slot (−1 watching). */
  self: number;
  /** The view's turn: the yaw "up the screen" points (this player's home at the bottom). */
  yaw: number;
  phase: "countdown" | "playing" | "results";
  /** Countdown: seconds left. */
  countdown: number;
  gift: DecodedGift;
  /** Round tick shown (fractional): the clock and the boxes in the air run on it. */
  tick: number;
  /** Per slot: the nine parts' poses (x y z qx qy qz qw), or null when not drawn. */
  poses: (Float32Array | null)[];
  /** Per slot: hit flash 0…1. */
  flash: number[];
  /** The winning slot at results (−1 none or a draw). */
  winner: number;
  /** Sounds to play this frame (punches, bumps, countdown). */
  feedback: FeedbackEvent[];
}
export interface GiftSource {
  frame(dt: number, controls: GiftControls, off: boolean): GiftFrame | null;
  dispose(): void;
}

/** The yaw up the screen for `slot`'s view: its home at the bottom, the pile above it. */
export const viewYaw = (gift: Pick<DecodedGift, "seats" | "players">, slot: number) => homeAngle(gift.players, Math.max(0, gift.seats.indexOf(slot))) + Math.PI;
/** Device controls (x right, z down the screen) to a world movement intent for a view turned by `yaw`. */
export function worldIntent(c: GiftControls, yaw: number): MovementInput {
  const intent = layerIntent({ x: c.x, z: c.z, jump: c.jump, punch: c.punch, grab: false, lift: false }, yaw);
  return { x: intent.x, z: intent.z, jump: c.jump, punch: c.punch, pickup: c.pickup };
}
/** Presses wait for the next step (a frame can run none). */
class Presses {
  jump = false;
  punch = false;
  pickup = false;
  add(c: GiftControls) {
    this.jump ||= c.jump;
    this.punch ||= c.punch;
    this.pickup ||= c.pickup;
  }
  take(c: GiftControls): GiftControls {
    const out = { x: c.x, z: c.z, jump: this.jump, punch: this.punch, pickup: this.pickup };
    this.jump = this.punch = this.pickup = false;
    return out;
  }
  clear() {
    this.jump = this.punch = this.pickup = false;
  }
}
const phaseOf = (p: string): GiftFrame["phase"] => (p === "playing" ? "playing" : p === "results" ? "results" : "countdown");

/** The local looks: you in your costume, the bots in the other two, slot colours. */
export function localLooks(players: 2 | 3, level: GiftBotLevel, costume: SelectableCostumeId): GiftLook[] {
  return PLAYERS.slice(0, players).map((p, i) => ({ color: p.color, costume: localCostumeForSlot(costume, i), name: i === 0 ? "Sen" : `${GIFT_BOT_NAMES[level]} Bot ${i}` }));
}

/**
 * Yerel Test Arenası: the shared game with this player (slot 0) and 1–2 bots of one level,
 * stepped at 60 Hz. The result stays on screen until a new round is asked for.
 */
export class LocalGift implements GiftSource {
  readonly game: GiftGame;
  readonly bots: GiftBot[];
  /** `?giftDebug=1`: a bot plays slot 0 through the same controls. */
  autopilot: GiftBot | null = null;
  private accumulator = 0;
  private readonly previous = PLAYERS.map(() => new Float32Array(63));
  private readonly current = PLAYERS.map(() => new Float32Array(63));
  private readonly shown = PLAYERS.map(() => new Float32Array(63));
  private readonly presses = new Presses();
  private readonly queue: FeedbackEvent[] = [];
  private gift: DecodedGift | null = null;
  constructor(readonly players: 2 | 3, readonly level: GiftBotLevel, seed = Math.floor(Math.random() * 2 ** 32)) {
    this.game = new GiftGame((event) => this.queue.push(event), { players, seed });
    this.bots = this.game.seats.filter((slot) => slot !== 0).map((slot) => new GiftBot(slot, level, seed));
    this.bots.forEach((bot) => bot.reset());
    this.capture(true);
  }
  private capture(snap: boolean) {
    for (const player of this.game.physics.players) {
      const out = this.current[player.id];
      if (!snap) this.previous[player.id].set(out);
      let i = 0;
      for (const name of PARTS) {
        const body = player.parts[name].body,
          p = body.translation(),
          q = body.rotation();
        out[i++] = p.x; out[i++] = p.y; out[i++] = p.z; out[i++] = q.x; out[i++] = q.y; out[i++] = q.z; out[i++] = q.w;
      }
      if (snap) this.previous[player.id].set(out);
    }
    this.gift = decodeGiftWire(giftWire(this.game, giftFlags(this.game), this.game.round.reason ? LAYER_RESULTS.indexOf(this.game.round.reason) : 0));
  }
  frame(dt: number, controls: GiftControls, off: boolean): GiftFrame | null {
    const g = this.game,
      yaw = viewYaw({ seats: g.seats, players: g.players }, 0);
    if (!off) this.presses.add(controls);
    else this.presses.clear();
    // The result stays until a new round: the game is not stepped on into its reset.
    if (g.round.phase !== "results" && !off) {
      this.accumulator += Math.min(dt, 0.1);
      while (this.accumulator >= PHYSICS.step) {
        this.accumulator -= PHYSICS.step;
        const inputs: MovementInput[] = PLAYERS.map(() => IDLE_INPUT);
        inputs[0] = this.autopilot ? this.autopilot.update(g) : worldIntent(this.presses.take(controls), yaw);
        for (const bot of this.bots) inputs[bot.slot] = bot.update(g);
        g.step(inputs);
        this.capture(false);
        if ((g.round.phase as string) === "results") break;
      }
    }
    const alpha = g.round.phase === "results" ? 1 : Math.min(1, this.accumulator / PHYSICS.step),
      poses = PLAYERS.map(({ id }) => {
        if (g.seatOf[id] < 0 || g.physics.players[id].eliminated) return null;
        const a = this.previous[id],
          b = this.current[id],
          out = this.shown[id];
        for (let i = 0; i < 63; i++) out[i] = a[i] + (b[i] - a[i]) * alpha;
        return out;
      });
    const feedback = this.queue.splice(0);
    const gift = this.gift!,
      phase = phaseOf(g.round.phase);
    return {
      round: 1,
      self: 0,
      yaw,
      phase,
      countdown: phase === "countdown" ? Math.max(0, (GIFT_TICKS.countdown - g.round.tick) / 60) : 0,
      gift,
      tick: phase === "playing" ? gift.tick + alpha : gift.tick,
      poses,
      flash: PLAYERS.map(({ id }) => Math.min(1, g.brawl.fighters[id].flash / 0.15)),
      winner: phase === "results" ? g.round.winner ?? -1 : -1,
      feedback: off ? [] : feedback,
    };
  }
  dispose() {
    this.game.dispose();
  }
}

export interface GiftOnline {
  stream: GameStream;
  sendInput: (input: MovementInput) => AnyInputPacket | null | undefined;
}
/**
 * Online: the server's yard. Own body predicted (the shared rig) and drawn at once; everyone
 * else drawn from the snapshots a moment behind (interpolated). Boxes, homes, carriers and
 * stuns come from the newest snapshot; nothing here decides any of them.
 */
export class OnlineGiftSource implements GiftSource {
  prediction: LocalPrediction | null = null;
  private readonly clock = new FrameClock();
  private accumulator = ACCUMULATOR_START;
  private readonly presses = new Presses();
  private readonly shown = PLAYERS.map(() => new Float32Array(63));
  private readonly flash = PLAYERS.map(() => 0);
  private sending = false;
  private lastYaw = 0;
  constructor(public online: GiftOnline, readonly round: number, readonly slot: number) {}
  frame(rendererDt: number, controls: GiftControls, off: boolean): GiftFrame | null {
    const { stream, sendInput } = this.online,
      started = performance.now(),
      dt = this.clock.step(frameTime(started), rendererDt);
    const latestFrame = stream.snapshots.latest,
      latest = latestFrame?.snapshot.mode === "gift_grab" && latestFrame.snapshot.round === this.round ? latestFrame : null;
    if (!latest) return null;
    const snapshot = latest.snapshot,
      gift = decodeGiftWire(snapshot.gift);
    if (!gift) return null;
    const slot = this.slot,
      yaw = slot >= 0 && gift.seats.includes(slot) ? viewYaw(gift, slot) : viewYaw(gift, gift.seats[0]);
    this.lastYaw = yaw;
    const alive = slot >= 0 && !!(snapshot.alive & (1 << slot)),
      enabled = !off && snapshot.phase === "playing" && alive;
    const predictor = this.prediction;
    if (enabled) predictor?.reconcile(latest, started);
    if (!off) this.presses.add(controls);
    else this.presses.clear();
    const sampled = stream.snapshots.sample(this.clock.time);
    const displayedTick = Math.max(0, Math.floor((stream.snapshots.renderMs * NET.physicsHz) / 1000));
    const feedback: FeedbackEvent[] = [];
    if (!enabled || dt > 0.25) {
      predictor?.suspend();
      this.accumulator = ACCUMULATOR_START;
      if (this.sending || dt > 0.25) sendInput(neutralIntent());
      this.sending = false;
    } else {
      this.sending = true;
      this.accumulator += Math.min(dt, 0.05);
      const ticks = this.accumulator + 1e-6 >= 1 / NET.inputHz ? Math.min(3, Math.floor((this.accumulator + 1e-6) * NET.physicsHz)) : 0;
      if (ticks > 0) {
        this.accumulator -= ticks / NET.physicsHz;
        const intent = worldIntent(this.presses.take(controls), yaw);
        intent.viewTick = displayedTick;
        const packet = sendInput(intent);
        if (packet) {
          const result = predictor?.advance(packet, ticks, started);
          if (result?.swing && slot >= 0) {
            feedback.push({ name: "punchSwing", actor: slot, x: predictor!.rig.character.body.translation().x });
            stream.markLocalSwing(packet.round, slot, packet.seq);
          }
        }
      }
    }
    const localPose = enabled ? predictor?.pose(Math.min(dt, 0.1), Math.min(1, this.accumulator * NET.physicsHz)) ?? null : null;
    const poses: (Float32Array | null)[] = PLAYERS.map(() => null);
    if (sampled && sampled.b.snapshot.mode === "gift_grab") {
      const { a, b, alpha } = sampled;
      for (const { id } of PLAYERS) {
        const inMatch = gift.seats.includes(id) && !!(b.snapshot.mask & (1 << id));
        if (!inMatch || !(b.snapshot.alive & (1 << id))) continue;
        if (id === slot && localPose) {
          poses[id] = localPose;
          continue;
        }
        const out = this.shown[id];
        for (let i = 0; i < 9; i++) {
          const o = (id * 9 + i) * 7,
            at = i * 7;
          out[at] = a.values[o] + (b.values[o] - a.values[o]) * alpha;
          out[at + 1] = a.values[o + 1] + (b.values[o + 1] - a.values[o + 1]) * alpha;
          out[at + 2] = a.values[o + 2] + (b.values[o + 2] - a.values[o + 2]) * alpha;
          slerp(a.values, b.values, o + 3, alpha, out, at + 3);
        }
        poses[id] = out;
      }
      for (const event of stream.drain(b.snapshot.round, stream.snapshots.renderMs, (e) => e.actor === slot || e.target === slot)) {
        if (off || (typeof document !== "undefined" && document.hidden)) continue;
        feedback.push(event);
        if ((event.name === "bodyHit" || event.name === "headHit" || event.name === "limbHit") && event.target !== undefined) this.flash[event.target] = 1;
      }
    }
    for (const { id } of PLAYERS) this.flash[id] = Math.max(0, this.flash[id] - dt / 0.15);
    const phase = phaseOf(snapshot.phase);
    const tick = phase === "playing" ? gift.tick + Math.max(0, Math.min(0.25, (started - latest.received) / 1000)) * NET.physicsHz : gift.tick;
    return {
      round: snapshot.round,
      self: slot,
      yaw,
      phase,
      countdown: phase === "countdown" ? snapshot.seconds : 0,
      gift,
      tick,
      poses,
      flash: [...this.flash],
      winner: snapshot.winner,
      feedback,
    };
  }
  get yaw() {
    return this.lastYaw;
  }
  dispose() {
    this.prediction?.dispose();
    this.prediction = null;
  }
}

/** Spherical blend of the quaternion at `a[i…i+3]` → `b[i…i+3]` into `out[o…o+3]`. */
function slerp(a: Float32Array, b: Float32Array, i: number, t: number, out: Float32Array, o: number) {
  let bx = b[i], by = b[i + 1], bz = b[i + 2], bw = b[i + 3];
  const ax = a[i], ay = a[i + 1], az = a[i + 2], aw = a[i + 3];
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) {
    cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  let k0 = 1 - t,
    k1 = t;
  if (cos < 0.9995) {
    const angle = Math.acos(cos),
      sin = Math.sin(angle);
    k0 = Math.sin((1 - t) * angle) / sin;
    k1 = Math.sin(t * angle) / sin;
  }
  const x = ax * k0 + bx * k1, y = ay * k0 + by * k1, z = az * k0 + bz * k1, w = aw * k0 + bw * k1,
    l = Math.hypot(x, y, z, w) || 1;
  out[o] = x / l; out[o + 1] = y / l; out[o + 2] = z / l; out[o + 3] = w / l;
}
