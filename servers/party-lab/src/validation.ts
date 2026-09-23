export const MAX_PLAYERS = 3;
export const CHAT_MAX_LENGTH = 280;
export const CHAT_HISTORY_LIMIT = 40;
export const RECONNECT_SECONDS = 15;
/**
 * Colyseus flood guard. It counts in a FIXED one-second window and, when exceeded,
 * silently detaches the client (no more snapshots, input ignored) and closes the
 * socket with 4002 only after the reconnect grace — the SDK never reconnects from
 * 4002. Input is 60/s, so the former 90/s cap was tripped by the burst of queued
 * packets a ~0.5–1 s uplink stall releases (measured: 91 in-window after a 1 s
 * stall). Handlers are cheap and input is latest-wins; this only stops floods.
 * Clients also coalesce input to 10/s while their input goes unacknowledged.
 */
export const MAX_MESSAGES_PER_SECOND = 300;
/** Diagnostics pings are 1/s; anything faster is ignored without a reply. */
export const PING_MIN_INTERVAL_MS = 200;

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
