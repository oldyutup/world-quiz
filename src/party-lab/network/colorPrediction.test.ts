import assert from "node:assert/strict";
import { before, test } from "node:test";
import { initializePhysics } from "../../../shared/party-lab/simulation/physics";
import { ColorRoundSimulation } from "../../../shared/party-lab/simulation/colorRound";
import { newRoomCounters } from "../../../shared/party-lab/simulation/online";
import { COLOR_NEIGHBOURS, COLOR_TILES, colorTileAt } from "../../../shared/party-lab/maps/colors";
import { normalizeMove, InputMailbox, type GameEvent, type GameSnapshot, type LayerInputPacket } from "../../../shared/party-lab/network/protocol";
import type { MovementInput } from "../../../shared/party-lab/intent";
import { GameStream, SnapshotBuffer } from "./gameStream";
import { LocalPrediction } from "./prediction/localPrediction";
import { ColorPredictionRig } from "./prediction/colorRig";
import { ColorBot } from "../scene/colors/bots";

before(() => initializePhysics());
const seeded = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) | 0) >>> 0) / 4294967296;
const FRAME = 1000 / 60;

interface Link {
  rtt: number;
  jitter?: number;
  /** [start ms, duration ms]: both directions held, then released in order (TCP). */
  stall?: [number, number];
}
const field = (standing: (id: number) => boolean) => COLOR_TILES.map((t) => (standing(t.id) ? 1 : 0)).join("");

/**
 * Scripted Renk Kaosu session for slot 0 on the real colour field, three players. Every
 * slot is a local bot (reading the server's game, as a player reads the screen) — slot 0's
 * intent goes through the link as packets and is predicted. Cycles 1–3: slot 0 plays
 * properly (it runs to the target, stands through three drops and restores, punches and
 * jumps on the way). From cycle 4's announcement it walks to the middle of a wrong-colour
 * tile and stands there: it falls when the floor drops. Transport as in the Katman Kaosu
 * test: ordered queues per direction (delay = rtt/2 + 0…jitter, never before the previous
 * packet), 60 Hz frames and server ticks, snapshots every third tick.
 */
function session(link: Link, seed = 1) {
  const random = seeded(seed);
  const server = new ColorRoundSimulation(newRoomCounters(), { seed: 900 + seed });
  server.start([0, 1, 2]);
  const box = new InputMailbox();
  while (server.phase === "countdown") server.step([]);
  const bots = [0, 1, 2].map((id) => new ColorBot(id as 0 | 1 | 2, seeded(50 + id)));
  bots.forEach((b) => b.reset());
  const local = new LocalPrediction(0, "color_chaos"),
    remote = new SnapshotBuffer(),
    stream = new GameStream();
  const snap = (): GameSnapshot => ({
    ...server.snapshot([box.processedRound === server.roundId ? box.processedSeq : -1, -1, -1]),
    prediction: server.prediction(0),
  });
  remote.push(snap(), 0);
  const up: { due: number; p: LayerInputPacket }[] = [],
    down: { due: number; s: GameSnapshot; events: GameEvent[] }[] = [];
  let lastUp = 0,
    lastDown = 0;
  const delay = (now: number, last: number) => {
    let due = now + link.rtt / 2 + random() * (link.jitter ?? 0);
    if (link.stall && now >= link.stall[0] && now < link.stall[0] + link.stall[1]) due = Math.max(due, link.stall[0] + link.stall[1]);
    return Math.max(due, last);
  };
  let seq = 0,
    pendingEvents: GameEvent[] = [];
  const out = { swings: 0, jumps: 0, maxPending: 0, frameStepMax: 0, shoved: 0, touched: 0, errorFree: 0 };
  /** Server colliders and pelvis height per round tick; the first prediction of each tick. */
  const serverField = new Map<number, string>(),
    serverY = new Map<number, number>(),
    predictedField = new Map<number, string>(),
    predictedY = new Map<number, number>();
  let sabotage: { x: number; z: number } | null = null,
    lastPose: Float32Array | null = null;
  const receive = (now: number) => {
    while (down[0] && down[0].due <= now + 1e-6) {
      const item = down.shift()!;
      remote.push(item.s, now);
      stream.acceptEvents(item.events);
      local.reconcile(remote.latest!, now);
    }
  };
  const game = server.game;
  for (let i = 0; i < 60 * 22 && server.phase === "playing" && server.round.alive[0]; i++) {
    const now = i * FRAME;
    receive(now);
    // Slot 0's intent (as a client would compute it now, from what it sees).
    const cycle = game.schedule.cycle;
    if (!sabotage && cycle.index >= 4 && game.round.tick >= cycle.announce) {
      const here = game.physics.players[0].body.translation();
      const wrong = COLOR_TILES.filter((t) => t.ring <= 3 && cycle.colors[t.id] !== cycle.target && COLOR_NEIGHBOURS[t.id].every((n) => cycle.colors[n] !== cycle.target)).sort(
        (a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z)
      )[0];
      sabotage = wrong ? { x: wrong.x, z: wrong.z } : { x: here.x, z: here.z };
    }
    let intent: MovementInput;
    if (sabotage) {
      const here = game.physics.players[0].body.translation();
      const dx = sabotage.x - here.x,
        dz = sabotage.z - here.z,
        d = Math.hypot(dx, dz);
      intent = d > 0.25 ? { x: dx / d, z: dz / d, jump: false } : { x: 0, z: 0, jump: false };
    } else intent = bots[0].update(game);
    const move = normalizeMove(intent.x, intent.z);
    const punch = i === 200 || !!intent.punch,
      jump = i === 90 || !!intent.jump;
    const p: LayerInputPacket = { seq: ++seq, round: server.roundId, moveX: move.x, moveZ: move.z, jumpPressed: jump, sprintHeld: !!intent.sprint, punchPressed: punch };
    up.push({ due: (lastUp = delay(now, lastUp)), p });
    const result = local.advance(p, 1, now);
    if (result?.swing) out.swings++;
    if (result?.jumped) out.jumps++;
    const rig = local.rig as ColorPredictionRig;
    if (local.active && !rig.out) {
      const tick = rig.tick - 1;
      if (!predictedField.has(tick)) {
        predictedField.set(tick, field((id) => rig.standing(id)));
        predictedY.set(tick, rig.character.body.translation().y);
      }
    }
    while (up[0] && up[0].due <= now + 1e-6) box.accept(up.shift()!.p, server.roundId, now, "color_chaos");
    const tick = server.round.tick;
    const events = server.step([box.read(now), bots[1].update(game), bots[2].update(game)]);
    pendingEvents.push(...events);
    if (events.some((e) => ["headHit", "bodyHit", "limbHit"].includes(e.name) && e.target === 0)) out.shoved++;
    // Another body within reach of slot 0 (contacts the rig cannot see: it has no other players).
    const me = server.physics.players[0].body.translation();
    if ([1, 2].some((id) => !server.physics.players[id].eliminated && Math.hypot(server.physics.players[id].body.translation().x - me.x, server.physics.players[id].body.translation().z - me.z) < 1.2)) out.touched = i;
    // Largest correction measured while no other body was near for the last second.
    if (i - out.touched > 60) out.errorFree = Math.max(out.errorFree, local.metrics.error);
    if (server.phase === "playing" || events.some((e) => e.name === "winner" || e.name === "draw")) {
      serverField.set(tick, field((id) => server.field.intact(id)));
      serverY.set(tick, server.physics.players[0].body.translation().y);
    }
    if (server.tick % 3 === 0) {
      down.push({ due: (lastDown = delay(now, lastDown)), s: snap(), events: pendingEvents });
      pendingEvents = [];
    }
    receive(now);
    const pose = local.pose(1 / 60);
    if (pose) {
      if (lastPose) out.frameStepMax = Math.max(out.frameStepMax, Math.hypot(pose[0] - lastPose[0], pose[1] - lastPose[1], pose[2] - lastPose[2]));
      lastPose = pose.slice();
    } else lastPose = null;
    out.maxPending = Math.max(out.maxPending, local.history.records.length);
    assert.ok(local.rig.valid());
  }
  // The predicted collider set of every tick both sides reached is the server's.
  let fieldChecked = 0,
    fieldMismatch = 0;
  for (const [tick, set] of predictedField) {
    const truth = serverField.get(tick);
    if (truth === undefined) continue;
    fieldChecked++;
    if (truth !== set) fieldMismatch++;
  }
  // First tick the body is below the floor (the sabotage fall): predicted vs server.
  const firstBelow = (ys: Map<number, number>) => {
    const ticks = [...ys.keys()].filter((k) => predictedY.has(k) && serverY.has(k)).sort((a, b) => a - b);
    return ticks.find((k) => ys.get(k)! < 0.3) ?? -1;
  };
  const m = local.metrics;
  const rig = local.rig as ColorPredictionRig;
  const result = {
    rtt: link.rtt,
    jitter: link.jitter ?? 0,
    stall: link.stall?.[1] ?? 0,
    cycles: game.schedule.cycle.index,
    swings: out.swings,
    jumps: out.jumps,
    averageError: +(m.totalError / Math.max(1, m.reconciliations)).toFixed(4),
    maxError: +m.maxError.toFixed(4),
    maxErrorAlone: +out.errorFree.toFixed(4),
    shovedByBots: out.shoved,
    corrections: m.corrections,
    hard: m.hard,
    overflows: m.overflows,
    maxPending: out.maxPending,
    frameStepMaxM: +out.frameStepMax.toFixed(3),
    predictionStepMs: +(m.stepMs / Math.max(1, m.steps)).toFixed(3),
    reconcileMs: +(m.reconcileMs / Math.max(1, m.reconciliations)).toFixed(3),
    restoredTiles: rig.restored,
    fall: [firstBelow(predictedY), firstBelow(serverY)],
    fieldChecked,
    fieldMismatch,
    out: server.round.outAt[0],
  };
  local.dispose();
  server.dispose();
  return result;
}

test("colour prediction at 0/50/100/150 ms RTT: three drops and restores survived on the server's colliders, then a fall through a wrong colour on the server's tick; soft corrections only", () => {
  for (const rtt of [0, 50, 100, 150]) {
    const r = session({ rtt });
    console.log(JSON.stringify(r));
    assert.ok(r.cycles >= 4, "played into cycle 4");
    assert.equal(r.hard, 0, "no hard correction");
    assert.equal(r.overflows, 0);
    // Bots shove and brush past slot 0: those contacts are corrections (the rig has no other bodies), soft ones.
    assert.ok(r.maxError < 0.5, `max correction ${r.maxError} m`);
    assert.ok(r.maxErrorAlone < 0.15, `max correction away from other bodies ${r.maxErrorAlone} m`);
    assert.ok(r.swings >= 1, "the punch swings locally");
    assert.ok(r.fieldChecked > 700 && r.fieldMismatch === 0, `predicted colliders = server's on every tick (${r.fieldMismatch}/${r.fieldChecked})`);
    assert.ok(r.out > 0, "slot 0 fell out");
    assert.ok(r.fall[1] > 0 && Math.abs(r.fall[0] - r.fall[1]) <= 1, `the fall starts on the server's tick (${r.fall})`);
    if (rtt >= 50) assert.ok(r.restoredTiles > 0, "replays brought back tiles the prediction had already dropped");
  }
});

test("colour prediction with jitter (100 ± 0–60, 150 ± 0–60 ms): soft corrections only, the colliders always agree", () => {
  for (const link of [
    { rtt: 100, jitter: 60 },
    { rtt: 150, jitter: 60 },
  ]) {
    const r = session(link, 7);
    console.log(JSON.stringify(r));
    assert.equal(r.hard, 0);
    assert.ok(r.maxError < 1, `max correction ${r.maxError} m`);
    assert.equal(r.fieldMismatch, 0);
    assert.ok(r.fall[1] < 0 || Math.abs(r.fall[0] - r.fall[1]) <= 2, `fall tick ${r.fall}`);
  }
});

test("colour prediction through 300/500/800 ms stalls: bounded window, recovers; the predicted colliders never disagree", () => {
  for (const ms of [300, 500, 800]) {
    // The stall starts in cycle 2's preview (standing on the last target, 4.6 s).
    const r = session({ rtt: 70, stall: [4600, ms] }, 11);
    console.log(JSON.stringify(r));
    assert.ok(r.maxPending <= 30, "pending window respected");
    assert.equal(r.fieldMismatch, 0, "no collider disagreement, even across the stall");
    if (ms <= 300) assert.equal(r.hard, 0, "a 300 ms stall needs no hard correction");
  }
  // A stall while running to the target, over its drop: the server never got those inputs, so
  // the body it has did not run — the player falls (the server decides), and the client's
  // prediction snaps to that; the colliders still agree tick for tick.
  const late = session({ rtt: 70, stall: [2400, 300] }, 11);
  console.log(JSON.stringify({ stallOverTheDrop: late }));
  assert.equal(late.fieldMismatch, 0);
  assert.ok(late.maxPending <= 30);
});

test("collider replay: a tile the prediction already dropped is solid again on the first replayed tick (the Katman Kaosu refresh, reused)", () => {
  const server = new ColorRoundSimulation(newRoomCounters(), { seed: 3 });
  server.start([0, 1]);
  while (server.phase === "countdown") server.step([]);
  const cycle = server.schedule.cycle;
  // Slot 0 on a wrong colour 12 ticks before the drop.
  while (server.round.tick < cycle.drop - 12) server.step([]);
  const here = server.physics.players[0].body.translation();
  const under = colorTileAt(here.x, here.z)!;
  const snapshot = { ...server.snapshot([-1, -1, -1]), prediction: server.prediction(0) };
  const buffer = new SnapshotBuffer();
  buffer.push(snapshot, 0);
  const values = buffer.latest!.values;
  const replay = (rig: ColorPredictionRig) => {
    assert.ok(rig.restore(snapshot, values));
    const ys: number[] = [];
    for (let i = 0; i < 40; i++) {
      rig.step({ x: 0, z: 0, jump: false });
      ys.push(rig.character.body.translation().y);
    }
    return ys;
  };
  const fresh = new ColorPredictionRig(0);
  const reference = replay(fresh);
  const onTarget = cycle.colors[under.id] === cycle.target;
  if (!onTarget) {
    assert.ok(Math.abs(reference[10] - reference[0]) < 0.02, "standing up to the drop tick");
    assert.ok(reference[reference.length - 1] < reference[0] - 0.5, "falling after it");
  }
  // The same rig restored again (the first replay parked the non-target tiles) replays identically.
  const again = replay(fresh);
  assert.ok(fresh.restored >= 1, "tiles came back");
  for (let i = 0; i < reference.length; i++) assert.ok(Math.abs(again[i] - reference[i]) < 1e-3, `tick ${i}: ${again[i]} vs ${reference[i]}`);
  fresh.dispose();
  server.dispose();
});
