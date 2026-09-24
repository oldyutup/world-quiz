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
  type GameEvent,
  type GameSnapshot,
  type LayerSnapshot,
  type OnlinePhase,
} from "../network/protocol.js";
import { LayerChaosGame, retire } from "./layers/game.js";
import { encodeTiles } from "./layers/wire.js";
import { captureLayerPredictionState } from "./predictionState.js";
import { newRoomCounters, type OnlineSimulation, type RoomCounters } from "./online.js";

const IDLE = PLAYERS.map(() => IDLE_INPUT);
/** Stagger shorter than this counts as over (the brawl's own epsilon). */
const EPSILON = 1e-9;

/**
 * Spawns (indices into LAYERS_MAP.spawns, 120° apart on L1) for a round's slots.
 * Three players take all three. Two players take two of them: the layout is symmetric
 * about the line through the unused spawn, so both starts are mirror images (fair). The
 * unused spawn rotates every round and the two players swap sides every other round.
 */
export function layerSpawns(slots: readonly PlayerId[], round: number): number[] {
  if (slots.length !== 2) return slots.map((slot) => slot);
  const free = round % 3;
  const pair = [0, 1, 2].filter((k) => k !== free);
  return Math.floor(round / 3) % 2 ? pair.reverse() : pair;
}

/**
 * Authoritative Katman Kaosu round for the room server: the shared `LayerChaosGame`
 * (297 tile colliders, arming, GONE, collapse schedule, punch shoves and staggers,
 * eliminations, last alive wins) for 2–3 players, with the room's phases around it.
 * Clients only send intent; every tile, hit, fall and result is decided here.
 *
 * Per playing tick, in order (the shared game): collapse schedule arms → tiles due go
 * GONE → punch/stagger timers and new punches → input → physics → punch contacts →
 * the tile under each standing player's hips arms → eliminations → winner.
 */
export class LayerRoundSimulation implements OnlineSimulation {
  readonly mode = "layer_chaos" as const;
  private pending: FeedbackEvent[] = [];
  readonly game = new LayerChaosGame((event) => this.pending.push(event));
  phase: OnlinePhase = "waiting";
  mask = 0;
  /** Slots that left mid-round (a forfeit, not a physical fall). */
  private forfeits = 0;
  /** Round tick of the last forfeit (−1: none). */
  private forfeitTick = -1;
  /** Encoded size and build time of the last `layers` section (diagnostics). */
  readonly section = { bytes: 0, encodeMs: 0 };
  constructor(readonly counters: RoomCounters = newRoomCounters()) {
    this.idle();
  }
  get physics() {
    return this.game.physics;
  }
  get field() {
    return this.game.field;
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
  /** Countdown and results: seconds left; play: seconds elapsed (the round has no fixed length). */
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
    if (this.phase !== "waiting" || unique.length < 2) return false;
    this.counters.round++;
    this.pending.length = 0;
    this.game.begin(unique, layerSpawns(unique, this.counters.round));
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
  /** The complete tile field and per-player state (small integers and two byte arrays). */
  layerSection(): LayerSnapshot {
    const began = performance.now();
    const round = this.round,
      t = this.roundTick;
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
    const section: LayerSnapshot = {
      t,
      ...encodeTiles(this.field, t),
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
      layers: this.layerSection(),
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
