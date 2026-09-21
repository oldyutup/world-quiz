import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalBot, type BotObservation } from "./bots";

function observations(): BotObservation[] {
  return [
    { id: 0, x: 1.5, z: 2.6, alive: true, grounded: true },
    { id: 1, x: -3, z: 0, alive: true, grounded: true },
    { id: 2, x: 1.5, z: -2.6, alive: true, grounded: true },
  ];
}

test("bots only produce normalized input without modifying player observations", () => {
  const bot = new LocalBot(1, () => 0.3);
  const players = observations();
  const before = JSON.stringify(players);
  const input = bot.update(1 / 60, players, 7, 6);
  assert.ok(Math.hypot(input.x, input.z) > 0.99);
  assert.ok(Math.hypot(input.x, input.z) <= 1.00001);
  assert.equal(JSON.stringify(players), before);
});

test("edge steering points inward without granting a jump or extra speed", () => {
  const bot = new LocalBot(1, () => 0.3);
  const players = observations();
  players[1].x = 6.5;
  players[1].z = 5.5;
  const input = bot.update(5, players, 7, 6);
  assert.ok(input.x < 0 && input.z < 0);
  assert.equal(input.jump, false);
  assert.ok(Math.hypot(input.x, input.z) <= 1.00001);
});

test("bot jumps require ground contact and have a cooldown", () => {
  const bot = new LocalBot(2, () => 0.3);
  const players = observations();
  players[2].grounded = false;
  assert.equal(bot.update(5, players, 7, 6).jump, false);
  players[2].grounded = true;
  assert.equal(bot.update(0.01, players, 7, 6).jump, true);
  assert.equal(bot.update(0.01, players, 7, 6).jump, false);
});

test("eliminated bots stop and reset clears old inputs", () => {
  const bot = new LocalBot(1, () => 0.3);
  const players = observations();
  bot.update(3, players, 7, 6);
  players[1].alive = false;
  assert.deepEqual(bot.update(1, players, 7, 6), { x: 0, z: 0, jump: false });
  bot.reset();
  assert.deepEqual(bot.input, { x: 0, z: 0, jump: false });
});
