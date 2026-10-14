/**
 * Kutu Kulesi: the slide, the drop rules (engine), the bots, the drop path (mailbox) and a real
 * room with 2 and 3 players.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Client, type Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { createPartyServer } from "../src/server.js";
import type { PartyRoom } from "../src/PartyRoom.js";
import type { LobbyState } from "../src/state.js";
import { BOX_TOWER as T } from "../../../shared/party-lab/simulation/boxtower/config.js";
import { BoxTowerGame, type TowerPress } from "../../../shared/party-lab/simulation/boxtower/game.js";
import { SPAN, columnAt, crossings, slideX, travelMs, type Slide } from "../../../shared/party-lab/simulation/boxtower/motion.js";
import { TowerBot, TOWER_BOT_LEVELS, type TowerBotLevel } from "../../../shared/party-lab/simulation/boxtower/bots.js";
import { laneHeights, towerSection, validTowerWire, wireSlide } from "../../../shared/party-lab/simulation/boxtower/wire.js";
import { TowerRoundSimulation } from "../../../shared/party-lab/simulation/towerRound.js";
import { mulberry32 } from "../../../shared/party-lab/simulation/colors/layouts.js";
import { validateTowerInput } from "../../../shared/party-lab/network/towerInput.js";
import { InputMailbox, NET, type GameSnapshot } from "../../../shared/party-lab/network/protocol.js";
import { GAME_MODES, MODE_NAMES, MODE_PLAYERS, MixedRotation, modeFits } from "../../../shared/party-lab/modes.js";
import { LOCAL_ARENA_IDS } from "../../../shared/party-lab/localArenas.js";
import { BoardSession, type BoardHost } from "../../../shared/party-lab/board/session.js";
import { boardSquares } from "../../../shared/party-lab/board/config.js";
import { PLAYERS } from "../../../shared/party-lab/simulation/players.js";

const MS = 1000 / T.hz;
const near = (a: number, b: number, eps: number, what = "") => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} ≉ ${b} (±${eps})`);
/** A game just past its countdown. */
function stacking(count = 2, seed = 7) {
  const g = new BoxTowerGame(count, mulberry32(seed));
  while (g.phase === "countdown") g.step();
  assert.equal(g.phase, "stacking");
  return g;
}
/** Steps until the step that reaches `ms`, then that step with `presses` (lane → press time). */
function stepTo(g: BoxTowerGame, ms: number, presses: Record<number, number> = {}) {
  while ((g.ticks + 1) * MS < ms - 1e-9 && g.phase === "stacking") g.step();
  g.step(g.lanes.map((l, lane) => (lane in presses ? { drop: l.drops + 1, at: presses[lane] } : undefined)));
}
const run = (g: BoxTowerGame, ms: number) => {
  while (g.elapsedMs < ms - 1e-9 && g.phase === "stacking") g.step();
};
/** The first moment at or after `after` lane `lane`'s box is over `column`. */
const over = (g: BoxTowerGame, lane: number, column: number, after: number) => crossings(g.lanes[lane].slide, column, after, after + 10_000)[0];
/** Drops lane `lane`'s box into `column` (at its next pass after it appeared) and lets it land. */
function place(g: BoxTowerGame, lane: number, column: number) {
  const l = g.lanes[lane],
    at = over(g, lane, column, Math.max(g.elapsedMs + MS, l.slide.spawn));
  stepTo(g, at, { [lane]: at });
  assert.ok(l.falling, `lane ${lane} dropped`);
  assert.equal(l.falling!.column, column);
  run(g, l.falling!.land);
  assert.equal(l.falling, null);
}

test("slide: the box crosses the 7 columns in 1.6 s at the start, 0.6 s at 9 high, and turns back at both ends", () => {
  assert.equal(T.columns, 7);
  assert.equal(travelMs(0), 1600);
  assert.equal(travelMs(9), 600);
  assert.equal(travelMs(14), 600, "taller keeps the last entry");
  for (let h = 1; h < T.travelSeconds.length; h++) assert.ok(travelMs(h) < travelMs(h - 1), "faster every box");
  const s: Slide = { spawn: 1000, from: 0, dir: 1, travel: 1600 };
  near(slideX(s, 1000), 0, 1e-12);
  near(slideX(s, 1800), 3, 1e-9, "half way");
  near(slideX(s, 2600), SPAN, 1e-9, "the last column after 1.6 s");
  near(slideX(s, 2600 + 400), SPAN - 1.5, 1e-9, "turned back");
  near(slideX(s, 1000 + 3200), 0, 1e-9, "back at the first");
  near(slideX(s, 1000 + 3200 + 800), 3, 1e-9, "and on again");
  // Never outside the yard.
  for (let t = 0; t < 20_000; t += 7.3) {
    const x = slideX({ spawn: 0, from: 4, dir: -1, travel: 600 }, t);
    assert.ok(x >= 0 && x <= SPAN, `${x}`);
  }
  // The column is the one under the middle: halfway between two goes right.
  assert.equal(columnAt(s, 1000 + (2.49 * 1600) / SPAN), 2);
  assert.equal(columnAt(s, 1000 + (2.5 * 1600) / SPAN), 3);
  // Crossings: exactly where the box is over the column.
  const left: Slide = { spawn: 0, from: 5, dir: -1, travel: 900 };
  const times = crossings(left, 2, 0, 5000);
  assert.ok(times.length >= 6);
  for (const t of times) near(slideX(left, t), 2, 1e-9);
  assert.deepEqual(crossings(left, 0, 0, 3000), [750, 2550], "an end column is passed once per turn");
});

test("a press drops the box into the column under its middle at the press moment; it lands 250 ms later on top", () => {
  const g = stacking();
  const l = g.lanes[0];
  l.slide = { spawn: 0, from: 0, dir: 1, travel: 1600 };
  const at = (2.2 * 1600) / SPAN;
  stepTo(g, at + 40, { 0: at });
  assert.deepEqual(l.falling, { column: 2, at, land: at + T.fallMs });
  assert.equal(l.drops, 1);
  assert.equal(l.heights[2], 0, "still in the air");
  run(g, at + T.fallMs - MS);
  assert.equal(l.heights[2], 0);
  run(g, at + T.fallMs);
  assert.equal(l.heights[2], 1);
  assert.equal(l.best, 1);
  assert.equal(l.reached, at + T.fallMs, "the moment it landed");
  assert.equal(l.placed, 1);
  assert.ok(l.good);
});

test("aim tolerance: a press up to 150 ms old (or 50 ms ahead) drops where it was pressed; older ones are moved to 150 ms", () => {
  for (const [late, expected] of [
    [0, 0],
    [100, 100],
    [150, 150],
    [260, 150],
    [-30, -30],
    [-50, -50],
    [-90, -50],
  ] as const) {
    const g = stacking();
    const l = g.lanes[0];
    l.slide = { spawn: 0, from: 0, dir: 1, travel: 1600 };
    run(g, 2000);
    const now = g.elapsedMs + MS,
      pressed = now - late;
    g.step([{ drop: 1, at: pressed }]);
    assert.ok(l.falling, `late ${late}`);
    near(l.falling!.at, now - expected, 1e-9, `late ${late}`);
    assert.equal(l.falling!.column, columnAt({ spawn: 0, from: 0, dir: 1, travel: 1600 }, now - expected));
  }
});

test("presses that do not count: in the countdown, while a box falls, before the next box appears, a repeated packet, after the time", () => {
  const g = new BoxTowerGame(2, mulberry32(3));
  g.step([{ drop: 1, at: -500 }]);
  assert.equal(g.lanes[0].drops, 0, "countdown");
  while (g.phase === "countdown") g.step([{ drop: 1, at: 0 }]);
  assert.equal(g.lanes[0].drops, 0, "countdown");
  const l = g.lanes[0];
  stepTo(g, 300, { 0: 300 });
  assert.equal(l.drops, 1);
  const land = l.falling!.land,
    next = l.slide.spawn;
  assert.equal(next, land + T.respawnMs, "the next box appears 400 ms after the landing");
  // Falling: a new drop number is refused, so is the same one again.
  g.step([{ drop: 2, at: g.elapsedMs }]);
  g.step([{ drop: 1, at: g.elapsedMs }]);
  assert.equal(l.drops, 1, "while falling");
  run(g, land + 20);
  assert.equal(l.falling, null);
  // Waiting for the next box: refused (also stamped in the gap and arriving after it appeared).
  g.step([{ drop: 2, at: g.elapsedMs }]);
  assert.equal(l.drops, 1, "waiting");
  run(g, next + 30);
  g.step([{ drop: 2, at: next - 10 }]);
  assert.equal(l.drops, 1, "stamped before the box appeared");
  g.step([{ drop: 3, at: g.elapsedMs }]);
  assert.equal(l.drops, 1, "not the next drop number");
  g.step([{ drop: 2, at: g.elapsedMs }]);
  assert.equal(l.drops, 2, "sliding: counts");
  // After the time is up.
  const h = new BoxTowerGame(2, mulberry32(4));
  while (h.phase === "countdown") h.step();
  run(h, h.limitMs + 20);
  assert.equal(h.phase, "stacking", "still waiting for late presses");
  h.step([{ drop: 1, at: h.limitMs + 5 }]);
  assert.equal(h.lanes[0].drops, 0, "pressed after the time");
});

test("every new box starts over a random column going a random way (inward at the ends), so the rhythm cannot be learned", () => {
  const starts = new Set<string>(),
    columns = new Set<number>();
  for (let seed = 1; seed < 41; seed++) {
    const g = stacking(3, seed);
    for (let i = 0; i < 4; i++) {
      for (const l of g.lanes) {
        const s = l.slide;
        assert.ok(Number.isInteger(s.from) && s.from >= 0 && s.from <= SPAN);
        assert.ok(s.dir === 1 || s.dir === -1);
        if (s.from === 0) assert.equal(s.dir, 1);
        if (s.from === SPAN) assert.equal(s.dir, -1);
        starts.add(`${s.from}:${s.dir}`);
        columns.add(s.from);
      }
      for (let lane = 0; lane < 3; lane++) place(g, lane, i % 7);
    }
  }
  assert.equal(columns.size, T.columns, "every column");
  assert.equal(starts.size, 2 * T.columns - 2, "every column and way that stays inside");
});

test("speed: the slide speeds up with the player's own tallest column; a miss (another column) does not", () => {
  const g = stacking(2, 11);
  assert.equal(g.lanes[0].slide.travel, 1600);
  place(g, 0, 3);
  assert.equal(g.lanes[0].slide.travel, travelMs(1));
  place(g, 0, 3);
  assert.equal(g.lanes[0].slide.travel, travelMs(2));
  // Misses: other columns, up to the tallest's height, leave the speed.
  place(g, 0, 5);
  assert.equal(g.lanes[0].slide.travel, travelMs(2), "a miss");
  assert.ok(!g.lanes[0].good);
  place(g, 0, 1);
  assert.equal(g.lanes[0].slide.travel, travelMs(2), "another miss");
  place(g, 0, 5);
  assert.equal(g.lanes[0].best, 2);
  assert.equal(g.lanes[0].slide.travel, travelMs(2), "a second column as tall");
  place(g, 0, 5);
  assert.equal(g.lanes[0].best, 3);
  assert.equal(g.lanes[0].slide.travel, travelMs(3), "taller again");
  // The other lane never sped up.
  assert.equal(g.lanes[1].slide.travel, 1600);
  // 9 high: 0.6 s from end to end.
  const h = stacking(2, 12);
  for (let i = 0; i < 9; i++) place(h, 1, 6);
  assert.equal(h.lanes[1].best, 9);
  assert.equal(h.lanes[1].slide.travel, 600);
});

test("10 in a column ends the round at once (the first to land wins); the others' boxes in the air never land", () => {
  const g = stacking(3, 5);
  g.lanes[0].heights[2] = 9;
  g.lanes[0].best = 9;
  g.lanes[1].heights[4] = 9;
  g.lanes[1].best = 9;
  g.lanes[0].slide = { spawn: 0, from: 0, dir: 1, travel: 600 };
  g.lanes[1].slide = { spawn: 0, from: 0, dir: 1, travel: 600 };
  run(g, 1000);
  const a = over(g, 0, 2, 1000),
    b = a + 60;
  // Lane 1's box is over its column 60 ms after lane 0's.
  g.lanes[1].slide = { spawn: b - 400, from: 0, dir: 1, travel: 600 };
  near(over(g, 1, 4, a), b, 1e-9);
  stepTo(g, a, { 0: a });
  stepTo(g, b, { 1: b });
  assert.ok(g.lanes[1].falling && g.lanes[1].falling.land > a + T.fallMs + MS, "lane 1 lands after lane 0");
  run(g, a + T.fallMs - MS);
  assert.equal(g.phase, "stacking");
  g.step();
  assert.equal(g.phase, "results", "ended the step the tenth landed");
  assert.equal(g.lanes[0].best, 10);
  assert.equal(g.lanes[1].best, 9, "landing 30 ms later: too late");
  assert.equal(g.lanes[1].falling, null);
  assert.equal(g.winner(), 0);
  assert.deepEqual(g.places(), [0, 1, 2]);
  assert.ok(g.elapsedMs < T.limit * 1000);
  // Landing at the very same moment: both count, a draw.
  const tie = stacking(2, 6);
  for (const l of tie.lanes) {
    l.heights[3] = 9;
    l.best = 9;
    l.reached = 500;
    l.slide = { spawn: 0, from: 0, dir: 1, travel: 600 };
  }
  run(tie, 1000);
  const t = over(tie, 0, 3, 1000);
  stepTo(tie, t + 1, { 0: t, 1: t });
  run(tie, t + T.fallMs + MS);
  assert.equal(tie.phase, "results");
  assert.deepEqual(tie.lanes.map((l) => l.best), [10, 10]);
  assert.equal(tie.winner(), -1, "a draw");
  assert.deepEqual(tie.places(), [0, 0]);
});

test("60 s: a box pressed before the limit lands after it and counts, even the tenth; a press after does not; the round ends once it is down", () => {
  const g = stacking(2, 8);
  g.lanes[0].heights[1] = 9;
  g.lanes[0].best = 9;
  g.lanes[0].reached = 30_000;
  g.lanes[1].heights[6] = 9;
  g.lanes[1].best = 9;
  g.lanes[1].reached = 20_000;
  // Lane 0's box is over column 1 40 ms before the end; the packet arrives 60 ms after it.
  g.lanes[0].slide = { spawn: g.limitMs - 140, from: 0, dir: 1, travel: 600 };
  run(g, g.limitMs - 200);
  const at = over(g, 0, 1, g.limitMs - 140);
  near(at, g.limitMs - 40, 1e-9);
  stepTo(g, g.limitMs + 60, { 0: at });
  assert.ok(g.lanes[0].falling, "a press before the time counts though it arrived after");
  assert.equal(g.phase, "stacking");
  g.step([undefined, { drop: 1, at: g.elapsedMs }]);
  assert.equal(g.lanes[1].drops, 0, "pressed after the time");
  run(g, at + T.fallMs + MS);
  assert.equal(g.phase, "results", "ended when the last box landed");
  assert.equal(g.lanes[0].best, 10);
  assert.equal(g.winner(), 0, "the last box made 10");
  // Nobody at 10: the tallest wins; equal heights → who got there first; equal moments → a draw.
  const h = stacking(3, 9);
  Object.assign(h.lanes[0], { best: 6, reached: 31_000 });
  Object.assign(h.lanes[1], { best: 7, reached: 50_000 });
  Object.assign(h.lanes[2], { best: 6, reached: 12_000 });
  h.lanes.forEach((l) => (l.heights[0] = l.best));
  run(h, h.limitMs + T.aimToleranceMs + 2 * MS);
  assert.equal(h.phase, "results");
  assert.equal(h.winner(), 1);
  assert.deepEqual(h.places(), [2, 0, 1]);
  const d = stacking(2, 10);
  d.lanes.forEach((l) => Object.assign(l, { best: 4, reached: 9000 }));
  run(d, d.limitMs + T.aimToleranceMs + 2 * MS);
  assert.equal(d.phase, "results");
  assert.equal(d.winner(), -1);
  assert.deepEqual(d.places(), [0, 0]);
});

test("leaving: the leaver ranks last and their box in the air is gone; the last player left wins at once", () => {
  const g = stacking(3, 13);
  place(g, 1, 2);
  place(g, 1, 2);
  const at = over(g, 1, 2, g.lanes[1].slide.spawn);
  stepTo(g, at, { 1: at });
  g.remove(1);
  assert.equal(g.lanes[1].falling, null);
  g.step();
  assert.equal(g.phase, "stacking", "two still in");
  assert.deepEqual(g.places(), [0, 2, 0]);
  g.remove(0);
  g.step();
  assert.equal(g.phase, "results");
  assert.equal(g.winner(), 2);
});

test("bots really play: they stack, miss more as the box speeds up, and harder bots finish sooner", () => {
  const results: Record<TowerBotLevel, { finish: number[]; early: number; late: number; earlyN: number; lateN: number }> = {
    easy: { finish: [], early: 0, late: 0, earlyN: 0, lateN: 0 },
    medium: { finish: [], early: 0, late: 0, earlyN: 0, lateN: 0 },
    hard: { finish: [], early: 0, late: 0, earlyN: 0, lateN: 0 },
  };
  for (const level of TOWER_BOT_LEVELS)
    for (let seed = 0; seed < 40; seed++) {
      const random = mulberry32(100 + seed),
        g = new BoxTowerGame(2, random),
        bots = [new TowerBot(level, random), new TowerBot(level, random)],
        r = results[level],
        seen = [0, 0],
        before = [0, 0];
      while (g.phase !== "results") {
        const due = g.elapsedMs + MS;
        g.step(
          g.lanes.map((l, lane): TowerPress | undefined => {
            if (g.phase !== "stacking") return undefined;
            const at = bots[lane].next({ playing: !l.out, busy: !!l.falling, heights: l.heights, slide: l.slide }, due);
            return at === null ? undefined : { drop: l.drops + 1, at };
          })
        );
        g.lanes.forEach((l, lane) => {
          if (l.placed === seen[lane]) return;
          seen[lane] = l.placed;
          if (before[lane] < 3) (r.earlyN++, (r.early += +l.good));
          else if (before[lane] >= 6 && before[lane] < 10) (r.lateN++, (r.late += +l.good));
          before[lane] = l.best;
        });
      }
      const done = g.lanes.flatMap((_, lane) => (g.finished(lane) >= 0 ? [g.finished(lane)] : []));
      r.finish.push(done.length ? Math.min(...done) : Infinity);
    }
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
  for (const level of TOWER_BOT_LEVELS) {
    const r = results[level];
    assert.ok(r.early / r.earlyN > r.late / r.lateN + 0.15, `${level}: hits ${(r.early / r.earlyN).toFixed(2)} low vs ${(r.late / r.lateN).toFixed(2)} high`);
  }
  assert.ok(median(results.hard.finish) < median(results.medium.finish) && median(results.medium.finish) < median(results.easy.finish), "harder finishes sooner");
  assert.ok(median(results.hard.finish) < 30_000, `hard ${median(results.hard.finish)}`);
});

test("the round simulation: player counts, slots (not seats) as winner, placements per slot, a dropped player's box keeps sliding", () => {
  const sim = new TowerRoundSimulation(undefined, 21);
  assert.equal(MODE_PLAYERS.box_tower.min, 2);
  assert.equal(MODE_PLAYERS.box_tower.max, 3);
  assert.equal(MODE_NAMES.box_tower, "Kutu Kulesi");
  assert.equal(sim.start([1]), false);
  assert.equal(sim.start([0, 1, 2, 3] as never), false);
  assert.equal(sim.start([2, 1]), true);
  assert.deepEqual(sim.seats, [1, 2]);
  while (sim.phase !== "playing") sim.step([]);
  // Slot 1 (lane 0) is dropped: nothing arrives, its box goes on sliding along its path.
  sim.neutralize(1);
  const before = wireSlide(towerSection(sim.game, sim.seats), 0);
  for (let i = 0; i < 90; i++) sim.step([]);
  assert.deepEqual(wireSlide(towerSection(sim.game, sim.seats), 0), before, "the same slide, still moving with time");
  // Slot 2 (lane 1) stacks to 10 through real packets.
  const g = sim.game;
  g.lanes[1].heights[4] = 9;
  g.lanes[1].best = 9;
  const at = over(g, 1, 4, Math.max(g.elapsedMs + MS, g.lanes[1].slide.spawn));
  while ((g.ticks + 1) * MS < at) sim.step([]);
  const inputs = PLAYERS.map(() => ({ x: 0, z: 0, jump: false }));
  sim.step(inputs.map((input, slot) => (slot === 2 ? { ...input, tower: { seq: 1, round: sim.roundId, drop: 1, at } } : input)));
  while (sim.phase === "playing") sim.step([]);
  assert.equal(sim.phase, "results");
  assert.equal(sim.winner, 2, "the winning lane's slot");
  assert.deepEqual(sim.placements(), [-1, 1, 0]);
  const snap = sim.snapshot([0, 0, 0]);
  assert.equal(snap.v, 19);
  assert.equal(snap.mode, "box_tower");
  assert.equal(snap.winner, 2);
  assert.ok(validTowerWire(snap.tower));
  assert.deepEqual(laneHeights(snap.tower!, 1), [0, 0, 0, 0, 10, 0, 0]);
  assert.equal(snap.transforms.byteLength, 0);
  for (let i = 0; i < T.results * T.hz + 2; i++) sim.step([]);
  assert.equal(sim.phase, "waiting");
  assert.equal(sim.start([0, 1, 2]), true, "3 players");
  assert.equal(sim.game.lanes.length, 3);
});

test("the wire: well formed, refused when malformed", () => {
  const g = stacking(3, 2);
  place(g, 0, 3);
  const w = towerSection(g, [0, 1, 2]);
  assert.ok(validTowerWire(w));
  assert.deepEqual(laneHeights(w, 0), [0, 0, 0, 1, 0, 0, 0]);
  assert.ok(validTowerWire(JSON.parse(JSON.stringify(w))));
  for (const bad of [{ ...w, heights: w.heights.slice(1) }, { ...w, dir: w.dir.map(() => 0) }, { ...w, fallColumn: w.fallColumn.map(() => 7) }, { ...w, phase: "mining" }, { ...w, seats: [0] }, { ...w, travel: w.travel.map(() => 0) }, null])
    assert.equal(validTowerWire(bad), false);
});

test("mailbox: the newest drop waits for the next step, however late; strict packets", () => {
  const box = new InputMailbox();
  assert.equal(box.accept({ seq: 1, round: 2, drop: 1, at: 50 }, 2, 0, "box_tower"), true);
  assert.equal(box.accept({ seq: 1, round: 2, drop: 2, at: 60 }, 2, 0, "box_tower"), false, "replayed seq");
  assert.equal(box.accept({ seq: 2, round: 1, drop: 2, at: 60 }, 2, 0, "box_tower"), false, "old round");
  assert.equal(box.accept({ seq: 2, round: 2, shot: 2, at: 60 }, 2, 0, "box_tower"), false, "another mode's packet");
  assert.deepEqual(box.read(10_000).tower, { seq: 1, round: 2, drop: 1, at: 50 });
  assert.equal(box.processedSeq, 1);
  assert.equal(box.read(10_001).tower, undefined, "read once");
  for (const bad of [{ seq: 4, round: 2, drop: 0, at: 1 }, { seq: 4, round: 2, drop: 1, at: NaN }, { seq: 4, round: 2, drop: 1.5, at: 1 }, { seq: 4, round: 2, drop: 1, at: 1, x: 1 }, { seq: 4, round: 2, drop: 1 }, [1]])
    assert.equal(validateTowerInput(bad), null, JSON.stringify(bad));
});

test("Kutu Kulesi is in Mixed, in the board's mini games and in the Yerel Test Arenası for 2 and 3 players", () => {
  assert.ok(GAME_MODES.includes("box_tower"));
  assert.ok(LOCAL_ARENA_IDS.includes("box_tower"));
  for (const count of [2, 3]) {
    assert.ok(modeFits("box_tower", count));
    const mixed = new MixedRotation(() => 0.5);
    mixed.setPlayers(count);
    const cycle = GAME_MODES.filter((m) => modeFits(m, count)).map(() => {
      const mode = mixed.next;
      mixed.played();
      return mode;
    });
    assert.ok(cycle.includes("box_tower"), `Mixed ${count}P`);
    const minis: string[] = [];
    const host: BoardHost = { startMini: (mode) => (minis.push(mode), true), endMini() {}, connected: () => true };
    const rotation = new MixedRotation(() => 0.25);
    rotation.setPlayers(count);
    const board = new BoardSession(host, { length: 50, slots: PLAYERS.slice(0, count).map((p) => p.id), random: () => 0.25, die: () => 1, rotation, squares: boardSquares(50) });
    const until = (done: () => boolean, act = () => board.step(1 / NET.physicsHz)) => {
      for (let t = 0; t < 600 * NET.physicsHz && !done(); t++) act();
      assert.ok(done(), `board stuck in ${board.phase}`);
    };
    while (minis.length < cycle.length) {
      until(() => board.phase === "minigame");
      board.miniResult(-1, null);
      until(() => board.phase !== "minigame");
      until(() => board.phase === "intro", () => (board.phase === "roll" ? board.rollPressed(board.current) : board.step(1 / NET.physicsHz)));
    }
    assert.ok(minis.includes("box_tower"), `Tahta Oyunu ${count}P: ${minis.join(",")}`);
  }
  assert.ok(!modeFits("box_tower", 1) && !modeFits("box_tower", 4));
});

/* A real room: drops during the countdown are dropped, a stamped drop lands where pressed, a
   dropped player's box keeps sliding and they stack again once back, and 10 ends it at once. */
const { server, httpServer } = createPartyServer();
let endpoint = "";
const rooms: Room<unknown, LobbyState>[] = [];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw Error("timeout");
    await pause(5);
  }
}
before(async () => {
  await server.listen(0, "127.0.0.1");
  endpoint = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
after(async () => {
  for (const r of rooms) {
    r.reconnection.enabled = false;
    if (r.connection.isOpen) await r.leave().catch(() => {});
  }
  await server.gracefullyShutdown(false);
});
async function peer(code?: string) {
  const c = new Client(endpoint),
    r = code
      ? await c.joinById<LobbyState>(code, { protocol: NET.version, nickname: "Guest", intent: "join", code })
      : await c.create<LobbyState>("party_lab", { protocol: NET.version, nickname: "Host", intent: "create" });
  rooms.push(r);
  r.onMessage("notice", () => {});
  r.onMessage("feedback", () => {});
  const snapshots: GameSnapshot[] = [];
  r.onMessage("snapshot", (s: GameSnapshot) => snapshots.push(s));
  Object.assign(r.reconnection, { minUptime: 0, minDelay: 70, maxDelay: 100, maxRetries: 10 });
  let seq = 0;
  return { r, snapshots, drop: (drop: number, at: number, round: number) => r.send("input", { seq: ++seq, round, drop, at }) };
}
async function lobby(count: number) {
  const peers = [await peer()];
  for (let i = 1; i < count; i++) peers.push(await peer(peers[0].r.roomId));
  const room = matchMaker.getLocalRoomById(peers[0].r.roomId) as PartyRoom;
  peers[0].r.send("mode", "box_tower");
  await until(() => room.selection === "box_tower");
  for (const p of peers) p.r.send("ready", true);
  await until(() => room.game.phase === "countdown");
  const sim = room.game as TowerRoundSimulation;
  assert.ok(sim instanceof TowerRoundSimulation);
  const lane = (p: (typeof peers)[number]) => sim.seats.indexOf(room.state.players.get(p.r.sessionId)!.slot as never);
  return { peers, room, sim, lane };
}
async function close(peers: { r: Room<unknown, LobbyState> }[]) {
  for (const p of peers) {
    p.r.reconnection.enabled = false;
    if (p.r.connection.isOpen) await p.r.leave();
  }
}

for (const count of [2, 3])
  test(`room ${count}P: countdown drops refused, stamped drops land where pressed, a dropped box keeps sliding, back and stacking, 10 wins at once`, { timeout: 30000 }, async () => {
    const { peers, room, sim, lane } = await lobby(count);
    const g = sim.game;
    peers[0].drop(1, 0, sim.roundId);
    await until(() => room.game.phase === "playing");
    await pause(60);
    assert.equal(g.lanes[lane(peers[0])].drops, 0, "a drop sent during the countdown");
    /** Peer `i` drops into `column` at the box's next pass (stamped as the client saw it) and waits for the landing. */
    const stack = async (i: number, column: number, number: number) => {
      const l = g.lanes[lane(peers[i])];
      const at = over(g, lane(peers[i]), column, Math.max(g.elapsedMs + 40, l.slide.spawn));
      await until(() => g.elapsedMs >= at);
      peers[i].drop(number, at, sim.roundId);
      peers[i].drop(number, at, sim.roundId);
      await until(() => l.placed === number);
      assert.equal(l.drops, number, "a repeated packet dropped once");
      assert.equal(l.last!.column, column);
      near(l.last!.at, at, 1e-9, "dropped at the stamped moment");
    };
    await stack(0, 3, 1);
    await stack(1, 5, 1);
    // A dropped player's box keeps sliding (the same slide, on the clock); back, they stack again.
    const l1 = lane(peers[1]),
      slide = { ...g.lanes[l1].slide };
    const r = peers[1].r,
      id = r.sessionId;
    r.connection.close(4010);
    await until(() => !room.state.players.get(id)!.connected);
    assert.deepEqual(g.lanes[l1].slide, slide);
    await until(() => room.state.players.get(id)!.connected);
    assert.equal(room.game, sim);
    await stack(1, 5, 2);
    if (count === 3) await stack(2, 0, 1);
    // Peer 0 needs one more for 10.
    const l0 = lane(peers[0]);
    g.lanes[l0].heights[3] = 9;
    g.lanes[l0].best = 9;
    await stack(0, 3, 2);
    await until(() => room.game.phase === "results", 2000);
    const slot = (i: number) => room.state.players.get(peers[i].r.sessionId)!.slot;
    assert.equal(room.state.winner, slot(0));
    const places = sim.placements();
    assert.equal(places[slot(0)], 0);
    assert.equal(places[slot(1)], 1);
    if (count === 3) assert.equal(places[slot(2)], 2, "1 high against 2");
    await until(() => peers[0].snapshots.at(-1)?.phase === "results");
    const shown = peers[0].snapshots.at(-1)!;
    assert.equal(shown.v, 19);
    assert.ok(validTowerWire(shown.tower));
    assert.equal(shown.winner, slot(0));
    assert.equal(shown.tower!.best[l0], 10);
    assert.ok(shown.tower!.elapsed < T.limit * 1000, "ended at once, before the time");
    await close(peers);
  });

test("room: the player left alone wins the round", { timeout: 30000 }, async () => {
  const { peers, room, sim } = await lobby(2);
  await until(() => room.game.phase === "playing");
  peers[1].r.reconnection.enabled = false;
  await peers[1].r.leave();
  await until(() => room.game.phase === "results");
  assert.equal(sim.winner, room.state.players.get(peers[0].r.sessionId)!.slot);
  await close(peers.slice(0, 1));
});
