import type { MovementInput } from "../intent.js";
import { NET, type GameSnapshot, type OnlinePhase } from "../network/protocol.js";
import { MODE_PLAYERS } from "../modes.js";
import { GoldMinerGame } from "./goldminer/game.js";
import { GOLD_MINER as G } from "./goldminer/config.js";
import { goldSection } from "./goldminer/wire.js";
import { mulberry32 } from "./colors/layouts.js";
import { newRoomCounters, type RoomCounters, type OnlineSimulation } from "./online.js";
import { seatRanks } from "../board/rules.js";
import { PLAYERS, type PlayerId } from "./players.js";

const NO_TRANSFORMS = new Uint8Array(0);

/** Altın Madenci on the server: it makes each round's mine, fires the hooks and counts the points. */
export class GoldRoundSimulation implements OnlineSimulation {
  readonly mode = "gold_miner" as const;
  phase: OnlinePhase = "waiting";
  mask = 0;
  game: GoldMinerGame;
  seats: PlayerId[] = [];
  private resultTime = 0;
  private readonly random: () => number;
  constructor(readonly counters: RoomCounters = newRoomCounters(), seed = Math.floor(Math.random() * 2 ** 32)) {
    this.random = mulberry32(seed);
    this.game = new GoldMinerGame(2, this.random);
  }
  get tick() {
    return this.counters.tick;
  }
  get roundId() {
    return this.counters.round;
  }
  get seconds() {
    if (this.phase === "countdown") return this.game.countdownTicks / G.hz;
    if (this.phase === "playing") return Math.max(0, (this.game.limitTicks - this.game.ticks) / G.hz);
    if (this.phase === "results") return Math.max(0, G.results - this.resultTime);
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
    const { min, max } = MODE_PLAYERS.gold_miner;
    if (
      this.phase !== "waiting" ||
      slots.length < min ||
      slots.length > max ||
      new Set(slots).size !== slots.length ||
      slots.some((s) => !Number.isInteger(s) || s < 0 || s >= PLAYERS.length)
    )
      return false;
    this.counters.round++;
    // Places at the top turn every round (the middle one reaches the most of the mine), so
    // everyone takes each place in turn.
    const sorted = [...slots].sort((a, b) => a - b),
      turn = this.counters.round % sorted.length;
    this.seats = [...sorted.slice(turn), ...sorted.slice(0, turn)];
    this.mask = slots.reduce<number>((m, s) => m | (1 << s), 0);
    // A new mine every round.
    this.game = new GoldMinerGame(slots.length, this.random);
    this.phase = "countdown";
    this.resultTime = 0;
    return true;
  }
  cancelCountdown() {
    if (this.phase !== "countdown") return;
    this.phase = "waiting";
    this.mask = 0;
  }
  /** A dropped player's hook keeps swinging (and a shot in flight comes home): nothing arrives until they are back. */
  neutralize(_slot: PlayerId) {}
  remove(slot: PlayerId) {
    const lane = this.seats.indexOf(slot);
    if (lane >= 0 && this.phase !== "waiting") this.game.remove(lane);
  }
  step(inputs: readonly MovementInput[]) {
    this.counters.tick++;
    if (this.phase === "waiting") return [];
    if (this.phase === "results") {
      if ((this.resultTime += 1 / G.hz) >= G.results) {
        this.phase = "waiting";
        this.mask = 0;
      }
      return [];
    }
    const g = this.game;
    g.step(this.seats.map((slot) => inputs[slot]?.gold));
    if (this.phase === "countdown" && g.phase === "mining") this.phase = "playing";
    if (g.phase === "results") {
      this.phase = "results";
      this.resultTime = 0;
    }
    return [];
  }
  snapshot(ack: number[]): GameSnapshot {
    const alive = this.game.lanes.reduce((m, l, lane) => (l.out ? m : m | (1 << this.seats[lane])), 0);
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
      alive: this.phase === "waiting" ? 0 : alive,
      states: [],
      meters: [],
      grips: [],
      ack,
      transforms: NO_TRANSFORMS,
      gold: goldSection(this.game, this.seats),
    };
  }
  prediction(slot: PlayerId) {
    return { slot, velocities: new Uint8Array(), controller: [] };
  }
  dispose() {}
}
