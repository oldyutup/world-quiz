import RAPIER from "@dimforge/rapier3d-compat";
import type { MovementInput } from "../../input/types";
import { IDLE_INPUT, PHYSICS } from "../physics";
import type { PlayerId } from "../players";
import {
  PLAZA,
  PROP_HUNT_MAP,
  ROUTE_CLEARANCES,
  SEEKER_SPAWN,
  SHED,
  STAIR,
  ENTRY_STEP_HEIGHT,
  LODGE,
  LOFT,
  STRUCTURE_COLLIDERS,
  STRUCTURE_ZONES,
  decoyHalf,
  surfaceBelow,
  zoneAt,
  type DecoyPlacement,
  type ZoneId,
} from "../../../../shared/party-lab/maps/propHunt";
import { conflict, placeIn, slotPoses, type PropLayout } from "../../../../shared/party-lab/maps/propHuntLayout";
import { CONTEXT_FAMILIES, FAMILY_SETTINGS, PROP_SCENES, PROP_SLOTS, SLOT_FAMILIES, slotById, variantItems } from "../../../../shared/party-lab/maps/propHuntScenes";
import { footprintHalf, PROP_FAMILIES, shapeHeight, type PropFamilyId } from "../../../../shared/party-lab/maps/propHuntProps";
import type { ArenaCollider } from "../../../../shared/party-lab/maps/types";
import { aimEye } from "../../../../shared/party-lab/simulation/prophunt/aim";
import { PROP_HUNT } from "../../../../shared/party-lab/simulation/prophunt/config";
import type { PropHuntGame } from "../../../../shared/party-lab/simulation/prophunt/game";
import { BombNav, NAV, type EdgeKind, type NavField, type NavNode } from "../bomb/nav";

/** One shared navigation grid for the camp's architecture (static; built once, ~0.4 s). */
let shared: BombNav | null = null;
export const propNav = () => (shared ??= new BombNav(PROP_HUNT_MAP));

const [SHED_FLOOR, ENTRY_STEP, LODGE_FLOOR, LOFT_FLOOR] = [SHED.floor, ENTRY_STEP_HEIGHT, LODGE.floor, LOFT.top];
/** Extra route cost (m-equivalent) of each climb-only node (the crate step, the woodpile, the lean-to roof): bots take the stair unless climbing saves a lot. */
export const CLIMB_COST = 1.0;
/**
 * The camp's grid with one round's decoys in it: the static grid (propNav) plus a mask of the
 * nodes a decoy stands on or within a body's clearance of (bots walk round decoys, they do not
 * climb them). Built once per layout (a few ms) and cached with it, so a bot never plans
 * through last round's props or into this round's. Climb-only surfaces cost extra (CLIMB_COST).
 */
export class LayoutNav {
  readonly blocked: Uint8Array;
  private readonly cost: Float32Array;
  private readonly isBlocked = (id: number) => this.blocked[id] === 1;
  constructor(
    readonly base: BombNav,
    readonly layout: PropLayout
  ) {
    this.blocked = new Uint8Array(base.nodes.length);
    this.cost = Float32Array.from(base.nodes, (n) => {
      const floor = [0, SHED_FLOOR, ENTRY_STEP, LODGE_FLOOR, LOFT_FLOOR].some((y) => Math.abs(n.y - y) < 0.05),
        stair = n.x >= STAIR.x[0] && n.x <= STAIR.x[1] && n.z >= STAIR.z[0] && n.z <= STAIR.z[1];
      return floor || stair ? 0 : CLIMB_COST;
    });
    for (const c of layout.colliders) {
      const bottom = c.shape === "cylinder" ? c.center.y - c.halfHeight : c.center.y - c.half.y;
      for (const n of base.nodes) {
        if (Math.abs(n.y - bottom) > 0.3) continue;
        const d =
          c.shape === "cylinder"
            ? Math.hypot(n.x - c.center.x, n.z - c.center.z) - c.radius
            : Math.hypot(Math.max(0, Math.abs(n.x - c.center.x) - c.half.x), Math.max(0, Math.abs(n.z - c.center.z) - c.half.z));
        if (d < NAV.clearance) {
          this.blocked[n.id] = 1;
          this.cost[n.id] = Infinity;
        }
      }
    }
  }
  get nodes(): readonly NavNode[] {
    return this.base.nodes;
  }
  /** The node for a pelvis position: an open one on the body's own level first (never the floor under a loft spot), then any open one, then any. */
  nodeAt(x: number, y: number, z: number) {
    const feet = y - 0.78,
      level = this.base.nodeAt(x, y, z, (id) => this.blocked[id] === 1 || Math.abs(this.base.nodes[id].y - feet) > 0.6);
    if (level >= 0) return level;
    const open = this.base.nodeAt(x, y, z, this.isBlocked);
    return open >= 0 ? open : this.base.nodeAt(x, y, z);
  }
  field(from: number): NavField {
    return this.base.field(from, this.cost);
  }
  path(field: NavField, to: number) {
    return this.base.path(field, to);
  }
  edge(a: number, b: number) {
    return this.base.edge(a, b);
  }
  clear(x0: number, z0: number, x1: number, z1: number, y: number) {
    return this.base.clear(x0, z0, x1, z1, y, this.isBlocked);
  }
}
const navs = new WeakMap<PropLayout, LayoutNav>();
/** The grid for a round's layout (cached with the layout). */
export function layoutNav(layout: PropLayout): LayoutNav {
  let nav = navs.get(layout);
  if (!nav) navs.set(layout, (nav = new LayoutNav(propNav(), layout)));
  return nav;
}

interface Point {
  x: number;
  y: number;
  z: number;
}
const STEP = PHYSICS.step;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// ─── Walking a route (the Bomba Sende bot's follower, for this map) ─────────

/**
 * Follows a grid route with plain movement intent: steers at the farthest node ahead it can
 * walk to straight; at a jump, hop, leap or drop it steers at the far side and presses jump
 * where needed; unsticks itself (a random step and a jump) after 1.2 s without progress.
 */
class Walker {
  route: number[] = [];
  goal = -1;
  private jumped = 0;
  private replanIn = 0;
  /** How hard the last step steered (the stuck check looks at that: `out` is cleared every update before `step`). */
  private pushed = 0;
  readonly stuck = { x: 0, z: 0, time: 0, escape: 0, dx: 0, dz: 0, unstuck: 0 };
  /** The round's grid (set by `use` before any planning). */
  nav!: LayoutNav;
  constructor(private readonly random: () => number) {}
  /** Follows the round's grid (a new layout drops the old route). */
  use(nav: LayoutNav) {
    if (this.nav === nav) return;
    this.nav = nav;
    this.reset();
  }
  reset() {
    this.route = [];
    this.goal = -1;
    this.jumped = this.replanIn = this.pushed = 0;
    Object.assign(this.stuck, { x: 0, z: 0, time: 0, escape: 0, dx: 0, dz: 0, unstuck: 0 });
  }
  /** Plans from the body's node to `goal`; false if unreachable. */
  plan(p: Point, goal: number): boolean {
    const here = this.nav.nodeAt(p.x, p.y, p.z);
    const field = this.nav.field(here);
    this.route = this.nav.path(field, goal);
    this.goal = goal;
    this.replanIn = 1;
    return this.route.length > 0;
  }
  /** Keeps a route to `goal`: plans when the goal changes, once a second, or after an unstick. */
  toward(p: Point, goal: number) {
    this.replanIn -= STEP;
    if (goal !== this.goal || !this.route.length || this.replanIn <= 0) this.plan(p, goal);
  }
  /** Path metres from a body to every node (bots choose among spots with it). */
  field(p: Point) {
    return this.nav.field(this.nav.nodeAt(p.x, p.y, p.z));
  }
  /** One step toward the goal: writes x/z/jump into `out`; true once at the route's end. */
  step(out: MovementInput, p: Point, vx: number, vz: number, canJump = true): boolean {
    const done = this.advance(out, p, vx, vz, canJump);
    this.pushed = Math.hypot(out.x, out.z);
    return done;
  }
  private advance(out: MovementInput, p: Point, vx: number, vz: number, canJump: boolean): boolean {
    this.jumped = Math.max(0, this.jumped - STEP);
    if (this.unstick(out, p)) return false;
    const route = this.route;
    if (!route.length) return true;
    const here = this.nav.nodeAt(p.x, p.y, p.z);
    let at = route.indexOf(here);
    if (at < 0) {
      let best = Infinity;
      route.forEach((id, k) => {
        const n = this.nav.nodes[id],
          d = Math.hypot(n.x - p.x, n.z - p.z) + Math.abs(n.y - (p.y - 0.78)) * 2;
        if (d < best) {
          best = d;
          at = k;
        }
      });
    }
    const last = this.nav.nodes[route[route.length - 1]];
    if (at >= route.length - 1) {
      const d = Math.hypot(last.x - p.x, last.z - p.z);
      if (d < 0.3) return true;
      steer(out, last.x - p.x, last.z - p.z, Math.min(1, d / 0.6));
      return false;
    }
    const level = this.nav.nodes[here]?.y ?? 0;
    let aim = route[at + 1];
    const kind: EdgeKind = this.nav.edge(route[at], route[at + 1])?.kind ?? "walk";
    if (kind === "walk")
      for (let k = at + 2; k < Math.min(route.length, at + 14); k++) {
        const e = this.nav.edge(route[k - 1], route[k]);
        if (!e || e.kind !== "walk") break;
        const n = this.nav.nodes[route[k]];
        if (!this.nav.clear(p.x, p.z, n.x, n.z, level)) break;
        aim = route[k];
      }
    const n = this.nav.nodes[aim],
      dx = n.x - p.x,
      dz = n.z - p.z,
      d = Math.hypot(dx, dz);
    steer(out, dx, dz, 1);
    if (canJump && (kind === "jump" || kind === "hop" || kind === "leap")) {
      const toward = (vx * dx + vz * dz) / Math.max(d, 1e-3),
        ready = kind === "leap" ? d < 2.9 : kind === "hop" ? d < 1.8 : d < 1.6,
        against = kind === "hop" ? d < 1.6 : kind === "jump" && d < 1.1;
      if (ready && (toward > 1.5 || against) && this.jumped <= 0) {
        out.jump = true;
        this.jumped = 0.5;
      }
    }
    return false;
  }
  private unstick(out: MovementInput, p: Point): boolean {
    const s = this.stuck;
    if (s.escape > 0) {
      s.escape -= STEP;
      steer(out, s.dx, s.dz, 1);
      return true;
    }
    if (Math.hypot(p.x - s.x, p.z - s.z) > 0.5 || this.pushed < 0.5) {
      s.x = p.x;
      s.z = p.z;
      s.time = 0;
      return false;
    }
    s.time += STEP;
    if (s.time > 1.2) {
      s.time = 0;
      s.unstuck++;
      const a = this.random() * Math.PI * 2;
      s.dx = Math.cos(a);
      s.dz = Math.sin(a);
      s.escape = 0.45;
      out.jump = true;
    }
    return false;
  }
}
function steer(out: MovementInput, dx: number, dz: number, magnitude: number) {
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) return;
  out.x = (dx / d) * magnitude;
  out.z = (dz / d) * magnitude;
}

// ─── Hide spots ─────────────────────────────────────────────────────────────

/** A place a hider can stand as `family` right beside a decoy of that family, looking like one of a set. */
export interface HideSpot {
  readonly family: PropFamilyId;
  /** The decoy it sits beside (the one it copies). */
  readonly decoy: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly turns: DecoyPlacement["turns"];
  readonly zone: ZoneId;
  /** Same-family decoys within 3.5 m (how well it blends in). */
  readonly blend: number;
  /** The camp's recipe spot it fills, empty this round (where a prop of its kind often stands); null: just beside the decoy. */
  readonly slot: string | null;
}
/** Route clearances as floor rectangles (a disguise never stands in a walkway either). */
const ROUTES = ROUTE_CLEARANCES.map((r) => ({ x0: r.x[0], x1: r.x[1], z0: r.z[0], z1: r.z[1], y: r.y }));
type Rect2 = { x0: number; x1: number; z0: number; z1: number };
/** Horizontal distance from (x, z) to a collider's footprint (0 inside it). */
const gapTo = (c: ArenaCollider, x: number, z: number) =>
  c.shape === "cylinder" ? Math.max(0, Math.hypot(x - c.center.x, z - c.center.z) - c.radius) : Math.hypot(Math.max(0, Math.abs(x - c.center.x) - c.half.x), Math.max(0, Math.abs(z - c.center.z) - c.half.z));
const footprint = (c: ArenaCollider): Rect2 & { round: number | null } =>
  c.shape === "cylinder"
    ? { x0: c.center.x - c.radius, x1: c.center.x + c.radius, z0: c.center.z - c.radius, z1: c.center.z + c.radius, round: c.radius }
    : { x0: c.center.x - c.half.x, x1: c.center.x + c.half.x, z0: c.center.z - c.half.z, z1: c.center.z + c.half.z, round: null };
/**
 * Areas a hider bot keeps clear (walkways a prop there would block or stand out in): the three
 * lodge doors and the shed door (inside and out), the stair's foot and top, the loft's drop
 * landing and the loft door path, the climb route, and the plaza's middle.
 */
export const KEEP_CLEAR: readonly Rect2[] = [
  { x0: -7.8, x1: -5.2, z0: -4.8, z1: 2.3 },
  { x0: 0.6, x1: 3.9, z0: -6.5, z1: -3.9 },
  { x0: 0.8, x1: 2.4, z0: -10.4, z1: -8.0 },
  { x0: 7.3, x1: 10.1, z0: -6.9, z1: -4.3 },
  { x0: -10.7, x1: -8.2, z0: -9.0, z1: -7.3 },
  { x0: -3.3, x1: -1.6, z0: -10.7, z1: -8.8 },
  { x0: -4.6, x1: -3.2, z0: -5.0, z1: -2.8 },
  { x0: 4.6, x1: 6.8, z0: -7.4, z1: -5.9 },
  { x0: 0.2, x1: 2.45, z0: 0.4, z1: 1.5 },
];
const spotsOf = new WeakMap<PropLayout, HideSpot[]>();
/**
 * Every hide spot of a round's layout, computed once per layout (cached with it): for each
 * decoy and each of its four sides, the same family's shape (same turn) placed touching it, if
 * that shape overlaps no solid at its level, stands on the same surface all over, stays in
 * bounds, out of KEEP_CLEAR and the route clearances, and is not in the plaza's middle.
 */
export function hideSpots(layout: PropLayout): HideSpot[] {
  const cached = spotsOf.get(layout);
  if (cached) return cached;
  const solids = [...STRUCTURE_COLLIDERS, ...layout.colliders].filter((c) => c.role !== "floor");
  const out: HideSpot[] = [];
  layout.decoys.forEach((decoy, index) => {
    const shape = PROP_FAMILIES[decoy.family].shape,
      h = decoyHalf(decoy),
      height = shapeHeight(shape);
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const x = decoy.x + dx * (2 * h.x + 0.08),
        z = decoy.z + dz * (2 * h.z + 0.08),
        r: Rect2 = { x0: x - h.x, x1: x + h.x, z0: z - h.z, z1: z + h.z };
      if (Math.abs(x) + h.x > 10.95 || Math.abs(z) + h.z > 10.95) continue;
      if (KEEP_CLEAR.some((k) => r.x0 < k.x1 && r.x1 > k.x0 && r.z0 < k.z1 && r.z1 > k.z0)) continue;
      if (ROUTES.some((k) => Math.abs(k.y - decoy.y) < 0.3 && r.x0 < k.x1 && r.x1 > k.x0 && r.z0 < k.z1 && r.z1 > k.z0)) continue;
      if (Math.hypot(x - PLAZA.x, z - PLAZA.z) < 3.0) continue;
      const blocked = solids.some((c) => {
        const f = footprint(c),
          y0 = c.shape === "cylinder" ? c.center.y - c.halfHeight : c.center.y - c.half.y,
          y1 = c.shape === "cylinder" ? c.center.y + c.halfHeight : c.center.y + c.half.y;
        if (y1 <= decoy.y + 0.02 || y0 >= decoy.y + height + 0.3) return false;
        const gx = Math.max(f.x0 - r.x1, r.x0 - f.x1),
          gz = Math.max(f.z0 - r.z1, r.z0 - f.z1);
        return gx < 0.03 && gz < 0.03;
      });
      if (blocked) continue;
      const level = [
        [x, z],
        [r.x0 + 0.05, r.z0 + 0.05],
        [r.x1 - 0.05, r.z0 + 0.05],
        [r.x0 + 0.05, r.z1 - 0.05],
        [r.x1 - 0.05, r.z1 - 0.05],
      ].every(([px, pz]) => Math.abs(surfaceBelow(px, pz, decoy.y + 0.1, layout.colliders) - decoy.y) < 0.03);
      if (!level) continue;
      const blend = layout.decoys.filter((o) => o.family === decoy.family && Math.hypot(o.x - x, o.z - z) < 3.5).length;
      out.push({ family: decoy.family, decoy: index, x, y: decoy.y, z, turns: decoy.turns, zone: zoneAt(x, z, decoy.y), blend, slot: null });
    }
  });
  // Empty recipe spots: where the camp puts a prop of a kind in play this round, with one of that
  // kind the nearest to copy there (facing the same way) — the most natural place to hide.
  const taken = new Set(layout.decoys.map((d) => d.slot));
  for (const slot of PROP_SLOTS) {
    if (taken.has(slot.id)) continue;
    for (const family of SLOT_FAMILIES.get(slot.id) ?? []) {
      if (!layout.active.includes(family)) continue;
      const poses = slotPoses(slot, family),
        pose = poses.find((q) => q.u === 0 && q.v === 0) ?? poses[0];
      if (!pose) continue;
      const p = placeIn(slot, family, pose),
        h = footprintHalf(PROP_FAMILIES[family].shape, p.turns),
        r: Rect2 = { x0: p.x - h.x, x1: p.x + h.x, z0: p.z - h.z, z1: p.z + h.z };
      if (layout.decoys.some((d) => conflict(d, p))) continue;
      if (KEEP_CLEAR.some((k) => r.x0 < k.x1 && r.x1 > k.x0 && r.z0 < k.z1 && r.z1 > k.z0) || Math.hypot(p.x - PLAZA.x, p.z - PLAZA.z) < 3.0) continue;
      let nearest = -1,
        best = Infinity;
      layout.decoys.forEach((d, i) => {
        if (Math.abs(d.y - p.y) > 0.3) return;
        const g = gapTo(layout.colliders[i], p.x, p.z);
        if (g < best) {
          best = g;
          nearest = i;
        }
      });
      const copy = layout.decoys[nearest];
      if (!copy || copy.family !== family || best > PROP_HUNT.disguise.range - 0.3) continue;
      if (PROP_FAMILIES[family].shape.kind === "box" && copy.turns !== p.turns) continue;
      const blend = layout.decoys.filter((o) => o.family === family && Math.hypot(o.x - p.x, o.z - p.z) < 3.5).length;
      out.push({ family, decoy: nearest, x: p.x, y: p.y, z: p.z, turns: p.turns, zone: slot.zone, blend, slot: slot.id });
    }
  }
  spotsOf.set(layout, out);
  return out;
}

// ─── Hider bot ──────────────────────────────────────────────────────────────

/** Where the seeker's eyes are when it is released (hider bots avoid spots in plain view of it). */
const SEEKER_EYE = { x: SEEKER_SPAWN.x, y: SEEKER_SPAWN.y + 1.0, z: SEEKER_SPAWN.z };

/** A hider bot's liking (score points) for an empty recipe spot over a place just beside a decoy. */
const RECIPE_SPOT = 0.3;
/** How strongly a hider bot favours the zone with the better spot (score points per e-fold of likelihood). */
const ZONE_PICK_TEMPERATURE = 1.0;
const claims = new WeakMap<PropHuntGame, { layout: PropLayout; spots: Set<HideSpot> }>();
/** The hide spots claimed in one game's round (a fresh game, a second arena mount or a new layout starts empty). */
function teamClaims(game: PropHuntGame) {
  let entry = claims.get(game);
  if (!entry || entry.layout !== game.layout) claims.set(game, (entry = { layout: game.layout, spots: new Set() }));
  return entry.spots;
}

export type HiderMode = "idle" | "go" | "disguise" | "hidden" | "move" | "found";

/**
 * A hider bot: in the hiding phase it picks a hide spot (a structure zone preferred, blending
 * with same-family decoys, reachable well inside the time, never the one its teammate took),
 * runs there along the grid, stops, and presses the transform (the same E as a player, the
 * same reach and sight rules: it gets whatever decoy is nearest, normally the one beside it).
 * Then it keeps still. Now and then during the search, with the seeker far away and out of
 * sight, it slides (disguised, slowly) to another spot of its family within a few metres — the
 * only motion a seeker could catch. It never learns where the seeker is going.
 */
export class HiderBot {
  readonly input: MovementInput = { x: 0, z: 0, jump: false };
  mode: HiderMode = "idle";
  spot: HideSpot | null = null;
  /** Spots the hider team claimed this round, per game (shared between the two bots of one game). */
  private claimed = new Set<HideSpot>();
  private readonly walker: Walker;
  private tried = new Set<HideSpot>();
  private pressIn = 0;
  private settle = 0;
  private relocateCheck = 0;
  private unseen = 0;
  private moveTime = 0;
  constructor(
    readonly id: PlayerId,
    private readonly random: () => number = Math.random
  ) {
    this.walker = new Walker(random);
  }
  private get nav() {
    return this.walker.nav;
  }
  reset() {
    this.mode = "idle";
    this.spot = null;
    this.tried.clear();
    this.claimed.clear();
    this.walker.reset();
    this.pressIn = this.settle = this.relocateCheck = this.unseen = this.moveTime = 0;
  }
  update(game: PropHuntGame): MovementInput {
    const i = this.input;
    i.x = i.z = 0;
    i.jump = i.sprint = i.pickup = false;
    const round = game.round;
    this.claimed = teamClaims(game);
    // A spot from another layout (last round's) is never used: start over on this one.
    if (this.spot && !hideSpots(game.layout).includes(this.spot)) this.reset();
    this.walker.use(layoutNav(game.layout));
    if (!round.alive[this.id]) {
      this.mode = "found";
      return IDLE_INPUT;
    }
    if (round.phase !== "hiding" && round.phase !== "search") {
      if (round.phase === "countdown" && this.mode !== "idle") this.reset();
      return IDLE_INPUT;
    }
    const worn = game.disguiseOf(this.id);
    if (worn) {
      if (this.mode !== "move") this.mode = "hidden";
      this.hidden(game);
      return i;
    }
    const me = game.physics.players[this.id],
      p = me.body.translation(),
      v = me.body.linvel();
    const late = round.phase === "search" || round.remaining < 2.2;
    if (!this.spot && !late) this.choose(game, p);
    if (this.spot && this.mode !== "disguise") {
      this.mode = "go";
      const d = Math.hypot(this.spot.x - p.x, this.spot.z - p.z),
        level = Math.abs(game.feet(me) - this.spot.y) < 0.3;
      if (d < 0.32 && level) {
        this.mode = "disguise";
        this.settle = 0.35 + this.random() * 0.2;
      } else if (d < 1.2 && level) steer(i, this.spot.x - p.x, this.spot.z - p.z, Math.max(0.35, Math.min(1, d / 0.8)));
      else {
        this.walker.toward(p, this.nav.nodeAt(this.spot.x, this.spot.y + 0.78, this.spot.z));
        this.walker.step(i, p, v.x, v.z);
        i.sprint = d > 2.5;
        // Hopelessly stuck on the way (three unsticks): another spot.
        if (this.walker.stuck.unstuck >= 3) {
          this.tried.add(this.spot);
          this.claimed.delete(this.spot);
          this.spot = null;
          this.walker.reset();
        }
      }
    }
    if (this.mode === "disguise") {
      // Stand still for a moment, then press E (once the transform can happen).
      this.settle -= STEP;
      if (this.settle <= 0 && Math.hypot(v.x, v.z) < 0.6) {
        i.pickup = true;
        this.pressIn++;
        if (this.pressIn > 3) {
          // Refused here (no room, or another prop is nearer): try another spot.
          if (this.spot) this.tried.add(this.spot);
          this.spot = null;
          this.pressIn = 0;
          this.walker.reset();
          this.mode = "go";
        } else this.settle = 0.9;
      }
    }
    // Out of time without a spot: take whatever is in reach.
    if (!this.spot && late && game.nearestDecoy(this.id)) i.pickup = true;
    return i;
  }
  /**
   * Chooses a spot: reachable in time, never a teammate's. Each zone offers its best spot
   * (structures, blending in and distance from the seeker score up; plain view of the
   * seeker's release point and the plaza score down), then a zone is drawn with the better
   * ones likelier — so a bot is not always in the same room.
   */
  private choose(game: PropHuntGame, p: Point) {
    const field = this.walker.field(p),
      seconds = game.round.remaining,
      reach = Math.max(8, (seconds - 3.5) * 5.2);
    const best = new Map<ZoneId, { spot: HideSpot; score: number }>();
    for (const spot of hideSpots(game.layout)) {
      if (this.tried.has(spot) || this.claimed.has(spot)) continue;
      if ([...this.claimed].some((c) => Math.hypot(c.x - spot.x, c.z - spot.z) < 3)) continue;
      const node = this.nav.nodeAt(spot.x, spot.y + 0.78, spot.z),
        path = field.dist[node];
      if (!Number.isFinite(path) || path > reach) continue;
      const structure = STRUCTURE_ZONES.includes(spot.zone) ? 1.2 : 0,
        far = Math.min(1, Math.hypot(spot.x - SEEKER_SPAWN.x, spot.z - SEEKER_SPAWN.z) / 14) * 1.5,
        exposed = game.physics.clearPath(SEEKER_EYE, { x: spot.x, y: spot.y + 0.5, z: spot.z }) ? 1.8 : 0,
        plaza = spot.zone === "plaza" ? 3 : 0;
      const score = structure + Math.min(3, spot.blend) * 0.7 + (spot.slot ? RECIPE_SPOT : 0) + far - exposed - plaza - path * 0.01 + this.random() * 0.6;
      const current = best.get(spot.zone);
      if (!current || score > current.score) best.set(spot.zone, { spot, score });
    }
    const options = [...best.values()],
      weights = options.map((o) => Math.exp(o.score / ZONE_PICK_TEMPERATURE));
    let draw = this.random() * weights.reduce((sum, w) => sum + w, 0),
      chosen: HideSpot | null = options.length ? options[options.length - 1].spot : null;
    for (let k = 0; k < options.length; k++) {
      draw -= weights[k];
      if (draw <= 0) {
        chosen = options[k].spot;
        break;
      }
    }
    this.spot = chosen;
    if (chosen) this.claimed.add(chosen);
    this.walker.reset();
  }
  /**
   * Disguised: keep still. In the search, if the seeker has been out of sight and ≥ 12 m away
   * for 6 s, now and then (≈ once a minute) slide to another spot of the family within 6 m.
   */
  private hidden(game: PropHuntGame) {
    const worn = game.disguiseOf(this.id)!,
      p = worn.body.translation(),
      round = game.round;
    if (this.mode === "move" && this.spot) {
      this.moveTime += STEP;
      const d = Math.hypot(this.spot.x - p.x, this.spot.z - p.z);
      if (d < 0.2 || this.moveTime > 5) {
        this.mode = "hidden";
        this.moveTime = 0;
      } else steer(this.input, this.spot.x - p.x, this.spot.z - p.z, Math.min(1, d / 0.6));
      return;
    }
    if (round.phase !== "search") return;
    const seeker = game.physics.players[round.seeker].body.translation(),
      far = Math.hypot(seeker.x - p.x, seeker.z - p.z) > 12 && !game.physics.clearPath({ x: p.x, y: p.y + 0.5, z: p.z }, { x: seeker.x, y: seeker.y + 0.8, z: seeker.z });
    this.unseen = far ? this.unseen + STEP : 0;
    this.relocateCheck -= STEP;
    if (this.unseen < 6 || this.relocateCheck > 0) return;
    this.relocateCheck = 1;
    if (this.random() > 1 / 60) return;
    const options = hideSpots(game.layout).filter((s) => s.family === worn.family && s !== this.spot && Math.hypot(s.x - p.x, s.z - p.z) < 6 && Math.abs(s.y - (p.y - 0.02)) < 0.1 && game.physics.clearPath({ x: p.x, y: p.y + 0.3, z: p.z }, { x: s.x, y: s.y + 0.3, z: s.z }));
    if (!options.length) return;
    this.spot = options[Math.floor(this.random() * options.length)];
    this.mode = "move";
    this.moveTime = 0;
  }
}

// ─── Seeker bot ─────────────────────────────────────────────────────────────

/** The camp's landmark props (always where they are: the chopping block), as anyone who has seen the camp knows. */
const LANDMARKS = PROP_SCENES.filter((s) => s.fixed).flatMap((s) =>
  s.variants.flatMap((v) => variantItems(v).flatMap((i) => i.families.map((family) => placeIn(slotById(i.slots[0])!, family, { turns: 0, u: 0, v: 0 }))))
);
/** Every spot the camp's recipes can put a prop of this kind (the camp's logic, the same every round; built on first use). */
const spots = new Map<PropFamilyId, { x: number; y: number; z: number }[]>();
function recipeSpots(family: PropFamilyId) {
  let list = spots.get(family);
  if (!list) {
    list = PROP_SLOTS.filter((s) => SLOT_FAMILIES.get(s.id)?.includes(family)).flatMap((s) => slotPoses(s, family).map((pose) => placeIn(s, family, pose)));
    spots.set(family, list);
  }
  return list;
}
/** Whether the camp's recipes ever put a prop of this kind near (x, z) on that floor (the camp's logic, not this round's layout). */
function plausibleAt(family: PropFamilyId, x: number, y: number, z: number) {
  return PROP_SLOTS.some(
    (s) =>
      Math.abs(s.y - y) < 0.3 &&
      CONTEXT_FAMILIES[s.context].includes(family) &&
      FAMILY_SETTINGS[family].includes(s.setting) &&
      Math.hypot(Math.max(0, s.x[0] - x, x - s.x[1]), Math.max(0, s.z[0] - z, z - s.z[1])) < 1.0
  );
}

export type SeekerMode = "wait" | "patrol" | "look" | "inspect" | "approach" | "aim";

/** Where the seeker bot stands to look over a zone, and roughly where it looks. */
export const VIEWPOINTS: readonly { readonly zone: ZoneId; readonly x: number; readonly y: number; readonly z: number; readonly look: number }[] = [
  { zone: "plaza", x: -1.0, y: 0, z: 1.6, look: Math.PI },
  { zone: "porch", x: -4.6, y: 0.45, z: -0.7, look: -Math.PI / 2 },
  { zone: "lodge", x: -6.3, y: 0.45, z: -4.3, look: Math.PI * 0.85 },
  { zone: "lodge", x: -1.0, y: 0.45, z: -6.8, look: 0 },
  // The loft from the stair top (its middle, the bunk bed, the door, the north wall) and from the drop gap (its south half).
  { zone: "loft", x: -2.3, y: 3.65, z: -8.3, look: (Math.PI * 75) / 180 },
  { zone: "loft", x: -1.8, y: 3.65, z: -4.3, look: (Math.PI * 70) / 180 },
  { zone: "yard", x: 3.8, y: 0, z: -5.0, look: Math.PI / 2 },
  { zone: "yard", x: 8.6, y: 0, z: -3.6, look: Math.PI / 2 },
  { zone: "leanTo", x: 5.9, y: 0, z: -5.2, look: Math.PI },
  { zone: "shed", x: 8.7, y: 0.15, z: -7.0, look: Math.PI },
  { zone: "pavilion", x: 7.0, y: 0, z: 2.6, look: 0 },
  { zone: "camp", x: -6.4, y: 0, z: 3.4, look: -Math.PI / 2 },
  { zone: "camp", x: -4.6, y: 0, z: 7.8, look: -Math.PI * 0.6 },
  { zone: "border", x: 2.8, y: 0, z: 8.3, look: Math.PI * 0.1 },
  { zone: "border", x: 9.2, y: 0, z: 1.0, look: Math.PI * 0.3 },
];
/** How the seeker bot judges what it sees (per second of looking, suspicion 0…1+). */
export const SEEKER_SENSE = {
  range: 15,
  /** Half the field of view it notices things in (rad): about a player's camera. */
  cone: 0.85,
  /** A prop it has seen move (in view both times, within a second). */
  moved: 0.85,
  /** A prop where it does not remember one of that kind: per second, before distance and blending. */
  unfamiliar: 0.32,
  /** Each same-kind decoy within 3.5 m slows that noticing: rate / (1 + blend · count). */
  blend: 0.35,
  /**
   * What it knows, besides what it sees: the camp's logic (which spots the camp puts each kind of
   * prop in — the same every round, like a regular knows it) and what it saw itself in earlier
   * rounds; never this round's layout. A prop of that kind within `familiar` m of where it saw one
   * in the last `recall` rounds looks familiar (paranoia only); one on a spot where that kind
   * belongs (within `usual` m of it) is no evidence by itself: noticed ×`usualRate`, never beyond
   * `usualCap` on that alone (a guess it only risks late, with shots to spare); one off every such
   * spot ×1; one of a kind the camp never puts there (a dresser by the fire) ×`outOfPlace`.
   */
  familiar: 0.3,
  recall: 2,
  usual: 0.4,
  usualRate: 0.35,
  usualCap: 0.7,
  outOfPlace: 3,
  /** Walk closer and study an unfamiliar prop at this much suspicion, for up to this long (s). */
  inspect: 0.2,
  inspectTime: 4,
  /** Any ordinary prop, now and then (it will sometimes waste a shot). */
  paranoia: 0.018,
  /**
   * Shoot at this much suspicion; lower when time runs short with shots to spare (at least
   * `lateSpare` more than hiders left), higher with only `reserve` more shots than hiders left
   * (the last shot spent with a hider hidden loses the round).
   */
  threshold: 1.0,
  lateThreshold: 0.6,
  lateSpare: 5,
  reserve: 2,
  reserveThreshold: 1.6,
  /** Aim error (rad): a base plus a share of the distance. */
  aimError: 0.012,
  aimErrorPerMetre: 0.0022,
  /** Patrol order: how much a metre of walk counts against a viewpoint (lower: far zones get their turn)… */
  patrolDistance: 0.5,
  /** …and the head start of a viewpoint over a structure (lodge, loft, porch, lean-to, shed, pavilion), where most hiders go. */
  patrolStructure: 8,
  /** The periodic whistle is a rough clue: where it heard one is off by up to this much (m, each way), the floor it came from right 70% of the time. */
  whistleBlur: 2.5,
  /** Props it knows of within this of where it guessed the whistle came from (same floor) become suspects: suspicion +`whistleNudge`, beyond their caps. */
  whistleNear: 3.0,
  whistleNudge: 0.45,
  /**
   * "Was this here before?": an unfamiliar prop whose neighbours (within `oddRadius` m, seen this
   * round) are at least `oddFamiliar` familiar ones and at most a third as many unfamiliar ones — a
   * corner mostly just as it was last round, but for it — is noticed ×`oddRate`, beyond its cap.
   */
  oddRadius: 2.5,
  oddFamiliar: 2,
  oddRate: 1.2,
  /**
   * The hunch ("near": a hider is close, nothing more). It only knows where it stood itself: the
   * props it has seen, or sees within the next `hunchTime` s, on its floor within the hunch's
   * radius (+`hunchSlack` m) of that spot become suspects (+`hunchNudge` once each per hunch,
   * beyond their caps), and it turns once all the way round (`hunchSweep` s) to see what is there.
   */
  hunchSlack: 0.3,
  hunchNudge: 0.35,
  hunchTime: 6,
  hunchSweep: 2.8,
} as const;

interface Seen {
  key: string;
  family: PropFamilyId | "body";
  x: number;
  y: number;
  z: number;
  /** Height of the thing (the aim point is at 55% of it). */
  height: number;
  /** Its collider (sight lines ignore the thing looked at). */
  handle: number | null;
}
interface Memory {
  family: PropFamilyId | "body";
  height: number;
  /** Its collider when last seen (sight lines ignore the thing looked at). */
  handle: number | null;
  x: number;
  y: number;
  z: number;
  lastSeen: number;
  suspicion: number;
  cleared: boolean;
  shots: number;
  /** Its first impression (from what it remembers of earlier rounds and the camp): where it saw one like it. */
  familiar: boolean;
  /** How fast it notices this one (a multiplier), and the most suspicion noticing alone gives it. */
  rate: number;
  cap: number;
}

/**
 * The seeker bot: no omniscience. It never reads who is disguised; it sees what a player
 * would — props (decoys and disguises alike: a family at a place) and a hider's body when one
 * is out in the open — through a view cone, a range and clear sight lines. It knows the camp's
 * layout like a regular would: a prop standing where a prop of that kind always stands is
 * "familiar" (remembered by its place), any other prop is not, and is tracked by sight while it
 * stays in view. Suspicion grows on a prop it saw move, or on an unfamiliar one (noticing takes
 * time: slower far away, and slower still among others of the same kind). It patrols the
 * zones' viewpoints (the least recently checked nearest first), sweeps its view at each, walks
 * closer to anything suspicious, aims with a small, distance-scaled error, and shoots only when
 * sure enough — pickier when shots are few, less picky near the end. A shot's result is what
 * anyone sees: a found hider, or a decoy that just took a hit (cleared, never shot again).
 */
export class SeekerBot {
  readonly input: MovementInput = { x: 0, z: 0, jump: false };
  mode: SeekerMode = "wait";
  readonly memory = new Map<string, Memory>();
  /** What it is aiming at (diagnostics). */
  target: string | null = null;
  private readonly walker: Walker;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  private time = 0;
  private senseIn = 0;
  private yaw = Math.PI;
  private pitch = 0.3;
  private view = -1;
  private readonly checked = new Map<number, number>();
  private lookLeft = 0;
  private lookBase = 0;
  private aimError = { yaw: 0, pitch: 0 };
  private settle = 0;
  private tracks = 0;
  private inspecting: { key: string; until: number } | null = null;
  private readonly inspected = new Map<string, number>();
  /** The last hunch: where it stood when it came (never where the hider is), until when it counts, and the props it has already weighed. */
  private hunch: { x: number; z: number; feet: number; until: number; weighed: Set<string> } | null = null;
  /** Seconds left of the all-round look after a hunch, and the yaw it started from. */
  private spin = 0;
  private spinBase = 0;
  /**
   * Props it saw in earlier rounds of this match (kind, place, which round): its whole knowledge
   * of the camp's layout. Wrong as often as the layout moved on — a disguise standing where a prop
   * of its kind stood last round looks familiar.
   */
  readonly past: { family: PropFamilyId; x: number; y: number; z: number; round: number }[] = [];
  /** Rounds it has searched in this match (a round's sightings go into `past` at the next reset). */
  rounds = 0;
  /** The round (its layout) its current memory belongs to: a new one starts the next round's memory. */
  private roundOf: PropLayout | null = null;
  constructor(
    readonly id: PlayerId,
    private readonly random: () => number = Math.random
  ) {
    this.walker = new Walker(random);
    this.reset();
  }
  private get nav() {
    return this.walker.nav;
  }
  /** A new round: what it saw goes into its memory of the camp; everything else starts over. */
  reset() {
    this.remember();
    this.roundOf = null;
    this.mode = "wait";
    this.memory.clear();
    this.checked.clear();
    this.walker.reset();
    this.target = null;
    this.time = this.senseIn = this.lookLeft = this.settle = this.tracks = 0;
    this.inspecting = null;
    this.inspected.clear();
    this.hunch = null;
    this.spin = this.spinBase = 0;
    this.view = -1;
    this.pitch = 0.3;
  }
  update(game: PropHuntGame): MovementInput {
    const i = this.input;
    i.x = i.z = 0;
    i.jump = i.sprint = i.attack = false;
    const round = game.round,
      me = game.physics.players[this.id];
    // A new round (reset was not called): what it saw last round becomes memory.
    if (this.roundOf && this.roundOf !== game.layout) this.reset();
    this.roundOf = game.layout;
    if (round.phase !== "search") {
      if (round.phase === "countdown" && this.mode !== "wait") this.reset();
      this.mode = "wait";
      this.yaw = me.facing;
      return IDLE_INPUT;
    }
    this.time += STEP;
    this.walker.use(layoutNav(game.layout));
    const p = me.body.translation(),
      v = me.body.linvel();
    // What its last shot did (anyone sees it): a decoy is cleared; a find ends that hider.
    for (const e of game.events)
      if (e.type === "shot" && e.shooter === this.id && this.target) {
        const m = this.memory.get(this.target);
        if (m) {
          m.shots++;
          if (e.hit === "decoy") m.cleared = true;
        }
        this.target = null;
      }
    // A whistle (every 15 s): head for the viewpoint nearest where it seemed to come from.
    for (const e of game.events) if (e.type === "whistle" && !this.target) this.heard(e.at);
    // A hunch: someone is close to where it stands (nothing more).
    for (const e of game.events) if (e.type === "near" && e.seeker === this.id) this.sensed(p);
    this.senseIn -= STEP;
    if (this.senseIn <= 0) {
      this.senseIn = 0.15;
      this.sense(game, p, 0.15);
    }
    const target = this.pickTarget(game) ?? this.pickInspect(p);
    if (target && target.suspicion < this.threshold(game)) this.inspect(game, target, p, v);
    else if (target) {
      const d = Math.hypot(target.x - p.x, target.z - p.z);
      if (d > 8 || !this.lineOfFire(game, target)) {
        this.mode = "approach";
        this.walker.toward(p, this.nav.nodeAt(target.x, target.y + 0.78, target.z));
        this.walker.step(i, p, v.x, v.z);
        this.lookAt(p, target, 5);
      } else this.aimAndShoot(game, target, p);
    } else this.patrol(game, p, v);
    i.facing = this.yaw;
    i.aimPitch = this.pitch;
    return i;
  }
  /** Looks over what is in view now: memory and suspicion. */
  private sense(game: PropHuntGame, p: Point, dt: number) {
    const late = game.round.remaining < 25;
    for (const s of this.visible(game, { x: p.x, y: p.y + 1.0, z: p.z })) {
      const d = Math.hypot(s.x - p.x, s.z - p.z);
      let m = this.memory.get(s.key);
      const fresh = !m;
      if (!m) this.memory.set(s.key, (m = { family: s.family, height: s.height, handle: s.handle, x: s.x, y: s.y, z: s.z, lastSeen: this.time, suspicion: 0, cleared: false, shots: 0, ...this.impression(s) }));
      m.handle = s.handle;
      if (m.cleared) continue;
      this.weigh(s.key, m);
      // Seen moving: in view a moment ago, somewhere else now (whatever it thought of it before).
      const moved = !fresh && this.time - m.lastSeen < 1.0 && Math.hypot(s.x - m.x, s.z - m.z) > 0.08;
      if (s.family === "body") m.suspicion = 2;
      else if (moved) {
        m.suspicion = Math.max(m.suspicion, m.cap) + SEEKER_SENSE.moved;
        m.familiar = false;
        m.cap = Infinity;
      } else if (m.familiar) m.suspicion += SEEKER_SENSE.paranoia * Math.max(0.2, 1.4 - d / 12) * dt * this.random() * (late ? 3 : 1);
      else {
        // A corner just as it was last round but for this one: the odd one out.
        const K = SEEKER_SENSE,
          around = [...this.memory.values()].filter((o) => o !== m && o.family !== "body" && Math.abs(o.y - s.y) < 0.3 && Math.hypot(o.x - s.x, o.z - s.z) < K.oddRadius),
          known = around.filter((o) => o.familiar).length,
          odd = known >= K.oddFamiliar && around.length - known <= known / 3;
        const rate = odd ? Math.max(m.rate, K.oddRate) : m.rate,
          cap = odd ? Infinity : m.cap;
        if (m.suspicion < cap) {
          // Others of its kind seen close by this round make it blend in.
          const distance = Math.max(0.2, Math.min(1, 1.5 - d / 10)),
            blend = around.filter((o) => o.family === s.family).length;
          m.suspicion = Math.min(cap, m.suspicion + (K.unfamiliar * rate * distance * dt * (0.6 + 0.8 * this.random())) / (1 + K.blend * blend));
        }
      }
      m.x = s.x;
      m.y = s.y;
      m.z = s.z;
      m.lastSeen = this.time;
    }
  }
  /**
   * Its first impression of a prop, from what it may know: the camp's landmarks (the chopping
   * block), the props it saw in earlier rounds, and which kinds of prop the camp puts where.
   * Never this round's layout: a decoy and a disguise at the same place look the same to it.
   */
  private impression(s: Seen): Pick<Memory, "familiar" | "rate" | "cap"> {
    const K = SEEKER_SENSE;
    if (s.family === "body") return { familiar: false, rate: 1, cap: Infinity };
    const family = s.family,
      near = (p: { x: number; y: number; z: number }, r: number) => Math.abs(p.y - s.y) < 0.3 && Math.hypot(p.x - s.x, p.z - s.z) < r;
    if (LANDMARKS.some((l) => l.family === family && near(l, K.familiar))) return { familiar: true, rate: 0, cap: Infinity };
    if (this.past.some((p) => p.round >= this.rounds - K.recall && p.family === family && near(p, K.familiar))) return { familiar: true, rate: 0, cap: Infinity };
    if (!plausibleAt(family, s.x, s.y, s.z)) return { familiar: false, rate: K.outOfPlace, cap: Infinity };
    if (recipeSpots(family).some((p) => near(p, K.usual))) return { familiar: false, rate: K.usualRate, cap: K.usualCap };
    return { familiar: false, rate: 1, cap: Infinity };
  }
  /** This round's sightings go into its memory of the camp (kept for a few rounds). */
  private remember() {
    let saw = false;
    for (const m of this.memory.values()) {
      if (m.family === "body") continue;
      this.past.push({ family: m.family, x: m.x, y: m.y, z: m.z, round: this.rounds });
      saw = true;
    }
    if (!saw) return;
    this.rounds++;
    // Older than it recalls: forgotten.
    for (let k = this.past.length - 1; k >= 0; k--) if (this.past[k].round < this.rounds - SEEKER_SENSE.recall) this.past.splice(k, 1);
  }
  /**
   * What a player standing at `eye` would see. Decoys are known by their place (`d:` + the
   * spot); any other prop is tracked by sight (`p:`), following the nearest one of its family
   * seen within the last second (so it can follow a sliding prop, and loses it out of view).
   */
  private visible(game: PropHuntGame, eye: Point): Seen[] {
    const out: Seen[] = [];
    const consider = (s: Seen) => {
      const dx = s.x - eye.x,
        dz = s.z - eye.z,
        d = Math.hypot(dx, dz);
      if (d > SEEKER_SENSE.range) return;
      if (d > 1.2 && Math.abs(wrap(Math.atan2(dx, dz) - this.yaw)) > SEEKER_SENSE.cone) return;
      if (this.sees(game, eye, { x: s.x, y: s.y + s.height * 0.55, z: s.z }, s.handle)) out.push(s);
    };
    game.layout.decoys.forEach((d, index) => consider({ key: `d:${index}`, family: d.family, x: d.x, y: d.y, z: d.z, height: shapeHeight(PROP_FAMILIES[d.family].shape), handle: game.decoyHandles[index] ?? null }));
    for (const id of game.round.hidden) {
      const worn = game.disguiseOf(id);
      if (worn) {
        const b = worn.body.translation();
        consider({ key: this.track(worn.family, b.x, b.z), family: worn.family, x: b.x, y: b.y, z: b.z, height: shapeHeight(PROP_FAMILIES[worn.family].shape), handle: worn.collider.handle });
      } else {
        const c = game.physics.players[id];
        if (!c.eliminated) {
          const b = c.body.translation();
          consider({ key: `b:${id}`, family: "body", x: b.x, y: b.y - 0.78, z: b.z, height: 1.8, handle: null });
        }
      }
    }
    return out;
  }
  /** The unfamiliar prop this sighting is: the same kind where it was (any time), or one seen within the last second within 1.2 m (sliding), else a new one. */
  private track(family: PropFamilyId, x: number, z: number) {
    let best: string | null = null,
      bestD = Infinity;
    for (const [key, m] of this.memory) {
      if (!key.startsWith("p:") || m.family !== family) continue;
      const d = Math.hypot(m.x - x, m.z - z);
      if ((d < 0.4 || (d < 1.2 && this.time - m.lastSeen <= 1.0)) && d < bestD) {
        bestD = d;
        best = key;
      }
    }
    return best ?? `p:${this.tracks++}`;
  }
  /** A clear line from `from` to `to`: static geometry and other props block, bodies and the thing itself do not. */
  private sees(game: PropHuntGame, from: Point, to: Point, handle: number | null): boolean {
    const dx = to.x - from.x,
      dy = to.y - from.y,
      dz = to.z - from.z,
      d = Math.hypot(dx, dy, dz);
    if (d < 0.5) return true;
    this.ray.origin = from;
    this.ray.dir = { x: dx / d, y: dy / d, z: dz / d };
    return !game.physics.world.castRay(this.ray, d, true, undefined, undefined, undefined, undefined, (collider) => collider.handle !== handle && !collider.parent()?.isDynamic());
  }
  /** The torso has a clear shot at it. */
  private lineOfFire(game: PropHuntGame, t: Memory) {
    const torso = game.physics.players[this.id].parts.torso.body.translation();
    return this.sees(game, torso, { x: t.x, y: t.y + t.height * 0.55, z: t.z }, t.handle);
  }
  /** Suspicion needed to spend a shot: higher when shots are few, lower near the end with shots to spare. */
  private threshold(game: PropHuntGame) {
    const K = SEEKER_SENSE,
      round = game.round,
      spare = game.ammo - round.hidden.length;
    if (spare <= K.reserve) return K.reserveThreshold;
    return round.remaining < 22 && spare >= K.lateSpare ? K.lateThreshold : K.threshold;
  }
  /** The most suspicious thing it remembers seeing lately, above the threshold, not shot twice. */
  private pickTarget(game: PropHuntGame): (Memory & { key: string }) | null {
    if (game.ammo <= 0) return null;
    const threshold = this.threshold(game);
    let best: { key: string; m: Memory } | null = null;
    for (const [key, m] of this.memory) {
      if (m.cleared || m.suspicion < threshold || m.shots >= 2 || this.time - m.lastSeen > 6) continue;
      if (!best || m.suspicion > best.m.suspicion) best = { key, m };
    }
    if (!best) return null;
    return { ...best.m, key: best.key };
  }
  /**
   * Something caught its eye but it is not sure (an unfamiliar prop, suspicion ≥ `inspect`):
   * it walks to about 4 m and studies it for up to `inspectTime` s before moving on (not the
   * same one again for 20 s).
   */
  private pickInspect(p: Point): (Memory & { key: string }) | null {
    if (this.inspecting) {
      const m = this.memory.get(this.inspecting.key);
      if (m && !m.cleared && this.time < this.inspecting.until) return { ...m, key: this.inspecting.key };
      this.inspected.set(this.inspecting.key, this.time);
      this.inspecting = null;
    }
    let best: string | null = null,
      bestScore = -Infinity;
    for (const [key, m] of this.memory) {
      if (m.cleared || m.family === "body" || m.familiar || m.suspicion < SEEKER_SENSE.inspect || this.time - m.lastSeen > 4) continue;
      const last = this.inspected.get(key);
      if (last !== undefined && this.time - last < 20) continue;
      // Evidence first (off its kind's usual spots, the odd one out, near the whistle); a prop on a usual spot only when nothing else is.
      const score = m.suspicion + (m.cap === Infinity ? 1 : 0) - Math.hypot(m.x - p.x, m.z - p.z) * 0.02;
      if (score > bestScore) {
        bestScore = score;
        best = key;
      }
    }
    if (!best) return null;
    this.inspecting = { key: best, until: this.time + SEEKER_SENSE.inspectTime };
    return { ...this.memory.get(best)!, key: best };
  }
  private inspect(game: PropHuntGame, t: Memory & { key: string }, p: Point, v: { x: number; z: number }) {
    this.mode = "inspect";
    const d = Math.hypot(t.x - p.x, t.z - p.z);
    if (d > 4.2 || !this.lineOfFire(game, t)) {
      this.walker.toward(p, this.nav.nodeAt(t.x, t.y + 0.78, t.z));
      this.walker.step(this.input, p, v.x, v.z);
    }
    this.lookAt(p, t, 6);
  }
  private lookAt(p: Point, t: { x: number; y: number; z: number; height: number }, rate: number) {
    const want = Math.atan2(t.x - p.x, t.z - p.z);
    this.yaw += Math.max(-rate * STEP, Math.min(rate * STEP, wrap(want - this.yaw)));
    this.pitch = Math.max(-0.3, Math.min(0.9, -Math.atan2(t.y + t.height * 0.55 - (p.y + 1.0), Math.hypot(t.x - p.x, t.z - p.z))));
  }
  private aimAndShoot(game: PropHuntGame, t: Memory & { key: string }, p: Point) {
    this.mode = "aim";
    if (this.target !== t.key) {
      this.target = t.key;
      const sigma = SEEKER_SENSE.aimError + SEEKER_SENSE.aimErrorPerMetre * Math.hypot(t.x - p.x, t.z - p.z);
      this.aimError = { yaw: gauss(this.random) * sigma, pitch: gauss(this.random) * sigma };
      this.settle = 0.35 + this.random() * 0.3;
    }
    const eye = aimEye(p, this.yaw),
      ty = t.y + t.height * 0.55;
    this.yaw = Math.atan2(t.x - eye.x, t.z - eye.z) + this.aimError.yaw;
    this.pitch = Math.max(-0.5, Math.min(1.0, -Math.atan2(ty - eye.y, Math.hypot(t.x - eye.x, t.z - eye.z)) + this.aimError.pitch));
    this.settle -= STEP;
    const me = game.physics.players[this.id];
    if (this.settle <= 0 && Math.abs(wrap(me.facing - this.yaw)) < 0.05 && game.shotCooldown === 0) this.input.attack = true;
  }
  /** The least recently checked viewpoint nearby, a sweep of the view there, then the next. */
  private patrol(game: PropHuntGame, p: Point, v: { x: number; z: number }) {
    if (this.spin > 0) {
      // After a hunch: once all the way round where it stands, a little down.
      this.mode = "look";
      this.spin -= STEP;
      this.yaw = this.spinBase + (1 - this.spin / SEEKER_SENSE.hunchSweep) * Math.PI * 2;
      this.pitch = 0.35;
      return;
    }
    if (this.lookLeft > 0) {
      this.mode = "look";
      this.lookLeft -= STEP;
      // Sweep ±70° round the viewpoint's direction over 2.4 s, a little down.
      this.yaw = this.lookBase + Math.sin((1 - this.lookLeft / 2.4) * Math.PI * 2) * 1.2;
      this.pitch = 0.32;
      if (this.lookLeft <= 0) {
        this.checked.set(this.view, this.time);
        this.view = -1;
      }
      return;
    }
    this.mode = "patrol";
    if (this.view < 0) this.nextView(p);
    const vp = VIEWPOINTS[this.view],
      d = Math.hypot(vp.x - p.x, vp.z - p.z);
    if (d < 0.6 && Math.abs(game.feet(game.physics.players[this.id]) - vp.y) < 0.4) {
      this.lookLeft = 2.4;
      this.lookBase = vp.look;
      return;
    }
    this.walker.toward(p, this.nav.nodeAt(vp.x, vp.y + 0.78, vp.z));
    this.walker.step(this.input, p, v.x, v.z);
    this.input.sprint = d > 4;
    // Can't get there (three unsticks on the way): count it as seen and go elsewhere.
    if (this.walker.stuck.unstuck >= 3) {
      this.checked.set(this.view, this.time);
      this.view = -1;
      this.walker.reset();
    }
    // Look where it walks, a little down.
    if (Math.hypot(this.input.x, this.input.z) > 0.3) {
      const want = Math.atan2(this.input.x, this.input.z);
      this.yaw += Math.max(-4 * STEP, Math.min(4 * STEP, wrap(want - this.yaw)));
      this.pitch = 0.3;
    }
  }
  /**
   * A hunch: a hider is within the hunch's radius of where it stands — which one, which prop and
   * which way are not told. What it has seen around here becomes suspect, and it looks all round.
   */
  private sensed(p: Point) {
    this.hunch = { x: p.x, z: p.z, feet: p.y - 0.78, until: this.time + SEEKER_SENSE.hunchTime, weighed: new Set() };
    for (const [key, m] of this.memory) if (!m.cleared) this.weigh(key, m);
    if (this.target) return;
    this.inspecting = null;
    this.lookLeft = 0;
    this.spin = SEEKER_SENSE.hunchSweep;
    this.spinBase = this.yaw;
  }
  /** A prop within the last hunch's reach (its floor, its radius from where it stood): a suspect, once per hunch. */
  private weigh(key: string, m: Memory) {
    const h = this.hunch;
    if (!h || this.time > h.until || m.family === "body" || h.weighed.has(key)) return;
    if (Math.abs(m.y - h.feet) > PROP_HUNT.proximity.vertical || Math.hypot(m.x - h.x, m.z - h.z) > PROP_HUNT.proximity.radius + SEEKER_SENSE.hunchSlack) return;
    h.weighed.add(key);
    m.suspicion += SEEKER_SENSE.hunchNudge;
    m.cap = Infinity;
  }
  /** A whistle heard: a rough guess at where (blurred, the floor right most of the time), then the nearest viewpoint on that floor. */
  private heard(at: Point) {
    const blur = SEEKER_SENSE.whistleBlur,
      x = at.x + (this.random() * 2 - 1) * blur,
      z = at.z + (this.random() * 2 - 1) * blur,
      upstairs = at.y > 2.5 !== this.random() > 0.7;
    // What it has seen near there (on the floor it thinks) becomes a suspect.
    for (const m of this.memory.values())
      if (m.family !== "body" && !m.cleared && m.y > 2.5 === upstairs && Math.hypot(m.x - x, m.z - z) < SEEKER_SENSE.whistleNear) {
        m.suspicion += SEEKER_SENSE.whistleNudge;
        m.cap = Infinity;
        m.lastSeen = this.time;
      }
    let best = -1,
      bestD = Infinity;
    VIEWPOINTS.forEach((vp, k) => {
      if (vp.y > 2.5 !== upstairs) return;
      const d = Math.hypot(vp.x - x, vp.z - z);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    if (best < 0 || best === this.view) return;
    this.view = best;
    this.lookLeft = 0;
    this.inspecting = null;
    this.walker.reset();
  }
  private nextView(p: Point) {
    const field = this.walker.field(p);
    let best = -1,
      bestScore = Infinity;
    VIEWPOINTS.forEach((vp, k) => {
      const checked = this.checked.get(k),
        age = checked === undefined ? 999 : this.time - checked,
        path = field.dist[this.nav.nodeAt(vp.x, vp.y + 0.78, vp.z)];
      if (!Number.isFinite(path) || age < 8) return;
      // Least recently checked first (unchecked ones most), then the nearest; a little randomness breaks ties.
      const score = path * SEEKER_SENSE.patrolDistance - Math.min(age, 60) * 0.6 - (STRUCTURE_ZONES.includes(vp.zone) ? SEEKER_SENSE.patrolStructure : 0) + this.random() * 3;
      if (score < bestScore) {
        bestScore = score;
        best = k;
      }
    });
    this.view = best < 0 ? Math.floor(this.random() * VIEWPOINTS.length) : best;
    this.walker.reset();
  }
}
/** A standard normal sample (Box–Muller). */
function gauss(random: () => number) {
  const u = Math.max(1e-9, random()),
    v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
