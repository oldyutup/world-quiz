/**
 * Kutu Kulesi: one drop. `drop` is the player's next drop number (a repeated packet drops
 * once) and `at` the press moment on the player's clock, ms after BAŞLA. The server decides
 * whether the box drops and into which column.
 */
export interface TowerInputPacket {
  seq: number;
  round: number;
  drop: number;
  at: number;
}
const keys = ["seq", "round", "drop", "at"];
export function validateTowerInput(value: unknown): TowerInputPacket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as TowerInputPacket;
  if (Object.keys(p).length !== keys.length || Object.keys(p).some((k) => !keys.includes(k))) return null;
  if (![p.seq, p.round, p.drop].every(Number.isSafeInteger) || p.seq < 0 || p.round < 1 || p.drop < 1 || p.drop > 10_000) return null;
  if (typeof p.at !== "number" || !Number.isFinite(p.at) || Math.abs(p.at) > 1e7) return null;
  return { seq: p.seq, round: p.round, drop: p.drop, at: p.at };
}
