import assert from "node:assert/strict";
import { test } from "node:test";
import { BoardSession, type BoardHost } from "../../../shared/party-lab/board/session.js";
import { BOARD, BOARD_LENGTHS, boardSquares, moveSeconds } from "../../../shared/party-lab/board/config.js";
import { dieFrom, eliminationRanks, moveOrder, ranksByScore, rollDice, seatRanks } from "../../../shared/party-lab/board/rules.js";
import { encodeBoard, parseBoard } from "../../../shared/party-lab/board/wire.js";
import { boardPath, numberedSquare, pawnOffset, SQUARE_SIZE } from "../../../shared/party-lab/board/layout.js";
import { BoardRotation, GAME_MODES, MixedRotation, modeFits, type GameMode } from "../../../shared/party-lab/modes.js";

const DT = 1 / 60;
function seeded(seed = 1) {
  return () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
}
/** Dice that return the queued values (then repeat the last). */
function queued(...values: number[]) {
  let last = values[0] ?? 1;
  return () => (last = values.length ? values.shift()! : last);
}
class Host implements BoardHost {
  minis: { mode: GameMode; slots: number[] }[] = [];
  ended = 0;
  away = new Set<number>();
  refuse = false;
  startMini(mode: GameMode, slots: readonly number[]) {
    this.minis.push({ mode, slots: [...slots] });
    return !this.refuse;
  }
  endMini() {
    this.ended++;
  }
  connected(slot: number) {
    return !this.away.has(slot);
  }
}
function run(board: BoardSession, seconds: number) {
  for (let t = 0; t < Math.round(seconds / DT); t++) board.step(DT);
}
/** Run until the phase changes (bounded). */
function until(board: BoardSession, phase: string, limit = 600) {
  for (let t = 0; t < limit / DT && board.phase !== phase; t++) board.step(DT);
  assert.equal(board.phase, phase);
}
/** A board without special squares: these tests are about turns and dice (boardSquares.test.ts has the specials). */
function make(slots: number[], options: { die?: () => number; random?: () => number; length?: number } = {}) {
  const host = new Host(),
    length = options.length ?? 20;
  const board = new BoardSession(host, { length, slots, random: options.random ?? seeded(7), die: options.die ?? queued(3), squares: boardSquares(length) });
  return { host, board };
}

test("dice: one die is uniform 1–6, two dice keep the higher (P(k) = (2k−1)/36), +1 is 2–7", () => {
  const two = new Map<number, number>(), plus = new Map<number, number>(), single = new Map<number, number>();
  for (let a = 1; a <= 6; a++) {
    for (let b = 1; b <= 6; b++) {
      const r = rollDice("two", queued(a, b));
      assert.deepEqual(r.dice, [a, b]);
      two.set(r.value, (two.get(r.value) ?? 0) + 1);
    }
    plus.set(rollDice("plus", queued(a)).value, 1);
    single.set(rollDice("single", queued(a)).value, 1);
  }
  for (let k = 1; k <= 6; k++) assert.equal(two.get(k), 2 * k - 1);
  assert.deepEqual([...plus.keys()].sort((a, b) => a - b), [2, 3, 4, 5, 6, 7]);
  assert.deepEqual([...single.keys()].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  // A real die from a random source: every face, close to 1/6 each over 60 000 rolls.
  const die = dieFrom(seeded(99)), counts = Array(7).fill(0);
  for (let i = 0; i < 60000; i++) counts[die()]++;
  assert.equal(counts[0], 0);
  for (let k = 1; k <= 6; k++) assert.ok(Math.abs(counts[k] / 60000 - 1 / 6) < 0.01, `face ${k}: ${counts[k]}`);
  const best = Array(7).fill(0), d2 = dieFrom(seeded(5));
  for (let i = 0; i < 72000; i++) best[rollDice("two", d2).value]++;
  for (let k = 1; k <= 6; k++) assert.ok(Math.abs(best[k] / 72000 - (2 * k - 1) / 36) < 0.01, `two dice ${k}: ${best[k]}`);
  // The "two dice" choice is worth more on average than "+1", which beats a plain die.
  assert.ok(161 / 36 > 3.5 && 4.5 > 161 / 36);
});

test("placements: competition ranks, seat → slot mapping, eliminations", () => {
  assert.deepEqual(ranksByScore([10, 30, 30, null]), [2, 0, 0, -1]);
  assert.deepEqual(seatRanks([0, 2], [5, 9], 3), [1, -1, 0]);
  // Slot 1 still standing, slot 0 out at tick 400, slot 2 out at tick 100.
  assert.deepEqual(eliminationRanks([400, -1, 100], 0b111), [1, 0, 2]);
  assert.deepEqual(eliminationRanks([400, -1, 100], 0b011), [1, 0, -1]);
});

test("move order: winner first, then placements, then whoever is behind, then random", () => {
  const squares = new Map([[0, 5], [1, 2], [2, 9], [3, 2]]);
  const at = (slot: number) => squares.get(slot)!;
  // Full placements after the winner (slot 2), regardless of squares.
  assert.deepEqual(moveOrder([0, 1, 2, 3], at, 2, [1, 3, 0, 2], seeded()), [2, 0, 3, 1]);
  // No placements: winner first, the rest behind-first (1 and 3 share square 2: random).
  const orders = new Set<string>();
  for (let s = 1; s < 40; s++) {
    const order = moveOrder([0, 1, 2, 3], at, 0, null, seeded(s));
    assert.equal(order[0], 0);
    assert.deepEqual(order.slice(1).map(at), [2, 2, 9]);
    orders.add(order.join());
  }
  assert.equal(orders.size, 2);
  // A draw: nobody first; tied places fall back to the board.
  assert.deepEqual(moveOrder([0, 1, 2], at, -1, [0, 0, 0], seeded()), [1, 0, 2]);
  assert.deepEqual(moveOrder([0, 1, 2], at, -1, null, seeded()), [1, 0, 2]);
});

test("board squares and wire: typed squares, round-trip, junk refused", () => {
  for (const length of BOARD_LENGTHS) {
    const squares = boardSquares(length);
    assert.equal(squares.length, length + 1);
    assert.ok(squares.every((s, i) => s.index === i && s.type === "normal"));
  }
  const { board } = make([0, 1]);
  const parsed = parseBoard(encodeBoard(board.wire()));
  assert.deepEqual(parsed, board.wire());
  assert.equal(encodeBoard(null), "");
  for (const junk of ["", "{", "[]", JSON.stringify({ ...board.wire(), length: 21 }), JSON.stringify({ ...board.wire(), pieces: [[0, 99]] }),
    JSON.stringify({ ...board.wire(), mode: "mixed" }), JSON.stringify({ ...board.wire(), roll: { seq: 1, slot: 0, kind: "two", dice: [3], value: 3, from: 0, to: 3, auto: false } })])
    assert.equal(parseBoard(junk), null, junk);
});

test("a 2P round: intro → mini game → 5 s results → winner chooses → rolls → others roll in order", () => {
  const { host, board } = make([0, 2], { die: queued(4, 2, 5) });
  assert.equal(board.phase, "intro");
  assert.deepEqual(board.wire().pieces, [[0, 0], [2, 0]]);
  run(board, BOARD.introSeconds);
  assert.equal(board.phase, "minigame");
  assert.deepEqual(host.minis[0].slots, [0, 2]);
  assert.ok(modeFits(host.minis[0].mode, 2), "the mini game fits two players");
  run(board, 20);
  board.miniResult(2, [1, -1, 0]);
  assert.equal(board.wire().mini, "results");
  run(board, BOARD.miniResultsSeconds - 0.1);
  assert.equal(host.ended, 0);
  run(board, 0.2);
  assert.equal(host.ended, 1);
  assert.equal(board.phase, "choose");
  assert.deepEqual(board.order, [2, 0]);
  assert.equal(board.current, 2);
  assert.equal(board.first, 2);
  // Not your turn / not a choice.
  assert.equal(board.choose(0, "plus"), false);
  assert.equal(board.choose(2, "three"), false);
  assert.equal(board.rollPressed(2), false);
  assert.equal(board.choose(2, "two"), true);
  assert.equal(board.phase, "roll");
  assert.equal(board.rollPressed(0), false);
  assert.equal(board.rollPressed(2), true);
  assert.deepEqual(board.roll, { seq: 1, slot: 2, kind: "two", dice: [4, 2], value: 4, bonus: false, from: 0, to: 4, auto: false });
  assert.equal(board.square(2), 4);
  assert.equal(board.phase, "move");
  run(board, moveSeconds(4) - 0.05);
  assert.equal(board.phase, "move");
  run(board, 0.1);
  assert.equal(board.phase, "roll");
  assert.equal(board.current, 0);
  board.rollPressed(0);
  assert.equal(board.roll!.kind, "single");
  assert.equal(board.roll!.value, 5);
  until(board, "intro");
  assert.equal(board.round, 2);
  assert.deepEqual(board.order, []);
  // The next mini game is never the one just played.
  run(board, BOARD.introSeconds);
  assert.notEqual(host.minis[1].mode, host.minis[0].mode);
});

test("+1 choice, and a draw or no winner: everyone rolls one die, the one behind first", () => {
  const { board } = make([0, 1, 2], { die: queued(6) });
  run(board, BOARD.introSeconds);
  board.miniResult(1, null);
  run(board, BOARD.miniResultsSeconds);
  board.choose(1, "plus");
  board.rollPressed(1);
  assert.deepEqual(board.roll!.dice, [6]);
  assert.equal(board.roll!.value, 7);
  assert.equal(board.square(1), 7);
  until(board, "intro");
  run(board, BOARD.introSeconds);
  board.miniResult(-1, [0, 0, 1]);
  run(board, BOARD.miniResultsSeconds);
  assert.equal(board.first, -1);
  assert.equal(board.phase, "roll", "no choice without a winner");
  // Tied on top (0 and 2... slot 0 and 1 share place 0): the one behind (slot 0, square 6) goes first.
  assert.deepEqual(board.order.slice(0, 2), [0, 1]);
  board.rollPressed(board.current);
  assert.equal(board.roll!.kind, "single");
});

test("passing the treasure counts; the first to reach it wins at once and nobody else moves", () => {
  const { host, board } = make([0, 1, 2], { die: queued(6), length: 20 });
  board.pieces.set(0, 17);
  board.pieces.set(1, 19);
  run(board, BOARD.introSeconds);
  board.miniResult(0, [0, 1, 2]);
  run(board, BOARD.miniResultsSeconds);
  board.choose(0, "two");
  board.rollPressed(0);
  assert.equal(board.roll!.to, 20, "capped at the treasure");
  assert.equal(board.roll!.value, 6);
  run(board, moveSeconds(3));
  assert.equal(board.phase, "finished");
  assert.equal(board.winner, 0);
  assert.equal(board.reason, "treasure");
  assert.equal(board.square(1), 19, "slot 1 never rolled");
  assert.equal(board.rollPressed(1), false);
  run(board, BOARD.finishSeconds - 0.1);
  assert.equal(board.done, false);
  run(board, 0.2);
  assert.equal(board.done, true);
  assert.equal(host.minis.length, 1);
});

test("time-outs: no choice in 10 s → two dice; no roll in 10 s → the server rolls", () => {
  const { board } = make([0, 1], { die: queued(1, 5, 2) });
  run(board, BOARD.introSeconds);
  board.miniResult(1, null);
  run(board, BOARD.miniResultsSeconds);
  assert.equal(board.phase, "choose");
  assert.equal(board.wire().left, 10);
  run(board, BOARD.chooseSeconds - 0.1);
  assert.equal(board.phase, "choose");
  run(board, 0.2);
  assert.equal(board.phase, "roll");
  assert.equal(board.choice, "two");
  // The choice landed mid-run: 0.1 s of the roll clock is already gone.
  run(board, BOARD.rollSeconds - 0.25);
  assert.equal(board.phase, "roll");
  run(board, 0.2);
  assert.equal(board.phase, "move");
  assert.deepEqual({ kind: board.roll!.kind, dice: board.roll!.dice, value: board.roll!.value, auto: board.roll!.auto }, { kind: "two", dice: [1, 5], value: 5, auto: true });
  until(board, "roll");
  run(board, BOARD.rollSeconds + 0.1);
  assert.equal(board.roll!.slot, 0);
  assert.equal(board.roll!.auto, true);
});

test("away players keep their square; their turn is played for them (two dice if they won)", () => {
  const { host, board } = make([0, 1], { die: queued(3, 6, 2) });
  run(board, BOARD.introSeconds);
  host.away.add(1);
  board.miniResult(1, null);
  run(board, BOARD.miniResultsSeconds);
  assert.equal(board.current, 1);
  run(board, BOARD.awaySeconds + 0.05);
  assert.equal(board.phase, "move");
  assert.equal(board.roll!.kind, "two");
  assert.equal(board.roll!.auto, true);
  assert.equal(board.square(1), 6);
  until(board, "roll");
  assert.equal(board.current, 0);
  board.rollPressed(0);
  until(board, "intro");
  // Back: the square is still theirs and they play on.
  host.away.delete(1);
  assert.deepEqual(board.wire().pieces, [[0, 2], [1, 6]]);
  run(board, BOARD.introSeconds);
  board.miniResult(-1, null);
  run(board, BOARD.miniResultsSeconds);
  assert.equal(board.current, 0, "the one behind first");
  board.rollPressed(0);
  until(board, "roll");
  assert.equal(board.current, 1);
  assert.equal(board.rollPressed(1), true);
});

test("nobody connected: the board waits; a mini game that ends early or never ends moves on", () => {
  const { host, board } = make([0, 1]);
  host.away.add(0).add(1);
  run(board, 30);
  assert.equal(board.phase, "intro");
  host.away.clear();
  run(board, BOARD.introSeconds);
  assert.equal(board.phase, "minigame");
  // Results shorter than the board's 5 s (Rooftop's 3.5 s): straight on.
  board.miniResult(0, null);
  run(board, 3.5);
  board.miniEnded();
  assert.equal(board.phase, "choose");
  assert.equal(host.ended, 0);
  board.choose(0, "two");
  board.rollPressed(0);
  until(board, "roll");
  board.rollPressed(1);
  until(board, "intro");
  run(board, BOARD.introSeconds);
  run(board, BOARD.miniTimeoutSeconds + 0.1);
  assert.equal(host.ended, 1);
  assert.equal(board.first, -1);
  assert.equal(board.phase, "roll");
  // A mini game that cannot start is a round without a winner.
  const other = make([0, 1]);
  other.host.refuse = true;
  run(other.board, BOARD.introSeconds);
  assert.equal(other.board.phase, "roll");
});

test("leaving: the turn passes on; down to one player, that player wins (also mid mini game)", () => {
  const { board } = make([0, 1, 2], { die: queued(2) });
  run(board, BOARD.introSeconds);
  board.miniResult(-1, [0, 1, 2]);
  run(board, BOARD.miniResultsSeconds);
  assert.deepEqual(board.order, [0, 1, 2]);
  board.rollPressed(0);
  until(board, "roll");
  assert.equal(board.current, 1);
  board.remove(1);
  assert.deepEqual(board.order, [0, 2]);
  assert.equal(board.current, 2);
  assert.equal(board.phase, "roll");
  assert.deepEqual(board.wire().pieces, [[0, 2], [2, 0]]);
  board.remove(2);
  assert.equal(board.phase, "finished");
  assert.equal(board.winner, 0);
  assert.equal(board.reason, "forfeit");
  const mid = make([0, 1]);
  run(mid.board, BOARD.introSeconds);
  mid.board.remove(0);
  assert.equal(mid.host.ended, 1);
  assert.equal(mid.board.winner, 1);
  // A player removed before their turn in a 3P order, and an earlier one.
  const three = make([0, 1, 2], { die: queued(1) });
  run(three.board, BOARD.introSeconds);
  three.board.miniResult(-1, [0, 1, 2]);
  run(three.board, BOARD.miniResultsSeconds);
  three.board.rollPressed(0);
  until(three.board, "roll");
  three.board.remove(0);
  assert.equal(three.board.current, 1, "an earlier player leaving does not skip anyone");
});

test("scales past three: 2, 3 and 6 players, mini games fit the count, pawns never overlap", () => {
  for (const slots of [[0, 1], [0, 1, 2], [0, 1, 2, 3, 4, 5]]) {
    const { host, board } = make(slots, { die: queued(6), random: seeded(slots.length) });
    for (let round = 0; round < 40 && board.phase !== "finished"; round++) {
      until(board, "minigame");
      const mode = host.minis.at(-1)!.mode;
      assert.ok(GAME_MODES.includes(mode));
      if (mode === "prop_hunt") assert.equal(slots.length, 3);
      board.miniResult(slots[round % slots.length], null);
      run(board, BOARD.miniResultsSeconds);
      while (board.phase === "choose" || board.phase === "roll" || board.phase === "move") {
        if (board.phase === "choose") board.choose(board.current, "plus");
        else if (board.phase === "roll") board.rollPressed(board.current);
        else board.step(DT);
      }
    }
    assert.equal(board.phase, "finished");
    assert.ok(board.slots.includes(board.winner));
    assert.equal(board.wire().pieces.length, slots.length);
    // No mode twice in a row.
    for (let i = 1; i < host.minis.length; i++) assert.notEqual(host.minis[i].mode, host.minis[i - 1].mode);
  }
  for (let count = 1; count <= BOARD.maxPlayers; count++) {
    const spots = Array.from({ length: count }, (_, i) => pawnOffset(i, count));
    for (const p of spots) assert.ok(Math.abs(p.x) <= SQUARE_SIZE / 2 - 0.2 && Math.abs(p.z) <= SQUARE_SIZE / 2 - 0.2);
    for (let a = 0; a < count; a++) for (let b = a + 1; b < count; b++)
      assert.ok(Math.hypot(spots[a].x - spots[b].x, spots[a].z - spots[b].z) >= 0.38, `${count}: ${a}/${b}`);
  }
  assert.throws(() => make([0]));
  assert.throws(() => make([0, 1, 2, 3, 4, 5, 6]));
});

test("board path: every length is a winding S with evenly spaced, non-touching squares", () => {
  for (const length of BOARD_LENGTHS) {
    const path = boardPath(length);
    assert.equal(path.length, length + 1);
    for (let i = 1; i < path.length; i++) {
      const d = Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
      assert.ok(d > SQUARE_SIZE * 1.05 && d < 1.85, `${length}: step ${i} is ${d.toFixed(2)} m`);
    }
    // Any two squares that are not neighbours on the path keep clear of each other.
    for (let i = 0; i < path.length; i++) for (let j = i + 2; j < path.length; j++)
      assert.ok(Math.hypot(path[i].x - path[j].x, path[i].z - path[j].z) > SQUARE_SIZE * 1.1, `${length}: ${i}/${j}`);
    // The ends are far apart: start at one end, treasure at the other.
    const ends = Math.hypot(path[0].x - path[length].x, path[0].z - path[length].z);
    assert.ok(ends > 6, `${length}: ends ${ends.toFixed(1)} m apart`);
    assert.deepEqual(Array.from({ length: length + 1 }, (_, i) => i).filter((i) => numberedSquare(i, length)), Array.from({ length: Math.floor((length - 1) / 5) }, (_, i) => 5 * (i + 1)));
  }
});

test("the board's rotation is the lobby preview: first mini game = the one announced", () => {
  const rotation = new MixedRotation(seeded(3));
  rotation.setPlayers(2);
  const preview = rotation.next;
  const host = new Host();
  const board = new BoardSession(host, { length: 35, slots: [1, 2], rotation, die: queued(1), squares: boardSquares(35) });
  assert.equal(board.mode, preview);
  run(board, BOARD.introSeconds);
  assert.equal(host.minis[0].mode, preview);
});

/** Plays a match to the end: every mini game a draw (or the winner `winner()` picks), the rolls pressed at once. Returns each round's intro mode. */
function playOut(board: BoardSession, winner: () => number = () => -1, dt = DT) {
  const intros: (GameMode | null)[] = [];
  let minigameWithoutMode = false;
  for (let t = 0; t < 4e6 && board.phase !== "finished"; t++) {
    if (board.phase === "intro" && intros.length < board.round) {
      intros.push(board.mode);
      assert.equal(parseBoard(encodeBoard(board.wire()))?.mode, board.mode);
    }
    if (board.phase === "minigame" && !board.mode) minigameWithoutMode = true;
    if (board.phase === "minigame" && board.wire().mini === "playing") board.miniResult(winner(), null);
    else if (board.phase === "roll") board.rollPressed(board.current);
    else if (board.phase === "choose") board.choose(board.current, "two");
    board.step(dt);
  }
  assert.equal(board.phase, "finished");
  assert.ok(!minigameWithoutMode, "a round without a mode never enters a mini game");
  return intros;
}
const counts = (modes: readonly GameMode[]) => modes.reduce((m, mode) => m.set(mode, (m.get(mode) ?? 0) + 1), new Map<GameMode, number>());

test("a board match never repeats a mini game: every fitting mode once, then the rounds go on with dice alone", () => {
  for (const count of [2, 3]) {
    const fits = GAME_MODES.filter((mode) => modeFits(mode, count)).sort();
    const host = new Host();
    // One square a round each on Uzun: 50 rounds, far more than the modes.
    const board = new BoardSession(host, { length: 50, slots: [0, 1, 2].slice(0, count), random: seeded(count), die: queued(1), squares: boardSquares(50) });
    const intros = playOut(board);
    const played = host.minis.map((m) => m.mode);
    assert.equal(board.round, 50);
    assert.equal(board.reason, "treasure");
    assert.equal(played.length, fits.length, `${count}P: one mini game per mode`);
    assert.deepEqual([...played].sort(), fits, `${count}P: every fitting mode`);
    assert.ok([...counts(played).values()].every((n) => n === 1), `${count}P: no repeats`);
    assert.equal(counts(played).get("rhythm_master"), 1, `${count}P: Ritim Ustası once`);
    // The intros announce the modes in the order they are played, then no mode at all.
    assert.deepEqual(intros.slice(0, fits.length), played);
    assert.deepEqual(intros.slice(fits.length), Array(50 - fits.length).fill(null));
  }
});

test("a player leaving a board match does not bring back the mini games already played", () => {
  const host = new Host();
  const board = new BoardSession(host, { length: 50, slots: [0, 1, 2], random: seeded(11), die: queued(1), squares: boardSquares(50) });
  for (let t = 0; t < 4e6 && board.round < 7; t++) {
    if (board.phase === "minigame" && board.wire().mini === "playing") board.miniResult(-1, null);
    else if (board.phase === "roll") board.rollPressed(board.current);
    board.step(DT);
  }
  const before = host.minis.map((m) => m.mode);
  assert.equal(before.length, 6);
  // 3 → 2 players in the intro: the rotation is reshuffled for two, the played modes stay out.
  board.remove(2);
  assert.ok(board.mode && !before.includes(board.mode));
  playOut(board);
  const played = host.minis.map((m) => m.mode),
    after = played.slice(before.length);
  assert.ok([...counts(played).values()].every((n) => n === 1), `no repeats: ${played.join(",")}`);
  assert.ok(!after.includes("prop_hunt"), "Saklambaç needs three");
  const fits2 = GAME_MODES.filter((mode) => modeFits(mode, 2));
  assert.deepEqual([...after].sort(), fits2.filter((mode) => !before.includes(mode)).sort());
  assert.ok(host.minis.slice(before.length).every((m) => m.slots.length === 2));
});

test("BoardRotation: each fitting mode once, kept across a player count change, then null", () => {
  const rotation = new BoardRotation(seeded(5));
  rotation.setPlayers(3);
  const seen: GameMode[] = [];
  for (let i = 0; i < 4; i++) {
    seen.push(rotation.next!);
    rotation.played();
  }
  rotation.setPlayers(2);
  for (let mode = rotation.next; mode; mode = rotation.next) {
    seen.push(mode);
    rotation.played();
  }
  assert.equal(new Set(seen).size, seen.length);
  const first = seen.slice(0, 4);
  assert.deepEqual(seen.slice(4).sort(), GAME_MODES.filter((m) => modeFits(m, 2) && !first.includes(m)).sort());
  assert.equal(rotation.next, null);
  rotation.played();
  assert.equal(rotation.next, null);
});

test("real dice and squares on Uzun: no board match repeats a mini game (Ritim Ustası at most once)", () => {
  // Matches with more rounds than modes (rare, a few in a thousand) run out of mini games instead of repeating one.
  let outOfModes = 0;
  for (const count of [2, 3]) {
    const fits = GAME_MODES.filter((mode) => modeFits(mode, count)).length;
    for (let match = 0; match < 2000; match++) {
      const random = seeded(1000 * count + match),
        slots = [0, 1, 2].slice(0, count);
      const host = new Host();
      const board = new BoardSession(host, { length: 50, slots, random, die: dieFrom(seeded(77 + match)) });
      // A random winner most rounds, sometimes a draw.
      playOut(board, () => (random() < 0.15 ? -1 : slots[Math.floor(random() * count)]), 0.25);
      const played = host.minis.map((m) => m.mode);
      assert.equal(new Set(played).size, played.length, `${count}P match ${match}: ${played.join(",")}`);
      assert.ok((counts(played).get("rhythm_master") ?? 0) <= 1);
      assert.equal(played.length, Math.min(board.round, fits));
      if (board.round > fits) outOfModes++;
    }
  }
  assert.ok(outOfModes > 0, "some long matches outlast the modes");
});
