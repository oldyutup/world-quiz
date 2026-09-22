import assert from "node:assert/strict";
import { test } from "node:test";
import { initializePhysics, PHYSICS } from "./physics";
import { LocalRoundSimulation } from "./localRound";
import { PARTS, HANDS, RAGDOLL } from "./ragdoll/config";
import { length, finite } from "./ragdoll/math";
import type { MovementInput } from "../input/types";
test("twelve local ragdoll rounds remain finite, resolve/reset, and exercise combat and both-hand grips", async () => {
  await initializePhysics();
  let seed = 531;
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const s = new LocalRoundSimulation(random);
  let rounds = 0,
    actionIn = 0,
    holdFor = 0,
    hand = 0,
    steps = 0;
  const states = new Set<string>(),
    winners: (number | null)[] = [];
  const started = performance.now();
  try {
    for (; steps < 60000 && rounds < 12; steps++) {
      const human = s.physics.players[0],
        pos = human.body.translation();
      const i: MovementInput = { x: 0, z: 0, jump: false };
      if (s.round.phase === "playing" && !human.eliminated) {
        const target = s.physics.players
          .filter((p) => p.id !== 0 && !p.eliminated)
          .sort(
            (a, b) =>
              Math.hypot(
                a.body.translation().x - pos.x,
                a.body.translation().z - pos.z
              ) -
              Math.hypot(
                b.body.translation().x - pos.x,
                b.body.translation().z - pos.z
              )
          )[0];
        if (target) {
          const t = target.body.translation();
          let x = t.x - pos.x,
            z = t.z - pos.z;
          const owner = s.combat.grips.hands.findIndex((h) =>
            h.some((g) => g?.target === 0)
          );
          if (owner >= 0) {
            const p = s.physics.players[owner].body.translation();
            x = pos.x - p.x;
            z = pos.z - p.z;
          }
          if (s.combat.grips.count(0)) {
            if (7 - Math.abs(pos.x) < 6 - Math.abs(pos.z)) {
              x = Math.sign(pos.x) || 1;
              z = 0;
            } else {
              x = 0;
              z = Math.sign(pos.z) || 1;
            }
            i.lift = true;
            if (Math.abs(pos.x) > 6 || Math.abs(pos.z) > 5) holdFor = 0;
          }
          const norm = Math.max(1, Math.hypot(x, z));
          i.x = x / norm;
          i.z = z / norm;
          actionIn -= PHYSICS.step;
          holdFor -= PHYSICS.step;
          if (actionIn <= 0) {
            actionIn = 0.5 + random() * 0.4;
            hand = 1 - hand;
            if (hand === 0) i.punchLeft = true;
            else i.punchRight = true;
            if (random() < 0.28) holdFor = 2.5;
            i.jump = owner >= 0 && random() < 0.5;
          }
          i.left = i.right = holdFor > 0;
        }
      }
      const event = s.step(i);
      for (const p of s.physics.players) {
        states.add(s.combat.players[p.id].condition.state);
        for (const name of PARTS) {
          const body = p.parts[name].body,
            q = body.rotation();
          assert.ok(
            finite(body.translation()) &&
              finite(body.linvel()) &&
              finite(q) &&
              Number.isFinite(q.w)
          );
          assert.ok(length(body.linvel()) <= RAGDOLL.maxSpeed + 0.01);
          assert.ok(length(body.angvel()) <= RAGDOLL.maxAngularSpeed + 0.01);
        }
        for (const hand of HANDS) {
          const grip = s.combat.grips.hands[p.id][hand];
          if (grip) {
            assert.ok(
              !p.eliminated && !s.physics.players[grip.target].eliminated
            );
            assert.ok(
              s.combat.grips.incoming[grip.target].has(`${p.id}:${hand}`)
            );
          }
        }
      }
      assert.equal(s.physics.world.bodies.len(), 27);
      assert.equal(s.physics.world.impulseJoints.len(), 24);
      if (event === "finished") {
        winners.push(s.round.winner);
        assert.ok(
          s.combat.grips.hands.every((h) => h.every((g) => g === null))
        );
      }
      if (event === "reset") {
        rounds++;
        s.combat.players.forEach((p) => assert.equal(p.condition.meter, 0));
      }
    }
    assert.equal(rounds, 12);
    assert.equal(s.physics.diagnostics.invalidBodies, 0);
    assert.ok(
      s.physics.diagnostics.maxSpeed < 30 &&
        s.physics.diagnostics.maxAngularSpeed < 35
    );
    assert.ok(
      s.combat.stats.hits > 0 &&
        s.combat.stats.headHits > 0 &&
        s.combat.stats.knockouts > 0
    );
    assert.ok(
      s.combat.grips.stats.twoHands > 0 && s.combat.grips.stats.releases > 0
    );
    assert.ok(states.has("KNOCKED_OUT") && states.has("RECOVERING"));
    console.log(
      JSON.stringify({
        rounds,
        steps,
        meanStepMs: (performance.now() - started) / steps,
        combat: s.combat.stats,
        grips: s.combat.grips.stats,
        safety: s.physics.diagnostics,
        winners,
        states: [...states],
      })
    );
  } finally {
    s.dispose();
  }
});
