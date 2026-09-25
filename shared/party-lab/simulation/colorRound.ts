import { IDLE_INPUT } from "./physics.js";
import { PLAYERS, type PlayerId } from "./players.js";
import { PARTS } from "./ragdoll/config.js";
import type { MovementInput } from "../intent.js";
import type { FeedbackEvent } from "../feedback/events.js";
import {
  LAYER_FLAG,
  LAYER_RESULTS,
  NET,
  TRANSFORM_BYTES,
  type ColorFieldSnapshot,
  type GameEvent,
  type GameSnapshot,
  type OnlinePhase,
} from "../network/protocol.js";
import { ColorChaosGame } from "./colors/game.js";
import { encodeColorField } from "./colors/wire.js";
import { retire } from "./layers/game.js";
import { captureLayerPredictionState } from "./predictionState.js";
import { newRoomCounters, type OnlineSimulation, type RoomCounters } from "./online.js";

const IDLE = PLAYERS.map(() => IDLE_INPUT);
/** Stagger shorter than this counts as over (the brawl's own epsilon). */
const EPSILON = 1e-9;

export interface ColorRoundOptions {
  /** Seeds every round's layouts and targets (default: random). Tests fix it. */
  seed?: number;
}

/**
 * Authoritative Renk Kaosu round for the room server: the shared `ColorChaosGame` (85
 * tile colliders, the colour schedule with its layouts, targets, drops, restores and
 * Daralma, the below-floor rule on every restore, punch shoves and staggers,
 * eliminations, last alive wins, same-tick draw) for 2–3 players, with the room's phases
 * around it. Clients only send intent; every colour, tile, hit, fall and result is
 * decided here.
 *
 * Per playing tick, in order (the shared game): the schedule's target / drop / restore
 * (colliders change before physics; on a restore, hips below the floor are out first) →
 * punch/stagger timers and new punches → input → physics → punch contacts →
 * eliminations → winner.
 *
 * Spawns: the approved ones for the player count (two: opposite, three: 120° apart), in
 * slot order. Each round draws a fresh seed.
 */
export class ColorRoundSimulation implements OnlineSimulation {
  readonly mode = "color_chaos" as const;
  private pending: FeedbackEvent[] = [];
  readonly game: ColorChaosGame;
  phase: OnlinePhase = "waiting";
  mask = 0;
  /** Slots that left mid-round (a forfeit, not a physical fall). */
  private forfeits = 0;
  /** Round tick of the last forfeit (−1: none). */
  private forfeitTick = -1;
  /** Encoded size and build time of the last `colors` section (diagnostics). */
  readonly section = { bytes: 0, encodeMs: 0 };
  constructor(
    readonly counters: RoomCounters = newRoomCounters(),
    options: ColorRoundOptions = {}
  ) {
    this.game = new ColorChaosGame((event) => this.pending.push(event), { seed: options.seed });
    this.idle();
  }
  get physics() {
    return this.game.physics;
  }
  get field() {
    return this.game.field;
  }
  get schedule() {
    return this.game.schedule;
  }
  get round() {
    return this.game.round;
  }
  get roundId() {
    return this.counters.round;
  }
  get tick() {
    return this.counters.tick;
  }
  /** Countdown and results: seconds left; play: seconds elapsed. */
  get seconds() {
    return this.phase === "waiting" ? 0 : this.round.seconds;
  }
  get winner() {
    return this.phase === "results" ? this.round.winner ?? -1 : -1;
  }
  /** Round tick the snapshot reports: the next step's in play, the final one in results. */
  get roundTick() {
    return this.phase === "playing" ? this.round.tick : this.phase === "results" ? Math.max(0, this.round.endedAt) : 0;
  }
  /** Lobby: nobody in the world. */
  private idle() {
    this.game.begin([]);
    this.mask = 0;
    this.forfeits = 0;
    this.forfeitTick = -1;
  }
  start(slots: readonly PlayerId[]) {
    const unique = [...new Set(slots)].sort((a, b) => a - b);
    if (this.phase !== "waiting" || unique.length < 2 || unique.length > 3) return false;
    this.counters.round++;
    this.pending.length = 0;
    this.game.begin(unique);
    this.mask = unique.reduce<number>((mask, id) => mask | (1 << id), 0);
    this.forfeits = 0;
    this.forfeitTick = -1;
    this.phase = "countdown";
    return true;
  }
  cancelCountdown() {
    if (this.phase !== "countdown") return;
    this.phase = "waiting";
    this.idle();
  }
  neutralize(slot: PlayerId) {
    // Input is already neutral (the room clears the mailbox); stop a swing in progress.
    this.game.brawl.fighters[slot].punch.age = -1;
  }
  remove(slot: PlayerId) {
    if (!(this.mask & (1 << slot))) return;
    const round = this.round;
    retire(this.physics.players[slot]);
    this.forfeits |= 1 << slot;
    // Departure is a forfeit: out on this tick; the next step decides the round (last alive wins).
    if (this.phase === "playing" && round.alive[slot]) {
      round.alive[slot] = false;
      round.outAt[slot] = round.tick;
      this.forfeitTick = round.tick;
    }
  }
  step(inputs: readonly MovementInput[]): GameEvent[] {
    this.counters.tick++;
    this.pending.length = 0;
    if (this.phase === "waiting") return [];
    const event = this.game.step(this.phase === "playing" ? inputs : IDLE);
    if (event === "started") this.phase = "playing";
    else if (event === "finished") this.phase = "results";
    else if (event === "reset") {
      // Results over: back to the lobby (the local arena would count down again instead).
      this.phase = "waiting";
      this.idle();
      this.pending.length = 0;
    }
    return this.pending.map((e) => ({ ...e, id: ++this.counters.event, round: this.roundId, tick: this.tick }));
  }
  private resultCode() {
    const round = this.round;
    if (this.phase !== "results" || !round.reason) return 0;
    if (round.reason === "survivor" && this.forfeitTick >= 0 && this.forfeitTick === round.endedAt) return LAYER_RESULTS.indexOf("forfeit");
    return LAYER_RESULTS.indexOf(round.reason);
  }
  /** The complete colour field and per-player state (small integers and four short byte arrays). */
  colorSection(): ColorFieldSnapshot {
    const began = performance.now();
    const round = this.round;
    const f = PLAYERS.map(({ id }) => {
      if (!(this.mask & (1 << id))) return 0;
      const character = this.physics.players[id];
      return (
        LAYER_FLAG.inMatch |
        (round.alive[id] ? LAYER_FLAG.alive : 0) |
        (!character.eliminated ? LAYER_FLAG.body : 0) |
        (this.game.brawl.fighters[id].stagger.time > EPSILON ? LAYER_FLAG.staggered : 0) |
        (this.forfeits & (1 << id) ? LAYER_FLAG.forfeit : 0)
      );
    });
    const section: ColorFieldSnapshot = {
      t: this.roundTick,
      ...encodeColorField(this.schedule.cycle),
      f,
      o: PLAYERS.map(({ id }) => (this.mask & (1 << id) ? round.outAt[id] : -1)),
      r: this.resultCode(),
    };
    this.section.encodeMs = performance.now() - began;
    return section;
  }
  snapshot(ack: number[]): GameSnapshot {
    const transforms = new Uint8Array(TRANSFORM_BYTES),
      view = new DataView(transforms.buffer);
    let offset = 0;
    for (const p of this.physics.players)
      for (const name of PARTS) {
        const body = p.parts[name].body,
          position = body.translation(),
          q = body.rotation();
        for (const value of [position.x, position.y, position.z, q.x, q.y, q.z, q.w]) {
          view.setFloat32(offset, value, true);
          offset += 4;
        }
      }
    const round = this.round;
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
      alive: PLAYERS.reduce((mask, { id }) => mask | (this.mask & (1 << id) && round.alive[id] ? 1 << id : 0), 0),
      states: [],
      meters: [],
      grips: [],
      ack,
      transforms,
      colors: this.colorSection(),
    };
  }
  prediction(slot: PlayerId) {
    const alive = !!(this.mask & (1 << slot)) && this.round.alive[slot];
    return captureLayerPredictionState(this.physics.players[slot], this.game.brawl.fighters[slot], alive);
  }
  dispose() {
    this.pending.length = 0;
    this.game.dispose();
  }
}
