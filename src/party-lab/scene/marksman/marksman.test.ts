import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { PerspectiveCamera } from "three";
import { MARKSMAN as M } from "../../../../shared/party-lab/simulation/marksman/config";
import { MarksmanGame } from "../../../../shared/party-lab/simulation/marksman/game";
import { EMPTY, TARGET, BOMB, makeWaves, type SlotKind, type Wave } from "../../../../shared/party-lab/simulation/marksman/waves";
import { marksmanSection, type MarksmanWire } from "../../../../shared/party-lab/simulation/marksman/wire";
import { mulberry32 } from "../../../../shared/party-lab/simulation/colors/layouts";
import { GAME_MODES, MODE_NAMES, MODE_PLAYERS, modeFits } from "../../../../shared/party-lab/modes";
import { LOCAL_ARENA_IDS } from "../../../../shared/party-lab/localArenas";
import { NET, type GameSnapshot } from "../../../../shared/party-lab/network/protocol";
import type { MovementInput } from "../../../../shared/party-lab/intent";
import { CHAT_LAYOUT } from "../gameChat";
import { ClickPresses } from "../clickrace/input";
import { defaultBindings } from "../../input/defaults";
import { AimKeys, aimBindings, aimLabel, bindMarksmanInput, fireBindings, fireLabel } from "./input";
import { LocalMarksman, MarksmanClient, OnlineMarksmanSource, LOWER_MS, botView, canShoot, drawTime, judge, laneViews, livesOf, type MarksmanFrame, type PendingShot } from "./source";
import { GALLERY, MARKSMAN_INSETS, fitMarksmanCamera, galleryBounds, laneX, projectMarksman, slotPoint } from "./layout";
import { points, resultOrder, scoreText } from "./results";

const MS = 1000 / M.hz;
const waves = (...kinds: SlotKind[][]): Wave[] => kinds.map((k, i) => ({ open: 1000 + 2000 * i, close: 2500 + 2000 * i, kinds: k }));
function shooting(count = 2, schedule?: Wave[], seed = 3) {
  const g = new MarksmanGame(count, mulberry32(seed), schedule);
  while (g.phase === "countdown") g.step();
  return g;
}
const run = (g: MarksmanGame, ms: number) => {
  while (g.elapsedMs < ms - 1e-9 && g.phase === "shooting") g.step();
};
const wireOf = (g: MarksmanGame): MarksmanWire => marksmanSection(g, g.lanes.map((_, lane) => lane));
const known = (g: MarksmanGame) => new Map(g.waves.map((w, id) => [id, w] as const));
const frameOf = (g: MarksmanGame, now = g.elapsedMs, self = -1, aim = 0, pending: PendingShot[] = []): MarksmanFrame => ({ wire: wireOf(g), now, winner: g.winner(), round: 1, self, aim, pending, waves: known(g) });

test("Nişancı is a registered 2–3 player mode on protocol 21, with a local arena, a chat spot, a lobby hint and an online view", () => {
  assert.equal(NET.version, 21);
  assert.ok(GAME_MODES.includes("marksman"));
  assert.equal(MODE_NAMES.marksman, "Nişancı");
  assert.deepEqual(MODE_PLAYERS.marksman, { min: 2, max: 3 });
  assert.ok(modeFits("marksman", 2) && modeFits("marksman", 3) && !modeFits("marksman", 4));
  assert.ok(LOCAL_ARENA_IDS.includes("marksman"));
  assert.ok(CHAT_LAYOUT.marksman.wide.bottom >= 0);
  const lobby = readFileSync(new URL("../../PartyLobby.tsx", import.meta.url), "utf8");
  assert.match(lobby, /marksman: "/);
  const arena = readFileSync(new URL("../OnlineArena.tsx", import.meta.url), "utf8");
  assert.match(arena, /mode === "marksman"\) return/);
  const local = readFileSync(new URL("../ArenaScene.tsx", import.meta.url), "utf8");
  assert.match(local, /id === "marksman" \? "Nişancı"/);
  assert.match(local, /MARKSMAN_BOT_LEVELS\.map/, "a bot level menu");
});

test("keys: Space fires (never a mouse button), A / D and the arrows aim; a held fire key and its repeats shoot once", () => {
  const fire = fireBindings(defaultBindings());
  assert.ok(fire.has("Space") && ![...fire].some((k) => k.startsWith("Mouse")));
  assert.equal(fireLabel(defaultBindings()), "SPACE");
  assert.equal(aimLabel(defaultBindings()), "A / D");
  const { left, right } = aimBindings(defaultBindings());
  assert.ok(left.has("KeyA") && left.has("ArrowLeft") && right.has("KeyD") && right.has("ArrowRight"));
  const presses = new ClickPresses(fire);
  assert.equal(presses.key("Space", false), true);
  assert.equal(presses.key("Space", true), false, "key repeat");
  assert.equal(presses.key("Space", false), false, "still held (a repeat without the flag)");
  presses.keyUp("Space");
  assert.equal(presses.key("Space", false), true, "pressed again");
  assert.ok(fireBindings({ ...defaultBindings(), jump: ["MouseLeft", null] }).has("Space"), "falls back to Space");
});

test("aim: the middle with no key, left or right while held, back to the middle on release; with both held the one pressed last", () => {
  const aim = new AimKeys(new Set(["KeyA", "ArrowLeft"]), new Set(["KeyD", "ArrowRight"]));
  assert.equal(aim.aim, 0);
  assert.equal(aim.down("KeyA"), true);
  assert.equal(aim.aim, -1);
  aim.up("KeyA");
  assert.equal(aim.aim, 0, "released: the middle");
  aim.down("KeyA");
  aim.down("KeyD");
  assert.equal(aim.aim, 1, "D pressed last");
  aim.up("KeyD");
  assert.equal(aim.aim, -1, "A still held");
  aim.down("KeyD");
  aim.down("KeyA");
  assert.equal(aim.aim, -1, "A pressed last");
  aim.up("KeyA");
  assert.equal(aim.aim, 1);
  aim.down("ArrowLeft");
  assert.equal(aim.aim, -1, "the arrows too");
  assert.equal(aim.down("Space"), false, "not an aim key");
  aim.clear();
  assert.equal(aim.aim, 0);
});

test("the key handler: aim and fire through real key events; nothing while input is off (menu or chat open); a release always counts", () => {
  const g = globalThis as Record<string, unknown>,
    saved = { window: g.window, document: g.document, HTMLElement: g.HTMLElement };
  const target = new EventTarget();
  g.window = target;
  g.document = { activeElement: null };
  g.HTMLElement = class {};
  try {
    const key = (type: string, code: string, repeat = false) => target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code, repeat, metaKey: false, ctrlKey: false, altKey: false, isComposing: false }));
    const presses = new ClickPresses(fireBindings(defaultBindings())),
      keys = new AimKeys(aimBindings(defaultBindings()).left, aimBindings(defaultBindings()).right);
    let on = true,
      shots = 0;
    const aims: number[] = [];
    const unbind = bindMarksmanInput(presses, keys, () => on, () => shots++, () => aims.push(keys.aim));
    key("keydown", "KeyA");
    key("keydown", "Space");
    key("keydown", "Space", true);
    key("keydown", "Space");
    assert.equal(shots, 1, "held: one shot");
    key("keyup", "Space");
    key("keydown", "KeyD");
    key("keydown", "Space");
    assert.equal(shots, 2);
    assert.equal(keys.aim, 1);
    key("keyup", "KeyD");
    assert.equal(keys.aim, -1);
    // The chat (or the menu) is open: keys do nothing; releasing still lets go.
    on = false;
    key("keyup", "Space");
    key("keydown", "Space");
    key("keydown", "KeyD");
    assert.equal(shots, 2, "no shot with the chat open");
    assert.equal(keys.aim, -1, "no aim change with the chat open");
    key("keyup", "KeyA");
    assert.equal(keys.aim, 0, "a release still counts");
    on = true;
    target.dispatchEvent(new Event("blur"));
    assert.equal(keys.aim, 0);
    assert.ok(aims.length >= 4);
    unbind();
    key("keydown", "Space");
    assert.equal(shots, 2, "unbound");
  } finally {
    Object.assign(g, saved);
  }
});

test("judge: the client scores a shot exactly as the server does (stamp, aim, one hit per target, empty and closed slots, bombs)", () => {
  for (let seed = 0; seed < 30; seed++) {
    const random = mulberry32(seed),
      g = new MarksmanGame(2, random),
      ws = known(g);
    while (g.phase === "countdown") g.step();
    let t = 300;
    while (g.phase === "shooting" && t < M.limit * 1000) {
      t += 130 + random() * 600;
      const aim = Math.floor(random() * 3) - 1,
        expect = judge(ws, g.lanes[0].hits, t, aim);
      const stunned = t < g.lanes[0].stunUntil;
      run(g, t);
      const before = g.lanes[0].hits.length,
        got = g.shoot(0, { at: t, aim });
      if (stunned) {
        assert.equal(got, null);
        continue;
      }
      if (got === null) break;
      assert.deepEqual(g.lanes[0].hits.length > before ? g.lanes[0].hits[g.lanes[0].hits.length - 1] : null, expect, `seed ${seed} at ${t.toFixed(1)} aim ${aim}`);
    }
  }
});

test("client clock: never ahead of the server; a shot is stamped on it with the aim held then, judged at once, sent with the aim (the latest three shots), confirmed by the server's count", () => {
  const g = shooting(2, waves([TARGET, BOMB, EMPTY], [TARGET, TARGET, TARGET]));
  const client = new MarksmanClient();
  run(g, 900);
  for (const delay of [90, 40, 75, 55]) {
    g.step();
    client.observe(wireOf(g), 1, 10_000 + g.elapsedMs + delay, 0);
  }
  const wall = (t: number) => 10_000 + 40 + t;
  assert.ok(Math.abs(client.clock(wall(g.elapsedMs)) - g.elapsedMs) < 0.01, "BAŞLA from the quickest snapshot");
  const sent: { aim: number; fired: number; shots: number[] }[] = [];
  const flush = (ok = true) => client.flush((p) => (sent.push(p), ok), 0);
  client.setAim(-1);
  flush(false);
  flush();
  flush();
  assert.deepEqual(sent.map((p) => p.aim), [-1, -1], "the aim alone, retried after a refusal, then sent once");
  // A shot at 1.3 s: the left target, +5 drawn at once.
  assert.equal(client.fire(wall(1300)), true);
  assert.deepEqual(client.pending, [{ n: 1, at: 1300, aim: -1, hit: { wave: 0, slot: 0, at: 1300, points: M.points.good } }]);
  assert.equal(client.fire(wall(1300 + M.cooldownMs - 1)), false, "cooldown");
  client.setAim(0);
  assert.equal(client.fire(wall(1300 + M.cooldownMs)), true, "0.12 s later");
  assert.equal(client.pending[1].hit?.points, M.points.bomb, "the bomb");
  assert.equal(client.fire(wall(1900)), false, "stunned by the bomb this screen just saw");
  flush();
  assert.deepEqual(sent[sent.length - 1], { aim: 0, fired: 2, shots: [1300, -1, 1420, 0] });
  // The server counts them: confirmed, and its hits are in the wire now.
  run(g, 1440);
  g.step([{ aim: 0, fired: 2, shots: [{ at: 1300, aim: -1 }, { at: 1420, aim: 0 }] }]);
  client.observe(wireOf(g), 1, wall(g.elapsedMs), 0);
  assert.deepEqual(client.pending, []);
  assert.deepEqual(client.hits().map((h) => h.points), [M.points.good, M.points.bomb]);
  assert.equal(client.fire(wall(2300)), false, "still stunned (the server's word)");
  assert.equal(client.fire(wall(2425)), true, "free again");
  // The fourth shot only carries the latest three.
  client.fire(wall(3100));
  client.fire(wall(3250));
  flush();
  assert.deepEqual(sent[sent.length - 1].shots, [2425, 0, 3100, 0, 3250, 0]);
  assert.equal(sent[sent.length - 1].fired, 5);
  // Nothing before BAŞLA.
  const fresh = new MarksmanClient(),
    c = new MarksmanGame(2);
  fresh.observe(wireOf(c), 1, 500, 0);
  assert.equal(fresh.fire(600), false);
  assert.ok(fresh.clock(600) < 0, "the countdown runs below zero");
  // Back after a drop: numbering goes on from the server's count, and the aim is told again.
  const back = new MarksmanClient();
  back.setAim(1);
  back.flush(() => true, 0);
  const g2 = shooting(2, waves([TARGET, TARGET, TARGET]));
  run(g2, 900);
  g2.step([{ aim: 0, fired: 7, shots: [] }]);
  back.observe(wireOf(g2), 1, 5_000, 0);
  const again: { fired: number; aim: number }[] = [];
  back.flush((p) => (again.push(p), true), 5_000);
  assert.deepEqual(again, [{ aim: 1, fired: 7, shots: [] }]);
});

test("canShoot: only while shooting, still in, within the 45 s", () => {
  const g = shooting();
  const w = wireOf(g);
  assert.ok(canShoot(w, 0, 10));
  assert.equal(canShoot(w, 4, 10), false);
  assert.equal(canShoot(w, 0, -1), false);
  assert.equal(canShoot(w, 0, M.limit * 1000), false, "time is up");
  assert.equal(canShoot(wireOf(new MarksmanGame(2)), 0, 0), false, "countdown");
  g.remove(1);
  assert.equal(canShoot(wireOf(g), 1, 10), false, "left");
  const k = shooting(3, waves([BOMB, TARGET, TARGET], [BOMB, TARGET, TARGET]));
  run(k, 1100);
  k.shoot(0, { at: 1100, aim: -1 });
  run(k, 3100);
  k.shoot(0, { at: 3100, aim: -1 });
  assert.equal(canShoot(wireOf(k), 0, 3200), false, "knocked out");
  assert.ok(canShoot(wireOf(k), 1, 3200));
});

test("lives on this screen: an own bomb not counted yet takes a life at once (the first stuns, the second knocks out); the client stops shooting", () => {
  const g = shooting(2, waves([BOMB, TARGET, EMPTY], [BOMB, BOMB, BOMB]));
  run(g, 1000);
  const w = wireOf(g),
    first = judge(known(g), [], 1100, -1)!,
    second = judge(known(g), [first], 3100, 0)!;
  assert.deepEqual(livesOf(w, 0, []), { lives: 2, diedAt: -1, stunUntil: 0 });
  assert.deepEqual(livesOf(w, 0, [{ n: 1, at: 1100, aim: -1, hit: first }]), { lives: 1, diedAt: -1, stunUntil: 1100 + M.stunMs });
  assert.deepEqual(livesOf(w, 0, [{ n: 1, at: 1100, aim: -1, hit: first }, { n: 2, at: 3100, aim: 0, hit: second }]), { lives: 0, diedAt: 3100, stunUntil: 1100 + M.stunMs });
  const [mine] = laneViews(frameOf(g, 3150, 0, 0, [{ n: 1, at: 1100, aim: -1, hit: first }, { n: 2, at: 3100, aim: 0, hit: second }]));
  assert.deepEqual([mine.lives, mine.diedAt], [0, 3100]);
  assert.equal(botView(frameOf(g, 3150, 0, 0, [{ n: 1, at: 1100, aim: -1, hit: first }, { n: 2, at: 3100, aim: 0, hit: second }]), 0).playing, false, "the autopilot stops too");
  // The client: two bombs drawn at once, then no more shots; the server agrees.
  const client = new MarksmanClient(),
    wall = (t: number) => 50_000 + t;
  client.observe(wireOf(g), 1, wall(g.elapsedMs), 0);
  client.setAim(-1);
  assert.equal(client.fire(wall(1100)), true);
  client.setAim(0);
  assert.equal(client.fire(wall(2000)), false, "stunned");
  run(g, 1120);
  g.step([{ aim: 0, fired: 1, shots: [{ at: 1100, aim: -1 }] }]);
  run(g, 2600);
  client.observe(wireOf(g), 1, wall(g.elapsedMs), 0);
  assert.deepEqual([client.pending.length, client.life().lives], [0, 1], "the server counted the first");
  assert.equal(client.fire(wall(3100)), true);
  assert.equal(client.life().diedAt, 3100);
  assert.equal(client.fire(wall(3400)), false, "knocked out");
  run(g, 3110);
  g.step([{ aim: 0, fired: 2, shots: [{ at: 1100, aim: -1 }, { at: 3100, aim: 0 }] }]);
  assert.equal(g.lanes[0].diedAt, 3100);
  client.observe(wireOf(g), 1, wall(g.elapsedMs), 0);
  assert.deepEqual(client.pending, []);
  assert.deepEqual(client.life(), { lives: 0, diedAt: 3100, stunUntil: 2100 });
  assert.equal(client.fire(wall(3500)), false);
});

test("lanes as drawn: the wave up in every lane's slots, an own hit at once (target down, score up), a bomb's stun; the others' aim from the server", () => {
  const g = shooting(2, waves([TARGET, BOMB, EMPTY], [EMPTY, TARGET, EMPTY]));
  run(g, 1100);
  g.step([undefined, { aim: 1, fired: 0, shots: [] }]);
  let [mine, other] = laneViews(frameOf(g, 1150, 0, -1));
  assert.deepEqual(mine.slots.map((s) => s && s.kind), [TARGET, BOMB, null]);
  assert.deepEqual(other.slots.map((s) => s && s.kind), [TARGET, BOMB, null], "the same wave in every lane");
  assert.equal(mine.aim, -1, "own aim from this screen");
  assert.equal(other.aim, 1, "the other's from the server");
  // An own shot the server has not counted yet: drawn at once.
  const hit = judge(known(g), [], 1150, -1)!;
  [mine, other] = laneViews(frameOf(g, 1160, 0, -1, [{ n: 1, at: 1150, aim: -1, hit }]));
  assert.deepEqual(mine.slots[0]?.hit, hit);
  assert.equal(mine.score, M.points.good);
  assert.equal(mine.shotAt, 1150);
  assert.equal(other.slots[0]?.hit, null, "only this player's copy");
  const bomb = judge(known(g), [hit], 1300, 0)!;
  [mine] = laneViews(frameOf(g, 1310, 0, 0, [{ n: 1, at: 1150, aim: -1, hit }, { n: 2, at: 1300, aim: 0, hit: bomb }]));
  assert.equal(mine.score, M.points.good + M.points.bomb);
  assert.equal(mine.stunUntil, 1300 + M.stunMs);
  // Still drawn while it goes down, then nothing until the next wave.
  assert.ok(laneViews(frameOf(g, 2500 + LOWER_MS - 1))[0].slots[0]);
  assert.deepEqual(laneViews(frameOf(g, 2500 + LOWER_MS))[0].slots, [null, null, null]);
  assert.equal(laneViews(frameOf(g, 3000))[0].slots[1]?.kind, TARGET);
  assert.equal(drawTime(wireOf(g), M.limit * 1000 + 5000), M.limit * 1000 + M.aimToleranceMs + 100);
});

test("online source: the aim and a shot go out as a marksman packet stamped on the clock, the frame shows it at once", () => {
  const g = shooting(2, waves([TARGET, TARGET, TARGET]), 8);
  run(g, 1100);
  let snapshot = { round: 4, winner: -1, marksman: wireOf(g) } as unknown as GameSnapshot;
  const sent: MovementInput[] = [];
  const stream = { snapshots: { get latest() { return { snapshot, received: performance.now() - 30 }; } } };
  const source = new OnlineMarksmanSource({ stream: stream as never, sendInput: (input) => (sent.push(input), {} as never) }, 4, 1);
  assert.ok(source.frame());
  source.aim(1);
  assert.equal(source.fire(performance.now()), true);
  const frame = source.frame()!;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].marksman?.round, 4);
  assert.equal(sent[0].marksman?.aim, 1);
  assert.equal(sent[0].marksman?.fired, 1);
  assert.equal(sent[0].marksman?.shots.length, 2);
  assert.ok(Math.abs(sent[0].marksman!.shots[0] - frame.pending[0].at) < 1e-9);
  assert.equal(frame.aim, 1);
  assert.equal(laneViews(frame)[1].slots[2]?.hit?.points, M.points.good);
  source.frame();
  assert.equal(sent.length, 1, "once");
  // Another round's snapshot is not this arena's.
  snapshot = { ...snapshot, round: 5 } as GameSnapshot;
  assert.equal(source.frame(), null);
  // Watching: nothing to send.
  const watcher = new OnlineMarksmanSource({ stream: stream as never, sendInput: () => assert.fail("a watcher sent") }, 5, -1);
  watcher.frame();
  assert.equal(watcher.fire(performance.now()), false);
});

test("local arena: the player shoots through the same rules, bots really play, the round ends with a winner; paused, nothing moves", () => {
  const local = new LocalMarksman(3, "hard", mulberry32(4));
  let frame = local.frame(0.2, false);
  while (frame.wire.phase === "countdown") frame = local.frame(0.2, false);
  assert.equal(frame.wire.phase, "shooting");
  const first = local.game.waves.find((w) => w.kinds.includes(TARGET))!;
  while (local.now < first.open + 100) local.frame(MS / 1000, false);
  local.aim(first.kinds.indexOf(TARGET) - 1);
  assert.equal(local.fire(), true);
  assert.equal(local.fire(), false, "cooldown");
  frame = local.frame(MS / 1000 + 0.001, false);
  assert.equal(frame.wire.score[0], M.points.good);
  const before = local.game.elapsedMs;
  local.frame(1, true);
  assert.equal(local.game.elapsedMs, before);
  for (let i = 0; i < 60 * M.hz && local.game.phase !== "results"; i++) local.frame(MS / 1000, false);
  assert.equal(local.game.phase, "results");
  const bots = local.game.lanes.slice(1);
  assert.ok(bots.every((l) => l.shots > 10 && (l.score > 100 || l.diedAt >= 0)), `bots ${bots.map((l) => `${l.score}/${l.diedAt}`)}`);
  assert.ok(bots.every((l) => l.lives <= M.lives && (l.diedAt < 0) === l.lives > 0), "bots have lives too");
  assert.ok(local.game.winner() >= 1);
  assert.equal(resultOrder(local.frame(0, false).wire)[0], local.game.winner());
  assert.ok(new Set(frame.wire.aim).size >= 1);
});

test("autopilot view: the waves opened by now, the stun this screen knows", () => {
  const g = shooting(2, waves([TARGET, TARGET, TARGET], [TARGET, EMPTY, EMPTY]));
  run(g, 1100);
  const view = botView(frameOf(g, 1100, 0), 0);
  assert.equal(view.playing, true);
  assert.deepEqual(view.waves.map((w) => w.id), [0]);
  assert.equal(botView(frameOf(g, 1100, 0, 0, [{ n: 1, at: 1050, aim: 0, hit: { wave: 0, slot: 1, at: 1050, points: M.points.bomb } }]), 0).stunUntil, 1050 + M.stunMs);
});

test("the camera fits every slot and player in the space the HUD leaves, 2 and 3 players; lanes left to right", () => {
  for (const count of [2, 3])
    for (const [width, height] of [[1440, 900], [1280, 720], [1920, 1080], [1024, 768]]) {
      const camera = new PerspectiveCamera(),
        fit = fitMarksmanCamera(camera, width, height, count);
      const b = galleryBounds(count);
      for (const r of [b.far, b.near])
        for (const x of [r.minX, r.maxX])
          for (const y of [r.minY, r.maxY]) {
            const p = projectMarksman(camera, width, height, x, y, r.z);
            assert.ok(p.x >= MARKSMAN_INSETS.left - 1 && p.x <= width - MARKSMAN_INSETS.right + 1, `${count}P ${width}×${height}: x ${p.x}`);
            assert.ok(p.y >= MARKSMAN_INSETS.top - 1 && p.y <= height - MARKSMAN_INSETS.bottom + 1, `${count}P ${width}×${height}: y ${p.y}`);
          }
      const fill = Math.max((fit.box.x1 - fit.box.x0) / fit.free.w, (fit.box.y1 - fit.box.y0) / fit.free.h);
      assert.ok(fill > 0.98, `fills ${fill}`);
      const xs = Array.from({ length: count }, (_, lane) => projectMarksman(camera, width, height, laneX(lane, count), GALLERY.targetY, GALLERY.targetZ).x);
      assert.ok(xs.every((x, i) => i === 0 || x > xs[i - 1]));
      const a = projectMarksman(camera, width, height, slotPoint(0, count, 0).x - GALLERY.radius, GALLERY.targetY, GALLERY.targetZ).x,
        z = projectMarksman(camera, width, height, slotPoint(0, count, 0).x + GALLERY.radius, GALLERY.targetY, GALLERY.targetZ).x;
      assert.ok(z - a >= 34, `a target is ${(z - a).toFixed(1)} px wide`);
    }
});

test("words and numbers: +5 / +2 / −5 with a real minus; the lanes in places order", () => {
  assert.equal(points(5), "+5");
  assert.equal(points(-5), "−5");
  assert.equal(scoreText(-12), "−12");
  assert.equal(scoreText(34), "34");
  const g = shooting(3, waves([TARGET, TARGET, TARGET]));
  run(g, 1100);
  g.shoot(2, { at: 1100, aim: 0 });
  assert.deepEqual(resultOrder(wireOf(g)), [2, 0, 1]);
  assert.equal(makeWaves(mulberry32(1)).length > 20, true);
});
