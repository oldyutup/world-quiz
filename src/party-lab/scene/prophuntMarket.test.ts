import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { silentFeedback } from "../audio/events";
import type { MovementInput } from "../input/types";
import { initializePhysics, IDLE_INPUT } from "./physics";
import type { PlayerId } from "./players";
import { restore } from "./ragdoll/character";
import { PropHuntGame } from "./prophunt/game";
import { BOT_MAPS, HiderBot, hideSpots, layoutNav, propNav, SeekerBot } from "./prophunt/bots";
import { PROP_CAMERA, propCameraBlockers, propCameraPose } from "./prophunt/propCamera";
import { MARKET_KIT_NODES } from "./prophunt/market/scenery";
import { buildMarketArena } from "./prophunt/market/arena";
import {
  CHECKOUTS,
  GONDOLAS,
  MARKET,
  MARKET_COLLIDERS,
  MARKET_FIXTURES,
  MARKET_HIDER_SPAWNS,
  MARKET_MAP,
  MARKET_ROUTES,
  MARKET_SEEKER_SPAWN,
  marketSurfaceBelow,
  marketZoneAt,
} from "../../../shared/party-lab/maps/market";
import { MARKET_DEALER, MARKET_LAYOUT_TUNING } from "../../../shared/party-lab/maps/marketLayout";
import { MARKET_SCENE_SET } from "../../../shared/party-lab/maps/marketScenes";
import { MARKET_FAMILY_IDS, PROP_FAMILIES, shapeSpan, type PropFamilyId } from "../../../shared/party-lab/maps/propHuntProps";
import { PROP_MAPS, pickPropMap } from "../../../shared/party-lab/maps/propMaps";
import { variantItems } from "../../../shared/party-lab/maps/propScenes";
import type { PropLayout } from "../../../shared/party-lab/maps/propDealer";
import type { ArenaCollider } from "../../../shared/party-lab/maps/types";
import { senses, senseSolids } from "../../../shared/party-lab/simulation/prophunt/proximity";
import { mulberry32 } from "../../../shared/party-lab/simulation/colors/layouts";

before(() => initializePhysics());

const IDLE: MovementInput[] = [IDLE_INPUT, IDLE_INPUT, IDLE_INPUT];
const I = MARKET.inside;
const top = (c: ArenaCollider) => (c.shape === "cylinder" ? c.center.y + c.halfHeight : c.center.y + c.half.y);
const bottom = (c: ArenaCollider) => (c.shape === "cylinder" ? c.center.y - c.halfHeight : c.center.y - c.half.y);
function gap(c: ArenaCollider, x: number, z: number) {
  if (c.shape === "cylinder") return Math.max(0, Math.hypot(x - c.center.x, z - c.center.z) - c.radius);
  return Math.hypot(Math.max(0, Math.abs(x - c.center.x) - c.half.x), Math.max(0, Math.abs(z - c.center.z) - c.half.z));
}
const box = (c: ArenaCollider) =>
  c.shape === "cylinder"
    ? { x0: c.center.x - c.radius, x1: c.center.x + c.radius, z0: c.center.z - c.radius, z1: c.center.z + c.radius }
    : { x0: c.center.x - c.half.x, x1: c.center.x + c.half.x, z0: c.center.z - c.half.z, z1: c.center.z + c.half.z };

/** 500 dealt layouts: 10 matches × 50 consecutive rounds. */
const MATCHES = Array.from({ length: 10 }, (_, k) => 211 + k * 7919);
const layouts = new Map<number, PropLayout[]>();
function match(seed: number, rounds = 50): PropLayout[] {
  let list = layouts.get(seed);
  if (!list) {
    list = [];
    for (let r = 0; r < rounds; r++) list.push(MARKET_DEALER.roundLayout(seed, r, list[r - 1] ?? null));
    layouts.set(seed, list);
  }
  return list;
}
const EMPTY = MARKET_DEALER.layoutOf([], null);
/** A market game with no decoys (the architecture only), fast-forwarded into the hiding phase. */
function bare(roles: ("seeker" | "hider")[] = ["hider", "hider", "seeker"]) {
  const g = new PropHuntGame(silentFeedback, { roles, map: "market", layout: EMPTY });
  while (g.round.phase !== "hiding") g.step(IDLE);
  return g;
}
const press = (id: PlayerId, extra: Partial<MovementInput> = {}) => IDLE.map((input, k) => (k === id ? { ...input, ...extra } : input));
const pelvis = (g: PropHuntGame, id: PlayerId) => g.physics.players[id].body.translation();
function place(g: PropHuntGame, id: PlayerId, x: number, z: number, yaw = 0) {
  restore(g.physics.players[id], { x, y: marketSurfaceBelow(x, z) + 0.9, z }, yaw);
}
/** Walk a body through waypoints (plain movement); keeps the phase open; returns where it ends. */
function walk(g: PropHuntGame, id: PlayerId, points: [number, number][], seconds: number, jump = false) {
  let k = 0;
  for (let t = 0; t < seconds * 60; t++) {
    const p = pelvis(g, id);
    while (k < points.length - 1 && Math.hypot(points[k][0] - p.x, points[k][1] - p.z) < 0.35) k++;
    const [x, z] = points[k],
      dx = x - p.x,
      dz = z - p.z,
      d = Math.hypot(dx, dz);
    g.step(press(id, d < 0.1 ? IDLE_INPUT : { x: dx / d, z: dz / d, jump: jump && t % 20 === 0 }));
    if (g.round.tick > 60 * 5) g.round.tick = 60;
  }
  const p = pelvis(g, id);
  return { x: p.x, z: p.z, reached: k === points.length - 1 && Math.hypot(points[k][0] - p.x, points[k][1] - p.z) < 0.6 };
}

// ─── Families and kit ──────────────────────────────────────────────────────

test("market: twelve families, all hider-sized (no side under 0.45 m), small, medium and large mixed", () => {
  assert.equal(MARKET_FAMILY_IDS.length, 12);
  const tiers = new Set<string>();
  for (const id of MARKET_FAMILY_IDS) {
    const { shape, name, tier } = PROP_FAMILIES[id];
    const dims = shape.kind === "box" ? [shape.x, shape.y, shape.z] : [2 * shape.radius, shape.height, 2 * shape.radius];
    assert.ok(Math.min(...dims) >= 0.45 && dims[0] * dims[1] * dims[2] >= 0.2, `${id} is not tiny (${dims})`);
    assert.ok(shapeSpan(shape) <= 2.0, `${id} is not enormous`);
    assert.ok(name.length > 2, `${id} has a Turkish name`);
    tiers.add(tier);
  }
  assert.deepEqual([...tiers].sort(), ["L", "M", "S"]);
  // The user's examples: cans and bottles (small), the watermelon and the box (medium-ish), the cart and the big crate (large).
  for (const id of ["canTower", "drinkCrate", "watermelon", "parcel", "cart", "produceBin"] as const) assert.ok(MARKET_FAMILY_IDS.includes(id));
});

test("market kit: every node the map draws, each family exactly its gameplay shape (bottom-centre), untextured, one material, small", () => {
  const file = new URL("../../../public/party-lab/maps/prop-hunt/market-kit.glb", import.meta.url);
  const glb = readFileSync(file);
  assert.ok(glb.length < 450 * 1024, `kit ${glb.length} bytes`);
  const length = glb.readUInt32LE(12),
    json = JSON.parse(glb.subarray(20, 20 + length).toString("utf8"));
  const names = json.nodes.map((n: { name: string }) => n.name);
  for (const node of MARKET_KIT_NODES) assert.ok(names.includes(node), `kit has ${node}`);
  for (const id of MARKET_FAMILY_IDS) {
    const family = PROP_FAMILIES[id],
      mesh = json.meshes[json.nodes.find((n: { name: string }) => n.name === family.node).mesh],
      position = json.accessors[mesh.primitives[0].attributes.POSITION];
    const size = position.max.map((v: number, k: number) => v - position.min[k]),
      shape = family.shape,
      want = shape.kind === "box" ? [shape.x, shape.y, shape.z] : [2 * shape.radius, shape.height, 2 * shape.radius];
    assert.ok(Math.abs(position.min[1]) < 1e-3, `${id} bottom at 0`);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(size[k] - want[k]) < 0.02, `${id} size ${size.map((n: number) => n.toFixed(2))} vs ${want}`);
    assert.ok(Math.abs(position.min[0] + position.max[0]) < 0.02 && Math.abs(position.min[2] + position.max[2]) < 0.02, `${id} centred`);
  }
  assert.ok(!json.images && !json.textures);
  assert.equal(json.materials.length, 1);
  assert.equal(json.materials[0].pbrMetallicRoughness.metallicFactor, 0);
  const credits = readFileSync(new URL("../../../public/party-lab/maps/prop-hunt/MARKET-CREDITS.txt", import.meta.url), "utf8");
  assert.match(credits, /Kenney/);
  assert.match(credits, /CC0/);
});

// ─── The map ───────────────────────────────────────────────────────────────

test("market map: one storey 22 × 22 m like the camp, walled all round (glass shop front), 5 m ceiling; the arena mesh builds", () => {
  assert.equal(MARKET.half, PROP_MAPS.camp.half);
  assert.deepEqual(MARKET_MAP.bounds, PROP_MAPS.camp.arena.bounds);
  const solids = MARKET_COLLIDERS.filter((c) => c.role !== "floor");
  // Nothing upstairs: counters, freezers, tables at most ~1 m (the produce rack 1.25 m at the wall); shelves and fridges out of reach.
  for (const c of solids) if (c.role === "furniture") assert.ok(top(c) <= 1.25 || top(c) >= 2.2, `furniture top ${top(c)}`);
  for (const role of ["wall", "glass", "boundary"] as const) assert.ok(solids.some((c) => c.role === role), role);
  // The shop front is glass with walls between: shots and bodies stop at it.
  assert.ok(solids.filter((c) => c.role === "glass" && bottom(c) < 1 && box(c).z0 > I - 0.2).length >= 4);
  for (const f of MARKET_FIXTURES) assert.ok(Math.abs(f.x[0]) <= I + 1e-6 && Math.abs(f.x[1]) <= I + 1e-6 && Math.abs(f.z[0]) <= I + 1e-6 && Math.abs(f.z[1]) <= I + 1e-6, f.kind);
  const arena = buildMarketArena();
  assert.ok(arena.triangles > 3000 && arena.triangles < 60000, `${arena.triangles} triangles`);
  arena.dispose();
  assert.deepEqual(PROP_MAPS.market.structureZones, ["depot", "aisles"]);
});

test("market spawns: on the open floor, clear of every collider; hiders 3 m apart and ≥ 6 m from the seeker (the camp's rule)", () => {
  for (const s of [MARKET_SEEKER_SPAWN, ...MARKET_HIDER_SPAWNS]) {
    assert.equal(marketSurfaceBelow(s.x, s.z), 0);
    for (const c of MARKET_COLLIDERS) {
      if (c.role === "floor") continue;
      assert.ok(gap(c, s.x, s.z) >= 0.45, `spawn (${s.x}, ${s.z}) near ${c.role} (${gap(c, s.x, s.z).toFixed(2)})`);
    }
  }
  assert.ok(Math.abs(Math.hypot(MARKET_HIDER_SPAWNS[0].x - MARKET_HIDER_SPAWNS[1].x, MARKET_HIDER_SPAWNS[0].z - MARKET_HIDER_SPAWNS[1].z) - 3) < 1e-6);
  for (const h of MARKET_HIDER_SPAWNS) assert.ok(Math.hypot(h.x - MARKET_SEEKER_SPAWN.x, h.z - MARKET_SEEKER_SPAWN.z) >= 6);
  // The seeker at the entrance, the hiders in the front cross aisle (the camp's logic: the seeker at the edge, the hiders nearer the middle).
  assert.equal(marketZoneAt(MARKET_SEEKER_SPAWN.x, MARKET_SEEKER_SPAWN.z), "entrance");
  for (const h of MARKET_HIDER_SPAWNS) assert.ok(h.z < MARKET_SEEKER_SPAWN.z - 3);
  const g = new PropHuntGame(silentFeedback, { map: "market" });
  for (const id of [0, 1, 2] as PlayerId[]) {
    const s = g.spawnOf(id).at,
      p = pelvis(g, id);
    assert.ok(Math.hypot(p.x - s.x, p.z - s.z) < 0.05);
  }
  g.dispose();
});

// ─── Layouts ───────────────────────────────────────────────────────────────

test("market recipes: every item's slot and family is plausible and has a pose", () => {
  for (const scene of MARKET_SCENE_SET.scenes)
    for (const v of scene.variants)
      for (const item of variantItems(v))
        for (const id of item.slots) {
          const slot = MARKET_SCENE_SET.slotById(id)!;
          assert.ok(slot && slot.scene === scene.id, `${scene.id}/${v.id}: slot ${id}`);
          for (const f of item.families) {
            assert.ok(MARKET_SCENE_SET.contextFamilies[slot.context].includes(f), `${id}: ${f} in a ${slot.context} slot`);
            assert.ok(MARKET_DEALER.slotPoses(slot, f).length > 0, `${scene.id}/${v.id}: ${id} ${f} has no pose (${MARKET_DEALER.staticRefusal(slot, f)})`);
          }
        }
  // Every family can come from at least two scenes (a family is never tied to one corner).
  for (const f of MARKET_FAMILY_IDS) assert.ok(MARKET_SCENE_SET.scenes.filter((s) => s.variants.some((v) => variantItems(v).some((i) => i.families.includes(f)))).length >= 2, f);
});

test("market layouts, 500 dealt rounds: every family in play with ≥ 3 decoys every round, 58–70 decoys, about half changing, deterministic", () => {
  const counts: number[] = [],
    changes: number[] = [];
  for (const seed of MATCHES) {
    const list = match(seed);
    list.forEach((layout, r) => {
      counts.push(layout.decoys.length);
      assert.deepEqual([...layout.active].sort(), [...MARKET_FAMILY_IDS].sort(), `round ${r}: all twelve in play`);
      for (const f of MARKET_FAMILY_IDS) {
        const n = layout.decoys.filter((d) => d.family === f).length;
        assert.ok(n >= 3, `seed ${seed} round ${r}: ${n} × ${f}`);
      }
      assert.equal(MARKET_DEALER.layoutProblem(layout, list[r - 1] ?? null), null);
      if (r) changes.push(MARKET_DEALER.layoutChange(list[r - 1], layout));
    });
  }
  assert.ok(Math.min(...counts) >= MARKET_LAYOUT_TUNING.count[0] && Math.max(...counts) <= MARKET_LAYOUT_TUNING.count[1], `${Math.min(...counts)}–${Math.max(...counts)}`);
  assert.ok(Math.min(...changes) >= 0.4 && Math.max(...changes) <= 0.6);
  const sorted = [...changes].sort((a, b) => a - b),
    median = sorted[Math.floor(sorted.length / 2)];
  assert.ok(median > 0.45 && median < 0.55, `median change ${median}`);
  // The same match seed deals the same rounds (a room only sends the seed and the map).
  const again: PropLayout[] = [];
  for (let r = 0; r < 4; r++) again.push(MARKET_DEALER.roundLayout(MATCHES[0], r, again[r - 1] ?? null));
  assert.deepEqual(again.map((l) => l.id), match(MATCHES[0]).slice(0, 4).map((l) => l.id));
  assert.equal(MARKET_DEALER.roundLayout(MATCHES[0], 3).id, match(MATCHES[0])[3].id);
});

test("market layouts: every decoy stands on the floor, inside the shop, in its zone, out of every route clearance, overlapping nothing", () => {
  const solids = MARKET_COLLIDERS.filter((c) => c.role !== "floor");
  for (const seed of MATCHES.slice(0, 4))
    for (const layout of match(seed)) {
      layout.decoys.forEach((d, i) => {
        const own = layout.colliders[i],
          b = box(own);
        assert.equal(d.y, 0);
        assert.equal(marketSurfaceBelow(d.x, d.z, 0.1), 0, `${d.family} (${d.x}, ${d.z}) on the floor`);
        assert.ok(b.x0 >= -I - 1e-3 && b.x1 <= I + 1e-3 && b.z0 >= -I - 1e-3 && b.z1 <= I + 1e-3, `${d.family} inside`);
        assert.equal(marketZoneAt(d.x, d.z), d.zone);
        for (const r of MARKET_ROUTES) assert.ok(!(b.x0 < r.x[1] - 0.005 && b.x1 > r.x[0] + 0.005 && b.z0 < r.z[1] - 0.005 && b.z1 > r.z[0] + 0.005), `${d.family} (${d.x}, ${d.z}) in the ${r.label}`);
        for (const c of [...solids, ...layout.colliders.filter((_, k) => k !== i)]) {
          if (bottom(c) >= top(own) - 0.01) continue;
          const o = box(c),
            overlap = Math.min(b.x1, o.x1) - Math.max(b.x0, o.x0) > 0.012 && Math.min(b.z1, o.z1) - Math.max(b.z0, o.z0) > 0.012;
          if (!overlap) continue;
          if (own.shape === "cylinder" || c.shape === "cylinder") {
            const [r, q] = own.shape === "cylinder" ? [own, o] : [c as Extract<ArenaCollider, { shape: "cylinder" }>, b];
            if (Math.hypot(Math.max(q.x0 - r.center.x, 0, r.center.x - q.x1), Math.max(q.z0 - r.center.z, 0, r.center.z - q.z1)) >= r.radius - 0.012) continue;
          }
          assert.fail(`${d.family} (${d.x}, ${d.z}) overlaps ${c.role} at (${c.center.x}, ${c.center.z})`);
        }
      });
    }
});

// ─── Bodies: walls and aisles ──────────────────────────────────────────────

test("market walls hold: running and jumping at the walls, the glass shop front and the depot's walls (both sides) never gets a body through", () => {
  const g = bare();
  // [start x, z, push x, z, the side it must stay on].
  const cases: [number, number, number, number, (x: number, z: number) => boolean, string][] = [
    [-6.0, -8.8, 0, -1, (_, z) => z > -I, "north (over the fridges)"],
    [-9.2, 0.0, -1, 0, (x) => x > -I, "west (over the produce rack)"],
    [9.0, 0.0, 1, 0, (x) => x < I, "east (the drinks wall)"],
    [-3.0, 9.6, 0, 1, (_, z) => z < I, "shop front glass"],
    [7.3, 9.2, 0, 1, (_, z) => z < I, "entrance doors"],
    [4.6, -4.9, 0, -1, (_, z) => z > -6.0, "depot wall from the shop"],
    [4.6, -7.4, 0, 1, (_, z) => z < -6.3, "depot wall from the depot"],
    [2.4, -6.6, 1, 0, (x) => x < 3.5, "depot west wall from the fridges"],
    [9.4, -6.9, 0, 1, (_, z) => z < -6.3, "depot corner"],
  ];
  for (const [x, z, px, pz, inside, label] of cases) {
    place(g, 0, x, z, Math.atan2(px, pz));
    for (let t = 0; t < 60 * 3; t++) {
      g.step(press(0, { x: px, z: pz, jump: t % 25 === 0, sprint: true }));
      if (g.round.tick > 60 * 5) g.round.tick = 60;
      const p = pelvis(g, 0);
      assert.ok(inside(p.x, p.z) && Number.isFinite(p.y) && p.y > -1, `${label}: (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`);
    }
  }
  g.dispose();
});

test("market aisles: a body walks every shelf aisle end to end, both cross aisles, the fridge aisle and through both depot doors without snagging", () => {
  const g = bare();
  const aisles = [
    [-3.7, -1.1],
    [0, 2.6],
    [3.7, 6.3],
    [7.4, 10.0],
  ];
  const routes: [string, [number, number][], number][] = [
    ...aisles.map(([a, b], k): [string, [number, number][], number] => [`aisle ${k + 1}`, [[(a + b) / 2, 4.8], [(a + b) / 2, -4.8]], 5]),
    ["north cross aisle", [[-3.0, -4.9], [9.3, -4.9]], 6],
    ["south cross aisle", [[-9.5, 5.3], [9.3, 5.3]], 7],
    ["fridge aisle", [[-9.0, -8.7], [1.2, -8.7]], 6],
    ["the depot through its shop door", [[7.3, -4.4], [7.3, -8.2]], 4],
    ["out through the side door", [[5.0, -8.3], [1.8, -8.3]], 4],
    ["the gap by the west freezer", [[-10.05, -5.4], [-10.05, -8.6]], 4],
    ["a checkout lane", [[-4.4, 5.6], [-4.4, 10.1]], 4],
  ];
  for (const [label, points, seconds] of routes) {
    place(g, 0, points[0][0], points[0][1]);
    const end = walk(g, 0, points, seconds);
    assert.ok(end.reached, `${label}: stopped at (${end.x.toFixed(2)}, ${end.z.toFixed(2)})`);
  }
  for (const [x0, x1] of GONDOLAS) assert.ok(x1 - x0 > 1 && x1 - x0 < 1.2);
  assert.equal(CHECKOUTS.length, 3);
  g.dispose();
});

// ─── Bots ──────────────────────────────────────────────────────────────────

test("market navigation: the bots' grid reaches every viewpoint and, for 30 dealt layouts, nearly every hide spot (in every zone) from the hiders' spawns", () => {
  const nav = propNav("market"),
    start = nav.nodeAt(MARKET_SEEKER_SPAWN.x, MARKET_SEEKER_SPAWN.y, MARKET_SEEKER_SPAWN.z),
    field = nav.field(start);
  for (const vp of BOT_MAPS.market.viewpoints) assert.ok(Number.isFinite(field.dist[nav.nodeAt(vp.x, vp.y + 0.78, vp.z)]), `viewpoint (${vp.x}, ${vp.z})`);
  // The longest walk from the seeker's spawn is short (the shop is the camp's size, all on one floor).
  const longest = Math.max(...nav.nodes.filter((n) => n.y === 0).map((n) => field.dist[n.id]).filter(Number.isFinite));
  assert.ok(longest / 4.6 < 7, `longest route ${longest.toFixed(1)} m`);
  let spots = 0,
    reached = 0;
  const zones = new Set<string>();
  for (const seed of MATCHES.slice(0, 3))
    for (const layout of match(seed).slice(0, 10)) {
      const lnav = layoutNav(layout, "market"),
        from = lnav.field(lnav.nodeAt(MARKET_HIDER_SPAWNS[0].x, 0.9, MARKET_HIDER_SPAWNS[0].z));
      const list = hideSpots(layout, "market");
      assert.ok(list.length >= 40, `${list.length} hide spots`);
      for (const s of list) {
        spots++;
        // A spot wedged between props and a wall may be off the grid: the bots skip those (HiderBot.choose).
        if (!Number.isFinite(from.dist[lnav.nodeAt(s.x, s.y + 0.78, s.z)])) continue;
        reached++;
        zones.add(s.zone);
      }
    }
  assert.ok(spots > 1000 && reached / spots > 0.95, `${reached} of ${spots} hide spots reachable`);
  for (const z of ["aisles", "produce", "fridges", "depot", "checkout", "entrance"]) assert.ok(zones.has(z), `hide spots in the ${z}`);
});

test("market bots play: hiders reach a spot and disguise, the seeker searches and finds, hiding spread over the shop, no physics faults", () => {
  let rounds = 0,
    disguised = 0,
    finds = 0,
    faults = 0;
  const zones = new Set<string>();
  for (let m = 0; m < 3; m++) {
    const rnd = mulberry32(400 + m),
      g = new PropHuntGame(silentFeedback, { seed: 9100 + m, map: "market" }),
      bots = [new SeekerBot(0, rnd), new HiderBot(1, rnd), new HiderBot(2, rnd)];
    let counted = false;
    while (rounds < (m + 1) * 3) {
      const event = g.step(bots.map((b) => ({ ...b.update(g) })));
      if (g.round.phase === "search" && !counted) {
        counted = true;
        for (const id of [1, 2] as PlayerId[]) {
          const worn = g.disguiseOf(id);
          if (!worn) continue;
          disguised++;
          const b = worn.body.translation();
          zones.add(g.map.zoneAt(b.x, b.z, b.y));
        }
      }
      if (event === "finished") {
        rounds++;
        counted = false;
        finds += g.stats.finds;
      }
      for (const p of g.physics.players) {
        const v = p.body.translation();
        if (!Number.isFinite(v.x) || v.y < -2 || Math.abs(v.x) > 12 || Math.abs(v.z) > 12) faults++;
      }
    }
    g.dispose();
  }
  assert.ok(disguised >= rounds * 2 * 0.85, `${disguised} of ${rounds * 2} hiders disguised`);
  assert.ok(finds >= 2, `${finds} finds in ${rounds} rounds`);
  assert.ok(zones.size >= 3, `hid in ${[...zones]}`);
  assert.equal(faults, 0);
});

// ─── Camera, hunch, map choice ─────────────────────────────────────────────

test("market camera: the boom stays under the 5 m ceiling and inside the walls; the hunch passes shelves but not the depot's walls", () => {
  const blockers = propCameraBlockers([], "market");
  const state = { boom: null as number | null };
  for (const [pivot, yaw, pitch] of [
    [{ x: 1.3, y: 1.9, z: 0 }, Math.PI, 0.95],
    [{ x: -6.0, y: 1.9, z: -8.5 }, 0, 0.9],
    [{ x: 9.8, y: 1.9, z: 9.8 }, Math.PI * 0.75, 0.4],
  ] as const) {
    state.boom = null;
    let pose = propCameraPose(blockers, PROP_CAMERA.seeker, PROP_CAMERA.seeker.boom, pivot, yaw, pitch, state, 1);
    for (let k = 0; k < 10; k++) pose = propCameraPose(blockers, PROP_CAMERA.seeker, PROP_CAMERA.seeker.boom, pivot, yaw, pitch, state, 0.1);
    assert.ok(pose.position.y < MARKET.ceiling, `camera at y ${pose.position.y.toFixed(2)}`);
    assert.ok(Math.abs(pose.position.x) < I && Math.abs(pose.position.z) < I, `camera at (${pose.position.x.toFixed(2)}, ${pose.position.z.toFixed(2)})`);
  }
  const solids = senseSolids(MARKET_MAP.colliders),
    target = (x: number, z: number) => ({ x, z, feet: 0, middle: 0.4, top: 0.6 });
  assert.ok(senses({ x: 1.3, y: 0.9, z: 0 }, target(5.0, 0), solids), "across a gondola");
  assert.ok(!senses({ x: 5.0, y: 0.9, z: -4.9 }, target(5.0, -7.3), solids), "through the depot wall");
});

test("map choice: Rastgele draws either map evenly; a chosen map is always played", () => {
  const rnd = mulberry32(5),
    drawn = { camp: 0, market: 0 };
  for (let k = 0; k < 400; k++) drawn[pickPropMap("random", rnd)]++;
  assert.ok(drawn.camp > 160 && drawn.market > 160, JSON.stringify(drawn));
  for (const map of ["camp", "market"] as const) assert.equal(pickPropMap(map, () => 0.99), map);
  const families = (id: "camp" | "market") => PROP_MAPS[id].dealer.def.families;
  assert.equal(families("market").length, 12);
  assert.ok(families("camp").every((f: PropFamilyId) => !families("market").includes(f)), "each map its own families");
});
