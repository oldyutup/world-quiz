/**
 * Conquest (Kuşatma) — pure helpers.
 *
 * No React, no Supabase. Safe to import from any conquest component.
 */

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** "K" prefix + 5 random alphanumerics. Distinguishes conquest rooms from
 *  other mode rooms (D = duel, M = wheel-multi, etc.) inside the shared
 *  duel_messages chat table. */
export function generateConquestRoomCode(): string {
  let out = "K";
  for (let i = 0; i < 5; i++) {
    out += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return out;
}

export function freshConquestPlayerId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `cq-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function validateConquestName(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < 2)  return "Oyuncu adı en az 2 karakter olmalı.";
  if (trimmed.length > 16) return "Oyuncu adı en fazla 16 karakter olabilir.";
  return null;
}

/** Build an invite URL that opens this app directly into the conquest
 *  lobby for the given code. Backend-less for now; just a placeholder
 *  for the share-link UI. */
export function buildConquestShareLink(code: string): string {
  if (typeof window === "undefined") return "";
  const { origin, pathname } = window.location;
  return `${origin}${pathname}?conquest=${code}`;
}

/**
 * Convert a flag emoji built from Regional Indicator Symbol pairs (e.g.
 * "🇯🇵") to its ISO 3166-1 alpha-2 code (e.g. "jp").  Returns null when the
 * input is not a valid two-letter regional indicator pair.
 *
 * Why: Chromium-family browsers on Windows do not render flag glyphs from
 * regional indicator pairs (Segoe UI Emoji intentionally omits them), so a
 * bare emoji string renders as letter tofu or nothing.  Callers should use
 * this to swap the emoji for a guaranteed-cross-browser SVG from
 * /assets/flags/{code}.svg, falling back to the emoji when conversion fails.
 */
export function flagEmojiToCountryCode(flag: string): string | null {
  const REGIONAL_A = 0x1F1E6; // 🇦
  const REGIONAL_Z = 0x1F1FF; // 🇿
  const codePoints: number[] = [];
  for (const ch of flag) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) return null;
    codePoints.push(cp);
  }
  if (codePoints.length !== 2) return null;
  const [a, b] = codePoints;
  if (a < REGIONAL_A || a > REGIONAL_Z) return null;
  if (b < REGIONAL_A || b > REGIONAL_Z) return null;
  const first  = String.fromCharCode(0x41 + (a - REGIONAL_A));
  const second = String.fromCharCode(0x41 + (b - REGIONAL_A));
  return (first + second).toLowerCase();
}
