import { PLAYERS, type PlayerId } from "../players.js";
import { LAYER_TICKS } from "./config.js";

export type LayerPhase = "countdown" | "playing" | "results";
export type LayerRoundEvent = "started" | "finished" | "reset" | null;
export type LayerResult = "survivor" | "all-fell" | "timeout";
/** Whole-tick lengths of a round's countdown, results and safety cap (Katman Kaosu's: LAYER_TICKS). */
export interface RoundTiming {
  readonly countdown: number;
  readonly results: number;
  readonly cap: number;
}

/**
 * Katman Kaosu's round in whole ticks: a 3 s frozen countdown, play until at most one
 * player is left, 3.5 s of results, then a fresh round. No respawns.
 *
 * - Last alive wins, decided on the tick it happens (no grace: the audited rule).
 * - The last survivors all eliminated on the same tick: a draw.
 * - The collapse ends every round by ~95.4 s; `LAYER_TICKS.cap` is a safety net (draw).
 *
 * In play, `tick` is the round clock: 0 on the first playing tick, and every rule of that
 * step (collapse, GONE, arming) uses it before `step()` advances it.
 */
export class LayerRound {
  phase: LayerPhase = "countdown";
  /** Ticks into the countdown/results; in play, the round tick. */
  tick = 0;
  /** Slots in this match (2–3 players); others sit it out as if eliminated. */
  readonly active = PLAYERS.map(() => true);
  readonly alive = PLAYERS.map(() => true);
  /** Round tick each player was eliminated on (−1: never). */
  readonly outAt = PLAYERS.map(() => -1);
  winner: PlayerId | null = null;
  reason: LayerResult | null = null;
  /** Round tick the result was decided on (−1: undecided). */
  endedAt = -1;
  /** Bumps whenever what a HUD shows changes (phase, second, who is alive). */
  revision = 0;
  /** Renk Kaosu reuses this round with its own timing (COLOR_TICKS). */
  constructor(private readonly timing: RoundTiming = LAYER_TICKS) {}

  setActive(slots: readonly PlayerId[]) {
    PLAYERS.forEach(({ id }) => {
      this.active[id] = slots.includes(id);
      this.alive[id] = this.active[id];
      this.outAt[id] = -1;
    });
    this.revision++;
  }
  get survivors() {
    return PLAYERS.filter(({ id }) => this.active[id] && this.alive[id]).map(({ id }) => id);
  }
  /** Countdown and results: seconds left; play: whole seconds elapsed. */
  get seconds() {
    if (this.phase === "playing") return Math.floor(this.tick / 60);
    const total = this.phase === "countdown" ? this.timing.countdown : this.timing.results;
    return Math.ceil((total - this.tick) / 60);
  }

  step(eliminations: readonly PlayerId[] = []): LayerRoundEvent {
    const before = `${this.phase}|${this.seconds}|${this.alive.join()}`;
    const event = this.advance(eliminations);
    if (`${this.phase}|${this.seconds}|${this.alive.join()}` !== before) this.revision++;
    return event;
  }
  private finish(winner: PlayerId | null, reason: LayerResult): LayerRoundEvent {
    this.winner = winner;
    this.reason = reason;
    this.endedAt = this.tick;
    this.phase = "results";
    this.tick = 0;
    return "finished";
  }
  private advance(eliminations: readonly PlayerId[]): LayerRoundEvent {
    if (this.phase === "countdown") {
      if (++this.tick < this.timing.countdown) return null;
      this.phase = "playing";
      this.tick = 0;
      return "started";
    }
    if (this.phase === "results") {
      if (++this.tick < this.timing.results) return null;
      this.phase = "countdown";
      this.tick = 0;
      this.winner = this.reason = null;
      this.endedAt = -1;
      PLAYERS.forEach(({ id }) => {
        this.alive[id] = this.active[id];
        this.outAt[id] = -1;
      });
      return "reset";
    }
    // The whole tick's eliminations count before anyone is declared the winner.
    for (const id of eliminations)
      if (this.alive[id]) {
        this.alive[id] = false;
        this.outAt[id] = this.tick;
      }
    const left = this.survivors;
    if (left.length === 0) return this.finish(null, "all-fell");
    if (left.length === 1) return this.finish(left[0], "survivor");
    if (this.tick >= this.timing.cap - 1) return this.finish(null, "timeout");
    this.tick++;
    return null;
  }
}
