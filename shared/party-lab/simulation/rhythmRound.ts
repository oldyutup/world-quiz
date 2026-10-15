import type { MovementInput } from "../intent.js";
import { NET, type GameSnapshot, type OnlinePhase } from "../network/protocol.js";
import { packetPresses } from "../network/rhythmInput.js";
import { MODE_PLAYERS } from "../modes.js";
import { RhythmGame, type RhythmVolley } from "./rhythm/game.js";
import { RHYTHM as R } from "./rhythm/config.js";
import { rhythmSection } from "./rhythm/wire.js";
import { mulberry32 } from "./colors/layouts.js";
import { newRoomCounters, type RoomCounters, type OnlineSimulation } from "./online.js";
import { seatRanks } from "../board/rules.js";
import { PLAYERS, type PlayerId } from "./players.js";

const NO_TRANSFORMS = new Uint8Array(0);

/** Ritim Ustası on the server: one song (a random style and seed) for everyone, the stamped presses judged, the combos kept. */
export class RhythmRoundSimulation implements OnlineSimulation {
  readonly mode = "rhythm_master" as const;
  phase: OnlinePhase = "waiting";
  mask = 0;
  game: RhythmGame;
  /** Lane → slot (every lane is alike, so slots keep their order). */
  seats: PlayerId[] = [];
  private resultTime = 0;
  private readonly random: () => number;
  constructor(readonly counters: RoomCounters = newRoomCounters(), seed = Math.floor(Math.random() * 2 ** 32)) {
    this.random = mulberry32(seed);
    this.game = new RhythmGame(2, this.random);
  }
  get tick() {
    return this.counters.tick;
  }
  get roundId() {
    return this.counters.round;
  }
  get seconds() {
    if (this.phase === "countdown") return this.game.countdownTicks / R.hz;
    if (this.phase === "playing") return Math.max(0, (this.game.limitTicks - this.game.ticks) / R.hz);
    if (this.phase === "results") return Math.max(0, R.results - this.resultTime);
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
    const { min, max } = MODE_PLAYERS.rhythm_master;
    if (
      this.phase !== "waiting" ||
      slots.length < min ||
      slots.length > max ||
      new Set(slots).size !== slots.length ||
      slots.some((s) => !Number.isInteger(s) || s < 0 || s >= PLAYERS.length)
    )
      return false;
    this.counters.round++;
    this.seats = [...slots].sort((a, b) => a - b);
    this.mask = slots.reduce<number>((m, s) => m | (1 << s), 0);
    this.game = new RhythmGame(slots.length, this.random);
    this.phase = "countdown";
    this.resultTime = 0;
    return true;
  }
  cancelCountdown() {
    if (this.phase !== "countdown") return;
    this.phase = "waiting";
    this.mask = 0;
  }
  /** A dropped player's notes keep coming and go by as misses until they are back. */
  neutralize() {}
  remove(slot: PlayerId) {
    const lane = this.seats.indexOf(slot);
    if (lane >= 0 && this.phase !== "waiting") this.game.remove(lane);
  }
  step(inputs: readonly MovementInput[]) {
    this.counters.tick++;
    if (this.phase === "waiting") return [];
    if (this.phase === "results") {
      if ((this.resultTime += 1 / R.hz) >= R.results) {
        this.phase = "waiting";
        this.mask = 0;
      }
      return [];
    }
    const g = this.game;
    g.step(
      this.seats.map((slot): RhythmVolley | undefined => {
        const p = inputs[slot]?.rhythm;
        return p && { pressed: p.pressed, presses: packetPresses(p) };
      })
    );
    if (this.phase === "countdown" && g.phase === "playing") this.phase = "playing";
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
      rhythm: rhythmSection(this.game, this.seats),
    };
  }
  prediction(slot: PlayerId) {
    return { slot, velocities: new Uint8Array(), controller: [] };
  }
  dispose() {}
}
