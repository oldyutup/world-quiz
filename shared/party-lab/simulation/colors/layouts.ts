import { COLOR_NEIGHBOURS, COLOR_SPAWN_TILES, COLOR_SYMMETRIES, COLOR_TILE_COUNT, colorRotation } from "../../maps/colors.js";
import { COLOR_INDICES, type ColorIndex } from "./config.js";
import { CYCLE_LAYOUTS, OPENING_LAYOUTS, SHRINK_LAYOUTS } from "./layoutBank.js";
import { STAGE_MASKS } from "./shrink.js";

/** A colour (0…3) per tile id; NO_COLOR for a tile without one (gone, or about to go). */
export type ColorLayout = Uint8Array;
/** A tile with no colour: outside the stage's field, or standing grey through its last cycle. */
export const NO_COLOR = 255;

/** Small deterministic PRNG (mulberry32): the same seed gives the same sequence on every JS engine. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * What every layout must satisfy (checked for every bank layout by colors.test.ts):
 * - balanced: tile counts per colour differ by at most `spread` (85 tiles: 21/21/21/22 ideal);
 * - clustered, never isolated: every same-colour connected group has `minGroup`…`maxGroup` tiles;
 * - spread out: every colour has at least `minGroups` separate groups;
 * - reachable: from EVERY tile, every colour is at most `reach` steps away (so from every
 *   spawn and wherever a survivor stands after a drop, every target is fair). Two steps is
 *   ≤ 4.3 m to be 0.3 m inside the tile from anywhere on the own tile.
 * - the smaller shrink fields also need every colour's largest patch to be ≥ `minLargest`.
 */
export interface LayoutRules {
  readonly spread: number;
  readonly minGroup: number;
  readonly maxGroup: number;
  readonly minGroups: number;
  readonly reach: number;
  readonly minLargest: number;
}
export const LAYOUT_RULES: LayoutRules = { spread: 2, minGroup: 2, maxGroup: 7, minGroups: 3, reach: 2, minLargest: 2 };
/**
 * The same rules for each shrink stage that has colour layouts (0 whole field … 6 the
 * middle seven): smaller fields take smaller and fewer patches; reach stays 2 steps.
 * From 31 tiles on, reach across the grey ring of the cut cycle cannot be kept with pairs
 * only, so single tiles are allowed there (rare: the designer avoids them), but every
 * colour keeps a patch of ≥ 2 and ≥ 2 patches. The seven-tile finale is 2/2/2/1.
 */
export const STAGE_RULES: readonly LayoutRules[] = [
  LAYOUT_RULES, // 85 tiles
  { spread: 2, minGroup: 2, maxGroup: 7, minGroups: 3, reach: 2, minLargest: 2 }, // 73
  { spread: 2, minGroup: 2, maxGroup: 6, minGroups: 3, reach: 2, minLargest: 2 }, // 61
  { spread: 2, minGroup: 2, maxGroup: 5, minGroups: 2, reach: 2, minLargest: 2 }, // 43
  { spread: 2, minGroup: 1, maxGroup: 4, minGroups: 2, reach: 2, minLargest: 2 }, // 31
  { spread: 2, minGroup: 1, maxGroup: 3, minGroups: 2, reach: 2, minLargest: 2 }, // 19
  { spread: 1, minGroup: 1, maxGroup: 2, minGroups: 1, reach: 2, minLargest: 1 }, // 7
];
/** Shrink stages with colour layout banks (0…6); stage 7 is the middle tile alone, 8 none. */
export const LAYOUT_STAGE_COUNT = STAGE_RULES.length;

/** Same-colour connected groups (tile ids), in tile order. */
export function colorGroups(layout: ColorLayout) {
  const seen = new Uint8Array(layout.length),
    groups: { color: ColorIndex; tiles: number[] }[] = [];
  for (let start = 0; start < layout.length; start++) {
    if (seen[start] || layout[start] === NO_COLOR) continue;
    const color = layout[start] as ColorIndex,
      tiles = [start];
    seen[start] = 1;
    for (let i = 0; i < tiles.length; i++)
      for (const n of COLOR_NEIGHBOURS[tiles[i]])
        if (!seen[n] && layout[n] === color) {
          seen[n] = 1;
          tiles.push(n);
        }
    groups.push({ color, tiles });
  }
  return groups;
}

/**
 * Steps (across neighbouring coloured tiles) from every coloured tile to the nearest tile
 * of each colour; 255 for tiles without a colour.
 */
export function colorReach(layout: ColorLayout): Uint8Array[] {
  return COLOR_INDICES.map((color) => {
    const distance = new Uint8Array(layout.length).fill(255),
      queue: number[] = [];
    layout.forEach((c, id) => {
      if (c === color) {
        distance[id] = 0;
        queue.push(id);
      }
    });
    for (let i = 0; i < queue.length; i++)
      for (const n of COLOR_NEIGHBOURS[queue[i]])
        if (distance[n] === 255 && layout[n] !== NO_COLOR) {
          distance[n] = distance[queue[i]] + 1;
          queue.push(n);
        }
    return distance;
  });
}

/**
 * Steps to each colour through the PREVIOUS stage's field (stage > 0): in the cycle a
 * stage is cut, the tiles it drops stand grey through the reaction time, so a player on
 * one (or crossing them) walks over them to a coloured tile. Per colour, per tile id;
 * 255 outside that field (and everywhere for stage 0).
 */
export function edgeReach(layout: ColorLayout, stage: number): Uint8Array[] {
  return COLOR_INDICES.map((color) => {
    const distance = new Uint8Array(layout.length).fill(255);
    if (stage === 0) return distance;
    const field = STAGE_MASKS[stage - 1],
      queue: number[] = [];
    layout.forEach((c, id) => {
      if (c === color) {
        distance[id] = 0;
        queue.push(id);
      }
    });
    for (let i = 0; i < queue.length; i++)
      for (const n of COLOR_NEIGHBOURS[queue[i]])
        if (distance[n] === 255 && field[n]) {
          distance[n] = distance[queue[i]] + 1;
          queue.push(n);
        }
    return distance;
  });
}

export function colorCounts(layout: ColorLayout) {
  const counts = [0, 0, 0, 0];
  for (const c of layout) if (c !== NO_COLOR) counts[c]++;
  return counts;
}

export interface LayoutCheck {
  ok: boolean;
  problems: string[];
  counts: number[];
  /** Group sizes per colour. */
  groups: number[][];
  /** Largest steps from any tile to the nearest tile of any colour. */
  worstReach: number;
}
/**
 * Every rule for a layout of shrink stage `stage` (default: the whole field): a colour on
 * exactly the stage's tiles, balance, patch sizes and counts, and reach — within the
 * stage (its later cycles), and across the previous stage's field (its cut cycle, when
 * the dropped ring still stands grey: edgeReach).
 */
export function checkLayout(layout: ColorLayout, stage = 0): LayoutCheck {
  const problems: string[] = [],
    rules = STAGE_RULES[stage],
    mask = STAGE_MASKS[stage];
  if (layout.length !== COLOR_TILE_COUNT) problems.push(`length ${layout.length}`);
  layout.forEach((c, id) => {
    if ((c === NO_COLOR) === !!mask[id] || (c !== NO_COLOR && c > 3)) problems.push(`tile ${id}: colour ${c}`);
  });
  const counts = colorCounts(layout);
  if (Math.max(...counts) - Math.min(...counts) > rules.spread) problems.push(`unbalanced ${counts.join("/")}`);
  const groups = COLOR_INDICES.map(() => [] as number[]);
  for (const g of colorGroups(layout)) groups[g.color].push(g.tiles.length);
  COLOR_INDICES.forEach((color) => {
    const sizes = groups[color];
    if (sizes.length < rules.minGroups) problems.push(`colour ${color}: ${sizes.length} groups`);
    if (Math.max(0, ...sizes) < rules.minLargest) problems.push(`colour ${color}: largest patch ${Math.max(0, ...sizes)}`);
    for (const size of sizes) if (size < rules.minGroup || size > rules.maxGroup) problems.push(`colour ${color}: group of ${size}`);
  });
  let worstReach = 0;
  const reach = colorReach(layout);
  for (const distance of reach) distance.forEach((d, id) => mask[id] && (worstReach = Math.max(worstReach, d)));
  if (stage > 0) for (const distance of edgeReach(layout, stage)) distance.forEach((d, id) => STAGE_MASKS[stage - 1][id] && (worstReach = Math.max(worstReach, d)));
  if (worstReach > rules.reach) problems.push(`reach ${worstReach}`);
  return { ok: problems.length === 0, problems, counts, groups, worstReach };
}

/** Orbits of a stage's tiles under a rotation of `order` (1: every tile its own orbit). */
function orbits(order: 1 | 2 | 3, stage = 0) {
  const rotation = colorRotation(order),
    mask = STAGE_MASKS[stage],
    orbitOf = new Int16Array(COLOR_TILE_COUNT).fill(-1),
    list: number[][] = [];
  for (let id = 0; id < COLOR_TILE_COUNT; id++) {
    if (orbitOf[id] >= 0 || !mask[id]) continue;
    const members: number[] = [];
    for (let t = id; orbitOf[t] < 0; t = rotation[t]) {
      orbitOf[t] = list.length;
      members.push(t);
    }
    list.push(members);
  }
  return { orbitOf, list };
}

/** Penalty of a layout: hard rule breaks weigh 10+ (a valid layout has hard = 0), soft preferences less. */
export function layoutPenalty(layout: ColorLayout, stage = 0) {
  let hard = 0,
    soft = 0;
  const rules = STAGE_RULES[stage],
    mask = STAGE_MASKS[stage],
    perColor = [0, 0, 0, 0],
    largest = [0, 0, 0, 0];
  for (const { color, tiles } of colorGroups(layout)) {
    perColor[color]++;
    const size = tiles.length;
    largest[color] = Math.max(largest[color], size);
    if (size < rules.minGroup) hard += 10;
    if (size > rules.maxGroup) hard += 5 * (size - rules.maxGroup);
    // Patches of 3–5 read best: a pair is a small target, 6–7 a big blob; a single tile
    // (allowed only on the small shrink fields) is kept as rare as the rules let it be.
    if (size === 2 || size >= 6) soft += 0.4;
    else if (size === 1 && rules.minGroup < 2) soft += 1.5;
  }
  for (const n of perColor) if (n < rules.minGroups) hard += 10 * (rules.minGroups - n);
  if (rules.minLargest > rules.minGroup) for (const n of largest) if (n < rules.minLargest) hard += 10;
  const reach = colorReach(layout);
  for (const distance of reach) distance.forEach((d, id) => mask[id] && d > rules.reach && (hard += 10 * (d - rules.reach)));
  if (stage > 0)
    for (const distance of edgeReach(layout, stage)) distance.forEach((d, id) => STAGE_MASKS[stage - 1][id] && d > rules.reach && (hard += 10 * (d - rules.reach)));
  return { hard, soft, total: hard + soft };
}

/**
 * Designs one layout by simulated annealing from a seed: a shuffled start with exact
 * counts (one colour 22, three 21), then swaps of two tiles of different colours (so the
 * balance never changes), accepted by the Metropolis rule on `layoutPenalty`. With
 * `order` 2 or 3 the swaps exchange whole orbits of a rotation (the middle tile keeps its
 * colour), so the layout keeps that rotation symmetry and its spawns stay equal. Returns
 * the best layout found (check `checkLayout` — the bank script keeps only valid ones).
 */
export function designLayout(seed: number, order: 1 | 2 | 3 = 1, iterations = 24000, stage = 0): ColorLayout {
  const random = mulberry32(seed),
    { list } = orbits(order, stage);
  // Exact counts: orbits of `order` tiles (plus the middle tile for 2 and 3).
  const sizes = list.map((o) => o.length),
    colors = new Uint8Array(list.length),
    shuffled = list.map((_, i) => i);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const counts = [0, 0, 0, 0],
    goal = Math.floor(sizes.reduce((n, s) => n + s, 0) / 4);
  // Largest orbits first, each to the colour furthest below its share.
  for (const o of [...shuffled].sort((a, b) => sizes[b] - sizes[a])) {
    let c = 0;
    for (let k = 1; k < 4; k++) if (goal - counts[k] > goal - counts[c] + (random() - 0.5) * 1e-3) c = k;
    colors[o] = c;
    counts[c] += sizes[o];
  }
  const layout = new Uint8Array(COLOR_TILE_COUNT).fill(NO_COLOR);
  const paint = () => list.forEach((tiles, o) => tiles.forEach((t) => (layout[t] = colors[o])));
  paint();
  let current = layoutPenalty(layout, stage).total,
    best = current;
  const bestLayout = Uint8Array.from(layout),
    swappable = list.map((_, o) => o).filter((o) => sizes[o] === order);
  for (let i = 0; i < iterations && best > 0; i++) {
    const a = swappable[Math.floor(random() * swappable.length)],
      b = swappable[Math.floor(random() * swappable.length)];
    if (colors[a] === colors[b]) continue;
    [colors[a], colors[b]] = [colors[b], colors[a]];
    for (const t of list[a]) layout[t] = colors[a];
    for (const t of list[b]) layout[t] = colors[b];
    const next = layoutPenalty(layout, stage).total,
      temperature = 2.5 * (1 - i / iterations) + 0.05;
    if (next <= current || random() < Math.exp((current - next) / temperature)) {
      current = next;
      if (current < best) {
        best = current;
        bestLayout.set(layout);
      }
    } else {
      [colors[a], colors[b]] = [colors[b], colors[a]];
      for (const t of list[a]) layout[t] = colors[a];
      for (const t of list[b]) layout[t] = colors[b];
    }
  }
  return bestLayout;
}

/** A layout as 85 characters in tile order (a digit per colour, "." for none), the bank's storage form. */
export const encodeLayout = (layout: ColorLayout) => Array.from(layout, (c) => (c === NO_COLOR ? "." : String(c))).join("");
export const decodeLayout = (digits: string): ColorLayout => Uint8Array.from(digits, (d) => (d === "." ? NO_COLOR : Number(d)));

/** Cycles after the first: free (no symmetry) layouts. */
export const CYCLE_LAYOUT_COUNT = CYCLE_LAYOUTS.length;
/** First cycle of a round: rotation-symmetric layouts, so every spawn starts equal. */
export const OPENING_LAYOUT_COUNT = OPENING_LAYOUTS[3].length;
let banks: { cycle: ColorLayout[]; opening: Record<2 | 3, ColorLayout[]>; stages: ColorLayout[][] } | null = null;
/**
 * The layout banks (layoutBank.ts, designed offline by
 * scripts/build-party-lab-color-layouts.ts from fixed seeds, so a server and its clients
 * agree): free layouts for ordinary cycles; third-turn symmetric openings for three
 * players and half-turn symmetric ones for two, each mapping the spawns onto each other;
 * free layouts of each shrink stage's smaller field (`stages[k]`, stage 0 = `cycle`).
 */
export function colorLayoutBanks() {
  if (!banks) {
    const cycle = CYCLE_LAYOUTS.map(decodeLayout);
    banks = {
      cycle,
      opening: { 3: OPENING_LAYOUTS[3].map(decodeLayout), 2: OPENING_LAYOUTS[2].map(decodeLayout) },
      stages: [cycle, ...SHRINK_LAYOUTS.map((bank) => bank.map(decodeLayout))],
    };
  }
  return banks;
}

/**
 * How a bank layout is shown in one cycle: one of the field's twelve symmetries and a
 * permutation of the colours. Both keep every LAYOUT_RULE (and an opening's symmetry),
 * so each bank layout can be shown 12 × 24 ways.
 */
export interface LayoutPick {
  bank: "cycle" | "opening";
  /** Shrink stage of a cycle layout (0 = the whole field). */
  stage: number;
  index: number;
  symmetry: number;
  /** Bank colour k is shown as `palette[k]`. */
  palette: readonly ColorIndex[];
}
export function applyPick(pick: LayoutPick, players: 2 | 3): ColorLayout {
  const banks = colorLayoutBanks(),
    source = pick.bank === "cycle" ? banks.stages[pick.stage][pick.index] : banks.opening[players][pick.index],
    map = COLOR_SYMMETRIES[pick.symmetry],
    out = new Uint8Array(COLOR_TILE_COUNT);
  for (let id = 0; id < COLOR_TILE_COUNT; id++) out[map[id]] = source[id] === NO_COLOR ? NO_COLOR : pick.palette[source[id]];
  return out;
}

/** Spawn tiles of a match all see the same colours at the same distances (an opening's promise). */
export function spawnsEquivalent(layout: ColorLayout, players: 2 | 3) {
  const reach = colorReach(layout),
    spawns = COLOR_SPAWN_TILES[players];
  const profile = (tile: number) => `${layout[tile]}|${reach.map((d) => d[tile]).join(",")}`;
  return spawns.every((tile) => profile(tile) === profile(spawns[0]));
}
