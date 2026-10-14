import type { MovementInput } from "../intent.js";
import type { FeedbackEvent } from "../feedback/events.js";
import { LAYER_RESULTS, NET, TRANSFORM_BYTES, type GameEvent, type GameSnapshot, type OnlinePhase } from "../network/protocol.js";
import { IDLE_INPUT } from "./physics.js";
import { PLAYERS, type PlayerId } from "./players.js";
import { PARTS } from "./ragdoll/config.js";
import { GiftGame, type GiftPose } from "./gifts/game.js";
import { giftFlags, giftWire } from "./gifts/wire.js";
import { captureGiftPredictionState } from "./predictionState.js";
import { newRoomCounters, type OnlineSimulation, type RoomCounters } from "./online.js";

const IDLE = PLAYERS.map(() => IDLE_INPUT);
const MAX_REWIND_TICKS = Math.round((NET.maxBombRewindMs / 1000) * NET.physicsHz);

interface PoseFrame {
  tick: number;
  poses: GiftPose[];
}

/**
 * Authoritative online Hediye Kapmaca around the shared game (the local arena drives the
 * same `GiftGame`). Boxes, homes, carriers, punches, stuns and the result are decided here;
 * a client predicts only its own body. A punch on a carrier is judged against the poses
 * that player was looking at when it was pressed (Bomba Sende's capped rewind).
 */
export class GiftRoundSimulation implements OnlineSimulation {
  readonly mode = "gift_grab" as const;
  private pending: FeedbackEvent[] = [];
  readonly game: GiftGame;
  phase: OnlinePhase = "waiting";
  mask = 0;
  private forfeitTick = -1;
  private history: PoseFrame[] = [];
  readonly section = { bytes: 0, encodeMs: 0 };
  readonly rewind = { punches: 0, lastMs: 0, maxMs: 0, clampedOld: 0, rejectedFuture: 0 };

  constructor(readonly counters: RoomCounters = newRoomCounters(), seed?: number) {
    this.game = new GiftGame((event) => this.pending.push(event), { seed });
    this.idle();
  }
  get physics() { return this.game.physics; }
  get round() { return this.game.round; }
  get roundId() { return this.counters.round; }
  get tick() { return this.counters.tick; }
  get seconds() { return this.phase === "waiting" ? 0 : this.round.seconds; }
  get winner() { return this.phase === "results" ? this.round.winner ?? -1 : -1; }
  /** Board placements: the most boxes at home first, leavers last. */
  placements() { return this.game.placements(); }
  private idle() {
    this.game.begin([]);
    this.mask = 0;
    this.forfeitTick = -1;
    this.history.length = 0;
  }
  start(slots: readonly PlayerId[]) {
    const unique = [...new Set(slots)].sort((a, b) => a - b);
    if (this.phase !== "waiting" || unique.length !== slots.length || unique.length < 2 || unique.length > 3 || unique.some((s) => !PLAYERS.some((p) => p.id === s))) return false;
    this.counters.round++;
    this.pending.length = 0;
    this.game.begin(unique);
    this.mask = unique.reduce<number>((mask, id) => mask | (1 << id), 0);
    this.forfeitTick = -1;
    this.phase = "countdown";
    this.history.length = 0;
    this.capturePose(this.tick);
    return true;
  }
  cancelCountdown() {
    if (this.phase !== "countdown") return;
    this.phase = "waiting";
    this.idle();
  }
  /** Disconnected: stands still (neutral input) and drops the box at its feet. */
  neutralize(slot: PlayerId) {
    if (this.mask & (1 << slot)) this.game.neutralize(slot);
  }
  remove(slot: PlayerId) {
    if (!(this.mask & (1 << slot))) return;
    const playing = this.phase === "playing" && this.round.alive[slot];
    this.game.forfeit(slot);
    if (playing) this.forfeitTick = this.round.tick;
  }
  private poseFrame(viewTick: number): readonly GiftPose[] | null {
    const now = this.tick;
    if (viewTick > now + 2) {
      this.rewind.rejectedFuture++;
      return null;
    }
    const oldest = now - MAX_REWIND_TICKS,
      wanted = Math.max(oldest, Math.min(now, viewTick));
    if (viewTick < oldest) this.rewind.clampedOld++;
    let best: PoseFrame | undefined;
    for (const frame of this.history) if (frame.tick <= wanted && (!best || frame.tick > best.tick)) best = frame;
    if (!best) return null;
    const ms = ((now - best.tick) * 1000) / NET.physicsHz;
    this.rewind.lastMs = ms;
    this.rewind.maxMs = Math.max(this.rewind.maxMs, ms);
    this.rewind.punches++;
    return best.poses;
  }
  private capturePose(tick: number) {
    const poses = this.physics.players.map((character) => ({
      pelvis: { ...character.body.translation() },
      chest: { ...character.parts.torso.body.translation() },
    }));
    this.history.push({ tick, poses });
    while (this.history.length > MAX_REWIND_TICKS + 2) this.history.shift();
  }
  step(inputs: readonly MovementInput[]): GameEvent[] {
    this.counters.tick++;
    this.pending.length = 0;
    if (this.phase === "waiting") return [];
    if (this.phase === "playing")
      for (const slot of this.game.seats) {
        const input = inputs[slot];
        this.game.rewind[slot] = input?.punch && Number.isSafeInteger(input.viewTick) ? this.poseFrame(input.viewTick as number) : null;
      }
    const event = this.game.step(this.phase === "playing" ? inputs : IDLE);
    if (event === "started") this.phase = "playing";
    else if (event === "finished") this.phase = "results";
    else if (event === "reset") {
      this.phase = "waiting";
      this.idle();
      this.pending.length = 0;
    }
    this.capturePose(this.tick);
    return this.pending.map((e) => ({ ...e, id: ++this.counters.event, round: this.roundId, tick: this.tick }));
  }
  private resultCode() {
    if (this.phase !== "results" || !this.round.reason) return 0;
    if (this.round.reason === "survivor" && this.forfeitTick >= 0 && this.forfeitTick === this.round.endedAt) return LAYER_RESULTS.indexOf("forfeit");
    return LAYER_RESULTS.indexOf(this.round.reason);
  }
  snapshot(ack: number[]): GameSnapshot {
    const transforms = new Uint8Array(TRANSFORM_BYTES),
      view = new DataView(transforms.buffer);
    let offset = 0;
    for (const player of this.physics.players)
      for (const name of PARTS) {
        const body = player.parts[name].body,
          p = body.translation(),
          q = body.rotation();
        for (const value of [p.x, p.y, p.z, q.x, q.y, q.z, q.w]) {
          view.setFloat32(offset, value, true);
          offset += 4;
        }
      }
    const began = performance.now(),
      gift = giftWire(this.game, giftFlags(this.game), this.resultCode());
    this.section.encodeMs = performance.now() - began;
    return {
      v: NET.version,
      mode: this.mode,
      seq: ++this.counters.snapshot,
      tick: this.tick,
      round: this.roundId,
      phase: this.phase,
      seconds: this.seconds,
      winner: this.winner,
      mask: this.mask,
      alive: PLAYERS.reduce((mask, { id }) => mask | (this.mask & (1 << id) && this.round.alive[id] ? 1 << id : 0), 0),
      states: [],
      meters: [],
      grips: [],
      ack,
      transforms,
      gift,
    };
  }
  prediction(slot: PlayerId) {
    const g = this.game;
    return captureGiftPredictionState(
      this.physics.players[slot],
      g.brawl.fighters[slot],
      !!(this.mask & (1 << slot)) && this.round.alive[slot],
      g.carrying[slot],
      g.stun[slot],
      g.homeOf(slot)
    );
  }
  dispose() {
    this.pending.length = 0;
    this.history.length = 0;
    this.game.dispose();
  }
}
