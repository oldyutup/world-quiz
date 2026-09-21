// Run locally with: node --import tsx --test src/party-lab/scene/physics.test.ts
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { initializePhysics, PHYSICS, PlaygroundPhysics, SPAWN } from "./physics";
import type { MovementInput } from "../input/keyboard";

const IDLE: MovementInput = { x: 0, z: 0, jump: false };
before(() => initializePhysics());

function withWorld(check: (physics: PlaygroundPhysics) => void) {
  const physics = new PlaygroundPhysics();
  try { check(physics); } finally { physics.dispose(); }
}

function advance(physics: PlaygroundPhysics, steps: number, input = IDLE) {
  for (let i = 0; i < steps; i++) physics.step(input);
}

test("gravity settles the capsule on the platform without tipping", () => withWorld(physics => {
  advance(physics, 120);
  assert.ok(Math.abs(physics.player.translation().y - 0.8) < 0.02);
  assert.ok(physics.isGrounded());
  physics.player.applyTorqueImpulse({ x: 10, y: 10, z: 10 }, true);
  advance(physics, 30);
  assert.equal(physics.player.rotation().w, 1);
}));

test("movement accelerates gradually, limits diagonal speed, and brakes", () => withWorld(physics => {
  advance(physics, 120);
  physics.step({ x: 1, z: 1, jump: false });
  assert.ok(Math.hypot(physics.player.linvel().x, physics.player.linvel().z) < 0.6);
  advance(physics, 30, { x: 1, z: 1, jump: false });
  const velocity = physics.player.linvel();
  assert.ok(Math.hypot(velocity.x, velocity.z) > 4);
  assert.ok(Math.hypot(velocity.x, velocity.z) <= PHYSICS.speed + 0.01);
  advance(physics, 45);
  assert.ok(Math.hypot(physics.player.linvel().x, physics.player.linvel().z) < 0.1);
}));

test("jump leaves the ground; repeated airborne jump requests add no lift", () => withWorld(physics => {
  advance(physics, 120);
  physics.step({ ...IDLE, jump: true });
  assert.ok(physics.player.linvel().y > 7);
  assert.equal(physics.isGrounded(), false);
  const firstVelocity = physics.player.linvel().y;
  physics.step({ ...IDLE, jump: true });
  assert.ok(physics.player.linvel().y < firstVelocity);
  advance(physics, 120);
  assert.ok(physics.isGrounded());
}));

test("a bumper blocks horizontal travel rather than allowing penetration", () => withWorld(physics => {
  advance(physics, 120);
  // Approach the low central bumper head-on from the initial spawn lane.
  advance(physics, 180, { x: 0, z: -1, jump: false });
  const position = physics.player.translation();
  assert.ok(position.z > -2.4 && position.z < -1.8, `unexpected stopping point ${position.z}`);
  assert.ok(position.y > 0.7 && position.y < 0.9);
  assert.equal(physics.fallen, false);
}));

test("touching a bumper wall in midair does not grant another jump", () => withWorld(physics => {
  physics.player.setTranslation({ x: -3.2, y: 1.5, z: -0.4 }, true);
  physics.world.step();
  assert.equal(physics.isGrounded(), false);
  physics.step({ ...IDLE, jump: true });
  assert.ok(physics.player.linvel().y < 0);
}));

test("fall triggers once, waits, then respawns with cleared velocity", () => withWorld(physics => {
  advance(physics, 120);
  let fell = false;
  for (let i = 0; i < 240; i++) {
    if (physics.step({ x: 1, z: 0, jump: false }) === "fell") { fell = true; break; }
  }
  assert.ok(fell, "walking past the unguarded platform edge must fall");
  assert.equal(physics.fallen, true);
  for (let i = 0; i < 60; i++) assert.equal(physics.step(IDLE), null);
  assert.equal(physics.fallen, true);
  let respawned = false;
  for (let i = 0; i < 30; i++) {
    if (physics.step(IDLE) === "respawned") { respawned = true; break; }
  }
  assert.ok(respawned);
  assert.equal(physics.fallen, false);
  assert.ok(Math.abs(physics.player.translation().y - SPAWN.y) < 0.001);
  assert.equal(physics.player.translation().x, SPAWN.x);
  assert.equal(physics.player.linvel().x, 0);
  assert.equal(physics.player.linvel().y, 0);
  advance(physics, 120);
  assert.ok(physics.isGrounded());
}));

test("disposing and recreating worlds leaves fresh, independent simulations", () => {
  for (let i = 0; i < 8; i++) {
    const physics = new PlaygroundPhysics();
    advance(physics, 120);
    assert.ok(physics.isGrounded());
    physics.dispose();
    physics.dispose();
  }
});
