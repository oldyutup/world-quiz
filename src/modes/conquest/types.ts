/**
 * Conquest (Kuşatma) — shared types.
 *
 * Phase-2 scope: entry flow + lobby skeleton. No gameplay, no Supabase
 * persistence. Types are intentionally future-ready so a later backend
 * can map a row directly onto these shapes.
 */

export type ConquestMapId =
  | "turkey"
  | "europe"
  | "middle-east";

export type ConquestVisibility = "public" | "private";

export type ConquestRoundCount = 4 | 6 | 8;

export type ConquestMaxPlayers = 2 | 3 | 4;

export type ConquestRoomStatus = "waiting" | "playing" | "finished";

export interface ConquestPlayer {
  id: string;
  name: string;
  isHost: boolean;
  /** Reserved for a future per-player color/region tint. */
  colorIndex?: number;
}

export interface ConquestRoomSettings {
  map: ConquestMapId;
  maxPlayers: ConquestMaxPlayers;
  rounds: ConquestRoundCount;
  visibility: ConquestVisibility;
}

export interface ConquestRoomSummary {
  code: string;
  hostName: string;
  settings: ConquestRoomSettings;
  playerCount: number;
  status: ConquestRoomStatus;
}

export interface ConquestMapInfo {
  id: ConquestMapId;
  label: string;
  icon: string;
}

export const CONQUEST_MAPS: ConquestMapInfo[] = [
  { id: "turkey",      label: "Türkiye Kuşatması",     icon: "🇹🇷" },
  { id: "europe",      label: "Avrupa Kuşatması",      icon: "🇪🇺" },
  { id: "middle-east", label: "Orta Doğu Kuşatması",   icon: "🕌" },
];

export const CONQUEST_PLAYER_COUNTS: ConquestMaxPlayers[] = [2, 3, 4];
export const CONQUEST_ROUND_COUNTS:  ConquestRoundCount[]  = [4, 6, 8];

export const CONQUEST_DEFAULT_SETTINGS: ConquestRoomSettings = {
  map: "turkey",
  maxPlayers: 4,
  rounds: 6,
  visibility: "public",
};

/** Minimum players to enable "Oyunu Başlat". */
export const CONQUEST_MIN_PLAYERS = 2;

/** Visual slot ceiling. Kuşatma caps at 4, but the slot column tolerates
 *  10 (parity with WheelGroup) without breaking layout. */
export const CONQUEST_VISUAL_SLOTS = 10;

export function mapLabel(id: ConquestMapId): string {
  return CONQUEST_MAPS.find(m => m.id === id)?.label ?? id;
}

export function mapIcon(id: ConquestMapId): string {
  return CONQUEST_MAPS.find(m => m.id === id)?.icon ?? "🗺️";
}

export function visibilityLabel(v: ConquestVisibility): string {
  return v === "public" ? "Açık oda" : "Gizli oda";
}
