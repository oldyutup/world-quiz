import { BOMBER as B, ticks } from "./config.js";
import { BOX, CELLS, FLOOR, PILLAR, SECTORS, VOID, cellAt, cellCenter, cellIndex, neighbour, neighbours, sharedSide } from "./arena.js";
import { collapseFallAt, type BomberBomb, type BomberGame, type BomberInput } from "./game.js";

export const BOMBER_BOT_LEVELS = ["easy", "medium", "hard"] as const;
export type BomberBotLevel = (typeof BOMBER_BOT_LEVELS)[number];
export const BOMBER_BOT_NAMES: Readonly<Record<BomberBotLevel, string>> = { easy: "Kolay", medium: "Orta", hard: "Zor" };

interface Tuning {
  /** Steps between decisions. */
  think: number;
  /** Steps before another player's new bomb is noticed (own bombs are known at once). */
  react: number;
  /** Chance a bomb goes down without checking for a way out. */
  careless: number;
  /** Chance a decision hunts players rather than boxes. */
  hunt: number;
  /** Walking speed (input length). */
  speed: number;
  /** Steps of slack wanted between leaving a cell and its flames. */
  pad: number;
  /** Sees whether a bomb would shut a player in (no way out for them): bombs it at once. */
  traps: boolean;
}
const TUNING: Readonly<Record<BomberBotLevel, Tuning>> = {
  easy: { think: 20, react: 24, careless: 0.3, hunt: 0.2, speed: 0.82, pad: 2, traps: false },
  medium: { think: 10, react: 10, careless: 0, hunt: 0.6, speed: 1, pad: 8, traps: true },
  hard: { think: 4, react: 3, careless: 0, hunt: 0.9, speed: 1, pad: 8, traps: true },
};

const FUSE = ticks(B.fuse),
  FLAME = ticks(B.flame),
  /** A cell that does not burn within this many steps counts as safe. */
  HORIZON = FUSE + FLAME + 60;

/** When each cell burns, in steps from now: [from, to), from = Infinity never (within the horizon). */
interface Danger {
  from: Float64Array;
  to: Float64Array;
}
/** Cells a bomb on `cell` would burn (itself first), the boxes it would break, the bombs it would set off. */
export function blastFrom(game: BomberGame, cell: number) {
  const cells = [cell],
    boxes: number[] = [],
    bombs: BomberBomb[] = [];
  for (let direction = 0; direction < 4; direction++) {
    let c = cell;
    for (let k = 1; k <= B.range; k++) {
      c = neighbour(c, direction);
      if (c < 0) break;
      const kind = game.cells[c];
      if (kind === PILLAR || kind === VOID) break;
      if (kind === BOX) {
        if (!game.burn[c]) boxes.push(c);
        break;
      }
      cells.push(c);
      const bomb = game.bombAt(c);
      if (bomb) {
        bombs.push(bomb);
        break;
      }
    }
  }
  return { cells, boxes, bombs };
}

/**
 * The danger map a bot of `lane` believes in: every bomb it has noticed (others' after `react`
 * steps) blows at its fuse or when an earlier blast reaches it; flames now burning; rings
 * about to fall. `extra`: a bomb of its own it is thinking of putting down there.
 */
function dangerMap(game: BomberGame, lane: number, react: number, extra = -1): Danger {
  const from = new Float64Array(CELLS).fill(Infinity),
    to = new Float64Array(CELLS).fill(-Infinity);
  const seen = game.bombs.filter((b) => b.owner === lane || FUSE - b.fuse >= react);
  const list: { cell: number; time: number; blast: number[] }[] = seen.map((b) => ({ cell: b.cell, time: b.fuse, blast: blastFrom(game, b.cell).cells }));
  if (extra >= 0 && !game.bombAt(extra)) {
    // The would-be bomb blocks like one: blasts stop on it and set it off.
    const fake: BomberBomb = { id: -1, owner: lane, cell: extra, fuse: FUSE, pass: 0 };
    game.bombs.push(fake);
    try {
      for (const item of list) item.blast = blastFrom(game, item.cell).cells;
      list.push({ cell: extra, time: FUSE, blast: blastFrom(game, extra).cells });
    } finally {
      game.bombs.pop();
    }
  }
  // Chains: a bomb in an earlier blast goes off with it.
  for (let changed = true, guard = 0; changed && guard < 16; guard++) {
    changed = false;
    for (const a of list)
      for (const b of list)
        if (b !== a && b.time > a.time && a.blast.includes(b.cell)) {
          b.time = a.time;
          changed = true;
        }
  }
  for (const { time, blast } of list)
    for (const c of blast) {
      from[c] = Math.min(from[c], time);
      to[c] = Math.max(to[c], time + FLAME);
    }
  for (let c = 0; c < CELLS; c++)
    if (game.fire[c]) {
      from[c] = Math.min(from[c], 0);
      to[c] = Math.max(to[c], game.fire[c]);
    }
  (B.collapse.rings as readonly number[]).forEach((ring, k) => {
    const left = collapseFallAt(k) - game.ticks;
    if (left > 0 && left < HORIZON + 120)
      for (let s = 0; s < SECTORS; s++) {
        const c = cellIndex(ring, s);
        from[c] = Math.min(from[c], left - 45);
        to[c] = Infinity;
      }
  });
  return { from, to };
}

const centreDistance = (a: number, b: number) => {
  const p = cellCenter(a),
    q = cellCenter(b);
  return Math.hypot(p.x - q.x, p.z - q.z);
};

interface Route {
  cells: number[];
  /** When to leave each cell (steps from now; the last never): later than "at once" to let flames ahead go out. */
  departs: number[];
  /** Arrival at the last cell, steps from now. */
  time: number;
}

/**
 * A bot of the Yerel Test Arenası (and the server tests' games). It reads the game, never
 * changes it: every step it hands back an input like a player's (a walk direction and its
 * bomb presses). It runs from flames it knows about to a cell no blast reaches in time, puts
 * bombs down where they break boxes or catch players when it can still get away, and walks
 * to the next such spot. Kolay notices others' bombs late, walks slower and sometimes bombs
 * without checking its way out; Zor sees when a bomb would shut a player in.
 */
export class BomberBot {
  private readonly tune: Tuning;
  private presses = 0;
  private route: number[] = [];
  private departs: number[] = [];
  /** The step the route was planned at. */
  private planned = 0;
  /** Walking to the middle of the last cell before thinking again. */
  private wait = 0;
  private stuck = 0;
  private last = { x: 0, z: 0 };
  /** Bombed: run before anything else. */
  private fleeing = false;
  /** Steps to stand still (the bomb goes down where the bot decided). */
  private hold = 0;
  constructor(readonly level: BomberBotLevel, readonly lane: number, private readonly random: () => number = Math.random) {
    this.tune = TUNING[level];
    this.wait = Math.floor(random() * this.tune.think);
  }
  /** This step's input (from the game as it is before the step). */
  input(game: BomberGame): BomberInput {
    const me = game.players[this.lane];
    if (game.phase !== "playing" || !me.alive || me.out) {
      this.route = [];
      this.fleeing = false;
      return { x: 0, z: 0, bombs: this.presses };
    }
    const here = cellAt(me.x, me.z);
    const moved = Math.hypot(me.x - this.last.x, me.z - this.last.z);
    this.last = { x: me.x, z: me.z };
    this.stuck = this.route.length && moved < 0.004 ? this.stuck + 1 : 0;
    if (--this.wait <= 0 || this.stuck > 20) {
      this.wait = this.tune.think;
      this.stuck = 0;
      this.decide(game, here);
    }
    return { ...this.steer(game, here), bombs: this.presses };
  }

  private decide(game: BomberGame, here: number) {
    if (here < 0) return;
    const danger = dangerMap(game, this.lane, this.tune.react);
    if (danger.from[here] <= HORIZON) {
      // Already running somewhere still safe: keep going (a fresh plan from mid-run reads tighter).
      const end = this.route[this.route.length - 1];
      if (this.fleeing && this.route.length > 1 && this.route.includes(here) && danger.from[end] > HORIZON && this.clear(game, danger)) return;
      this.flee(game, here, danger);
      return;
    }
    this.fleeing = false;
    const mine = game.bombs.filter((b) => b.owner === this.lane).length;
    if (mine < B.maxBombs && !game.bombAt(here)) {
      const value = this.bombValue(game, here, true);
      if (value > 0 && this.mayBomb(game, here)) {
        this.presses++;
        this.hold = 1;
        // Run from the next step: the bomb goes down in this one, where the bot stands.
        const after = dangerMap(game, this.lane, this.tune.react, here);
        this.flee(game, here, after);
        return;
      }
    }
    this.follow(game, this.target(game, here, danger) ?? this.wander(game, here, danger));
  }
  private follow(game: BomberGame, route: Route | null) {
    this.route = route ? route.cells : [];
    this.departs = route ? route.departs : [];
    this.planned = game.ticks;
  }
  /** The rest of the route still crosses no cell while it burns (by the planned times). */
  private clear(game: BomberGame, danger: Danger) {
    const now = game.ticks - this.planned;
    return this.route.every((cell, i) => {
      if (i === 0) return true;
      const enter = this.departs[i - 1] - now;
      return enter >= danger.to[cell] + this.tune.pad - 30 || enter + 30 <= danger.from[cell] - this.tune.pad || danger.from[cell] === Infinity;
    });
  }
  /** Bombing here leaves a way out (or the bot does not look). */
  private mayBomb(game: BomberGame, here: number) {
    if (this.random() < this.tune.careless) return true;
    const after = dangerMap(game, this.lane, this.tune.react, here);
    // Two ways out, unless the bot is careless: one bomb from someone else can shut one.
    const outs = new Set<number>();
    this.explore(game, here, after, this.lane, (cell, route) => {
      if (after.from[cell] > HORIZON && route.cells.length > 1) outs.add(route.cells[1]);
    });
    return outs.size >= (this.level === "easy" ? 1 : 2) || (outs.size === 1 && this.random() < 0.15);
  }
  /** What a bomb on `cell` would do: boxes broken, players caught (shut-in players most). */
  private bombValue(game: BomberGame, cell: number, now: boolean) {
    const blast = blastFrom(game, cell);
    let value = blast.boxes.length;
    game.players.forEach((p, lane) => {
      if (lane === this.lane || !p.alive || p.out || p.shield > FUSE) return;
      const at = cellAt(p.x, p.z);
      if (!blast.cells.includes(at)) return;
      value += 2;
      if (this.tune.traps && now && !this.canEscape(game, lane, at, cell)) value += 10;
    });
    return value;
  }
  /** Could `lane` (at `from`) still get clear of a bomb put on `bomb`? */
  private canEscape(game: BomberGame, lane: number, from: number, bomb: number) {
    const after = dangerMap(game, lane, 0, bomb);
    return !!this.search(game, from, after, (c) => after.from[c] > HORIZON, lane);
  }
  private flee(game: BomberGame, here: number, danger: Danger) {
    this.fleeing = true;
    const route = this.search(game, here, danger, (c) => danger.from[c] > HORIZON, this.lane, this.level === "easy");
    if (route) {
      this.follow(game, route);
      return;
    }
    // No safe cell in reach (the last ring, crowded): the one that burns last.
    let best: Route | null = null,
      latest = -Infinity;
    this.explore(game, here, danger, this.lane, (cell, r) => {
      const burns = danger.from[cell] - (cell === here ? 1 : 0);
      if (burns > latest) {
        latest = burns;
        best = r;
      }
    });
    this.follow(game, best);
  }
  /** The best place to bomb next (boxes, or players when hunting), reached without burning. */
  private target(game: BomberGame, here: number, danger: Danger) {
    // Few boxes left: players are what is left to bomb.
    let boxes = 0;
    for (let c = 0; c < CELLS; c++) if (game.cells[c] === BOX && !game.burn[c]) boxes++;
    const hunting = this.random() < (boxes < 12 ? Math.max(this.tune.hunt, 0.8) : this.tune.hunt);
    let best: Route | null = null,
      bestScore = 0;
    this.explore(game, here, danger, this.lane, (cell, route) => {
      if (danger.from[cell] <= HORIZON || game.bombAt(cell)) return;
      const blast = blastFrom(game, cell);
      let value = blast.boxes.length;
      if (hunting)
        game.players.forEach((p, lane) => {
          if (lane !== this.lane && p.alive && !p.out && blast.cells.includes(cellAt(p.x, p.z))) value += 3;
        });
      const score = value / (1 + route.time / 60);
      if (value > 0 && score > bestScore) {
        bestScore = score;
        best = route;
      }
    });
    if (best || !hunting) return best;
    // Hunting with nothing in reach: walk towards the nearest player.
    const players = game.players.filter((p, lane) => lane !== this.lane && p.alive && !p.out).map((p) => cellAt(p.x, p.z));
    let toward: Route | null = null,
      far = Infinity;
    this.explore(game, here, danger, this.lane, (cell, route) => {
      for (const at of players) {
        const d = centreDistance(cell, at);
        if (d < far && danger.from[cell] > HORIZON) {
          far = d;
          toward = route;
        }
      }
    });
    return toward;
  }
  /** Somewhere safe nearby, so the bot never just stands about. */
  private wander(game: BomberGame, here: number, danger: Danger) {
    const options: Route[] = [];
    this.explore(game, here, danger, this.lane, (cell, route) => {
      if (route.cells.length > 1 && route.cells.length <= 6 && danger.from[cell] > HORIZON) options.push(route);
    });
    return options.length ? options[Math.floor(this.random() * options.length)] : null;
  }

  /** Cells `lane` may walk on: free floor, or a bomb it is still standing on. */
  private open(game: BomberGame, cell: number, lane: number, start: number) {
    if (cell < 0 || game.cells[cell] !== FLOOR) return false;
    const bomb = game.bombAt(cell);
    return !bomb || cell === start || !!(bomb.pass & (1 << lane));
  }
  /**
   * Every cell reachable without walking into flames, with its quickest route (arrival times
   * from cell-to-cell distances at the bot's speed).
   */
  private explore(game: BomberGame, start: number, danger: Danger, lane: number, visit: (cell: number, route: Route) => void) {
    const origin = game.players[lane];
    const speed = (B.speed * this.tune.speed) / B.hz,
      time = new Float64Array(CELLS).fill(Infinity),
      previous = new Int32Array(CELLS).fill(-1),
      leaveFor = new Float64Array(CELLS),
      done = new Uint8Array(CELLS);
    time[start] = 0;
    for (;;) {
      let cell = -1;
      for (let c = 0; c < CELLS; c++) if (!done[c] && time[c] < Infinity && (cell < 0 || time[c] < time[cell])) cell = c;
      if (cell < 0) break;
      done[cell] = 1;
      const route: number[] = [],
        departs: number[] = [];
      for (let c = cell; c >= 0; c = previous[c]) {
        route.unshift(c);
        departs.unshift(c === cell ? Infinity : leaveFor[route[1]]);
      }
      visit(cell, { cells: route, departs, time: time[cell] });
      for (const next of neighbours(cell)) {
        if (done[next] || !this.open(game, next, lane, start)) continue;
        const centre = cellCenter(next),
          step = (cell === start ? Math.hypot(centre.x - origin.x, centre.z - origin.z) : centreDistance(cell, next)) / speed,
          pad = this.tune.pad;
        let depart = time[cell];
        // In the next cell from crossing the shared side until well past its middle; never
        // while it burns (with slack either side). Flames that go out soon: wait for them here.
        const enter = () => depart + step * 0.45,
          leave = () => depart + step + 0.6 / speed;
        if (enter() < danger.to[next] + pad && leave() > danger.from[next] - pad) {
          depart = danger.to[next] + pad - step * 0.45;
          if (!(depart < Infinity) || depart > time[cell] + 90) continue;
          // Waiting here must be safe too.
          if (cell !== start && depart + step * 0.45 > danger.from[cell] - pad && time[cell] < danger.to[cell] + pad) continue;
          if (cell === start && depart > danger.from[cell] - pad) continue;
        }
        const arrive = depart + step;
        if (arrive < time[next]) {
          time[next] = arrive;
          previous[next] = cell;
          leaveFor[next] = depart;
        }
      }
    }
  }
  /** The quickest route to a cell `goal` accepts; `loose`: one of the nearer few at random. */
  private search(game: BomberGame, start: number, danger: Danger, goal: (cell: number) => boolean, lane = this.lane, loose = false): Route | null {
    const found: Route[] = [];
    this.explore(game, start, danger, lane, (cell, route) => {
      if (found.length < 3 && goal(cell)) found.push(route);
    });
    if (!found.length) return null;
    return loose ? found[Math.floor(this.random() * found.length)] : found[0];
  }

  /** The walk towards the route's next cell: through the middle of the side it shares with this one. */
  private steer(game: BomberGame, here: number) {
    const me = game.players[this.lane];
    const at = this.route.lastIndexOf(here);
    if (at > 0) {
      this.route = this.route.slice(at);
      this.departs = this.departs.slice(at);
    }
    if (!this.route.length || this.hold > 0) {
      this.hold--;
      return { x: 0, z: 0 };
    }
    let goal: { x: number; z: number };
    const early = this.route[0] === here && this.route.length > 1 && game.ticks - this.planned < this.departs[0] - 1;
    if (early) {
      // Flames ahead: wait in the middle of this cell.
      goal = cellCenter(here);
      if (Math.hypot(goal.x - me.x, goal.z - me.z) < 0.08) return { x: 0, z: 0 };
    } else if (this.route[0] === here && this.route.length > 1) {
      // Aim a little past the middle of the shared side, so the bot walks through it.
      const gate = sharedSide(here, this.route[1]),
        beyond = cellCenter(this.route[1]);
      goal = { x: gate.x + (beyond.x - gate.x) * 0.35, z: gate.z + (beyond.z - gate.z) * 0.35 };
    } else if (this.route[0] === here) {
      goal = cellCenter(here);
      if (Math.hypot(goal.x - me.x, goal.z - me.z) < 0.08) {
        this.route = [];
        return { x: 0, z: 0 };
      }
    } else if (here >= 0 && neighbours(here).includes(this.route[0])) {
      const gate = sharedSide(here, this.route[0]),
        beyond = cellCenter(this.route[0]);
      goal = { x: gate.x + (beyond.x - gate.x) * 0.35, z: gate.z + (beyond.z - gate.z) * 0.35 };
    } else goal = cellCenter(this.route[0]);
    const dx = goal.x - me.x,
      dz = goal.z - me.z,
      d = Math.hypot(dx, dz);
    if (d < 1e-6) return { x: 0, z: 0 };
    const speed = this.tune.speed * Math.min(1, d / 0.08);
    return { x: (dx / d) * speed, z: (dz / d) * speed };
  }
}
