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
