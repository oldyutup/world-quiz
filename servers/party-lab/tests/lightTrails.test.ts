/**
 * Işık İzi: running and turning (smooth, diagonal, U-turn), the trails' life and fade (killing
 * while fading), your own trail's spared head end, swept hits, walls, heads meeting, the train
 * (warning, run, kills, wipes), the last 15 s, winning, places, the start ring, dropping and
 * leaving, the wire, the bots, the round simulation and a real room.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Client, type Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { createPartyServer } from "../src/server.js";
import type { PartyRoom } from "../src/PartyRoom.js";
import type { LobbyState } from "../src/state.js";
import { LIGHT_TRAILS as L, ticks } from "../../../shared/party-lab/simulation/trails/config.js";
import {
  DEATH_FADE,
  HEAD,
  HIT,
  LEFT,
  LIFE,
  RUSH_AT,
  SELF,
  SPAWN_AXES,
  TRAIL,
  TRAIN,
  TrailGame,
  WALL,
  onCentimetre,
  ringPoint,
  speedAt,
  steer,
  trailAlpha,
  turnRateAt,
  visitTrail,
  type TrailInput,
} from "../../../shared/party-lab/simulation/trails/game.js";
import { segmentDistance, sweepSegment } from "../../../shared/party-lab/simulation/trails/sweep.js";
import { TRAIN_PASSES, TRAIN_SPEED, trainDir, trainEnter, trainLeave, trainSpan, trainState, trainWarn } from "../../../shared/party-lab/simulation/trails/train.js";
import { TrailBot, type TrailBotLevel } from "../../../shared/party-lab/simulation/trails/bots.js";
import { restoreTrails, trailSection, validTrailWire, wireLines } from "../../../shared/party-lab/simulation/trails/wire.js";
import { TrailRoundSimulation } from "../../../shared/party-lab/simulation/trailRound.js";
import { mulberry32 } from "../../../shared/party-lab/simulation/colors/layouts.js";
import { validateTrailInput } from "../../../shared/party-lab/network/trailInput.js";
import { InputMailbox, NET, type GameSnapshot } from "../../../shared/party-lab/network/protocol.js";
import { GAME_MODES, MODE_NAMES, MODE_PLAYERS, MixedRotation, modeFits } from "../../../shared/party-lab/modes.js";
import { LOCAL_ARENA_IDS } from "../../../shared/party-lab/localArenas.js";
import { BoardSession, type BoardHost } from "../../../shared/party-lab/board/session.js";
import { boardSquares } from "../../../shared/party-lab/board/config.js";
import { PLAYERS, type PlayerId } from "../../../shared/party-lab/simulation/players.js";

const HALF_X = L.width / 2,
  HALF_Z = L.depth / 2,
  PER_STEP = L.turnRate / L.hz,
  RADIUS_TURN = L.speed / L.turnRate;
const UP: TrailInput = { x: 0, z: -1 },
  DOWN: TrailInput = { x: 0, z: 1 },
  LEFTWARD: TrailInput = { x: -1, z: 0 },
  RIGHTWARD: TrailInput = { x: 1, z: 0 };

/** A game already playing (the countdown run through). */
function playing(count: number, turn = 0.1) {
  const game = new TrailGame(count, mulberry32(1), turn);
  while (game.phase === "countdown") game.step();
  return game;
}
/** Puts `lane` at (x, z) facing `a` with a fresh trail starting there. */
function place(game: TrailGame, lane: number, x: number, z: number, a: number) {
  Object.assign(game.players[lane], { x, z, a });
  Object.assign(game.lines[lane], { x: [onCentimetre(x)], z: [onCentimetre(z)], t: [game.ticks], cut: [false] });
}
/** Keeps `lane` standing still at (x, z) without a trail (it stays in the round, out of the way). */
function park(game: TrailGame, lane: number, x: number, z: number) {
  Object.assign(game.players[lane], { x, z, a: 0 });
  Object.assign(game.lines[lane], { x: [], z: [], t: [], cut: [] });
}
/** `lane` is only a trail now: not running (and not dead), its line as given, laid at `born`. */
function ghost(game: TrailGame, lane: number, points: [number, number][], born: number) {
  Object.assign(game.players[lane], { alive: false, died: -1, x: 100, z: 100 });
  Object.assign(game.lines[lane], { x: points.map((p) => onCentimetre(p[0])), z: points.map((p) => onCentimetre(p[1])), t: points.map(() => born), cut: points.map(() => false) });
}
/** Steps with these keys; parked lanes stay parked. Stops at results. */
function run(game: TrailGame, steps: number, inputs: (TrailInput | undefined)[] = [], parked: Record<number, [number, number]> = {}) {
  for (let i = 0; i < steps && game.phase !== "results"; i++) {
    for (const [lane, at] of Object.entries(parked)) park(game, Number(lane), at[0], at[1]);
    game.step(inputs);
  }
}
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** Pieces of a trail visible at `step` (no grace). */
function pieces(game: TrailGame, lane: number, step = game.ticks) {
  const out: number[][] = [];
  const p = game.players[lane];
  visitTrail(game.lines[lane], p.died, step, p.alive && !p.out ? p : null, 0, (ax, az, bx, bz) => out.push([ax, az, bx, bz]));
  return out;
}

test("running: never stops — 7 m/s straight on without keys; keys are screen directions; turns at most 294°/s; diagonals; a U-turn is a smooth half circle", () => {
  const g = playing(2),
    p = g.players[0],
    parked = { 1: [10, 7] as [number, number] };
  place(g, 0, -8, -4, 0);
  run(g, 60, [], parked);
  assert.ok(Math.abs(p.x - (-8 + L.speed)) < 1e-9 && Math.abs(p.z + 4) < 1e-9 && p.a === 0, "a second straight on: 5 m along x");
  // W from heading right: up the screen, eased at the turn rate, never a jump.
  place(g, 0, -8, 3, 0);
  let before = p.a,
    turning = 0;
  for (let i = 0; i < 40; i++) {
    run(g, 1, [UP], parked);
    const d = Math.abs(wrap(p.a - before));
    assert.ok(d <= PER_STEP + 1e-12, `step ${i}: turned ${d}`);
    if (d > 0) turning++;
    before = p.a;
  }
  assert.equal(p.a, -Math.PI / 2, "W: up the screen");
  assert.equal(turning, Math.ceil(Math.PI / 2 / PER_STEP), "90° takes 90/4.9 steps");
  // Two keys: the diagonal.
  run(g, 30, [{ x: 1, z: -1 }], parked);
  assert.ok(Math.abs(p.a + Math.PI / 4) < 1e-12, "W+D: up and right");
  run(g, 60, [{ x: -1, z: 1 }], parked);
  assert.ok(Math.abs(p.a - (3 * Math.PI) / 4) < 1e-12, "S+A: down and left");
  // The exact opposite: a U-turn, smooth, on the turning circle (no death on its own trail).
  place(g, 0, -6, -5, 0);
  const start = { x: p.x, z: p.z };
  let widest = 0;
  for (let i = 0; i < 70; i++) {
    const was = p.a;
    run(g, 1, [LEFTWARD], parked);
    assert.ok(Math.abs(wrap(p.a - was)) <= PER_STEP + 1e-12);
    widest = Math.max(widest, Math.abs(p.z - start.z));
  }
  assert.equal(p.a, Math.PI);
  assert.ok(p.alive, "a U-turn never hits your own trail");
  assert.ok(Math.abs(widest - 2 * RADIUS_TURN) < 0.12, `turning circle ${widest.toFixed(3)} m across, ${(2 * RADIUS_TURN).toFixed(3)} expected`);
  // steer() alone: no keys keeps the heading exactly.
  const head = { x: 0, z: 0, a: 1.234 };
  steer(head, undefined, 10);
  assert.equal(head.a, 1.234);
});

test("trails: a point every 3 steps on the centimetre; each lives 2.5 s, fading over its last 0.6 s", () => {
  assert.equal(L.trailLife, 2.5);
  assert.equal(L.trailFade, 0.6);
  const g = playing(2),
    parked = { 1: [10, 7] as [number, number] };
  place(g, 0, -10, -6, 0);
  run(g, 90, [], parked);
  const line = g.lines[0];
  for (let i = 1; i < line.t.length; i++) assert.equal(line.t[i] - line.t[i - 1], 3);
  for (const v of [...line.x, ...line.z]) assert.equal(v, onCentimetre(v));
  // Brightness: full until 1.9 s, then down to nothing at 2.5 s; a dead trail goes in 0.4 s.
  assert.equal(trailAlpha(0, -1, ticks(1.9)), 1);
  assert.ok(Math.abs(trailAlpha(0, -1, ticks(2.2)) - 0.5) < 1e-9);
  assert.ok(trailAlpha(0, -1, ticks(2.45)) > 0, "still there just before the end");
  assert.equal(trailAlpha(0, -1, LIFE), 0);
  assert.ok(Math.abs(trailAlpha(0, 100, 100 + DEATH_FADE / 2) - 0.5) < 1e-9);
  assert.equal(trailAlpha(0, 100, 100 + DEATH_FADE), 0);
  // Old points go: straight on, the visible trail is exactly 2.5 s of running behind the head.
  place(g, 0, -10, -6, 0);
  run(g, LIFE + 30, [], parked);
  const p = g.players[0];
  assert.ok(p.alive);
  assert.ok(g.lines[0].t[1] + LIFE > g.ticks, "pruned");
  const tail = Math.min(...pieces(g, 0).map(([ax, , bx]) => Math.min(ax, bx)));
  assert.ok(Math.abs(p.x - tail - L.speed * L.trailLife) < 0.01, `trail ${(p.x - tail).toFixed(3)} m long`);
});

test("a trail kills as long as it can be seen: while fading too (2.3 s old), not once it is gone (2.6 s)", () => {
  for (const [age, dies] of [
    [2.3, true],
    [2.45, true],
    [1.5, true],
    [2.6, false],
  ] as const) {
    const g = playing(3),
      parked = { 2: [10, 7] as [number, number] };
    // Lane 1's trail across x at z = −5; lane 0 runs up into it from 2 m below (0.23 s).
    const reach = Math.round(((2 - HIT) / L.speed) * L.hz);
    ghost(g, 1, [
      [-5, -5],
      [5, -5],
    ], g.ticks - ticks(age) + reach);
    place(g, 0, 0, -3, -Math.PI / 2);
    run(g, 30, [], parked);
    assert.equal(!g.players[0].alive, dies, `${age} s old`);
    if (dies) {
      assert.equal(g.players[0].cause, TRAIL);
      assert.equal(g.players[0].by, 1);
      assert.ok(Math.abs(g.players[0].z - (-5 + HIT)) < 1e-6, "stopped where it touched");
      if (age > L.trailLife - L.trailFade) assert.ok(trailAlpha(g.lines[1].t[0] ?? 0, -1, g.players[0].died) < 1, "it was fading");
    }
  }
});

test("your own trail: the newest 0.7 m never hits you; the rest does (a full circle kills)", () => {
  const g = playing(2),
    p = g.players[0],
    parked = { 1: [10, 7] as [number, number] };
  // Grace by length along the line from the head.
  place(g, 0, -10, 0.5 - 6, 0);
  run(g, 30, [], parked);
  const spared: number[][] = [];
  visitTrail(g.lines[0], -1, g.ticks, p, L.selfGrace, (ax, az, bx, bz) => spared.push([ax, az, bx, bz]));
  const nearest = Math.max(...spared.map((s) => s[2]));
  assert.ok(Math.abs(p.x - nearest - L.selfGrace) < 1e-9, `spared to ${nearest} (head ${p.x})`);
  // Turning clockwise without end: round the circle into your own trail.
  place(g, 0, 0, -4, 0);
  let steps = 0;
  while (p.alive && steps < 300) {
    const target = p.a + Math.PI / 2,
      keys = { x: Math.round(Math.cos(target)), z: Math.round(Math.sin(target)) };
    run(g, 1, [keys], parked);
    steps++;
  }
  assert.ok(!p.alive && p.cause === SELF, `cause ${p.cause}`);
  const lap = (2 * Math.PI * RADIUS_TURN) / L.speed;
  assert.ok(steps / L.hz > lap * 0.8 && steps / L.hz < lap * 1.15, `${(steps / L.hz).toFixed(2)} s for a lap of ${lap.toFixed(2)} s`);
});

test("the tightest turn (the turn rate held, three quarters round) never comes near your own trail past the grace, at either speed", () => {
  assert.equal(L.speed, 7);
  assert.ok(Math.abs(L.turnRate - (294 * Math.PI) / 180) < 1e-12, "294°/s");
  assert.ok(Math.abs(L.speed / L.turnRate - 5 / ((210 * Math.PI) / 180)) < 1e-12, "the same turning circle as 5 m/s at 210°/s");
  for (const rush of [false, true]) {
    const g = playing(2),
      p = g.players[0];
    if (rush) g.ticks = RUSH_AT + 5;
    place(g, 0, -4, -4, 0);
    const lap = Math.round((2 * Math.PI) / (turnRateAt(g.ticks + 1) / L.hz));
    let closest = Infinity;
    for (let i = 0; i < lap * 0.75; i++) {
      run(g, 1, [{ x: Math.round(Math.cos(p.a + Math.PI / 2)), z: Math.round(Math.sin(p.a + Math.PI / 2)) }], { 1: [10, 7] });
      assert.ok(p.alive, `${rush ? "rush" : "normal"}: step ${i}`);
      visitTrail(g.lines[0], -1, g.ticks, p, L.selfGrace, (ax, az, bx, bz) => (closest = Math.min(closest, segmentDistance(p.x, p.z, ax, az, bx, bz))));
    }
    assert.ok(closest > HIT + 0.2, `${rush ? "rush" : "normal"}: ${closest.toFixed(3)} m`);
  }
});

test("swept hits: a head moving 3 m in one step cannot jump a thin trail (both ends clear of it)", () => {
  // The bare test: from 1.5 m left to 1.5 m right of a line across its way.
  const f = sweepSegment(-1.5, 0, 3, 0, 0, -1, 0, 1, HIT);
  assert.ok(Math.abs(f - (1.5 - HIT) / 3) < 1e-12, `touches at ${f}`);
  assert.equal(sweepSegment(-1.5, 0, 3, 0, 0, 0.5, 0, 1, HIT), Infinity, "passes beside its end");
  assert.ok(Math.abs(sweepSegment(-1.5, 0.8, 3, 0, 0, -1, 0, 0.5, HIT) - (1.5 - Math.sqrt(HIT * HIT - 0.09)) / 3) < 1e-9, "round its end");
  // The game's own check, as each step runs it.
  const g = playing(3);
  ghost(g, 1, [
    [0, -6],
    [0, -2],
  ], g.ticks);
  park(g, 0, -1.5, -4);
  const hit = g.hazard(0, { x: -1.5, z: -4 }, { x: 1.5, z: -4 }, g.ticks + 1);
  assert.ok(hit && hit.cause === TRAIL && hit.by === 1 && Math.abs(hit.f - (1.5 - HIT) / 3) < 1e-12);
  assert.equal(g.hazard(0, { x: -1.5, z: -1 }, { x: 1.5, z: -1 }, g.ticks + 1), null, "beside it: clear");
  // At the last 15 s speed, running across trails at a shallow angle never slips through.
  for (let k = 0; k < 40; k++) {
    const r = playing(3),
      angle = 0.05 + k * 0.02;
    r.ticks = RUSH_AT + 10;
    ghost(r, 1, [
      [-6, -4],
      [6, -4],
    ], r.ticks);
    place(r, 0, -3, -4 + 3 * Math.sin(angle), -angle);
    run(r, 120, [], { 2: [10, 7] });
    assert.equal(r.players[0].cause, TRAIL, `angle ${angle.toFixed(2)}`);
  }
});

test("walls: running into one kills there (WALL), never past it", () => {
  for (const [x, z, a] of [
    [8, -4, 0],
    [-8, 4, Math.PI],
    [3, 4, Math.PI / 2],
    [3, -4, -Math.PI / 2],
    [8, 4, Math.PI / 4],
  ]) {
    const g = playing(2),
      p = g.players[0];
    place(g, 0, x, z, a);
    run(g, 200, [], { 1: [-10, 0.5] });
    assert.equal(p.cause, WALL);
    assert.ok(Math.abs(p.x) <= HALF_X - L.radius + 1e-9 && Math.abs(p.z) <= HALF_Z - L.radius + 1e-9);
    assert.ok(Math.abs(p.x) > HALF_X - L.radius - 1e-6 || Math.abs(p.z) > HALF_Z - L.radius - 1e-6, "touching it");
  }
});

test("heads meeting: both die in the same step (HEAD), a two-player round is a draw; running into a trail just behind a head kills only the runner", () => {
  const g = playing(2);
  place(g, 0, -3, -5, 0);
  place(g, 1, 3, -5, Math.PI);
  run(g, 60);
  assert.deepEqual(g.players.map((p) => p.cause), [HEAD, HEAD]);
  assert.equal(g.players[0].died, g.players[1].died);
  assert.equal(g.players[0].by, 1);
  assert.ok(Math.abs(g.players[1].x - g.players[0].x - 2 * L.radius) < 1e-6, "touching");
  assert.equal(g.phase, "results");
  assert.equal(g.winner(), -1);
  assert.deepEqual(g.places(), [0, 0]);
  // Across someone's way 2 m behind it: only the runner.
  const t = playing(3),
    parked = { 2: [10, 7] as [number, number] };
  place(t, 1, -6, -5, 0);
  run(t, 30, [], parked);
  place(t, 0, t.players[1].x - 2, -3, -Math.PI / 2);
  run(t, 40, [], parked);
  assert.equal(t.players[0].cause, TRAIL);
  assert.equal(t.players[0].by, 1);
  assert.ok(t.players[1].alive);
});

test("the train: 8 s then every 10 s, 2 s of warning first, crosses in 0.6 s (the rail shut ~1 s), turning about each time", () => {
  assert.equal(TRAIN_PASSES, 6);
  assert.deepEqual(Array.from({ length: TRAIN_PASSES }, (_, k) => trainEnter(k) / L.hz), [8, 18, 28, 38, 48, 58]);
  assert.equal(trainWarn(0), ticks(6));
  assert.ok(Math.abs(L.width / TRAIN_SPEED - L.train.cross) < 1e-12);
  assert.ok(trainLeave(TRAIN_PASSES - 1) <= L.limit * L.hz, "the last one is out before the end");
  assert.deepEqual(trainState(ticks(5)), { k: 0, dir: 1, phase: "wait", until: 3 });
  assert.equal(trainState(ticks(6)).phase, "warn");
  assert.equal(trainState(ticks(8)).phase, "run");
  assert.equal(trainState(trainLeave(0)).phase, "wait");
  assert.equal(trainState(trainLeave(TRAIN_PASSES - 1)).phase, "done");
  assert.equal(trainSpan(trainWarn(0) + 60), null, "warning: no train yet");
  // Left to right first: the front at the left wall, then the whole width, then gone.
  assert.deepEqual(trainSpan(trainEnter(0))!.x0, -HALF_X);
  // The front at the far wall after 0.6 s, the whole train (20 m) on the rail; every bit of it run over by the end.
  const middle = trainSpan(trainEnter(0) + ticks(L.train.cross))!;
  assert.ok(Math.abs(middle.x1 - HALF_X) < 1e-9 && Math.abs(middle.x1 - middle.x0 - L.train.length) < 1e-9, `${middle.x0}…${middle.x1}`);
  let x0 = Infinity,
    x1 = -Infinity;
  for (let s = trainEnter(0); s < trainLeave(0); s++) {
    const span = trainSpan(s)!;
    x0 = Math.min(x0, span.x0);
    x1 = Math.max(x1, span.x1);
  }
  assert.deepEqual([x0, x1], [-HALF_X, HALF_X]);
  assert.equal(trainSpan(trainLeave(0)), null);
  assert.equal(trainDir(1), -1);
  assert.ok(trainSpan(trainEnter(1) + 5)!.x1 === HALF_X && trainSpan(trainEnter(1) + 5)!.front < HALF_X, "then right to left");
});

test("the train kills everyone on the rail it runs over and wipes the trails there (not the rest); the warning itself is harmless", () => {
  // On the rail while it blinks: nothing happens.
  const w = playing(2),
    parked = { 1: [10, 7] as [number, number] };
  w.ticks = trainWarn(0) + 10;
  place(w, 0, -10, 0, 0);
  run(w, trainEnter(0) - w.ticks - 2, [], parked);
  assert.ok(w.players[0].alive, "warning only");
  // Running along the rail when it comes: dead (TRAIN), counted.
  run(w, 40, [], parked);
  assert.equal(w.players[0].cause, TRAIN);
  assert.equal(w.trainKills, 1);
  // A trail across the rail: the train wipes the part on it, the rest stays and still kills.
  const g = playing(3),
    keep = { 0: [-10, -7] as [number, number], 2: [10, 7] as [number, number] };
  g.ticks = trainEnter(0) - 30;
  const points: [number, number][] = [];
  for (let z = -4; z <= 4.001; z += 0.25) points.push([5, z]);
  ghost(g, 1, points, g.ticks);
  run(g, trainLeave(0) - g.ticks + 2, [], keep);
  const left = pieces(g, 1);
  assert.ok(left.length > 0);
  for (const [, az, , bz] of left) assert.ok(Math.min(Math.abs(az), Math.abs(bz)) > L.train.halfWidth + L.trailRadius - 1e-9, `kept on the rail: ${az}…${bz}`);
  assert.ok(left.some(([, az]) => az < -3.5) && left.some(([, , , bz]) => bz > 3.5), "the ends stay");
  // Through the wiped gap: clear; into the part left: dead.
  assert.equal(g.hazard(0, { x: 3, z: 0 }, { x: 7, z: 0 }, g.ticks), null);
  assert.equal(g.hazard(0, { x: 3, z: -3 }, { x: 7, z: -3 }, g.ticks)?.cause, TRAIL);
});

test("the last 15 s: everyone runs and turns 1.3× as fast (the same turning circle)", () => {
  assert.equal(RUSH_AT, ticks(45));
  assert.equal(speedAt(RUSH_AT), L.speed);
  assert.equal(speedAt(RUSH_AT + 1), L.speed * 1.3);
  assert.equal(turnRateAt(RUSH_AT + 1), L.turnRate * 1.3);
  assert.ok(Math.abs(speedAt(RUSH_AT + 1) / turnRateAt(RUSH_AT + 1) - RADIUS_TURN) < 1e-12);
  const g = playing(2),
    p = g.players[0];
  g.ticks = RUSH_AT;
  place(g, 0, -10, -6, 0);
  run(g, 60, [], { 1: [10, 7] });
  assert.ok(Math.abs(p.x - (-10 + L.speed * 1.3)) < 1e-9, `${p.x}`);
});

test("winning and places: the last one running wins that very step; out in the same step share a place; all out at once is a draw; time up: the rest draw", () => {
  // 3P: lane 2 into a wall first, lane 1 ten steps later: lane 0 wins at once.
  const g = playing(3);
  place(g, 0, -6, -5, 0);
  place(g, 1, 0, -HALF_Z + L.radius + (L.speed / L.hz) * 10.5, -Math.PI / 2);
  place(g, 2, 6, -HALF_Z + L.radius + (L.speed / L.hz) * 0.5, -Math.PI / 2);
  let steps = 0;
  while (g.phase === "playing") (g.step([RIGHTWARD]), steps++);
  assert.equal(g.players[2].died + 10, g.players[1].died);
  assert.equal(g.ticks, g.players[1].died, "results the step the second-last falls");
  assert.equal(g.winner(), 0);
  assert.deepEqual(g.places(), [0, 1, 2]);
  // Two out in the same step: they share second place.
  const s = playing(3);
  place(s, 0, -6, -5, 0);
  place(s, 1, 0, -HALF_Z + L.radius + 0.05, -Math.PI / 2);
  place(s, 2, 6, -HALF_Z + L.radius + 0.05, -Math.PI / 2);
  run(s, 30);
  assert.equal(s.winner(), 0);
  assert.deepEqual(s.places(), [0, 1, 1]);
  // Everyone at once: a draw, everyone first.
  const d = playing(3);
  place(d, 0, -6, -HALF_Z + L.radius + 0.05, -Math.PI / 2);
  place(d, 1, 0, -HALF_Z + L.radius + 0.05, -Math.PI / 2);
  place(d, 2, 6, -HALF_Z + L.radius + 0.05, -Math.PI / 2);
  run(d, 30);
  assert.equal(d.phase, "results");
  assert.equal(d.winner(), -1);
  assert.deepEqual(d.places(), [0, 0, 0]);
  // 60 s: two still running draw.
  const t = playing(2);
  run(t, 4000, [], { 0: [-8, -6], 1: [8, 6] });
  assert.equal(t.phase, "results");
  assert.equal(t.ticks, L.limit * L.hz);
  assert.equal(t.winner(), -1);
  assert.deepEqual(t.places(), [0, 0]);
});

for (const count of [2, 3])
  test(`${count} players: the start ring — equally spaced along the ellipse, all facing clockwise, turned at random each round; fair to the rail; going straight on is safe for 1.1 s`, () => {
    const len = (from: number, to: number) => {
      let total = 0;
      const n = Math.ceil(3000 * (to - from));
      for (let i = 0; i < n; i++) {
        const a = ringPoint(from + ((to - from) * i) / n),
          b = ringPoint(from + ((to - from) * (i + 1)) / n);
        total += Math.hypot(b.x - a.x, b.z - a.z);
      }
      return total;
    };
    const quarter = len(0, 1) / count;
    const turns: number[] = [];
    const rail = Array.from({ length: count }, () => 0);
    const sim = new TrailRoundSimulation(undefined, 77);
    for (let round = 0; round < 300; round++) {
      assert.ok(sim.start(PLAYERS.slice(0, count).map((p) => p.id)));
      const g = sim.game;
      turns.push(g.turn);
      g.players.forEach((p, lane) => {
        assert.ok(Math.abs((p.x / SPAWN_AXES.x) ** 2 + (p.z / SPAWN_AXES.z) ** 2 - 1) < 1e-4, "on the ellipse");
        const dx = Math.cos(p.a),
          dz = Math.sin(p.a);
        assert.ok(Math.abs(dx * (p.x / SPAWN_AXES.x ** 2) + dz * (p.z / SPAWN_AXES.z ** 2)) < 1e-3, "along it");
        assert.ok(p.x * dz - p.z * dx > 0, "clockwise");
        rail[lane] += Math.abs(p.z);
        if (round < 20) {
          const next = g.players[(lane + 1) % count],
            s = (g.turn + lane / count) % 1;
          assert.ok(Math.abs(Math.hypot(ringPoint(s).x - p.x, ringPoint(s).z - p.z)) < 1e-9);
          assert.ok(Math.abs(len(s, s + 1 / count) - quarter) < 1e-3, "equal arcs");
          assert.ok(Math.hypot(ringPoint(s + 1 / count).x - next.x, ringPoint(s + 1 / count).z - next.z) < 1e-9);
        }
      });
      sim.cancelCountdown();
    }
    const mean = turns.reduce((a, b) => a + b, 0) / turns.length;
    assert.ok(Math.abs(mean - 0.5) < 0.05 && new Set(turns).size === turns.length, "a fresh turn every round");
    const avg = rail.map((r) => r / 300);
    assert.ok(Math.max(...avg) - Math.min(...avg) < 0.5, `distance to the rail by lane ${avg.map((x) => x.toFixed(2))}`);
    // Nobody pressing anything: at least 1.1 s (7.7 m) before anyone hits anything, heads far apart.
    for (let i = 0; i < 200; i++) {
      const g = new TrailGame(count, Math.random, i / 200);
      while (g.phase === "countdown") g.step();
      let closest = Infinity;
      while (g.players.every((p) => p.alive)) {
        g.step();
        for (let a = 0; a < count; a++) for (let b = a + 1; b < count; b++) closest = Math.min(closest, Math.hypot(g.players[a].x - g.players[b].x, g.players[a].z - g.players[b].z));
      }
      assert.ok(g.ticks >= 1.1 * L.hz, `turn ${i / 200}: first crash after ${g.ticks} steps`);
      assert.ok(closest > 3, `heads ${closest.toFixed(2)} m apart`);
      assert.ok(g.players.every((p) => p.alive || p.cause === WALL), "only walls");
    }
  });

test("dropping: no input is straight on (it may well crash); leaving: out at once, its trail fades in 0.4 s, ranked last; a dead player who leaves keeps its place", () => {
  const sim = new TrailRoundSimulation(undefined, 3);
  assert.ok(sim.start([0, 1, 2] as PlayerId[]));
  while (sim.phase !== "playing") sim.step([]);
  const g = sim.game,
    a1 = g.players[1].a;
  const turn = { seq: 1, round: sim.roundId, dirX: 0, dirZ: 0 };
  for (let i = 0; i < 20; i++) sim.step(PLAYERS.map((_, slot) => ({ x: 0, z: 0, jump: false, trail: slot === 1 ? undefined : { ...turn, seq: i + 1, dirX: Math.cos(g.players[slot].a + 2) > 0 ? 1 : -1 } })));
  assert.equal(g.players[1].a, a1, "the dropped one runs straight on");
  sim.neutralize(1 as PlayerId);
  assert.ok(g.players[1].alive);
  // The mailbox: the newest keys every step, nothing after 300 ms of silence (straight on).
  const box = new InputMailbox();
  assert.ok(box.accept({ seq: 1, round: 3, dirX: 1, dirZ: -1 }, 3, 0, "light_trails"));
  assert.deepEqual(box.read(10).trail, { seq: 1, round: 3, dirX: 1, dirZ: -1 });
  assert.deepEqual(box.read(20).trail, { seq: 1, round: 3, dirX: 1, dirZ: -1 }, "held");
  assert.equal(box.read(400).trail, undefined, "stale: straight on");
  // Leaving: out, ranked behind everyone who stayed.
  const left = playing(3),
    parked = { 0: [-8, -6] as [number, number], 2: [8, 6] as [number, number] };
  place(left, 1, -5, 4, 0);
  run(left, 30, [], parked);
  left.remove(1);
  assert.equal(left.players[1].cause, LEFT);
  assert.ok(pieces(left, 1).length > 0, "its trail is still there…");
  run(left, DEATH_FADE, [], parked);
  assert.equal(pieces(left, 1).length, 0, "…for 0.4 s");
  assert.equal(left.lines[1].x.length, 0);
  assert.deepEqual(left.places(), [0, 2, 0]);
  // Dead first, then gone: the place stays.
  const dead = playing(3);
  place(dead, 2, 6, -HALF_Z + L.radius + 0.05, -Math.PI / 2);
  run(dead, 5, [], { 0: [-8, -6], 1: [-8, 6] });
  dead.remove(2);
  dead.remove(1);
  assert.equal(dead.phase, "playing");
  run(dead, 1, [], { 0: [-8, -6] });
  assert.equal(dead.phase, "results");
  assert.equal(dead.winner(), 0);
  assert.deepEqual(dead.places(), [0, 2, 1], "the one who left running is behind the one who died");
});

test("the section: heads exact, trail points on the centimetre exactly as the server has them; restores a game; a malformed one is refused; strict packets", () => {
  const g = playing(3);
  run(g, 200, [UP, LEFTWARD, DOWN]);
  const wire = trailSection(g, [0, 1, 2]);
  assert.ok(validTrailWire(wire));
  assert.deepEqual(wireLines(wire), g.lines.map((l) => ({ x: l.x, z: l.z, t: l.t, cut: l.cut })));
  const copy = new TrailGame(3, () => 0.5);
  restoreTrails(copy, wire);
  assert.deepEqual(copy.lines, g.lines);
  assert.deepEqual(copy.players, g.players);
  assert.equal(copy.ticks, g.ticks);
  assert.ok(!validTrailWire({ ...wire, counts: [1, 2, 3] }));
  assert.ok(!validTrailWire({ ...wire, points: new Uint8Array(5) }));
  assert.ok(!validTrailWire({ ...wire, by: [5, -1, -1] }));
  assert.ok(!validTrailWire({ ...wire, seats: [0] }));
  assert.deepEqual(validateTrailInput({ seq: 1, round: 2, dirX: 0.4, dirZ: -7 }), { seq: 1, round: 2, dirX: 1, dirZ: -1 });
  assert.equal(validateTrailInput({ seq: 1, round: 2, dirX: 0, dirZ: 0, extra: 1 }), null);
  assert.equal(validateTrailInput({ seq: 1, round: 0, dirX: 0, dirZ: 0 }), null);
  assert.equal(validateTrailInput({ seq: 1, round: 2, dirX: NaN, dirZ: 0 }), null);
});

/** One bot alone for a whole round (the other lane parked in a corner). */
function solo(level: TrailBotLevel, seed: number) {
  const random = mulberry32(seed),
    g = new TrailGame(2, random),
    bot = new TrailBot(level, 0, random);
  while (g.phase === "countdown") g.step();
  while (g.phase === "playing" && g.players[0].alive) {
    park(g, 1, HALF_X - 0.6, HALF_Z - 0.6);
    g.step([bot.input(g)]);
  }
  return g.players[0];
}
test("bots: Orta and Zor live through a round on their own and keep off the rail when it blinks; Kolay now and then runs into its own trail", () => {
  for (const level of ["medium", "hard"] as const) {
    const runs = Array.from({ length: 8 }, (_, i) => solo(level, i + 1));
    assert.ok(runs.filter((p) => p.alive).length >= 7, `${level}: ${runs.map((p) => p.cause).join(",")}`);
    assert.ok(runs.every((p) => p.cause !== TRAIN), `${level}: hit by a train`);
  }
  const easy = Array.from({ length: 10 }, (_, i) => solo("easy", i + 1));
  assert.ok(easy.some((p) => p.cause === SELF), `easy: ${easy.map((p) => p.cause).join(",")}`);
  // On the rail when the warning starts: off it before the train comes.
  for (const level of ["easy", "medium", "hard"] as const) {
    const g = playing(2),
      bot = new TrailBot(level, 0, mulberry32(4));
    g.ticks = trainWarn(0);
    place(g, 0, -9, 0, 0);
    let off = -1;
    while (g.ticks < trainEnter(0) && g.players[0].alive) {
      park(g, 1, HALF_X - 0.6, HALF_Z - 0.6);
      g.step([bot.input(g)]);
      if (off < 0 && Math.abs(g.players[0].z) > L.train.halfWidth + L.radius) off = g.ticks;
    }
    assert.ok(off > 0 && off < trainEnter(0), `${level} left the rail at ${off}`);
  }
});

test("bots: Zor turns across a rival's way just ahead of it; Orta keeps going", () => {
  const choose = (level: TrailBotLevel) => {
    const g = playing(2),
      bot = new TrailBot(level, 0, () => 0.99);
    // The rival runs right along z = −1.5; the bot runs right 3 m below and a little ahead.
    place(g, 1, -8, -1.5, 0);
    place(g, 0, -4, 1.5, 0);
    return bot.input(g);
  };
  assert.equal(choose("hard").z, -1, "Zor: up, across its way");
  assert.deepEqual(choose("medium"), { x: 0, z: 0 }, "Orta: straight on");
});

test("the round simulation: 2–3 players, slots (not seats) as winner, placements per slot, held inputs counted, protocol 24", () => {
  const sim = new TrailRoundSimulation(undefined, 5);
  assert.equal(sim.start([0] as PlayerId[]), false);
  assert.equal(sim.start([0, 1, 2, 3] as PlayerId[]), false);
  assert.ok(sim.start([2, 1] as PlayerId[]));
  assert.deepEqual(sim.seats, [1, 2]);
  assert.equal(sim.phase, "countdown");
  while (sim.phase === "countdown") sim.step([]);
  assert.equal(sim.phase, "playing");
  const packet = { seq: 4, round: sim.roundId, dirX: 0, dirZ: 0 };
  const inputs = PLAYERS.map(() => ({ x: 0, z: 0, jump: false, trail: packet }));
  sim.step(inputs);
  sim.step(inputs);
  sim.step(inputs);
  const snap = sim.snapshot([0, 0, 0]);
  assert.equal(snap.v, 24);
  assert.equal(NET.version, 24);
  assert.equal(snap.mode, "light_trails");
  assert.ok(validTrailWire(snap.trail));
  assert.equal(snap.transforms.byteLength, 0);
  assert.deepEqual(snap.trail!.held, [2, 2], "the same packet three steps: two extra");
  // Lane 0 (slot 1) into a wall: slot 2 wins.
  place(sim.game, 0, 0, -HALF_Z + L.radius + 0.05, -Math.PI / 2);
  sim.step([]);
  assert.equal(sim.phase, "results");
  assert.equal(sim.winner, 2, "lane 1 is slot 2");
  assert.deepEqual(sim.placements(), [-1, 1, 0]);
  assert.equal(sim.snapshot([0, 0, 0]).winner, 2);
  for (let i = 0; i < L.results * L.hz + 1; i++) sim.step([]);
  assert.equal(sim.phase, "waiting");
});

test("Işık İzi is a 2–3 player mode in Mixed, in the board's mini games and in the Yerel Test Arenası", () => {
  assert.ok(GAME_MODES.includes("light_trails"));
  assert.equal(MODE_NAMES.light_trails, "Işık İzi");
  assert.deepEqual(MODE_PLAYERS.light_trails, { min: 2, max: 3 });
  assert.ok(LOCAL_ARENA_IDS.includes("light_trails"));
  assert.ok(!modeFits("light_trails", 1) && modeFits("light_trails", 2) && modeFits("light_trails", 3) && !modeFits("light_trails", 4));
  for (const count of [2, 3]) {
    const mixed = new MixedRotation(() => 0.5);
    mixed.setPlayers(count);
    const cycle = GAME_MODES.filter((m) => modeFits(m, count)).map(() => {
      const mode = mixed.next;
      mixed.played();
      return mode;
    });
    assert.ok(cycle.includes("light_trails"), `Mixed ${count}P`);
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
    assert.ok(minis.includes("light_trails"), `Tahta Oyunu ${count}P: ${minis.join(",")}`);
  }
});

/* A real room: keys from packets turn the player, a dropped player runs straight on, the
   results reach everyone; the player left alone wins. */
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
  const client = new Client(endpoint),
    r = code
      ? await client.joinById<LobbyState>(code, { protocol: NET.version, nickname: "Guest", intent: "join", code })
      : await client.create<LobbyState>("party_lab", { protocol: NET.version, nickname: "Host", intent: "create" });
  rooms.push(r);
  r.onMessage("notice", () => {});
  r.onMessage("feedback", () => {});
  const snapshots: GameSnapshot[] = [];
  r.onMessage("snapshot", (s: GameSnapshot) => snapshots.push(s));
  Object.assign(r.reconnection, { minUptime: 0, minDelay: 70, maxDelay: 100, maxRetries: 10 });
  let seq = 0;
  return { r, snapshots, send: (round: number, dirX: number, dirZ: number) => r.send("input", { seq: ++seq, round, dirX, dirZ }) };
}
async function lobby(count: number) {
  const peers = [await peer()];
  for (let i = 1; i < count; i++) peers.push(await peer(peers[0].r.roomId));
  const room = matchMaker.getLocalRoomById(peers[0].r.roomId) as PartyRoom;
  peers[0].r.send("mode", "light_trails");
  await until(() => room.selection === "light_trails");
  for (const p of peers) p.r.send("ready", true);
  await until(() => room.game.phase === "countdown");
  const sim = room.game as TrailRoundSimulation;
  assert.ok(sim instanceof TrailRoundSimulation);
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
  test(`room ${count}P: keys from packets turn the runner, a dropped one runs straight on, results with the survivor`, { timeout: 30000 }, async () => {
    const { peers, room, sim, lane } = await lobby(count);
    const g = sim.game,
      l0 = lane(peers[0]),
      l1 = lane(peers[1]);
    await until(() => room.game.phase === "playing");
    // Everyone running right from the left wall; anyone near the right one goes back (7 m/s is
    // 3.5 s across); lane 0 is sent W (up the screen), then back along its line.
    const rows = [-6, -3, 4],
      keep = () => g.players.forEach((p, k) => p.alive && p.x > 8 && place(g, k, -12, rows[k], 0));
    g.players.forEach((_, k) => place(g, k, -12, rows[k], 0));
    for (let i = 0; i < 24; i++) {
      peers[0].send(sim.roundId, 0, -1);
      await pause(16);
    }
    await until(() => g.players[l0].a === -Math.PI / 2);
    place(g, l0, -12, rows[l0], 0);
    // Lane 1 drops: no input, straight on.
    const r = peers[1].r,
      id = r.sessionId;
    place(g, l1, -12, rows[l1], 0);
    r.connection.close(4010);
    await until(() => !room.state.players.get(id)!.connected);
    await pause(350);
    assert.equal(g.players[l1].a, 0, "straight on, the packets gone stale");
    assert.ok(g.players[l1].alive);
    await until(() => (keep(), room.state.players.get(id)!.connected));
    assert.equal(room.game, sim);
    // Everyone but lane 0 into the bottom wall.
    g.players.forEach((_, k) => k !== l0 && place(g, k, [-8, 0, 8][k], HALF_Z - L.radius - 0.05, Math.PI / 2));
    place(g, l0, -12, -6, 0);
    await until(() => room.game.phase === "results", 4000);
    const slot = (i: number) => room.state.players.get(peers[i].r.sessionId)!.slot;
    assert.equal(room.state.winner, slot(0));
    assert.equal(sim.placements()[slot(0)], 0);
    await until(() => peers[0].snapshots.at(-1)?.phase === "results");
    const shown = peers[0].snapshots.at(-1)!;
    assert.equal(shown.v, 24);
    assert.ok(validTrailWire(shown.trail), "the section survives the wire");
    assert.ok(shown.trail!.points instanceof Uint8Array);
    assert.equal(shown.winner, slot(0));
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
