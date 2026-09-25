import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import RAPIER from "@dimforge/rapier3d-compat";
import { InstancedMesh, Matrix4, PerspectiveCamera, Raycaster, Vector3, type Mesh } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { initializePhysics, IDLE_INPUT, PlaygroundPhysics } from "./physics";
import { LocalRoundSimulation } from "./localRound";
import { restore } from "./ragdoll/character";
import { PARTS, RAGDOLL } from "./ragdoll/config";
import type { PlayerId } from "./players";
import type { MovementInput } from "../input/types";
import { createArenaWorld } from "../../../shared/party-lab/simulation/world";
import { NET } from "../../../shared/party-lab/network/protocol";
import { MODE_MAP } from "../../../shared/party-lab/modes";
import {
  ARENA_MAP_IDS,
  DEFAULT_ARENA_MAP_ID,
  ONLINE_ARENA_MAP_ID,
  arenaMap,
  isArenaMapId,
  rampHull,
  spawnYaw,
  type ArenaCollider,
  type RampCollider,
} from "../../../shared/party-lab/maps";
import {
  BALE,
  BARN,
  BARN_MAP,
  BARREL_SIZE,
  BARRELS,
  COVER,
  CRATE,
  DECK_THICKNESS,
  DECKS,
  DROPS,
  EAST_LANDING,
  HUB,
  HUB_HALF,
  OUTER,
  POST,
  POSTS,
  RAIL_DEPTH,
  RAIL_HEIGHT,
  RAILS,
  RAMP,
  SPAWN_CANDIDATES,
  STAIRS,
  STALL,
  START_SPAWNS,
  STEPS,
  TRAPS,
  UPPER_HEIGHT,
  VOID,
  WALL_BLOCKS,
  WALL_HEIGHT,
  WEAPON_SPOTS,
  WING_HALF,
  WINGS,
  ZONES,
  insideBarn,
  stepColumn,
  type BarnCoverId,
  type Rect,
} from "../../../shared/party-lab/maps/barn";
import { ROOFTOP_MAP } from "../../../shared/party-lab/maps/rooftop";
import {
  BARN_CAMERA,
  barnCameraBlockers,
  cameraRelativeMove,
  cameraRight,
  castBlockers,
  clampPitch,
  insideBlockers,
  ownCharacterOpacity,
  updateChaseCamera,
  type Point,
} from "./arenas/barnCamera";
import { barnIntent } from "./arenas/barnControls";
import { BARN_KIT_NODES, buildBarn, readBarnKit } from "./arenas/buildBarn";
import { ACTIONS } from "../input/actions";
import { changeBinding } from "../input/bindings";
import { defaultBindings } from "../input/defaults";
import { InputManager } from "../input/inputManager";
import { deserializeControls, serializeControls } from "../input/storage";
import { DOORS, RAFTERS, SACKS, SHEAVES, SHELL } from "./arenas/barnScenery";

before(() => initializePhysics());

const map = BARN_MAP;
const U = UPPER_HEIGHT;
type Range = readonly [number, number];
interface Extent {
  role: string;
  x: Range;
  y: Range;
  z: Range;
  radius?: { x: number; z: number; r: number };
}
/** Axis-aligned extent of any collider (a ramp by its wedge's bounding box). */
function extent(c: ArenaCollider): Extent {
  if (c.shape === "cylinder")
    return {
      role: c.role,
      x: [c.center.x - c.radius, c.center.x + c.radius],
      y: [c.center.y - c.halfHeight, c.center.y + c.halfHeight],
      z: [c.center.z - c.radius, c.center.z + c.radius],
      radius: { x: c.center.x, z: c.center.z, r: c.radius },
    };
  return {
    role: c.role,
    x: [c.center.x - c.half.x, c.center.x + c.half.x],
    y: [c.center.y - c.half.y, c.center.y + c.half.y],
    z: [c.center.z - c.half.z, c.center.z + c.half.z],
  };
}
/** Horizontal clear distance between two footprints (a cylinder is measured as a circle). */
function gap(a: Extent, b: Extent) {
  const boxGap = (p: Extent, q: Extent) =>
    Math.hypot(Math.max(p.x[0] - q.x[1], q.x[0] - p.x[1], 0), Math.max(p.z[0] - q.z[1], q.z[0] - p.z[1], 0));
  if (a.radius && b.radius) return Math.max(0, Math.hypot(a.radius.x - b.radius.x, a.radius.z - b.radius.z) - a.radius.r - b.radius.r);
  const circle = a.radius ?? b.radius;
  if (!circle) return boxGap(a, b);
  const box = a.radius ? b : a;
  const dx = Math.max(box.x[0] - circle.x, circle.x - box.x[1], 0),
    dz = Math.max(box.z[0] - circle.z, circle.z - box.z[1], 0);
  return Math.max(0, Math.hypot(dx, dz) - circle.r);
}
const overlapsVertically = (a: Extent, b: Extent) => Math.min(a.y[1], b.y[1]) - Math.max(a.y[0], b.y[0]) > 1e-6;
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const within = (r: Rect, x: number, z: number, eps = 1e-6) => x > r.x[0] - eps && x < r.x[1] + eps && z > r.z[0] - eps && z < r.z[1] + eps;
const size = (r: Range) => r[1] - r[0];
/** Distance with height differences weighted 1.5× (a floor apart matters more than a step). */
const spacing = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.hypot(a.x - b.x, (a.y - b.y) * 1.5, a.z - b.z);
const cover = (id: BarnCoverId) => COVER.find((c) => c.id === id)!;
const point = (p: { x: number; z: number }, fy = 0): Extent => ({ role: "p", x: [p.x, p.x], y: [fy, fy], z: [p.z, p.z] });
/** Clear horizontal distance from a floor point to the nearest collider in the standing volume above it. */
const clearance = (p: { x: number; z: number }, fy: number, height = 1.95) =>
  Math.min(...map.colliders.map(extent).filter((e) => !(e.y[1] <= fy + 0.05 || e.y[0] >= fy + height)).map((e) => gap(e, point(p, fy))));

function withWorld<T>(check: (world: RAPIER.World) => T) {
  const world = createArenaWorld(map);
  try {
    world.step();
    return check(world);
  } finally {
    world.free();
  }
}
const surfaceIn = (world: RAPIER.World) => (x: number, z: number, from = 20) => {
  const hit = world.castRay(new RAPIER.Ray({ x, y: from, z }, { x: 0, y: -1, z: 0 }), 100, true);
  return hit ? from - hit.timeOfImpact : null;
};
/** Chest-to-chest line of sight through the static arena. */
function sees(world: RAPIER.World, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, chest = 1.33) {
  const o = { x: a.x, y: a.y + chest, z: a.z },
    d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z },
    length = Math.hypot(d.x, d.y, d.z);
  return !world.castRay(new RAPIER.Ray(o, { x: d.x / length, y: d.y / length, z: d.z / length }), length, true);
}

function withBarn(check: (p: PlaygroundPhysics) => void) {
  const p = new PlaygroundPhysics(undefined, map);
  try {
    check(p);
  } finally {
    p.dispose();
  }
}
function solo(p: PlaygroundPhysics, keep: PlayerId[] = [0]) {
  for (const c of p.players) {
    if (keep.includes(c.id)) continue;
    c.eliminated = true;
    for (const part of Object.values(c.parts)) part.body.setEnabled(false);
  }
}
function run(p: PlaygroundPhysics, seconds: number, input: (t: number) => MovementInput = () => IDLE_INPUT) {
  for (let i = 0; i < Math.round(seconds * 60); i++) p.step([input(i / 60), IDLE_INPUT, IDLE_INPUT]);
}
const pelvis = (p: PlaygroundPhysics, id: PlayerId = 0) => p.players[id].body.translation();
const facing = (x: number, z: number) => Math.atan2(x, z);
const uprightness = (p: PlaygroundPhysics) => {
  const q = p.players[0].parts.torso.body.rotation();
  return 1 - 2 * (q.x * q.x + q.z * q.z); // torso up-vector Y
};
/** Walks from `start` (a surface point) in a direction (optionally jump-spamming) and returns the path's highest pelvis. */
function walk(p: PlaygroundPhysics, start: { x: number; y: number; z: number }, dir: { x: number; z: number }, seconds: number, jump = false) {
  restore(p.players[0], { x: start.x, y: start.y + 0.8, z: start.z }, facing(dir.x, dir.z));
  run(p, 0.5);
  let highest = -Infinity;
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    p.step([{ x: dir.x, z: dir.z, jump }, IDLE_INPUT, IDLE_INPUT]);
    highest = Math.max(highest, pelvis(p).y);
  }
  return highest;
}
/** Follows waypoints (surface points) with plain input toward each; returns the time taken or null. */
function follow(p: PlaygroundPhysics, points: { x: number; z: number; y?: number }[], limit = 20) {
  const s = points[0];
  restore(p.players[0], { x: s.x, y: (s.y ?? 0) + 0.8, z: s.z }, facing(points[1].x - s.x, points[1].z - s.z));
  run(p, 0.5);
  let k = 1;
  for (let i = 0; i < limit * 60; i++) {
    const b = pelvis(p), w = points[k];
    const dx = w.x - b.x, dz = w.z - b.z, d = Math.hypot(dx, dz);
    if (d < (k === points.length - 1 ? 0.5 : 0.8) && (w.y === undefined || Math.abs(b.y - 0.78 - w.y) < 0.5)) {
      if (++k === points.length) return i / 60;
      continue;
    }
    p.step([{ x: dx / d, z: dz / d, jump: false }, IDLE_INPUT, IDLE_INPUT]);
  }
  return null;
}

// ─── Registration and footprint ─────────────────────────────────────────────

test("barn is selectable locally and is Barn Shootout's online map; rooftop stays the local default", () => {
  assert.ok(isArenaMapId("barn"));
  assert.equal(arenaMap("barn"), map);
  assert.ok(ARENA_MAP_IDS.includes("barn"));
  assert.equal(DEFAULT_ARENA_MAP_ID, "rooftop");
  assert.equal(ONLINE_ARENA_MAP_ID, "rooftop", "Rooftop Brawl's map");
  assert.equal(MODE_MAP.barn_shootout, "barn");
  assert.equal(MODE_MAP.rooftop_brawl, "rooftop");
  // 5 = game modes: a room can run Barn rounds, which a protocol-4 page would render and
  // predict as the rooftop, so mismatched pages are refused at join. 6 = Katman Kaosu online,
  // 7 = Renk Kaosu online; 8 = Bomba Sende online (Barn's own wire content unchanged).
  assert.equal(NET.version, 8, "Bomba Sende online adds protocol 8");
  assert.equal(new LocalRoundSimulation(() => 0.5).map.id, "rooftop", "local default unchanged");
});

test("four-wing footprint: 35 m across, a 13 m hub and four 9 m × 11 m wings; the walls are the cross's outline", () => {
  assert.ok(close(BARN.maxX - BARN.minX, 35) && close(BARN.maxZ - BARN.minZ, 35));
  assert.ok(close(size(HUB.x), 13) && close(size(HUB.z), 13));
  for (const [id, w] of Object.entries(WINGS)) {
    const alongZ = id === "N" || id === "S";
    assert.ok(close(size(alongZ ? w.x : w.z), 9), `${id} wing width`);
    assert.ok(close(size(alongZ ? w.z : w.x), 11), `${id} wing length beyond the hub`);
  }
  // Inside the cross, including the hub's shoulders; outside it, the corners.
  for (const [x, z] of [[0, 0], [6, 6], [-6.4, 6.4], [0, -17.4], [17.4, 0], [4.4, 17.4], [-17.4, -4.4]]) assert.ok(insideBarn(x, z), `${x},${z} inside`);
  for (const [x, z] of [[8, 8], [5, -8], [-8, 5], [17, 6], [6.6, 4.6]]) assert.ok(!insideBarn(x, z), `${x},${z} outside`);
  // The wall mass covers exactly the outside of the cross: no floor point inside is walled, every outside one is.
  for (let x = -OUTER + 0.25; x < OUTER; x += 0.5)
    for (let z = -OUTER + 0.25; z < OUTER; z += 0.5) {
      const walled = WALL_BLOCKS.some((w) => within(w, x, z, -1e-9));
      assert.equal(walled, !insideBarn(x, z), `wall mass at ${x},${z}`);
    }
  assert.equal(map.colliders.length, 61);
  assert.deepEqual(map.lethalEdges, []);
  for (const c of map.colliders) {
    const values =
      c.shape === "cylinder" ? [c.center.x, c.center.y, c.center.z, c.radius, c.halfHeight] : [...Object.values(c.center), ...Object.values(c.half)];
    assert.ok(values.every(Number.isFinite), c.role);
    if (c.shape !== "cylinder") assert.ok(c.half.x > 0 && c.half.y > 0 && c.half.z > 0, c.role);
    else assert.ok(c.radius > 0 && c.halfHeight > 0, c.role);
    const e = extent(c);
    assert.ok(e.x[0] >= BARN.minX - 0.4 - 1e-9 && e.x[1] <= BARN.maxX + 0.4 + 1e-9, `${c.role} x`);
    assert.ok(e.z[0] >= BARN.minZ - 0.4 - 1e-9 && e.z[1] <= BARN.maxZ + 0.4 + 1e-9, `${c.role} z`);
    if (c.role !== "floor") assert.ok(e.y[0] >= -1e-9, `${c.role} starts at or above the floor`);
  }
  const roles = Object.entries(map.colliders.reduce<Record<string, number>>((m, c) => ((m[c.role] = (m[c.role] ?? 0) + 1), m), {})).sort();
  assert.deepEqual(Object.fromEntries(roles), { barrel: 3, crate: 6, floor: 1, hay: 8, loft: 9, post: 4, rail: 10, stall: 2, stairs: 2, step: 4, wall: 12 });
  const floor = extent(map.colliders.find((c) => c.role === "floor")!);
  assert.equal(floor.y[1], 0);
  assert.ok(floor.y[0] > RAGDOLL.fallY);
  // Walls stand ≥ 1.6 m above the highest floor in front of them (jump-spam safe from the upper floor too).
  for (const w of map.colliders.filter((c) => c.role === "wall").map(extent)) assert.ok(close(w.y[1], WALL_HEIGHT) && WALL_HEIGHT - U >= 1.6);
});

test("enlarged space, not enlarged things: props, risers, rails and the character keep their sizes", () => {
  const e = 1e-9;
  for (const c of COVER.filter((c) => c.role === "crate")) {
    for (const r of [c.x, c.y, c.z]) assert.ok(Math.abs(size(r) / CRATE - Math.round(size(r) / CRATE)) < e, `${c.id} is whole crates`);
    assert.ok(close(size(c.y), 2 * CRATE), `${c.id} is two crates high`);
  }
  for (const c of COVER.filter((c) => c.role === "hay")) {
    assert.ok(Math.abs(size(c.y) / BALE.height - Math.round(size(c.y) / BALE.height)) < e, `${c.id} layers`);
    const [a, b] = [size(c.x), size(c.z)].sort((p, q) => p - q);
    assert.ok(Math.abs(a / BALE.short - Math.round(a / BALE.short)) < e || Math.abs(a / BALE.long - Math.round(a / BALE.long)) < e, `${c.id} is whole bales`);
    assert.ok(Math.abs(b / BALE.long - Math.round(b / BALE.long)) < e || Math.abs(b / BALE.short - Math.round(b / BALE.short)) < e, `${c.id} is whole bales`);
  }
  for (const c of COVER.filter((c) => c.role === "stall")) assert.ok(close(size(c.x), STALL.thickness) && close(size(c.y), STALL.height), c.id);
  assert.ok(close(BARREL_SIZE.radius, 0.4) && close(BARREL_SIZE.height, 1.02));
  assert.ok(close(STEPS.riser, 0.6) && close(STEPS.tread, 1.2) && close(RAIL_HEIGHT, 1) && close(RAIL_DEPTH, 0.1));
  assert.ok(close(U, 3) && close(DECK_THICKNESS, 0.2));
  assert.equal(RAGDOLL.aimTurnSpeed, 12, "the character was not retuned for the map");
});

// ─── Upper floor ────────────────────────────────────────────────────────────

const deckArea = (d: Rect) => size(d.x) * size(d.z);
test("upper floor: one connected floor at 3.0 m — a ring broken to the south around an 8 × 8 m void, with branches into two wings", () => {
  const decks = Object.entries(DECKS);
  for (const [id, d] of decks) assert.ok(d.x[0] < d.x[1] && d.z[0] < d.z[1], id);
  const deckColliders = map.colliders.filter((c) => c.role === "loft").map(extent).filter((e) => e.y[0] > 1);
  assert.equal(deckColliders.length, decks.length);
  for (const e of deckColliders) assert.ok(close(e.y[1], U) && close(e.y[0], U - DECK_THICKNESS), "decks at 3.0 m, 0.2 m thick");
  // Connected: decks that share an edge (touching footprints) form one piece.
  const touching = (a: Rect, b: Rect) => Math.max(a.x[0] - b.x[1], b.x[0] - a.x[1]) <= 1e-9 && Math.max(a.z[0] - b.z[1], b.z[0] - a.z[1]) <= 1e-9 && (Math.min(a.x[1], b.x[1]) - Math.max(a.x[0], b.x[0]) > 0.5 || Math.min(a.z[1], b.z[1]) - Math.max(a.z[0], b.z[0]) > 0.5);
  const reached = new Set([decks[0][0]]);
  for (let grow = true; grow; ) {
    grow = false;
    for (const [id, d] of decks) if (!reached.has(id) && decks.some(([o, od]) => reached.has(o) && touching(d, od))) reached.add(id), (grow = true);
  }
  assert.equal(reached.size, decks.length, "every deck connects to the rest");
  // The void: no deck over the middle 8 × 8 m, nor over the ring's southern break (4 m wide).
  assert.ok(size(VOID.x) >= 8 && size(VOID.z) >= 8);
  for (const [id, d] of decks) {
    const overlap = (r: Rect) => Math.min(d.x[1], r.x[1]) - Math.max(d.x[0], r.x[0]) > 1e-6 && Math.min(d.z[1], r.z[1]) - Math.max(d.z[0], r.z[0]) > 1e-6;
    assert.ok(!overlap(VOID), `${id} covers the void`);
    assert.ok(!overlap({ x: [-2, 2], z: [4, HUB_HALF] }), `${id} closes the ring's southern break`);
  }
  // A real floor, not a loft: ≥ 150 m² in total, with ring sides on three sides of the void and
  // branches reaching ≥ 7 m into the north and east wings — but it covers under half the ground.
  const area = decks.reduce((s, [, d]) => s + deckArea(d), 0);
  const ground = 13 * 13 + 4 * 9 * 11;
  assert.ok(area >= 150 && area / ground <= 0.45 && area / ground >= 0.25, `upper floor ${area.toFixed(0)} m² = ${((area / ground) * 100).toFixed(0)}% of the ground floor`);
  const reach = (wing: "N" | "E") => Math.max(...decks.map(([, d]) => (wing === "N" ? (within(WINGS.N, (d.x[0] + d.x[1]) / 2, d.z[0], 1e-6) ? -d.z[0] - HUB_HALF : 0) : within(WINGS.E, d.x[1], (d.z[0] + d.z[1]) / 2, 1e-6) ? d.x[1] - HUB_HALF : 0)));
  assert.ok(reach("N") >= 7 && reach("E") >= 7, `branches reach ${reach("N")} m north and ${reach("E")} m east`);
  for (const side of [{ x: 0, z: -5.25 }, { x: -5.25, z: 0 }, { x: 5.25, z: 0 }]) assert.ok(decks.some(([, d]) => within(d, side.x, side.z)), "ring side");
});

/** Deck-edge samples just off each deck, where the upper floor ends in open air. */
function openEdgeSamples() {
  const supported = (x: number, z: number) =>
    !insideBarn(x, z) || [...Object.values(DECKS), EAST_LANDING, RAMP, STAIRS].some((r) => within(r, x, z));
  const out: { deck: string; x: number; z: number; out: { x: number; z: number } }[] = [];
  for (const [id, d] of Object.entries(DECKS))
    for (const [axis, at, dir] of [["z", d.z[0], -1], ["z", d.z[1], 1], ["x", d.x[0], -1], ["x", d.x[1], 1]] as const) {
      const [lo, hi] = axis === "z" ? d.x : d.z;
      for (let c = lo + 0.05; c < hi - 0.04; c += 0.1) {
        const x = axis === "z" ? c : at, z = axis === "z" ? at : c;
        const ox = axis === "x" ? dir : 0, oz = axis === "z" ? dir : 0;
        if (!supported(x + ox * 0.02, z + oz * 0.02)) out.push({ deck: id, x, z, out: { x: ox, z: oz } });
      }
    }
  return out;
}

test("edges: every open upper-floor edge is railed or a marked drop; rails sit on deck edges; 13 drops spread over the floor", () => {
  const samples = openEdgeSamples();
  assert.ok(samples.length > 300, `${samples.length} edge samples`);
  const railed = (x: number, z: number) => RAILS.some((r) => within(r, x, z, 0.06));
  const dropAt = (x: number, z: number) => DROPS.find((d) => within(d.edge, x, z, 0.03));
  let railedCount = 0,
    dropCount = 0;
  for (const s of samples) {
    const r = railed(s.x, s.z),
      d = dropAt(s.x, s.z);
    assert.ok(r || d, `unmarked open edge of ${s.deck} at ${s.x.toFixed(2)},${s.z.toFixed(2)}`);
    const strictlyRailed = RAILS.some((q) => within(q, s.x, s.z, -0.001) || (within(q, s.x, s.z, 0.06) && Math.min(size(q.x), size(q.z)) < 0.2 && within({ x: [q.x[0] + 0.05, q.x[1] - 0.05], z: [q.z[0] + 0.05, q.z[1] - 0.05] }, s.x, s.z, 0.06)));
    assert.ok(!(strictlyRailed && d && within(d.edge, s.x, s.z, -0.05)), `railed drop at ${s.x.toFixed(2)},${s.z.toFixed(2)}`);
    if (r) railedCount++;
    if (d) {
      dropCount++;
      assert.ok(d.out.x === s.out.x && d.out.z === s.out.z, `${d.id} points off the deck`);
    }
  }
  // Selective rails: roughly a third of the open edge is railed, the rest is readable drops.
  const railedShare = railedCount / samples.length;
  assert.ok(railedShare > 0.25 && railedShare < 0.55, `railed ${(railedShare * 100).toFixed(0)}%, drops ${((dropCount / samples.length) * 100).toFixed(0)}%`);
  // Each rail is a 0.1 m band just inside a deck edge, 1 m tall.
  for (const r of RAILS) {
    assert.ok(Object.values(DECKS).some((d) => within(d, (r.x[0] + r.x[1]) / 2, (r.z[0] + r.z[1]) / 2)), "rail on a deck");
    assert.ok(close(Math.min(size(r.x), size(r.z)), RAIL_DEPTH));
  }
  assert.equal(DROPS.length, 13);
  const zones = new Set(DROPS.map((d) => (within(VOID, d.edge.x[0], d.edge.z[0], 0.01) ? "void" : within(HUB, (d.edge.x[0] + d.edge.x[1]) / 2, (d.edge.z[0] + d.edge.z[1]) / 2, 0.01) ? "ring" : "branch")));
  assert.deepEqual([...zones].sort(), ["branch", "ring", "void"]);
});

test("routes: three ways up on three sides — west ramp and south stairs at 26.6°, east hay steps with 0.6 m risers — each rising toward the hub onto a deck", () => {
  const wedges = map.colliders.filter((c): c is RampCollider => c.shape === "ramp");
  assert.equal(wedges.length, 2);
  for (const [r, rises] of [[RAMP, "+x"], [STAIRS, "-z"]] as const) {
    const w = wedges.find((c) => c.rises === rises)!;
    const run = rises.endsWith("x") ? size(r.x) : size(r.z);
    const slope = (Math.atan2(U, run) * 180) / Math.PI;
    assert.ok(slope > 26 && slope < 27, `${rises} slope ${slope.toFixed(1)}°`);
    const high = rampHull(w).filter((p) => close(p.y, U));
    assert.equal(high.length, 2);
    // The high edge borders a deck, on the hub's side.
    for (const p of high) {
      const off = rises === "+x" ? { x: p.x + 0.05, z: p.z } : { x: p.x, z: p.z - 0.05 };
      assert.ok(Object.values(DECKS).some((d) => within(d, off.x, off.z)), `${rises} top meets a deck at ${p.x},${p.z}`);
    }
  }
  assert.ok(RAMP.x[0] < -HUB_HALF && STAIRS.z[1] > HUB_HALF, "ramp in the west wing, stairs in the south wing");
  // Hay steps: four 0.6 m risers over 1.2 m treads rising west; the landing (3.0 m, solid) is the fifth.
  const steps = map.colliders.filter((c) => c.role === "step").map(extent).sort((a, b) => a.y[1] - b.y[1]);
  assert.equal(steps.length, STEPS.count);
  steps.forEach((s, i) => {
    assert.ok(close(s.y[1], 0.6 * (i + 1)) && close(size(s.x), 1.2), `step ${i + 1}`);
    if (i) assert.ok(close(s.x[1], steps[i - 1].x[0]), "treads are contiguous, rising west");
  });
  const landing = extent(map.colliders.find((c) => c.role === "loft" && c.center.y < 2)!);
  assert.ok(close(landing.y[0], 0) && close(landing.y[1], U) && close(landing.x[1], steps[steps.length - 1].x[0]));
  assert.ok(close(landing.x[0], HUB_HALF), "the landing reaches the ring");
  assert.ok(steps[0].x[0] > HUB_HALF, "hay steps in the east wing");
});

test("height classes: walkable ≤ 0.6, hop-over 0.8–1.02, full cover ≥ 1.6; nothing in the ambiguous band", () => {
  const obstacles = [
    // A cover piece's height counts from the floor it stands on; H2 is the central pile's top tier.
    ...COVER.filter((c) => c.id !== "H2").map((c) => ({ id: c.id, height: c.y[1] - (c.y[0] >= U - 1e-9 ? U : 0) })),
    ...BARRELS.map((b) => ({ id: b.id, height: BARREL_SIZE.height })),
    { id: "rail", height: RAIL_HEIGHT },
    { id: "walls above the upper floor", height: WALL_HEIGHT - U },
    { id: "deck edge above the floor", height: U },
  ];
  for (const { id, height } of obstacles) {
    const walkable = height <= 0.6 + 1e-9,
      hop = height >= 0.8 - 1e-9 && height <= 1.02 + 1e-9,
      full = height >= 1.6 - 1e-9;
    assert.ok(walkable || hop || full, `${id} is ${height} m`);
    assert.ok(!(height > 1.2 && height < 1.45), `${id} is in the ambiguous 1.2–1.45 m band`);
  }
  // The central pile's top tier sits on a 1.6 m tier: 2.4 m from the floor.
  assert.ok(close(cover("H2").y[0], cover("H1").y[1]) && close(cover("H2").y[1], 2.4));
  const route = [0, ...Array.from({ length: STEPS.count }, (_, i) => stepColumn(i + 1).y[1]), U];
  for (let i = 1; i < route.length; i++) assert.ok(route[i] - route[i - 1] <= 0.6 + 1e-9, `riser ${i}`);
});

test("gaps: every pair of obstacles at the same level touches or leaves ≥ 1.4 m (no ragdoll traps); columns are 0.6 m", () => {
  const steps = map.colliders.filter((c) => c.role === "step").map(extent);
  const stepBlock: Extent = {
    role: "steps",
    x: [Math.min(...steps.map((e) => e.x[0])), Math.max(...steps.map((e) => e.x[1]))],
    y: [0, Math.max(...steps.map((e) => e.y[1]))],
    z: [Math.min(...steps.map((e) => e.z[0])), Math.max(...steps.map((e) => e.z[1]))],
  };
  const solids = [...map.colliders.filter((c) => c.role !== "floor" && c.role !== "step").map(extent), stepBlock];
  const decks = Object.values(DECKS);
  const found: string[] = [];
  for (let i = 0; i < solids.length; i++)
    for (let j = i + 1; j < solids.length; j++) {
      const a = solids[i],
        b = solids[j];
      if (!overlapsVertically(a, b)) continue;
      const g = gap(a, b);
      if (!(g > 1e-6 && g < 1.4)) continue;
      // A deck's corner near a wall is fine when another deck bridges the space between them.
      const mx = (Math.max(a.x[0], b.x[0]) + Math.min(a.x[1], b.x[1])) / 2,
        mz = (Math.max(a.z[0], b.z[0]) + Math.min(a.z[1], b.z[1])) / 2;
      if ((a.role === "loft" || b.role === "loft") && decks.some((d) => within(d, mx, mz))) continue;
      found.push(`${a.role}/${b.role} ${g.toFixed(2)} m`);
    }
  assert.deepEqual(found, []);
  for (const p of POSTS) assert.ok(close(size(p.x), POST) && close(size(p.z), POST) && POST >= 0.6);
  assert.equal(POSTS.length, 4, "only the void's corners stand on posts");
});

// ─── Physics world built from the data ──────────────────────────────────────

test("server-side world, local mode and a fresh world build the identical 61 static colliders", () => {
  const describe = (world: RAPIER.World) => {
    const out: string[] = [];
    world.forEachCollider((c) => {
      if (c.parent()) return;
      const t = c.translation();
      out.push(`${c.shape.type}|${t.x.toFixed(4)},${t.y.toFixed(4)},${t.z.toFixed(4)}|${c.friction()}`);
    });
    return out.sort();
  };
  const reference = createArenaWorld(map),
    local = new LocalRoundSimulation(() => 0.5, undefined, map, { explore: true }),
    physics = new PlaygroundPhysics(undefined, map);
  try {
    const expected = describe(reference);
    assert.equal(expected.length, 61);
    assert.deepEqual(describe(local.physics.world), expected);
    assert.deepEqual(describe(physics.world), expected);
  } finally {
    reference.free();
    local.dispose();
    physics.dispose();
  }
});

test("surface heights from raycasts: floor, void, decks, routes, landing, cover tops, rails", () =>
  withWorld((world) => {
    const at = surfaceIn(world);
    const mid = (r: Range) => (r[0] + r[1]) / 2;
    assert.ok(close(at(2.8, 2.8)!, 0, 1e-4), "hub floor under the void");
    for (const [id, d] of Object.entries(DECKS)) {
      const x = mid(d.x), z = mid(d.z);
      if (COVER.some((c) => c.y[0] >= U - 1e-9 && within(c, x, z, 0.5)) || RAILS.some((r) => within(r, x, z, 0.1))) continue;
      assert.ok(close(at(x, z)!, U, 1e-4), `${id} deck`);
    }
    assert.ok(close(at(mid(RAMP.x), mid(RAMP.z))!, 1.5, 1e-3), "ramp midpoint");
    assert.ok(close(at(mid(STAIRS.x), mid(STAIRS.z))!, 1.5, 1e-3), "stairs midpoint");
    assert.ok(close(at(mid(EAST_LANDING.x), mid(EAST_LANDING.z))!, U, 1e-4), "landing");
    for (let i = 1; i <= STEPS.count; i++) {
      const s = stepColumn(i);
      assert.ok(close(at(mid(s.x), mid(s.z))!, 0.6 * i, 1e-4), `step ${i}`);
    }
    // Cast from just above each piece (some stand under a deck); the pile's middle is its top tier.
    for (const c of COVER) {
      const top = c.id === "H1" ? 2.4 : c.y[1];
      assert.ok(close(at(mid(c.x), mid(c.z), top + 0.3)!, top, 1e-4), `${c.id} top`);
    }
    for (const b of BARRELS) assert.ok(close(at(b.x, b.z)!, 1.02, 1e-3), `${b.id} top`);
    for (const r of RAILS) assert.ok(close(at(mid(r.x), mid(r.z))!, U + RAIL_HEIGHT, 1e-4), "rail top");
    // Under a deck, the ground floor is still the floor.
    assert.ok(close(at(3.25, -8, 2.7)!, 0, 1e-4) && close(at(3.25, -8)!, U, 1e-4), "north catwalk over its aisle");
  }));

// ─── Traversal with the real ragdoll (no character physics changes) ─────────

test("routes are walked up without jumping: west ramp, south stairs, east hay steps", () => {
  const cases = [
    { name: "west ramp", start: { x: RAMP.x[0] - 1.2, y: 0, z: 3.4 }, dir: { x: 1, z: 0 }, seconds: 2.6, onTop: (b: Point) => b.x > -HUB_HALF + 0.2 },
    { name: "south stairs", start: { x: 3.25, y: 0, z: STAIRS.z[1] + 1.2 }, dir: { x: 0, z: -1 }, seconds: 2.6, onTop: (b: Point) => b.z < HUB_HALF + 0.3 },
    { name: "east hay steps", start: { x: stepColumn(1).x[1] + 1.6, y: 0, z: -3.4 }, dir: { x: -1, z: 0 }, seconds: 3.6, onTop: (b: Point) => b.x < EAST_LANDING.x[1] + 0.3 },
  ];
  for (const c of cases)
    withBarn((p) => {
      solo(p);
      restore(p.players[0], { x: c.start.x, y: 0.8, z: c.start.z }, facing(c.dir.x, c.dir.z));
      run(p, 0.5);
      let highest = 0;
      for (let i = 0; i < c.seconds * 60 && !(pelvis(p).y > U + 0.5 && c.onTop(pelvis(p))); i++) {
        p.step([{ ...c.dir, jump: false }, IDLE_INPUT, IDLE_INPUT]);
        highest = Math.max(highest, pelvis(p).y);
      }
      run(p, 0.6);
      const b = pelvis(p);
      assert.ok(highest > U + 0.45, `${c.name}: reached ${highest.toFixed(2)}`);
      assert.ok(b.y > U + 0.5 && c.onTop(b), `${c.name}: ends on the upper floor (${b.x.toFixed(2)}, ${b.y.toFixed(2)}, ${b.z.toFixed(2)})`);
      assert.ok(uprightness(p) > 0.7 && !p.players[0].eliminated, c.name);
    });
});

test("drops: walking off every marked drop lands upright on the ground floor", () => {
  for (const d of DROPS)
    withBarn((p) => {
      solo(p);
      const mid = { x: (d.edge.x[0] + d.edge.x[1]) / 2, z: (d.edge.z[0] + d.edge.z[1]) / 2 };
      restore(p.players[0], { x: mid.x - d.out.x * 1.2, y: U + 0.8, z: mid.z - d.out.z * 1.2 }, facing(d.out.x, d.out.z));
      run(p, 0.5);
      // Walk until the pelvis is past the edge, then let go.
      const past = () => (pelvis(p).x - mid.x) * d.out.x + (pelvis(p).z - mid.z) * d.out.z;
      for (let i = 0; i < 120 && past() < 0.5; i++) p.step([{ ...d.out, jump: false }, IDLE_INPUT, IDLE_INPUT]);
      run(p, 2);
      const b = pelvis(p);
      assert.equal(p.players[0].eliminated, false, d.id);
      assert.ok(b.y < 1.5, `${d.id} (${d.label}): came down (pelvis ${b.y.toFixed(2)})`);
      assert.ok(p.isGrounded(0) && uprightness(p) > 0.75, `${d.id}: standing afterwards (${uprightness(p).toFixed(2)})`);
    });
});

test("rails: walking into one (straight and angled) never goes over", () => {
  const cases = [
    { at: { x: -4.05, z: -1.75 }, into: { x: 1, z: 0 } }, // void, west side
    { at: { x: 4.05, z: 1.75 }, into: { x: -1, z: 0 } }, // void, east side
    { at: { x: -2.65, z: -14.05 }, into: { x: 0, z: 1 } }, // hayloft front
    { at: { x: 2.05, z: -8.35 }, into: { x: -1, z: 0 } }, // north catwalk
  ];
  for (const c of cases)
    for (const angle of [0, 25, -25])
      withBarn((p) => {
        solo(p);
        const a = (angle * Math.PI) / 180;
        const dir = { x: c.into.x * Math.cos(a) - c.into.z * Math.sin(a), z: c.into.x * Math.sin(a) + c.into.z * Math.cos(a) };
        walk(p, { x: c.at.x - c.into.x * 1.3, y: U, z: c.at.z - c.into.z * 1.3 }, dir, 1.8);
        const b = pelvis(p);
        assert.ok(b.y > U + 0.5, `went over the rail at ${c.at.x},${c.at.z} (${angle}°)`);
      });
});

test("walls and full cover: jump-spam never climbs the outer walls (ground or upper floor), the pile, the towers or the stacks", () => {
  type P = { x: number; y: number; z: number };
  const cx = (c: { x: Range }) => (c.x[0] + c.x[1]) / 2,
    cz = (c: { z: Range }) => (c.z[0] + c.z[1]) / 2;
  const n2 = cover("N2"), n1 = cover("N1"), s2 = cover("S2"), e3 = cover("E3");
  const cases = [
    { name: "north end wall from the hayloft", start: { x: 1, y: U, z: -16.2 }, dir: { x: 0.2, z: -1 }, ok: (b: P) => b.z > -OUTER },
    { name: "east catwalk's wall", start: { x: 15.5, y: U, z: 3.4 }, dir: { x: 0.2, z: 1 }, ok: (b: P) => b.z < WING_HALF },
    { name: "hub shoulder from the ring", start: { x: 5.5, y: U, z: -5.6 }, dir: { x: 0.3, z: -1 }, ok: (b: P) => b.z > -HUB_HALF },
    { name: "south end wall (doors)", start: { x: -1, y: 0, z: 16.4 }, dir: { x: 0, z: 1 }, ok: (b: P) => b.z < OUTER },
    { name: "west end wall", start: { x: -16.2, y: 0, z: 1.4 }, dir: { x: -1, z: -0.2 }, ok: (b: P) => b.x > -OUTER },
    { name: "central pile (1.6 m tier)", start: { x: 3.1, y: 0, z: 0.2 }, dir: { x: -1, z: 0 }, ok: (b: P) => b.y < 1.6 },
    { name: "north bale tower (2.4 m)", start: { x: cx(n2), y: 0, z: n2.z[1] + 1.3 }, dir: { x: 0, z: -1 }, ok: (b: P) => b.y < 2.4 },
    { name: "north mouth crates (2.06 m)", start: { x: cx(n1) + 0.3, y: 0, z: n1.z[1] + 1.3 }, dir: { x: -0.2, z: -1 }, ok: (b: P) => b.y < 2.06 },
    { name: "entrance crates (2.06 m)", start: { x: s2.x[1] + 1.3, y: 0, z: cz(s2) }, dir: { x: -1, z: 0.1 }, ok: (b: P) => b.y < 2.06 },
    { name: "east crates (2.06 m)", start: { x: cx(e3), y: 0, z: e3.z[1] + 1.3 }, dir: { x: 0.1, z: -1 }, ok: (b: P) => b.y < 2.06 },
  ];
  for (const c of cases)
    withBarn((p) => {
      solo(p);
      const highest = walk(p, c.start, c.dir, 5, true);
      const b = pelvis(p);
      assert.ok(c.ok(b), `${c.name}: ended at ${b.x.toFixed(2)},${b.y.toFixed(2)},${b.z.toFixed(2)}`);
      assert.ok(highest < c.start.y + 2.3, `${c.name}: pelvis peaked at ${highest.toFixed(2)}`);
      assert.equal(p.players[0].eliminated, false);
    });
});

test("hop-over: a barrel stops a walk but a running jump clears it", () => {
  const b = BARRELS.find((b) => b.id === "B1")!;
  withBarn((p) => {
    solo(p);
    walk(p, { x: b.x - 1.7, y: 0, z: b.z }, { x: 1, z: 0 }, 2);
    assert.ok(pelvis(p).x < b.x - 0.3, "walking is stopped at the barrel");
  });
  withBarn((p) => {
    solo(p);
    restore(p.players[0], { x: b.x - 2.75, y: 0.8, z: b.z }, facing(1, 0));
    run(p, 0.5);
    run(p, 2, (t) => ({ x: 1, z: 0, jump: t > 0.28 }));
    assert.ok(pelvis(p).x > b.x + 0.5, `a running jump clears the barrel (x ${pelvis(p).x.toFixed(2)})`);
    assert.equal(p.players[0].eliminated, false);
  });
});

test("traversal: wing to wing takes ≥ 6 s with the real character (the 23 m barn's longest run was ~4.3 s); upstairs spans three wings", () => {
  const timed = (points: { x: number; z: number; y?: number }[]) => {
    let t: number | null = null;
    withBarn((p) => {
      solo(p);
      t = follow(p, points);
      assert.ok(uprightness(p) > 0.7 && !p.players[0].eliminated);
    });
    return t as number | null;
  };
  const northSouth = timed([{ x: 0.5, z: -15.5 }, { x: 0.8, z: -10 }, { x: 2.9, z: -3 }, { x: 2.9, z: 3 }, { x: 0.8, z: 8 }, { x: 0.8, z: 15.5 }]);
  const eastWest = timed([{ x: 15.5, z: 0.4 }, { x: 8.5, z: 0.4 }, { x: 3, z: 2.9 }, { x: -3, z: 2.9 }, { x: -8.2, z: 0.3 }, { x: -15.5, z: -0.5 }]);
  const upstairs = timed([{ x: -5.25, y: U, z: 2.5 }, { x: -5.25, y: U, z: -5.25 }, { x: 5.25, y: U, z: -5.25 }, { x: 5.25, y: U, z: 3.25 }, { x: 15.5, y: U, z: 3.25 }]);
  for (const [name, t, min] of [["north ↔ south", northSouth, 6], ["east ↔ west", eastWest, 6], ["ring west → east catwalk end", upstairs, 6]] as const)
    assert.ok(t !== null && t >= min && t < min * 1.6, `${name}: ${t === null ? "did not arrive" : `${t.toFixed(2)} s`}`);
});

// ─── Sightlines ─────────────────────────────────────────────────────────────

test("sightlines: deep in a wing you see the hub, little of the opposite wing and nothing of the side wings; no spot sees most of the barn", () =>
  withWorld((world) => {
    const at = surfaceIn(world);
    const pts: { x: number; y: number; z: number; zone: string }[] = [];
    for (let x = -OUTER + 0.75; x < OUTER; x += 1.5)
      for (let z = -OUTER + 0.75; z < OUTER; z += 1.5) {
        if (!insideBarn(x, z) || Math.abs(at(x, z, 2.7) ?? 9) > 1e-3 || clearance({ x, z }, 0) < 0.45) continue;
        const zone = Object.entries(ZONES).find(([, r]) => within(r, x, z))?.[0] ?? "mouth";
        pts.push({ x, y: 0, z, zone });
      }
    const zone = (id: string) => pts.filter((p) => p.zone === id);
    const vis = (A: typeof pts, B: typeof pts) => {
      let open = 0, n = 0;
      for (const a of A) for (const b of B) if (a !== b) (n++, sees(world, a, b) && open++);
      return open / n;
    };
    const wings = ["N", "S", "E", "W"] as const;
    const opposite = { N: "S", S: "N", E: "W", W: "E" } as const;
    for (const w of wings) {
      assert.ok(vis(zone(w), zone("HUB")) > 0.25, `${w} sees the hub`);
      assert.ok(vis(zone(w), zone(opposite[w])) < 0.1, `${w} → ${opposite[w]} ${(vis(zone(w), zone(opposite[w])) * 100).toFixed(0)}%`);
      for (const side of wings.filter((o) => o !== w && o !== opposite[w])) assert.ok(vis(zone(w), zone(side)) < 0.1, `${w} → ${side}`);
    }
    // No point on the ground floor sees most of it (the 23 m barn: mean 61%, best spot 80%).
    let sum = 0, max = 0;
    for (const a of pts) {
      const v = vis([a], pts);
      sum += v;
      max = Math.max(max, v);
    }
    assert.ok(sum / pts.length < 0.48 && max < 0.72, `mean ${((sum / pts.length) * 100).toFixed(0)}%, best spot ${(max * 100).toFixed(0)}%`);
    // Nobody deep in a wing clearly sees two other wings.
    for (const w of wings)
      for (const a of zone(w)) {
        const clear = wings.filter((o) => o !== w && vis([a], zone(o)) >= 0.25).length;
        assert.ok(clear <= 1, `${a.x},${a.z} sees ${clear} other wings`);
      }
    // Upstairs is exposed: at its inner edge each ring side is seen from about half the hub floor or more.
    for (const edge of [{ x: 0, z: -4.3 }, { x: -4.3, z: 0 }, { x: 4.3, z: 0 }])
      assert.ok(vis([{ ...edge, y: U, zone: "up" }], zone("HUB")) > 0.45, `ring edge at ${edge.x},${edge.z} is exposed to the hub floor`);
  }));

// ─── Spawns, weapons, traps ─────────────────────────────────────────────────

test("spawns: six candidates on real floors across all four wings, ≥ 8 m apart; the three start spawns hide from each other, ≥ 15 m apart", () =>
  withWorld((world) => {
    const at = surfaceIn(world);
    const spawns = Object.entries(SPAWN_CANDIDATES);
    assert.equal(spawns.length, 6);
    const upper = spawns.filter(([, s]) => s.y === U).length;
    assert.ok(upper >= 2 && upper <= 3, `${upper} upper-floor spawns`);
    const regions = new Set(spawns.map(([, s]) => (Object.entries(WINGS).find(([, r]) => within(r, s.x, s.z) && !within(HUB, s.x, s.z))?.[0] ?? "HUB")));
    for (const w of ["N", "S", "E", "W"]) assert.ok(regions.has(w), `a spawn in the ${w} wing`);
    for (const [id, s] of spawns) {
      assert.ok(close(at(s.x, s.z, s.y + 0.5)!, s.y, 1e-4), `${id} stands on its floor`);
      assert.ok(Number.isFinite(s.yaw), `${id} has an explicit yaw`);
      if (s.y === 0) assert.ok(!within(HUB, s.x, s.z), `${id} is not on the hub floor`);
      assert.ok(clearance(s, s.y) >= (s.y ? 1.1 : 1.5), `${id} clearance ${clearance(s, s.y).toFixed(2)} m`);
    }
    let visible = 0;
    for (let i = 0; i < spawns.length; i++)
      for (let j = i + 1; j < spawns.length; j++) {
        const [a, pa] = spawns[i],
          [b, pb] = spawns[j];
        assert.ok(spacing(pa, pb) >= 8, `${a}–${b} ${spacing(pa, pb).toFixed(2)} m`);
        if (sees(world, pa, pb)) {
          visible++;
          assert.ok(pa.y === U && pb.y === U, `${a} and ${b} see each other from the ground`);
        }
      }
    assert.ok(visible <= 2, `${visible} spawn pairs in sight`);
    assert.deepEqual([...START_SPAWNS], ["S1", "S2", "S3"]);
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++) {
        const a = SPAWN_CANDIDATES[START_SPAWNS[i]], b = SPAWN_CANDIDATES[START_SPAWNS[j]];
        assert.ok(!sees(world, a, b) && spacing(a, b) >= 15, `start spawns ${i} and ${j}`);
      }
    map.spawns.forEach((spawn, slot) => {
      const s = SPAWN_CANDIDATES[START_SPAWNS[slot]];
      assert.deepEqual(spawn, { x: s.x, y: s.y + 1.6, z: s.z });
      assert.equal(spawnYaw(map, slot), s.yaw);
    });
  }));

test("spawns leave the chase camera room at their own yaw: ≥ 3.5 m of boom, no crane; ground spawns look toward the hub", () => {
  const blockers = barnCameraBlockers(map);
  for (const [id, s] of Object.entries(SPAWN_CANDIDATES)) {
    const pivot = { x: s.x, y: s.y + 0.78 + BARN_CAMERA.pivotHeight, z: s.z };
    for (const pitch of [BARN_CAMERA.restPitch, 0]) {
      const rig = updateChaseCamera(blockers, pivot, s.yaw, pitch, null, 1 / 60);
      assert.ok(rig.boom >= 3.5, `${id} boom ${rig.boom.toFixed(2)} m at pitch ${pitch.toFixed(2)}`);
      assert.equal(rig.lift, 0, `${id} needs no crane`);
    }
    if (s.y === 0) {
      const toHub = Math.atan2(-s.x, -s.z);
      assert.ok(Math.abs(Math.atan2(Math.sin(s.yaw - toHub), Math.cos(s.yaw - toHub))) <= Math.PI / 4 + 1e-9, `${id} faces the hub`);
    }
  }
});

test("spawn facing: the map's yaws reach reset and the local respawn; rooftop still faces the origin", () => {
  for (let slot = 0; slot < 3; slot++) {
    const s = ROOFTOP_MAP.spawns[slot];
    assert.equal(spawnYaw(ROOFTOP_MAP, slot), Math.atan2(-s.x, -s.z));
  }
  withBarn((p) => {
    p.reset();
    for (const c of p.players) assert.ok(close(c.facing, SPAWN_CANDIDATES[START_SPAWNS[c.id]].yaw, 1e-9), `slot ${c.id} faces its spawn yaw`);
  });
  const local = new LocalRoundSimulation(() => 0.5, undefined, map, { explore: true });
  try {
    for (let i = 0; i < 60 * 3.2; i++) local.step(IDLE_INPUT); // past the countdown
    restore(local.physics.players[2], { x: 0, y: RAGDOLL.fallY - 1, z: 0 }, 0);
    local.step(IDLE_INPUT);
    local.step(IDLE_INPUT);
    assert.ok(close(local.physics.players[2].facing, SPAWN_CANDIDATES.S3.yaw, 0.05), "respawned facing S3's yaw");
  } finally {
    local.dispose();
  }
});

test("weapons and traps: on walkable floors, one per wing plus the hub and two upstairs; spaced from spawns, traps and each other", () =>
  withWorld((world) => {
    const at = surfaceIn(world);
    const weapons = Object.entries(WEAPON_SPOTS),
      traps = Object.entries(TRAPS),
      spawns = Object.entries(SPAWN_CANDIDATES);
    assert.equal(weapons.length, 7);
    assert.equal(traps.length, 2);
    assert.equal(weapons.filter(([, w]) => w.y === U).length, 2, "two upstairs");
    const ground = weapons.filter(([, w]) => w.y === 0).map(([, w]) => w);
    for (const [id, r] of Object.entries(WINGS)) assert.ok(ground.some((w) => within(r, w.x, w.z) && !within(HUB, w.x, w.z)), `a weapon in the ${id} wing`);
    // The risky one: on the hub floor under the void, in view of all three ring sides.
    const w1 = WEAPON_SPOTS.W1;
    assert.ok(within(VOID, w1.x, w1.z), "W1 lies under the void");
    for (const edge of [{ x: 0, z: -4.3 }, { x: -4.3, z: 1.5 }, { x: 4.3, z: 1.5 }]) assert.ok(sees(world, { ...edge, y: U }, w1, 1.4), `W1 is exposed to the ring's edge at ${edge.x},${edge.z}`);
    for (const [id, m] of [...weapons, ...traps]) {
      assert.ok(close(at(m.x, m.z, m.y + 0.5)!, m.y, 1e-4), `${id} lies on its floor`);
      assert.ok(clearance(m, m.y, 1.5) >= 1.2, `${id} clearance ${clearance(m, m.y, 1.5).toFixed(2)}`);
    }
    for (const [sid, s] of spawns) {
      for (const [wid, w] of weapons) assert.ok(spacing(s, w) >= 4.5, `${sid}–${wid} ${spacing(s, w).toFixed(2)} m`);
      for (const [tid, t] of traps) assert.ok(spacing(s, t) >= 4.5, `${sid}–${tid} ${spacing(s, t).toFixed(2)} m`);
    }
    for (const [wid, w] of weapons) {
      for (const [tid, t] of traps) assert.ok(spacing(w, t) >= 2.9, `${wid}–${tid} ${spacing(w, t).toFixed(2)} m`);
      for (const [oid, o] of weapons) if (oid !== wid) assert.ok(spacing(w, o) >= 6, `${wid}–${oid} ${spacing(w, o).toFixed(2)} m`);
    }
    // Traps: on the ground, off every route up (≥ 4 m from its foot), outside every drop's landing strip, off the hub.
    const feet = [{ x: RAMP.x[0], z: 3.4 }, { x: 3.25, z: STAIRS.z[1] }, { x: stepColumn(1).x[1], z: -3.4 }];
    for (const [id, t] of traps) {
      assert.equal(t.y, 0, id);
      assert.ok(!within(HUB, t.x, t.z), `${id} is off the hub`);
      for (const f of feet) assert.ok(Math.hypot(t.x - f.x, t.z - f.z) >= 4, `${id} near a route's foot`);
      for (const d of DROPS) {
        const lx = [d.edge.x[0] + d.out.x * 1.5, d.edge.x[1] + d.out.x * 1.5], lz = [d.edge.z[0] + d.out.z * 1.5, d.edge.z[1] + d.out.z * 1.5];
        const mx = Math.max(lx[0], Math.min(lx[1], t.x)), mz = Math.max(lz[0], Math.min(lz[1], t.z));
        assert.ok(Math.hypot(t.x - mx, t.z - mz) >= 1.2, `${id} is in ${d.id}'s landing`);
      }
    }
  }));

// ─── Local layout practice ──────────────────────────────────────────────────

test("idle characters stand on S1/S2/S3 (ground, ground, ring) facing their yaws; nobody falls or faults", () =>
  withBarn((p) => {
    p.reset();
    run(p, 3);
    for (const c of p.players) {
      const s = SPAWN_CANDIDATES[START_SPAWNS[c.id]];
      const b = c.body.translation();
      assert.equal(c.eliminated, false);
      assert.ok(p.isGrounded(c.id), `slot ${c.id} grounded`);
      assert.ok(Math.abs(b.y - (s.y + 0.78)) < 0.08, `slot ${c.id} pelvis ${b.y.toFixed(2)}`);
      assert.ok(Math.hypot(b.x - s.x, b.z - s.z) < 0.2, `slot ${c.id} stays put`);
    }
    assert.equal(p.diagnostics.invalidBodies, 0);
  }));

test("explore mode: dummies stand still, there is no timeout, and a fall-out respawns on the slot's spawn", () => {
  const local = new LocalRoundSimulation(() => 0.5, undefined, map, { explore: true });
  try {
    for (let i = 0; i < 60 * 3.2; i++) local.step(IDLE_INPUT);
    assert.equal(local.round.phase, "playing");
    for (let i = 0; i < 60 * 70; i++) local.step(i < 60 * 2 ? { x: -1, z: 0, jump: false } : IDLE_INPUT);
    assert.equal(local.round.phase, "playing", "no 60 s round limit while exploring");
    for (const id of [1, 2] as const) {
      const b = local.physics.players[id].body.translation(),
        s = map.spawns[id];
      assert.ok(Math.hypot(b.x - s.x, b.z - s.z) < 0.45, `dummy ${id} stays on its spawn (${Math.hypot(b.x - s.x, b.z - s.z).toFixed(2)} m)`);
      assert.ok(b.y > s.y - 1.2, `dummy ${id} stays on its floor`);
      const q = local.physics.players[id].parts.torso.body.rotation();
      assert.ok(1 - 2 * (q.x * q.x + q.z * q.z) > 0.85, `dummy ${id} stands upright`);
    }
    assert.ok(local.physics.players.every((c) => !c.eliminated));
    assert.equal(local.combat.stats.punches, 0, "no combat while exploring");
    restore(local.physics.players[0], { x: 0, y: RAGDOLL.fallY - 1, z: 0 }, 0);
    local.step(IDLE_INPUT);
    local.step(IDLE_INPUT);
    const b = local.physics.players[0].body.translation(),
      s = map.spawns[0];
    assert.equal(local.physics.players[0].eliminated, false);
    assert.ok(Math.hypot(b.x - s.x, b.z - s.z) < 0.1 && b.y > 0.5, "put back on S1");
    for (const name of PARTS) {
      const t = local.physics.players[0].parts[name].body.translation();
      assert.ok(Number.isFinite(t.x + t.y + t.z));
    }
    assert.equal(local.physics.diagnostics.invalidBodies, 0);
  } finally {
    local.dispose();
  }
});

// ─── Third-person camera and aim-driven movement ────────────────────────────

/** Pure framing: camera and projection for a pelvis, without collision. */
function frame(pelvisAt: Point, yaw: number, pitch: number, aspect = 16 / 10) {
  const pivot = { x: pelvisAt.x, y: pelvisAt.y + BARN_CAMERA.pivotHeight, z: pelvisAt.z };
  const rig = updateChaseCamera([], pivot, yaw, pitch, null, 1 / 60);
  const camera = new PerspectiveCamera(BARN_CAMERA.fov, aspect, 0.05, 200);
  camera.position.set(rig.position.x, rig.position.y, rig.position.z);
  camera.lookAt(rig.position.x + rig.look.x, rig.position.y + rig.look.y, rig.position.z + rig.look.z);
  camera.updateMatrixWorld();
  const project = (dx: number, dy: number, dz = 0) => {
    const r = cameraRight(yaw);
    return new Vector3(pelvisAt.x + r.x * dx, pelvisAt.y + dy, pelvisAt.z + r.z * dx + dz).project(camera);
  };
  return { rig, camera, project };
}
const FEET = -0.74,
  HEAD_TOP = 1.2,
  ARM = 0.6;

test("chase camera framing: ~4 m behind, ~1.8 m above the pelvis, right shoulder, 65° FOV, full body in the lower screen", () => {
  assert.equal(BARN_CAMERA.fov, 65);
  assert.ok(close(BARN_CAMERA.distance, 4.2) && close(BARN_CAMERA.shoulder, 0.45));
  assert.ok(close(BARN_CAMERA.minPitch, (-30 * Math.PI) / 180) && close(BARN_CAMERA.maxPitch, (35 * Math.PI) / 180));
  const pelvisAt = { x: 1, y: 0.78, z: 2 };
  for (const yaw of [0, 1, 2.5, -2]) {
    const { rig, project } = frame(pelvisAt, yaw, BARN_CAMERA.restPitch);
    const forward = { x: Math.sin(yaw), z: Math.cos(yaw) };
    const behind = -((rig.position.x - pelvisAt.x) * forward.x + (rig.position.z - pelvisAt.z) * forward.z);
    const side = (rig.position.x - pelvisAt.x) * cameraRight(yaw).x + (rig.position.z - pelvisAt.z) * cameraRight(yaw).z;
    const above = rig.position.y - pelvisAt.y;
    assert.ok(behind >= 3.5 && behind <= 5, `behind ${behind.toFixed(2)}`);
    assert.ok(above >= 1.2 && above <= 2, `above ${above.toFixed(2)}`);
    assert.ok(close(side, BARN_CAMERA.shoulder, 1e-9), "right-shoulder offset");
    const feet = project(0, FEET), head = project(0, HEAD_TOP), left = project(-ARM, 0.5), right = project(ARM, 0.5);
    for (const p of [feet, head, left, right]) assert.ok(Math.abs(p.x) < 0.95 && Math.abs(p.y) < 0.95, `on screen: ${p.x.toFixed(2)},${p.y.toFixed(2)}`);
    assert.ok(head.y < 0.15 && feet.y < -0.4, "occupies the lower screen");
    assert.ok((head.y - feet.y) / 2 > 0.3, `character is ${(((head.y - feet.y) / 2) * 100).toFixed(0)}% of the screen height`);
    assert.ok(project(0, 0.9).x < -0.05, "crosshair sits right of the character, not on it");
  }
});

test("pitch: −30° up to 35° down; looking up tilts without burying the camera, the body stays visible", () => {
  assert.equal(clampPitch(-2), BARN_CAMERA.minPitch);
  assert.equal(clampPitch(2), BARN_CAMERA.maxPitch);
  const pelvisAt = { x: 0, y: 0.78, z: 0 };
  const up = frame(pelvisAt, 0.4, BARN_CAMERA.minPitch),
    down = frame(pelvisAt, 0.4, BARN_CAMERA.maxPitch);
  assert.ok(up.rig.position.y > 0.4 && up.rig.position.y < pelvisAt.y + BARN_CAMERA.pivotHeight, "looking up lowers the camera a little, never to the floor");
  assert.ok(up.rig.look.y > 0.45 && down.rig.look.y < -0.55);
  assert.ok(down.rig.position.y - pelvisAt.y > 3, "looking down lifts the camera (e.g. over a rail)");
  for (const { project } of [up, down]) {
    const pelvis = project(0, 0), head = project(0, HEAD_TOP);
    for (const p of [pelvis, head]) assert.ok(Math.abs(p.x) < 0.95 && Math.abs(p.y) < 0.98, `visible ${p.x.toFixed(2)},${p.y.toFixed(2)}`);
  }
});

test("movement is camera-relative: W forward, S back, A/D strafe, for any yaw", () => {
  for (const yaw of [0, Math.PI / 2, Math.PI, -2.2]) {
    const f = { x: Math.sin(yaw), z: Math.cos(yaw) }, r = cameraRight(yaw);
    const w = cameraRelativeMove(0, -1, yaw), s = cameraRelativeMove(0, 1, yaw), d = cameraRelativeMove(1, 0, yaw), a = cameraRelativeMove(-1, 0, yaw);
    assert.ok(close(w.x, f.x) && close(w.z, f.z) && close(s.x, -f.x) && close(s.z, -f.z));
    assert.ok(close(d.x, r.x) && close(d.z, r.z) && close(a.x, -r.x) && close(a.z, -r.z));
  }
  const w = cameraRelativeMove(0, -1, Math.PI), d = cameraRelativeMove(1, 0, Math.PI);
  assert.ok(close(w.x, 0) && close(w.z, -1) && close(d.x, 1) && close(d.z, 0));
});

/** Standable pelvis positions on the ground and upper floors, clear of every collider. */
function standable() {
  return withWorld((world) => {
    const at = surfaceIn(world);
    const out: Point[] = [];
    for (let x = -OUTER + 0.5; x < OUTER; x += 1)
      for (let z = -OUTER + 0.5; z < OUTER; z += 1) {
        if (!insideBarn(x, z)) continue;
        if (Math.abs(at(x, z, 2.7) ?? 9) < 1e-3 && clearance({ x, z }, 0, 2) >= 0.45) out.push({ x, y: 0.78, z });
        if (Math.abs((at(x, z, U + 0.5) ?? 9) - U) < 1e-3 && clearance({ x, z }, U, 2) >= 0.45) out.push({ x, y: U + 0.78, z });
      }
    return out;
  });
}
const insideConvex = (b: ReturnType<typeof barnCameraBlockers>[number], p: Point, slack = 0) =>
  b.planes.every(({ n, d }) => n.x * p.x + n.y * p.y + n.z * p.z <= d - slack);
/** Ceiling over a point: the wing's gable roof, or the hub's eave cap. */
const ceilingAt = (x: number, z: number) => {
  if (within(HUB, x, z)) return SHELL.hubEave;
  const across = Math.abs(x) <= WING_HALF && Math.abs(z) > HUB_HALF ? Math.abs(x) : Math.abs(z);
  return SHELL.wingEave + (SHELL.wingRidge - SHELL.wingEave) * (1 - across / WING_HALF);
};

test("camera collision sweep: never inside walls, decks, cover or roofs, never outside the barn; the boom is always clear", () => {
  const blockers = barnCameraBlockers(map);
  const points = standable();
  assert.ok(points.length > 520, `${points.length} standable points`);
  let cases = 0,
    tight = 0,
    underDeck = 0,
    underDeckTight = 0;
  for (const pelvisAt of points)
    for (let yaw = 0; yaw < Math.PI * 2 - 1e-9; yaw += Math.PI / 6)
      for (const pitch of [BARN_CAMERA.minPitch, 0, BARN_CAMERA.restPitch, BARN_CAMERA.maxPitch]) {
        const pivot = { x: pelvisAt.x, y: pelvisAt.y + BARN_CAMERA.pivotHeight, z: pelvisAt.z };
        const rig = updateChaseCamera(blockers, pivot, yaw, pitch, null, 1 / 60);
        const c = rig.position;
        cases++;
        if (rig.boom < 1.5) tight++;
        const covered = pelvisAt.y < 1 && Object.values(DECKS).some((d) => within(d, pelvisAt.x, pelvisAt.z));
        if (covered && pitch === BARN_CAMERA.maxPitch) (underDeck++, rig.boom < 1.5 && underDeckTight++);
        const where = `pelvis ${pelvisAt.x.toFixed(1)},${pelvisAt.y.toFixed(1)},${pelvisAt.z.toFixed(1)} yaw ${yaw.toFixed(2)} pitch ${pitch.toFixed(2)}`;
        for (const b of blockers) assert.ok(!insideConvex(b, c, -0.12), `camera within 12 cm of ${b.label}: ${where}`);
        assert.ok(insideBarn(c.x, c.z) && c.y > 0.1, `outside the barn: ${where}`);
        assert.ok(c.y < ceilingAt(c.x, c.z), `above the roof: ${where}`);
        assert.ok(castBlockers(blockers, rig.shoulder, rig.boomDir, rig.boom) >= rig.boom - 1e-6, `boom crosses geometry: ${where}`);
        const end = { x: c.x, y: c.y - rig.lift, z: c.z };
        assert.ok(castBlockers(blockers, end, { x: 0, y: 1, z: 0 }, rig.lift) >= rig.lift - 1e-6, `crane lift crosses geometry: ${where}`);
        assert.ok(!insideBlockers(blockers, c, BARN_CAMERA.collision.radius * 0.75 - 1e-9) || rig.boom === 0, `camera sphere clips geometry: ${where}`);
      }
  // Narrower spaces than the 23 m barn's (16.5% of cases under 1.5 m there); looking down under a
  // deck keeps the boom by lowering it (it used to collapse in ~90% of those cases).
  assert.ok(tight / cases < 0.25, `boom under 1.5 m in ${((tight / cases) * 100).toFixed(0)}% of cases`);
  assert.ok(underDeck > 300 && underDeckTight / underDeck < 0.35, `under a deck, looking down: ${((underDeckTight / underDeck) * 100).toFixed(0)}% squeezed`);
});

test("camera collision cases: backed against the doors, over the void from the ring, under a deck looking down, open floor", () => {
  const blockers = barnCameraBlockers(map);
  const rigAt = (pelvisAt: Point, yaw: number, pitch: number) =>
    updateChaseCamera(blockers, { x: pelvisAt.x, y: pelvisAt.y + BARN_CAMERA.pivotHeight, z: pelvisAt.z }, yaw, pitch, null, 1 / 60);
  // Backed against the south end wall, facing into the barn: the boom shortens, the body fades, the camera cranes up.
  const doors = rigAt({ x: -1, y: 0.78, z: OUTER - 0.7 }, Math.PI, BARN_CAMERA.restPitch);
  assert.ok(doors.position.z < OUTER - 0.1 && doors.boom < 1);
  assert.ok(ownCharacterOpacity(doors.boom) < 1 && doors.lift > 0.5);
  // On the ring's north side facing the void, looking down: the camera rises over the ring behind.
  const ring = rigAt({ x: 0, y: U + 0.78, z: -5.25 }, 0, BARN_CAMERA.maxPitch);
  assert.ok(ring.position.y > U + 2.5 && ring.look.y < -0.5 && ring.boom > 2);
  // Under the north catwalk, looking down: the ceiling lowers the boom (to a 10° rise, then it
  // shortens) instead of collapsing it — and the whole character stays on screen.
  const aislePelvis = { x: 3.25, y: 0.78, z: -11 };
  const aisle = rigAt(aislePelvis, Math.PI, BARN_CAMERA.maxPitch);
  const rise = Math.asin(aisle.boomDir.y);
  assert.ok(aisle.boom > 2.5 && aisle.position.y < U - DECK_THICKNESS - 0.2, `aisle boom ${aisle.boom.toFixed(2)} at ${aisle.position.y.toFixed(2)} m`);
  assert.ok(rise >= BARN_CAMERA.collision.ceilingRise - 1e-6 && rise < BARN_CAMERA.maxPitch - 0.2, `aisle boom rise ${((rise * 180) / Math.PI).toFixed(1)}°`);
  const view = new PerspectiveCamera(BARN_CAMERA.fov, 16 / 10, 0.05, 200);
  view.position.set(aisle.position.x, aisle.position.y, aisle.position.z);
  view.lookAt(aisle.position.x + aisle.look.x, aisle.position.y + aisle.look.y, aisle.position.z + aisle.look.z);
  view.updateMatrixWorld();
  for (const dy of [FEET, 0, HEAD_TOP]) {
    const p = new Vector3(aislePelvis.x, aislePelvis.y + dy, aislePelvis.z).project(view);
    assert.ok(Math.abs(p.y) < 0.95 && Math.abs(p.x) < 0.95, `under the catwalk the body stays on screen (${dy}: ${p.x.toFixed(2)},${p.y.toFixed(2)})`);
  }
  // The same yaw and pitch in the open keeps the full, steep boom.
  const open = rigAt({ x: -1, y: 0.78, z: 10 }, Math.PI, BARN_CAMERA.maxPitch);
  assert.ok(close(open.boom, BARN_CAMERA.distance) && open.position.y > 3.5 && open.lift === 0);
  // Upstairs by a wing's side wall looking down: stays under the gable roof.
  const eaves = rigAt({ x: 3.25, y: U + 0.78, z: -12 }, -Math.PI / 2, BARN_CAMERA.maxPitch);
  assert.ok(eaves.position.y < ceilingAt(eaves.position.x, eaves.position.z));
});

test("camera boom: pulls in immediately, eases back out over ~a second (no snapping)", () => {
  const blockers = barnCameraBlockers(map);
  const pivot = { x: -1, y: 0.78 + BARN_CAMERA.pivotHeight, z: 11 };
  const pulled = updateChaseCamera(blockers, pivot, Math.PI, BARN_CAMERA.restPitch, 1, 1 / 60);
  assert.ok(pulled.boom > 1 && pulled.boom < 1.3, `first frame ${pulled.boom.toFixed(2)}`);
  let boom = 1;
  for (let i = 0; i < 90; i++) boom = updateChaseCamera(blockers, pivot, Math.PI, BARN_CAMERA.restPitch, boom, 1 / 60).boom;
  assert.ok(boom > 4, `after 1.5 s ${boom.toFixed(2)}`);
  const blocked = { x: -1, y: 0.78 + BARN_CAMERA.pivotHeight, z: OUTER - 0.7 };
  const snapIn = updateChaseCamera(blockers, blocked, Math.PI, BARN_CAMERA.restPitch, BARN_CAMERA.distance, 1 / 60);
  assert.equal(snapIn.boom, snapIn.desiredBoom, "never lags behind an obstruction");
  assert.ok(ownCharacterOpacity(BARN_CAMERA.distance) === 1 && ownCharacterOpacity(0) === BARN_CAMERA.fade.minOpacity);
});

/** A flat 40 × 40 m floor for aim-driven movement checks. */
const FLAT = {
  ...map,
  colliders: [{ role: "floor" as const, shape: "box" as const, center: { x: 0, y: -0.5, z: 0 }, half: { x: 20, y: 0.5, z: 20 } }],
  spawns: [{ x: 0, y: 1.6, z: 0 }, { x: 10, y: 1.6, z: 10 }, { x: -10, y: 1.6, z: 10 }] as typeof map.spawns,
  spawnYaws: undefined,
};

test("aim-driven facing: strafe and backpedal keep facing the aim at full speed", () => {
  for (const [label, axis, expected] of [
    ["strafe right", { x: 1, z: 0 }, (yaw: number) => cameraRight(yaw)],
    ["backpedal", { x: 0, z: 1 }, (yaw: number) => ({ x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) })],
  ] as const)
    for (const yaw of [0, 2.2]) {
      const p = new PlaygroundPhysics(undefined, FLAT);
      try {
        solo(p);
        restore(p.players[0], { x: 0, y: 0.8, z: 0 }, yaw);
        run(p, 0.5, () => ({ x: 0, z: 0, jump: false, facing: yaw }));
        const start = { ...pelvis(p) };
        run(p, 1.5, () => ({ ...cameraRelativeMove(axis.x, axis.z, yaw), jump: false, facing: yaw }));
        const b = pelvis(p), e = expected(yaw);
        const along = (b.x - start.x) * e.x + (b.z - start.z) * e.z,
          across = Math.abs((b.x - start.x) * -e.z + (b.z - start.z) * e.x);
        assert.ok(along > 5, `${label} at ${yaw}: moved ${along.toFixed(2)} m`);
        assert.ok(across < 0.6, `${label} drifted ${across.toFixed(2)} m sideways`);
        const f = p.players[0].facing;
        assert.ok(Math.abs(Math.atan2(Math.sin(f - yaw), Math.cos(f - yaw))) < 0.05, `${label}: body keeps facing the aim`);
        assert.ok(uprightness(p) > 0.8);
      } finally {
        p.dispose();
      }
    }
});

test("aim-driven facing: turning faster than the body can follow while circling never topples or faults", () => {
  const p = new PlaygroundPhysics(undefined, FLAT);
  try {
    solo(p);
    restore(p.players[0], { x: 0, y: 0.8, z: 0 }, 0);
    let lowest = 1,
      yaw = 0;
    for (let i = 0; i < 60 * 6; i++) {
      yaw += (i < 180 ? 9 : -14) / 60; // faster than RAGDOLL.aimTurnSpeed
      const t = i / 60;
      p.step([{ ...cameraRelativeMove(Math.cos(t * 2), -Math.sin(t * 2), yaw), jump: i % 90 === 0, facing: yaw }, IDLE_INPUT, IDLE_INPUT]);
      lowest = Math.min(lowest, uprightness(p));
    }
    assert.ok(lowest > 0.7, `lowest uprightness ${lowest.toFixed(2)}`);
    assert.equal(p.players[0].eliminated, false);
    assert.equal(p.diagnostics.invalidBodies, 0);
  } finally {
    p.dispose();
  }
});

test("barn walk with the chase camera: up the west ramp facing the hub, along the ring, off the void's open north-east corner", () =>
  withBarn((p) => {
    solo(p);
    const east = Math.PI / 2;
    restore(p.players[0], { x: RAMP.x[0] - 1.2, y: 0.8, z: 3.4 }, east);
    run(p, 0.4, () => ({ x: 0, z: 0, jump: false, facing: east }));
    for (let i = 0; i < 60 * 3 && !(pelvis(p).y > U + 0.5 && pelvis(p).x > -6); i++)
      p.step([{ ...cameraRelativeMove(0, -1, east), jump: false, facing: east }, IDLE_INPUT, IDLE_INPUT]);
    run(p, 0.3, () => ({ x: 0, z: 0, jump: false, facing: east }));
    assert.ok(pelvis(p).y > U + 0.5, `on the ring (${pelvis(p).x.toFixed(2)}, ${pelvis(p).y.toFixed(2)})`);
    // Aim north (yaw π) and walk forward along the ring's west side, then strafe right (east) along its north side.
    for (let i = 0; i < 60 * 4 && pelvis(p).z > -5.1; i++)
      p.step([{ ...cameraRelativeMove(Math.max(-1, Math.min(1, (-5.25 - pelvis(p).x) * 2)), -1, Math.PI), jump: false, facing: Math.PI }, IDLE_INPUT, IDLE_INPUT]);
    // Now face the void (yaw 0) and strafe left (+x here) along the rail to the open east end, then walk off forward.
    for (let i = 0; i < 60 * 4 && pelvis(p).x < 2.7; i++) p.step([{ ...cameraRelativeMove(-1, 0, 0), jump: false, facing: 0 }, IDLE_INPUT, IDLE_INPUT]);
    assert.ok(pelvis(p).x > 2.2 && pelvis(p).x < 3.8 && pelvis(p).y > U + 0.5, `at the opening on the ring (${pelvis(p).x.toFixed(2)}, ${pelvis(p).z.toFixed(2)})`);
    run(p, 1.2, () => ({ ...cameraRelativeMove(0, -1, 0), jump: false, facing: 0 }));
    run(p, 1.2, () => ({ x: 0, z: 0, jump: false, facing: 0 }));
    assert.ok(pelvis(p).y < 1.5 && pelvis(p).z > -4, `down in the hub (${pelvis(p).x.toFixed(2)},${pelvis(p).y.toFixed(2)},${pelvis(p).z.toFixed(2)})`);
    assert.equal(p.players[0].eliminated, false);
    assert.ok(uprightness(p) > 0.75);
  }));

// ─── Sprint (Lift binding, barn only) ──────────────────────────────────────

test("sprint: the barn reads the Lift binding (Shift) as sprint; actions and saved controls are unchanged", () => {
  assert.equal(ACTIONS.length, 8, "no new action: saved controls keep validating");
  assert.deepEqual(defaultBindings().lift, ["ShiftLeft", "ShiftRight"]);
  const input = new InputManager();
  input.setBindingDown("ShiftLeft", true);
  input.setBindingDown("KeyW", true);
  const raw = input.readIntent();
  assert.equal(raw.lift, true, "the device layer still reports Lift");
  const barn = barnIntent(raw, 1.1);
  assert.equal(barn.sprint, true);
  assert.equal(barn.lift, undefined, "the barn does not lift with Shift");
  assert.equal(barn.facing, 1.1);
  const forward = cameraRelativeMove(0, -1, 1.1);
  assert.ok(close(barn.x, forward.x) && close(barn.z, forward.z), "movement stays camera-relative");
  input.setBindingDown("ShiftLeft", false);
  assert.equal(barnIntent(input.readIntent(), 1.1).sprint, false, "releasing Shift stops sprinting");
  // A saved custom Lift key sprints in the barn, through the unchanged storage format.
  const custom = deserializeControls(serializeControls(changeBinding(defaultBindings(), "lift", 0, "KeyQ")!));
  const rebound = new InputManager(custom);
  rebound.setBindingDown("KeyQ", true);
  assert.equal(barnIntent(rebound.readIntent(), 0).sprint, true);
});

/** Steady ground speed along `axis` (camera-relative, facing the aim) on the flat floor. */
function steadySpeed(axis: { x: number; z: number }, yaw: number, sprint: boolean) {
  const p = new PlaygroundPhysics(undefined, FLAT);
  try {
    solo(p);
    const dir = cameraRelativeMove(axis.x, axis.z, yaw);
    restore(p.players[0], { x: -dir.x * 14, y: 0.8, z: -dir.z * 14 }, yaw);
    run(p, 0.5, () => ({ x: 0, z: 0, jump: false, facing: yaw }));
    const input = () => ({ ...dir, jump: false, facing: yaw, sprint });
    run(p, 1, input);
    const a = { ...pelvis(p) };
    run(p, 1.5, input);
    const b = pelvis(p);
    assert.ok(uprightness(p) > 0.8 && p.players[0].sprint === (sprint ? 1 : 0));
    return ((b.x - a.x) * dir.x + (b.z - a.z) * dir.z) / 1.5;
  } finally {
    p.dispose();
  }
}

test("sprint: steady speed is ~1.4× walking — forward, strafing and backward; without Shift the walk is unchanged", () => {
  for (const [label, axis] of [
    ["forward", { x: 0, z: -1 }],
    ["strafe right", { x: 1, z: 0 }],
    ["strafe left", { x: -1, z: 0 }],
    ["backward", { x: 0, z: 1 }],
    ["diagonal", { x: Math.SQRT1_2, z: -Math.SQRT1_2 }],
  ] as const)
    for (const yaw of [0, 2.2]) {
      const walk = steadySpeed(axis, yaw, false),
        sprint = steadySpeed(axis, yaw, true);
      assert.ok(Math.abs(walk - RAGDOLL.speed) < 0.2, `${label} walk ${walk.toFixed(2)} m/s`);
      const ratio = sprint / walk;
      assert.ok(Math.abs(ratio - 1.4) < 0.03, `${label} at ${yaw}: sprint ${sprint.toFixed(2)} m/s = ${ratio.toFixed(3)}× walk`);
    }
});

test("sprint: Shift eases in and out over ~0.25 s — no jolt, upright, back to walking speed on release, rapid toggles safe", () => {
  const p = new PlaygroundPhysics(undefined, FLAT);
  try {
    solo(p);
    const yaw = 0.7,
      dir = cameraRelativeMove(0, -1, yaw);
    restore(p.players[0], { x: -dir.x * 15, y: 0.8, z: -dir.z * 15 }, yaw);
    run(p, 0.5, () => ({ x: 0, z: 0, jump: false, facing: yaw }));
    const speed = () => Math.hypot(p.players[0].body.linvel().x, p.players[0].body.linvel().z);
    /** Holds `sprint` for `seconds`; returns when the speed first came within 0.15 m/s of `target`, the largest speed change per second and the lowest uprightness. */
    const phase = (sprint: boolean, seconds: number, target: number) => {
      let reached = -1,
        jolt = 0,
        lowest = 1,
        before = speed();
      for (let i = 0; i < Math.round(seconds * 60); i++) {
        p.step([{ ...dir, jump: false, facing: yaw, sprint }, IDLE_INPUT, IDLE_INPUT]);
        const now = speed();
        jolt = Math.max(jolt, Math.abs(now - before) * 60);
        before = now;
        lowest = Math.min(lowest, uprightness(p));
        if (reached < 0 && Math.abs(now - target) < 0.15) reached = (i + 1) / 60;
      }
      return { reached, jolt, lowest };
    };
    phase(false, 1.2, RAGDOLL.speed);
    const sprintSpeed = RAGDOLL.speed * RAGDOLL.sprintMultiplier;
    const press = phase(true, 1.2, sprintSpeed);
    assert.ok(press.reached > 0.15 && press.reached < 0.35, `sprint speed after ${press.reached.toFixed(2)} s`);
    assert.ok(Math.abs(speed() - sprintSpeed) < 0.3, `sprinting at ${speed().toFixed(2)} m/s`);
    const release = phase(false, 1.2, RAGDOLL.speed);
    assert.ok(release.reached > 0.15 && release.reached < 0.35, `walking speed again after ${release.reached.toFixed(2)} s`);
    assert.ok(Math.abs(speed() - RAGDOLL.speed) < 0.3 && p.players[0].sprint === 0, `walking at ${speed().toFixed(2)} m/s`);
    // An instant switch would change speed at the full 25 m/s² drive (~30 m/s² measured).
    for (const [label, r] of [["press", press], ["release", release]] as const) {
      assert.ok(r.jolt < 12, `${label}: speed changed at most ${r.jolt.toFixed(1)} m/s²`);
      assert.ok(r.lowest > 0.85, `${label}: lowest uprightness ${r.lowest.toFixed(2)}`);
    }
    let lowest = 1;
    for (let i = 0; i < 60 * 3; i++) {
      p.step([{ ...dir, jump: false, facing: yaw, sprint: Math.floor(i / (6 + (i % 7))) % 2 === 0 }, IDLE_INPUT, IDLE_INPUT]);
      lowest = Math.min(lowest, uprightness(p));
    }
    assert.ok(lowest > 0.85, `rapid toggles: lowest uprightness ${lowest.toFixed(2)}`);
    assert.ok(p.isGrounded(0) && !p.players[0].eliminated && p.diagnostics.invalidBodies === 0);
    restore(p.players[0], { x: 0, y: 0.8, z: 0 }, 0);
    assert.equal(p.players[0].sprint, 0, "a respawn starts at walking pace");
  } finally {
    p.dispose();
  }
});

test("sprint in the barn: ramp, stairs and hay steps are run up; every drop lands upright; rails still stop a sprint", () => {
  const routes = [
    { name: "west ramp", start: { x: RAMP.x[0] - 1.2, z: 3.4 }, dir: { x: 1, z: 0 }, onTop: (b: Point) => b.x > -HUB_HALF + 0.2 },
    { name: "south stairs", start: { x: 3.25, z: STAIRS.z[1] + 1.2 }, dir: { x: 0, z: -1 }, onTop: (b: Point) => b.z < HUB_HALF + 0.3 },
    { name: "east hay steps", start: { x: stepColumn(1).x[1] + 1.6, z: -3.4 }, dir: { x: -1, z: 0 }, onTop: (b: Point) => b.x < EAST_LANDING.x[1] + 0.3 },
  ];
  for (const c of routes)
    withBarn((p) => {
      solo(p);
      restore(p.players[0], { x: c.start.x, y: 0.8, z: c.start.z }, facing(c.dir.x, c.dir.z));
      run(p, 0.5);
      for (let i = 0; i < 3.6 * 60 && !(pelvis(p).y > U + 0.5 && c.onTop(pelvis(p))); i++)
        p.step([{ ...c.dir, jump: false, sprint: true }, IDLE_INPUT, IDLE_INPUT]);
      run(p, 0.8);
      const b = pelvis(p);
      assert.ok(b.y > U + 0.5 && c.onTop(b), `${c.name}: sprinted onto the upper floor (${b.x.toFixed(2)}, ${b.y.toFixed(2)}, ${b.z.toFixed(2)})`);
      assert.ok(uprightness(p) > 0.8 && !p.players[0].eliminated, `${c.name}: upright (${uprightness(p).toFixed(2)})`);
    });
  for (const d of DROPS)
    withBarn((p) => {
      solo(p);
      const mid = { x: (d.edge.x[0] + d.edge.x[1]) / 2, z: (d.edge.z[0] + d.edge.z[1]) / 2 };
      restore(p.players[0], { x: mid.x - d.out.x * 1.6, y: U + 0.8, z: mid.z - d.out.z * 1.6 }, facing(d.out.x, d.out.z));
      run(p, 0.5);
      const past = () => (pelvis(p).x - mid.x) * d.out.x + (pelvis(p).z - mid.z) * d.out.z;
      for (let i = 0; i < 120 && past() < 0.5; i++) p.step([{ ...d.out, jump: false, sprint: true }, IDLE_INPUT, IDLE_INPUT]);
      const v = p.players[0].body.linvel();
      assert.ok(Math.hypot(v.x, v.z) > RAGDOLL.speed + 0.5, `${d.id}: off the edge at sprint speed (${Math.hypot(v.x, v.z).toFixed(2)} m/s)`);
      run(p, 2);
      const b = pelvis(p);
      assert.equal(p.players[0].eliminated, false, d.id);
      assert.ok(b.y < 1.5, `${d.id} (${d.label}): came down (pelvis ${b.y.toFixed(2)})`);
      assert.ok(p.isGrounded(0) && uprightness(p) > 0.75, `${d.id}: standing afterwards (${uprightness(p).toFixed(2)})`);
    });
  const rails = [
    { at: { x: -4.05, z: -1.75 }, into: { x: 1, z: 0 }, runUp: 2.3 }, // void, west side (across the ring)
    { at: { x: 4.05, z: 1.75 }, into: { x: -1, z: 0 }, runUp: 2.3 }, // void, east side
    { at: { x: -2.65, z: -14.05 }, into: { x: 0, z: 1 }, runUp: 3 }, // hayloft front
    { at: { x: 2.05, z: -8.35 }, into: { x: -1, z: 0 }, runUp: 2.3 }, // north catwalk
  ];
  for (const c of rails)
    for (const angle of [0, 25, -25])
      withBarn((p) => {
        solo(p);
        const a = (angle * Math.PI) / 180;
        const dir = { x: c.into.x * Math.cos(a) - c.into.z * Math.sin(a), z: c.into.x * Math.sin(a) + c.into.z * Math.cos(a) };
        restore(p.players[0], { x: c.at.x - c.into.x * c.runUp, y: U + 0.8, z: c.at.z - c.into.z * c.runUp }, facing(dir.x, dir.z));
        run(p, 0.5);
        run(p, 1.8, () => ({ ...dir, jump: false, sprint: true }));
        assert.ok(pelvis(p).y > U + 0.5, `sprinted over the rail at ${c.at.x},${c.at.z} (${angle}°)`);
      });
});

test("sprint traversal: wing to wing ≥ 1.3× faster, the cornering upper-floor route ≥ 1.12×, upright all the way", () => {
  const timed = (points: { x: number; z: number; y?: number }[], sprint: boolean) => {
    let t: number | null = null;
    withBarn((p) => {
      solo(p);
      const s = points[0];
      restore(p.players[0], { x: s.x, y: (s.y ?? 0) + 0.8, z: s.z }, facing(points[1].x - s.x, points[1].z - s.z));
      run(p, 0.5);
      let k = 1,
        lowest = 1;
      for (let i = 0; i < 20 * 60 && t === null; i++) {
        const b = pelvis(p), w = points[k];
        const dx = w.x - b.x, dz = w.z - b.z, d = Math.hypot(dx, dz);
        if (d < (k === points.length - 1 ? 0.5 : 0.8) && (w.y === undefined || Math.abs(b.y - 0.78 - w.y) < 0.5)) {
          if (++k === points.length) t = i / 60;
          continue;
        }
        p.step([{ x: dx / d, z: dz / d, jump: false, sprint }, IDLE_INPUT, IDLE_INPUT]);
        lowest = Math.min(lowest, uprightness(p));
      }
      assert.ok(lowest > 0.7 && !p.players[0].eliminated, `lowest uprightness ${lowest.toFixed(2)}`);
    });
    return t as number | null;
  };
  for (const [name, gain, points] of [
    ["north → south", 1.3, [{ x: 0.5, z: -15.5 }, { x: 0.8, z: -10 }, { x: 2.9, z: -3 }, { x: 2.9, z: 3 }, { x: 0.8, z: 8 }, { x: 0.8, z: 15.5 }]],
    ["east → west", 1.3, [{ x: 15.5, z: 0.4 }, { x: 8.5, z: 0.4 }, { x: 3, z: 2.9 }, { x: -3, z: 2.9 }, { x: -8.2, z: 0.3 }, { x: -15.5, z: -0.5 }]],
    ["ring west → east catwalk end", 1.12, [{ x: -5.25, y: U, z: 2.5 }, { x: -5.25, y: U, z: -5.25 }, { x: 5.25, y: U, z: -5.25 }, { x: 5.25, y: U, z: 3.25 }, { x: 15.5, y: U, z: 3.25 }]],
  ] as const) {
    const walk = timed([...points], false),
      sprint = timed([...points], true);
    assert.ok(walk !== null && sprint !== null, `${name}: walk ${walk} s, sprint ${sprint} s`);
    assert.ok(walk / sprint > gain, `${name}: sprint ${sprint.toFixed(2)} s vs walk ${walk.toFixed(2)} s (${(walk / sprint).toFixed(2)}×)`);
  }
});

// ─── Visual kit and scene ───────────────────────────────────────────────────

const KIT = path.resolve("public/party-lab/maps/barn/barn-kit.glb");
async function parseKit() {
  const data = fs.readFileSync(KIT);
  return new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), "");
}

test("barn-kit.glb: curated nodes (props and Big Barn's doors only), untextured opaque metalness-0 materials, < 300 KB", () => {
  const buffer = fs.readFileSync(KIT);
  const json = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString("utf8"));
  assert.ok(buffer.length < 300 * 1024, `${(buffer.length / 1024).toFixed(0)} KB`);
  assert.equal(buffer.readUInt32LE(0), 0x46546c67);
  assert.deepEqual(json.nodes.map((n: { name: string }) => n.name).sort(), [...BARN_KIT_NODES].sort());
  assert.ok(!json.images && !json.textures, "no textures");
  for (const m of json.materials) {
    assert.equal(m.pbrMetallicRoughness.metallicFactor, 0, m.name);
    assert.ok(!m.alphaMode || m.alphaMode === "OPAQUE", m.name);
  }
  for (const mesh of json.meshes)
    for (const primitive of mesh.primitives) assert.deepEqual(Object.keys(primitive.attributes).sort(), ["NORMAL", "POSITION"], mesh.name);
  const bounds = (name: string) => {
    const mesh = json.meshes[json.nodes.find((n: { name: string }) => n.name === name).mesh];
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const p of mesh.primitives) {
      const a = json.accessors[p.attributes.POSITION];
      a.min.forEach((v: number, i: number) => (min[i] = Math.min(min[i], v)));
      a.max.forEach((v: number, i: number) => (max[i] = Math.max(max[i], v)));
    }
    return max.map((v, i) => v - min[i]);
  };
  const doors = bounds("BarnDoors");
  assert.ok(Math.abs(doors[0] - DOORS.width) < 0.01 && Math.abs(doors[1] - DOORS.height) < 0.01 && Math.abs(doors[2] - DOORS.depth) < 0.01, `doors ${doors.map((v) => v.toFixed(2))}`);
  assert.ok(DOORS.width < 2 * WING_HALF, "the doors fit the south end wall");
  assert.ok(Math.abs(bounds("Crate")[1] - 1.03) < 1e-3 && Math.abs(bounds("HayBale")[1] - 0.8) < 1e-3);
});

test("barn scene builds: a generated shell, instances fill the shared cover, decoration only on cover tops, valid transforms", async () => {
  const gltf = await parseKit();
  const built = buildBarn(readBarnKit(gltf.scene));
  try {
    const count = (name: string) => {
      const mesh = built.group.getObjectByName(name) as unknown as { count?: number } | undefined;
      return mesh?.count ?? (mesh ? 1 : 0);
    };
    const bales = COVER.filter((c) => c.role === "hay").reduce((n, c) => n + Math.round(size(c.y) / BALE.height) * Math.round(Math.max(size(c.x), size(c.z)) / BALE.long) * Math.round(Math.min(size(c.x), size(c.z)) / BALE.short), 0);
    assert.equal(count("kit-HayBale"), bales + (1 + 2 + 3 + 4), "bales: every hay stack and the hay steps");
    assert.equal(count("kit-Crate"), COVER.filter((c) => c.role === "crate").reduce((n, c) => n + Math.round((size(c.x) * size(c.y) * size(c.z)) / CRATE ** 3), 0));
    assert.equal(count("kit-Barrel"), BARRELS.length);
    assert.equal(count("kit-Shotgun") + count("kit-Smg"), 7);
    assert.equal(count("kit-Pallet"), 7);
    assert.equal(count("kit-BearTrap"), 2);
    assert.ok(count("kit-Rail") >= RAILS.length);
    assert.ok(built.group.getObjectByName("barn-shell") && built.group.getObjectByName("barn-windows") && built.group.getObjectByName("kit-BarnDoors"));
    assert.ok(built.shellTriangles > 3000 && built.shellTriangles < 20000, `${built.shellTriangles} shell triangles`);
    // Rafters and tie beams sit above anything the camera reaches (7.3 m from the upper floor).
    assert.ok(RAFTERS.collarY - RAFTERS.size / 2 > U + 0.78 + BARN_CAMERA.pivotHeight + BARN_CAMERA.distance * Math.sin(BARN_CAMERA.maxPitch) + BARN_CAMERA.collision.radius);
    // Decoration stands on full cover only.
    const onTop = (id: string) => COVER.find((c) => c.id === id)!.y[1] >= 1.6;
    assert.ok(onTop(SACKS.cover) && SHEAVES.every((s) => onTop(s.cover)));
    built.update(3.2);
    const m = new Matrix4();
    let checked = 0;
    built.group.updateMatrixWorld(true);
    built.group.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const matrices = mesh instanceof InstancedMesh ? Array.from({ length: mesh.count }, (_, i) => (mesh.getMatrixAt(i, m), m.clone())) : [mesh.matrixWorld];
      for (const matrix of matrices) {
        checked++;
        assert.ok(matrix.elements.every(Number.isFinite) && matrix.determinant() > 1e-6, `${mesh.name} has an invalid transform`);
      }
      mesh.geometry.computeBoundingBox();
      assert.ok(mesh.geometry.boundingBox!.min.toArray().every(Number.isFinite), `${mesh.name} geometry`);
    });
    assert.ok(checked > 100, `${checked} transforms checked`);
  } finally {
    built.dispose();
  }
});

test("the shell is closed: from anywhere a player or the camera can be, every view ray hits the barn (no sky)", async () => {
  const gltf = await parseKit();
  const built = buildBarn(readBarnKit(gltf.scene));
  try {
    built.group.updateMatrixWorld(true);
    const targets = ["barn-shell", "barn-windows", "kit-BarnDoors"].flatMap((n) => {
      const out: Mesh[] = [];
      built.group.traverse((o) => o.name === n && (o as Mesh).isMesh && out.push(o as Mesh));
      return out;
    });
    const ray = new Raycaster();
    const eyes = [
      { x: 0, y: 1.6, z: 13 }, { x: 0, y: 1.6, z: -15 }, { x: 15, y: 1.6, z: 0 }, { x: -15, y: 1.6, z: 0 }, { x: 2.8, y: 1.6, z: 2.8 },
      { x: 3.25, y: U + 1.6, z: -12 }, { x: 12, y: U + 1.6, z: 3.25 }, { x: -5.25, y: U + 1.6, z: 0 }, { x: 0, y: 7, z: 0 },
    ];
    let rays = 0;
    for (const e of eyes)
      for (let i = 0; i < 12; i++)
        for (let j = -3; j <= 5; j++) {
          const yaw = (i / 12) * Math.PI * 2, pitch = (j / 6) * (Math.PI / 2);
          ray.set(new Vector3(e.x, e.y, e.z), new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)));
          ray.far = 60;
          rays++;
          assert.ok(ray.intersectObjects(targets, false).length > 0, `sky visible from ${e.x},${e.y},${e.z} at yaw ${yaw.toFixed(2)} pitch ${pitch.toFixed(2)}`);
        }
    assert.ok(rays > 900);
  } finally {
    built.dispose();
  }
});
