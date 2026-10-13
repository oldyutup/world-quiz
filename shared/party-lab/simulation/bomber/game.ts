import { BOMBER as B, ticks } from "./config.js";
import { BOX, CELLS, FLOOR, PILLAR, SECTORS, VOID, bomberLayout, cellAt, cellCenter, cellIndex, neighbour, ringOf, sectorOf, wedgeOf, type BomberLayout } from "./arena.js";
import { overlapsCell, walk, type Point } from "./motion.js";
import { ranksByScore } from "../../board/rules.js";

export type BomberPhase = "countdown" | "playing" | "results";
export interface BomberBomb {
  id: number;
  owner: number;
  cell: number;
  /** Steps until it blows. */
  fuse: number;
  /** Lanes that were on its cell when it was placed: they may walk off it (bit per lane). */
  pass: number;
}
export interface BomberPlayer extends Point {
  /** Facing (atan2(x, z) of the last walk). */
  face: number;
  alive: boolean;
  /** Dead: steps until back. */
  respawn: number;
  /** Back from the dead: steps of blinking left (bombs do not hurt). */
  shield: number;
  score: number;
  kills: number;
  selfKills: number;
  deaths: number;
  /** Boxes this player's bombs broke. */
  boxes: number;
  /** Left the round: ranked behind everyone who stayed. */
  out: boolean;
  /** Bomb presses read (a press is one more than this). */
  presses: number;
}
/** One player's step: a walk direction (length ≤ 1, world axes) and the bomb presses so far this round. */
export interface BomberInput {
  x: number;
  z: number;
  bombs: number;
}
/** What happened, for the view (sounds, the kill feed, points that float up). */
export type BomberEvent =
  | { id: number; kind: "boom"; bomb: number; owner: number; cell: number }
  | { id: number; kind: "kill"; victim: number; by: number; cell: number }
  | { id: number; kind: "fall"; ring: number };
type BomberEventData = BomberEvent extends infer E ? (E extends BomberEvent ? Omit<E, "id"> : never) : never;
/** `by` of a kill nobody scored: the ground fell. */
export const FELL = -1;

/** Coming back on a ring that falls within this many steps would be a trap: further in instead. */
const RING_SOON = ticks(3);
const FUSE = ticks(B.fuse),
  FLAME = ticks(B.flame),
  RESPAWN = ticks(B.respawn),
  SHIELD = ticks(B.shield),
  DT = 1 / B.hz;

/** The play step at which ring `rings[k]` starts blinking, and the one at which it falls. */
export const collapseWarnAt = (k: number) => ticks(B.collapse.start + k * B.collapse.every);
export const collapseFallAt = (k: number) => collapseWarnAt(k) + ticks(B.collapse.warn);
/** Per ring after `step` steps of play: 0 standing, 1 blinking (about to fall), 2 fallen. */
export function ringStates(step: number) {
  const states = B.ringDepths.map(() => 0);
  (B.collapse.rings as readonly number[]).forEach((ring, k) => {
    if (step >= collapseFallAt(k)) states[ring] = 2;
    else if (step >= collapseWarnAt(k)) states[ring] = 1;
  });
  return states;
}

/**
 * The Bombacı rules without any network. After a countdown everyone walks their own closed
 * pocket; a bomb blows `range` cells along its ray and its ring, stops at pillars, breaks the
 * first box and stops there, and sets off any bomb it reaches at once. A player whose centre
 * is in flames dies: the bomb that made those flames scores (+1, or −1 to its own owner). Dead
 * players come back at their start after `respawn` s, unhurt for `shield` s. In the last
 * seconds the rings fall from the outside in. Most points after `limit` s wins.
 *
 * Who scores a cell burnt by two bombs in the same step: the nearer bomb, then the one that
 * blew first. A later blast over still-burning flames takes the cell over.
 */
export class BomberGame {
  phase: BomberPhase = "countdown";
  countdownTicks = ticks(B.countdown);
  /** Play steps since BAŞLA. */
  ticks = 0;
  readonly layout: BomberLayout;
  readonly cells: Uint8Array;
  /** Steps a broken box still burns (it stays a box until then). */
  readonly burn = new Uint8Array(CELLS);
  /** Steps of flames left, and who scores them (lane, bomb). */
  readonly fire = new Uint8Array(CELLS);
  readonly fireLane = new Int8Array(CELLS).fill(-1);
  readonly fireBomb = new Int32Array(CELLS);
  private readonly fireStep = new Int32Array(CELLS).fill(-1);
  private readonly fireDistance = new Uint8Array(CELLS);
  bombs: BomberBomb[] = [];
  private nextBomb = 1;
  readonly players: BomberPlayer[];
  /** Recent events (the last 32), ids rising. */
  events: BomberEvent[] = [];
  private nextEvent = 1;
  /** Boxes broken this round. */
  broken = 0;
  constructor(readonly count: number, random: () => number = Math.random, layout?: BomberLayout) {
    if (!Number.isInteger(count) || count < 2 || count > B.maxLanes) throw new RangeError(`Bombacı: ${count} players`);
    this.layout = layout ?? bomberLayout(count, random);
    this.cells = this.layout.cells.slice();
    this.players = this.layout.spawns.map((cell) => ({
      ...cellCenter(cell),
      face: 0,
      alive: true,
      respawn: 0,
      shield: 0,
      score: 0,
      kills: 0,
      selfKills: 0,
      deaths: 0,
      boxes: 0,
      out: false,
      presses: 0,
    }));
    // Everyone starts facing the hub.
    for (const p of this.players) p.face = Math.atan2(-p.x, -p.z);
  }
  get elapsedMs() {
    return (this.ticks * 1000) / B.hz;
  }
  get limitTicks() {
    return B.limit * B.hz;
  }
  bombAt(cell: number) {
    return this.bombs.find((b) => b.cell === cell);
  }
  /** The cell stops `lane`'s walk: a pillar, a box, a fallen cell, or a bomb it was not on. */
  solidFor(lane: number) {
    return (cell: number) => {
      const kind = this.cells[cell];
      if (kind !== FLOOR) return true;
      const bomb = this.bombAt(cell);
      return !!bomb && !(bomb.pass & (1 << lane));
    };
  }
  /** A free cell to stand on: floor without a bomb. */
  walkable(cell: number) {
    return cell >= 0 && this.cells[cell] === FLOOR && !this.bombAt(cell);
  }

  /** One fixed step; `inputs[lane]` is that player's latest input (undefined: standing still). */
  step(inputs: readonly (BomberInput | undefined)[] = []) {
    if (this.phase === "results") return;
    if (this.phase === "countdown") {
      if (--this.countdownTicks <= 0) this.phase = "playing";
      if (this.players.filter((p) => !p.out).length <= 1) this.phase = "results";
      return;
    }
    this.ticks++;
    for (let c = 0; c < CELLS; c++) {
      if (this.fire[c] && --this.fire[c] === 0) this.fireLane[c] = -1;
      if (this.burn[c] && --this.burn[c] === 0) this.cells[c] = FLOOR;
    }
    // Back from the dead `respawn` steps after dying (and able to walk at once); blinking counts down.
    this.players.forEach((p, lane) => {
      if (p.out) return;
      if (!p.alive) {
        if (--p.respawn <= 0) this.spawn(lane);
      } else if (p.shield > 0) p.shield--;
    });
    this.players.forEach((p, lane) => {
      const input = inputs[lane];
      if (p.out || !input) return;
      if (p.alive) this.walkLane(lane, input);
      if (input.bombs > p.presses) {
        p.presses = input.bombs;
        if (p.alive) this.place(lane);
      }
    });
    this.updatePasses();
    const due: BomberBomb[] = [];
    for (const b of this.bombs) if (--b.fuse <= 0 || this.fire[b.cell]) due.push(b);
    if (due.length) this.detonate(due);
    (B.collapse.rings as readonly number[]).forEach((ring, k) => {
      if (this.ticks === collapseFallAt(k)) this.fall(ring);
    });
    this.players.forEach((p, lane) => {
      if (p.out || !p.alive || p.shield > 0) return;
      const cell = cellAt(p.x, p.z);
      if (cell >= 0 && this.fire[cell]) this.kill(lane, this.fireLane[cell], cell);
    });
    if (this.ticks >= this.limitTicks) this.phase = "results";
    // The last player left wins at once.
    if (this.players.filter((p) => !p.out).length <= 1) this.phase = "results";
  }
  /** `lane` walks one step (also the client's prediction of its own player). */
  walkLane(lane: number, input: BomberInput) {
    const p = this.players[lane],
      x = Math.max(-1, Math.min(1, input.x)),
      z = Math.max(-1, Math.min(1, input.z));
    if (!x && !z) return;
    walk(p, { x, z }, this.solidFor(lane), DT);
    p.face = Math.atan2(x, z);
  }
  /** A bomb on `lane`'s cell: alive, under `maxBombs`, on free floor. True when placed. */
  place(lane: number) {
    const p = this.players[lane],
      cell = cellAt(p.x, p.z);
    if (!p.alive || p.out || this.phase !== "playing" || cell < 0 || this.cells[cell] !== FLOOR || this.bombAt(cell)) return false;
    if (this.bombs.filter((b) => b.owner === lane).length >= B.maxBombs) return false;
    let pass = 0;
    this.players.forEach((q, i) => {
      if (q.alive && !q.out && overlapsCell(cell, q.x, q.z)) pass |= 1 << i;
    });
    this.bombs.push({ id: this.nextBomb++, owner: lane, cell, fuse: FUSE, pass });
    return true;
  }
  /** Who stepped off a bomb can no longer walk back on. */
  updatePasses() {
    for (const b of this.bombs)
      if (b.pass)
        this.players.forEach((p, i) => {
          if (b.pass & (1 << i) && (!p.alive || p.out || !overlapsCell(b.cell, p.x, p.z))) b.pass &= ~(1 << i);
        });
  }
  /** Blows `first` and every bomb its flames reach, in order, all in this step. */
  private detonate(first: BomberBomb[]) {
    const queue = [...first],
      queued = new Set(queue);
    while (queue.length) {
      const b = queue.shift()!;
      this.bombs = this.bombs.filter((x) => x !== b);
      this.event({ kind: "boom", bomb: b.id, owner: b.owner, cell: b.cell });
      this.paint(b.cell, b, 0);
      for (let direction = 0; direction < 4; direction++) {
        let cell = b.cell;
        for (let k = 1; k <= B.range; k++) {
          cell = neighbour(cell, direction);
          if (cell < 0) break;
          const kind = this.cells[cell];
          if (kind === PILLAR || kind === VOID) break;
          if (kind === BOX) {
            if (!this.burn[cell]) {
              this.burn[cell] = FLAME;
              this.broken++;
              this.players[b.owner].boxes++;
            }
            break;
          }
          this.paint(cell, b, k);
          const other = this.bombAt(cell);
          if (other) {
            if (!queued.has(other)) {
              queued.add(other);
              queue.push(other);
            }
            break;
          }
        }
      }
    }
  }
  /** Flames on `cell` from bomb `b`, `distance` cells from it. */
  private paint(cell: number, b: BomberBomb, distance: number) {
    const same = this.fireStep[cell] === this.ticks && this.fire[cell] > 0;
    this.fire[cell] = FLAME;
    // Burnt twice in one step: the nearer bomb scores, then the one that blew first.
    if (same && distance >= this.fireDistance[cell]) return;
    this.fireLane[cell] = b.owner;
    this.fireBomb[cell] = b.id;
    this.fireStep[cell] = this.ticks;
    this.fireDistance[cell] = distance;
  }
  /** Ring `ring` falls: everyone on it dies (nobody scores), its boxes, bombs and flames go with it. */
  private fall(ring: number) {
    for (let s = 0; s < SECTORS; s++) {
      const cell = cellIndex(ring, s);
      this.cells[cell] = VOID;
      this.burn[cell] = this.fire[cell] = 0;
      this.fireLane[cell] = -1;
    }
    this.bombs = this.bombs.filter((b) => ringOf(b.cell) !== ring);
    this.event({ kind: "fall", ring });
    this.players.forEach((p, lane) => {
      const cell = cellAt(p.x, p.z);
      if (p.alive && !p.out && cell >= 0 && ringOf(cell) === ring) this.kill(lane, FELL, cell);
    });
  }
  private kill(lane: number, by: number, cell: number) {
    const p = this.players[lane];
    p.alive = false;
    p.respawn = RESPAWN;
    p.shield = 0;
    p.deaths++;
    if (by === lane) {
      p.score += B.selfPoints;
      p.selfKills++;
    } else if (by >= 0) {
      this.players[by].score += B.killPoints;
      this.players[by].kills++;
    }
    this.event({ kind: "kill", victim: lane, by, cell });
  }
  /** The ring falls within `RING_SOON` steps (coming back there would be a trap). */
  private fallsSoon(cell: number) {
    const k = (B.collapse.rings as readonly number[]).indexOf(ringOf(cell));
    return k >= 0 && collapseFallAt(k) - this.ticks <= RING_SOON;
  }
  /**
   * Where `lane` comes back: its start, or (taken, fallen or about to fall) the nearest free cell
   * of its wedge on a ring that is not about to fall, then of the arena.
   */
  spawnCell(lane: number) {
    const start = this.layout.spawns[lane];
    if (this.walkable(start) && !this.fallsSoon(start)) return start;
    const from = cellCenter(start),
      players = this.count;
    const nearest = (inWedge: boolean) => {
      let best = -1,
        bestD = Infinity;
      for (let c = 0; c < CELLS; c++) {
        if (!this.walkable(c) || this.fallsSoon(c) || (inWedge && wedgeOf(sectorOf(c), players) !== lane)) continue;
        const at = cellCenter(c),
          d = Math.hypot(at.x - from.x, at.z - from.z);
        if (d < bestD - 1e-9) {
          best = c;
          bestD = d;
        }
      }
      return best;
    };
    const cell = nearest(true);
    if (cell >= 0) return cell;
    const any = nearest(false);
    if (any >= 0) return any;
    // Nothing free anywhere (every cell a box or a bomb): clear the inner cell below the start.
    const inner = cellIndex(0, sectorOf(start));
    this.cells[inner] = FLOOR;
    this.burn[inner] = 0;
    this.bombs = this.bombs.filter((b) => b.cell !== inner);
    return inner;
  }
  private spawn(lane: number) {
    const p = this.players[lane],
      at = cellCenter(this.spawnCell(lane));
    p.x = at.x;
    p.z = at.z;
    p.face = Math.atan2(-p.x, -p.z);
    p.alive = true;
    p.respawn = 0;
    p.shield = SHIELD;
  }
  private event(e: BomberEventData) {
    this.events.push({ ...e, id: this.nextEvent++ } as BomberEvent);
    if (this.events.length > 32) this.events.splice(0, this.events.length - 32);
  }
  /** `lane` left the round for good: off the arena, ranked last; its bombs still blow. */
  remove(lane: number) {
    const p = this.players[lane];
    if (!p || p.out) return;
    p.out = true;
    p.alive = false;
    p.shield = p.respawn = 0;
    for (const b of this.bombs) b.pass &= ~(1 << lane);
  }
  /** Per-lane order, higher first: points; leavers last. */
  scores() {
    return this.players.map((p) => (p.out ? -1e9 + p.score : p.score));
  }
  /** Per-lane places: 0 best, equal points share one. */
  places() {
    return ranksByScore(this.scores());
  }
  /** The winning lane at results, −1 before or on a tie for first. */
  winner() {
    if (this.phase !== "results") return -1;
    const first = this.places().flatMap((place, lane) => (place === 0 ? [lane] : []));
    return first.length === 1 ? first[0] : -1;
  }
}
