/**
 * Conquest (Kuşatma) — pure state helpers.
 *
 * No React, no Supabase.  All functions are pure and deterministic so they
 * can be unit-tested independently of the UI.
 *
 * Phase-4 scope: initial color assignment and region ownership distribution.
 * Turn logic, capture resolution, and win conditions come in a later phase.
 */

import type {
  ConquestMapConfig,
  ConquestPlayer,
  ConquestPlayerColor,
  ConquestRegion,
  ConquestRegionId,
  ConquestRegionState,
} from "./types";
import { getRegionPoints } from "./regionPoints";

/**
 * Ordered color palette.  First four slots match the legacy slot-based
 * assignment (red → blue → green → yellow) so rooms created before the
 * picker shipped keep their original tints when falling back.
 */
export const CONQUEST_COLOR_PALETTE: ConquestPlayerColor[] = [
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
];

/** TR label per color — used by tooltips in the lobby color picker. */
export const CONQUEST_COLOR_LABEL: Record<ConquestPlayerColor, string> = {
  red:    "Kırmızı",
  blue:   "Mavi",
  green:  "Yeşil",
  yellow: "Sarı",
  purple: "Mor",
  orange: "Turuncu",
  pink:   "Pembe",
  cyan:   "Camgöbeği",
};

/** Hex values for each ConquestPlayerColor — used by UI components. */
export const CONQUEST_COLOR_HEX: Record<ConquestPlayerColor, string> = {
  red:    "#ef4444",
  blue:   "#3b82f6",
  green:  "#22c55e",
  yellow: "#eab308",
  purple: "#a855f7",
  orange: "#f97316",
  pink:   "#ec4899",
  cyan:   "#06b6d4",
};

/**
 * Assign a color to each player.  Honours `player.color` when present
 * (picker-driven) and falls back to slot-based palette rotation for legacy
 * rows that pre-date persistence.  Slot fallback also skips colors already
 * claimed by earlier players in the same list to avoid two players sharing
 * a tint mid-migration.
 */
export function assignConquestPlayerColors(
  players: ConquestPlayer[],
): Record<string, ConquestPlayerColor> {
  const out:  Record<string, ConquestPlayerColor> = {};
  const used: Set<ConquestPlayerColor>            = new Set();
  // First pass: respect explicit picks.
  for (const p of players) {
    if (p.color) {
      out[p.id] = p.color;
      used.add(p.color);
    }
  }
  // Second pass: assign the next free palette entry to anyone unset.
  for (const p of players) {
    if (out[p.id]) continue;
    const free = CONQUEST_COLOR_PALETTE.find(c => !used.has(c))
      ?? CONQUEST_COLOR_PALETTE[0];
    out[p.id] = free;
    used.add(free);
  }
  return out;
}

/** First palette entry not present in `usedColors` — wraps if all 8 taken. */
export function pickNextConquestColor(
  usedColors: Iterable<string | null | undefined>,
): ConquestPlayerColor {
  const used = new Set<string>();
  for (const c of usedColors) if (c) used.add(c);
  return CONQUEST_COLOR_PALETTE.find(c => !used.has(c))
    ?? CONQUEST_COLOR_PALETTE[0];
}

/**
 * Per-player starting region count by player count.
 *
 * Tuned so opponents collide early: a 24-region map (Türkiye) leaves only a
 * thin neutral buffer (10 / 6 / 4 tiles for 2 / 3 / 4 players) instead of the
 * old 16-region dead zone. Falls back to floor(regions/playerCount) - 1 for
 * unusual headcounts so very crowded matches still leave a small neutral
 * buffer.
 */
const STARTING_REGIONS_PER_PLAYER: Record<number, number> = {
  2: 7,
  3: 6,
  4: 5,
};

/**
 * Number of distinct *seeds* (initial scattered spawn tiles) per player before
 * the adjacency-growth phase kicks in. More seeds = more fronts = less
 * single-blob clustering.
 *
 *   2 players → 3 seeds each, then 4 growth picks
 *   3 players → 2 seeds each, then 4 growth picks
 *   4 players → 2 seeds each, then 3 growth picks
 *
 * Pure clusterability tuning — does not affect totals or per-player region
 * counts. Falls back to 2 for unusual headcounts, clamped to perPlayer.
 */
const SEEDS_PER_PLAYER: Record<number, number> = {
  2: 3,
  3: 2,
  4: 2,
};

/**
 * Regions whose initial concentration should be spread across players. These
 * are the bonus-bearing tiles from REGION_BONUSES — letting one player snag
 * two of these in the opening is a known "snowball" failure mode.
 *
 * Kept as a local literal Set (not imported) to avoid coupling state to the
 * bonus-effect module; the *identity* of these tiles is what matters for
 * fairness, not the effect they grant.
 */
const BONUS_REGION_IDS: ReadonlySet<ConquestRegionId> = new Set<ConquestRegionId>([
  "istanbul_kocaeli",
  "ankara_cevre",
  "cukurova",
  "dogu_karadeniz",
]);

/** mulberry32 — small, fast, deterministic 32-bit PRNG. Returns floats in [0,1). */
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

/** Fisher-Yates shuffle of a copy, driven by a seeded RNG. */
function shuffled<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Snake-order draft pick:
 *   2 players → 0,1,1,0,0,1,1,0,…
 *   3 players → 0,1,2,2,1,0,0,1,2,…
 *   4 players → 0,1,2,3,3,2,1,0,…
 *
 * Each cycle reverses direction so the player who picked last in cycle N
 * picks first in cycle N+1.  Classic draft balance — over many cycles the
 * total values converge.
 */
function snakeDraftPlayerIndex(pickIndex: number, playerCount: number): number {
  const cycle  = Math.floor(pickIndex / playerCount);
  const within = pickIndex % playerCount;
  return cycle % 2 === 0 ? within : playerCount - 1 - within;
}

/** BFS shortest-path distance map from `from` to every reachable region. */
function bfsDistancesFrom(
  regions: ConquestRegion[],
  from:    ConquestRegionId,
): Map<ConquestRegionId, number> {
  const out: Map<ConquestRegionId, number> = new Map();
  const neighborMap: Map<ConquestRegionId, readonly ConquestRegionId[]> = new Map();
  for (const r of regions) neighborMap.set(r.id, r.neighbors);
  out.set(from, 0);
  const queue: ConquestRegionId[] = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d   = out.get(cur)!;
    for (const n of neighborMap.get(cur) ?? []) {
      if (out.has(n)) continue;
      out.set(n, d + 1);
      queue.push(n);
    }
  }
  return out;
}

/**
 * Group a player's owned regions into connected components and return a map
 * from regionId → clusterIndex. Used by the growth phase to bias picks toward
 * the player's *smallest* sub-cluster so all seeds grow at similar rates
 * instead of one super-blob swallowing the others.
 */
function computeOwnedClusters(
  regions: ConquestRegion[],
  owned:   Set<ConquestRegionId>,
): Map<ConquestRegionId, number> {
  const out: Map<ConquestRegionId, number> = new Map();
  const neighborMap: Map<ConquestRegionId, readonly ConquestRegionId[]> = new Map();
  for (const r of regions) neighborMap.set(r.id, r.neighbors);
  let clusterId = 0;
  for (const r of regions) {
    if (!owned.has(r.id) || out.has(r.id)) continue;
    out.set(r.id, clusterId);
    const queue: ConquestRegionId[] = [r.id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const n of neighborMap.get(cur) ?? []) {
        if (!owned.has(n) || out.has(n)) continue;
        out.set(n, clusterId);
        queue.push(n);
      }
    }
    clusterId++;
  }
  return out;
}

/** Count cluster sizes from a regionId → clusterIndex map. */
function clusterSizesFrom(
  clusterMap: Map<ConquestRegionId, number>,
): Map<number, number> {
  const out: Map<number, number> = new Map();
  for (const cid of clusterMap.values()) out.set(cid, (out.get(cid) ?? 0) + 1);
  return out;
}

/**
 * Run one seeded distribution attempt.  See `pickInitialOwners` for the
 * outer retry loop and acceptance criteria.
 *
 * Two-phase draft, both phases obey the snake order so per-player value
 * still converges:
 *
 *   1. Seed phase — each player drops K seeds (see SEEDS_PER_PLAYER) chosen
 *      to be FAR from their own previous seeds AND from opponent seeds.
 *      This deliberately scatters each player across the map so they don't
 *      grow as a single blob.  Value still factors into the score (high-
 *      value tiles preferred among similarly-spread candidates), and a
 *      penalty term discourages a single player hoarding bonus-bearing
 *      tiles (İstanbul/Ankara/Çukurova/D.Karadeniz).
 *
 *   2. Growth phase — adjacency-aware, but biased to extend the player's
 *      *smallest* sub-cluster so all seeds grow at similar rates.  This
 *      preserves spread instead of letting one cluster swallow the others.
 *      Value-greedy is the tie-breaker.
 *
 * Randomness lives in three controlled places (Fisher-Yates draft order,
 * tied-score seed pick, tied-score growth pick) — all driven by the seeded
 * mulberry32 RNG so host/guest sync via the persisted snapshot is unaffected.
 */
function runDistributionAttempt(
  regions: ConquestRegion[],
  players: ConquestPlayer[],
  seed: number,
): Record<ConquestRegionId, string> {
  const rng = mulberry32(seed);
  // Randomize who picks first / second / ... so spawn rotation varies.
  const draftPlayers = shuffled(players, rng);
  const playerCount  = draftPlayers.length;
  const perPlayer =
    STARTING_REGIONS_PER_PLAYER[playerCount]
    ?? Math.max(1, Math.floor(regions.length / playerCount) - 1);
  const target = Math.min(perPlayer * playerCount, regions.length);

  // Seeds per player, clamped so we never request more seeds than the player
  // will receive picks for (e.g. tiny maps where perPlayer < 2).
  const seedRequest = SEEDS_PER_PLAYER[playerCount] ?? 2;
  const seedCount   = Math.max(1, Math.min(seedRequest, perPlayer));
  const seedTarget  = Math.min(seedCount * playerCount, target);

  // Precompute all-pairs BFS distances. Cheap (≤24 regions on the live map).
  const distances: Map<ConquestRegionId, Map<ConquestRegionId, number>> = new Map();
  for (const r of regions) distances.set(r.id, bfsDistancesFrom(regions, r.id));
  const dist = (a: ConquestRegionId, b: ConquestRegionId): number =>
    distances.get(a)?.get(b) ?? Infinity;

  const owners: Record<ConquestRegionId, string>            = {};
  const ownedByPlayer: Record<string, Set<ConquestRegionId>> = {};
  const bonusCountByPlayer: Record<string, number>           = {};
  for (const p of draftPlayers) {
    ownedByPlayer[p.id]       = new Set();
    bonusCountByPlayer[p.id]  = 0;
  }

  // ── Phase 1: seed scatter ──────────────────────────────────────────────
  // Spread heavily weighted; value contributes as a softer factor; bonus
  // hoarding penalized.  Score numbers tuned so a far high-value tile beats
  // a near low-value tile, but two equally-spread candidates still rank by
  // value (preserving snake-draft value balance).
  for (let pickIndex = 0; pickIndex < seedTarget; pickIndex++) {
    const playerIdx = snakeDraftPlayerIndex(pickIndex, playerCount);
    const player    = draftPlayers[playerIdx];
    const remaining = regions.filter(r => !(r.id in owners));
    if (remaining.length === 0) break;

    const myOwned = Array.from(ownedByPlayer[player.id]);
    const oppOwned: ConquestRegionId[] = [];
    for (const otherP of draftPlayers) {
      if (otherP.id === player.id) continue;
      for (const rid of ownedByPlayer[otherP.id]) oppOwned.push(rid);
    }

    const scoreOf = (r: ConquestRegion): number => {
      let dSelf = Infinity;
      for (const o of myOwned) {
        const d = dist(r.id, o);
        if (d < dSelf) dSelf = d;
      }
      let dOpp = Infinity;
      for (const o of oppOwned) {
        const d = dist(r.id, o);
        if (d < dOpp) dOpp = d;
      }
      const spreadSelf  = Math.min(dSelf, 4) * 5;   // strong: avoid clustering
      const spreadOpp   = Math.min(dOpp, 3) * 2;    // medium: breathing room
      const valueScore  = getRegionPoints(r.id);    // soft: high-value bias
      const bonusGuard  =
        bonusCountByPlayer[player.id] > 0 && BONUS_REGION_IDS.has(r.id) ? -6 : 0;
      return spreadSelf + spreadOpp + valueScore + bonusGuard;
    };

    let bestScore = -Infinity;
    for (const r of remaining) {
      const s = scoreOf(r);
      if (s > bestScore) bestScore = s;
    }
    const top = remaining.filter(r => scoreOf(r) >= bestScore - 0.001);
    const chosen = top[Math.floor(rng() * top.length)];

    owners[chosen.id] = player.id;
    ownedByPlayer[player.id].add(chosen.id);
    if (BONUS_REGION_IDS.has(chosen.id)) bonusCountByPlayer[player.id]++;
  }

  // ── Phase 2: spread-aware growth ───────────────────────────────────────
  // Each pick extends the player's frontier, preferring extensions to the
  // smallest existing cluster (so all seeds grow at similar rates instead
  // of one swallowing the rest). Within the smallest-cluster tier, value-
  // greedy + random tie-break is preserved.
  for (let pickIndex = seedTarget; pickIndex < target; pickIndex++) {
    const playerIdx = snakeDraftPlayerIndex(pickIndex, playerCount);
    const player    = draftPlayers[playerIdx];
    const myRegions = ownedByPlayer[player.id];
    const remaining = regions.filter(r => !(r.id in owners));
    if (remaining.length === 0) break;

    const adjacent = remaining.filter(r =>
      r.neighbors.some(n => myRegions.has(n)),
    );
    const pool = adjacent.length > 0 ? adjacent : remaining;

    const clusterMap   = computeOwnedClusters(regions, myRegions);
    const clusterSizes = clusterSizesFrom(clusterMap);

    type Candidate = { region: ConquestRegion; smallest: number; value: number };
    const candidates: Candidate[] = pool.map(r => {
      let smallest = Infinity;
      for (const n of r.neighbors) {
        const cid = clusterMap.get(n);
        if (cid === undefined) continue;
        const size = clusterSizes.get(cid) ?? 0;
        if (size < smallest) smallest = size;
      }
      // Fallback (disconnected pick — only possible when no adjacent pool):
      // treat as the largest possible bucket so the connected candidates
      // (rare to coexist with this fallback) still win.
      if (smallest === Infinity) smallest = myRegions.size + 1;
      return { region: r, smallest, value: getRegionPoints(r.id) };
    });

    const minSmall = Math.min(...candidates.map(c => c.smallest));
    const smallestTier = candidates.filter(c => c.smallest === minSmall);
    const bestVal = Math.max(...smallestTier.map(c => c.value));
    let topTier = smallestTier.filter(c => c.value === bestVal);

    // Bonus diversity guard: if this player already holds a bonus tile and
    // a non-bonus alternative exists in the top tier, drop the bonus picks.
    if (bonusCountByPlayer[player.id] > 0) {
      const nonBonus = topTier.filter(c => !BONUS_REGION_IDS.has(c.region.id));
      if (nonBonus.length > 0) topTier = nonBonus;
    }

    const chosen = topTier[Math.floor(rng() * topTier.length)].region;
    owners[chosen.id] = player.id;
    myRegions.add(chosen.id);
    if (BONUS_REGION_IDS.has(chosen.id)) bonusCountByPlayer[player.id]++;
  }

  return owners;
}

/** Sum of region values currently held by each player (incl. 0-region players). */
function summarizeTotals(
  regions: ConquestRegion[],
  players: ConquestPlayer[],
  owners: Record<ConquestRegionId, string>,
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const p of players) totals[p.id] = 0;
  for (const r of regions) {
    const owner = owners[r.id];
    if (owner !== undefined) totals[owner] = (totals[owner] ?? 0) + getRegionPoints(r.id);
  }
  return totals;
}

/**
 * For each player, the count of unowned regions adjacent to their territory
 * — i.e. how many free expansion moves they have on turn one.  A value of 0
 * means the player is fully boxed in (their only option is to attack a
 * neighbor); we treat that as unfair and prefer attempts that leave every
 * player with at least 1.
 */
function summarizeFrontiers(
  regions: ConquestRegion[],
  players: ConquestPlayer[],
  owners: Record<ConquestRegionId, string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of players) out[p.id] = 0;
  for (const r of regions) {
    if (owners[r.id] !== undefined) continue; // skip owned regions
    const adjacentOwners = new Set<string>();
    for (const n of r.neighbors) {
      const o = owners[n];
      if (o !== undefined) adjacentOwners.add(o);
    }
    for (const ownerId of adjacentOwners) out[ownerId] = (out[ownerId] ?? 0) + 1;
  }
  return out;
}

/**
 * Pick a fair distribution.  Tries up to MAX_ATTEMPTS seed variations and
 * accepts the first one that clears all four fairness gates:
 *
 *   - value-diff (max − min totals) ≤ 2
 *   - no player is fully boxed in (every player has ≥ 1 unowned neighbor)
 *   - no player owns >1 connected blob (multi-front spread)
 *   - no player hoards 2+ bonus-bearing tiles (İstanbul/Ankara/Çukurova/D.Kara.)
 *
 * If no attempt meets all gates, returns the attempt with the lowest
 * composite penalty so we never block game start on a degenerate map.
 * Attempt budget is generous (12) because the multi-seed scatter has
 * stricter constraints than the legacy single-seed grow — most maps still
 * resolve in 1–3 attempts.
 *
 * Seeds are derived by perturbing `baseSeed` with a fixed golden-ratio
 * stride; using a real RNG would lose host/guest determinism, but since
 * the host computes this once and persists the result, the per-attempt
 * stream just needs to be deterministic per seed.
 */
function pickInitialOwners(
  regions: ConquestRegion[],
  players: ConquestPlayer[],
  baseSeed: number,
): Record<ConquestRegionId, string> {
  const MAX_ATTEMPTS = 12;
  let bestOwners: Record<ConquestRegionId, string> | null = null;
  let bestPenalty = Infinity;

  const totalBonusOnMap = regions.filter(r => BONUS_REGION_IDS.has(r.id)).length;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Golden-ratio stride avoids near-duplicate seeds across attempts.
    const seed   = (baseSeed + attempt * 0x9e3779b9) >>> 0;
    const owners = runDistributionAttempt(regions, players, seed);

    const totals    = summarizeTotals(regions, players, owners);
    const frontiers = summarizeFrontiers(regions, players, owners);
    const totalValues = Object.values(totals);
    const valueDiff = totalValues.length > 0
      ? Math.max(...totalValues) - Math.min(...totalValues)
      : 0;
    const minFrontier = Object.values(frontiers).length > 0
      ? Math.min(...Object.values(frontiers))
      : 1;

    // Cluster diversity: how many players end up with a single connected
    // blob (i.e. the spread phase failed for them).
    let monoBlobCount = 0;
    // Bonus diversity: how many players exceed the fair-share ceiling of
    // bonus tiles. ceil(B/P) is the smallest count any player must hold in
    // a perfectly-fair split, so >ceil is a true imbalance (not just a
    // 2/2 split being flagged when both players are equal).
    const bonusCeiling = players.length > 0
      ? Math.ceil(totalBonusOnMap / players.length)
      : Infinity;
    let bonusHoarders = 0;
    for (const p of players) {
      const myOwned: Set<ConquestRegionId> = new Set();
      for (const r of regions) if (owners[r.id] === p.id) myOwned.add(r.id);
      if (myOwned.size === 0) continue;
      const clusters = new Set(computeOwnedClusters(regions, myOwned).values());
      if (clusters.size <= 1 && myOwned.size > 1) monoBlobCount++;
      if (totalBonusOnMap >= 2) {
        let bonusHeld = 0;
        for (const rid of myOwned) if (BONUS_REGION_IDS.has(rid)) bonusHeld++;
        if (bonusHeld > bonusCeiling) bonusHoarders++;
      }
    }

    // Penalty weights:
    //   valueDiff       — primary fairness lever, scale 10 per point
    //   boxed-in        — hard strike (100): match start would feel rigged
    //   mono-blob       — soft (8 each): the user explicitly wants spread
    //   bonus hoarders  — meaningful (20 each): snowball failure mode
    const penalty =
      valueDiff * 10
      + (minFrontier === 0 ? 100 : 0)
      + monoBlobCount * 8
      + bonusHoarders * 20;

    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestOwners  = owners;
      if (
        valueDiff   <= 2
        && minFrontier > 0
        && monoBlobCount === 0
        && bonusHoarders === 0
      ) break;
    }
  }

  return bestOwners ?? {};
}

/**
 * Build the initial ConquestRegionState[] for a match.
 *
 * The distribution is **controlled-random**: seeded by `seed` (defaults to
 * `Date.now()` so each match feels different) and run through a
 * snake-draft + value-greedy + adjacency-aware allocator with up to 5
 * retries to enforce a value-diff ≤ 2 and no fully-boxed-in players.
 *
 * Determinism is per-seed: the host runs this once with the match's seed
 * and uploads the resulting state to Supabase; guests read the snapshot
 * from the synced row, so host/guest agreement does not depend on the
 * seed being shared.
 *
 * Pass an explicit `seed` for tests / lobby previews that need a stable
 * result.
 */
export function createInitialRegionStates(
  mapConfig: ConquestMapConfig,
  players: ConquestPlayer[],
  seed: number = Date.now(),
): ConquestRegionState[] {
  const regions = mapConfig.regions;
  if (players.length === 0) {
    return regions.map(r => ({
      regionId:      r.id,
      ownerPlayerId: null,
      shielded:      false,
    }));
  }
  const owners = pickInitialOwners(regions, players, seed);
  return regions.map(r => ({
    regionId:      r.id,
    ownerPlayerId: owners[r.id] ?? null,
    shielded:      false,
  }));
}

/**
 * Count the number of regions each player currently owns.
 * Returns a map of playerId → count.  Players with 0 regions are omitted.
 */
export function getRegionOwnerCounts(
  regionStates: ConquestRegionState[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const rs of regionStates) {
    if (rs.ownerPlayerId !== null) {
      counts[rs.ownerPlayerId] = (counts[rs.ownerPlayerId] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Hide Ankara "Gizli Operasyon" placements from non-owner viewers.  Three flavours:
 *
 *   - kind === "shield"       → region is already openly owned by the placing
 *     player; only the shield itself is secret.  Keep ownership visible to
 *     opponents and just strip the `hiddenShieldOwnerId`/`hiddenShieldKind`
 *     so the shield's presence doesn't leak.
 *
 *   - kind === "conquest"     → region was secretly captured from neutral
 *     (gizli fetih).  Real owner is the placer; mask ownership so opponents
 *     see a plain neutral tile.  Also the legacy fallback for very old saves
 *     without a stored kind.
 *
 *   - kind === "neutral_trap" → LEGACY only: pre-spec-rev3 trap where the
 *     region stayed genuinely neutral.  Strip the hidden-shield fields for
 *     opponents so the tile renders as a plain neutral region.
 *
 * Owner-side projection is identity in all cases.
 *
 * NOTE: `shielded` (İstanbul open shield) is intentionally NOT cleared here.
 * It is a public/open field — opponents must always see it on the map.
 *
 * Used for all opponent-facing renders and any helper that derives "what the
 * viewer sees on the board" (legal targets, region counts in side panels).
 * Gameplay logic must still operate on the real `regionStates` so blocks and
 * reveals trigger correctly when an opponent acts on a hidden region.
 */
export function projectRegionStatesForViewer(
  regionStates: ConquestRegionState[],
  viewerId:     string | null,
): ConquestRegionState[] {
  let mutated = false;
  const out = regionStates.map(rs => {
    const hiddenOwner = rs.hiddenShieldOwnerId;
    if (!hiddenOwner) return rs;
    if (hiddenOwner === viewerId) return rs;
    mutated = true;
    const kind = rs.hiddenShieldKind ?? "conquest";
    if (kind === "shield" || kind === "neutral_trap") {
      // Region is either openly owned (shield) or genuinely neutral (trap);
      // either way the tile's owner is shown correctly, only the hidden
      // marker is stripped for opponents.
      return {
        ...rs,
        hiddenShieldOwnerId: undefined,
        hiddenShieldKind:    undefined,
      };
    }
    // Legacy ("conquest"): mask the whole capture as a neutral tile.
    return {
      ...rs,
      ownerPlayerId:       null,
      hiddenShieldOwnerId: undefined,
      hiddenShieldKind:    undefined,
      lastCapturedBy:      undefined,
    };
  });
  return mutated ? out : regionStates;
}
