/**
 * Bombacı: the round arena (symmetry, closed start pockets, no way to bomb yourself in),
 * walking, blasts along rays and rings, chains and who scores them, deaths, coming back,
 * the falling rings, places, leaving and dropping, the round simulation and a real room.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Client, type Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { createPartyServer } from "../src/server.js";
import type { PartyRoom } from "../src/PartyRoom.js";
import type { LobbyState } from "../src/state.js";
import { BOMBER as B, ticks } from "../../../shared/party-lab/simulation/bomber/config.js";
import {
  BOX,
  CELLS,
  EDGES,
  FLOOR,
  PILLAR,
  RINGS,
  SECTORS,
  SECTOR_ANGLE,
  VOID,
  bomberLayout,
  cellAt,
  cellCenter,
  cellIndex,
  midRadius,
  neighbours,
  ringOf,
  sectorAngle,
  sectorOf,
  sharedSide,
  wedgeOf,
  wedgeSectors,
  type BomberLayout,
} from "../../../shared/party-lab/simulation/bomber/arena.js";
import { BomberGame, collapseFallAt, collapseWarnAt, ringStates, type BomberInput } from "../../../shared/party-lab/simulation/bomber/game.js";
import { BomberBot, blastFrom } from "../../../shared/party-lab/simulation/bomber/bots.js";
import { bomberSection, restoreBomber, validBomberWire, wireEvents } from "../../../shared/party-lab/simulation/bomber/wire.js";
import { walk } from "../../../shared/party-lab/simulation/bomber/motion.js";
import { BomberRoundSimulation } from "../../../shared/party-lab/simulation/bomberRound.js";
import { mulberry32 } from "../../../shared/party-lab/simulation/colors/layouts.js";
import { validateBomberInput } from "../../../shared/party-lab/network/bomberInput.js";
import { InputMailbox, NET, type GameSnapshot } from "../../../shared/party-lab/network/protocol.js";
import { GAME_MODES, MODE_NAMES, MixedRotation, modeFits } from "../../../shared/party-lab/modes.js";
import { LOCAL_ARENA_IDS } from "../../../shared/party-lab/localArenas.js";
import { BoardSession, type BoardHost } from "../../../shared/party-lab/board/session.js";
import { boardSquares } from "../../../shared/party-lab/board/config.js";
import { PLAYERS, type PlayerId } from "../../../shared/party-lab/simulation/players.js";

const FUSE = ticks(B.fuse),
  FLAME = ticks(B.flame);
const STILL: BomberInput = { x: 0, z: 0, bombs: 0 };

/** A game already playing (the countdown run through). */
function playing(count: number, seed = 1, layout?: BomberLayout) {
  const game = new BomberGame(count, mulberry32(seed), layout);
  while (game.phase === "countdown") game.step();
  return game;
}
/** Only pillars (no boxes): blasts and walks in the open. */
function open(count: number): BomberLayout {
  const base = bomberLayout(count, mulberry32(9));
  return { ...base, cells: base.cells.map((k) => (k === BOX ? FLOOR : k)) };
}
/** Every cell floor except the ones given. */
function bare(count: number, kinds: Record<number, number> = {}): BomberLayout {
  const base = bomberLayout(count, mulberry32(9)),
    cells = new Uint8Array(CELLS);
  for (const [cell, kind] of Object.entries(kinds)) cells[Number(cell)] = kind;
  return { ...base, cells };
}
const c = cellIndex;
function put(game: BomberGame, lane: number, cell: number) {
  Object.assign(game.players[lane], cellCenter(cell));
}
/** Steps, everyone standing still (or the given inputs). */
function run(game: BomberGame, steps: number, inputs: (BomberInput | undefined)[] = []) {
  for (let i = 0; i < steps && game.phase !== "results"; i++) game.step(inputs);
}
const burning = (game: BomberGame) => [...game.fire].flatMap((f, cell) => (f ? [cell] : [])).sort((a, b) => a - b);
const sorted = (cells: number[]) => [...cells].sort((a, b) => a - b);

/** The input that walks `lane` along `route` (through the middle of each shared side). */
function follow(game: BomberGame, lane: number, route: number[]): BomberInput {
  const p = game.players[lane],
    here = cellAt(p.x, p.z),
    i = Math.max(0, route.lastIndexOf(here));
  let goal = cellCenter(route[i]);
  if (i < route.length - 1) {
    const side = sharedSide(route[i], route[i + 1]),
      next = cellCenter(route[i + 1]);
    goal = { x: side.x + (next.x - side.x) * 0.35, z: side.z + (next.z - side.z) * 0.35 };
  }
  const dx = goal.x - p.x,
    dz = goal.z - p.z,
    d = Math.hypot(dx, dz);
  return d < 1e-6 ? STILL : { x: (dx / d) * Math.min(1, d / 0.08), z: (dz / d) * Math.min(1, d / 0.08), bombs: p.presses };
}
/** Shortest walk (cells) over free floor from `from` to the first cell `goal` accepts. */
function bfs(game: BomberGame, from: number, goal: (cell: number) => boolean, allowed: (cell: number) => boolean = () => true) {
  const previous = new Map<number, number>([[from, -1]]),
    queue = [from];
  while (queue.length) {
    const cell = queue.shift()!;
    if (cell !== from && goal(cell)) {
      const route = [cell];
      for (let p = previous.get(cell)!; p >= 0; p = previous.get(p)!) route.unshift(p);
      return route;
    }
    for (const next of neighbours(cell)) if (!previous.has(next) && game.walkable(next) && allowed(next)) previous.set(next, cell), queue.push(next);
  }
  return null;
}

test("the arena: 24 sectors × 5 rings round a hub; every cell found from its middle; cells close in size; corridors wide enough", () => {
  assert.equal(SECTORS, 24);
  assert.equal(RINGS, 5);
  assert.equal(SECTORS % 12, 0, "a 2-sector pillar pattern survives turns by a half and a third");
  for (let cell = 0; cell < CELLS; cell++) {
    const at = cellCenter(cell);
    assert.equal(cellAt(at.x, at.z), cell);
  }
  assert.equal(cellAt(0, 0), -1, "the hub");
  assert.equal(cellAt(EDGES[RINGS] + 0.01, 0), -1, "outside");
  const areas = B.ringDepths.map((depth, ring) => depth * midRadius(ring) * SECTOR_ANGLE);
  assert.ok(Math.max(...areas) / Math.min(...areas) < 1.6, `cell areas ${areas.map((a) => a.toFixed(2))}`);
  // The narrowest way through: a ray corridor at its inner end between two ring-1 pillars, or a ring corridor.
  const narrowest = Math.min(EDGES[1] * SECTOR_ANGLE, ...B.ringDepths);
  assert.ok(narrowest >= 2 * B.radius + 0.2, `narrowest ${narrowest}`);
});

for (const players of [2, 3])
  test(`${players} players: every wedge the same turned by ${360 / players}°, pillars at odd rings × odd sectors, an exact box share (200 arenas)`, () => {
    const wedge = wedgeSectors(players);
    for (let seed = 1; seed <= 200; seed++) {
      const layout = bomberLayout(players, mulberry32(seed));
      for (let cell = 0; cell < CELLS; cell++) {
        const turned = c(ringOf(cell), sectorOf(cell) + wedge);
        assert.equal(layout.cells[turned], layout.cells[cell], `seed ${seed}: cell ${cell}`);
        assert.equal(layout.cells[cell] === PILLAR, ringOf(cell) % 2 === 1 && sectorOf(cell) % 2 === 1);
      }
      layout.spawns.forEach((spawn, lane) => {
        assert.equal(spawn, c(ringOf(layout.spawns[0]), sectorOf(layout.spawns[0]) + lane * wedge));
        assert.equal(wedgeOf(sectorOf(spawn), players), lane);
        assert.equal(ringOf(spawn), RINGS - 1, "starts on the outer ring");
        assert.deepEqual(layout.pockets[lane], layout.pockets[0].map((cell) => c(ringOf(cell), sectorOf(cell) + lane * wedge)));
      });
      const boxes = [...layout.cells].filter((k) => k === BOX).length;
      assert.equal(boxes % players, 0);
      if (seed > 1) assert.equal(boxes, [...bomberLayout(players, mulberry32(1)).cells].filter((k) => k === BOX).length, "same digging every round");
    }
  });

for (const players of [2, 3])
  test(`${players} players: everyone starts shut in their own pocket of 8 cells; no one reaches anyone without breaking boxes`, () => {
    for (let seed = 1; seed <= 50; seed++) {
      const game = new BomberGame(players, mulberry32(seed));
      game.layout.spawns.forEach((spawn, lane) => {
        const reach = new Set([spawn]),
          queue = [spawn];
        while (queue.length) for (const next of neighbours(queue.shift()!)) if (!reach.has(next) && game.cells[next] === FLOOR) reach.add(next), queue.push(next);
        assert.deepEqual(sorted([...reach]), sorted(game.layout.pockets[lane]), `seed ${seed} lane ${lane}`);
        assert.equal(reach.size, 8);
      });
    }
  });

for (const players of [2, 3])
  test(`${players} players: a bomb on any pocket cell leaves a way out in time (walked for real, nobody dies)`, () => {
    for (const [index, cell] of new BomberGame(players, mulberry32(3)).layout.pockets[0].entries()) {
      const game = playing(players, 3);
      put(game, 0, cell);
      assert.ok(game.place(0), `bomb on pocket cell ${index}`);
      const blast = new Set(blastFrom(game, cell).cells),
        pocket = new Set(game.layout.pockets[0]);
      const route = bfs(game, cell, (x) => !blast.has(x) && pocket.has(x), (x) => pocket.has(x));
      assert.ok(route && route.length <= 4, `pocket cell ${index}: way out ${route}`);
      for (let i = 0; i < FUSE + FLAME + 10; i++) game.step([follow(game, 0, route)]);
      assert.equal(game.players[0].deaths, 0, `pocket cell ${index}: died`);
      assert.equal(game.bombs.length, 0);
    }
  });

test("walking: full speed along a ring, stopped by pillars and boxes, slid into an opening beside a pillar", () => {
  const game = playing(3, 1, open(3)),
    p = game.players[0];
  put(game, 0, c(2, 0));
  const start = { x: p.x, z: p.z },
    tangent = { x: -Math.sin(sectorAngle(0)), z: Math.cos(sectorAngle(0)) };
  run(game, 30, [{ ...tangent, bombs: 0 }]);
  assert.ok(Math.abs(Math.hypot(p.x - start.x, p.z - start.z) - B.speed * 0.5) < 0.12, "half a second at full speed along the ring (it slides round the curve)");
  // Straight out from ring 2 into the ring-3 pillar at sector 1.
  put(game, 0, c(2, 1));
  const out = { x: Math.cos(sectorAngle(1)), z: Math.sin(sectorAngle(1)) };
  run(game, 60, [{ ...out, bombs: 0 }]);
  assert.equal(cellAt(p.x, p.z), c(2, 1));
  assert.ok(Math.hypot(p.x, p.z) <= EDGES[3] - B.radius + 1e-6);
  // Beside the opening (sector 0, next to the pillar at sector 1): pressed straight out, slid into the corridor.
  const a = SECTOR_ANGLE - 0.04,
    r = midRadius(2);
  Object.assign(p, { x: r * Math.cos(a), z: r * Math.sin(a) });
  run(game, 50, [{ x: Math.cos(a), z: Math.sin(a), bombs: 0 }]);
  assert.ok(ringOf(cellAt(p.x, p.z)) >= 3, `slid into the ray corridor: ${ringOf(cellAt(p.x, p.z))}.${sectorOf(cellAt(p.x, p.z))}`);
  // A box is a wall.
  const boxed = playing(3, 1, bare(3, { [c(2, 3)]: BOX }));
  put(boxed, 0, c(2, 2));
  run(boxed, 60, [{ x: -Math.sin(sectorAngle(2)), z: Math.cos(sectorAngle(2)), bombs: 0 }]);
  assert.equal(cellAt(boxed.players[0].x, boxed.players[0].z), c(2, 2));
  // Walking never ends inside a solid cell, the hub or past the edge (random walks in a real arena).
  const real = playing(3, 7),
    random = mulberry32(5);
  for (let i = 0; i < 3000; i++) {
    for (const q of real.players) {
      walk(q, { x: random() * 2 - 1, z: random() * 2 - 1 }, real.solidFor(0), 1 / B.hz);
      const at = cellAt(q.x, q.z);
      assert.ok(at >= 0 && real.cells[at] === FLOOR, `inside a solid cell ${at}`);
    }
  }
});

test("bombs: Space puts one on your cell, two at most, a counter read twice places once; you walk off yours but never back on, nor onto another's", () => {
  const game = playing(3, 1, open(3)),
    p = game.players[0];
  put(game, 0, c(2, 0));
  game.step([{ x: 0, z: 0, bombs: 1 }]);
  game.step([{ x: 0, z: 0, bombs: 1 }]);
  assert.equal(game.bombs.length, 1, "the same counter twice: one bomb");
  assert.equal(game.bombs[0].cell, c(2, 0));
  assert.equal(game.bombs[0].owner, 0);
  game.step([{ x: 0, z: 0, bombs: 2 }]);
  assert.equal(game.bombs.length, 1, "a cell holds one bomb");
  // Off the bomb (along the ring), a second bomb, a third refused.
  const cw = (s: number) => ({ x: -Math.sin(sectorAngle(s)), z: Math.cos(sectorAngle(s)), bombs: 2 });
  for (let i = 0; i < 60 && cellAt(p.x, p.z) === c(2, 0); i++) game.step([cw(0)]);
  run(game, 20, [cw(1)]);
  assert.equal(cellAt(p.x, p.z), c(2, 1));
  assert.equal(game.bombs[0].pass, 0, "off it: it no longer lets you through");
  game.step([{ x: 0, z: 0, bombs: 3 }]);
  assert.equal(game.bombs.length, 2);
  run(game, 20, [{ ...cw(1), bombs: 3 }]);
  game.step([{ x: 0, z: 0, bombs: 4 }]);
  assert.equal(game.bombs.length, 2, "two at most");
  // Back towards the first bomb: stopped at its cell's side.
  put(game, 0, c(2, 23));
  run(game, 40, [{ ...cw(23), bombs: 4 }]);
  assert.equal(cellAt(p.x, p.z), c(2, 23));
  // Another player walking at a bomb is stopped too.
  put(game, 1, c(1, 0));
  run(game, 40, [STILL, { x: Math.cos(sectorAngle(0)), z: Math.sin(sectorAngle(0)), bombs: 0 }]);
  assert.equal(cellAt(game.players[1].x, game.players[1].z), c(1, 0));
});

test("blasts: 3 cells each way along the ray (in and out) and the ring (both ways, round past sector 0); stopped by the hub, the edge, pillars; a box breaks and stops it", () => {
  const game = playing(3, 1, bare(3, { [c(2, 2)]: PILLAR, [c(2, 22)]: BOX, [c(2, 20)]: BOX }));
  put(game, 0, c(4, 12));
  put(game, 1, c(4, 15));
  put(game, 2, c(4, 18));
  game.bombs.push({ id: 99, owner: 0, cell: c(2, 0), fuse: 1, pass: 0 });
  game.step();
  assert.deepEqual(burning(game), sorted([c(2, 0), c(1, 0), c(0, 0), c(3, 0), c(4, 0), c(2, 1), c(2, 23)]));
  assert.equal(game.burn[c(2, 22)], FLAME, "the box burns");
  assert.equal(game.cells[c(2, 22)], BOX, "still a box while it burns");
  assert.equal(game.burn[c(2, 20)], 0, "a box behind a box stays");
  assert.equal(game.players[0].boxes, 1);
  assert.equal(game.broken, 1);
  run(game, FLAME);
  assert.equal(game.cells[c(2, 22)], FLOOR, "burnt away");
  assert.deepEqual(burning(game), [], "flames out");
  // Full reach: 3 each way along the ring, round past sector 0.
  const wide = playing(3, 1, bare(3));
  put(wide, 0, c(4, 12));
  put(wide, 1, c(4, 15));
  put(wide, 2, c(4, 18));
  wide.bombs.push({ id: 1, owner: 0, cell: c(2, 1), fuse: 1, pass: 0 });
  wide.step();
  assert.deepEqual(burning(wide), sorted([c(2, 1), c(2, 2), c(2, 3), c(2, 4), c(2, 0), c(2, 23), c(2, 22), c(1, 1), c(0, 1), c(3, 1), c(4, 1)]));
});

test("chains: a blast sets off any bomb it reaches in the same step; a hit scores for the bomb whose flames it was; same-step overlaps go to the nearer bomb, then the first", () => {
  // A (lane 0) at 2.0 reaches B (lane 1) at 2.2; B's flames alone reach 2.4 (lane 2 stands there).
  const game = playing(3, 1, bare(3));
  put(game, 0, c(4, 12));
  put(game, 1, c(4, 15));
  put(game, 2, c(2, 4));
  game.bombs.push({ id: 1, owner: 0, cell: c(2, 0), fuse: 2, pass: 0 }, { id: 2, owner: 1, cell: c(2, 2), fuse: FUSE, pass: 0 });
  run(game, 2);
  assert.equal(game.bombs.length, 0, "both blew in the same step");
  assert.equal(game.players[2].alive, false);
  assert.deepEqual(game.players.map((p) => p.score), [0, 1, 0], "B's owner scores, not the chain's starter");
  assert.equal(game.fireLane[c(2, 1)], 0, "2.1: one cell from both, A blew first");
  assert.equal(game.fireLane[c(2, 3)], 1);
  // A (lane 0) at 2.0 reaches B (lane 1) at 2.3: 2.2 is 2 from A and 1 from B → B's.
  const near = playing(3, 1, bare(3));
  put(near, 0, c(4, 12));
  put(near, 1, c(4, 15));
  put(near, 2, c(2, 2));
  near.bombs.push({ id: 1, owner: 0, cell: c(2, 0), fuse: 1, pass: 0 }, { id: 2, owner: 1, cell: c(2, 3), fuse: FUSE, pass: 0 });
  near.step();
  assert.equal(near.fireLane[c(2, 2)], 1);
  assert.deepEqual(near.players.map((p) => p.score), [0, 1, 0]);
  const kill = wireEvents(bomberSection(near, [0, 1, 2])).find((e) => e.kind === "kill");
  assert.deepEqual(kill && { victim: kill.kind === "kill" && kill.victim, by: kill.kind === "kill" && kill.by }, { victim: 2, by: 1 });
  // A later blast over flames still burning takes the cell over.
  const later = playing(3, 1, bare(3));
  put(later, 0, c(4, 12));
  put(later, 1, c(4, 15));
  put(later, 2, c(4, 18));
  later.bombs.push({ id: 1, owner: 0, cell: c(2, 0), fuse: 1, pass: 0 }, { id: 2, owner: 1, cell: c(2, 6), fuse: 10, pass: 0 });
  run(later, 1);
  assert.equal(later.fireLane[c(2, 3)], 0);
  run(later, 9);
  assert.equal(later.fireLane[c(2, 3)], 1);
  put(later, 2, c(2, 3));
  later.step();
  assert.deepEqual(later.players.map((p) => p.score), [0, 1, 0]);
});

test("your own bomb: −1 and nobody scores; dead for 2 s, back at the start blinking 1.5 s and unhurt meanwhile, then hurt again", () => {
  const game = playing(3, 1, open(3)),
    spawn = game.layout.spawns[0];
  put(game, 0, c(2, 0));
  game.place(0);
  run(game, FUSE);
  assert.equal(game.players[0].alive, false);
  assert.deepEqual(game.players.map((p) => [p.score, p.kills, p.selfKills, p.deaths]), [[-1, 0, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]]);
  run(game, ticks(B.respawn) - 1);
  assert.equal(game.players[0].alive, false, "still out just before 2 s");
  game.step();
  assert.equal(game.players[0].alive, true);
  assert.equal(cellAt(game.players[0].x, game.players[0].z), spawn);
  assert.equal(game.players[0].shield, ticks(B.shield));
  // Lane 1's bomb on the start while it blinks: unhurt.
  game.bombs.push({ id: 50, owner: 1, cell: spawn, fuse: 1, pass: 1 });
  game.step();
  assert.equal(game.players[0].alive, true, "blinking: unhurt");
  assert.equal(game.players[1].score, 0);
  run(game, ticks(B.shield));
  assert.equal(game.players[0].shield, 0);
  game.bombs.push({ id: 51, owner: 1, cell: spawn, fuse: 1, pass: 1 });
  game.step();
  assert.equal(game.players[0].alive, false, "hurt once it stops blinking");
  assert.equal(game.players[1].score, 1);
  assert.equal(game.players[0].score, -1);
});

test("the last 15 s: rings 4, 3, 2, 1 blink 1.5 s then fall, 3.5 s apart; ring 0 stays; on a falling ring you die (nobody scores), boxes and bombs fall too; you come back on the nearest free cell of your wedge not about to fall", () => {
  assert.deepEqual((B.collapse.rings as readonly number[]).map((_, k) => collapseWarnAt(k) / B.hz), [45, 48.5, 52, 55.5]);
  assert.deepEqual((B.collapse.rings as readonly number[]).map((_, k) => (collapseFallAt(k) - collapseWarnAt(k)) / B.hz), [1.5, 1.5, 1.5, 1.5]);
  assert.deepEqual(ringStates(collapseWarnAt(0) - 1), [0, 0, 0, 0, 0]);
  assert.deepEqual(ringStates(collapseWarnAt(0)), [0, 0, 0, 0, 1]);
  assert.deepEqual(ringStates(collapseFallAt(1)), [0, 0, 0, 2, 2]);
  assert.deepEqual(ringStates(B.limit * B.hz), [0, 2, 2, 2, 2]);
  const game = playing(3, 4);
  run(game, collapseFallAt(0) - 1);
  assert.equal(game.ticks, collapseFallAt(0) - 1);
  const spawn = game.layout.spawns[1];
  // Lane 1 on its start (ring 4), lane 0 one ring in; a bomb of lane 0 on ring 4.
  put(game, 0, c(3, sectorOf(game.layout.spawns[0]) - 1));
  game.bombs.push({ id: 77, owner: 0, cell: c(4, sectorOf(game.layout.spawns[0]) - 1), fuse: FUSE, pass: 0 });
  game.step();
  assert.ok([...Array(SECTORS).keys()].every((s) => game.cells[c(4, s)] === VOID));
  assert.equal(game.players[1].alive, false);
  assert.equal(game.players[2].alive, false);
  assert.equal(game.players[0].alive, true);
  assert.deepEqual(game.players.map((p) => p.score), [0, 0, 0], "nobody scores a fall");
  assert.equal(game.bombs.length, 0, "the bomb fell, unblown");
  assert.ok(game.events.some((e) => e.kind === "fall" && e.ring === 4));
  run(game, ticks(B.respawn));
  const back = cellAt(game.players[1].x, game.players[1].z);
  assert.equal(game.players[1].alive, true);
  assert.equal(wedgeOf(sectorOf(back), 3), 1, "back in its own wedge");
  assert.ok(game.walkable(back));
  assert.ok(ringOf(back) <= 2, `not on ring 3, which falls 1.5 s later (${ringOf(back)})`);
  const from = cellCenter(spawn),
    dist = (cell: number) => Math.hypot(cellCenter(cell).x - from.x, cellCenter(cell).z - from.z);
  for (let cell = 0; cell < CELLS; cell++)
    if (game.walkable(cell) && ringOf(cell) <= 2 && wedgeOf(sectorOf(cell), 3) === 1) assert.ok(dist(cell) >= dist(back) - 1e-9, "the nearest free cell on a ring that stays");
  run(game, B.limit * B.hz);
  assert.equal(game.phase, "results");
  assert.ok([...Array(SECTORS).keys()].every((s) => game.cells[c(0, s)] !== VOID), "ring 0 stays to the end");
  assert.ok([1, 2, 3, 4].every((ring) => game.cells[c(ring, 0)] === VOID));
  assert.equal(game.ticks, B.limit * B.hz, "60 s of play");
});

test("places: most points wins, equal points share a place, a tie for first is a draw; a leaver is last; the last player left wins at once", () => {
  const game = playing(3, 1);
  Object.assign(game.players[0], { score: 2 });
  Object.assign(game.players[1], { score: 2 });
  Object.assign(game.players[2], { score: -1 });
  assert.equal(game.winner(), -1, "not over");
  run(game, B.limit * B.hz);
  assert.deepEqual(game.places(), [0, 0, 2]);
  assert.equal(game.winner(), -1, "a draw");
  const two = playing(3, 1);
  Object.assign(two.players[2], { score: 5 });
  Object.assign(two.players[0], { score: 1 });
  two.remove(2);
  two.step();
  assert.equal(two.phase, "playing", "two still in");
  assert.deepEqual(two.places(), [0, 1, 2], "the leaver last despite 5 points");
  two.remove(1);
  two.step();
  assert.equal(two.phase, "results");
  assert.equal(two.winner(), 0);
});

test("bots: Orta and Zor never die to their own bombs when nobody interferes, Kolay sometimes does; they break boxes and catch players", () => {
  const solo = (level: "easy" | "medium" | "hard", games: number) => {
    let self = 0,
      boxes = 0,
      kills = 0;
    for (let g = 0; g < games; g++) {
      const random = mulberry32(5000 + g),
        game = new BomberGame(3, random),
        bot = new BomberBot(level, 0, random);
      while (game.phase !== "results") {
        game.step([bot.input(game)]);
        // Before the rings fall: the last ring can leave nowhere to go.
        if (game.ticks === collapseWarnAt(0)) self += game.players[0].selfKills;
      }
      boxes += game.players[0].boxes;
      kills += game.players[0].kills;
    }
    return { self: self / games, boxes: boxes / games, kills: kills / games };
  };
  const medium = solo("medium", 12),
    hard = solo("hard", 12),
    easy = solo("easy", 24);
  assert.equal(medium.self, 0, `Orta ${JSON.stringify(medium)}`);
  assert.equal(hard.self, 0, `Zor ${JSON.stringify(hard)}`);
  assert.ok(easy.self > 0.1, `Kolay ${JSON.stringify(easy)}`);
  for (const r of [medium, hard, easy]) {
    assert.ok(r.boxes > 15, `boxes ${JSON.stringify(r)}`);
    assert.ok(r.kills > 0.5, `kills ${JSON.stringify(r)}`);
  }
  // Three bots together play a whole round: boxes broken, someone scores, nobody stands still.
  const random = mulberry32(42),
    game = new BomberGame(3, random),
    bots = [0, 1, 2].map((lane) => new BomberBot("medium", lane, random));
  while (game.phase !== "results") game.step(bots.map((b) => b.input(game)));
  assert.ok(game.broken > 30, `broken ${game.broken}`);
});

test("the section: restores the arena, bombs, flames and players; a malformed one is refused", () => {
  const game = playing(3, 2, open(3));
  put(game, 0, c(2, 0));
  game.step([{ x: 0, z: 0, bombs: 1 }]);
  run(game, 5);
  const wire = bomberSection(game, [0, 1, 2], [1, 0, 2]);
  assert.ok(validBomberWire(wire));
  assert.deepEqual(wire.held, [1, 0, 2]);
  const copy = new BomberGame(3, mulberry32(99));
  restoreBomber(copy, wire);
  assert.deepEqual([...copy.cells], [...game.cells]);
  assert.deepEqual(copy.bombs, game.bombs);
  assert.ok(Math.abs(copy.players[0].x - game.players[0].x) < 0.006);
  assert.equal(copy.players[0].presses, 1);
  assert.ok(!validBomberWire({ ...wire, cells: new Uint8Array(3) }));
  assert.ok(!validBomberWire({ ...wire, bombs: [1, 2, 3] }));
  assert.ok(!validBomberWire({ ...wire, x: [0, 0] }));
  assert.ok(!validBomberWire({ ...wire, seats: [0] }));
});

test("the round simulation: 2–3 players, slots (not seats) as winner, placements per slot, a fresh arena every round, held inputs counted", () => {
  const sim = new BomberRoundSimulation(undefined, 5);
  assert.equal(sim.start([0] as PlayerId[]), false);
  assert.ok(sim.start([2, 1] as PlayerId[]));
  assert.deepEqual(sim.seats, [1, 2]);
  const first = [...sim.game.cells];
  while (sim.phase === "countdown") sim.step([]);
  assert.equal(sim.phase, "playing");
  const packet = { seq: 4, round: sim.roundId, moveX: 1, moveZ: 0, bombs: 0 };
  const inputs = PLAYERS.map(() => ({ x: 0, z: 0, jump: false, bomber: packet }));
  sim.step(inputs);
  sim.step(inputs);
  sim.step(inputs);
  const snap = sim.snapshot([0, 0, 0]);
  assert.equal(snap.v, 25);
  assert.equal(snap.mode, "bomber");
  assert.ok(validBomberWire(snap.bomber));
  assert.deepEqual(snap.bomber!.held, [2, 2], "the same packet three steps: two extra");
  sim.game.players[1].score = 3;
  sim.game.ticks = sim.game.limitTicks - 1;
  sim.step([]);
  assert.equal(sim.phase, "results");
  assert.equal(sim.winner, 2, "lane 1 is slot 2");
  assert.deepEqual(sim.placements(), [-1, 1, 0]);
  for (let i = 0; i < B.results * B.hz + 1; i++) sim.step([]);
  assert.equal(sim.phase, "waiting");
  assert.ok(sim.start([0, 1, 2] as PlayerId[]));
  assert.notDeepEqual([...sim.game.cells], first, "a new arena");
});

test("mailbox: the newest walk is read every step until a newer one or 300 ms of silence; strict packets", () => {
  const box = new InputMailbox();
  assert.equal(box.accept({ seq: 1, round: 3, moveX: 0.6, moveZ: 0.8, bombs: 2 }, 3, 0, "bomber"), true);
  assert.deepEqual(box.read(10).bomber, { seq: 1, round: 3, moveX: 0.6, moveZ: 0.8, bombs: 2 });
  assert.deepEqual(box.read(20).bomber, { seq: 1, round: 3, moveX: 0.6, moveZ: 0.8, bombs: 2 }, "read again (held state)");
  assert.equal(box.read(400).bomber, undefined, "stale: standing still");
  assert.equal(box.accept({ seq: 2, round: 2, moveX: 0, moveZ: 0, bombs: 0 }, 3, 0, "bomber"), false, "old round");
  assert.equal(box.accept({ seq: 2, round: 3, moveX: 0, moveZ: 0, bombs: 0, extra: 1 }, 3, 0, "bomber"), false);
  assert.deepEqual(validateBomberInput({ seq: 1, round: 1, moveX: 0.6, moveZ: 0.8, bombs: 0 }), { seq: 1, round: 1, moveX: 0.6, moveZ: 0.8, bombs: 0 });
  assert.equal(validateBomberInput({ seq: 1, round: 1, moveX: 3, moveZ: 0, bombs: 0 })!.moveX, 1, "never faster than walking");
  const diagonal = validateBomberInput({ seq: 1, round: 1, moveX: 1, moveZ: 1, bombs: 0 })!;
  assert.ok(Math.abs(Math.hypot(diagonal.moveX, diagonal.moveZ) - 1) < 1e-9);
  assert.equal(validateBomberInput({ seq: 1, round: 1, moveX: 0, moveZ: 0, bombs: -1 }), null);
  assert.equal(validateBomberInput({ seq: 1, round: 1, moveX: NaN, moveZ: 0, bombs: 0 }), null);
});

test("Bombacı is a 2–3 player mode in Mixed, in the board's mini games and in the Yerel Test Arenası", () => {
  assert.ok(GAME_MODES.includes("bomber"));
  assert.equal(MODE_NAMES.bomber, "Bombacı");
  assert.ok(LOCAL_ARENA_IDS.includes("bomber"));
  assert.ok(!modeFits("bomber", 1) && modeFits("bomber", 2) && modeFits("bomber", 3) && !modeFits("bomber", 4));
  for (const count of [2, 3]) {
    const mixed = new MixedRotation(() => 0.5);
    mixed.setPlayers(count);
    const cycle = GAME_MODES.filter((m) => modeFits(m, count)).map(() => {
      const mode = mixed.next;
      mixed.played();
      return mode;
    });
    assert.ok(cycle.includes("bomber"), `Mixed ${count}P`);
    const minis: string[] = [];
    const host: BoardHost = { startMini: (mode) => (minis.push(mode), true), endMini() {}, connected: () => true };
    const rotation = new MixedRotation(() => 0.25);
    rotation.setPlayers(count);
    const board = new BoardSession(host, { length: 50, slots: PLAYERS.slice(0, count).map((p) => p.id), random: () => 0.25, die: () => 1, rotation, squares: boardSquares(50) });
    const until = (done: () => boolean, act = () => board.step(1 / NET.physicsHz)) => {
      for (let t = 0; t < 600 * NET.physicsHz && !done(); t++) act();
      assert.ok(done(), `board stuck in ${board.phase}`);
    };
    while (minis.length < cycle.length) {
      until(() => board.phase === "minigame");
      board.miniResult(-1, null);
      until(() => board.phase !== "minigame");
      until(() => board.phase === "intro", () => (board.phase === "roll" ? board.rollPressed(board.current) : board.step(1 / NET.physicsHz)));
    }
    assert.ok(minis.includes("bomber"), `Tahta Oyunu ${count}P: ${minis.join(",")}`);
  }
});

/* A real room: a bomb from a packet, a hit scored to the bomb's owner, a dropped player's
   character stays (and can be hit) and walks again once back, the results reach everyone. */
const { server, httpServer } = createPartyServer();
let endpoint = "";
const rooms: Room<unknown, LobbyState>[] = [];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw Error("timeout");
    await pause(5);
  }
}
before(async () => {
  await server.listen(0, "127.0.0.1");
  endpoint = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
after(async () => {
  for (const r of rooms) {
    r.reconnection.enabled = false;
    if (r.connection.isOpen) await r.leave().catch(() => {});
  }
  await server.gracefullyShutdown(false);
});
async function peer(code?: string) {
  const client = new Client(endpoint),
    r = code
      ? await client.joinById<LobbyState>(code, { protocol: NET.version, nickname: "Guest", intent: "join", code })
      : await client.create<LobbyState>("party_lab", { protocol: NET.version, nickname: "Host", intent: "create" });
  rooms.push(r);
  r.onMessage("notice", () => {});
  r.onMessage("feedback", () => {});
  const snapshots: GameSnapshot[] = [];
  r.onMessage("snapshot", (s: GameSnapshot) => snapshots.push(s));
  Object.assign(r.reconnection, { minUptime: 0, minDelay: 70, maxDelay: 100, maxRetries: 10 });
  let seq = 0;
  return { r, snapshots, send: (round: number, moveX: number, moveZ: number, bombs: number) => r.send("input", { seq: ++seq, round, moveX, moveZ, bombs }) };
}
async function lobby(count: number) {
  const peers = [await peer()];
  for (let i = 1; i < count; i++) peers.push(await peer(peers[0].r.roomId));
  const room = matchMaker.getLocalRoomById(peers[0].r.roomId) as PartyRoom;
  peers[0].r.send("mode", "bomber");
  await until(() => room.selection === "bomber");
  for (const p of peers) p.r.send("ready", true);
  await until(() => room.game.phase === "countdown");
  const sim = room.game as BomberRoundSimulation;
  assert.ok(sim instanceof BomberRoundSimulation);
  const lane = (p: (typeof peers)[number]) => sim.seats.indexOf(room.state.players.get(p.r.sessionId)!.slot as never);
  return { peers, room, sim, lane };
}
async function close(peers: { r: Room<unknown, LobbyState> }[]) {
  for (const p of peers) {
    p.r.reconnection.enabled = false;
    if (p.r.connection.isOpen) await p.r.leave();
  }
}

for (const count of [2, 3])
  test(`room ${count}P: a bomb from a packet, the hit scores for its owner, a dropped player stays put and walks again once back, results`, { timeout: 30000 }, async () => {
    const { peers, room, sim, lane } = await lobby(count);
    const g = sim.game,
      l0 = lane(peers[0]),
      l1 = lane(peers[1]);
    await until(() => room.game.phase === "playing");
    // Lane 0 bombs its start; lane 1 is put next to it (in the blast).
    const spawn = g.layout.spawns[l0];
    peers[0].send(sim.roundId, 0, 0, 1);
    await until(() => g.bombs.length === 1);
    assert.equal(g.bombs[0].cell, spawn);
    assert.equal(g.bombs[0].owner, l0);
    peers[0].send(sim.roundId, 0, 0, 1);
    // Lane 0 out of the way (the next pocket cell's far side, round the pillar).
    Object.assign(g.players[l0], cellCenter(c(2, sectorOf(spawn) - 1)));
    Object.assign(g.players[l1], cellCenter(c(4, sectorOf(spawn) + 1)));
    // Lane 1 drops: its character stays where it is.
    const r = peers[1].r,
      id = r.sessionId;
    r.connection.close(4010);
    await until(() => !room.state.players.get(id)!.connected);
    await until(() => g.bombs.length === 0, 4000);
    await until(() => g.players[l1].deaths === 1);
    assert.equal(g.players[l0].score, 1, "the bomb's owner scores");
    assert.equal(g.players[l0].deaths, 0);
    await until(() => room.state.players.get(id)!.connected);
    assert.equal(room.game, sim);
    await until(() => g.players[l1].alive, 4000);
    // Back: it walks (along its ring, round the pocket) on its own packets.
    const before = { ...g.players[l1] };
    const a = sectorAngle(sectorOf(g.layout.spawns[l1]));
    for (let i = 0; i < 20; i++) {
      peers[1].send(sim.roundId, -Math.sin(a), Math.cos(a), 0);
      await pause(16);
    }
    await until(() => Math.hypot(g.players[l1].x - before.x, g.players[l1].z - before.z) > 0.3);
    sim.game.ticks = sim.game.limitTicks - 2;
    await until(() => room.game.phase === "results", 4000);
    const slot = (i: number) => room.state.players.get(peers[i].r.sessionId)!.slot;
    assert.equal(room.state.winner, slot(0));
    assert.equal(sim.placements()[slot(0)], 0);
    await until(() => peers[0].snapshots.at(-1)?.phase === "results");
    const shown = peers[0].snapshots.at(-1)!;
    assert.equal(shown.v, 25);
    assert.ok(validBomberWire(shown.bomber), "the section survives the wire");
    assert.ok(shown.bomber!.cells instanceof Uint8Array);
    assert.equal(shown.winner, slot(0));
    await close(peers);
  });

test("room: the player left alone wins the round", { timeout: 30000 }, async () => {
  const { peers, room, sim } = await lobby(2);
  await until(() => room.game.phase === "playing");
  peers[1].r.reconnection.enabled = false;
  await peers[1].r.leave();
  await until(() => room.game.phase === "results");
  assert.equal(sim.winner, room.state.players.get(peers[0].r.sessionId)!.slot);
  await close(peers.slice(0, 1));
});
