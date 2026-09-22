import assert from "node:assert/strict";
import { before, test } from "node:test";
import {
  initializePhysics,
  PlaygroundPhysics,
  IDLE_INPUT,
  PHYSICS,
} from "./physics";
import { CombatSimulation } from "./combat";
import { PhysicsFeedback } from "./feedback";
import { LocalRoundSimulation } from "./localRound";
import { ROUND } from "./roundLogic";
import { restore } from "./ragdoll/character";
import { impact } from "./combat/knockout";
import { PARTS } from "./ragdoll/config";
import type { FeedbackEvent } from "../audio/events";
import type { MovementInput } from "../input/types";
before(() => initializePhysics());
function fixture(
  check: (
    p: PlaygroundPhysics,
    c: CombatSimulation,
    events: FeedbackEvent[],
    tick: (inputs?: MovementInput[], n?: number) => void
  ) => void
) {
  const events: FeedbackEvent[] = [],
    emit = (event: FeedbackEvent) => events.push(event);
  const p = new PlaygroundPhysics(emit),
    c = new CombatSimulation(p, emit);
  restore(p.players[0], { x: 0, y: 1, z: 1 }, 0);
  restore(p.players[1], { x: 0, y: 1, z: 1.85 }, 0);
  for (let i = 0; i < 180; i++) p.step([]);
  events.length = 0;
  const tick = (inputs: MovementInput[] = [], n = 1) => {
    for (let i = 0; i < n; i++) {
      p.step(inputs, c.step(inputs, PHYSICS.step, "playing"));
      c.afterStep();
    }
  };
  try {
    check(p, c, events, tick);
  } finally {
    c.stop();
    p.dispose();
  }
}
test("missed accepted punch emits only swing; actual contacts emit part-aware impacts", () =>
  fixture((p, _c, events, tick) => {
    restore(p.players[1], { x: 0, y: 1, z: 4 }, 0);
    tick([{ ...IDLE_INPUT, punch: true }]);
    tick([], 60);
    assert.deepEqual(
      events.map((e) => e.name),
      ["punchSwing"]
    );
  }));
test("confirmed physical punch emits exactly one weighted contact and a separate KO accent", () =>
  fixture((_p, c, events, tick) => {
    // Existing hit logic will cross KO on any meaningful contact; audio cannot cause it.
    c.players[1].condition.meter = 99;
    tick([{ ...IDLE_INPUT, punch: true }]);
    tick([], 35);
    const hits = events.filter((e) =>
      ["headHit", "bodyHit", "limbHit"].includes(e.name)
    );
    assert.equal(hits.length, 1);
    assert.ok(hits[0].intensity! > 0);
    assert.equal(events.filter((e) => e.name === "punchSwing").length, 1);
    assert.equal(events.filter((e) => e.name === "knockout").length, 1);
    assert.equal(
      events.filter((e) => e.name === "fall").length,
      0,
      "KO is not elimination"
    );
    tick([], 240);
    assert.equal(events.filter((e) => e.name === "recovery").length, 1);
  }));
test("one/two-hand acquire, lift once, normal release and momentum throw cues", () =>
  fixture((p, c, events, tick) => {
    const grab = { ...IDLE_INPUT, grab: true };
    tick([grab], 65);
    assert.equal(c.grips.count(0), 2);
    assert.equal(events.filter((e) => e.name === "grab").length, 1);
    assert.equal(events.filter((e) => e.name === "secondGrab").length, 1);
    impact(c.players[1].condition, 100);
    c.step([{ ...grab, lift: true }], PHYSICS.step, "playing");
    const lifts = events.filter((e) => e.name === "lift").length;
    assert.ok(lifts > 0 && lifts <= 2); // EventGate merges the two successful hand cues.
    c.step([{ ...grab, lift: true }], PHYSICS.step, "playing");
    assert.equal(events.filter((e) => e.name === "lift").length, lifts);
    p.players[1].parts.torso.body.setLinvel({ x: 7, y: 0, z: 0 }, true);
    c.step([IDLE_INPUT], PHYSICS.step, "playing");
    assert.equal(events.filter((e) => e.name === "throw").length, 1);
    assert.equal(events.filter((e) => e.name === "release").length, 0);
  }));
test("escape/overload emit slip, but round cleanup never emits fake throws or breaks", () =>
  fixture((_p, c, events, tick) => {
    tick([{ ...IDLE_INPUT, grab: true }], 65);
    c.grips.release(0, 0, "escape");
    assert.equal(events.filter((e) => e.name === "gripBreak").length, 1);
    events.length = 0;
    c.stop();
    assert.equal(events.length, 0);
  }));
test("real grounded jumps and landing contacts emit once; idle floor contact stays quiet", () => {
  const p = new PlaygroundPhysics();
  const events: FeedbackEvent[] = [];
  const observer = new PhysicsFeedback(p, (e) => events.push(e));
  try {
    for (let i = 0; i < 180; i++) p.step([]);
    observer.reset();
    for (let i = 0; i < 120; i++) {
      p.step([]);
      observer.afterStep(PHYSICS.step, []);
    }
    assert.equal(events.length, 0, "resting contacts must be silent");
    p.step([{ ...IDLE_INPUT, jump: true }]);
    observer.afterStep(PHYSICS.step, []);
    for (let i = 0; i < 150; i++) {
      p.step([]);
      observer.afterStep(PHYSICS.step, []);
    }
    assert.equal(events.filter((e) => e.name === "landing").length, 1);
  } finally {
    p.dispose();
  }
});
test("physical collapse produces bounded contact feedback using real manifold impulse", () => {
  const p = new PlaygroundPhysics(),
    c = new CombatSimulation(p);
  const events: FeedbackEvent[] = [];
  const observer = new PhysicsFeedback(p, (e) => events.push(e));
  try {
    for (let i = 0; i < 180; i++) p.step([]);
    restore(p.players[0], { x: 0, y: 2.8, z: 2 }, 0);
    impact(c.players[0].condition, 100);
    p.players[0].parts.torso.body.applyTorqueImpulse(
      { x: 0.7, y: 0, z: 0 },
      true
    );
    for (let i = 0; i < 120; i++) {
      const before = events.length;
      p.step([], c.step([], PHYSICS.step, "playing"));
      observer.afterStep(PHYSICS.step, []);
      assert.ok(events.length - before <= 3);
    }
    assert.ok(
      events.some((e) => e.name === "floorFlop" || e.name === "headHit")
    );
    assert.ok(events.length < 16, `collapse generated ${events.length} cues`);
    assert.ok(events.every((e) => e.intensity! > 0));
  } finally {
    p.dispose();
  }
});
test("countdown 3/2/1, start, draw, fall, reset and jump come from real round transitions", () => {
  const events: FeedbackEvent[] = [];
  const s = new LocalRoundSimulation(
    () => 0.5,
    (e) => events.push(e)
  );
  try {
    for (let i = 0; i < 180; i++) s.step(IDLE_INPUT);
    assert.deepEqual(
      events.filter((e) => e.name === "countdown").map((e) => e.step),
      [3, 2, 1]
    );
    assert.equal(events.filter((e) => e.name === "roundStart").length, 1);
    s.step({ ...IDLE_INPUT, jump: true });
    assert.equal(
      events.filter((e) => e.name === "jump" && e.actor === 0).length,
      1
    );
    for (const p of s.physics.players)
      restore(p, { x: p.id * 2, y: -6, z: 0 }, 0);
    s.step(IDLE_INPUT);
    assert.equal(events.filter((e) => e.name === "fall").length, 3);
    assert.equal(events.filter((e) => e.name === "draw").length, 1);
    for (let i = 0; i < 211; i++) s.step(IDLE_INPUT);
    assert.equal(
      events.filter((e) => e.name === "fall").length,
      3,
      "no per-frame retriggers"
    );
    assert.equal(
      events.filter((e) => e.name === "countdown" && e.step === 3).length,
      2
    );
    for (let i = 0; i < 180; i++) s.step(IDLE_INPUT);
    for (const p of s.physics.players)
      restore(p, { x: p.id * 2, y: -6, z: 0 }, 0);
    s.step(IDLE_INPUT);
    for (const actor of [0, 1, 2])
      assert.equal(
        events.filter((e) => e.name === "fall" && e.actor === actor).length,
        2,
        "one elimination cue per actor per round"
      );
  } finally {
    s.dispose();
  }
});
test("feedback observers do not change deterministic body trajectories or combat", () => {
  const a = new LocalRoundSimulation(() => 0.5),
    b = new LocalRoundSimulation(
      () => 0.5,
      () => {}
    );
  try {
    for (let i = 0; i < 600; i++) {
      const input = { ...IDLE_INPUT, punch: i % 60 === 0, grab: i % 200 > 120 };
      a.step(input);
      b.step(input);
    }
    assert.deepEqual(a.round.snapshot(), b.round.snapshot());
    assert.deepEqual(a.combat.stats, b.combat.stats);
    for (const p of a.physics.players)
      for (const part of PARTS)
        assert.deepEqual(
          p.parts[part].body.translation(),
          b.physics.players[p.id].parts[part].body.translation()
        );
  } finally {
    a.dispose();
    b.dispose();
  }
});

test("winner cue is emitted once for the surviving player", () => {
  const events: FeedbackEvent[] = [];
  const s = new LocalRoundSimulation(
    () => 0.5,
    (e) => events.push(e)
  );
  try {
    for (let i = 0; i < 180; i++) s.step(IDLE_INPUT);
    for (const p of s.physics.players.slice(1))
      restore(p, { x: p.id * 2, y: -6, z: 0 }, 0);
    for (
      let i = 0;
      i < Math.ceil(ROUND.finalFallGrace / PHYSICS.step) + 10;
      i++
    )
      s.step(IDLE_INPUT);
    assert.equal(s.round.winner, 0);
    assert.equal(events.filter((e) => e.name === "winner").length, 1);
    assert.equal(events.filter((e) => e.name === "draw").length, 0);
  } finally {
    s.dispose();
  }
});
