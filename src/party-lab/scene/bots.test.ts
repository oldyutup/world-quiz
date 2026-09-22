import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalBot, type BotObservation } from "./bots";
import { PLAYERS } from "./players";
const observations = (): BotObservation[] =>
  PLAYERS.map((p) => ({
    id: p.id,
    x: p.id * 0.8,
    z: 0,
    alive: true,
    grounded: true,
    state: "CONSCIOUS",
    cooldowns: [0, 0],
    grips: [null, null],
    grabbedBy: null,
  }));
test("bots produce bounded input without modifying observations", () => {
  const p = observations(),
    copy = structuredClone(p),
    b = new LocalBot(1, () => 0.7);
  b.reset();
  for (let f = 0; f < 600; f++) {
    const i = b.update(1 / 60, p, 7, 6);
    assert.ok(Math.hypot(i.x, i.z) <= 1.001);
  }
  assert.deepEqual(p, copy);
});
test("both hands respect attack cooldowns and decisions are not every frame", () => {
  const p = observations(),
    b = new LocalBot(1, () => 0.8);
  b.reset();
  p[1].cooldowns = [1, 1];
  for (let f = 0; f < 600; f++) {
    const i = b.update(1 / 60, p, 7, 6);
    assert.ok(!i.punchLeft && !i.punchRight);
  }
  p[1].cooldowns = [0, 0];
  let attacks = 0;
  for (let f = 0; f < 600; f++) {
    const i = b.update(1 / 60, p, 7, 6);
    if (i.punchLeft || i.punchRight) attacks++;
  }
  assert.ok(attacks > 0 && attacks < 15);
});
test("bot secures a second hand, lifts a vulnerable target, and releases near an edge", () => {
  const p = observations(),
    b = new LocalBot(1, () => 0.2);
  b.reset();
  p[0].state = "KNOCKED_OUT";
  for (let f = 0; f < 100; f++) b.update(1 / 60, p, 7, 6);
  p[1].grips = [0, null];
  let both = false,
    lift = false;
  for (let f = 0; f < 40; f++) {
    const i = b.update(1 / 60, p, 7, 6);
    both ||= !!i.left && !!i.right;
    lift ||= !!i.lift;
  }
  assert.ok(both && lift);
  p[1].x = 6.3;
  const i = b.update(1 / 60, p, 7, 6);
  assert.ok(!i.left && !i.right);
});
test("grabbed bots react late, pull away and can punch; KO/elimination clear intent", () => {
  const p = observations(),
    b = new LocalBot(1, () => 0.8);
  b.reset();
  p[1].grabbedBy = 0;
  let away = false,
    attack = false;
  for (let f = 0; f < 300; f++) {
    const i = b.update(1 / 60, p, 7, 6);
    away ||= i.x > 0;
    attack ||= !!i.punchRight;
  }
  assert.ok(away && attack);
  p[1].state = "KNOCKED_OUT";
  assert.equal(b.update(1 / 60, p, 7, 6).x, 0);
  assert.equal(b.input.punchRight, false);
  p[1].alive = false;
  assert.equal(b.update(1 / 60, p, 7, 6).left, false);
  b.reset();
  assert.equal(b.input.right, false);
});
test("edge steering returns inward and jumping requires grounded state", () => {
  const p = observations(),
    b = new LocalBot(1, () => 0.2);
  b.reset();
  p[1].x = 6.8;
  p[1].grounded = false;
  for (let f = 0; f < 600; f++) {
    const i = b.update(1 / 60, p, 7, 6);
    assert.ok(i.x < 0);
    assert.equal(i.jump, false);
  }
});
