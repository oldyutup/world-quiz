import { CLICK_RACE } from "../simulation/clickrace/config.js";

/**
 * Tıklama Yarışı: the presses made since the client's previous packet, each stamped in ms
 * after BAŞLA on the client's clock. The server decides what counts.
 */
export interface ClickInputPacket {
  seq: number;
  round: number;
  stamps: number[];
}
const keys = ["seq", "round", "stamps"];
export function validateClickInput(value: unknown): ClickInputPacket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as ClickInputPacket;
  if (Object.keys(p).length !== keys.length || Object.keys(p).some((k) => !keys.includes(k))) return null;
  if (![p.seq, p.round].every(Number.isSafeInteger) || p.seq < 0 || p.round < 1) return null;
  if (!Array.isArray(p.stamps) || p.stamps.length < 1 || p.stamps.length > CLICK_RACE.maxStamps) return null;
  if (!p.stamps.every((stamp) => typeof stamp === "number" && Number.isFinite(stamp) && Math.abs(stamp) <= 1e7)) return null;
  return { seq: p.seq, round: p.round, stamps: [...p.stamps] };
}
