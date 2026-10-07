import { boardSquares, EFFECT, isBoardLength, SQUARE_GROUPS, type BoardSquare, type SpecialType } from "./config.js";
import { rowPairs, SQUARE_SPACING } from "./layout.js";

/**
 * Where the special squares go: a fresh random layout for every match, drawn by the server.
 * Pure (randomness is an argument), so tests check the rules over many layouts.
 */
export const LAYOUT = {
  /** Squares right after the start and right before the treasure stay normal. */
  safeStart: 3,
  safeEnd: 2,
  /** Special squares: 20–25 % of the board's length. */
  share: [0.2, 0.25],
  /** Squares a ladder gains or a slide loses, per board length. */
  connectorRange: { 20: [4, 6], 35: [4, 10], 50: [4, 12] },
  /** Swap squares per board length. */
  swaps: { 20: 1, 35: 1, 50: 2 },
  /** Ladders and slides across the same gap keep at least this far apart (metres): never touching. */
  connectorGap: 1.5 * SQUARE_SPACING,
} as const;

const REWARDS = ["ladder", "forward", "bonus"] as const satisfies readonly SpecialType[];
const PENALTIES = ["slide", "back"] as const satisfies readonly SpecialType[];

/** Fewest and most special squares on a board of `length`. */
export const specialCount = (length: number): [number, number] => [Math.ceil(LAYOUT.share[0] * length), Math.floor(LAYOUT.share[1] * length)];
/** The squares a special may sit on. */
export const sourceRange = (length: number): [number, number] => [LAYOUT.safeStart + 1, length - 1 - LAYOUT.safeEnd];
export const connectorRange = (length: number): readonly [number, number] => (isBoardLength(length) ? LAYOUT.connectorRange[length] : [4, 10]);
export const swapCount = (length: number) => (isBoardLength(length) ? LAYOUT.swaps[length] : length >= 50 ? 2 : 1);

/** A possible ladder (lower row → upper row) or slide (upper → lower) between two rows. */
export interface Connector {
  type: "ladder" | "slide";
  from: number;
  to: number;
  /** The lower of the two rows it joins. */
  row: number;
  x: number;
}
/** Every ladder and slide the board's geometry allows within the length's range. */
export function connectorOptions(length: number): Connector[] {
  const [min, max] = connectorRange(length),
    [first, last] = sourceRange(length);
  const options: Connector[] = [];
  for (const pair of rowPairs(length)) {
    const gain = pair.upper - pair.lower;
    if (gain < min || gain > max) continue;
    if (pair.lower >= first && pair.lower <= last && pair.upper < length)
      options.push({ type: "ladder", from: pair.lower, to: pair.upper, row: pair.row, x: pair.x });
    if (pair.upper >= first && pair.upper <= last && pair.lower >= 1)
      options.push({ type: "slide", from: pair.upper, to: pair.lower, row: pair.row, x: pair.x });
  }
  return options;
}

const count = (types: readonly SpecialType[], type: SpecialType) => types.filter((t) => t === type).length;

/** The special types of one layout: level rewards and penalties, every type once when there is room. */
function pickTypes(length: number, random: () => number): SpecialType[] {
  const pick = <T>(list: readonly T[]) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  const shuffled = <T>(list: readonly T[]) => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.min(i, Math.floor(random() * (i + 1)));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const [min, max] = specialCount(length);
  const total = min + Math.min(max - min, Math.floor(random() * (max - min + 1)));
  const swaps = Math.min(swapCount(length), total);
  const rest = total - swaps;
  const rewards = rest % 2 === 0 ? rest / 2 : (rest + (random() < 0.5 ? 1 : -1)) / 2,
    penalties = rest - rewards;
  const types: SpecialType[] = [...shuffled(REWARDS).slice(0, Math.min(rewards, REWARDS.length)), ...shuffled(PENALTIES).slice(0, Math.min(penalties, PENALTIES.length))];
  while (count(types, "ladder") + count(types, "forward") + count(types, "bonus") < rewards) types.push(pick(REWARDS));
  while (count(types, "slide") + count(types, "back") < penalties) types.push(pick(PENALTIES));
  // Ladders and slides stay level (one apart at most): extras become İleri / bonus or Geri.
  while (count(types, "ladder") - count(types, "slide") > 1) types[types.lastIndexOf("ladder")] = pick(["forward", "bonus"] as const);
  while (count(types, "slide") - count(types, "ladder") > 1) types[types.lastIndexOf("slide")] = "back";
  for (let i = 0; i < swaps; i++) types.push("swap");
  return types;
}

/** Puts `types` on the board, most constrained first; null when this draw does not fit. */
function place(length: number, types: readonly SpecialType[], random: () => number): BoardSquare[] | null {
  const squares = boardSquares(length),
    [first, last] = sourceRange(length);
  const special = (i: number) => squares[i]?.type !== undefined && squares[i].type !== "normal";
  // Connector ends belong to one connector; every target stays a normal square.
  const ends = new Set<number>(),
    targets = new Set<number>(),
    connectors: Connector[] = [];
  const free = (i: number) => i >= first && i <= last && !special(i) && !ends.has(i) && !targets.has(i) && !special(i - 1) && !special(i + 1);
  const options = connectorOptions(length);
  const order: SpecialType[] = ["ladder", "slide", "forward", "back", "bonus", "swap"];
  for (const type of [...types].sort((a, b) => order.indexOf(a) - order.indexOf(b))) {
    let spots: { at: number; target: number; connector?: Connector }[];
    if (type === "ladder" || type === "slide")
      spots = options
        .filter((c) => c.type === type && free(c.from) && !special(c.to) && !ends.has(c.to) && connectors.every((o) => o.row !== c.row || Math.abs(o.x - c.x) >= LAYOUT.connectorGap))
        .map((c) => ({ at: c.from, target: c.to, connector: c }));
    else {
      spots = [];
      for (let at = first; at <= last; at++) {
        if (!free(at)) continue;
        const target = type === "forward" ? at + EFFECT.forward : type === "back" ? Math.max(0, at - EFFECT.back) : -1;
        if (target >= 0 && target < length && special(target)) continue;
        spots.push({ at, target });
      }
    }
    if (!spots.length) return null;
    // Of three random spots, the one furthest from the specials so far: the board stays spread out.
    const placed = squares.filter((s) => s.type !== "normal").map((s) => s.index);
    const room = (at: number) => (placed.length ? Math.min(...placed.map((p) => Math.abs(p - at))) : 0);
    let best = spots[Math.min(spots.length - 1, Math.floor(random() * spots.length))];
    for (let k = 0; k < 2; k++) {
      const other = spots[Math.min(spots.length - 1, Math.floor(random() * spots.length))];
      if (room(other.at) > room(best.at)) best = other;
    }
    squares[best.at] = { index: best.at, type, target: best.target };
    if (best.target >= 0) targets.add(best.target);
    if (best.connector) {
      ends.add(best.target);
      connectors.push(best.connector);
    }
  }
  return squares;
}

/** A fresh layout for a match. Always valid (squareProblems is empty); tests check that over many draws. */
export function generateSquares(length: number, random: () => number): BoardSquare[] {
  for (let attempt = 0; attempt < 500; attempt++) {
    const squares = place(length, pickTypes(length, random), random);
    if (squares && !squareProblems(squares, length).length) return squares;
  }
  // Never reached on the three board lengths; a plain board is still a playable board.
  return boardSquares(length);
}

/** Every layout rule a board breaks (empty: valid). Shared by the generator and the tests. */
export function squareProblems(squares: readonly BoardSquare[], length: number): string[] {
  const problems: string[] = [];
  if (squares.length !== length + 1 || squares.some((s, i) => s.index !== i)) return ["squares 0 … length, in order"];
  const specials = squares.filter((s) => s.type !== "normal") as (BoardSquare & { type: SpecialType })[];
  const types = specials.map((s) => s.type);
  const [min, max] = specialCount(length),
    [first, last] = sourceRange(length),
    [gainMin, gainMax] = connectorRange(length);
  if (specials.length < min || specials.length > max) problems.push(`${specials.length} specials, want ${min}–${max}`);
  const pairs = rowPairs(length);
  const connectors: Connector[] = [];
  for (const s of specials) {
    const at = s.index;
    if (at < first || at > last) problems.push(`${s.type} at ${at}: outside ${first}–${last}`);
    if (squares[at - 1]?.type !== "normal" || squares[at + 1]?.type !== "normal") problems.push(`${s.type} at ${at}: next to another special`);
    const want =
      s.type === "forward" ? at + EFFECT.forward
      : s.type === "back" ? Math.max(0, at - EFFECT.back)
      : s.type === "bonus" || s.type === "swap" ? -1
      : s.target;
    if (s.target !== want) problems.push(`${s.type} at ${at}: target ${s.target}, want ${want}`);
    if (s.type === "ladder" || s.type === "slide") {
      const pair = pairs.find((p) => (s.type === "ladder" ? p.lower === at && p.upper === s.target : p.upper === at && p.lower === s.target));
      const gain = Math.abs(s.target - at);
      if (!pair) problems.push(`${s.type} at ${at}: ${s.target} is not straight across the next row`);
      else connectors.push({ type: s.type, from: at, to: s.target, row: pair.row, x: pair.x });
      if (gain < gainMin || gain > gainMax) problems.push(`${s.type} at ${at}: ${gain} squares, want ${gainMin}–${gainMax}`);
      if (s.target < 1 || s.target >= length) problems.push(`${s.type} at ${at}: target ${s.target} off the path`);
    }
    // No chains, so no loops: every effect lands on a normal square (İleri may reach the treasure).
    if (s.target >= 0 && s.target < length && squares[s.target]?.type !== "normal") problems.push(`${s.type} at ${at}: targets the special at ${s.target}`);
  }
  const ends = connectors.map((c) => c.to);
  if (new Set(ends).size !== ends.length) problems.push("two ladders or slides share an end");
  for (const a of connectors)
    for (const b of connectors)
      if (a !== b && a.row === b.row && Math.abs(a.x - b.x) < LAYOUT.connectorGap - 1e-9) problems.push(`${a.type} ${a.from} and ${b.type} ${b.from} cross the same gap too close`);
  const swaps = count(types, "swap"),
    rewards = types.filter((t) => SQUARE_GROUPS[t] === "reward").length,
    penalties = types.filter((t) => SQUARE_GROUPS[t] === "penalty").length;
  if (swaps !== Math.min(swapCount(length), specials.length)) problems.push(`${swaps} swaps`);
  if (Math.abs(rewards - penalties) > 1) problems.push(`${rewards} rewards against ${penalties} penalties`);
  if (rewards >= REWARDS.length && REWARDS.some((t) => !types.includes(t))) problems.push("a reward type is missing");
  if (penalties >= PENALTIES.length && PENALTIES.some((t) => !types.includes(t))) problems.push("a penalty type is missing");
  if (Math.abs(count(types, "ladder") - count(types, "slide")) > 1) problems.push("ladders and slides are not level");
  return problems;
}
