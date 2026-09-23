import type { MovementInput } from "../intent.js";
import type { GameMode } from "../modes.js";
import type { GameEvent, GameSnapshot, OnlinePhase, PredictionState } from "../network/protocol.js";
import type { PlayerId } from "./players.js";

/**
 * Room-lifetime counters shared by every simulation a room creates. A room swaps its
 * simulation when the mode changes between rounds (Mixed), but clients rely on
 * monotonic ticks (snapshot order), round epochs (input) and event IDs
 * (deduplication) for the room's whole life, so these never restart.
 */
export interface RoomCounters {
  tick: number;
  round: number;
  event: number;
  snapshot: number;
}
export const newRoomCounters = (): RoomCounters => ({ tick: 0, round: 0, event: 0, snapshot: 0 });

/** What a room needs from a mode's authoritative simulation. */
export interface OnlineSimulation {
  readonly mode: GameMode;
  readonly phase: OnlinePhase;
  readonly roundId: number;
  readonly tick: number;
  /** Participating slots (bitmask). */
  readonly mask: number;
  /** Seconds left in the current phase (0 in the lobby). */
  readonly seconds: number;
  /** Winning slot of the last finished round, −1 for none/draw. */
  readonly winner: number;
  start(slots: readonly PlayerId[]): boolean;
  cancelCountdown(): void;
  /** Disconnected (reconnect grace): stop acting, body stays. */
  neutralize(slot: PlayerId): void;
  /** Left for good: forfeit. */
  remove(slot: PlayerId): void;
  step(inputs: readonly MovementInput[]): GameEvent[];
  snapshot(ack: number[]): GameSnapshot;
  /** Recipient-only state for the client's own prediction rig. */
  prediction(slot: PlayerId): PredictionState;
  dispose(): void;
}
