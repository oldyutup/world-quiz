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
  ConquestHiddenBonusPlacement,
  ConquestHiddenBonusToast,
  ConquestHiddenBonusType,
  ConquestMapConfig,
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
 * Build the toast text for `viewerId`.  Claimer-side copy names the real
 * bonus; opponent-side copy intentionally hides the bonus type, the region,
 * and the effect.
 */
export function getHiddenBonusToastCopyForViewer(
  toast:    ConquestHiddenBonusToast,
  viewerId: string | null,
): HiddenBonusToastCopy {
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
