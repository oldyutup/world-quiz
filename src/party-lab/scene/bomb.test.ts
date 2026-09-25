import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { silentFeedback, SFX_NAMES, type FeedbackEvent } from "../audio/events";
import type { MovementInput } from "../input/types";
import { defaultBindings } from "../input/defaults";
import { controlHint } from "./arenaMenu";
import { initializePhysics, IDLE_INPUT } from "./physics";
import type { PlayerId } from "./players";
import { restore, type Character } from "./ragdoll/character";
import { retire } from "./layers/game";

import { layerIntent } from "./layers/controls";
import { BombBot, bombNav, TRAP, trapPenalty } from "./bomb/bots";
import { BOMB_CAMERA, bombCameraBlockers, bombCameraPose, BombFollow, clampBombPitch } from "./bomb/bombCamera";
import { BombTagGame } from "./bomb/game";
import { buildBombArena, TRAP_MAT } from "./bomb/arena";
import { BombNav, NAV } from "./bomb/nav";
import { BOMB_KIT_NODES, CLOUD_CLEAR_RADIUS, cloudPlacements, cratePlacements, LEDGE_PROP_MAX, ledgePlacements, type Placement } from "./bomb/scenery";
import { insideBlockers } from "./arenas/barnCamera";
import { ARENA_MAP_IDS, ARENA_MAPS } from "../../../shared/party-lab/maps";
import {
  AC_UNITS,
  BOMB_ARENA,
  BOMB_MAP,
  BOMB_SPAWNS,
  BOMB_TRAPS,
  CATWALKS,
  CRATE_BLOCKS,
  DECK_HEIGHT,
  HOP_WALL_HEIGHT,
  HOP_WALLS,
  JUMP_SHORTCUTS,
  L_WALL_NW,
  L_WALL_SE,
  LOW_COVER_HEIGHT,
  PERIMETER,
  POCKET_WALL_HEIGHT,
  RAMPS,
  surfaceBelow,
} from "../../../shared/party-lab/maps/bomb";
import type { ArenaCollider } from "../../../shared/party-lab/maps/types";
import { BOMB_TAG, BOMB_TICKS } from "../../../shared/party-lab/simulation/bomb/config";
import { COLOR_CHAOS } from "../../../shared/party-lab/simulation/colors/config";
import { LAYER_CHAOS } from "../../../shared/party-lab/simulation/layers/config";
import { ColorChaosGame } from "./colors/game";
import { LayerChaosGame } from "./layers/game";
import { BombRules } from "../../../shared/party-lab/simulation/bomb/rules";
import { mulberry32 } from "../../../shared/party-lab/simulation/colors/layouts";
import { GAME_MODES, MODE_SELECTIONS } from "../../../shared/party-lab/modes";
import { NET } from "../../../shared/party-lab/network/protocol";
import { BARN_COMBAT } from "../../../shared/party-lab/simulation/barn/config";
import { TRAPS as BARN_TRAPS } from "../../../shared/party-lab/maps/barn";
import { BombTraps } from "../../../shared/party-lab/simulation/bomb/traps";

before(() => initializePhysics());

const IDLE: MovementInput[] = [IDLE_INPUT, IDLE_INPUT, IDLE_INPUT];
const walk = (x: number, z: number, extra: Partial<MovementInput> = {}): MovementInput => ({ x, z, jump: false, ...extra });
/** A game fast-forwarded to its first playing tick (the countdown elapsed). */
function started(players: 2 | 3 = 3, seed = 7) {
  const game = new BombTagGame(silentFeedback, { players, seed });
  let ticks = 0;
  while (game.step(IDLE) !== "started") ticks++;
  return { game, countdown: ticks + 1 };
}
/** Put a body standing at floor point (x, z) facing `yaw` (pelvis at standing height over the surface there). */
function place(character: Character, x: number, z: number, yaw: number, floor = surfaceBelow(x, z)) {
  restore(character, { x, y: floor + 0.9, z }, yaw);
}
const pelvis = (game: BombTagGame, id: PlayerId) => game.physics.players[id].body.translation();
/** Only these slots stay in the world (the rest retired, still "alive" in the round). */
function only(game: BombTagGame, keep: PlayerId[]) {
  for (const c of game.physics.players) if (!keep.includes(c.id)) retire(c);
}
function steps(game: BombTagGame, seconds: number, inputs: (t: number) => MovementInput[] = () => IDLE) {
  for (let i = 0; i < Math.round(seconds * 60); i++) game.step(inputs(i / 60));
}
const facing = (dx: number, dz: number) => Math.atan2(dx, dz);
const colliders = (role: string) => BOMB_MAP.colliders.filter((c) => c.role === role);
const top = (c: ArenaCollider) => (c.shape === "cylinder" ? c.center.y + c.halfHeight : c.center.y + c.half.y);

// ─── Map ────────────────────────────────────────────────────────────────────

test("map: a 20 × 20 m walled playground, symmetric under a half turn, outside the static map registry", () => {
  assert.equal(BOMB_MAP.id, "bomb");
  assert.deepEqual(BOMB_MAP.bounds, { minX: -10, maxX: 10, minZ: -10, maxZ: 10 });
  assert.ok(!(ARENA_MAP_IDS as string[]).includes("bomb") && !("bomb" in ARENA_MAPS));
  assert.deepEqual(BOMB_MAP.lethalEdges, []);
  const solids = BOMB_MAP.colliders.filter((c) => c.role !== "floor");
  for (const c of BOMB_MAP.colliders) {
    assert.ok(c.shape !== "cylinder");
    const values = [...Object.values(c.center), ...Object.values(c.half)];
    assert.ok(values.every(Number.isFinite) && c.half.x > 0 && c.half.y > 0 && c.half.z > 0, c.role);
    assert.ok(Math.abs(c.center.x) + c.half.x <= 12.5 + 1e-9 && Math.abs(c.center.z) + c.half.z <= 12.5 + 1e-9, c.role);
  }
  // Every solid has a twin at (−x, −z) with the same size (a ramp rising the other way).
  const flip = { "+x": "-x", "-x": "+x", "+z": "-z", "-z": "+z" } as const;
  for (const c of solids) {
    if (c.shape === "cylinder") continue;
    const twin = solids.find(
      (o) =>
        o !== c &&
        o.shape === c.shape &&
        // The AC units' twins are crates (same blocks, another look).
        (o.role === c.role || [o.role, c.role].sort().join() === "condenser,crate") &&
        Math.abs(o.center.x + c.center.x) < 1e-9 &&
        Math.abs(o.center.z + c.center.z) < 1e-9 &&
        Math.abs(o.center.y - c.center.y) < 1e-9 &&
        Math.abs(o.half.x - c.half.x) < 1e-9 &&
        Math.abs(o.half.z - c.half.z) < 1e-9 &&
        (c.shape !== "ramp" || (o.shape === "ramp" && o.rises === flip[c.rises]))
    );
    assert.ok(twin, `${c.role} at (${c.center.x}, ${c.center.z}) has a half-turn twin`);
  }
  assert.equal(colliders("parapet").length, 4);
  assert.equal(colliders("wall").length, 4);
  assert.equal(colliders("condenser").length + colliders("crate").length, 4);
  assert.equal(colliders("deck").length, 2);
  assert.equal(colliders("stairs").length, 2);
  assert.equal(colliders("hop").length, 2);
});

test("heights from the measured ragdoll: pocket walls and the perimeter stop everyone; low cover, catwalks and hop walls take a jump", () => {
  // A walker steps 0.65 m; a running jump makes a 1.1 m ledge easily and a 0.9 m wall from almost
  // anywhere; nothing ≥ 1.5 m above the surface in front of it is ever crossed (Rooftop's audit).
  assert.ok(POCKET_WALL_HEIGHT >= 1.6);
  assert.ok(LOW_COVER_HEIGHT > 0.65 && LOW_COVER_HEIGHT <= 1.15);
  assert.ok(DECK_HEIGHT > 0.65 && DECK_HEIGHT <= 1.1);
  assert.ok(HOP_WALL_HEIGHT > 0.65 && HOP_WALL_HEIGHT <= 0.9);
  const highest = Math.max(...bombNav().nodes.map((n) => n.y));
  assert.equal(highest, LOW_COVER_HEIGHT, "the highest standable top is an AC unit / crate");
  for (const c of colliders("parapet")) assert.ok(top(c) - highest >= 2.0, "the perimeter stands ≥ 2 m over every standable top");
  for (const r of RAMPS) {
    const run = r.x[1] - r.x[0];
    assert.ok((Math.atan2(r.height, run) * 180) / Math.PI < 27, "ramps ≤ 27° (Rooftop's stairs are 26.6°)");
  }
  for (const s of JUMP_SHORTCUTS) assert.equal(Math.round(s.gap * 100) / 100, 1.5);
  // No tall piece that a top could reach: pocket walls are ≥ 2 m from every raised top.
  const tops = [...AC_UNITS, ...CRATE_BLOCKS, ...CATWALKS];
  for (const w of [...L_WALL_NW, ...L_WALL_SE])
    for (const t of tops) {
      const dx = Math.max(0, t.x[0] - w.x[1], w.x[0] - t.x[1]),
        dz = Math.max(0, t.z[0] - w.z[1], w.z[0] - t.z[1]);
      assert.ok(Math.hypot(dx, dz) >= 2 || w.height - t.height >= 1.5, "a pocket wall out of reach of every top");
    }
});

test("spawns: three 120° apart on a 5 m circle, two on opposite sides; all on open floor, ≥ 8 m apart", () => {
  const nav = bombNav();
  for (const [n, spawns] of Object.entries(BOMB_SPAWNS)) {
    assert.equal(spawns.length, Number(n));
    for (const s of spawns) {
      assert.equal(surfaceBelow(s.x, s.z), 0);
      const node = nav.nodeAt(s.x, s.y, s.z);
      assert.ok(Math.hypot(nav.nodes[node].x - s.x, nav.nodes[node].z - s.z) < 0.5, "on a walkable cell");
      assert.ok(nav.openness[node] > 0.9, "in the open");
    }
    for (let i = 0; i < spawns.length; i++)
      for (let j = i + 1; j < spawns.length; j++) assert.ok(Math.hypot(spawns[i].x - spawns[j].x, spawns[i].z - spawns[j].z) >= 8);
  }
  for (const s of BOMB_SPAWNS[3]) assert.ok(Math.abs(Math.hypot(s.x, s.z) - 5) < 0.01);
});

test("navigation: one connected playground; every corner pocket has at least two ways out; the jump shortcuts and hop walls are in the graph", () => {
  const nav = bombNav();
  const from = nav.field(nav.nodeAt(0, 0.8, 0));
  assert.ok(nav.nodes.every((n) => Number.isFinite(from.dist[n.id])), "everything reachable from the middle");
  for (const n of nav.nodes) assert.ok(Number.isFinite(nav.field(n.id).dist[from.from]), "the middle is reachable from everywhere");
  // Corner regions (outside x, z = ±5): walk exits, grouped by adjacency.
  const corners = [
    { name: "NW", inside: (x: number, z: number) => x < -5.6 && z < -5.6 },
    { name: "SE", inside: (x: number, z: number) => x > 5.6 && z > 5.6 },
    { name: "NE", inside: (x: number, z: number) => x > 5.0 && z < -6.0 },
    { name: "SW", inside: (x: number, z: number) => x < -5.0 && z > 6.0 },
  ];
  for (const corner of corners) {
    const exits = nav.nodes.filter((n) => n.y < 0.05 && corner.inside(n.x, n.z) && nav.edges[n.id].some((e) => e.kind === "walk" && !corner.inside(nav.nodes[e.to].x, nav.nodes[e.to].z)));
    const groups: (typeof exits)[] = [];
    for (const n of exits) {
      const group = groups.find((g) => g.some((m) => Math.hypot(m.x - n.x, m.z - n.z) <= NAV.cell * 1.5));
      if (group) group.push(n);
      else groups.push([n]);
    }
    assert.ok(groups.length >= 2, `${corner.name} corner has ${groups.length} walking exits`);
  }
  const leaps = nav.nodes.flatMap((n) => nav.edges[n.id].filter((e) => e.kind === "leap").map((e) => [n, nav.nodes[e.to]] as const));
  for (const s of JUMP_SHORTCUTS) {
    assert.ok(leaps.some(([a, b]) => Math.abs(a.y - DECK_HEIGHT) < 0.01 && Math.abs(b.y - LOW_COVER_HEIGHT) < 0.01 && Math.sign(b.x - a.x) === Math.sign(s.to.x - s.from.x)), "catwalk → corner top");
    assert.ok(leaps.some(([a, b]) => Math.abs(a.y - LOW_COVER_HEIGHT) < 0.01 && Math.abs(b.y - DECK_HEIGHT) < 0.01 && Math.sign(b.x - a.x) === -Math.sign(s.to.x - s.from.x)), "and back");
  }
  for (const w of HOP_WALLS) {
    const cx = (w.x[0] + w.x[1]) / 2;
    const hops = nav.nodes.filter((n) => nav.edges[n.id].some((e) => e.kind === "hop" && Math.sign(nav.nodes[e.to].x - cx) !== Math.sign(n.x - cx) && Math.abs(n.z) < 3));
    assert.ok(hops.some((n) => n.x < cx) && hops.some((n) => n.x > cx), "hops over each hop wall both ways");
  }
});

// ─── Rules (pure) ───────────────────────────────────────────────────────────

test("rules: a carrier is picked at the start and shown unlit; the fuse lights on play and burns 14 s; a pass carries the fuse over; no tag-back for 1 s", () => {
  const rules = new BombRules(mulberry32(3));
  rules.start([0, 1, 2]);
  assert.equal(rules.phase, "pending");
  assert.ok(rules.carrier !== null);
  assert.deepEqual(rules.tick([0, 1, 2]), [], "nothing burns before it is lit");
  const carrier = rules.carrier!;
  assert.deepEqual(rules.light(), { type: "armed", carrier });
  assert.equal(rules.fuse, BOMB_TICKS.fuse);
  assert.equal(BOMB_TICKS.fuse, 14 * 60);
  for (let i = 0; i < 300; i++) assert.deepEqual(rules.tick([0, 1, 2]), []);
  const to = ((carrier + 1) % 3) as PlayerId;
  const pass = rules.pass(carrier, to, [0, 1, 2]);
  assert.deepEqual(pass, { type: "pass", from: carrier, to, fuse: BOMB_TICKS.fuse - 300 });
  assert.equal(rules.fuse, BOMB_TICKS.fuse - 300, "no reset, no refill");
  assert.equal(rules.refusal(to, carrier, [0, 1, 2]), "tag-back");
  assert.equal(rules.pass(to, carrier, [0, 1, 2]), null);
  assert.equal(rules.refusal(carrier, to, [0, 1, 2]), "not-carrier");
  const third = [0, 1, 2].find((id) => id !== carrier && id !== to) as PlayerId;
  assert.equal(rules.refusal(to, third, [0, 1, 2]), null, "the third player is fair game at once");
  assert.equal(rules.refusal(to, to, [0, 1, 2]), "self");
  assert.equal(rules.refusal(to, third, [carrier, to]), "out");
  for (let i = 0; i < BOMB_TICKS.tagBack - 1; i++) rules.tick([0, 1, 2]);
  assert.equal(rules.refusal(to, carrier, [0, 1, 2]), "tag-back", "still protected on its last tick");
  rules.tick([0, 1, 2]);
  assert.equal(rules.refusal(to, carrier, [0, 1, 2]), null, "tag-back ends after exactly 1 s");
  assert.equal(rules.passes, 1);
});

test("rules: at 0 the carrier blasts; with two or more left the next carrier is picked at once and lit 2.5 s later with a full fuse; with one left the bomb is gone", () => {
  const rules = new BombRules(mulberry32(9));
  rules.start([0, 1, 2]);
  rules.light();
  const first = rules.carrier!;
  let events = rules.tick([0, 1, 2]);
  let armedTicks = 1;
  while (!events.length) {
    events = rules.tick([0, 1, 2]);
    armedTicks++;
  }
  assert.equal(armedTicks, BOMB_TICKS.fuse, "blast exactly when the fuse runs out");
  assert.equal(events[0].type, "blast");
  assert.equal(events[0].type === "blast" && events[0].carrier, first);
  assert.equal(events[1]?.type, "next");
  const next = rules.carrier!;
  assert.ok(next !== first && [0, 1, 2].includes(next));
  assert.equal(rules.phase, "pending");
  assert.equal(rules.held[first], BOMB_TICKS.fuse);
  const alive = [0, 1, 2].filter((id) => id !== first) as PlayerId[];
  let gap = 0;
  do {
    events = rules.tick(alive);
    gap++;
  } while (!events.length);
  assert.equal(gap, BOMB_TICKS.gap);
  assert.deepEqual(events, [{ type: "armed", carrier: next }]);
  assert.equal(rules.fuse, BOMB_TICKS.fuse);
  // Two left: the next blast leaves one, and the bomb is gone.
  const other = alive.find((id) => id !== next)!;
  for (let i = 0; i < BOMB_TICKS.fuse - 1; i++) rules.tick(alive);
  assert.deepEqual(rules.tick(alive), [{ type: "blast", carrier: next }]);
  assert.equal(rules.carrier, null);
  assert.ok(other !== next);
  // A carrier who drops out without a blast (a fall) hands it on the same way.
  const fell = new BombRules(mulberry32(4));
  fell.start([0, 1, 2]);
  fell.light();
  const gone = fell.carrier!;
  const moved = fell.drop([0, 1, 2]);
  assert.equal(moved.length, 1);
  assert.ok(moved[0].type === "next" && moved[0].carrier !== gone);
  assert.equal(fell.phase, "pending");
  assert.equal(fell.gapLeft, BOMB_TICKS.gap);
});

// ─── Game ───────────────────────────────────────────────────────────────────

test("game: 3 s frozen countdown with the first carrier already shown; the fuse lights on the first playing tick", () => {
  const game = new BombTagGame(silentFeedback, { players: 3, seed: 5 });
  assert.equal(game.round.phase, "countdown");
  assert.ok(game.bomb.carrier !== null && game.bomb.phase === "pending");
  const before = pelvis(game, 0);
  let ticks = 0;
  while (game.step([walk(1, 0), walk(0, 1), walk(-1, 0)]) !== "started") ticks++;
  assert.equal(ticks + 1, BOMB_TICKS.countdown);
  const after = pelvis(game, 0);
  // Inputs are ignored (walking would cover ~14 m); only the shared idle creep remains.
  assert.ok(Math.hypot(after.x - before.x, after.z - before.z) < 0.3, "frozen through the countdown");
  assert.equal(game.bomb.phase, "pending");
  game.step(IDLE);
  assert.equal(game.bomb.phase, "armed");
  assert.equal(game.events[0]?.type, "armed");
  assert.equal(game.bomb.fuse, BOMB_TICKS.fuse - 1);
  game.dispose();
});

/** Two players 1.1 m apart in the open, slot `a` holding the lit bomb and facing `b`. */
function faceOff(a: PlayerId = 0, b: PlayerId = 1) {
  const { game } = started(2, 21);
  game.bomb.carrier = a;
  place(game.physics.players[a], -0.55, 0, facing(1, 0));
  place(game.physics.players[b], 0.55, 0, facing(-1, 0));
  steps(game, 0.4);
  return game;
}
function punchUntil(game: BombTagGame, who: PlayerId, toward: number, seconds: number, stop: () => boolean) {
  for (let i = 0; i < seconds * 60 && !stop(); i++) {
    const inputs = [...IDLE];
    inputs[who] = walk(toward * 0.25, 0, { punch: true });
    game.step(inputs);
  }
}

test("game: the carrier's landed punch passes the bomb — fuse carried over, the receiver shoved and staggered, the passer protected for 1 s", () => {
  const game = faceOff(0, 1);
  const fuse = game.bomb.fuse;
  let pass: { from: PlayerId; to: PlayerId; fuse: number } | null = null,
    ticks = 0;
  punchUntil(game, 0, 1, 2, () => {
    ticks++;
    const e = game.events.find((x) => x.type === "pass");
    if (e && e.type === "pass") pass = e;
    return !!pass;
  });
  assert.ok(pass, "a punch in reach passes it");
  const p = pass as unknown as { from: PlayerId; to: PlayerId; fuse: number };
  assert.equal(p.from, 0);
  assert.equal(p.to, 1);
  // `ticks` counts the stop checks: one before each step, and the one that saw the pass.
  assert.equal(p.fuse, fuse - (ticks - 1), "the fuse kept burning through the pass: no reset");
  assert.equal(game.bomb.carrier, 1);
  assert.equal(game.bomb.immune, 0);
  assert.ok(game.brawl.fighters[1].stagger.time > 0, "the receiver is staggered (the passer's escape window)");
  // The new carrier punches straight back: shoved, but the bomb stays (no tag-back).
  let refused = 0;
  for (let i = 0; i < 50; i++) {
    game.step([IDLE_INPUT, walk(-0.3, 0, { punch: true }), IDLE_INPUT]);
    refused += game.refused.filter((r) => r.why === "tag-back").length;
    assert.equal(game.bomb.carrier, 1, "no pass back within the protection");
  }
  assert.ok(refused >= 0);
  game.dispose();
});

test("game: a punch by a player without the bomb only shoves; the bomb stays", () => {
  const game = faceOff(0, 1);
  let shoves = 0;
  punchUntil(game, 1, -1, 2, () => {
    shoves += game.brawl.shoves.filter((s) => s.attacker === 1).length;
    return shoves > 0;
  });
  assert.ok(shoves > 0, "the shove landed");
  assert.equal(game.bomb.carrier, 0);
  assert.equal(game.bomb.passes, 0);
  game.dispose();
});

test("game: at 0 the carrier blows up — out of the round, everyone within 3 m shoved away; 3 players: a survivor is next, lit 2.5 s later", () => {
  const { game } = started(3, 13);
  const carrier = game.bomb.carrier!;
  const near = ([0, 1, 2] as PlayerId[]).find((id) => id !== carrier)!,
    far = ([0, 1, 2] as PlayerId[]).find((id) => id !== carrier && id !== near)!;
  place(game.physics.players[carrier], 0, 0, 0);
  place(game.physics.players[near], 1.2, 0, 0);
  place(game.physics.players[far], -6, -2, 0);
  steps(game, 0.3);
  game.bomb.fuse = 2;
  const nearBefore = { ...pelvis(game, near) };
  game.step(IDLE);
  game.step(IDLE);
  assert.ok(game.blast && game.blast.carrier === carrier, "blast on the tick the fuse runs out");
  assert.deepEqual(game.blast!.shoved, [near]);
  assert.ok(game.eliminated.includes(carrier));
  assert.ok(!game.round.alive[carrier] && game.physics.players[carrier].eliminated);
  assert.equal(game.bomb.phase, "pending");
  assert.ok(game.bomb.carrier === near || game.bomb.carrier === far);
  assert.ok(game.brawl.fighters[near].stagger.time > 0.3);
  steps(game, 0.4);
  const moved = pelvis(game, near);
  assert.ok(moved.x - nearBefore.x > 0.5, `pushed away from the blast (${(moved.x - nearBefore.x).toFixed(2)} m)`);
  let gap = 0;
  const next = game.bomb.carrier;
  while (game.bomb.phase === "pending") {
    game.step(IDLE);
    gap++;
  }
  assert.equal(gap, BOMB_TICKS.gap - 24, "lit 2.5 s after the blast");
  assert.equal(game.bomb.carrier, next);
  assert.equal(game.round.phase, "playing");
  game.dispose();
});

test("game: two players — the blast ends the round and the other one wins; results, then a fresh round with a new carrier", () => {
  const { game } = started(2, 17);
  const carrier = game.bomb.carrier!,
    other = carrier === 0 ? 1 : 0;
  let event = null;
  for (let i = 0; i < BOMB_TICKS.fuse + 5 && game.round.phase === "playing"; i++) event = game.step(IDLE);
  assert.equal(event, "finished");
  assert.equal(game.round.winner, other);
  assert.equal(game.round.reason, "survivor");
  assert.equal(game.round.endedAt, BOMB_TICKS.fuse - 1, "decided on the blast tick");
  assert.equal(game.bomb.carrier, null);
  while (game.step(IDLE) !== "reset");
  assert.equal(game.round.phase, "countdown");
  assert.ok(game.bomb.carrier !== null && game.bomb.phase === "pending");
  assert.ok(game.round.alive[0] && game.round.alive[1] && !game.round.active[2]);
  game.dispose();
});

test("game: a 3-player round always ends after two fuses (≈ 30.5 s), inside the 45 s safety net", () => {
  const { game } = started(3, 23);
  let ticks = 0;
  while (game.round.phase === "playing") {
    game.step(IDLE);
    ticks++;
  }
  assert.equal(game.round.reason, "survivor");
  assert.equal(game.bomb.blasts, 2);
  assert.equal(ticks, 2 * BOMB_TICKS.fuse + BOMB_TICKS.gap);
  assert.ok(ticks < BOMB_TICKS.cap);
  game.dispose();
});

test("game: the lit bomb's carrier runs exactly 15% faster (walking and sprinting); the others keep the shared speed", () => {
  assert.equal(BOMB_TAG.carrierSpeed, 1.15);
  const speed = (carrier: boolean, sprint: boolean) => {
    const { game } = started(2, 29);
    only(game, [0]);
    game.bomb.carrier = carrier ? 0 : 1;
    // An open lane along z = 4 (south of the hop walls, north of the crates and the L-wall).
    place(game.physics.players[0], -9, 4, facing(1, 0));
    steps(game, 1.2, () => [walk(1, 0, { sprint }), IDLE_INPUT, IDLE_INPUT]);
    const a = pelvis(game, 0).x;
    steps(game, 1, () => [walk(1, 0, { sprint }), IDLE_INPUT, IDLE_INPUT]);
    const v = pelvis(game, 0).x - a;
    game.dispose();
    return v;
  };
  const walkPlain = speed(false, false),
    walkBomb = speed(true, false),
    runPlain = speed(false, true),
    runBomb = speed(true, true);
  assert.ok(Math.abs(walkBomb / walkPlain - BOMB_TAG.carrierSpeed) < 0.01, `walk ${walkPlain.toFixed(2)} → ${walkBomb.toFixed(2)} m/s`);
  assert.ok(Math.abs(runBomb / runPlain - BOMB_TAG.carrierSpeed) < 0.01, `sprint ${runPlain.toFixed(2)} → ${runBomb.toFixed(2)} m/s`);
  assert.ok(Math.abs(walkBomb - 5.37) < 0.08 && Math.abs(runBomb - 7.49) < 0.1, "measured carrier speeds: 5.37 / 7.49 m/s");
  assert.ok(Math.abs(walkPlain - 4.68) < 0.1 && Math.abs(runPlain - 6.52) < 0.15, "the shared walking and sprint speeds");
});

// ─── Tag assist ─────────────────────────────────────────────────────────────

/**
 * A started game with the lit bomb on `carrier`, bodies placed standing at the given floor
 * points (the surface under each), the carrier facing `yaw`; others retired. Settled 0.3 s.
 */
function tagSetup(players: 2 | 3, carrier: PlayerId, at: Partial<Record<PlayerId, [number, number]>>, yaw: number) {
  const { game } = started(players, 41);
  game.bomb.carrier = carrier;
  game.bomb.immune = null;
  game.bomb.immuneTicks = 0;
  const ids = Object.keys(at).map(Number) as PlayerId[];
  only(game, ids);
  for (const id of ids) {
    const [x, z] = at[id]!;
    const other = ids.find((o) => o !== id)!;
    place(game.physics.players[id], x, z, id === carrier ? yaw : facing(at[other]![0] - x, at[other]![1] - z));
  }
  steps(game, 0.3);
  return game;
}
/** The carrier presses Punch (standing still) for `seconds`; returns the pass events and refusals seen. */
function swing(game: BombTagGame, carrier: PlayerId, seconds = 0.4) {
  const passes: { to: PlayerId; via?: string; reach?: number }[] = [],
    refused: string[] = [];
  for (let i = 0; i < seconds * 60; i++) {
    const inputs = [...IDLE];
    inputs[carrier] = walk(0, 0, { punch: true });
    game.step(inputs);
    for (const e of game.events) if (e.type === "pass") passes.push({ to: e.to, via: e.via, reach: e.reach });
    for (const r of game.refused) refused.push(r.why);
  }
  return { passes, refused };
}
const EAST = facing(1, 0);

/** A clear stretch of floor for the 360° cases: nothing within 2 m, no trap near. */
const OPEN: [number, number] = [1.5, 5.5];
const around = (degrees: number, d: number, from: [number, number] = OPEN): [number, number] => [
  from[0] + d * Math.cos((degrees * Math.PI) / 180),
  from[1] + d * Math.sin((degrees * Math.PI) / 180),
];

test("tag: no facing rule — a rival 1.0 m in front, behind, to the left or to the right takes the bomb on the press; the receiver is shoved ~0.8 m away and staggered", () => {
  assert.equal(BOMB_TAG.tag.range, 1.3);
  assert.deepEqual(Object.keys(BOMB_TAG.tag).sort(), ["heightGap", "range", "surfaceStep"], "no cone or facing angle left");
  // The carrier faces east (+x); the rival stands 1.0 m away on each side.
  const sides: [string, number][] = [
    ["in front", 0],
    ["behind", 180],
    ["to the left", -90],
    ["to the right", 90],
  ];
  for (const [name, degrees] of sides) {
    const game = tagSetup(2, 0, { 0: OPEN, 1: around(degrees, 1.0) }, EAST);
    const before = { ...pelvis(game, 1) };
    const { passes } = swing(game, 0, 0.1);
    assert.equal(passes.length, 1, `${name}: a pass on the press`);
    assert.equal(passes[0].to, 1);
    assert.equal(passes[0].via, "tag");
    assert.ok(passes[0].reach! <= BOMB_TAG.tag.range && passes[0].reach! > 0.75, `${name}: reach ${passes[0].reach!.toFixed(2)} m`);
    assert.equal(game.bomb.carrier, 1);
    assert.equal(game.bomb.immune, 0);
    assert.ok(game.brawl.fighters[1].stagger.time > 0.2, `${name}: staggered (0.35 s)`);
    steps(game, 0.5);
    const ux = Math.cos((degrees * Math.PI) / 180),
      uz = Math.sin((degrees * Math.PI) / 180),
      shove = (pelvis(game, 1).x - before.x) * ux + (pelvis(game, 1).z - before.z) * uz;
    assert.ok(shove > 0.4 && shove < 1.4, `${name}: shoved ${shove.toFixed(2)} m away from the carrier`);
    game.dispose();
  }
  // Every other direction too, out to 1.2 m (just inside the 1.3 m range).
  for (let degrees = 0; degrees < 360; degrees += 45) {
    const game = tagSetup(2, 0, { 0: OPEN, 1: around(degrees, 1.2) }, EAST);
    assert.equal(game.tagPick(0).target, 1, `1.2 m at ${degrees}°`);
    assert.equal(swing(game, 0, 0.1).passes.length, 1, `1.2 m at ${degrees}°`);
    game.dispose();
  }
});

test("tag: close range only — beyond 1.30 m nothing passes in any direction, assist or hand contact (a punch at 1.4 m in front shoves but never passes)", () => {
  for (const d of [1.4, 1.6])
    for (let degrees = 0; degrees < 360; degrees += 45) {
      const game = tagSetup(2, 0, { 0: OPEN, 1: around(degrees, d) }, EAST);
      assert.equal(game.tagPick(0).target, null, `${d} m at ${degrees}°`);
      const { passes } = swing(game, 0, 0.4);
      assert.equal(passes.length, 0, `${d} m at ${degrees}°: ${JSON.stringify(passes)}`);
      assert.equal(game.bomb.carrier, 0);
      game.dispose();
    }
  // Straight ahead at 1.4 m, three swings: whatever the hand reaches, the bomb stays.
  const game = tagSetup(2, 0, { 0: OPEN, 1: around(0, 1.4) }, EAST);
  assert.equal(swing(game, 0, 1.5).passes.length, 0);
  assert.equal(game.bomb.carrier, 0);
  game.dispose();
});

test("tag: in a three-player cluster the nearest valid rival takes it, whichever side — and a nearer one behind a wall is skipped", () => {
  // Rival 2 behind the carrier (0.9 m) is nearer than rival 1 in front (1.2 m).
  const game = tagSetup(3, 0, { 0: OPEN, 1: around(0, 1.2), 2: around(180, 0.9) }, EAST);
  assert.equal(game.tagPick(0).target, 2, "the nearer one, behind");
  assert.deepEqual(swing(game, 0, 0.1).passes.map((p) => p.to), [2]);
  game.dispose();
  // Beside the NW pocket's long leg (z −5.6…−5.2): rival 1 is 1.1 m away through the wall,
  // rival 2 1.2 m away on the carrier's own side — rival 2 takes it.
  const wall = tagSetup(3, 0, { 0: [-6.6, -4.85], 1: [-6.6, -5.95], 2: [-5.4, -4.85] }, facing(0, -1));
  assert.equal(wall.tagPick(0).target, 2);
  assert.deepEqual(swing(wall, 0, 0.1).passes.map((p) => p.to), [2]);
  wall.dispose();
});

test("never through geometry (360° tag or hand contact) — a pocket wall, an AC unit's or crate's corner, a hop wall, or from the floor to the catwalk above", () => {
  const blocked: [string, [number, number], [number, number]][] = [
    // Either side of the NW L-wall's long leg (z −5.6…−5.2), 1.1 m apart.
    ["through the pocket wall", [-6.6, -4.85], [-6.6, -5.95]],
    // Round the west end of the NE AC unit (x 5.4…7.8, z −6…−5), 1.25 m apart.
    ["round the AC unit's corner", [5.1, -5.2], [5.7, -6.3]],
    ["round the crates' corner", [-5.1, 5.2], [-5.7, 6.3]],
    // Floor beside the north catwalk (deck z −10…−8.2, 1 m high) → someone on it, 0.95 m apart.
    ["floor to catwalk", [0, -7.75], [0, -8.7]],
    ["catwalk to floor", [0, -8.7], [0, -7.75]],
  ];
  blocked.push(["over the E hop wall (0.9 m)", [5.65, 0], [6.75, 0]]);
  for (const [name, from, to] of blocked) {
    assert.ok(Math.hypot(to[0] - from[0], to[1] - from[1]) <= BOMB_TAG.tag.range, `${name}: within range`);
    // Facing the rival, a little off either way, and facing away (the tag has no facing rule);
    // three punches each (1.5 s), so a real hand contact over or round the obstacle gets its
    // chances too.
    for (const skew of [-0.25, 0, 0.25, Math.PI]) {
      const game = tagSetup(2, 0, { 0: from, 1: to }, facing(to[0] - from[0], to[1] - from[1]) + skew);
      if (skew === 0) assert.equal(game.tagPick(0).target, null, `${name}: no tag`);
      const { passes } = swing(game, 0, 1.5);
      assert.equal(passes.length, 0, `${name} (skew ${skew}): ${JSON.stringify(passes)}`);
      assert.equal(game.bomb.carrier, 0);
      game.dispose();
    }
  }
  // A jumping punch from the floor at someone on the catwalk: no pass.
  const jumper = tagSetup(2, 0, { 0: [0, -7.75], 1: [0, -8.7] }, facing(0, -1));
  let upPasses = 0;
  for (let i = 0; i < 90; i++) {
    const inputs = [...IDLE];
    inputs[0] = walk(0, -0.3, { jump: i % 30 === 0, punch: i % 30 === 12 });
    jumper.step(inputs);
    upPasses += jumper.events.filter((e) => e.type === "pass").length;
  }
  assert.equal(upPasses, 0, "a jumping punch up at the catwalk never passes");
  jumper.dispose();
  // Both on the catwalk (same surface): it passes.
  const game = tagSetup(2, 0, { 0: [-1, -9.1], 1: [0, -9.1] }, EAST);
  assert.equal(game.tagPick(0).target, 1, "on the same catwalk");
  assert.equal(swing(game, 0, 0.1).passes.length, 1);
  game.dispose();
});

test("tag assist: with three players the nearest valid rival takes it; the previous carrier is protected for 1 s but the third player is not", () => {
  const game = tagSetup(3, 0, { 0: [0, 3.5], 1: [1.15, 3.8], 2: [0.95, 3.1] }, EAST);
  assert.equal(game.tagPick(0).target, 2, "the nearer one");
  // Player 2 just passed it to 0: protected, so player 1 (farther, but valid) takes it.
  game.bomb.immune = 2;
  game.bomb.immuneTicks = BOMB_TICKS.tagBack;
  assert.equal(game.tagPick(0).target, 1, "the third player can receive at once");
  const { passes } = swing(game, 0, 0.1);
  assert.deepEqual(passes.map((p) => p.to), [1]);
  game.dispose();
  // Only the protected previous carrier in reach: refused (reported once per swing) until the window ends.
  const back = tagSetup(2, 1, { 1: [-1, 3.5], 0: [0, 3.5] }, EAST);
  back.bomb.immune = 0;
  back.bomb.immuneTicks = BOMB_TICKS.tagBack;
  assert.deepEqual(back.tagPick(1), { target: null, refused: 0, distance: Infinity });
  const first = swing(back, 1, 0.4);
  assert.equal(first.passes.length, 0, "no tag-back");
  assert.deepEqual(first.refused, ["tag-back"], "one refusal per swing");
  assert.equal(back.bomb.carrier, 1);
  steps(back, 0.7);
  assert.equal(back.bomb.immuneTicks, 0);
  // Re-face the rival (the refused swing shoved nobody, but bodies drift) and swing again.
  place(back.physics.players[1], -1, 3.5, EAST);
  place(back.physics.players[0], 0, 3.5, facing(-1, 0));
  steps(back, 0.2);
  assert.equal(swing(back, 1, 0.3).passes.length, 1, "after 1 s it can go back");
  back.dispose();
});

test("tag assist: only the lit bomb's carrier — a punch by anyone else, or while the fuse waits, passes nothing; a rival jumping beside you can still be tagged", () => {
  const other = tagSetup(2, 0, { 0: [-1, 3.5], 1: [0, 3.5] }, EAST);
  assert.equal(swing(other, 1, 0.4).passes.length, 0, "the non-carrier's punch");
  assert.equal(other.bomb.carrier, 0);
  other.dispose();
  const pending = tagSetup(2, 0, { 0: [-1, 3.5], 1: [0, 3.5] }, EAST);
  pending.bomb.phase = "pending";
  pending.bomb.gapLeft = 120;
  assert.equal(swing(pending, 0, 0.4).passes.length, 0, "no lit fuse, no pass");
  pending.dispose();
  const jumping = tagSetup(2, 0, { 0: [-1, 3.5], 1: [0.1, 3.5] }, EAST);
  const inputs = [...IDLE];
  inputs[1] = walk(0, 0, { jump: true });
  jumping.step(inputs);
  steps(jumping, 0.2);
  assert.ok(pelvis(jumping, 1).y - pelvis(jumping, 0).y > 0.4, "mid-jump");
  assert.equal(swing(jumping, 0, 0.1).passes.length, 1, "same surface, mid-jump: tagged");
  jumping.dispose();
});

test("tag assist is Bomba Sende's own: the other modes keep their punch tuning and have no assist", () => {
  const shove = { cooldown: 0.6, push: 3.0, lift: 0.3, stagger: { time: 0.35, posture: 0.7, mobility: 0.25 } };
  assert.deepEqual(LAYER_CHAOS.punch, shove);
  assert.deepEqual(COLOR_CHAOS.punch, shove);
  assert.deepEqual(BOMB_TAG.punch, shove, "the transfer's shove and stagger are unchanged too");
  const colors = new ColorChaosGame(silentFeedback, { players: 2, seed: 1 });
  const layers = new LayerChaosGame(silentFeedback, { players: 2 });
  assert.equal(colors.brawl.tuning, COLOR_CHAOS.punch);
  assert.equal(layers.brawl.tuning, LAYER_CHAOS.punch);
  assert.ok(!("tagPick" in colors) && !("tagPick" in layers));
  colors.dispose();
  layers.dispose();
});

// ─── Slow traps ─────────────────────────────────────────────────────────────

const footprint = (b: { x: readonly [number, number]; z: readonly [number, number] }, x: number, z: number) =>
  Math.hypot(Math.max(0, b.x[0] - x, x - b.x[1]), Math.max(0, b.z[0] - z, z - b.z[1]));

test("traps: exactly three, fixed, flat on open floor round the middle — a loose triangle on the plaza ring, ≥ 4 m apart", () => {
  assert.equal(BOMB_TRAPS.length, 3);
  const a = new BombTagGame(silentFeedback, { players: 3, seed: 1 }),
    b = new BombTagGame(silentFeedback, { players: 2, seed: 999 });
  for (const game of [a, b]) {
    assert.equal(game.traps.traps.length, 3);
    game.traps.traps.forEach((t, i) => assert.deepEqual([t.x, t.y, t.z, t.armed], [BOMB_TRAPS[i].x, 0, BOMB_TRAPS[i].z, true], "the same spots every match"));
  }
  a.dispose();
  b.dispose();
  const solids = BOMB_MAP.colliders.filter((c) => c.role !== "floor" && c.shape !== "cylinder");
  const angles: number[] = [];
  for (const t of BOMB_TRAPS) {
    assert.equal(t.y, 0);
    const r = Math.hypot(t.x, t.z);
    assert.ok(r > 2.5 && r < 3.5, `on the plaza ring: ${r.toFixed(2)} m from the middle`);
    // The whole mat on bare floor, clear of every solid by a body width.
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2,
        x = t.x + Math.cos(a) * TRAP_MAT.outer,
        z = t.z + Math.sin(a) * TRAP_MAT.outer;
      assert.equal(surfaceBelow(x, z, 3), 0);
    }
    for (const c of solids) {
      if (c.shape === "cylinder") continue;
      const d = footprint({ x: [c.center.x - c.half.x, c.center.x + c.half.x], z: [c.center.z - c.half.z, c.center.z + c.half.z] }, t.x, t.z);
      assert.ok(d >= 3, `${c.role} ${d.toFixed(2)} m away`);
    }
    angles.push(Math.atan2(t.z, t.x));
  }
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++) assert.ok(Math.hypot(BOMB_TRAPS[i].x - BOMB_TRAPS[j].x, BOMB_TRAPS[i].z - BOMB_TRAPS[j].z) >= 4, "≥ 4 m apart");
  // Around the middle: no gap between neighbouring traps wider than 150°.
  angles.sort((x, y) => x - y);
  const gaps = angles.map((x, i) => ((angles[(i + 1) % 3] - x + Math.PI * 2) % (Math.PI * 2)) * (180 / Math.PI));
  assert.ok(Math.max(...gaps) <= 150, `gaps ${gaps.map((g) => g.toFixed(0)).join("/")}°`);
  assert.ok(TRAP_MAT.inner >= BOMB_TAG.trap.radius + 0.1, "the dark mat covers everywhere a foot springs it");
});

test("traps: no spawn overlap and no route blocked — clear of spawns, pocket exits, ramps, catwalk landings, hop walls and shortcuts; the playground stays connected round them", () => {
  for (const t of BOMB_TRAPS) {
    for (const spawn of [...BOMB_SPAWNS[2], ...BOMB_SPAWNS[3]]) assert.ok(Math.hypot(spawn.x - t.x, spawn.z - t.z) >= 2.5 + TRAP_MAT.outer - 0.35, "≥ 2.9 m from every spawn");
    // Pocket exits: along each L-wall's two legs, past their free ends (2 m wide gaps to the perimeter).
    for (const exit of [
      { x: -9, z: -5.4 },
      { x: -5.4, z: -9 },
      { x: 9, z: 5.4 },
      { x: 5.4, z: 9 },
    ])
      assert.ok(Math.hypot(exit.x - t.x, exit.z - t.z) >= 6, "far from the pocket exits");
    for (const r of RAMPS) assert.ok(footprint(r, t.x, t.z) >= 3, "off the ramps");
    // Catwalk landings: the floor band along each catwalk's open side, where a drop lands.
    for (const c of CATWALKS) assert.ok(footprint(c, t.x, t.z) >= 3, "clear of the catwalk landings");
    // Hop-wall landings: both sides of each hop wall.
    for (const h of HOP_WALLS) assert.ok(footprint(h, t.x, t.z) >= 3, "clear of the hop-wall landings");
    for (const s of JUMP_SHORTCUTS) for (const p of [s.from, s.to]) assert.ok(Math.hypot(p.x - t.x, p.z - t.z) >= 6, "far from the jump shortcuts");
  }
  // Even with every trap's floor treated as a wall (0.9 m round each), everything stays reachable
  // and no route between spawns or corners gets more than 15% longer: the middle keeps its lanes.
  const nav = new BombNav(BOMB_MAP),
    walls = new Float32Array(nav.nodes.length);
  for (const t of BOMB_TRAPS) for (const id of nav.floorNear(t.x, t.z, 0.9)) walls[id] = 1e6;
  const middle = nav.field(nav.nodeAt(0, 0.9, 0), walls);
  assert.ok(nav.nodes.every((n) => walls[n.id] > 0 || middle.dist[n.id] < 1e6), "nothing cut off");
  const points = [...BOMB_SPAWNS[3], ...BOMB_SPAWNS[2], { x: 0, y: 0.9, z: 0 }, { x: -8.5, y: 0.9, z: -8.5 }, { x: 8.5, y: 0.9, z: 8.5 }, { x: 8.5, y: 0.9, z: -7 }, { x: -8.5, y: 0.9, z: 7 }];
  for (const a of points) {
    const from = nav.nodeAt(a.x, a.y, a.z),
      open = nav.field(from),
      round = nav.field(from, walls);
    for (const b of points) {
      if (a === b) continue;
      const to = nav.nodeAt(b.x, b.y, b.z);
      assert.ok(round.dist[to] <= open.dist[to] * 1.15, `(${a.x}, ${a.z}) → (${b.x}, ${b.z}): ${open.dist[to].toFixed(1)} → ${round.dist[to].toFixed(1)} m`);
    }
  }
});

/** A started 2-player game with only slot 0 in the world (the lit bomb on the retired slot 1, a long fuse), standing `back` m north of trap `trap`, facing it. */
function trapRun(trap: number, back = 6) {
  const { game } = started(2, 51);
  only(game, [0]);
  game.bomb.carrier = 1;
  game.bomb.fuse = 60 * 60;
  const t = game.traps.traps[trap];
  place(game.physics.players[0], t.x, t.z - back, facing(0, 1));
  steps(game, 0.3);
  return { game, t };
}

test("traps: a foot on an armed trap springs it once — no damage, no hold, no stagger: 0.50× speed for exactly 1.0 s, then shut 7.0 s (nobody springs it), then it works again", () => {
  const { game, t } = trapRun(0);
  const z: number[] = [],
    slowed: number[] = [];
  let spring = -1;
  const sprung: number[] = [];
  const cues: FeedbackEvent[] = [];
  // Walk south over the S trap until 1.5 s after it sprang (short of the south catwalk).
  let ticks = 0;
  for (; ticks < 240 && (spring < 0 || ticks <= spring + 90); ticks++) {
    game.step([walk(0, 1), IDLE_INPUT, IDLE_INPUT]);
    z.push(pelvis(game, 0).z);
    slowed.push(game.traps.slowed[0]);
    const i = ticks;
    for (const s of game.sprung) {
      sprung.push(i);
      if (spring < 0) spring = i;
      assert.equal(s.id, 0);
      assert.equal(s.trap, t);
    }
    if (i === spring) {
      assert.equal(t.armed, false);
      assert.equal(t.rearmIn, BOMB_TICKS.trapRearm);
      assert.equal(game.brawl.fighters[0].stagger.time, 0, "no stagger");
    }
  }
  assert.ok(spring > 0);
  assert.deepEqual(sprung, [spring], "springs once");
  assert.equal(slowed[spring], BOMB_TICKS.trapSlow);
  assert.equal(BOMB_TICKS.trapSlow, 60, "1.0 s");
  assert.equal(slowed.filter((n) => n > 0).length, 60, "slowed for exactly 60 steps");
  assert.equal(slowed[spring + 60], 0);
  const before = (z[spring - 1] - z[spring - 31]) / 0.5,
    during = (z[spring + 59] - z[spring - 1]) / 1.0,
    after = (z[spring + 86] - z[spring + 62]) / 0.4;
  assert.ok(Math.abs(before - 4.68) < 0.1, `full walking speed first: ${before.toFixed(2)} m/s`);
  assert.ok(during / before > 0.46 && during / before < 0.56, `0.50× while slowed: ${before.toFixed(2)} → ${during.toFixed(2)} m/s`);
  assert.ok(after / before > 0.9, `back to speed after 1 s: ${after.toFixed(2)} m/s`);
  // Nothing else: still in, the bomb where it was, no falls or faults.
  assert.ok(game.round.alive[0] && !game.physics.players[0].eliminated);
  assert.equal(game.bomb.carrier, 1);
  assert.equal(game.bomb.passes, 0);
  assert.equal(game.physics.diagnostics.invalidBodies, 0);
  // Shut: walking back north over it springs nothing.
  for (const end = ticks + 180; ticks < end; ticks++) {
    game.step([walk(0, -1), IDLE_INPUT, IDLE_INPUT]);
    assert.equal(game.sprung.length, 0, "a shut trap never springs");
    assert.equal(game.traps.slowed[0], 0);
  }
  assert.ok(pelvis(game, 0).z < t.z - 1.5, "walked back over it");
  // Rearms exactly 7.0 s after it sprang.
  assert.equal(BOMB_TICKS.trapRearm, 420);
  for (; ticks < spring + 420; ticks++) game.step(IDLE);
  assert.equal(t.armed, false, "still shut at 6.98 s");
  game.step(IDLE);
  assert.equal(game.rearmed.length, 1);
  assert.equal(t.armed, true, "armed again at 7.0 s");
  // And it works again.
  let again = 0;
  for (let i = 0; i < 200; i++) {
    game.step([walk(0, 1), IDLE_INPUT, IDLE_INPUT]);
    again += game.sprung.length;
  }
  assert.equal(again, 1, "the rearmed trap springs again");
  game.dispose();
  // The snap is the Barn trap's sound (an existing feedback name; no new sound).
  const heard = new BombTagGame((e) => cues.push(e), { players: 2, seed: 51 });
  while (heard.step(IDLE) !== "started");
  only(heard, [0]);
  heard.bomb.carrier = 1;
  place(heard.physics.players[0], BOMB_TRAPS[0].x, BOMB_TRAPS[0].z - 3, facing(0, 1));
  for (let i = 0; i < 90; i++) heard.step([walk(0, 1), IDLE_INPUT, IDLE_INPUT]);
  assert.deepEqual(cues.filter((e) => e.name === "trapSnap").map((e) => [e.actor, e.intensity]), [[0, 1]]);
  heard.dispose();
});

test("traps: the carrier and a runner both spring them; a trap never passes, takes or burns the bomb", () => {
  const { game } = started(2, 53);
  game.bomb.carrier = 0;
  const fuse = game.bomb.fuse;
  const [south, northWest] = [game.traps.traps[0], game.traps.traps[1]];
  // The carrier walks south over the S trap, the runner north over the NW trap (5 m apart).
  place(game.physics.players[0], south.x, south.z - 2.5, facing(0, 1));
  place(game.physics.players[1], northWest.x, northWest.z + 2.5, facing(0, -1));
  const who: PlayerId[] = [];
  for (let i = 0; i < 60; i++) {
    game.step([walk(0, 1), walk(0, -1), IDLE_INPUT]);
    for (const s of game.sprung) who.push(s.id);
    assert.equal(game.bomb.carrier, 0, "the bomb stays with the carrier");
  }
  assert.deepEqual(who.sort(), [0, 1], "both sprang one");
  assert.equal(game.bomb.passes, 0);
  assert.equal(game.bomb.phase, "armed");
  assert.equal(game.bomb.fuse, fuse - 60, "the fuse burned on as ever");
  assert.equal(game.traps.springs, 2);
  game.dispose();
});

test("traps: jumping over an armed one clears it; a slowed player passes over another without springing it, can still jump, and jumping does not beat the slow", () => {
  // Take off 1.5 m before it, walking or sprinting: over it.
  for (const sprint of [false, true]) {
    const { game, t } = trapRun(0);
    let jumped = false,
      springs = 0;
    for (let i = 0; i < 120; i++) {
      const jump: boolean = !jumped && pelvis(game, 0).z >= t.z - 1.5;
      jumped ||= jump;
      game.step([walk(0, 1, { jump, sprint }), IDLE_INPUT, IDLE_INPUT]);
      springs += game.sprung.length;
    }
    assert.equal(springs, 0, `a ${sprint ? "sprinting" : "walking"} jump clears it`);
    assert.ok(pelvis(game, 0).z > t.z + 2);
    game.dispose();
  }
  // Already slowed: over an armed trap without springing it (it stays armed).
  {
    const { game, t } = trapRun(0, 1.2);
    game.traps.slowed[0] = BOMB_TICKS.trapSlow;
    for (let i = 0; i < 50; i++) {
      game.step([walk(0, 1), IDLE_INPUT, IDLE_INPUT]);
      assert.equal(game.sprung.length, 0);
    }
    assert.ok(t.armed && pelvis(game, 0).z > t.z + 0.5, "walked over it slowed; still armed");
    game.dispose();
  }
  // Slowed: a jump still takes off, and jump-spamming stays at half speed.
  const speed = (spam: boolean) => {
    const { game, t } = trapRun(0);
    let spring = -1,
      top = 0,
      from = 0;
    for (let i = 0; i < 200 && (spring < 0 || i < spring + 60); i++) {
      const jump = spam && spring >= 0 && (i - spring) % 20 === 1;
      game.step([walk(0, 1, { jump }), IDLE_INPUT, IDLE_INPUT]);
      if (spring < 0 && game.sprung.length) {
        spring = i;
        from = pelvis(game, 0).z;
      }
      if (spring >= 0) top = Math.max(top, pelvis(game, 0).y);
    }
    const covered = pelvis(game, 0).z - from;
    game.dispose();
    assert.ok(spring > 0 && t.id === 0);
    return { covered, top };
  };
  const plain = speed(false),
    hopping = speed(true);
  assert.ok(hopping.top > plain.top + 0.3, `jumps while slowed (${plain.top.toFixed(2)} → ${hopping.top.toFixed(2)} m)`);
  assert.ok(hopping.covered < 4.68 * 0.56 && plain.covered < 4.68 * 0.56, `still half speed: ${plain.covered.toFixed(2)} m / ${hopping.covered.toFixed(2)} m in 1 s`);
});

test("traps: the slow is 0.50× of whatever speed the player has — walking, sprinting, or the carrier's ×1.15", () => {
  assert.equal(BOMB_TAG.trap.slow, 0.5);
  for (const [sprint, carrier, full] of [
    [true, false, 6.52],
    [true, true, 7.49],
    [false, true, 5.37],
  ] as const) {
    const { game, t } = trapRun(0, 8);
    if (carrier) game.bomb.carrier = 0;
    const z: number[] = [];
    let spring = -1;
    for (let i = 0; i < 160 && (spring < 0 || i <= spring + 60); i++) {
      game.step([walk(0, 1, { sprint }), IDLE_INPUT, IDLE_INPUT]);
      z.push(pelvis(game, 0).z);
      if (spring < 0 && game.sprung.length) spring = i;
    }
    const before = (z[spring - 1] - z[spring - 21]) / (20 / 60),
      during = (z[spring + 59] - z[spring - 1]) / 1.0;
    assert.ok(Math.abs(before - full) < 0.2, `${full} m/s before: ${before.toFixed(2)}`);
    assert.ok(during / before > 0.46 && during / before < 0.56, `${before.toFixed(2)} → ${during.toFixed(2)} m/s`);
    assert.equal(game.bomb.carrier, carrier ? 0 : 1);
    assert.ok(t.id === 0);
    game.dispose();
  }
});

test("traps (pure state): shared ticks spring for the lowest slot first; out-of-round players never spring; reset rearms all", () => {
  const traps = new BombTraps(BOMB_TRAPS);
  const on = (t: { x: number; z: number }) => [{ x: t.x + 0.1, y: 0.05, z: t.z }];
  const first = traps.tick([0, 1, 2], (id) => (id === 2 ? null : on(BOMB_TRAPS[0])));
  assert.deepEqual(first.sprung.map((s) => [s.id, s.trap.id]), [[0, 0]], "slot 0 springs it; slot 1 on the same tick finds it shut");
  assert.deepEqual(traps.slowed, [BOMB_TICKS.trapSlow, 0, 0]);
  assert.equal(traps.tick([0, 1, 2], (id) => (id === 1 ? on(BOMB_TRAPS[0]) : null)).sprung.length, 0);
  assert.equal(traps.tick([2], () => [{ x: BOMB_TRAPS[1].x, y: 0.5, z: BOMB_TRAPS[1].z }]).sprung.length, 0, "feet 0.5 m up (a jump) never spring it");
  assert.equal(traps.tick([2], () => [{ x: BOMB_TRAPS[1].x + 0.44, y: 0, z: BOMB_TRAPS[1].z }]).sprung.length, 1, "a foot 0.44 m from the centre does");
  traps.reset();
  assert.ok(traps.traps.every((t) => t.armed && t.rearmIn === 0) && traps.slowed.every((n) => n === 0) && traps.springs === 0);
  assert.equal(traps.mobility(0), 1);
});

test("bots and traps: routes go round an armed trap and straight over a shut one; a carrier bot charges over one at close range (it can be baited) but goes round from farther away", () => {
  const nav = bombNav();
  const { game } = started(3, 61);
  const trap = game.traps.traps[1];
  const a = nav.nodeAt(trap.x, 0.9, trap.z - 3.5),
    b = nav.nodeAt(trap.x, 0.9, trap.z + 3.5);
  const nearest = (route: number[]) => Math.min(...route.map((id) => Math.hypot(nav.nodes[id].x - trap.x, nav.nodes[id].z - trap.z)));
  const armedRoute = nav.path(nav.field(a, trapPenalty(nav, game)), b);
  assert.ok(nearest(armedRoute) > TRAP.zone, `round the armed trap (${nearest(armedRoute).toFixed(2)} m)`);
  trap.armed = false;
  trap.rearmIn = 100;
  assert.equal(trapPenalty(nav, game)?.[nav.floorNear(trap.x, trap.z, 0.3)[0]] ?? 0, 0, "a shut trap costs nothing");
  const shutRoute = nav.path(nav.field(a, trapPenalty(nav, game)), b);
  assert.ok(nearest(shutRoute) < 0.5, "straight over the shut one");
  game.dispose();
  // Bait: a runner stands just past a trap; the carrier bot comes at it from the other side.
  const bait = (gap: number) => {
    const { game } = started(2, 67);
    game.bomb.carrier = 1;
    game.bomb.fuse = 60 * 60;
    const t = game.traps.traps[1];
    place(game.physics.players[0], t.x, t.z + 1.1, facing(0, -1));
    place(game.physics.players[1], t.x, t.z + 1.1 - gap, facing(0, 1));
    const bot = new BombBot(1, mulberry32(5));
    let sprang = false,
      tagged = false;
    for (let i = 0; i < 60 * 3 && !tagged; i++) {
      game.step([IDLE_INPUT, bot.update(game), IDLE_INPUT]);
      sprang ||= game.sprung.some((s) => s.id === 1);
      tagged ||= game.events.some((e) => e.type === "pass");
    }
    game.dispose();
    return { sprang, tagged };
  };
  const close = bait(1.9);
  assert.ok(close.sprang, "from 1.9 m it runs straight over the trap");
  for (const gap of [2.5, 3.5]) {
    const far = bait(gap);
    assert.ok(!far.sprang && far.tagged, `from ${gap} m it goes round and still tags (${JSON.stringify(far)})`);
  }
});

test("game: deterministic — the same seed and inputs give the same match (bots included)", () => {
  const play = () => {
    const game = new BombTagGame(silentFeedback, { players: 3, seed: 42 });
    const bots = ([0, 1, 2] as PlayerId[]).map((id) => new BombBot(id, mulberry32(100 + id)));
    const log: string[] = [];
    for (let i = 0; i < 60 * 25; i++) {
      game.step(bots.map((b) => b.update(game)));
      for (const e of game.events) log.push(`${i}:${JSON.stringify(e)}`);
    }
    const bodies = game.physics.players.map((c) => Object.values(c.body.translation()).map((x) => x.toFixed(6)).join(","));
    game.dispose();
    return log.join("|") + "#" + bodies.join("|");
  };
  const a = play();
  assert.ok(a.includes('"type":"pass"'), "the bots pass the bomb");
  assert.equal(play(), a);
});

// ─── Traversal with the real ragdoll ────────────────────────────────────────

/** Slot 0 alone in a started game at (x, z) facing `yaw`, then `drive` for `seconds`; returns the final pelvis. */
function drive(x: number, z: number, yaw: number, seconds: number, input: (t: number, p: { x: number; y: number; z: number }) => MovementInput) {
  const { game } = started(2, 31);
  only(game, [0]);
  place(game.physics.players[0], x, z, yaw);
  steps(game, 0.3);
  for (let i = 0; i < seconds * 60; i++) game.step([input(i / 60, pelvis(game, 0)), IDLE_INPUT, IDLE_INPUT]);
  const end = { ...pelvis(game, 0) };
  const faults = game.physics.diagnostics.invalidBodies;
  game.dispose();
  assert.equal(faults, 0);
  return end;
}

test("traversal: the ramp walks up onto the catwalk; the catwalk's open side takes a running jump; dropping off it is free", () => {
  // Up the north ramp (rises toward +x) and along the deck.
  const up = drive(-6.8, -9.1, facing(1, 0), 2.2, () => walk(1, 0));
  assert.ok(up.y > DECK_HEIGHT + 0.5 && up.x > -2.5, `on the catwalk (${up.x.toFixed(2)}, ${up.y.toFixed(2)})`);
  // A running jump from the plaza side onto the deck.
  let jumped = false;
  const onto = drive(0, -5, facing(0, -1), 2, (_t, p) => {
    const j = !jumped && p.z < -7.1;
    if (j) jumped = true;
    return walk(0, -1, { jump: j });
  });
  assert.ok(onto.y > DECK_HEIGHT + 0.5 && onto.z < -8.3, `jumped onto the catwalk (${onto.z.toFixed(2)}, ${onto.y.toFixed(2)})`);
  const off = drive(0, -9.1, facing(0, 1), 1.5, () => walk(0, 1));
  assert.ok(off.y < 1 && off.z > -7.5, "walked off the open side onto the floor");
});

test("traversal: the hop walls take a running jump from either side; walking into one stops you", () => {
  for (const w of HOP_WALLS) {
    const cx = (w.x[0] + w.x[1]) / 2;
    for (const side of [-1, 1]) {
      let jumped = false;
      const start = cx + side * 3,
        dir = -side;
      const end = drive(start, 0, facing(dir, 0), 2, (_t, p) => {
        const j = !jumped && Math.abs(p.x - cx) < 1.2;
        if (j) jumped = true;
        return walk(dir, 0, { jump: j });
      });
      assert.ok(Math.sign(end.x - cx) === dir && Math.abs(end.x - cx) > 0.5 && end.y < 1, `hopped the wall at x ${cx} from ${side > 0 ? "+" : "−"}x`);
      const blocked = drive(start, 0, facing(dir, 0), 2, () => walk(dir, 0));
      assert.ok(Math.sign(blocked.x - cx) === side, "a walker stays on its side");
    }
  }
});

test("traversal: the jump shortcuts — from each catwalk's end across the 1.5 m gap onto the corner top, and back", () => {
  for (const s of JUMP_SHORTCUTS) {
    const dir = Math.sign(s.to.x - s.from.x);
    let jumped = false,
      landed = false;
    const top = s.gap > 0 ? (dir > 0 ? AC_UNITS[1] : CRATE_BLOCKS[1]) : null;
    drive(s.from.x - dir * 2, s.from.z, facing(dir, 0), 1.6, (_t, p) => {
      const j = !jumped && dir * (p.x - s.from.x) > 0;
      if (j) jumped = true;
      // Standing on the corner top: over it, pelvis at standing height above it, then stop.
      if (top && p.x > top.x[0] && p.x < top.x[1] && Math.abs(p.y - 0.78 - top.height) < 0.2) landed = true;
      return landed ? IDLE_INPUT : walk(dir, 0, { jump: j });
    });
    assert.ok(landed, "a walking jump from the catwalk's end lands on the corner top");
    jumped = false;
    const onTop = drive(s.to.x, s.to.z, facing(dir, 0), 0.01, () => IDLE_INPUT);
    assert.ok(onTop.y > LOW_COVER_HEIGHT + 0.5, "standing on the corner top");
    const back = drive(s.to.x + dir * 0.2, s.to.z, facing(-dir, 0), 1.6, (_t, p) => {
      const j = !jumped && dir * (p.x - s.to.x) < -0.35;
      if (j) jumped = true;
      return walk(-dir, 0, { jump: j, sprint: true });
    });
    assert.ok(back.y > DECK_HEIGHT + 0.5 && dir * (back.x - (s.from.x + dir * 0.5)) < 0, `jumped back onto the catwalk (${back.x.toFixed(2)}, ${back.y.toFixed(2)})`);
  }
});

test("traversal: jump-spamming at a pocket wall never gets over it; from the catwalk and the tops the perimeter holds (nobody falls)", () => {
  // NW L-wall's long leg (z −5.6…−5.2): from the plaza side, straight and angled.
  for (const angle of [-0.5, 0, 0.5]) {
    const end = drive(-6.6, -3.2, facing(Math.sin(angle), -Math.cos(angle)), 3, (t) => walk(Math.sin(angle), -Math.cos(angle), { jump: Math.floor(t * 4) % 2 === 0 }));
    assert.ok(end.z > -5.2 || end.x > -5.2 || end.x < -8.0, `stayed out of the pocket over the wall (${end.x.toFixed(2)}, ${end.z.toFixed(2)})`);
  }
  // Toward the perimeter from every raised surface (straight at the wall, jumping).
  const starts: [number, number, number, number][] = [
    [0, -9.1, 0, -1],
    [-2, 9.1, 0, 1],
    [5.7, -9.3, 0, -1],
    [5.7, -9.3, 1, 0],
    [7, -5.5, 1, -1],
    [-5.7, 9.3, 0, 1],
    [-7, 5.5, -1, 1],
  ];
  for (const [x, z, dx, dz] of starts) {
    const l = Math.hypot(dx, dz);
    const end = drive(x, z, facing(dx, dz), 3, (t) => walk(dx / l, dz / l, { jump: Math.floor(t * 3) % 2 === 0, sprint: true }));
    assert.ok(Math.abs(end.x) < 10 && Math.abs(end.z) < 10 && end.y > 0, `stayed inside from (${x}, ${z}): (${end.x.toFixed(2)}, ${end.y.toFixed(2)}, ${end.z.toFixed(2)})`);
  }
});

// ─── Bots ───────────────────────────────────────────────────────────────────

test("bots: whole rounds without faults or falls — they chase, pass, flee, and each fuse sees several passes; the first carrier is not doomed", () => {
  const runs = { 2: 12, 3: 12 } as const;
  for (const players of [2, 3] as const) {
    let passes = 0,
      fuses = 0,
      firstBlasts = 0,
      unstuck = 0,
      springs = 0;
    for (let r = 0; r < runs[players]; r++) {
      const game = new BombTagGame(silentFeedback, { players, seed: 500 + r });
      const bots = ([0, 1, 2] as PlayerId[]).map((id) => new BombBot(id, mulberry32(900 + r * 3 + id)));
      const first = game.bomb.carrier;
      let firstBlast: PlayerId | null = null;
      let guard = 0;
      while (game.round.phase !== "results" && guard++ < 60 * 60) {
        game.step(bots.map((b) => b.update(game)));
        for (const e of game.events) {
          if (e.type === "pass") passes++;
          if (e.type === "blast") {
            fuses++;
            firstBlast ??= e.carrier;
          }
        }
        for (const id of game.eliminated) assert.ok(game.blast?.carrier === id, "the only way out is the blast");
        springs += game.sprung.length;
      }
      assert.equal(game.round.phase, "results");
      assert.equal(game.round.reason, "survivor");
      assert.equal(game.physics.diagnostics.invalidBodies, 0);
      if (firstBlast === first) firstBlasts++;
      unstuck += bots.reduce((n, b) => n + b.stuck.unstuck, 0);
      game.dispose();
    }
    const perFuse = passes / fuses;
    assert.ok(perFuse >= 2 && perFuse <= 12, `${players} players: ${perFuse.toFixed(1)} passes per fuse`);
    assert.ok(firstBlasts / runs[players] <= (players === 2 ? 0.8 : 0.6), `${players} players: the first carrier blew up first in ${firstBlasts}/${runs[players]}`);
    assert.ok(unstuck / runs[players] < 3, `${players} players: ${unstuck} unstick moves`);
    // They mostly go round the traps, but not always.
    assert.ok(springs <= runs[players] * 2, `${players} players: ${springs} trap springs`);
    if (players === 3) assert.ok(springs >= 1, `3 players: ${springs} trap springs`);
  }
});

test("bots: a fleeing bot runs from the carrier (the gap grows or holds while it can), a carrier bot closes in", () => {
  const { game } = started(2, 37);
  game.bomb.carrier = 1;
  place(game.physics.players[1], -3, 0, facing(1, 0));
  place(game.physics.players[0], 1, 0, facing(1, 0));
  const flee = new BombBot(0, mulberry32(1)),
    chase = new BombBot(1, mulberry32(2));
  const gap = () => Math.hypot(pelvis(game, 0).x - pelvis(game, 1).x, pelvis(game, 0).z - pelvis(game, 1).z);
  const start = gap();
  let minGap = start,
    passed = false;
  for (let i = 0; i < 60 * 8 && !passed; i++) {
    game.step([flee.update(game), chase.update(game), IDLE_INPUT]);
    minGap = Math.min(minGap, gap());
    passed = game.events.some((e) => e.type === "pass");
    if (i === 30) assert.equal(flee.mode, "flee");
  }
  assert.equal(chase.mode === "chase" || passed, true);
  assert.ok(passed || minGap < start, "the carrier got closer or passed it");
  game.dispose();
});

// ─── Camera ─────────────────────────────────────────────────────────────────

test("camera: 6.4 m boom, 30° down (20–50°), 60° FOV, eases out ~0.7 m when sprinting; a jump lifts it 20% of the rise", () => {
  assert.equal(BOMB_CAMERA.fov, 60);
  assert.equal(Math.round((BOMB_CAMERA.restPitch * 180) / Math.PI), 30);
  assert.equal(Math.round((clampBombPitch(0) * 180) / Math.PI), 20);
  assert.equal(Math.round((clampBombPitch(2) * 180) / Math.PI), 50);
  const follow = new BombFollow();
  const p = { x: 0, y: 0.78, z: 0 };
  for (let i = 0; i < 60; i++) follow.update(p, 0, 1 / 60);
  const rest = follow.pivot!.y;
  assert.ok(Math.abs(rest - 1.78) < 0.01);
  let highest = rest;
  for (let i = 0; i < 36; i++) {
    const t = i / 60,
      y = 0.78 + 6.5 * t - 10 * t * t;
    highest = Math.max(highest, follow.update({ x: 0, y, z: 0 }, 6.5 - 20 * t, 1 / 60).y);
  }
  assert.ok(highest - rest < 0.2, `a 0.96 m jump lifts the view ${(highest - rest).toFixed(2)} m`);
  const blockers = bombCameraBlockers();
  const open = bombCameraPose(blockers, { x: 0, y: 1.78, z: 0 }, 0, BOMB_CAMERA.restPitch, 0, { boom: null }, 1 / 60);
  assert.ok(Math.abs(open.boom - BOMB_CAMERA.boom) < 1e-6);
  const sprinting = bombCameraPose(blockers, { x: 0, y: 1.78, z: 0 }, 0, BOMB_CAMERA.restPitch, 1, { boom: null }, 1 / 60);
  assert.ok(Math.abs(sprinting.boom - BOMB_CAMERA.boom - BOMB_CAMERA.sprintBoom) < 1e-6);
});

test("camera: from every standable spot and 8 yaws it never sits inside geometry, and keeps a long boom almost everywhere (the glass guard is see-through)", () => {
  const nav = bombNav(),
    blockers = bombCameraBlockers();
  let samples = 0,
    short = 0;
  for (const node of nav.nodes)
    for (let k = 0; k < 8; k++) {
      const pivot = { x: node.x, y: node.y + BOMB_CAMERA.stand + BOMB_CAMERA.pivotHeight, z: node.z };
      const pose = bombCameraPose(blockers, pivot, (k * Math.PI) / 4, BOMB_CAMERA.restPitch, 0, { boom: null }, 1 / 60);
      samples++;
      assert.ok(!insideBlockers(blockers, pose.position, 0.1), `camera clear of geometry at (${node.x}, ${node.z})`);
      if (pose.boom < 3) short++;
    }
  assert.ok(short / samples < 0.05, `boom under 3 m in ${((100 * short) / samples).toFixed(1)}% of spots × yaws`);
});

// ─── Visuals ────────────────────────────────────────────────────────────────

/** POSITION bounds of each node of the built kit (read straight from the GLB's JSON chunk). */
function kitBounds() {
  const glb = readFileSync(new URL("../../../public/party-lab/maps/bomb/bomb-kit.glb", import.meta.url));
  const length = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + length).toString("utf8"));
  const out = new Map<string, { min: number[]; max: number[] }>();
  for (const node of json.nodes) {
    const accessor = json.accessors[json.meshes[node.mesh].primitives[0].attributes.POSITION];
    out.set(node.name, { min: accessor.min, max: accessor.max });
  }
  return out;
}

test("visuals: the arena mesh is generated from the colliders (two meshes, < 3k triangles); kit props stay readable — crates exactly over their colliders, ledge props outside and low, clouds far out", () => {
  const arena = buildBombArena();
  assert.equal(arena.group.children.length, 2, "solid + glass: two draw calls");
  assert.ok(arena.triangles < 3000, `${arena.triangles} triangles`);
  arena.dispose();
  const kit = kitBounds();
  assert.deepEqual([...kit.keys()].sort(), [...BOMB_KIT_NODES].sort());
  const size = (node: string, axis: number) => kit.get(node)!.max[axis] - kit.get(node)!.min[axis];
  assert.ok(Math.abs(size("Crate", 0) - 1) < 0.01 && Math.abs(size("Crate", 1) - 1) < 0.01, "the kit crate is a 1 m cube");
  // The trap's open jaws sit on its mat (≈ 0.8 × 0.93 m, low).
  assert.ok(Math.max(size("BearTrap", 0), size("BearTrap", 2)) <= 2 * TRAP_MAT.inner && size("BearTrap", 1) < 0.25, "the trap's jaws fit on its mat");
  // Crates tile each crate collider exactly.
  for (const b of CRATE_BLOCKS) {
    const inside = cratePlacements().filter((p) => p.x > b.x[0] && p.x < b.x[1] && p.z > b.z[0] && p.z < b.z[1]);
    const area = inside.reduce((a, p) => a + p.scale[0] * p.scale[2], 0);
    assert.ok(Math.abs(area - (b.x[1] - b.x[0]) * (b.z[1] - b.z[0])) < 1e-9);
    for (const p of inside) assert.equal(p.scale[1], b.height);
  }
  const extent = (p: Placement) => ({
    r: Math.max(size(p.node, 0) * p.scale[0], size(p.node, 2) * p.scale[2]) / 2,
    top: p.y + size(p.node, 1) * p.scale[1],
  });
  const perimeter = BOMB_ARENA.half + BOMB_ARENA.wall.thickness;
  for (const p of ledgePlacements()) {
    const { r, top } = extent(p);
    assert.ok(Math.max(Math.abs(p.x), Math.abs(p.z)) - r >= perimeter - 1e-6, `${p.node} outside the perimeter`);
    assert.ok(Math.max(Math.abs(p.x), Math.abs(p.z)) + r <= perimeter + BOMB_ARENA.ledge + 0.05, `${p.node} on the ledge`);
    assert.ok(top <= LEDGE_PROP_MAX, `${p.node} ${top.toFixed(2)} m tall`);
  }
  for (const p of cloudPlacements()) assert.ok(Math.hypot(p.x, p.z) - extent(p).r >= CLOUD_CLEAR_RADIUS, "clouds far out");
  for (const b of PERIMETER) assert.equal(b.height, BOMB_ARENA.wall.height);
});

test("controls: WASD camera-relative, Shift sprint, Space jump, F punches (passes the bomb); the controls line says so", () => {
  const intent = layerIntent({ x: 0, z: -1, jump: true, punch: true, grab: false, lift: true }, 0);
  assert.ok(Math.abs(intent.z - 1) < 1e-9 && Math.abs(intent.x) < 1e-9);
  assert.deepEqual([intent.jump, intent.punch, intent.sprint], [true, true, true]);
  assert.equal(controlHint(defaultBindings(), "bomb"), "WASD hareket · Shift koş · Space zıpla · F yumruk: bombayı ver · Esc menü");
  assert.equal(controlHint(defaultBindings(), "colors", "drag"), "WASD hareket · Shift koş · Space zıpla · F it · sürükleyerek bak · Esc menü", "the other modes' line is unchanged");
});

// ─── Regression ─────────────────────────────────────────────────────────────

test("online integration: protocol 8 exposes Bomba Sende after the existing modes; bomb sounds stay appended", () => {
  assert.deepEqual([...GAME_MODES], ["rooftop_brawl", "barn_shootout", "layer_chaos", "color_chaos", "bomb_tag"]);
  assert.ok((MODE_SELECTIONS as readonly string[]).includes(BOMB_TAG.mode));
  assert.equal(NET.version, 8);
  assert.deepEqual([...ARENA_MAP_IDS].sort(), ["barn", "rooftop", "test"]);
  assert.deepEqual(SFX_NAMES.slice(-3), ["bombTick", "bombPass", "bombBlast"], "the traps reuse the Barn's snap: no new sound");
  // The Barn's bear traps keep their own rules (damage, hold, 10 s rearm) and spots.
  assert.deepEqual(BARN_COMBAT.trap, { radius: 0.45, damage: 25, hold: 1.1, rearm: 10, stop: 0.85, stagger: { time: 0.2, posture: 0.75, mobility: 1 } });
  assert.deepEqual(Object.keys(BARN_TRAPS), ["T1", "T2"]);
  assert.equal(SFX_NAMES.indexOf("respawn"), SFX_NAMES.length - 4, "earlier names keep their positions");
  // The blast and pass reach the feedback sink with who and where.
  const events: FeedbackEvent[] = [];
  const game = new BombTagGame((e) => events.push(e), { players: 2, seed: 3 });
  while (game.round.phase !== "results") game.step(IDLE);
  assert.ok(events.some((e) => e.name === "bombBlast" && e.actor !== undefined));
  assert.equal(events.filter((e) => e.name === "bombTick").length, 7, "ticks at 5, 4, 3, 2, 1.5, 1 and 0.5 s");
  game.dispose();
});

test("navigation grid rebuilds from any map (no hand-placed waypoints)", () => {
  const nav = new BombNav(BOMB_MAP);
  assert.equal(nav.nodes.length, bombNav().nodes.length);
  assert.ok(nav.nodes.length > 1000);
});
