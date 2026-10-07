import assert from "node:assert/strict";
import { test } from "node:test";
import { GOLD_MINER as G } from "../../../../shared/party-lab/simulation/goldminer/config";
import { GoldMinerGame } from "../../../../shared/party-lab/simulation/goldminer/game";
import { hookPose, pivotX, swingAngle, tipAt, traceShot } from "../../../../shared/party-lab/simulation/goldminer/mine";
import type { FieldItem } from "../../../../shared/party-lab/simulation/goldminer/field";
import { goldSection, type GoldWire } from "../../../../shared/party-lab/simulation/goldminer/wire";
import { mulberry32 } from "../../../../shared/party-lab/simulation/colors/layouts";
import { GAME_MODES, MODE_NAMES, MODE_PLAYERS, modeFits } from "../../../../shared/party-lab/modes";
import { LOCAL_ARENA_IDS } from "../../../../shared/party-lab/localArenas";
import { NET } from "../../../../shared/party-lab/network/protocol";
import { fitGoldView, goldInsets, mineBounds, projectGoldView } from "./layout";
import { GoldMinerClient, canFire, hookViews, type GoldFrame } from "./online";
import { BOT_LEVELS, BOT_PLAY, GoldBot, nextAngleTime, type BotLevel } from "./bots";
import { LocalGoldMiner } from "./local";
import { finds, resultOrder } from "./results";

const MS = 1000 / G.hz;
const item = (kind: FieldItem["kind"], x: number, y: number, value: number = G.items[kind].value): FieldItem => ({ kind, x, y, r: G.items[kind].radius, value });
function mining(count: number, field?: FieldItem[], random: () => number = Math.random) {
  const g = new GoldMinerGame(count, random, field);
  while (g.phase === "countdown") g.step();
  return g;
}
const seats = (g: GoldMinerGame) => g.lanes.map((_, lane) => lane);
const frameOf = (g: GoldMinerGame, now = g.elapsedMs, self = -1, pending: GoldFrame["pending"] = null): GoldFrame => ({ wire: goldSection(g, seats(g)), now, winner: g.winner(), round: 1, self, pending });

test("Altın Madenci is a registered 2–3 player mode on protocol 17, with a local arena", () => {
  assert.equal(NET.version, 17);
  assert.ok(GAME_MODES.includes("gold_miner"));
  assert.equal(MODE_NAMES.gold_miner, "Altın Madenci");
  assert.deepEqual(MODE_PLAYERS.gold_miner, { min: 2, max: 3 });
  assert.ok(modeFits("gold_miner", 2) && modeFits("gold_miner", 3) && !modeFits("gold_miner", 4));
  assert.ok(LOCAL_ARENA_IDS.includes("gold_miner"));
});

test("the camera shows the whole mine and the miners in the space the HUD leaves, wide or tall (phone portrait too)", () => {
  const b = mineBounds();
  for (const [width, height] of [[1440, 900], [1280, 720], [390, 844], [360, 640], [844, 390], [768, 1024]]) {
    const insets = goldInsets(width, height),
      view = fitGoldView(width, height, insets);
    for (const x of [b.minX, b.maxX])
      for (const y of [b.minY, b.maxY]) {
        const p = projectGoldView(view, { x, y });
        assert.ok(p.x >= insets.left - 0.5 && p.x <= width - insets.right + 0.5, `${width}×${height}: x ${p.x}`);
        assert.ok(p.y >= insets.top - 0.5 && p.y <= height - insets.bottom + 0.5, `${width}×${height}: y ${p.y}`);
      }
    // It fills the free space in one direction.
    const left = projectGoldView(view, { x: b.minX, y: b.maxY }),
      right = projectGoldView(view, { x: b.maxX, y: b.minY });
    const fillX = (right.x - left.x) / (width - insets.left - insets.right),
      fillY = (right.y - left.y) / (height - insets.top - insets.bottom);
    assert.ok(Math.max(fillX, fillY) > 0.99, `${width}×${height}: fills ${fillX.toFixed(2)} / ${fillY.toFixed(2)}`);
    if (height > width) {
      assert.ok(fillX > 0.99, "tall screens: the mine spans the width");
      // A diamond (the smallest item) is still at least 12 px across on a phone.
      assert.ok((2 * G.items.diamond.radius) / view.scale >= 12, `diamond ${((2 * G.items.diamond.radius) / view.scale).toFixed(1)} px`);
    }
  }
});

function snapshotWire(g: GoldMinerGame): GoldWire {
  return goldSection(g, seats(g));
}
test("client clock: never ahead of the server; a press is stamped on it at the angle on screen; one shot at a time", () => {
  const g = mining(2, [item("small", -4.5, 5), item("rock", 4.5, 11)]);
  const client = new GoldMinerClient();
  for (let i = 0; i < 30; i++) g.step();
  // Snapshots sent at the server's clock arrive 40–90 ms later (wall time = server time + 10 000).
  const delays = [90, 40, 75, 55];
  for (const delay of delays) {
    g.step();
    client.observe(snapshotWire(g), 1, 10_000 + g.elapsedMs + delay, 0);
  }
  const wall = 10_000 + g.elapsedMs + 60;
  assert.ok(Math.abs(client.clock(wall) - (g.elapsedMs + 60 - 40)) < 0.01, "BAŞLA from the quickest snapshot");
  assert.ok(client.clock(wall) <= g.elapsedMs + 60, "never ahead");
  const wire = snapshotWire(g);
  assert.equal(client.press(wall, wire, 0), true);
  const p = client.pending!;
  assert.equal(p.shot, 1);
  assert.equal(p.at, client.clock(wall));
  assert.equal(p.angle, swingAngle(p.at, wire.origin[0]));
  assert.equal(client.press(wall + 5, wire, 0), false, "one pending shot");
  // Sent once; a refused send is tried again.
  const sent: number[] = [];
  client.flush(() => false);
  client.flush((s) => (sent.push(s.shot), true));
  client.flush((s) => (sent.push(s.shot), true));
  assert.deepEqual(sent, [1]);
  // Confirmed when the server's hook shows it.
  g.step([{ shot: 1, at: p.at }]);
  client.observe(snapshotWire(g), 1, 10_000 + g.elapsedMs + 50, 0);
  assert.equal(client.pending, null);
  assert.equal(client.press(10_000 + g.elapsedMs + 50, snapshotWire(g), 0), false, "the hook is out");
  // A refused shot gives up after a second.
  const h = new GoldMinerClient();
  h.observe(snapshotWire(g), 1, 10_000 + g.elapsedMs, 1);
  assert.ok(h.press(10_000 + g.elapsedMs, snapshotWire(g), 1));
  for (let i = 0; i < 70; i++) g.step();
  h.observe(snapshotWire(g), 1, 10_000 + g.elapsedMs, 1);
  assert.equal(h.pending, null);
  // Nothing before BAŞLA.
  const fresh = new GoldMinerClient(),
    c = new GoldMinerGame(2);
  fresh.observe(snapshotWire(c), 1, 500, 0);
  assert.equal(fresh.press(600, snapshotWire(c), 0), false);
  assert.ok(fresh.clock(600) < 0, "the countdown runs below zero");
});

test("canFire: only a swinging hook (or one already home on this clock) during mining", () => {
  const g = mining(2, [item("small", -4.5, 5), item("rock", 4.5, 11)]);
  for (let i = 0; i < 10; i++) g.step();
  let w = snapshotWire(g);
  assert.ok(canFire(w, 0, g.elapsedMs));
  assert.equal(canFire(w, 5, g.elapsedMs), false);
  g.step([{ shot: 1, at: g.elapsedMs + MS }]);
  w = snapshotWire(g);
  assert.equal(canFire(w, 0, g.elapsedMs), false, "out");
  while (g.lanes[0].hook.state === "out") g.step();
  w = snapshotWire(g);
  assert.equal(canFire(w, 0, w.home[0] - 1), false, "coming back");
  assert.equal(canFire(w, 0, w.home[0]), true, "home on this clock");
  g.remove(1);
  assert.equal(canFire(snapshotWire(g), 1, g.elapsedMs), false, "left");
});

test("the hooks drawn are the server's: at any moment the view's tip is the engine's", () => {
  const random = mulberry32(9);
  const g = new GoldMinerGame(3, random);
  while (g.phase === "countdown") g.step();
  let checked = 0;
  for (let t = 0; t < 30 * G.hz && g.phase === "mining"; t++) {
    const shots = g.lanes.map((l) => (l.hook.state === "swing" && random() < 0.04 ? { shot: l.hook.shots + 1, at: g.elapsedMs + MS - random() * 120 } : undefined));
    g.step(shots);
    const views = hookViews(frameOf(g));
    g.lanes.forEach((l, lane) => {
      const engine = hookPose(l.hook, g.elapsedMs);
      assert.ok(Math.abs(views[lane].angle - engine.angle) < 1e-5 && Math.abs(views[lane].length - engine.length) < 2e-3, `lane ${lane} at ${g.elapsedMs}`);
      checked++;
    });
  }
  assert.ok(checked > 1000);
});

test("between snapshots: an outgoing hook is drawn catching the first free item it reaches, and the item rides on it", () => {
  const g = mining(2, [item("big", -4.5, 7), item("small", 4.5, 4)]);
  const down = nextAngleTime(g.lanes[0].hook.origin, 0, MS);
  while ((g.ticks + 1) * MS < down) g.step();
  g.step([{ shot: 1, at: down }]);
  const fired = g.lanes[0].hook.fired;
  // The server has said "out" only; 0.5 s later the view already has it on the big gold.
  const frame = frameOf(g, fired + 500);
  const [v] = hookViews(frame);
  assert.equal(v.state, "back");
  assert.equal(v.item, 0);
  const contact = tipAt(pivotX(0, 2), { angle: v.angle, length: 7 - G.items.big.radius - G.hookRadius });
  assert.ok(Math.abs(v.angle) < 1e-9);
  assert.ok(v.carry && Math.abs(v.carry.y - (7 - contact.y)) < 1e-6 && Math.abs(v.carry.x) < 1e-6, "the gold hangs where it was caught");
  // This player's unconfirmed shot is drawn fired at once, at the pressed angle.
  const h = mining(2, [item("small", 4.5, 5)]);
  for (let i = 0; i < 20; i++) h.step();
  const at = h.elapsedMs - 30,
    angle = swingAngle(at, h.lanes[1].hook.origin);
  const [, mine] = hookViews(frameOf(h, h.elapsedMs, 1, { shot: 1, at, angle, origin: h.lanes[1].hook.origin }));
  assert.equal(mine.state, "out");
  assert.equal(mine.angle, angle);
  assert.ok(mine.length > G.restLength);
});

/** Bots alone: `levels[lane]` plays each lane for one 30 s round. */
function botRound(levels: readonly BotLevel[], seed: number) {
  const random = mulberry32(seed),
    g = new GoldMinerGame(levels.length, random),
    bots = levels.map((level) => new GoldBot(level, random));
  let fired = 0,
    refused = 0;
  while (g.phase !== "results") {
    const due = g.elapsedMs + MS;
    const shots = bots.map((bot, lane) => {
      if (g.phase !== "mining") return undefined;
      const at = bot.step(g, lane, due);
      return at === null ? undefined : { shot: g.lanes[lane].hook.shots + 1, at };
    });
    const before = g.lanes.map((l) => l.hook.shots);
    g.step(shots);
    shots.forEach((s, lane) => s && (g.lanes[lane].hook.shots > before[lane] ? fired++ : refused++));
  }
  return { g, bots, fired, refused };
}
test("bots play the mine for real: valuable, near items first; harder levels score more; they slip now and then", () => {
  assert.deepEqual([...BOT_LEVELS], ["easy", "medium", "hard"]);
  assert.ok(BOT_PLAY.easy.jitter > BOT_PLAY.medium.jitter && BOT_PLAY.medium.jitter > BOT_PLAY.hard.jitter);
  assert.ok(BOT_PLAY.easy.mistake > BOT_PLAY.medium.mistake && BOT_PLAY.medium.mistake > BOT_PLAY.hard.mistake && BOT_PLAY.hard.mistake > 0);
  const totals: Record<BotLevel, number> = { easy: 0, medium: 0, hard: 0 },
    empties: Record<BotLevel, number> = { easy: 0, medium: 0, hard: 0 },
    shots: Record<BotLevel, number> = { easy: 0, medium: 0, hard: 0 },
    mistakes: Record<BotLevel, number> = { easy: 0, medium: 0, hard: 0 };
  const games = 24;
  for (let seed = 1; seed <= games; seed++) {
    // Every level in every seat over the games.
    const order = [BOT_LEVELS[seed % 3], BOT_LEVELS[(seed + 1) % 3], BOT_LEVELS[(seed + 2) % 3]];
    const { g, bots, refused } = botRound(order, seed);
    assert.equal(refused, 0, "every bot press fires (it only presses while its hook swings)");
    order.forEach((level, lane) => {
      totals[level] += g.lanes[lane].score;
      shots[level] += g.lanes[lane].hook.shots;
      empties[level] += g.lanes[lane].hook.shots - g.lanes[lane].banked.length - (g.lanes[lane].hook.state !== "swing" ? 1 : 0);
      mistakes[level] += bots[lane].mistakes;
    });
  }
  const mean = (r: Record<BotLevel, number>, level: BotLevel) => r[level] / games;
  assert.ok(mean(totals, "hard") > mean(totals, "medium") && mean(totals, "medium") > mean(totals, "easy"), `points ${JSON.stringify(totals)}`);
  assert.ok(empties.easy / shots.easy > empties.hard / shots.hard, `misses ${JSON.stringify(empties)} of ${JSON.stringify(shots)}`);
  assert.ok(empties.hard > 0 || mistakes.hard > 0, "even a hard bot is not perfect");
  assert.ok(mistakes.easy > mistakes.hard);
  for (const level of BOT_LEVELS) assert.ok(mean(shots, level) >= 5, `${level} keeps shooting: ${mean(shots, level)}`);
});

test("a bot prefers a valuable near item to a rock and leaves an item another hook is already flying at", () => {
  // Lane 1's bot (hard, no slips): a big gold below-left, a rock straight below.
  const g = mining(2, [item("rock", 4.5, 5), item("big", 2.5, 7), item("small", -4.5, 4)]);
  const bot = new GoldBot("hard", () => 0.5);
  let at: number | null = null;
  for (let i = 0; i < 200 && at === null; i++) {
    at = bot.step(g, 1, g.elapsedMs + MS);
    g.step([undefined, at === null ? undefined : { shot: 1, at }]);
  }
  assert.ok(at !== null);
  for (let i = 0; i < 120 && g.lanes[1].hook.state !== "swing"; i++) g.step();
  assert.equal(g.items[1].by, 1, "took the big gold");
  // The next-swing helper finds the moment a swing points at an angle.
  const t = nextAngleTime(100, 0.5, 2000);
  assert.ok(t >= 2000 && Math.abs(swingAngle(t, 100) - 0.5) < 1e-9);
  // Watching: lane 0 fires at the only good item; the bot does not race for it.
  const w = mining(2, [item("diamond", 0, 6), item("small", 4.5, 4)]);
  const aim0 = Math.atan2(4.5, 6);
  const fire0 = nextAngleTime(w.lanes[0].hook.origin, aim0, MS);
  while ((w.ticks + 1) * MS < fire0) w.step();
  w.step([{ shot: 1, at: fire0 }]);
  // A hard bot, no slips (0.5 never falls under its mistake rate), decides while lane 0's
  // hook is still on its way (the mine held still): it goes for the small gold.
  const watcher = new GoldBot("hard", () => 0.5);
  assert.equal(w.lanes[0].hook.state, "out");
  let pick: number | null = null;
  for (let now = w.elapsedMs + MS; now < w.elapsedMs + 3000 && pick === null; now += MS) pick = watcher.step(w, 1, now);
  assert.ok(pick !== null);
  assert.equal(traceShot(w.items, w.pivot(1), swingAngle(pick, w.lanes[1].hook.origin), 0).item, 1, "the small gold, not the diamond");
});

test("Yerel Test Arenası: the player is lane 0 (bots never play it), presses fire only while swinging, the menu pauses the mine", () => {
  const local = new LocalGoldMiner(3, "medium", mulberry32(4));
  let frame = local.frame(0, false);
  assert.equal(frame.wire.phase, "countdown");
  assert.equal(local.press(), false, "countdown");
  for (let i = 0; i < 20 && frame.wire.phase === "countdown"; i++) frame = local.frame(0.2, false);
  assert.equal(frame.wire.phase, "mining");
  // Paused: no time passes.
  const elapsed = frame.wire.elapsed;
  for (let i = 0; i < 30; i++) frame = local.frame(0.1, true);
  assert.equal(frame.wire.elapsed, elapsed);
  assert.equal(local.press(), true);
  assert.equal(local.press(), false, "already pressed");
  frame = local.frame(1 / 60, false);
  assert.equal(local.game.lanes[0].hook.shots, 1);
  // The rest of the round without the player pressing: bots mine, lane 0 shoots no more.
  for (let i = 0; i < 40 * 60 && frame.wire.phase === "mining"; i++) frame = local.frame(1 / 60, false);
  assert.equal(frame.wire.phase, "results");
  assert.equal(local.game.lanes[0].hook.shots, 1);
  assert.ok(local.game.lanes[1].hook.shots > 5 && local.game.lanes[2].hook.shots > 5, "the bots kept mining");
  assert.ok(local.game.lanes[1].score + local.game.lanes[2].score > 0);
});

test("results: places order, what each brought up", () => {
  const g = mining(2, [item("diamond", -4.5, 5), item("small", 4.5, 4), item("rock", 0, 11)]);
  for (const lane of [0, 1]) {
    const at = nextAngleTime(g.lanes[lane].hook.origin, 0, g.elapsedMs + MS);
    while ((g.ticks + 1) * MS < at) g.step();
    g.step(g.lanes.map((_, l) => (l === lane ? { shot: 1, at } : undefined)));
  }
  for (let i = 0; i < 90; i++) g.step();
  g.ticks = g.limitTicks - 1;
  g.step();
  const end = snapshotWire(g);
  assert.equal(finds(end, 0), "1 elmas");
  assert.equal(finds(end, 1), "1 küçük altın");
  assert.deepEqual(resultOrder(end), [0, 1]);
  assert.equal(finds({ ...end, by: end.by.map(() => -1) }, 0), "—");
});
