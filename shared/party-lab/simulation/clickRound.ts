import type { MovementInput } from "../intent.js";
import { NET, type GameSnapshot, type OnlinePhase } from "../network/protocol.js";
import { MODE_PLAYERS } from "../modes.js";
import { ClickRaceGame } from "./clickrace/game.js";
import { CLICK_RACE as C } from "./clickrace/config.js";
import { clickSection } from "./clickrace/wire.js";
import { newRoomCounters, type RoomCounters, type OnlineSimulation } from "./online.js";
import { seatRanks } from "../board/rules.js";
import { PLAYERS, type PlayerId } from "./players.js";

const NO_TRANSFORMS = new Uint8Array(0);

/** Tıklama Yarışı on the server: the counted clicks are the only state. */
export class ClickRoundSimulation implements OnlineSimulation {
  readonly mode = "click_race" as const;
  phase: OnlinePhase = "waiting";
  mask = 0;
  game = new ClickRaceGame(2);
  seats: PlayerId[] = [];
  private resultTime = 0;
  constructor(readonly counters: RoomCounters = newRoomCounters()) {}
  get tick() {
    return this.counters.tick;
  }
  get roundId() {
    return this.counters.round;
  }
  get seconds() {
    if (this.phase === "countdown") return this.game.countdownTicks / C.hz;
    if (this.phase === "playing") return Math.max(0, (this.game.limitTicks - this.game.ticks) / C.hz);
    if (this.phase === "results") return Math.max(0, C.results - this.resultTime);
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
    const { min, max } = MODE_PLAYERS.click_race;
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
    this.game = new ClickRaceGame(slots.length);
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
  /** A dropped player's car simply stops: nothing arrives until they are back. */
  neutralize(_slot: PlayerId) {}
  remove(slot: PlayerId) {
    const lane = this.seats.indexOf(slot);
    if (lane >= 0 && this.phase !== "waiting") this.game.remove(lane);
  }
  step(inputs: readonly MovementInput[]) {
    this.counters.tick++;
    if (this.phase === "waiting") return [];
    if (this.phase === "results") {
      if ((this.resultTime += 1 / C.hz) >= C.results) {
        this.phase = "waiting";
        this.mask = 0;
      }
      return [];
    }
    const g = this.game;
    g.step(this.seats.map((slot) => inputs[slot]?.click?.stamps));
    if (this.phase === "countdown" && g.phase === "racing") this.phase = "playing";
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
      click: clickSection(this.game, this.seats),
    };
  }
  prediction(slot: PlayerId) {
    return { slot, velocities: new Uint8Array(), controller: [] };
  }
  dispose() {}
}
