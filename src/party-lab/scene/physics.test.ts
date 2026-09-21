// node --import tsx --test src/party-lab/scene/*.test.ts
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { BUMPERS, IDLE_INPUT, initializePhysics, PHYSICS, PlaygroundPhysics } from "./physics";
import { PLAYERS } from "./players";
import { LocalRoundSimulation } from "./localRound";
import { ROUND } from "./roundLogic";
import type { MovementInput } from "../input/keyboard";

before(() => initializePhysics());

function withWorld(check: (physics: PlaygroundPhysics) => void) {
  const physics = new PlaygroundPhysics();
  try { check(physics); } finally { physics.dispose(); }
}

function advance(physics: PlaygroundPhysics, steps: number, input = IDLE_INPUT) {
  for (let i = 0; i < steps; i++) physics.step([input, IDLE_INPUT, IDLE_INPUT]);
}

test("exactly three equal-mass dynamic beans settle upright at separated spawns", () => withWorld(physics => {
  assert.equal(physics.players.length, 3);
  advance(physics, 180);
  for (const player of physics.players) {
    assert.ok(player.body.isDynamic());
    assert.equal(player.body.mass(), 1);
    assert.ok(Math.abs(player.body.translation().y - 0.8) < 0.02);
    assert.ok(physics.isGrounded(player.id));
    player.body.applyTorqueImpulse({ x: 10, y: 10, z: 10 }, true);
    for (const other of PLAYERS.filter(other => other.id !== player.id)) {
      const spawn = PLAYERS[player.id].spawn;
      assert.ok(Math.hypot(spawn.x - other.spawn.x, spawn.z - other.spawn.z) > 5);
    }
    for (const bumper of BUMPERS) {
      const spawn = PLAYERS[player.id].spawn;
      assert.ok(Math.hypot(spawn.x - bumper.x, spawn.z - bumper.z) > PHYSICS.radius + bumper.radius);
    }
  }
  advance(physics, 30);
  physics.players.forEach(player => assert.equal(player.body.rotation().w, 1));
}));

test("movement accelerates gradually, limits diagonal speed, and brakes", () => withWorld(physics => {
  advance(physics, 120);
  const body = physics.players[0].body;
  physics.step([{ x: 1, z: 1, jump: false }]);
  assert.ok(Math.hypot(body.linvel().x, body.linvel().z) < 0.6);
  advance(physics, 30, { x: 1, z: 1, jump: false });
  assert.ok(Math.hypot(body.linvel().x, body.linvel().z) > 4);
  assert.ok(Math.hypot(body.linvel().x, body.linvel().z) <= PHYSICS.speed + 0.01);
  advance(physics, 45);
  assert.ok(Math.hypot(body.linvel().x, body.linvel().z) < 0.1);
}));

test("grounded jump works and repeated airborne jump requests add no lift", () => withWorld(physics => {
  advance(physics, 120);
  const body = physics.players[0].body;
  physics.step([{ ...IDLE_INPUT, jump: true }]);
  assert.ok(body.linvel().y > 7);
  assert.equal(physics.isGrounded(0), false);
  const firstVelocity = body.linvel().y;
  physics.step([{ ...IDLE_INPUT, jump: true }]);
  assert.ok(body.linvel().y < firstVelocity);
  advance(physics, 120);
  assert.ok(physics.isGrounded(0));
}));

test("a bumper blocks horizontal travel", () => withWorld(physics => {
  physics.players[0].body.setTranslation({ x: 0, y: 1.6, z: 2 }, true);
  advance(physics, 120);
  advance(physics, 180, { x: 0, z: -1, jump: false });
  const position = physics.players[0].body.translation();
  assert.ok(position.z > -2.4 && position.z < -1.8);
  assert.ok(position.y > 0.7 && position.y < 0.9);
}));

test("a moving bean physically pushes an idle bean without tipping or explosive speed", () => withWorld(physics => {
  physics.players[0].body.setTranslation({ x: 0, y: 0.81, z: 2 }, true);
  physics.players[1].body.setTranslation({ x: 1.2, y: 0.81, z: 2 }, true);
  advance(physics, 20);
  const before = physics.players[1].body.translation().x;
  advance(physics, 60, { x: 1, z: 0, jump: false });
  assert.ok(physics.players[1].body.translation().x > before + 0.5);
  const separation = physics.players[1].body.translation().x - physics.players[0].body.translation().x;
  assert.ok(separation > 0.8, "capsules should not overlap");
  for (const player of physics.players) {
    assert.ok(Math.hypot(player.body.linvel().x, player.body.linvel().z) < 6);
    assert.equal(player.body.rotation().w, 1);
  }
}));

test("touching a bumper wall in midair does not grant another jump", () => withWorld(physics => {
  const body = physics.players[0].body;
  body.setTranslation({ x: -3.2, y: 1.5, z: -0.4 }, true);
  physics.world.step();
  assert.equal(physics.isGrounded(0), false);
  physics.step([{ ...IDLE_INPUT, jump: true }]);
  assert.ok(body.linvel().y < 0);
}));

test("walking off eliminates once and never respawns within the round", () => withWorld(physics => {
  advance(physics, 120);
  let fell = false;
  for (let i = 0; i < 240; i++) {
    if (physics.step([{ x: 1, z: 0, jump: false }]).includes(0)) { fell = true; break; }
  }
  assert.ok(fell);
  advance(physics, 300, { x: -1, z: 0, jump: true });
  assert.equal(physics.players[0].eliminated, true);
  assert.equal(physics.players[0].body.isEnabled(), false);
  assert.deepEqual(physics.step([]), []);
}));

test("a shared physics tick reports all simultaneous falls", () => withWorld(physics => {
  physics.players.forEach(player => player.body.setTranslation({ x: 0, y: -6, z: 0 }, true));
  assert.deepEqual(physics.step([]), [0, 1, 2]);
  assert.deepEqual(physics.step([]), []);
}));

test("countdown blocks all inputs; results freeze; reset restores every spawn and velocity", () => {
  const local = new LocalRoundSimulation(() => 0.5);
  const moving: MovementInput = { x: 1, z: 1, jump: true };
  try {
    for (let i = 0; i < ROUND.countdown / PHYSICS.step; i++) local.step(moving);
    assert.equal(local.round.phase, "playing");
    local.physics.players.forEach(player => {
      assert.ok(Math.abs(player.body.translation().x - PLAYERS[player.id].spawn.x) < 0.01);
      assert.ok(Math.abs(player.body.translation().z - PLAYERS[player.id].spawn.z) < 0.01);
      assert.ok(Math.abs(player.body.translation().y - 0.8) < 0.02);
    });
    local.physics.players.forEach(player => player.body.setTranslation({ x: 0, y: -6, z: 0 }, true));
    assert.equal(local.step(IDLE_INPUT), "finished");
    assert.equal(local.round.reason, "all-fell");
    const frozen = local.physics.players.map(player => ({ ...player.body.translation() }));
    for (let i = 0; i < 120; i++) assert.equal(local.step(moving), null);
    assert.deepEqual(local.physics.players.map(player => ({ ...player.body.translation() })), frozen);
    let reset = false;
    for (let i = 0; i < 120; i++) {
      if (local.step(moving) === "reset") { reset = true; break; }
    }
    assert.ok(reset);
    assert.equal(local.round.phase, "countdown");
    assert.deepEqual(local.round.alive, [true, true, true]);
    local.physics.players.forEach(player => {
      const { spawn } = PLAYERS[player.id];
      const position = player.body.translation();
      assert.ok(Math.hypot(position.x - spawn.x, position.y - spawn.y, position.z - spawn.z) < 0.001);
      assert.deepEqual({ ...player.body.linvel() }, { x: 0, y: 0, z: 0 });
      assert.deepEqual({ ...player.body.angvel() }, { x: 0, y: 0, z: 0 });
      assert.equal(player.eliminated, false);
      assert.ok(player.body.isEnabled());
    });
  } finally { local.dispose(); }
});

test("disposing and recreating worlds leaves independent simulations", () => {
  for (let i = 0; i < 8; i++) {
    const physics = new PlaygroundPhysics();
    advance(physics, 120);
    physics.players.forEach(player => assert.ok(physics.isGrounded(player.id)));
    physics.dispose();
    physics.dispose();
  }
});
