/**
 * Altın Madenci: the mining rules (engine), the mine generator, the shot path (mailbox) and
 * a real room with 2 and 3 players.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Client, type Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { createPartyServer } from "../src/server.js";
import type { PartyRoom } from "../src/PartyRoom.js";
import type { LobbyState } from "../src/state.js";
import { GOLD_KINDS, GOLD_MINER as G, type GoldKind } from "../../../shared/party-lab/simulation/goldminer/config.js";
import { GoldMinerGame, type GoldHook } from "../../../shared/party-lab/simulation/goldminer/game.js";
import { clearShots, countRange, fieldCounts, fieldProblems, generateField, nearValues, sackValue, type FieldItem } from "../../../shared/party-lab/simulation/goldminer/field.js";
import { SWING_AMPLITUDE, SWING_MS, edgeLength, hookPose, pivotX, returnMs, shotMs, swingAngle, tipAt, traceShot } from "../../../shared/party-lab/simulation/goldminer/mine.js";
import { goldSection, validGoldWire } from "../../../shared/party-lab/simulation/goldminer/wire.js";
import { GoldRoundSimulation } from "../../../shared/party-lab/simulation/goldRound.js";
import { mulberry32 } from "../../../shared/party-lab/simulation/colors/layouts.js";
import { validateGoldInput } from "../../../shared/party-lab/network/goldInput.js";
import { InputMailbox, NET, type GameSnapshot } from "../../../shared/party-lab/network/protocol.js";
import { GAME_MODES, MODE_PLAYERS, MixedRotation, modeFits } from "../../../shared/party-lab/modes.js";
import { LOCAL_ARENA_IDS } from "../../../shared/party-lab/localArenas.js";
import { BoardSession, type BoardHost } from "../../../shared/party-lab/board/session.js";
import { boardSquares } from "../../../shared/party-lab/board/config.js";
import { IDLE_INPUT } from "../../../shared/party-lab/simulation/physics.js";
import { PLAYERS } from "../../../shared/party-lab/simulation/players.js";

const MS = 1000 / G.hz;
const near = (a: number, b: number, eps: number, what = "") => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} ≉ ${b} (±${eps})`);
const item = (kind: GoldKind, x: number, y: number, value: number = G.items[kind].value): FieldItem => ({ kind, x, y, r: G.items[kind].radius, value });
/** A game on a hand-made mine, just past its countdown. */
function mining(count: number, field: FieldItem[]) {
  const g = new GoldMinerGame(count, Math.random, field);
  while (g.phase === "countdown") g.step();
  assert.equal(g.phase, "mining");
  return g;
}
/** The first moment at or after `after` (ms) this hook's swing points at `angle`. */
function whenAngle(h: GoldHook, angle: number, after: number) {
  const base = (Math.asin(angle / SWING_AMPLITUDE) * SWING_MS) / (2 * Math.PI);
  let best = Infinity;
  for (let k = -2; k < 60; k++) for (const t of [h.origin + base + k * SWING_MS, h.origin + SWING_MS / 2 - base + k * SWING_MS]) if (t >= after - 1e-9 && t < best) best = t;
  return best;
}
/** The angle from lane `lane`'s pivot to a point. */
const aim = (g: GoldMinerGame, lane: number, x: number, y: number) => Math.atan2(x - g.pivot(lane), y);
/** Steps until the step that reaches `ms`, then that step with `shots` (lane → press time). */
function stepTo(g: GoldMinerGame, ms: number, shots: Record<number, number> = {}) {
  while ((g.ticks + 1) * MS < ms - 1e-9 && g.phase === "mining") g.step();
  g.step(g.lanes.map((l, lane) => (lane in shots ? { shot: l.hook.shots + 1, at: shots[lane] } : undefined)));
}
const run = (g: GoldMinerGame, ms: number) => {
  while (g.elapsedMs < ms - 1e-9 && g.phase === "mining") g.step();
};
/** Steps until lane `lane`'s hook is in `state` (swing: back home). */
function settle(g: GoldMinerGame, lane: number, state: GoldHook["state"]) {
  for (let i = 0; i < 10 * G.hz && g.lanes[lane].hook.state !== state && g.phase === "mining"; i++) g.step();
  assert.equal(g.lanes[lane].hook.state, state);
}
/** Fires lane `lane` at `angle` at the first moment its swing points there (after `after`, never in the past); the press time. */
function fire(g: GoldMinerGame, lane: number, angle: number, after = 0) {
  const at = whenAngle(g.lanes[lane].hook, angle, Math.max(after, g.elapsedMs + MS));
  stepTo(g, at, { [lane]: at });
  assert.equal(g.lanes[lane].hook.fired, at, "fired at the press");
  return at;
}

test("swing: ±70° and one full swing every 2.8 s; a shot flies at the angle of its press", () => {
  assert.equal(G.swingDeg, 70);
  assert.equal(G.swingSeconds, 2.8);
  let max = 0;
  for (let t = 0; t < SWING_MS; t += 1) max = Math.max(max, Math.abs(swingAngle(t, 0)));
  near(max, (70 * Math.PI) / 180, 1e-6, "amplitude");
  near(swingAngle(1234, 0), swingAngle(1234 + SWING_MS, 0), 1e-12, "period");
  near(swingAngle(SWING_MS / 4, 0), SWING_AMPLITUDE, 1e-12);
  const g = mining(3, [item("small", 0, 6)]);
  // Hooks start apart, so they never swing in step.
  assert.notEqual(swingAngle(500, g.lanes[0].hook.origin), swingAngle(500, g.lanes[1].hook.origin));
  for (const offset of [400, 377.7, 503.3]) {
    const h = g.lanes[2].hook,
      press = g.elapsedMs + offset,
      expected = swingAngle(press, h.origin);
    stepTo(g, press, { 2: press });
    assert.equal(h.state, "out");
    near(h.angle, expected, 1e-12, "shot angle");
    // Straight out at that angle: the tip moves along one line.
    for (const dt of [50, 150, 250]) {
      const pose = hookPose(h, press + dt);
      if (h.state !== "out") break;
      near(pose.angle, expected, 1e-12);
    }
    settle(g, 2, "swing");
    // Back home the swing goes on from the shot's angle.
    near(swingAngle(h.home, h.origin), expected, 1e-9, "resumes at the shot angle");
  }
});

test("aim tolerance: a press up to 150 ms old (or 50 ms ahead) fires as pressed; others are moved to those limits; never before the hook was back", () => {
  assert.equal(G.aimToleranceMs, 150);
  const g = mining(2, [item("rock", 8, 11)]);
  run(g, 1000);
  const h = g.lanes[0].hook;
  // Pressed 140 ms ago (a slow link): fired from then, at that angle.
  g.step([{ shot: 1, at: g.elapsedMs + MS - 140 }]);
  near(h.fired, g.elapsedMs - 140, 1e-9);
  near(h.angle, swingAngle(g.elapsedMs - 140, h.origin), 1e-12);
  // The tip is already where it would be 140 ms after firing.
  near(hookPose(h, g.elapsedMs).length, G.restLength + ((G.depth - G.restLength) / G.shotSeconds) * 0.14, 1e-6);
  settle(g, 0, "swing");
  // Pressed 400 ms ago: fired 150 ms ago.
  g.step([undefined, { shot: 1, at: g.elapsedMs + MS - 400 }]);
  const h1 = g.lanes[1].hook;
  assert.equal(h1.fired, g.elapsedMs - 150);
  near(h1.angle, swingAngle(g.elapsedMs - 150, h1.origin), 1e-12);
  settle(g, 0, "swing");
  settle(g, 1, "swing");
  // A press a little ahead of the server's clock (its step ran early) fires as pressed; it
  // waits at rest until then, then flies.
  assert.equal(G.aheadMs, 50);
  const ahead = g.elapsedMs + MS + 30;
  g.step([{ shot: 2, at: ahead }]);
  assert.equal(h.fired, ahead);
  near(h.angle, swingAngle(ahead, h.origin), 1e-12);
  assert.equal(hookPose(h, g.elapsedMs).length, G.restLength, "not out before its moment");
  settle(g, 0, "swing");
  // One from further in the future is pulled back to 50 ms ahead.
  g.step([{ shot: 3, at: g.elapsedMs + 5000 }]);
  near(h.fired, g.elapsedMs + 50, 1e-9);
  settle(g, 0, "swing");
  // A press before the hook was back (its last shot's return) counts from the return.
  const home = h.home;
  g.step([{ shot: 4, at: home - 60 }]);
  assert.equal(h.fired, Math.max(home, g.elapsedMs - 150));
  assert.ok(h.fired >= home);
});

test("a shot only fires while the hook swings, during mining, once per shot number", () => {
  const g = new GoldMinerGame(2, Math.random, [item("big", -4.5, 9), item("small", 4.5, 9)]);
  g.step([{ shot: 1, at: 0 }]);
  assert.equal(g.lanes[0].hook.shots, 0, "countdown");
  while (g.phase === "countdown") g.step([{ shot: 1, at: 0 }]);
  run(g, 300);
  g.step([{ shot: 2, at: g.elapsedMs }]);
  assert.equal(g.lanes[0].hook.shots, 0, "a skipped shot number");
  g.step([{ shot: 1, at: g.elapsedMs }]);
  assert.equal(g.lanes[0].hook.shots, 1);
  const fired = g.lanes[0].hook.fired;
  g.step([{ shot: 1, at: g.elapsedMs }]);
  g.step([{ shot: 2, at: g.elapsedMs }]);
  assert.equal(g.lanes[0].hook.shots, 1, "a repeated packet, or a shot while out");
  assert.equal(g.lanes[0].hook.fired, fired);
  for (const bad of [NaN, Infinity]) assert.equal(g.shoot(1, { shot: 1, at: bad }), false);
});

test("catching: the first item the hook touches comes up and scores; an empty hook comes back from the edge", () => {
  const g = mining(2, [item("small", -4.5, 4), item("big", -4.5, 9), item("diamond", 5, 8)]);
  const h = g.lanes[0].hook;
  // Straight down: the small gold is in front of the big one.
  fire(g, 0, 0);
  settle(g, 0, "back");
  assert.equal(h.item, 0);
  assert.equal(g.items[0].state, "carried");
  near(h.reach, 4 - G.items.small.radius - G.hookRadius, 1e-9, "contact on the item's edge");
  assert.equal(g.items[1].state, "free");
  // While coming up, the item rides on the tip.
  const mid = (h.turn + h.home) / 2;
  assert.ok(hookPose(h, mid).length < h.reach && hookPose(h, mid).length > G.restLength);
  settle(g, 0, "swing");
  assert.equal(g.items[0].state, "banked");
  assert.equal(g.items[0].at, h.home);
  assert.equal(g.lanes[0].score, 50);
  assert.deepEqual(g.lanes[0].banked, [0]);
  // Far left: nothing there, it reaches the wall and comes back empty.
  fire(g, 0, -1.1);
  run(g, h.fired + 2000);
  assert.equal(h.state, "swing");
  assert.equal(g.lanes[0].score, 50);
  near(h.reach, edgeLength(g.pivot(0), h.angle), 1e-9);
  near(h.home - h.turn, returnMs(h.reach, null), 1e-6);
});

test("speeds: a shot reaches the bottom in about 0.6 s; back from the bottom empty 0.5 s, small gold and diamond 0.6 s, big gold 1.3 s, rock 2 s; never over 2 s", () => {
  const bottom = edgeLength(0, 0);
  near(bottom, G.depth - G.hookRadius, 1e-9);
  near(shotMs(bottom), 600, 25, "shot");
  near(returnMs(bottom, null), 500, 25, "empty");
  near(returnMs(bottom, "small"), 600, 25, "small");
  near(returnMs(bottom, "diamond"), 600, 25, "diamond");
  near(returnMs(bottom, "sack"), 1000, 30, "sack");
  near(returnMs(bottom, "big"), 1300, 40, "big");
  near(returnMs(bottom, "rock"), 2000, 60, "rock");
  // Heavier is slower, a shallower item comes up sooner, and nothing takes over 2 s (an empty hook over 0.6 s).
  assert.ok(returnMs(6, "small") < returnMs(6, "sack") && returnMs(6, "sack") < returnMs(6, "big") && returnMs(6, "big") < returnMs(6, "rock"));
  assert.ok(returnMs(5, "big") < returnMs(10, "big"));
  for (const kind of [...GOLD_KINDS, null]) assert.ok(returnMs(25, kind) <= (kind ? 2000 : 600));
  // The same times in a game: a rock from the bottom straight below.
  const g = mining(2, [item("rock", -4.5, G.depth - G.field.margin - G.items.rock.radius)]);
  fire(g, 0, 0);
  const h = g.lanes[0].hook;
  run(g, h.fired + 3000);
  near(h.turn - h.fired, shotMs(h.reach), 1e-6);
  near(h.home - h.turn, returnMs(h.reach, "rock"), 1e-6);
  // The lowest a rock can lie (its centre a radius above the margin): about 1.6 s.
  near(h.home - h.turn, (2000 * (h.reach - G.restLength)) / (G.depth - G.restLength), 1e-6, "rock");
  assert.ok(h.home - h.turn > 1500, `rock ${h.home - h.turn}`);
});

test("points: small gold 50, big gold 250, rock 10, diamond 400, sack 20–400", () => {
  assert.deepEqual(
    GOLD_KINDS.filter((k) => k !== "sack").map((k) => G.items[k].value),
    [50, 250, 10, 400]
  );
  const random = mulberry32(5),
    seen = new Set<number>();
  for (let i = 0; i < 20000; i++) {
    const v = sackValue(random);
    assert.ok(v >= 20 && v <= 400 && (v - 20) % 10 === 0, `sack ${v}`);
    seen.add(v);
  }
  assert.ok(seen.has(20) && seen.has(400), "both ends of the range");
  assert.equal(seen.size, 39);
  // Each kind scores its points once it is up; a sack's points stay hidden until then.
  const field = [item("small", -6, 5), item("big", 0, 9), item("rock", 6, 6), item("diamond", -6, 9.5), item("sack", 6, 9.5, 170)];
  const g = mining(3, field);
  const wire = goldSection(g, [0, 1, 2]);
  assert.deepEqual(wire.value, [50, 250, 10, 400, -1]);
  const pulls: [number, number][] = [[0, 0], [1, 1], [2, 2]];
  for (const [lane, index] of pulls) fire(g, lane, aim(g, lane, field[index].x, field[index].y), g.elapsedMs + MS);
  for (const lane of [0, 1, 2]) settle(g, lane, "swing");
  assert.deepEqual(g.lanes.map((l) => l.score), [50, 250, 10]);
  fire(g, 0, aim(g, 0, -6, 9.5));
  fire(g, 2, aim(g, 2, 6, 9.5));
  for (const lane of [0, 2]) settle(g, lane, "swing");
  assert.deepEqual(g.lanes.map((l) => l.score), [450, 250, 180]);
  assert.equal(goldSection(g, [0, 1, 2]).value[4], 170, "shown once up");
});

test("two hooks on one item: the earlier contact takes it, a tie goes to the lower lane; the other passes through", () => {
  // The diamond halfway between the pivots, a rock behind it on each side.
  const field = () => [item("diamond", 0, 6), item("rock", 4.5, 11), item("rock", -4.5, 11)];
  const tie = mining(2, field());
  const angle0 = aim(tie, 0, 0, 6),
    angle1 = aim(tie, 1, 0, 6);
  // Both pressed so they touch it at the same moment (a mirror image): lane 0 takes it.
  const t0 = whenAngle(tie.lanes[0].hook, angle0, 200);
  tie.lanes[1].hook.origin = tie.lanes[0].hook.origin + SWING_MS / 2;
  near(swingAngle(t0, tie.lanes[1].hook.origin), angle1, 1e-9, "mirror swing");
  stepTo(tie, t0, { 0: t0, 1: t0 });
  run(tie, t0 + 3500);
  assert.equal(tie.items[0].by, 0);
  assert.equal(tie.lanes[0].score, 400);
  // Lane 1 went on through the diamond's spot and took the rock behind it.
  assert.equal(tie.items[2].by, 1, "passed through");
  assert.equal(tie.lanes[1].score, 10);

  // Lane 1 pressed 40 ms earlier (its packet came in the same step): lane 1 takes it.
  const early = mining(2, field());
  const a = whenAngle(early.lanes[0].hook, angle0, 600);
  early.lanes[1].hook.origin = a - 40 - (Math.asin(angle1 / SWING_AMPLITUDE) * SWING_MS) / (2 * Math.PI);
  near(swingAngle(a - 40, early.lanes[1].hook.origin), angle1, 1e-9);
  stepTo(early, a, { 0: a, 1: a - 40 });
  run(early, a + 2500);
  assert.equal(early.items[0].by, 1, "earlier contact");
  assert.equal(early.items[1].by, 0, "lane 0 passed through to the rock behind");

  // A claim is final: lane 0 took it in an earlier step; a shot that arrives later but, fired
  // 150 ms back, would have touched it sooner does not take it back: everyone sees one owner.
  // The diamond is close to lane 1 and far from lane 0; a rock lies behind it on lane 1's line.
  const late = mining(2, [item("diamond", 3, 2.8), item("rock", 1.2, 6.17)]);
  const far = aim(late, 0, 3, 2.8),
    close = aim(late, 1, 3, 2.8);
  fire(late, 0, far, 300);
  settle(late, 0, "back");
  assert.equal(late.items[0].by, 0);
  const at = late.elapsedMs + MS - G.aimToleranceMs;
  late.lanes[1].hook.origin = at - (Math.asin(close / SWING_AMPLITUDE) * SWING_MS) / (2 * Math.PI);
  assert.ok(traceShot(late.items, late.pivot(1), close, at).turn < late.lanes[0].hook.turn, "it would have touched it first");
  late.step([undefined, { shot: 1, at }]);
  near(late.lanes[1].hook.angle, close, 1e-9);
  run(late, late.elapsedMs + 2500);
  assert.equal(late.items[0].by, 0);
  assert.equal(late.lanes[0].score, 400);
  assert.equal(late.items[1].by, 1, "passed through to the rock");
});

test("hooks pass through each other and through items other hooks carry", () => {
  // Mirror shots cross mid-mine at the same moment; each takes its own gold.
  const field = [item("small", 3, 9), item("small", -3, 9), item("big", -4.5, 8), item("rock", -7.5, 6)];
  const g = mining(2, field);
  const right = aim(g, 0, 3, 9),
    left = aim(g, 1, -3, 9);
  const t = whenAngle(g.lanes[0].hook, right, 200);
  g.lanes[1].hook.origin = g.lanes[0].hook.origin + SWING_MS / 2;
  stepTo(g, t, { 0: t, 1: t });
  near(g.lanes[1].hook.angle, left, 1e-9);
  const cross = (5.4 / Math.cos(right)) * 1;
  near(tipAt(g.pivot(0), hookPose(g.lanes[0].hook, t + shotMs(cross))).x, tipAt(g.pivot(1), hookPose(g.lanes[1].hook, t + shotMs(cross))).x, 0.05, "tips meet");
  run(g, t + 1500);
  assert.equal(g.items[0].by, 0);
  assert.equal(g.items[1].by, 1);
  assert.deepEqual(g.lanes.map((l) => l.score), [50, 50]);
  // Lane 0 pulls the big gold straight up; lane 1's shot crosses it on the way up, right through it.
  const h0 = g.lanes[0].hook,
    h1 = g.lanes[1].hook,
    f0 = whenAngle(h0, 0, g.elapsedMs + MS),
    up = traceShot(g.items, g.pivot(0), 0, f0, (i) => g.items[i].state !== "free");
  assert.equal(up.item, 2);
  const through = Math.atan2(-9, 4.5),
    spot = Math.hypot(9, 4.5);
  // The big gold's centre is 1.2 m below the tip: it is at (−4.5, 4.5) when the tip is at 3.3 m.
  const k = (up.reach - 3.3) / (up.reach - G.restLength),
    meet = up.turn + k * (up.home - up.turn),
    f1 = meet - shotMs(spot);
  assert.ok(f1 > f0 + MS);
  h1.origin = f1 - (Math.asin(through / SWING_AMPLITUDE) * SWING_MS) / (2 * Math.PI);
  stepTo(g, f0, { 0: f0 });
  stepTo(g, f1, { 1: f1 });
  run(g, meet);
  const tip = tipAt(g.pivot(1), hookPose(h1, meet)),
    gold = { x: -4.5, y: tipAt(g.pivot(0), hookPose(h0, meet)).y + G.items.big.radius + G.hookRadius };
  assert.equal(g.items[2].state, "carried");
  assert.ok(Math.hypot(tip.x - gold.x, tip.y - gold.y) < 0.1, "lane 1's tip is inside the carried gold");
  run(g, g.elapsedMs + 3000);
  assert.equal(g.items[2].by, 0);
  assert.equal(g.lanes[0].score, 300);
  assert.equal(g.items[3].by, 1, "went through the carried gold to the rock");
});

test("the mine: counts from config, inside, apart, every item hookable, a shared prize, balanced nearby value (thousands of mines)", () => {
  for (const lanes of [2, 3]) {
    const counts = fieldCounts(lanes),
      diamonds = new Set<number>();
    for (let seed = 1; seed <= 1000; seed++) {
      const items = generateField(lanes, mulberry32(seed * 7919 + lanes));
      const problems = fieldProblems(items, lanes);
      assert.deepEqual(problems, [], `${lanes}P seed ${seed}`);
      for (const kind of GOLD_KINDS) {
        const n = items.filter((i) => i.kind === kind).length,
          [min, max] = countRange(counts[kind]);
        assert.ok(n >= min && n <= max);
      }
      diamonds.add(items.filter((i) => i.kind === "diamond").length);
    }
    assert.deepEqual([...diamonds].sort(), lanes === 3 ? [1, 2] : [1], `${lanes}P diamonds`);
  }
  assert.deepEqual(fieldCounts(3), { big: 2, small: 5, rock: 3, diamond: [1, 2], sack: 2 });
  assert.deepEqual(fieldCounts(2), { big: 2, small: 4, rock: 2, diamond: 1, sack: 2 });
  // The validator really catches a broken mine.
  const good = generateField(3, mulberry32(1));
  assert.ok(fieldProblems([...good.slice(1)], 3).length, "a missing item");
  assert.ok(fieldProblems(good.map((it, i) => (i === 1 ? { ...it, x: good[0].x, y: good[0].y } : it)), 3).some((p) => p.includes("overlap")));
  assert.ok(fieldProblems(good.map((it, i) => (i === 0 ? { ...it, y: 1 } : it)), 3).some((p) => p.includes("outside")));
  // Every lane gets something near it; shared prizes exist.
  const near3 = nearValues(good, 3);
  assert.ok(near3.every((v) => v > 0));
  assert.ok(good.some((it, i) => (it.kind === "big" || it.kind === "diamond") && clearShots(good, i, 3).length >= 2));
});

test("30 s: mining stops at the limit; an item still on its way up does not count", () => {
  const g = mining(2, [item("big", -4.5, 10), item("small", 4.5, 4), item("rock", 0, 10.5)]);
  assert.equal(G.limit, 30);
  run(g, 28_900);
  // A big gold from the bottom takes over a second to come up: fired at 29.0 s, still rising at 30 s.
  g.lanes[0].hook.origin = 29_000;
  g.lanes[1].hook.origin = 29_500;
  assert.equal(fire(g, 0, 0, 29_000), 29_000);
  const h = g.lanes[0].hook;
  // A small gold near the top, fired at 29.5 s, is up before the end.
  assert.equal(fire(g, 1, 0, 29_500), 29_500);
  run(g, 31_000);
  assert.equal(g.phase, "results");
  assert.equal(g.ticks, G.limit * G.hz, "ended at 30 s");
  assert.ok(h.home > 30_000, "still rising");
  assert.equal(g.items[0].state, "carried");
  assert.equal(g.lanes[0].score, 0, "not counted");
  assert.equal(g.lanes[1].score, 50);
  g.step();
  assert.equal(g.items[0].state, "carried", "results freeze the mine");
  assert.equal(g.winner(), 1);
});

test("early end: once every item is up the round ends at once", () => {
  const g = mining(2, [item("small", -4.5, 4), item("diamond", 4.5, 5)]);
  fire(g, 0, 0, 100);
  fire(g, 1, 0, 100);
  run(g, g.elapsedMs + 3000);
  assert.equal(g.lanes[0].score + g.lanes[1].score, 450);
  assert.equal(g.phase, "results");
  const last = Math.max(g.lanes[0].hook.home, g.lanes[1].hook.home);
  assert.ok(g.elapsedMs - last < MS + 1e-9, `ended at ${g.elapsedMs}, last item up at ${last}`);
  assert.equal(g.winner(), 1);
});

test("places and ties: by points, equal points share a place, a tie for first is a draw", () => {
  const g = mining(3, [item("small", -6, 4), item("small", 0, 4), item("big", 6, 9), item("rock", 0, 11)]);
  fire(g, 0, 0, 100);
  fire(g, 1, 0, 100);
  settle(g, 0, "swing");
  settle(g, 1, "swing");
  assert.deepEqual(g.lanes.map((l) => l.score), [50, 50, 0]);
  g.ticks = g.limitTicks - 1;
  g.step();
  assert.equal(g.phase, "results");
  assert.deepEqual(g.places(), [0, 0, 2]);
  assert.equal(g.winner(), -1, "draw");
  const sim = new GoldRoundSimulation(undefined, 3);
  assert.ok(sim.start([2, 1, 0]));
  sim.game.lanes[sim.seats.indexOf(1)].score = 300;
  sim.game.lanes[sim.seats.indexOf(2)].score = 300;
  sim.game.lanes[sim.seats.indexOf(0)].score = 10;
  sim.game.phase = "results";
  sim.step(PLAYERS.map(() => IDLE_INPUT));
  assert.equal(sim.phase, "results");
  assert.equal(sim.winner, -1);
  assert.deepEqual(sim.placements(), [2, 0, 0]);
});

test("leaving: the leaver ranks last and the item on their hook is lost; the last player left wins at once", () => {
  const g = mining(3, [item("big", -6, 9), item("small", 0, 4), item("small", 6, 4)]);
  fire(g, 1, 0, 100);
  settle(g, 1, "swing");
  assert.equal(g.lanes[1].score, 50);
  fire(g, 0, 0, 1000);
  settle(g, 0, "back");
  assert.equal(g.items[0].state, "carried");
  g.remove(0);
  assert.equal(g.items[0].state, "lost");
  g.step();
  assert.equal(g.phase, "mining", "two still mining");
  g.remove(2);
  g.step();
  assert.equal(g.phase, "results");
  assert.equal(g.winner(), 1);
  assert.deepEqual(g.places(), [1, 0, 1]);
  // The leavers' order among themselves still follows their points.
  const h = mining(3, [item("small", -6, 4), item("small", 0, 4), item("rock", 6, 11)]);
  fire(h, 0, 0, 100);
  settle(h, 0, "swing");
  assert.equal(h.lanes[0].score, 50);
  h.remove(0);
  h.remove(1);
  h.step();
  assert.equal(h.winner(), 2);
  assert.deepEqual(h.places(), [1, 2, 0]);
});

test("a dropped player's hook keeps swinging and a shot in flight still comes home", () => {
  const sim = new GoldRoundSimulation(undefined, 11);
  assert.ok(sim.start([0, 1]));
  const idle = PLAYERS.map(() => IDLE_INPUT);
  while (sim.phase === "countdown") sim.step(idle);
  const g = sim.game;
  g.items.forEach((it, i) => i > 1 && (it.state = "lost"));
  Object.assign(g.items[0], { kind: "small", r: G.items.small.radius, value: 50, x: g.pivot(0), y: 6 });
  Object.assign(g.items[1], { kind: "small", r: G.items.small.radius, value: 50, x: g.pivot(1), y: 10 });
  const h = g.lanes[0].hook,
    at = whenAngle(h, 0, 300);
  while ((g.ticks + 1) * MS < at) sim.step(idle);
  sim.step(PLAYERS.map((p) => (p.id === sim.seats[0] ? { ...IDLE_INPUT, gold: { seq: 1, round: sim.roundId, shot: 1, at } } : IDLE_INPUT)));
  assert.equal(h.state, "out");
  sim.neutralize(sim.seats[0]);
  for (let i = 0; i < 90; i++) sim.step(idle);
  assert.equal(g.lanes[0].score, 50, "came home while away");
  assert.equal(h.state, "swing");
  const a = hookPose(h, g.elapsedMs).angle;
  sim.step(idle);
  assert.notEqual(hookPose(h, g.elapsedMs).angle, a, "still swinging");
});

test("the round simulation: player counts, slots (not seats) as winner, placements per slot, a fresh mine every round", () => {
  const sim = new GoldRoundSimulation(undefined, 21);
  assert.equal(sim.start([0]), false);
  assert.ok(MODE_PLAYERS.gold_miner.min === 2 && MODE_PLAYERS.gold_miner.max === 3);
  assert.ok(sim.start([2, 1]));
  const first = sim.game.items.map((i) => `${i.x},${i.y}`).join();
  const idle = PLAYERS.map(() => IDLE_INPUT);
  while (sim.phase === "countdown") sim.step(idle);
  assert.equal(sim.phase, "playing");
  const lane2 = sim.seats.indexOf(2);
  sim.game.lanes[lane2].score = 99;
  sim.game.ticks = sim.game.limitTicks - 1;
  sim.step(idle);
  assert.equal(sim.phase, "results");
  assert.equal(sim.winner, 2, "the winning lane's slot");
  assert.deepEqual(sim.placements(), [-1, 1, 0]);
  const snap = sim.snapshot([0, 0, 0]);
  assert.equal(snap.v, 17);
  assert.equal(snap.winner, 2);
  assert.ok(validGoldWire(snap.gold));
  assert.equal(snap.transforms.byteLength, 0);
  for (let t = 0; t < G.results * G.hz + 1; t++) sim.step(idle);
  assert.equal(sim.phase, "waiting");
  assert.ok(sim.start([0, 1, 2]));
  assert.notEqual(sim.game.items.map((i) => `${i.x},${i.y}`).join(), first);
  // The places at the top turn every round: each player takes the middle in turn.
  const middles = new Set<number>();
  for (let round = 0; round < 3; round++) {
    if (round) {
      sim.game.ticks = sim.game.limitTicks;
      sim.game.phase = "results";
      sim.step(idle);
      for (let t = 0; t < G.results * G.hz + 1; t++) sim.step(idle);
      assert.ok(sim.start([0, 1, 2]));
    }
    assert.deepEqual([...sim.seats].sort(), [0, 1, 2]);
    middles.add(sim.seats[1]);
  }
  assert.equal(middles.size, 3);
  assert.equal(sim.game.items.length >= 13, true, "3P mine");
  assert.equal(validGoldWire({ ...snap.gold, kind: [99] }), false);
});

test("mailbox: the newest shot waits for the next step, however late; strict packets", () => {
  const box = new InputMailbox();
  assert.equal(box.accept({ seq: 1, round: 2, shot: 1, at: 50 }, 2, 0, "gold_miner"), true);
  assert.equal(box.accept({ seq: 1, round: 2, shot: 2, at: 60 }, 2, 0, "gold_miner"), false, "replayed seq");
  assert.equal(box.accept({ seq: 2, round: 1, shot: 2, at: 60 }, 2, 0, "gold_miner"), false, "old round");
  assert.deepEqual(box.read(10_000).gold, { seq: 1, round: 2, shot: 1, at: 50 });
  assert.equal(box.processedSeq, 1);
  assert.equal(box.read(10_001).gold, undefined, "read once");
  for (const bad of [{ seq: 4, round: 2, shot: 0, at: 1 }, { seq: 4, round: 2, shot: 1, at: NaN }, { seq: 4, round: 2, shot: 1.5, at: 1 }, { seq: 4, round: 2, shot: 1, at: 1, x: 1 }, { seq: 4, round: 2, shot: 1 }, [1]])
    assert.equal(validateGoldInput(bad), null, JSON.stringify(bad));
});

test("Altın Madenci is in Mixed, in the board's mini games and in the Yerel Test Arenası for 2 and 3 players", () => {
  assert.ok(GAME_MODES.includes("gold_miner"));
  assert.ok(LOCAL_ARENA_IDS.includes("gold_miner"));
  for (const count of [2, 3]) {
    assert.ok(modeFits("gold_miner", count));
    const mixed = new MixedRotation(() => 0.5);
    mixed.setPlayers(count);
    const cycle = GAME_MODES.filter((m) => modeFits(m, count)).map(() => {
      const mode = mixed.next;
      mixed.played();
      return mode;
    });
    assert.ok(cycle.includes("gold_miner"), `Mixed ${count}P`);
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
    assert.ok(minis.includes("gold_miner"), `Tahta Oyunu ${count}P: ${minis.join(",")}`);
  }
  assert.ok(!modeFits("gold_miner", 1) && !modeFits("gold_miner", 4));
});

/* A real room: shots during the countdown are dropped, a shot fires and scores, a dropped
   player's hook keeps going and they shoot again once back, and the results reach everyone. */
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
  return { r, snapshots, shoot: (shot: number, at: number, round: number) => r.send("input", { seq: ++seq, round, shot, at }) };
}
async function lobby(count: number) {
  const peers = [await peer()];
  for (let i = 1; i < count; i++) peers.push(await peer(peers[0].r.roomId));
  const room = matchMaker.getLocalRoomById(peers[0].r.roomId) as PartyRoom;
  peers[0].r.send("mode", "gold_miner");
  await until(() => room.selection === "gold_miner");
  for (const p of peers) p.r.send("ready", true);
  await until(() => room.game.phase === "countdown");
  const sim = room.game as GoldRoundSimulation;
  assert.ok(sim instanceof GoldRoundSimulation);
  const lane = (p: (typeof peers)[number]) => sim.seats.indexOf(room.state.players.get(p.r.sessionId)!.slot as never);
  return { peers, room, sim, lane };
}
async function close(peers: { r: Room<unknown, LobbyState> }[]) {
  for (const p of peers) {
    p.r.reconnection.enabled = false;
    if (p.r.connection.isOpen) await p.r.leave();
  }
}
/** Puts a small gold straight below `lane`'s pivot, 5 m down (the rest of the mine out of the way). */
function target(sim: GoldRoundSimulation, lane: number, index: number) {
  Object.assign(sim.game.items[index], { kind: "small", r: G.items.small.radius, value: 50, x: sim.game.pivot(lane), y: 5, state: "free", by: -1 });
}

for (const count of [2, 3])
  test(`room ${count}P: countdown shots dropped, a shot scores, a dropped hook comes home, back and shooting, results`, { timeout: 30000 }, async () => {
    const { peers, room, sim, lane } = await lobby(count);
    // Clear the mine except one item per lane (and a spare), right below each pivot.
    const g = sim.game;
    g.items.forEach((it) => Object.assign(it, { state: "lost" }));
    for (let l = 0; l < count; l++) target(sim, l, l);
    target(sim, lane(peers[0]), count);
    g.items[count].y = 9;
    peers[0].shoot(1, 0, sim.roundId);
    await until(() => room.game.phase === "playing");
    await pause(80);
    assert.equal(g.lanes[lane(peers[0])].hook.shots, 0, "shot sent during the countdown");
    // Straight down at the next zero crossing of the swing (stamped as the client saw it).
    const down = (l: number) => whenAngle(g.lanes[l].hook, 0, g.elapsedMs + 60);
    const l0 = lane(peers[0]);
    let at = down(l0);
    await until(() => g.elapsedMs >= at);
    peers[0].shoot(1, at, sim.roundId);
    peers[0].shoot(1, at, sim.roundId);
    await until(() => g.lanes[l0].score === 50);
    assert.equal(g.lanes[l0].hook.shots, 1, "a repeated packet fired once");
    near(g.lanes[l0].hook.angle, 0, 1e-9, "fired at the stamped angle");
    // A dropped player's shot in flight comes home; their hook keeps swinging.
    const l1 = lane(peers[1]);
    at = down(l1);
    await until(() => g.elapsedMs >= at);
    peers[1].shoot(1, at, sim.roundId);
    await until(() => g.lanes[l1].hook.state === "out");
    const r = peers[1].r,
      id = r.sessionId;
    r.connection.close(4010);
    await until(() => !room.state.players.get(id)!.connected);
    await until(() => g.lanes[l1].score === 50);
    await until(() => room.state.players.get(id)!.connected);
    assert.equal(room.game, sim);
    // Back: they shoot again (the spare, far below lane 0, is out of reach; a wall shot returns empty).
    at = down(l1) + 0;
    await until(() => g.elapsedMs >= at);
    peers[1].shoot(2, at, sim.roundId);
    await until(() => g.lanes[l1].hook.shots === 2);
    // Lane 0 takes the deep spare: 100 points against 50 (and 50 for a third player if present).
    if (count === 3) {
      const l2 = lane(peers[2]);
      at = down(l2);
      await until(() => g.elapsedMs >= at);
      peers[2].shoot(1, at, sim.roundId);
      await until(() => g.lanes[l2].score === 50);
    }
    at = down(l0);
    await until(() => g.elapsedMs >= at);
    peers[0].shoot(2, at, sim.roundId);
    await until(() => g.lanes[l0].score === 100);
    await until(() => room.game.phase === "results", 4000);
    const slot = (i: number) => room.state.players.get(peers[i].r.sessionId)!.slot;
    assert.equal(room.state.winner, slot(0));
    const places = sim.placements();
    assert.equal(places[slot(0)], 0);
    assert.equal(places[slot(1)], 1);
    if (count === 3) assert.equal(places[slot(2)], 1, "a tie shares the place");
    await until(() => peers[0].snapshots.at(-1)?.phase === "results");
    const shown = peers[0].snapshots.at(-1)!;
    assert.equal(shown.v, 17);
    assert.ok(validGoldWire(shown.gold));
    assert.equal(shown.winner, slot(0));
    assert.ok(shown.gold!.elapsed < G.limit * 1000, "ended early: every item up");
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
