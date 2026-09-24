import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import RAPIER from "@dimforge/rapier3d-compat";
import { Mesh, MeshLambertMaterial, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { silentFeedback } from "../audio/events";
import type { MovementInput } from "../input/types";
import { initializePhysics, IDLE_INPUT, PlaygroundPhysics } from "./physics";
import type { PlayerId } from "./players";
import { connect, restore, type Character } from "./ragdoll/character";
import { RAGDOLL } from "./ragdoll/config";
import { rotate } from "./ragdoll/math";
import { LayerBot } from "./layers/bots";
import { landingMarker, layerIntent } from "./layers/controls";
import { LayerChaosGame, retire } from "./layers/game";
import { LayerFall, LAYER_FALL } from "./layers/fall";
import { boomDirection, freeBoom, intactTileNear, LAYER_CAMERA, LayerFollow, updateLayerCamera, type LayerCameraState } from "./layers/layerCamera";
import {
  buildSkyScenery,
  CLOUD_TOP_MAX,
  HEX_LAYER_CLEARANCE,
  pieceMatrix,
  readSkyKit,
  SKY_CLEAR_RADIUS,
  SKY_NODES,
  SKY_PIECES,
  type SkyPiece,
} from "./layers/skyScenery";
import { spawnYaw, type ArenaMap } from "../../../shared/party-lab/maps";
import {
  HEX,
  HEX_DIRECTIONS,
  hexAt,
  hexContains,
  hexDistance,
  LAYER_CELLS,
  LAYER_INDICES,
  LAYER_OUTER_RING,
  LAYER_SPAWN_HEIGHT,
  LAYER_TILES,
  LAYER_TOPS,
  LAYERS_MAP,
  tileAt,
  tileAtCell,
  tileNeighbours,
  type HexCoord,
  type LayerIndex,
  type LayerTile,
} from "../../../shared/party-lab/maps/layers";
import { breakTicks, LAYER_CHAOS, LAYER_TICKS, schedulePhase } from "../../../shared/party-lab/simulation/layers/config";
import { LayerBrawl } from "../../../shared/party-lab/simulation/layers/brawl";
import { LayerRound } from "../../../shared/party-lab/simulation/layers/round";
import { collapseArmTick, collapseWarnTick, TileField } from "../../../shared/party-lab/simulation/layers/tiles";
import { supportingTile } from "../../../shared/party-lab/simulation/layers/trigger";

before(async () => {
  await initializePhysics();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const tile = (layer: LayerIndex, q: number, r: number): LayerTile => {
  const t = tileAtCell(layer, { q, r });
  assert.ok(t, `L${layer + 1} has a tile at (${q},${r})`);
  return t;
};
const STAND = RAGDOLL.standHeight + 0.1;
/**
 * Raw physics on the tile field, only slot 0 in play (nothing arms unless a test arms it).
 * One world step builds the scene-query structure, as the game's first step does.
 */
function field() {
  const physics = new PlaygroundPhysics(silentFeedback, LAYERS_MAP);
  const tiles = new TileField(physics.world);
  for (const c of physics.players) if (c.id !== 0) retire(c);
  physics.world.step();
  return { physics, tiles };
}
function place(physics: PlaygroundPhysics, id: PlayerId, x: number, y: number, z: number, facing = Math.PI / 2) {
  const c = physics.players[id];
  restore(c, { x, y, z }, facing);
  connect(physics.world, c);
  return c;
}
const pelvis = (c: Character) => c.body.translation();
const upright = (c: Character) => rotate(c.body.rotation(), { x: 0, y: 1, z: 0 }).y;
function settle(physics: PlaygroundPhysics, ticks = 40) {
  for (let i = 0; i < ticks; i++) physics.step([IDLE_INPUT, IDLE_INPUT, IDLE_INPUT]);
}
const walk = (x: number, z: number, extra: Partial<MovementInput> = {}): MovementInput => ({ x, z, jump: false, ...extra });
/** A 30 × 30 m slab at y = 0: the same walks on it are the no-seam reference. */
const SLAB_MAP: ArenaMap = {
  ...LAYERS_MAP,
  id: "test",
  colliders: [{ role: "floor", shape: "box", center: { x: 0, y: -0.25, z: 0 }, half: { x: 15, y: 0.25, z: 15 } }],
};
/** Game fast-forwarded to its first playing tick (countdown elapsed, nothing armed yet). */
function started(players: 2 | 3 = 3) {
  const game = new LayerChaosGame(silentFeedback, { players });
  const idle = [IDLE_INPUT, IDLE_INPUT, IDLE_INPUT];
  while (game.step(idle) !== "started");
  return game;
}

// ─── Tiles and layers ──────────────────────────────────────────────────────

test("297 hex tiles: L1 85, L2 79, L3 78, L4 55, 5.5 m apart, walking surfaces at 16.5 / 11 / 5.5 / 0", () => {
  assert.equal(LAYER_TILES.length, 297);
  assert.deepEqual(
    LAYER_INDICES.map((layer) => LAYER_TILES.filter((t) => t.layer === layer).length),
    [85, 79, 78, 55]
  );
  assert.deepEqual([...LAYER_TOPS], [16.5, 11, 5.5, 0]);
  for (let i = 1; i < 4; i++) assert.equal(LAYER_TOPS[i - 1] - LAYER_TOPS[i], 5.5);
  for (const t of LAYER_TILES) assert.equal(t.top, LAYER_TOPS[t.layer]);
  assert.equal(HEX.width, 2);
  assert.ok(Math.abs(HEX.corner - 1.1547) < 1e-4, "corner radius 2/√3");
  assert.equal(HEX.thickness, 0.5);
  assert.ok(Math.abs(HEX.groove - 0.06) < 1e-9);
  assert.equal(LAYERS_MAP.id, "layers");
  assert.equal(LAYER_CHAOS.mode, "layer_chaos");
  assert.equal(LAYER_CHAOS.label, "Katman Kaosu");
});

test("audited shapes: a round crown, three windows + three notches, seven honeycomb windows, a compact core", () => {
  const cells = (layer: LayerIndex) => new Set(LAYER_CELLS[layer].map((c) => `${c.q},${c.r}`));
  const crown = cells(0);
  // L1: every cell whose centre is within 9.2 m (a disc ≈ 20.6 m across).
  for (const t of LAYER_TILES.filter((t) => t.layer === 0)) assert.ok(Math.hypot(t.x, t.z) <= 9.2 + 1e-6);
  const missing = (layer: LayerIndex) => [...crown].filter((k) => !cells(layer).has(k)).sort();
  const between = [HEX_DIRECTIONS[1], HEX_DIRECTIONS[3], HEX_DIRECTIONS[5]],
    toward = [HEX_DIRECTIONS[0], HEX_DIRECTIONS[4], HEX_DIRECTIONS[2]];
  const at = (n: number, d: HexCoord) => `${n * d.q},${n * d.r}`;
  assert.deepEqual(missing(1), [...between.map((d) => at(2, d)), ...between.map((d) => at(4, d))].sort(), "L2: 3 inner windows (ring 2) + 3 rim notches (ring 4), between the spawns");
  assert.deepEqual(missing(2), ["0,0", ...between.map((d) => at(2, d)), ...toward.map((d) => at(2, d))].sort(), "L3: the hub + 6 windows on ring 2");
  // L4 lies inside the crown's footprint, centres within 7.3 m.
  for (const t of LAYER_TILES.filter((t) => t.layer === 3)) {
    assert.ok(Math.hypot(t.x, t.z) <= 7.3 + 1e-6);
    assert.ok(crown.has(`${t.q},${t.r}`));
  }
  // Inner windows are enclosed holes: all six neighbours present.
  for (const [layer, holes] of [
    [1, between.map((d) => at(2, d))],
    [2, ["0,0", ...between.map((d) => at(2, d)), ...toward.map((d) => at(2, d))]],
  ] as const)
    for (const hole of holes) {
      const [q, r] = hole.split(",").map(Number);
      for (const d of HEX_DIRECTIONS) assert.ok(tileAtCell(layer as LayerIndex, { q: q + d.q, r: r + d.r }), `L${layer + 1} window ${hole} is enclosed`);
    }
});

test("no duplicate tiles; neighbours are exactly 2 m apart and flush; every layer is one connected field", () => {
  const cells = new Set<string>(),
    places = new Set<string>();
  for (const t of LAYER_TILES) {
    const c = `${t.layer}:${t.q},${t.r}`,
      p = `${t.layer}:${t.x.toFixed(6)},${t.z.toFixed(6)}`;
    assert.ok(!cells.has(c) && !places.has(p), `duplicate ${c}`);
    cells.add(c);
    places.add(p);
    assert.deepEqual(hexAt(t.x, t.z), { q: t.q, r: t.r });
    assert.equal(tileAt(t.layer, t.x + 0.4, t.z - 0.3), t);
    assert.equal(t.ring, hexDistance(t));
  }
  for (const layer of LAYER_INDICES) {
    const tiles = LAYER_TILES.filter((t) => t.layer === layer);
    let edges = 0;
    for (const t of tiles)
      for (const n of tileNeighbours(t)) {
        edges++;
        assert.ok(Math.abs(Math.hypot(n.x - t.x, n.z - t.z) - HEX.width) < 1e-9, "neighbour centres one tile width apart");
        // The shared edge's midpoint lies on both tiles' tops: no gap, no overlap beyond the edge.
        const mx = (t.x + n.x) / 2,
          mz = (t.z + n.z) / 2;
        assert.ok(hexContains(t, mx, mz, 1e-9) && hexContains(n, mx, mz, 1e-9));
        assert.ok(!hexContains(t, mx + (n.x - t.x) * 0.01, mz + (n.z - t.z) * 0.01));
      }
    // Breadth-first from one tile reaches all of them (L3's windows included).
    const seen = new Set([tiles[0].id]),
      queue = [tiles[0]];
    while (queue.length) for (const n of tileNeighbours(queue.shift()!)) if (!seen.has(n.id)) seen.add(n.id), queue.push(n);
    assert.equal(seen.size, tiles.length, `L${layer + 1} connected`);
    assert.ok(edges / 2 > tiles.length, "a field, not a chain");
  }
});

test("colliders: one flush convex prism per tile, 0.5 m deep; rays find a top anywhere on a layer, seams and corners included", () => {
  const { physics, tiles } = field();
  assert.equal(tiles.colliders.length, 297);
  const down = (x: number, y: number, z: number) =>
    physics.world.castRayAndGetNormal(new RAPIER.Ray({ x, y, z }, { x: 0, y: -1, z: 0 }), 3, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
  const up = (x: number, y: number, z: number) =>
    physics.world.castRay(new RAPIER.Ray({ x, y, z }, { x: 0, y: 1, z: 0 }), 3, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
  for (const t of LAYER_TILES.filter((t) => t.layer === 3)) {
    const hit = down(t.x, t.top + 1, t.z)!;
    assert.ok(Math.abs(1 - hit.timeOfImpact) < 1e-4 && hit.normal.y > 0.99, "flat top at the layer height");
    assert.equal(tiles.tileOf(hit.collider), t.id);
    assert.ok(Math.abs(up(t.x, t.top - 1, t.z)!.timeOfImpact - (1 - HEX.thickness)) < 1e-4, "0.5 m thick");
    for (const n of tileNeighbours(t)) {
      // Seam midpoints and points just either side: all on a top (no gap to fall into).
      for (const k of [0.5, 0.49, 0.51]) {
        const x = t.x + (n.x - t.x) * k,
          z = t.z + (n.z - t.z) * k;
        assert.ok(Math.abs(down(x, t.top + 1, z)!.timeOfImpact - 1) < 1e-4);
      }
    }
  }
  // Triple corners where three tiles meet.
  const c = tile(3, 0, 0);
  for (let k = 0; k < 6; k++) {
    const a = ((30 + 60 * k) * Math.PI) / 180;
    assert.ok(Math.abs(down(c.x + HEX.corner * Math.cos(a), 1, c.z + HEX.corner * Math.sin(a))!.timeOfImpact - 1) < 1e-4);
  }
  physics.dispose();
});

test("spawns: three L1 tiles 120° apart at (6, 0), (−3, ±5.2), pelvis 17.4 m, facing the centre, with floor below", () => {
  const expected = [
    [6, 0],
    [-3, 5.196],
    [-3, -5.196],
  ];
  LAYERS_MAP.spawns.forEach((s, i) => {
    assert.ok(Math.abs(s.x - expected[i][0]) < 1e-3 && Math.abs(s.z - expected[i][1]) < 1e-3);
    assert.equal(s.y, 17.4);
    assert.equal(LAYER_SPAWN_HEIGHT, 17.4);
    assert.ok(tileAt(0, s.x, s.z));
    const yaw = spawnYaw(LAYERS_MAP, i);
    assert.ok(Math.abs(Math.sin(yaw) * -s.x + Math.cos(yaw) * -s.z - Math.hypot(s.x, s.z)) < 1e-9, "faces the centre");
    // Every L1 tile within two steps of a spawn has a lower tile under it (no instant void).
    const cell = hexAt(s.x, s.z);
    for (const t of LAYER_TILES.filter((t) => t.layer === 0 && hexDistance(t, cell) <= 2))
      assert.ok([1, 2, 3].some((l) => tileAtCell(l as LayerIndex, t)), `something under L1 (${t.q},${t.r})`);
  });
  const angles = LAYERS_MAP.spawns.map((s) => Math.atan2(s.z, s.x));
  for (let i = 0; i < 3; i++) {
    const gap = Math.abs(Math.atan2(Math.sin(angles[i] - angles[(i + 1) % 3]), Math.cos(angles[i] - angles[(i + 1) % 3])));
    assert.ok(Math.abs(gap - (2 * Math.PI) / 3) < 1e-3);
  }
});

// ─── Trigger ────────────────────────────────────────────────────────────────

test("the hips arm the tile under them; one timer per tile however many stand on it", () => {
  const { physics, tiles } = field();
  const t = tile(3, 0, 0);
  const c = place(physics, 0, t.x, t.top + STAND, t.z);
  settle(physics);
  assert.deepEqual(supportingTile(physics.world, c, tiles), { tile: t.id, via: "hips" });
  assert.equal(tiles.arm(t.id, 10), true);
  assert.equal(tiles.goneTick[t.id], 10 + LAYER_TICKS.base);
  assert.equal(tiles.arm(t.id, 30), false, "a second contact changes nothing");
  assert.equal(tiles.goneTick[t.id], 10 + LAYER_TICKS.base);
  physics.dispose();

  // Two players sharing a spawn tile in a real round: armed once, on the first playing tick, same goneTick.
  const game = new LayerChaosGame(silentFeedback, { players: 2 });
  const s = LAYERS_MAP.spawns[0];
  place(game.physics, 0, s.x - 0.45, s.y, s.z, spawnYaw(LAYERS_MAP, 0));
  place(game.physics, 1, s.x + 0.45, s.y, s.z, spawnYaw(LAYERS_MAP, 0));
  const idle = [IDLE_INPUT, IDLE_INPUT, IDLE_INPUT];
  while (game.step(idle) !== "started");
  game.step(idle);
  const spawnTile = tileAt(0, s.x, s.z)!;
  assert.deepEqual(
    game.armed.map((a) => a.tile),
    [spawnTile.id],
    "the shared tile arms once"
  );
  assert.equal(game.field.armTick[spawnTile.id], 0);
  assert.equal(game.field.goneTick[spawnTile.id], LAYER_TICKS.base);
  for (let i = 1; i < LAYER_TICKS.base; i++) {
    game.step(idle);
    assert.equal(game.field.goneTick[spawnTile.id], LAYER_TICKS.base, "no faster break with two players");
  }
  assert.equal(game.field.intact(spawnTile.id), true);
  game.step(idle);
  assert.equal(game.field.intact(spawnTile.id), false, "gone exactly at goneTick");
  game.dispose();
});

test("hands, arms, head and a torso against a tile's side never arm; the feet only as a fallback", () => {
  const { physics, tiles } = field();
  const hole = tile(3, 0, 0),
    side = tile(3, 1, 0);
  tiles.remove(hole.id);
  physics.world.step();
  // Falling through the hole: pelvis 0.3 m below the layer, torso, hands and head pressed onto the next tile.
  const c = place(physics, 0, hole.x + 0.2, hole.top - 0.3, hole.z);
  const parts = c.parts;
  parts.torso.body.setTranslation({ x: side.x - HEX.width / 2 - 0.3, y: side.top - 0.1, z: side.z }, true);
  parts.head.body.setTranslation({ x: side.x - 0.4, y: side.top + 0.28, z: side.z }, true);
  parts.leftHand.body.setTranslation({ x: side.x, y: side.top + 0.14, z: side.z - 0.3 }, true);
  parts.rightHand.body.setTranslation({ x: side.x, y: side.top + 0.14, z: side.z + 0.3 }, true);
  parts.leftUpper.body.setTranslation({ x: side.x - 0.5, y: side.top + 0.12, z: side.z - 0.3 }, true);
  assert.equal(supportingTile(physics.world, c, tiles), null);
  // Lying with only the hands on a tile and the pelvis over the hole: still nothing.
  place(physics, 0, hole.x, hole.top + 0.3, hole.z);
  parts.leftHand.body.setTranslation({ x: side.x - 0.2, y: side.top + 0.13, z: side.z }, true);
  parts.leftLeg.body.setTranslation({ x: hole.x, y: hole.top - 0.4, z: hole.z - 0.2 }, true);
  parts.rightLeg.body.setTranslation({ x: hole.x, y: hole.top - 0.4, z: hole.z + 0.2 }, true);
  assert.equal(supportingTile(physics.world, c, tiles), null);
  // Standing on the hole's edge, pelvis over the hole, one foot on the next tile: the feet fallback arms that tile.
  place(physics, 0, side.x - HEX.width / 2 - 0.35, side.top + STAND - 0.1, side.z);
  parts.rightLeg.body.setTranslation({ x: side.x - HEX.width / 2 + 0.15, y: side.top + 0.34, z: side.z }, true);
  parts.leftLeg.body.setTranslation({ x: side.x - HEX.width / 2 - 0.5, y: side.top - 0.1, z: side.z }, true);
  assert.deepEqual(supportingTile(physics.world, c, tiles), { tile: side.id, via: "feet" });
  physics.dispose();
});

test("jumping over a tile never arms it; landing arms the landing tile at once", () => {
  const { physics, tiles } = field();
  const a = tile(3, -2, 0),
    b = tile(3, -1, 0),
    landing = tile(3, 0, 0);
  const c = place(physics, 0, a.x - 0.4, a.top + STAND, a.z);
  settle(physics, 30);
  let jumped = false,
    tick = 0,
    landedAt = -1,
    takeoffAt = -1;
  const armedAt = new Map<number, number>();
  for (; tick < 90; tick++) {
    const x = pelvis(c).x;
    physics.step([walk(1, 0, { jump: !jumped && x >= a.x + HEX.width / 2 - 0.45 }), IDLE_INPUT, IDLE_INPUT]);
    if (!jumped && c.jumpIn > 0) {
      jumped = true;
      takeoffAt = tick;
    }
    const support = supportingTile(physics.world, c, tiles);
    if (support && !armedAt.has(support.tile)) armedAt.set(support.tile, tick);
    if (support?.tile === landing.id && landedAt < 0) landedAt = tick;
  }
  assert.ok(jumped, "took off");
  assert.ok(armedAt.has(a.id), "the take-off tile armed");
  assert.equal(armedAt.has(b.id), false, "the tile jumped over never armed");
  assert.ok(landedAt > takeoffAt && landedAt - takeoffAt < 45, `landing arms at touchdown (${landedAt - takeoffAt} ticks after take-off)`);
  // It really landed and walked on: still up on L4, upright.
  assert.ok(pelvis(c).y > landing.top + 0.5 && upright(c) > 0.85);
  // Rising through a tile's support range (jump just pressed) arms nothing either.
  const rising = place(physics, 0, b.x, b.top + STAND, b.z);
  settle(physics, 30);
  physics.step([walk(0, 0, { jump: true }), IDLE_INPUT, IDLE_INPUT]);
  assert.ok(rising.jumpIn > 0);
  assert.equal(supportingTile(physics.world, rising, tiles), null);
  physics.dispose();
});

test("the countdown, eliminated players and empty slots never arm; the first playing tick does", () => {
  const game = new LayerChaosGame(silentFeedback, { players: 2 });
  const idle = [IDLE_INPUT, IDLE_INPUT, IDLE_INPUT];
  let ticks = 0;
  while (game.step(idle) !== "started") {
    ticks++;
    assert.equal(game.armed.length, 0);
    assert.ok(game.field.armTick.every((t) => t === -1), "tiles immune during the countdown");
  }
  assert.equal(ticks + 1, LAYER_TICKS.countdown);
  game.step(idle);
  const armed = game.armed.map((a) => a.actor).sort();
  assert.deepEqual(armed, [0, 1], "both players' spawn tiles arm on tick 0; the empty third slot arms nothing");
  assert.equal(game.field.armTick[tileAt(0, LAYERS_MAP.spawns[2].x, LAYERS_MAP.spawns[2].z)!.id], -1);
  game.dispose();
  // An eliminated body lying on a tile is never a support.
  const { physics, tiles } = field();
  const t = tile(3, 0, 0);
  const c = place(physics, 0, t.x, t.top + STAND, t.z);
  settle(physics);
  assert.ok(supportingTile(physics.world, c, tiles));
  c.eliminated = true;
  assert.equal(supportingTile(physics.world, c, tiles), null);
  physics.dispose();
});

// ─── Timing ─────────────────────────────────────────────────────────────────

test("break time 1.30 s, 1.05 s from 45 s, 0.80 s from 70 s — fixed when a tile first arms", () => {
  assert.deepEqual([LAYER_TICKS.base, LAYER_TICKS.fast, LAYER_TICKS.collapse], [78, 63, 48]);
  assert.equal(breakTicks(0), 78);
  assert.equal(breakTicks(45 * 60 - 1), 78);
  assert.equal(breakTicks(45 * 60), 63);
  assert.equal(breakTicks(70 * 60 - 1), 63);
  assert.equal(breakTicks(70 * 60), 48);
  assert.deepEqual([schedulePhase(0), schedulePhase(2700), schedulePhase(4200)], ["normal", "fast", "collapse"]);
  const { physics, tiles } = field();
  const [a, b, c] = [tile(3, 0, 0), tile(3, 1, 0), tile(3, 2, 0)];
  tiles.arm(a.id, 2699);
  tiles.arm(b.id, 2700);
  tiles.arm(c.id, 4200);
  assert.deepEqual([tiles.goneTick[a.id], tiles.goneTick[b.id], tiles.goneTick[c.id]], [2699 + 78, 2700 + 63, 4200 + 48]);
  // A tile armed just before the speed-up keeps 1.30 s after it.
  tiles.advance(2710);
  assert.equal(tiles.goneTick[a.id], 2777);
  physics.dispose();
});

test("WARN → CRACK → BREAK at 31% / 69%, and GONE exactly on goneTick: collider off before that tick's physics", () => {
  const { physics, tiles } = field();
  const t = tile(3, 0, 0);
  const c = place(physics, 0, t.x, t.top + STAND, t.z);
  settle(physics);
  tiles.arm(t.id, 100);
  const stages: string[] = [];
  for (let tick = 100; tick < 178; tick++) stages.push(tiles.stage(t.id, tick));
  assert.equal(stages.filter((s) => s === "warn").length, 25, "WARN: ticks 0–24 (24/78 < 31%)");
  assert.equal(stages.filter((s) => s === "crack").length, 29, "CRACK: ticks 25–53");
  assert.equal(stages.filter((s) => s === "break").length, 24, "BREAK: ticks 54–77");
  assert.deepEqual([...new Set(stages)], ["warn", "crack", "break"]);
  const standing = pelvis(c).y;
  let beforeGone = standing;
  for (let tick = 100; tick <= 178; tick++) {
    beforeGone = pelvis(c).y;
    const vanished = tiles.advance(tick);
    if (tick < 178) {
      assert.equal(vanished.length, 0);
      assert.equal(tiles.colliders[t.id].isEnabled(), true, `intact at ${tick}`);
      assert.equal(tiles.stage(t.id, tick) === "gone", false);
    } else {
      assert.deepEqual(vanished, [t.id]);
      assert.equal(tiles.stage(t.id, tick), "gone");
      assert.equal(tiles.colliders[t.id].isEnabled(), false);
      // Queries before the next world step no longer see it (the controller's support ray included).
      const ray = physics.world.castRay(new RAPIER.Ray({ x: t.x, y: t.top + 1, z: t.z }, { x: 0, y: -1, z: 0 }), 2, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
      assert.equal(ray, null);
    }
    physics.step([IDLE_INPUT, IDLE_INPUT, IDLE_INPUT]);
    if (tick < 178) assert.ok(Math.abs(pelvis(c).y - standing) < 0.05, "still standing before goneTick");
  }
  // The same tick's step already moved the body down; a few ticks later it is clearly falling.
  assert.ok(pelvis(c).y < beforeGone - 0.003, "falls from goneTick's step");
  for (let i = 0; i < 6; i++) physics.step([IDLE_INPUT, IDLE_INPUT, IDLE_INPUT]);
  assert.ok(pelvis(c).y < standing - 0.1);
  physics.dispose();
});

test("a GONE tile's collider is disabled and out of queries; intact neighbours keep theirs; reset restores all", () => {
  const { physics, tiles } = field();
  const gone = tile(0, 0, 0),
    kept = tileNeighbours(gone);
  tiles.remove(gone.id);
  assert.equal(tiles.colliders[gone.id].isEnabled(), false);
  assert.equal(tiles.enabledColliders, 296);
  const hit = physics.world.castRay(new RAPIER.Ray({ x: gone.x, y: 20, z: gone.z }, { x: 0, y: -1, z: 0 }), 30, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC)!;
  assert.equal(tiles.tileOf(hit.collider), tileAt(1, gone.x, gone.z)!.id, "the ray falls through to L2");
  for (const n of kept) {
    assert.equal(tiles.colliders[n.id].isEnabled(), true);
    const h = physics.world.castRay(new RAPIER.Ray({ x: n.x, y: 20, z: n.z }, { x: 0, y: -1, z: 0 }), 30, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC)!;
    assert.equal(tiles.tileOf(h.collider), n.id);
  }
  tiles.reset();
  assert.equal(tiles.enabledColliders, 297);
  assert.equal(tiles.colliders[gone.id].isEnabled(), true);
  physics.world.step();
  const back = physics.world.castRay(new RAPIER.Ray({ x: gone.x, y: 20, z: gone.z }, { x: 0, y: -1, z: 0 }), 30, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC)!;
  assert.equal(tiles.tileOf(back.collider), gone.id);
  physics.dispose();
});

// ─── Movement ───────────────────────────────────────────────────────────────

/** Walk a straight line; pelvis height range, lowest uprightness and largest vertical speed after 0.6 s. */
function traverse(physics: PlaygroundPhysics, from: { x: number; z: number }, to: { x: number; z: number }, top: number, sprint: boolean) {
  const dx = to.x - from.x,
    dz = to.z - from.z,
    d = Math.hypot(dx, dz);
  const c = place(physics, 0, from.x, top + STAND, from.z, Math.atan2(dx, dz));
  settle(physics, 30);
  let lo = Infinity,
    hi = -Infinity,
    up = 1,
    vy = 0,
    tick = 0;
  for (; tick < 400; tick++) {
    const p = pelvis(c);
    if ((p.x - from.x) * dx + (p.z - from.z) * dz >= d * d) break;
    physics.step([walk(dx / d, dz / d, { sprint }), IDLE_INPUT, IDLE_INPUT]);
    if (tick < 36) continue;
    lo = Math.min(lo, pelvis(c).y);
    hi = Math.max(hi, pelvis(c).y);
    up = Math.min(up, upright(c));
    vy = Math.max(vy, Math.abs(c.body.linvel().y));
  }
  return { range: hi - lo, up, vy, fell: pelvis(c).y < top + 0.3, seconds: tick / 60 };
}

test("walking and sprinting across flush hex seams is as smooth as a slab (straight across edges and diagonally over corners)", () => {
  const { physics } = field();
  const slab = new PlaygroundPhysics(silentFeedback, SLAB_MAP);
  for (const c of slab.players) if (c.id !== 0) retire(c);
  const lines = [
    [{ x: -6.2, z: 0 }, { x: 6.2, z: 0 }], // across six flat edges
    [{ x: -5.2, z: -3 }, { x: 5.2, z: 3 }], // 30°: over corners where three tiles meet
    [{ x: -3, z: -5.5 }, { x: 3, z: 5.5 }], // along a corner-to-corner zigzag
  ];
  for (const sprint of [false, true])
    for (const [from, to] of lines) {
      const hex = traverse(physics, from, to, 0, sprint),
        flat = traverse(slab, from, to, 0, sprint);
      const label = `${sprint ? "sprint" : "walk"} ${from.x},${from.z}→${to.x},${to.z}: hex ${hex.range.toFixed(3)} m / ${hex.vy.toFixed(2)} m/s / up ${hex.up.toFixed(2)}, slab ${flat.range.toFixed(3)} / ${flat.vy.toFixed(2)} / ${flat.up.toFixed(2)}`;
      assert.equal(hex.fell, false, label);
      assert.ok(hex.range <= flat.range + 0.02, `no seam bumps (height): ${label}`);
      assert.ok(hex.vy <= flat.vy + 0.25, `no seam bumps (vertical speed): ${label}`);
      assert.ok(hex.up >= flat.up - 0.05 && hex.up > 0.85, `upright: ${label}`);
      assert.ok(Math.abs(hex.seconds - flat.seconds) < 0.1, `same pace: ${label}`);
    }
  physics.dispose();
  slab.dispose();
});

/** Run along L4's middle row toward +x with some tiles removed; jump `lead` metres before the hole. */
function gapJump(missing: number[], lead: number, sprint: boolean) {
  const { physics, tiles } = field();
  for (const q of missing) tiles.remove(tile(3, q, 0).id);
  const edge = tile(3, missing[0], 0).x - HEX.width / 2,
    beyond = tile(3, missing[missing.length - 1], 0).x + HEX.width / 2;
  const c = place(physics, 0, tile(3, -3, 0).x - 0.4, STAND, 0);
  settle(physics, 20);
  let jumped = false;
  for (let tick = 0; tick < 240 && !c.eliminated; tick++) {
    const x = pelvis(c).x;
    physics.step([x > beyond + 1.2 ? IDLE_INPUT : walk(1, 0, { sprint, jump: !jumped && x >= edge - lead }), IDLE_INPUT, IDLE_INPUT]);
    if (c.jumpIn > 0) jumped = true;
  }
  const p = pelvis(c),
    made = !c.eliminated && p.y > LAYER_TOPS[3] + 0.4 && p.x > beyond;
  physics.dispose();
  return { made, jumped };
}

test("jumps: one missing tile clears walking; two missing (4 m) never walking; three missing (6 m) never, even sprinting", () => {
  const one = gapJump([0], 0.45, false);
  assert.ok(one.jumped && one.made, "walking jump over one missing tile");
  for (const lead of [0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
    assert.equal(gapJump([-1, 0], lead, false).made, false, `two missing, walking, jump ${lead} m early`);
    assert.equal(gapJump([-1, 0, 1], lead, true).made, false, `three missing, sprinting, jump ${lead} m early`);
  }
});

test("a 5.5 m drop lands upright on the layer below; nobody climbs back up", () => {
  const { physics, tiles } = field();
  const top = tile(0, 1, 0),
    below = tileAt(1, top.x, top.z)!;
  const c = place(physics, 0, top.x, top.top + STAND, top.z);
  settle(physics);
  tiles.remove(top.id);
  let landed = -1;
  for (let tick = 0; tick < 120; tick++) {
    physics.step([IDLE_INPUT, IDLE_INPUT, IDLE_INPUT]);
    if (landed < 0 && pelvis(c).y < below.top + STAND + 0.1 && physics.isGrounded(0)) landed = tick;
  }
  assert.ok(landed > 0 && landed < 70, `landed after ${landed} ticks`);
  assert.ok(Math.abs(pelvis(c).y - (below.top + RAGDOLL.standHeight)) < 0.15, "standing on L2");
  assert.ok(upright(c) > 0.9, "upright");
  assert.equal(c.eliminated, false, "a fall to a lower layer is not an elimination");
  // Jump spam under intact L1 tiles: the apex (~1 m) is nowhere near the 5 m to the layer above.
  let highest = -Infinity;
  for (let tick = 0; tick < 300; tick++) {
    physics.step([walk(Math.sin(tick / 20), Math.cos(tick / 20), { jump: true, sprint: true }), IDLE_INPUT, IDLE_INPUT]);
    highest = Math.max(highest, pelvis(c).y);
  }
  assert.ok(highest < LAYER_TOPS[1] + 2.2, `apex ${highest.toFixed(2)} m`);
  assert.ok(pelvis(c).y < LAYER_TOPS[0], "still below L1");
  physics.dispose();
});

// ─── Elimination and the round ──────────────────────────────────────────────

test("round rules: last alive wins on the tick it happens; the last ones out on the same tick draw; empty slots sit out", () => {
  const round = new LayerRound();
  for (let i = 0; i < LAYER_TICKS.countdown - 1; i++) assert.equal(round.step(), null);
  assert.equal(round.step(), "started");
  assert.equal(round.tick, 0);
  for (let i = 0; i < 10; i++) round.step();
  assert.equal(round.step([1]), null);
  assert.equal(round.outAt[1], 10);
  for (let i = 0; i < 5; i++) round.step();
  assert.equal(round.step([2]), "finished");
  assert.deepEqual([round.winner, round.reason, round.endedAt], [0, "survivor", 16]);

  const draw = new LayerRound();
  while (draw.step() !== "started");
  draw.step([0]);
  assert.equal(draw.step([1, 2]), "finished");
  assert.deepEqual([draw.winner, draw.reason], [null, "all-fell"]);

  const pair = new LayerRound();
  pair.setActive([0, 1]);
  while (pair.step() !== "started");
  assert.equal(pair.step([0, 1]), "finished", "both remaining out together");
  assert.equal(pair.winner, null);
  // Results, then a fresh countdown with the same slots.
  let event = null;
  for (let i = 0; i < LAYER_TICKS.results && event !== "reset"; i++) event = pair.step();
  assert.equal(event, "reset");
  assert.deepEqual(pair.alive, [true, true, false]);
  // Safety cap: survivors at 100 s draw.
  const cap = new LayerRound();
  while (cap.step() !== "started");
  let finished = null;
  for (let i = 0; i < LAYER_TICKS.cap && !finished; i++) finished = cap.step();
  assert.equal(finished, "finished");
  assert.deepEqual([cap.reason, cap.endedAt], ["timeout", LAYER_TICKS.cap - 1], "100 s = round ticks 0…5999");
});

test("physically: falling to a lower layer is not elimination, below the last layer is; the last one standing wins", () => {
  const game = started(3);
  const core = tile(3, 0, 0);
  // Player 0 stands on L4's middle; players 1 and 2 fall from different heights beside the tower.
  place(game.physics, 0, core.x, core.top + STAND, core.z);
  place(game.physics, 1, 13, 8, 0);
  place(game.physics, 2, -13, 2, 0);
  const idle = [IDLE_INPUT, IDLE_INPUT, IDLE_INPUT];
  const outs: { id: number; tick: number; y: number }[] = [];
  let event = null;
  for (let i = 0; i < 200 && event !== "finished"; i++) {
    const tick = game.round.tick;
    event = game.step(idle);
    for (const id of game.eliminated) outs.push({ id, tick, y: game.physics.players[id].body.translation().y });
  }
  assert.equal(event, "finished");
  assert.deepEqual(
    outs.map((o) => o.id),
    [2, 1]
  );
  for (const o of outs) assert.ok(o.y < LAYER_CHAOS.eliminationY && o.y > LAYER_CHAOS.eliminationY - 0.5, "out as the hips cross −5 m");
  assert.deepEqual([game.round.winner, game.round.reason, game.round.endedAt], [0, "survivor", outs[1].tick]);
  game.dispose();

  // A player dropping from L1 to L2 stays in.
  const drop = started(2);
  drop.step(idle);
  for (let i = 0; i < 160; i++) drop.step(idle);
  const p = drop.physics.players[0].body.translation();
  assert.ok(p.y < LAYER_TOPS[0] && p.y > LAYER_TOPS[1], `on L2 (${p.y.toFixed(2)})`);
  assert.equal(drop.round.alive[0], true);
  drop.dispose();
});

test("physically: the last two falling out on the same tick is a draw", () => {
  const game = started(2);
  // Same pose, same height, beside each other over the void: identical falls.
  place(game.physics, 0, 12, 10, 0, 0);
  place(game.physics, 1, 12, 10, 3, 0);
  const idle = [IDLE_INPUT, IDLE_INPUT, IDLE_INPUT];
  let event = null;
  for (let i = 0; i < 200 && event !== "finished"; i++) event = game.step(idle);
  assert.equal(event, "finished");
  assert.deepEqual(game.round.outAt.slice(0, 2), [game.round.endedAt, game.round.endedAt]);
  assert.deepEqual([game.round.winner, game.round.reason], [null, "all-fell"]);
  game.dispose();
});

// ─── Anti-stall ─────────────────────────────────────────────────────────────

test("collapse schedule: L1 from 70 s, L2 76 s, L3 82 s, L4 88 s; outside ring first, one ring per 1.2 s, 1 s warning", () => {
  assert.deepEqual(LAYER_TICKS.layerStarts, [4200, 4560, 4920, 5280]);
  assert.deepEqual([LAYER_TICKS.ringInterval, LAYER_TICKS.warning], [72, 60]);
  assert.deepEqual([...LAYER_OUTER_RING], [5, 5, 5, 4]);
  for (const t of LAYER_TILES) {
    const k = LAYER_OUTER_RING[t.layer] - t.ring;
    assert.equal(collapseWarnTick(t), LAYER_TICKS.layerStarts[t.layer] + k * 72);
    assert.equal(collapseArmTick(t), collapseWarnTick(t) + 60);
  }
  // Outside-in within a layer, layer by layer.
  for (const layer of LAYER_INDICES) {
    const tiles = LAYER_TILES.filter((t) => t.layer === layer);
    for (const a of tiles) for (const b of tiles) if (a.ring > b.ring) assert.ok(collapseArmTick(a) < collapseArmTick(b));
    const first = Math.min(...tiles.map(collapseWarnTick));
    assert.equal(first, LAYER_TICKS.layerStarts[layer]);
  }
  // The last tile (L4's centre) arms at 93.8 s and is gone at 94.6 s: everyone is out by ~96 s.
  const last = Math.max(...LAYER_TILES.map(collapseArmTick));
  assert.equal(collapseArmTick(tile(3, 0, 0)), last);
  assert.equal(last, 5628);
  assert.equal(last + breakTicks(last), 5676);
});

test("collapse: a MARKED second, then only untouched tiles arm at 0.8 s; the field empties by 94.6 s, deterministically", () => {
  const { physics, tiles } = field();
  const outer = LAYER_TILES.find((t) => t.layer === 0 && t.ring === 5)!,
    touched = LAYER_TILES.find((t) => t.layer === 0 && t.ring === 5 && t.id !== outer.id)!;
  const arm = collapseArmTick(outer);
  tiles.arm(touched.id, arm - 30); // a player stood on it during the warning (0.8 s already)
  for (let tick = 0; tick <= 5760; tick++) {
    if (tick === arm - 61) assert.equal(tiles.stage(outer.id, tick), "solid");
    if (tick >= arm - 60 && tick < arm) {
      assert.equal(tiles.stage(outer.id, tick), "marked");
      assert.equal(tiles.colliders[outer.id].isEnabled(), true, "a warning, not a hole");
    }
    tiles.advance(tick);
    if (tick === arm) {
      assert.equal(tiles.armTick[outer.id], arm);
      assert.equal(tiles.goneTick[outer.id], arm + 48);
      assert.equal(tiles.armedBy[outer.id], 2);
      assert.equal(tiles.armTick[touched.id], arm - 30, "a touched tile keeps its own timer");
      assert.equal(tiles.armedBy[touched.id], 1);
    }
    if (tick === 5675) assert.equal(tiles.enabledColliders, 1, "L4's centre is the last tile");
  }
  assert.equal(tiles.enabledColliders, 0);
  const schedule = Array.from(tiles.goneTick);
  physics.dispose();
  const again = field();
  again.tiles.arm(touched.id, arm - 30);
  for (let tick = 0; tick <= 5760; tick++) again.tiles.advance(tick);
  assert.deepEqual(Array.from(again.tiles.goneTick), schedule, "the same schedule every time");
  again.physics.dispose();
});

test("a whole bot round is deterministic for the same seed and ends by the collapse", () => {
  const play = (seed: number) => {
    let s = seed;
    const random = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const game = new LayerChaosGame(silentFeedback, { players: 3 });
    const bots = ([0, 1, 2] as const).map((id) => new LayerBot(id, random));
    bots.forEach((b) => b.reset());
    let event = null;
    for (let i = 0; i < 60 * 110 && event !== "finished"; i++) event = game.step(bots.map((b) => b.update(game)));
    const out = { event, winner: game.round.winner, endedAt: game.round.endedAt, arm: Array.from(game.field.armTick), faults: game.physics.diagnostics.invalidBodies, stats: { ...game.brawl.stats } };
    game.dispose();
    return out;
  };
  const a = play(7),
    b = play(7);
  assert.equal(a.event, "finished");
  assert.ok(a.endedAt / 60 < 96, `ended at ${(a.endedAt / 60).toFixed(1)} s`);
  assert.ok(a.endedAt / 60 > 8, "bots stay up for a while");
  assert.equal(a.faults, 0);
  assert.deepEqual(b, a);
});

// ─── Punch ──────────────────────────────────────────────────────────────────

test("punch: a shove (3 m/s + 0.3 up) and a 0.35 s stagger; no health; a hit during a stagger never extends it", () => {
  const physics = new PlaygroundPhysics(silentFeedback, LAYERS_MAP);
  new TileField(physics.world);
  retire(physics.players[2]);
  const brawl = new LayerBrawl(physics);
  const step = (inputs: MovementInput[]) => {
    const { inputs: effective, drives } = brawl.step(inputs, RAGDOLL.step);
    physics.step(effective, drives);
    brawl.afterStep();
  };
  const idle = [IDLE_INPUT, IDLE_INPUT, IDLE_INPUT];
  const a = tile(3, 0, 0);
  // Face to face on L4, 1.0 m apart (tiles never arm in this rig).
  place(physics, 0, a.x - 0.5, a.top + STAND, a.z, Math.PI / 2);
  const victim = place(physics, 1, a.x + 0.5, a.top + STAND, a.z, -Math.PI / 2);
  for (let i = 0; i < 20; i++) step(idle);
  const before = victim.body.translation().x;
  let hit = null;
  for (let i = 0; i < 40 && !hit; i++) {
    step([{ x: 0, z: 0, jump: false, punch: i === 0 }, IDLE_INPUT, IDLE_INPUT]);
    hit = brawl.shoves[0] ?? null;
  }
  assert.ok(hit, "the punch landed by hand contact");
  assert.deepEqual([hit.attacker, hit.target, hit.staggered], [0, 1, true]);
  const f = brawl.fighters[1];
  assert.deepEqual(f.stagger, { time: 0.35, posture: 0.7, mobility: 0.25 });
  assert.ok(brawl.fighters[0].punchCooldown > 0.5 && brawl.fighters[0].punchCooldown <= LAYER_CHAOS.punch.cooldown);
  step(idle);
  assert.deepEqual([brawl.drives[1].posture, brawl.drives[1].mobility, brawl.drives[1].jump], [0.7, 0.25, false], "staggered: no jump");
  const speed = victim.body.linvel().x;
  assert.ok(speed > 1.5, `shoved away at ${speed.toFixed(2)} m/s`);
  let ticks = 1;
  while (brawl.drives[1].posture < 1) {
    step(idle);
    ticks++;
  }
  assert.equal(ticks, 22, "staggered drive on the 21 steps after the hit (0.35 s), normal on the 22nd");
  assert.deepEqual([brawl.drives[1].posture, brawl.drives[1].mobility, brawl.drives[1].jump], [1, 1, true]);
  for (let i = 0; i < 40; i++) step(idle);
  const moved = victim.body.translation().x - before;
  assert.ok(moved > 0.5 && moved < 1.6, `pushed ${moved.toFixed(2)} m`);
  assert.ok(upright(victim) > 0.8, "a shove, not a topple");
  assert.equal(victim.eliminated, false);
  // During a stagger another hit pushes but leaves the stagger's end where it was.
  place(physics, 0, victim.body.translation().x - 1, a.top + STAND, a.z, Math.PI / 2);
  for (let i = 0; i < 20; i++) step(idle);
  f.stagger = { time: 0.3, posture: 0.7, mobility: 0.25 };
  brawl.fighters[0].punchCooldown = 0;
  let second = null,
    elapsed = 0;
  for (let i = 0; i < 17 && !second; i++) {
    step([{ x: 0, z: 0, jump: false, punch: i === 0 }, IDLE_INPUT, IDLE_INPUT]);
    elapsed += RAGDOLL.step;
    second = brawl.shoves[0] ?? null;
  }
  assert.ok(second, "second punch landed inside the stagger");
  assert.equal(second.staggered, false, "a hit during a stagger only pushes");
  assert.ok(Math.abs(f.stagger.time - Math.max(0, 0.3 - elapsed)) < 1e-9, "not extended");
  physics.dispose();
});

// ─── Camera, fade, landing marker ───────────────────────────────────────────

test("camera: 5.6 m boom at 30°, 60° FOV; under an intact layer it lowers its pitch and never goes inside it; ≥ 3 m wherever one can stand", () => {
  assert.equal(LAYER_CAMERA.fov, 60);
  assert.equal(LAYER_CAMERA.boom, 5.6);
  assert.ok(Math.abs(LAYER_CAMERA.restPitch - Math.PI / 6) < 1e-12);
  assert.equal(LAYER_CAMERA.pivotHeight, 0.9);
  const { physics, tiles } = field();
  // Open sky on L1: the wanted pitch as is.
  const onTop = updateLayerCamera(tiles, { x: 0, y: LAYER_TOPS[0] + 0.78 + 0.9, z: 0 }, 0, LAYER_CAMERA.restPitch, { drop: 0, boom: null }, 1 / 60);
  assert.ok(Math.abs(onTop.boom - 5.6) < 1e-9 && Math.abs(onTop.pitch - LAYER_CAMERA.restPitch) < 1e-9);
  let lowered = 0,
    samples = 0,
    shortest = Infinity;
  for (const layer of [1, 2, 3] as const)
    for (const t of LAYER_TILES.filter((t) => t.layer === layer))
      for (let yaw = 0; yaw < 360; yaw += 45)
        for (const pitch of [18, 30, 55]) {
          const pivot = { x: t.x, y: t.top + 0.78 + 0.9, z: t.z };
          const pose = updateLayerCamera(tiles, pivot, (yaw * Math.PI) / 180, (pitch * Math.PI) / 180, { drop: 0, boom: null }, 1 / 60);
          samples++;
          if (pose.pitch < (pitch * Math.PI) / 180 - 1e-6) lowered++;
          shortest = Math.min(shortest, pose.boom);
          // The camera sphere is outside every intact tile slab.
          for (const above of LAYER_INDICES)
            if (pose.position.y > LAYER_TOPS[above] - HEX.thickness - 0.2 && pose.position.y < LAYER_TOPS[above] + 0.2)
              assert.equal(intactTileNear(tiles, above, pose.position.x, pose.position.z, 0.2), false, `camera inside L${above + 1}`);
        }
  assert.ok(shortest >= LAYER_CAMERA.minBoom, `shortest boom ${shortest.toFixed(2)} m`);
  assert.ok(lowered > 0 && lowered < samples, `lowered in ${lowered}/${samples}`);
  // Under intact L1: the rest pitch fits as is; a steep look is lowered (not shortened).
  const l2 = tile(1, 1, 0),
    at = { x: l2.x, y: l2.top + 0.78 + 0.9, z: l2.z };
  const rest = updateLayerCamera(tiles, at, 0, LAYER_CAMERA.restPitch, { drop: 0, boom: null }, 1 / 60);
  assert.ok(Math.abs(rest.pitch - LAYER_CAMERA.restPitch) < 1e-9 && rest.boom === 5.6);
  const steep = updateLayerCamera(tiles, at, 0, LAYER_CAMERA.maxPitch, { drop: 0, boom: null }, 1 / 60);
  assert.ok(steep.pitch < LAYER_CAMERA.maxPitch - 0.1 && steep.pitch >= LAYER_CAMERA.minPitch && steep.boom === 5.6, `lowered to ${((steep.pitch * 180) / Math.PI).toFixed(1)}°`);
  // Falling past a layer's rim, the boom keeps its 3 m (it passes through the faded layer above).
  const rim = updateLayerCamera(tiles, { x: -9.6, y: LAYER_TOPS[2] - 0.6, z: 0 }, -Math.PI / 2, LAYER_CAMERA.restPitch, { drop: 0, boom: null }, 1 / 60);
  assert.ok(rim.free < LAYER_CAMERA.minBoom && rim.boom === LAYER_CAMERA.minBoom && rim.pitch === LAYER_CAMERA.minPitch, `rim fall: boom ${rim.boom}`);
  // A hole above lets the camera through at the wanted pitch.
  const under = tile(1, 3, 0);
  const pivot = { x: under.x, y: under.top + 1.68, z: under.z },
    dir = boomDirection(Math.PI / 2 + Math.PI, (55 * Math.PI) / 180);
  const blocked = freeBoom(tiles, pivot, dir, 6);
  for (let s = 0; s < 6; s += 0.25) {
    const cell = tileAt(0, pivot.x + dir.x * s, pivot.z + dir.z * s);
    if (cell) tiles.remove(cell.id);
  }
  for (const n of LAYER_TILES.filter((t) => t.layer === 0 && Math.hypot(t.x - pivot.x, t.z - pivot.z) < 5)) tiles.remove(n.id);
  assert.ok(blocked < 6 && freeBoom(tiles, pivot, dir, 6) >= 6, "free through the hole");
  physics.dispose();
});

test("landing marker: the first intact tile below while falling between layers; red when nothing is below; nothing in normal play", () => {
  const { physics, tiles } = field();
  const t = tile(0, 1, 0);
  assert.deepEqual(landingMarker(tiles, false, t.x, t.top + 0.78, t.z, 0), { kind: "none" }, "standing");
  assert.deepEqual(landingMarker(tiles, true, t.x, t.top + 3, t.z, -3), { kind: "safe", tile: t.id, x: t.x, z: t.z }, "falling onto L1");
  assert.deepEqual(landingMarker(tiles, false, t.x, t.top + 1.7, t.z, -3), { kind: "none" }, "coming down from a jump");
  tiles.remove(t.id);
  const l2 = tileAt(1, t.x, t.z)!;
  assert.deepEqual(landingMarker(tiles, true, t.x, t.top - 1, t.z, -6), { kind: "safe", tile: l2.id, x: t.x, z: t.z }, "through the hole to L2");
  assert.deepEqual(landingMarker(tiles, false, t.x, t.top + 1.2, t.z, -4), { kind: "none" }, "jumping over the hole");
  assert.equal(landingMarker(tiles, true, t.x, t.top + 3, t.z, 2).kind, "none", "rising");
  const danger = landingMarker(tiles, true, 9.5, 12, 0, -5);
  assert.equal(danger.kind, "danger", "outside every layer below");
  assert.equal(landingMarker(tiles, true, 0, -1, 0, -5).kind, "danger", "below the last layer");
  physics.dispose();
});

/**
 * The Playground's camera chain on a live body, one frame per tick: the fall state from
 * the physics pelvis, the landing marker, the follow and the orbit (yaw 0, rest pitch).
 */
function watchCamera(tiles: TileField, c: Character) {
  const fall = new LayerFall(),
    follow = new LayerFollow(),
    rig: LayerCameraState = { drop: 0, boom: null };
  fall.reset(pelvis(c).y);
  let last = pelvis(c).y;
  const log = { fallingTicks: 0, markers: new Set<string>(), lookDrop: 0, pitch: Infinity, camY: [] as number[], pivotY: [] as number[] };
  return {
    fall,
    log,
    tick() {
      const p = pelvis(c);
      fall.update(tiles, p.x, p.y, p.z, c.body.linvel().y);
      const marker = landingMarker(tiles, fall.falling, p.x, p.y, p.z, (p.y - last) * 60);
      last = p.y;
      const landingY = marker.kind === "safe" ? tiles.tiles[marker.tile].top : marker.kind === "danger" ? marker.y : null;
      const pivot = follow.update(p, fall, landingY, 1 / 60);
      const pose = updateLayerCamera(tiles, pivot, 0, LAYER_CAMERA.restPitch, rig, 1 / 60);
      if (fall.falling) log.fallingTicks++;
      if (marker.kind !== "none") log.markers.add(marker.kind === "safe" ? `safe L${tiles.tiles[marker.tile].layer + 1}` : "danger");
      log.lookDrop = Math.max(log.lookDrop, follow.lookDrop);
      log.pitch = Math.min(log.pitch, pose.pitch);
      log.camY.push(pose.position.y);
      log.pivotY.push(pivot.y);
    },
  };
}
/** Largest vertical acceleration (m/s²) of a per-tick series. */
const peakAcceleration = (ys: number[]) => Math.max(...ys.slice(2).map((y, i) => Math.abs(y - 2 * ys[i + 1] + ys[i]) * 3600));

test("a jump is not a fall between layers: standing, walking, sprinting, at the rim, under a layer, over one or two missing tiles", () => {
  // Pelvis x at take-off for the gap jumps: inside the measured windows (one missing, walking
  // −2.38…−1.08; two missing, sprinting −3.66…−3.04), holes at q = 0 (and −1) of L1's row r = 0.
  const cases: { name: string; at: [LayerIndex, number, number, number]; missing?: number[]; input: (tick: number, x: number) => MovementInput }[] = [
    { name: "standing", at: [0, 1, 0, 0], input: (t) => walk(0, 0, { jump: t === 10 }) },
    { name: "walking", at: [0, -3, 0, 0], input: (t) => walk(1, 0, { jump: t === 30 }) },
    { name: "sprinting", at: [0, -3, 0, -0.5], input: (t) => walk(1, 0, { sprint: true, jump: t === 30 }) },
    { name: "0.6 m from the rim", at: [0, 4, 0, 0.4], input: (t) => walk(0, 0, { jump: t === 10 }) },
    { name: "on L2 under intact L1", at: [1, 1, 0, 0], input: (t) => walk(0, 0, { jump: t === 10 }) },
    { name: "over one missing tile, walking", at: [0, -3, 0, -0.4], missing: [0], input: (t, x) => walk(x > 5 ? 0 : 1, 0, { jump: t > 5 && x >= -1.72 && x < -1.6 }) },
    { name: "over two missing tiles, sprinting", at: [0, -3, 0, -0.4], missing: [-1, 0], input: (_tick, x) => walk(x > 5 ? 0 : 1, 0, { sprint: true, jump: x >= -3.34 && x < -3.2 }) },
  ];
  for (const { name, at: [layer, q, r, dx], missing = [], input } of cases) {
    const { physics, tiles } = field();
    for (const m of missing) tiles.remove(tile(0, m, 0).id);
    physics.world.step();
    const start = tile(layer, q, r);
    const c = place(physics, 0, start.x + dx, start.top + STAND, start.z);
    settle(physics);
    const cam = watchCamera(tiles, c);
    const standing = pelvis(c).y;
    let apex = -Infinity,
      lowest = Infinity,
      takeoff = -1,
      landed = -1;
    for (let tick = 0; tick < 110; tick++) {
      physics.step([input(tick, pelvis(c).x), IDLE_INPUT, IDLE_INPUT]);
      if (takeoff < 0 && c.jumpIn > 0) takeoff = tick;
      if (takeoff >= 0 && landed < 0 && tick > takeoff + 5 && physics.isGrounded(0)) landed = tick;
      apex = Math.max(apex, pelvis(c).y - standing);
      if (takeoff >= 0) lowest = Math.min(lowest, pelvis(c).y - start.top);
      cam.tick();
    }
    const { log } = cam;
    const label = `${name}: apex +${apex.toFixed(2)} m, air ${landed - takeoff} ticks, lowest ${lowest.toFixed(2)} m over the layer`;
    assert.ok(takeoff >= 0 && landed > takeoff, `jumped and landed — ${label}`);
    assert.ok(pelvis(c).y > start.top + 0.5 && !c.eliminated, `still on L${layer + 1} — ${label}`);
    // Jump physics as measured before this pass: ≈ 0.6 s in the air, ≈ 0.96 m rise.
    if (!missing.length) assert.ok(apex > 0.9 && apex < 1.0 && landed - takeoff >= 33 && landed - takeoff <= 39, `jump unchanged — ${label}`);
    assert.equal(log.fallingTicks, 0, `never falling between layers — ${label}`);
    assert.deepEqual([...log.markers], [], `no landing marker — ${label}`);
    assert.equal(log.lookDrop, 0, `the camera never looks down toward a landing point — ${label}`);
    assert.ok(Math.abs(log.pitch - LAYER_CAMERA.restPitch) < 1e-9, `the orbit keeps its pitch (${((log.pitch * 180) / Math.PI).toFixed(1)}°) — ${label}`);
    const rise = Math.max(...log.camY) - Math.min(...log.camY),
      jolt = peakAcceleration(log.camY);
    assert.ok(rise < LAYER_CAMERA.jumpShare * 1.0 + 0.02, `the camera lifts ${rise.toFixed(3)} m — ${label}`);
    // Before: a 0.1 s follow that switched to 0.03 s below −3 m/s: −124…+196 m/s².
    assert.ok(jolt < 10, `camera vertical acceleration ≤ ${jolt.toFixed(1)} m/s² — ${label}`);
    physics.dispose();
  }
});

test("gap jumps over the whole timing range: a body that makes it never falls between layers; one that falls short always does, by the time it passes the layer", () => {
  for (const { missing, sprint, from, to } of [
    { missing: [0], sprint: false, from: -3, to: 0.2 },
    { missing: [-1, 0], sprint: true, from: -4.3, to: -2.6 },
  ]) {
    const { physics, tiles } = field();
    for (const m of missing) tiles.remove(tile(0, m, 0).id);
    physics.world.step();
    const far = tile(0, missing[missing.length - 1] + 1, 0);
    let made = 0,
      short = 0,
      caught = 0;
    for (let jumpX = from; jumpX <= to + 1e-9; jumpX += 0.1) {
      const c = place(physics, 0, -6.4, LAYER_TOPS[0] + STAND, 0);
      settle(physics, 20);
      const cam = watchCamera(tiles, c);
      let jumped = false,
        lowest = Infinity,
        fellAt = Infinity;
      // Long enough for a body wedged on the far tile's edge to climb up or slide off.
      for (let tick = 0; tick < 320 && !c.eliminated && pelvis(c).y > LAYER_TOPS[1] + 1.2; tick++) {
        const x = pelvis(c).x;
        physics.step([walk(x > 5 ? 0 : 1, 0, { sprint, jump: !jumped && x >= jumpX }), IDLE_INPUT, IDLE_INPUT]);
        if (c.jumpIn > 0) jumped = true;
        cam.tick();
        const p = pelvis(c);
        const under = tileAt(0, p.x, p.z);
        if (p.y > LAYER_TOPS[0] && (!under || !tiles.intact(under.id))) lowest = Math.min(lowest, p.y - LAYER_TOPS[0]);
        if (cam.fall.falling && fellAt === Infinity) fellAt = p.y - LAYER_TOPS[0];
      }
      const p = pelvis(c),
        across = !c.eliminated && p.y > LAYER_TOPS[0] + 0.3 && p.x > far.x - HEX.width / 2;
      const label = `${missing.length} missing, ${sprint ? "sprinting" : "walking"}, jump at x = ${jumpX.toFixed(2)}`;
      if (across) {
        made++;
        if (lowest < LAYER_FALL.sink) caught++;
        assert.equal(cam.log.fallingTicks, 0, `made it: never falling between layers — ${label}`);
        assert.deepEqual([...cam.log.markers], [], `made it: no landing marker — ${label}`);
        assert.equal(cam.log.lookDrop, 0, `made it: no look-down — ${label}`);
      } else if (p.y < LAYER_TOPS[0]) {
        short++;
        assert.ok(fellAt > -0.2, `fell short: falling from ${fellAt.toFixed(2)} m over L1's surface — ${label}`);
        assert.ok(cam.log.markers.has("safe L2"), `fell short: the marker shows L2 — ${label}`);
      } else assert.equal(cam.log.fallingTicks, 0, `still hanging on the far edge: not falling — ${label}`);
    }
    assert.ok(made >= 5 && short >= 5, `both outcomes swept (${made} made, ${short} short)`);
    // Some made it by catching the far tile's edge with the pelvis below standing height.
    assert.ok(caught >= 1, `ledge catches in the sweep: ${caught}`);
    physics.dispose();
  }
});

test("falling between layers: a vanished tile, three layers down, off the last layer's rim; the marker and the camera follow the fall and landing ends it", () => {
  const { physics, tiles } = field();
  const top = tile(0, 1, 0),
    l2 = tileAt(1, top.x, top.z)!;
  let c = place(physics, 0, top.x, top.top + STAND, top.z);
  settle(physics);
  let cam = watchCamera(tiles, c);
  tiles.remove(top.id);
  let fellAfter = -1,
    landedAfter = -1;
  for (let tick = 0; tick < 130; tick++) {
    physics.step([IDLE_INPUT, IDLE_INPUT, IDLE_INPUT]);
    cam.tick();
    if (fellAfter < 0 && cam.fall.falling) fellAfter = tick;
    if (fellAfter >= 0 && landedAfter < 0 && !cam.fall.falling) landedAfter = tick;
  }
  // Old rule: the marker at −1 m/s (3 ticks), the fast follow at −3 m/s (9 ticks).
  assert.ok(fellAfter >= 0 && fellAfter <= 9, `falling ${fellAfter} ticks after the tile went`);
  assert.ok(landedAfter > 40 && landedAfter < 60, `landed on L2 after ${landedAfter} ticks`);
  assert.equal(cam.log.fallingTicks, landedAfter - fellAfter, "one continuous fall");
  assert.equal(cam.fall.ground, LAYER_TOPS[1], "L2 is the new ground");
  assert.ok(cam.log.markers.has(`safe L2`), "the marker showed the L2 tile");
  assert.ok(cam.log.lookDrop > 1.5, `the camera looked down ${cam.log.lookDrop.toFixed(2)} m toward it`);
  assert.equal(cam.log.pitch, LAYER_CAMERA.minPitch, "and lowered its pitch to pass L1");
  const settled = cam.log.pivotY[cam.log.pivotY.length - 1];
  assert.ok(Math.abs(settled - (l2.top + LAYER_FALL.stand + LAYER_CAMERA.pivotHeight)) < 0.06, `pivot back at L2's stance (${settled.toFixed(2)})`);
  // A jump right after landing on the lower layer is a jump.
  const before = cam.log.fallingTicks;
  for (let tick = 0; tick < 80; tick++) {
    physics.step([walk(0, 0, { jump: tick === 0 }), IDLE_INPUT, IDLE_INPUT]);
    cam.tick();
  }
  assert.ok(c.jumpIn > 0 || physics.isGrounded(0));
  assert.equal(cam.log.fallingTicks, before, "no fall state in the jump after landing");
  // Three layers down through one column: falling the whole way, landing on L4.
  c = place(physics, 0, l2.x, l2.top + STAND, l2.z);
  settle(physics);
  cam = watchCamera(tiles, c);
  for (const layer of [1, 2] as const) tiles.remove(tileAt(layer, l2.x, l2.z)!.id);
  let fell = -1,
    landed = -1;
  for (let tick = 0; tick < 150; tick++) {
    physics.step([IDLE_INPUT, IDLE_INPUT, IDLE_INPUT]);
    cam.tick();
    if (fell < 0 && cam.fall.falling) fell = tick;
    if (fell >= 0 && landed < 0 && !cam.fall.falling) landed = tick;
  }
  assert.ok(fell >= 0 && fell <= 9 && landed > fell, `fell at ${fell}, landed at ${landed}`);
  assert.equal(cam.log.fallingTicks, landed - fell, "one continuous fall past L3");
  assert.equal(cam.fall.ground, LAYER_TOPS[3], "L4 is the new ground");
  assert.ok(cam.log.markers.has("safe L4"));
  // Walking off L4's rim: falling, and still falling when out of the round.
  const edge = tile(3, 3, 0);
  c = place(physics, 0, edge.x, edge.top + STAND, edge.z);
  settle(physics);
  cam = watchCamera(tiles, c);
  for (let tick = 0; tick < 150 && !c.eliminated; tick++) {
    physics.step([walk(1, 0), IDLE_INPUT, IDLE_INPUT]);
    cam.tick();
  }
  assert.ok(c.eliminated && cam.fall.falling && cam.log.markers.has("danger"), "off the rim: falling out, red marker");
  physics.dispose();
});

test("fall rule: rising or descending from a jump is normal play; sinking over a hole away from any ledge, or dropping past a layer, is a fall; stopping near a layer lands", () => {
  const { physics, tiles } = field();
  const t = tile(0, 1, 0),
    fall = new LayerFall();
  fall.reset(t.top + LAYER_FALL.stand);
  const at = (h: number, vy: number, x = t.x) => fall.update(tiles, x, t.top + h, t.z, vy);
  assert.equal(at(1.74, 3), false, "rising");
  assert.equal(at(1.74, -6), false, "coming down from a jump");
  assert.equal(at(0.5, -3), false, "a landing squat on an intact tile");
  tiles.remove(t.id);
  assert.equal(at(1.2, -6), false, "coming down over a hole, above standing height");
  assert.equal(at(0.5, -3, t.x + 0.7), false, "low over the hole, 0.3 m from an intact tile's edge: it can still catch it");
  assert.equal(at(0.5, -0.5), false, "low over the hole but not descending");
  assert.equal(at(0.5, -3), true, "low over the hole, away from every ledge, descending");
  assert.equal(at(-1, -8), true, "past the layer");
  assert.equal(at(-5.5 + 1.5, -12), true, "still falling 1.5 m over L2");
  assert.equal(at(-5.5 + 0.8, -0.2), false, "stopped on L2");
  assert.equal(fall.ground, LAYER_TOPS[1]);
  fall.reset(t.top + LAYER_FALL.stand);
  assert.equal(at(-1, -2), true, "anywhere past the layer, even slowly");
  assert.equal(fall.update(tiles, 0, -1, 0, -3), true, "below the last layer");
  physics.dispose();
});

test("controls: WASD relative to the camera; punch, sprint (Shift) and jump pass through; no aim facing, grab or lift", () => {
  const raw = { x: 0, z: -1, jump: true, punch: true, grab: true, lift: true };
  const forward = layerIntent(raw, Math.PI / 2);
  assert.ok(Math.abs(forward.x - 1) < 1e-9 && Math.abs(forward.z) < 1e-9, "W walks where the camera looks");
  const right = layerIntent({ ...raw, x: 1, z: 0 }, 0);
  assert.ok(Math.abs(right.x + 1) < 1e-9 && Math.abs(right.z) < 1e-9, "D is screen-right");
  assert.deepEqual([forward.jump, forward.punch, forward.sprint], [true, true, true]);
  assert.equal(forward.facing, undefined);
  assert.equal(forward.grab, undefined);
  assert.equal(forward.lift, undefined);
});

// ─── Gök Petekleri: background scenery (visual only) ───────────────────────

const SKY_KIT = path.resolve("public/party-lab/maps/layers/layers-kit.glb");
async function skyKit() {
  const data = fs.readFileSync(SKY_KIT);
  const gltf = await new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), "");
  return readSkyKit(gltf.scene);
}
/** A piece's vertices in the world. */
function skyVertices(kit: Awaited<ReturnType<typeof skyKit>>, piece: SkyPiece) {
  const position = kit[piece.node].getAttribute("position"),
    matrix = pieceMatrix(piece);
  return Array.from({ length: position.count }, (_, i) => new Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix));
}

test("layers-kit.glb: the curated nodes only, vertex colours, no textures, opaque metalness-0, < 300 KB", () => {
  const buffer = fs.readFileSync(SKY_KIT);
  const json = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString("utf8"));
  assert.ok(buffer.length < 300 * 1024, `${(buffer.length / 1024).toFixed(0)} KB`);
  assert.deepEqual(json.nodes.map((n: { name: string }) => n.name).sort(), [...SKY_NODES].sort());
  assert.ok(!json.images && !json.textures, "no textures");
  for (const m of json.materials) {
    assert.equal(m.pbrMetallicRoughness.metallicFactor, 0, m.name);
    assert.ok(!m.alphaMode || m.alphaMode === "OPAQUE", m.name);
  }
  for (const mesh of json.meshes)
    for (const primitive of mesh.primitives) assert.deepEqual(Object.keys(primitive.attributes).sort(), ["COLOR_0", "NORMAL", "POSITION"], mesh.name);
  assert.ok(fs.existsSync(path.resolve("public/party-lab/maps/layers/CREDITS.txt")));
});

test("sky scenery never comes near play: outside the camera's reach, cloud sea and stumps under the last layer, island and hex tops clear of every layer height", async () => {
  const kit = await skyKit();
  // The chase camera stays within the field plus its boom: scenery beyond cannot sit between
  // it and a tile or player, under a hole, or clip it.
  const reach = LAYERS_MAP.bounds.maxX + LAYER_CAMERA.boom + LAYER_CAMERA.collision.radius;
  assert.ok(reach + 5 < SKY_CLEAR_RADIUS, `camera reach ${reach.toFixed(1)} m`);
  for (const piece of SKY_PIECES) {
    const vertices = skyVertices(kit, piece),
      label = `${piece.node} at (${piece.x.toFixed(1)}, ${piece.y}, ${piece.z.toFixed(1)})`;
    const nearest = Math.min(...vertices.map((v) => Math.hypot(v.x, v.z)));
    assert.ok(nearest >= SKY_CLEAR_RADIUS, `${label}: ${nearest.toFixed(1)} m from the axis`);
    const top = Math.max(...vertices.map((v) => v.y));
    if (piece.group === "cloud" || (piece.node === "ColumnDamaged" && piece.y < 0))
      assert.ok(top <= CLOUD_TOP_MAX, `${label}: top ${top.toFixed(2)} (cloud sea / stump)`);
    const platform = piece.group === "hex" || (piece.node.startsWith("Island") && piece.scale[1] > 0);
    if (platform)
      for (const layerTop of LAYER_TOPS)
        assert.ok(Math.abs(top - layerTop) >= HEX_LAYER_CLEARANCE, `${label}: top ${top.toFixed(2)} level with the layer at ${layerTop}`);
  }
  const count = (test: (p: SkyPiece) => boolean) => SKY_PIECES.filter(test).length;
  assert.equal(count((p) => p.node === "IslandLarge" || p.node === "IslandMedium" || (p.node === "IslandTall" && p.scale[1] > 0)), 6, "six islands");
  assert.equal(count((p) => p.node === "Column"), 3, "three landmark columns");
  assert.ok(count((p) => p.node === "Flag") <= 3 && count((p) => p.group === "hex") <= 6 && count((p) => p.node === "Tree") <= 1);
});

test("sky scenery budget: two merged draw calls, < 40k triangles, opaque, no shadows, no physics", async () => {
  const built = buildSkyScenery(await skyKit());
  try {
    const meshes = built.group.children as Mesh[];
    assert.equal(built.drawCalls, 2);
    assert.equal(meshes.length, 2);
    assert.ok(built.triangles < 40_000, `${built.triangles} triangles`);
    for (const mesh of meshes) {
      assert.ok(mesh.isMesh && !mesh.castShadow && !mesh.receiveShadow, mesh.name);
      const material = mesh.material as MeshLambertMaterial;
      assert.ok(material.vertexColors && !material.transparent && material.fog, mesh.name);
      assert.ok(!mesh.geometry.getAttribute("uv"), `${mesh.name}: untextured`);
    }
  } finally {
    built.dispose();
  }
  // Scenery code never reaches the physics world (no colliders, bodies or queries).
  for (const file of ["layers/skyScenery.ts", "layers/LayerSkyScenery.tsx"]) {
    const source = fs.readFileSync(path.resolve("src/party-lab/scene", file), "utf8");
    assert.ok(!/rapier|physics|collider/i.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), `${file} stays visual`);
  }
});
