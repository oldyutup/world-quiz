import assert from "node:assert/strict";
import { before, test } from "node:test";
import { Packr } from "msgpackr";
import { initializePhysics } from "../../../shared/party-lab/simulation/physics";
import { BarnRoundSimulation, BARN_MATCH, MAX_REWIND_TICKS } from "../../../shared/party-lab/simulation/barnRound";
import { OnlineRoundSimulation } from "../../../shared/party-lab/simulation/onlineRound";
import { newRoomCounters } from "../../../shared/party-lab/simulation/online";
import { connect, restore } from "../../../shared/party-lab/simulation/ragdoll/character";
import { newWeapon } from "../../../shared/party-lab/simulation/barn/weapons";
import { BARN_COMBAT } from "../../../shared/party-lab/simulation/barn/config";
import { WEAPON_SPOTS, TRAPS, SPAWN_CANDIDATES } from "../../../shared/party-lab/maps/barn";
import { readBarnPredictionState } from "../../../shared/party-lab/simulation/predictionState";
import {
  BARN_FIGHTER_FIELDS,
  BARN_FLAG,
  InputMailbox,
  NET,
  validateBarnInput,
  validateInput,
  type BarnInputPacket,
  type GameEvent,
} from "../../../shared/party-lab/network/protocol";
import type { PlayerId } from "../../../shared/party-lab/simulation/players";

before(() => initializePhysics());
const packr = new Packr({ useRecords: false });
const seeded = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) | 0) >>> 0) / 4294967296;
type P = { x: number; y: number; z: number };

/** An authoritative barn round in play, with one mailbox per slot and the room's cadence. */
function match(slots: PlayerId[] = [0, 1], seed = 1) {
  const sim = new BarnRoundSimulation(newRoomCounters(), seeded(seed));
  assert.ok(sim.start(slots));
  const boxes = [new InputMailbox(), new InputMailbox(), new InputMailbox()];
  const seq = [0, 0, 0];
  let now = 0;
  const events: GameEvent[] = [];
  const step = (packets: (Partial<BarnInputPacket> | null)[] = []) => {
    now += 1000 / NET.physicsHz;
    packets.forEach((p, id) => {
      if (!p) return;
      const packet = { ...base(id), ...p };
      assert.ok(boxes[id].accept(packet, sim.roundId, now, "barn_shootout"), "valid barn packet accepted");
    });
    const out = sim.step(boxes.map((b) => b.read(now)));
    events.push(...out);
    // The room sends a snapshot every third tick; a client cannot view a later tick.
    if (sim.tick % (NET.physicsHz / NET.snapshotHz) === 0) sim.snapshot([-1, -1, -1]);
    return out;
  };
  const base = (id: number): BarnInputPacket => ({
    seq: ++seq[id],
    round: sim.roundId,
    moveX: 0,
    moveZ: 0,
    jumpPressed: false,
    sprintHeld: false,
    attackPressed: false,
    attackHeld: false,
    pickupPressed: false,
    aimYaw: sim.physics.players[id].facing,
    aimPitch: 0,
    eyeX: 0,
    eyeY: 1.05,
    eyeZ: 0,
    viewTick: Math.max(0, sim.tick - 1),
  });
  while (sim.phase === "countdown") step();
  assert.equal(sim.phase, "playing");
  return { sim, step, events, boxes };
}
/** Stand a character on a floor point facing `yaw`, unprotected. */
function place(sim: BarnRoundSimulation, id: PlayerId, at: P, yaw: number) {
  const c = sim.physics.players[id];
  restore(c, { x: at.x, y: at.y + 1.6, z: at.z }, yaw);
  connect(sim.physics.world, c);
  sim.barn.fighters[id].protection = 0;
}
/** Aim from the shooter's own torso at a point (the eye point is the torso, well inside the bound). */
function aimAt(sim: BarnRoundSimulation, id: PlayerId, target: P): Partial<BarnInputPacket> {
  const c = sim.physics.players[id],
    p = c.body.translation(),
    t = c.parts.torso.body.translation();
  const dx = target.x - t.x,
    dy = target.y - t.y,
    dz = target.z - t.z,
    d = Math.hypot(dx, dy, dz);
  return { aimYaw: Math.atan2(dx, dz), aimPitch: -Math.asin(dy / d), eyeX: t.x - p.x, eyeY: t.y - p.y, eyeZ: t.z - p.z };
}
const torsoAt = (sim: BarnRoundSimulation, tick: number, id: PlayerId): P => {
  const f = sim.history.frame(tick)!;
  const o = id * 63 + 7;
  return { x: f.poses[o], y: f.poses[o + 1], z: f.poses[o + 2] };
};
const still = (sim: BarnRoundSimulation, id: PlayerId): Partial<BarnInputPacket> => ({ aimYaw: sim.physics.players[id].facing });
const fighterField = (sim: BarnRoundSimulation, id: number, field: number) => sim.snapshot([-1, -1, -1]).barn!.f[id * BARN_FIGHTER_FIELDS + field];

// ─── Protocol ───────────────────────────────────────────────────────────────

test("barn packet: intent only — strict keys, finite values, clamped movement/aim; target/damage/result fields are rejected", () => {
  const good: BarnInputPacket = {
    seq: 1,
    round: 1,
    moveX: 3,
    moveZ: 4,
    jumpPressed: false,
    sprintHeld: true,
    attackPressed: true,
    attackHeld: true,
    pickupPressed: false,
    aimYaw: 7,
    aimPitch: 3,
    eyeX: 0.1,
    eyeY: 9,
    eyeZ: 0,
    viewTick: 120.5,
  };
  const v = validateBarnInput(good)!;
  assert.ok(Math.abs(Math.hypot(v.moveX, v.moveZ) - 1) < 1e-9, "diagonal clamped to 1");
  assert.ok(Math.abs(v.aimYaw - Math.atan2(Math.sin(7), Math.cos(7))) < 1e-12, "yaw normalised like the client");
  assert.equal(v.aimPitch, 1.2);
  assert.equal(v.eyeY, 4);
  for (const extra of [{ target: 1 }, { damage: 100 }, { hit: true }, { kill: 2 }, { hp: 0 }, { pickupWinner: 0 }, { slot: 1 }])
    assert.equal(validateBarnInput({ ...good, ...extra }), null, `rejects ${Object.keys(extra)[0]}`);
  for (const bad of [{ viewTick: -1 }, { viewTick: NaN }, { aimYaw: Infinity }, { attackPressed: 1 }, { seq: 1.5 }, { round: 0 }])
    assert.equal(validateBarnInput({ ...good, ...bad }), null);
  const { viewTick: _, ...missing } = good;
  assert.equal(validateBarnInput(missing), null);
  // Mode-specific: a rooftop packet is not a barn packet and vice versa.
  assert.equal(validateBarnInput({ seq: 1, round: 1, moveX: 0, moveZ: 0, jumpPressed: false, punchPressed: false, grabHeld: false, liftHeld: false }), null);
  assert.equal(validateInput(good), null);
  const box = new InputMailbox();
  assert.ok(!box.accept(good, 1, 0, "rooftop_brawl"), "a barn packet in a rooftop round is refused");
  assert.ok(box.accept(good, 1, 0, "barn_shootout"));
  const read = box.read(1);
  assert.equal(read.attack, true);
  assert.equal(read.sprint, true);
  assert.equal(read.viewTick, 120.5, "the attack edge keeps the view of the packet that carried it");
  assert.equal(box.read(2).attack, false, "edges are consumed once");
});

// ─── Authority: weapons, punches, traps, pickups ────────────────────────────

test("online SMG: exactly 10 rounds, then gone; 7 comparable hits leave 2 HP, the 8th kills", () => {
  const { sim, step } = match([0, 1], 3);
  place(sim, 0, { x: 13.5 - 6, y: 0, z: -1 }, Math.PI / 2);
  place(sim, 1, { x: 13.5, y: 0, z: -1 }, -Math.PI / 2);
  for (let i = 0; i < 60; i++) step([still(sim, 0), still(sim, 1)]);
  sim.barn.fighters[0].weapon = newWeapon("smg");
  const hits: number[] = [];
  let shots = 0;
  // Tap fire, like the local test: one press per round, the spread recovers in between.
  for (let round = 0; round < 12; round++) {
    const target = sim.physics.players[1].parts.torso.body.translation();
    const before = sim.barn.fighters[1].hp;
    const out = step([{ ...aimAt(sim, 0, target), attackPressed: true, attackHeld: false }, still(sim, 1)]);
    shots += out.filter((e) => e.name === "smgFire").length;
    if (sim.barn.fighters[1].hp < before) hits.push(sim.barn.fighters[1].hp);
    for (let i = 0; i < 20; i++) step([{ ...aimAt(sim, 0, target) }, still(sim, 1)]);
    if (!sim.barn.fighters[1].alive) break;
  }
  assert.deepEqual(hits.slice(0, 8), [86, 72, 58, 44, 30, 16, 2, 0], "14 HP per round: 7 hits → 2 HP, the 8th kills");
  assert.equal(sim.barn.fighters[1].alive, false);
  assert.equal(sim.barn.fighters[0].kills, 1, "kill credited to the shooter");
  assert.equal(shots, 8);
  // Two rounds left; then gone.
  sim.barn.fighters[1].alive = true;
  for (let i = 0; i < 4; i++) {
    step([{ attackPressed: true, aimYaw: sim.physics.players[0].facing }, null]);
    for (let k = 0; k < 10; k++) step([still(sim, 0), null]);
  }
  assert.equal(sim.barn.fighters[0].weapon, null, "10 rounds, then the SMG is gone");
  assert.equal(sim.barn.stats.shots, 10);
});

test("online shotgun: one shell, 8 pellets; a centred 2 m shot kills from 100 HP and the weapon disappears", () => {
  const { sim, step, events } = match([0, 1], 5);
  place(sim, 0, { x: 13.5 - 2, y: 0, z: -1 }, Math.PI / 2);
  place(sim, 1, { x: 13.5, y: 0, z: -1 }, -Math.PI / 2);
  for (let i = 0; i < 60; i++) step([still(sim, 0), still(sim, 1)]);
  sim.barn.fighters[0].weapon = newWeapon("shotgun");
  const target = sim.physics.players[1].parts.torso.body.translation();
  step([{ ...aimAt(sim, 0, target), attackPressed: true }, still(sim, 1)]);
  const fire = events.filter((e) => e.name === "shotgunFire");
  assert.equal(fire.length, 1);
  assert.equal(fire[0].barn?.struck?.length, 8, "server traced all 8 pellets");
  assert.equal(fire[0].barn?.ends?.length, 24);
  assert.equal(sim.barn.fighters[1].alive, false, "8 × 15 = 120 at 2 m");
  assert.equal(sim.barn.fighters[0].weapon, null, "one shell, then gone");
  const hit = events.find((e) => e.name === "bulletHit")!;
  assert.equal(hit.actor, 0);
  assert.equal(hit.target, 1);
  assert.equal(hit.barn?.killed, true);
  // The next press (after a release: a held button is one press) is a punch, not a shot.
  step([{ aimYaw: sim.physics.players[0].facing }, null]);
  step([{ attackPressed: true, aimYaw: sim.physics.players[0].facing }, null]);
  assert.equal(sim.barn.stats.shots, 1);
  assert.equal(sim.barn.stats.punches, 1);
});

test("online punch: unarmed attack is the physical arm strike — 12 HP on real contact, 0.5 s apart, no knockout", () => {
  const { sim, step } = match([0, 1], 7);
  place(sim, 0, { x: 12.7, y: 0, z: -1 }, Math.PI / 2);
  place(sim, 1, { x: 13.5, y: 0, z: -1 }, -Math.PI / 2);
  for (let i = 0; i < 60; i++) step([still(sim, 0), still(sim, 1)]);
  const hp: number[] = [];
  let swings = 0;
  for (let i = 0; i < 6; i++) {
    const out = step([{ attackPressed: true, aimYaw: Math.PI / 2 }, still(sim, 1)]);
    swings += out.filter((e) => e.name === "punchSwing").length;
    for (let k = 0; k < 35; k++) step([{ aimYaw: Math.PI / 2 }, still(sim, 1)]);
    hp.push(sim.barn.fighters[1].hp);
  }
  assert.equal(swings, 6);
  const landed = hp.map((h, i) => (i === 0 ? 100 : hp[i - 1]) - h).filter((d) => d > 0);
  assert.ok(landed.length >= 3, `landed ${landed.length}/6`);
  assert.ok(landed.every((d) => d === 12), "12 HP per landed punch");
  assert.ok(sim.barn.fighters[1].alive);
  // Presses faster than the 0.5 s cooldown do not start a new punch.
  const before = sim.barn.stats.punches;
  for (let i = 0; i < 10; i++) step([{ attackPressed: i % 2 === 0, aimYaw: Math.PI / 2 }, still(sim, 1)]);
  assert.equal(sim.barn.stats.punches - before, 1);
});

test("online bear trap: server-detected, 25 HP, 1.1 s movement hold while aiming/firing still work, rearms after 10 s", () => {
  const { sim, step } = match([0, 1], 9);
  const trap = TRAPS.T1;
  place(sim, 0, { x: trap.x - 1.6, y: 0, z: trap.z }, Math.PI / 2);
  place(sim, 1, { x: -13, y: 0, z: -1 }, Math.PI / 2);
  for (let i = 0; i < 30; i++) step([still(sim, 0), still(sim, 1)]);
  let snapped = -1;
  for (let i = 0; i < 90 && snapped < 0; i++) {
    step([{ moveX: 1, aimYaw: Math.PI / 2 }, still(sim, 1)]);
    if (sim.barn.fighters[0].trapped > 0) snapped = sim.tick;
  }
  assert.ok(snapped > 0, "walking over the trap springs it");
  assert.equal(sim.barn.fighters[0].hp, 75);
  const at = { ...sim.physics.players[0].body.translation() };
  sim.barn.fighters[0].weapon = newWeapon("smg");
  let fired = 0;
  for (let i = 0; i < 50; i++) {
    const out = step([{ moveX: 1, jumpPressed: i === 5, aimYaw: -Math.PI / 2, attackHeld: true, attackPressed: i === 0 }, still(sim, 1)]);
    fired += out.filter((e) => e.name === "smgFire").length;
  }
  const b = sim.physics.players[0].body.translation();
  assert.ok(Math.hypot(b.x - at.x, b.z - at.z) < 0.25, `held in place (${Math.hypot(b.x - at.x, b.z - at.z).toFixed(2)} m)`);
  assert.ok(fired >= 4, "can still fire while trapped");
  assert.ok(Math.abs(sim.physics.players[0].facing - -Math.PI / 2) < 0.2, "can still aim while trapped");
  const t = sim.barn.traps.find((x) => x.id === "T1")!;
  assert.equal(t.armed, false);
  for (let i = 0; i < 60 * 10; i++) step([still(sim, 0), still(sim, 1)]);
  assert.equal(t.armed, true, "rearmed after 10 s");
});

test("pickups: 2 active for a duel, 3 for three players; contested request goes to the nearer player, an exact tie at random", () => {
  assert.equal(match([0, 1], 11).sim.barn.pickups.active.length, 2);
  assert.equal(match([0, 1, 2], 11).sim.barn.pickups.active.length, 3);
  const kinds = new Set(match([0, 1], 12).sim.barn.pickups.active.map((p) => p.kind));
  assert.equal(kinds.size, 2, "a duel starts with both weapon kinds");
  const winners: number[] = [];
  for (const [seed, offsets] of [
    [21, [0.4, 0.8]],
    [22, [0.8, 0.4]],
    [23, [0.6, 0.6]],
    [24, [0.6, 0.6]],
    [25, [0.6, 0.6]],
    [26, [0.6, 0.6]],
  ] as const) {
    const { sim, step } = match([0, 1], seed);
    sim.barn.pickups.active.splice(0, sim.barn.pickups.active.length, { spot: "W4", kind: "smg" });
    const s = WEAPON_SPOTS.W4;
    // Requests are resolved before the physics step, so freshly placed bodies are exactly
    // at these distances (a settled ragdoll is never perfectly symmetric).
    place(sim, 0, { x: s.x - offsets[0], y: 0, z: s.z - 0.2 }, Math.PI / 2);
    place(sim, 1, { x: s.x + offsets[1], y: 0, z: s.z - 0.2 }, -Math.PI / 2);
    step([{ pickupPressed: true, aimYaw: Math.PI / 2 }, { pickupPressed: true, aimYaw: -Math.PI / 2 }]);
    const holders = sim.barn.fighters.filter((f) => f.weapon).map((f) => f.id);
    assert.equal(holders.length, 1, "exactly one player gets the contested weapon");
    winners.push(holders[0]);
    assert.equal(sim.barn.pickups.active.length, 0);
    assert.equal(sim.barn.pickups.pending.length, 1, "a replacement is scheduled");
  }
  assert.equal(winners[0], 0, "nearer (0.4 m) beats 0.8 m");
  assert.equal(winners[1], 1);
  assert.ok(new Set(winners.slice(2)).size === 2, `exact ties are not always slot 0: ${winners.slice(2)}`);
});

test("replacement: ~4 s after pickup, telegraphed ~0.8 s, never the emptied spot, clear of living players", () => {
  const { sim, step } = match([0, 1], 31);
  const first = sim.barn.pickups.active[0];
  const s = WEAPON_SPOTS[first.spot as keyof typeof WEAPON_SPOTS];
  place(sim, 0, { x: s.x + 0.3, y: s.y, z: s.z + 0.3 }, 0);
  for (let i = 0; i < 30; i++) step([still(sim, 0), still(sim, 1)]);
  step([{ pickupPressed: true, aimYaw: sim.physics.players[0].facing }, still(sim, 1)]);
  assert.ok(sim.barn.fighters[0].weapon);
  let telegraphAt = -1,
    appearedAt = -1;
  const taken = sim.tick;
  for (let i = 0; i < 60 * 5 && appearedAt < 0; i++) {
    step([still(sim, 0), still(sim, 1)]);
    const snap = sim.snapshot([-1, -1, -1]).barn!;
    if (telegraphAt < 0 && snap.t.length) telegraphAt = sim.tick;
    if (sim.barn.pickups.active.length === 2) appearedAt = sim.tick;
  }
  assert.ok(Math.abs((appearedAt - taken) / 60 - BARN_COMBAT.pickups.replace) < 0.05, `appeared after ${((appearedAt - taken) / 60).toFixed(2)} s`);
  assert.ok(Math.abs((appearedAt - telegraphAt) / 60 - BARN_COMBAT.pickups.telegraph) < 0.05, "telegraphed ~0.8 s early");
  const fresh = sim.barn.pickups.active.find((p) => p !== sim.barn.pickups.active[0] || p.spot !== first.spot)!;
  assert.notEqual(sim.barn.pickups.active[1].spot, first.spot, "not the emptied spot");
  assert.ok(fresh);
});

test("kill credit: a trap death within 3 s of being shot is the shooter's kill; later it is nobody's", () => {
  for (const [delay, credited] of [
    [1.5, true],
    [3.6, false],
  ] as const) {
    const { sim, step } = match([0, 1], 41);
    const trap = TRAPS.T1;
    place(sim, 1, { x: trap.x - 1.6, y: 0, z: trap.z }, Math.PI / 2);
    place(sim, 0, { x: trap.x - 1.6, y: 0, z: trap.z - 3.5 }, 0);
    for (let i = 0; i < 40; i++) step([still(sim, 0), still(sim, 1)]);
    sim.barn.fighters[0].weapon = newWeapon("smg");
    sim.barn.fighters[1].hp = 30;
    step([{ ...aimAt(sim, 0, sim.physics.players[1].parts.torso.body.translation()), attackPressed: true }, still(sim, 1)]);
    assert.equal(sim.barn.fighters[1].hp, 16, "shot to 16 HP");
    for (let i = 0; i < delay * 60; i++) step([still(sim, 0), still(sim, 1)]);
    for (let i = 0; i < 90 && sim.barn.fighters[1].alive; i++) step([still(sim, 0), { moveX: 1, aimYaw: Math.PI / 2 }]);
    assert.equal(sim.barn.fighters[1].alive, false, "the trap finished them");
    assert.equal(sim.barn.fighters[1].deaths, 1);
    assert.equal(sim.barn.fighters[0].kills, credited ? 1 : 0, `${delay} s after the hit`);
  }
});

test("death and respawn online: weapon removed, body stays ~2 s and ignores bullets, respawn 100 HP unarmed and protected ~1 s", () => {
  const { sim, step, events } = match([0, 1], 51);
  place(sim, 0, { x: 7.5, y: 0, z: -1 }, Math.PI / 2);
  place(sim, 1, { x: 13.5, y: 0, z: -1 }, -Math.PI / 2);
  for (let i = 0; i < 40; i++) step([still(sim, 0), still(sim, 1)]);
  sim.barn.fighters[1].weapon = newWeapon("shotgun");
  sim.barn.fighters[1].hp = 10;
  sim.barn.fighters[0].weapon = newWeapon("smg");
  step([{ ...aimAt(sim, 0, sim.physics.players[1].parts.torso.body.translation()), attackPressed: true }, still(sim, 1)]);
  const dead = sim.barn.fighters[1];
  assert.equal(dead.alive, false);
  assert.equal(dead.weapon, null, "weapon removed at death");
  assert.equal(fighterField(sim, 1, 0) & BARN_FLAG.present, BARN_FLAG.present, "the body stays in the world");
  // Dead bodies ignore bullets, cannot attack, pick up or trigger traps.
  const shotsBefore = sim.barn.stats.hits;
  step([{ ...aimAt(sim, 0, sim.physics.players[1].parts.torso.body.translation()), attackPressed: true }, { attackPressed: true, pickupPressed: true }]);
  assert.equal(sim.barn.stats.hits, shotsBefore, "no hit on a dead body");
  let respawnTick = -1;
  const diedAt = sim.tick;
  for (let i = 0; i < 60 * 3 && respawnTick < 0; i++) {
    step([still(sim, 0), null]);
    if (dead.alive) respawnTick = sim.tick;
  }
  assert.ok(Math.abs((respawnTick - diedAt) / 60 - BARN_COMBAT.death.respawn) < 0.05, "respawn ~2 s later");
  assert.equal(dead.hp, 100);
  assert.equal(dead.weapon, null);
  assert.ok(dead.protection > 0.9 && dead.protection <= 1, "~1 s protection");
  assert.ok(events.some((e) => e.name === "respawn" && e.actor === 1));
  assert.equal(dead.life, 1, "a new life for lag compensation");
});

test("respawn choice: away from living enemies and out of their sight when possible, not the last spot, never fails", () => {
  const { sim, step } = match([0, 1, 2], 61);
  for (let i = 0; i < 20; i++) step();
  const picks: string[] = [];
  for (let trial = 0; trial < 12; trial++) {
    const s = Object.values(SPAWN_CANDIDATES)[trial % 6];
    place(sim, 1, { x: s.x + 0.8, y: s.y, z: s.z }, 0);
    place(sim, 2, { x: 0, y: 0, z: 8 }, 0);
    for (let i = 0; i < 5; i++) step();
    const f = sim.barn.fighters[0];
    const spawn = sim.barn.chooseSpawn(0);
    picks.push(spawn.id);
    for (const enemy of [1, 2] as const) {
      const e = sim.physics.players[enemy].body.translation();
      assert.ok(Math.hypot(e.x - spawn.x, (e.y - 0.78 - spawn.y) * 1.5, e.z - spawn.z) >= BARN_COMBAT.respawn.clearance, `${spawn.id} ≥ 6 m from enemy ${enemy}`);
    }
    f.home = spawn;
  }
  for (let i = 1; i < picks.length; i++) assert.ok(new Set(picks).size >= 2, "varies");
});

// ─── Match rules ────────────────────────────────────────────────────────────

test("match: 3 s countdown, 150 s of play, most kills wins, a tie is a draw; a leaver forfeits", () => {
  const { sim, step, events } = match([0, 1], 71);
  assert.equal(sim.seconds, BARN_MATCH.duration);
  sim.barn.fighters[1].kills = 2;
  sim.barn.fighters[0].kills = 1;
  for (let i = 0; i < 60 * BARN_MATCH.duration && sim.phase === "playing"; i++) step();
  assert.equal(sim.phase, "results");
  assert.equal(sim.winner, 1);
  assert.equal(sim.reason, "timeout");
  assert.ok(events.some((e) => e.name === "winner"));
  const phase = () => sim.phase as string;
  for (let i = 0; i < 60 * 4 && phase() !== "waiting"; i++) step();
  assert.equal(phase(), "waiting");
  const draw = match([0, 1], 72).sim;
  draw.barn.fighters[0].kills = draw.barn.fighters[1].kills = 3;
  for (let i = 0; i < 60 * BARN_MATCH.duration + 2 && draw.phase === "playing"; i++) draw.step([]);
  assert.equal(draw.winner, -1, "tie → draw");
  const left = match([0, 1, 2], 73).sim;
  left.barn.fighters[2].kills = 5;
  left.remove(2);
  assert.equal(left.phase, "playing", "two remain: play on");
  left.remove(1);
  assert.equal(left.phase, "results");
  assert.equal(left.reason, "forfeit");
  assert.equal(left.winner, 0, "the last player in the room wins a forfeit");
});

// ─── Lag compensation ───────────────────────────────────────────────────────

/**
 * Shooter in the north wing, target strafing across at walking speed ~4 m away. The
 * client aims at where it drew the target (`view` ticks ago) and says so; the server
 * resolves the shot against that tick's hit volumes.
 */
function strafingTarget(seed: number) {
  const m = match([0, 1], seed);
  const { sim, step } = m;
  // Where the target's torso was after each tick (the client's drawn poses).
  const drawn = new Map<number, P>();
  const run = (packets: (Partial<BarnInputPacket> | null)[]) => {
    const out = step(packets);
    drawn.set(sim.tick, { ...sim.physics.players[1].parts.torso.body.translation() });
    return out;
  };
  place(sim, 0, { x: 0.5, y: 0, z: -9.3 }, Math.PI);
  place(sim, 1, { x: -4, y: 0, z: -13.3 }, 0);
  for (let i = 0; i < 40; i++) run([{ aimYaw: Math.PI }, { aimYaw: 0 }]);
  sim.barn.fighters[0].weapon = newWeapon("smg");
  sim.barn.fighters[1].protection = 0;
  // Sprinting across the shooter's view (~6.4 m/s), at full speed for the last 30+ ticks.
  for (let i = 0; i < 48; i++) run([{ aimYaw: Math.PI }, { moveX: 1, sprintHeld: true, aimYaw: 0 }]);
  return { ...m, run, drawn };
}
function laggedShot(seed: number, back: number, claimed = back) {
  const { sim, run, drawn } = strafingTarget(seed);
  const latest = sim.history.latest;
  const seen = latest - back;
  const lo = drawn.get(Math.floor(seen))!,
    hi = drawn.get(Math.ceil(seen))!;
  const t = seen - Math.floor(seen);
  const point = { x: lo.x + (hi.x - lo.x) * t, y: lo.y + (hi.y - lo.y) * t, z: lo.z + (hi.z - lo.z) * t };
  const now = sim.physics.players[1].parts.torso.body.translation();
  const moved = Math.hypot(now.x - point.x, now.z - point.z);
  const before = sim.barn.fighters[1].hp;
  run([{ ...aimAt(sim, 0, point), attackPressed: true, viewTick: Math.max(0, latest - claimed) }, { moveX: 1, sprintHeld: true, aimYaw: 0 }]);
  return { hit: sim.barn.fighters[1].hp < before, moved, rewind: { ...sim.rewind } };
}

test("lag compensation: shots at the drawn target hit at 50/100/150 ms RTT (+100 ms interpolation) and with jitter; unrewound they miss", () => {
  const cases = [
    { label: "RTT 0", back: 6 },
    { label: "RTT 50", back: 9 },
    { label: "RTT 100", back: 12 },
    { label: "RTT 100 + jitter", back: 13.4 },
    { label: "RTT 150 (limit)", back: MAX_REWIND_TICKS },
  ];
  for (const [i, c] of cases.entries()) {
    const r = laggedShot(100 + i, c.back);
    console.log(JSON.stringify({ case: c.label, rewindMs: Math.round(r.rewind.lastMs), targetMovedSinceMs: +(r.moved).toFixed(2), hit: r.hit }));
    assert.ok(r.moved > 0.5, `${c.label}: the target really moved (${r.moved.toFixed(2)} m)`);
    assert.ok(r.hit, `${c.label}: hit where it was drawn`);
    assert.ok(Math.abs(r.rewind.lastMs - (c.back * 1000) / 60) < 1e-6, `${c.label}: resolved ${r.rewind.lastMs} ms back`);
    // Same aim, resolved against the current poses: once the target has moved more than
    // its half-width with the arms (~0.75 m) the shot misses.
    const unrewound = laggedShot(100 + i, c.back, 0);
    console.log(JSON.stringify({ case: c.label, unrewoundHit: unrewound.hit }));
    if (r.moved > 0.8) assert.equal(unrewound.hit, false, `${c.label}: without rewind it misses`);
  }
});

test("lag compensation bounds: older than 250 ms is clamped, a future or unsent tick is resolved without rewind, nothing else is rewound", () => {
  const stale = laggedShot(201, 30);
  assert.equal(stale.rewind.clampedOld, 1);
  assert.equal(stale.rewind.lastMs, NET.maxRewindMs, "clamped to the limit");
  assert.equal(stale.hit, false, "the 500 ms-old position is not reachable");
  const veryOld = laggedShot(202, 30, 400);
  assert.equal(veryOld.rewind.clampedOld, 1);
  // A tick the client cannot have seen (later than any snapshot sent) → current poses.
  const { sim, run } = strafingTarget(203);
  const latest = sim.history.latest;
  const future = torsoAt(sim, latest, 1);
  run([{ ...aimAt(sim, 0, future), attackPressed: true, viewTick: latest + 5 }, { moveX: 1, sprintHeld: true, aimYaw: 0 }]);
  assert.equal(sim.rewind.rejectedFuture, 1);
  assert.equal(sim.rewind.lastMs, 0, "no rewind for an impossible view");
  // Static geometry is never rewound: the rewind view holds only character poses, the
  // barn's colliders are tested in the live world (a crate between them blocks a rewound shot).
  const m = match([0, 1], 204);
  place(m.sim, 0, { x: 8.6, y: 0, z: -3.6 }, Math.PI / 2);
  place(m.sim, 1, { x: 12.9, y: 0, z: -0.3 }, -Math.PI / 2);
  for (let i = 0; i < 30; i++) m.step([still(m.sim, 0), still(m.sim, 1)]);
  m.sim.barn.fighters[0].weapon = newWeapon("smg");
  const latest2 = m.sim.history.latest;
  const behind = torsoAt(m.sim, latest2 - 6, 1);
  const out = m.step([{ ...aimAt(m.sim, 0, behind), attackPressed: true, viewTick: latest2 - 6 }, still(m.sim, 1)]);
  const shot = out.find((e) => e.name === "smgFire")!;
  assert.ok(shot.barn!.struck![0] === -2, "the east wing crates (E3) stop the rewound shot");
  assert.equal(m.sim.barn.fighters[1].hp, 100);
});

test("lag compensation cost: history record and a 9-ray shotgun lookup stay in the microsecond range", () => {
  const { sim, step } = strafingTarget(301);
  const began = performance.now();
  for (let i = 0; i < 600; i++) step([{ aimYaw: Math.PI }, { moveX: i % 120 < 60 ? 1 : -1, aimYaw: 0 }]);
  const stepMs = (performance.now() - began) / 600;
  let lookups = 0;
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) {
    const view = sim.history.view(sim.history.latest - 7.5);
    assert.ok(view);
    lookups++;
  }
  const lookupUs = ((performance.now() - t0) / lookups) * 1000;
  console.log(JSON.stringify({ barnStepMs: +stepMs.toFixed(3), viewLookupUs: +lookupUs.toFixed(1) }));
  assert.ok(lookupUs < 100);
});

// ─── Snapshot and prediction state ──────────────────────────────────────────

test("snapshot: explicit mode, compact integer barn section; exact msgpack bytes measured for rooftop and barn", () => {
  const { sim, step } = match([0, 1, 2], 401);
  for (let i = 0; i < 30; i++) step();
  const snap = sim.snapshot([10, 11, 12]);
  assert.equal(snap.mode, "barn_shootout");
  assert.equal(snap.barn!.f.length, 3 * BARN_FIGHTER_FIELDS);
  assert.ok(snap.barn!.f.every(Number.isInteger), "every barn field is a small integer");
  assert.ok([snap.barn!.p, snap.barn!.t, snap.barn!.r].every((a) => a.every(Number.isInteger)));
  const withPrediction = { ...snap, prediction: sim.prediction(0) };
  const barnBytes = packr.pack(withPrediction).byteLength;
  const roof = new OnlineRoundSimulation(newRoomCounters());
  roof.start([0, 1, 2]);
  for (let i = 0; i < 240; i++) roof.step([]);
  const roofSnap = { ...roof.snapshot([10, 11, 12]), prediction: roof.prediction(0) };
  assert.equal(roofSnap.mode, "rooftop_brawl");
  const roofBytes = packr.pack(roofSnap).byteLength;
  const parts = {
    transforms: snap.transforms.byteLength,
    velocities: withPrediction.prediction.velocities.byteLength,
    barnPrediction: withPrediction.prediction.barn!.byteLength,
    barnSection: packr.pack(snap.barn).byteLength,
  };
  console.log(JSON.stringify({ barnSnapshotBytes: barnBytes, rooftopSnapshotBytes: roofBytes, barnPerSecond: barnBytes * NET.snapshotHz, parts }));
  assert.ok(barnBytes < 1400, `barn snapshot ${barnBytes} B`);
  assert.ok(parts.barnSection < 90, `barn section ${parts.barnSection} B`);
  roof.dispose();
  // The recipient-only prediction section round-trips.
  const state = readBarnPredictionState(withPrediction.prediction.barn);
  assert.ok(state);
  assert.equal(state!.alive, 1);
  assert.ok(Math.abs(state!.facing - sim.physics.players[0].facing) < 1e-5);
});

test("barn input packet bytes: typical 60 Hz uplink", () => {
  const p: BarnInputPacket = {
    seq: 12345,
    round: 3,
    moveX: -0.7071067811865476,
    moveZ: 0.7071067811865475,
    jumpPressed: false,
    sprintHeld: true,
    attackPressed: false,
    attackHeld: true,
    pickupPressed: false,
    aimYaw: 2.345678,
    aimPitch: 0.1745,
    eyeX: -0.3123,
    eyeY: 1.1034,
    eyeZ: 0.2211,
    viewTick: 18234.37,
  };
  const bytes = packr.pack(p).byteLength;
  const roof = packr.pack({ seq: 12345, round: 3, moveX: 1, moveZ: 0, jumpPressed: false, punchPressed: false, grabHeld: false, liftHeld: false }).byteLength;
  console.log(JSON.stringify({ barnInputBytes: bytes, barnUplinkBps: bytes * 60, rooftopInputBytes: roof }));
  assert.ok(bytes < 260);
});

// ─── Modes and presentation plumbing ────────────────────────────────────────

test("modes: a fixed selection is that mode; Mixed starts at random and then alternates", async () => {
  const { upcomingMode, otherMode, isModeSelection, isGameMode, MODE_MAP } = await import("../../../shared/party-lab/modes");
  assert.equal(upcomingMode("rooftop_brawl", "barn_shootout"), "rooftop_brawl");
  assert.equal(upcomingMode("barn_shootout", null), "barn_shootout");
  assert.equal(upcomingMode("mixed", null, () => 0.2), "rooftop_brawl");
  assert.equal(upcomingMode("mixed", null, () => 0.8), "barn_shootout");
  let mode = upcomingMode("mixed", null, () => 0.8);
  const seq = [mode];
  for (let i = 0; i < 5; i++) seq.push((mode = upcomingMode("mixed", mode)));
  assert.deepEqual(seq, ["barn_shootout", "rooftop_brawl", "barn_shootout", "rooftop_brawl", "barn_shootout", "rooftop_brawl"]);
  assert.equal(otherMode("barn_shootout"), "rooftop_brawl");
  assert.ok(isModeSelection("mixed") && !isGameMode("mixed") && !isModeSelection("toString") && !isModeSelection(1));
  assert.deepEqual(MODE_MAP, { rooftop_brawl: "rooftop", barn_shootout: "barn" });
});

test("local shots: each predicted shot suppresses exactly one confirmed echo of that weapon; late or unpredicted echoes still play", async () => {
  const { GameStream } = await import("./gameStream");
  const stream = new GameStream();
  const fire = (id: number, actor: number, name: "smgFire" | "shotgunFire" = "smgFire") => ({ id, round: 1, tick: id, name, actor } as GameEvent);
  stream.markLocalShot(0, "smgFire");
  stream.markLocalShot(0, "smgFire");
  stream.acceptEvents([fire(1, 0), fire(2, 0), fire(3, 0), fire(4, 1), fire(5, 0, "shotgunFire")]);
  const shown = stream.drain(1, Infinity).map((e) => `${e.id}:${e.actor}:${e.name}`);
  assert.deepEqual(shown, ["3:0:smgFire", "4:1:smgFire", "5:0:shotgunFire"], "two local SMG rounds suppress two echoes only");
  // Own hits/damage are released at once; other players' events wait for the playout clock.
  stream.acceptEvents([{ id: 6, round: 1, tick: 600, name: "bulletHit", actor: 0, target: 1 } as GameEvent, { id: 7, round: 1, tick: 600, name: "smgFire", actor: 1 } as GameEvent]);
  const now = stream.drain(1, 0, (e) => e.actor === 0 || e.target === 0).map((e) => e.id);
  assert.deepEqual(now, [6]);
  assert.deepEqual(stream.drain(1, 10_000).map((e) => e.id), [7]);
});

test("barn prediction state is exact (Float64): the restored facing equals the server's bit for bit", () => {
  const { sim, step } = match([0, 1], 501);
  for (let i = 0; i < 20; i++) step([{ aimYaw: 1.2345678901234567 }, null]);
  const state = readBarnPredictionState(sim.prediction(0).barn)!;
  assert.equal(state.facing, sim.physics.players[0].facing);
  assert.equal(state.anchorX, sim.physics.players[0].anchorX);
});

test("server benchmark: 3-player barn, 60 s of movement and fire — step avg/p99/max, snapshot encoding, event bytes", () => {
  const { sim, step } = match([0, 1, 2], 601);
  const steps: number[] = [],
    encode: number[] = [];
  let eventBytes = 0,
    snapBytes = 0,
    snaps = 0,
    pending: GameEvent[] = [];
  for (let i = 0; i < 60 * 60; i++) {
    // Keep everyone armed and moving; fire often (reloads by pickup are not the point here).
    for (const f of sim.barn.fighters) if (f.alive && !f.weapon && i % 120 === 0) f.weapon = newWeapon(i % 240 ? "smg" : "shotgun");
    const packets = [0, 1, 2].map((id) => ({
      moveX: Math.sin(i / 40 + id),
      moveZ: Math.cos(i / 55 + id * 2),
      sprintHeld: i % 200 > 120,
      aimYaw: Math.sin(i / 90 + id) * 3,
      attackHeld: i % 90 < 40,
      attackPressed: i % 90 === 0,
      pickupPressed: i % 50 === 0,
      jumpPressed: i % 170 === 0,
      viewTick: Math.max(0, sim.tick - 9),
    }));
    const t = performance.now();
    pending.push(...step(packets));
    steps.push(performance.now() - t);
    if (sim.tick % 3 === 0) {
      const t2 = performance.now();
      const common = sim.snapshot([1, 2, 3]);
      for (const id of [0, 1, 2] as const) snapBytes += packr.pack({ ...common, prediction: sim.prediction(id) }).byteLength;
      encode.push(performance.now() - t2);
      snaps++;
      if (pending.length) eventBytes += packr.pack(pending).byteLength;
      pending = [];
    }
  }
  steps.sort((a, b) => a - b);
  encode.sort((a, b) => a - b);
  const q = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))];
  const report = {
    stepAvgMs: +(steps.reduce((a, b) => a + b, 0) / steps.length).toFixed(3),
    stepP99Ms: +q(steps, 0.99).toFixed(3),
    stepMaxMs: +steps[steps.length - 1].toFixed(3),
    snapshotBuildEncode3Ms: { avg: +(encode.reduce((a, b) => a + b, 0) / encode.length).toFixed(3), p99: +q(encode, 0.99).toFixed(3) },
    snapshotBytesPerClient: Math.round(snapBytes / snaps / 3),
    eventBytesPerSecond: Math.round(eventBytes / 60),
    shots: sim.barn.stats.shots,
    kills: sim.barn.stats.kills,
    rewind: { shots: sim.rewind.shots, lookupUsAvg: +((sim.rewind.lookupMs / Math.max(1, sim.rewind.shots)) * 1000).toFixed(1), maxMs: Math.round(sim.rewind.maxMs) },
    rays: sim.barn.hitscan.stats.rays,
    rayUsAvg: +((sim.barn.hitscan.stats.ms / Math.max(1, sim.barn.hitscan.stats.rays)) * 1000).toFixed(1),
  };
  console.log(JSON.stringify(report));
  assert.ok(report.stepAvgMs < 2, "well inside the 16.7 ms tick");
  assert.ok(sim.barn.stats.shots > 50);
});
