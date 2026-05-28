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

/**
 * Run one seeded distribution attempt.  See `pickInitialOwners` for the
 * outer retry loop and acceptance criteria.
 *
 * Randomness lives in three controlled places:
 *   1. Draft slot order — Fisher-Yates shuffle of the player list, so a
 *      different player gets "first pick" across matches.
 *   2. Seed pick — when multiple isolated regions tie at the highest value
 *      (e.g. İstanbul and Ankara both value-5 and both isolated), pick one
 *      uniformly at random instead of always taking the lowest index.
 *   3. Growth pick — same logic, applied within the player's frontier so
 *      a player who could equally well take three different value-3 regions
 *      doesn't always pick the same one.
 *
 * Value-greedy selection (always pick from the top-value tier) is preserved
 * everywhere, so per-pick value never drops below the deterministic version
 * — only the *identity* of the chosen tile varies.
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

  const owners: Record<ConquestRegionId, string> = {};
  const ownedByPlayer: Record<string, Set<ConquestRegionId>> = {};
  for (const p of draftPlayers) ownedByPlayer[p.id] = new Set();
  const firstPickDone = new Set<string>();

  /** Pick uniformly from the highest-value entries in `pool`. */
  const pickWithRandomTie = (pool: ConquestRegion[]): ConquestRegion => {
    let bestVal = -Infinity;
    for (const r of pool) {
      const v = getRegionPoints(r.id);
      if (v > bestVal) bestVal = v;
    }
    const top = pool.filter(r => getRegionPoints(r.id) === bestVal);
    return top[Math.floor(rng() * top.length)];
  };

  for (let pickIndex = 0; pickIndex < target; pickIndex++) {
    const playerIdx = snakeDraftPlayerIndex(pickIndex, playerCount);
    const player    = draftPlayers[playerIdx];
    const remaining = regions.filter(r => !(r.id in owners));
    if (remaining.length === 0) break;

    let pool: ConquestRegion[];
    if (!firstPickDone.has(player.id)) {
      const isolated = remaining.filter(r =>
        r.neighbors.every(n => !(n in owners)),
      );
      pool = isolated.length > 0 ? isolated : remaining;
      firstPickDone.add(player.id);
    } else {
      const myRegions = ownedByPlayer[player.id];
      const adjacent  = remaining.filter(r =>
        r.neighbors.some(n => myRegions.has(n)),
      );
      pool = adjacent.length > 0 ? adjacent : remaining;
    }

    const chosen = pickWithRandomTie(pool);
    owners[chosen.id] = player.id;
    ownedByPlayer[player.id].add(chosen.id);
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
 * accepts the first one that satisfies both fairness gates:
 *
 *   - value-diff (max − min totals) ≤ 2
 *   - no player is fully boxed in (every player has ≥ 1 unowned neighbor)
 *
 * If no attempt meets both gates, returns the attempt with the lowest
 * composite penalty so we never block game start on a degenerate map.
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
  const MAX_ATTEMPTS = 5;
  let bestOwners: Record<ConquestRegionId, string> | null = null;
  let bestPenalty = Infinity;

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

    // Penalty: value imbalance hurts most; boxed-in players are a hard
    // strike (penalty 100) since they can't expand without attacking.
    const penalty = valueDiff * 10 + (minFrontier === 0 ? 100 : 0);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestOwners  = owners;
      if (valueDiff <= 2 && minFrontier > 0) break; // fair enough — stop early
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
