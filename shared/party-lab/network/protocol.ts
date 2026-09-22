import type { MovementInput } from "../intent.js";
import type { FeedbackEvent } from "../feedback/events.js";
export const NET = {
  // 3: rooftop arena. Prediction replays against the static map, so a client
  // built for another map must refuse this server's snapshots.
  version: 3,
  physicsHz: 60,
  snapshotHz: 20,
  inputHz: 60,
  staleMs: 300,
  interpolationMs: 100,
} as const;
export type OnlinePhase = "waiting" | "countdown" | "playing" | "results";
export interface InputPacket {
  seq: number;
  round: number;
  moveX: number;
  moveZ: number;
  jumpPressed: boolean;
  punchPressed: boolean;
  grabHeld: boolean;
  liftHeld: boolean;
}
export interface GameEvent extends FeedbackEvent {
  id: number;
  round: number;
  tick: number;
  inputSeq?: number; // Originating punch edge, for local swing-only deduplication.
}
/** Only sent to this slot's client. Never accepted from a client. */
export interface PredictionState {
  slot: number;
  velocities: Uint8Array; // Nine bodies × (linear XYZ, angular XYZ), Float32 LE.
  controller: number[]; // facing, gait, jump cooldown, next hand, alternate cooldown, two age/cooldown pairs
}
export const VELOCITY_BYTES = 9 * 6 * 4;
export interface GameSnapshot {
  v: number;
  seq: number;
  tick: number;
  round: number;
  phase: OnlinePhase;
  seconds: number;
  winner: number;
  mask: number;
  alive: number;
  states: number[];
  meters: number[];
  grips: number[];
  ack: number[];
  transforms: Uint8Array;
  prediction?: PredictionState;
}
export const BODY_COUNT = 9,
  BODY_STRIDE = 7,
  TRANSFORM_BYTES = 3 * BODY_COUNT * BODY_STRIDE * 4;
export const CONDITIONS = [
  "CONSCIOUS",
  "DAZED",
  "KNOCKED_OUT",
  "RECOVERING",
] as const;
const keys = [
  "seq",
  "round",
  "moveX",
  "moveZ",
  "jumpPressed",
  "punchPressed",
  "grabHeld",
  "liftHeld",
];
export function validateInput(value: unknown): InputPacket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as InputPacket;
  if (
    Object.keys(p).length !== keys.length ||
    Object.keys(p).some((k) => !keys.includes(k))
  )
    return null;
  if (
    !Number.isSafeInteger(p.seq) ||
    p.seq < 0 ||
    !Number.isSafeInteger(p.round) ||
    p.round < 1
  )
    return null;
  if (
    ![p.moveX, p.moveZ].every(
      (v) => typeof v === "number" && Number.isFinite(v)
    )
  )
    return null;
  if (
    ![p.jumpPressed, p.punchPressed, p.grabHeld, p.liftHeld].every(
      (v) => typeof v === "boolean"
    )
  )
    return null;
  let x = Math.max(-1, Math.min(1, p.moveX)),
    z = Math.max(-1, Math.min(1, p.moveZ));
  const length = Math.max(1, Math.hypot(x, z));
  x /= length;
  z /= length;
  return { ...p, moveX: x, moveZ: z };
}
export const neutralIntent = (): MovementInput => ({
  x: 0,
  z: 0,
  jump: false,
  punch: false,
  grab: false,
  lift: false,
});
/** Per-session mailbox: sequence high-water mark survives stale/reset/reconnect. */
export class InputMailbox {
  seq = -1;
  processedSeq = -1;
  processedRound = -1;
  processedPunchSeq = -1;
  private punchSeq = -1;
  private received = -Infinity;
  private packet: InputPacket | null = null;
  private jump = false;
  private punch = false;
  accept(value: unknown, round: number, now: number) {
    const p = validateInput(value);
    // Transport limits traffic; valid ordered packets may arrive together after network jitter.
    if (!p || p.round !== round || p.seq <= this.seq) return false;
    this.seq = p.seq;
    this.jump ||= p.jumpPressed && !this.packet?.jumpPressed;
    if (p.punchPressed && !this.packet?.punchPressed && !this.punch) {
      this.punch = true;
      this.punchSeq = p.seq;
    }
    this.packet = p;
    this.received = now;
    return true;
  }
  read(now: number): MovementInput {
    if (now - this.received > NET.staleMs) this.clear();
    const p = this.packet;
    if (p) {
      this.processedSeq = this.seq;
      this.processedRound = p.round;
    }
    this.processedPunchSeq = this.punch ? this.punchSeq : -1;
    const result = p
      ? {
          x: p.moveX,
          z: p.moveZ,
          jump: this.jump,
          punch: this.punch,
          grab: p.grabHeld,
          lift: p.liftHeld,
        }
      : neutralIntent();
    this.jump = this.punch = false;
    return result;
  }
  clear() {
    this.packet = null;
    this.jump = this.punch = false;
    this.received = -Infinity;
    this.punchSeq = this.processedPunchSeq = -1;
  }
}
