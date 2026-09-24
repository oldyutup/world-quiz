import type { MovementInput } from "../../input/types";
import { IDLE_INPUT, PHYSICS } from "../physics";
import type { PlayerId } from "../players";
import {
  HEX,
  layerBelow,
  LAYER_TILES,
  tileAt,
  tileNeighbours,
  type LayerIndex,
  type LayerTile,
} from "../../../../shared/party-lab/maps/layers";
import { breakTicks } from "../../../../shared/party-lab/simulation/layers/config";
import type { LayerChaosGame } from "./game";

/** Seconds of one walked metre (RAGDOLL.speed 4.6 m/s), for "will this tile still be there". */
const SECONDS_PER_METRE = 1 / 4.6;
const PATH_STEP = 0.35;
/** A walking jump clears ~2.9 m from take-off to landing; only single missing tiles are attempted. */
const MAX_GAP = 2.1;
const JUMP_LEAD = 0.5;
const PUNCH_RANGE = 1.45;

interface Plan {
  tile: LayerTile;
  /** Where the line was planned from. */
  fromX: number;
  fromZ: number;
  /** Distance along the line to the first missing stretch (jump there), if any. */
  gapAt: number | null;
}

/**
 * Local Katman Kaosu test opponent: plain movement intent, no physics access beyond
 * reading positions and tile states (like the rooftop bots). Stands on a tile for a
 * random part of its break time, then walks to a neighbouring tile that is still
 * untouched and has the most untouched tiles around it, never along a line with a
 * hole in it — except a single missing tile, which it jumps. Steers toward a tile
 * below while falling, hops now and then, and punches an opponent right in front.
 */
export class LayerBot {
  readonly input: MovementInput = { x: 0, z: 0, jump: false };
  private plan: Plan | null = null;
  private replanIn = 0;
  private dwellFor = 0;
  private dwellOn = -1;
  private punchIn = 1;
  private hopIn = 3;
  private fightFor = 0;
  constructor(
    readonly id: PlayerId,
    private readonly random: () => number = Math.random
  ) {}
  reset() {
    this.plan = null;
    this.replanIn = this.fightFor = 0;
    this.dwellFor = 0;
    this.dwellOn = -1;
    this.punchIn = 1 + this.random();
    this.hopIn = 3 + this.random() * 3;
  }

  update(game: LayerChaosGame): MovementInput {
    const i = this.input,
      dt = PHYSICS.step,
      me = game.physics.players[this.id];
    i.x = i.z = 0;
    i.jump = i.punch = i.sprint = false;
    if (game.round.phase !== "playing" || !game.round.alive[this.id] || me.eliminated) return IDLE_INPUT;
    this.replanIn -= dt;
    this.punchIn -= dt;
    this.hopIn -= dt;
    this.fightFor = Math.max(0, this.fightFor - dt);
    const t = game.round.tick,
      p = me.body.translation(),
      layer = layerBelow(p.y - 0.3);
    if (layer === -1) return i;
    const intact = (tile: LayerTile) => game.field.intact(tile.id);
    const here = tileAt(layer, p.x, p.z);
    const standing = !!here && intact(here) && p.y - here.top < 1.3;
    if (!standing) {
      // Falling (or stepping off): steer toward the nearest tile still there below.
      const landing = this.nearest(layer, p.x, p.z, 3.2, (tile) => intact(tile) && this.timeLeft(game, tile, t) > 0.35);
      if (landing) this.steer(landing.x - p.x, landing.z - p.z, 1);
      return i;
    }
    // Opponents on this layer, nearest first.
    const rivals = game.physics.players
      .filter((o) => o.id !== this.id && game.round.alive[o.id] && !o.eliminated)
      .map((o) => ({ o, at: o.body.translation() }))
      .filter(({ at }) => Math.abs(at.y - p.y) < 1)
      .sort((a, b) => Math.hypot(a.at.x - p.x, a.at.z - p.z) - Math.hypot(b.at.x - p.x, b.at.z - p.z));
    const rival = rivals[0];
    const rivalDistance = rival ? Math.hypot(rival.at.x - p.x, rival.at.z - p.z) : Infinity;
    if (rival && rivalDistance < PUNCH_RANGE && this.punchIn <= 0) {
      const ahead = (Math.sin(me.facing) * (rival.at.x - p.x) + Math.cos(me.facing) * (rival.at.z - p.z)) / rivalDistance;
      if (ahead > 0.6) {
        i.punch = true;
        this.punchIn = 0.7 + this.random() * 0.9;
      }
    }
    if (this.fightFor <= 0 && rival && rivalDistance < 3 && this.random() < dt * 0.35) this.fightFor = 0.8 + this.random() * 0.8;
    if (this.fightFor > 0 && rival && game.field.stage(here.id, t) !== "break") {
      // Close in and face them (the body turns toward where it walks).
      this.steer(rival.at.x - p.x, rival.at.z - p.z, rivalDistance > 1.1 ? 1 : 0.35);
      return i;
    }
    // Wait a while on the tile just stepped on (it breaks anyway), then move on.
    if (this.dwellOn !== here.id) {
      this.dwellOn = here.id;
      this.dwellFor = (0.2 + this.random() * 0.4) * breakTicks(t) * dt;
    } else this.dwellFor -= dt;
    const urgent = game.field.stage(here.id, t) === "break" || game.field.stage(here.id, t) === "marked";
    const reached = this.plan && this.plan.tile.id === here.id && Math.hypot(here.x - p.x, here.z - p.z) < 0.5;
    if (reached) this.plan = null;
    if (!this.plan && this.dwellFor > 0 && !urgent) {
      // Hold the middle of the tile against the idle creep.
      this.steer(here.x - p.x, here.z - p.z, Math.min(0.14, Math.hypot(here.x - p.x, here.z - p.z)));
      return i;
    }
    const stale = this.plan && (!intact(this.plan.tile) || this.timeLeft(game, this.plan.tile, t) < 0.3);
    if (!this.plan || stale || this.replanIn <= 0) {
      this.plan = this.choose(game, here, p.x, p.z, t);
      this.replanIn = 0.3 + this.random() * 0.3;
    }
    const plan = this.plan;
    if (!plan) return i;
    const dx = plan.tile.x - p.x,
      dz = plan.tile.z - p.z,
      d = Math.hypot(dx, dz);
    this.steer(dx, dz, Math.min(1, d / 0.9));
    i.sprint = urgent || d > 2.6;
    if (plan.gapAt !== null) {
      // Jump just before the hole's edge.
      const walked = Math.hypot(p.x - plan.fromX, p.z - plan.fromZ);
      if (plan.gapAt - walked < JUMP_LEAD) i.jump = true;
    } else if (this.hopIn <= 0) {
      i.jump = true;
      this.hopIn = 3 + this.random() * 4;
    }
    return i;
  }

  private steer(dx: number, dz: number, magnitude: number) {
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) return;
    this.input.x = (dx / d) * magnitude;
    this.input.z = (dz / d) * magnitude;
  }
  private timeLeft(game: LayerChaosGame, tile: LayerTile, t: number) {
    if (!game.field.intact(tile.id)) return 0;
    const gone = game.field.goneTick[tile.id];
    return gone < 0 ? Infinity : (gone - t) * PHYSICS.step;
  }
  private nearest(layer: LayerIndex, x: number, z: number, within: number, ok: (tile: LayerTile) => boolean) {
    let best: LayerTile | null = null,
      bestD = within;
    for (const tile of LAYER_TILES) {
      if (tile.layer !== layer || !ok(tile)) continue;
      const d = Math.hypot(tile.x - x, tile.z - z);
      if (d < bestD) {
        best = tile;
        bestD = d;
      }
    }
    return best;
  }
  /** Untouched tiles reachable from a tile within three steps (a cheap "room to live" score). */
  private room(game: LayerChaosGame, start: LayerTile) {
    const seen = new Set([start.id]);
    let frontier = [start];
    for (let depth = 0; depth < 3; depth++) {
      const next: LayerTile[] = [];
      for (const tile of frontier)
        for (const n of tileNeighbours(tile))
          if (!seen.has(n.id) && game.field.intact(n.id) && game.field.armTick[n.id] < 0) {
            seen.add(n.id);
            next.push(n);
          }
      frontier = next;
    }
    return seen.size;
  }
  /**
   * Next tile: a neighbour (or a tile two steps away) that is intact on arrival, along
   * a line with no hole — or with a single missing tile to jump. Best room to live,
   * untouched, not marked for the collapse, nearer the middle; a little randomness.
   */
  private choose(game: LayerChaosGame, here: LayerTile, x: number, z: number, t: number): Plan | null {
    let best: { plan: Plan; score: number } | null = null;
    for (const tile of LAYER_TILES) {
      if (tile.layer !== here.layer || tile.id === here.id || !game.field.intact(tile.id)) continue;
      const span = Math.hypot(tile.x - here.x, tile.z - here.z);
      if (span > 2 * HEX.width + 0.1) continue;
      const route = this.route(game, here.layer, x, z, tile, t);
      if (!route) continue;
      const stage = game.field.stage(tile.id, t);
      const score =
        (stage === "solid" ? 20 : stage === "marked" ? -25 : -10) +
        this.room(game, tile) -
        0.4 * tile.ring -
        (route.gapAt !== null ? 6 : 0) -
        (span > HEX.width + 0.1 ? 2 : 0) +
        this.random() * 3;
      if (!best || score > best.score) best = { plan: { tile, fromX: x, fromZ: z, gapAt: route.gapAt }, score };
    }
    return best?.plan ?? null;
  }
  /** Walk the straight line to a tile: every point on an intact tile when we get there, or one short hole. */
  private route(game: LayerChaosGame, layer: LayerIndex, x: number, z: number, tile: LayerTile, t: number) {
    const dx = tile.x - x,
      dz = tile.z - z,
      length = Math.hypot(dx, dz);
    let gapStart: number | null = null,
      gapEnd: number | null = null;
    for (let s = PATH_STEP; s < length; s += PATH_STEP) {
      const under = tileAt(layer, x + (dx * s) / length, z + (dz * s) / length);
      const there = !!under && game.field.intact(under.id) && this.timeLeft(game, under, t) > s * SECONDS_PER_METRE + 0.15;
      if (there) {
        if (gapStart !== null && gapEnd === null) gapEnd = s;
        continue;
      }
      if (gapEnd !== null) return null; // A second hole: not this way.
      if (gapStart === null) gapStart = s;
    }
    if (gapStart !== null && (gapEnd ?? length) - gapStart > MAX_GAP) return null;
    if (gapStart !== null && gapEnd === null) return null; // The hole runs to the target.
    return { gapAt: gapStart };
  }
}
