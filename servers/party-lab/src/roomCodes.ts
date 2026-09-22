import { randomInt } from "node:crypto";

export const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function normalizeRoomCode(value: unknown): string {
  if (typeof value !== "string" || value.length > 32) throw new Error("INVALID_CODE");
  const code = value.trim().toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) throw new Error("INVALID_CODE");
  return code;
}

/** Atomic within this single Node process. No Torble registry or database. */
export class RoomCodes {
  private active = new Set<string>();
  constructor(private readonly random: (max: number) => number = randomInt) {}
  claim(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = Array.from({ length: 6 }, () => ROOM_ALPHABET[this.random(ROOM_ALPHABET.length)]).join("");
      if (!this.active.has(code)) {
        this.active.add(code);
        return code;
      }
    }
    throw new Error("ROOM_CODE_EXHAUSTED");
  }
  release(code: string) { this.active.delete(code); }
}
export const roomCodes = new RoomCodes();
