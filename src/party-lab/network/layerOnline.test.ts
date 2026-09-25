import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { before, test } from "node:test";
import { Packr } from "msgpackr";
import RAPIER from "@dimforge/rapier3d-compat";
import { initializePhysics } from "../../../shared/party-lab/simulation/physics";
import { LayerRoundSimulation, layerSpawns } from "../../../shared/party-lab/simulation/layerRound";
import { newRoomCounters } from "../../../shared/party-lab/simulation/online";
import { connect, restore } from "../../../shared/party-lab/simulation/ragdoll/character";
import { RAGDOLL } from "../../../shared/party-lab/simulation/ragdoll/config";
import { LAYER_TILES, LAYER_TOPS, LAYERS_MAP, tileAt, type LayerIndex } from "../../../shared/party-lab/maps/layers";
import { LAYER_TICKS } from "../../../shared/party-lab/simulation/layers/config";
import { decodeLayerSnapshot, LAYER_GONE_BYTES, LayerTileKnowledge } from "../../../shared/party-lab/simulation/layers/wire";
import { readLayerPredictionState } from "../../../shared/party-lab/simulation/predictionState";
import {
  InputMailbox,
  LAYER_FLAG,
  LAYER_PREDICTION_BYTES,
  LAYER_RESULTS,
  NET,
  validateLayerInput,
  type GameEvent,
  type GameSnapshot,
  type LayerInputPacket,
} from "../../../shared/party-lab/network/protocol";
import type { PlayerId } from "../../../shared/party-lab/simulation/players";
import { LayerFall } from "../scene/layers/fall";
import { LayerBot } from "../scene/layers/bots";

before(() => initializePhysics());
const packr = new Packr({ useRecords: false });
const seeded = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) | 0) >>> 0) / 4294967296;
const TICK_MS = 1000 / NET.physicsHz;

/** An authoritative Katman Kaosu round, one mailbox per slot, the room's cadence (snapshot every third tick). */
function match(slots: PlayerId[] = [0, 1], { play = true } = {}) {
  const sim = new LayerRoundSimulation(newRoomCounters());
  assert.ok(sim.start(slots));
  const boxes = [new InputMailbox(), new InputMailbox(), new InputMailbox()];
  const seq = [0, 0, 0];
  let now = 0;
  const events: GameEvent[] = [];
  const snapshots: GameSnapshot[] = [];
  const packet = (id: number, p: Partial<LayerInputPacket> = {}): LayerInputPacket => ({
    seq: ++seq[id],
    round: sim.roundId,
    moveX: 0,
    moveZ: 0,
    jumpPressed: false,
    sprintHeld: false,
    punchPressed: false,
    ...p,
  });
  const step = (packets: (Partial<LayerInputPacket> | null)[] = []) => {
    now += TICK_MS;
    packets.forEach((p, id) => {
      if (!p || sim.phase !== "playing") return;
      assert.ok(boxes[id].accept(packet(id, p), sim.roundId, now, "layer_chaos"), "valid layer packet accepted");
    });
    const out = sim.step(boxes.map((b) => (sim.phase === "playing" ? b.read(now) : { x: 0, z: 0, jump: false })));
    events.push(...out);
    if (sim.tick % (NET.physicsHz / NET.snapshotHz) === 0) snapshots.push(sim.snapshot(boxes.map((b) => (b.processedRound === sim.roundId ? b.processedSeq : -1))));
    return out;
  };
  if (play) {
    while (sim.phase === "countdown") step();
    assert.equal(sim.phase, "playing");
  }
  return { sim, step, events, snapshots, boxes, packet };
}
type Sim = LayerRoundSimulation;
/** Stand a character on a tile (pelvis at spawn height over it), facing `yaw`. */
function place(sim: Sim, id: PlayerId, tile: { x: number; z: number; top: number }, yaw = 0, dx = 0, dz = 0) {
  const c = sim.physics.players[id];
  restore(c, { x: tile.x + dx, y: tile.top + 0.9, z: tile.z + dz }, yaw);
  connect(sim.physics.world, c);
}
const pelvis = (sim: Sim, id: PlayerId) => sim.physics.players[id].body.translation();
const tileUnder = (sim: Sim, id: PlayerId, layer: LayerIndex) => {
  const p = pelvis(sim, id);
  return tileAt(layer, p.x, p.z);
};
const hit = (sim: Sim, x: number, y: number, z: number) =>
  sim.physics.world.castRay(new RAPIER.Ray({ x, y, z }, { x: 0, y: -1, z: 0 }), 3, false, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);

// ─── Protocol ───────────────────────────────────────────────────────────────

test("protocol 7: a strict layer packet (intent only), its mailbox edges, and packets of other modes refused", () => {
  // 6 = Katman Kaosu online; 7 = Renk Kaosu online (the layer packet is unchanged and shared with it).
  assert.equal(NET.version, 7);
  const valid: LayerInputPacket = { seq: 4, round: 2, moveX: 1, moveZ: 1, jumpPressed: false, sprintHeld: true, punchPressed: false };
  const v = validateLayerInput(valid)!;
  assert.ok(Math.abs(Math.hypot(v.moveX, v.moveZ) - 1) < 1e-12, "diagonal normalised to length 1");
  // Nothing but intent: tile, hit, elimination or winner claims, Barn aim fields and missing keys are refused.
  for (const extra of [{ tile: 3 }, { hit: 1 }, { eliminated: true }, { winner: 0 }, { aimYaw: 0 }, { grabHeld: false }, { viewTick: 3 }])
    assert.equal(validateLayerInput({ ...valid, ...extra }), null, `extra ${Object.keys(extra)[0]} refused`);
  const { punchPressed: _, ...missing } = valid;
  assert.equal(validateLayerInput(missing), null);
  for (const bad of [{ moveX: NaN }, { moveZ: Infinity }, { seq: -1 }, { round: 0 }, { jumpPressed: 1 }, { sprintHeld: "yes" }, { seq: 1.5 }])
    assert.equal(validateLayerInput({ ...valid, ...bad }), null);
  // Edges: a held jump/punch counts once; the punch keeps the sequence that carried it.
  const box = new InputMailbox();
  assert.ok(box.accept({ ...valid, seq: 1, round: 1, jumpPressed: true, punchPressed: true }, 1, 0, "layer_chaos"));
  assert.ok(box.accept({ ...valid, seq: 2, round: 1, jumpPressed: true, punchPressed: true }, 1, 1, "layer_chaos"));
  const first = box.read(2);
  assert.deepEqual([first.jump, first.punch, first.sprint, box.processedSeq, box.processedPunchSeq], [true, true, true, 2, 1]);
  const second = box.read(3);
  assert.deepEqual([second.jump, second.punch], [false, false], "edges consumed once");
  assert.equal(box.accept({ ...valid, seq: 2, round: 1 }, 1, 4, "layer_chaos"), false, "old sequence refused");
  // Mode mismatch: rooftop/barn packets in a layer round and a layer packet in the others are refused.
  const roof = { seq: 9, round: 1, moveX: 0, moveZ: 0, jumpPressed: false, punchPressed: false, grabHeld: false, liftHeld: false };
  assert.equal(new InputMailbox().accept(roof, 1, 0, "layer_chaos"), false);
  assert.equal(new InputMailbox().accept({ ...valid, round: 1 }, 1, 0, "rooftop_brawl"), false);
  assert.equal(new InputMailbox().accept({ ...valid, round: 1 }, 1, 0, "barn_shootout"), false);
  const bytes = packr.pack({ ...valid, seq: 12345, round: 3, moveX: -0.7071067811865475, moveZ: 0.7071067811865476 }).byteLength;
  console.log(JSON.stringify({ layerInputBytes: bytes, layerUplinkBps: bytes * 60 }));
  assert.ok(bytes < 110, `${bytes} B per packet`);
});

// ─── Rounds ─────────────────────────────────────────────────────────────────

test("2 and 3 players: slots and spawns (duels rotate a mirror-fair pair), frozen countdown with immune tiles", () => {
  // Three players: all three approved top-layer spawns.
  const three = match([0, 1, 2], { play: false });
  for (const id of [0, 1, 2] as const) {
    const p = pelvis(three.sim, id),
      s = LAYERS_MAP.spawns[id];
    assert.ok(Math.hypot(p.x - s.x, p.z - s.z) < 0.05 && Math.abs(p.y - s.y) < 0.2, `slot ${id} on spawn ${id}`);
  }
  // Countdown: inputs are ignored (the room drops them; the simulation too): the bodies only
  // settle from spawn height exactly as with no input at all, and no tile arms.
  const still = match([0, 1, 2], { play: false });
  let ticks = 0;
  while (three.sim.phase === "countdown") {
    three.sim.step([0, 1, 2].map(() => ({ x: 1, z: 0, jump: true, punch: true, sprint: true })));
    still.sim.step([]);
    ticks++;
  }
  assert.equal(ticks, LAYER_TICKS.countdown, "3 s countdown");
  for (const id of [0, 1, 2] as const) assert.deepEqual(pelvis(three.sim, id), pelvis(still.sim, id), "frozen: inputs change nothing");
  assert.equal(three.events.filter((e) => e.name === "punchSwing" || e.name === "jump").length, 0);
  still.sim.dispose();
  assert.ok(three.sim.field.armTick.every((t) => t === -1), "no tile armed during the countdown");
  assert.equal(three.sim.snapshot([-1, -1, -1]).layers!.a.byteLength, 0);
  three.step();
  assert.equal([...three.sim.field.armTick].filter((t) => t === 0).length, 3, "each standing player arms their tile on the first playing tick");
  three.sim.dispose();
  // Two players: two of the three spawns, the unused one rotating every round; both starts mirror images.
  const used = new Set<string>();
  for (let round = 1; round <= 6; round++) {
    const spawns = layerSpawns([0, 2], round);
    assert.equal(new Set(spawns).size, 2);
    assert.ok(!spawns.includes(round % 3), "the unused spawn rotates");
    used.add(spawns.join());
    const [a, b] = spawns.map((k) => LAYERS_MAP.spawns[k]);
    assert.ok(Math.abs(Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z)) < 1e-9, "same distance from the middle");
  }
  assert.equal(used.size, 6, "every pair, both ways round, over six rounds");
  const duel = match([0, 2], { play: false });
  const spawns = layerSpawns([0, 2], duel.sim.roundId);
  for (const [i, id] of ([0, 2] as const).entries()) {
    const p = pelvis(duel.sim, id),
      s = LAYERS_MAP.spawns[spawns[i]];
    assert.ok(Math.hypot(p.x - s.x, p.z - s.z) < 0.05, `slot ${id} on spawn ${spawns[i]}`);
  }
  assert.ok(duel.sim.physics.players[1].eliminated, "the empty seat has no body");
  duel.sim.dispose();
});

test("tiles: the hip tile arms on its tick; break time 1.30 / 1.05 / 0.80 s exactly; the collider is gone on goneTick", () => {
  const { sim, step } = match([0, 1]);
  step();
  const tile = tileUnder(sim, 0, 0)!;
  assert.equal(sim.field.armTick[tile.id], 0, "armed on round tick 0");
  assert.equal(sim.field.goneTick[tile.id], LAYER_TICKS.base);
  assert.equal(LAYER_TICKS.base, 78);
  // The collider answers until the tick it goes, then never.
  while (sim.round.tick < LAYER_TICKS.base) {
    assert.ok(hit(sim, tile.x, tile.top + 1.5, tile.z), `tile still there before tick ${LAYER_TICKS.base}`);
    step();
  }
  step();
  assert.ok(sim.field.gone[tile.id], "GONE on its tick");
  assert.equal(hit(sim, tile.x, tile.top + 1.5, tile.z), null, "no collider left");
  // Later arms: the duration follows the round clock at the moment of arming.
  for (const [at, ticks] of [
    [LAYER_TICKS.fastAt, 63],
    [LAYER_TICKS.collapseAt, 48],
  ] as const) {
    sim.round.tick = at;
    const fresh = LAYER_TILES.find((t) => t.layer === 3 && sim.field.armTick[t.id] < 0 && t.ring <= 1)!;
    place(sim, 1, fresh);
    step();
    assert.equal(sim.field.armTick[fresh.id], at, `armed at ${at}`);
    assert.equal(sim.field.goneTick[fresh.id] - at, ticks, `${ticks} ticks from ${at / 60} s`);
  }
  sim.dispose();
});

test("tile section: complete in every snapshot (reconnect rebuilds the exact field), clients agree on every tick, bad links included", () => {
  const sim = new LayerRoundSimulation(newRoomCounters());
  sim.start([0, 1, 2]);
  const random = seeded(3);
  const bots = [0, 1, 2].map((id) => new LayerBot(id as PlayerId, random));
  bots.forEach((b) => b.reset());
  const boxes = [0, 1, 2].map(() => new InputMailbox());
  const seq = [0, 0, 0];
  // Two clients: one on a clean 50 ms link, one on 150 ms ± 80 ms jitter with 300/500/800 ms stalls (ordered, like TCP).
  const links = [
    { delay: () => 25, stalls: [] as [number, number][] },
    { delay: () => 75 + random() * 80, stalls: [[8000, 300], [20000, 500], [35000, 800]] as [number, number][] },
  ];
  const clients = links.map(() => ({ queue: [] as { due: number; bytes: Uint8Array; round: number; seq: number }[], last: 0, knowledge: new LayerTileKnowledge(), checked: 0, seen: new Map<number, string>() }));
  const truth = new Map<number, string>();
  const stages = (view: { stage(id: number, t: number): string }, t: number) => LAYER_TILES.map((tile) => view.stage(tile.id, t)[0]).join("");
  let fresh = 0,
    endedAt = -1,
    maxSection = 0,
    maxArmed = 0,
    sections = 0,
    total = 0;
  for (let i = 0; sim.phase !== "waiting" && i < 60 * 110; i++) {
    const now = i * TICK_MS;
    for (const id of [0, 1, 2]) {
      const intent = bots[id].update(sim.game);
      if (sim.phase === "playing")
        boxes[id].accept({ seq: ++seq[id], round: sim.roundId, moveX: intent.x, moveZ: intent.z, jumpPressed: intent.jump, sprintHeld: !!intent.sprint, punchPressed: !!intent.punch }, sim.roundId, now, "layer_chaos");
    }
    sim.step(boxes.map((b) => (sim.phase === "playing" ? b.read(now) : { x: 0, z: 0, jump: false })));
    if (sim.phase === "results" && endedAt < 0) endedAt = sim.round.endedAt;
    if (sim.tick % 3) continue;
    const snap = sim.snapshot([-1, -1, -1]);
    const bytes = packr.pack(snap.layers);
    maxSection = Math.max(maxSection, bytes.byteLength);
    maxArmed = Math.max(maxArmed, snap.layers!.a.byteLength / 3);
    sections++;
    total += bytes.byteLength;
    if (snap.phase !== "playing") continue;
    const shown = snap.layers!.t - 1;
    truth.set(shown, stages(sim.field, shown));
    // A client with nothing else (a reconnect's first snapshot) has the exact field.
    const decoded = decodeLayerSnapshot(packr.unpack(bytes))!;
    const reconnect = new LayerTileKnowledge();
    reconnect.apply(snap.round, decoded);
    reconnect.viewTick = shown;
    assert.equal(stages(reconnect, shown), truth.get(shown), `reconnect at tick ${shown}`);
    for (const tile of LAYER_TILES) assert.equal(reconnect.intact(tile.id), sim.field.intact(tile.id));
    fresh++;
    clients.forEach((client, c) => {
      const link = links[c];
      let due = Math.max(client.last, now + link.delay());
      for (const [from, ms] of link.stalls) if (now >= from && now < from + ms) due = Math.max(due, from + ms);
      client.last = due;
      client.queue.push({ due, bytes, round: snap.round, seq: snap.seq });
    });
    for (const client of clients)
      while (client.queue[0] && client.queue[0].due <= now) {
        const item = client.queue.shift()!;
        const d = decodeLayerSnapshot(packr.unpack(item.bytes))!;
        client.knowledge.apply(item.round, d);
        const at = d.t - 1;
        // What this client shows for that tick is what the server had then.
        assert.equal(stages(client.knowledge, at), truth.get(at), `client agrees at tick ${at}`);
        client.seen.set(at, stages(client.knowledge, at));
        client.checked++;
      }
  }
  // Both clients hold the same field for every tick they both received.
  let common = 0;
  for (const [t, s] of clients[0].seen)
    if (clients[1].seen.has(t)) {
      common++;
      assert.equal(clients[1].seen.get(t), s);
    }
  console.log(JSON.stringify({ snapshotsChecked: fresh, clientChecks: clients.map((c) => c.checked), commonTicks: common, sectionMaxBytes: maxSection, sectionAvgBytes: Math.round(total / sections), goneBitset: LAYER_GONE_BYTES, maxArmedTiles: maxArmed, endedAt: +(endedAt / 60).toFixed(1) }));
  assert.ok(fresh > 300 && common > 300);
  assert.ok(maxSection < 200, `section ≤ ${maxSection} B`);
  sim.dispose();
});

// ─── Combat and movement ────────────────────────────────────────────────────

test("punch online: the server decides contact, push and stagger (no HP); cooldown 0.6 s; the stagger is in the snapshot", () => {
  const { sim, step, events } = match([0, 1]);
  const a = LAYER_TILES.find((t) => t.layer === 0 && t.q === 0 && t.r === 0)!;
  const b = LAYER_TILES.find((t) => t.layer === 0 && t.q === 1 && t.r === 0)!;
  // Face each other one tile apart: slot 0 at the middle facing +x, slot 1 just in front.
  place(sim, 0, a, Math.PI / 2, 0.35);
  place(sim, 1, b, -Math.PI / 2, -0.35);
  for (let i = 0; i < 20; i++) step();
  const before = { ...pelvis(sim, 1) };
  let hitAt = -1;
  for (let i = 0; i < 40 && hitAt < 0; i++) {
    const out = step([{ punchPressed: i < 2 }]);
    if (out.some((e) => ["headHit", "bodyHit", "limbHit"].includes(e.name) && e.actor === 0 && e.target === 1)) hitAt = i;
  }
  assert.ok(hitAt >= 0, "the punch lands by real hand contact");
  const target = sim.game.brawl.fighters[1];
  assert.ok(target.stagger.time > 0.3 - 1e-9, "stagger started (0.35 s)");
  const snap = sim.snapshot([-1, -1, -1]);
  assert.ok(snap.layers!.f[1] & LAYER_FLAG.staggered, "stagger visible to every client");
  assert.equal(sim.game.brawl.stats.hits, 1);
  for (let i = 0; i < 30; i++) step();
  const moved = Math.hypot(pelvis(sim, 1).x - before.x, pelvis(sim, 1).z - before.z);
  console.log(JSON.stringify({ punchHitTick: hitAt, shove: +moved.toFixed(2) }));
  assert.ok(moved > 0.3 && moved < 2, `pushed ${moved.toFixed(2)} m, no knockout`);
  assert.ok(!("hp" in target) && !snap.barn && snap.states.length === 0, "no health anywhere");
  // Cooldown: a second press 0.3 s after a swing does nothing; one after 0.65 s swings.
  const swings = () => events.filter((e) => e.name === "punchSwing" && e.actor === 0).length;
  for (let i = 0; i < 60; i++) step();
  const n = swings();
  step([{ punchPressed: true }]);
  step([{ punchPressed: false }]);
  for (let i = 0; i < 16; i++) step();
  step([{ punchPressed: true }]);
  step([{ punchPressed: false }]);
  assert.equal(swings(), n + 1, "second press inside 0.6 s ignored");
  for (let i = 0; i < 22; i++) step();
  step([{ punchPressed: true }]);
  assert.equal(swings(), n + 2, "after the cooldown it swings");
  sim.dispose();
});

test("sprint ×1.4 and jump via packets; a normal jump is never a layer fall; one-layer and multi-layer physical falls", () => {
  const speed = (sprint: boolean) => {
    const { sim, step } = match([0, 1]);
    place(sim, 0, LAYER_TILES.find((t) => t.layer === 0 && t.q === -4 && t.r === 0)!, Math.PI / 2);
    for (let i = 0; i < 10; i++) step();
    for (let i = 0; i < 30; i++) step([{ moveX: 1, sprintHeld: sprint }]);
    const from = pelvis(sim, 0).x;
    for (let i = 0; i < 30; i++) step([{ moveX: 1, sprintHeld: sprint }]);
    const v = (pelvis(sim, 0).x - from) * 2;
    sim.dispose();
    return v;
  };
  const walk = speed(false),
    run = speed(true);
  console.log(JSON.stringify({ walk: +walk.toFixed(2), sprint: +run.toFixed(2), ratio: +(run / walk).toFixed(2) }));
  assert.ok(run / walk > 1.25 && run / walk < 1.55, `sprint ×${(run / walk).toFixed(2)}`);
  // Jumps (standing and running): airborne, over tiles, never "falling between layers".
  const { sim, step } = match([0, 1]);
  place(sim, 0, LAYER_TILES.find((t) => t.layer === 0 && t.q === -3 && t.r === 0)!, Math.PI / 2);
  for (let i = 0; i < 10; i++) step();
  const fall = new LayerFall();
  fall.reset(pelvis(sim, 0).y);
  let apex = 0;
  const base = pelvis(sim, 0).y;
  for (let i = 0; i < 70; i++) {
    step([{ moveX: i < 50 ? 1 : 0, jumpPressed: i === 5 || i === 45 }]);
    const p = pelvis(sim, 0);
    apex = Math.max(apex, p.y - base);
    assert.equal(fall.update(sim.field, p.x, p.y, p.z, sim.physics.players[0].body.linvel().y), false, `jump tick ${i} is not a layer fall`);
  }
  assert.ok(apex > 0.7, `jumped ${apex.toFixed(2)} m`);
  assert.equal(fall.ground, LAYER_TOPS[0]);
  // One layer: the tile under the body goes; it falls physically (no teleport) and lands on L2.
  const stand = tileUnder(sim, 0, 0)!;
  sim.field.remove(stand.id);
  const ys: number[] = [];
  let falling = false;
  for (let i = 0; i < 90; i++) {
    step();
    const p = pelvis(sim, 0);
    ys.push(p.y);
    falling ||= fall.update(sim.field, p.x, p.y, p.z, sim.physics.players[0].body.linvel().y);
  }
  assert.ok(falling, "a real fall between layers");
  for (let i = 1; i < ys.length; i++) assert.ok(Math.abs(ys[i] - ys[i - 1]) < 0.4, "continuous, no teleport");
  assert.ok(Math.abs(pelvis(sim, 0).y - (LAYER_TOPS[1] + 0.78)) < 0.3, `landed on L2 (${pelvis(sim, 0).y.toFixed(2)})`);
  for (let i = 0; i < 20; i++) step();
  fall.update(sim.field, pelvis(sim, 0).x, pelvis(sim, 0).y, pelvis(sim, 0).z, 0);
  assert.equal(fall.ground, LAYER_TOPS[1]);
  // Several layers: the tiles under it on L2 and L3 go too; it drops to L4.
  for (const layer of [1, 2] as const) {
    const t = tileUnder(sim, 0, layer);
    if (t) sim.field.remove(t.id);
  }
  for (let i = 0; i < 150; i++) step();
  assert.ok(Math.abs(pelvis(sim, 0).y - (LAYER_TOPS[3] + 0.78)) < 0.3, `landed on L4 (${pelvis(sim, 0).y.toFixed(2)})`);
  assert.ok(sim.round.alive[0], "still in");
  sim.dispose();
});

test("elimination, last survivor, simultaneous draw and forfeit; no respawn; the round returns to the lobby", () => {
  const dropOut = (sim: Sim, id: PlayerId) => {
    const hips = pelvis(sim, id).y;
    for (const part of Object.values(sim.physics.players[id].parts)) {
      const p = part.body.translation();
      part.body.setTranslation({ x: p.x, y: RAGDOLL.fallY - 1 + (p.y - hips), z: p.z }, true);
    }
  };
  // Three players: one falls out (body off, no respawn), then another: the last alive wins on that tick.
  const three = match([0, 1, 2]);
  dropOut(three.sim, 1);
  const out1 = three.step();
  assert.ok(out1.some((e) => e.name === "fall" && e.actor === 1), "the fall cue");
  assert.ok(!three.sim.round.alive[1] && three.sim.physics.players[1].eliminated, "eliminated, body disabled");
  assert.equal(three.sim.phase, "playing");
  for (let i = 0; i < 120; i++) three.step();
  assert.ok(three.sim.physics.players[1].eliminated && !three.sim.round.alive[1], "no respawn");
  const snap = three.sim.snapshot([-1, -1, -1]);
  assert.equal(snap.alive & 0b010, 0);
  assert.equal(snap.layers!.f[1] & (LAYER_FLAG.alive | LAYER_FLAG.body), 0);
  assert.ok(snap.layers!.o[1] >= 0, "elimination tick recorded");
  dropOut(three.sim, 2);
  const out2 = three.step();
  assert.equal(three.sim.phase, "results");
  assert.equal(three.sim.winner, 0);
  assert.ok(out2.some((e) => e.name === "winner"));
  assert.equal(three.sim.snapshot([-1, -1, -1]).layers!.r, LAYER_RESULTS.indexOf("survivor"));
  let ticks = 0;
  while (three.sim.phase === "results") {
    three.step();
    ticks++;
  }
  assert.equal(three.sim.phase, "waiting");
  assert.equal(ticks, LAYER_TICKS.results, "3.5 s of results, then the lobby");
  assert.equal(three.sim.mask, 0);
  three.sim.dispose();
  // Two players out on the same tick: a draw.
  const duel = match([0, 1]);
  dropOut(duel.sim, 0);
  dropOut(duel.sim, 1);
  const outs = duel.step();
  assert.equal(duel.sim.phase, "results");
  assert.equal(duel.sim.winner, -1);
  assert.ok(outs.some((e) => e.name === "draw"));
  assert.equal(duel.sim.snapshot([-1, -1, -1]).layers!.r, LAYER_RESULTS.indexOf("all-fell"));
  duel.sim.dispose();
  // Leaving is a forfeit.
  const left = match([0, 2]);
  left.sim.remove(2);
  left.step();
  assert.equal(left.sim.phase, "results");
  assert.equal(left.sim.winner, 0);
  const section = left.sim.snapshot([-1, -1, -1]).layers!;
  assert.equal(section.r, LAYER_RESULTS.indexOf("forfeit"));
  assert.ok(section.f[2] & LAYER_FLAG.forfeit);
  left.sim.dispose();
});

test("collapse is deterministic and ends every round by ~96 s; the same inputs give the same round", () => {
  const run = () => {
    const sim = new LayerRoundSimulation(newRoomCounters());
    sim.start([0, 1]);
    // Only the collapse arms tiles here (players never do), so the schedule alone decides the end:
    // the two stand still on L1 and fall layer by layer as each layer collapses under them.
    const arm = sim.field.arm.bind(sim.field);
    sim.field.arm = (id, t, source) => (source === "collapse" ? arm(id, t, source) : false);
    const h = createHash("sha256");
    let marked = -1,
      done = -1;
    for (let i = 0; sim.phase !== "waiting" && i < 60 * 110; i++) {
      sim.step([{ x: 0, z: 0, jump: false }, { x: 0, z: 0, jump: false }, { x: 0, z: 0, jump: false }]);
      // The step's rules used round tick `tick − 1` (the clock has moved on since).
      if (sim.phase === "playing" && marked < 0 && sim.field.stats.armedByCollapse > 0) marked = sim.round.tick - 1;
      if (sim.phase === "results" && done < 0) done = sim.round.endedAt;
      h.update(Buffer.from(sim.field.goneTick.buffer));
      h.update(`${sim.phase}|${sim.round.alive}`);
    }
    return { hash: h.digest("hex"), marked, done };
  };
  const a = run(),
    b = run();
  console.log(JSON.stringify({ collapseFirstArm: a.marked / 60, endedAt: a.done / 60 }));
  assert.equal(a.hash, b.hash, "deterministic");
  assert.equal(a.marked, LAYER_TICKS.layerStarts[0] + LAYER_TICKS.warning, "the first ring arms 1 s after 70 s");
  assert.ok(a.done > 0 && a.done / 60 <= 96, `ended by ${(a.done / 60).toFixed(1)} s`);
});

test("recipient prediction block and snapshot size; server cost with 3 players and all 297 tiles", () => {
  const sim = new LayerRoundSimulation(newRoomCounters());
  sim.start([0, 1, 2]);
  const random = seeded(9);
  const bots = [0, 1, 2].map((id) => new LayerBot(id as PlayerId, random));
  bots.forEach((b) => b.reset());
  const boxes = [0, 1, 2].map(() => new InputMailbox());
  const seq = [0, 0, 0];
  const steps: number[] = [];
  let snapMs = 0,
    snaps = 0,
    snapBytes = 0,
    maxSnap = 0,
    eventBytes = 0,
    pending: GameEvent[] = [],
    ticks = 0;
  for (let i = 0; i < 60 * 60 && sim.phase !== "waiting"; i++) {
    for (const id of [0, 1, 2]) {
      const intent = bots[id].update(sim.game);
      if (sim.phase === "playing")
        boxes[id].accept({ seq: ++seq[id], round: sim.roundId, moveX: intent.x, moveZ: intent.z, jumpPressed: intent.jump, sprintHeld: !!intent.sprint, punchPressed: !!intent.punch }, sim.roundId, i * TICK_MS, "layer_chaos");
    }
    const began = performance.now();
    pending.push(...sim.step(boxes.map((b) => (sim.phase === "playing" ? b.read(i * TICK_MS) : { x: 0, z: 0, jump: false }))));
    steps.push(performance.now() - began);
    ticks++;
    if (sim.tick % 3) continue;
    const t0 = performance.now();
    const common = sim.snapshot([0, 0, 0]);
    const encoded = [0, 1, 2].map((id) => packr.pack({ ...common, prediction: sim.prediction(id as PlayerId) }));
    snapMs += performance.now() - t0;
    snaps++;
    for (const e of encoded) {
      snapBytes += e.byteLength;
      maxSnap = Math.max(maxSnap, e.byteLength);
    }
    if (pending.length) eventBytes += packr.pack(pending).byteLength;
    pending = [];
  }
  const p = sim.prediction(0);
  assert.equal(p.layers!.byteLength, LAYER_PREDICTION_BYTES);
  assert.ok(readLayerPredictionState(p.layers));
  assert.equal(p.controller.length, 0);
  const sorted = [...steps].sort((x, y) => x - y);
  const report = {
    ticks,
    stepAvgMs: +(steps.reduce((s, v) => s + v, 0) / steps.length).toFixed(3),
    stepP99Ms: +sorted[Math.floor(sorted.length * 0.99)].toFixed(3),
    stepMaxMs: +sorted[sorted.length - 1].toFixed(2),
    snapshotBuildEncode3Ms: +(snapMs / snaps).toFixed(3),
    snapshotAvgBytes: Math.round(snapBytes / snaps / 3),
    snapshotMaxBytes: maxSnap,
    downKBps: +((snapBytes / snaps / 3) * NET.snapshotHz / 1000 + eventBytes / (ticks / 60) / 1000).toFixed(1),
    eventKBps: +(eventBytes / (ticks / 60) / 1000).toFixed(2),
  };
  console.log(JSON.stringify(report));
  assert.ok(report.stepAvgMs < 2, "a step stays far below the 16.7 ms tick");
  assert.ok(maxSnap < 1600, `snapshot ≤ ${maxSnap} B`);
  sim.dispose();
});
