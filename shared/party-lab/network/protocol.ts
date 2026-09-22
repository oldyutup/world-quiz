import type { MovementInput } from "../intent.js";
import type { FeedbackEvent } from "../feedback/events.js";
export const NET = {
  version: 1,
  physicsHz: 60,
  snapshotHz: 20,
  inputHz: 30,
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
}
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
  private received = -Infinity;
  private packet: InputPacket | null = null;
  private jump = false;
  private punch = false;
  accept(value: unknown, round: number, now: number) {
    const p = validateInput(value);
    if (!p || p.round !== round || p.seq <= this.seq || now - this.received < 8)
      return false;
    this.seq = p.seq;
    this.jump ||= p.jumpPressed && !this.packet?.jumpPressed;
    this.punch ||= p.punchPressed && !this.packet?.punchPressed;
    this.packet = p;
    this.received = now;
    return true;
  }
  read(now: number): MovementInput {
    if (now - this.received > NET.staleMs) this.clear();
    const p = this.packet;
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
  }
}
