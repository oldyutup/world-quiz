import assert from "node:assert/strict";
import { before, test } from "node:test";
import {
  initializePhysics,
  PlaygroundPhysics,
  IDLE_INPUT,
  PHYSICS,
} from "./physics";
import { PARTS, TOTAL_MASS, SHAPES, RAGDOLL } from "./ragdoll/config";
import { restore } from "./ragdoll/character";
import { rotate, length } from "./ragdoll/math";
import { LocalRoundSimulation } from "./localRound";
import { TEST_MAP } from "../../../shared/party-lab/maps/test";
import type { ArenaMap } from "../../../shared/party-lab/maps";
before(() => initializePhysics());
const withWorld = (check: (p: PlaygroundPhysics) => void, map?: ArenaMap) => {
  const p = new PlaygroundPhysics(undefined, map);
  try {
    check(p);
  } finally {
    p.dispose();
  }
};
function advance(p: PlaygroundPhysics, n: number, input = IDLE_INPUT) {
  for (let i = 0; i < n; i++) p.step([input]);
}
test("three nine-body characters settle on articulated feet with 24 anatomical joints", () =>
  withWorld((p) => {
    advance(p, 240);
    assert.equal(p.world.bodies.len(), 27);
    assert.equal(p.world.impulseJoints.len(), 24);
    for (const c of p.players) {
      assert.ok(p.isGrounded(c.id));
      assert.ok(Math.abs(c.body.translation().y - RAGDOLL.standHeight) < 0.12);
      assert.ok(
        Math.abs(
          PARTS.reduce((sum, n) => sum + c.parts[n].body.mass(), 0) - TOTAL_MASS
        ) < 0.001
      );
      assert.equal(c.joints.filter((j) => j.spherical).length, 2);
      assert.equal(c.joints.filter((j) => !j.spherical).length, 6);
      PARTS.forEach((n) => assert.ok(c.parts[n].body.isDynamic()));
      assert.ok(rotate(c.body.rotation(), { x: 0, y: 1, z: 0 }).y > 0.9);
    }
    assert.equal(p.diagnostics.invalidBodies, 0);
  }));
test("locomotion accelerates, normalizes diagonal input and brakes without a master body", () =>
  withWorld((p) => {
    advance(p, 180);
    p.step([{ x: 1, z: 1, jump: false }]);
    assert.ok(
      Math.hypot(p.players[0].body.linvel().x, p.players[0].body.linvel().z) < 1
    );
    advance(p, 35, { x: 1, z: 1, jump: false });
    assert.ok(
      Math.hypot(p.players[0].body.linvel().x, p.players[0].body.linvel().z) >
        1.5
    );
    assert.ok(
      Math.hypot(p.players[0].body.linvel().x, p.players[0].body.linvel().z) <
        PHYSICS.speed + 0.6
    );
    advance(p, 90);
    assert.ok(
      Math.hypot(p.players[0].body.linvel().x, p.players[0].body.linvel().z) <
        0.4
    );
  }));
test("feet grant a grounded jump; repeated airborne requests add no lift", () =>
  withWorld((p) => {
    advance(p, 180);
    p.step([{ ...IDLE_INPUT, jump: true }]);
    const first = p.players[0].body.linvel().y;
    assert.ok(first > 4);
    assert.equal(p.isGrounded(0), false);
    p.step([{ ...IDLE_INPUT, jump: true }]);
    assert.ok(p.players[0].body.linvel().y < first);
    advance(p, 180);
    assert.ok(p.isGrounded(0));
  }));
test("an arm/head touching a bumper never grants an airborne jump", () =>
  withWorld((p) => {
    restore(p.players[0], { x: -3.2, y: 2, z: -0.5 }, 0);
    p.step([]);
    assert.equal(p.isGrounded(0), false);
    const v = p.players[0].body.linvel().y;
    p.step([{ ...IDLE_INPUT, jump: true }]);
    assert.ok(p.players[0].body.linvel().y < v + 0.2);
  }, TEST_MAP));
test("a bumper obstructs normal walking", () =>
  withWorld((p) => {
    restore(p.players[0], { x: 3.2, y: 1, z: 1 }, Math.PI);
    advance(p, 180);
    advance(p, 100, { x: 0, z: -1, jump: false });
    assert.ok(p.players[0].body.translation().z > -1.1);
    assert.equal(p.players[0].eliminated, false);
  }, TEST_MAP));
test("characters physically push and torque can topple an unlocked body", () =>
  withWorld((p) => {
    restore(p.players[0], { x: 0, y: 1, z: 1 }, Math.PI / 2);
    restore(p.players[1], { x: 1.1, y: 1, z: 1 }, 0);
    advance(p, 180);
    const before = p.players[1].body.translation().x;
    advance(p, 55, { x: 1, z: 0, jump: false });
    assert.ok(p.players[1].body.translation().x > before + 0.15);
    p.players[1].parts.torso.body.applyTorqueImpulse(
      { x: 0.6, y: 0, z: 0 },
      true
    );
    advance(p, 3);
    assert.ok(Math.abs(p.players[1].parts.torso.body.rotation().x) > 0.05);
    assert.equal(p.diagnostics.invalidBodies, 0);
  }));
test("walking off eliminates the entire articulated character exactly once", () =>
  withWorld((p) => {
    advance(p, 180);
    let fell = false;
    for (let i = 0; i < 400; i++)
      if (p.step([{ x: 1, z: 0, jump: false }]).includes(0)) {
        fell = true;
        break;
      }
    assert.ok(fell);
    PARTS.forEach((n) =>
      assert.equal(p.players[0].parts[n].body.isEnabled(), false)
    );
    advance(p, 200, { x: -1, z: 0, jump: true });
    assert.equal(p.players[0].eliminated, true);
  }));
test("simultaneous falls are reported together; invalid transforms are quarantined", () =>
  withWorld((p) => {
    for (const c of p.players) restore(c, { x: c.id * 2, y: -6, z: 0 }, 0);
    assert.deepEqual(p.step([]), [0, 1, 2]);
    assert.deepEqual(p.step([]), []);
    p.reset();
    p.players[0].parts.head.body.setTranslation({ x: NaN, y: 0, z: 0 }, true);
    assert.deepEqual(p.step([]), [0]);
    assert.equal(p.diagnostics.invalidBodies, 1);
    for (const c of p.players)
      for (const n of PARTS)
        assert.ok(Number.isFinite(c.parts[n].body.translation().x));
  }));
test("countdown/results preserve round behavior; reset restores every part and recreates every joint", () => {
  const s = new LocalRoundSimulation(() => 0.5);
  try {
    for (let i = 0; i < 180; i++)
      s.step({ x: 1, z: 1, jump: true, left: true, punchRight: true });
    assert.equal(s.round.phase, "playing");
    assert.equal(s.combat.stats.punches, 0);
    const oldJoints = s.physics.players.flatMap((c) =>
      c.joints.map((j) => j.joint)
    );
    for (const c of s.physics.players)
      restore(c, { x: c.id * 2, y: -6, z: 0 }, 0);
    assert.equal(s.step(IDLE_INPUT), "finished");
    const frozen = s.physics.players.map((c) => ({ ...c.body.translation() }));
    for (let i = 0; i < 100; i++) s.step(IDLE_INPUT);
    assert.deepEqual(
      s.physics.players.map((c) => ({ ...c.body.translation() })),
      frozen
    );
    for (let i = 0; i < 200; i++) if (s.step(IDLE_INPUT) === "reset") break;
    assert.equal(s.round.phase, "countdown");
    assert.equal(s.physics.world.impulseJoints.len(), 24);
    oldJoints.forEach((j) => assert.equal(j.isValid(), false));
    for (const c of s.physics.players)
      for (const n of PARTS) {
        const body = c.parts[n].body;
        assert.equal(length(body.linvel()), 0);
        assert.equal(length(body.angvel()), 0);
        assert.equal(c.eliminated, false);
        assert.ok(body.isEnabled());
        assert.ok(
          Math.abs(body.translation().y - s.map.spawns[c.id].y - SHAPES[n].y) <
            0.001
        );
      }
  } finally {
    s.dispose();
  }
});
test("repeated create/dispose keeps worlds independent", () => {
  for (let i = 0; i < 6; i++)
    withWorld((p) => {
      advance(p, 180);
      assert.ok(p.isGrounded(0));
      p.dispose();
    });
});
