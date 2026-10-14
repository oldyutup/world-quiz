import { MARKSMAN as M } from "../simulation/marksman/config.js";

/**
 * Nişancı: the aim now (−1 left, 0 middle, +1 right), how many shots the player has fired this
 * round, and the latest of them as [press moment, aim] pairs, oldest first; the last pair is shot
 * number `fired`. A packet repeats the latest shots, so bunched or lost packets lose none and a
 * repeated one counts once. Times are ms after BAŞLA on the player's clock.
 */
export interface MarksmanInputPacket {
  seq: number;
  round: number;
  aim: number;
  fired: number;
  shots: number[];
}
const keys = ["seq", "round", "aim", "fired", "shots"];
const aim = (n: unknown) => n === -1 || n === 0 || n === 1;
export function validateMarksmanInput(value: unknown): MarksmanInputPacket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as MarksmanInputPacket;
  if (Object.keys(p).length !== keys.length || Object.keys(p).some((k) => !keys.includes(k))) return null;
  if (![p.seq, p.round, p.fired].every(Number.isSafeInteger) || p.seq < 0 || p.round < 1 || p.fired < 0 || p.fired > 10_000 || !aim(p.aim)) return null;
  const s = p.shots;
  if (!Array.isArray(s) || s.length % 2 !== 0 || s.length > 2 * M.recentShots || s.length / 2 > p.fired) return null;
  for (let i = 0; i < s.length; i += 2)
    if (typeof s[i] !== "number" || !Number.isFinite(s[i]) || Math.abs(s[i]) > 1e7 || !aim(s[i + 1])) return null;
  return { seq: p.seq, round: p.round, aim: p.aim, fired: p.fired, shots: [...s] };
}
/** The packet's shots as the game reads them. */
export const packetShots = (p: MarksmanInputPacket) => Array.from({ length: p.shots.length / 2 }, (_, i) => ({ at: p.shots[2 * i], aim: p.shots[2 * i + 1] }));
