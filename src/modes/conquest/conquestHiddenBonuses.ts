/**
 * Conquest (Kuşatma) — gizli (hidden) bonus infrastructure.
 *
 * Hidden bonuses are a SEPARATE channel from the open bonus rotation
 * (`roundBonuses` / `bonusPool.ts` / `regionBonuses.ts`).  Key contract:
 *
 *   - They may not spawn at all (per-match probability gate).
 *   - They never render any icon, glow, badge, or tooltip on the map; the
 *     placement state is invisible until the region is first captured.
 *   - They are claimed one-shot on the FIRST ownership change of the region.
 *     Subsequent owners receive nothing.
 *   - The actual gameplay effects of each hidden bonus type are intentionally
 *     NOT implemented in this revision — the scope here is spawn, claim,
 *     inventory, and viewer-aware toast plumbing only.
 *
 * Pure module — no React, no Supabase.  Same inputs always produce the same
 * placements so host and guest agree on the snapshot stored in the gameplay
 * state blob.
 */

import { CAPITAL_REGION_IDS } from "./conquestCapital";
import type {
  ConquestActiveHiddenEffects,
  ConquestHiddenBonusPlacement,
  ConquestHiddenBonusToast,
  ConquestHiddenBonusType,
  ConquestIntelReport,
  ConquestMapConfig,
  ConquestPendingAmbush,
  ConquestPendingCurse,
  ConquestPlayerHiddenBonus,
  ConquestRegionId,
  ConquestRegionState,
  ConquestRoundBonusAssignment,
} from "./types";

/** All hidden bonus types eligible for placement.  Order is documentation
 *  only — the picker shuffles before drawing. */
export const HIDDEN_BONUS_TYPES: readonly ConquestHiddenBonusType[] = [
  "lanet_muhru",
  "pusu",
  "suikast",
] as const;

/** Per-match probability that a hidden bonus is placed at all. */
export const HIDDEN_BONUS_FIRST_CHANCE  = 0.40;
/** Additional probability of a SECOND hidden bonus when the match has 4
 *  players (rolled independently from the first slot). */
export const HIDDEN_BONUS_SECOND_CHANCE = 0.15;
/** Player count threshold above which the second hidden bonus may roll. */
export const HIDDEN_BONUS_SECOND_MIN_PLAYERS = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic helpers — local copies so this module stays decoupled.
// ─────────────────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function () {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive a hidden-bonus stream seed from the raw match seed.  A constant
 *  distinct from the bonusPool / round-bonus seeds keeps the parallel streams
 *  independent, so hidden bonus placement decisions never shadow open bonus
 *  picks made from the same match seed. */
function seedFromMatchSeed(matchSeed: number): number {
  const a = (matchSeed >>> 0);
  const b = (0xc2b2ae35 >>> 0); // distinct constant; not used by other streams
  return (a ^ b ^ ((a << 11) | (a >>> 21))) >>> 0;
}

function shuffledSeeded<T>(arr: readonly T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j   = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Placement (spawn)
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildHiddenBonusPlacementsInput {
  mapConfig:    ConquestMapConfig;
  regionStates: ConquestRegionState[];
  /** Open-bonus assignment for this match.  Regions present as keys are
   *  excluded from hidden bonus candidate selection — a region NEVER carries
   *  both an open and a hidden bonus simultaneously. */
  roundBonuses: ConquestRoundBonusAssignment | undefined;
  /** Total player count in the match.  Determines whether the second-slot
   *  roll is even eligible (≥ HIDDEN_BONUS_SECOND_MIN_PLAYERS). */
  playerCount:  number;
  /** Match-level seed.  Identical seeds always yield identical placements. */
  matchSeed:    number;
}

/**
 * Pick the hidden bonus placements for a brand-new match.
 *
 * Algorithm:
 *
 *   1. Build the candidate pool from regions that are:
 *        - NOT carrying an open bonus this match (`roundBonuses`)
 *        - NOT a capital region (`CAPITAL_REGION_IDS`)
 *        - NOT owned by any player at match start (i.e. tarafsız regions)
 *
 *      A region owned by a player at start counts as one of "Oyuncuların
 *      başlangıçta sahip olduğu bölgeler" AND covers the "Özel başlangıç
 *      bölgeleri" rule from the spec — the snake-draft allocator is the only
 *      special-start mechanism today, so excluding non-neutral starts handles
 *      both classes in one filter.
 *
 *   2. Roll for the first hidden bonus (40% gate).  If it lands, pick a random
 *      region from the pool and a random type.
 *
 *   3. If the match has 4+ players, INDEPENDENTLY roll for the second hidden
 *      bonus (15% gate).  Pick a region NOT already chosen and a (possibly
 *      different) random type.  If no candidate remains, silently skip — no
 *      error.
 *
 *   4. Return the assembled placement map.  An empty map is the legitimate
 *      "no hidden bonuses this match" outcome and must be handled by callers
 *      as such (NOT as a failure).
 *
 * Pure: no side effects; same inputs yield the same placements every time.
 */
export function buildHiddenBonusPlacements(
  input: BuildHiddenBonusPlacementsInput,
): Record<ConquestRegionId, ConquestHiddenBonusPlacement> {
  const { mapConfig, regionStates, roundBonuses, playerCount, matchSeed } = input;
  const regions = mapConfig.regions;
  if (regions.length === 0) return {};

  const rng = mulberry32(seedFromMatchSeed(matchSeed));

  // Build candidate pool.  Order is mapConfig.regions order so the seeded
  // shuffle below is the only source of randomness in selection.
  const ownerById: Map<ConquestRegionId, string | null> = new Map();
  for (const rs of regionStates) ownerById.set(rs.regionId, rs.ownerPlayerId);

  const openBonusKeys = new Set(
    roundBonuses ? Object.keys(roundBonuses) : [],
  );

  const candidates: ConquestRegionId[] = [];
  for (const r of regions) {
    if (openBonusKeys.has(r.id))      continue;
    if (CAPITAL_REGION_IDS.has(r.id)) continue;
    if ((ownerById.get(r.id) ?? null) !== null) continue;
    candidates.push(r.id);
  }

  const placements: Record<ConquestRegionId, ConquestHiddenBonusPlacement> = {};
  if (candidates.length === 0) return placements;

  // Pre-shuffle the candidate pool and the type pool ONCE per match so the
  // two slot rolls draw from a consistent seeded order without re-using the
  // same indices.  This also makes the second slot guaranteed-different from
  // the first (we just take the next region in the shuffled list).
  const shuffledCandidates = shuffledSeeded(candidates, rng);
  const shuffledTypes      = shuffledSeeded(HIDDEN_BONUS_TYPES, rng);

  let typeIndex   = 0;
  let regionIndex = 0;

  // ── First slot ─────────────────────────────────────────────────────────
  if (rng() < HIDDEN_BONUS_FIRST_CHANCE) {
    const regionId = shuffledCandidates[regionIndex++];
    const type     = shuffledTypes[typeIndex++ % shuffledTypes.length];
    placements[regionId] = { type };
  }

  // ── Second slot (4+ players, independent roll) ─────────────────────────
  if (
    playerCount >= HIDDEN_BONUS_SECOND_MIN_PLAYERS
    && rng() < HIDDEN_BONUS_SECOND_CHANCE
    && regionIndex < shuffledCandidates.length
  ) {
    const regionId = shuffledCandidates[regionIndex++];
    const type     = shuffledTypes[typeIndex++ % shuffledTypes.length];
    placements[regionId] = { type };
  }

  return placements;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim — first-capture handover from placement → player inventory
// ─────────────────────────────────────────────────────────────────────────────

export interface HiddenBonusClaimDiff {
  /** Next placements map with the claimed slot stamped.  Always returned
   *  alongside `playerHiddenBonuses` / `lastHiddenBonusToast`. */
  hiddenBonusPlacements: Record<ConquestRegionId, ConquestHiddenBonusPlacement>;
  /** Next per-player inventory with the new entry appended. */
  playerHiddenBonuses:   Record<string, ConquestPlayerHiddenBonus[]>;
  /** Toast describing the claim — viewer-aware copy is decided at render
   *  time, NOT here, so the synced payload is identical on every client. */
  lastHiddenBonusToast:  ConquestHiddenBonusToast;
}

/**
 * Attempt to claim the hidden bonus on `regionId` for `claimerId`.  Returns
 * the diff to merge into ConquestGameState when a claim actually happens, or
 * null when no claim should occur:
 *
 *   - The region carries no hidden bonus placement.
 *   - The placement is already `claimedByPlayerId` (subsequent owners get
 *     nothing — this enforces the one-shot rule).
 *
 * Pure: never mutates the inputs.  Caller is responsible for splicing the
 * returned slices into the state snapshot that ultimately gets persisted.
 */
export function tryClaimHiddenBonus(
  hiddenPlacementsIn:    Record<ConquestRegionId, ConquestHiddenBonusPlacement> | undefined,
  playerHiddenBonusesIn: Record<string, ConquestPlayerHiddenBonus[]> | undefined,
  regionId:              ConquestRegionId,
  claimerId:             string,
  claimerName:           string,
  roundNumber:           number,
  now:                   number,
): HiddenBonusClaimDiff | null {
  if (!hiddenPlacementsIn) return null;
  const placement = hiddenPlacementsIn[regionId];
  if (!placement) return null;
  if (placement.claimedByPlayerId) return null;

  const nextPlacement: ConquestHiddenBonusPlacement = {
    ...placement,
    claimedByPlayerId: claimerId,
    claimedAtRound:    roundNumber,
  };
  const hiddenBonusPlacements: Record<ConquestRegionId, ConquestHiddenBonusPlacement> = {
    ...hiddenPlacementsIn,
    [regionId]: nextPlacement,
  };

  const currentInventory = playerHiddenBonusesIn ?? {};
  const claimerInventory = currentInventory[claimerId] ?? [];
  const entry: ConquestPlayerHiddenBonus = {
    id:               `hb-${placement.type}-${regionId}-${now}-${claimerId}`,
    type:             placement.type,
    used:             false,
    claimedRegionId:  regionId,
    claimedRound:     roundNumber,
  };
  const playerHiddenBonuses: Record<string, ConquestPlayerHiddenBonus[]> = {
    ...currentInventory,
    [claimerId]: [...claimerInventory, entry],
  };

  const lastHiddenBonusToast: ConquestHiddenBonusToast = {
    id:           `hb_claim-${placement.type}-${regionId}-${now}-${claimerId}`,
    type:         placement.type,
    claimerId,
    claimerName,
    regionId,
    at:           now,
  };

  return { hiddenBonusPlacements, playerHiddenBonuses, lastHiddenBonusToast };
}

// ─────────────────────────────────────────────────────────────────────────────
// Consume — Suikast 🗡️
// ─────────────────────────────────────────────────────────────────────────────

/** Raw point damage of a Suikast hit before the floor-at-0 clamp. */
export const SUIKAST_DAMAGE = 2;

export interface SuikastUseDiff {
  /** Next per-player inventory with the consumed entry's `used` flipped to true. */
  playerHiddenBonuses: Record<string, ConquestPlayerHiddenBonus[]>;
  /** Effective points deducted from the target (0..SUIKAST_DAMAGE).  Capped
   *  by the target's current visible total so the score never displays a
   *  negative value. */
  pointsLost:          number;
  /** Toast describing the consume — viewer-aware copy is decided at render
   *  time, NOT here, so the synced payload is identical on every client. */
  lastHiddenBonusToast: ConquestHiddenBonusToast;
}

export interface UseSuikastInput {
  playerHiddenBonusesIn: Record<string, ConquestPlayerHiddenBonus[]> | undefined;
  /** Bonus entry id (matches ConquestPlayerHiddenBonus.id) — identifies WHICH
   *  Suikast charge in the caster's inventory is being consumed.  Required so
   *  two charges held by the same player are independently spendable and so
   *  realtime echoes are idempotent against the exact item id. */
  bonusEntryId:          string;
  casterId:              string;
  casterName:            string;
  targetId:              string;
  targetName:            string;
  /** Target's current TOTAL visible score (region points + bonus points).
   *  Used solely to clamp the deduction so the displayed score never drops
   *  below 0; pure functions in this module never look up scoring tables. */
  targetCurrentScore:    number;
  now:                   number;
}

/**
 * Validate and compute the diff for using a Suikast charge.  Returns null on:
 *   - missing inventory entry for `bonusEntryId` in the caster's slot
 *   - the entry is already `used: true`
 *   - the entry is not a Suikast charge
 *   - the caster is targeting themselves
 *
 * Pure: never mutates the inputs.  Caller (`applySuikastHiddenBonus` in
 * gameplay) is responsible for splicing the diff into ConquestGameState and
 * applying the score deduction onto the target's `bonusPoints`.
 */
export function useSuikastHiddenBonus(
  input: UseSuikastInput,
): SuikastUseDiff | null {
  const {
    playerHiddenBonusesIn,
    bonusEntryId,
    casterId,
    casterName,
    targetId,
    targetName,
    targetCurrentScore,
    now,
  } = input;

  if (casterId === targetId) return null;

  const inventory  = playerHiddenBonusesIn ?? {};
  const casterBag  = inventory[casterId] ?? [];
  const entryIndex = casterBag.findIndex(e => e.id === bonusEntryId);
  if (entryIndex < 0) return null;

  const entry = casterBag[entryIndex];
  if (entry.used)              return null;
  if (entry.type !== "suikast") return null;

  // Clamp the deduction so the target's visible total never displays below 0.
  // A target with 0 points takes a 0-point Suikast — the inventory entry is
  // still consumed (spec: "Suikast tek kullanımlıktır"), and the toast still
  // fires so opponents know it happened.
  const safeCurrentScore = Math.max(0, targetCurrentScore);
  const pointsLost       = Math.min(SUIKAST_DAMAGE, safeCurrentScore);

  const nextCasterBag = casterBag.slice();
  nextCasterBag[entryIndex] = { ...entry, used: true };
  const playerHiddenBonuses: Record<string, ConquestPlayerHiddenBonus[]> = {
    ...inventory,
    [casterId]: nextCasterBag,
  };

  const lastHiddenBonusToast: ConquestHiddenBonusToast = {
    id:               `hb_use-suikast-${bonusEntryId}-${now}`,
    type:             "suikast",
    claimerId:        casterId,
    claimerName:      casterName,
    at:               now,
    event:            "use",
    targetPlayerId:   targetId,
    targetPlayerName: targetName,
    pointsLost,
  };

  return { playerHiddenBonuses, pointsLost, lastHiddenBonusToast };
}

// ─────────────────────────────────────────────────────────────────────────────
// Consume — Lanet Mührü 🧿
// ─────────────────────────────────────────────────────────────────────────────
//
// Two-step lifecycle (NOT symmetric with Suikast):
//
//   1. `useLanetMuhruHiddenBonus` — caster spends a Lanet Mührü charge on a
//      chosen opponent.  Inventory entry flips to `used: true` immediately;
//      a pending curse entry is inserted on `activeHiddenEffects.curses`
//      keyed by the target's id.  No score changes, no phase changes — the
//      curse is purely waiting.
//
//   2. `consumePendingCurseOnTrigger` — called at the moment a cursed player
//      would otherwise be promoted to action holder (challenge → action via
//      `finalizeReveal`).  Removes the curse entry and builds the trigger
//      toast.  A wrong answer never reaches this path because no promotion
//      happens; the curse stays pending.
//
// Both halves are pure: callers (`applyLanetMuhruHiddenBonus` /
// `finalizeReveal` in gameplay) splice the returned slices into the synced
// ConquestGameState.

export interface LanetMuhruUseDiff {
  /** Next per-player inventory with the consumed entry's `used` flipped. */
  playerHiddenBonuses:  Record<string, ConquestPlayerHiddenBonus[]>;
  /** Next activeHiddenEffects with the new pending curse stamped on
   *  `curses[targetId]`. */
  activeHiddenEffects:  ConquestActiveHiddenEffects;
  /** Use-event toast — viewer-aware copy is decided at render time. */
  lastHiddenBonusToast: ConquestHiddenBonusToast;
}

export interface UseLanetMuhruInput {
  playerHiddenBonusesIn:  Record<string, ConquestPlayerHiddenBonus[]> | undefined;
  activeHiddenEffectsIn:  ConquestActiveHiddenEffects | undefined;
  /** Bonus entry id (matches ConquestPlayerHiddenBonus.id) — identifies WHICH
   *  Lanet Mührü charge in the caster's inventory is being consumed. */
  bonusEntryId:           string;
  casterId:               string;
  casterName:             string;
  targetId:               string;
  targetName:             string;
  /** 1-based round number the curse is being cast in.  Stored on the curse
   *  entry purely as a debugging / replay hint. */
  currentRound:           number;
  now:                    number;
}

/**
 * Validate and compute the diff for applying a Lanet Mührü to `targetId`.
 * Returns null on:
 *   - missing inventory entry for `bonusEntryId` in the caster's slot
 *   - the entry is already `used: true`
 *   - the entry is not a Lanet Mührü charge
 *   - the caster is targeting themselves
 *   - the target already has an active curse (no stacking)
 *
 * Pure: never mutates the inputs.
 */
export function useLanetMuhruHiddenBonus(
  input: UseLanetMuhruInput,
): LanetMuhruUseDiff | null {
  const {
    playerHiddenBonusesIn,
    activeHiddenEffectsIn,
    bonusEntryId,
    casterId,
    casterName,
    targetId,
    targetName,
    currentRound,
    now,
  } = input;

  if (casterId === targetId) return null;

  const inventory  = playerHiddenBonusesIn ?? {};
  const casterBag  = inventory[casterId] ?? [];
  const entryIndex = casterBag.findIndex(e => e.id === bonusEntryId);
  if (entryIndex < 0) return null;

  const entry = casterBag[entryIndex];
  if (entry.used)                    return null;
  if (entry.type !== "lanet_muhru")  return null;

  const existingCurses = activeHiddenEffectsIn?.curses ?? {};
  // No stacking: a second curse on an already-cursed target is rejected.
  // The caster's charge stays unspent so they can retarget.
  if (existingCurses[targetId]) return null;

  const nextCasterBag = casterBag.slice();
  nextCasterBag[entryIndex] = { ...entry, used: true };
  const playerHiddenBonuses: Record<string, ConquestPlayerHiddenBonus[]> = {
    ...inventory,
    [casterId]: nextCasterBag,
  };

  const newCurse: ConquestPendingCurse = {
    casterPlayerId: casterId,
    bonusEntryId,
    createdRound:   currentRound,
  };
  const activeHiddenEffects: ConquestActiveHiddenEffects = {
    ...(activeHiddenEffectsIn ?? {}),
    curses: {
      ...existingCurses,
      [targetId]: newCurse,
    },
  };

  const lastHiddenBonusToast: ConquestHiddenBonusToast = {
    id:               `hb_use-lanet_muhru-${bonusEntryId}-${now}`,
    type:             "lanet_muhru",
    claimerId:        casterId,
    claimerName:      casterName,
    at:               now,
    event:            "use",
    targetPlayerId:   targetId,
    targetPlayerName: targetName,
  };

  return { playerHiddenBonuses, activeHiddenEffects, lastHiddenBonusToast };
}

export interface CurseTriggerDiff {
  /** Next activeHiddenEffects with the consumed curse stripped. */
  activeHiddenEffects:  ConquestActiveHiddenEffects;
  /** Trigger-event toast — viewer-aware copy is decided at render time. */
  lastHiddenBonusToast: ConquestHiddenBonusToast;
}

/**
 * Read-only: is `playerId` currently cursed?  Cheap branch the
 * `finalizeReveal` transition uses to decide whether to cancel the hamle.
 */
export function hasPendingCurse(
  effects: ConquestActiveHiddenEffects | undefined,
  playerId: string,
): boolean {
  return !!effects?.curses?.[playerId];
}

/**
 * Strip the pending curse on `targetId` and build the trigger toast.  Returns
 * null when no curse is pending on the target (called speculatively from the
 * reveal → action transition).
 *
 * Pure: never mutates the inputs.  Caller (gameplay) is responsible for
 * routing the round into `round_result` with a curse-flavoured message
 * instead of promoting the player to action holder.
 */
export function consumePendingCurseOnTrigger(
  activeHiddenEffectsIn: ConquestActiveHiddenEffects | undefined,
  targetId:              string,
  targetName:            string,
  now:                   number,
): CurseTriggerDiff | null {
  const existing = activeHiddenEffectsIn?.curses ?? {};
  const curse    = existing[targetId];
  if (!curse) return null;

  const nextCurses: Record<string, ConquestPendingCurse> = { ...existing };
  delete nextCurses[targetId];

  const activeHiddenEffects: ConquestActiveHiddenEffects = {
    ...(activeHiddenEffectsIn ?? {}),
    curses: nextCurses,
  };

  const lastHiddenBonusToast: ConquestHiddenBonusToast = {
    id:               `hb_trigger-lanet_muhru-${curse.bonusEntryId}-${now}`,
    type:             "lanet_muhru",
    claimerId:        curse.casterPlayerId,
    claimerName:      "",
    at:               now,
    event:            "trigger",
    targetPlayerId:   targetId,
    targetPlayerName: targetName,
  };

  return { activeHiddenEffects, lastHiddenBonusToast };
}

// ─────────────────────────────────────────────────────────────────────────────
// Consume — Pusu 🕳️
// ─────────────────────────────────────────────────────────────────────────────
//
// Two-step lifecycle (mirrors Lanet Mührü's place → trigger pattern):
//
//   1. `usePusuHiddenBonus` — owner spends a Pusu charge on a region they
//      own OR a neutral region.  Inventory entry flips to `used: true`;
//      an ambush entry is inserted on `activeHiddenEffects.ambushes` keyed
//      by the chosen regionId.  No phase change.
//
//   2. `tryConsumePendingAmbush` — called by `applyActionToGame` BEFORE the
//      attack/capture is resolved.  When the attacker is NOT the ambush
//      owner and the target carries an active ambush, the ambush fires:
//      the action is cancelled, the ambush entry is removed, and a viewer-
//      aware "trigger" toast is emitted.
//
// Both halves are pure: callers splice the returned slices into ConquestGameState.
// Eligibility (own/neutral, no enemy/capital) is enforced here so the UI's
// optimistic placement-candidate set and the synced commit agree.

export interface PusuUseDiff {
  /** Next per-player inventory with the consumed entry's `used` flipped. */
  playerHiddenBonuses:  Record<string, ConquestPlayerHiddenBonus[]>;
  /** Next activeHiddenEffects with the new pending ambush stamped on
   *  `ambushes[regionId]`. */
  activeHiddenEffects:  ConquestActiveHiddenEffects;
  /** Use-event toast — viewer-aware copy is decided at render time.  Only
   *  the owner gets a real placement message; opponents must NEVER see this
   *  toast surface at all (UI filters by `event === "use" && type === "pusu"`
   *  and routes the toast strictly to the caster). */
  lastHiddenBonusToast: ConquestHiddenBonusToast;
}

export interface UsePusuInput {
  playerHiddenBonusesIn:  Record<string, ConquestPlayerHiddenBonus[]> | undefined;
  activeHiddenEffectsIn:  ConquestActiveHiddenEffects | undefined;
  /** Live region states — required so the helper can verify the chosen
   *  region is owner-self or neutral (NEVER enemy-owned). */
  regionStates:           ConquestRegionState[];
  /** Bonus entry id (matches ConquestPlayerHiddenBonus.id). */
  bonusEntryId:           string;
  ownerId:                string;
  ownerName:              string;
  regionId:               ConquestRegionId;
  /** 1-based round number the ambush is being placed in. */
  currentRound:           number;
  now:                    number;
}

/**
 * Validate and compute the diff for placing a Pusu on `regionId`.  Returns
 * null on:
 *   - missing inventory entry for `bonusEntryId` in the owner's slot
 *   - the entry is already `used: true`
 *   - the entry is not a Pusu charge
 *   - the chosen region is not on the map at all
 *   - the chosen region is owned by an opponent (enemy regions ineligible)
 *   - the chosen region is a capital (capitals never carry hidden traps)
 *   - the region already has an active ambush (no stacking on one region)
 *
 * Eligible regions: owner-self OR truly neutral.  The owner's own bonus-
 * carrying regions are still eligible — the spec's V1 decision is "açık
 * bonuslu bölgeye pusu kurulabilir, eğer bölge benimse veya tarafsızsa".
 *
 * Pure: never mutates the inputs.
 */
export function usePusuHiddenBonus(
  input: UsePusuInput,
): PusuUseDiff | null {
  const {
    playerHiddenBonusesIn,
    activeHiddenEffectsIn,
    regionStates,
    bonusEntryId,
    ownerId,
    ownerName,
    regionId,
    currentRound,
    now,
  } = input;

  const inventory  = playerHiddenBonusesIn ?? {};
  const ownerBag   = inventory[ownerId] ?? [];
  const entryIndex = ownerBag.findIndex(e => e.id === bonusEntryId);
  if (entryIndex < 0) return null;

  const entry = ownerBag[entryIndex];
  if (entry.used)            return null;
  if (entry.type !== "pusu") return null;

  // Region eligibility — owner-self or neutral; never enemy, never capital.
  const target = regionStates.find(rs => rs.regionId === regionId);
  if (!target) return null;
  if (CAPITAL_REGION_IDS.has(regionId)) return null;
  if (target.ownerPlayerId !== null && target.ownerPlayerId !== ownerId) {
    return null;
  }

  const existingAmbushes = activeHiddenEffectsIn?.ambushes ?? {};
  // No stacking on the same region — second Pusu rejected (owner's charge
  // stays unspent so they can pick a different region).
  if (existingAmbushes[regionId]) return null;

  const nextOwnerBag = ownerBag.slice();
  nextOwnerBag[entryIndex] = { ...entry, used: true };
  const playerHiddenBonuses: Record<string, ConquestPlayerHiddenBonus[]> = {
    ...inventory,
    [ownerId]: nextOwnerBag,
  };

  const newAmbush: ConquestPendingAmbush = {
    ownerPlayerId: ownerId,
    bonusEntryId,
    createdRound:  currentRound,
  };
  const activeHiddenEffects: ConquestActiveHiddenEffects = {
    ...(activeHiddenEffectsIn ?? {}),
    ambushes: {
      ...existingAmbushes,
      [regionId]: newAmbush,
    },
  };

  // Owner-only toast — UI must NOT render this for any other viewer.
  // (See getHiddenBonusToastCopyForViewer's pusu/use branch: opponents get
  //  a null-equivalent stub copy, and the renderer is expected to suppress
  //  it for non-owner viewers.)
  const lastHiddenBonusToast: ConquestHiddenBonusToast = {
    id:          `hb_use-pusu-${bonusEntryId}-${now}`,
    type:        "pusu",
    claimerId:   ownerId,
    claimerName: ownerName,
    regionId,
    at:          now,
    event:       "use",
  };

  return { playerHiddenBonuses, activeHiddenEffects, lastHiddenBonusToast };
}

export interface PusuTriggerDiff {
  /** Next activeHiddenEffects with the consumed ambush stripped. */
  activeHiddenEffects:  ConquestActiveHiddenEffects;
  /** Trigger-event toast — viewer-aware copy is decided at render time. */
  lastHiddenBonusToast: ConquestHiddenBonusToast;
  /** Resolved ambush owner id (for the caller to source viewer-aware copy
   *  / route success notifications). */
  ownerPlayerId:        string;
}

/**
 * Read-only: does `regionId` carry an active ambush?  Cheap branch the
 * `applyActionToGame` transition uses to decide whether to cancel the
 * attack/capture before any state mutates.
 */
export function hasPendingAmbush(
  effects:  ConquestActiveHiddenEffects | undefined,
  regionId: ConquestRegionId,
): boolean {
  return !!effects?.ambushes?.[regionId];
}

/**
 * Try to consume a pending ambush on `regionId` because `attackerId` is
 * targeting it with an attack/capture.  Returns null when no ambush should
 * fire:
 *   - no ambush is armed on this region
 *   - the attacker IS the ambush owner (self-attempts never trigger; in
 *     practice canCaptureNeutral/canAttackRegion already reject these, but
 *     a defensive guard here means the helper is safe to call in any path)
 *
 * Pure: never mutates the inputs.  Caller is responsible for cancelling
 * the action — `applyConquestAction` / duel / direct flip must NOT run on
 * the ambushed region when this returns non-null.
 */
export function tryConsumePendingAmbush(
  activeHiddenEffectsIn: ConquestActiveHiddenEffects | undefined,
  regionId:              ConquestRegionId,
  attackerId:            string,
  attackerName:          string,
  now:                   number,
): PusuTriggerDiff | null {
  const existing = activeHiddenEffectsIn?.ambushes ?? {};
  const ambush   = existing[regionId];
  if (!ambush) return null;
  if (ambush.ownerPlayerId === attackerId) return null;

  const nextAmbushes: Record<string, ConquestPendingAmbush> = { ...existing };
  delete nextAmbushes[regionId];

  const activeHiddenEffects: ConquestActiveHiddenEffects = {
    ...(activeHiddenEffectsIn ?? {}),
    ambushes: nextAmbushes,
  };

  const lastHiddenBonusToast: ConquestHiddenBonusToast = {
    id:               `hb_trigger-pusu-${ambush.bonusEntryId}-${now}`,
    type:             "pusu",
    claimerId:        ambush.ownerPlayerId,
    claimerName:      "",
    regionId,
    at:               now,
    event:            "trigger",
    targetPlayerId:   attackerId,
    targetPlayerName: attackerName,
  };

  return {
    activeHiddenEffects,
    lastHiddenBonusToast,
    ownerPlayerId: ambush.ownerPlayerId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Toast copy — viewer-aware
// ─────────────────────────────────────────────────────────────────────────────

/** Display label per hidden bonus type — shown ONLY to the claimer.
 *  Opponents always see the generic "rakip gizli bonus keşfetti" copy. */
const HIDDEN_BONUS_LABEL: Record<ConquestHiddenBonusType, string> = {
  lanet_muhru: "Lanet Mührü",
  pusu:        "Pusu",
  suikast:     "Suikast",
};

export function getHiddenBonusLabel(type: ConquestHiddenBonusType): string {
  return HIDDEN_BONUS_LABEL[type];
}

export interface HiddenBonusToastCopy {
  icon:   string;
  title:  string;
  detail: string;
}

/**
 * Build the toast text for `viewerId`.
 *
 * - "claim" events: claimer-side copy names the real bonus; opponent-side
 *   copy intentionally hides the bonus type, the region, and the effect.
 * - "use"   events: three audiences — caster (success), target (got hit),
 *   observers (announcement).  All three name the bonus that was used,
 *   since spec calls for transparent reveal at consume time.
 */
export function getHiddenBonusToastCopyForViewer(
  toast:    ConquestHiddenBonusToast,
  viewerId: string | null,
): HiddenBonusToastCopy {
  const event = toast.event ?? "claim";

  if (event === "use" && toast.type === "suikast") {
    const isCaster = viewerId !== null && viewerId === toast.claimerId;
    const isTarget = viewerId !== null && viewerId === toast.targetPlayerId;
    const points   = toast.pointsLost ?? 0;
    const targetName = toast.targetPlayerName ?? "Rakip";

    if (isCaster) {
      return {
        icon:   "🗡️",
        title:  "🗡️ Suikast Başarılı!",
        detail: `${targetName} hedef alındı ve ${points} puan kaybetti.`,
      };
    }
    if (isTarget) {
      return {
        icon:   "🗡️",
        title:  "🗡️ Suikast!",
        detail: `Gizli bir saldırıya uğradın ve ${points} puan kaybettin.`,
      };
    }
    return {
      icon:   "🗡️",
      title:  "🗡️ Suikast Gerçekleşti!",
      detail: `${targetName} gizli bir saldırıya uğradı ve ${points} puan kaybetti.`,
    };
  }

  if (event === "use" && toast.type === "lanet_muhru") {
    const isCaster = viewerId !== null && viewerId === toast.claimerId;
    const isTarget = viewerId !== null && viewerId === toast.targetPlayerId;
    const targetName = toast.targetPlayerName ?? "Rakip";

    if (isCaster) {
      return {
        icon:   "🧿",
        title:  "🧿 Lanet Mührü Uygulandı!",
        detail: `${targetName} lanetlendi. Bir sonraki doğru cevabında hamle hakkı mühürlenecek.`,
      };
    }
    if (isTarget) {
      return {
        icon:   "🧿",
        title:  "🧿 Lanetlendin!",
        detail: "Üzerine Lanet Mührü uygulandı. Bir sonraki doğru cevabında hamle hakkın mühürlenecek.",
      };
    }
    return {
      icon:   "🧿",
      title:  "🧿 Lanet Mührü Kullanıldı!",
      detail: `${targetName} lanetlendi. Bir sonraki doğru cevabında hamle hakkı mühürlenecek.`,
    };
  }

  if (event === "use" && toast.type === "pusu") {
    // Owner-only placement copy.  Opponents must NEVER see this toast — the
    // renderer is expected to suppress it when viewerId !== claimerId; the
    // fallback copy below is a defensive last-resort that still says nothing
    // about which region was ambushed.
    const isOwner = viewerId !== null && viewerId === toast.claimerId;
    if (isOwner) {
      return {
        icon:   "🕳️",
        title:  "🕳️ Pusu Kuruldu!",
        detail: "Seçtiğin bölgeye gizli pusu kuruldu. Rakip bu bölgeyi hedeflerse saldırısı gerçekleşmeyecek.",
      };
    }
    // Defensive stub — UI must filter this out for non-owners before display.
    return {
      icon:   "🕳️",
      title:  "",
      detail: "",
    };
  }

  if (event === "trigger" && toast.type === "pusu") {
    const isAttacker = viewerId !== null && viewerId === toast.targetPlayerId;
    const isOwner    = viewerId !== null && viewerId === toast.claimerId;

    if (isAttacker) {
      return {
        icon:   "🕳️",
        title:  "🕳️ Gizli Bonus Ortaya Çıktı!",
        detail: "Rakip, saldırmaya gittiğin bölgenin istihbaratını önceden aldı ve yola pusu kurdu. Saldırın gerçekleşemedi!",
      };
    }
    if (isOwner) {
      return {
        icon:   "🕳️",
        title:  "🕳️ Pusu Başarılı!",
        detail: "Rakibin hedeflediğin bölgeye saldırmaya çalıştı ama kurduğun pusu saldırıyı durdurdu.",
      };
    }
    return {
      icon:   "🕳️",
      title:  "🕳️ Pusu Ortaya Çıktı!",
      detail: "Bir saldırı, gizli pusu nedeniyle gerçekleşemedi.",
    };
  }

  if (event === "trigger" && toast.type === "lanet_muhru") {
    const isTarget = viewerId !== null && viewerId === toast.targetPlayerId;
    const targetName = toast.targetPlayerName ?? "Rakip";

    if (isTarget) {
      return {
        icon:   "🧿",
        title:  "🧿 Hamlen Mühürlendi!",
        detail: "Doğru bildin ancak Lanet Mührü hamle hakkını engelledi.",
      };
    }
    return {
      icon:   "🧿",
      title:  "🧿 Lanet Mührü Devreye Girdi!",
      detail: `${targetName} doğru bildi ancak Lanet Mührü nedeniyle hamle yapamadı.`,
    };
  }

  // Default: claim event (legacy + lanet_muhru/pusu claim flow).
  const isClaimer = viewerId !== null && viewerId === toast.claimerId;
  if (isClaimer) {
    const label = getHiddenBonusLabel(toast.type);
    return {
      icon:   "🎁",
      title:  "🎁 Gizli Bonus Bulundu!",
      detail: `Bu bölgede gizli bir güç vardı: ${label}. Bu bonus tek kullanımlık olarak envanterine eklendi.`,
    };
  }
  return {
    icon:   "❓",
    title:  "❓ Rakip Gizli Bonus Keşfetti!",
    detail: "Rakibin haritada gizli bir bonus buldu. Hangi bonus olduğunu, özelliği kullandığında öğreneceksin.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// İstihbarat Ağı 👁️ — intel report builders + copy
// ─────────────────────────────────────────────────────────────────────────────
//
// Intel reports are a synced channel that EVERY client receives, but only the
// current owner of the istihbarat_agi bonus region is allowed to render.  The
// recipient is NEVER baked into the payload — the renderer looks up the
// region's current owner at render time, so a mid-round handover means future
// reports go to the new owner and prior reports stop showing for the old
// owner (they're cleared on round advance anyway).
//
// The actual ownership lookup helper lives in conquestGameplay.ts as
// `getIntelNetworkOwnerId` so it can stay close to the gameplay state shape.

/** Build an intel report for a hidden bonus claim event. */
export function buildHiddenClaimIntelReport(
  claimerId:    string,
  claimerName:  string,
  hiddenType:   ConquestHiddenBonusType,
  now:          number,
): ConquestIntelReport {
  return {
    id:              `intel-claim-${hiddenType}-${now}-${claimerId}`,
    kind:            "hidden_claim",
    actorPlayerId:   claimerId,
    actorPlayerName: claimerName,
    at:              now,
    hiddenBonusType: hiddenType,
  };
}

/** Build an intel report for a Gizli Operasyon (own-region shield OR
 *  neutral-region gizli fetih) placement event. */
export function buildGizliOpIntelReport(
  actorId:       string,
  actorName:     string,
  targetRegion:  ConquestRegionId,
  now:           number,
): ConquestIntelReport {
  return {
    id:              `intel-gizliop-${targetRegion}-${now}-${actorId}`,
    kind:            "gizli_op",
    actorPlayerId:   actorId,
    actorPlayerName: actorName,
    at:              now,
    targetRegionId:  targetRegion,
  };
}

export interface IntelReportCopy {
  icon:   string;
  title:  string;
  detail: string;
}

/**
 * Build the toast text for an intel report.  Callers (the UI) must already
 * have decided the viewer is the current istihbarat_agi region owner —
 * suppression-by-non-owner happens at the render layer, not here.
 *
 * `regionLabel` is the display label of the gizli_op target region, looked up
 * via the local map config.  Optional: when omitted (gizli_op report without
 * a resolvable label, or a hidden_claim report), the copy drops the phrase.
 */
export function getIntelReportCopy(
  report:       ConquestIntelReport,
  regionLabel?: string | null,
): IntelReportCopy {
  if (report.kind === "hidden_claim") {
    const label = report.hiddenBonusType
      ? getHiddenBonusLabel(report.hiddenBonusType)
      : "bilinmeyen bonus";
    return {
      icon:   "👁️",
      title:  "👁️ İstihbarat Raporu",
      detail: `${report.actorPlayerName} gizli bonus keşfetti: ${label}.`,
    };
  }
  // gizli_op
  const where = regionLabel ?? "bilinmeyen bölge";
  return {
    icon:   "👁️",
    title:  "👁️ İstihbarat Raporu",
    detail: `${report.actorPlayerName} Gizli Operasyon kullandı. Hedef bölge: ${where}.`,
  };
}
