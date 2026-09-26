import assert from "node:assert/strict";
import { before, test } from "node:test";
import { Packr } from "msgpackr";
import { initializePhysics, IDLE_INPUT } from "../../../shared/party-lab/simulation/physics";
import { PropRoundSimulation, PropRotation } from "../../../shared/party-lab/simulation/propRound";
import { PROP_TICKS } from "../../../shared/party-lab/simulation/prophunt/config";
import { retire } from "../../../shared/party-lab/simulation/layers/game";
import { restore } from "../../../shared/party-lab/simulation/ragdoll/character";
import { reconstructPropLayout } from "../../../shared/party-lab/simulation/prophunt/wire";
import { roundLayout, layoutChange } from "../../../shared/party-lab/maps/propHuntLayout";
import { newRoomCounters } from "../../../shared/party-lab/simulation/online";
import { InputMailbox, NET, PROP_INPUT_BYTES, encodePropInput, validatePropInput, type PropInputPacket } from "../../../shared/party-lab/network/protocol";
import { DEFAULT_PROP_SETTINGS, validPropSettings, validPropSettingsPatch } from "../../../shared/party-lab/propSettings";
import { PropPrediction } from "./prediction/propRig";
import { PROP_FAMILIES, shapeHeight } from "../../../shared/party-lab/maps/propHuntProps";
import type { PlayerId } from "../../../shared/party-lab/simulation/players";
import type { MovementInput } from "../../../shared/party-lab/intent";
before(() => initializePhysics());
const idle = [IDLE_INPUT, IDLE_INPUT, IDLE_INPUT];
const pack = new Packr({ useRecords: false });
const packet = (extra: Partial<PropInputPacket> = {}): PropInputPacket => ({ seq: 1, round: 1, moveX: 0, moveZ: 0, jumpPressed: false, sprintHeld: false, attackPressed: false, attackHeld: false, pickupPressed: false, whistlePressed: false, aimYaw: 0, aimPitch: 0, eyeX: 0, eyeY: 1, eyeZ: 0, viewTick: 0, ...extra });
function match(ammo: 5 | 10 | 15 = 15, proximity = true) {
  const sim = new PropRoundSimulation(); sim.settings = { ammo, proximity }; assert.ok(sim.start([0, 1, 2]));
  sim.round.tick = PROP_TICKS.countdown - 1; sim.step(idle);
  return sim;
}
function search(sim: PropRoundSimulation) { sim.round.tick = PROP_TICKS.hiding - 1; sim.step(idle); }
function wear(sim: PropRoundSimulation, id: PlayerId, x = 5, z = 3) {
  retire(sim.physics.players[id]);
  return sim.game.disguises.wear(id, "crate", { x, y: 0.02, z }, 0);
}
function place(sim: PropRoundSimulation, id: PlayerId, x: number, z: number) { restore(sim.physics.players[id], { x, y: 0.8, z }, 0); }
function shotAt(sim: PropRoundSimulation, at: { x: number; y: number; z: number }) {
  const c = sim.physics.players[sim.round.seeker], p = c.parts.torso.body.translation();
  const dx = at.x - p.x, dy = at.y - p.y, dz = at.z - p.z;
  const b = c.body.translation();
  return { ...IDLE_INPUT, attack: true, facing: Math.atan2(dx, dz), aimPitch: -Math.atan2(dy, Math.hypot(dx, dz)), aimEye: { x: p.x - b.x, y: p.y - b.y, z: p.z - b.z }, viewTick: sim.tick };
}

test("protocol 9: compact 41-byte intent rejects claims, duplicates and malformed flags", () => {
  assert.equal(NET.version, 9); assert.equal(PROP_INPUT_BYTES, 41);
  const p = packet({ pickupPressed: true, attackPressed: true, whistlePressed: true });
  assert.deepEqual(validatePropInput(encodePropInput(p)), p);
  for (const claim of ["family", "target", "winner", "ammo", "proximity", "position", "disguise"]) assert.equal(validatePropInput({ ...p, [claim]: 1 }), null);
  const bytes = encodePropInput(p); bytes[40] = 255; assert.equal(validatePropInput(bytes), null);
  assert.equal(validatePropInput(bytes.subarray(1)), null);
  const box = new InputMailbox(); assert.ok(box.accept(encodePropInput(p), 1, 0, "prop_hunt"));
  assert.equal(box.accept(encodePropInput(p), 1, 1, "prop_hunt"), false);
  const first = box.read(1); assert.ok(first.attack && first.pickup && first.whistle);
  const second = box.read(2); assert.ok(!second.attack && !second.pickup && !second.whistle);
  box.clear(); assert.equal(box.accept(p, 1, 3, "prop_hunt"), false);
});
test("settings only admit 5/10/15 and booleans; defaults are 15/on", () => {
  assert.deepEqual(DEFAULT_PROP_SETTINGS, { ammo: 15, proximity: true });
  assert.ok(validPropSettingsPatch({ ammo: 5 })); assert.ok(validPropSettingsPatch({ proximity: false }));
  for (const invalid of [{}, { ammo: 6 }, { proximity: 0 }, { winner: 1 }]) assert.equal(validPropSettingsPatch(invalid), false);
  for (const ammo of [5, 10, 15]) assert.ok(validPropSettings({ ammo, proximity: false }));
  for (const ammo of [0, 6, 100, "15"]) assert.equal(validPropSettings({ ammo, proximity: true }), false);
  assert.equal(validPropSettings({ ammo: 5, proximity: true, winner: 0 }), false);
});
test("exactly three distinct seats; cancelled countdown preserves seeker and layout index", () => {
  const sim = new PropRoundSimulation();
  for (const seats of [[], [0], [0, 1], [0, 0, 1]]) assert.equal(sim.start(seats as PlayerId[]), false);
  assert.ok(sim.start([2, 0, 1])); const hash = sim.game.layout.id;
  assert.deepEqual(sim.round.roles, ["seeker", "hider", "hider"]);
  sim.cancelCountdown(); assert.ok(sim.start([0, 1, 2]));
  assert.equal(sim.round.seeker, 0); assert.equal(sim.game.layout.id, hash); sim.dispose();
});
test("role rotation survives simulation disposal and Mixed; layouts vary by the approved sequence", () => {
  const rotation = new PropRotation(123), counters = newRoomCounters();
  let previous: ReturnType<typeof roundLayout> | null = null;
  for (let i = 0; i < 7; i++) {
    const sim = new PropRoundSimulation(counters, rotation); sim.start([0, 1, 2]);
    assert.equal(sim.round.seeker, i % 3); sim.round.tick = PROP_TICKS.countdown - 1; sim.step(idle);
    assert.equal(rotation.index, i); const wire = sim.snapshot([-1, -1, -1]).prop!;
    assert.equal(reconstructPropLayout(wire).id, sim.game.layout.id);
    if (previous) assert.ok(layoutChange(previous, sim.game.layout) >= 0.4 && layoutChange(previous, sim.game.layout) <= 0.6);
    previous = sim.game.layout; sim.dispose();
  }
});
test("authoritative 3/15/75/5 phase clocks and post-result survivor reveal", () => {
  const sim = new PropRoundSimulation(); sim.start([0, 1, 2]);
  for (let i = 0; i < 180; i++) sim.step(idle);
  assert.equal(sim.round.phase, "hiding");
  for (let i = 0; i < 900; i++) sim.step(idle);
  assert.equal(sim.round.phase, "search"); assert.deepEqual(sim.snapshot([]).prop?.reveal, []);
  sim.round.tick = PROP_TICKS.search - 1; sim.step(idle);
  assert.equal(sim.round.outcome, "hiders"); assert.equal(sim.game.reveal.length, 2);
  for (let i = 0; i < 300; i++) sim.step(idle);
  assert.equal(sim.phase, "waiting"); sim.dispose();
});
for (const ammo of [5, 10, 15] as const) test(`room ammo ${ammo}: one decrement per edge, no reload, immediate hider result`, () => {
  const sim = match(ammo); search(sim);
  assert.equal(sim.game.ammo, ammo); assert.equal(sim.snapshot([]).prop?.settings.ammo, ammo);
  for (let i = 0; i < ammo; i++) {
    sim.game.shotCooldown = 0;
    sim.step([{ ...IDLE_INPUT, attack: true, aimPitch: -1.2, facing: 0 }, IDLE_INPUT, IDLE_INPUT]);
    assert.equal(sim.game.ammo, ammo - i - 1);
  }
  assert.equal(sim.phase, "results"); assert.equal(sim.round.reason, "ammo"); assert.equal(sim.round.outcome, "hiders"); sim.dispose();
});
test("final available shot finds last disguised hider before zero-ammo result", () => {
  const sim = match(5); search(sim); place(sim, 0, 5, 6);
  const w = wear(sim, 1, 5, 3); sim.round.alive[2] = false; retire(sim.physics.players[2]);
  sim.step(idle); sim.game.ammo = 1;
  const p = w.body.translation(), target = { ...p, y: p.y + shapeHeight(PROP_FAMILIES.crate.shape) / 2 };
  sim.step([shotAt(sim, target), IDLE_INPUT, IDLE_INPUT]);
  assert.equal(sim.game.ammo, 0); assert.equal(sim.round.outcome, "seeker"); assert.equal(sim.round.reason, "found");
  assert.equal(sim.game.reveal.length, 0); sim.dispose();
});
test("manual whistle search-only, separate cooldown, no identity/disguise in emitted wire event", () => {
  const sim = match(); const intent = [IDLE_INPUT, { ...IDLE_INPUT, whistle: true }, IDLE_INPUT];
  sim.step(intent); assert.equal(sim.events.filter(e => e.event.type === "whistle").length, 0);
  search(sim); sim.step(intent);
  const event = sim.events.find(e => e.event.type === "whistle")!;
  assert.deepEqual(Object.keys(event.event).sort(), ["at", "eid", "round", "tick", "type"]);
  assert.equal(sim.game.manualWhistleCooldown[1], 480);
  sim.step(intent); assert.equal(sim.events.filter(e => e.event.type === "whistle").length, 0);
  for (let i = 0; i < 479; i++) sim.step(idle);
  sim.step(intent); assert.equal(sim.game.manualWhistles[1], 2); sim.dispose();
});
test("automatic whistles at 60/45/30/15, staggered 36 ticks, exclude found hiders", () => {
  const sim = match(); search(sim); const heard: number[] = [];
  for (let i = 0; i < 3600 + 36; i++) {
    sim.step(idle); for (const e of sim.events) if (e.event.type === "whistle") heard.push(sim.round.tick);
  }
  assert.deepEqual(heard, [900, 936, 1800, 1836, 2700, 2736, 3600, 3636]); sim.dispose();
});
for (const enabled of [false, true]) test(`proximity ${enabled}: server-owned dwell, generic recipient event, no repetition nearby`, () => {
  const sim = match(15, enabled); search(sim); place(sim, 0, 5, 6); wear(sim, 1, 5, 3); wear(sim, 2, -8, 7);
  let events = 0;
  for (let i = 0; i < 120; i++) { sim.step(idle); for (const e of sim.events) if (e.event.type === "near") { events++; assert.equal(e.recipient, 0); assert.deepEqual(Object.keys(e.event).sort(), ["eid", "round", "tick", "type"]); } }
  assert.equal(events, enabled ? 1 : 0); sim.dispose();
});
test("one snapshot reconnect restores layout, roles, ammo, disguise, cooldown and prediction", () => {
  const sim = match(10, false); search(sim); wear(sim, 1); sim.game.ammo = 7; sim.game.manualWhistleCooldown[1] = 220; sim.game.toggleCooldown[1] = 11;
  const snapshot = sim.snapshot([0, 0, 0]); snapshot.prediction = sim.prediction(1);
  const rig = new PropPrediction(1); assert.ok(rig.accept(snapshot));
  assert.equal(rig.game?.layout.id, sim.game.layout.id); assert.deepEqual(rig.game?.roles, sim.game.roles);
  assert.equal(rig.game?.ammo, 7); assert.equal(rig.game?.disguiseOf(1)?.family, "crate"); assert.equal(rig.game?.manualWhistleCooldown[1], 220);
  assert.equal(rig.game?.toggleCooldown[1], 11); assert.equal(rig.game?.proximityEnabled, false);
  assert.throws(() => reconstructPropLayout({ ...snapshot.prop!, hash: "bad" }));
  assert.throws(() => reconstructPropLayout({ ...snapshot.prop!, families: 0 }));
  rig.dispose(); sim.dispose();
});
test("disguise prediction reproduces authoritative 2.3 m/s movement without sprint/jump or client transforms", () => {
  const sim = match(); search(sim); wear(sim, 1, 5, 3);
  const snapshot = sim.snapshot([0, 0, 0]); snapshot.prediction = sim.prediction(1); const rig = new PropPrediction(1); rig.accept(snapshot);
  const input: MovementInput = { x: 1, z: 0, jump: true, sprint: true, pickup: true, whistle: true };
  for (let i = 1; i <= 25; i++) {
    sim.step([IDLE_INPUT, { ...input, pickup: false, whistle: false }, IDLE_INPUT]);
    rig.step(input, packet({ seq: i, moveX: 1 }));
  }
  const a = sim.game.disguiseOf(1)!, b = rig.game!.disguiseOf(1)!;
  assert.equal(b.family, "crate"); assert.ok(Math.hypot(a.body.translation().x - b.body.translation().x, a.body.translation().z - b.body.translation().z) < 0.05);
  assert.ok(Math.hypot(b.vx, b.vz) <= 2.30001); rig.dispose(); sim.dispose();
});
test("leave seeker awards hiders; leave both hiders awards seeker; disconnect neutralization preserves state", () => {
  const sim = match(); search(sim); wear(sim, 1); const hash = sim.game.layout.id;
  sim.neutralize(1); assert.ok(sim.game.disguiseOf(1)); assert.equal(sim.game.layout.id, hash);
  sim.remove(1); assert.equal(sim.phase, "playing"); sim.remove(2); assert.equal(sim.round.outcome, "seeker"); sim.dispose();
  const other = match(); other.remove(0); assert.equal(other.round.outcome, "hiders"); assert.equal(other.round.reason, "forfeit"); other.dispose();
});
test("server benchmark: three players, snapshots, bounded rewind and measured wire size", () => {
  const sim = match(); search(sim); wear(sim, 1); wear(sim, 2, -8, 7);
  const times: number[] = [], builds: number[] = []; let bytes = 0;
  for (let i = 0; i < 1800; i++) {
    const start = performance.now(); sim.step(idle); times.push(performance.now() - start);
    if (i % 3 === 0) { const t = performance.now(); const snap = sim.snapshot([i, i, i]); snap.prediction = sim.prediction(0); bytes = pack.pack(snap).byteLength; builds.push(performance.now() - t); }
  }
  const stats = (values: number[]) => ({ avg: values.reduce((a, b) => a + b, 0) / values.length, p99: values.sort((a, b) => a - b)[Math.floor(values.length * .99)] });
  console.log(JSON.stringify({ propPerformance: { step: stats(times), snapshot: stats(builds), inputBytes: 41, snapshotBytes: bytes, upKBs: 41 * 60 / 1024, downKBs: bytes * 20 / 1024, rewindCapMs: NET.maxPropRewindMs } }));
  assert.ok(bytes < 2500); sim.dispose();
});

test("rewind uses a server historical moving disguise, capped at 150 ms", () => {
  const sim = match(); search(sim); place(sim, 0, 5, 6);
  const w = wear(sim, 1, 5, 3);
  for (let i = 0; i < 12; i++) sim.step(idle);
  const viewed = sim.tick, at = w.body.translation();
  const input = shotAt(sim, { ...at, y: at.y + shapeHeight(PROP_FAMILIES.crate.shape) / 2 });
  w.body.setTranslation({ x: 6.5, y: at.y, z: at.z }, true);
  w.body.setNextKinematicTranslation({ x: 6.5, y: at.y, z: at.z });
  for (let i = 0; i < 5; i++) sim.step(idle);
  sim.step([{ ...input, viewTick: viewed }, IDLE_INPUT, IDLE_INPUT]);
  assert.equal(sim.round.alive[1], false);
  assert.equal(sim.rewind.lastMs, 100);
  assert.ok(sim.rewind.maxMs <= 150); sim.dispose();
});
test("rewind clamps old claims, rejects future claims, and cannot hit an eliminated pose", () => {
  const sim = match(); search(sim); place(sim, 0, 5, 6); wear(sim, 1, 5, 3);
  for (let i = 0; i < 20; i++) sim.step(idle);
  sim.step([{ ...IDLE_INPUT, attack: true, aimPitch: -1.2, viewTick: -1000 }, IDLE_INPUT, IDLE_INPUT]);
  assert.equal(sim.rewind.lastMs, 150); assert.equal(sim.rewind.clampedOld, 1);
  sim.game.shotCooldown = 0;
  sim.step([{ ...IDLE_INPUT, attack: true, aimPitch: -1.2, viewTick: sim.tick + 100 }, IDLE_INPUT, IDLE_INPUT]);
  assert.equal(sim.rewind.rejectedFuture, 1);
  sim.round.alive[1] = false; sim.game.disguises.remove(1); sim.game.shotCooldown = 0;
  sim.step([{ ...shotAt(sim, { x: 5, y: .5, z: 3 }), viewTick: sim.tick - 5 }, IDLE_INPUT, IDLE_INPUT]);
  assert.notEqual(sim.game.events.find(e => e.type === "shot")?.hit, "hider");
  sim.dispose();
});
test("rewind retains present architecture occlusion and does not cross a disguise boundary", () => {
  const sim = match(); search(sim); place(sim, 0, 3, -7); wear(sim, 1, .8, -7);
  for (let i = 0; i < 12; i++) sim.step(idle);
  sim.step([{ ...shotAt(sim, { x: .8, y: .5, z: -7 }), viewTick: sim.tick - 5 }, IDLE_INPUT, IDLE_INPUT]);
  assert.equal(sim.round.alive[1], true); assert.equal(sim.game.events.find(e => e.type === "shot")?.hit, "world");
  place(sim, 0, 5, 6); const w = wear(sim, 1, 5, 3);
  for (let i = 0; i < 10; i++) sim.step(idle);
  const at = w.body.translation(), viewTick = sim.tick;
  sim.game.disguises.wear(1, "barrel", { x: 6.5, y: at.y, z: at.z }, 0); sim.game.shotCooldown = 0;
  sim.step([{ ...shotAt(sim, { x: 5, y: .5, z: 3 }), viewTick }, IDLE_INPUT, IDLE_INPUT]);
  assert.equal(sim.round.alive[1], true); sim.dispose();
});
