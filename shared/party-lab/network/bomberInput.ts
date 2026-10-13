/**
 * Bombacı: one step of walking (world axes, length ≤ 1) and the bomb presses so far this
 * round. A press is the counter going up, so a packet read twice never places a second bomb.
 */
export interface BomberInputPacket {
  seq: number;
  round: number;
  moveX: number;
  moveZ: number;
  bombs: number;
}
const keys = ["seq", "round", "moveX", "moveZ", "bombs"];
export function validateBomberInput(value: unknown): BomberInputPacket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as BomberInputPacket;
  if (Object.keys(p).length !== keys.length || Object.keys(p).some((k) => !keys.includes(k))) return null;
  if (![p.seq, p.round, p.bombs].every(Number.isSafeInteger) || p.seq < 0 || p.round < 1 || p.bombs < 0 || p.bombs > 100_000) return null;
  if (![p.moveX, p.moveZ].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const x = Math.max(-1, Math.min(1, p.moveX)),
    z = Math.max(-1, Math.min(1, p.moveZ)),
    length = Math.max(1, Math.hypot(x, z));
  return { seq: p.seq, round: p.round, moveX: x / length, moveZ: z / length, bombs: p.bombs };
}
