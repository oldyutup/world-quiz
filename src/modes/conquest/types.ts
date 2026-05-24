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

export type ConquestRoundCount = 6 | 8 | 10;

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
export const CONQUEST_ROUND_COUNTS:  ConquestRoundCount[]  = [6, 8, 10];

export const CONQUEST_DEFAULT_SETTINGS: ConquestRoomSettings = {
  map: "turkey",
  maxPlayers: 4,
  rounds: 8,
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
 * Kinds of action a player can take once they've earned a hamle hakkı.
 *  - capture_neutral → take an unowned region
 *  - attack_region   → flip an enemy region adjacent to one of yours
 *  - defend_region   → reserved for future shield mechanic (not wired yet)
 *  - skip            → relinquish action (legal when no other action exists)
 */
export type ConquestActionType =
  | "capture_neutral"
  | "attack_region"
  | "defend_region"
  | "skip";

/**
 * An atomic action that has been decided for the current resolution step but
 * not yet committed to region states.  `regionId` is omitted only for skip.
 */
export type ConquestPendingAction =
  | { type: "capture_neutral"; playerId: string; regionId: ConquestRegionId }
  | { type: "attack_region";   playerId: string; regionId: ConquestRegionId }
  | { type: "defend_region";   playerId: string; regionId: ConquestRegionId }
  | { type: "skip";            playerId: string };

/**
 * Result of applying a ConquestPendingAction.  `ok=false` means the action
 * was rejected as illegal and the source state is unchanged; the caller
 * should surface `message` to the user.
 */
export interface ConquestActionResult {
  ok:        boolean;
  action:    ConquestActionType;
  playerId:  string;
  regionId:  ConquestRegionId | null;
  /** Localised (TR) message describing the outcome. */
  message:   string;
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 — Gameplay foundation (challenge → action → round loop)
//
// NOTE: This data lives entirely on the client in this phase.  No Supabase
// tables back it.  See `conquestGameplay.ts` for the state factory and
// `ConquestGame.tsx` for the local driver.  When server-authoritative state
// is introduced later, these shapes are the contract a row should map onto.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Catalogue of challenge formats Kuşatma will support.  Only `placeholder`
 * is implemented in this phase; the rest exist so future minigames can be
 * dropped in without re-modelling the round flow.
 */
export type ConquestChallengeType =
  | "quiz"
  | "map_click"
  | "type_race"
  | "flag_guess"
  | "neighbor_question"
  | "placeholder";

/** Lifecycle of a single challenge instance within a round. */
export type ConquestChallengeStatus =
  | "active"     // challenge live, no winner yet
  | "resolved"   // a winner has been determined
  | "skipped";   // no eligible players / forfeit

/**
 * Static description of a single challenge instance.  For non-placeholder
 * types this will eventually carry the question/clue payload directly.
 *
 * Phase 9A: real challenge types carry their answer payload inline.  This is
 * acceptable for a prototype — correctness validation lives client-side
 * (see conquestChallengeValidation.ts).  Server-authoritative validation
 * is a future hardening step.
 */
export interface ConquestChallenge {
  /** Stable id for this challenge instance (unique within a match). */
  id:                 string;
  type:               ConquestChallengeType;
  /** Round number this challenge belongs to (1-based). */
  roundNumber:        number;
  /** Short TR title shown at the top of the challenge panel. */
  title:              string;
  /** Optional one-line TR subtitle / instruction. */
  prompt?:            string;
  /** Players who may win this challenge (typically all active players). */
  eligiblePlayerIds:  string[];
  /** Multiple-choice options for quiz challenges. */
  choices?:           string[];
  /** Flag emoji for flag_guess challenges (e.g. "🇯🇵"). */
  flag?:              string;
  /** Acceptable normalised answers — anything matching wins the challenge. */
  acceptedAnswers?:   string[];
}

/**
 * One player's submission against the active challenge.  Stored in the
 * synced state only for the *winning* submission today (wrong attempts are
 * tracked client-locally to avoid write races); the array shape is kept so
 * a future fairness pass can record every attempt without re-modelling.
 */
export interface ConquestChallengeAnswer {
  playerId:    string;
  playerName:  string;
  answer:      string;
  correct:     boolean;
  /** Epoch ms when this submission was recorded. */
  at:          number;
}

/** Live state of the current round's challenge. */
export interface ConquestChallengeState {
  challenge:        ConquestChallenge;
  status:           ConquestChallengeStatus;
  winnerPlayerId:   string | null;
  /** Epoch ms when this challenge started. */
  startedAt:        number;
  /** Epoch ms when this challenge will time out (status → skipped). */
  endsAt:           number;
  /** Submission log — populated on resolve/expire only.  See doc above. */
  submittedAnswers: ConquestChallengeAnswer[];
  /** Epoch ms when status transitioned to resolved/skipped. */
  resolvedAt?:      number;
}

/**
 * Phase the gameplay loop is currently in.  `setup` is the very brief
 * moment between entering the game screen and the first challenge mounting.
 */
export type ConquestGamePhase =
  | "setup"
  | "challenge"
  | "action"
  | "round_result"
  | "finished";

/** Snapshot of an in-progress round. */
export interface ConquestRoundState {
  roundNumber:     number;
  totalRounds:     number;
  challenge:       ConquestChallengeState;
  /** Set once the challenge resolves — the player owed a hamle. */
  actionHolderId:  string | null;
  /** Set after the player resolves their action (or skips). */
  lastResult:      ConquestActionResult | null;
}

/** Compact per-round log entry kept across the whole match. */
export interface ConquestRoundHistoryEntry {
  roundNumber:        number;
  challengeWinnerId:  string | null;
  result:             ConquestActionResult | null;
}

/**
 * The full client-side gameplay state.  Pure data — no React, no Supabase.
 * Mutated only via helpers in `conquestGameplay.ts` and `conquestActions.ts`.
 */
export interface ConquestGameState {
  mapId:         ConquestMapId;
  players:       ConquestPlayer[];
  phase:         ConquestGamePhase;
  round:         ConquestRoundState;
  regionStates:  ConquestRegionState[];
  history:       ConquestRoundHistoryEntry[];
  startedAt:     number;
  finishedAt:    number | null;
  /** Bank entry ids shown so far; used to prevent repeats within a match. */
  usedChallengeKeys:  string[];
  /** Challenge type shown in the previous round; used to avoid consecutive same-type challenges. */
  lastChallengeType?: ConquestChallengeType;
}

/** Final result row — one per player — used by the result screen. */
export interface ConquestFinalStanding {
  playerId:    string;
  playerName:  string;
  /** 1-based rank.  Tied players share the same rank. */
  rank:        number;
  regionsHeld: number;
  /** Sum of region point values held by this player. */
  points:      number;
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
