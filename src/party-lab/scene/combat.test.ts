import assert from "node:assert/strict";
import { before, test } from "node:test";
import {
  initializePhysics,
  PlaygroundPhysics,
  PHYSICS,
  IDLE_INPUT,
} from "./physics";
import { CombatSimulation } from "./combat";
import { COMBAT } from "./combatConfig";
import {
  createKnockout,
  impact,
  impactWeight,
  tickKnockout,
  resetKnockout,
  resistance,
  controlStrength,
} from "./combat/knockout";
import { liftQuality } from "./combat/lift";
import { newPunch, startPunch, tickPunch, punchPower } from "./combat/punch";
import { restore } from "./ragdoll/character";
import { handPoint } from "./ragdoll/controller";
import { PARTS, HANDS, HAND_PARTS, RAGDOLL } from "./ragdoll/config";
import { length, rotate } from "./ragdoll/math";
import type { MovementInput } from "../input/types";
before(() => initializePhysics());
function fixture(
  check: (p: PlaygroundPhysics, c: CombatSimulation) => void,
  base = 1
) {
  const p = new PlaygroundPhysics(),
    c = new CombatSimulation(p);
  try {
    restore(p.players[0], { x: 0, y: 1, z: base }, 0);
    restore(p.players[1], { x: 0, y: 1, z: base + 0.85 }, 0);
    for (let f = 0; f < 180; f++) p.step([]);
    check(p, c);
  } finally {
    p.dispose();
  }
}
function step(
  p: PlaygroundPhysics,
  c: CombatSimulation,
  inputs: MovementInput[] = [],
  n = 1
) {
  for (let f = 0; f < n; f++) {
    p.step(inputs, c.step(inputs, PHYSICS.step, "playing"));
    c.afterStep();
  }
}
const hold = (both = true): MovementInput => ({
  ...IDLE_INPUT,
  left: true,
  right: both,
});
test("clean head/body hits reach KO in two/three hits; limb/glancing contacts weigh less", () => {
  for (const [part, hits] of [
    ["head", 2],
    ["torso", 3],
  ] as const) {
    const s = createKnockout();
    for (let n = 0; n < hits - 1; n++)
      assert.equal(impact(s, impactWeight(part, 1)), false);
    assert.equal(impact(s, impactWeight(part, 1)), true);
    assert.equal(s.state, "KNOCKED_OUT");
  }
  assert.ok(punchPower("head", 3.2, 1) > punchPower("torso", 3.2, 1));
  assert.ok(punchPower("torso", 3.2, 1) > punchPower("leftLeg", 3.2, 1));
  assert.equal(punchPower("head", 0.2, 1), 0);
  assert.ok(punchPower("head", 1, 0.3) < 15);
});
test("KO duration is bounded, recovery ramps control, immunity prevents chains and reset clears state", () => {
  const s = createKnockout();
  impact(s, 100);
  assert.equal(controlStrength(s), 0);
  for (let f = 0; f < 157; f++) {
    impact(s, 58);
    tickKnockout(s, 1 / 60);
  }
  assert.equal(s.state, "RECOVERING");
  assert.ok(controlStrength(s) > 0 && controlStrength(s) < 0.3);
  assert.ok(resistance(s) > COMBAT.grip.koResistance);
  tickKnockout(s, 2);
  assert.equal(s.state, "CONSCIOUS");
  assert.equal(s.immunity, COMBAT.knockout.immunity);
  assert.equal(impact(s, 100), false);
  tickKnockout(s, 2);
  assert.equal(impact(s, 100), true);
  resetKnockout(s);
  assert.deepEqual(s, createKnockout());
});
test("impact meter decays after quiet time; daze reduces balance and resistance", () => {
  const s = createKnockout();
  impact(s, 58);
  assert.equal(s.state, "DAZED");
  assert.ok(controlStrength(s) < 1 && resistance(s) < 1);
  tickKnockout(s, 0.5);
  assert.equal(s.meter, 58);
  tickKnockout(s, 3);
  assert.ok(s.meter < 42);
  assert.equal(s.state, "CONSCIOUS");
});
test("independent punches respect hand cooldown and cannot hit outside actual contact", () =>
  fixture((p, c) => {
    const punch = newPunch();
    assert.ok(startPunch(punch));
    assert.equal(startPunch(punch), false);
    tickPunch(punch, 1);
    assert.ok(startPunch(punch));
    restore(p.players[1], { x: 0, y: 1, z: 4 }, 0);
    const before = handPoint(p.players[0], 0);
    step(p, c, [{ ...IDLE_INPUT, punchLeft: true }], 1);
    step(p, c, [], 18);
    const after = handPoint(p.players[0], 0);
    assert.ok(
      after.z > before.z + 0.2 || after.y > before.y + 0.2,
      "physical arm moves"
    );
    assert.equal(c.stats.hits, 0);
    assert.equal(c.players[0].punches[1].cooldown, 0);
    step(p, c, [{ ...IDLE_INPUT, punchLeft: true }], 1);
    assert.equal(c.stats.punches, 1);
  }));
test("physical punch contacts contribute stun and move the target", () =>
  fixture((p, c) => {
    const start = { ...p.players[1].body.translation() };
    step(p, c, [{ ...IDLE_INPUT, punchLeft: true }], 1);
    step(p, c, [], 35);
    assert.ok(c.stats.hits > 0);
    assert.ok(c.players[1].condition.meter > 0);
    const end = p.players[1].body.translation();
    assert.ok(
      Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z) > 0.05
    );
  }));
test("countdown/results disable all combat", () =>
  fixture((_p, c) => {
    for (const phase of ["countdown", "results"] as const)
      c.step([{ ...hold(), punchLeft: true, lift: true }], 1, phase);
    assert.equal(c.stats.punches, 0);
    assert.equal(c.grips.count(0), 0);
  }));
test("KO physically collapses; recovery stands through forces without snapping", () =>
  fixture((p, c) => {
    impact(c.players[0].condition, 100);
    p.players[0].parts.torso.body.applyImpulse({ x: 1, y: 0, z: 0 }, true);
    const top = p.players[0].parts.head.body.translation().y;
    step(p, c, [], 100);
    assert.equal(c.players[0].condition.state, "KNOCKED_OUT");
    assert.ok(p.players[0].parts.head.body.translation().y < top - 0.45);
    assert.equal(c.drives[0].posture, 0);
    assert.equal(c.drives[0].jump, false);
    let maxFrameRise = 0;
    for (let f = 0; f < 360; f++) {
      const y = p.players[0].body.translation().y;
      step(p, c);
      maxFrameRise = Math.max(
        maxFrameRise,
        p.players[0].body.translation().y - y
      );
    }
    assert.equal(c.players[0].condition.state, "CONSCIOUS");
    assert.ok(p.players[0].body.translation().y > 0.6);
    assert.ok(
      rotate(p.players[0].body.rotation(), { x: 0, y: 1, z: 0 }).y > 0.8
    );
    assert.ok(maxFrameRise < 0.25, "stand-up is gradual");
    assert.equal(p.diagnostics.invalidBodies, 0);
  }));
test("left/right grips are independent; both can hold the same opponent and release independently", () =>
  fixture((p, c) => {
    step(p, c, [hold()], 65);
    assert.equal(c.grips.count(0, 1), 2);
    assert.equal(c.grips.incoming[1].size, 2);
    c.grips.release(0, 0);
    assert.equal(c.grips.count(0, 1), 1);
    assert.equal(c.grips.incoming[1].size, 1);
    c.grips.release(0, 1);
    assert.equal(c.grips.incoming[1].size, 0);
  }));
test("self, invalid, distant and recursive grips are rejected", () =>
  fixture((p, c) => {
    assert.equal(c.grips.acquire(0, 0, 0, "torso"), null);
    assert.equal(c.grips.acquire(0, 0, 2, "torso"), null);
    assert.equal(c.grips.acquire(0, 0, 1, "not-a-part" as "torso"), null);
    assert.equal(c.grips.acquire(0, 0, 99 as 1, "torso"), null);
    step(p, c, [hold()], 65);
    assert.ok(c.grips.count(0) > 0);
    assert.equal(c.grips.validTarget(1, 0), false);
    c.grips.clear();
    impact(c.players[0].condition, 100);
    assert.equal(c.grips.acquire(0, 0, 1, "torso"), null);
  }));
test("overload/distance breaks bounded point holds and clears reverse references", () =>
  fixture((p, c) => {
    step(p, c, [hold()], 65);
    assert.ok(c.grips.count(0) > 0);
    for (let f = 0; f < 20; f++) {
      for (const h of HANDS) {
        const g = c.grips.hands[0][h];
        if (g) {
          p.players[g.target].parts[g.part].body.setLinvel(
            { x: 30, y: 0, z: 0 },
            true
          );
          p.players[g.target].parts[g.part].body.setAngvel(
            { x: 0, y: 0, z: 0 },
            true
          );
          p.players[0].parts[HAND_PARTS[h]].body.setLinvel(
            { x: 0, y: 0, z: 0 },
            true
          );
          p.players[0].parts[HAND_PARTS[h]].body.setAngvel(
            { x: 0, y: 0, z: 0 },
            true
          );
        }
      }
      c.grips.update([hold()], 1 / 60);
    }
    assert.ok(c.grips.stats.overloads > 0);
    assert.equal(c.grips.count(0), 0);
    c.grips.clear();
    assert.equal(c.grips.incoming[1].size, 0);
  }));
test("conscious effort stresses one-hand grips faster than two hands or knockout", () =>
  fixture((p, c) => {
    step(p, c, [hold()], 65);
    const g = c.grips.hands[0][0];
    assert.ok(g);
    c.grips.release(0, 1);
    const input = [hold(false), { x: 0, z: 1, jump: false }];
    const before = g.fatigue;
    for (let f = 0; f < 30 && c.grips.hands[0][0]; f++)
      c.grips.update(input, 1 / 60);
    assert.ok(g.fatigue > before + 0.15);
    const healthy = resistance(c.players[1].condition);
    impact(c.players[1].condition, 100);
    assert.ok(resistance(c.players[1].condition) < healthy * 0.05);
  }));
test("grabbed conscious players retain a free-hand punch and normal movement input", () =>
  fixture((p, c) => {
    step(p, c, [hold()], 65);
    assert.ok(c.grips.incoming[1].size);
    const before = c.stats.punches;
    step(p, c, [hold(), { x: 0, z: -1, jump: false, punchLeft: true }], 1);
    assert.ok(c.stats.punches > before);
    assert.ok(c.drives[1].mobility > 0);
  }));
test("lift requires grips; two hands and KO increase strength; conscious resistance reduces it", () => {
  assert.equal(liftQuality(0, "KNOCKED_OUT", 0, 1), 0);
  assert.equal(liftQuality(2, "KNOCKED_OUT", 0, 3), 0);
  assert.ok(
    liftQuality(2, "KNOCKED_OUT", 0, 1) >
      liftQuality(1, "KNOCKED_OUT", 0, 1) * 2
  );
  assert.ok(
    liftQuality(2, "KNOCKED_OUT", 0, 1) > liftQuality(2, "CONSCIOUS", 1, 1) * 10
  );
  assert.ok(liftQuality(2, "KNOCKED_OUT", 0, 1) <= 1);
});
test("collapsed target can be grabbed, lifted, carried and released with bounded retained momentum", () =>
  fixture((p, c) => {
    impact(c.players[1].condition, 100);
    p.players[1].parts.torso.body.applyImpulse({ x: 0, y: 0, z: 0.8 }, true);
    let low = Infinity,
      peak = 0,
      carried = 0,
      holdSeen = false;
    for (let f = 0; f < 145; f++) {
      const input = {
        ...IDLE_INPUT,
        left: f >= 35 && f < 115,
        right: f >= 35 && f < 115,
        lift: f >= 75,
        z: f >= 95 ? 1 : 0,
      };
      step(p, c, [input]);
      if (f < 75) low = Math.min(low, p.players[1].body.translation().y);
      if (f >= 75 && f < 115) {
        peak = Math.max(peak, p.players[1].body.translation().y);
        holdSeen ||= c.grips.count(0, 1) === 2;
      }
      if (f === 95) carried = p.players[1].body.translation().z;
      if (f === 115) {
        assert.equal(c.grips.count(0), 0);
        assert.ok(length(p.players[1].body.linvel()) > 0.3);
      }
      for (const part of PARTS)
        assert.ok(
          length(p.players[1].parts[part].body.linvel()) <=
            RAGDOLL.maxSpeed + 0.01
        );
    }
    assert.ok(holdSeen);
    assert.ok(peak > low + 0.25);
    assert.ok(p.players[1].body.translation().z > carried + 0.5);
    assert.ok(c.stats.lifts > 0);
    assert.equal(p.diagnostics.invalidBodies, 0);
  }));
test("an edge carry/release can eliminate a target without leaving a constraint", () =>
  fixture((p, c) => {
    impact(c.players[1].condition, 100);
    p.players[1].parts.torso.body.applyImpulse({ x: 0, y: 0, z: 0.8 }, true);
    for (let f = 0; f < 330; f++)
      step(p, c, [
        {
          ...IDLE_INPUT,
          left: f >= 35 && f < 130,
          right: f >= 35 && f < 130,
          lift: f >= 75,
          z: f >= 90 && f < 135 ? 1 : 0,
        },
      ]);
    assert.ok(p.players[1].eliminated);
    assert.equal(c.grips.incoming[1].size, 0);
    assert.equal(c.grips.count(0), 0);
    assert.equal(p.diagnostics.invalidBodies, 0);
  }, 3));
test("two physical hand grips lift a fallen KO target higher than one", () => {
  const peaks: number[] = [];
  for (const both of [false, true])
    fixture((p, c) => {
      impact(c.players[1].condition, 100);
      p.players[1].parts.torso.body.applyImpulse({ x: 0, y: 0, z: 0.8 }, true);
      let peak = 0;
      for (let f = 0; f < 115; f++) {
        step(p, c, [
          {
            ...IDLE_INPUT,
            left: f >= 35,
            right: both && f >= 35,
            lift: f >= 75,
          },
        ]);
        if (f >= 75) peak = Math.max(peak, p.players[1].body.translation().y);
      }
      peaks.push(peak);
    });
  assert.ok(peaks[1] > peaks[0] + 0.15, JSON.stringify(peaks));
});
test("elimination and reset clear both hands, KO, cooldowns and all reverse references", () =>
  fixture((p, c) => {
    step(p, c, [hold()], 65);
    assert.ok(c.grips.count(0) > 0);
    p.players[1].eliminated = true;
    c.cleanupEliminations();
    assert.equal(c.grips.count(0), 0);
    impact(c.players[0].condition, 100);
    c.players[0].punches[0].cooldown = 1;
    c.reset();
    p.reset();
    assert.equal(p.world.impulseJoints.len(), 24);
    for (const player of c.players) {
      assert.deepEqual(player.condition, createKnockout());
      assert.equal(player.punches[0].cooldown, 0);
      assert.equal(c.grips.incoming[player.id].size, 0);
    }
  }));

test("abstract Punch alternates accepted physical swings left/right; cooldown rejection does not skip a hand", () => fixture((_p, c) => {
  const punch = { ...IDLE_INPUT, punch: true };
  for (const hand of [0, 1, 0, 1]) {
    const before = c.stats.punches;
    c.step([punch], PHYSICS.step, "playing");
    assert.equal(c.stats.punches, before + 1);
    assert.equal(c.players[0].punches[hand].age, 0);
    const next = c.players[0].nextPunchHand;
    c.step([punch], PHYSICS.step, "playing");
    assert.equal(c.stats.punches, before + 1);
    assert.equal(c.players[0].nextPunchHand, next);
    for (let i = 0; i < 60; i++) c.step([], PHYSICS.step, "playing");
  }
  c.reset(); assert.equal(c.players[0].nextPunchHand, 0);
}));
test("abstract Grab acquires one then two physical hands on the same opponent and releases both", () => fixture((p, c) => {
  let one = false, two = false;
  const grab = { ...IDLE_INPUT, grab: true };
  for (let i = 0; i < 140; i++) {
    step(p, c, [grab]);
    const grips = c.grips.hands[0].filter(g => g !== null);
    one ||= grips.length === 1;
    two ||= grips.length === 2;
    assert.ok(grips.every(g => g.target === 1));
    if (two) break;
  }
  assert.ok(one, "a real one-hand hold exists before second-hand acquisition");
  assert.ok(two, "second physical hand joins when it can reach");
  const velocity = { ...p.players[1].body.linvel() };
  c.step([{ ...grab, grab: false }], PHYSICS.step, "playing");
  assert.equal(c.grips.count(0), 0); assert.equal(c.grips.incoming[1].size, 0);
  assert.deepEqual({ ...p.players[1].body.linvel() }, velocity, "release preserves momentum");
}));
test("automatic second reach cannot select a different player, and a free hand can punch while holding", () => fixture((p, c) => {
  step(p, c, [hold()], 65);
  assert.equal(c.grips.count(0, 1), 2);
  c.grips.release(0, 1);
  // Move third character to the free hand; filtered human reach must still seek player 1.
  const palm = handPoint(p.players[0], 1);
  restore(p.players[2], { x: palm.x, y: 1, z: palm.z }, 0);
  p.world.step();
  const reach = c.grips.reach(0, 1, 1);
  assert.ok(!reach || reach.target === 1);
  const before = c.stats.punches;
  c.step([{ ...IDLE_INPUT, grab: true, punch: true, x: 1, jump: true }], PHYSICS.step, "playing");
  assert.equal(c.stats.punches, before + 1);
  assert.equal(c.players[0].punches[1].age, 0, "occupied left hand redirects to free right");
  assert.ok(c.drives[0].mobility > 0 && c.drives[0].jump);
  assert.ok(c.grips.hands[0].every(g => !g || g.target === 1));
}));
test("a grabbed human retains abstract Punch, movement and supported jump", () => fixture((p, c) => {
  step(p, c, [hold()], 65);
  assert.ok(c.grips.incoming[1].size);
  const before = c.stats.punches;
  c.step([hold(), { ...IDLE_INPUT, punch: true, x: 1, jump: true }], PHYSICS.step, "playing");
  assert.equal(c.stats.punches, before + 1);
  assert.ok(c.drives[1].mobility > 0 && c.drives[1].jump);
}));
