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

/**
 * How active bonuses are picked for a match.
 *   "random" — engine picks bonuses (current behaviour).
 *   "vote"   — players vote in the lobby; top vote-getters become active.
 * Lobby-only setting today: the picker still uses the legacy random path
 * regardless of this value (see bonusPool.ts).  Wiring the vote result into
 * `createInitialConquestGameState` is a follow-up.
 */
export type ConquestBonusDistribution = "random" | "vote";

/**
 * Oyun tipi — Layer 1.
 *   • "individual"  → bireysel Kuşatma (mevcut davranış)
 *   • "teams_2v2"   → 4 oyunculu, 2v2 takımlı lobby
 * Gameplay kuralları Layer 1'de bu değerden etkilenmez; sadece lobby/takım
 * seçimi/state altyapısı bu alanı kullanır.
 */
export type ConquestTeamMode = "individual" | "teams_2v2";

/** 2v2 modda kullanılabilen takım kimlikleri. 1 = Mavi, 2 = Kırmızı. */
export type ConquestTeamId = 1 | 2;

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
  /**
   * 2v2 Takımlı modda oyuncunun takımı.  null → seçmedi / bireysel mod.
   * Layer 1: bilgilendirme amaçlı; gameplay kuralları bu alanı kullanmıyor.
   */
  teamId?: ConquestTeamId | null;
}

export interface ConquestRoomSettings {
  map: ConquestMapId;
  maxPlayers: ConquestMaxPlayers;
  rounds: ConquestRoundCount;
  visibility: ConquestVisibility;
  /**
   * Phase-bonus-vote: how bonus types are distributed at match start.
   * Optional for back-compat with rooms whose row predates the setting —
   * readers default to "random".
   */
  bonusDistribution?: ConquestBonusDistribution;
  /**
   * 2v2 Takımlı mod — Layer 1.  Yoksa "individual" varsayılır.  Sadece
   * lobby/seçim altyapısı kullanır; gameplay kuralları bu alana göre
   * davranmaz.
   */
  teamMode?: ConquestTeamMode;
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
  bonusDistribution: "random",
  teamMode: "individual",
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
  /**
   * Mevzi Bekçisi 🏰 anti-farm log.  Player ids who have ALREADY redeemed
   * the protection bonus on this region during this match — they preserved
   * the region's point value when they lost it.  Repeat losses by a name
   * already in this list never grant the protection again.  New owners are
   * eligible on their own first loss.  Absent / empty in pre-mevzi saves.
   */
  mevziProtectionClaimedBy?: string[];
  /**
   * Liman ⚓ per-tenure income counter.  Counts how many round-end income
   * payouts the *current owner* has already received on this region.  Reset
   * to 0 on every ownership change so a fresh owner restarts at 0/10 and
   * can earn up to 10 more payouts.  Cap = 10 (LIMAN_MAX_INCOME_TICKS).
   * Absent / 0 when the region has never produced income under the current
   * owner.  Optional for back-compat with pre-Liman saves.
   */
  limanIncomeTicks?: number;
  /**
   * Bereketli Ova 🌾 per-tenure hold counter.  Counts how many consecutive
   * round-end ticks the *current owner* has held this region (0..INTERVAL).
   * The harvest payout fires exactly ONCE per tenure — when the counter
   * first reaches BEREKET_HARVEST_INTERVAL (3) — and the counter then stays
   * at that value as a "harvested" sentinel so subsequent ticks are no-ops.
   * Reset to 0 on every ownership change so a new owner restarts fresh and
   * has to hold the region for 3 fresh rounds to earn their own harvest.
   * Absent / 0 when the region has never ticked under the current owner.
   * Optional for back-compat with pre-bereket-harvest saves.
   */
  bereketHarvestTurns?: number;
  /**
   * Sınır Karakolu (Kuşatma fate card) — id of the player who placed a
   * border outpost on this NEUTRAL region.  Region ownerPlayerId stays
   * null; an enemy capture attempt opens a defense duel between the
   * attacker and this outpost owner instead of flipping ownership.
   * Cleared on duel resolution (any outcome), on an eliminated-owner
   * direct capture, and on any flipOwnership write.  Absent / undefined
   * when no outpost is present.  Optional for back-compat.
   */
  borderOutpostOwnerId?: string;
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
  | "cukurova_score"          // Bereketli Ova: +2 on every capture, one-shot +4 harvest after 3 held rounds (per tenure)
  | "karadeniz_extra_time"    // one-shot +5s to bonused player's next move
  // ── Bonus pool — defined but not yet assignable (see bonusPool.ts) ────────
  // Savunma
  | "mevzi_bekcisi"
  | "direnis"
  // Saldırı
  | "kocbasi"
  | "gecit"
  | "kiskac_harekati"
  | "mancinik"
  // Bilgi
  | "eleme_yetkisi"
  | "kahin"
  | "atlas"
  | "istihbarat_agi"
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
 *   - cukurovaClaimed      — LEGACY one-shot lock; no longer gates the
 *                            Bereketli Ova payout (every capture pays +2 now)
 *                            but the field stays in the type so old saves
 *                            round-trip cleanly through serialisation.
 *   - bonusPoints          — written by Bereketli Ova (capture +2, one-shot
 *                            +4 harvest after 3 held rounds per tenure),
 *                            Liman (per-tick income),
 *                            Koçbaşı (enemy capture +1), and Mevzi Bekçisi
 *                            (per-region-per-tenure protection payout on a
 *                            mevzi region loss).  Counted in scoring directly
 *                            (see regionPoints.ts) and reflected on the
 *                            top-left scoreboard via getPlayerTotalPoints.
 *
 * istanbul_defense is intentionally NOT mirrored here — it is a passive
 * "while owning" marker derived from current region ownership.
 */
export interface ConquestPlayerBonusState {
  pendingHiddenShield: boolean;
  extraNextMoveMs:     number;
  cukurovaClaimed:     boolean;
  bonusPoints:         number;
  /**
   * Eleme Yetkisi 🃏 — number of pending wrong-choice eliminations.  Granted
   * by capturing an eleme_yetkisi bonus region (overwrite-not-stack: max 1).
   * Consumed on the next *multiple-choice* challenge submission only — flag/
   * type-write challenges leave the charge intact for later use.  Optional
   * for back-compat with pre-eliminator saves; readers default to 0.
   */
  eliminatorCharges?:  number;
  /**
   * Mancınık 🎯 — number of pending long-range attack charges.  Granted
   * (overwrite-not-stack, max 1) by capturing the mancinik bonus region.
   * While > 0, the holder's next attack/capture ignores the adjacency rule
   * and may target ANY region on the map.  Consumed exactly once when the
   * holder commits an action whose target was not otherwise adjacency-legal
   * (i.e., the bypass was actually used).  Optional for back-compat with
   * pre-mancinik saves; readers default to 0.
   */
  mancinikCharges?:    number;
  /**
   * Muhafız Desteği 🛡️ — number of pending open-shield bypass charges.
   * Granted (overwrite-not-stack: Math.max(prev, 1)) by drawing the `kalkan`
   * fate card.  While > 0, the holder's next attack against an opponent
   * region with `shielded === true` ignores the shield: an attacker-win in
   * the resulting duel flips ownership instead of just breaking the shield.
   * Consumed at duel start the moment the attempt launches (Mancınık's
   * "shot leaves the silo" rule) — both correct and wrong duel outcomes
   * spend the charge.  Skipped when the target carries no open shield, when
   * Koçbaşı already supplies the bypass for free (charge is preserved), and
   * when the duel is a Sınır Karakolu / hidden-shield path (neither uses
   * `target.shielded`).  Optional for back-compat with pre-guardian saves;
   * readers default to 0.
   */
  guardianShieldBypassCharges?: number;
  /**
   * Liman 🪙 — total Gold this player has earned via Liman round-end income
   * for the current match.  Synced in gameplay state so every client can see
   * each player's in-match earnings (account-level gold is NEVER mirrored
   * here — only what was won inside this match).  Optional for back-compat
   * with pre-liman saves; readers default to 0.
   */
  matchGoldEarned?:    number;
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
  /**
   * Mevzi Bekçisi 🏰 — point value preserved by the previous owner when a
   * mevzi region changed hands.  When set, viewer-aware copy switches to the
   * loss-flavour banner ("Mevzi direndi: X puan korundu.").  `playerId` /
   * `playerName` on this toast refer to the previous owner (who keeps the
   * points); `previousOwnerId` mirrors `playerId` for clarity.
   */
  pointsPreserved?: number;
  previousOwnerId?: string;
}

// ── Hidden bonuses ───────────────────────────────────────────────────────────

/**
 * Catalog of hidden bonus types.  These are kept on a SEPARATE channel from
 * the open `ConquestRegionBonusType` rotation: they never render an icon on
 * the map, they may not spawn at all on a given match, and they are claimed
 * one-shot via region capture (the placement disappears the moment a region
 * with a hidden bonus first changes hands).
 *
 * The real gameplay effects are wired in a follow-up — this revision only
 * delivers the infrastructure (spawn, claim, inventory, viewer-aware toast).
 */
export type ConquestHiddenBonusType =
  | "lanet_muhru"
  | "pusu"
  | "suikast";

/**
 * Per-region hidden bonus placement.  Authoritative source of truth for
 * "this region carries a hidden bonus of this type, claimed or not".  Lives
 * on `ConquestGameState.hiddenBonusPlacements` (regionId → placement).
 *
 * `claimedByPlayerId` flips from undefined to the claimer's id on the FIRST
 * ownership change of this region during the match.  Once set, the region
 * never grants another hidden bonus — subsequent owners get nothing here.
 */
export interface ConquestHiddenBonusPlacement {
  type:               ConquestHiddenBonusType;
  claimedByPlayerId?: string;
  claimedAtRound?:    number;
}

/**
 * One-shot hidden bonus charge held in a player's inventory.  Appended to
 * `ConquestGameState.playerHiddenBonuses[playerId]` when the player captures
 * a region carrying an unclaimed hidden bonus.
 *
 * `used` is reserved for the next revision (the actual effect/consume flow).
 * This revision only ever sets it to `false`.
 */
export interface ConquestPlayerHiddenBonus {
  id:               string;
  type:             ConquestHiddenBonusType;
  used:             boolean;
  claimedRegionId:  ConquestRegionId;
  claimedRound:     number;
}

/**
 * Viewer-aware toast announced on a hidden bonus event.  Synced through
 * `ConquestGameState.lastHiddenBonusToast` so every client renders the same
 * notification at the same moment.  The renderer chooses which copy to show
 * based on the local viewer id.
 *
 * Two event flavours share the channel:
 *   - "claim" (default / legacy)  — a player just picked up a hidden bonus by
 *     capturing the carrying region.  Claimer sees the real type; everyone
 *     else gets the generic "rakip gizli bonus keşfetti" copy.
 *   - "use"                       — a player consumed a hidden bonus (Suikast
 *     so far).  Three audiences: caster (success), target (got hit), others
 *     (observer).  `targetPlayerId/Name` and `pointsLost` carry the payload
 *     needed for those copy variants.
 */
export interface ConquestHiddenBonusToast {
  id:           string;
  type:         ConquestHiddenBonusType;
  claimerId:    string;
  claimerName:  string;
  /** Region the bonus was claimed on.  Optional on "use" events where the
   *  toast is not tied to any region.  Required on legacy "claim" events. */
  regionId?:    ConquestRegionId;
  at:           number;
  /** Distinguishes a claim notification from a consume notification.  Absent
   *  in pre-use saves — readers must default to "claim" for back-compat.
   *  "trigger" fires when a delayed-effect bonus (Lanet Mührü) actually
   *  consumes its pending effect — distinct from "use" which fires at the
   *  moment the caster spends the charge. */
  event?:       "claim" | "use" | "trigger";
  /** Use-only: the player that got hit by the consumed bonus. */
  targetPlayerId?:   string;
  targetPlayerName?: string;
  /** Use-only: how many points were actually deducted from the target
   *  (clamped so their visible total never drops below 0). */
  pointsLost?:       number;
}

/**
 * Lanet Mührü 🧿 — pending curse applied to a target player.  Stored on
 * `ConquestGameState.activeHiddenEffects.curses` keyed by `targetPlayerId`.
 *
 * Lifecycle:
 *   1. Caster consumes their Lanet Mührü charge against a chosen opponent —
 *      a curse entry is inserted; caster's inventory entry flips to `used`.
 *   2. The curse waits silently.  Target may answer wrong any number of
 *      times — the curse does NOT consume on a wrong answer.
 *   3. The first time the target answers a CHALLENGE correctly *and would
 *      receive hamle hakkı* (i.e. they'd promote from `reveal` → `action`
 *      as the action holder), the curse fires: the move is cancelled, the
 *      round jumps to `round_result` with a curse-specific message, and the
 *      curse entry is removed.
 *
 * Defense duels are explicitly outside the curse window — only the
 * round-level challenge → action transition consumes it.
 */
export interface ConquestPendingCurse {
  casterPlayerId: string;
  bonusEntryId:   string;
  createdRound:   number;
}

/**
 * Pusu 🕳️ — pending ambush armed on a chosen region.  Stored on
 * `ConquestGameState.activeHiddenEffects.ambushes` keyed by `regionId`.
 *
 * Lifecycle:
 *   1. Owner consumes their Pusu charge and chooses a region they own OR a
 *      neutral region (NEVER an enemy region, NEVER a capital).  Inventory
 *      entry flips to `used`; an ambush entry is inserted under that region.
 *   2. The ambush waits silently.  Only the owner sees a marker on their
 *      own map view; opponents see nothing.
 *   3. The first time an *opponent* targets the ambushed region with an
 *      attack/capture, the ambush fires: the action is cancelled BEFORE any
 *      duel starts or ownership flips, the round jumps to `round_result`
 *      with a Pusu-flavoured message, and the ambush entry is removed.
 *
 * Owner-self interactions (clicking your own ambush region) never trigger:
 * `canCaptureNeutral` rejects own regions and `canAttackRegion` rejects
 * targets you already own.  The trigger predicate also explicitly bails out
 * when `attackerId === ownerPlayerId` as a defensive second guard.
 */
export interface ConquestPendingAmbush {
  ownerPlayerId: string;
  bonusEntryId:  string;
  createdRound:  number;
}

/**
 * Container for all "in-flight" hidden bonus effects that outlive a single
 * helper call.  Lanet Mührü uses `curses`; Pusu uses `ambushes`.  Optional
 * on ConquestGameState for back-compat with pre-curse saves.
 */
export interface ConquestActiveHiddenEffects {
  /** Pending curses keyed by targetPlayerId.  At most one curse per target
   *  at any time — a second Lanet Mührü against an already-cursed target
   *  is rejected by `useLanetMuhruHiddenBonus`. */
  curses?: Record<string, ConquestPendingCurse>;
  /** Pending ambushes keyed by regionId.  At most one ambush per region
   *  (a second Pusu on an already-ambushed region is rejected by
   *  `usePusuHiddenBonus`). */
  ambushes?: Record<string, ConquestPendingAmbush>;
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
  /**
   * Owner of `regionId` immediately BEFORE this action committed.  Populated
   * for ownership-changing outcomes (currently the duel-flip success path)
   * so viewer-aware round_result cards (e.g. the liman control-flip variant)
   * can name the previous holder without re-deriving it from history.
   * Absent on actions that don't flip ownership or on legacy snapshots.
   */
  previousOwnerId?: string;
  /**
   * Koçbaşı 🪵 shield-bypass marker.  Set to `true` on the duel-flip success
   * path when the duel snapshot recorded `kocbasiBypass` — i.e. the attacker
   * single-stepped through an open shield (Kale Surları) instead of just
   * breaking it.  Used by the round_result card to render the "Koçbaşı
   * Surları Parçaladı!" variant for the Kale Surları bonus.  Absent on
   * non-bypass flips and legacy snapshots.
   */
  kocbasiShieldBypass?: boolean;
  /**
   * Mancınık 🎯 — true when the attacker consumed a Mancınık charge to launch
   * this action (i.e., the target was not adjacency-legal without the
   * bypass).  Forwarded onto the action result so the UI can render the
   * "Mancınık Ateşlendi!" big card and, when combined with
   * `kocbasiShieldBypass`, the "Kuşatma Darbesi!" combo card.  Absent on
   * non-bypass actions and legacy snapshots.
   */
  mancinikBypassUsed?: boolean;
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
  /**
   * Extra milliseconds granted to the defender on top of the base
   * `DEFENSE_DUEL_MS` window — currently set when the target region carries
   * the Mevzi Bekçisi 🏰 bonus (and the defender is the current owner of
   * that region).  `endsAt` is the *defender's* deadline (= the moment the
   * duel finally times out and the defender wins by default).  The attacker
   * is capped at `endsAt - defenderTimeBonusMs`; submissions after that
   * point are rejected by `submitDuelAnswer`.  Optional / 0 → symmetric
   * timer (legacy behaviour).
   */
  defenderTimeBonusMs?: number;
  endsAt:           number;
  status:           ConquestDuelStatus;
  winnerId:         string | null;
  submittedAnswers: ConquestChallengeAnswer[];
  /**
   * Koçbaşı 🪵 — true when the attacker owns the kocbasi bonus region AND
   * the target carried an open shield at duel start.  In that case the duel
   * stores `shieldActive: false` so resolution flips ownership directly
   * (single-step capture); this flag records that the shield was actually
   * present and bypassed, so UI can show the bypass chip and the post-flip
   * toast can announce "kalkanı aştı".  Absent / false in normal duels.
   */
  kocbasiBypass?:   boolean;
  /**
   * Mancınık 🎯 — true when the attacker used a Mancınık charge to launch
   * this attack (i.e., the target region was not adjacency-legal without the
   * bypass).  Snapshotted at duel start so `resolveDuelWithWinner` can
   * forward the bypass into `applyConquestAction`'s adjacency check on the
   * attacker-wins-flip path.  Absent on normal duels.
   */
  mancinikBypass?:  boolean;
  /**
   * Muhafız Desteği 🛡️ — true when the attacker spent a
   * `guardianShieldBypassCharges` charge to launch this attack (target
   * carried an open shield AND Koçbaşı was not already supplying the
   * bypass).  Like `kocbasiBypass`, the duel stores `shieldActive: false`
   * so attacker-win flips ownership directly; this flag records that the
   * shield was actually present and bypassed via the fate-card charge, so
   * UI can show the bypass chip / toast variant.  Absent on normal duels.
   */
  guardianBypass?:  boolean;
  /**
   * Sınır Karakolu — true when this duel was triggered by an attacker
   * targeting a NEUTRAL region carrying a defender's border outpost.
   * Region's `ownerPlayerId` is null and `defenderId` is the outpost
   * owner (not the region owner).  Resolution diverges from the standard
   * duel: attacker-win flips neutral → attacker; defender-win / expire
   * keeps region neutral; both outcomes clear `borderOutpostOwnerId` on
   * the target region.  Capture-side bonus chains (mevzi/koçbaşı/hidden
   * bonus claim) are intentionally skipped on this branch because the
   * region's bonus payload belongs to no current owner.  Absent on
   * normal duels.
   */
  outpostBreak?:    boolean;
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
  /**
   * Kâhin Büyüsü 🔮 — pre-picked challenge for the *next* round.  The host
   * resolves a full ConquestChallenge ahead of time so the Kâhin region's
   * current owner can peek at the upcoming question's type (only the type
   * label is rendered — never the prompt or answer; opponents never see the
   * chip).  `advanceToNextRound` consumes this entry verbatim as the actual
   * next-round challenge and immediately re-picks a fresh one for the round
   * after.  Absent on the final round (no future round to preview) and on
   * pre-Kâhin saves — readers must treat missing as "no preview".
   */
  nextChallenge?: {
    challenge: ConquestChallenge;
    bankId:    string;
  };
  /**
   * Hidden bonus placements for this match.  Picked once at match creation
   * by `buildHiddenBonusPlacements` and persisted as a `regionId → placement`
   * map.  Hidden bonuses are intentionally separate from `roundBonuses`:
   *   - They may not spawn at all (per-match probability gate).
   *   - They never render an icon on the map.
   *   - They are claimed one-shot on the FIRST capture of the region.
   * Absent (or empty) when no hidden bonus was placed this match, or in
   * legacy saves predating the hidden bonus system.
   */
  hiddenBonusPlacements?: Record<ConquestRegionId, ConquestHiddenBonusPlacement>;
  /**
   * Per-player hidden bonus inventory.  Appended to whenever a player claims
   * a hidden bonus by capturing its region for the first time.  Each entry
   * represents one one-shot charge; the consume flow (real effects) is wired
   * in a follow-up.  Absent in pre-hidden-bonus saves; readers must default
   * a missing player entry to an empty array.
   */
  playerHiddenBonuses?: Record<string, ConquestPlayerHiddenBonus[]>;
  /**
   * Most recent hidden-bonus claim toast.  Persisted on game state so every
   * client renders the SAME viewer-aware notification (claimer sees the real
   * bonus name; everyone else sees the generic "rakip gizli bonus keşfetti"
   * copy).  Cleared on round advance so a stale claim doesn't echo to late
   * joiners.
   */
  lastHiddenBonusToast?: ConquestHiddenBonusToast;
  /**
   * Container for delayed-effect hidden bonus state that outlives a single
   * helper call (currently Lanet Mührü pending curses).  Absent in pre-curse
   * saves; readers default missing/empty sub-maps to "no active effects".
   */
  activeHiddenEffects?: ConquestActiveHiddenEffects;
  /**
   * 👁️ İstihbarat Ağı — last intel report written to synced state.  The
   * payload is identical on every client; only the renderer decides whether
   * to display it (true only when the local viewer currently owns the
   * istihbarat_agi bonus region).  Cleared on round advance so a stale
   * report doesn't echo to late joiners.
   */
  lastIntelReport?: ConquestIntelReport;
  /**
   * Auto-finish (last player standing) winner.  Populated only when the match
   * was ended because every other player either explicitly left or stayed
   * stale (no heartbeat) past the 60-second reconnect window.  The normal
   * round-based finish path leaves this absent; `buildFinalStandings` honours
   * the override by promoting this player to rank #1 so the result screen
   * and the win/lose audio cue agree with the abandoned-match outcome.
   */
  winnerPlayerId?: string;
  /** Display name snapshotted at finish time — handy for XP/audit later. */
  winnerName?:     string;
  /**
   * How the match ended.  Absent on legacy / in-progress saves; the natural
   * round-loop finish path leaves it implicit.  Auto-finish writes one of
   * the two values below so future XP logic can distinguish a normal victory
   * from a walkover.
   */
  finishReason?:   "last_player_standing" | "opponent_left";
  /**
   * Kader Kartı V1 — playerId → true map of players who have already drawn
   * their once-per-match fate card.  Absent or missing keys mean the player
   * still has their draw.  Optional for back-compat with pre-fate-card saves;
   * readers must default missing entries to "not used yet".
   */
  fateCardsUsedByPlayerId?: Record<string, boolean>;
  /**
   * Kader Kartı V1 — most recent fate-card draw event.  Persisted so every
   * client renders the same reveal overlay; cleared (or replaced) by the
   * next draw.  UI tracks the last-seen event id locally to avoid replaying
   * a stale reveal on reconnect / late join.
   */
  lastFateCardEvent?: ConquestFateCardEvent;
  /**
   * Elimination — players who have dropped to 0 regions during this match.
   * Ordered by elimination time (first eliminated first); used as a
   * secondary tiebreaker in final standings so later-eliminated outrank
   * earlier-eliminated when points/regions tie. 1v1 matches keep the
   * legacy "domination" early-finish path; 3+ player matches stay alive
   * until the active count (players minus eliminated) drops to 1.
   * Optional / [] for pre-elimination saves.
   */
  eliminatedPlayerIds?: string[];
  /**
   * Per-eliminated-player metadata: when they were eliminated.  Mirrors
   * eliminatedPlayerIds but indexed by player id so the result screen can
   * surface "Round X" badges without re-deriving from history.
   */
  eliminations?: Record<string, { at: number; round: number }>;
  /**
   * Most recent elimination event — persisted so every client renders the
   * same rival-side banner ("@name hanedanlığı düştü!").  May carry
   * multiple ids when the same hamle eliminated more than one player.
   * UI dedupes by event id; cleared on round advance so a stale event
   * doesn't replay to late joiners.
   */
  lastEliminationEvent?: ConquestEliminationEvent;
  /**
   * 2v2 Takımlı mod — Layer 1.  Maç başında lobby'den taşınır ama gameplay
   * kuralları henüz bu alanı kullanmaz (Layer 2'de aynı takım saldırı yasağı,
   * takım skoru vb. eklenecek).  Pre-Layer-1 saves için optional.
   */
  teamMode?: ConquestTeamMode;
  /**
   * 2v2 Takımlı mod — Layer 1.  playerId → 1|2 mapping.  Lobby'den maç
   * başında taşınır; Layer 2'de kullanılacak.
   */
  teamAssignments?: Record<string, ConquestTeamId>;
}

/**
 * Elimination — synced event payload announcing one or more players just
 * dropped to 0 regions.  Used by the rival-side dramatic banner and the
 * event-feed row.  The self-side modal is driven directly from
 * `eliminatedPlayerIds` (no toast needed for the player themselves).
 */
export interface ConquestEliminationEvent {
  id:           string;
  playerIds:    string[];
  playerNames:  string[];
  at:           number;
  round:        number;
}

/**
 * Kader Kartı V1 — synced fate-card draw event.  Carries everything the
 * reveal overlay and action-log surfaces need, so the renderer never has to
 * cross-reference a card catalog.  Future revisions may extend `cardType`
 * with neutral / mixed variants.
 */
export interface ConquestFateCardEvent {
  id:          string;
  playerId:    string;
  playerName:  string;
  cardId:      string;
  cardName:    string;
  cardType:    "good" | "bad";
  description: string;
  createdAt:   number;
  round?:      number;
}

/**
 * 👁️ İstihbarat Ağı — single intel report.  Two flavours share the channel:
 *
 *   - "hidden_claim" — a player just claimed a hidden bonus by capturing
 *     the carrying region.  `hiddenBonusType` carries the real bonus type
 *     so the intel owner learns WHAT the opponent picked up (regular
 *     opponents continue to see only the generic claim toast).
 *
 *   - "gizli_op" — a player just consumed a Gizli Operasyon hakkı
 *     (own-region shield placement OR neutral-region gizli fetih).
 *     `targetRegionId` carries the chosen region so the intel owner learns
 *     WHERE the secret move landed.
 *
 * Recipient is NEVER baked into the payload — the renderer looks up the
 * current owner of the istihbarat_agi region at render time, so ownership
 * changes mid-round are honoured (new owner sees future reports, prior
 * owner sees nothing more).
 */
export interface ConquestIntelReport {
  id:                 string;
  kind:               "hidden_claim" | "gizli_op";
  actorPlayerId:      string;
  actorPlayerName:    string;
  at:                 number;
  /** hidden_claim only: the real type of the claimed hidden bonus. */
  hiddenBonusType?:   ConquestHiddenBonusType;
  /** gizli_op only: the region the secret op was placed on. */
  targetRegionId?:    ConquestRegionId;
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
