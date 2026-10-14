import type { MovementInput } from "../intent.js";
import { NET, type GameSnapshot, type OnlinePhase } from "../network/protocol.js";
import { MODE_PLAYERS } from "../modes.js";
import { TrailGame, type TrailInput } from "./trails/game.js";
import { LIGHT_TRAILS as L } from "./trails/config.js";
import { trailSection } from "./trails/wire.js";
import { mulberry32 } from "./colors/layouts.js";
import { newRoomCounters, type RoomCounters, type OnlineSimulation } from "./online.js";
import { seatRanks } from "../board/rules.js";
import { PLAYERS, type PlayerId } from "./players.js";

const NO_TRANSFORMS = new Uint8Array(0);

/** Işık İzi on the server: it runs everyone, lays the trails, drives the train and decides every death. */
export class TrailRoundSimulation implements OnlineSimulation {
  readonly mode = "light_trails" as const;
  phase: OnlinePhase = "waiting";
  mask = 0;
  game: TrailGame;
  /** Lane → slot (slots in order; the start ring is turned at random every round). */
  seats: PlayerId[] = [];
  private resultTime = 0;
  private readonly random: () => number;
  private sequences: number[] = [];
  private held: number[] = [];
  constructor(readonly counters: RoomCounters = newRoomCounters(), seed = Math.floor(Math.random() * 2 ** 32)) {
    this.random = mulberry32(seed);
    this.game = new TrailGame(2, this.random);
  }
  get tick() {
    return this.counters.tick;
  }
  get roundId() {
    return this.counters.round;
  }
  get seconds() {
    if (this.phase === "countdown") return this.game.countdownTicks / L.hz;
    if (this.phase === "playing") return Math.max(0, (this.game.limitTicks - this.game.ticks) / L.hz);
    if (this.phase === "results") return Math.max(0, L.results - this.resultTime);
    return 0;
  }
  get winner() {
    const lane = this.phase === "results" ? this.game.winner() : -1;
    return lane < 0 ? -1 : this.seats[lane];
  }
  placements() {
    return seatRanks(this.seats, this.game.scores(), PLAYERS.length);
  }
  start(slots: readonly PlayerId[]) {
    const { min, max } = MODE_PLAYERS.light_trails;
    if (
      this.phase !== "waiting" ||
      slots.length < min ||
      slots.length > max ||
      new Set(slots).size !== slots.length ||
      slots.some((s) => !Number.isInteger(s) || s < 0 || s >= PLAYERS.length)
    )
      return false;
    this.seats = [...slots].sort((a, b) => a - b);
    this.mask = slots.reduce<number>((m, s) => m | (1 << s), 0);
    // A fresh turn of the start ring every round: nobody keeps the spot nearest the rail.
    this.game = new TrailGame(slots.length, this.random);
    this.sequences = slots.map(() => -1);
    this.held = slots.map(() => 0);
    this.counters.round++;
    this.phase = "countdown";
    this.resultTime = 0;
    return true;
  }
  cancelCountdown() {
    if (this.phase !== "countdown") return;
    this.phase = "waiting";
    this.mask = 0;
  }
  /** A dropped player's input goes stale: it runs straight on (and most likely crashes) until they are back. */
  neutralize(_slot: PlayerId) {}
  remove(slot: PlayerId) {
    const lane = this.seats.indexOf(slot);
    if (lane >= 0 && this.phase !== "waiting") this.game.remove(lane);
  }
  step(inputs: readonly MovementInput[]) {
    this.counters.tick++;
    if (this.phase === "waiting") return [];
    if (this.phase === "results") {
      if ((this.resultTime += 1 / L.hz) >= L.results) {
        this.phase = "waiting";
        this.mask = 0;
      }
      return [];
    }
    const g = this.game;
    const keys = this.seats.map((slot, lane): TrailInput | undefined => {
      const p = inputs[slot]?.trail,
        seq = p?.seq ?? -1;
      this.held[lane] = seq >= 0 && seq === this.sequences[lane] ? this.held[lane] + 1 : 0;
      this.sequences[lane] = seq;
      return p ? { x: p.dirX, z: p.dirZ } : undefined;
    });
    g.step(keys);
    if (this.phase === "countdown" && g.phase === "playing") this.phase = "playing";
    if (g.phase === "results") {
      this.phase = "results";
      this.resultTime = 0;
    }
    return [];
  }
  snapshot(ack: number[]): GameSnapshot {
    const inRound = this.game.players.reduce((m, p, lane) => (p.out ? m : m | (1 << this.seats[lane])), 0);
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
      alive: this.phase === "waiting" ? 0 : inRound,
      states: [],
      meters: [],
      grips: [],
      ack,
      transforms: NO_TRANSFORMS,
      trail: trailSection(this.game, this.seats, this.held),
    };
  }
  prediction(slot: PlayerId) {
    return { slot, velocities: new Uint8Array(), controller: [] };
  }
  dispose() {}
}
