import type { MovementInput } from "../intent.js";
import type { FeedbackEvent } from "../feedback/events.js";
import {
  LAYER_FLAG,
  LAYER_RESULTS,
  NET,
  TRANSFORM_BYTES,
  type BombSnapshot,
  type GameEvent,
  type GameSnapshot,
  type OnlinePhase,
} from "../network/protocol.js";
import { IDLE_INPUT } from "./physics.js";
import { PLAYERS, type PlayerId } from "./players.js";
import { PARTS } from "./ragdoll/config.js";
import { retire } from "./layers/game.js";
import { BombTagGame, type BombTagPose } from "./bomb/game.js";
import { captureBombPredictionState } from "./predictionState.js";
import { newRoomCounters, type OnlineSimulation, type RoomCounters } from "./online.js";

const IDLE = PLAYERS.map(() => IDLE_INPUT);
const EPSILON = 1e-9;
const MAX_REWIND_TICKS = Math.round((NET.maxBombRewindMs / 1000) * NET.physicsHz);

interface PoseFrame {
  tick: number;
  poses: BombTagPose[];
}

/** Authoritative online Bomba Sende wrapper around the approved shared local game. */
export class BombRoundSimulation implements OnlineSimulation {
  readonly mode = "bomb_tag" as const;
  private pending: FeedbackEvent[] = [];
  readonly game = new BombTagGame((event) => this.pending.push(event));
  phase: OnlinePhase = "waiting";
  mask = 0;
  private forfeits = 0;
  private forfeitTick = -1;
  private history: PoseFrame[] = [];
  readonly section = { bytes: 0, encodeMs: 0 };
  readonly rewind = { tags: 0, lastMs: 0, maxMs: 0, clampedOld: 0, rejectedFuture: 0, lookupMs: 0 };

  constructor(readonly counters: RoomCounters = newRoomCounters()) {
    this.idle();
  }
  get physics() { return this.game.physics; }
  get round() { return this.game.round; }
  get roundId() { return this.counters.round; }
  get tick() { return this.counters.tick; }
  get seconds() { return this.phase === "waiting" ? 0 : this.round.seconds; }
  get winner() { return this.phase === "results" ? this.round.winner ?? -1 : -1; }
  get roundTick() {
    return this.phase === "playing" ? this.round.tick : this.phase === "results" ? Math.max(0, this.round.endedAt) : 0;
  }
  private idle() {
    this.game.begin([]);
    this.mask = 0;
    this.forfeits = 0;
    this.forfeitTick = -1;
    this.history.length = 0;
  }
  start(slots: readonly PlayerId[]) {
    const unique = [...new Set(slots)].sort((a, b) => a - b);
    if (this.phase !== "waiting" || unique.length < 2) return false;
    this.counters.round++;
    this.pending.length = 0;
    this.game.begin(unique);
    this.mask = unique.reduce<number>((mask, id) => mask | (1 << id), 0);
    this.forfeits = 0;
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
  neutralize(slot: PlayerId) {
    this.game.brawl.fighters[slot].punch.age = -1;
  }
  remove(slot: PlayerId) {
    if (!(this.mask & (1 << slot))) return;
    retire(this.physics.players[slot]);
    this.forfeits |= 1 << slot;
    if (this.phase !== "playing" || !this.round.alive[slot]) return;
    this.round.alive[slot] = false;
    this.round.outAt[slot] = this.round.tick;
    this.forfeitTick = this.round.tick;
    if (this.game.bomb.carrier === slot) this.game.bomb.drop(this.round.survivors);
  }
  private poseFrame(viewTick: number): readonly BombTagPose[] | null {
    const began = performance.now();
    const now = this.tick;
    if (viewTick > now + 2) {
      this.rewind.rejectedFuture++;
      return null;
    }
    const oldest = now - MAX_REWIND_TICKS;
    const wanted = Math.max(oldest, Math.min(now, viewTick));
    if (viewTick < oldest) this.rewind.clampedOld++;
    let best: PoseFrame | undefined;
    for (const frame of this.history)
      if (frame.tick <= wanted && (!best || frame.tick > best.tick)) best = frame;
    this.rewind.lookupMs += performance.now() - began;
    if (!best) return null;
    const ms = ((now - best.tick) * 1000) / NET.physicsHz;
    this.rewind.lastMs = ms;
    this.rewind.maxMs = Math.max(this.rewind.maxMs, ms);
    this.rewind.tags++;
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
    if (this.phase === "playing") {
      const carrier = this.game.bomb.carrier;
      const input = carrier === null ? null : inputs[carrier];
      this.game.tagRewind = input?.punch && Number.isSafeInteger(input.viewTick)
        ? this.poseFrame(input.viewTick as number)
        : null;
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
    if (this.round.reason === "survivor" && this.forfeitTick >= 0 && this.forfeitTick === this.round.endedAt)
      return LAYER_RESULTS.indexOf("forfeit");
    return LAYER_RESULTS.indexOf(this.round.reason);
  }
  bombSection(): BombSnapshot {
    const began = performance.now(),
      t = this.roundTick,
      bomb = this.game.bomb;
    let armed = 0;
    const x = this.game.traps.traps.map((trap) => {
      if (trap.armed) {
        armed |= 1 << trap.id;
        return -1;
      }
      return t + trap.rearmIn;
    });
    const section: BombSnapshot = {
      t,
      c: bomb.carrier ?? -1,
      e: bomb.phase === "armed" && bomb.carrier !== null ? t + bomb.fuse : -1,
      n: bomb.phase === "pending" && bomb.gapLeft > 0 && bomb.carrier !== null ? t + bomb.gapLeft : -1,
      p: bomb.immuneTicks > 0 ? bomb.immune ?? -1 : -1,
      b: bomb.immuneTicks > 0 ? t + bomb.immuneTicks : -1,
      a: armed,
      x,
      s: this.game.traps.slowed.map((left) => (left > 0 ? t + left : -1)),
      f: PLAYERS.map(({ id }) =>
        !(this.mask & (1 << id))
          ? 0
          : LAYER_FLAG.inMatch |
            (this.round.alive[id] ? LAYER_FLAG.alive : 0) |
            (!this.physics.players[id].eliminated ? LAYER_FLAG.body : 0) |
            (this.game.brawl.fighters[id].stagger.time > EPSILON ? LAYER_FLAG.staggered : 0) |
            (this.forfeits & (1 << id) ? LAYER_FLAG.forfeit : 0)
      ),
      o: PLAYERS.map(({ id }) => (this.mask & (1 << id) ? this.round.outAt[id] : -1)),
      r: this.resultCode(),
    };
    this.section.encodeMs = performance.now() - began;
    return section;
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
      bomb: this.bombSection(),
    };
  }
  prediction(slot: PlayerId) {
    return captureBombPredictionState(
      this.physics.players[slot],
      this.game.brawl.fighters[slot],
      !!(this.mask & (1 << slot)) && this.round.alive[slot],
      this.game.bomb.phase === "armed" && this.game.bomb.carrier === slot,
      this.game.traps.slowed[slot]
    );
  }
  dispose() {
    this.pending.length = 0;
    this.history.length = 0;
    this.game.dispose();
  }
}
