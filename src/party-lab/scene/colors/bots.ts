import type { MovementInput } from "../../input/types";
import { IDLE_INPUT, PHYSICS } from "../physics";
import type { PlayerId } from "../players";
import { COLOR_NEIGHBOURS, COLOR_TILES, colorTileAt, type ColorTile } from "../../../../shared/party-lab/maps/colors";
import { shrinkStage, stageDepth } from "../../../../shared/party-lab/simulation/colors/shrink";
import type { ColorChaosGame } from "./game";

/** Walking speed (m/s) the bot plans with (RAGDOLL.speed); sprint when slower would be late. */
const WALK = 4.6;
const PUNCH_RANGE = 1.45;
/** How close to a tile's centre counts as "there" (m). */
const ARRIVED = 0.35;
/** A tap of the stick: enough to turn the body (the controller turns above 0.15), barely a step. */
const TAP = 0.18;

/**
 * Local Renk Kaosu test opponent: plain movement intent from what a player can see (tile
 * colours, the announced target, the timer, positions), same speed and rules as a human.
 *
 * - Reacts to each announcement after a human-like 0.18–0.5 s, then walks (sprinting when
 *   walking would be late) to the best tile of the target colour: nearest, found by a
 *   breadth-first search over neighbouring tiles, with penalties for the rim and for a
 *   tile someone else is heading to or standing on. About one cycle in eight it settles
 *   for a worse tile — its mistakes, which the faster timers punish.
 * - Holds the middle of its tile while the other colours are gone; between cycles it
 *   moves off the edge of the field toward the middle rings.
 * - Daralma: it searches and walks only over the tiles that are there, counts the marked
 *   (warned) and grey tiles as the edge, and waits on tiles the next cycle keeps. It knows
 *   the shrink from what is shown (the marks), never a future target colour. In the final
 *   drop it holds the last tile and jumps late, as a player could.
 * - Shoves a rival right in front of it sometimes, mostly near the deadline and while the
 *   floor is gone. Once it stands safe on its tile with a rival within reach, it taps
 *   toward them to turn and shove (the crowded small field of the shrink's end).
 * - Falling (a hole under it), steers for the nearest standing tile.
 */
export class ColorBot {
  readonly input: MovementInput = { x: 0, z: 0, jump: false };
  private cycle = -1;
  private delay = 0;
  private sloppy = false;
  /** The target-colour tile it runs to once it has reacted. */
  private goal: ColorTile | null = null;
  /** Where it waits before that (off the rim). */
  private home: ColorTile | null = null;
  private punchIn = 1;
  /** Depth of each tile inside the field the next cycle keeps (−1: marked or grey — going). */
  private depth: Int8Array = stageDepth(0, COLOR_NEIGHBOURS);
  private depthStage = 0;
  /** Final drop: when (seconds before it) to jump. */
  private jumpAt = 0;
  constructor(
    readonly id: PlayerId,
    private readonly random: () => number = Math.random
  ) {}
  reset() {
    this.cycle = -1;
    this.goal = this.home = null;
    this.depthStage = 0;
    this.depth = stageDepth(0, COLOR_NEIGHBOURS);
    this.punchIn = 0.8 + this.random();
  }

  update(game: ColorChaosGame): MovementInput {
    const i = this.input,
      dt = PHYSICS.step,
      me = game.physics.players[this.id];
    i.x = i.z = 0;
    i.jump = i.punch = i.sprint = false;
    if (game.round.phase !== "playing" || !game.round.alive[this.id] || me.eliminated) return IDLE_INPUT;
    const t = game.round.tick,
      schedule = game.schedule,
      cycle = schedule.cycle,
      phase = schedule.phase(t);
    if (cycle.index !== this.cycle) {
      this.cycle = cycle.index;
      this.goal = this.home = null;
      // A human-like read of "which colour, where is the nearest": 0.3–0.65 s, and now and
      // then a slow one (0.6–1.25 s) — the faster timers turn those into falls.
      this.delay = 0.3 + this.random() * 0.35 + (this.random() < 0.15 ? 0.3 + this.random() * 0.3 : 0);
      this.sloppy = this.random() < 0.12;
      // The field the marks say the next cycle keeps (what a player sees, nothing more).
      const next = cycle.final ? cycle.stage : shrinkStage(cycle.index + 1);
      if (next !== this.depthStage) {
        this.depthStage = next;
        this.depth = stageDepth(next, COLOR_NEIGHBOURS);
      }
      this.jumpAt = cycle.final ? 0.05 + this.random() * 0.25 : 0;
    }
    this.punchIn -= dt;
    const p = me.body.translation(),
      here = colorTileAt(p.x, p.z);
    if (!here || !game.field.intact(here.id) || p.y < 0.2) {
      // Over a hole: the nearest standing tile, if one is close enough to catch.
      const rescue = this.nearest(game, p.x, p.z, 2.4, () => true);
      if (rescue) this.steer(rescue.x - p.x, rescue.z - p.z, 1);
      return i;
    }
    const rivals = game.physics.players
      .filter((o) => o.id !== this.id && game.round.alive[o.id] && !o.eliminated)
      .map((o) => ({ id: o.id, at: o.body.translation() }));
    if (phase === "run" && this.delay > 0) this.delay -= dt;
    const reacting = phase === "run" && this.delay <= 0 && !cycle.final;
    if (reacting) this.goal ??= this.choose(game, here, p.x, p.z, rivals);
    // Before reacting: off the edge (and off marked tiles), then stand still.
    else if (!this.home || this.depth[this.home.id] < this.wanted()) this.home = this.inward(game, here);
    const goal = (reacting ? this.goal : this.home) ?? here,
      // Straight at it if the way there is all floor, else to the next tile on the path.
      via = this.waypoint(game, here, goal, p.x, p.z),
      dx = via.x - p.x,
      dz = via.z - p.z,
      d = Math.hypot(goal.x - p.x, goal.z - p.z);
    // Safe on a tile that stays (the target colour, or anything with the floor gone) with a
    // rival close by: turn to them with a tap, as a player would, to shove them off.
    const safe = cycle.colors[here.id] === cycle.target && (phase === "unsafe" || (reacting && d <= ARRIVED));
    const rival = safe && Math.hypot(here.x - p.x, here.z - p.z) < 0.6 ? this.closest(rivals, p.x, p.z, PUNCH_RANGE) : null;
    if (rival) this.steer(rival.at.x - p.x, rival.at.z - p.z, TAP);
    else if (phase === "unsafe") {
      // The floor is gone around: hold the middle of this tile.
      this.steer(here.x - p.x, here.z - p.z, Math.min(0.2, Math.hypot(here.x - p.x, here.z - p.z)));
    } else if (d > ARRIVED) {
      this.steer(dx, dz, via === goal ? Math.min(1, d / 0.6) : 1);
      const left = schedule.timeLeft(t);
      i.sprint = reacting && d > 1 && d / Math.max(0.05, left - 0.2) > WALK * 0.8;
    } else this.steer(dx, dz, Math.min(0.15, d));
    // The final drop: nothing to run to — jump late, to fall last.
    if (cycle.final && phase === "run" && this.jumpAt > 0 && schedule.timeLeft(t) <= this.jumpAt) {
      i.jump = true;
      this.jumpAt = 0;
    }
    // Shove a rival standing right in front, mostly near the deadline or with the floor gone.
    const late = phase === "unsafe" || (phase === "run" && schedule.timeLeft(t) < 0.8);
    if (this.punchIn <= 0) {
      for (const r of rivals) {
        const rx = r.at.x - p.x,
          rz = r.at.z - p.z,
          rd = Math.hypot(rx, rz);
        if (rd > PUNCH_RANGE || rd < 1e-3) continue;
        const ahead = (Math.sin(me.facing) * rx + Math.cos(me.facing) * rz) / rd;
        if (ahead > 0.6 && this.random() < (late || rival ? 0.5 : 0.15)) {
          i.punch = true;
          break;
        }
      }
      this.punchIn = i.punch ? 0.7 + this.random() * 0.8 : 0.15;
    }
    return i;
  }

  /**
   * Where to steer for `goal`: the goal itself when the straight way there (body-wide) is
   * over tiles that are there, else the next tile on the shortest path of present tiles
   * (on the last fields, around a removed tile instead of across its gap).
   */
  private waypoint(game: ColorChaosGame, here: ColorTile, goal: ColorTile, x: number, z: number): ColorTile {
    if (goal === here || this.clear(game, x, z, goal.x, goal.z)) return goal;
    const present = game.schedule.cycle.present,
      parent = new Int16Array(COLOR_TILES.length).fill(-1),
      queue = [goal.id];
    parent[goal.id] = goal.id;
    // Breadth-first from the goal, so the first step from `here` can be read off directly.
    for (let k = 0; k < queue.length && parent[here.id] < 0; k++)
      for (const n of COLOR_NEIGHBOURS[queue[k]])
        if (parent[n] < 0 && present[n]) {
          parent[n] = queue[k];
          queue.push(n);
        }
    return parent[here.id] >= 0 ? COLOR_TILES[parent[here.id]] : goal;
  }
  /** Whether a body walking from (x0, z0) to (x1, z1) stays over present tiles (centre line and ±0.25 m to the sides). */
  private clear(game: ColorChaosGame, x0: number, z0: number, x1: number, z1: number) {
    const present = game.schedule.cycle.present,
      length = Math.hypot(x1 - x0, z1 - z0),
      steps = Math.ceil(length / 0.3);
    if (!steps) return true;
    const sideX = (-(z1 - z0) / length) * 0.25,
      sideZ = ((x1 - x0) / length) * 0.25;
    for (let k = 1; k <= steps; k++) {
      const x = x0 + ((x1 - x0) * k) / steps,
        z = z0 + ((z1 - z0) * k) / steps;
      for (const side of [-1, 0, 1]) {
        const tile = colorTileAt(x + side * sideX, z + side * sideZ);
        if (!tile || !present[tile.id]) return false;
      }
    }
    return true;
  }
  private closest(rivals: { at: { x: number; z: number } }[], x: number, z: number, within: number) {
    let best: (typeof rivals)[number] | null = null,
      bestD = within;
    for (const r of rivals) {
      const d = Math.hypot(r.at.x - x, r.at.z - z);
      if (d < bestD) {
        best = r;
        bestD = d;
      }
    }
    return best;
  }
  private steer(dx: number, dz: number, magnitude: number) {
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) return;
    this.input.x = (dx / d) * magnitude;
    this.input.z = (dz / d) * magnitude;
  }
  private nearest(game: ColorChaosGame, x: number, z: number, within: number, ok: (tile: ColorTile) => boolean) {
    let best: ColorTile | null = null,
      bestD = within;
    for (const tile of COLOR_TILES) {
      if (!game.field.intact(tile.id) || !ok(tile)) continue;
      const d = Math.hypot(tile.x - x, tile.z - z);
      if (d < bestD) {
        best = tile;
        bestD = d;
      }
    }
    return best;
  }
  /** How deep inside the next field a waiting spot should be (2, or as deep as that field goes). */
  private wanted() {
    let deepest = -1;
    for (const d of this.depth) if (d > deepest) deepest = d;
    return Math.min(2, deepest);
  }
  /**
   * Where to wait: this tile if it is deep enough inside the field the next cycle keeps,
   * else the nearest one that is (breadth-first over the tiles that are there, a random
   * one of the nearest).
   */
  private inward(game: ColorChaosGame, here: ColorTile) {
    const want = this.wanted();
    if (this.depth[here.id] >= want) return here;
    const present = game.schedule.cycle.present,
      seen = new Uint8Array(COLOR_TILES.length),
      layer = [here.id];
    seen[here.id] = 1;
    while (layer.length) {
      const next: number[] = [];
      for (const id of layer)
        for (const n of COLOR_NEIGHBOURS[id])
          if (!seen[n] && present[n]) {
            seen[n] = 1;
            next.push(n);
          }
      const good = next.filter((id) => this.depth[id] >= want);
      if (good.length) return COLOR_TILES[good[Math.floor(this.random() * good.length)]];
      layer.splice(0, layer.length, ...next);
    }
    return here;
  }
  /**
   * Tiles of the target colour by breadth-first search from the own tile over the tiles
   * that are there (steps across neighbours: every one of them stands during the run),
   * scored by metres to walk plus edge and crowd penalties (a marked tile counts as the
   * edge: it goes grey next cycle). Sloppy: the second or third best.
   */
  private choose(game: ColorChaosGame, here: ColorTile, x: number, z: number, rivals: { id: number; at: { x: number; z: number } }[]) {
    const { colors, target } = game.schedule.cycle,
      seen = new Uint8Array(COLOR_TILES.length),
      queue = [here.id],
      found: { tile: ColorTile; score: number }[] = [];
    seen[here.id] = 1;
    const present = game.schedule.cycle.present;
    for (let k = 0; k < queue.length && found.length < 8; k++) {
      const tile = COLOR_TILES[queue[k]];
      if (colors[tile.id] === target) {
        const crowd = rivals.filter((r) => Math.hypot(r.at.x - tile.x, r.at.z - tile.z) < 1.3).length;
        const depth = this.depth[tile.id],
          rim = depth === 0 ? 1.2 : depth === 1 ? 0.4 : depth < 0 ? 1.5 : 0;
        found.push({ tile, score: Math.hypot(tile.x - x, tile.z - z) + rim + 1.5 * crowd + this.random() * 0.4 });
      }
      for (const n of COLOR_NEIGHBOURS[tile.id])
        if (!seen[n] && present[n]) {
          seen[n] = 1;
          queue.push(n);
        }
    }
    found.sort((a, b) => a.score - b.score);
    if (!found.length) return null;
    return (this.sloppy ? found[Math.min(found.length - 1, 1 + Math.floor(this.random() * 2))] : found[0]).tile;
  }
}
