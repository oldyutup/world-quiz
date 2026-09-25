import assert from "node:assert/strict";
import { before, test } from "node:test";
import { Packr } from "msgpackr";
import { initializePhysics } from "../../../shared/party-lab/simulation/physics";
import { BombRoundSimulation } from "../../../shared/party-lab/simulation/bombRound";
import { BOMB_TAG, BOMB_TICKS } from "../../../shared/party-lab/simulation/bomb/config";
import { BOMB_TRAPS } from "../../../shared/party-lab/maps/bomb";
import { connect, restore } from "../../../shared/party-lab/simulation/ragdoll/character";
import { decodeBombSnapshot, type DecodedBomb } from "../../../shared/party-lab/simulation/bomb/wire";
import { readBombPredictionState } from "../../../shared/party-lab/simulation/predictionState";
import { newRoomCounters } from "../../../shared/party-lab/simulation/online";
import {
  BOMB_PREDICTION_BYTES,
  InputMailbox,
  NET,
  validateBombInput,
  type BombInputPacket,
  type GameSnapshot,
} from "../../../shared/party-lab/network/protocol";
import type { PlayerId } from "../../../shared/party-lab/simulation/players";
import { BombPredictionRig } from "./prediction/bombRig";

before(() => initializePhysics());
const packr = new Packr({ useRecords: false });
const IDLE = [{ x: 0, z: 0, jump: false }, { x: 0, z: 0, jump: false }, { x: 0, z: 0, jump: false }];

function match(slots: PlayerId[] = [0, 1]) {
  const sim = new BombRoundSimulation(newRoomCounters());
  assert.ok(sim.start(slots));
  while (sim.phase === "countdown") sim.step(IDLE);
  return sim;
}
function place(sim: BombRoundSimulation, id: PlayerId, x: number, z: number, y = 0.9) {
  const c = sim.physics.players[id];
  restore(c, { x, y, z }, 0);
  connect(sim.physics.world, c);
}
function poses(snapshot: GameSnapshot) {
  const bytes = snapshot.transforms,
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    out = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}
test("protocol 8 bomb packet is strict intent only and measured", () => {
  assert.equal(NET.version, 8);
  const valid: BombInputPacket = { seq: 12345, round: 3, moveX: -0.7071067811865475, moveZ: 0.7071067811865476, jumpPressed: false, sprintHeld: true, punchPressed: true, viewTick: 765432 };
  assert.ok(validateBombInput(valid));
  for (const claim of [{ target: 1 }, { carrier: 0 }, { transfer: true }, { trap: 2 }, { slowed: true }, { fuse: 99 }, { winner: 0 }])
    assert.equal(validateBombInput({ ...valid, ...claim }), null, `refuses ${Object.keys(claim)[0]}`);
  assert.equal(validateBombInput({ ...valid, viewTick: 2.5 }), null);
  const bytes = packr.pack(valid).byteLength;
  console.log(JSON.stringify({ bombInputBytes: bytes, bombUplinkKBs60Hz: +((bytes * 60) / 1024).toFixed(2) }));
  assert.ok(bytes < 130, `${bytes} B`);
  const box = new InputMailbox();
  assert.ok(box.accept(valid, 3, 10, "bomb_tag"));
  const intent = box.read(11);
  assert.deepEqual([intent.punch, intent.sprint, intent.viewTick], [true, true, valid.viewTick]);
  assert.equal(new InputMailbox().accept({ ...valid, viewTick: undefined }, 3, 0, "bomb_tag"), false);
});

test("countdown, random valid carrier, exact 14 s absolute fuse and recipient prediction", () => {
  const sim = new BombRoundSimulation(newRoomCounters());
  sim.start([0, 2]);
  assert.ok([0, 2].includes(sim.game.bomb.carrier!), "carrier is one of the participants");
  let countdown = 0;
  while (sim.phase === "countdown") { sim.step(IDLE); countdown++; }
  assert.equal(countdown, BOMB_TICKS.countdown);
  sim.step(IDLE);
  const snapshot = sim.snapshot([-1, -1, -1]), section = decodeBombSnapshot(snapshot.bomb)!;
  assert.equal(section.fuseEnd! - section.tick, BOMB_TICKS.fuse - 1);
  assert.equal(snapshot.mode, "bomb_tag");
  assert.equal(snapshot.v, 8);
  const prediction = sim.prediction(0);
  assert.equal(prediction.bomb?.byteLength, BOMB_PREDICTION_BYTES);
  assert.ok(readBombPredictionState(prediction.bomb));
  sim.dispose();
});

test("360-degree authoritative pass chooses nearest, preserves fuse, no-tag-back and third-player pass", () => {
  const sim = match([0, 1, 2]);
  sim.game.bomb.carrier = 0;
  sim.game.bomb.phase = "armed";
  sim.game.bomb.fuse = 80;
  place(sim, 0, 0, 0);
  place(sim, 1, 0, -1.2); // behind the body's spawn facing
  place(sim, 2, 0.85, 0); // side and nearer
  sim.step(IDLE); // captures these poses in the rewind history
  const before = sim.game.bomb.fuse;
  sim.step([{ ...IDLE[0], punch: true, viewTick: sim.tick }, IDLE[1], IDLE[2]]);
  assert.equal(sim.game.bomb.carrier, 2, "nearest valid player in any direction");
  assert.equal(sim.game.bomb.fuse, before - 1, "pass did not refill the fuse");
  assert.equal(sim.game.bomb.immune, 0);
  assert.equal(sim.game.bomb.immuneTicks, BOMB_TICKS.tagBack);
  // Slot 2 cannot immediately return it to 0, but can give it to slot 1.
  place(sim, 1, 0.6, 0);
  place(sim, 0, 0.9, 0);
  sim.game.brawl.fighters[2].punchCooldown = 0;
  sim.step(IDLE);
  sim.step([IDLE[0], IDLE[1], { ...IDLE[2], punch: true, viewTick: sim.tick }]);
  assert.equal(sim.game.bomb.carrier, 1, "third player receives immediately while previous carrier is protected");
  sim.dispose();
});

test("last-moment authoritative passes at 500/250/100 ms and the final pre-blast tick keep the same fuse", () => {
  for (const ticksLeft of [31, 16, 7, 2]) {
    const sim = match([0, 1]);
    sim.game.bomb.carrier = 0;
    sim.game.bomb.phase = "armed";
    sim.game.bomb.fuse = ticksLeft;
    place(sim, 0, 0, 0);
    place(sim, 1, 0, -1);
    sim.step(IDLE);
    sim.game.bomb.fuse = ticksLeft;
    const events = sim.step([{ ...IDLE[0], punch: true, viewTick: sim.tick }, IDLE[1]]);
    assert.equal(sim.game.bomb.carrier, 1, `${ticksLeft - 1} ticks remained after transfer`);
    assert.equal(sim.game.bomb.fuse, ticksLeft - 1, "the fuse burned one tick and was not reset");
    assert.equal(events.filter((event) => event.name === "bombPass").length, 1);
    if (ticksLeft === 2) {
      sim.step(IDLE);
      assert.equal(sim.game.bomb.blasts, 1);
      assert.equal(sim.round.alive[1], false, "the new carrier owns the next-tick blast");
    }
    sim.dispose();
  }
});

test("150 ms conservative tag rewind accepts a recent visible touch but preserves historical wall LOS", () => {
  const accepted = match([0, 1]);
  accepted.game.bomb.carrier = 0;
  accepted.game.bomb.phase = "armed";
  accepted.game.bomb.fuse = 200;
  place(accepted, 0, 0, 0);
  place(accepted, 1, 0, -1.2);
  accepted.step(IDLE);
  const closeTick = accepted.tick;
  place(accepted, 1, 0, -4);
  accepted.step(IDLE);
  accepted.step([{ ...IDLE[0], punch: true, viewTick: closeTick }, IDLE[1]]);
  assert.equal(accepted.game.bomb.carrier, 1, "recent server-known close pose is accepted");
  assert.ok(accepted.rewind.lastMs > 0 && accepted.rewind.lastMs <= NET.maxBombRewindMs);
  accepted.dispose();

  const blocked = match([0, 1]);
  blocked.game.bomb.carrier = 0;
  blocked.game.bomb.phase = "armed";
  blocked.game.bomb.fuse = 200;
  // Opposite sides of the NW pocket wall, 1.1 m apart in the historical frame.
  place(blocked, 0, -6.6, -4.85);
  place(blocked, 1, -6.6, -5.95);
  blocked.step(IDLE);
  const wallTick = blocked.tick;
  // A later current pose cannot make the historical through-wall attempt legal.
  place(blocked, 1, -5.4, -4.85);
  blocked.step(IDLE);
  blocked.step([{ ...IDLE[0], punch: true, viewTick: wallTick }, IDLE[1]]);
  assert.equal(blocked.game.bomb.carrier, 0);
  blocked.dispose();
});

test("online trap authority: exact positions, no damage, 0.50 slow for 1 s, 7 s rearm and no chain", () => {
  const sim = match([0, 1]);
  assert.deepEqual(sim.game.traps.traps.map((t) => [t.x, t.z]), BOMB_TRAPS.map((t) => [t.x, t.z]));
  const trap = BOMB_TRAPS[0];
  place(sim, 0, trap.x, trap.z);
  sim.step(IDLE);
  assert.equal(sim.game.traps.slowed[0], BOMB_TICKS.trapSlow);
  assert.equal(sim.game.traps.traps[0].rearmIn, BOMB_TICKS.trapRearm);
  assert.equal(sim.round.alive[0], true, "trap never damages or eliminates");
  const other = BOMB_TRAPS[1];
  place(sim, 0, other.x, other.z);
  sim.step(IDLE);
  assert.equal(sim.game.traps.traps[1].armed, true, "slowed player cannot spring another armed trap");
  place(sim, 0, 0, 0);
  assert.equal(BOMB_TAG.trap.slow, 0.5);
  for (let i = 0; i < BOMB_TICKS.trapSlow - 1; i++) sim.step(IDLE);
  assert.equal(sim.game.traps.slowed[0], 0, "slow expires after exactly 60 trap ticks");
  for (let i = 0; i < BOMB_TICKS.trapRearm - BOMB_TICKS.trapSlow; i++) sim.step(IDLE);
  assert.equal(sim.game.traps.traps[0].armed, true, "trap rearms at 7 s");
  sim.dispose();
});

test("self-contained compact snapshot restores carrier, fuse, no-tag-back, traps, slows and result state", () => {
  const sim = match([0, 1, 2]);
  sim.game.bomb.carrier = 2;
  sim.game.bomb.phase = "armed";
  sim.game.bomb.fuse = 31;
  sim.game.bomb.immune = 1;
  sim.game.bomb.immuneTicks = 17;
  sim.game.traps.traps[0].armed = false;
  sim.game.traps.traps[0].rearmIn = 333;
  sim.game.traps.slowed[2] = 41;
  const original = sim.snapshot([4, 5, 6]), bytes = packr.pack(original), copy = packr.unpack(bytes) as GameSnapshot;
  const state = decodeBombSnapshot(copy.bomb)!;
  assert.equal(state.carrier, 2);
  assert.equal(state.fuseEnd! - state.tick, 31);
  assert.equal(state.previous, 1);
  assert.equal(state.tagBackEnd! - state.tick, 17);
  assert.equal(state.armedMask & 1, 0);
  assert.equal(state.rearmAt[0] - state.tick, 333);
  assert.equal(state.slowUntil[2] - state.tick, 41);
  console.log(JSON.stringify({ bombSnapshotBytes: bytes.byteLength, bombSectionBytes: packr.pack(original.bomb).byteLength }));
  assert.ok(packr.pack(original.bomb).byteLength < 100, "three traps and all player state stay compact");
  sim.dispose();
});

test("bad-link delivery remains idempotent: delayed clients converge on carrier, fuse and trap ticks", () => {
  const sim = match([0, 1]);
  const links = [50, 100, 150, 300, 500, 800];
  const queues = links.map(() => [] as { due: number; bytes: Uint8Array }[]);
  const seen: (DecodedBomb | null)[] = links.map(() => null);
  let now = 0;
  for (let i = 0; i < 240; i++) {
    now += 1000 / 60;
    sim.step(IDLE);
    if (i % 3 === 0) {
      const bytes = packr.pack(sim.snapshot([-1, -1, -1]).bomb);
      queues.forEach((q, index) => q.push({ due: now + links[index], bytes }));
    }
    queues.forEach((q, index) => {
      while (q[0] && q[0].due <= now) seen[index] = decodeBombSnapshot(packr.unpack(q.shift()!.bytes));
    });
  }
  while (queues.some((q) => q.length)) {
    now += 50;
    queues.forEach((q, index) => { while (q[0] && q[0].due <= now) seen[index] = decodeBombSnapshot(packr.unpack(q.shift()!.bytes)); });
  }
  assert.ok(seen.every(Boolean));
  const final = seen[0]!;
  for (const state of seen.slice(1)) assert.deepEqual(state, final);
  sim.dispose();
});

test("bomb prediction replays authoritative carrier × trap movement without drift", () => {
  const sim = match([0, 1]);
  sim.game.bomb.carrier = 0;
  sim.game.bomb.phase = "armed";
  sim.game.bomb.fuse = 10_000;
  sim.game.traps.slowed[0] = 90;
  place(sim, 0, -6, 0);
  place(sim, 1, 6, 0);
  sim.step(IDLE);
  const snapshot = { ...sim.snapshot([-1, -1, -1]), prediction: sim.prediction(0) };
  const rig = new BombPredictionRig(0);
  assert.ok(rig.restore(snapshot, poses(snapshot)));
  let maxError = 0;
  for (let i = 0; i < 120; i++) {
    const input = { x: 0, z: i < 70 ? 0.55 : 0, jump: i === 45, sprint: true };
    sim.step([input, IDLE[1]]);
    rig.step(input);
    const a = sim.physics.players[0].body.translation(), b = rig.character.body.translation();
    maxError = Math.max(maxError, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
  }
  console.log(JSON.stringify({ bombPredictionCarrierTrapMaxErrorM: +maxError.toFixed(5) }));
  // Snapshot transforms are Float32 while Rapier integrates in full precision. The
  // independent replay should stay within a few centimetres until reconciliation.
  assert.ok(maxError < 0.05, `${maxError} m`);
  rig.dispose();
  sim.dispose();
});

test("server benchmark: 3-player bomb movement, tags, traps and snapshots", () => {
  const sim = match([0, 1, 2]);
  const steps: number[] = [], snapshots: number[] = [], prediction: number[] = [];
  let wireBytes = 0, sectionBytes = 0, count = 0;
  for (let i = 0; i < 60 * 30; i++) {
    // Keep the benchmark in the live phase. Explosion/winner behavior has separate tests.
    sim.game.bomb.phase = "armed";
    sim.game.bomb.fuse = Math.max(sim.game.bomb.fuse, 600);
    const inputs = [0, 1, 2].map((id) => ({
      x: Math.sin(i / 41 + id * 2),
      z: Math.cos(i / 53 + id),
      jump: i % (151 + id * 11) === 0,
      sprint: i % 180 > 70,
      punch: i % (47 + id * 3) === 0,
      viewTick: Math.max(0, sim.tick - 9),
    }));
    const started = performance.now();
    sim.step(inputs);
    steps.push(performance.now() - started);
    if (sim.tick % 3 === 0) {
      const snapStarted = performance.now(), common = sim.snapshot([1, 2, 3]);
      const predictionStarted = performance.now();
      const perClient = [0, 1, 2].map((slot) => ({ ...common, prediction: sim.prediction(slot as PlayerId) }));
      prediction.push(performance.now() - predictionStarted);
      const encoded = perClient.map((value) => packr.pack(value));
      snapshots.push(performance.now() - snapStarted);
      wireBytes += encoded.reduce((sum, bytes) => sum + bytes.byteLength, 0);
      sectionBytes += packr.pack(common.bomb).byteLength;
      count++;
    }
  }
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      avg: +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3),
      p99: +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))].toFixed(3),
      max: +sorted[sorted.length - 1].toFixed(3),
    };
  };
  const report = {
    durationSeconds: 30,
    simStepMs: stats(steps),
    snapshotBuildEncode3Ms: stats(snapshots),
    predictionBuild3Ms: stats(prediction),
    snapshotBytesPerClient: Math.round(wireBytes / count / 3),
    bombSectionBytes: Math.round(sectionBytes / count),
    downstreamKBsPerClient20Hz: +((wireBytes / count / 3 * 20) / 1024).toFixed(2),
    rewind: {
      tags: sim.rewind.tags,
      maxMs: +sim.rewind.maxMs.toFixed(1),
      lookupUsAvg: +((sim.rewind.lookupMs / Math.max(1, sim.rewind.tags)) * 1000).toFixed(2),
    },
  };
  console.log(JSON.stringify(report));
  assert.ok(report.simStepMs.avg < 2, "well inside the 16.7 ms fixed step");
  assert.ok(report.snapshotBytesPerClient < 1_400);
  assert.ok(report.bombSectionBytes < 100);
  sim.dispose();
});
