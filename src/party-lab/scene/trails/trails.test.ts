import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PerspectiveCamera, Vector3 } from "three";
import { NET } from "../../../../shared/party-lab/network/protocol";
import { GAME_MODES, MODE_NAMES, MODE_SELECTIONS, modeFits } from "../../../../shared/party-lab/modes";
import { LOCAL_ARENA_IDS } from "../../../../shared/party-lab/localArenas";
import { LIGHT_TRAILS as L } from "../../../../shared/party-lab/simulation/trails/config";
import { DEATH_FADE, HEAD, LIFE, SELF, TRAIL, TRAIN, WALL, onCentimetre, type TrailLine } from "../../../../shared/party-lab/simulation/trails/game";
import { TrailRoundSimulation } from "../../../../shared/party-lab/simulation/trailRound";
import type { TrailWire } from "../../../../shared/party-lab/simulation/trails/wire";
import { newRoomCounters } from "../../../../shared/party-lab/simulation/online";
import type { TrailInputPacket } from "../../../../shared/party-lab/network/trailInput";
import type { GameSnapshot } from "../../../../shared/party-lab/network/protocol";
import type { PlayerId } from "../../../../shared/party-lab/simulation/players";
import { CHAT_LAYOUT } from "../gameChat";
import { LocalTrails, NO_CONTROLS, OnlineTrailSource, TrailPrediction, keysOf, trailRuns } from "./source";
import { TRAIL_DPR, TRAIL_INSETS, TRAIL_VIEW, fitTrailCamera } from "./layout";
import { causeText, resultOrder, secondsLeft } from "./hud";

const HALF_X = L.width / 2,
  HALF_Z = L.depth / 2;

test("Işık İzi is a registered 2–3 player mode on protocol 22, with a local arena, an online view and a chat spot", () => {
  assert.equal(NET.version, 22);
  assert.ok(GAME_MODES.includes("light_trails") && MODE_SELECTIONS.includes("light_trails"));
  assert.equal(MODE_NAMES.light_trails, "Işık İzi");
  assert.ok(modeFits("light_trails", 2) && modeFits("light_trails", 3) && !modeFits("light_trails", 4));
  assert.ok(LOCAL_ARENA_IDS.includes("light_trails"));
  assert.ok(CHAT_LAYOUT.light_trails.wide.bottom >= 16);
  const dir = fileURLToPath(new URL("..", import.meta.url));
  assert.ok(readFileSync(`${dir}OnlineArena.tsx`, "utf8").includes('"light_trails"'));
  assert.match(readFileSync(`${dir}OnlineTrailArena.tsx`, "utf8"), /menu\.view !== null \|\| menu\.chatOpen/, "chat open: input off");
});

test("keys: screen directions from the movement vector, W up (z −1), diagonals both", () => {
  assert.deepEqual(keysOf(0, -1), { x: 0, z: -1 });
  assert.deepEqual(keysOf(Math.SQRT1_2, -Math.SQRT1_2), { x: 1, z: -1 });
  assert.deepEqual(keysOf(0, 0), { x: 0, z: 0 });
  assert.deepEqual(NO_CONTROLS, { x: 0, z: 0 });
});

test("the camera: the whole arena beside the HUD column on every desktop size, the rail level across, W up the screen", () => {
  for (const [w, h] of [[1280, 800], [1920, 1080], [1440, 900], [2560, 1440], [1024, 768], [1512, 982]]) {
    const camera = new PerspectiveCamera(),
      fit = fitTrailCamera(camera, w, h),
      insets = TRAIL_INSETS;
    assert.ok(fit.box.x0 >= insets.left - 1 && fit.box.x1 <= w - insets.right + 1, `${w}×${h}: across ${fit.box.x0}–${fit.box.x1}`);
    assert.ok(fit.box.y0 >= insets.top - 1 && fit.box.y1 <= h - insets.bottom + 1, `${w}×${h}: down ${fit.box.y0}–${fit.box.y1}`);
    const used = Math.max((fit.box.x1 - fit.box.x0) / fit.free.w, (fit.box.y1 - fit.box.y0) / fit.free.h);
    assert.ok(used > 0.98, `${w}×${h}: fills ${used.toFixed(3)} of the space`);
    const left = new Vector3(-HALF_X, 0, 0).project(camera),
      right = new Vector3(HALF_X, 0, 0).project(camera),
      top = new Vector3(0, 0, -HALF_Z).project(camera),
      bottom = new Vector3(0, 0, HALF_Z).project(camera);
    assert.ok(Math.abs(left.y - right.y) < 1e-6, "the rail is level");
    assert.ok(top.y > bottom.y, "−z (W) is up the screen");
    assert.ok(right.x > left.x, "+x (D) is right");
  }
  assert.ok(TRAIL_VIEW.tilt <= (8 * Math.PI) / 180, "nearly straight down");
  assert.deepEqual(TRAIL_DPR, [2, 2]);
});

test("drawn trails: cut where a life ends, fading over the last 0.6 s, broken where the train wiped them, gone 0.4 s after a death, and ending at the drawn head", () => {
  // Points every 3 steps along x from step 0 to 300.
  const line: TrailLine = { x: [], z: [], t: [], cut: [] };
  for (let t = 0; t <= 300; t += 3) {
    line.x.push(onCentimetre(-10 + t * 0.05));
    line.z.push(-4);
    line.t.push(t);
    line.cut.push(t === 225);
  }
  const step = 301,
    runs = trailRuns(line, -1, step, { x: 5.1, z: -4 });
  assert.equal(runs.length, 2, "split at the wiped piece");
  const first = runs[0];
  assert.ok(Math.abs(first.x[0] - (-10 + (step - LIFE) * 0.05)) < 1e-9, `tail at ${first.x[0]}`);
  assert.equal(first.alpha[0], 0, "the tail has faded right out");
  assert.ok(first.alpha[first.alpha.length - 1] > 0.9);
  assert.equal(runs[1].x[runs[1].x.length - 1], 5.1, "ends at the head");
  assert.equal(runs[1].alpha[runs[1].alpha.length - 1], 1);
  // Drawn behind (another player a moment ago): nothing past that step.
  const behind = trailRuns(line, -1, step, { x: 4, z: -4 }, 280);
  const last = behind[behind.length - 1];
  assert.equal(last.x[last.x.length - 1], 4);
  assert.ok(last.x[last.x.length - 2] <= -10 + 280 * 0.05 + 1e-9);
  // Dead at 290: everything dims together and is gone 0.4 s later.
  const dying = trailRuns(line, 290, 290 + DEATH_FADE / 2, null);
  assert.ok(dying.every((r) => r.alpha.every((a) => a <= 0.5 + 1e-9)));
  assert.deepEqual(trailRuns(line, 290, 290 + DEATH_FADE, null), []);
});

/** A fixed-latency link: the client predicts at once, the server sees inputs `delay` steps late, snapshots come every 3 steps, `delay` late. */
function link(delay: number) {
  const sim = new TrailRoundSimulation(newRoomCounters(), 11);
  sim.start([0, 1] as PlayerId[]);
  while (sim.phase !== "playing") sim.step([]);
  // Both heads somewhere roomy, running right.
  Object.assign(sim.game.players[0], { x: -9, z: -5, a: 0 });
  Object.assign(sim.game.lines[0], { x: [-9], z: [-5], t: [0], cut: [false] });
  Object.assign(sim.game.players[1], { x: -9, z: 5, a: 0 });
  Object.assign(sim.game.lines[1], { x: [-9], z: [5], t: [0], cut: [false] });
  const toServer: { at: number; packet: TrailInputPacket }[] = [],
    toClient: { at: number; snapshot: GameSnapshot }[] = [];
  let latest: TrailInputPacket | null = null,
    seq = 0,
    clock = 0;
  const prediction = new TrailPrediction(sim.snapshot([-1, -1, -1]).trail!, 0, 0);
  const tick = (dirX: number, dirZ: number) => {
    clock++;
    while (toClient.length && toClient[0].at <= clock) prediction.reconcile({ snapshot: toClient.shift()!.snapshot, values: new Float32Array(), received: clock * 16.67 }, clock * 16.67);
    const packet: TrailInputPacket = { seq: ++seq, round: sim.roundId, dirX, dirZ };
    prediction.stepInput(packet, clock * 16.67);
    prediction.visual(1 / 60);
    toServer.push({ at: clock + delay, packet });
    while (toServer.length && toServer[0].at <= clock) latest = toServer.shift()!.packet;
    const inputs = [0, 1, 2].map((slot) => ({ x: 0, z: 0, jump: false, trail: slot === 0 && latest ? latest : undefined }));
    sim.step(inputs);
    if (clock % 3 === 0) toClient.push({ at: clock + delay, snapshot: sim.snapshot([latest?.seq ?? -1, -1, -1]) });
  };
  return { sim, tick, prediction };
}

test("prediction: own turns shown at once and replayed exactly (steady 100 ms round trip: no correction at all), the same trail points the server lays", () => {
  const { sim, tick, prediction } = link(3);
  // Up, then right, then down, then right: smooth turns at once.
  for (let i = 0; i < 40; i++) tick(0, -1);
  assert.ok(prediction.game.players[0].a < -1, "turned up before the server knew");
  for (let i = 0; i < 40; i++) tick(1, 0);
  for (let i = 0; i < 40; i++) tick(0, 1);
  for (let i = 0; i < 30; i++) tick(0, 0);
  const server = sim.game.players[0];
  // The server is `delay` behind: run it on with the last keys to compare where the prediction is.
  for (let i = 0; i < 12; i++) tick(0, 0);
  const shown = prediction.visual(0.016),
    lead = prediction.step - sim.game.ticks;
  assert.ok(lead >= 0 && lead <= 8, `prediction ${lead} steps ahead`);
  const ahead = { x: server.x + Math.cos(server.a) * (L.speed / L.hz) * lead, z: server.z + Math.sin(server.a) * (L.speed / L.hz) * lead };
  assert.ok(Math.hypot(shown.x - ahead.x, shown.z - ahead.z) < 0.02, `predicted ${shown.x},${shown.z} vs server+lead ${ahead.x},${ahead.z}`);
  assert.equal(prediction.metrics.hard, 0);
  assert.equal(prediction.metrics.corrections, 0, `corrections: ${prediction.metrics.corrections}`);
  assert.ok(prediction.metrics.maxError < 1e-9);
  // The points the prediction laid match the server's where both have them.
  const mine = prediction.game.lines[0],
    theirs = sim.game.lines[0];
  for (let i = 0; i < theirs.t.length; i++) {
    const k = mine.t.indexOf(theirs.t[i]);
    if (k >= 0) assert.ok(mine.x[k] === theirs.x[i] && mine.z[k] === theirs.z[i], `point at ${theirs.t[i]}`);
  }
});

test("prediction: running into a wall stops the drawn head there; only the server says dead", () => {
  const { sim, tick, prediction } = link(6);
  Object.assign(sim.game.players[0], { x: HALF_X - 2.5, z: -5, a: 0 });
  Object.assign(sim.game.lines[0], { x: [onCentimetre(HALF_X - 2.5)], z: [-5], t: [sim.game.ticks], cut: [false] });
  let blockedAlive = false;
  for (let i = 0; i < 40 && sim.game.players[0].alive; i++) {
    tick(0, 0);
    if (prediction.blocked && sim.game.players[0].alive) blockedAlive = true;
  }
  assert.ok(blockedAlive, "the view stopped at the wall while the server still had it running");
  assert.ok(prediction.game.players[0].x <= HALF_X - L.radius + 1e-9);
  assert.equal(sim.game.players[0].cause, WALL);
});

test("the local arena: the game runs with bots, pauses while paused; W turns the player up the screen", () => {
  const local = new LocalTrails(3, "medium", () => 0.3);
  for (let i = 0; i < 3 * L.hz + 2; i++) local.frame(1 / L.hz, NO_CONTROLS, false);
  assert.equal(local.game.phase, "playing");
  const before = local.game.ticks;
  for (let i = 0; i < 30; i++) local.frame(1 / L.hz, NO_CONTROLS, true);
  assert.equal(local.game.ticks, before, "paused: no steps");
  Object.assign(local.game.players[0], { x: 0, z: 4, a: 0 });
  Object.assign(local.game.lines[0], { x: [0], z: [4], t: [local.game.ticks], cut: [false] });
  for (let i = 0; i < 40; i++) local.frame(1 / L.hz, { x: 0, z: -1 }, false);
  assert.equal(local.game.players[0].a, -Math.PI / 2);
  const frame = local.frame(0, NO_CONTROLS, false);
  assert.equal(frame.self, 0);
  assert.equal(frame.trails.length, 3);
  const run = frame.trails[0][frame.trails[0].length - 1];
  assert.ok(Math.abs(run.x[run.x.length - 1] - frame.x[0]) < 1e-9 && Math.abs(run.z[run.z.length - 1] - frame.z[0]) < 1e-9, "the trail ends at the drawn head");
});

test("online: another player is drawn a moment behind with its trail ending at its drawn head; the own head is predicted", () => {
  const sim = new TrailRoundSimulation(newRoomCounters(), 4);
  sim.start([0, 1] as PlayerId[]);
  while (sim.phase !== "playing") sim.step([]);
  for (let i = 0; i < 30; i++) sim.step([]);
  const a = sim.snapshot([-1, -1, -1]);
  for (let i = 0; i < 3; i++) sim.step([]);
  const b = sim.snapshot([-1, -1, -1]);
  const frames = [
    { snapshot: a, values: new Float32Array(), received: 0 },
    { snapshot: b, values: new Float32Array(), received: 50 },
  ];
  const stream = { snapshots: { latest: frames[1], sample: () => ({ a: frames[0], b: frames[1], alpha: 0.5 }) } } as never;
  const sent: unknown[] = [];
  const source = new OnlineTrailSource({ stream, sendInput: (input) => (sent.push(input), null) }, a.round, 0, 0);
  const frame = source.frame(1 / 60, { x: 0, z: -1 }, false)!;
  assert.ok(frame);
  const wa = a.trail!,
    wb = b.trail!;
  assert.ok(Math.abs(frame.x[1] - (wa.x[1] + wb.x[1]) / 2) < 1e-9, "halfway between the two snapshots");
  const run = frame.trails[1][frame.trails[1].length - 1];
  assert.ok(Math.abs(run.x[run.x.length - 1] - frame.x[1]) < 1e-9, "its trail ends at its drawn head");
  assert.ok(source.prediction?.active, "own head predicted");
});

test("the HUD: why someone is out, places order, seconds left", () => {
  const wire = { seats: [0, 1, 2], cause: [WALL, TRAIL, SELF], by: [-1, 0, 2], places: [2, 0, 1], limit: 60 } as unknown as TrailWire;
  const names = ["Ayşe", "Bora", "Cem"];
  assert.equal(causeText(wire, 0, names), "Duvara çarptı");
  assert.equal(causeText(wire, 1, names), "İze çarptı (Ayşe)");
  assert.equal(causeText(wire, 2, names), "Kendi izine çarptı");
  assert.equal(causeText({ ...wire, cause: [HEAD, TRAIN, 0], by: [1, -1, -1] } as TrailWire, 0, names), "Kafa kafaya (Bora)");
  assert.equal(causeText({ ...wire, cause: [HEAD, TRAIN, 0], by: [1, -1, -1] } as TrailWire, 1, names), "Tren çarptı");
  assert.deepEqual(resultOrder(wire), [1, 2, 0]);
  assert.equal(secondsLeft(wire, 30 * L.hz), 30);
});
