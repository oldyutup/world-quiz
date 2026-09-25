import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { before, test } from "node:test";
import { Packr } from "msgpackr";
import { initializePhysics } from "../../../shared/party-lab/simulation/physics";
import { ColorRoundSimulation } from "../../../shared/party-lab/simulation/colorRound";
import { newRoomCounters } from "../../../shared/party-lab/simulation/online";
import { connect, restore } from "../../../shared/party-lab/simulation/ragdoll/character";
import { RAGDOLL } from "../../../shared/party-lab/simulation/ragdoll/config";
import { COLOR_NEIGHBOURS, COLOR_TILES, colorSpawn, colorTileAt, colorTileAtCell, type ColorTile } from "../../../shared/party-lab/maps/colors";
import { COLOR_CHAOS, COLOR_TICKS, reactionTicks, type ColorIndex } from "../../../shared/party-lab/simulation/colors/config";
import { colorCounts, NO_COLOR } from "../../../shared/party-lab/simulation/colors/layouts";
import { FINAL_CYCLE, FOUR_TILES, SHRINK_START_CYCLE, STAGE_MASKS, STAGE_SIZES } from "../../../shared/party-lab/simulation/colors/shrink";
import type { ColorCycleState } from "../../../shared/party-lab/simulation/colors/schedule";
import { COLOR_BITSET_BYTES, COLOR_LAYOUT_BYTES, ColorFieldKnowledge, cycleTicks, decodeColorSnapshot, encodeColorField } from "../../../shared/party-lab/simulation/colors/wire";
import { readLayerPredictionState } from "../../../shared/party-lab/simulation/predictionState";
import { MODE_MAP, MODE_NAMES, MODE_SELECTIONS } from "../../../shared/party-lab/modes";
import {
  InputMailbox,
  LAYER_FLAG,
  LAYER_PREDICTION_BYTES,
  LAYER_RESULTS,
  NET,
  validateLayerInput,
  type ColorFieldSnapshot,
  type GameEvent,
  type GameSnapshot,
  type LayerInputPacket,
} from "../../../shared/party-lab/network/protocol";
import type { PlayerId } from "../../../shared/party-lab/simulation/players";
import { SnapshotBuffer } from "./gameStream";
import { ColorPredictionRig } from "./prediction/colorRig";
import { layerPacketIntent } from "./prediction/layerRig";

before(() => initializePhysics());
const packr = new Packr({ useRecords: false });
const TICK_MS = 1000 / NET.physicsHz;
const STAND = RAGDOLL.standHeight + 0.1;

/** An authoritative Renk Kaosu round, one mailbox per slot, the room's cadence (snapshot every third tick). */
function match(slots: PlayerId[] = [0, 1], { play = true, seed = 7 } = {}) {
  const sim = new ColorRoundSimulation(newRoomCounters(), { seed });
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
      assert.ok(boxes[id].accept(packet(id, p), sim.roundId, now, "color_chaos"), "valid packet accepted");
    });
    const out = sim.step(boxes.map((b) => (sim.phase === "playing" ? b.read(now) : { x: 0, z: 0, jump: false })));
    events.push(...out);
    if (sim.tick % (NET.physicsHz / NET.snapshotHz) === 0) snapshots.push(snap());
    return out;
  };
  const snap = (slot: PlayerId = 0): GameSnapshot => ({
    ...sim.snapshot(boxes.map((b) => (b.processedRound === sim.roundId ? b.processedSeq : -1))),
    prediction: sim.prediction(slot),
  });
  if (play) {
    while (sim.phase === "countdown") step();
    assert.equal(sim.phase, "playing");
  }
  return { sim, step, events, snapshots, boxes, packet, snap };
}
type Sim = ColorRoundSimulation;
const pelvis = (sim: Sim, id: PlayerId) => sim.physics.players[id].body.translation();
function place(sim: Sim, id: PlayerId, x: number, z: number, yaw = 0, y = STAND) {
  const c = sim.physics.players[id];
  restore(c, { x, y, z }, yaw);
  connect(sim.physics.world, c);
}
/** Every alive slot onto a tile of the target colour (interior first), so a scripted round runs to the end. */
function keepSafe(sim: Sim) {
  const { colors, target } = sim.schedule.cycle;
  const safe = COLOR_TILES.filter((t) => colors[t.id] === target).sort((a, b) => a.ring - b.ring);
  sim.game.slots.forEach((slot, k) => {
    if (!sim.round.alive[slot] || !safe.length) return;
    const t = safe[k % safe.length],
      offset = safe.length === 1 ? (k - 0.5) * 0.8 : 0;
    place(sim, slot, t.x + offset, t.z);
  });
}
/** Step (idle) until the start of round tick `tick` (the next step runs it). */
function stepTo(step: () => unknown, sim: Sim, tick: number) {
  while (sim.phase === "playing" && sim.round.tick < tick) step();
}
const tile = (q: number, r: number): ColorTile => colorTileAtCell({ q, r })!;
/** Wrong-colour tiles with no target neighbour (a body in the middle has no ledge to catch), innermost first. */
const interiorWrong = (c: ColorCycleState) =>
  COLOR_TILES.filter((t) => t.ring <= 4 && c.colors[t.id] !== c.target && COLOR_NEIGHBOURS[t.id].every((n) => c.colors[n] !== c.target)).sort((a, b) => a.ring - b.ring);
const decode = (s: GameSnapshot) => {
  const d = decodeColorSnapshot(s.colors);
  assert.ok(d, "a valid colours section");
  return d;
};
const sameCycle = (a: ColorCycleState, b: ColorCycleState, label: string) => {
  assert.deepEqual([a.index, a.start, a.announce, a.drop, a.restore, a.target, a.stage, a.final], [b.index, b.start, b.announce, b.drop, b.restore, b.target, b.stage, b.final], label);
  assert.deepEqual([...a.colors], [...b.colors], `${label}: colours`);
  assert.deepEqual([...a.present], [...b.present], `${label}: present`);
  assert.deepEqual([...a.warned], [...b.warned], `${label}: marked`);
};

// ─── Protocol, mode ─────────────────────────────────────────────────────────

test("protocol 7: Renk Kaosu is a game mode (lobby order, Karışık last); its packet is the shove-mode intent (colour, tile, target and result claims refused)", () => {
  assert.equal(NET.version, 7);
  assert.deepEqual([...MODE_SELECTIONS], ["rooftop_brawl", "barn_shootout", "layer_chaos", "color_chaos", "mixed"]);
  assert.equal(MODE_NAMES.color_chaos, "Renk Kaosu");
  assert.equal(MODE_MAP.color_chaos, "colors");
  const valid: LayerInputPacket = { seq: 4, round: 2, moveX: 1, moveZ: 1, jumpPressed: false, sprintHeld: true, punchPressed: false };
  for (const extra of [{ color: 1 }, { target: 2 }, { tile: 3 }, { safe: true }, { drop: 1 }, { restore: 1 }, { layout: 3 }, { hit: 1 }, { eliminated: true }, { winner: 0 }, { aimYaw: 0 }, { grabHeld: false }])
    assert.equal(validateLayerInput({ ...valid, ...extra }), null, `extra ${Object.keys(extra)[0]} refused`);
  const box = new InputMailbox();
  assert.ok(box.accept({ ...valid, seq: 1, round: 1, jumpPressed: true, punchPressed: true }, 1, 0, "color_chaos"));
  const read = box.read(1);
  assert.deepEqual([read.jump, read.punch, read.sprint, box.processedPunchSeq], [true, true, true, 1]);
  assert.ok(Math.abs(Math.hypot(read.x, read.z) - 1) < 1e-12, "normalised like the prediction replays it");
  const roof = { seq: 9, round: 1, moveX: 0, moveZ: 0, jumpPressed: false, punchPressed: false, grabHeld: false, liftHeld: false };
  assert.equal(new InputMailbox().accept(roof, 1, 0, "color_chaos"), false, "a rooftop packet in a colour round");
  assert.equal(new InputMailbox().accept({ ...valid, round: 1 }, 1, 0, "rooftop_brawl"), false);
  assert.equal(new InputMailbox().accept({ ...valid, round: 1 }, 1, 0, "barn_shootout"), false);
  const bytes = packr.pack({ ...valid, seq: 12345, round: 3, moveX: -0.7071067811865475, moveZ: 0.7071067811865476 }).byteLength;
  console.log(JSON.stringify({ colorInputBytes: bytes, colorUplinkBps: bytes * 60 }));
  assert.ok(bytes < 110, `${bytes} B per packet`);
});

// ─── Rounds ─────────────────────────────────────────────────────────────────

test("2 and 3 players: the approved spawns (opposite / 120°), empty seats have no body; a frozen 3 s countdown with every tile standing and cycle 1's colours shown", () => {
  const three = match([0, 1, 2], { play: false });
  for (const id of [0, 1, 2] as const) {
    const p = pelvis(three.sim, id),
      s = colorSpawn(3, id);
    assert.ok(Math.hypot(p.x - s.x, p.z - s.z) < 0.05, `slot ${id} on the three-player spawn ${id}`);
  }
  const still = match([0, 1, 2], { play: false });
  const layouts = new Set<string>();
  let ticks = 0;
  while (three.sim.phase === "countdown") {
    three.sim.step([0, 1, 2].map(() => ({ x: 1, z: 0, jump: true, punch: true, sprint: true })));
    still.sim.step([]);
    const d = decode(three.sim.snapshot([-1, -1, -1]));
    assert.equal(d.t, 0);
    assert.equal(d.cycle.index, 1);
    layouts.add(Buffer.from(d.cycle.colors).toString("hex"));
    assert.equal(three.sim.field.enabledColliders, 85, "every tile standing");
    ticks++;
  }
  assert.equal(ticks, COLOR_TICKS.countdown, "3 s countdown");
  assert.equal(layouts.size, 1, "cycle 1's colours stay put through the countdown");
  for (const id of [0, 1, 2] as const) assert.deepEqual(pelvis(three.sim, id), pelvis(still.sim, id), "frozen: inputs change nothing");
  assert.equal(three.events.filter((e) => e.name === "punchSwing" || e.name === "jump").length, 0);
  still.sim.dispose();
  three.sim.dispose();
  // Two players on any two seats: the two-player spawns, opposite, 12 m apart.
  for (const slots of [[0, 1], [0, 2], [1, 2]] as PlayerId[][]) {
    const duel = match(slots, { play: false });
    slots.forEach((id, k) => {
      const p = pelvis(duel.sim, id),
        s = colorSpawn(2, k);
      assert.ok(Math.hypot(p.x - s.x, p.z - s.z) < 0.05, `slot ${id} on the two-player spawn ${k}`);
    });
    const [a, b] = slots.map((id) => pelvis(duel.sim, id));
    assert.ok(Math.abs(Math.hypot(a.x - b.x, a.z - b.z) - 12) < 0.1, "opposite sides");
    const empty = [0, 1, 2].find((id) => !slots.includes(id as PlayerId)) as PlayerId;
    assert.ok(duel.sim.physics.players[empty].eliminated, "the empty seat has no body");
    assert.equal(duel.sim.schedule.players, 2, "a two-player opening layout (half-turn symmetric)");
    duel.sim.dispose();
  }
});

test("targets and layouts come from the server: a shuffle bag (every colour once per four cycles, never twice in a row), balanced 21/21/21/22 layouts, reproducible per seed and new every round", () => {
  const run = (seed: number, rounds = 1) => {
    const { sim, step } = match([0, 1], { seed });
    const out: { targets: ColorIndex[]; counts: string[] }[] = [];
    for (let r = 0; r < rounds; r++) {
      const targets: ColorIndex[] = [],
        counts: string[] = [];
      let last = 0;
      for (let i = 0; i < 60 * 80 && sim.phase === "playing"; i++) {
        step();
        const d = decode(sim.snapshot([-1, -1, -1]));
        if (d.cycle.index !== last) {
          last = d.cycle.index;
          targets.push(d.cycle.target);
          if (d.cycle.stage === 0) counts.push(colorCounts(d.cycle.colors).sort((a, b) => a - b).join("/"));
          keepSafe(sim);
        }
      }
      out.push({ targets, counts });
      // Next round: back to the lobby, then a fresh start (a new seed from the match seed).
      while (sim.phase === "playing") {
        for (const id of [1] as const) place(sim, id, 0, 0, 0, -20);
        step();
      }
      while (sim.phase !== "waiting") step();
      sim.start([0, 1]);
      while ((sim.phase as string) === "countdown") step();
    }
    sim.dispose();
    return out;
  };
  const [first, second] = run(3, 2);
  assert.ok(first.targets.length >= 18, `${first.targets.length} cycles`);
  for (let i = 1; i < first.targets.length; i++) assert.notEqual(first.targets[i], first.targets[i - 1], `no repeat at cycle ${i + 1}`);
  for (let b = 0; b + 4 <= first.targets.length; b += 4) assert.deepEqual([...first.targets.slice(b, b + 4)].sort(), [0, 1, 2, 3], `bag ${b / 4 + 1} holds every colour once`);
  // Cycle 1 is a symmetric opening (within the rules' spread of 2); every free layout is exactly 21/21/21/22.
  assert.ok(first.counts.slice(1).every((c) => c === "21/21/21/22"), `balanced: ${[...new Set(first.counts)]}`);
  const opening = first.counts[0].split("/").map(Number);
  assert.ok(opening[3] - opening[0] <= 2 && opening.reduce((a, b) => a + b, 0) === 85, `opening ${first.counts[0]}`);
  assert.deepEqual(run(3)[0].targets, first.targets, "same seed, same targets");
  assert.notDeepEqual(second.targets.slice(0, 12), first.targets.slice(0, 12), "the next round draws a new sequence");
});

test("exact ticks: the snapshot's cycle ticks follow the approved reaction schedule; non-target colliders go ON the drop tick, all back ON the restore tick; the target collider never goes", () => {
  const { sim, step } = match([0, 1], { seed: 5 });
  const seen = new Map<number, readonly number[]>();
  let checked = 0;
  for (let i = 0; i < 60 * 45 && sim.phase === "playing"; i++) {
    const t = sim.round.tick;
    step();
    const cycle = sim.schedule.cycle;
    if (sim.game.event === "target") keepSafe(sim);
    if (!seen.has(cycle.index)) seen.set(cycle.index, [cycle.start, cycle.announce, cycle.drop, cycle.restore]);
    for (const tile of COLOR_TILES) {
      const expected = cycle.colors[tile.id] === cycle.target || (cycle.present[tile.id] === 1 && t < cycle.drop);
      if (sim.field.intact(tile.id) !== expected) assert.fail(`tick ${t} tile ${tile.id}`);
      if (sim.field.colliders[tile.id].isEnabled() !== expected) assert.fail(`tick ${t} collider ${tile.id}`);
      checked++;
    }
  }
  const reactions = [...seen.entries()].map(([n, k]) => [n, (k[2] - k[1]) / 60]);
  console.log(JSON.stringify({ reactions: reactions.slice(0, 11), checked }));
  for (const [n, k] of seen) assert.deepEqual([...k], [...cycleTicks(n)], `cycle ${n}: the snapshot's ticks follow from its number`);
  assert.deepEqual(
    reactions.slice(0, 10).map(([, s]) => s),
    [2.6, 2.6, 2.2, 2.2, 1.8, 1.8, 1.5, 1.5, 1.2, 1.2]
  );
  for (let n = 9; n <= 40; n++) assert.equal(reactionTicks(n), 72, "never below 1.2 s");
  assert.deepEqual([...cycleTicks(1)], [0, 0, 156, 246], "cycle 1: target on the first playing tick, drop 2.6 s, restore 1.5 s later");
  assert.equal(cycleTicks(2)[1] - cycleTicks(2)[0], 54, "0.9 s preview");
  assert.equal(cycleTicks(9)[0], 60 * 34.5, "the 1.2 s timer starts at 34.5 s");
  sim.dispose();
});

// ─── The colour section ─────────────────────────────────────────────────────

test("colour section: every snapshot rebuilds the exact floor (cycle, ticks, target, colour per tile, present, grey, marked) — a reconnect needs no history; tampered or stale sections are refused", () => {
  const { sim, step } = match([0, 1], { seed: 19 });
  const bytes: number[] = [];
  let checked = 0,
    stages = new Set<number>();
  for (let i = 0; i < 60 * 130 && sim.phase === "playing"; i++) {
    step();
    if (sim.game.event === "target") keepSafe(sim);
    if (i % 7) continue;
    const s = sim.snapshot([-1, -1, -1]);
    const d = decode(s);
    sameCycle(d.cycle, sim.schedule.cycle, `tick ${d.t}`);
    stages.add(d.cycle.stage);
    bytes.push(packr.pack(s.colors).byteLength);
    // A client that only ever saw this snapshot (a reconnect) knows the collider of every tile now.
    const k = new ColorFieldKnowledge();
    k.apply(s.round, d);
    for (const tile of COLOR_TILES) if (k.standing(tile.id, d.t - 1) !== sim.field.intact(tile.id)) assert.fail(`reconnect view of tile ${tile.id} at ${d.t - 1}`);
    checked++;
  }
  assert.deepEqual([...stages].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8], "every Daralma stage went over the wire");
  const s = sim.snapshot([-1, -1, -1]).colors!;
  assert.equal(s.p.byteLength, COLOR_BITSET_BYTES);
  assert.equal(s.c.byteLength, COLOR_LAYOUT_BYTES);
  console.log(JSON.stringify({ colorSectionBytes: [Math.min(...bytes), Math.max(...bytes)], checked }));
  assert.ok(Math.max(...bytes) <= 130, `section ${Math.max(...bytes)} B`);
  // Refused: another cycle's ticks, a floor that does not follow from the cycle, lengths, ranges.
  const good = sim.snapshot([-1, -1, -1]).colors!;
  const flip = (b: Uint8Array, id: number) => {
    const out = b.slice();
    out[id >> 3] ^= 1 << (id & 7);
    return out;
  };
  const bad: Partial<ColorFieldSnapshot>[] = [
    { k: [good.k[0] + 1, ...good.k.slice(1)] },
    { n: good.n + 1 },
    { n: 0 },
    { h: 4 },
    { p: flip(good.p, FOUR_TILES[0]) },
    { g: flip(good.g, FOUR_TILES[1]) },
    { m: flip(good.m, 40) },
    { p: good.p.slice(0, 10) },
    { c: new Uint8Array(21) },
    { f: [0, 0] },
    { o: [-2, -1, -1] },
    { r: 9 },
    { t: -1 },
  ];
  assert.ok(decodeColorSnapshot(good));
  for (const change of bad) assert.equal(decodeColorSnapshot({ ...good, ...change }), null, `refused: ${JSON.stringify(Object.keys(change))}`);
  assert.equal(decodeColorSnapshot(null), null);
  sim.dispose();
});

test("field knowledge ahead of the newest snapshot: from any snapshot, every later tick up to the next cycle's drop gets the server's exact colliders (the restore included)", () => {
  const { sim, step } = match([0, 1], { seed: 29 });
  const truth = new Map<number, string>();
  const snaps: { t: number; d: NonNullable<ReturnType<typeof decodeColorSnapshot>>; round: number }[] = [];
  for (let i = 0; i < 60 * 40 && sim.phase === "playing"; i++) {
    const t = sim.round.tick;
    step();
    if (sim.game.event === "target") keepSafe(sim);
    truth.set(t, COLOR_TILES.map((tile) => (sim.field.intact(tile.id) ? 1 : 0)).join(""));
    if (sim.tick % 3 === 0) {
      const s = sim.snapshot([-1, -1, -1]);
      snaps.push({ t: s.colors!.t, d: decode(s), round: s.round });
    }
  }
  let checked = 0;
  for (const { d, round } of snaps) {
    const k = new ColorFieldKnowledge();
    k.apply(round, d);
    // A prediction runs at most 30 ticks (500 ms) ahead; check 40.
    for (let tick = d.t; tick < d.t + 40; tick++) {
      const want = truth.get(tick);
      if (want === undefined) continue;
      const got = COLOR_TILES.map((tile) => (k.standing(tile.id, tick) ? 1 : 0)).join("");
      if (got !== want) assert.fail(`snapshot t ${d.t} → tick ${tick}`);
      checked++;
    }
  }
  console.log(JSON.stringify({ aheadChecked: checked }));
  assert.ok(checked > 20000);
  sim.dispose();
});

// ─── Momentum grace, drop boundary ──────────────────────────────────────────

/**
 * A straight run along +x toward the target tile (2, 0) over non-target tiles, timed so the
 * pelvis is `gap` m short of the tile's near edge on the drop tick (two passes: the run is
 * shift-invariant). The server decides; a prediction rig restored from a snapshot a few ticks
 * before the drop, fed the same packets, must reach the same outcome.
 */
function graceRun(gap: number, sprint: boolean, restoreBefore = 8) {
  const attempt = (startX: number) => {
    const { sim, step, snap } = match([0, 1], { seed: 41 });
    const cycle = sim.schedule.cycle;
    const goal = tile(2, 0),
      park = tile(-2, 4);
    // The test fixes the colours (the server sends whatever its schedule holds): only the goal and slot 1's tile keep the target.
    cycle.colors.forEach((_, id) => (cycle.colors[id] = id === goal.id || id === park.id ? cycle.target : (cycle.target + 1) % 4));
    place(sim, 1, park.x, park.z);
    const runTicks = 70;
    stepTo(step, sim, cycle.drop - runTicks);
    place(sim, 0, startX, goal.z, Math.PI / 2);
    const packets: Partial<LayerInputPacket>[] = [];
    let rig: ColorPredictionRig | null = null,
      atDrop = NaN;
    const serverY: number[] = [],
      rigY: number[] = [];
    for (let i = 0; i < runTicks + 150; i++) {
      const tick = sim.round.tick;
      const p = pelvis(sim, 0);
      const brake = goal.x - p.x < 0.2 + sim.physics.players[0].body.linvel().x ** 2 / 18;
      const input = { moveX: brake ? 0 : 1, sprintHeld: sprint };
      if (tick === cycle.drop - restoreBefore) {
        const s = snap(0);
        const buffer = new SnapshotBuffer();
        buffer.push(s, 0);
        rig = new ColorPredictionRig(0);
        assert.ok(rig.restore(s, buffer.latest!.values), "the rig restores from the snapshot");
      }
      if (tick === cycle.drop) atDrop = goal.x - 1 - p.x;
      step([input]);
      packets.push(input);
      if (rig) {
        const r = rig.step(layerPacketIntent({ seq: 1, round: 1, moveX: input.moveX, moveZ: 0, jumpPressed: false, sprintHeld: sprint, punchPressed: false }, false));
        assert.ok(r.valid);
        serverY.push(pelvis(sim, 0).y);
        rigY.push(rig.character.body.translation().y);
        // The rig's colliders are the server's on every tick (until the rig calls the body out and stops).
        if (!rig.out) for (const t of COLOR_TILES) if (rig.standing(t.id) !== sim.field.intact(t.id)) assert.fail(`tick ${tick}: rig collider ${t.id}`);
      }
      if (sim.phase !== "playing") break;
    }
    const saved = sim.round.alive[0] && pelvis(sim, 0).y > 0.3;
    const rigSaved = !!rig && rig.character.body.translation().y > 0.3 && !rig.out;
    const divergence = Math.max(...serverY.map((y, i) => Math.abs(y - rigY[i])));
    rig?.dispose();
    sim.dispose();
    return { saved, rigSaved, atDrop, divergence };
  };
  const probe = attempt(-7);
  const goalEdge = tile(2, 0).x - 1;
  const r = attempt(-7 + (goalEdge - gap - (goalEdge - probe.atDrop)));
  return r;
}

test("momentum grace online: running at the target when its floor drops, the server catches a walker ≈ 1.1 m and a sprinter ≈ 1.6 m short — and the prediction rig reaches the same outcome on the same ticks", () => {
  const rows: unknown[] = [];
  const check = (gap: number, sprint: boolean, expected: boolean) => {
    const r = graceRun(gap, sprint);
    rows.push({ gap, sprint, short: +r.atDrop.toFixed(2), saved: r.saved, rig: r.rigSaved, divergence: +r.divergence.toFixed(4) });
    assert.ok(Math.abs(r.atDrop - gap) < 0.12, `${r.atDrop.toFixed(2)} m short on the drop tick (wanted ${gap})`);
    assert.equal(r.saved, expected, `${sprint ? "sprinting" : "walking"} ${gap} m short: ${expected ? "saved" : "falls"}`);
    assert.equal(r.rigSaved, r.saved, "the prediction agrees");
  };
  for (const gap of [0.3, 0.9]) check(gap, false, true);
  for (const gap of [1.4, 1.9]) check(gap, false, false);
  for (const gap of [0.9, 1.4]) check(gap, true, true);
  for (const gap of [2.0, 2.4]) check(gap, true, false);
  console.log(JSON.stringify(rows));
});

test("drop boundary: restored from a snapshot 2, 1 or 0 ticks before the drop (and 1 after), the rig drops the same colliders on the same tick and its body follows the server's", () => {
  for (const before of [2, 1, 0, -1]) {
    const { sim, step, snap } = match([0, 1], { seed: 13 });
    const cycle = sim.schedule.cycle;
    // Slot 0 stands in the middle of a wrong tile (it falls), slot 1 on a target tile.
    const wrong = interiorWrong(cycle)[0];
    const safe = COLOR_TILES.find((t) => cycle.colors[t.id] === cycle.target && Math.hypot(t.x - wrong.x, t.z - wrong.z) > 4)!;
    place(sim, 1, safe.x, safe.z);
    stepTo(step, sim, cycle.drop - 40);
    place(sim, 0, wrong.x, wrong.z);
    stepTo(step, sim, cycle.drop - before);
    const s = snap(0);
    const buffer = new SnapshotBuffer();
    buffer.push(s, 0);
    const rig = new ColorPredictionRig(0);
    assert.ok(rig.restore(s, buffer.latest!.values));
    assert.equal(rig.tick, cycle.drop - before);
    let fellServer = -1,
      fellRig = -1,
      maxDiff = 0;
    for (let i = 0; i < 40; i++) {
      const tick = sim.round.tick;
      step();
      rig.step({ x: 0, z: 0, jump: false });
      for (const t of COLOR_TILES) if (rig.standing(t.id) !== sim.field.intact(t.id)) assert.fail(`before ${before}, tick ${tick}: collider ${t.id}`);
      const ys = pelvis(sim, 0).y,
        yr = rig.character.body.translation().y;
      maxDiff = Math.max(maxDiff, Math.abs(ys - yr));
      if (fellServer < 0 && ys < 0.5) fellServer = tick;
      if (fellRig < 0 && yr < 0.5) fellRig = tick;
    }
    assert.ok(fellServer >= cycle.drop, "the server body falls after the drop");
    assert.equal(fellRig, fellServer, `the rig falls on the server's tick (restored ${before} before the drop)`);
    assert.ok(maxDiff < 0.01, `rig ≈ server (${maxDiff.toFixed(4)} m)`);
    rig.dispose();
    sim.dispose();
  }
});

// ─── Restore, elimination ───────────────────────────────────────────────────

test("restore: hips below the floor on the restore tick are out on that tick — the server's rule, applied by the rig on the same tick; on the floor nobody is", () => {
  const { sim, step, snap } = match([0, 1], { seed: 12 });
  const cycle = sim.schedule.cycle;
  const safes = COLOR_TILES.filter((t) => t.ring <= 3 && cycle.colors[t.id] === cycle.target);
  const safe = safes[0];
  const hole = COLOR_TILES.find((t) => t.ring <= 3 && cycle.colors[t.id] !== cycle.target && Math.hypot(t.x - safe.x, t.z - safe.z) > 3)!;
  place(sim, 0, safes[1].x, safes[1].z);
  place(sim, 1, safe.x, safe.z);
  stepTo(step, sim, cycle.restore - 1);
  // Slot 0 hangs in a hole just below the surface as the tiles return.
  place(sim, 0, hole.x, hole.z, 0, -0.9);
  sim.physics.players[0].body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  const s = snap(0);
  // The prediction block marks it alive: the rig predicts it and applies the rule on the restore tick.
  assert.ok(readLayerPredictionState(s.prediction!.layers)!.alive === 1);
  const buffer = new SnapshotBuffer();
  buffer.push(s, 0);
  const rig = new ColorPredictionRig(0);
  assert.ok(rig.restore(s, buffer.latest!.values));
  rig.step({ x: 0, z: 0, jump: false });
  step();
  assert.ok(!rig.out && sim.round.alive[0], "still in before the restore tick");
  rig.step({ x: 0, z: 0, jump: false });
  const events = step();
  assert.equal(sim.game.event, "restore");
  assert.equal(sim.round.outAt[0], cycle.restore, "out on the restore tick");
  assert.equal(rig.outTick, cycle.restore, "the rig calls it on the same tick");
  assert.ok(events.some((e) => e.name === "fall" && e.actor === 0));
  assert.deepEqual([sim.phase, sim.winner], ["results", 1]);
  assert.equal(sim.physics.diagnostics.invalidBodies, 0, "never trapped in a returning tile");
  rig.dispose();
  sim.dispose();
  // On the floor at the restore: nothing happens.
  const calm = match([0, 1], { seed: 12 });
  place(calm.sim, 0, safe.x, safe.z);
  place(calm.sim, 1, safe.x + 0.2, safe.z + 0.9);
  stepTo(calm.step, calm.sim, calm.sim.schedule.cycle.restore + 1);
  assert.ok(calm.sim.round.alive[0] && calm.sim.round.alive[1]);
  calm.sim.dispose();
});

test("elimination: a wrong colour falls out, the target holds; the last alive wins; the last two on one tick draw; leaving forfeits; no respawn; results then the lobby", () => {
  const { sim, step } = match([0, 1, 2], { seed: 8 });
  const cycle = sim.schedule.cycle;
  const safe = COLOR_TILES.filter((t) => t.ring <= 3 && cycle.colors[t.id] === cycle.target);
  const wrong = interiorWrong(cycle)[0];
  place(sim, 0, safe[0].x, safe[0].z);
  place(sim, 1, wrong.x, wrong.z);
  place(sim, 2, safe[safe.length - 1].x, safe[safe.length - 1].z);
  const events: GameEvent[] = [];
  while (sim.phase === "playing" && sim.round.tick < cycle.restore) events.push(...step());
  assert.ok(!sim.round.alive[1], "the wrong colour fell out");
  assert.ok(sim.round.outAt[1] > cycle.drop && sim.round.outAt[1] < cycle.restore, `out ${((sim.round.outAt[1] - cycle.drop) / 60).toFixed(2)} s after the drop`);
  assert.ok(sim.round.alive[0] && sim.round.alive[2], "the target holds");
  assert.ok(events.some((e) => e.name === "fall" && e.actor === 1));
  const s = sim.snapshot([-1, -1, -1]);
  assert.equal(s.alive & 0b010, 0);
  assert.equal(s.colors!.f[1] & (LAYER_FLAG.alive | LAYER_FLAG.body), 0);
  for (let i = 0; i < 200; i++) step();
  assert.ok(sim.physics.players[1].eliminated, "no respawn");
  sim.remove(2);
  step();
  assert.deepEqual([sim.phase, sim.winner], ["results", 0]);
  assert.equal(sim.snapshot([-1, -1, -1]).colors!.r, LAYER_RESULTS.indexOf("forfeit"));
  let ticks = 0;
  while (sim.phase === "results") {
    step();
    ticks++;
  }
  assert.equal(ticks, COLOR_TICKS.results, "3.5 s of results");
  assert.equal(sim.phase, "waiting");
  sim.dispose();
  // The last two off the field on the same tick: a draw.
  const duel = match([0, 1]);
  const d = duel.sim.schedule.cycle;
  const wrongs = interiorWrong(d);
  // Two wrong tiles at the same x (mirror images in z): identical falls.
  const pair = wrongs.flatMap((u) => wrongs.filter((w) => w.id !== u.id && Math.abs(w.x - u.x) < 1e-9 && Math.abs(w.z + u.z) < 1e-9).map((w) => [u, w]))[0];
  assert.ok(pair, "a mirrored pair of wrong tiles");
  place(duel.sim, 0, pair[0].x, pair[0].z);
  place(duel.sim, 1, pair[1].x, pair[1].z);
  // Identical drops: whichever body is out, it is out on the same tick as the other.
  const outs: GameEvent[] = [];
  while (duel.sim.phase === "playing") outs.push(...duel.step());
  assert.equal(duel.sim.round.outAt[0], duel.sim.round.outAt[1], "same tick");
  assert.deepEqual([duel.sim.winner, duel.sim.snapshot([-1, -1, -1]).colors!.r], [-1, LAYER_RESULTS.indexOf("all-fell")]);
  assert.ok(outs.some((e) => e.name === "draw"));
  duel.sim.dispose();
});

test("punch online: the server decides contact, the ≈ 3 m/s shove and the 0.35 s stagger (in the snapshot); 0.6 s cooldown; sprint ×1.4 and jump by packet", () => {
  const { sim, step, events } = match([0, 1], { seed: 4 });
  const a = tile(0, 0),
    b = tile(1, 0);
  place(sim, 0, a.x + 0.35, a.z, Math.PI / 2);
  place(sim, 1, b.x - 0.35, b.z, -Math.PI / 2);
  for (let i = 0; i < 20; i++) step();
  const before = { ...pelvis(sim, 1) };
  let hitAt = -1,
    stagger = false;
  for (let i = 0; i < 40 && hitAt < 0; i++) {
    const out = step([{ punchPressed: i < 2 }]);
    if (out.some((e) => ["headHit", "bodyHit", "limbHit"].includes(e.name) && e.actor === 0 && e.target === 1)) hitAt = i;
  }
  assert.ok(hitAt >= 0, "the punch lands by real hand contact");
  const target = sim.game.brawl.fighters[1];
  assert.ok(target.stagger.time > 0.3 - 1e-9, "stagger started (0.35 s)");
  stagger = !!(sim.snapshot([-1, -1, -1]).colors!.f[1] & LAYER_FLAG.staggered);
  assert.ok(stagger, "stagger visible to every client");
  assert.equal(sim.game.brawl.tuning, COLOR_CHAOS.punch);
  let staggerTicks = 0;
  while (sim.game.brawl.fighters[1].stagger.time > 1e-9) {
    step();
    staggerTicks++;
  }
  const moved = Math.hypot(pelvis(sim, 1).x - before.x, pelvis(sim, 1).z - before.z);
  console.log(JSON.stringify({ punchHitTick: hitAt, shove: +moved.toFixed(2), staggerTicks }));
  assert.ok(moved > 0.3 && moved < 2, `pushed ${moved.toFixed(2)} m, no knockout`);
  assert.ok(Math.abs(staggerTicks - 20) <= 1, `${staggerTicks} ticks left of the 21-tick stagger`);
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
  // Sprint and jump from packets on the colour field (the whole field kept standing: the first cycle's preview-free timer is long enough).
  const speed = (sprint: boolean) => {
    const m = match([0, 1], { seed: 4 });
    place(m.sim, 0, tile(-4, 0).x, 0, Math.PI / 2);
    for (let i = 0; i < 10; i++) m.step();
    for (let i = 0; i < 30; i++) m.step([{ moveX: 1, sprintHeld: sprint }]);
    const from = pelvis(m.sim, 0).x;
    for (let i = 0; i < 30; i++) m.step([{ moveX: 1, sprintHeld: sprint }]);
    const v = (pelvis(m.sim, 0).x - from) * 2;
    let apex = 0;
    const base = pelvis(m.sim, 0).y;
    for (let i = 0; i < 40; i++) {
      m.step([{ jumpPressed: i === 2 }]);
      apex = Math.max(apex, pelvis(m.sim, 0).y - base);
    }
    m.sim.dispose();
    return { v, apex };
  };
  const walk = speed(false),
    run = speed(true);
  console.log(JSON.stringify({ walk: +walk.v.toFixed(2), sprint: +run.v.toFixed(2), ratio: +(run.v / walk.v).toFixed(2), jump: +walk.apex.toFixed(2) }));
  assert.ok(run.v / walk.v > 1.25 && run.v / walk.v < 1.55, `sprint ×${(run.v / walk.v).toFixed(2)}`);
  assert.ok(walk.apex > 0.5, `jumped ${walk.apex.toFixed(2)} m`);
});

// ─── Daralma, final drop ────────────────────────────────────────────────────

test("daralma online: cycle 19 marks the first rim, cycle 20 shows it grey, then it is gone for good; 85 → 73 → 61 → 43 → 31 → 19 → 7 → 4 → 0; the four-tile finale has one tile per colour; the final drop is SON and the last one down wins", () => {
  const { sim, step } = match([0, 1], { seed: 23 });
  const byCycle = new Map<number, ColorCycleState>();
  const sizes: number[] = [];
  let finalDrop = -1;
  for (let i = 0; i < 60 * 130 && sim.phase === "playing"; i++) {
    step();
    if (sim.game.event === "target") keepSafe(sim);
    if (sim.game.event === "drop" && sim.schedule.cycle.final) finalDrop = sim.round.tick - 1;
    if (sim.phase !== "playing") break;
    const d = decode(sim.snapshot([-1, -1, -1]));
    if (!byCycle.has(d.cycle.index)) {
      byCycle.set(d.cycle.index, d.cycle);
      const coloured = d.cycle.colors.filter((c) => c !== NO_COLOR).length;
      if (sizes[sizes.length - 1] !== coloured) sizes.push(coloured);
    }
  }
  assert.deepEqual(sizes, [...STAGE_SIZES], "the coloured field over the wire");
  const count = (a: Uint8Array) => a.reduce((n, x) => n + x, 0);
  for (let n = 1; n < SHRINK_START_CYCLE; n++) assert.equal(count(byCycle.get(n)!.warned), 0, `cycle ${n}: nothing marked`);
  const marked = byCycle.get(SHRINK_START_CYCLE)!,
    grey = byCycle.get(SHRINK_START_CYCLE + 1)!,
    after = byCycle.get(SHRINK_START_CYCLE + 2)!;
  assert.equal(SHRINK_START_CYCLE, 19);
  assert.equal(marked.start / 60, 70.5, "the shrink starts at 70.5 s");
  assert.equal(count(marked.warned), 12, "cycle 19: the rim's 12 tiles marked (DARALIYOR!), still coloured");
  for (let id = 0; id < COLOR_TILES.length; id++) {
    if (!marked.warned[id]) continue;
    assert.notEqual(marked.colors[id], NO_COLOR, "marked tiles still play");
    assert.ok(grey.present[id] && grey.colors[id] === NO_COLOR, "cycle 20: they are back grey");
    assert.notEqual(grey.target, NO_COLOR);
    assert.equal(after.present[id], 0, "cycle 21: gone for good");
  }
  const four = [...byCycle.values()].find((c) => c.stage === 7)!;
  assert.deepEqual(COLOR_TILES.filter((t) => four.colors[t.id] !== NO_COLOR).map((t) => t.id).sort((a, b) => a - b), [...FOUR_TILES].sort((a, b) => a - b));
  assert.deepEqual([...FOUR_TILES].map((id) => four.colors[id]).sort(), [0, 1, 2, 3], "one tile per colour: exactly one safe tile");
  const last = byCycle.get(FINAL_CYCLE)!;
  assert.ok(last.final && last.colors.every((c) => c === NO_COLOR), "the final cycle has no colour (SON!)");
  assert.equal(count(last.present), 4, "the four tiles stand grey until the final drop");
  assert.equal(finalDrop, last.drop);
  assert.equal(+(finalDrop / 60).toFixed(1), 119.4);
  assert.equal(sim.phase, "results");
  assert.ok(sim.round.endedAt > finalDrop && sim.round.endedAt < finalDrop + 90, "decided by the last fall, well inside the 125 s safety net");
  assert.ok(["survivor", "all-fell"].includes(sim.round.reason!));
  for (const id of [0, 1] as const) if (sim.round.winner !== id) assert.ok(sim.round.outAt[id] <= sim.round.endedAt);
  if (sim.round.winner !== null) assert.ok(sim.round.outAt[sim.round.winner] < 0 || sim.round.outAt[sim.round.winner] >= Math.max(...[0, 1].map((id) => sim.round.outAt[id])), "the winner fell last");
  assert.equal(sim.physics.diagnostics.invalidBodies, 0);
  sim.dispose();
});

test("determinism: the same seed and inputs give the same round, tick for tick (layouts, targets, bodies, result)", () => {
  const run = () => {
    const { sim, step } = match([0, 1, 2], { seed: 77 });
    const h = createHash("sha256");
    for (let i = 0; i < 60 * 40 && sim.phase === "playing"; i++) {
      step([{ moveX: Math.sin(i / 50), moveZ: Math.cos(i / 70), sprintHeld: i % 200 > 120, jumpPressed: i % 90 === 3, punchPressed: i % 41 === 5 }, { moveX: -1, punchPressed: i % 37 === 1 }]);
      const s = sim.snapshot([-1, -1, -1]);
      h.update(Buffer.from(s.transforms));
      h.update(packr.pack(s.colors));
    }
    const out = `${h.digest("hex")}|${sim.phase}|${sim.round.alive}`;
    sim.dispose();
    return out;
  };
  assert.equal(run(), run());
});

test("snapshot size, prediction block and server cost with 3 players on the 85-tile field", () => {
  const { sim, step, snap } = match([0, 1, 2], { seed: 31 });
  const steps: number[] = [],
    builds: number[] = [];
  let wire = 0;
  for (let i = 0; i < 60 * 30 && sim.phase === "playing"; i++) {
    const began = performance.now();
    // Moving, jumping and punching until just before each drop; still through the unsafe window.
    const c = sim.schedule.cycle,
      calm = sim.round.tick >= c.drop - 4 && sim.round.tick < c.restore;
    step(calm ? [] : [{ moveX: 0.6 * Math.sin(i / 40), moveZ: 0.6 * Math.cos(i / 55), sprintHeld: i % 150 > 90, jumpPressed: i % 97 === 0, punchPressed: i % 43 === 0 }, { moveX: 0.5 * Math.cos(i / 30) }, { moveZ: 0.5 * Math.sin(i / 45) }]);
    steps.push(performance.now() - began);
    // Everyone moves all the time, and is put back on the target colour just before each drop (a long round).
    if (sim.phase === "playing" && (sim.round.tick === sim.schedule.cycle.drop - 4 || sim.game.event === "restore")) keepSafe(sim);
    if (i % 3 === 0) {
      const b = performance.now();
      const s = snap(0);
      builds.push(performance.now() - b);
      wire = Math.max(wire, packr.pack(s).byteLength);
    }
  }
  const s = snap(0);
  assert.equal(s.prediction!.layers!.byteLength, LAYER_PREDICTION_BYTES);
  assert.ok(!s.layers && !s.barn, "only the colour section");
  const sorted = [...steps].sort((a, b) => a - b);
  const avg = steps.reduce((a, b) => a + b, 0) / steps.length;
  const report = {
    stepAvgMs: +avg.toFixed(3),
    stepP99Ms: +sorted[Math.floor(sorted.length * 0.99)].toFixed(3),
    snapshotBuildMs: +(builds.reduce((a, b) => a + b, 0) / builds.length).toFixed(3),
    snapshotBytes: wire,
    sectionBytes: packr.pack(s.colors).byteLength,
  };
  console.log(JSON.stringify(report));
  assert.ok(avg < 2, `step ${avg.toFixed(3)} ms`);
  assert.ok(wire < 1500, `snapshot ${wire} B`);
  // The section is built from the schedule alone.
  assert.deepEqual(packr.pack({ ...encodeColorField(sim.schedule.cycle) }), packr.pack({ n: s.colors!.n, k: s.colors!.k, h: s.colors!.h, p: s.colors!.p, g: s.colors!.g, m: s.colors!.m, c: s.colors!.c }));
  // A playing snapshot's section tick is the next step's (the drawn tick is t − 1); in results the final one.
  assert.equal(s.colors!.t, sim.roundTick);
  assert.ok(steps.length > 60 * 20, `${steps.length} ticks measured`);
  assert.ok(STAGE_MASKS.length === 9);
  sim.dispose();
  void colorTileAt;
});
