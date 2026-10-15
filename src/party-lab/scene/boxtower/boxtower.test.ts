import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { PerspectiveCamera } from "three";
import { BOX_TOWER as T } from "../../../../shared/party-lab/simulation/boxtower/config";
import { BoxTowerGame } from "../../../../shared/party-lab/simulation/boxtower/game";
import { columnAt, crossings, slideX } from "../../../../shared/party-lab/simulation/boxtower/motion";
import { towerSection, type TowerWire } from "../../../../shared/party-lab/simulation/boxtower/wire";
import { mulberry32 } from "../../../../shared/party-lab/simulation/colors/layouts";
import { GAME_MODES, MODE_NAMES, MODE_PLAYERS, modeFits } from "../../../../shared/party-lab/modes";
import { LOCAL_ARENA_IDS } from "../../../../shared/party-lab/localArenas";
import { NET, type GameSnapshot } from "../../../../shared/party-lab/network/protocol";
import type { MovementInput } from "../../../../shared/party-lab/intent";
import { CHAT_LAYOUT } from "../gameChat";
import { ClickPresses } from "../clickrace/input";
import { defaultBindings } from "../../input/defaults";
import { dropBindings, dropLabel } from "./input";
import { LocalTower, OnlineTowerSource, TowerClient, botView, canDrop, drawTime, yardViews, type TowerFrame } from "./source";
import { YARD, fitTowerCamera, projectTower, rowBounds, TOWER_INSETS, yardX } from "./layout";
import { resultOrder, seconds } from "./results";

const MS = 1000 / T.hz;
function stacking(count = 2, seed = 3) {
  const g = new BoxTowerGame(count, mulberry32(seed));
  while (g.phase === "countdown") g.step();
  return g;
}
const wireOf = (g: BoxTowerGame): TowerWire => towerSection(g, g.lanes.map((_, lane) => lane));
const frameOf = (g: BoxTowerGame, now = g.elapsedMs, self = -1, pending: TowerFrame["pending"] = null): TowerFrame => ({ wire: wireOf(g), now, winner: g.winner(), round: 1, self, pending });

test("Kutu Kulesi is a registered 2–3 player mode on protocol 24, with a local arena, a chat spot and a lobby hint", () => {
  assert.equal(NET.version, 24);
  assert.ok(GAME_MODES.includes("box_tower"));
  assert.equal(MODE_NAMES.box_tower, "Kutu Kulesi");
  assert.deepEqual(MODE_PLAYERS.box_tower, { min: 2, max: 3 });
  assert.ok(modeFits("box_tower", 2) && modeFits("box_tower", 3) && !modeFits("box_tower", 4));
  assert.ok(LOCAL_ARENA_IDS.includes("box_tower"));
  assert.ok(CHAT_LAYOUT.box_tower.wide.bottom >= 0);
  const lobby = readFileSync(new URL("../../PartyLobby.tsx", import.meta.url), "utf8");
  assert.match(lobby, /box_tower: "/);
  const arena = readFileSync(new URL("../OnlineArena.tsx", import.meta.url), "utf8");
  assert.match(arena, /mode === "box_tower"\) return/);
});

test("the drop key is Space (the Jump keys), never a mouse button; a held key and its repeats drop once", () => {
  const keys = dropBindings(defaultBindings());
  assert.ok(keys.has("Space"));
  assert.ok(![...keys].some((k) => k.startsWith("Mouse")));
  assert.equal(dropLabel(defaultBindings()), "SPACE");
  const presses = new ClickPresses(keys);
  assert.equal(presses.key("Space", false), true);
  assert.equal(presses.key("Space", true), false, "key repeat");
  assert.equal(presses.key("Space", false), false, "still held (a repeat without the flag)");
  presses.keyUp("Space");
  assert.equal(presses.key("Space", false), true, "pressed again");
  assert.equal(presses.mouse(0), false, "a click only focuses");
  assert.ok(dropBindings({ ...defaultBindings(), jump: ["MouseLeft", null] }).has("Space"), "falls back to Space");
});

test("client clock: never ahead of the server; a press is stamped on it into the column under the box on screen; one drop at a time", () => {
  const g = stacking();
  const client = new TowerClient();
  for (let i = 0; i < 30; i++) g.step();
  for (const delay of [90, 40, 75, 55]) {
    g.step();
    client.observe(wireOf(g), 1, 10_000 + g.elapsedMs + delay, 0);
  }
  const wall = 10_000 + g.elapsedMs + 60;
  assert.ok(Math.abs(client.clock(wall) - (g.elapsedMs + 60 - 40)) < 0.01, "BAŞLA from the quickest snapshot");
  const wire = wireOf(g),
    t = client.clock(wall);
  assert.equal(client.press(wall, wire, 0), true);
  const p = client.pending!;
  assert.deepEqual(p, { drop: 1, at: t, column: columnAt(g.lanes[0].slide, t), land: t + T.fallMs });
  assert.equal(client.press(wall + 5, wire, 0), false, "one pending drop");
  const sent: { drop: number; at: number }[] = [];
  client.flush(() => false);
  client.flush((d) => (sent.push(d), true));
  client.flush((d) => (sent.push(d), true));
  assert.deepEqual(sent, [{ drop: 1, at: t }], "sent once, retried after a refusal");
  // The server counts it: confirmed; its box falls, so no press until the next box appears.
  g.step([{ drop: 1, at: p.at }]);
  assert.equal(g.lanes[0].falling?.column, p.column, "the server drops it into the same column");
  client.observe(wireOf(g), 1, 10_000 + g.elapsedMs + 50, 0);
  assert.equal(client.pending, null);
  assert.equal(client.press(10_000 + g.elapsedMs + 50, wireOf(g), 0), false, "falling");
  while (g.lanes[0].falling) g.step();
  assert.equal(client.press(10_000 + g.elapsedMs + 40, wireOf(g), 0), false, "waiting for the next box");
  // Nothing before BAŞLA.
  const fresh = new TowerClient(),
    c = new BoxTowerGame(2);
  fresh.observe(wireOf(c), 1, 500, 0);
  assert.equal(fresh.press(600, wireOf(c), 0), false);
  assert.ok(fresh.clock(600) < 0, "the countdown runs below zero");
});

test("canDrop: only a sliding box, during stacking, before the time is up", () => {
  const g = stacking();
  let w = wireOf(g);
  assert.ok(canDrop(w, 0, 10));
  assert.equal(canDrop(w, 4, 10), false);
  assert.equal(canDrop(w, 0, T.limit * 1000), false, "time is up");
  g.step([{ drop: 1, at: g.elapsedMs }]);
  w = wireOf(g);
  assert.equal(canDrop(w, 0, g.elapsedMs), false, "falling");
  assert.ok(canDrop(w, 1, g.elapsedMs), "the other yard is free");
  const c = new BoxTowerGame(2);
  assert.equal(canDrop(wireOf(c), 0, 0), false, "countdown");
});

test("yards as drawn: the slider over its column, an own drop falls at once and lands on screen before the server says so", () => {
  const g = stacking(2, 5);
  const s = g.lanes[0].slide;
  const now = g.elapsedMs + 5;
  let [v] = yardViews(frameOf(g, now, 0));
  assert.ok(v.slider);
  assert.equal(v.slider!.x, slideX(s, now));
  assert.equal(v.slider!.column, columnAt(s, now));
  assert.equal(v.falling, null);
  // An own drop not shown by the server yet: falling from the press, no slider.
  const pending = { drop: 1, at: now, column: 4, land: now + T.fallMs };
  [v] = yardViews(frameOf(g, now + 100, 0, pending));
  assert.equal(v.slider, null);
  assert.deepEqual(v.falling, { column: 4, progress: 100 / T.fallMs });
  [v] = yardViews(frameOf(g, now + T.fallMs + 1, 0, pending));
  assert.equal(v.heights[4], 1, "down on this screen");
  assert.equal(v.best, 1);
  assert.deepEqual(v.landed, { drop: 1, column: 4, land: now + T.fallMs, good: true });
  assert.equal(v.slider, null, "the next box is the server's to place");
  // Someone else's yard: the server's falling box, then the server's column.
  g.step([undefined, { drop: 1, at: g.elapsedMs }]);
  const f = g.lanes[1].falling!;
  let other = yardViews(frameOf(g, f.at + 50, 0))[1];
  assert.equal(other.falling?.column, f.column);
  other = yardViews(frameOf(g, f.land + 1, 0))[1];
  assert.equal(other.heights[f.column], 1);
  while (g.lanes[1].falling) g.step();
  other = yardViews(frameOf(g, g.elapsedMs, 0))[1];
  assert.equal(other.heights[f.column], 1);
  assert.equal(other.slider, null, "waiting for the next box");
  other = yardViews(frameOf(g, g.lanes[1].slide.spawn + 1, 0))[1];
  assert.ok(other.slider, "the next box slides");
  // The countdown shows where each box starts; the time up hides them.
  const c = new BoxTowerGame(2, mulberry32(9));
  const cv = yardViews(frameOf(c, -500));
  cv.forEach((y, lane) => assert.deepEqual(y.slider && { x: y.slider.x, column: y.slider.column }, { x: c.lanes[lane].slide.from, column: c.lanes[lane].slide.from }));
  assert.equal(yardViews(frameOf(g, T.limit * 1000 + 10))[0].slider, null);
  assert.equal(drawTime(wireOf(g), T.limit * 1000 + 5000), T.limit * 1000 + T.aimToleranceMs + T.fallMs + 100);
});

test("online source: a press is sent once as a drop packet stamped on the clock, and the frame shows it", () => {
  const g = stacking(2, 8);
  for (let i = 0; i < 20; i++) g.step();
  let snapshot = { round: 4, winner: -1, tower: wireOf(g) } as unknown as GameSnapshot;
  const sent: MovementInput[] = [];
  const stream = { snapshots: { get latest() { return { snapshot, received: performance.now() - 30 }; } } };
  const source = new OnlineTowerSource({ stream: stream as never, sendInput: (input) => (sent.push(input), {} as never) }, 4, 1);
  assert.ok(source.frame());
  assert.equal(source.press(performance.now()), true);
  const frame = source.frame()!;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tower?.drop, 1);
  assert.equal(sent[0].tower?.round, 4);
  assert.ok(Math.abs(sent[0].tower!.at - frame.pending!.at) < 1e-9);
  source.frame();
  assert.equal(sent.length, 1, "once");
  assert.equal(source.press(performance.now()), false, "one at a time");
  // Another round's snapshot is not this arena's.
  snapshot = { ...snapshot, round: 5 } as GameSnapshot;
  assert.equal(source.frame(), null);
});

test("local arena: the player drops through the same rules, bots really stack, the round ends with a winner", () => {
  const local = new LocalTower(3, "hard", mulberry32(4));
  let frame = local.frame(0.2, false);
  while (frame.wire.phase === "countdown") frame = local.frame(0.2, false);
  assert.equal(frame.wire.phase, "stacking");
  assert.equal(local.press(), true);
  assert.equal(local.press(), false, "one at a time");
  frame = local.frame(MS / 1000 + 0.001, false);
  assert.equal(frame.wire.drops[0], 1);
  // Paused: nothing moves.
  const before = local.game.elapsedMs;
  local.frame(1, true);
  assert.equal(local.game.elapsedMs, before);
  for (let i = 0; i < 70 * T.hz && local.game.phase !== "results"; i++) local.frame(MS / 1000, false);
  assert.equal(local.game.phase, "results");
  const bots = local.game.lanes.slice(1);
  assert.ok(bots.every((l) => l.placed >= 5), `bots stacked ${bots.map((l) => l.placed)}`);
  assert.ok(bots.some((l) => l.best >= T.goal), "a hard bot reached 10");
  assert.ok(local.game.winner() >= 1);
  assert.deepEqual(resultOrder(local.frame(0, false).wire)[0], local.game.winner());
  assert.equal(seconds(23_449), "23,4 sn");
});

test("autopilot view: busy while its own drop is pending or falling; the bot plans one press for the box over its tallest column", () => {
  const g = stacking(2, 12);
  const view = botView(frameOf(g, g.elapsedMs, 0), 0);
  assert.equal(view.playing, true);
  assert.equal(view.busy, false);
  assert.equal(botView(frameOf(g, g.elapsedMs, 0, { drop: 1, at: 0, column: 0, land: 250 }), 0).busy, true);
  g.lanes[0].heights[5] = 3;
  const crossing = crossings(g.lanes[0].slide, 5, 0, 10_000);
  assert.ok(crossing.length > 2);
});

test("the camera fits every yard, wall and character in the space the HUD leaves, 2 and 3 players", () => {
  for (const count of [2, 3])
    for (const [width, height] of [[1440, 900], [1280, 720], [1920, 1080], [1024, 768]]) {
      const camera = new PerspectiveCamera(),
        fit = fitTowerCamera(camera, width, height, count);
      const b = rowBounds(count);
      for (const x of [b.minX, b.maxX])
        for (const y of [b.minY, b.maxY]) {
          const p = projectTower(camera, width, height, x, y);
          assert.ok(p.x >= TOWER_INSETS.left - 1 && p.x <= width - TOWER_INSETS.right + 1, `${count}P ${width}×${height}: x ${p.x}`);
          assert.ok(p.y >= TOWER_INSETS.top - 1 && p.y <= height - TOWER_INSETS.bottom + 1, `${count}P ${width}×${height}: y ${p.y}`);
        }
      const fill = Math.max((fit.box.x1 - fit.box.x0) / fit.free.w, (fit.box.y1 - fit.box.y0) / fit.free.h);
      assert.ok(fill > 0.98, `fills ${fill}`);
      // The yards are left to right in lane order, a box is at least 18 px.
      const xs = Array.from({ length: count }, (_, lane) => projectTower(camera, width, height, yardX(lane, count), YARD.wallTop).x);
      assert.ok(xs.every((x, i) => i === 0 || x > xs[i - 1]));
      const box = projectTower(camera, width, height, yardX(0, count) + 0.5, 0).x - projectTower(camera, width, height, yardX(0, count) - 0.5, 0).x;
      assert.ok(box >= 18, `a box is ${box.toFixed(1)} px`);
    }
});
