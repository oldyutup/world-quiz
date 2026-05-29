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
  /**
   * Persisted per-player palette pick. Absent for legacy rooms that joined
   * before color persistence was added — readers must fall back to slot-based
   * assignment via `assignConquestPlayerColors`.
   */
  color?: ConquestPlayerColor;
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
  | "orange"
  | "pink"
  | "cyan";

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
  /**
   * Ankara bonus payload: the player id whose hidden shield is currently
   * stamped on this region.  Invisible to opponents; cleared when the shield
   * is triggered by an attack or when the region changes hands.
   */
  hiddenShieldOwnerId?: string;
  /**
   * Distinguishes how the hidden shield got here:
   *   "shield"       — placed by the owner onto a region they already own
   *                    (opponents continue to see it as theirs; reveal:
   *                    "Gizli kalkan ortaya çıktı").
   *   "conquest"     — placed by the holder onto a NEUTRAL region as a
   *                    "gizli fetih": real `ownerPlayerId` flips to the
   *                    placer, but opponents see the tile as neutral via
   *                    projectRegionStatesForViewer.  First enemy attack
   *                    reveals the real owner and is wasted (reveal:
   *                    "Gizli fetih ortaya çıktı").  Adjacency NOT required.
   *                    Also the fallback for very old saves without this
   *                    field (matches the earliest auto-stamp behaviour).
   *   "neutral_trap" — LEGACY: pre-spec-rev3 trap that kept the region
   *                    genuinely neutral.  No new code emits this; kept so
   *                    older in-flight saves still resolve correctly.
   * Absent when no hidden shield is stamped.
   */
  hiddenShieldKind?: "conquest" | "shield" | "neutral_trap";
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

// ── Region bonuses ───────────────────────────────────────────────────────────

/**
 * Catalog of region-bonus families.  Definitions live in regionBonuses.ts
 * (legacy static catalog, still authoritative for the currently-assigned set)
 * and bonusPool.ts (forward-looking 12-type catalog grouped by category).
 * Gameplay wiring lives in conquestGameplay.ts.
 *
 * Two sub-groups are mixed in this union:
 *   1. Active types — picked by `buildRoundBonusAssignment` today via
 *      ROTATING_BONUS_TYPES (istanbul_defense, ankara_hidden_shield,
 *      cukurova_score, karadeniz_extra_time).  Each has a wired effect.
 *   2. Pool-only types — defined in bonusPool.ts, currently `implemented:false`.
 *      They appear in the union for type safety but `buildRoundBonusAssignment`
 *      never assigns them, so no UI surface ever renders them.  When their
 *      gameplay effects are wired in a future PR, the implemented flag flips
 *      and the pool-driven selector swaps in.
 */
export type ConquestRegionBonusType =
  // ── Currently wired (legacy ROTATING_BONUS_TYPES set) ──────────────────────
  | "istanbul_defense"        // passive marker while owned (UI/altyapı only)
  | "ankara_hidden_shield"    // grant pending shield, placed on next capture
  | "cukurova_score"          // one-shot +1 bonus point on capture
  | "karadeniz_extra_time"    // one-shot +5s to bonused player's next move
  // ── Bonus pool — defined but not yet assignable (see bonusPool.ts) ────────
  // Savunma
  | "mevzi_bekcisi"
  | "direnis"
  // Saldırı
  | "kocbasi"
  | "gecit"
  | "kiskac_harekati"
  // Bilgi
  | "eleme_yetkisi"
  | "kahin"
  | "atlas"
  // Ekonomi
  | "liman"
  | "ganimet";

/**
 * Per-player bonus state.  Persisted in ConquestGameState.playerBonuses.
 *
 * Stacking rules (enforced in gameplay):
 *   - pendingHiddenShield  — re-capturing Ankara keeps the flag at true; never
 *                            grants more than one slot.
 *   - extraNextMoveMs      — re-capturing Karadeniz overwrites; never sums.
 *   - cukurovaClaimed      — flips to true on the first Çukurova capture in
 *                            the match and never resets.
 *   - bonusPoints          — only Çukurova writes here today; counted in
 *                            scoring once.
 *
 * istanbul_defense is intentionally NOT mirrored here — it is a passive
 * "while owning" marker derived from current region ownership.
 */
export interface ConquestPlayerBonusState {
  pendingHiddenShield: boolean;
  extraNextMoveMs:     number;
  cukurovaClaimed:     boolean;
  bonusPoints:         number;
}

/**
 * Transient, sync-friendly toast payload announced when a bonus region is
 * captured.  Carried on ConquestGameState so every client renders the same
 * toast at the same moment; UI auto-dismisses after a fixed delay using
 * `at` as the anchor.  The `id` re-keys the React component on every toast
 * even if the message text matches a previous one.
 */
export interface ConquestBonusToast {
  id:         string;
  bonusType:  ConquestRegionBonusType;
  /**
   * Region the bonus was attached to *for this round* — written by the
   * dynamic per-round bonus assigner.  Optional for back-compat with pre-
   * dynamic-bonus saves (readers fall back to the static REGION_BONUSES
   * table or omit region-bound coordination like the capital reveal hold).
   */
  regionId?:  ConquestRegionId;
  /** Display icon (emoji). */
  icon:       string;
  /** Short TR title — e.g. "Ankara Bonusu". */
  title:      string;
  /** One-line TR detail — e.g. "Sıradaki fetih gizli kalkan kazanacak". */
  detail:     string;
  /** Player who earned the bonus — used to colour the toast border. */
  playerId:   string;
  playerName: string;
  /** Epoch ms the toast was raised. UI uses this to time the auto-dismiss. */
  at:         number;
}

/**
 * Dynamic per-round bonus assignment.  Maps `regionId → bonus type` for the
 * regions carrying bonuses this round.  Replaces the static REGION_BONUSES
 * lookup at runtime — the static table is only consulted as a fallback for
 * legacy saves and for the type catalog (icon/label/description).
 *
 * Always exactly one bonus per region; bonus types may repeat across rounds
 * but rarely sit on the same region twice in a row (see anti-repeat in
 * `buildRoundBonusAssignment`).
 */
export type ConquestRoundBonusAssignment = Record<ConquestRegionId, ConquestRegionBonusType>;

/**
 * Resolved bonus def — what the gameplay/UI layers consume.  Carried on the
 * round assignment lookup result so the dynamic bonus moves with its region
 * label, icon, and tooltip copy.
 */
export interface ConquestRegionBonusDef {
  regionId:    ConquestRegionId;
  type:        ConquestRegionBonusType;
  icon:        string;
  label:       string;
  description: string;
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
  /**
   * Player whose submission was the first correct answer to land on the
   * synced state during the challenge phase.  Recorded *without* triggering
   * a phase transition — the phase stays "challenge" until the timer runs
   * out, then jumps to "reveal" with this player promoted to
   * `winnerPlayerId`.  Optional for backward compat with pre-reveal rooms.
   */
  firstCorrectPlayerId?: string | null;
  /**
   * Set of player ids that have submitted *any* answer (correct or wrong)
   * for this challenge.  Used by the host-side "early reveal" check:
   * when every still-in-room eligible player appears here, the host fires
   * `expireChallenge` immediately instead of waiting on the timer.  Race
   * semantics inherited from `firstCorrectPlayerId` (last-write-wins on
   * the Supabase row); a stale write can soft-fail to the timer fallback,
   * but never breaks gameplay.  Optional for backward compat.
   */
  answeredPlayerIds?: string[];
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
  | "reveal"
  | "action"
  | "defense_duel"
  | "round_result"
  | "finished";

/**
 * Lifecycle of a single Savunma Düellosu.
 *   active  — duel live, no winner yet
 *   resolved — attacker or defender answered correctly first
 *   expired — timer ran out without a correct answer (defender wins by spec)
 */
export type ConquestDuelStatus = "active" | "resolved" | "expired";

/**
 * Savunma Düellosu — defense duel triggered when a player attacks an
 * opponent's bonus region (REGION_BONUSES entry).  Only the attacker and the
 * defender may answer; the first correct response wins.  On expiry or if
 * nobody answers, the defender keeps the region by spec ("savunan avantajlı").
 *
 * Optional on ConquestGameState for backward-compat with pre-duel rooms.
 */
export interface ConquestDefenseDuelState {
  /** Stable id used as a React key and to dedupe expiry writes. */
  id:               string;
  attackerId:       string;
  defenderId:       string;
  regionId:         ConquestRegionId;
  /**
   * Whether the region carried an open shield (İstanbul) when the duel
   * started.  Snapshotted here so resolution can break the shield instead of
   * flipping ownership when the attacker wins.
   */
  shieldActive:     boolean;
  /** Reuse of the existing challenge schema — narrowed via eligiblePlayerIds. */
  challenge:        ConquestChallenge;
  startedAt:        number;
  /** Epoch ms when the question panel becomes visible (after the intro overlay).
   *  The 8-second duel timer starts from this point.  Optional for back-compat
   *  with pre-intro rooms; absent → question visible immediately from startedAt. */
  questionVisibleAt?: number;
  endsAt:           number;
  status:           ConquestDuelStatus;
  winnerId:         string | null;
  submittedAnswers: ConquestChallengeAnswer[];
}

/** Snapshot of an in-progress round. */
export interface ConquestRoundState {
  roundNumber:     number;
  totalRounds:     number;
  challenge:       ConquestChallengeState;
  /** Set once the challenge resolves — the player owed a hamle. */
  actionHolderId:  string | null;
  /** Set after the player resolves their action (or skips). */
  lastResult:      ConquestActionResult | null;
  /** Epoch ms when the action (move) phase started for this round. Set on
   *  challenge → action transition; absent in pre-timer rooms or non-action
   *  phases. */
  actionStartedAt?: number;
  /** Epoch ms when the action phase will auto-skip if the holder does not
   *  commit a move. Host watches this and writes the skip; clients render a
   *  countdown from it. Future bonuses (e.g. Doğu Karadeniz +5s) extend the
   *  window by mutating `getMovePhaseDurationMs` only. */
  actionEndsAt?:    number;
  /** Epoch ms when the reveal/results sub-phase started.  Set on the
   *  challenge → reveal transition. */
  revealStartedAt?: number;
  /** Epoch ms when the reveal phase finalises (host transitions to action
   *  or round_result depending on whether anyone answered correctly). */
  revealEndsAt?:    number;
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
  /**
   * Per-player bonus state (Phase: bonus layer v1).  Optional so pre-bonus
   * in-flight rooms keep deserializing cleanly; readers must default missing
   * entries through `createEmptyPlayerBonusState`.
   */
  playerBonuses?:     Record<string, ConquestPlayerBonusState>;
  /**
   * Most recent bonus toast.  Persisted so realtime echo shows the same
   * notification on every client; UI auto-dismisses by comparing
   * `Date.now() - at`.  Cleared on round advance to keep state tidy.
   */
  lastBonusToast?:    ConquestBonusToast;
  /**
   * Active Savunma Düellosu, if any.  Present only while `phase === "defense_duel"`;
   * cleared on resolution.  Optional so pre-duel rooms deserialize cleanly.
   */
  defenseDuel?:       ConquestDefenseDuelState;
  /**
   * Epoch ms when the game-start intro overlay should disappear and the first
   * challenge question becomes interactive.  The first challenge's `startedAt`
   * is anchored to this value so the 20-second timer doesn't begin until the
   * intro finishes.  Absent in pre-intro rooms — UI falls through to immediate
   * challenge display.
   */
  gameIntroEndsAt?:   number;
  /**
   * Match-level bonus assignment — which region carries which bonus type
   * for the entire match.  Picked once at match creation by
   * `buildRoundBonusAssignment` (seeded by `startedAt` alone) and preserved
   * verbatim across all rounds; host writes once, every client reads the
   * same snapshot.  Absent in pre-dynamic-bonus saves — readers fall back
   * to the static REGION_BONUSES table.  Capital cinematic (Ankara) is
   * intentionally NOT routed through this assignment.
   */
  roundBonuses?:      ConquestRoundBonusAssignment;
  /**
   * Legacy: previous round's bonus assignment, kept only for back-compat
   * with pre-match-stable saves.  Modern code no longer writes this — bonus
   * picks no longer depend on round-to-round history.
   */
  prevRoundBonuses?:  ConquestRoundBonusAssignment;
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
