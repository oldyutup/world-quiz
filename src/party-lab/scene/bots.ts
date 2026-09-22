import type { MovementInput } from "../input/types";
import type { PlayerId } from "./players";
import type { Consciousness } from "./combat/knockout";
import { BOT_COMBAT } from "./combatConfig";
import type { ArenaMap, LethalEdge, Vec2 } from "../../../shared/party-lab/maps";
export interface BotObservation {
  id: PlayerId;
  x: number;
  z: number;
  alive: boolean;
  grounded: boolean;
  state: Consciousness;
  cooldowns: readonly number[];
  grips: readonly (PlayerId | null)[];
  grabbedBy: PlayerId | null;
}
/** Axis-aligned footprint of a static obstacle, with its top height. */
export interface BotObstacle {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  top: number;
}
/** What a bot knows about the map: lethal edges, obstacle footprints, a safe home and a wander box. */
export interface BotArena {
  lethalEdges: readonly LethalEdge[];
  obstacles: readonly BotObstacle[];
  home: Vec2;
  wander: ArenaMap["bot"]["wander"];
}
const EDGE_MARGIN = 0.85;
const OBSTACLE_PADDING = 0.45;
const LOOKAHEAD = 1.4;
const BLOCKING = new Set(["parapet", "building", "deck", "condenser", "bumper"]);

export function botArena(map: ArenaMap): BotArena {
  const obstacles: BotObstacle[] = [];
  for (const c of map.colliders) {
    if (!BLOCKING.has(c.role)) continue;
    const hx = c.shape === "cylinder" ? c.radius : c.half.x,
      hz = c.shape === "cylinder" ? c.radius : c.half.z,
      hy = c.shape === "cylinder" ? c.halfHeight : c.half.y;
    obstacles.push({
      minX: c.center.x - hx,
      maxX: c.center.x + hx,
      minZ: c.center.z - hz,
      maxZ: c.center.z + hz,
      top: c.center.y + hy,
    });
  }
  return { lethalEdges: map.lethalEdges, obstacles, home: map.bot.home, wander: map.bot.wander };
}

/** Distance to the closest lethal edge segment and that edge. */
export function nearestLethalEdge(arena: BotArena, x: number, z: number) {
  let best: { edge: LethalEdge; distance: number } | null = null;
  for (const edge of arena.lethalEdges) {
    const dx = edge.to.x - edge.from.x,
      dz = edge.to.z - edge.from.z;
    const t = Math.max(0, Math.min(1, ((x - edge.from.x) * dx + (z - edge.from.z) * dz) / (dx * dx + dz * dz)));
    const distance = Math.hypot(x - (edge.from.x + t * dx), z - (edge.from.z + t * dz));
    if (!best || distance < best.distance) best = { edge, distance };
  }
  return best;
}

const inside = (o: BotObstacle, x: number, z: number, pad: number) =>
  x > o.minX - pad && x < o.maxX + pad && z > o.minZ - pad && z < o.maxZ + pad;

/** First padded obstacle face along the ray, if any, within the lookahead. */
function obstacleAhead(arena: BotArena, x: number, z: number, dx: number, dz: number, skip?: BotObstacle) {
  let best: { t: number; nx: number; nz: number } | null = null;
  for (const o of arena.obstacles) {
    // Standing on it (pushed or carried up): its edges are handled as floor, not a wall.
    if (o === skip || inside(o, x, z, 0)) continue;
    const x0 = o.minX - OBSTACLE_PADDING,
      x1 = o.maxX + OBSTACLE_PADDING,
      z0 = o.minZ - OBSTACLE_PADDING,
      z1 = o.maxZ + OBSTACLE_PADDING;
    if (x > x0 && x < x1 && z > z0 && z < z1) {
      // Inside the padding: leave through the nearest face.
      const faces = [
        { d: x - x0, nx: -1, nz: 0 },
        { d: x1 - x, nx: 1, nz: 0 },
        { d: z - z0, nx: 0, nz: -1 },
        { d: z1 - z, nx: 0, nz: 1 },
      ].sort((a, b) => a.d - b.d)[0];
      return { t: 0, nx: faces.nx, nz: faces.nz };
    }
    let tNear = -Infinity,
      tFar = Infinity,
      nx = 0,
      nz = 0;
    for (const [origin, dir, lo, hi, ax] of [
      [x, dx, x0, x1, "x"],
      [z, dz, z0, z1, "z"],
    ] as const) {
      if (Math.abs(dir) < 1e-9) {
        if (origin <= lo || origin >= hi) tNear = Infinity;
        continue;
      }
      const a = (lo - origin) / dir,
        b = (hi - origin) / dir;
      const enter = Math.min(a, b);
      if (enter > tNear) {
        tNear = enter;
        nx = ax === "x" ? -Math.sign(dir) : 0;
        nz = ax === "z" ? -Math.sign(dir) : 0;
      }
      tFar = Math.min(tFar, Math.max(a, b));
    }
    if (tNear <= tFar && tNear >= 0 && tNear <= LOOKAHEAD && (!best || tNear < best.t)) best = { t: tNear, nx, nz };
  }
  return best;
}

/** Slide along an obstacle instead of walking into it. No pathfinding. */
export function steerAround(arena: BotArena, x: number, z: number, vx: number, vz: number, skip?: BotObstacle) {
  const length = Math.hypot(vx, vz);
  if (length < 1e-6) return { x: vx, z: vz };
  const dx = vx / length,
    dz = vz / length;
  const hit = obstacleAhead(arena, x, z, dx, dz, skip);
  if (!hit) return { x: vx, z: vz };
  let tx = -hit.nz,
    tz = hit.nx;
  if (tx * dx + tz * dz < 0) {
    tx = -tx;
    tz = -tz;
  }
  const push = hit.t === 0 ? 0.6 : 0.25;
  return { x: (tx + hit.nx * push) * length, z: (tz + hit.nz * push) * length };
}

/** Removable input producer. No body writes or privileged force/hit/escape paths. */
export class LocalBot {
  readonly input: MovementInput = { x: 0, z: 0, jump: false };
  private decisionIn = 0;
  private actionIn = 1;
  private jumpIn = 2;
  private targetX = 0;
  private targetZ = 0;
  private holdFor = 0;
  private holdAge = 0;
  private firstHand = 0;
  private reactionIn = 0;
  private previousGrabber: PlayerId | null = null;
  constructor(
    readonly id: 1 | 2,
    private readonly random: () => number = Math.random
  ) {}
  reset() {
    this.decisionIn = 0;
    this.actionIn = 1;
    this.jumpIn = 2;
    this.holdFor = this.holdAge = this.reactionIn = 0;
    this.previousGrabber = null;
    Object.assign(this.input, {
      x: 0,
      z: 0,
      jump: false,
      left: false,
      right: false,
      punchLeft: false,
      punchRight: false,
      lift: false,
    });
  }
  update(
    dt: number,
    players: readonly BotObservation[],
    arena: BotArena
  ): MovementInput {
    const me = players[this.id],
      i = this.input;
    Object.assign(i, {
      jump: false,
      punchLeft: false,
      punchRight: false,
      left: false,
      right: false,
      lift: false,
    });
    if (!me.alive || me.state === "KNOCKED_OUT") {
      i.x = i.z = 0;
      this.holdFor = 0;
      return i;
    }
    this.actionIn -= dt;
    this.decisionIn -= dt;
    this.jumpIn -= dt;
    this.holdFor = Math.max(0, this.holdFor - dt);
    const opponents = players.filter((p) => p.id !== this.id && p.alive);
    const nearest = opponents.reduce<BotObservation | undefined>(
      (best, p) =>
        !best ||
        Math.hypot(p.x - me.x, p.z - me.z) <
          Math.hypot(best.x - me.x, best.z - me.z)
          ? p
          : best,
      undefined
    );
    if (this.decisionIn <= 0) {
      this.decisionIn = 0.65 + this.random() * 0.7;
      if (nearest && this.random() < 0.8) {
        this.targetX = nearest.x + (this.random() - 0.5) * 0.35;
        this.targetZ = nearest.z + (this.random() - 0.5) * 0.35;
      } else {
        const w = arena.wander;
        this.targetX = w.x + (this.random() - 0.5) * 2 * w.halfX;
        this.targetZ = w.z + (this.random() - 0.5) * 2 * w.halfZ;
      }
    }
    const lethal = nearestLethalEdge(arena, me.x, me.z);
    const edge = !!lethal && lethal.distance < EDGE_MARGIN;
    let x = (edge ? arena.home.x : this.targetX) - me.x,
      z = (edge ? arena.home.z : this.targetZ) - me.z;
    // A target standing on a low obstacle (deck, condenser) is reached by jumping, not avoided.
    const perch = arena.obstacles.find(
      (o) => o.top <= 1.25 && inside(o, this.targetX, this.targetZ, 0)
    );
    if (me.grabbedBy !== this.previousGrabber) {
      this.previousGrabber = me.grabbedBy;
      this.reactionIn =
        BOT_COMBAT.reaction + this.random() * BOT_COMBAT.reactionSpread;
    }
    this.reactionIn = Math.max(0, this.reactionIn - dt);
    if (me.grabbedBy !== null && this.reactionIn <= 0) {
      const owner = players[me.grabbedBy];
      x = me.x - owner.x;
      z = me.z - owner.z;
      if (me.grounded && this.jumpIn <= 0) {
        i.jump = true;
        this.jumpIn = 0.85 + this.random();
      }
    }
    const holding = me.grips.find((id) => id !== null);
    if (holding !== undefined && holding !== null) {
      this.holdAge += dt;
      const target = players[holding];
      i.left =
        this.holdFor > 0 &&
        (this.firstHand === 0 || this.holdAge > BOT_COMBAT.secondHandDelay);
      i.right =
        this.holdFor > 0 &&
        (this.firstHand === 1 || this.holdAge > BOT_COMBAT.secondHandDelay);
      i.lift = target.state === "KNOCKED_OUT" || target.state === "DAZED";
      // Carry toward the closest lethal edge, straight out through it.
      x = lethal?.edge.outward.x ?? 0;
      z = lethal?.edge.outward.z ?? 1;
      if (edge && this.holdAge > 0.7) {
        i.left = i.right = false;
        this.holdFor = 0;
      }
    } else if (this.holdFor > 0) {
      this.holdAge += dt;
      i.left =
        this.firstHand === 0 || this.holdAge > BOT_COMBAT.secondHandDelay;
      i.right =
        this.firstHand === 1 || this.holdAge > BOT_COMBAT.secondHandDelay;
    } else this.holdAge = 0;
    if (
      nearest &&
      holding === undefined &&
      this.actionIn <= 0 &&
      Math.hypot(nearest.x - me.x, nearest.z - me.z) < 1.65
    ) {
      this.actionIn = BOT_COMBAT.interval + this.random() * BOT_COMBAT.spread;
      if (
        me.grabbedBy === null &&
        (nearest.state === "KNOCKED_OUT" ||
          this.random() < BOT_COMBAT.grabChance)
      ) {
        this.holdFor = BOT_COMBAT.hold + this.random() * BOT_COMBAT.holdSpread;
        this.firstHand = this.random() < 0.5 ? 0 : 1;
        this.holdAge = 0;
      } else {
        const hand = this.random() < 0.5 ? 0 : 1;
        if (me.cooldowns[hand] <= 0) {
          if (hand === 0) i.punchLeft = true;
          else i.punchRight = true;
        }
        // Briefly face a nearby grabber to fight back instead of perfect auto-escape.
        if (me.grabbedBy !== null) {
          const owner = players[me.grabbedBy];
          x = owner.x - me.x;
          z = owner.z - me.z;
        }
      }
    }
    const steered = steerAround(arena, me.x, me.z, x, z, edge || holding !== undefined ? undefined : perch);
    const norm = Math.max(1, Math.hypot(steered.x, steered.z));
    i.x = steered.x / norm;
    i.z = steered.z / norm;
    if (me.grounded && this.jumpIn <= 0 && !edge && holding === undefined) {
      const climbing = perch && inside(perch, me.x, me.z, 0.9) && !inside(perch, me.x, me.z, 0);
      i.jump = climbing || this.random() < 0.3;
      this.jumpIn = climbing ? 0.6 : 2 + this.random() * 2;
    }
    return i;
  }
}
