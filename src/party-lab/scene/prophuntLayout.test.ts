import assert from "node:assert/strict";
import { before, test } from "node:test";
import RAPIER from "@dimforge/rapier3d-compat";
import { silentFeedback } from "../audio/events";
import type { MovementInput } from "../input/types";
import { initializePhysics, IDLE_INPUT } from "./physics";
import type { PlayerId } from "./players";
import { restore } from "./ragdoll/character";
import { retire } from "./layers/game";
import { PropHuntGame } from "./prophunt/game";
import { HiderBot, hideSpots, layoutNav, propNav, SeekerBot, SEEKER_SENSE, VIEWPOINTS } from "./prophunt/bots";
import { CAMP, HIDER_SPAWNS, LOFT, PROP_HUNT_MAP, ROUTE_CLEARANCES, SEEKER_SPAWN, SHED, WOODPILE, surfaceBelow, zoneAt, type DecoyPlacement } from "../../../shared/party-lab/maps/propHunt";
import {
  conflict,
  CORE_FAMILIES,
  familyCap,
  generatePropLayout,
  LAYOUT_TUNING,
  layoutChange,
  layoutProblem,
  REFERENCE_LAYOUT,
  roundLayout,
  slotPoses,
  staticRefusal,
  type PropLayout,
} from "../../../shared/party-lab/maps/propHuntLayout";
import { CONTEXT_FAMILIES, CONTEXT_SETTING, FAMILY_SETTINGS, PROP_SCENES, PROP_SLOTS, SLOT_FAMILIES, slotById, variantItems } from "../../../shared/party-lab/maps/propHuntScenes";
import { PROP_FAMILIES, PROP_FAMILY_IDS, shapeHeight, type PropFamilyId } from "../../../shared/party-lab/maps/propHuntProps";
import type { ArenaCollider } from "../../../shared/party-lab/maps/types";
import { PROP_HUNT } from "../../../shared/party-lab/simulation/prophunt/config";
import { mulberry32 } from "../../../shared/party-lab/simulation/colors/layouts";

before(() => initializePhysics());

/** 500 dealt layouts: 10 matches × 50 consecutive rounds (each round dealt from the one before it). */
const MATCHES = Array.from({ length: 10 }, (_, k) => 101 + k * 7919);
const ROUNDS = 50;
const matches = new Map<number, PropLayout[]>();
function match(seed: number): PropLayout[] {
  let list = matches.get(seed);
  if (!list) {
    list = [];
    for (let r = 0; r < ROUNDS; r++) list.push(roundLayout(seed, r, list[r - 1] ?? null));
    matches.set(seed, list);
  }
  return list;
}
const all = () => MATCHES.flatMap(match);
const IDLE: MovementInput[] = [IDLE_INPUT, IDLE_INPUT, IDLE_INPUT];
const count = (layout: PropLayout, f: PropFamilyId) => layout.decoys.filter((d) => d.family === f).length;
function footprint(c: ArenaCollider) {
  return c.shape === "cylinder"
    ? { x0: c.center.x - c.radius, x1: c.center.x + c.radius, z0: c.center.z - c.radius, z1: c.center.z + c.radius }
    : { x0: c.center.x - c.half.x, x1: c.center.x + c.half.x, z0: c.center.z - c.half.z, z1: c.center.z + c.half.z };
}
const gapTo = (c: ArenaCollider, x: number, z: number) =>
  c.shape === "cylinder" ? Math.max(0, Math.hypot(x - c.center.x, z - c.center.z) - c.radius) : Math.hypot(Math.max(0, Math.abs(x - c.center.x) - c.half.x), Math.max(0, Math.abs(z - c.center.z) - c.half.z));
/** How often each value occurs, as shares. */
function distribution(values: number[]) {
  const out = new Map<number, number>();
  for (const v of values) out.set(v, (out.get(v) ?? 0) + 1);
  return new Map([...out].map(([k, n]) => [k, n / values.length]));
}

// ─── The recipes ────────────────────────────────────────────────────────────

test("scenes: authored slots with a zone, a context and a floor; every recipe item is plausible in its slot and has a pose that fits, stands on its floor and keeps routes clear; the chopping block is the one fixed scene", () => {
  assert.ok(PROP_SCENES.length >= 25, `${PROP_SCENES.length} scenes`);
  assert.equal(new Set(PROP_SLOTS.map((s) => s.id)).size, PROP_SLOTS.length, "unique slot ids");
  assert.deepEqual(
    PROP_SCENES.filter((s) => s.fixed).map((s) => s.id),
    ["yard.chop"]
  );
  for (const scene of PROP_SCENES) {
    assert.ok(scene.variants.length >= (scene.fixed ? 1 : 3), `${scene.id}: ${scene.variants.length} variants`);
    for (const v of scene.variants)
      for (const item of variantItems(v))
        for (const id of item.slots) {
          const slot = slotById(id)!;
          assert.ok(slot && slot.scene === scene.id, `${scene.id}/${v.id}: slot ${id} of another scene`);
          for (const f of item.families) {
            assert.ok(CONTEXT_FAMILIES[slot.context].includes(f), `${id}: ${f} in a ${slot.context} slot`);
            assert.ok(slotPoses(slot, f).length > 0, `${scene.id}/${v.id}: ${id} ${f} has no pose (${staticRefusal(slot, f)})`);
          }
        }
  }
  for (const slot of PROP_SLOTS) {
    assert.equal(slot.setting, CONTEXT_SETTING[slot.context]);
    assert.ok(SLOT_FAMILIES.get(slot.id)?.length, `${slot.id} is used by a recipe`);
  }
});

test("semantics: contexts keep furniture indoors, storage in the shed and the yard, nature outdoors — never a dresser by the fire, a nightstand in the forest, an armchair by a tree, a bush in the lodge or a wheelie bin by the bunk bed", () => {
  for (const [context, families] of Object.entries(CONTEXT_FAMILIES)) for (const f of families) assert.ok(FAMILY_SETTINGS[f].includes(CONTEXT_SETTING[context as keyof typeof CONTEXT_SETTING]), `${f} in ${context}`);
  for (const f of ["nightstand", "dresser"] as const) assert.deepEqual([...FAMILY_SETTINGS[f]], ["indoor"]);
  for (const f of ["bush", "flowerBush", "sapling", "boulder", "boulderB"] as const) assert.deepEqual([...FAMILY_SETTINGS[f]], ["outdoor"]);
  for (const f of ["armchair", "sideTable", "pottedPlant", "chair"] as const) assert.ok(!FAMILY_SETTINGS[f].includes("outdoor"), `${f} outdoors`);
  const HOME = ["lodge", "loft"],
    INDUSTRIAL: PropFamilyId[] = ["wheelieBin", "metalCan", "propane", "barrel", "sacks"],
    NATURE: PropFamilyId[] = ["bush", "flowerBush", "sapling", "boulder", "boulderB"],
    FURNITURE: PropFamilyId[] = ["dresser", "nightstand", "armchair"];
  for (const layout of all())
    for (const d of layout.decoys) {
      const slot = slotById(d.slot!)!;
      assert.ok(CONTEXT_FAMILIES[slot.context].includes(d.family), `${d.family} in ${slot.id}`);
      if (HOME.includes(d.zone)) assert.ok(!INDUSTRIAL.includes(d.family) && !NATURE.includes(d.family) && d.family !== "stump", `${d.family} in the ${d.zone}`);
      if (FURNITURE.includes(d.family)) assert.ok(HOME.includes(d.zone), `${d.family} in the ${d.zone}`);
      // A side table: indoors, or the porch's small table with its chairs.
      if (d.family === "sideTable") assert.ok([...HOME, "porch"].includes(d.zone), `side table in the ${d.zone}`);
      if (NATURE.includes(d.family)) assert.equal(slot.setting, "outdoor", `${d.family} under a roof`);
      if (d.zone === "plaza") assert.ok(["log", "stump", "backpack", "crate", "boulder", "boulderB", "bush", "flowerBush"].includes(d.family), `${d.family} by the fire`);
    }
});

// ─── Dealing ────────────────────────────────────────────────────────────────

test("layouts: the same match seed and round deal the identical layout (with or without the previous round given); consecutive rounds are never identical", () => {
  for (const seed of MATCHES.slice(0, 3)) {
    const list = match(seed);
    for (let r = 0; r < 12; r++) {
      const again = roundLayout(seed, r, list[r - 1] ?? null);
      assert.equal(again.id, list[r].id);
      assert.deepEqual(again.decoys, list[r].decoys);
      if (r) assert.notEqual(list[r].id, list[r - 1].id);
    }
    assert.equal(roundLayout(seed, 6).id, list[6].id, "recomputed from round 0");
    assert.equal(generatePropLayout(roundLayout(seed, 0).seed!).id, list[0].id);
  }
  const firsts = new Set(MATCHES.map((s) => match(s)[0].id));
  assert.equal(firsts.size, MATCHES.length, "different matches start differently");
});

test("layouts (500): 60–68 decoys, ≈ 64 on average; 15–18 families in play, each with ≥ 2 decoys (never a single one of a kind), the rest none; chairs, crates, logs and stumps always; no family out more than 2 rounds in a row, every family in play most rounds", () => {
  const T = LAYOUT_TUNING,
    layouts = all(),
    totals: number[] = [],
    pool: number[] = [];
  assert.equal(layouts.length, 500);
  const inPlay = new Map<PropFamilyId, number>();
  for (const seed of MATCHES) {
    const list = match(seed),
      streak = new Map<PropFamilyId, number>();
    list.forEach((layout, r) => {
      assert.equal(layoutProblem(layout, list[r - 1] ?? null), null, `match ${seed} round ${r}`);
      totals.push(layout.decoys.length);
      pool.push(layout.active.length);
      assert.ok(layout.decoys.length >= T.count[0] && layout.decoys.length <= T.count[1]);
      assert.ok(layout.active.length >= 15 && layout.active.length <= 18, `${layout.active.length} families`);
      for (const f of PROP_FAMILY_IDS) {
        const n = count(layout, f);
        assert.equal(n > 0, layout.active.includes(f));
        assert.ok(n === 0 || (n >= 2 && n <= familyCap(f)), `match ${seed} round ${r}: ${n} × ${f}`);
        if (CORE_FAMILIES.includes(f)) assert.ok(n >= 2, `${f} always`);
        streak.set(f, n ? 0 : (streak.get(f) ?? 0) + 1);
        assert.ok(streak.get(f)! <= T.maxRest, `${f} out ${streak.get(f)} rounds`);
        assert.equal(layout.resting[f], streak.get(f));
        if (n) inPlay.set(f, (inPlay.get(f) ?? 0) + 1);
      }
    });
  }
  const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
  assert.ok(mean >= 62.5 && mean <= 65.5, `mean ${mean.toFixed(2)} decoys`);
  for (const size of [15, 16, 17, 18]) assert.ok(pool.filter((p) => p === size).length >= 40, `${size} families in play: ${pool.filter((p) => p === size).length} rounds`);
  for (const f of PROP_FAMILY_IDS) assert.ok((inPlay.get(f) ?? 0) >= 0.6 * layouts.length, `${f} in play in ${inPlay.get(f)} of 500 rounds`);
});

test("layouts (500): consecutive rounds keep about half — 45–55% of the ordinary props changed (never outside 40–60%), median ≈ 50%; the chopping block always stays", () => {
  const changes: number[] = [];
  for (const seed of MATCHES) {
    const list = match(seed);
    for (let r = 1; r < list.length; r++) {
      const c = layoutChange(list[r - 1], list[r]);
      assert.ok(c >= LAYOUT_TUNING.changeLimits[0] && c <= LAYOUT_TUNING.changeLimits[1], `match ${seed} round ${r}: ${Math.round(c * 100)}%`);
      changes.push(c);
    }
    for (const layout of list) assert.equal(layout.decoys.filter((d) => d.scene === "yard.chop" && d.family === "stump" && d.x === 6.1 && d.z === -3.285).length, 1, "the chopping block");
  }
  const sorted = [...changes].sort((a, b) => a - b),
    median = sorted[sorted.length >> 1];
  assert.ok(median >= 0.45 && median <= 0.55, `median ${(median * 100).toFixed(1)}%`);
  assert.ok(changes.filter((c) => c >= 0.45 && c <= 0.55).length >= 0.95 * changes.length, "almost always in the aimed band");
});

test("clusters (500): natural same-kind groups whose counts vary — dining chairs 2–5, shed crates 0–5, logs or stumps round the fire 2–4, fence bushes and rocks — no count a reliable rule (≥ 3 values, none in more than 60% of rounds)", () => {
  const layouts = all();
  const series = {
    dining: layouts.map((l) => l.decoys.filter((d) => d.scene === "lodge.dining" && d.family === "chair").length),
    shedCrates: layouts.map((l) => l.decoys.filter((d) => d.zone === "shed" && d.family === "crate").length),
    fireSeats: layouts.map((l) => l.decoys.filter((d) => d.scene === "plaza.fire" && (d.family === "log" || d.family === "stump")).length),
    fenceBushesRocks: layouts.map((l) => l.decoys.filter((d) => d.zone === "border" && ["bush", "flowerBush", "boulder", "boulderB"].includes(d.family)).length),
  };
  for (const [name, values] of Object.entries(series)) {
    const shares = distribution(values);
    assert.ok(shares.size >= 3, `${name}: ${[...shares.keys()]}`);
    assert.ok(Math.max(...shares.values()) <= 0.6, `${name}: ${JSON.stringify([...shares])}`);
  }
  assert.ok(series.dining.every((n) => n >= 2 && n <= 5), "the table always has 2–5 chairs");
  assert.ok(series.fireSeats.every((n) => n >= 2 && n <= 4), "the fire always has 2–4 seats");
  // Same-kind clusters happen: three or more chairs at the table, two or more crates in the shed, three logs or stumps at the fire.
  assert.ok(series.dining.filter((n) => n >= 3).length > 0.5 * layouts.length);
  assert.ok(series.shedCrates.filter((n) => n >= 2).length > 0.3 * layouts.length);
});

test("layouts (500): no clipping — no two props overlap or leave a squeeze, no duplicate at the same place; every prop stands on its floor, in its slot and zone, flush with what it backs onto", () => {
  for (const layout of all()) {
    const seen = new Set<string>();
    layout.decoys.forEach((d, i) => {
      const key = `${d.family}|${d.x}|${d.y}|${d.z}`;
      assert.ok(!seen.has(key), `duplicate ${key}`);
      seen.add(key);
      for (let j = i + 1; j < layout.decoys.length; j++) assert.ok(!conflict(d, layout.decoys[j]), `${d.slot} ${d.family} vs ${layout.decoys[j].slot} ${layout.decoys[j].family}`);
      const slot = slotById(d.slot!)!,
        f = footprint(layout.colliders[i]);
      assert.equal(zoneAt(d.x, d.z, d.y), slot.zone);
      assert.ok(Math.max(Math.abs(f.x0), Math.abs(f.x1), Math.abs(f.z0), Math.abs(f.z1)) <= CAMP.half + 1e-6);
      assert.ok(f.x0 >= slot.x[0] - 0.003 && f.x1 <= slot.x[1] + 0.003 && f.z0 >= slot.z[0] - 0.003 && f.z1 <= slot.z[1] + 0.003, `${d.slot} ${d.family} outside its slot`);
      for (const side of slot.against) {
        const edge = side === "-x" ? f.x0 - slot.x[0] : side === "+x" ? slot.x[1] - f.x1 : side === "-z" ? f.z0 - slot.z[0] : slot.z[1] - f.z1;
        assert.ok(Math.abs(edge) < 0.003, `${d.slot} not flush`);
      }
      for (const [x, z] of [
        [d.x, d.z],
        [f.x0 + 0.05, f.z0 + 0.05],
        [f.x1 - 0.05, f.z1 - 0.05],
      ])
        assert.ok(Math.abs(surfaceBelow(x, z, d.y + 0.1) - d.y) < 0.02, `${d.slot} floating or sunk`);
    });
  }
});

test("layouts (500): route safety — no prop ever in a doorway, on the stair's foot, approach or top, in the loft's walks or drop gap, the porch's walk or exits, the shed door, the woodpile route or a spawn", () => {
  const labels = ROUTE_CLEARANCES.map((r) => r.label);
  for (const want of ["front door (inside)", "front door (porch)", "front steps", "side door (inside)", "side door (outside)", "stair foot", "stair approach", "stair top", "loft walk to the loft door", "loft door (inside)", "loft rail walk", "loft drop gap", "loft drop landing", "porch front walk", "porch east exit", "porch rail vault landing", "shed door (inside)", "shed door (outside)", "crate step", "woodpile route", "seeker spawn", "hider spawn 1", "hider spawn 2"])
    assert.ok(labels.includes(want), `clearance for ${want}`);
  for (const layout of all())
    layout.decoys.forEach((d, i) => {
      const f = footprint(layout.colliders[i]);
      for (const r of ROUTE_CLEARANCES)
        if (Math.abs(r.y - d.y) < 0.3) assert.ok(!(f.x0 < r.x[1] - 0.005 && f.x1 > r.x[0] + 0.005 && f.z0 < r.z[1] - 0.005 && f.z1 > r.z[0] + 0.005), `${d.family} (${d.slot}) in the ${r.label} clearance`);
    });
});

// ─── Navigation with dealt layouts ──────────────────────────────────────────

test("navigation (40 layouts): one connected camp — every viewpoint and zone reachable, routes barely longer than the bare camp's, every decoy copyable from a reachable spot", () => {
  const bare = propNav(),
    bareField = bare.field(bare.nodeAt(SEEKER_SPAWN.x, SEEKER_SPAWN.y, SEEKER_SPAWN.z));
  const sample = MATCHES.slice(0, 4).flatMap((seed) => match(seed).slice(0, 10));
  for (const layout of sample) {
    const nav = layoutNav(layout),
      field = nav.field(nav.nodeAt(SEEKER_SPAWN.x, SEEKER_SPAWN.y, SEEKER_SPAWN.z));
    for (const vp of VIEWPOINTS) {
      const id = nav.nodeAt(vp.x, vp.y + 0.78, vp.z),
        base = bareField.dist[bare.nodeAt(vp.x, vp.y + 0.78, vp.z)];
      assert.ok(Number.isFinite(field.dist[id]) && Math.abs(nav.nodes[id].y - vp.y) < 0.3, `${layout.id}: viewpoint ${vp.zone} (${vp.x}, ${vp.z}) cut off`);
      assert.ok(field.dist[id] <= base + 3 + 12, `${layout.id}: route to ${vp.zone} ${field.dist[id].toFixed(1)} m (bare ${base.toFixed(1)})`);
    }
    for (const [x, y, z, what] of [
      [-1.5, LOFT.top, -9.4, "loft"],
      [8.7, SHED.floor, -8.0, "shed"],
      [5.75, WOODPILE.top, -8.0, "woodpile top"],
      [...Object.values(HIDER_SPAWNS[0]), "hider spawn"],
    ] as const) {
      const id = nav.nodeAt(Number(x), Number(y) + 0.78, Number(z));
      assert.ok(Number.isFinite(field.dist[id]), `${layout.id}: ${what} cut off`);
    }
    layout.decoys.forEach((d, i) => {
      const reach = nav.nodes.some((n) => !nav.blocked[n.id] && Number.isFinite(field.dist[n.id]) && Math.abs(n.y - d.y) < 0.4 && gapTo(layout.colliders[i], n.x, n.z) <= PROP_HUNT.disguise.range);
      assert.ok(reach, `${layout.id}: decoy ${d.slot} ${d.family} out of reach`);
    });
  }
});

/** A game on a fixed dealt layout, fast-forwarded into the hiding (bots out of the way). */
function onLayout(layout: PropLayout) {
  const g = new PropHuntGame(silentFeedback, { roles: ["hider", "hider", "seeker"], layout });
  while (g.round.phase !== "hiding") g.step(IDLE);
  retire(g.physics.players[1]);
  retire(g.physics.players[2]);
  return g;
}
function walk(g: PropHuntGame, id: PlayerId, points: [number, number][], seconds: number) {
  let k = 0;
  const press = (input: MovementInput) => IDLE.map((x, j) => (j === id ? input : x));
  for (let t = 0; t < seconds * 60; t++) {
    const p = g.physics.players[id].body.translation();
    while (k < points.length - 1 && Math.hypot(points[k][0] - p.x, points[k][1] - p.z) < 0.35) k++;
    const [x, z] = points[k],
      dx = x - p.x,
      dz = z - p.z,
      d = Math.hypot(dx, dz);
    g.step(press(d < 0.1 ? IDLE_INPUT : { x: dx / d, z: dz / d, jump: false }));
    if (g.round.tick > 60 * 5) g.round.tick = 60;
  }
  const p = g.physics.players[id].body.translation();
  return { x: p.x, z: p.z, feet: g.feet(g.physics.players[id]) };
}

test("routes (real ragdoll) with dealt layouts: into the lodge, up and down the stair, the woodpile route to the loft door, into the shed", () => {
  for (const layout of [match(MATCHES[0])[0], match(MATCHES[0])[7], match(MATCHES[1])[3], match(MATCHES[2])[11]]) {
    const g = onLayout(layout);
    const at = (x: number, z: number, yaw: number) => restore(g.physics.players[0], { x, y: surfaceBelow(x, z) + 0.9, z }, yaw);
    at(-6.5, 2.4, Math.PI);
    assert.ok(walk(g, 0, [[-6.5, -4.0]], 5).z < -3.5, `${layout.id}: front door`);
    at(-10.2, -8.0, Math.PI);
    const up = walk(g, 0, [[-10.2, -9.8], [-9.3, -9.8], [-3.6, -9.8], [-2.5, -9.6]], 8);
    assert.ok(Math.abs(up.feet - LOFT.top) < 0.05, `${layout.id}: up the stair (${up.feet.toFixed(2)})`);
    const down = walk(g, 0, [[-3.6, -9.8], [-9.6, -9.8], [-10.2, -8.2]], 8);
    assert.ok(Math.abs(down.feet - 0.45) < 0.05 && down.x < -9.5, `${layout.id}: down the stair (${down.x.toFixed(2)}, ${down.feet.toFixed(2)})`);
    at(5.85, -5.0, Math.PI);
    const loft = walk(g, 0, [[5.85, -6.5], [5.85, -8.0], [4.4, -8.6], [2.4, -9.2], [1.0, -9.2]], 10);
    assert.ok(Math.abs(loft.feet - LOFT.top) < 0.05 && loft.x < 1.7, `${layout.id}: woodpile route (${loft.x.toFixed(2)}, ${loft.feet.toFixed(2)})`);
    at(8.7, -3.5, Math.PI);
    assert.ok(walk(g, 0, [[8.7, -7.0]], 4).z < -6.5, `${layout.id}: shed door`);
    g.dispose();
  }
});

// ─── The game and the bots over several rounds ──────────────────────────────

test("game: every reset deals the next layout — last round's decoy colliders leave the world, this round's are hit by rays; a fixed layout stays; the first round is round 0 of the match seed", () => {
  const g = new PropHuntGame(silentFeedback, { roles: ["seeker", "hider", "hider"], seed: 4242 });
  assert.equal(g.layout.id, roundLayout(4242, 0, null).id);
  assert.equal(g.layoutChanged, null);
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  /** The decoy a straight-down ray from just over height `y` at (x, z) meets first (−1: none). */
  const decoyBelow = (x: number, y: number, z: number) => {
    ray.origin = { x, y: y + 0.25, z };
    const hit = g.physics.world.castRay(ray, 0.5, true);
    return hit ? g.decoyHandles.indexOf(hit.collider.handle) : -1;
  };
  let previous = g.layout;
  for (let round = 1; round <= 3; round++) {
    g.round.phase = "results";
    g.round.tick = 0;
    let event = null;
    while (event !== "reset") event = g.step(IDLE);
    g.step(IDLE); // the countdown's first physics step brings the scene queries up to date
    assert.equal(g.layoutRound, round);
    assert.notEqual(g.layout.id, previous.id);
    assert.equal(g.layout.id, roundLayout(4242, round, previous).id);
    assert.ok(g.layoutChanged! >= LAYOUT_TUNING.changeLimits[0] && g.layoutChanged! <= LAYOUT_TUNING.changeLimits[1]);
    assert.equal(g.decoyHandles.length, g.decoys.length);
    // Every decoy of this round is there; a spot only last round used is empty.
    g.decoys.forEach((d, i) => assert.equal(decoyBelow(d.x, d.y + shapeHeight(PROP_FAMILIES[d.family].shape), d.z), i, `round ${round}: decoy ${i} ${d.slot}`));
    const gone = previous.decoys.filter((p) => !g.layout.colliders.some((c) => gapTo(c, p.x, p.z) < 0.05) && shapeHeight(PROP_FAMILIES[p.family].shape) > 0.5);
    assert.ok(gone.length >= 3, `${gone.length} emptied spots`);
    for (const p of gone) assert.equal(decoyBelow(p.x, p.y + shapeHeight(PROP_FAMILIES[p.family].shape), p.z), -1, `round ${round}: last round's ${p.slot} still solid`);
    let colliders = 0;
    g.physics.world.forEachCollider((c) => void (c.parent() ? 0 : colliders++));
    assert.equal(colliders, PROP_HUNT_MAP.colliders.length + g.decoys.length, "no stale colliders");
    previous = g.layout;
  }
  g.dispose();
  const fixed = new PropHuntGame(silentFeedback, { roles: ["seeker", "hider", "hider"], layout: REFERENCE_LAYOUT });
  fixed.round.phase = "results";
  let event = null;
  while (event !== "reset") event = fixed.step(IDLE);
  assert.equal(fixed.layout, REFERENCE_LAYOUT);
  assert.equal(fixed.layoutChanged, null);
  fixed.dispose();
});

test("hider bots' spots (100 layouts): only this round's props and families in play; recipe spots only where the recipe slot is empty this round, next to a prop of that kind to copy, clear of every prop", () => {
  for (const layout of MATCHES.slice(0, 2).flatMap((seed) => match(seed).slice(0, 50))) {
    const spots = hideSpots(layout),
      taken = new Set(layout.decoys.map((d) => d.slot));
    assert.ok(spots.length > 20);
    assert.ok(spots.some((s) => s.slot), "some recipe spots");
    for (const s of spots) {
      assert.ok(layout.active.includes(s.family), `${s.family} not in play`);
      assert.equal(layout.decoys[s.decoy].family, s.family, "copies a prop of its kind in this layout");
      if (!s.slot) continue;
      assert.ok(!taken.has(s.slot), `${s.slot} is taken`);
      assert.ok(SLOT_FAMILIES.get(s.slot)!.includes(s.family));
      const p: DecoyPlacement = { family: s.family, x: s.x, y: s.y, z: s.z, turns: s.turns, zone: s.zone, slot: s.slot };
      assert.ok(!layout.decoys.some((d) => conflict(d, p)), `${s.slot} ${s.family} clips a prop`);
      assert.ok(gapTo(layout.colliders[s.decoy], s.x, s.z) <= PROP_HUNT.disguise.range, "the prop to copy in reach");
    }
  }
});

test("bots across rounds: hiders only take this round's props (families in play) and start over each round; the seeker learns only from what it saw in earlier rounds — and a match replays identically", () => {
  const run = () => {
    const g = new PropHuntGame(silentFeedback, { roles: ["seeker", "hider", "hider"], seed: 77 });
    const rnd = mulberry32(5),
      seeker = new SeekerBot(0, rnd),
      hiders = [new HiderBot(1, rnd), new HiderBot(2, rnd)];
    const trace: (string | number)[] = [];
    const layoutsSeen: PropLayout[] = [];
    let disguises = 0;
    for (let t = 0; t < 60 * 60 * 6 && layoutsSeen.length < 4; t++) {
      const event = g.step([seeker.update(g), hiders[0].update(g), hiders[1].update(g)]);
      if (layoutsSeen[layoutsSeen.length - 1] !== g.layout) layoutsSeen.push(g.layout);
      for (const e of g.events)
        if (e.type === "disguise") {
          disguises++;
          // Copied from this round's layout: the index points at a decoy of that family now, a family in play.
          assert.equal(g.decoys[e.decoy].family, e.family, `round ${g.layoutRound}: copied a stale decoy`);
          assert.ok(g.layout.active.includes(e.family));
          const bot = hiders.find((h) => h.id === e.id)!;
          if (bot.spot) assert.ok(hideSpots(g.layout).includes(bot.spot), `round ${g.layoutRound}: a spot from another layout`);
        }
      if (event === "reset") {
        for (const bot of [seeker, ...hiders]) bot.reset();
        for (const h of hiders) assert.equal(h.spot, null);
        assert.equal(seeker.memory.size, 0);
        // Everything it remembers of the camp, it saw: a prop of that kind was there in an earlier round (its decoys or a disguise).
        for (const p of seeker.past) assert.ok(p.round < seeker.rounds);
      }
      if (g.round.phase === "hiding" && g.round.tick === 1) for (const h of hiders) assert.ok(!h.spot || hideSpots(g.layout).includes(h.spot), "no spot carried over");
      if (t % 90 === 0) for (const c of g.physics.players) trace.push(Math.round(c.body.translation().x * 1000), Math.round(c.body.translation().z * 1000));
    }
    trace.push(g.layoutRound, g.layout.id, disguises, seeker.rounds, seeker.past.length);
    assert.ok(layoutsSeen.length >= 4, `${layoutsSeen.length} layouts in the run`);
    assert.ok(disguises >= 6, `${disguises} disguises`);
    assert.ok(seeker.rounds >= 3 && seeker.past.length > 20, "it remembers the rounds it searched");
    g.dispose();
    return trace;
  };
  assert.deepEqual(run(), run());
});

test("seeker bot honesty: a fresh seeker does not know a new layout — nothing familiar but the chopping block, every decoy just a prop on a spot where its kind belongs (no shot on that alone); memory from earlier rounds can be fooled by a disguise where a prop of its kind stood", () => {
  // Round 1 of a match: both hiders out of the way (never seen), only the decoys to look at.
  const g = new PropHuntGame(silentFeedback, { roles: ["seeker", "hider", "hider"], seed: 9 });
  while (g.round.phase !== "search") g.step(IDLE);
  retire(g.physics.players[1]);
  retire(g.physics.players[2]);
  const bot = new SeekerBot(0, mulberry32(3));
  for (let t = 0; t < 60 * 45; t++) {
    // This isolates visual familiarity. Retiring a test body does not mark its living
    // hider found, so automatic whistles and the broader hunch can still be emitted.
    // Those are valid evidence, tested separately; do not feed them to this visual-only bot.
    g.events.length = 0;
    g.step([bot.update(g), IDLE_INPUT, IDLE_INPUT]);
  }
  assert.equal(g.stats.shots, 0, "no shot in the first 45 s of its first round");
  const seen = [...bot.memory.values()].filter((m) => m.family !== "body");
  assert.ok(seen.length > 15, `${seen.length} props seen`);
  for (const m of seen) {
    const landmark = m.family === "stump" && Math.hypot(m.x - 6.1, m.z + 3.285) < 0.1;
    assert.equal(m.familiar, landmark, `${m.family} at ${m.x.toFixed(1)}, ${m.z.toFixed(1)}`);
    if (!landmark) assert.ok(m.suspicion <= SEEKER_SENSE.usualCap + 1e-9 && SEEKER_SENSE.usualCap < SEEKER_SENSE.threshold, "a prop on its usual spot never reaches a shot on that alone");
  }
  // Next round: what it saw is its memory. A prop of a kind it saw last round, where it saw it, looks familiar — even a disguise.
  bot.reset();
  assert.equal(bot.rounds, 1);
  assert.ok(bot.past.length === seen.length);
  const remembered = seen.find((m) => m.family !== "stump")!;
  const impression = (bot as unknown as { impression(s: object): { familiar: boolean } }).impression({ key: "p:0", family: remembered.family, x: remembered.x + 0.1, y: remembered.y, z: remembered.z, height: 1, handle: null });
  assert.ok(impression.familiar, "fooled: it was here last round");
  g.dispose();
});
