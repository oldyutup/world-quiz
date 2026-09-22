import assert from "node:assert/strict";
import { before, test } from "node:test";
import { OnlineRoundSimulation } from "../../../shared/party-lab/simulation/onlineRound.js";
import {
  initializePhysics,
  IDLE_INPUT,
  PHYSICS,
} from "../../../shared/party-lab/simulation/physics.js";
import {
  PARTS,
  RAGDOLL,
} from "../../../shared/party-lab/simulation/ragdoll/config.js";
import { restore } from "../../../shared/party-lab/simulation/ragdoll/character.js";
import { impact } from "../../../shared/party-lab/simulation/combat/knockout.js";
import { allowedOrigin, invalidAllowlistEntries } from "../src/origin.js";
import type { GameEvent } from "../../../shared/party-lab/network/protocol.js";
import { capturePredictionState } from "../../../shared/party-lab/simulation/predictionState.js";
before(() => initializePhysics());
test("online allocates articulated rigs, enables only real slots, countdown blocks intent, reset clears every body and grip", () => {
  const s = new OnlineRoundSimulation();
  try {
    assert.equal(s.physics.world.bodies.len(), 27);
    assert.equal(s.physics.world.impulseJoints.len(), 24);
    assert.ok(s.start([0, 2]));
    assert.equal(s.physics.players[1].eliminated, true);
    const events: GameEvent[] = [];
    for (let i = 0; i < 180; i++)
      events.push(
        ...s.step([
          { ...IDLE_INPUT, jump: true, punch: true, grab: true, lift: true },
        ])
      );
    assert.equal(s.phase, "playing");
    assert.equal(s.combat.stats.punches, 0);
    assert.equal(s.combat.grips.count(0), 0);
    assert.deepEqual(
      events.filter((e) => e.name === "countdown").map((e) => e.step),
      [3, 2, 1]
    );
    for (const p of s.physics.players.filter((p) => p.id !== 1))
      restore(p, { x: p.id * 2, y: -6, z: 0 }, 0);
    events.push(...s.step([]));
    assert.equal(s.round.winner, null);
    assert.equal(s.phase, "results");
    assert.equal(events.filter((e) => e.name === "fall").length, 2);
    for (let i = 0; i < 220; i++) events.push(...s.step([]));
    assert.equal(s.phase, "waiting");
    assert.equal(events.filter((e) => e.name === "fall").length, 2);
    assert.ok(s.start([0, 1, 2]));
    for (const p of s.physics.players)
      for (const name of PARTS) {
        const part = p.parts[name];
        assert.deepEqual({ ...part.body.linvel() }, { x: 0, y: 0, z: 0 });
        assert.deepEqual({ ...part.body.angvel() }, { x: 0, y: 0, z: 0 });
        assert.ok(Number.isFinite(part.body.rotation().w));
      }
    assert.ok(s.combat.grips.hands.flat().every((g) => g === null));
    assert.ok(
      s.combat.players.every(
        (p) =>
          p.condition.state === "CONSCIOUS" &&
          p.condition.meter === 0 &&
          p.punches.every((h) => h.age < 0)
      )
    );
    for (let i = 0; i < 180; i++) events.push(...s.step([]));
    restore(s.physics.players[0], { x: 0, y: -6, z: 0 }, 0);
    events.push(...s.step([]));
    assert.equal(
      events.filter((e) => e.name === "fall" && e.actor === 0).length,
      2
    );
    assert.equal(new Set(events.map((e) => e.id)).size, events.length);
  } finally {
    s.dispose();
  }
});
test("server shared combat confirms physical hit/KO/recovery and automatic grips, lift, throw and neutralization", () => {
  const s = new OnlineRoundSimulation();
  try {
    s.start([0, 1, 2]);
    for (let i = 0; i < 180; i++) s.step([]);
    restore(s.physics.players[0], { x: 0, y: 1, z: 1 }, 0);
    restore(s.physics.players[1], { x: 0, y: 1, z: 1.85 }, 0);
    for (let i = 0; i < 180; i++) s.step([]);
    s.combat.players[1].condition.meter = 99;
    const events: GameEvent[] = [];
    events.push(...s.step([{ ...IDLE_INPUT, punch: true }]));
    for (let i = 0; i < 35; i++) events.push(...s.step([]));
    assert.ok(
      events.some((e) => ["headHit", "bodyHit", "limbHit"].includes(e.name))
    );
    assert.ok(events.some((e) => e.name === "knockout"));
    assert.equal(
      events.some((e) => e.name === "fall"),
      false
    );
    for (let i = 0; i < 240; i++) events.push(...s.step([]));
    assert.equal(events.filter((e) => e.name === "recovery").length, 1);
    s.combat.reset();
    s.physics.reset();
    restore(s.physics.players[0], { x: 0, y: 1, z: 1 }, 0);
    restore(s.physics.players[1], { x: 0, y: 1, z: 1.85 }, 0);
    for (let i = 0; i < 180; i++) s.step([]);
    for (let i = 0; i < 65; i++) s.step([{ ...IDLE_INPUT, grab: true }]);
    assert.equal(s.combat.grips.count(0), 2);
    assert.ok(s.combat.grips.hands[0].every((g) => g?.target === 1));
    impact(s.combat.players[1].condition, 100);
    assert.ok(
      s
        .step([{ ...IDLE_INPUT, grab: true, lift: true }])
        .some((e) => e.name === "lift")
    );
    s.physics.players[1].parts.torso.body.setLinvel({ x: 7, y: 0, z: 0 }, true);
    assert.ok(s.step([]).some((e) => e.name === "throw"));
    assert.equal(s.combat.grips.count(0), 0);
    s.neutralize(0);
    assert.ok(s.combat.players[0].punches.every((p) => p.age < 0));
    for (const p of s.physics.players)
      for (const name of PARTS) {
        const v = p.parts[name].body.linvel();
        assert.ok(Math.hypot(v.x, v.y, v.z) <= RAGDOLL.maxSpeed + 0.001);
      }
  } finally {
    s.dispose();
  }
});
test("three-player authoritative simulation benchmark and snapshot encoding stay finite", () => {
  const s = new OnlineRoundSimulation();
  s.start([0, 1, 2]);
  const began = performance.now();
  let snapshots = 0,
    serialize = 0,
    eventCount = 0,
    bytes = 0;
  try {
    for (let i = 0; i < 1800; i++) {
      const input = [0, 1, 2].map((id) => ({
        x: Math.sin(i / 60 + id * 2) * 0.6,
        z: Math.cos(i / 60 + id * 2) * 0.6,
        jump: i % 120 === id,
        punch: i % 40 === id,
        grab: i % 180 > 100,
        lift: i % 180 > 140,
      }));
      eventCount += s.step(input).length;
      if (s.phase === "waiting") s.start([0, 1, 2]);
      if (i % 3 === 0) {
        const start = performance.now();
        const snap = s.snapshot([i, i, i]);
        const prediction = s.physics.players.map((p) =>
          capturePredictionState(p, s.combat.players[p.id])
        );
        serialize += performance.now() - start;
        snapshots++;
        bytes =
          snap.transforms.byteLength +
          JSON.stringify({ ...snap, transforms: undefined }).length +
          Math.max(...prediction.map((p) =>
            p.velocities.byteLength +
            JSON.stringify({ prediction: { ...p, velocities: undefined } }).length
          ));
        assert.equal(snap.transforms.byteLength, 756);
        assert.ok(prediction.every((p) => p.velocities.byteLength === 216));
      }
      for (const p of s.physics.players)
        for (const name of PARTS) {
          const part = p.parts[name];
          assert.ok(Number.isFinite(part.body.translation().x));
        }
    }
    console.log(
      JSON.stringify({
        benchmark: "3-player",
        steps: 1800,
        msPerStepIncludingAssertions: (performance.now() - began) / 1800,
        snapshotMs: serialize / snapshots,
        approxBytes: bytes,
        bytesPerSecond: bytes * 20,
        eventCount,
        allocatedBodies: s.physics.world.bodies.len(),
        joints: s.physics.world.impulseJoints.len(),
        activeGrips: s.combat.grips.hands.flat().filter(Boolean).length,
        invalidBodies: s.physics.diagnostics.invalidBodies,
      })
    );
    assert.equal(s.physics.diagnostics.invalidBodies, 0);
  } finally {
    s.dispose();
  }
});
test("development origin validation accepts same LAN host, rejects foreign sites; explicit allowlist works", () => {
  assert.ok(allowedOrigin("http://192.168.1.34:5173", "192.168.1.34:2567", ""));
  assert.ok(allowedOrigin("http://localhost:5173", "127.0.0.1:2567", ""));
  assert.equal(
    allowedOrigin("http://attacker.example:5173", "192.168.1.34:2567", ""),
    false
  );
  assert.equal(allowedOrigin("null", "192.168.1.34:2567", ""), false);
  assert.ok(
    allowedOrigin("https://play.example", "host:2567", "https://play.example")
  );
});
test("production allowlist admits only the listed exact origins", () => {
  const list = "https://torble.com, https://www.torble.com";
  assert.ok(allowedOrigin("https://torble.com", "party.up.railway.app", list));
  assert.ok(allowedOrigin("https://www.torble.com", "party.up.railway.app", list));
  for (const origin of ["http://torble.com", "https://evil.torble.com", "https://torble.com.evil.example", "http://localhost:5173"])
    assert.equal(allowedOrigin(origin, "party.up.railway.app", list), false, origin);
  assert.deepEqual(invalidAllowlistEntries(list), []);
  assert.deepEqual(invalidAllowlistEntries(""), []);
  assert.deepEqual(
    invalidAllowlistEntries("https://torble.com/,*,torble.com,https://torble.com/party-lab,ws://torble.com,https://ok.example"),
    ["https://torble.com/", "*", "torble.com", "https://torble.com/party-lab", "ws://torble.com"]
  );
});
