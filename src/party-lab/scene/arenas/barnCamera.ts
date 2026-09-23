import { rampHull, type ArenaCollider, type ArenaMap } from "../../../../shared/party-lab/maps";
import { HUB_HALF, OUTER, WALL_BLOCKS, WALL_THICKNESS, WING_HALF, WINGS } from "../../../../shared/party-lab/maps/barn";
import { SHELL } from "./barnScenery";

export interface Point {
  x: number;
  y: number;
  z: number;
}
const rad = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Barn Shootout third-person chase camera (over the right shoulder). Yaw is the
 * aim/facing direction and orbits the local player; pitch tilts the aim. The boom
 * follows pitch fully downward (looking down from the loft lifts the camera) and
 * partly upward (`boomUpFactor`), so looking up lowers the camera a little and tilts
 * the rest — the body stays in view without the camera diving into the floor.
 * Rooftop keeps its own fixed camera.
 */
export const BARN_CAMERA = {
  fov: 65,
  /** Boom length behind the shoulder point, metres. */
  distance: 4.2,
  /** Orbit pivot above the pelvis: upper chest / shoulders. */
  pivotHeight: 1.05,
  /** Right-shoulder offset. */
  shoulder: 0.45,
  restPitch: rad(10),
  /** Looking up (negative) and down (positive) limits. */
  minPitch: rad(-30),
  maxPitch: rad(35),
  boomUpFactor: 0.6,
  /** Radians per pointer pixel (mouse and trackpad deltas alike). */
  sensitivity: 0.0024,
  /** Pivot smoothing time constants (s): horizontal follows tightly, height eases steps and jumps. */
  followXZ: 0.05,
  followY: 0.12,
  collision: {
    /** Camera sphere radius (sphere cast along the boom) and extra clearance kept from surfaces. */
    radius: 0.22,
    margin: 0.15,
    /** Seconds to ease back out once the obstruction clears (pulling in is immediate). */
    restore: 0.3,
    /**
     * Under a low ceiling a rising boom is lowered, but never below this rise (or the
     * wanted one, if smaller): flatter and the character's head leaves the top of the
     * screen when aiming down. Past it the boom shortens instead.
     */
    ceilingRise: rad(10),
  },
  /**
   * Backed against a wall or cover the boom shortens; the camera then also rises (up
   * to `maxLift` at a zero boom, none from `from` metres) to look over the head instead
   * of through the body.
   */
  crane: { maxLift: 1.0, from: 2.0 },
  /** Own character fades while the boom is shorter than these (m): from opaque to `minOpacity`. */
  fade: { from: 1.2, to: 0.4, minOpacity: 0.25 },
} as const;

export const clampPitch = (pitch: number) => Math.max(BARN_CAMERA.minPitch, Math.min(BARN_CAMERA.maxPitch, pitch));
/** Unit aim/look direction; yaw uses the body's facing convention atan2(x, z), pitch > 0 looks down. */
export function aimDirection(yaw: number, pitch: number, out: Point = { x: 0, y: 0, z: 0 }): Point {
  out.x = Math.sin(yaw) * Math.cos(pitch);
  out.y = -Math.sin(pitch);
  out.z = Math.cos(yaw) * Math.cos(pitch);
  return out;
}
/** Screen-right on the floor plane for a yaw. */
export const cameraRight = (yaw: number): Point => ({ x: -Math.cos(yaw), y: 0, z: Math.sin(yaw) });

/**
 * Camera-relative movement: `x` is the strafe axis (D = +1), `z` the device's
 * back axis (W = −1, as on the rooftop). Returns a world-space floor direction.
 */
export function cameraRelativeMove(x: number, z: number, yaw: number) {
  const forward = -z,
    right = cameraRight(yaw);
  return { x: Math.sin(yaw) * forward + right.x * x, z: Math.cos(yaw) * forward + right.z * x };
}

// ─── Collision ─────────────────────────────────────────────────────────────

/** Convex solid as outward half-spaces n·p ≤ d. */
interface Convex {
  planes: { n: Point; d: number }[];
  label: string;
}
const plane = (n: Point, p: Point) => {
  const l = Math.hypot(n.x, n.y, n.z);
  const u = { x: n.x / l, y: n.y / l, z: n.z / l };
  return { n: u, d: u.x * p.x + u.y * p.y + u.z * p.z };
};
function box(label: string, min: Point, max: Point): Convex {
  return {
    label,
    planes: [
      plane({ x: 1, y: 0, z: 0 }, max),
      plane({ x: -1, y: 0, z: 0 }, min),
      plane({ x: 0, y: 1, z: 0 }, max),
      plane({ x: 0, y: -1, z: 0 }, min),
      plane({ x: 0, y: 0, z: 1 }, max),
      plane({ x: 0, y: 0, z: -1 }, min),
    ],
  };
}
function fromCollider(c: ArenaCollider): Convex {
  if (c.shape === "box")
    return box(c.role, { x: c.center.x - c.half.x, y: c.center.y - c.half.y, z: c.center.z - c.half.z }, { x: c.center.x + c.half.x, y: c.center.y + c.half.y, z: c.center.z + c.half.z });
  if (c.shape === "cylinder") {
    // Octagonal prism around the cylinder.
    const planes = [plane({ x: 0, y: 1, z: 0 }, { x: 0, y: c.center.y + c.halfHeight, z: 0 }), plane({ x: 0, y: -1, z: 0 }, { x: 0, y: c.center.y - c.halfHeight, z: 0 })];
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4,
        n = { x: Math.cos(a), y: 0, z: Math.sin(a) };
      planes.push(plane(n, { x: c.center.x + n.x * c.radius, y: 0, z: c.center.z + n.z * c.radius }));
    }
    return { label: c.role, planes };
  }
  // Ramp wedge: bottom, the two ends/sides of its bounding box and the slope.
  const hull = rampHull(c),
    lo = { x: c.center.x - c.half.x, y: c.center.y - c.half.y, z: c.center.z - c.half.z },
    hi = { x: c.center.x + c.half.x, y: c.center.y + c.half.y, z: c.center.z + c.half.z };
  const b = box(c.role, lo, hi).planes.filter((p) => p.n.y <= 0); // drop the flat top
  const raised = hull.filter((p) => Math.abs(p.y - hi.y) < 1e-9),
    low = hull.filter((p) => Math.abs(p.y - lo.y) < 1e-9 && !raised.some((r) => r.x === p.x && r.z === p.z));
  // Slope through a raised edge point and a low edge point, normal pointing up/outward.
  const r = raised[0],
    l = low[0],
    along = { x: l.x - r.x, y: l.y - r.y, z: l.z - r.z },
    side = c.rises.endsWith("x") ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  let n = { x: along.y * side.z - along.z * side.y, y: along.z * side.x - along.x * side.z, z: along.x * side.y - along.y * side.x };
  if (n.y < 0) n = { x: -n.x, y: -n.y, z: -n.z };
  return { label: c.role, planes: [...b, plane(n, r)] };
}

/**
 * Everything the camera must stay out of: every shared gameplay collider plus
 * camera-only solids for the visual shell — the wall mass outside the cross carried
 * up to the roof, each wing's gable roof (two slopes, filled above), and a flat cap
 * at the hub's eave (its pyramid roof is higher still).
 */
export function barnCameraBlockers(map: ArenaMap): Convex[] {
  const out = map.colliders.map(fromCollider);
  const t = WALL_THICKNESS,
    top = SHELL.hubPeak + 2;
  for (const w of WALL_BLOCKS) out.push(box("shell-wall", { x: w.x[0], y: 0, z: w.z[0] }, { x: w.x[1], y: top, z: w.z[1] }));
  out.push(box("roof-hub", { x: -HUB_HALF - t, y: SHELL.hubEave, z: -HUB_HALF - t }, { x: HUB_HALF + t, y: top, z: HUB_HALF + t }));
  // Gable roofs: the ridge runs along each wing; each slope rises from the eave (wall top) to it.
  for (const [id, wing] of Object.entries(WINGS)) {
    const alongZ = id === "N" || id === "S";
    const along = alongZ ? wing.z : wing.x,
      lo = along[0] === -OUTER ? along[0] - t : along[0],
      hi = along[1] === OUTER ? along[1] + t : along[1];
    for (const side of [-1, 1]) {
      // Across-coordinate c: eave at c = side·WING_HALF, ridge at c = 0. Outward normal points down, into the wing.
      const across = (c: number, y: number, a: number): Point => (alongZ ? { x: c, y, z: a } : { x: a, y, z: c });
      const eave = across(side * WING_HALF, SHELL.wingEave, 0),
        rise = SHELL.wingRidge - SHELL.wingEave;
      const n = across(-side * rise, -WING_HALF, 0);
      const cMin = side > 0 ? 0 : -WING_HALF - t,
        cMax = side > 0 ? WING_HALF + t : 0;
      out.push({
        label: "roof-wing",
        planes: [
          plane(n, eave),
          plane(across(1, 0, 0), across(cMax, 0, 0)),
          plane(across(-1, 0, 0), across(cMin, 0, 0)),
          plane(across(0, 0, 1), across(0, 0, hi)),
          plane(across(0, 0, -1), across(0, 0, lo)),
          plane({ x: 0, y: 1, z: 0 }, { x: 0, y: top, z: 0 }),
        ],
      });
    }
  }
  return out;
}

const INSIDE = -1;
/** Cyrus–Beck entry distance into a convex solid grown by `inflate` (null: missed; INSIDE: origin inside). */
function entry(b: Convex, o: Point, dir: Point, inflate: number): number | null {
  let enter = -Infinity,
    exit = Infinity,
    inside = true;
  for (const { n, d } of b.planes) {
    const denom = n.x * dir.x + n.y * dir.y + n.z * dir.z,
      dist = d + inflate - (n.x * o.x + n.y * o.y + n.z * o.z);
    if (dist < 0) inside = false;
    if (Math.abs(denom) < 1e-12) {
      if (dist < 0) return null;
      continue;
    }
    const t = dist / denom;
    if (denom < 0) enter = Math.max(enter, t);
    else exit = Math.min(exit, t);
    if (enter > exit) return null;
  }
  return inside ? INSIDE : enter;
}

/**
 * Distance along a unit ray to the first blocker it enters, treating the ray as a
 * sphere of `radius` (solids are grown by it — conservative at edges and corners).
 * A solid whose grown shape already contains the origin is tested unexpanded, and
 * one containing the origin outright is ignored.
 */
export function castBlockers(blockers: readonly Convex[], o: Point, dir: Point, max: number, radius = 0) {
  let best = max;
  for (const b of blockers) {
    let t = entry(b, o, dir, radius);
    if (t === INSIDE && radius > 0) t = entry(b, o, dir, 0);
    if (t === null || t === INSIDE) continue;
    if (t >= 0 && t < best) best = t;
  }
  return best;
}
/** Whether a point lies inside any blocker grown by `radius`. */
export function insideBlockers(blockers: readonly Convex[], p: Point, radius = 0) {
  return blockers.some((b) => b.planes.every(({ n, d }) => n.x * p.x + n.y * p.y + n.z * p.z <= d + radius));
}

export interface ChaseCamera {
  pivot: Point;
  /** Shoulder point after its own collision check. */
  shoulder: Point;
  position: Point;
  /** Current (collided, eased) and unobstructed boom lengths. */
  boom: number;
  desiredBoom: number;
  /** Crane rise above the boom's end (collision-checked). */
  lift: number;
  look: Point;
  /** Direction the boom actually took (lowered toward level under a low ceiling). */
  boomDir: Point;
}

/** Where the boom points (from the shoulder toward the camera) for a yaw/pitch. */
export function boomDirection(yaw: number, pitch: number): Point {
  const p = pitch < 0 ? pitch * BARN_CAMERA.boomUpFactor : pitch;
  const d = aimDirection(yaw, p);
  return { x: -d.x, y: -d.y, z: -d.z };
}

/**
 * One camera update: pivot (smoothed pelvis + pivot height), shoulder offset with
 * its own clearance check, then a sphere cast along the boom. Pulling in is
 * immediate (never shows through geometry); easing back out takes
 * `collision.restore` seconds. Under a low ceiling (a deck overhead, the roof near
 * the eaves) a rising boom first keeps its length and drops toward level — only the
 * camera height changes, the aim does not — before it is pulled in.
 */
export function updateChaseCamera(
  blockers: readonly Convex[],
  pivot: Point,
  yaw: number,
  pitch: number,
  previousBoom: number | null,
  dt: number
): ChaseCamera {
  const c = BARN_CAMERA.collision;
  const right = cameraRight(yaw);
  const shoulderRoom = castBlockers(blockers, pivot, right, BARN_CAMERA.shoulder + c.margin, c.radius) - c.margin;
  const offset = Math.max(0, Math.min(BARN_CAMERA.shoulder, shoulderRoom));
  const shoulder = { x: pivot.x + right.x * offset, y: pivot.y, z: pivot.z + right.z * offset };
  const full = BARN_CAMERA.distance + c.margin;
  const cast = (d: Point) => castBlockers(blockers, shoulder, d, full, c.radius);
  let dir = boomDirection(yaw, pitch),
    free = cast(dir);
  if (dir.y > 0 && free < full) {
    const h = Math.hypot(dir.x, dir.z),
      fx = dir.x / h,
      fz = dir.z / h,
      wanted = Math.asin(Math.min(1, dir.y)),
      tilt = (e: number) => ({ x: fx * Math.cos(e), y: Math.sin(e), z: fz * Math.cos(e) }),
      lowest = tilt(Math.min(wanted, c.ceilingRise)),
      lowestFree = cast(lowest);
    if (lowestFree > free) {
      dir = lowest;
      free = lowestFree;
      if (lowestFree >= full) {
        // Highest elevation that still fits; bisection keeps it continuous as the player moves.
        let lo = Math.min(wanted, c.ceilingRise),
          hi = wanted;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2,
            d = tilt(mid),
            f = cast(d);
          if (f >= full) {
            lo = mid;
            dir = d;
            free = f;
          } else hi = mid;
        }
      }
    }
  }
  // In a tight spot the boom may shrink to the shoulder itself (the body fades) rather than enter geometry.
  let desiredBoom = Math.max(0, Math.min(BARN_CAMERA.distance, free - c.margin));
  const at = (length: number) => ({ x: shoulder.x + dir.x * length, y: shoulder.y + dir.y * length, z: shoulder.z + dir.z * length });
  // Corners the grown solids miss: step in until the camera sphere is clear.
  while (desiredBoom > 0 && insideBlockers(blockers, at(desiredBoom), c.radius * 0.75)) desiredBoom = Math.max(0, desiredBoom - 0.05);
  const boom =
    previousBoom === null || desiredBoom <= previousBoom
      ? desiredBoom
      : previousBoom + (desiredBoom - previousBoom) * (1 - Math.exp(-Math.min(dt, 0.1) / c.restore));
  const end = at(boom),
    { maxLift, from } = BARN_CAMERA.crane;
  const wanted = maxLift * Math.max(0, Math.min(1, (from - boom) / from));
  let lift = wanted > 0 ? Math.max(0, Math.min(wanted, castBlockers(blockers, end, { x: 0, y: 1, z: 0 }, wanted + c.margin, c.radius) - c.margin)) : 0;
  while (lift > 0 && insideBlockers(blockers, { x: end.x, y: end.y + lift, z: end.z }, c.radius * 0.75)) lift = Math.max(0, lift - 0.05);
  return { pivot, shoulder, position: { x: end.x, y: end.y + lift, z: end.z }, boom, desiredBoom, lift, look: aimDirection(yaw, pitch), boomDir: dir };
}

/** Local-character opacity for a boom length (fades when the camera is pressed against it). */
export function ownCharacterOpacity(boom: number) {
  const { from, to, minOpacity } = BARN_CAMERA.fade;
  const k = Math.max(0, Math.min(1, (boom - to) / (from - to)));
  return minOpacity + (1 - minOpacity) * k;
}

/** Exponential smoothing factor for a time constant. */
export const smoothing = (dt: number, tau: number) => 1 - Math.exp(-Math.min(dt, 0.1) / tau);
