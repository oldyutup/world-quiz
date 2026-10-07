import assert from "node:assert/strict";
import { test } from "node:test";
import { BOARD, BOARD_LENGTHS, boardSquares, EFFECT, effectSeconds, moveSeconds, SQUARE_GROUPS, type BoardSquare, type SpecialType } from "../../../shared/party-lab/board/config.js";
import { rowPairs } from "../../../shared/party-lab/board/layout.js";
import { BoardSession, type BoardHost } from "../../../shared/party-lab/board/session.js";
import { connectorRange, generateSquares, LAYOUT, specialCount, squareProblems, swapCount } from "../../../shared/party-lab/board/squares.js";
import { encodeBoard, parseBoard } from "../../../shared/party-lab/board/wire.js";
import type { GameMode } from "../../../shared/party-lab/modes.js";

const DT = 1 / 60;
function seeded(seed = 1) {
  return () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
}
/** Dice that return the queued values, then repeat the last one. */
function queued(...values: number[]) {
  let last = values[0] ?? 1;
  return () => (last = values.length ? values.shift()! : last);
}
class Host implements BoardHost {
  minis: GameMode[] = [];
  startMini(mode: GameMode) {
    this.minis.push(mode);
    return true;
  }
  endMini() {}
  connected() {
    return true;
  }
}
/** A board of `length` with only these specials ([square, type, target]); forward/back targets follow the rules. */
function layout(length: number, specials: [number, SpecialType, number?][]): BoardSquare[] {
  const squares = boardSquares(length);
  for (const [index, type, target] of specials)
    squares[index] = { index, type, target: target ?? (type === "forward" ? index + EFFECT.forward : type === "back" ? Math.max(0, index - EFFECT.back) : -1) };
  return squares;
}
function run(board: BoardSession, seconds: number) {
  for (let t = 0; t < Math.round(seconds / DT); t++) board.step(DT);
}
function until(board: BoardSession, done: () => boolean, limit = 600) {
  for (let t = 0; t < limit / DT && !done(); t++) board.step(DT);
  assert.ok(done(), `stuck in ${board.phase}`);
}
/**
 * A board whose pieces stand on `at` (slot → square), at the first roll of a round
 * without a mini game winner: everyone rolls one die, the player furthest behind first.
 */
function setup(length: number, specials: [number, SpecialType, number?][], at: number[], options: { die?: () => number; random?: () => number; winner?: number } = {}) {
  const host = new Host();
  const slots = at.map((_, slot) => slot);
  const board = new BoardSession(host, { length, slots, squares: layout(length, specials), die: options.die ?? queued(1), random: options.random ?? seeded(3) });
  at.forEach((square, slot) => board.pieces.set(slot, square));
  until(board, () => board.phase === "minigame");
  board.miniResult(options.winner ?? -1, null);
  until(board, () => board.phase === "roll" || board.phase === "choose");
  return { host, board };
}
/** The current player rolls; returns once the move is over (in the effect, or the next turn). */
function rollAndMove(board: BoardSession) {
  const slot = board.current;
  assert.ok(board.rollPressed(slot));
  run(board, moveSeconds(board.roll!.to - board.roll!.from));
  return slot;
}

test("layouts: thousands of random boards follow every rule", () => {
  for (const length of BOARD_LENGTHS) {
    const [min, max] = specialCount(length),
      [gainMin, gainMax] = connectorRange(length),
      pairs = rowPairs(length);
    const seen = { ladder: 0, slide: 0, sizes: new Set<number>() };
    for (let seed = 1; seed <= 3000; seed++) {
      const squares = generateSquares(length, seeded(seed));
      assert.deepEqual(squareProblems(squares, length), [], `${length}/${seed}`);
      // The main rules once more, written out.
      const specials = squares.filter((s) => s.type !== "normal");
      seen.sizes.add(specials.length);
      assert.ok(specials.length >= min && specials.length <= max && specials.length >= 0.2 * length && specials.length <= 0.25 * length);
      for (let i = 0; i <= LAYOUT.safeStart; i++) assert.equal(squares[i].type, "normal", "start and the first three squares");
      for (let i = length - LAYOUT.safeEnd; i <= length; i++) assert.equal(squares[i].type, "normal", "the last two squares and the treasure");
      const groups = specials.map((s) => SQUARE_GROUPS[s.type as SpecialType]);
      assert.ok(Math.abs(groups.filter((g) => g === "reward").length - groups.filter((g) => g === "penalty").length) <= 1);
      const swaps = groups.filter((g) => g === "neutral").length;
      assert.ok(swaps >= 1 && swaps <= 2 && swaps === swapCount(length));
      for (const s of specials) {
        // Every effect ends on a normal square (İleri may reach the treasure): no chain, no loop.
        if (s.target >= 0 && s.target < length) assert.equal(squares[s.target].type, "normal", `${length}/${seed}: ${s.type} ${s.index} → ${s.target}`);
        if (s.type === "ladder" || s.type === "slide") {
          const gain = Math.abs(s.target - s.index);
          assert.ok(gain >= gainMin && gain <= gainMax, `${length}: ${s.type} ${s.index} → ${s.target}`);
          assert.ok(pairs.some((p) => (s.type === "ladder" ? p.lower === s.index && p.upper === s.target : p.upper === s.index && p.lower === s.target)), "joins two rows straight across");
          seen[s.type]++;
        }
      }
    }
    assert.ok(seen.ladder > 0 && seen.slide > 0, `${length}: ladders and slides appear`);
    assert.deepEqual([...seen.sizes].sort((a, b) => a - b), Array.from({ length: max - min + 1 }, (_, i) => min + i), `${length}: every count in range is drawn`);
  }
  // Kısa keeps ladders and slides to 4–6 squares; the S path has room for them there.
  assert.deepEqual(connectorRange(20), [4, 6]);
  assert.deepEqual(connectorRange(35), [4, 10]);
  assert.deepEqual(connectorRange(50), [4, 12]);
});

test("layout rules catch broken boards", () => {
  const ok = generateSquares(35, seeded(5));
  assert.deepEqual(squareProblems(ok, 35), []);
  const broken = (edit: (squares: BoardSquare[]) => void) => {
    const squares = ok.map((s) => ({ ...s }));
    edit(squares);
    return squareProblems(squares, 35);
  };
  const free = (squares: BoardSquare[], from: number) => {
    let i = from;
    while (squares[i].type !== "normal" || squares[i - 1].type !== "normal" || squares[i + 1].type !== "normal") i++;
    return i;
  };
  assert.notDeepEqual(broken((s) => (s[2] = { index: 2, type: "bonus", target: -1 })), [], "a special in the first three squares");
  assert.notDeepEqual(broken((s) => (s[33] = { index: 33, type: "bonus", target: -1 })), [], "a special in the last two squares");
  assert.notDeepEqual(broken((s) => {
    const special = s.find((q) => q.type === "swap")!;
    s[special.index + 1] = { index: special.index + 1, type: "bonus", target: -1 };
  }), [], "two specials side by side");
  assert.notDeepEqual(broken((s) => {
    const ladder = s.find((q) => q.type === "ladder")!;
    ladder.target++;
  }), [], "a ladder to a square that is not straight across");
  assert.notDeepEqual(broken((s) => {
    const forward = s.find((q) => q.type === "forward")!;
    s[forward.target] = { index: forward.target, type: "back", target: forward.target - 3 };
  }), [], "an effect that targets another special");
  assert.notDeepEqual(broken((s) => {
    const at = free(s, 10);
    s[at] = { index: at, type: "swap", target: -1 };
  }), [], "an extra swap");
});

test("İleri, Geri, Merdiven, Kaydırak: the effect after the move, then the next turn", () => {
  // Kısa: ladder 4 → 8 and slide 16 → 12 are straight across two rows.
  const cases: { specials: [number, SpecialType, number?][]; from: number; die: number; to: number }[] = [
    { specials: [[6, "forward"]], from: 2, die: 4, to: 9 },
    { specials: [[9, "back"]], from: 3, die: 6, to: 6 },
    { specials: [[4, "ladder", 8]], from: 1, die: 3, to: 8 },
    { specials: [[16, "slide", 12]], from: 10, die: 6, to: 12 },
  ];
  for (const c of cases) {
    const { board } = setup(20, c.specials, [c.from, 19], { die: queued(c.die) });
    const slot = rollAndMove(board);
    assert.equal(board.phase, "effect", c.specials[0][1]);
    assert.equal(board.current, slot);
    assert.equal(board.square(slot), c.to);
    const effect = board.effect!;
    assert.deepEqual({ ...effect, seq: 0 }, { seq: 0, slot, type: c.specials[0][1], from: c.from + c.die, to: c.to, other: -1, gained: false });
    assert.deepEqual(parseBoard(encodeBoard(board.wire()))!.effect, effect);
    // Held for exactly effectSeconds, then the other player rolls.
    run(board, effectSeconds(effect) - 0.05);
    assert.equal(board.phase, "effect");
    run(board, 0.1);
    assert.equal(board.phase, "roll");
    assert.equal(board.current, 1);
    assert.equal(board.square(slot), c.to);
  }
  assert.equal(effectSeconds({ type: "forward", from: 6, to: 9, other: -1 }), EFFECT.leadSeconds + 3 * EFFECT.hopSeconds + EFFECT.settleSeconds);
  assert.equal(effectSeconds({ type: "ladder", from: 4, to: 8, other: -1 }), EFFECT.leadSeconds + EFFECT.climbSeconds + EFFECT.settleSeconds);
});

test("only an exact landing counts; passing over does nothing", () => {
  const { board } = setup(20, [[6, "forward"], [8, "slide", 4]], [4, 19], { die: queued(5) });
  const slot = rollAndMove(board);
  assert.equal(board.square(slot), 9, "passed the İleri and Kaydırak squares");
  assert.equal(board.effect, null);
  assert.equal(board.phase, "roll");
  assert.equal(board.current, 1);
});

test("no chains: the square an effect sends a player to never acts", () => {
  // Broken on purpose (the layout never does this): İleri onto a ladder, a slide onto Geri.
  for (const [specials, from, die, to] of [
    [[[5, "forward"], [8, "ladder", 12]], 1, 4, 8],
    [[[16, "slide", 12], [12, "back"]], 10, 6, 12],
    [[[7, "back"], [4, "ladder", 8]], 1, 6, 4],
  ] as [[number, SpecialType, number?][], number, number, number][]) {
    const { board } = setup(20, specials, [from, 19], { die: queued(die) });
    const slot = rollAndMove(board);
    assert.equal(board.phase, "effect");
    assert.equal(board.square(slot), to);
    run(board, effectSeconds(board.effect!) + 0.05);
    assert.equal(board.phase, "roll", "straight to the next turn");
    assert.equal(board.square(slot), to);
    assert.equal(board.effect!.seq, 1, "one effect");
  }
});

test("bounds: Geri stops at the start; İleri can reach the treasure and win; a roll past the treasure has no effect", () => {
  const back = setup(20, [[2, "back"]], [0, 19], { die: queued(2) }).board;
  const slot = rollAndMove(back);
  assert.equal(back.square(slot), 0, "never behind the start");
  assert.equal(back.effect!.to, 0);

  const win = setup(20, [[17, "forward"]], [12, 15], { die: queued(5) }).board;
  const mover = rollAndMove(win);
  assert.equal(mover, 0);
  assert.equal(win.phase, "effect");
  assert.equal(win.square(0), 20);
  run(win, effectSeconds(win.effect!) + 0.05);
  assert.equal(win.phase, "finished");
  assert.equal(win.winner, 0);
  assert.equal(win.reason, "treasure");

  const over = setup(20, [[17, "forward"]], [16, 18], { die: queued(6) }).board;
  rollAndMove(over);
  assert.equal(over.phase, "finished", "the treasure, not the square before it");
  assert.equal(over.effect, null);
});

test("bonus die: +1 on the next roll (also on top of two dice, +1 and auto rolls), never stacks, used once", () => {
  // Slot 0: 1 → 5 (bonus). Slot 1: 15 → 17. Slot 0: 5 + 1 = 6 → 11 (passes the bonus on 10).
  const { board } = setup(20, [[5, "bonus"], [10, "bonus"]], [1, 15], { die: queued(4, 2, 5) });
  const slot = rollAndMove(board);
  assert.equal(board.square(slot), 5);
  assert.deepEqual({ type: board.effect!.type, gained: board.effect!.gained, to: board.effect!.to }, { type: "bonus", gained: true, to: 5 });
  assert.deepEqual(board.wire().bonus, [slot]);
  run(board, effectSeconds(board.effect!) + 0.05);
  assert.equal(board.phase, "roll");
  rollAndMove(board);
  until(board, () => board.phase === "minigame");
  board.miniResult(-1, null);
  until(board, () => board.phase === "roll");
  assert.equal(board.current, slot);
  rollAndMove(board);
  assert.deepEqual({ value: board.roll!.value, bonus: board.roll!.bonus, dice: board.roll!.dice }, { value: 6, bonus: true, dice: [5] });
  assert.equal(board.square(slot), 11);
  assert.deepEqual(board.wire().bonus, [], "used up");

  // Bonus after bonus: the held one is used by the roll that lands on the next, so it is
  // always +1, never +2. 1 → 5 (bonus), 5 + (4 + 1) → 10 (bonus again), 10 + (3 + 1) → 14.
  const chain = setup(20, [[5, "bonus"], [10, "bonus"]], [1, 18], { die: queued(4) }).board;
  const values: number[] = [];
  for (const die of [4, 4, 3]) {
    (chain as unknown as { die: () => number }).die = queued(die);
    chain.pieces.set(1, 18);
    until(chain, () => (chain.phase === "roll" && chain.current === 0) || chain.phase === "minigame");
    if (chain.phase === "minigame") {
      chain.miniResult(-1, null);
      until(chain, () => chain.phase === "roll");
    }
    rollAndMove(chain);
    values.push(chain.roll!.value);
    assert.ok(chain.wire().bonus.length <= 1);
    if (chain.phase === "effect") run(chain, effectSeconds(chain.effect!) + 0.05);
    // Slot 1 sits out its turns on 18 (a roll there would reach the treasure).
    if (chain.phase === "roll" && chain.current === 1) {
      (chain as unknown as { die: () => number }).die = queued(1);
      chain.pieces.set(1, 7);
      rollAndMove(chain);
    }
  }
  assert.deepEqual(values, [4, 5, 4]);
  assert.equal(chain.square(0), 14);

  // The mini game winner: two dice keep the higher (+1 bonus), +1 adds one more: up to 8.
  for (const [choice, dice, value] of [["two", [3, 5], 6], ["plus", [6], 8]] as const) {
    const w = setup(20, [], [0, 0], { winner: 0, die: queued(...dice) }).board;
    w.bonus.add(0);
    assert.equal(w.phase, "choose");
    w.choose(0, choice);
    w.rollPressed(0);
    assert.deepEqual({ value: w.roll!.value, bonus: w.roll!.bonus }, { value, bonus: true }, choice);
    assert.ok(parseBoard(encodeBoard(w.wire())), "a value of 8 is a valid roll");
  }
  // Auto roll on timeout uses it too.
  const auto = setup(20, [], [0, 3], { die: queued(2) }).board;
  auto.bonus.add(0);
  run(auto, BOARD.rollSeconds + 0.05);
  assert.deepEqual({ auto: auto.roll!.auto, value: auto.roll!.value, bonus: auto.roll!.bonus }, { auto: true, value: 3, bonus: true });
});

test("swap: a random player on another square (2, 3 and 6 players); nobody else there means no swap", () => {
  // Two players: always the other one.
  const two = setup(20, [[6, "swap"]], [2, 12], { die: queued(4) }).board;
  rollAndMove(two);
  assert.deepEqual({ type: two.effect!.type, other: two.effect!.other, from: two.effect!.from, to: two.effect!.to }, { type: "swap", other: 1, from: 6, to: 12 });
  assert.equal(two.square(0), 12);
  assert.equal(two.square(1), 6);

  // Everyone on the swap square already: nobody to swap with.
  const alone = setup(20, [[6, "swap"]], [2, 6, 6], { die: queued(4) }).board;
  rollAndMove(alone);
  assert.equal(alone.effect!.other, -1);
  assert.deepEqual([alone.square(0), alone.square(1), alone.square(2)], [6, 6, 6]);
  assert.equal(effectSeconds(alone.effect!), EFFECT.leadSeconds + EFFECT.stillSeconds + EFFECT.settleSeconds);

  // Three and six players: never the mover, never someone on the same square, every other one about as often.
  for (const at of [[2, 9, 14], [2, 9, 14, 6, 11, 17]]) {
    const picked = new Map<number, number>();
    const trials = 1200;
    for (let k = 0; k < trials; k++) {
      const board = setup(20, [[6, "swap"]], at, { die: queued(4), random: seeded(100 + k) }).board;
      const slot = rollAndMove(board);
      assert.equal(slot, 0);
      const other = board.effect!.other;
      assert.ok(other > 0 && board.square(0) === at[other] && board.square(other) === 6, `${at.length}P: swapped with ${other}`);
      picked.set(other, (picked.get(other) ?? 0) + 1);
    }
    const eligible = at.map((sq, slot) => slot).filter((slot) => slot !== 0 && at[slot] !== 6);
    assert.deepEqual([...picked.keys()].sort(), eligible, `${at.length}P: someone on square 6 is never picked`);
    for (const slot of eligible) assert.ok(Math.abs(picked.get(slot)! / trials - 1 / eligible.length) < 0.06, `${at.length}P slot ${slot}: ${picked.get(slot)}`);
  }
});

test("leaving mid-effect: the board moves on; a leaver's bonus is gone", () => {
  const { board } = setup(20, [[6, "forward"]], [2, 12, 14], { die: queued(4) });
  const slot = rollAndMove(board);
  assert.equal(board.phase, "effect");
  board.bonus.add(slot);
  board.remove(slot);
  assert.equal(board.phase, "roll");
  assert.equal(board.has(slot), false);
  assert.deepEqual(board.wire().bonus, []);
});

test("wire: the layout, bonus dice and the latest effect round-trip; junk refused", () => {
  for (const length of BOARD_LENGTHS) {
    const board = new BoardSession(new Host(), { length, slots: [0, 1, 2], random: seeded(length) });
    const wire = board.wire();
    assert.ok(wire.squares.length >= specialCount(length)[0]);
    assert.deepEqual(wire.squares, board.squares.filter((s) => s.type !== "normal").map((s) => [s.index, s.type, s.target]));
    assert.deepEqual(parseBoard(encodeBoard(wire)), wire);
    assert.ok(encodeBoard(wire).length < 1500, `${length}: ${encodeBoard(wire).length} characters`);
  }
  const { board } = setup(20, [[6, "forward"]], [2, 12], { die: queued(4) });
  rollAndMove(board);
  const wire = board.wire();
  assert.deepEqual(parseBoard(encodeBoard(wire)), wire);
  for (const junk of [
    { ...wire, squares: [[6, "teleport", 9]] },
    { ...wire, squares: [[6, "forward", 9], [6, "back", 3]] },
    { ...wire, squares: [[0, "forward", 3]] },
    { ...wire, bonus: [9] },
    { ...wire, effect: { ...wire.effect!, type: "normal" } },
    { ...wire, effect: { ...wire.effect!, gained: 1 } },
    { ...wire, roll: { ...wire.roll!, value: 9 } },
    { ...wire, roll: { ...wire.roll!, bonus: undefined } },
    { ...wire, phase: "teleport" },
  ])
    assert.equal(parseBoard(JSON.stringify(junk)), null, JSON.stringify(junk).slice(0, 120));
});
