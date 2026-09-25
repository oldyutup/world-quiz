import assert from "node:assert/strict";
import { before, test } from "node:test";
import RAPIER from "@dimforge/rapier3d-compat";
import { Vector3 } from "three";
import { silentFeedback } from "../audio/events";
import type { MovementInput } from "../input/types";
import { defaultBindings } from "../input/defaults";
import { controlHint } from "./arenaMenu";
import { initializePhysics, IDLE_INPUT, PlaygroundPhysics } from "./physics";
import type { PlayerId } from "./players";
import { connect, restore, type Character } from "./ragdoll/character";
import { RAGDOLL } from "./ragdoll/config";
import { rotate } from "./ragdoll/math";
import { ColorBot } from "./colors/bots";
import { COLOR_CAMERA, colorCameraPosition, ColorFall, ColorFollow } from "./colors/colorCamera";
import { ColorChaosGame } from "./colors/game";
import { TILE_HEX } from "./colors/palette";
import { buildScenery, SCENERY_CLEAR_RADIUS, SCENERY_TOP_MAX } from "./colors/scenery";
import { LayerChaosGame, retire } from "./layers/game";
import { layerIntent } from "./layers/controls";
import { HEX, hexCenter, hexDistance } from "../../../shared/party-lab/maps/layers";
import {
  COLOR_NEIGHBOURS,
  COLOR_OUTER_RING,
  COLOR_SPAWN_CELLS,
  COLOR_SPAWN_TILES,
  COLOR_SYMMETRIES,
  COLOR_TILES,
  colorRotation,
  colorTileAt,
  colorTileAtCell,
  COLORS_MAP,
  type ColorTile,
} from "../../../shared/party-lab/maps/colors";
import { ARENA_MAP_IDS } from "../../../shared/party-lab/maps";
import { COLOR_CHAOS, COLOR_IDS, COLOR_TICKS, reactionSeconds, reactionTicks, type ColorIndex } from "../../../shared/party-lab/simulation/colors/config";
import { ColorTileField } from "../../../shared/party-lab/simulation/colors/field";
import {
  applyPick,
  checkLayout,
  colorCounts,
  colorGroups,
  colorLayoutBanks,
  colorReach,
  CYCLE_LAYOUT_COUNT,
  decodeLayout,
  designLayout,
  encodeLayout,
  LAYOUT_RULES,
  LAYOUT_STAGE_COUNT,
  mulberry32,
  NO_COLOR,
  spawnsEquivalent,
  STAGE_RULES,
} from "../../../shared/party-lab/simulation/colors/layouts";
import { CYCLE_LAYOUTS, OPENING_LAYOUTS, SHRINK_LAYOUTS } from "../../../shared/party-lab/simulation/colors/layoutBank";
import { ColorSchedule, TargetBag, type ColorCycle } from "../../../shared/party-lab/simulation/colors/schedule";
import { FINAL_CYCLE, FOUR_TILES, HUB_TILE, SHRINK_START_CYCLE, shrinkStage, STAGE_MASKS, STAGE_SIZES } from "../../../shared/party-lab/simulation/colors/shrink";
import { LayerBrawl } from "../../../shared/party-lab/simulation/layers/brawl";
import { LAYER_CHAOS, LAYER_TICKS } from "../../../shared/party-lab/simulation/layers/config";
import { LayerRound } from "../../../shared/party-lab/simulation/layers/round";
import { TileField } from "../../../shared/party-lab/simulation/layers/tiles";
import { LAYER_TILES, LAYERS_MAP } from "../../../shared/party-lab/maps/layers";

before(async () => {
  await initializePhysics();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const STAND = RAGDOLL.standHeight + 0.1;
const IDLE = [IDLE_INPUT, IDLE_INPUT, IDLE_INPUT];
const walk = (x: number, z: number, extra: Partial<MovementInput> = {}): MovementInput => ({ x, z, jump: false, ...extra });
const pelvis = (c: Character) => c.body.translation();
const upright = (c: Character) => rotate(c.body.rotation(), { x: 0, y: 1, z: 0 }).y;
function place(physics: PlaygroundPhysics, id: PlayerId, x: number, y: number, z: number, facing = Math.PI / 2) {
  const c = physics.players[id];
  restore(c, { x, y, z }, facing);
  connect(physics.world, c);
  return c;
}
/** Raw physics on the colour field, only slot 0 in play. One step builds the query structure. */
function field() {
  const physics = new PlaygroundPhysics(silentFeedback, COLORS_MAP);
  const tiles = new ColorTileField(physics.world);
  for (const c of physics.players) if (c.id !== 0) retire(c);
  physics.world.step();
  return { physics, tiles };
}
/** A game fast-forwarded to its first playing tick (the countdown elapsed). */
function started(players: 2 | 3 = 3, seed = 11) {
  const game = new ColorChaosGame(silentFeedback, { players, seed });
  let ticks = 0;
  while (game.step(IDLE) !== "started") ticks++;
  return { game, countdown: ticks + 1 };
}
/** Step until the schedule reports `event` (returns the round tick it happened on). */
function until(game: ColorChaosGame, event: "target" | "drop" | "restore", inputs: () => MovementInput[] = () => IDLE, limit = 2000) {
  for (let i = 0; i < limit; i++) {
    const tick = game.round.tick;
    game.step(inputs());
    if (game.event === event) return tick;
    if (game.round.phase !== "playing") throw new Error(`round ended before ${event}`);
  }
  throw new Error(`no ${event}`);
}
const tile = (q: number, r: number): ColorTile => {
  const t = colorTileAtCell({ q, r });
  assert.ok(t, `a tile at (${q},${r})`);
  return t;
};
const DOWN = { x: 0, y: -1, z: 0 };
const rayHitsTile = (physics: PlaygroundPhysics, tiles: ColorTileField, x: number, z: number) => {
  const hit = physics.world.castRay(new RAPIER.Ray({ x, y: 2, z }, DOWN), 4, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
  return hit ? tiles.tileOf(hit.collider) ?? null : null;
};

// ─── Arena ──────────────────────────────────────────────────────────────────

test("arena: 85 flush hex tiles (2.0 m flat to flat) in one round field Ø ≈ 20.7 m at y = 0; no duplicates; one connected field", () => {
  assert.equal(COLOR_TILES.length, 85);
  assert.equal(HEX.width, 2);
  assert.equal(COLOR_OUTER_RING, 5);
  assert.equal(new Set(COLOR_TILES.map((t) => `${t.q},${t.r}`)).size, 85, "no duplicate coordinates");
  for (const t of COLOR_TILES) {
    assert.equal(t.top, 0);
    assert.ok(Math.hypot(t.x, t.z) <= 9.2 + 1e-6);
    assert.equal(COLOR_TILES[t.id], t);
    assert.equal(colorTileAt(t.x, t.z), t);
    for (const n of COLOR_NEIGHBOURS[t.id]) {
      const o = COLOR_TILES[n];
      assert.ok(Math.abs(Math.hypot(o.x - t.x, o.z - t.z) - HEX.width) < 1e-9, "neighbours exactly 2 m apart (flush)");
      assert.ok(COLOR_NEIGHBOURS[n].includes(t.id), "symmetric adjacency");
    }
  }
  const seen = new Set([0]);
  for (const id of seen) for (const n of COLOR_NEIGHBOURS[id]) seen.add(n);
  assert.equal(seen.size, 85, "one connected field");
  const across = Math.max(...COLOR_TILES.map((t) => Math.hypot(t.x, t.z))) * 2 + HEX.width;
  assert.ok(across > 20 && across < 21, `Ø ${across.toFixed(1)} m`);
  // The field is symmetric under all twelve symmetries (each is a permutation of the tiles).
  for (const map of COLOR_SYMMETRIES) assert.equal(new Set(map).size, 85);
  assert.equal(COLORS_MAP.id, "colors");
  assert.equal(COLORS_MAP.colliders.length, 0, "the tile field owns the colliders");
  assert.deepEqual([COLOR_CHAOS.mode, COLOR_CHAOS.label], ["color_chaos", "Renk Kaosu"]);
});

test("colliders: one flush prism per tile; rays find a top anywhere incl. seams; a dropped tile is off and out of queries, restore brings it back", () => {
  const { physics, tiles } = field();
  assert.equal(tiles.colliders.length, 85);
  assert.equal(tiles.enabledColliders, 85);
  const a = tile(0, 0),
    b = tile(1, 0);
  // Centre, the shared edge between two tiles, and a corner where three meet.
  assert.equal(rayHitsTile(physics, tiles, a.x, a.z), a.id);
  assert.notEqual(rayHitsTile(physics, tiles, (a.x + b.x) / 2, 0), null, "seam");
  assert.notEqual(rayHitsTile(physics, tiles, HEX.corner * Math.cos(Math.PI / 6), HEX.corner * Math.sin(Math.PI / 6)), null, "corner");
  tiles.drop([a.id]);
  assert.equal(tiles.colliders[a.id].isEnabled(), false);
  assert.ok(tiles.colliders[a.id].translation().y < -900, "parked far below");
  assert.equal(rayHitsTile(physics, tiles, a.x, a.z), null, "gone from queries at once (parked)");
  assert.equal(rayHitsTile(physics, tiles, b.x, b.z), b.id, "neighbour untouched");
  assert.equal(tiles.enabledColliders, 84);
  tiles.restore();
  physics.world.step();
  assert.equal(tiles.colliders[a.id].isEnabled(), true);
  assert.equal(rayHitsTile(physics, tiles, a.x, a.z), a.id, "back after the next world step");
  assert.equal(tiles.enabledColliders, 85);
  physics.dispose();
});

test("spawns: three on ring 3, 120° apart, 6 m out and 10.4 m apart; two on opposite sides 12 m apart; never on the rim; facing the middle", () => {
  for (const players of [2, 3] as const) {
    const cells = COLOR_SPAWN_CELLS[players];
    assert.equal(cells.length, players);
    for (const cell of cells) {
      assert.equal(hexDistance(cell), 3);
      const c = hexCenter(cell);
      assert.ok(Math.abs(Math.hypot(c.x, c.z) - 6) < 1e-9);
      assert.ok(hexDistance(cell) < COLOR_OUTER_RING - 1, "not on the rim");
    }
    const [p, q] = cells.map(hexCenter);
    assert.ok(Math.abs(Math.hypot(p.x - q.x, p.z - q.z) - (players === 3 ? 6 * Math.sqrt(3) : 12)) < 1e-9);
    // Each spawn set is one orbit of the rotation the openings use.
    const rotation = colorRotation(players);
    const spawnTiles = COLOR_SPAWN_TILES[players];
    for (let i = 0; i < players; i++) assert.equal(rotation[spawnTiles[i]], spawnTiles[(i + 1) % players]);
    const { game } = started(players);
    for (let slot = 0; slot < players; slot++) {
      const body = game.physics.players[slot].body.translation(),
        spawn = hexCenter(cells[slot]);
      // Settled after the countdown (the stance leans ≈ 0.2 m forward), still on the spawn tile.
      assert.ok(Math.hypot(body.x - spawn.x, body.z - spawn.z) < 0.3, `slot ${slot} on its spawn`);
      assert.equal(colorTileAt(body.x, body.z)?.id, COLOR_SPAWN_TILES[players][slot]);
      const facing = game.physics.players[slot].facing,
        toMiddle = Math.atan2(-spawn.x, -spawn.z);
      assert.ok(Math.abs(Math.atan2(Math.sin(facing - toMiddle), Math.cos(facing - toMiddle))) < 0.05, "faces the middle");
    }
    if (players === 2) assert.equal(game.physics.players[2].eliminated, true, "empty slot sits out");
    game.dispose();
  }
});

// ─── Colours ────────────────────────────────────────────────────────────────

test("layout bank: balanced, clustered (every group 2–7 tiles, ≥ 3 groups per colour), every colour ≤ 2 steps from every tile — and every symmetry and colour permutation keeps it", () => {
  const banks = colorLayoutBanks();
  assert.equal(banks.cycle.length, CYCLE_LAYOUT_COUNT);
  assert.ok(CYCLE_LAYOUT_COUNT >= 12);
  const all = [...banks.cycle, ...banks.opening[3], ...banks.opening[2]];
  for (const layout of all) {
    const check = checkLayout(layout);
    assert.ok(check.ok, check.problems.join(", "));
    assert.ok(Math.max(...check.counts) - Math.min(...check.counts) <= 2, `counts ${check.counts}`);
    for (const c of check.counts) assert.ok(c >= 20 && c <= 22);
    for (const sizes of check.groups) {
      assert.ok(sizes.length >= LAYOUT_RULES.minGroups, "several separate groups per colour");
      for (const size of sizes) assert.ok(size >= 2, "no isolated single tile");
    }
    assert.ok(check.worstReach <= 2);
  }
  // Free cycle layouts are balanced as tightly as 85 tiles allow.
  for (const layout of banks.cycle) assert.deepEqual([...checkLayout(layout).counts].sort(), [21, 21, 21, 22]);
  // No two bank layouts are the same arrangement.
  assert.equal(new Set(all.map(encodeLayout)).size, all.length);
  // Shown through any of the 12 symmetries and 24 palettes, a layout keeps every rule.
  const random = mulberry32(5);
  for (let i = 0; i < 60; i++) {
    const palette = [0, 1, 2, 3] as ColorIndex[];
    for (let k = 3; k > 0; k--) {
      const j = Math.floor(random() * (k + 1));
      [palette[k], palette[j]] = [palette[j], palette[k]];
    }
    const shown = applyPick({ bank: "cycle", stage: 0, index: i % CYCLE_LAYOUT_COUNT, symmetry: i % 12, palette }, 3);
    assert.ok(checkLayout(shown).ok);
  }
});

test("openings: third-turn symmetric for 3 players, half-turn for 2 — every spawn starts on the same colour with every colour at the same distance", () => {
  for (const players of [2, 3] as const) {
    const rotation = colorRotation(players);
    for (const layout of colorLayoutBanks().opening[players]) {
      for (let id = 0; id < 85; id++) assert.equal(layout[rotation[id]], layout[id], "rotation symmetric");
      assert.ok(spawnsEquivalent(layout, players));
      for (let s = 0; s < 12; s++) assert.ok(spawnsEquivalent(applyPick({ bank: "opening", stage: 0, index: 0, symmetry: s, palette: [2, 0, 3, 1] }, players), players));
    }
  }
  // Every round opens with one of them.
  for (const players of [2, 3] as const)
    for (let seed = 0; seed < 20; seed++) {
      const schedule = new ColorSchedule(seed, players);
      assert.equal(schedule.cycle.pick.bank, "opening");
      assert.ok(spawnsEquivalent(schedule.cycle.colors, players));
    }
});

test("the stored banks are what designLayout(seed) makes (reproducible, not hand-edited)", () => {
  // First entry of each bank, from the seeds the build script walks from.
  assert.equal(encodeLayout(designLayout(1000, 1)), CYCLE_LAYOUTS[0]);
  assert.equal(encodeLayout(designLayout(3000, 3)), OPENING_LAYOUTS[3][0]);
  assert.equal(encodeLayout(designLayout(2000, 2)), OPENING_LAYOUTS[2][0]);
  assert.deepEqual(Array.from(decodeLayout(CYCLE_LAYOUTS[0])), Array.from(colorLayoutBanks().cycle[0]));
});

test("every target is reachable from every spawn: walking straight to the nearest tile of any colour lands inside it well within the 2.6 s first reaction time", () => {
  for (const players of [3, 2] as const) {
    const layout = colorLayoutBanks().opening[players][0];
    const reach = colorReach(layout);
    for (const color of [0, 1, 2, 3] as ColorIndex[]) {
      const from = COLOR_TILES[COLOR_SPAWN_TILES[players][0]];
      assert.ok(reach[color][from.id] <= 2);
      // Nearest tile of that colour by steps, then by metres.
      const goal = COLOR_TILES.filter((t) => layout[t.id] === color).sort(
        (a, b) => hexDistance(a, from) - hexDistance(b, from) || Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z)
      )[0];
      const { physics } = field();
      const c = place(physics, 0, from.x, STAND, from.z);
      for (let i = 0; i < 20; i++) physics.step(IDLE);
      let inside = -1;
      for (let tick = 0; tick < 180 && inside < 0; tick++) {
        const p = pelvis(c),
          dx = goal.x - p.x,
          dz = goal.z - p.z,
          d = Math.hypot(dx, dz);
        physics.step([d > 0.05 ? walk(dx / d, dz / d) : IDLE_INPUT, IDLE_INPUT, IDLE_INPUT]);
        const under = colorTileAt(pelvis(c).x, pelvis(c).z);
        if (under && layout[under.id] === color && Math.hypot(pelvis(c).x - under.x, pelvis(c).z - under.z) < 0.7) inside = tick + 1;
      }
      physics.dispose();
      assert.ok(inside >= 0 && inside / 60 < 1.5, `${players}p ${COLOR_IDS[color]}: ${reach[color][from.id]} steps, inside after ${(inside / 60).toFixed(2)} s walking`);
    }
  }
});

test("targets: a shuffle bag — each bag holds all four colours, never the same colour twice in a row, no colour missing for more than six cycles; deterministic per seed", () => {
  const draw = (seed: number, n: number) => {
    const bag = new TargetBag(mulberry32(seed));
    return Array.from({ length: n }, () => bag.next());
  };
  const seq = draw(3, 10000);
  for (let i = 0; i < seq.length; i += 4) assert.deepEqual([...seq.slice(i, i + 4)].sort(), [0, 1, 2, 3], `bag ${i / 4}`);
  for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1], `repeat at ${i}`);
  const last = [-1, -1, -1, -1];
  seq.forEach((c, i) => {
    if (last[c] >= 0) assert.ok(i - last[c] - 1 <= 6, "drought ≤ 6");
    last[c] = i;
  });
  assert.deepEqual(draw(3, 40), seq.slice(0, 40));
  assert.notDeepEqual(draw(4, 40), seq.slice(0, 40));
  // The schedule's targets follow the same rule, cycle after cycle.
  const schedule = new ColorSchedule(9, 3),
    targets = [schedule.cycle.target];
  for (let i = 0; i < 60; i++) {
    schedule.advance(schedule.cycle.restore);
    targets.push(schedule.cycle.target);
  }
  for (let i = 1; i < targets.length; i++) assert.notEqual(targets[i], targets[i - 1]);
});

// ─── Phases and timing ──────────────────────────────────────────────────────

test("reaction time by cycle: 2.6 s ×2, 2.2 ×2, 1.8 ×2, 1.5 ×2, then 1.2 s — never below", () => {
  const expected = [2.6, 2.6, 2.2, 2.2, 1.8, 1.8, 1.5, 1.5, 1.2, 1.2, 1.2, 1.2, 1.2];
  expected.forEach((s, i) => assert.equal(reactionSeconds(i + 1), s, `cycle ${i + 1}`));
  assert.deepEqual(expected.map((_, i) => reactionTicks(i + 1)), [156, 156, 132, 132, 108, 108, 90, 90, 72, 72, 72, 72, 72]);
  for (let c = 1; c < 500; c++) assert.ok(reactionSeconds(c) >= 1.2);
  assert.deepEqual([COLOR_TICKS.countdown, COLOR_TICKS.preview, COLOR_TICKS.unsafe, COLOR_TICKS.drop, COLOR_TICKS.restore], [180, 54, 90, 18, 27]);
});

test("cycle timeline in exact ticks: cycle 1 target on the first playing tick, drop +2.6 s, restore +1.5 s; later cycles 0.9 s preview, target, drop, restore; new layout and target each cycle", () => {
  const schedule = new ColorSchedule(21, 3);
  const c1 = schedule.cycle;
  assert.deepEqual([c1.index, c1.start, c1.announce, c1.drop, c1.restore], [1, 0, 0, 156, 246]);
  assert.equal(schedule.advance(0), "target");
  assert.equal(schedule.phase(0), "run");
  assert.equal(schedule.phase(155), "run");
  assert.equal(schedule.advance(155), null);
  assert.equal(schedule.advance(156), "drop");
  assert.equal(schedule.phase(156), "unsafe");
  assert.ok(Math.abs(schedule.timeLeft(78) - 1.3) < 1e-9);
  assert.equal(schedule.advance(246), "restore");
  const c2 = schedule.cycle;
  assert.equal(schedule.previous, c1);
  assert.deepEqual([c2.index, c2.start, c2.announce, c2.drop, c2.restore], [2, 246, 300, 456, 546]);
  assert.equal(schedule.phase(280), "preview");
  assert.equal(schedule.advance(300), "target");
  assert.equal(c2.pick.bank, "cycle");
  assert.notEqual(c2.target, c1.target);
  // Cycle lengths: 4.1 s, then preview 0.9 + reaction + unsafe 1.5.
  const starts = [0, 246];
  for (let i = 0; i < 12; i++) {
    schedule.advance(schedule.cycle.restore);
    starts.push(schedule.cycle.start);
  }
  const lengths = starts.slice(1).map((s, i) => (s - starts[i]) / 60);
  assert.deepEqual(lengths.map((l) => Math.round(l * 10) / 10), [4.1, 5.0, 4.6, 4.6, 4.2, 4.2, 3.9, 3.9, 3.6, 3.6, 3.6, 3.6, 3.6]);
  // Every cycle's colours come from the bank rules.
  assert.ok(checkLayout(schedule.cycle.colors).ok);
  // Deterministic for the seed.
  const again = new ColorSchedule(21, 3);
  for (let i = 0; i < 13; i++) again.advance(again.cycle.restore);
  assert.equal(again.cycle.index, schedule.cycle.index);
  assert.deepEqual(Array.from(again.cycle.colors), Array.from(schedule.cycle.colors));
});

test("game: 3 s frozen countdown (no punches, every tile standing), then the schedule drives the field — non-target colliders off ON the drop tick, all back ON the restore tick", () => {
  const { game, countdown } = started(3, 5);
  assert.equal(countdown, 180, "3.0 s countdown");
  assert.equal(COLOR_CHAOS.round.cap, 125, "a safety net only (the shrink's final drop is at 119.4 s)");
  assert.equal(game.brawl.stats.punches, 0);
  assert.equal(game.field.enabledColliders, 85);
  const cycle = game.schedule.cycle;
  const target = cycle.target,
    dropTick = cycle.drop;
  standOn(game, [true, true, true]);
  // Walk to the drop tick one step at a time: before it every tile stands.
  while (game.round.tick < dropTick) {
    game.step(IDLE);
    assert.equal(game.field.enabledColliders, 85, `tick ${game.round.tick - 1}: all standing`);
  }
  game.step(IDLE); // the drop tick
  assert.equal(game.event, "drop");
  for (const t of COLOR_TILES) {
    const standing = cycle.colors[t.id] === target;
    assert.equal(game.field.intact(t.id), standing);
    assert.equal(game.field.colliders[t.id].isEnabled(), standing);
    if (!standing) assert.ok(game.field.colliders[t.id].translation().y < -900);
  }
  assert.equal(game.field.enabledColliders, cycle.colors.filter((c) => c === target).length);
  // Restore exactly 1.5 s later; the next cycle's colours and target take over.
  const restoreTick = until(game, "restore");
  assert.equal(restoreTick, dropTick + 90);
  assert.equal(game.field.enabledColliders, 85);
  for (const t of COLOR_TILES) assert.ok(game.field.colliders[t.id].isEnabled() && Math.abs(game.field.colliders[t.id].translation().y) < 1e-6);
  assert.equal(game.schedule.cycle.index, 2);
  assert.equal(until(game, "target"), restoreTick + 54, "0.9 s preview");
  game.dispose();
});

// ─── Momentum grace (kept on purpose: the last-second save) ─────────────────

/**
 * Run along +x toward tile (2, 0) and drop every other tile when the pelvis is `gap` m short
 * of its near edge; keep running (stopping on it) or let go at the drop. Survived: standing
 * on it 2 s later.
 */
function graceRun(gap: number, sprint: boolean, letGo = false) {
  const { physics, tiles } = field();
  const goal = tile(2, 0);
  const c = place(physics, 0, -7, 0.86, 0);
  for (let i = 0; i < 30; i++) physics.step(IDLE);
  let dropped = false,
    after = 0;
  for (let t = 0; t < 600 && after <= 120 && !c.eliminated; t++) {
    const p = pelvis(c);
    if (!dropped && p.x >= goal.x - 1 - gap) {
      tiles.drop(COLOR_TILES.filter((u) => u.id !== goal.id).map((u) => u.id));
      dropped = true;
    }
    if (dropped) after++;
    const brake = goal.x - p.x < 0.2 + c.body.linvel().x ** 2 / 18;
    physics.step([(letGo && dropped) || brake ? IDLE_INPUT : walk(1, 0, { sprint }), IDLE_INPUT, IDLE_INPUT]);
  }
  const ok = !c.eliminated && pelvis(c).y > 0.3;
  physics.dispose();
  return ok;
}

test("momentum grace: running at the target when the floor drops, a player is caught by its edge from ≈ 1.1 m short (walking) / ≈ 1.6 m (sprinting); letting go or standing still is a fall", () => {
  for (const gap of [0, 0.5, 1.0]) assert.ok(graceRun(gap, false), `walking ${gap} m short: saved`);
  for (const gap of [1.3, 1.8]) assert.ok(!graceRun(gap, false), `walking ${gap} m short: falls`);
  for (const gap of [1.0, 1.5]) assert.ok(graceRun(gap, true), `sprinting ${gap} m short: saved`);
  for (const gap of [1.8, 2.2]) assert.ok(!graceRun(gap, true), `sprinting ${gap} m short: falls`);
  assert.ok(!graceRun(1.2, false, true), "keys released at the drop, 1.2 m short: falls");
});

// ─── Daralma (shrink) ───────────────────────────────────────────────────────

const count = (a: Uint8Array) => a.reduce((n, x) => n + x, 0);
/** Cycles 1…33 of a schedule (the round's timeline, no physics). */
function timeline(seed: number, players: 2 | 3) {
  const schedule = new ColorSchedule(seed, players),
    cycles: ColorCycle[] = [];
  while (schedule.cycle.index <= 33) {
    cycles.push(schedule.cycle);
    schedule.advance(schedule.cycle.restore);
  }
  return cycles;
}
/** Steps from every tile of `present` to the nearest `target` tile, walking only over `present`. */
function targetSteps(cycle: ColorCycle) {
  const distance = new Uint8Array(COLOR_TILES.length).fill(255),
    queue: number[] = [];
  cycle.colors.forEach((c, id) => {
    if (c === cycle.target) {
      distance[id] = 0;
      queue.push(id);
    }
  });
  for (let i = 0; i < queue.length; i++)
    for (const n of COLOR_NEIGHBOURS[queue[i]])
      if (distance[n] === 255 && cycle.present[n]) {
        distance[n] = distance[queue[i]] + 1;
        queue.push(n);
      }
  return distance;
}

test("daralma timeline: nothing before cycle 19 (70.5 s); the coloured field goes 85 → 73 → 61 → 43 → 31 → 19 → 7 → 4 → 0 and the last tiles drop at 119.4 s (cycle 32), inside the 125 s safety net", () => {
  assert.deepEqual(STAGE_SIZES, [85, 73, 61, 43, 31, 19, 7, 4, 0]);
  assert.deepEqual([SHRINK_START_CYCLE, FINAL_CYCLE], [19, 32]);
  const cycles = timeline(3, 3),
    c = (i: number) => cycles[i - 1];
  for (let i = 1; i < 19; i++) assert.deepEqual([c(i).stage, count(c(i).warned), count(c(i).present)], [0, 0, 85], `cycle ${i}`);
  assert.equal(c(19).start, 4230, "the first marks: 70.5 s");
  assert.equal(count(c(19).warned), 12);
  // [cut cycle, coloured tiles from then on, its start tick]
  const cuts = [
    [20, 73, 4446],
    [21, 61, 4662],
    [22, 43, 4878],
    [23, 31, 5094],
    [24, 19, 5310],
    [26, 7, 5742],
    [28, 4, 6174],
    [32, 0, 7038],
  ];
  for (const [cut, size, start] of cuts) {
    assert.equal(c(cut).start, start, `cycle ${cut} starts at ${start / 60} s`);
    assert.equal(STAGE_SIZES[c(cut).stage], size);
    assert.equal(shrinkStage(cut), shrinkStage(cut - 1) + 1);
    assert.equal(count(c(cut).present) - size, count(c(cut - 1).warned), "the marked tiles come back grey");
  }
  assert.deepEqual([c(32).final, c(31).final], [true, false]);
  assert.equal(c(32).drop, 7164, "final drop 119.4 s");
  assert.ok(c(32).drop + 90 < COLOR_TICKS.cap, "the safety net only follows the final drop");
  assert.deepEqual(FOUR_TILES.map((id) => COLOR_TILES[id].ring), [0, 1, 1, 1]);
  assert.equal(FOUR_TILES[0], HUB_TILE);
});

test("daralma is fair: every removed tile was marked a full cycle before and never leaves while it is the target; every present tile has the target ≤ 2 steps away over present tiles; all four colours stay in play until the final drop", () => {
  for (const players of [2, 3] as const)
    for (let seed = 0; seed < 12; seed++) {
      const cycles = timeline(seed, players);
      cycles.forEach((cycle, k) => {
        const label = `${players}p seed ${seed} cycle ${cycle.index}`,
          before = cycles[k - 1],
          next = cycles[k + 1],
          mask = STAGE_MASKS[cycle.stage];
        for (let id = 0; id < COLOR_TILES.length; id++) {
          const coloured = cycle.colors[id] !== NO_COLOR;
          assert.equal(coloured, !!mask[id], `${label}: colours exactly on the stage's tiles`);
          if (coloured) assert.ok(cycle.present[id], `${label}: a coloured tile is there`);
          const grey = cycle.present[id] && !coloured;
          if (grey) assert.ok(before && before.warned[id], `${label}: grey tile ${id} was marked the cycle before`);
          assert.equal(!!cycle.warned[id], coloured && !!next && !STAGE_MASKS[next.stage][id], `${label}: marked = coloured now, not next`);
          if (next && cycle.present[id] && !next.present[id]) {
            assert.notEqual(cycle.colors[id], cycle.target, `${label}: tile ${id} left while it was the target`);
            assert.ok(grey || cycle.warned[id], `${label}: tile ${id} left without a mark`);
          }
          if (next && cycle.colors[id] === cycle.target) assert.ok(next.present[id], `${label}: a target tile comes back`);
        }
        if (cycle.final) {
          assert.equal(colorCounts(cycle.colors).reduce((a, b) => a + b), 0);
          return;
        }
        assert.ok(colorCounts(cycle.colors).every((n) => n >= 1), `${label}: all four colours`);
        const steps = targetSteps(cycle);
        cycle.present.forEach((p, id) => p && assert.ok(steps[id] <= 2, `${label}: tile ${id} is ${steps[id]} steps from the target`));
        if (cycle.stage < LAYOUT_STAGE_COUNT) assert.ok(checkLayout(cycle.colors, cycle.stage).ok, `${label}: ${checkLayout(cycle.colors, cycle.stage).problems}`);
        else assert.deepEqual([...FOUR_TILES.map((id) => cycle.colors[id])].sort(), [0, 1, 2, 3], `${label}: one tile per colour`);
      });
    }
});

test("daralma layouts: every stage bank keeps its rules under all symmetries and palettes (balanced, patches of ≥ 2 for every colour, ≤ 2 steps also from the grey ring of the cut cycle), and the banks are what the designer makes", () => {
  const banks = colorLayoutBanks();
  assert.deepEqual(banks.stages.map((b) => b.length), [16, 8, 8, 8, 8, 8, 1]);
  assert.equal(SHRINK_LAYOUTS.length, LAYOUT_STAGE_COUNT - 1);
  const random = mulberry32(12);
  for (let stage = 1; stage < LAYOUT_STAGE_COUNT; stage++) {
    const rules = STAGE_RULES[stage];
    banks.stages[stage].forEach((layout, index) => {
      const check = checkLayout(layout, stage);
      assert.ok(check.ok, `stage ${stage} #${index}: ${check.problems}`);
      assert.ok(Math.max(...check.counts) - Math.min(...check.counts) <= rules.spread);
      assert.equal(check.counts.reduce((a, b) => a + b), STAGE_SIZES[stage]);
      for (const sizes of check.groups) assert.ok(Math.max(...sizes) >= rules.minLargest && sizes.length >= rules.minGroups);
      for (let i = 0; i < 8; i++) {
        const palette = [0, 1, 2, 3] as ColorIndex[];
        for (let k = 3; k > 0; k--) {
          const j = Math.floor(random() * (k + 1));
          [palette[k], palette[j]] = [palette[j], palette[k]];
        }
        assert.ok(checkLayout(applyPick({ bank: "cycle", stage, index, symmetry: Math.floor(random() * 12), palette }, 3), stage).ok);
      }
    });
  }
  // Single tiles are allowed only from 31 tiles down, and stay rare.
  for (let stage = 1; stage <= 3; stage++) for (const layout of banks.stages[stage]) assert.ok(colorGroups(layout).every((g) => g.tiles.length >= 2));
  // The seven-tile finale: the middle tile has its own colour, the ring alternates the other three.
  const seven = banks.stages[6][0];
  assert.deepEqual([...checkLayout(seven, 6).counts].sort(), [1, 2, 2, 2]);
  assert.equal(colorCounts(seven)[seven[HUB_TILE]], 1);
  // The first design of each stage bank, re-derived from the build script's seeds.
  for (let stage = 1; stage < LAYOUT_STAGE_COUNT; stage++) {
    let seed = 4000 + 1000 * (stage - 1);
    while (!checkLayout(designLayout(seed, 1, 24000, stage), stage).ok) seed++;
    assert.equal(encodeLayout(designLayout(seed, 1, 24000, stage)), SHRINK_LAYOUTS[stage - 1][0], `stage ${stage}`);
  }
});

/** At each announcement, put every surviving slot on a tile of the target colour (two share the only one on "four"). */
function keepSafe(game: ColorChaosGame) {
  const { colors, target } = game.schedule.cycle;
  const safe = COLOR_TILES.filter((t) => colors[t.id] === target).sort((a, b) => a.ring - b.ring);
  game.slots.forEach((slot, k) => {
    if (!game.round.alive[slot] || !safe.length) return;
    const t = safe[k % safe.length],
      offset = safe.length === 1 ? (k - 0.5) * 0.8 : 0;
    place(game.physics, slot, t.x + offset, STAND, t.z, 0);
  });
}

test("game: the field follows the shrink on exact ticks — marked tiles that drop stay down, grey tiles stand until the drop and never return — to the final drop, where the last one down wins (or a same-tick draw), well inside the safety net", () => {
  const { game } = started(2, 23);
  let restores = 0;
  for (let i = 0; i < 60 * 130 && game.round.phase === "playing"; i++) {
    game.step(IDLE);
    const t = game.round.tick - 1;
    if (game.event === "target") keepSafe(game);
    if (game.round.phase !== "playing") break;
    const schedule = game.schedule;
    for (const tile of COLOR_TILES) {
      const standing = schedule.standing(tile.id, t);
      if (game.field.intact(tile.id) !== standing) assert.fail(`tick ${t} cycle ${schedule.cycle.index} tile ${tile.id}: field ${game.field.intact(tile.id)}, schedule ${standing}`);
      if (game.field.colliders[tile.id].isEnabled() !== standing) assert.fail(`tick ${t}: collider ${tile.id}`);
    }
    if (game.event === "restore") {
      restores++;
      assert.equal(game.field.enabledColliders, count(schedule.cycle.present), `cycle ${schedule.cycle.index}: ${count(schedule.cycle.present)} tiles back`);
    }
  }
  assert.equal(game.round.phase, "results");
  assert.equal(restores, FINAL_CYCLE - 1);
  const drop = game.schedule.cycle.drop;
  assert.equal(game.schedule.cycle.index, FINAL_CYCLE);
  assert.ok(game.round.endedAt > drop && game.round.endedAt < drop + 90, `decided ${((game.round.endedAt - drop) / 60).toFixed(2)} s after the final drop`);
  assert.ok(game.round.reason === "survivor" || game.round.reason === "all-fell");
  assert.equal(game.physics.diagnostics.invalidBodies, 0);
  game.dispose();
});

test("game: whoever is still down in a hole when the tiles come back is out on that tick (never trapped inside a returning tile)", () => {
  const { game } = started(2, 12);
  const [safe] = standOn(game, [true, false]);
  const restore = game.schedule.cycle.restore;
  const hole = COLOR_TILES.find((t) => t.ring <= 2 && game.schedule.cycle.colors[t.id] !== game.schedule.cycle.target && Math.hypot(t.x - safe.x, t.z - safe.z) > 3)!;
  while (game.round.tick < restore - 1) game.step(IDLE);
  // Slot 1 hangs in the hole just below the surface as the tiles return.
  place(game.physics, 1, hole.x, -0.9, hole.z);
  game.physics.players[1].body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  game.step(IDLE);
  const t = game.round.tick;
  game.step(IDLE);
  assert.equal(game.event, "restore");
  assert.equal(game.round.outAt[1], t, "out on the restore tick");
  assert.deepEqual([game.round.winner, game.round.reason], [0, "survivor"]);
  assert.equal(game.physics.diagnostics.invalidBodies, 0);
  game.dispose();
});

// ─── Movement ───────────────────────────────────────────────────────────────

/** Walk a straight line; pelvis height range, lowest uprightness, largest vertical speed and pace. */
function traverse(physics: PlaygroundPhysics, from: { x: number; z: number }, to: { x: number; z: number }, sprint: boolean) {
  const dx = to.x - from.x,
    dz = to.z - from.z,
    d = Math.hypot(dx, dz);
  const c = place(physics, 0, from.x, STAND, from.z, Math.atan2(dx, dz));
  for (let i = 0; i < 30; i++) physics.step(IDLE);
  let lo = Infinity,
    hi = -Infinity,
    up = 1,
    vy = 0,
    tick = 0,
    speed = 0;
  for (; tick < 400; tick++) {
    const p = pelvis(c);
    if ((p.x - from.x) * dx + (p.z - from.z) * dz >= d * d) break;
    physics.step([walk(dx / d, dz / d, { sprint }), IDLE_INPUT, IDLE_INPUT]);
    if (tick < 36) continue;
    lo = Math.min(lo, pelvis(c).y);
    hi = Math.max(hi, pelvis(c).y);
    up = Math.min(up, upright(c));
    vy = Math.max(vy, Math.abs(c.body.linvel().y));
    const v = c.body.linvel();
    speed = Math.max(speed, Math.hypot(v.x, v.z));
  }
  return { range: hi - lo, up, vy, speed, fell: pelvis(c).y < 0.3, seconds: tick / 60 };
}

test("movement: sprint is the shared 1.4× (no stamina); jump unchanged; walking and sprinting over hex seams is as smooth as a slab", () => {
  assert.equal(RAGDOLL.sprintMultiplier, 1.4);
  const { physics } = field();
  const slab = new PlaygroundPhysics(silentFeedback, {
    ...COLORS_MAP,
    id: "test",
    colliders: [{ role: "floor", shape: "box", center: { x: 0, y: -0.25, z: 0 }, half: { x: 15, y: 0.25, z: 15 } }],
  });
  for (const c of slab.players) if (c.id !== 0) retire(c);
  const lines = [
    [{ x: -7, z: 0 }, { x: 7, z: 0 }],
    [{ x: -6, z: -3.5 }, { x: 6, z: 3.5 }],
    [{ x: -3.5, z: -6.5 }, { x: 3.5, z: 6.5 }],
  ];
  const speeds: Record<string, number> = {};
  for (const sprint of [false, true])
    for (const [from, to] of lines) {
      const hex = traverse(physics, from, to, sprint),
        flat = traverse(slab, from, to, sprint);
      const label = `${sprint ? "sprint" : "walk"} ${from.x},${from.z}: hex ${hex.range.toFixed(3)} m / ${hex.vy.toFixed(2)} m/s, slab ${flat.range.toFixed(3)} / ${flat.vy.toFixed(2)}`;
      assert.equal(hex.fell, false, label);
      assert.ok(hex.range <= flat.range + 0.02, `no seam bumps: ${label}`);
      assert.ok(hex.vy <= flat.vy + 0.25, `no seam bumps (vertical speed): ${label}`);
      assert.ok(hex.up > 0.85, `upright: ${label}`);
      assert.ok(Math.abs(hex.seconds - flat.seconds) < 0.1, `same pace: ${label}`);
      speeds[sprint ? "sprint" : "walk"] = hex.speed;
    }
  assert.ok(Math.abs(speeds.sprint / speeds.walk - 1.4) < 0.08, `sprint/walk ${(speeds.sprint / speeds.walk).toFixed(2)}`);
  // A standing jump: the shared 0.6 s arc, ≈ 1 m of pelvis rise, back down on the tile.
  const c = place(physics, 0, 0, STAND, 0);
  for (let i = 0; i < 40; i++) physics.step(IDLE);
  const base = pelvis(c).y;
  let apex = base,
    air = 0;
  for (let tick = 0; tick < 90; tick++) {
    physics.step([walk(0, 0, { jump: tick === 0 }), IDLE_INPUT, IDLE_INPUT]);
    apex = Math.max(apex, pelvis(c).y);
    if (pelvis(c).y > base + 0.05) air++;
  }
  assert.ok(apex - base > 0.85 && apex - base < 1.1, `apex +${(apex - base).toFixed(2)} m`);
  assert.ok(air / 60 > 0.45 && air / 60 < 0.7, `airtime ${(air / 60).toFixed(2)} s`);
  assert.ok(Math.abs(pelvis(c).y - base) < 0.08 && upright(c) > 0.9, "lands back on the tile");
  physics.dispose();
  slab.dispose();
});

// ─── Punch ──────────────────────────────────────────────────────────────────

test("punch: Renk Kaosu's own shove tuning (Katman Kaosu's values, Katman Kaosu's untouched) — 0.6 s cooldown, 3 m/s + 0.3 up, 0.35 s stagger, no health; grab and lift do nothing", () => {
  assert.deepEqual(COLOR_CHAOS.punch, { cooldown: 0.6, push: 3.0, lift: 0.3, stagger: { time: 0.35, posture: 0.7, mobility: 0.25 } });
  assert.deepEqual(LAYER_CHAOS.punch, { cooldown: 0.6, push: 3.0, lift: 0.3, stagger: { time: 0.35, posture: 0.7, mobility: 0.25 } });
  assert.notEqual(COLOR_CHAOS.punch, LAYER_CHAOS.punch, "separate tuning objects");
  const { game } = started(3, 3);
  assert.equal(game.brawl.tuning, COLOR_CHAOS.punch);
  const a = tile(0, 0);
  place(game.physics, 0, a.x - 0.5, STAND, a.z, Math.PI / 2);
  const victim = place(game.physics, 1, a.x + 0.5, STAND, a.z, -Math.PI / 2);
  place(game.physics, 2, -6, STAND, 0);
  for (let i = 0; i < 20; i++) game.step(IDLE);
  const before = pelvis(victim).x;
  let hit = null,
    swings = 0;
  // Punch held every step for 1.3 s: a swing every 0.6 s (36 ticks), alternating hands.
  const hands: number[] = [];
  for (let i = 0; i < 78; i++) {
    const punches = game.brawl.stats.punches;
    game.step([{ x: 0, z: 0, jump: false, punch: true, grab: true, lift: true }, IDLE_INPUT, IDLE_INPUT]);
    if (game.brawl.stats.punches > punches) {
      swings++;
      hands.push(game.brawl.fighters[0].punchHand);
    }
    hit ??= game.brawl.shoves[0] ?? null;
  }
  assert.equal(swings, 3, "ticks 0, 36, 72");
  assert.deepEqual(hands, [0, 1, 0]);
  assert.ok(hit, "the punch landed by hand contact");
  assert.deepEqual([hit.attacker, hit.target, hit.staggered], [0, 1, true]);
  assert.ok(pelvis(victim).x - before > 0.4, `shoved ${(pelvis(victim).x - before).toFixed(2)} m`);
  assert.ok(upright(victim) > 0.8, "a shove, not a topple");
  assert.equal(game.round.alive[1], true, "no health, no knockout");
  // Grab and lift never reach the controller: the effective intent is movement, jump, sprint only.
  const effective = game.brawl.inputs[0];
  assert.deepEqual(Object.keys(effective).sort(), ["jump", "sprint", "x", "z"]);
  assert.ok(!("hp" in game.brawl.fighters[0]) && !("knockout" in game.brawl.fighters[0]));
  game.dispose();
});

test("a last-second shove knocks a player near the edge of a target patch off it: they fall; well inside, they hold", () => {
  const trial = (inside: number) => {
    const { game } = started(2, 12);
    const { colors, target, drop } = game.schedule.cycle;
    // A target tile with a non-target tile beyond its +x side and any tile behind it.
    const t = COLOR_TILES.find((u) => {
      const beyond = colorTileAtCell({ q: u.q + 1, r: u.r }),
        behind = colorTileAtCell({ q: u.q - 1, r: u.r });
      return u.ring <= 3 && colors[u.id] === target && beyond && behind && colors[beyond.id] !== target;
    })!;
    assert.ok(t);
    place(game.physics, 1, t.x + 1 - inside, STAND, t.z, Math.PI / 2);
    place(game.physics, 0, t.x - inside, STAND, t.z, Math.PI / 2);
    let hit = -1;
    while (game.round.phase === "playing" && game.round.tick < drop + 100) {
      game.step([walk(0, 0, { punch: game.round.tick === drop - 20 }), IDLE_INPUT, IDLE_INPUT]);
      if (hit < 0 && game.brawl.shoves.length) hit = game.round.tick;
    }
    const out = { hit: hit >= 0 ? (drop - hit) / 60 : null, alive: game.round.alive[1], winner: game.round.winner };
    game.dispose();
    return out;
  };
  const near = trial(0.45);
  assert.ok(near.hit !== null && near.hit > 0 && near.hit < 0.4, `shove landed ${near.hit} s before the drop`);
  assert.deepEqual([near.alive, near.winner], [false, 0], "shoved off the colour: falls, the shover wins");
  const deep = trial(0.8);
  assert.equal(deep.alive, true, "0.8 m inside the patch edge the same shove is survivable");
});

// ─── Elimination and the round ──────────────────────────────────────────────

/** At the announcement: put `slots` on tiles of the target colour or not (colours from the schedule). */
function standOn(game: ColorChaosGame, onTarget: boolean[], mirror = false) {
  const { colors, target } = game.schedule.cycle;
  const picks: ColorTile[] = [];
  for (let slot = 0; slot < onTarget.length; slot++) {
    const want = onTarget[slot];
    // Interior tiles (a hole under a non-target tile has no ledge within reach), distinct.
    const t = COLOR_TILES.find(
      (t) =>
        t.ring <= 3 &&
        (colors[t.id] === target) === want &&
        !picks.includes(t) &&
        (want || COLOR_NEIGHBOURS[t.id].every((n) => colors[n] !== target)) &&
        (!mirror || slot === 0 || Math.abs(t.x - picks[0].x) < 1e-9)
    );
    assert.ok(t, `a ${want ? "target" : "non-target"} tile for slot ${slot}`);
    picks.push(t);
    place(game.physics, slot as PlayerId, t.x, STAND, t.z, 0);
  }
  return picks;
}

test("elimination: a player on a wrong colour falls through and is out within the unsafe window; on the target colour they stay; the last one standing wins", () => {
  const { game } = started(3, 8);
  standOn(game, [true, false, false]);
  const dropTick = game.schedule.cycle.drop;
  const outs: { id: number; tick: number; y: number }[] = [];
  let event = null;
  for (let i = 0; i < 400 && event !== "finished"; i++) {
    const tick = game.round.tick;
    event = game.step(IDLE);
    for (const id of game.eliminated) outs.push({ id, tick, y: game.physics.players[id].body.translation().y });
  }
  assert.equal(event, "finished");
  assert.deepEqual(outs.map((o) => o.id).sort(), [1, 2]);
  for (const o of outs) {
    assert.ok(o.tick > dropTick && o.tick < dropTick + COLOR_TICKS.unsafe, `out ${((o.tick - dropTick) / 60).toFixed(2)} s after the drop`);
    assert.ok(o.y < COLOR_CHAOS.eliminationY, "hips below the fall line");
  }
  assert.deepEqual([game.round.winner, game.round.reason], [0, "survivor"]);
  assert.equal(game.round.endedAt, Math.max(...outs.map((o) => o.tick)));
  const p = pelvis(game.physics.players[0]);
  assert.ok(p.y > 0.5 && upright(game.physics.players[0]) > 0.9, "the target-colour player still stands");
  game.dispose();
});

test("elimination: the last two falling on the same tick is a draw; results then a fresh round with every tile back", () => {
  const { game } = started(2, 12);
  // Mirror-image tiles (same x, opposite z) of other colours: identical falls.
  const picks = standOn(game, [false, false], true);
  assert.ok(Math.abs(picks[0].z + picks[1].z) < 1e-9 || Math.abs(picks[0].x - picks[1].x) < 1e-9);
  let event = null;
  for (let i = 0; i < 400 && event !== "finished"; i++) event = game.step(IDLE);
  assert.equal(event, "finished");
  assert.deepEqual(game.round.outAt.slice(0, 2), [game.round.endedAt, game.round.endedAt]);
  assert.deepEqual([game.round.winner, game.round.reason], [null, "all-fell"]);
  // Results 3.5 s, then a reset: every tile back, both players on their spawns, a new opening.
  let ticks = 0;
  while (game.step(IDLE) !== "reset") ticks++;
  assert.equal(ticks + 1, 210);
  assert.equal(game.field.enabledColliders, 85);
  assert.equal(game.round.phase, "countdown");
  assert.deepEqual(game.round.alive.slice(0, 2), [true, true]);
  assert.equal(game.schedule.cycle.pick.bank, "opening");
  game.dispose();
});

test("jumping over the drop does not save a player: landing where a tile went is still a fall", () => {
  const { game } = started(2, 14);
  standOn(game, [false, true]);
  const dropTick = game.schedule.cycle.drop;
  // Jump 0.2 s before the drop: up while it goes, down into the hole.
  let event = null;
  for (let i = 0; i < 400 && event !== "finished"; i++) event = game.step([walk(0, 0, { jump: game.round.tick === dropTick - 12 }), IDLE_INPUT, IDLE_INPUT]);
  assert.deepEqual([event, game.round.winner], ["finished", 1]);
  game.dispose();
});

// ─── Bots ───────────────────────────────────────────────────────────────────

test("bots respond to the target: from every spawn they reach a tile of the announced colour before the drop and survive the first cycles", () => {
  for (const players of [3, 2] as const)
    for (const seed of [1, 2, 3]) {
      const game = new ColorChaosGame(silentFeedback, { players, seed });
      const random = mulberry32(seed * 7);
      const bots = ([0, 1, 2] as const).map((id) => new ColorBot(id, random));
      bots.forEach((b) => b.reset());
      const inputs = () => bots.map((b) => b.update(game));
      while (game.step(inputs()) !== "started");
      for (let cycle = 0; cycle < 3; cycle++) {
        until(game, "drop", inputs);
        const { colors, target } = game.schedule.cycle;
        for (const slot of game.slots) {
          const p = pelvis(game.physics.players[slot]),
            under = colorTileAt(p.x, p.z);
          assert.ok(under && colors[under.id] === target, `${players}p seed ${seed} cycle ${cycle + 1}: bot ${slot} on ${COLOR_IDS[target]}`);
        }
        until(game, "restore", inputs);
        assert.equal(game.round.survivors.length, players, "everyone survives the forgiving first cycles");
      }
      game.dispose();
    }
});

test("a bot two steps from the target at the fastest timer (1.2 s) sprints there in time", () => {
  const { game } = started(2, 31);
  game.schedule.cycle.index = 10; // the next cycle is the 11th: 1.2 s
  standOn(game, [true, true]);
  until(game, "restore");
  const { colors, target } = game.schedule.cycle;
  assert.equal(game.schedule.cycle.drop - game.schedule.cycle.announce, 72);
  const reach = colorReach(colors)[target];
  const far = COLOR_TILES.find((t) => reach[t.id] === 2 && t.ring <= 3)!;
  assert.ok(far, "a tile two steps from the target colour");
  const bot = new ColorBot(1, () => 0.5); // 0.475 s reaction, no slip
  bot.reset();
  const safe = COLOR_TILES.find((t) => colors[t.id] === target && hexDistance(t, far) >= 4)!;
  place(game.physics, 0, safe.x, STAND, safe.z);
  place(game.physics, 1, far.x, STAND, far.z);
  let sprinted = false;
  const dropTick = game.schedule.cycle.drop;
  while (game.round.tick <= dropTick) {
    const input = bot.update(game);
    sprinted ||= !!input.sprint;
    game.step([IDLE_INPUT, input, IDLE_INPUT]);
  }
  const p = pelvis(game.physics.players[1]),
    under = colorTileAt(p.x, p.z);
  assert.ok(sprinted, "sprinted");
  assert.ok(under && colors[under.id] === target, "on the target colour at the drop");
  until(game, "restore");
  assert.equal(game.round.alive[1], true);
  game.dispose();
});

test("bots on the shrinking field: they walk only over tiles that are there, leave grey tiles before the drop and keep playing to the end", () => {
  let checked = 0,
    walked = 0;
  for (const players of [3, 2] as const)
    for (const seed of [1, 2]) {
      const game = new ColorChaosGame(silentFeedback, { players, seed });
      const random = mulberry32(seed * 3);
      const bots = ([0, 1, 2] as const).map((id) => new ColorBot(id, random));
      bots.forEach((b) => b.reset());
      const inputs = () => bots.map((b) => b.update(game));
      while (game.step(inputs()) !== "started");
      game.schedule.cycle.index = SHRINK_START_CYCLE - 2; // the next cycle marks the first rim
      const shoved = [-99, -99, -99];
      for (let i = 0; i < 60 * 70 && game.round.phase === "playing"; i++) {
        game.step(inputs());
        for (const shove of game.brawl.shoves) shoved[shove.target] = game.round.tick;
        if (game.round.phase !== "playing") break;
        const cycle = game.schedule.cycle,
          t = game.round.tick - 1;
        for (const slot of game.round.survivors) {
          const p = pelvis(game.physics.players[slot]),
            under = colorTileAt(p.x, p.z);
          // Down, falling or just shoved: not walking on its own.
          if (p.y < 0.4 || game.round.tick - shoved[slot] < 42) continue;
          walked++;
          assert.ok(under && cycle.present[under.id], `${players}p seed ${seed} cycle ${cycle.index}: bot ${slot} over a missing tile`);
          if (t === cycle.drop) {
            checked++;
            assert.notEqual(cycle.colors[under.id], NO_COLOR, `${players}p seed ${seed} cycle ${cycle.index}: bot ${slot} still on a grey tile at the drop`);
          }
        }
      }
      assert.equal(game.round.phase, "results", `${players}p seed ${seed}: the round ends`);
      game.dispose();
    }
  assert.ok(checked > 20 && walked > 5000, `${checked} drops, ${walked} bot-ticks`);
});

test("a whole bot round is deterministic for the same seed and ends with a winner", () => {
  const play = (seed: number) => {
    const game = new ColorChaosGame(silentFeedback, { players: 3, seed });
    const random = mulberry32(seed);
    const bots = ([0, 1, 2] as const).map((id) => new ColorBot(id, random));
    bots.forEach((b) => b.reset());
    let event = null;
    for (let i = 0; i < 60 * 190 && event !== "finished"; i++) event = game.step(bots.map((b) => b.update(game)));
    const out = { event, winner: game.round.winner, reason: game.round.reason, endedAt: game.round.endedAt, cycle: game.schedule.cycle.index, outAt: [...game.round.outAt], faults: game.physics.diagnostics.invalidBodies, stats: { ...game.brawl.stats } };
    game.dispose();
    return out;
  };
  const a = play(4),
    b = play(4);
  assert.equal(a.event, "finished");
  assert.equal(a.reason, "survivor");
  assert.ok(a.cycle > 10, `lasted into cycle ${a.cycle}`);
  assert.equal(a.faults, 0);
  assert.deepEqual(b, a);
});

// ─── Camera, controls, presentation ─────────────────────────────────────────

test("camera: 5.3 m boom, 28° down, 60° FOV, pivot 0.9 m over the hips, centred; a jump barely lifts it; a fall looks down through the hole without the camera diving", () => {
  assert.deepEqual([COLOR_CAMERA.fov, COLOR_CAMERA.boom, COLOR_CAMERA.pivotHeight], [60, 5.3, 0.9]);
  assert.ok(Math.abs((COLOR_CAMERA.restPitch * 180) / Math.PI - 28) < 1e-9);
  const follow = new ColorFollow();
  const stand = { x: 0, y: 0.78, z: 0 };
  const pivot = { ...follow.update(stand, false, 1 / 60) };
  assert.ok(Math.abs(pivot.y - 1.68) < 1e-9 && pivot.x === 0 && pivot.z === 0, "centred, 0.9 m over the hips");
  const at = colorCameraPosition(pivot, 0, COLOR_CAMERA.restPitch);
  assert.ok(Math.abs(Math.hypot(at.x - pivot.x, at.y - pivot.y, at.z - pivot.z) - 5.3) < 1e-9);
  assert.ok(at.z < 0 && Math.abs(at.x) < 1e-9, "behind the look direction, no shoulder offset");
  // Jump: pelvis +0.96 m → pivot at most 0.15 of it.
  let highest = 0;
  for (let i = 0; i < 36; i++) highest = Math.max(highest, follow.update({ x: 0, y: 0.78 + 0.96 * Math.sin((i / 36) * Math.PI), z: 0 }, false, 1 / 60).y);
  assert.ok(highest - 1.68 < 0.15, `jump lift ${(highest - 1.68).toFixed(3)} m`);
  // Falling through a hole: the pivot stays at standing height, the view tilts down toward the body.
  for (let i = 0; i < 60; i++) follow.update({ x: 0, y: 0.78 - i * 0.1, z: 0 }, true, 1 / 60);
  assert.ok(follow.pivot!.y >= 1.68 - 1e-9, "no dive");
  assert.ok(follow.lookDrop > 2, `looks ${follow.lookDrop.toFixed(2)} m down`);
  // Jumps never count as falling; sinking into a hole does.
  const fall = new ColorFall();
  for (let i = 0; i < 36; i++) assert.equal(fall.update(0.78 + 0.96 * Math.sin((i / 36) * Math.PI), -3), false);
  assert.equal(fall.update(0.2, -3), true);
});

test("controls: WASD camera-relative, Shift sprint, Space jump, F shove; the controls line names them", () => {
  const intent = layerIntent({ x: 0, z: -1, jump: true, punch: true, grab: false, lift: true }, 0);
  assert.ok(Math.abs(intent.z - 1) < 1e-9 && Math.abs(intent.x) < 1e-9, "forward = +z at yaw 0");
  assert.deepEqual([intent.jump, intent.punch, intent.sprint], [true, true, true]);
  assert.equal(controlHint(defaultBindings(), "colors"), "WASD hareket · Shift koş · Space zıpla · F it · Esc menü");
});

test("palette: four distinct colours, one symbol each; scenery is one merged mesh far from play (≥ 32 m out, no top above 6 m)", () => {
  assert.equal(new Set(TILE_HEX).size, 4);
  assert.deepEqual([...COLOR_IDS], ["blue", "yellow", "green", "pink"]);
  const mesh = buildScenery();
  const position = mesh.geometry.getAttribute("position");
  let nearest = Infinity,
    top = -Infinity;
  const v = new Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    nearest = Math.min(nearest, Math.hypot(v.x, v.z));
    top = Math.max(top, v.y);
  }
  assert.ok(nearest >= SCENERY_CLEAR_RADIUS, `nearest vertex ${nearest.toFixed(1)} m`);
  assert.ok(top <= SCENERY_TOP_MAX, `highest ${top.toFixed(1)} m`);
  const triangles = position.count / 3;
  assert.ok(triangles < 10000, `${triangles} triangles`);
  assert.ok(!Array.isArray(mesh.material), "one material: one draw call");
  mesh.geometry.dispose();
});

// ─── Regression ─────────────────────────────────────────────────────────────

test("regression: Katman Kaosu keeps its own round timing, shove tuning and 297-tile field; Renk Kaosu stays out of the static map registry", () => {
  const round = new LayerRound();
  let ticks = 0;
  while (round.step() !== "started") ticks++;
  assert.equal(ticks + 1, LAYER_TICKS.countdown);
  const physics = new PlaygroundPhysics(silentFeedback, LAYERS_MAP);
  const brawl = new LayerBrawl(physics);
  assert.equal(brawl.tuning, LAYER_CHAOS.punch);
  assert.equal(new TileField(physics.world).colliders.length, LAYER_TILES.length);
  physics.dispose();
  const layers = new LayerChaosGame(silentFeedback, { players: 3 });
  assert.equal(layers.brawl.tuning, LAYER_CHAOS.punch);
  layers.dispose();
  assert.deepEqual([...ARENA_MAP_IDS].sort(), ["barn", "rooftop", "test"]);
});
