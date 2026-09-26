import { Raycaster, Vector3 } from "three";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { silentFeedback } from "../audio/events";
import type { MovementInput } from "../input/types";
import { defaultBindings } from "../input/defaults";
import { controlHint } from "./arenaMenu";
import { initializePhysics, IDLE_INPUT } from "./physics";
import type { PlayerId } from "./players";
import { restore } from "./ragdoll/character";
import { retire } from "./layers/game";
import { PropHuntGame } from "./prophunt/game";
import { hiderIntent, seekerIntent, whistleKey } from "./prophunt/controls";
import { HiderBot, hideSpots, KEEP_CLEAR, layoutNav, propNav, SeekerBot, VIEWPOINTS } from "./prophunt/bots";
import { clampPitch, PROP_CAMERA, propCameraBlockers, propCameraPose } from "./prophunt/propCamera";
import { insideBlockers } from "./arenas/barnCamera";
import { buildPropArena, STAIR_RISERS, stairSteps } from "./prophunt/arena";
import { decoyPlacements, detailPlacements, forestPlacements, PROP_KIT_NODES, TREE_CLEARANCE } from "./prophunt/scenery";
import { SENSE_AUDIO, SENSE_RECIPE, WHISTLE_AUDIO, WHISTLE_RECIPE } from "./prophunt/whistle";
import { revealLabel } from "./prophunt/reveal";
import { AudioManager, inverseDistanceGain } from "../audio/AudioManager";
import { silentFeedback as quiet, type FeedbackEvent } from "../audio/events";
import { ARENA_MAP_IDS, ARENA_MAPS } from "../../../shared/party-lab/maps";
import {
  CAMP,
  ENTRY_STEP_HEIGHT,
  HIDER_SPAWNS,
  LEAN_TO,
  LODGE,
  LOFT,
  OPENINGS,
  PORCH,
  PORCH_RAIL_Z,
  PROP_HUNT_MAP,
  SEEKER_SPAWN,
  SHED,
  STAIR,
  STRUCTURE_ZONES,
  WALLS,
  WOODPILE,
  CRATE_STEP,
  LODGE_INSIDE,
  colliderTop,
  surfaceBelow,
  zoneAt,
  type PropRole,
} from "../../../shared/party-lab/maps/propHunt";
import { REFERENCE_LAYOUT } from "../../../shared/party-lab/maps/propHuntLayout";
import { PROP_FAMILIES, PROP_FAMILY_IDS, shapeHeight, shapeSpan } from "../../../shared/party-lab/maps/propHuntProps";
import type { ArenaCollider } from "../../../shared/party-lab/maps/types";
import { PROP_HUNT, PROP_TICKS, WHISTLE_TICKS, WHISTLE_TIMES } from "../../../shared/party-lab/simulation/prophunt/config";
import { aimDirection } from "../../../shared/party-lab/simulation/prophunt/aim";
import { GAME_MODES, MODE_SELECTIONS } from "../../../shared/party-lab/modes";
import { NET } from "../../../shared/party-lab/network/protocol";
import { mulberry32 } from "../../../shared/party-lab/simulation/colors/layouts";

before(() => initializePhysics());

/**
 * The hand-placed V1 layout: most tests pin mechanics at known spots, so their games use it as
 * a fixed layout (`game()`); the dealt layouts have tests of their own (prophuntLayout.test.ts).
 */
const DECOYS = REFERENCE_LAYOUT.decoys,
  DECOY_COLLIDERS = REFERENCE_LAYOUT.colliders;

const IDLE: MovementInput[] = [IDLE_INPUT, IDLE_INPUT, IDLE_INPUT];
const HIDER_FIRST: PropRole[] = ["hider", "hider", "seeker"];
const SEEKER_FIRST: PropRole[] = ["seeker", "hider", "hider"];
const top = (c: ArenaCollider) => (c.shape === "cylinder" ? c.center.y + c.halfHeight : c.center.y + c.half.y);

/** A game fast-forwarded into `phase` ("hiding": the countdown elapsed; "search": the hiding too). */
function game(roles: PropRole[] = HIDER_FIRST, phase: "hiding" | "search" = "hiding") {
  const g = new PropHuntGame(silentFeedback, { roles, layout: REFERENCE_LAYOUT });
  while (g.round.phase !== phase) g.step(IDLE);
  return g;
}
function steps(g: PropHuntGame, seconds: number, inputs: (t: number) => MovementInput[] = () => IDLE) {
  for (let i = 0; i < Math.round(seconds * 60); i++) g.step(inputs(i / 60));
}
/** A body standing at floor point (x, z) facing `yaw`. */
function place(g: PropHuntGame, id: PlayerId, x: number, z: number, yaw = 0) {
  restore(g.physics.players[id], { x, y: surfaceBelow(x, z) + 0.9, z }, yaw);
}
const pelvis = (g: PropHuntGame, id: PlayerId) => g.physics.players[id].body.translation();
const press = (id: PlayerId, extra: Partial<MovementInput> = {}) => IDLE.map((input, k) => (k === id ? { ...input, ...extra } : input));
/** Walk a body through waypoints (plain movement, jumping only if asked); returns its feet and position. */
function walk(g: PropHuntGame, id: PlayerId, points: [number, number][], seconds: number, jump = false) {
  let k = 0;
  for (let t = 0; t < seconds * 60; t++) {
    const p = pelvis(g, id);
    while (k < points.length - 1 && Math.hypot(points[k][0] - p.x, points[k][1] - p.z) < 0.35) k++;
    const [x, z] = points[k],
      dx = x - p.x,
      dz = z - p.z,
      d = Math.hypot(dx, dz);
    const input = d < 0.1 ? IDLE_INPUT : { x: dx / d, z: dz / d, jump: jump && t % 20 === 0 };
    g.step(press(id, input));
    // Keep the phase open (hiding or search) however long the walk takes.
    if (g.round.tick > 60 * 5) g.round.tick = 60;
  }
  const p = pelvis(g, id);
  return { x: p.x, z: p.z, feet: g.feet(g.physics.players[id]) };
}
/** Hider `id` stands at (x, z) and presses E; returns its disguise (or null). */
function disguiseAt(g: PropHuntGame, id: PlayerId, x: number, z: number, yaw = 0) {
  place(g, id, x, z, yaw);
  steps(g, 0.6);
  g.step(press(id, { pickup: true }));
  return g.disguiseOf(id);
}
/** Horizontal gap from (x, z) to a collider's footprint (0 inside). */
function gap(c: ArenaCollider, x: number, z: number) {
  if (c.shape === "cylinder") return Math.max(0, Math.hypot(x - c.center.x, z - c.center.z) - c.radius);
  return Math.hypot(Math.max(0, Math.abs(x - c.center.x) - c.half.x), Math.max(0, Math.abs(z - c.center.z) - c.half.z));
}
const bottom = (c: ArenaCollider) => (c.shape === "cylinder" ? c.center.y - c.halfHeight : c.center.y - c.half.y);
/** Room for a standing body at (x, z) on `floor`: that floor under it, nothing solid within 0.5 m up to head height. */
function roomAt(x: number, z: number, floor: number) {
  if (Math.abs(x) > 10.4 || Math.abs(z) > 10.4 || Math.abs(surfaceBelow(x, z, floor + 0.3) - floor) > 0.01) return false;
  return [...PROP_HUNT_MAP.colliders, ...DECOY_COLLIDERS].every((c) => c.role === "floor" || top(c) <= floor + 0.05 || bottom(c) >= floor + 2 || gap(c, x, z) >= 0.5);
}
/** The seeker's facing and pitch putting its crosshair line (through the shoulder point) on a world point. */
function aimAt(g: PropHuntGame, x: number, y: number, z: number): MovementInput {
  const p = pelvis(g, g.seeker),
    { pivotHeight, shoulder } = PROP_HUNT.aim;
  let yaw = Math.atan2(x - p.x, z - p.z);
  // The shoulder point sits `shoulder` to the right of the yaw it serves: converge on it.
  for (let k = 0; k < 4; k++) yaw = Math.atan2(x - (p.x - Math.cos(yaw) * shoulder), z - (p.z + Math.sin(yaw) * shoulder));
  const ex = p.x - Math.cos(yaw) * shoulder,
    ez = p.z + Math.sin(yaw) * shoulder,
    pitch = -Math.atan2(y - (p.y + pivotHeight), Math.hypot(x - ex, z - ez));
  return { ...IDLE_INPUT, facing: yaw, aimPitch: pitch };
}
type Cast = ReturnType<PropHuntGame["cast"]>;
/**
 * The seeker takes a clean shot at a world point: it stands 2.5–4.5 m away on `floor` where a
 * preview of the shot (the crosshair line and the line from its torso) meets what `want`
 * accepts, turns to it and fires once. Returns the shot event (undefined if no spot works).
 */
function shootAt(g: PropHuntGame, target: { x: number; y: number; z: number }, floor: number, want: (hit: Cast) => boolean) {
  const s = g.seeker;
  for (const r of [2.5, 3.5, 4.5])
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2,
        x = target.x + Math.cos(a) * r,
        z = target.z + Math.sin(a) * r;
      if (!roomAt(x, z, floor)) continue;
      place(g, s, x, z, Math.atan2(target.x - x, target.z - z));
      steps(g, 0.6, () => press(s, aimAt(g, target.x, target.y, target.z)));
      const input = aimAt(g, target.x, target.y, target.z),
        preview = g.aim(input);
      if (!want(preview.target) || !want(g.cast(preview.origin, preview.direction, PROP_HUNT.seeker.range, s))) continue;
      g.step(press(s, { ...input, attack: true }));
      return g.events.find((e) => e.type === "shot");
    }
  return undefined;
}
const middle = (worn: { body: { translation(): { x: number; y: number; z: number } }; family: keyof typeof PROP_FAMILIES }) => {
  const b = worn.body.translation();
  return { x: b.x, y: b.y + shapeHeight(PROP_FAMILIES[worn.family].shape) / 2, z: b.z };
};

// ─── Map ────────────────────────────────────────────────────────────────────

test("map: Orman Kampı is 22 × 22 m, walled invisibly at ±11 m, outside the static registry, with the approved zones", () => {
  assert.equal(PROP_HUNT_MAP.id, "prophunt");
  assert.deepEqual(PROP_HUNT_MAP.bounds, { minX: -11, maxX: 11, minZ: -11, maxZ: 11 });
  assert.ok(!(ARENA_MAP_IDS as string[]).includes("prophunt") && !("prophunt" in ARENA_MAPS));
  assert.deepEqual(PROP_HUNT_MAP.lethalEdges, []);
  for (const c of PROP_HUNT_MAP.colliders) {
    const values = c.shape === "cylinder" ? [c.center.x, c.center.y, c.center.z, c.radius, c.halfHeight] : [...Object.values(c.center), ...Object.values(c.half)];
    assert.ok(values.every(Number.isFinite), c.role);
  }
  // Lodge 13 × 8.5 at +0.45, shed 4.5 × 5.5, porch across the lodge's south face.
  assert.equal(LODGE.x[1] - LODGE.x[0], 13);
  assert.equal(LODGE.z[1] - LODGE.z[0], 8.5);
  assert.equal(LODGE.floor, 0.45);
  assert.equal(SHED.x[1] - SHED.x[0], 4.5);
  assert.equal(SHED.z[1] - SHED.z[0], 5.5);
  assert.deepEqual(PORCH.x, LODGE.x);
  assert.equal(PORCH.top, LODGE.floor);
  assert.equal(LOFT.x[1] - LOFT.x[0], 5);
  assert.ok(Math.abs(LOFT.z[1] - LOFT.z[0] - 7.9) < 1e-9);
  assert.equal(LOFT.top, 3.65);
  // The boundary is ≥ 1.5 m above every standable top near it (the lean-to roof at 3.05 m reaches it).
  const boundary = PROP_HUNT_MAP.colliders.filter((c) => c.role === "boundary");
  assert.equal(boundary.length, 4);
  const nav = propNav(),
    reach = nav.field(nav.nodeAt(SEEKER_SPAWN.x, SEEKER_SPAWN.y, SEEKER_SPAWN.z));
  // Outdoors within 1.5 m of the boundary (indoors, the lodge's and shed's walls stand between).
  const indoors = (x: number, z: number) => [LODGE, SHED].some((r) => x > r.x[0] && x < r.x[1] && z > r.z[0] && z < r.z[1]);
  const edge = nav.nodes.filter((n) => Number.isFinite(reach.dist[n.id]) && Math.max(Math.abs(n.x), Math.abs(n.z)) > CAMP.half - 1.5 && !indoors(n.x, n.z));
  const highest = Math.max(...edge.map((n) => n.y));
  assert.ok(highest <= LEAN_TO.high, `the lean-to roof is the highest reachable top by the boundary (${highest})`);
  for (const c of boundary) assert.ok(top(c) - highest >= 1.5, `boundary ${top(c)} over the highest top ${highest}`);
  // Every zone is there (and its props).
  const zones = new Set(DECOYS.map((d) => d.zone));
  for (const zone of ["lodge", "loft", "porch", "leanTo", "shed", "yard", "plaza", "camp", "pavilion", "border"]) assert.ok(zones.has(zone as never), zone);
});

test("map: doors are 2.2 × 2.6 m; indoor clear height ≥ 3.0 m; the lodge has three exits and the loft three ways out", () => {
  const doors = OPENINGS.filter((o) => o.kind === "door");
  for (const d of doors) {
    assert.ok(Math.abs(d.span[1] - d.span[0] - 2.2) < 1e-9, d.label);
    assert.ok(d.top - d.bottom >= 2.6 - 1e-9, d.label);
  }
  // The lodge: front (porch), side (yard) and the loft door (onto the lean-to roof).
  assert.deepEqual(doors.filter((d) => d.wall.startsWith("lodge")).map((d) => d.label).sort(), ["front", "loft", "side"]);
  // Clear heights: under the loft deck, in the loft (to the ceiling at the wall tops), in the shed.
  assert.ok(LOFT.top - LOFT.thickness - LODGE.floor >= 3.0 - 1e-9);
  assert.ok(LODGE.wallTop - LOFT.top >= 3.0);
  assert.ok(SHED.wallTop - SHED.floor >= 3.0);
  // The loft's three ways out: the stair meets its edge, the 2.2 m drop gap, the loft door at its level.
  assert.equal(STAIR.top, LOFT.top);
  assert.equal(STAIR.x[1], LOFT.x[0]);
  assert.ok(Math.abs(LOFT.drop[1] - LOFT.drop[0] - 2.2) < 1e-9);
  const loftDoor = doors.find((d) => d.label === "loft")!;
  assert.equal(loftDoor.bottom, LOFT.top);
  // The stair is the Barn's slope (26.6°), the lean-to roof walkable (22.6°).
  assert.ok(Math.abs((Math.atan2(STAIR.top - STAIR.bottom, STAIR.x[1] - STAIR.x[0]) * 180) / Math.PI - 26.57) < 0.1);
  assert.ok((Math.atan2(LEAN_TO.high - LEAN_TO.low, LEAN_TO.x[1] - LEAN_TO.x[0]) * 180) / Math.PI < 25);
  // The walk-up route: every step 0.6 m (≤ 0.65 is walked without jumping).
  const climb = [CRATE_STEP.top, WOODPILE.top - CRATE_STEP.top, LEAN_TO.low - WOODPILE.top, LOFT.top - LEAN_TO.high];
  for (const rise of climb) assert.ok(Math.abs(rise - 0.6) < 1e-9, `step ${rise}`);
  // Entry steps halve the 0.45 m floors; the porch rail is 1.0 m, set back from the deck's edge.
  assert.ok(ENTRY_STEP_HEIGHT < LODGE.floor && LODGE.floor - ENTRY_STEP_HEIGHT < 0.35);
  assert.ok(PORCH.z[1] - PORCH_RAIL_Z[1] >= 0.6);
  const walls = Object.values(WALLS);
  assert.equal(walls.length, 8);
});

test("routes (real ragdoll): up the stair to the loft; the walk-up woodpile route to the loft door without a jump; the drop gap; vaulting the porch rail both ways; the doors", () => {
  let g = game();
  retire(g.physics.players[1]);
  retire(g.physics.players[2]);
  place(g, 0, -9.2, -8.3, Math.PI / 2);
  assert.ok(Math.abs(walk(g, 0, [[-9.3, -9.6], [-3.6, -9.8], [-1.5, -9.4]], 6).feet - LOFT.top) < 0.05, "stair → loft");
  place(g, 0, 5.85, -5.0, Math.PI);
  const up = walk(g, 0, [[5.85, -6.5], [5.85, -8.0], [4.4, -8.6], [2.4, -9.2], [1.0, -9.2]], 10);
  assert.ok(Math.abs(up.feet - LOFT.top) < 0.05 && up.x < 1.7, `woodpile route ended at ${up.x.toFixed(2)}, ${up.feet.toFixed(2)}`);
  place(g, 0, -2.0, -3.9, -Math.PI / 2);
  assert.ok(Math.abs(walk(g, 0, [[-4.6, -3.9]], 3).feet - LODGE.floor) < 0.05, "drop gap → great room floor");
  place(g, 0, -9.75, -1.2, 0);
  assert.ok(walk(g, 0, [[-9.75, 1.5]], 4, true).z > PORCH.z[1], "vault out over the porch rail");
  place(g, 0, -8.8, 2.1, Math.PI);
  const vaultIn = walk(g, 0, [[-8.8, -1.7]], 8, true);
  assert.ok(vaultIn.z < PORCH_RAIL_Z[0] && Math.abs(vaultIn.feet - PORCH.top) < 0.05, "vault in onto the porch");
  place(g, 0, -6.5, 2.4, Math.PI);
  assert.ok(walk(g, 0, [[-6.5, -4.0]], 5).z < -3.5, "front steps and door");
  place(g, 0, 3.5, -5.2, -Math.PI / 2);
  assert.ok(walk(g, 0, [[0.5, -5.2]], 4).x < 1.0, "side door");
  place(g, 0, 8.7, -3.5, Math.PI);
  assert.ok(walk(g, 0, [[8.7, -8.0]], 4).z < -7.5, "shed door");
  // Jump-spamming from the woodpile at the shed wall never gets onto the shed.
  place(g, 0, 5.9, -8.5, Math.PI / 2);
  assert.ok(walk(g, 0, [[8, -8.5]], 5, true).feet < 1.3);
  g.dispose();
  g = game();
});

test("navigation: one connected camp — every viewpoint, zone and decoy is reachable from the seeker's spawn; no hiding pocket is a dead end", () => {
  const nav = layoutNav(REFERENCE_LAYOUT);
  const from = nav.nodeAt(SEEKER_SPAWN.x, SEEKER_SPAWN.y, SEEKER_SPAWN.z);
  const field = nav.field(from);
  for (const vp of VIEWPOINTS) assert.ok(Number.isFinite(field.dist[nav.nodeAt(vp.x, vp.y + 0.78, vp.z)]), `viewpoint ${vp.zone} (${vp.x}, ${vp.z})`);
  for (const [i, d] of DECOYS.entries()) {
    // A reachable standing spot on the decoy's level within copying reach of its footprint.
    const reach = nav.nodes.some((n) => Number.isFinite(field.dist[n.id]) && Math.abs(n.y - d.y) < 0.4 && gap(DECOY_COLLIDERS[i], n.x, n.z) <= PROP_HUNT.disguise.range);
    assert.ok(reach, `decoy ${i} ${d.family} at (${d.x}, ${d.z})`);
  }
  // The longest walk from the seeker's spawn to anywhere is about 7 s at walking speed (the bare grid: no climbing surcharge).
  const bare = propNav(),
    bareField = bare.field(bare.nodeAt(SEEKER_SPAWN.x, SEEKER_SPAWN.y, SEEKER_SPAWN.z)),
    longest = Math.max(...bare.nodes.map((n) => bareField.dist[n.id]).filter(Number.isFinite));
  assert.ok(longest / 4.6 < 9.5, `longest route ${longest.toFixed(1)} m`);
});

test("spawns: on open ground, clear of every collider; hiders ≥ 3 m apart and ≥ 6 m from the seeker", () => {
  for (const s of [SEEKER_SPAWN, ...HIDER_SPAWNS]) {
    assert.equal(surfaceBelow(s.x, s.z), 0);
    for (const c of [...PROP_HUNT_MAP.colliders, ...DECOY_COLLIDERS]) {
      if (c.role === "floor") continue;
      const d = gap(c, s.x, s.z);
      assert.ok(d >= 0.45, `spawn (${s.x}, ${s.z}) near ${c.role} (${d.toFixed(2)})`);
    }
  }
  assert.ok(Math.hypot(HIDER_SPAWNS[0].x - HIDER_SPAWNS[1].x, HIDER_SPAWNS[0].z - HIDER_SPAWNS[1].z) >= 3);
  for (const h of HIDER_SPAWNS) assert.ok(Math.hypot(h.x - SEEKER_SPAWN.x, h.z - SEEKER_SPAWN.z) >= 6);
});

// ─── Props ──────────────────────────────────────────────────────────────────

test("props: 20 transformable families, none tiny; ~85 decoys, 2–10 per family, every family in ≥ 2 zones; about half in the structures", () => {
  assert.equal(PROP_FAMILY_IDS.length, 20);
  for (const id of PROP_FAMILY_IDS) {
    const shape = PROP_FAMILIES[id].shape;
    const dims = shape.kind === "box" ? [shape.x, shape.y, shape.z] : [2 * shape.radius, shape.height, 2 * shape.radius];
    // Hider-sized: no side under 0.45 m and at least 0.2 m³ of bounding box.
    assert.ok(Math.min(...dims) >= 0.45 && dims[0] * dims[1] * dims[2] >= 0.2, `${id} is not tiny (${dims})`);
    assert.ok(shapeSpan(shape) <= 2.0, `${id} is not enormous`);
  }
  const rejected = /bottle|match|phone|knife|flashlight|plate|battery|cup|book|tool/i;
  for (const id of PROP_FAMILY_IDS) assert.ok(!rejected.test(id) && !rejected.test(PROP_FAMILIES[id].node), id);
  assert.ok(DECOYS.length >= 80 && DECOYS.length <= 90, `${DECOYS.length} decoys`);
  for (const id of PROP_FAMILY_IDS) {
    const of = DECOYS.filter((d) => d.family === id);
    assert.ok(of.length >= 2 && of.length <= 10, `${id}: ${of.length}`);
    assert.ok(new Set(of.map((d) => d.zone)).size >= 2, `${id} in ≥ 2 zones`);
  }
  const share = DECOYS.filter((d) => STRUCTURE_ZONES.includes(d.zone)).length / DECOYS.length;
  assert.ok(share >= 0.5 && share <= 0.65, `structures ${Math.round(share * 100)}%`);
});

test("props: every decoy stands on its surface, inside the camp, in its declared zone, never overlapping a solid; quarter turns only for boxes", () => {
  const all = [...PROP_HUNT_MAP.colliders, ...DECOY_COLLIDERS],
    solids = all.filter((c) => c.role !== "floor");
  for (const [i, d] of DECOYS.entries()) {
    const own = DECOY_COLLIDERS[i];
    assert.ok(Math.abs(d.x) < CAMP.half && Math.abs(d.z) < CAMP.half);
    assert.equal(zoneAt(d.x, d.z, d.y), d.zone, `${d.family} (${d.x}, ${d.z})`);
    assert.ok([0, 1, 2, 3].includes(d.turns));
    // Supported: the surface under its middle (without itself) is exactly its y.
    let floor = 0;
    for (const c of all) {
      if (c === own || c.role === "floor" || c.role === "boundary" || c.role === "glass") continue;
      const inside = c.shape === "cylinder" ? Math.hypot(d.x - c.center.x, d.z - c.center.z) <= c.radius : Math.abs(d.x - c.center.x) <= c.half.x && Math.abs(d.z - c.center.z) <= c.half.z;
      if (inside && top(c) <= d.y + 0.3) floor = Math.max(floor, top(c));
    }
    assert.ok(Math.abs(floor - d.y) < 1e-6, `${d.family} (${d.x}, ${d.z}) on ${floor}, declared ${d.y}`);
    // No overlap with another solid at its level (touching is fine).
    const b = own.shape === "cylinder" ? { x0: own.center.x - own.radius, x1: own.center.x + own.radius, z0: own.center.z - own.radius, z1: own.center.z + own.radius, y0: own.center.y - own.halfHeight, y1: own.center.y + own.halfHeight } : { x0: own.center.x - own.half.x, x1: own.center.x + own.half.x, z0: own.center.z - own.half.z, z1: own.center.z + own.half.z, y0: own.center.y - own.half.y, y1: own.center.y + own.half.y };
    for (const c of solids) {
      if (c === own || c.shape === "ramp") continue;
      const o = c.shape === "cylinder" ? { x0: c.center.x - c.radius, x1: c.center.x + c.radius, z0: c.center.z - c.radius, z1: c.center.z + c.radius, y0: c.center.y - c.halfHeight, y1: c.center.y + c.halfHeight } : { x0: c.center.x - c.half.x, x1: c.center.x + c.half.x, z0: c.center.z - c.half.z, z1: c.center.z + c.half.z, y0: c.center.y - c.half.y, y1: c.center.y + c.half.y };
      const overlap = Math.min(b.x1, o.x1) - Math.max(b.x0, o.x0) > 0.012 && Math.min(b.z1, o.z1) - Math.max(b.z0, o.z0) > 0.012 && Math.min(b.y1, o.y1) - Math.max(b.y0, o.y0) > 0.012;
      if (!overlap) continue;
      // Boxes' corners against a cylinder: check the true distance.
      if (own.shape === "cylinder" || c.shape === "cylinder") {
        const [r, q] = own.shape === "cylinder" ? [own, o] : [c as Extract<ArenaCollider, { shape: "cylinder" }>, b];
        const dx = Math.max(q.x0 - r.center.x, 0, r.center.x - q.x1),
          dz = Math.max(q.z0 - r.center.z, 0, r.center.z - q.z1);
        if (Math.hypot(dx, dz) >= r.radius - 0.012) continue;
      }
      assert.fail(`${d.family} (${d.x}, ${d.z}) overlaps ${c.role} at (${c.center.x}, ${c.center.z})`);
    }
  }
});

test("props: the kit draws each family exactly its gameplay shape (bottom-centre, same size) and has every node the scene uses", () => {
  const glb = readFileSync(new URL("../../../public/party-lab/maps/prop-hunt/prop-hunt-kit.glb", import.meta.url));
  const length = glb.readUInt32LE(12),
    json = JSON.parse(glb.subarray(20, 20 + length).toString("utf8"));
  const names = json.nodes.map((n: { name: string }) => n.name);
  for (const node of PROP_KIT_NODES) assert.ok(names.includes(node), `kit has ${node}`);
  for (const id of PROP_FAMILY_IDS) {
    const family = PROP_FAMILIES[id],
      mesh = json.meshes[json.nodes.find((n: { name: string }) => n.name === family.node).mesh],
      position = json.accessors[mesh.primitives[0].attributes.POSITION];
    const size = position.max.map((v: number, k: number) => v - position.min[k]);
    const shape = family.shape;
    const want = shape.kind === "box" ? [shape.x, shape.y, shape.z] : [2 * shape.radius, shape.height, 2 * shape.radius];
    // Bottom-centre pivot and the gameplay size (cylinders: their diameter; the sapling's foliage is wider than its trunk shape).
    assert.ok(Math.abs(position.min[1]) < 1e-3, `${id} bottom at 0`);
    if (id === "sapling") assert.ok(Math.abs(size[1] - want[1]) < 0.02, `${id} height ${size[1]}`);
    else for (let k = 0; k < 3; k++) assert.ok(Math.abs(size[k] - want[k]) < 0.02, `${id} size ${size.map((n: number) => n.toFixed(2))} vs ${want}`);
    assert.ok(Math.abs(position.min[0] + position.max[0]) < 0.02 && Math.abs(position.min[2] + position.max[2]) < 0.02, `${id} centred`);
  }
  // No textures, one material, metalness 0.
  assert.ok(!json.images && !json.textures);
  assert.equal(json.materials.length, 1);
  assert.equal(json.materials[0].pbrMetallicRoughness.metallicFactor, 0);
  assert.ok(glb.length < 2_000_000, `kit ${glb.length} bytes`);
  const credits = readFileSync(new URL("../../../public/party-lab/maps/prop-hunt/CREDITS.txt", import.meta.url), "utf8");
  assert.match(credits, /CC0/);
  assert.equal(decoyPlacements(DECOYS).length, DECOYS.length);
});

// ─── Transform ──────────────────────────────────────────────────────────────

test("transform: E copies the nearest decoy in reach (footprint ≤ 1.8 m, feet within 1.2 m of its floor); nothing in reach is a refusal", () => {
  const g = game();
  /** The decoy nearest a hider's pelvis (by footprint) among those it could copy, ignoring sight. */
  const expected = (id: PlayerId) => {
    const p = pelvis(g, id),
      feet = g.feet(g.physics.players[id]);
    let best = -1,
      bestGap = Infinity;
    DECOYS.forEach((d, i) => {
      const distance = gap(DECOY_COLLIDERS[i], p.x, p.z);
      if (Math.abs(d.y - feet) <= PROP_HUNT.disguise.heightGap && distance <= PROP_HUNT.disguise.range && distance < bestGap) [best, bestGap] = [i, distance];
    });
    return best;
  };
  // In the yard between the side door's log and a crate: the log's footprint is nearer.
  for (const [x, z] of [
    [4.3, -4.6],
    [-1.0, 1.55],
    [8.0, -7.2],
    [-1.45, -8.9],
  ] as const) {
    place(g, 0, x, z, Math.PI);
    steps(g, 0.5);
    const pick = g.nearestDecoy(0);
    assert.ok(pick, `something in reach at (${x}, ${z})`);
    assert.equal(pick!.index, expected(0), `(${x}, ${z}) picked ${DECOYS[pick!.index].family}`);
    assert.ok(pick!.distance <= PROP_HUNT.disguise.range);
  }
  // Open ground 2.2 m and more from every decoy: nothing, and E is refused.
  let open: [number, number] | null = null;
  for (let z = -10; z <= 10 && !open; z += 0.5)
    for (let x = -10; x <= 10 && !open; x += 0.5) if (roomAt(x, z, 0) && DECOY_COLLIDERS.every((c) => gap(c, x, z) >= 2.2)) open = [x, z];
  assert.ok(open, "an open spot");
  place(g, 0, open![0], open![1], Math.PI);
  steps(g, 0.5);
  const p = pelvis(g, 0);
  assert.ok(DECOY_COLLIDERS.every((c) => gap(c, p.x, p.z) > PROP_HUNT.disguise.range), `no decoy footprint within reach of (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`);
  assert.equal(g.nearestDecoy(0), null);
  g.step(press(0, { pickup: true }));
  assert.deepEqual(g.events, [{ type: "refused", id: 0, why: "noProp" }]);
  assert.equal(g.disguiseOf(0), null);
  g.dispose();
});

test("transform: never through walls or glass — inside the lodge by the south wall, the porch plant just outside is not copied", () => {
  const g = game();
  // The porch plant at (−8.0, −2.1) is 1.0 m from this spot, through the wall; the side table inside is nearer anyway,
  // so stand where only outside decoys would be in reach: in the doorway's west corner inside.
  place(g, 0, -7.4, -3.25, Math.PI);
  steps(g, 0.5);
  const pick = g.nearestDecoy(0);
  assert.ok(!pick || DECOYS[pick.index].zone === "lodge", `picked ${pick && JSON.stringify(DECOYS[pick.index])}`);
  // And from the porch, the side table inside the lodge (0.8 m through the wall) is not picked.
  place(g, 0, -8.3, -1.9, 0);
  steps(g, 0.5);
  const outside = g.nearestDecoy(0);
  assert.ok(!outside || DECOYS[outside.index].zone !== "lodge", `picked ${outside && JSON.stringify(DECOYS[outside.index])}`);
  g.dispose();
});

test("transform: the disguise sits exactly on the floor (ground, lodge, loft, shed), takes the copied decoy's turn, and E steps back out", () => {
  const g = game();
  const cases: [number, number, number][] = [
    [-1.0, 1.55, 0], // the plaza's north log
    [-6.1, -4.95, LODGE.floor], // a dining chair
    [-1.45, -8.9, LOFT.top], // the loft's side table
    [8.0, -7.2, SHED.floor], // the shed's dresser
  ];
  for (const [x, z, floor] of cases) {
    const worn = disguiseAt(g, 0, x, z);
    assert.ok(worn, `disguised at (${x}, ${z})`);
    const b = worn!.body.translation();
    steps(g, 0.5);
    const settled = worn!.body.translation();
    assert.ok(Math.abs(settled.y - PROP_HUNT.disguise.skin - floor) < 0.02, `bottom ${settled.y.toFixed(3)} on ${floor}`);
    assert.ok(Math.hypot(settled.x - b.x, settled.z - b.z) < 0.02, "no drift");
    assert.equal(g.physics.players[0].eliminated, true, "the ragdoll is retired while disguised");
    // Out again (after the cooldown): standing where the prop was.
    steps(g, PROP_HUNT.disguise.cooldown);
    g.step(press(0, { pickup: true }));
    assert.equal(g.disguiseOf(0), null);
    assert.equal(g.physics.players[0].eliminated, false);
    const p = pelvis(g, 0);
    assert.ok(Math.hypot(p.x - settled.x, p.z - settled.z) < 0.7);
    steps(g, 1);
  }
  // A crate copied from a quarter-turned-0 decoy keeps turn 0; a chair from the west side of the table (turn 1) faces +x.
  const chair = disguiseAt(g, 0, -6.1, -4.95);
  assert.ok(chair && Math.abs(chair.yaw - Math.PI / 2) < 1e-6, `chair yaw ${chair?.yaw}`);
  g.dispose();
});

test("transform: refused in the air, and within the 0.8 s cooldown; never for the seeker", () => {
  const g = game();
  place(g, 0, -1.0, 1.55, 0);
  steps(g, 0.5);
  g.step(press(0, { jump: true }));
  steps(g, 0.12);
  g.step(press(0, { pickup: true }));
  assert.equal(g.disguiseOf(0), null);
  assert.deepEqual(g.events, [{ type: "refused", id: 0, why: "airborne" }]);
  steps(g, 1.2);
  g.step(press(0, { pickup: true }));
  assert.ok(g.disguiseOf(0));
  g.step(press(0, { pickup: true }));
  assert.deepEqual(g.events, [{ type: "refused", id: 0, why: "cooldown" }]);
  assert.ok(g.disguiseOf(0));
  // The seeker (slot 2) pressing E does nothing.
  steps(g, 0.1, () => press(2, { pickup: true }));
  assert.equal(g.disguiseOf(2), null);
  g.dispose();
});

test("disguised movement: slow (2.3 m/s), no jump, no sprint; up the side door's 0.22 m steps and the stair, never the 0.6 m crate step; falls off the loft edge", () => {
  const g = game();
  /** Steers a disguise toward (x, z) for up to `seconds` (jump and sprint held: they do nothing). */
  const drive = (x: number, z: number, seconds: number) => {
    const worn = g.disguiseOf(0)!;
    for (let t = 0; t < seconds * 60; t++) {
      const b = worn.body.translation(),
        dx = x - b.x,
        dz = z - b.z,
        d = Math.hypot(dx, dz);
      if (d < 0.1) break;
      g.step(press(0, { x: dx / d, z: dz / d, jump: true, sprint: true }));
    }
    return { ...worn.body.translation() };
  };
  const skin = PROP_HUNT.disguise.skin;
  // A stump copied in the yard: open ground to the south of (3.4, −5.4).
  const stump = disguiseAt(g, 0, 2.9, -5.9, 0);
  assert.equal(stump?.family, "stump");
  drive(3.4, -5.4, 2);
  steps(g, 0.3, () => press(0, { x: 0, z: 1 }));
  const a = { ...stump!.body.translation() };
  steps(g, 1.5, () => press(0, { x: 0, z: 1, jump: true, sprint: true }));
  const b = stump!.body.translation(),
    speed = Math.hypot(b.x - a.x, b.z - a.z) / 1.5;
  assert.ok(speed > 2.15 && speed <= PROP_HUNT.disguise.speed + 0.02, `speed ${speed.toFixed(2)} m/s`);
  assert.ok(Math.abs(b.y - a.y) < 0.01, "no jump");
  // Up the side door's entry step (0.22 m) onto the lodge floor (0.45 m).
  drive(2.9, -5.2, 3);
  let at = drive(0.6, -5.2, 3);
  assert.ok(at.x < 0.8 && Math.abs(at.y - skin - LODGE.floor) < 0.02, `inside the lodge at x ${at.x.toFixed(2)}, y ${at.y.toFixed(2)}`);
  // Never up the 0.6 m crate step at the woodpile.
  drive(2.9, -5.2, 3);
  drive(5.85, -5.3, 4);
  at = drive(5.85, -8.0, 3);
  assert.ok(at.y - skin < 0.02 && at.z > CRATE_STEP.z[1], `stayed on the ground at z ${at.z.toFixed(2)}, y ${at.y.toFixed(2)}`);
  // Up the stair (26.6°) from its foot to the loft.
  stump!.body.setTranslation({ x: -10.2, y: LODGE.floor + skin, z: -9.8 }, true);
  steps(g, 0.2);
  drive(-9.3, -9.8, 2);
  at = drive(-2.8, -9.8, 6);
  assert.ok(at.x > -3.3 && Math.abs(at.y - skin - LOFT.top) < 0.03, `up the stair at x ${at.x.toFixed(2)}, y ${at.y.toFixed(2)}`);
  // Off the loft's open edge (the drop gap) onto the great room floor (its landing is kept clear).
  drive(-2.8, -3.9, 4);
  drive(-4.1, -3.9, 3);
  steps(g, 1);
  at = { ...stump!.body.translation() };
  assert.ok(at.x < -3.6 && Math.abs(at.y - skin - LODGE.floor) < 0.03, `dropped to x ${at.x.toFixed(2)}, y ${at.y.toFixed(2)}`);
  g.dispose();
});

test("disguised movement soak: 3 minutes of random steering through the camp — no sinking, no leaving the camp, no physics faults", () => {
  const g = game();
  const rnd = mulberry32(99);
  const worn = disguiseAt(g, 0, -1.0, 1.55)!;
  assert.ok(worn);
  let x = 0,
    z = -1,
    lowest = Infinity;
  for (let t = 0; t < 60 * 180; t++) {
    if (t % 45 === 0) {
      const a = rnd() * Math.PI * 2;
      x = Math.cos(a);
      z = Math.sin(a);
    }
    g.step(press(0, { x, z }));
    if (g.round.tick > 60 * 5) g.round.tick = 60;
    const p = g.disguiseOf(0)!.body.translation();
    lowest = Math.min(lowest, p.y - surfaceBelow(p.x, p.z, p.y + 0.1));
    assert.ok(Math.abs(p.x) < 11 && Math.abs(p.z) < 11 && Number.isFinite(p.y), `left the camp at ${p.x}, ${p.z}`);
  }
  assert.ok(lowest > -0.03, `sank ${lowest}`);
  assert.equal(g.physics.diagnostics.invalidBodies, 0);
  g.dispose();
});

// ─── Round ──────────────────────────────────────────────────────────────────

test("round: 3 s countdown (everyone frozen) → 15 s hiding (seeker frozen) → 75 s search → results → a fresh round with the same roles", () => {
  const g = new PropHuntGame(silentFeedback, { roles: SEEKER_FIRST });
  let t = 0;
  while (g.round.phase === "countdown") {
    g.step(press(0, { x: 0, z: -1 }));
    t++;
  }
  assert.equal(t, PROP_TICKS.countdown);
  const start = pelvis(g, 0);
  t = 0;
  while (g.round.phase === "hiding") {
    g.step(press(0, { x: 0, z: -1, attack: true }));
    t++;
  }
  assert.equal(t, PROP_TICKS.hiding);
  assert.ok(Math.hypot(pelvis(g, 0).x - start.x, pelvis(g, 0).z - start.z) < 0.15, "the seeker stayed put while hiding");
  assert.equal(g.ammo, PROP_HUNT.seeker.ammo, "and could not shoot");
  assert.equal(g.round.phase, "search");
  steps(g, 0.5, () => press(0, { x: 0, z: -1 }));
  assert.ok(Math.hypot(pelvis(g, 0).x - start.x, pelvis(g, 0).z - start.z) > 0.5, "released");
  t = 0;
  while (g.round.phase === "search") {
    g.step(IDLE);
    t++;
  }
  assert.equal(t, PROP_TICKS.search - PROP_TICKS.search % 1 - 30);
  assert.equal(g.round.outcome, "hiders");
  assert.equal(g.round.reason, "timeout");
  let event = null;
  while (event !== "reset") event = g.step(IDLE);
  assert.equal(g.round.phase, "countdown");
  assert.deepEqual([...g.roles], SEEKER_FIRST);
  assert.equal(g.ammo, PROP_HUNT.seeker.ammo);
  g.dispose();
});

test("round: the seeker wins the moment the second hider is found; one hider left when time runs out is a hider win", () => {
  const g = game(SEEKER_FIRST, "hiding");
  assert.ok(disguiseAt(g, 1, 4.3, -4.6, 0));
  assert.ok(disguiseAt(g, 2, 8.0, -7.2, 0));
  while (g.round.phase !== "search") g.step(IDLE);
  const found = (id: PlayerId) => (hit: Cast) => hit?.hit === "hider" && hit.target === id;
  let shot = shootAt(g, middle(g.disguiseOf(1)!), 0, found(1));
  assert.ok(shot?.type === "shot" && shot.hit === "hider" && shot.target === 1, JSON.stringify(shot));
  assert.deepEqual(g.round.alive, [true, false, true]);
  assert.equal(g.round.phase, "search");
  shot = shootAt(g, middle(g.disguiseOf(2)!), SHED.floor, found(2));
  assert.ok(shot?.type === "shot" && shot.hit === "hider" && shot.target === 2, JSON.stringify(shot));
  assert.equal(g.round.phase, "results");
  assert.equal(g.round.outcome, "seeker");
  assert.equal(g.round.reason, "found");
  assert.equal(g.stats.finds, 2);
  g.dispose();
  // One found, one left: the hiders win when the search runs out.
  const h = game(SEEKER_FIRST, "hiding");
  assert.ok(disguiseAt(h, 1, 4.3, -4.6, 0));
  while (h.round.phase !== "search") h.step(IDLE);
  assert.ok(shootAt(h, pelvis(h, 2), 0, found(2)));
  assert.deepEqual(h.round.alive, [true, true, false]);
  while (h.round.phase === "search") h.step(IDLE);
  assert.equal(h.round.outcome, "hiders");
  assert.equal(h.round.reason, "timeout");
  h.dispose();
});

// ─── Seeker ─────────────────────────────────────────────────────────────────

test("seeker: 15 shots, one per press (the 0.55 s cooldown swallows held presses), each costing exactly one, no reload; the 15th spent with a hider hidden ends the round at once — no 16th shot", () => {
  assert.equal(PROP_HUNT.seeker.ammo, 15);
  const g = game(SEEKER_FIRST, "search");
  assert.equal(g.ammo, 15, "the seeker starts with 15");
  const shots: { tick: number; ammo: number }[] = [];
  let finishedAt = -1;
  for (let t = 0; t < 60 * 12 && finishedAt < 0; t++) {
    const tick = g.round.tick,
      event = g.step(press(0, { facing: Math.PI, aimPitch: 0.6, attack: true }));
    for (const e of g.events) if (e.type === "shot") shots.push({ tick, ammo: e.ammo });
    if (event === "finished") finishedAt = tick;
  }
  assert.equal(shots.length, 15);
  shots.forEach((s, k) => assert.equal(s.ammo, 14 - k, "each shot costs exactly one"));
  for (let k = 1; k < shots.length; k++) assert.ok(shots[k].tick - shots[k - 1].tick >= PROP_TICKS.shotCooldown, "held: one shot per cooldown");
  // The 15th missed with both hiders hidden: the round ended on that very tick, the hiders won.
  assert.equal(finishedAt, shots[14].tick);
  assert.equal(g.round.phase, "results");
  assert.equal(g.round.outcome, "hiders");
  assert.equal(g.round.reason, "ammo");
  assert.equal(g.round.endedAt, shots[14].tick, "the search clock stopped there (not run out)");
  assert.ok(g.round.endedAt < PROP_TICKS.search - 60);
  // No 16th shot: pressing on during the result fires nothing.
  steps(g, 2, () => press(0, { facing: Math.PI, aimPitch: 0.6, attack: true }));
  assert.equal(g.stats.shots, 15);
  assert.equal(g.ammo, 0);
  g.dispose();
});

test("seeker: the last shot is resolved first — if it finds the last hider the seeker wins; a last shot at a decoy with a hider left is an instant hider win (\"Mermin bitti!\")", () => {
  const g = game(SEEKER_FIRST, "hiding");
  const worn = disguiseAt(g, 1, 4.3, -4.6, 0)!;
  assert.ok(worn);
  while (g.round.phase !== "search") g.step(IDLE);
  assert.ok(shootAt(g, pelvis(g, 2), 0, (hit) => hit?.hit === "hider" && hit.target === 2));
  assert.deepEqual(g.round.alive, [true, true, false]);
  g.ammo = 1;
  const shot = shootAt(g, middle(worn), 0, (hit) => hit?.hit === "hider" && hit.target === 1);
  assert.ok(shot?.type === "shot" && shot.hit === "hider" && shot.ammo === 0);
  assert.equal(g.round.outcome, "seeker", "the 15th shot found the last hider: the seeker wins");
  assert.equal(g.round.reason, "found");
  assert.equal(g.reveal.length, 0, "nobody left to reveal");
  g.dispose();
  // The same last shot at a decoy instead: the hiders win on that tick.
  const h = game(SEEKER_FIRST, "hiding");
  disguiseAt(h, 1, 4.3, -4.6, 0);
  while (h.round.phase !== "search") h.step(IDLE);
  h.ammo = 1;
  const log = DECOYS.findIndex((d) => d.family === "log" && d.zone === "plaza"),
    d = DECOYS[log];
  const miss = shootAt(h, { x: d.x, y: d.y + 0.23, z: d.z }, 0, (hit) => hit?.hit === "decoy" && hit.decoy === log);
  assert.ok(miss?.type === "shot" && miss.hit === "decoy" && miss.ammo === 0);
  assert.equal(h.round.phase, "results");
  assert.equal(h.round.outcome, "hiders");
  assert.equal(h.round.reason, "ammo");
  h.dispose();
});

test("result reveal: only once the round is decided, only the hiders still hidden (a found one never), with their name, disguise and exact place; nothing during the search; cleared for the next round", () => {
  const g = game(SEEKER_FIRST, "hiding");
  const worn = disguiseAt(g, 1, 4.3, -4.6, 0)!;
  assert.ok(worn);
  const family = worn.family;
  while (g.round.phase !== "search") g.step(IDLE);
  assert.ok(shootAt(g, pelvis(g, 2), 0, (hit) => hit?.hit === "hider" && hit.target === 2), "hider 2 found");
  while (g.round.phase === "search") {
    assert.equal(g.reveal.length, 0, "never during the search");
    if (g.round.tick < PROP_TICKS.search - 30) g.round.tick = PROP_TICKS.search - 30;
    g.step(IDLE);
  }
  assert.equal(g.round.reason, "timeout");
  assert.equal(g.reveal.length, 1, "only the hider still hidden");
  const at = g.disguiseOf(1)!.body.translation(),
    yaw = g.disguiseOf(1)!.yaw;
  const r = g.reveal[0];
  assert.equal(r.id, 1);
  assert.equal(r.family, family);
  assert.ok(Math.hypot(r.at.x - at.x, r.at.z - at.z) < 1e-6 && Math.abs(r.at.y - (at.y - PROP_HUNT.disguise.skin)) < 1e-6, "its prop's bottom-centre");
  assert.equal(r.yaw, yaw);
  assert.equal(revealLabel(1, family).text, `Bulunamadı: Player 2 · ${PROP_FAMILIES[family].name}`);
  assert.equal(revealLabel(2, null).text, "Bulunamadı: Player 3 · kılıksız");
  assert.equal(revealLabel(0, "chair").text, "Bulunamadı: Player 1 (sen) · Sandalye");
  // The whole result shows it; the next round starts clean.
  while (g.round.phase === "results") {
    assert.equal(g.reveal.length, 1);
    g.step(IDLE);
  }
  assert.equal(g.reveal.length, 0);
  while (g.round.phase !== "search") g.step(IDLE);
  assert.equal(g.reveal.length, 0);
  g.dispose();
  // Out of shots with both still hidden: both revealed (one in its prop, one in plain body).
  const h = game(SEEKER_FIRST, "hiding");
  const prop = disguiseAt(h, 1, 4.3, -4.6, 0)!;
  place(h, 2, 0.6, 3.0, 0);
  while (h.round.phase !== "search") h.step(IDLE);
  h.ammo = 1;
  steps(h, 0.6, (t) => press(0, { facing: 0, aimPitch: -0.9, attack: t === 0 }));
  assert.equal(h.round.reason, "ammo");
  assert.deepEqual(
    h.reveal.map((x) => [x.id, x.family]),
    [
      [1, prop.family],
      [2, null],
    ]
  );
  const feet = h.feet(h.physics.players[2]);
  assert.ok(Math.abs(h.reveal[1].at.y - feet) < 0.05, "the body's feet");
  h.dispose();
});

test("seeker: a real decoy takes the shot harmlessly; a disguised hider's prop is found; an undisguised hider's body is found; walls and glass stop shots", () => {
  const g = game(SEEKER_FIRST, "hiding");
  const worn = disguiseAt(g, 1, 4.3, -4.6, 0)!;
  assert.ok(worn);
  while (g.round.phase !== "search") g.step(IDLE);
  // A real decoy: the plaza's north log.
  const log = DECOYS.findIndex((d) => d.family === "log" && d.zone === "plaza");
  const d = DECOYS[log];
  let shot = shootAt(g, { x: d.x, y: d.y + 0.23, z: d.z }, 0, (hit) => hit?.hit === "decoy" && hit.decoy === log);
  assert.ok(shot?.type === "shot" && shot.hit === "decoy" && shot.decoy === log, JSON.stringify(shot));
  assert.deepEqual(g.round.alive, [true, true, true]);
  assert.equal(g.ammo, PROP_HUNT.seeker.ammo - 1);
  assert.equal(g.stats.decoyHits, 1);
  // The disguised hider (the hitbox is its prop's shape, not the body it replaced).
  shot = shootAt(g, middle(worn), 0, (hit) => hit?.hit === "hider" && hit.target === 1);
  assert.ok(shot?.type === "shot" && shot.hit === "hider" && shot.target === 1);
  const found = g.events.find((e) => e.type === "found");
  assert.ok(found?.type === "found" && found.id === 1 && found.family === worn.family);
  assert.equal(g.disguiseOf(1), null);
  assert.equal(g.round.phase, "search");
  // The other hider, undisguised in the open.
  shot = shootAt(g, pelvis(g, 2), 0, (hit) => hit?.hit === "hider" && hit.target === 2);
  assert.ok(shot?.type === "shot" && shot.hit === "hider" && shot.target === 2);
  assert.equal(g.round.outcome, "seeker");
  g.dispose();
  // Glass: from the porch, a shot at the great room through a window stops on the pane.
  const h = game(SEEKER_FIRST, "search");
  const window = OPENINGS.find((o) => o.kind === "window" && o.wall === "lodgeS")!;
  const wx = (window.span[0] + window.span[1]) / 2,
    wy = (window.bottom + window.top) / 2;
  place(h, 0, wx, -1.4, Math.PI);
  steps(h, 0.6, () => press(0, aimAt(h, wx, wy, -5)));
  h.step(press(0, { ...aimAt(h, wx, wy, -5), attack: true }));
  shot = h.events.find((e) => e.type === "shot");
  assert.ok(shot?.type === "shot" && shot.hit === "world", `through glass: ${shot?.type === "shot" && shot.hit}`);
  assert.ok(shot?.type === "shot" && shot.end.z > LODGE_INSIDE.z[1] - 0.05, `stopped at the wall line (z ${shot?.type === "shot" && shot.end.z.toFixed(2)})`);
  // And a wall: the same from beside the window, at the logs.
  const beside = window.span[1] + 0.8;
  place(h, 0, beside, -1.4, Math.PI);
  steps(h, 0.7, () => press(0, aimAt(h, beside, 1.2, -5)));
  h.step(press(0, { ...aimAt(h, beside, 1.2, -5), attack: true }));
  shot = h.events.find((e) => e.type === "shot");
  assert.ok(shot?.type === "shot" && shot.hit === "world" && shot.end.z > LODGE_INSIDE.z[1] - 0.05, "stopped by the wall");
  h.dispose();
});

// ─── Controls, camera, visuals ──────────────────────────────────────────────

test("controls: the seeker's F fires along its aim (body faces it); the hider's E transforms; the controls lines say so", () => {
  const raw = { x: 0, z: -1, jump: false, punch: true, grab: false, lift: true };
  const seeker = seekerIntent(raw, 0.4, 0.3, { x: 0.1, y: 1, z: 0 });
  assert.equal(seeker.attack, true);
  assert.equal(seeker.facing, 0.4);
  assert.equal(seeker.aimPitch, 0.3);
  assert.equal(seeker.sprint, true);
  assert.ok(Math.abs(seeker.x - Math.sin(0.4)) < 1e-9 && Math.abs(seeker.z - Math.cos(0.4)) < 1e-9);
  const hider = hiderIntent(raw, 0.4, true);
  assert.equal(hider.pickup, true);
  assert.equal(hider.facing, undefined);
  assert.equal((hider as MovementInput).attack, undefined);
  const bindings = defaultBindings();
  assert.match(controlHint(bindings, "propSeeker"), /F ateş \(15 mermi\)/);
  assert.match(controlHint(bindings, "propSeeker"), /V kamera/);
  assert.doesNotMatch(controlHint(bindings, "propHider"), /kamera/);
  assert.match(controlHint(bindings, "propHider"), /E eşyaya dönüş/);
});

test("camera: seeker 4.8 m boom, 22° down, 60° FOV, a right shoulder; hider 5.4 m, centred, a little wider; never inside geometry from any standing spot", () => {
  assert.equal(PROP_CAMERA.seeker.boom, 4.8);
  assert.equal(PROP_CAMERA.seeker.fov, 60);
  assert.ok(Math.abs((PROP_CAMERA.seeker.restPitch * 180) / Math.PI - 22) < 1e-9);
  assert.ok(PROP_CAMERA.seeker.shoulder > 0 && PROP_CAMERA.hider.shoulder === 0);
  assert.ok(PROP_CAMERA.hider.boom > PROP_CAMERA.seeker.boom && PROP_CAMERA.hider.fov > PROP_CAMERA.seeker.fov);
  assert.equal(clampPitch(PROP_CAMERA.seeker, 2), PROP_CAMERA.seeker.maxPitch);
  const blockers = propCameraBlockers(DECOY_COLLIDERS),
    nav = layoutNav(REFERENCE_LAYOUT),
    reach = nav.field(nav.nodeAt(SEEKER_SPAWN.x, SEEKER_SPAWN.y, SEEKER_SPAWN.z));
  let short = 0,
    total = 0;
  for (const n of nav.nodes.filter((node, k) => k % 3 === 0 && !nav.blocked[node.id] && Number.isFinite(reach.dist[node.id]))) {
    for (let k = 0; k < 8; k++) {
      const yaw = (k / 8) * Math.PI * 2,
        pivot = { x: n.x, y: n.y + 0.78 + PROP_CAMERA.seeker.pivotHeight, z: n.z };
      const pose = propCameraPose(blockers, PROP_CAMERA.seeker, PROP_CAMERA.seeker.boom, pivot, yaw, PROP_CAMERA.seeker.restPitch, { boom: null }, 1 / 60);
      assert.ok(!insideBlockers(blockers, pose.position, 0.02), `camera inside geometry at (${n.x}, ${n.y}, ${n.z}) yaw ${k}`);
      total++;
      if (pose.boom < 2) short++;
    }
  }
  assert.ok(short / total < 0.3, `boom < 2 m in ${Math.round((100 * short) / total)}% of samples`);
  void aimDirection;
});

test("visuals: generated arena mesh + glass, kit trees outside the camp (≥ TREE_CLEARANCE), every hide-spot bot plan legal", () => {
  const arena = buildPropArena();
  assert.equal(arena.group.children.length, 2);
  assert.ok(arena.triangles < 20000, `${arena.triangles} triangles`);
  arena.dispose();
  for (const t of forestPlacements()) assert.ok(Math.max(Math.abs(t.x), Math.abs(t.z)) >= CAMP.half + TREE_CLEARANCE - 0.61, `tree at (${t.x.toFixed(1)}, ${t.z.toFixed(1)})`);
  const spots = hideSpots(REFERENCE_LAYOUT);
  assert.ok(spots.length >= 40, `${spots.length} hide spots`);
  for (const s of spots) {
    assert.equal(DECOYS[s.decoy].family, s.family);
    assert.ok(!KEEP_CLEAR.some((k) => s.x > k.x0 && s.x < k.x1 && s.z > k.z0 && s.z < k.z1));
  }
});

// ─── Bots ───────────────────────────────────────────────────────────────────

test("bots: hider bots reach a legal spot and disguise as a family that stands there (a same-family decoy within reach) before the search", () => {
  for (const seed of [1, 2, 3]) {
    const g = new PropHuntGame(silentFeedback, { roles: SEEKER_FIRST, seed });
    const rnd = mulberry32(seed),
      bots = [new HiderBot(1, rnd), new HiderBot(2, rnd)];
    while (g.round.phase !== "search") g.step([IDLE_INPUT, bots[0].update(g), bots[1].update(g)]);
    for (const bot of bots) {
      const worn = g.disguiseOf(bot.id);
      assert.ok(worn, `seed ${seed}: bot ${bot.id} disguised (${bot.mode})`);
      const p = worn!.body.translation();
      const twin = g.decoys.some((d) => d.family === worn!.family && Math.hypot(d.x - p.x, d.z - p.z) < 3.5);
      assert.ok(twin, `seed ${seed}: bot ${bot.id} ${worn!.family} has a same-family decoy nearby`);
      assert.ok(Math.hypot(p.x - SEEKER_SPAWN.x, p.z - SEEKER_SPAWN.z) > 3, "not at the seeker's feet");
    }
    g.dispose();
  }
});

test("bots: the seeker bot is not omniscient — hiders disguised out of its sight are never targeted, it shoots nothing it has not seen", () => {
  const g = game(SEEKER_FIRST, "hiding");
  // Two hiders disguised inside the shed (closed but for its south door, which the plaza cannot see into).
  disguiseAt(g, 1, 7.6, -7.4, 0);
  disguiseAt(g, 2, 9.4, -9.2, 0);
  while (g.round.phase !== "search") g.step(IDLE);
  const bot = new SeekerBot(0, mulberry32(4));
  // Held at the plaza, looking south for 8 s.
  for (let t = 0; t < 60 * 8; t++) {
    const input = bot.update(g);
    g.step([{ ...input, x: 0, z: 0, facing: 0, attack: false }, IDLE_INPUT, IDLE_INPUT]);
  }
  for (const [key, m] of bot.memory) assert.ok(!(key.startsWith("p:") && m.x > 6.5 && m.z < -5.5), `it never saw the shed's props (${key})`);
  assert.equal(g.stats.shots, 0);
  g.dispose();
});

test("bots: whole bot-only rounds — the seeker respects its 15 shots, both sides can win, no physics faults", () => {
  let seekerWins = 0,
    hiderWins = 0;
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    const g = new PropHuntGame(silentFeedback, { roles: SEEKER_FIRST, seed });
    const rnd = mulberry32(seed),
      seeker = new SeekerBot(0, rnd),
      hiders = [new HiderBot(1, rnd), new HiderBot(2, rnd)];
    let shots = 0;
    while (g.round.phase !== "results") {
      g.step([seeker.update(g), hiders[0].update(g), hiders[1].update(g)]);
      shots += g.events.filter((e) => e.type === "shot").length;
    }
    assert.ok(shots <= PROP_HUNT.seeker.ammo);
    assert.equal(g.physics.diagnostics.invalidBodies, 0);
    if (g.round.outcome === "seeker") seekerWins++;
    else hiderWins++;
    g.dispose();
  }
  assert.ok(seekerWins + hiderWins === 6);
});

test("deterministic: the same inputs give the same round (bots with a seed included)", () => {
  const run = () => {
    const g = new PropHuntGame(silentFeedback, { roles: SEEKER_FIRST });
    const rnd = mulberry32(21),
      seeker = new SeekerBot(0, rnd),
      hiders = [new HiderBot(1, rnd), new HiderBot(2, rnd)];
    const trace: number[] = [];
    for (let t = 0; t < 60 * 40; t++) {
      g.step([seeker.update(g), hiders[0].update(g), hiders[1].update(g)]);
      if (t % 30 === 0) for (const c of g.physics.players) trace.push(c.body.translation().x, c.body.translation().z);
    }
    trace.push(g.ammo, ...g.round.alive.map(Number), g.round.tick);
    g.dispose();
    return trace;
  };
  assert.deepEqual(run(), run());
});

// ─── The lodge stair ────────────────────────────────────────────────────────

test("stair: drawn from its collider — every tread's nose on the ramp, never more than a riser under it; the top tread meets the loft floor (the last riser is the loft deck's edge); the foot rises from the lodge floor; the kit model is gone", () => {
  const ramp = PROP_HUNT_MAP.colliders.find((c) => c.role === "stairs")!,
    loft = PROP_HUNT_MAP.colliders.find((c) => c.role === "loft")!,
    steps = stairSteps(),
    rise = (STAIR.top - STAIR.bottom) / STAIR_RISERS,
    run = (STAIR.x[1] - STAIR.x[0]) / STAIR_RISERS,
    z = (STAIR.z[0] + STAIR.z[1]) / 2;
  assert.equal(steps.length, STAIR_RISERS - 1);
  steps.forEach((step, k) => {
    assert.ok(Math.abs(colliderTop(ramp, step.x0, z) - step.top) < 1e-9, `nose ${k + 1} on the ramp`);
    assert.ok(colliderTop(ramp, step.x1, z) - step.top <= rise + 1e-9, `tread ${k + 1} under the ramp by ≤ a riser`);
    if (k > 0) assert.ok(Math.abs(step.x0 - steps[k - 1].x1) < 1e-9 && Math.abs(step.top - steps[k - 1].top - rise) < 1e-9, `step ${k + 1} follows on`);
  });
  const first = steps[0],
    last = steps[steps.length - 1];
  assert.ok(Math.abs(first.top - rise - LODGE.floor) < 1e-9 && Math.abs(first.x0 - (STAIR.x[0] + run)) < 1e-9, "the first riser rises from the lodge floor");
  assert.ok(Math.abs(last.x1 - LOFT.x[0]) < 1e-9, "the top tread runs right to the loft's edge");
  assert.ok(Math.abs(last.top + rise - LOFT.top) < 1e-9, "one riser up is the loft floor");
  // The collider agrees: the ramp tops out at the loft deck's top, at the deck's edge.
  assert.equal(top(loft), LOFT.top);
  assert.ok(Math.abs(colliderTop(ramp, STAIR.x[1], z) - LOFT.top) < 1e-9 && STAIR.x[1] === LOFT.x[0]);
  // Comfortable, the slope unchanged (26.6°).
  assert.ok(rise <= 0.17 && run >= 0.3, `${rise.toFixed(3)} m risers, ${run.toFixed(2)} m treads`);
  assert.ok(Math.abs((Math.atan2(rise, run) * 180) / Math.PI - 26.57) < 0.1);
  // The arena mesh has the top tread's back edge exactly at the loft edge; no kit stair any more.
  const arena = buildPropArena(),
    position = (arena.group.children[0] as unknown as { geometry: { getAttribute(n: string): { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number } } }).geometry.getAttribute("position");
  let edge = 0;
  for (let i = 0; i < position.count; i++) if (Math.abs(position.getX(i) - LOFT.x[0]) < 1e-5 && Math.abs(position.getY(i) - last.top) < 1e-5 && position.getZ(i) >= STAIR.z[0] - 1e-5 && position.getZ(i) <= STAIR.z[1] + 1e-5) edge++;
  assert.ok(edge >= 2, "the top tread's back edge meets the loft edge");
  arena.dispose();
  assert.ok(!(PROP_KIT_NODES as readonly string[]).includes("Stair"));
  assert.ok(!detailPlacements().some((p) => (p.node as string) === "Stair"));
});

test("stair (real ragdoll): up and down; a disguised stump and a disguised crate up and down; bots plan over it; no jump or drop through a wall or a window", () => {
  const g = game();
  retire(g.physics.players[1]);
  retire(g.physics.players[2]);
  place(g, 0, -10.2, -8.0, Math.PI);
  const up = walk(g, 0, [[-10.2, -9.8], [-9.3, -9.8], [-3.6, -9.8], [-2.5, -9.6]], 8);
  assert.ok(Math.abs(up.feet - LOFT.top) < 0.05, `up: ${up.feet.toFixed(2)}`);
  const down = walk(g, 0, [[-3.6, -9.8], [-9.6, -9.8], [-10.2, -8.2]], 8);
  assert.ok(Math.abs(down.feet - LODGE.floor) < 0.05 && down.x < -9.5, `down: ${down.x.toFixed(2)}, ${down.feet.toFixed(2)}`);
  g.dispose();
  const skin = PROP_HUNT.disguise.skin;
  for (const [x, z, family] of [
    [2.9, -5.9, "stump"],
    [8.2, -9.4, "crate"],
  ] as const) {
    const h = game();
    const worn = disguiseAt(h, 0, x, z, Math.PI);
    assert.equal(worn?.family, family);
    const drive = (tx: number, tz: number, seconds: number) => {
      for (let t = 0; t < seconds * 60; t++) {
        const b = worn!.body.translation(),
          dx = tx - b.x,
          dz = tz - b.z,
          d = Math.hypot(dx, dz);
        if (d < 0.1) break;
        h.step(press(0, { x: dx / d, z: dz / d }));
        if (h.round.tick > 60 * 5) h.round.tick = 60;
      }
      return { ...worn!.body.translation() };
    };
    worn!.body.setTranslation({ x: -10.2, y: LODGE.floor + skin, z: -9.8 }, true);
    steps(h, 0.2);
    let at = drive(-9.3, -9.8, 2);
    at = drive(-2.8, -9.8, 7);
    assert.ok(at.x > -3.3 && Math.abs(at.y - skin - LOFT.top) < 0.03, `${family} up: x ${at.x.toFixed(2)}, y ${at.y.toFixed(2)}`);
    at = drive(-10.1, -9.8, 7);
    steps(h, 0.5);
    at = { ...worn!.body.translation() };
    assert.ok(at.x < -9.6 && Math.abs(at.y - skin - LODGE.floor) < 0.03, `${family} down: x ${at.x.toFixed(2)}, y ${at.y.toFixed(2)}`);
    h.dispose();
  }
  // Bots: the route from the great room to the loft climbs the stair's nodes.
  const nav = layoutNav(REFERENCE_LAYOUT),
    field = nav.field(nav.nodeAt(-6.5, LODGE.floor + 0.78, -8.2)),
    path = nav.path(field, nav.nodeAt(-1.5, LOFT.top + 0.78, -9.4));
  const onStair = path.map((id) => nav.nodes[id]).filter((n) => n.x > STAIR.x[0] && n.x < STAIR.x[1] && n.z > STAIR.z[0] && n.z < STAIR.z[1]);
  assert.ok(onStair.length >= 8 && onStair.every((n, k) => k === 0 || n.y >= onStair[k - 1].y - 1e-9), `${onStair.length} stair nodes, rising`);
  // No jump, drop, hop or leap through a wall or a pane (walks are barrier-checked already).
  const walls = PROP_HUNT_MAP.colliders.filter((c): c is Extract<ArenaCollider, { shape: "box" }> => (c.role === "wall" || c.role === "glass") && c.shape === "box");
  const bare = propNav();
  bare.nodes.forEach((a) => {
    for (const e of bare.edges[a.id]) {
      if (e.kind === "walk") continue;
      const b = bare.nodes[e.to],
        y = Math.max(a.y, b.y) + 0.5;
      for (let k = 1; k < 10; k++) {
        const x = a.x + ((b.x - a.x) * k) / 10,
          zz = a.z + ((b.z - a.z) * k) / 10;
        assert.ok(!walls.some((w) => Math.abs(x - w.center.x) < w.half.x && Math.abs(zz - w.center.z) < w.half.z && Math.abs(y - w.center.y) < w.half.y), `${e.kind} (${a.x}, ${a.z}) → (${b.x}, ${b.z}) through a wall`);
      }
    }
  });
});

// ─── The periodic whistle ───────────────────────────────────────────────────

/** A game whose feedback cues are kept (the whistle must make none). */
function listened(roles: PropRole[]) {
  const cues: FeedbackEvent[] = [];
  const g = new PropHuntGame((e) => cues.push(e), { roles, layout: REFERENCE_LAYOUT });
  while (g.round.phase !== "hiding") g.step(IDLE);
  return { g, cues };
}
/** Search ticks of the four whistle calls (60, 45, 30 and 15 s left). */
const CALLS = WHISTLE_TICKS;
const STAGGER = PROP_TICKS.whistleStagger;
/** Every whistle of the rest of this search: [slot, search tick, seconds left]. */
function whistlesOf(g: PropHuntGame, each: () => MovementInput[] = () => IDLE) {
  const heard: [PlayerId, number, number][] = [];
  while (g.round.phase === "search") {
    g.step(each());
    for (const e of g.events) if (e.type === "whistle") heard.push([e.id, g.round.tick, Math.round(g.round.remaining * 100) / 100]);
  }
  return heard;
}

test("whistle: every 15 s of the search — at 60, 45, 30 and 15 s left (none at 10 s, none at any other time) — each hidden hider whistles once per call, slot order 0.6 s apart, from its prop's middle or its chest; nothing else changes", () => {
  assert.equal(PROP_HUNT.whistle.every, 15);
  assert.equal(PROP_HUNT.timing.search, 75);
  assert.deepEqual([...WHISTLE_TIMES], [60, 45, 30, 15]);
  assert.deepEqual([...CALLS], [900, 1800, 2700, 3600]);
  assert.equal(STAGGER, 36);
  const { g, cues } = listened(SEEKER_FIRST);
  const worn = disguiseAt(g, 1, 4.3, -4.6, 0)!;
  assert.ok(worn);
  place(g, 2, -1.0, 1.55, 0);
  while (g.round.phase !== "search") g.step(IDLE);
  const prop = { ...worn.body.translation() },
    ammo = g.ammo,
    cueCount = cues.length;
  const heard: { id: PlayerId; tick: number; remaining: number; at: { x: number; y: number; z: number }; disguised: boolean; chest: { x: number; y: number; z: number } }[] = [];
  while (g.round.phase === "search") {
    g.step(IDLE);
    for (const e of g.events)
      if (e.type === "whistle") heard.push({ id: e.id, tick: g.round.tick, remaining: g.round.remaining, at: e.at, disguised: e.disguised, chest: { ...g.physics.players[e.id].parts.torso.body.translation() } });
    assert.ok(!g.events.some((e) => e.type === "found" || e.type === "refused" || e.type === "disguise" || e.type === "undisguise"));
  }
  // Four calls, both hiders each time, slot order, 0.6 s apart — and nothing else.
  assert.deepEqual(
    heard.map((h) => [h.id, h.tick]),
    CALLS.flatMap((t) => [
      [1, t],
      [2, t + STAGGER],
    ])
  );
  assert.deepEqual(
    heard.filter((h) => h.id === 1).map((h) => h.remaining),
    [60, 45, 30, 15],
    "the first of each call at exactly 60, 45, 30 and 15 s left"
  );
  assert.ok(!heard.some((h) => h.remaining < 14), "no whistle at 10 s (or later)");
  // The disguised hider's whistle comes from its prop (its middle); the other from its chest.
  for (const h of heard.filter((x) => x.id === 1)) {
    assert.equal(h.disguised, true);
    assert.ok(Math.abs(h.at.x - prop.x) < 1e-6 && Math.abs(h.at.z - prop.z) < 1e-6 && Math.abs(h.at.y - (prop.y + shapeHeight(PROP_FAMILIES[worn.family].shape) / 2)) < 1e-6, "from the disguise itself");
  }
  for (const h of heard.filter((x) => x.id === 2)) {
    assert.equal(h.disguised, false);
    assert.ok(Math.hypot(h.at.x - h.chest.x, h.at.y - h.chest.y, h.at.z - h.chest.z) < 0.05);
  }
  // Nothing else changed: no reveal, no cue, the prop where it was, ammo and roster the same.
  assert.equal(g.disguiseOf(1), worn);
  assert.ok(Math.hypot(worn.body.translation().x - prop.x, worn.body.translation().z - prop.z) < 1e-6);
  assert.equal(g.ammo, ammo);
  assert.deepEqual(g.round.alive, [true, true, true]);
  assert.equal(cues.filter((c) => c.name !== "winner").length, cueCount, "the whistle is not a shared sound cue");
  assert.deepEqual(g.whistles, [0, 4, 4]);
  g.dispose();
});

test("whistle: a found hider stops whistling (the next call is the other alone); found between the two of a call, the second never sounds; a round decided early stops them; the next round starts the schedule again", () => {
  // Hider 2 found between the first and second call: hider 1 alone from the second call on.
  let { g } = listened(SEEKER_FIRST);
  assert.ok(disguiseAt(g, 1, 4.3, -4.6, 0));
  while (g.round.phase !== "search") g.step(IDLE);
  while (g.round.tick < CALLS[0] + STAGGER + 30) g.step(IDLE);
  assert.ok(shootAt(g, pelvis(g, 2), 0, (hit) => hit?.hit === "hider" && hit.target === 2));
  assert.equal(g.round.alive[2], false);
  assert.deepEqual(
    whistlesOf(g).map(([id, tick]) => [id, tick]),
    CALLS.slice(1).map((t) => [1, t])
  );
  assert.deepEqual(g.whistles, [0, 4, 1]);
  // The next round: both hiders again, from the first call.
  let event = null;
  while (event !== "reset") event = g.step(IDLE);
  assert.deepEqual(g.whistles, [0, 0, 0]);
  while (g.round.phase !== "search") g.step(IDLE);
  assert.deepEqual(
    whistlesOf(g).map(([id, tick]) => [id, tick]),
    CALLS.flatMap((t) => [
      [1, t],
      [2, t + STAGGER],
    ])
  );
  g.dispose();
  // Found between the two whistles of the 45 s call: its second never sounds, and it never whistles again.
  ({ g } = listened(SEEKER_FIRST));
  place(g, 2, -1.0, 1.55, 0);
  while (g.round.phase !== "search") g.step(IDLE);
  place(g, 0, -1.0, 4.2, Math.PI);
  const aim = () => aimAt(g, pelvis(g, 2).x, pelvis(g, 2).y, pelvis(g, 2).z);
  let heard: [PlayerId, number, number][] = [];
  while (g.round.tick < CALLS[1] + 10) {
    g.step(press(0, aim()));
    for (const e of g.events) if (e.type === "whistle") heard.push([e.id, g.round.tick, 0]);
  }
  g.step(press(0, { ...aim(), attack: true }));
  assert.equal(g.round.alive[2], false, "hider 2 found ⅙ s into the 45 s call");
  heard = heard.concat(whistlesOf(g));
  assert.deepEqual(
    heard.filter(([id]) => id === 2).map(([, tick]) => tick),
    [CALLS[0] + STAGGER],
    "hider 2 whistled at the 60 s call only"
  );
  assert.deepEqual(
    heard.filter(([id]) => id === 1).map(([, tick]) => tick),
    [...CALLS]
  );
  g.dispose();
  // Both found before the first call: the round is over, no whistle at all.
  ({ g } = listened(SEEKER_FIRST));
  while (g.round.phase !== "search") g.step(IDLE);
  assert.ok(shootAt(g, pelvis(g, 1), 0, (hit) => hit?.hit === "hider" && hit.target === 1));
  assert.ok(shootAt(g, pelvis(g, 2), 0, (hit) => hit?.hit === "hider" && hit.target === 2));
  assert.equal(g.round.phase, "results");
  for (let t = 0; t < PROP_TICKS.results; t++) {
    g.step(IDLE);
    assert.ok(!g.events.some((e) => e.type === "whistle"));
  }
  g.dispose();
});

test("whistle audio: positional and rough — equal-power panning toward its side, a centred share, fainter far away, muffled through walls; mute and the voice limit apply; no marker anywhere", async () => {
  class Param {
    value = 0;
    setTargetAtTime(v: number) {
      this.value = v;
    }
  }
  class Node {
    connected: Node[] = [];
    connect(n: Node) {
      this.connected.push(n);
      return n;
    }
    disconnect() {}
  }
  const make = (panner: boolean) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const made: Record<string, any[]> = { gain: [], pan: [], panner: [], filter: [] };
    const ctx = {
      state: "suspended",
      currentTime: 0,
      destination: new Node(),
      listener: { positionX: new Param(), positionY: new Param(), positionZ: new Param(), forwardX: new Param(), forwardY: new Param(), forwardZ: new Param(), upX: new Param(), upY: new Param(), upZ: new Param() },
      async resume() {
        this.state = "running";
      },
      async decodeAudioData() {
        return {} as AudioBuffer;
      },
      createGain: () => {
        const n = Object.assign(new Node(), { gain: new Param() });
        made.gain.push(n);
        return n;
      },
      createDynamicsCompressor: () => Object.assign(new Node(), { threshold: new Param(), knee: new Param(), ratio: new Param() }),
      createStereoPanner: () => {
        const n = Object.assign(new Node(), { pan: new Param() });
        made.pan.push(n);
        return n;
      },
      createBiquadFilter: () => {
        const n = Object.assign(new Node(), { type: "", frequency: new Param() });
        made.filter.push(n);
        return n;
      },
      ...(panner
        ? {
            createPanner: () => {
              const n = Object.assign(new Node(), { panningModel: "", distanceModel: "", refDistance: 0, rolloffFactor: 0, maxDistance: 0, positionX: new Param(), positionY: new Param(), positionZ: new Param() });
              made.panner.push(n);
              return n;
            },
          }
        : {}),
      createBuffer: (_c: number, length: number) => {
        const data = new Float32Array(length);
        return { getChannelData: () => data };
      },
      createBufferSource: () => Object.assign(new Node(), { buffer: null, playbackRate: new Param(), onended: null, start() {}, stop() {} }),
      async close() {},
      async suspend() {},
    };
    return { ctx, made };
  };
  // With a PannerNode: equal-power (no HRTF front/back or height cues), the inverse model, placed at the source.
  let { ctx, made } = make(true);
  let audio = new AudioManager(() => ctx as unknown as AudioContext);
  await audio.unlock();
  audio.setListener({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 });
  assert.equal(ctx.listener.forwardZ.value, -1);
  assert.ok(audio.playSpatial("propWhistle", WHISTLE_RECIPE, { x: 5, y: 1, z: 0 }, WHISTLE_AUDIO));
  const panner = made.panner[0];
  assert.equal(panner.panningModel, "equalpower");
  assert.equal(panner.distanceModel, "inverse");
  assert.equal(panner.refDistance, WHISTLE_AUDIO.refDistance);
  assert.equal((panner.positionX as Param).value, 5);
  // Only part of it is panned; the rest plays centred (a rough direction, never exact).
  assert.ok(made.gain.some((g) => Math.abs((g.gain as Param).value - WHISTLE_AUDIO.spatial) < 1e-9));
  assert.ok(WHISTLE_AUDIO.spatial > 0.3 && WHISTLE_AUDIO.spatial < 0.8);
  const beforeSense = audio.voices.voices.size;
  audio.playSpatial("propSense", SENSE_RECIPE, { x: 0, y: 1, z: 0 }, SENSE_AUDIO);
  assert.equal(audio.voices.voices.size, beforeSense + 1);
  audio.stopSpatial("propSense");
  assert.equal(audio.voices.voices.size, beforeSense, "switching the clue off stops only its heartbeat");
  audio.stopSpatial("propSense");
  assert.equal(audio.voices.voices.size, beforeSense, "repeat cancellation preserves the whistle");
  audio.dispose();
  // Without one: a stereo pan toward its side and the same falloff; a muffle when a wall is in the way.
  ({ ctx, made } = make(false));
  audio = new AudioManager(() => ctx as unknown as AudioContext);
  await audio.unlock();
  audio.setListener({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 });
  audio.playSpatial("propWhistle", WHISTLE_RECIPE, { x: 4, y: 1, z: 0 }, WHISTLE_AUDIO);
  audio.playSpatial("propWhistle", WHISTLE_RECIPE, { x: -18, y: 1, z: 0 }, { ...WHISTLE_AUDIO, muffle: 900 });
  assert.ok((made.pan[0].pan as Param).value > 0.9, "east of a listener facing north: right");
  assert.ok((made.pan[1].pan as Param).value < -0.9, "west: left");
  assert.equal(made.filter.length, 1);
  assert.equal((made.filter[0].frequency as Param).value, 900);
  assert.ok(inverseDistanceGain(18, WHISTLE_AUDIO) < inverseDistanceGain(4, WHISTLE_AUDIO) * 0.4, "fainter far away");
  assert.ok(inverseDistanceGain(20, WHISTLE_AUDIO) > 0.1, "never silent across the camp");
  audio.setSettings({ ...audio.settings, muted: true });
  assert.equal(audio.playSpatial("propWhistle", WHISTLE_RECIPE, { x: 4, y: 1, z: 0 }, WHISTLE_AUDIO), false);
  audio.dispose();
  void quiet;
  // No marker: neither the HUD nor the visuals know about whistles.
  for (const file of ["./prophunt/PropHuntHud.tsx", "./prophunt/visuals.ts"]) assert.ok(!/whistle|ıslık/i.test(readFileSync(new URL(file, import.meta.url), "utf8")), file);
});

// ─── Regression ─────────────────────────────────────────────────────────────

test("regression: online integration — the six modes, Mixed, the protocol (9) and the static map registry are unchanged", () => {
  assert.deepEqual([...GAME_MODES], ["rooftop_brawl", "barn_shootout", "layer_chaos", "color_chaos", "bomb_tag", "prop_hunt"]);
  assert.ok((MODE_SELECTIONS as readonly string[]).includes(PROP_HUNT.mode));
  assert.equal(NET.version, 9);
  assert.deepEqual([...ARENA_MAP_IDS].sort(), ["barn", "rooftop", "test"]);
  assert.equal(shapeHeight(PROP_FAMILIES.crate.shape), 0.92);
});


test("manual whistle: chest/disguise sources, independent per-hider cooldown, no automatic schedule changes", () => {
  const g = game(SEEKER_FIRST, "search");
  const at = { x: 4.3, y: PROP_HUNT.disguise.skin, z: -4.8 };
  retire(g.physics.players[1]);
  const worn = g.disguises.wear(1, "crate", at, 0);
  g.round.tick = WHISTLE_TICKS[0] - 121;
  const ammo = g.ammo;
  g.step(IDLE, [1, 2, 0]);
  const calls = g.events.filter((e) => e.type === "whistle");
  assert.equal(calls.length, 2, "the seeker cannot whistle");
  for (const e of calls) {
    assert.equal(e.disguised, e.id === 1);
    const expected = e.id === 1 ? { ...worn.body.translation(), y: worn.body.translation().y + shapeHeight(PROP_FAMILIES.crate.shape) / 2 } : { ...g.physics.players[2].parts.torso.body.translation() };
    assert.deepEqual(e.at, expected);
  }
  assert.deepEqual(g.manualWhistles, [0, 1, 1]);
  assert.deepEqual(g.whistles, [0, 0, 0]);
  assert.equal(g.ammo, ammo);
  assert.equal(g.round.tick, WHISTLE_TICKS[0] - 120);
  g.step(IDLE, [1, 2]);
  assert.equal(g.events.filter((e) => e.type === "whistle").length, 0);
  assert.equal(g.events.filter((e) => e.type === "whistleCooldown").length, 2);
  while (g.round.tick < WHISTLE_TICKS[0]) g.step(IDLE);
  assert.ok(g.events.some((e) => e.type === "whistle" && e.id === 1), "automatic whistle while manual is cooling down");
  assert.equal(g.manualWhistleCooldown[1], PROP_TICKS.manualWhistleCooldown - 120);
  while (g.round.tick < WHISTLE_TICKS[0] + PROP_TICKS.whistleStagger) g.step(IDLE);
  assert.deepEqual(g.whistles, [0, 1, 1]);
  assert.equal(g.manualWhistleCooldown[2], PROP_TICKS.manualWhistleCooldown - 120 - PROP_TICKS.whistleStagger);
  while (g.manualWhistleCooldown[1] > 1) g.step(IDLE);
  g.step(IDLE, [1]);
  assert.deepEqual(g.manualWhistles, [0, 2, 1]);
  g.step(IDLE, [1, 2]);
  assert.deepEqual(g.manualWhistles, [0, 2, 2], "second hider has an independent clock");
  g.round.alive[1] = false;
  g.manualWhistleCooldown[1] = 0;
  g.step(IDLE, [1]);
  assert.ok(!g.events.some((e) => e.type === "whistle" && e.id === 1));
  g.reset();
  assert.deepEqual(g.manualWhistleCooldown, [0, 0, 0]);
  g.step(IDLE, [1]);
  assert.ok(!g.events.some((e) => e.type === "whistle"), "countdown cannot taunt");
  g.dispose();
});

test("manual whistle: hiding allowed, results forbidden, Q fallback respects saved bindings", () => {
  const g = game();
  g.step(IDLE, [0]);
  assert.ok(g.events.some((e) => e.type === "whistle" && e.id === 0));
  assert.equal(PROP_TICKS.manualWhistleCooldown, 480);
  g.round.phase = "results";
  g.manualWhistleCooldown[0] = 0;
  g.step(IDLE, [0]);
  assert.ok(!g.events.some((e) => e.type === "whistle"));
  g.dispose();
  const defaults = defaultBindings();
  assert.equal(whistleKey(defaults), "KeyQ");
  const custom = { ...defaults, jump: ["KeyQ", "KeyT"] as const };
  assert.equal(whistleKey(custom), "KeyR");
  assert.match(controlHint(custom, "propHider"), /R · Islık/);
  assert.ok(!controlHint(defaults, "propSeeker").includes("Islık"));
});

test("stair visual: solid panel from kitchen, both sides and floor underside within the existing ramp", () => {
  const arena = buildPropArena();
  arena.group.updateMatrixWorld(true);
  const ray = new Raycaster();
  const hitAt = (p: number[], d: number[], distance: number) => {
    ray.set(new Vector3(...p), new Vector3(...d));
    const hits = ray.intersectObject(arena.group, true);
    assert.ok(hits.length && Math.abs(hits[0].distance - distance) < 0.01, `ray ${p} hits stair skin at ${distance}, got ${hits[0]?.distance}`);
  };
  const x = (STAIR.x[0] + STAIR.x[1]) / 2, z = (STAIR.z[0] + STAIR.z[1]) / 2;
  // Just outside each skin, away from the treads and from surrounding walls/floors.
  hitAt([STAIR.x[1] + 0.05, 2, z], [-1, 0, 0], 0.05);
  hitAt([x, 1, STAIR.z[1] + 0.05], [0, 0, -1], 0.05);
  hitAt([x, 1, STAIR.z[0] - 0.05], [0, 0, 1], 0.05);
  arena.dispose();
});
