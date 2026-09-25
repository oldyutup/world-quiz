import type { PlayerId } from "../players.js";
import { BOMB_TICKS } from "./config.js";

/** "pending": a carrier is chosen but the fuse is not lit (countdown, the gap after a blast). "armed": burning. */
export type BombPhase = "pending" | "armed";
export type BombEvent =
  | { type: "armed"; carrier: PlayerId }
  | {
      type: "pass";
      from: PlayerId;
      to: PlayerId;
      fuse: number;
      /** How the game saw it land (BombTagGame): the punching hand's contact, or the tag assist. */
      via?: "punch" | "tag";
      /** Pelvis-to-pelvis horizontal distance at the pass (m), for diagnostics. */
      reach?: number;
    }
  | { type: "blast"; carrier: PlayerId }
  | { type: "next"; carrier: PlayerId };
export type PassRefusal = "no-bomb" | "not-carrier" | "self" | "out" | "tag-back";

/**
 * The bomb, as pure state in whole ticks — no physics, so the online server can run it
 * as it is and a snapshot needs only (phase, carrier, fuse, immune, immuneTicks).
 *
 * - `start` picks the first carrier (the countdown shows who) with the fuse unlit.
 * - `light` starts the fuse (the first playing tick; after a blast, when the gap ends).
 * - `tick` burns one tick; at 0 the carrier explodes ("blast"), and if two or more are
 *   left, the next carrier is picked at once ("next") and lit `gap` ticks later.
 * - `pass` hands the bomb on (a landed punch by the carrier): the fuse carries over
 *   unchanged, and the one who passed it cannot be tagged back for `tagBack` ticks.
 * - `drop` handles a carrier leaving without a blast (a fall): the bomb moves on as after one.
 */
export class BombRules {
  phase: BombPhase = "pending";
  carrier: PlayerId | null = null;
  /** Ticks left on the fuse (armed), or the full fuse waiting (pending). */
  fuse = BOMB_TICKS.fuse;
  /** Pending after a blast: ticks until the fuse lights (−1: waiting for the round start). */
  gapLeft = -1;
  /** The player who just passed it, protected from the new carrier. */
  immune: PlayerId | null = null;
  immuneTicks = 0;
  /** This round's passes and blasts (HUD, stats). */
  passes = 0;
  blasts = 0;
  /** Ticks each slot has held a lit bomb this round. */
  readonly held = [0, 0, 0];
  constructor(private readonly random: () => number) {}

  /** A new round: pick the first carrier among `players`; the fuse lights with `light`. */
  start(players: readonly PlayerId[]) {
    this.phase = "pending";
    this.fuse = BOMB_TICKS.fuse;
    this.gapLeft = -1;
    this.immune = null;
    this.immuneTicks = 0;
    this.passes = this.blasts = 0;
    this.held.fill(0);
    this.carrier = this.pick(players);
  }
  light(): BombEvent | null {
    if (this.phase === "armed" || this.carrier === null) return null;
    this.phase = "armed";
    this.fuse = BOMB_TICKS.fuse;
    this.gapLeft = -1;
    return { type: "armed", carrier: this.carrier };
  }
  /**
   * One playing tick, before the step's physics. `alive`: who is still in. Returns the
   * events in order (a blast is followed by the next carrier when two or more remain).
   */
  tick(alive: readonly PlayerId[]): BombEvent[] {
    if (this.immuneTicks > 0 && --this.immuneTicks === 0) this.immune = null;
    if (this.phase === "pending") {
      if (this.gapLeft > 0 && --this.gapLeft === 0) {
        const lit = this.light();
        return lit ? [lit] : [];
      }
      return [];
    }
    if (this.carrier !== null) this.held[this.carrier]++;
    if (--this.fuse > 0) return [];
    const carrier = this.carrier!;
    this.blasts++;
    return [{ type: "blast", carrier }, ...this.moveOn(alive.filter((id) => id !== carrier))];
  }
  /** Whether `from` (the carrier's landed punch) may pass the bomb to `to`, and why not. */
  refusal(from: PlayerId, to: PlayerId, alive: readonly PlayerId[]): PassRefusal | null {
    if (this.phase !== "armed" || this.carrier === null) return "no-bomb";
    if (from !== this.carrier) return "not-carrier";
    if (to === from) return "self";
    if (!alive.includes(to)) return "out";
    if (this.immune === to && this.immuneTicks > 0) return "tag-back";
    return null;
  }
  pass(from: PlayerId, to: PlayerId, alive: readonly PlayerId[]): BombEvent | null {
    if (this.refusal(from, to, alive)) return null;
    this.carrier = to;
    this.immune = from;
    this.immuneTicks = BOMB_TICKS.tagBack;
    this.passes++;
    return { type: "pass", from, to, fuse: this.fuse };
  }
  /** The carrier left the round without a blast (fell): the bomb moves on as after a blast. */
  drop(alive: readonly PlayerId[]): BombEvent[] {
    if (this.carrier === null) return [];
    return this.moveOn(alive.filter((id) => id !== this.carrier));
  }
  private moveOn(survivors: readonly PlayerId[]): BombEvent[] {
    this.phase = "pending";
    this.fuse = BOMB_TICKS.fuse;
    this.immune = null;
    this.immuneTicks = 0;
    if (survivors.length < 2) {
      this.carrier = null;
      this.gapLeft = -1;
      return [];
    }
    const next = this.pick(survivors)!;
    this.carrier = next;
    this.gapLeft = BOMB_TICKS.gap;
    return [{ type: "next", carrier: next }];
  }
  private pick(players: readonly PlayerId[]): PlayerId | null {
    if (!players.length) return null;
    return players[Math.min(players.length - 1, Math.floor(this.random() * players.length))];
  }
  /** Seconds left on the fuse (armed) or until it lights (pending after a blast). */
  get seconds() {
    return this.phase === "armed" ? this.fuse / 60 : this.gapLeft > 0 ? this.gapLeft / 60 : 0;
  }
}
