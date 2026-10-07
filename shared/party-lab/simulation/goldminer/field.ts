import { GOLD_KINDS, GOLD_MINER as G, type GoldCount, type GoldKind } from "./config.js";
import { SWING_AMPLITUDE, contactLength, edgeLength, pivotX, type MineItem } from "./mine.js";

/** One item of a round's mine: where it lies and what it is worth (a sack's points rolled). */
export interface FieldItem extends MineItem {
  value: number;
}
const F = G.field;
/** Big golds and diamonds lie in the deeper part of the mine: below this share of the dig range. */
const DEEP_FROM = 0.35;
const PREMIUM: readonly GoldKind[] = ["big", "diamond"];

export const countRange = (count: GoldCount): readonly [number, number] => (typeof count === "number" ? [count, count] : count);
const pick = (count: GoldCount, random: () => number) => {
  const [min, max] = countRange(count);
  return min + Math.min(max - min, Math.floor(random() * (max - min + 1)));
};
/** The item counts for `lanes` players (2 or 3; the engine supports no others). */
export const fieldCounts = (lanes: number) => G.counts[lanes === 2 ? 2 : 3];
/** A sack's points: a random multiple of `sackStep` from `sackValue[0]` to `sackValue[1]`. */
export function sackValue(random: () => number) {
  const [low, high] = G.sackValue,
    steps = Math.floor((high - low) / G.sackStep);
  return low + G.sackStep * Math.min(steps, Math.floor(random() * (steps + 1)));
}
/** What an item is worth on average (a sack counts as the middle of its range). */
export const expectedValue = (item: { kind: GoldKind; value: number }) => (item.kind === "sack" ? (G.sackValue[0] + G.sackValue[1]) / 2 : item.value);

/** The first item (index) a hook fired at `angle` from `px` touches, −1 for none. */
export function firstHit(items: readonly MineItem[], px: number, angle: number, skip: (index: number) => boolean = () => false) {
  const edge = edgeLength(px, angle);
  let best = -1,
    bestLength = Infinity;
  items.forEach((item, index) => {
    if (skip(index)) return;
    const length = contactLength(px, angle, item, G.restLength, edge);
    if (length !== null && length < bestLength) {
      best = index;
      bestLength = length;
    }
  });
  return best;
}
/** The swing angles (radians) from `px` that hook `items[index]` first, sampled across it (`skip`: items no longer there). */
export function clearAngles(items: readonly MineItem[], index: number, px: number, skip: (index: number) => boolean = () => false) {
  const item = items[index],
    dx = item.x - px,
    dy = item.y,
    centre = Math.atan2(dx, dy),
    half = Math.asin(Math.min(1, (item.r + G.hookRadius) / Math.hypot(dx, dy)));
  const out: number[] = [];
  for (const u of [0, -0.3, 0.3, -0.6, 0.6, -0.85, 0.85]) {
    const angle = centre + u * half;
    if (Math.abs(angle) <= SWING_AMPLITUDE && firstHit(items, px, angle, skip) === index) out.push(angle);
  }
  return out;
}
/** The lanes that can hook `items[index]` with nothing else in the way. */
export const clearShots = (items: readonly MineItem[], index: number, lanes: number) =>
  Array.from({ length: lanes }, (_, lane) => lane).filter((lane) => clearAngles(items, index, pivotX(lane, lanes)).length > 0);

/**
 * Each lane's nearby value: every item counts (at its average) for the closest lane that can
 * hook it with nothing in the way; equally close lanes share it.
 */
export function nearValues(items: readonly FieldItem[], lanes: number) {
  const out = Array.from({ length: lanes }, () => 0);
  items.forEach((item, index) => {
    const shots = clearShots(items, index, lanes);
    if (!shots.length) return;
    const distance = (lane: number) => Math.hypot(item.x - pivotX(lane, lanes), item.y);
    const best = Math.min(...shots.map(distance)),
      nearest = shots.filter((lane) => distance(lane) - best < 1e-6);
    for (const lane of nearest) out[lane] += expectedValue(item) / nearest.length;
  });
  return out;
}

/** What is wrong with a mine for `lanes` players (empty: it follows every rule). */
export function fieldProblems(items: readonly FieldItem[], lanes: number): string[] {
  const problems: string[] = [];
  const counts = fieldCounts(lanes);
  for (const kind of GOLD_KINDS) {
    const n = items.filter((item) => item.kind === kind).length,
      [min, max] = countRange(counts[kind]);
    if (n < min || n > max) problems.push(`${kind}: ${n} (${min}–${max})`);
  }
  items.forEach((item, i) => {
    if (item.r !== G.items[item.kind].radius) problems.push(`${i}: radius`);
    if (Math.abs(item.x) > G.width / 2 - F.margin - item.r + 1e-9 || item.y - item.r < F.minDepth - 1e-9 || item.y + item.r > G.depth - F.margin + 1e-9) problems.push(`${i}: outside`);
    const value = item.kind === "sack" ? item.value >= G.sackValue[0] && item.value <= G.sackValue[1] && (item.value - G.sackValue[0]) % G.sackStep === 0 : item.value === G.items[item.kind].value;
    if (!value) problems.push(`${i}: value ${item.value}`);
    for (let j = 0; j < i; j++) if (Math.hypot(item.x - items[j].x, item.y - items[j].y) < item.r + items[j].r + F.gap - 1e-9) problems.push(`${i}/${j}: overlap`);
    if (!clearShots(items, i, lanes).length) problems.push(`${i}: unreachable`);
  });
  const shared = items.filter((item, i) => PREMIUM.includes(item.kind) && clearShots(items, i, lanes).length >= 2).length;
  if (shared < F.shared) problems.push(`shared premium: ${shared}`);
  const near = nearValues(items, lanes),
    mean = near.reduce((a, b) => a + b, 0) / lanes;
  if (near.some((v) => Math.abs(v - mean) > F.balance * mean + 1e-9)) problems.push(`balance: ${near.map(Math.round).join("/")}`);
  return problems;
}
const imbalance = (items: readonly FieldItem[], lanes: number) => {
  const near = nearValues(items, lanes),
    mean = near.reduce((a, b) => a + b, 0) / lanes;
  return Math.max(...near.map((v) => Math.abs(v - mean))) / Math.max(1, mean);
};

/** Larger items are placed first (they are the hardest to fit). */
const ORDER: readonly GoldKind[] = ["big", "rock", "sack", "small", "diamond"];
function layout(lanes: number, random: () => number): FieldItem[] | null {
  const counts = fieldCounts(lanes),
    items: FieldItem[] = [];
  for (const kind of ORDER) {
    const n = pick(counts[kind], random),
      r = G.items[kind].radius,
      top = F.minDepth + r,
      bottom = G.depth - F.margin - r,
      from = PREMIUM.includes(kind) ? top + (bottom - top) * DEEP_FROM : top;
    for (let k = 0; k < n; k++) {
      let placed = false;
      for (let tries = 0; tries < 80 && !placed; tries++) {
        const x = (random() * 2 - 1) * (G.width / 2 - F.margin - r),
          y = from + random() * (bottom - from);
        if (items.some((o) => Math.hypot(o.x - x, o.y - y) < o.r + r + F.gap)) continue;
        items.push({ kind, x, y, r, value: kind === "sack" ? sackValue(random) : G.items[kind].value });
        placed = true;
      }
      if (!placed) return null;
    }
  }
  return items;
}

/**
 * A round's mine for `lanes` players: random layouts until one follows every rule
 * (`fieldProblems`); if none does in `attempts`, the most balanced one that only misses the
 * balance rule (never seen in practice: the tests generate thousands).
 */
export function generateField(lanes: number, random: () => number): FieldItem[] {
  let best: FieldItem[] | null = null,
    bestScore = Infinity;
  for (let attempt = 0; attempt < F.attempts; attempt++) {
    const items = layout(lanes, random);
    if (!items) continue;
    const problems = fieldProblems(items, lanes);
    if (!problems.length) return items;
    if (problems.every((p) => p.startsWith("balance"))) {
      const score = imbalance(items, lanes);
      if (score < bestScore) {
        best = items;
        bestScore = score;
      }
    }
  }
  if (best) return best;
  throw new Error(`Altın Madenci: no mine for ${lanes} players`);
}
