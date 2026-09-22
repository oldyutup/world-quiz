import { PLAYERS, type PlayerId } from "./players.js";

export const ROUND = {
  countdown: 3,
  duration: 60,
  results: 3.5,
  finalFallGrace: 0.35,
} as const;
export type RoundPhase = "countdown" | "playing" | "results";
export type RoundEvent = "started" | "finished" | "reset" | null;
export interface RoundSnapshot {
  phase: RoundPhase;
  seconds: number;
  alive: readonly boolean[];
  winner: PlayerId | null;
  reason: "survivor" | "all-fell" | "timeout" | null;
}

const EPSILON = 1e-8;

/** No rendering, physics engine, browser clock, or bot dependencies. */
export class RoundLogic {
  phase: RoundPhase = "countdown";
  readonly alive = PLAYERS.map(() => true);
  winner: PlayerId | null = null;
  reason: RoundSnapshot["reason"] = null;
  revision = 0;
  private elapsed = 0;
  private finalFallElapsed: number | null = null;

  get seconds(): number {
    const duration =
      this.phase === "countdown"
        ? ROUND.countdown
        : this.phase === "playing"
        ? ROUND.duration
        : ROUND.results;
    return Math.max(0, Math.ceil(duration - this.elapsed - EPSILON));
  }

  snapshot(): RoundSnapshot {
    return {
      phase: this.phase,
      seconds: this.seconds,
      alive: [...this.alive],
      winner: this.winner,
      reason: this.reason,
    };
  }

  tick(dt: number, eliminations: readonly PlayerId[] = []): RoundEvent {
    const oldPhase = this.phase;
    const oldSeconds = this.seconds;
    const oldAlive = this.alive.reduce(
      (mask, alive, id) => mask | (Number(alive) << id),
      0
    );
    const event = this.advance(dt, eliminations);
    const newAlive = this.alive.reduce(
      (mask, alive, id) => mask | (Number(alive) << id),
      0
    );
    if (
      oldPhase !== this.phase ||
      oldSeconds !== this.seconds ||
      oldAlive !== newAlive
    )
      this.revision++;
    return event;
  }

  private finish(
    winner: PlayerId | null,
    reason: RoundSnapshot["reason"]
  ): RoundEvent {
    this.phase = "results";
    this.elapsed = 0;
    this.winner = winner;
    this.reason = reason;
    return "finished";
  }

  private advance(dt: number, eliminations: readonly PlayerId[]): RoundEvent {
    this.elapsed += dt;
    if (this.phase === "countdown") {
      if (this.elapsed + EPSILON < ROUND.countdown) return null;
      this.phase = "playing";
      this.elapsed = 0;
      return "started";
    }
    if (this.phase === "results") {
      if (this.elapsed + EPSILON < ROUND.results) return null;
      this.phase = "countdown";
      this.elapsed = 0;
      this.finalFallElapsed = null;
      this.alive.fill(true);
      this.winner = null;
      this.reason = null;
      return "reset";
    }

    // Consume the entire physics tick's eliminations before choosing a winner.
    for (const id of eliminations) this.alive[id] = false;
    const survivors = PLAYERS.filter((player) => this.alive[player.id]);
    if (survivors.length === 0) return this.finish(null, "all-fell");
    if (survivors.length === 1) {
      this.finalFallElapsed =
        this.finalFallElapsed === null ? 0 : this.finalFallElapsed + dt;
      if (this.finalFallElapsed + EPSILON >= ROUND.finalFallGrace)
        return this.finish(survivors[0].id, "survivor");
      return null; // Let an already-falling final bean finish falling, even at timeout.
    }
    if (this.elapsed + EPSILON >= ROUND.duration)
      return this.finish(null, "timeout");
    return null;
  }
}
