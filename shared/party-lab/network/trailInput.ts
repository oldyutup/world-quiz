/**
 * Işık İzi: the direction keys held, as screen directions (W up = dirZ −1, D right = dirX +1;
 * both 0: straight on). Held state: the server reads the newest packet every step.
 */
export interface TrailInputPacket {
  seq: number;
  round: number;
  dirX: number;
  dirZ: number;
}
const keys = ["seq", "round", "dirX", "dirZ"];
export function validateTrailInput(value: unknown): TrailInputPacket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as TrailInputPacket;
  if (Object.keys(p).length !== keys.length || Object.keys(p).some((k) => !keys.includes(k))) return null;
  if (![p.seq, p.round].every(Number.isSafeInteger) || p.seq < 0 || p.round < 1) return null;
  if (![p.dirX, p.dirZ].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return { seq: p.seq, round: p.round, dirX: Math.sign(p.dirX), dirZ: Math.sign(p.dirZ) };
}
