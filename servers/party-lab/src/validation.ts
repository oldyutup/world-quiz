export const MAX_PLAYERS = 3;
export const CHAT_MAX_LENGTH = 280;
export const CHAT_HISTORY_LIMIT = 40;
export const RECONNECT_SECONDS = 15;

export function nickname(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) throw new Error("INVALID_NICKNAME");
  const name = value.trim().normalize("NFC");
  if (!/^[\p{L}\p{N}_-]{3,16}$/u.test(name)) throw new Error("INVALID_NICKNAME");
  return name;
}

export function chatText(value: unknown): string {
  if (typeof value !== "string" || value.length > CHAT_MAX_LENGTH) throw new Error("INVALID_CHAT");
  const text = value.normalize("NFC").replace(/[\r\n\t]/g, " ").trim();
  if (!text || /[\p{Cc}\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u.test(text)) {
    throw new Error("INVALID_CHAT");
  }
  // Angle brackets are ordinary text. Clients render this as text, never HTML.
  return text;
}

/** Sliding window; rejected attempts don't extend the cooldown or grow memory. */
export class ChatLimiter {
  private times: number[] = [];
  take(now = Date.now()): boolean {
    this.times = this.times.filter(time => now - time < 5000);
    if (this.times.length >= 4) return false;
    this.times.push(now);
    return true;
  }
}
