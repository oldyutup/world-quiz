/**
 * Conquest (Kuşatma) — match-stable bonus assignment.
 *
 * One assignment per match: 3-4 regions are selected at game creation and
 * stay locked for every round of that match.  Round transitions never
 * rebuild the assignment — host and guest read the same persisted snapshot,
 * so bonuses remain identical for everyone in the room.  Starting a fresh
 * match seeds from a new `matchSeed` (gameState.startedAt) and may produce
 * a different random-balanced set.
 *
 * Selection rules:
 *
 *   - **Seeded** by the match-level `matchSeed` alone.  Round number does
 *     not influence the seed, so the assignment is stable across rounds.
 *   - **Anti-cluster**: a candidate adjacent to an already-picked region
 *     this match is heavily penalised.  The map's `groupName` cluster
 *     (Batı, Doğu, Karadeniz, etc.) is used as a second spread axis —
 *     picks try to span at least 3 distinct groups.
 *   - **Fairness**: candidates owned by a single concentrated player take a
 *     penalty so bonuses don't pile up on one player's tiles.  Neutral and
 *     boundary regions get a small positive — they're meaningful to contest.
 *   - **Capital exclusion**: Ankara is never auto-bonused here.  The capital
 *     reveal cinematic (CAPITAL_REGION_IDS) is a separate FX channel; mixing
 *     it with rotating bonus assignments leaks the capital's identity into
 *     the bonus rotation logic.  Ankara may still be chosen as the *target*
 *     of a Gizli Operasyon placement by a player — that path is independent.
 *
 * Pure data — no React, no Supabase.  Identical inputs (mapConfig, players,
 * regionStates, seed) yield identical assignments so every client computes
 * the same bonus map when reading the same snapshot.
 */

import { BONUS_POOL } from "./bonusPool";
import { CAPITAL_REGION_IDS } from "./conquestCapital";
import { REGION_BONUSES } from "./regionBonuses";
import type {
  ConquestMapConfig,
  ConquestPlayer,
  ConquestRegion,
  ConquestRegionBonusDef,
  ConquestRegionBonusType,
  ConquestRegionId,
  ConquestRegionState,
  ConquestRoundBonusAssignment,
} from "./types";

// Re-export `ConquestRegionBonusDef` so callers don't need to import it from
// `regionBonuses.ts` separately when they already work with this module.
export type { ConquestRegionBonusDef } from "./types";

/** Bonus types eligible for rotation.  Order is the canonical catalog;
 *  per-round randomisation shuffles before assigning.
 *
 *  `eleme_yetkisi` is the first pool-driven bonus to graduate into the
 *  rotation.  The rest of the bonus pool stays `implemented:false` and is
 *  excluded — see bonusPool.ts.  The per-match bonus count is still decided
 *  by `pickBonusCountForRound(regionCount)`, so adding a fifth type doesn't
 *  change how many bonus regions appear; it just widens the draw set. */
const ROTATING_BONUS_TYPES: ConquestRegionBonusType[] = [
  "istanbul_defense",
  "ankara_hidden_shield",
  "cukurova_score",
  "karadeniz_extra_time",
  "eleme_yetkisi",
  "mevzi_bekcisi",
];

/** Static bonus-type metadata (icon/label/description), reused so the UI
 *  surfaces don't lose the existing copy when a bonus moves region.
 *
 *  Seeded from BONUS_POOL first (so pool-resident types like eleme_yetkisi
 *  get their canonical icon/label/description) and then overwritten by
 *  REGION_BONUSES for the legacy region-tied entries so existing copy stays
 *  byte-identical for istanbul/ankara/çukurova/karadeniz. */
const BONUS_TYPE_META: Record<
  ConquestRegionBonusType,
  { icon: string; label: string; description: string }
> = (() => {
  const out: Record<string, { icon: string; label: string; description: string }> = {};
  for (const entry of BONUS_POOL) {
    out[entry.type] = {
      icon:        entry.icon,
      label:       entry.label,
      description: entry.description,
    };
  }
  for (const def of Object.values(REGION_BONUSES)) {
    out[def.type] = {
      icon:        def.icon,
      label:       def.label,
      description: def.description,
    };
  }
  return out as Record<ConquestRegionBonusType, { icon: string; label: string; description: string }>;
})();

/** mulberry32 — deterministic 32-bit PRNG.  Local copy so this module stays
 *  decoupled from `conquestState.ts`. */
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

/** Number of bonus tiles to place per round.  Maps with very few regions
 *  receive fewer bonuses so they don't saturate the board. */
function pickBonusCountForRound(regionCount: number): number {
  if (regionCount <= 6)  return 2;
  if (regionCount <= 12) return 3;
  return 4;
}

/** Build a deterministic seed for the match-level assignment from the raw
 *  `matchSeed` (`gameState.startedAt`).  Bit mix so the low bits of the
 *  wall-clock value aren't directly exposed to the picker. */
export function matchBonusSeed(matchSeed: number): number {
  // Multiplicative + xor mix; cheap and good enough for our 4-pick lottery.
  const a = (matchSeed >>> 0);
  const b = (0x9e3779b1 >>> 0);  // golden-ratio constant
  return (a ^ b ^ ((a << 5) | (a >>> 27))) >>> 0;
}

/**
 * Build the bonus assignment for the entire match.  Pure function — same
 * inputs always yield the same assignment so host/guest snapshots stay in
 * sync, and the picks remain identical from round to round.
 *
 * Excludes capital regions (`CAPITAL_REGION_IDS`) so Ankara never doubles as a
 * rotating bonus; the capital cinematic owns that lane exclusively.
 *
 * The assignment is fixed at match creation; round transitions reuse it
 * verbatim, so there is no per-round anti-repeat concept here.
 */
export function buildRoundBonusAssignment(
  mapConfig:     ConquestMapConfig,
  regionStates:  ConquestRegionState[],
  players:       ConquestPlayer[],
  matchSeed:     number,
): ConquestRoundBonusAssignment {
  const regions = mapConfig.regions;
  if (regions.length === 0) return {};

  const rng = mulberry32(matchBonusSeed(matchSeed));
  const ownerById: Map<ConquestRegionId, string | null> = new Map();
  for (const rs of regionStates) ownerById.set(rs.regionId, rs.ownerPlayerId);

  const regionById: Map<ConquestRegionId, ConquestRegion> = new Map();
  for (const r of regions) regionById.set(r.id, r);

  // Pool: every region *except* the capital region(s) — capital cinematic
  // owns Ankara; mixing it into the rotation undermines that channel.
  const pool: ConquestRegion[] = regions.filter(r => !CAPITAL_REGION_IDS.has(r.id));
  if (pool.length === 0) return {};

  // Tally how many tiles each owner currently controls, used for the anti-
  // hoarding score (concentrated owners earn a negative weight).
  const ownerCount: Record<string, number> = {};
  for (const p of players) ownerCount[p.id] = 0;
  for (const rs of regionStates) {
    if (rs.ownerPlayerId && ownerCount[rs.ownerPlayerId] !== undefined) {
      ownerCount[rs.ownerPlayerId] += 1;
    }
  }

  const targetCount = Math.min(pool.length, pickBonusCountForRound(regions.length));

  // Pick bonus *types* in a seeded shuffled order so type→region mapping
  // doesn't always assign the same type to the highest-scoring region.
  const bonusTypes = shuffledSeeded(ROTATING_BONUS_TYPES, rng).slice(0, targetCount);

  const picked: ConquestRegionId[] = [];
  const pickedGroups: Set<string>  = new Set();
  const pickedOwners: Map<string, number> = new Map(); // owner → count this match

  const assignment: ConquestRoundBonusAssignment = {};

  for (let i = 0; i < bonusTypes.length; i++) {
    let bestScore = -Infinity;
    let bestPicks: ConquestRegion[] = [];

    for (const r of pool) {
      if (r.id in assignment) continue;
      const score = scoreCandidate({
        candidate:    r,
        regionById,
        ownerById,
        ownerCount,
        pickedSet:    new Set(picked),
        pickedGroups,
        pickedOwners,
        rng,
      });
      if (score > bestScore) {
        bestScore = score;
        bestPicks = [r];
      } else if (score === bestScore) {
        bestPicks.push(r);
      }
    }

    if (bestPicks.length === 0) break;

    // Tie break: random pick within the top tier — keeps variety high when
    // many regions are roughly equally good (typical mid-match scenario).
    const chosen = bestPicks[Math.floor(rng() * bestPicks.length)];
    assignment[chosen.id] = bonusTypes[i];

    picked.push(chosen.id);
    if (chosen.groupName) pickedGroups.add(chosen.groupName);
    const ownerId = ownerById.get(chosen.id) ?? null;
    if (ownerId) pickedOwners.set(ownerId, (pickedOwners.get(ownerId) ?? 0) + 1);
  }

  return assignment;
}

interface CandidateScoreInput {
  candidate:     ConquestRegion;
  regionById:    Map<ConquestRegionId, ConquestRegion>;
  ownerById:     Map<ConquestRegionId, string | null>;
  ownerCount:    Record<string, number>;
  pickedSet:     Set<ConquestRegionId>;
  pickedGroups:  Set<string>;
  pickedOwners:  Map<string, number>;
  rng:           () => number;
}

/**
 * Score a candidate region for the match's bonus selection.  Higher is
 * better.  Weights tuned so:
 *   - Anti-cluster dominates (adjacency check; we never want bonuses next to
 *     each other).
 *   - Fairness (owner concentration) is a softer push so a contested boundary
 *     is mildly preferred to a deep-controlled interior, without hard-banning
 *     any specific player.
 *
 * Random jitter in [0, 0.99) keeps the tie-break field organic for visually
 * varied placements.
 */
function scoreCandidate(input: CandidateScoreInput): number {
  const {
    candidate, regionById, ownerById, ownerCount,
    pickedSet, pickedGroups, pickedOwners, rng,
  } = input;

  let score = 0;

  // ── Anti-cluster: penalise candidates adjacent to any already-picked
  //    region this round.  Strong weight so clustered placements only happen
  //    when there are truly no other choices left.
  for (const n of candidate.neighbors) {
    if (pickedSet.has(n)) {
      score -= 12;
    } else {
      // Two-hop adjacency: small additional penalty so we don't accidentally
      // pick the next ring on a tightly-knit map.
      const neighborRegion = regionById.get(n);
      if (neighborRegion) {
        for (const nn of neighborRegion.neighbors) {
          if (pickedSet.has(nn) && nn !== candidate.id) {
            score -= 1.5;
            break;
          }
        }
      }
    }
  }

  // ── Group / quadrant spread: reward regions whose group hasn't appeared
  //    in this match's picks yet.  Encourages bonuses to span the map.
  if (candidate.groupName) {
    if (!pickedGroups.has(candidate.groupName)) {
      score += 5;
    } else {
      score -= 1;
    }
  }

  // ── Fairness: penalise candidates owned by a player who already has many
  //    tiles or who's already collected a bonus in this match's picks.
  const ownerId = ownerById.get(candidate.id) ?? null;
  if (ownerId) {
    const tilesHeld = ownerCount[ownerId] ?? 0;
    // Scaling: each tile beyond 3 subtracts 0.6 — caps around -6 for big leaders.
    if (tilesHeld > 3) score -= Math.min(tilesHeld - 3, 10) * 0.6;
    // Additional sting for picking a second bonus on the same owner this match.
    const sameOwnerPicks = pickedOwners.get(ownerId) ?? 0;
    score -= sameOwnerPicks * 3.5;
  } else {
    // Neutral and contested boundary tiles are slightly preferred — they
    // create real "go capture this" tension instead of "you already had it".
    score += 1.8;
  }

  // Tiny random jitter so equally-scored regions still vary in placement.
  score += rng() * 0.99;

  return score;
}

/** Fisher-Yates shuffle of a copy, driven by a seeded RNG. */
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

/**
 * Resolve the bonus def for a region in the context of the current snapshot.
 * Checks the dynamic per-round assignment first; falls back to the legacy
 * static REGION_BONUSES table so pre-dynamic-bonus saves keep working.
 *
 * Returns null when no bonus is assigned to this region in either source.
 *
 * The returned def adopts the dynamic region id (so map FX/toasts surface
 * the right region label) but keeps the bonus type's icon/label copy from
 * the static catalog — that's still the canonical type metadata.
 */
export function resolveActiveBonus(
  roundBonuses: ConquestRoundBonusAssignment | undefined,
  regionId:     ConquestRegionId,
): ConquestRegionBonusDef | null {
  // Dynamic path: dyn-built `roundBonuses` is authoritative when present.
  if (roundBonuses && regionId in roundBonuses) {
    const type = roundBonuses[regionId];
    const meta = BONUS_TYPE_META[type] ?? null;
    if (!meta) {
      // Unknown bonus type (defensive — should never happen).  Return a
      // minimal generic def so the UI still renders something.
      return {
        regionId, type,
        icon:        "⭐",
        label:       "Bonus",
        description: "Tur bonusu",
      };
    }
    return {
      regionId,
      type,
      icon:        meta.icon,
      label:       meta.label,
      description: meta.description,
    };
  }

  // Legacy fallback: pre-dynamic save with no assignment field.  Walk the
  // static table so old games still surface bonuses correctly.
  if (!roundBonuses) {
    const legacy = REGION_BONUSES[regionId];
    if (legacy) return legacy;
  }

  return null;
}

/**
 * Iterate every region id carrying a bonus in the current snapshot.  Used by
 * the sound layer's ownership diff to fire `bonus-capture` on any bonus tile.
 *
 * Falls back to the static catalog when no dynamic assignment exists (older
 * saves) so the sound contract stays identical for pre-dynamic-bonus rooms.
 */
export function getActiveBonusRegionIds(
  roundBonuses: ConquestRoundBonusAssignment | undefined,
): ConquestRegionId[] {
  if (roundBonuses) return Object.keys(roundBonuses);
  return Object.keys(REGION_BONUSES);
}

/**
 * Compact list of `{ regionId, def }` pairs for the active round.  Handy for
 * the round-intro UI that announces "Bu tur bonuslar şurada" without rewriting
 * the resolver loop.
 */
export function getActiveBonusEntries(
  roundBonuses: ConquestRoundBonusAssignment | undefined,
): Array<{ regionId: ConquestRegionId; def: ConquestRegionBonusDef }> {
  const ids = getActiveBonusRegionIds(roundBonuses);
  const out: Array<{ regionId: ConquestRegionId; def: ConquestRegionBonusDef }> = [];
  for (const id of ids) {
    const def = resolveActiveBonus(roundBonuses, id);
    if (def) out.push({ regionId: id, def });
  }
  return out;
}
