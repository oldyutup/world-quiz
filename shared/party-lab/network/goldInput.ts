/**
 * Altın Madenci: one shot. `shot` is the shooter's next shot number (a repeated packet fires
 * once) and `at` the press moment on the shooter's clock, ms after BAŞLA. The server decides
 * whether and when it fires.
 */
export interface GoldInputPacket {
  seq: number;
  round: number;
  shot: number;
  at: number;
}
const keys = ["seq", "round", "shot", "at"];
export function validateGoldInput(value: unknown): GoldInputPacket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as GoldInputPacket;
  if (Object.keys(p).length !== keys.length || Object.keys(p).some((k) => !keys.includes(k))) return null;
  if (![p.seq, p.round, p.shot].every(Number.isSafeInteger) || p.seq < 0 || p.round < 1 || p.shot < 1 || p.shot > 10_000) return null;
  if (typeof p.at !== "number" || !Number.isFinite(p.at) || Math.abs(p.at) > 1e7) return null;
  return { seq: p.seq, round: p.round, shot: p.shot, at: p.at };
}
