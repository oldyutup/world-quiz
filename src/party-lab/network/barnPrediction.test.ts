import assert from "node:assert/strict";
import { before, test } from "node:test";
import { initializePhysics } from "../../../shared/party-lab/simulation/physics";
import { BarnRoundSimulation } from "../../../shared/party-lab/simulation/barnRound";
import { newRoomCounters } from "../../../shared/party-lab/simulation/online";
import { connect, restore } from "../../../shared/party-lab/simulation/ragdoll/character";
import { newWeapon } from "../../../shared/party-lab/simulation/barn/weapons";
import { InputMailbox, NET, type BarnInputPacket, type GameEvent, type GameSnapshot } from "../../../shared/party-lab/network/protocol";
import { GameStream, SnapshotBuffer } from "./gameStream";
import { LocalPrediction } from "./prediction/localPrediction";
import { BarnPredictionRig } from "./prediction/barnRig";

before(() => initializePhysics());
const seeded = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) | 0) >>> 0) / 4294967296;
const FRAME = 1000 / 60;

interface Link {
  rtt: number;
  jitter?: number;
  /** [start ms, duration ms]: both directions held, then released in order (TCP). */
  stall?: [number, number];
}
/**
 * Scripted Barn session (8.5 s) in the east wing's open lane: walk, stop, sprint, stop,
 * strafe while aiming, turn in place, 10 SMG rounds held, walk + jump, idle. Transport is
 * simulated per direction as an ordered queue (delay = rtt/2 + 0…jitter, never before the
 * previous packet), 60 Hz client frames and server ticks, snapshots every third tick.
 */
function session(link: Link, seed = 1) {
  const random = seeded(seed);
  const server = new BarnRoundSimulation(newRoomCounters(), seeded(seed + 100));
  server.start([0, 1]);
  const box = new InputMailbox();
  while (server.phase === "countdown") server.step([]);
  const c = server.physics.players[0];
  restore(c, { x: 15, y: 1.6, z: 0.5 }, -Math.PI / 2);
  connect(server.physics.world, c);
  const other = server.physics.players[1];
  restore(other, { x: -13, y: 1.6, z: -1 }, Math.PI / 2);
  connect(server.physics.world, other);
  for (let i = 0; i < 60; i++) server.step([]);
  server.barn.fighters[0].weapon = newWeapon("smg");
  server.barn.fighters[0].protection = 0;
  const local = new LocalPrediction(0, "barn_shootout"),
    remote = new SnapshotBuffer(),
    stream = new GameStream();
  const snap = (): GameSnapshot => ({
    ...server.snapshot([box.processedRound === server.roundId ? box.processedSeq : -1, -1, -1]),
    prediction: server.prediction(0),
  });
  remote.push(snap(), 0);
  local.reconcile(remote.latest!, 0);
  const up: { due: number; p: BarnInputPacket }[] = [],
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
  const out = {
    predictedResponse: -1,
    serverResponse: -1,
    jumped: -1,
    localShots: 0,
    serverShots: 0,
    lateShots: 0,
    maxPending: 0,
    frameStepMax: 0,
    idleDrift: 0,
  };
  const start = 500;
  let origin = 0,
    serverOrigin = 0,
    lastPose: Float32Array | null = null,
    idleFrom: { x: number; z: number } | null = null;
  const receive = (now: number) => {
    while (down[0] && down[0].due <= now + 1e-6) {
      const item = down.shift()!;
      remote.push(item.s, now);
      stream.acceptEvents(item.events);
      local.reconcile(remote.latest!, now);
    }
  };
  for (let i = 0; i < 510; i++) {
    const now = i * FRAME,
      t = now / 1000;
    receive(now);
    // Script (world axes; the barn's camera-relative mapping is tested elsewhere).
    let moveX = 0,
      moveZ = 0,
      sprint = false,
      yaw = -Math.PI / 2,
      attackHeld = false,
      attackPressed = false,
      jump = false;
    if (t >= 0.5 && t < 1.5) moveX = -1;
    else if (t >= 2 && t < 2.8) (moveX = 1), (sprint = true), (yaw = Math.PI / 2);
    else if (t >= 3.5 && t < 4.5) (moveX = -1), (yaw = Math.PI - (t - 3.5) * 2);
    else if (t >= 4.5 && t < 5.5) yaw = Math.PI - 2 + (t - 4.5) * 3;
    else if (t >= 5.5 && t < 6.5) (yaw = -Math.PI / 2), (attackHeld = true), (attackPressed = i === Math.round(5.5 * 60));
    else if (t >= 6.5 && t < 7.5) (moveX = 1), (yaw = Math.PI / 2), (jump = i === 7 * 60);
    else if (t >= 7.5) yaw = Math.PI / 2;
    if (t >= 4.5 && t < 5.5) yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    const p: BarnInputPacket = {
      seq: ++seq,
      round: server.roundId,
      moveX,
      moveZ,
      jumpPressed: jump,
      sprintHeld: sprint,
      attackPressed,
      attackHeld,
      pickupPressed: false,
      aimYaw: Math.atan2(Math.sin(yaw), Math.cos(yaw)),
      aimPitch: 0.17,
      eyeX: -0.4,
      eyeY: 1.05,
      eyeZ: 0,
      viewTick: Math.max(0, (remote.renderMs * NET.physicsHz) / 1000),
    };
    up.push({ due: (lastUp = delay(now, lastUp)), p });
    const result = local.advance(p, 1, now);
    if (result?.jumped && out.jumped < 0) out.jumped = now;
    for (const shot of [...(result?.shots ?? []), ...local.lateShots.splice(0)]) {
      out.localShots++;
      stream.markLocalShot(0, shot.kind === "shotgun" ? "shotgunFire" : "smgFire", now);
    }
    while (up[0] && up[0].due <= now + 1e-6) box.accept(up.shift()!.p, server.roundId, now, "barn_shootout");
    const events = server.step([box.read(now), { x: 0, z: 0, jump: false }]);
    out.serverShots += events.filter((e) => e.name === "smgFire" && e.actor === 0).length;
    pendingEvents.push(...events);
    const sx = server.physics.players[0].body.translation().x;
    if (now < start) serverOrigin = sx;
    if (now >= start && out.serverResponse < 0 && Math.abs(sx - serverOrigin) > 0.002) out.serverResponse = now;
    if (server.tick % 3 === 0) {
      down.push({ due: (lastDown = delay(now, lastDown)), s: snap(), events: pendingEvents });
      pendingEvents = [];
    }
    receive(now);
    const pose = local.pose(1 / 60);
    if (pose) {
      if (now < start) origin = pose[0];
      if (now >= start && out.predictedResponse < 0 && Math.abs(pose[0] - origin) > 0.002) out.predictedResponse = now;
      if (lastPose) out.frameStepMax = Math.max(out.frameStepMax, Math.hypot(pose[0] - lastPose[0], pose[2] - lastPose[2]));
      lastPose = pose.slice();
      // Standing still at the end: the predicted body holds its place like the server's.
      if (t >= 7.9 && !idleFrom) idleFrom = { x: pose[0], z: pose[2] };
      if (idleFrom) out.idleDrift = Math.max(out.idleDrift, Math.hypot(pose[0] - idleFrom.x, pose[2] - idleFrom.z));
    }
    out.maxPending = Math.max(out.maxPending, local.history.records.length);
    assert.ok(local.rig.valid());
  }
  // Drain what is still in flight.
  for (let k = 1; k <= 120; k++) receive(510 * FRAME + k * FRAME);
  // Confirmed own shots not already presented locally are drawn from the server echo (late).
  for (const e of stream.drain(server.roundId, Infinity)) if (e.name === "smgFire" && e.actor === 0) out.lateShots++;
  const m = local.metrics;
  const rig = local.rig as BarnPredictionRig;
  const result = {
    rtt: link.rtt,
    jitter: link.jitter ?? 0,
    stall: link.stall?.[1] ?? 0,
    predictedResponseMs: Math.round(out.predictedResponse - start),
    serverResponseMs: Math.round(out.serverResponse - start),
    jumpPredictedMs: Math.round(out.jumped - 7 * 1000),
    averageError: +(m.totalError / Math.max(1, m.reconciliations)).toFixed(4),
    maxError: +m.maxError.toFixed(4),
    corrections: m.corrections,
    hard: m.hard,
    overflows: m.overflows,
    maxPending: out.maxPending,
    frameStepMaxM: +out.frameStepMax.toFixed(3),
    predictionStepMs: +(m.stepMs / Math.max(1, m.steps)).toFixed(3),
    reconcileMs: +(m.reconcileMs / Math.max(1, m.reconciliations)).toFixed(3),
    localShots: out.localShots,
    serverShots: out.serverShots,
    lateShots: out.lateShots,
    /** Shots drawn twice (predicted and again from the echo): must be 0. */
    duplicateShots: Math.max(0, out.localShots + out.lateShots - out.serverShots),
    predictedAmmo: rig.fighter.weapon?.ammo ?? 0,
    serverAmmo: server.barn.fighters[0].weapon?.ammo ?? 0,
    idleDriftM: +out.idleDrift.toFixed(3),
  };
  local.dispose();
  server.dispose();
  return result;
}

test("barn prediction at 0/50/100/150 ms RTT: immediate local movement, sprint, aim-facing and fire; bounded soft corrections, no hard ones", () => {
  for (const rtt of [0, 50, 100, 150]) {
    const r = session({ rtt });
    console.log(JSON.stringify(r));
    assert.ok(r.predictedResponseMs >= 0 && r.predictedResponseMs <= 17, `movement shows on the next frame (${r.predictedResponseMs} ms)`);
    assert.ok(Math.abs(r.jumpPredictedMs) <= 17, "jump predicted on its frame");
    assert.equal(r.hard, 0, "no hard correction");
    assert.equal(r.overflows, 0);
    assert.ok(r.maxError < 0.15, `max correction ${r.maxError} m`);
    assert.equal(r.localShots, 10, "10 rounds presented locally at once");
    assert.equal(r.serverShots, 10, "and 10 fired by the server");
    assert.equal(r.duplicateShots, 0, "no confirmed shot drawn twice");
    assert.equal(r.predictedAmmo, r.serverAmmo, "predicted ammo reconciles to the server's");
    assert.ok(r.idleDriftM < 0.05, `predicted idle drift ${r.idleDriftM} m`);
  }
});

test("barn prediction with jitter (100 ± 0–60 ms, 150 ± 0–60 ms): smooth, soft corrections only", () => {
  for (const link of [
    { rtt: 100, jitter: 60 },
    { rtt: 150, jitter: 60 },
  ]) {
    const r = session(link, 7);
    console.log(JSON.stringify(r));
    assert.equal(r.hard, 0);
    // Soft (blended) corrections only; the largest visible frame-to-frame step stays small
    // (the rooftop measured ≤ 0.16 m up to RTT 300 + 60 ms jitter).
    assert.ok(r.maxError < 1, `max correction ${r.maxError} m`);
    assert.ok(r.frameStepMaxM < 0.2, `largest visible frame step ${r.frameStepMaxM} m`);
    assert.equal(r.duplicateShots, 0, "each shot presented once");
    assert.equal(r.localShots + r.lateShots, r.serverShots, "predicted or, if the replay moved it, from the echo");
  }
});

test("barn prediction through 300/500/800 ms stalls: bounded, recovers; shots never presented twice", () => {
  for (const ms of [300, 500, 800]) {
    const r = session({ rtt: 70, stall: [3600, ms] }, 11);
    console.log(JSON.stringify(r));
    assert.ok(r.maxPending <= 30, "pending window respected");
    assert.equal(r.duplicateShots, 0);
    assert.equal(r.localShots, r.serverShots, "held fire after the stall still matches");
    if (ms <= 300) assert.equal(r.hard, 0, "a 300 ms stall needs no hard correction");
  }
});
