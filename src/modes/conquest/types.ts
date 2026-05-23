/**
 * Conquest (Kuşatma) — shared types.
 *
 * Phase-2 scope: entry flow + lobby skeleton. No gameplay, no Supabase
 * persistence. Types are intentionally future-ready so a later backend
 * can map a row directly onto these shapes.
 *
 * Phase-3 additions: full map/region/match state type foundation.
 * No gameplay logic — types and configs only.
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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — Map / Region / Match state foundation
// No gameplay logic. Types and config shapes only.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Describes how a map's regions are modelled.
 * - "country-based"  → regions are real countries or administrative units
 * - "region-based"   → regions are custom conquest zones on a real territory
 * - "custom-board"   → regions are fictional or stylized board squares
 *
 * The distinction matters for future geometry sourcing (GeoJSON countries vs.
 * custom SVG paths vs. abstract tiles) but never affects core game logic.
 */
export type ConquestMapKind =
  | "country-based"
  | "region-based"
  | "custom-board";

/**
 * Per-player conquest color.  Palette intentionally limited to 4 for v1 (max
 * players = 4); extended slots (purple, orange) are reserved for future maps
 * that allow up to 6 players.
 */
export type ConquestPlayerColor =
  | "red"
  | "blue"
  | "green"
  | "yellow"
  | "purple"
  | "orange";

/** Opaque string id that uniquely identifies a region within its map. */
export type ConquestRegionId = string;

/**
 * A single region on a conquest map.  All fields beyond id/name/mapId/neighbors
 * are optional so placeholder regions can be defined with minimal data now and
 * enriched later without breaking existing configs.
 */
export interface ConquestRegion {
  id:            ConquestRegionId;
  name:          string;
  mapId:         ConquestMapId;
  /** Ids of directly adjacent regions — used for capture/defense logic. */
  neighbors:     ConquestRegionId[];
  /** Short label to display inside the region shape (may differ from name). */
  displayLabel?: string;
  /** Decorative emoji shown in UI chips or tooltips. */
  emoji?:        string;
  /**
   * Reference key into a future geometry asset (SVG path id, GeoJSON feature
   * property, etc.).  Not resolved at runtime yet.
   */
  geometryId?:   string;
  /** ISO 3166-1 alpha-2 country code — populated for country-based maps. */
  countryCode?:  string;
  /** Sub-divisions or provinces grouped under this region. */
  provinceList?: string[];
  /** Logical cluster label (e.g. "Batı Avrupa", "Körfez"). */
  groupName?:    string;
  /** Suggested label anchor for a future map renderer — normalised [0,1]. */
  labelPos?:     { x: number; y: number };
}

/** Live state of a single region during an active match. */
export interface ConquestRegionState {
  regionId:         ConquestRegionId;
  /** Null means the region is neutral / uncaptured. */
  ownerPlayerId:    string | null;
  shielded:         boolean;
  lastCapturedBy?:  string;
  /** Round number when this region was last captured. */
  turnCaptured?:    number;
  /** How many times this region has changed hands. */
  captureCount?:    number;
}

/**
 * Full configuration for a Kuşatma map.  This is the authoritative source for
 * map metadata, region topology, and future cosmetic/geometry references.
 * The simpler ConquestMapInfo (id + label + icon) is kept for backward-compat
 * use in dropdowns; ConquestMapConfig is used wherever region data is needed.
 */
export interface ConquestMapConfig {
  id:                 ConquestMapId;
  kind:               ConquestMapKind;
  /** Full localised name shown in headings (e.g. "Türkiye Kuşatması"). */
  displayName:        string;
  /** Compact name for chips/badges (e.g. "Türkiye"). */
  shortName:          string;
  description:        string;
  icon:               string;
  minPlayers:         number;
  maxPlayers:         number;
  recommendedRounds:  number;
  /** Authoritative region count — must equal regions.length. */
  regionCount:        number;
  /** False while the map is a placeholder or not yet shipped. */
  implemented:        boolean;
  regions:            ConquestRegion[];
  /**
   * Optional reference to a future geometry source (URL, asset name, or
   * internal key).  Not consumed at runtime until a map renderer is added.
   */
  geometrySource?:    string;
  /** Cosmetic theme override for this map's board visuals. */
  themeId?:           string;
}

// ── Match state ──────────────────────────────────────────────────────────────

export type ConquestMatchPhase =
  | "waiting"      // lobby — waiting for players to ready up
  | "starting"     // countdown / setup before round 1
  | "question"     // active question or minigame in progress
  | "resolution"   // question answered; map update being applied
  | "finished";    // match complete

/**
 * An atomic action that has been decided for the current resolution step but
 * not yet committed to region states.
 */
export type ConquestPendingAction =
  | { type: "capture"; attackerId: string; regionId: ConquestRegionId }
  | { type: "shield";  defenderId: string; regionId: ConquestRegionId };

/** Complete snapshot of an active or recently-finished Kuşatma match. */
export interface ConquestMatchState {
  roomId:                string;
  mapId:                 ConquestMapId;
  phase:                 ConquestMatchPhase;
  currentRound:          number;
  totalRounds:           number;
  players:               ConquestPlayer[];
  regionStates:          ConquestRegionState[];
  /** Id of the question/minigame currently being displayed. */
  activeQuestionId?:     string;
  /** Player who won the most recent question round. */
  currentTurnWinnerId?:  string;
  pendingAction?:        ConquestPendingAction;
  /** ISO-8601 timestamp when the match transitioned out of "waiting". */
  startedAt?:            string;
  finishedAt?:           string;
}

// ── Result / leaderboard ─────────────────────────────────────────────────────

export interface ConquestPlayerRank {
  playerId:     string;
  playerName:   string;
  /** 1-based rank (1 = winner). */
  rank:         number;
  regionsHeld:  number;
}

export interface ConquestMatchResult {
  roomId:      string;
  mapId:       ConquestMapId;
  /** Null means the match ended in a draw. */
  winnerId:    string | null;
  rankings:    ConquestPlayerRank[];
  /** playerId → number of regions held at match end. */
  regionsWon:  Record<string, number>;
  totalRounds: number;
  startedAt?:  string;
  finishedAt?: string;
}
