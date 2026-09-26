import type { PropRole } from "../../maps/propHunt.js";
import { PLAYERS, type PlayerId } from "../players.js";
import { PROP_TICKS } from "./config.js";

export type PropPhase = "countdown" | "hiding" | "search" | "results";
export type PropRoundEvent = "hiding" | "search" | "finished" | "reset" | null;
/** Which side won: the seeker found every hider, or a hider lasted (the search, or the seeker's shots). */
export type PropOutcome = "seeker" | "hiders";
/** Why: every hider found; the search ran out; the seeker's last shot was spent with a hider still hidden. */
export type PropResult = "found" | "timeout" | "ammo" | "forfeit";

/**
 * Saklambaç's round in whole ticks: a 3 s frozen countdown, the hiding phase (hiders move,
 * the seeker is frozen and blind), the search, then results and a fresh round with the same
 * roles. No respawns: a found hider is out until the next round.
 *
 * - The seeker wins on the tick the last hider is found.
 * - The hiders win when the search runs out with at least one of them still hidden, or at once
 *   when the seeker has no shot left and one of them is still hidden (the shot that emptied the
 *   gun is resolved first: if it found the last hider, the seeker wins).
 */
export class PropHuntRound {
  phase: PropPhase = "countdown";
  /** Ticks into the current phase. */
  tick = 0;
  readonly roles: PropRole[];
  readonly alive = PLAYERS.map(() => true);
  /** Search tick each hider was found on (−1: never). */
  readonly foundAt = PLAYERS.map(() => -1);
  outcome: PropOutcome | null = null;
  reason: PropResult | null = null;
  /** Search tick the result was decided on (−1: undecided). */
  endedAt = -1;
  /** Bumps whenever what a HUD shows changes (phase, second, who is still in). */
  revision = 0;

  constructor(roles: readonly PropRole[]) {
    this.roles = [...roles];
  }
  get seeker(): PlayerId {
    return PLAYERS.find(({ id }) => this.roles[id] === "seeker")!.id;
  }
  get hiders(): PlayerId[] {
    return PLAYERS.filter(({ id }) => this.roles[id] === "hider").map(({ id }) => id);
  }
  /** Hiders not found yet. */
  get hidden(): PlayerId[] {
    return this.hiders.filter((id) => this.alive[id]);
  }
  private get length() {
    return this.phase === "countdown" ? PROP_TICKS.countdown : this.phase === "hiding" ? PROP_TICKS.hiding : this.phase === "search" ? PROP_TICKS.search : PROP_TICKS.results;
  }
  /** Whole seconds left in the current phase. */
  get seconds() {
    return Math.max(0, Math.ceil((this.length - this.tick) / 60));
  }
  /** Seconds left in the current phase, to the tick. */
  get remaining() {
    return Math.max(0, (this.length - this.tick) / 60);
  }
  /** Search ticks elapsed (0 before the search). */
  get searchTick() {
    return this.phase === "search" ? this.tick : this.phase === "results" ? Math.max(0, this.endedAt) : 0;
  }

  /** `outOfAmmo`: the seeker has no shot left (after this tick's shot, whose finds are in `found`). */
  step(found: readonly PlayerId[] = [], outOfAmmo = false): PropRoundEvent {
    const before = `${this.phase}|${this.seconds}|${this.alive.join()}`;
    const event = this.advance(found, outOfAmmo);
    if (`${this.phase}|${this.seconds}|${this.alive.join()}` !== before) this.revision++;
    return event;
  }
  private finish(outcome: PropOutcome, reason: PropResult): PropRoundEvent {
    this.outcome = outcome;
    this.reason = reason;
    this.endedAt = this.tick;
    this.phase = "results";
    this.tick = 0;
    return "finished";
  }
  private advance(found: readonly PlayerId[], outOfAmmo: boolean): PropRoundEvent {
    if (this.phase === "countdown") {
      if (++this.tick < PROP_TICKS.countdown) return null;
      this.phase = "hiding";
      this.tick = 0;
      return "hiding";
    }
    if (this.phase === "hiding") {
      if (++this.tick < PROP_TICKS.hiding) return null;
      this.phase = "search";
      this.tick = 0;
      return "search";
    }
    if (this.phase === "results") {
      if (++this.tick < PROP_TICKS.results) return null;
      this.phase = "countdown";
      this.tick = 0;
      this.outcome = this.reason = null;
      this.endedAt = -1;
      PLAYERS.forEach(({ id }) => {
        this.alive[id] = true;
        this.foundAt[id] = -1;
      });
      return "reset";
    }
    for (const id of found)
      if (this.alive[id] && this.roles[id] === "hider") {
        this.alive[id] = false;
        this.foundAt[id] = this.tick;
      }
    if (!this.hidden.length) return this.finish("seeker", "found");
    if (outOfAmmo) return this.finish("hiders", "ammo");
    if (++this.tick >= PROP_TICKS.search) {
      this.tick = PROP_TICKS.search;
      return this.finish("hiders", "timeout");
    }
    return null;
  }
}
