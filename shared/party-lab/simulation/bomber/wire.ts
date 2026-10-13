import { BOMBER as B } from "./config.js";
import { BOX, CELLS } from "./arena.js";
import type { BomberEvent, BomberGame, BomberPhase } from "./game.js";

/** Cell codes on the wire: the kind, or 4 for a box that is burning away. */
export const BURNING = 4;
const EVENT_KINDS = ["boom", "kill", "fall"] as const;
/**
 * Bombacı snapshot section. Per-lane arrays are by lane (`seats[lane]` is its slot). The
 * arena is the cell codes; bombs and flames are flat lists. Positions are exact metres.
 */
export interface BomberWire {
  seats: number[];
  phase: BomberPhase;
  /** Countdown seconds left (0 once playing). */
  countdown: number;
  /** Play steps since BAŞLA (the fixed step is BOMBER.hz a second). */
  step: number;
  /** Play time, seconds. */
  limit: number;
  /** Per cell: 0 floor, 1 pillar, 2 box, 3 fallen, 4 a box burning away. */
  cells: Uint8Array;
  /** Per lane: start cell. */
  spawns: number[];
  /** Bombs, five numbers each: id, owner lane, cell, steps to go, lanes still on it (bits). */
  bombs: number[];
  /** Flames, three numbers each: cell, steps left, scoring lane. */
  fire: number[];
  x: number[];
  z: number[];
  face: number[];
  alive: boolean[];
  /** Dead: steps until back. Alive: steps of blinking left. */
  respawn: number[];
  shield: number[];
  score: number[];
  kills: number[];
  selfKills: number[];
  deaths: number[];
  boxes: number[];
  out: boolean[];
  /** Bomb presses read per lane (prediction: a press above it is still to come). */
  presses: number[];
  /** Steps the server ran on the same input packet before this snapshot (prediction). */
  held: number[];
  /** Places (0 best, ties share one), final at results. */
  places: number[];
  /** Boxes broken this round. */
  broken: number;
  /** Recent events, four numbers each: id, kind (0 boom, 1 kill, 2 fall), then boom: owner, cell; kill: victim·4 + by+1, cell; fall: ring, 0. */
  events: number[];
}

export function bomberSection(game: BomberGame, seats: readonly number[], held: readonly number[] = []): BomberWire {
  const cells = new Uint8Array(CELLS);
  for (let c = 0; c < CELLS; c++) cells[c] = game.burn[c] ? BURNING : game.cells[c];
  const fire: number[] = [];
  for (let c = 0; c < CELLS; c++) if (game.fire[c]) fire.push(c, game.fire[c], game.fireLane[c]);
  const p = game.players;
  return {
    seats: [...seats],
    phase: game.phase,
    countdown: game.phase === "countdown" ? game.countdownTicks / B.hz : 0,
    step: game.ticks,
    limit: B.limit,
    cells,
    spawns: [...game.layout.spawns],
    bombs: game.bombs.flatMap((b) => [b.id, b.owner, b.cell, b.fuse, b.pass]),
    fire,
    // Exact: the client's prediction walks on from these, and rounding moves it near walls.
    x: p.map((q) => q.x),
    z: p.map((q) => q.z),
    face: p.map((q) => Math.round(q.face * 1000) / 1000),
    alive: p.map((q) => q.alive),
    respawn: p.map((q) => q.respawn),
    shield: p.map((q) => q.shield),
    score: p.map((q) => q.score),
    kills: p.map((q) => q.kills),
    selfKills: p.map((q) => q.selfKills),
    deaths: p.map((q) => q.deaths),
    boxes: p.map((q) => q.boxes),
    out: p.map((q) => q.out),
    presses: p.map((q) => q.presses),
    held: p.map((_, lane) => held[lane] ?? 0),
    places: game.places(),
    broken: game.broken,
    events: game.events.flatMap((e) => eventNumbers(e)),
  };
}
function eventNumbers(e: BomberEvent): number[] {
  if (e.kind === "boom") return [e.id, 0, e.owner, e.cell];
  if (e.kind === "kill") return [e.id, 1, e.victim * 4 + e.by + 1, e.cell];
  return [e.id, 2, e.ring, 0];
}
/** The section's events, decoded. */
export function wireEvents(wire: BomberWire): BomberEvent[] {
  const out: BomberEvent[] = [];
  for (let i = 0; i + 3 < wire.events.length; i += 4) {
    const [id, kind, a, b] = wire.events.slice(i, i + 4);
    const name = EVENT_KINDS[kind];
    if (name === "boom") out.push({ id, kind: name, bomb: -1, owner: a, cell: b });
    else if (name === "kill") out.push({ id, kind: name, victim: Math.floor(a / 4), by: (a % 4) - 1, cell: b });
    else if (name === "fall") out.push({ id, kind: name, ring: a });
  }
  return out;
}
export interface WireBomb {
  id: number;
  owner: number;
  cell: number;
  fuse: number;
  pass: number;
}
export function wireBombs(wire: BomberWire): WireBomb[] {
  const out: WireBomb[] = [];
  for (let i = 0; i + 5 <= wire.bombs.length; i += 5) {
    const [id, owner, cell, fuse, pass] = wire.bombs.slice(i, i + 5);
    out.push({ id, owner, cell, fuse, pass });
  }
  return out;
}
/** Restores the arena, the bombs and the players from a section (the client's prediction world). */
export function restoreBomber(game: BomberGame, wire: BomberWire) {
  for (let c = 0; c < CELLS; c++) {
    const code = wire.cells[c];
    game.cells[c] = code === BURNING ? BOX : code;
    game.burn[c] = code === BURNING ? 1 : 0;
    game.fire[c] = 0;
    game.fireLane[c] = -1;
  }
  for (let i = 0; i + 2 < wire.fire.length; i += 3) {
    game.fire[wire.fire[i]] = wire.fire[i + 1];
    game.fireLane[wire.fire[i]] = wire.fire[i + 2];
  }
  game.bombs = wireBombs(wire).map((b) => ({ ...b }));
  game.players.forEach((p, lane) => {
    p.x = wire.x[lane];
    p.z = wire.z[lane];
    p.face = wire.face[lane];
    p.alive = wire.alive[lane];
    p.respawn = wire.respawn[lane];
    p.shield = wire.shield[lane];
    p.score = wire.score[lane];
    p.out = wire.out[lane];
    p.presses = wire.presses[lane];
  });
  game.ticks = wire.step;
  game.phase = wire.phase;
}

const numbers = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) && value.length === length && value.every((n) => typeof n === "number" && Number.isFinite(n));
const flags = (value: unknown, length: number) => Array.isArray(value) && value.length === length && value.every((b) => typeof b === "boolean");
const flat = (value: unknown, stride: number, max: number) =>
  Array.isArray(value) && value.length % stride === 0 && value.length <= stride * max && value.every((n) => Number.isInteger(n));
/** A received section is well formed (the client never trusts a snapshot's shape). */
export function validBomberWire(value: unknown): value is BomberWire {
  if (!value || typeof value !== "object") return false;
  const w = value as BomberWire,
    lanes = Array.isArray(w.seats) ? w.seats.length : 0;
  if (lanes < 2 || lanes > B.maxLanes || !w.seats.every((slot) => Number.isInteger(slot) && slot >= 0)) return false;
  if (!(w.phase === "countdown" || w.phase === "playing" || w.phase === "results")) return false;
  if (![w.countdown, w.step, w.limit, w.broken].every((n) => typeof n === "number" && Number.isFinite(n))) return false;
  if (!(w.cells instanceof Uint8Array) || w.cells.length !== CELLS || w.cells.some((c) => c > BURNING)) return false;
  if (!numbers(w.spawns, lanes) || !w.spawns.every((c) => Number.isInteger(c) && c >= 0 && c < CELLS)) return false;
  if (!flat(w.bombs, 5, 32) || !flat(w.fire, 3, CELLS) || !flat(w.events, 4, 64)) return false;
  for (let i = 0; i < w.bombs.length; i += 5) if (w.bombs[i + 1] < 0 || w.bombs[i + 1] >= lanes || w.bombs[i + 2] < 0 || w.bombs[i + 2] >= CELLS) return false;
  for (let i = 0; i < w.fire.length; i += 3) if (w.fire[i] < 0 || w.fire[i] >= CELLS || w.fire[i + 2] < -1 || w.fire[i + 2] >= lanes) return false;
  if (![w.x, w.z, w.face, w.respawn, w.shield, w.score, w.kills, w.selfKills, w.deaths, w.boxes, w.presses, w.held, w.places].every((a) => numbers(a, lanes))) return false;
  return flags(w.alive, lanes) && flags(w.out, lanes);
}
