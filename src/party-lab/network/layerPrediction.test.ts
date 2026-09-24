import assert from "node:assert/strict";
import { before, test } from "node:test";
import RAPIER from "@dimforge/rapier3d-compat";
import { initializePhysics } from "../../../shared/party-lab/simulation/physics";
import { LayerRoundSimulation } from "../../../shared/party-lab/simulation/layerRound";
import { newRoomCounters } from "../../../shared/party-lab/simulation/online";
import { connect, restore } from "../../../shared/party-lab/simulation/ragdoll/character";
import { LAYER_TILES, LAYER_TOPS, tileAt } from "../../../shared/party-lab/maps/layers";
import { InputMailbox, type GameEvent, type GameSnapshot, type LayerInputPacket } from "../../../shared/party-lab/network/protocol";
import { GameStream, SnapshotBuffer } from "./gameStream";
import { LocalPrediction } from "./prediction/localPrediction";
import { LayerPredictionRig } from "./prediction/layerRig";

before(() => initializePhysics());
const seeded = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) | 0) >>> 0) / 4294967296;
const FRAME = 1000 / 60;

interface Link {
  rtt: number;
  jitter?: number;
  /** [start ms, duration ms]: both directions held, then released in order (TCP). */
  stall?: [number, number];
}
const goneSet = (gone: (id: number) => boolean) => LAYER_TILES.filter((t) => gone(t.id)).map((t) => t.id).join(",");

/**
 * Scripted Katman Kaosu session (7 s) for slot 0 on the real tile field: walk to the
 * crown's inner ring, stand until the tile breaks (a physical fall to L2, which bounces
 * once), punch the air, sprint with a running jump into one of L2's windows (another fall). Slot 1 waits
 * on the far side of L4 (moved to a fresh tile every second, so it never falls out and
 * ends the round). Transport as in the Barn test: ordered queues per direction (delay =
 * rtt/2 + 0…jitter, never before the previous packet), 60 Hz frames and server ticks,
 * snapshots every third tick.
 */
function session(link: Link, seed = 1) {
  const random = seeded(seed);
  const server = new LayerRoundSimulation(newRoomCounters());
  server.start([0, 1]);
  const box = new InputMailbox();
  while (server.phase === "countdown") server.step([]);
  const keeper = LAYER_TILES.filter((t) => t.layer === 3 && t.x < -2);
  const park = (k: number) => {
    const tile = keeper[k % keeper.length],
      c = server.physics.players[1];
    restore(c, { x: tile.x, y: tile.top + 0.9, z: tile.z }, 0);
    connect(server.physics.world, c);
  };
  park(0);
  const local = new LocalPrediction(0, "layer_chaos"),
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
  const out = { predictedResponse: -1, jumped: -1, serverJumped: false, swings: 0, maxPending: 0, frameStepMax: 0 };
  /** Server pelvis height and GONE set per round tick; the first prediction of each tick. */
  const serverY = new Map<number, number>(),
    serverGone = new Map<number, string>(),
    predictedY = new Map<number, number>(),
    predictedGone = new Map<number, string>();
  const start = 500;
  let origin = 0,
    lastPose: Float32Array | null = null;
  const receive = (now: number) => {
    while (down[0] && down[0].due <= now + 1e-6) {
      const item = down.shift()!;
      remote.push(item.s, now);
      stream.acceptEvents(item.events);
      local.reconcile(remote.latest!, now);
    }
  };
  for (let i = 0; i < 420; i++) {
    const now = i * FRAME,
      t = now / 1000;
    receive(now);
    let moveX = 0,
      moveZ = 0,
      sprint = false,
      jump = false,
      punch = false;
    if (t >= 0.5 && t < 1.3) moveX = -1;
    else if (t >= 3.0 && t < 3.05) punch = true;
    else if (t >= 3.6 && t < 4.3) (moveZ = 1), (sprint = true), (jump = i === Math.round(4.2 * 60));
    const p: LayerInputPacket = { seq: ++seq, round: server.roundId, moveX, moveZ, jumpPressed: jump, sprintHeld: sprint, punchPressed: punch };
    up.push({ due: (lastUp = delay(now, lastUp)), p });
    const result = local.advance(p, 1, now);
    if (result?.jumped && out.jumped < 0) out.jumped = now;
    if (result?.swing) out.swings++;
    const rig = local.rig as LayerPredictionRig;
    if (local.active) {
      const tick = rig.tick - 1;
      if (!predictedY.has(tick)) {
        predictedY.set(tick, rig.character.body.translation().y);
        predictedGone.set(tick, goneSet((id) => tick >= rig.tiles.goneTick(id)));
      }
    }
    while (up[0] && up[0].due <= now + 1e-6) box.accept(up.shift()!.p, server.roundId, now, "layer_chaos");
    if (i % 60 === 30) park(Math.floor(i / 60) + 1);
    const events = server.step([box.read(now), { x: 0, z: 0, jump: false }]);
    pendingEvents.push(...events);
    out.serverJumped ||= events.some((e) => e.name === "jump" && e.actor === 0 && t > 4.1);
    if (server.phase === "playing") {
      serverY.set(server.round.tick - 1, server.physics.players[0].body.translation().y);
      serverGone.set(server.round.tick - 1, goneSet((id) => !server.field.intact(id)));
    }
    if (server.tick % 3 === 0) {
      down.push({ due: (lastDown = delay(now, lastDown)), s: snap(), events: pendingEvents });
      pendingEvents = [];
    }
    receive(now);
    const pose = local.pose(1 / 60);
    if (pose) {
      if (now < start) origin = pose[0];
      if (now >= start && out.predictedResponse < 0 && Math.abs(pose[0] - origin) > 0.002) out.predictedResponse = now;
      if (lastPose) out.frameStepMax = Math.max(out.frameStepMax, Math.hypot(pose[0] - lastPose[0], pose[1] - lastPose[1], pose[2] - lastPose[2]));
      lastPose = pose.slice();
    }
    out.maxPending = Math.max(out.maxPending, local.history.records.length);
    assert.ok(local.rig.valid());
  }
  assert.equal(server.phase, "playing", "the round is still on");
  // First tick the body is below its layer (L1 → L2 and L2 → lower): predicted vs server.
  // Only ticks both sides reached (the prediction runs ahead of the server by the round trip).
  const firstBelow = (ys: Map<number, number>, level: number, after = 0) => {
    const ticks = [...ys.keys()].filter((k) => k >= after && predictedY.has(k) && serverY.has(k)).sort((a, b) => a - b);
    return ticks.find((k) => ys.get(k)! < level) ?? -1;
  };
  const drop1 = [firstBelow(predictedY, LAYER_TOPS[0] + 0.3), firstBelow(serverY, LAYER_TOPS[0] + 0.3)];
  const drop2 = [firstBelow(predictedY, LAYER_TOPS[1] + 0.3, drop1[1]), firstBelow(serverY, LAYER_TOPS[1] + 0.3, drop1[1])];
  // The GONE set the prediction used for a tick is the server's GONE set on that tick.
  let goneChecked = 0,
    goneMismatch = 0;
  for (const [tick, set] of predictedGone) {
    const truth = serverGone.get(tick);
    if (truth === undefined) continue;
    goneChecked++;
    if (truth !== set) goneMismatch++;
  }
  const m = local.metrics;
  const rig = local.rig as LayerPredictionRig;
  const result = {
    rtt: link.rtt,
    jitter: link.jitter ?? 0,
    stall: link.stall?.[1] ?? 0,
    predictedResponseMs: Math.round(out.predictedResponse - start),
    jumpPredictedMs: out.jumped < 0 ? null : Math.round(out.jumped - 4.2 * 1000),
    serverJumped: out.serverJumped,
    swings: out.swings,
    averageError: +(m.totalError / Math.max(1, m.reconciliations)).toFixed(4),
    maxError: +m.maxError.toFixed(4),
    corrections: m.corrections,
    hard: m.hard,
    overflows: m.overflows,
    maxPending: out.maxPending,
    frameStepMaxM: +out.frameStepMax.toFixed(3),
    predictionStepMs: +(m.stepMs / Math.max(1, m.steps)).toFixed(3),
    reconcileMs: +(m.reconcileMs / Math.max(1, m.reconciliations)).toFixed(3),
    restoredTiles: rig.restored,
    dropL1: drop1,
    dropL2: drop2,
    goneChecked,
    goneMismatch,
    finalLayerY: +server.physics.players[0].body.translation().y.toFixed(2),
  };
  local.dispose();
  server.dispose();
  return result;
}

test("layer prediction at 0/50/100/150 ms RTT: immediate movement and jump, drops through tiles on the server's tick, same GONE set every tick", () => {
  for (const rtt of [0, 50, 100, 150]) {
    const r = session({ rtt });
    console.log(JSON.stringify(r));
    assert.ok(r.predictedResponseMs >= 0 && r.predictedResponseMs <= 17, `movement shows on the next frame (${r.predictedResponseMs} ms)`);
    // The running jump happens when the body is on its feet again after the L2 landing bounce.
    assert.equal(r.jumpPredictedMs !== null, r.serverJumped, "predicted jump iff the server jumped");
    if (r.jumpPredictedMs !== null) assert.ok(Math.abs(r.jumpPredictedMs) <= 17, "jump predicted on its frame");
    assert.equal(r.swings, 1, "the punch swings locally once");
    assert.equal(r.hard, 0, "no hard correction");
    assert.equal(r.overflows, 0);
    assert.ok(r.maxError < 0.15, `max correction ${r.maxError} m`);
    assert.ok(r.dropL1[1] > 0, "a physical fall through the breaking tile");
    assert.ok(Math.abs(r.dropL1[0] - r.dropL1[1]) <= 1, `the fall starts on the server's tick (${r.dropL1})`);
    if (r.dropL2[1] > 0) assert.ok(Math.abs(r.dropL2[0] - r.dropL2[1]) <= 1, `second fall on the server's tick (${r.dropL2})`);
    assert.ok(r.goneChecked > 400 && r.goneMismatch === 0, `predicted GONE set = server's on every tick (${r.goneMismatch}/${r.goneChecked})`);
    if (rtt >= 50) assert.ok(r.restoredTiles > 0, "replays restored tiles the prediction had already dropped");
  }
});

test("layer prediction with jitter (100 ± 0–60, 150 ± 0–60 ms): smooth, soft corrections only, tiles agree", () => {
  for (const link of [
    { rtt: 100, jitter: 60 },
    { rtt: 150, jitter: 60 },
  ]) {
    const r = session(link, 7);
    console.log(JSON.stringify(r));
    assert.equal(r.hard, 0);
    assert.ok(r.maxError < 1, `max correction ${r.maxError} m`);
    assert.equal(r.goneMismatch, 0);
    assert.ok(Math.abs(r.dropL1[0] - r.dropL1[1]) <= 2, `fall tick ${r.dropL1}`);
  }
});

test("layer prediction through 300/500/800 ms stalls: bounded window, recovers; the predicted tiles never disagree", () => {
  for (const ms of [300, 500, 800]) {
    const r = session({ rtt: 70, stall: [2200, ms] }, 11);
    console.log(JSON.stringify(r));
    assert.ok(r.maxPending <= 30, "pending window respected");
    assert.equal(r.goneMismatch, 0, "no tile disagreement, even across the stall");
    if (ms <= 300) assert.equal(r.hard, 0, "a 300 ms stall needs no hard correction");
  }
});

test("tile collider replay: a tile the prediction already dropped is solid again on the first replayed tick", () => {
  const server = new LayerRoundSimulation(newRoomCounters());
  server.start([0, 1]);
  while (server.phase === "countdown") server.step([]);
  for (let i = 0; i < 20; i++) server.step([]);
  const pelvis = server.physics.players[0].body.translation();
  const tile = tileAt(0, pelvis.x, pelvis.z)!;
  const goneTick = server.field.goneTick[tile.id];
  assert.ok(goneTick > server.round.tick, "the standing tile is armed and still there");
  const snapshot = { ...server.snapshot([-1, -1, -1]), prediction: server.prediction(0) };
  const buffer = new SnapshotBuffer();
  buffer.push(snapshot, 0);
  const values = buffer.latest!.values;
  const replay = (rig: LayerPredictionRig) => {
    assert.ok(rig.restore(snapshot, values));
    const ys: number[] = [];
    for (let i = 0; i < goneTick - snapshot.layers!.t + 25; i++) {
      rig.step({ x: 0, z: 0, jump: false });
      ys.push(rig.character.body.translation().y);
    }
    return ys;
  };
  const fresh = new LayerPredictionRig(0);
  const reference = replay(fresh);
  // The body stands until the tile's GONE tick, then falls.
  const at = goneTick - snapshot.layers!.t;
  assert.ok(Math.abs(reference[at - 1] - reference[0]) < 0.02, "standing up to the GONE tick");
  assert.ok(reference[reference.length - 1] < reference[0] - 0.5, "falling after it");
  // The same rig restored again (its tile was parked by the first replay) replays identically.
  const again = replay(fresh);
  assert.ok(fresh.restored >= 1, "the tile came back");
  for (let i = 0; i < reference.length; i++) assert.ok(Math.abs(again[i] - reference[i]) < 1e-3, `tick ${i}: ${again[i]} vs ${reference[i]}`);
  // Without the query refresh it would not: a restored collider is invisible to ray queries until a world step.
  const probe = new RAPIER.World({ x: 0, y: -20, z: 0 });
  const c = probe.createCollider(RAPIER.ColliderDesc.cuboid(1, 0.25, 1));
  probe.step();
  c.setEnabled(false);
  c.setTranslation({ x: 0, y: -1000, z: 0 });
  probe.step();
  c.setTranslation({ x: 0, y: 0, z: 0 });
  c.setEnabled(true);
  const ray = () => probe.castRay(new RAPIER.Ray({ x: 0, y: 2, z: 0 }, { x: 0, y: -1, z: 0 }), 5, false);
  assert.equal(ray(), null, "Rapier: not visible before a step (why the rig takes a zero-length one)");
  probe.timestep = 0;
  probe.step();
  assert.ok(ray(), "visible after it");
  probe.free();
  fresh.dispose();
  server.dispose();
});
