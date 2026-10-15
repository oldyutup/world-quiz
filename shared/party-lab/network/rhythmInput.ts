import { RHYTHM as R } from "../simulation/rhythm/config.js";

/**
 * Ritim Ustası: how many keys the player has pressed this round, and the latest of those
 * presses as [press moment, key] pairs, oldest first; the last pair is press number `pressed`.
 * A packet repeats the latest presses, so bunched or lost packets lose none and a repeated one
 * counts once. Times are ms after BAŞLA on the player's clock; keys 0 W, 1 A, 2 S, 3 D.
 */
export interface RhythmInputPacket {
  seq: number;
  round: number;
  pressed: number;
  presses: number[];
}
const keys = ["seq", "round", "pressed", "presses"];
const key = (n: unknown) => n === 0 || n === 1 || n === 2 || n === 3;
export function validateRhythmInput(value: unknown): RhythmInputPacket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as RhythmInputPacket;
  if (Object.keys(p).length !== keys.length || Object.keys(p).some((k) => !keys.includes(k))) return null;
  if (![p.seq, p.round, p.pressed].every(Number.isSafeInteger) || p.seq < 0 || p.round < 1 || p.pressed < 0 || p.pressed > 20_000) return null;
  const s = p.presses;
  if (!Array.isArray(s) || s.length % 2 !== 0 || s.length > 2 * R.recentPresses || s.length / 2 > p.pressed) return null;
  for (let i = 0; i < s.length; i += 2) if (typeof s[i] !== "number" || !Number.isFinite(s[i]) || Math.abs(s[i]) > 1e7 || !key(s[i + 1])) return null;
  return { seq: p.seq, round: p.round, pressed: p.pressed, presses: [...s] };
}
/** The packet's presses as the game reads them. */
export const packetPresses = (p: RhythmInputPacket) => Array.from({ length: p.presses.length / 2 }, (_, i) => ({ at: p.presses[2 * i], key: p.presses[2 * i + 1] }));
