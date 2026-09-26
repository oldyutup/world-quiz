import { LODGE, PAVILION, PROP_HUNT_MAP, SHED, surfaceBelow, type PropRole } from "../../../../shared/party-lab/maps/propHunt";
import type { ArenaCollider } from "../../../../shared/party-lab/maps/types";
import { PROP_HUNT } from "../../../../shared/party-lab/simulation/prophunt/config";
import { aimDirection, rightOf } from "../../../../shared/party-lab/simulation/prophunt/aim";
import { castBlockers, colliderBlockers, insideBlockers } from "../arenas/barnCamera";

export interface Point {
  x: number;
  y: number;
  z: number;
}
const rad = (degrees: number) => (degrees * Math.PI) / 180;

/** Per-role view: the seeker's is a shoulder camera (the crosshair line), the hider's centred and a little wider. */
export interface ViewTuning {
  readonly fov: number;
  readonly boom: number;
  /** Pivot above the pelvis (a disguise: above the prop's middle, see `disguisePivot`). */
  readonly pivotHeight: number;
  /** Right-shoulder offset (m); 0 centres the character. */
  readonly shoulder: number;
  readonly restPitch: number;
  readonly minPitch: number;
  readonly maxPitch: number;
}
/**
 * Saklambaç's third-person cameras. Mouse/trackpad orbit (Pointer Lock or drag), WASD
 * camera-relative. The seeker's body faces its aim (strafe); a hider turns toward where it
 * walks. Collision is the Barn's: a sphere cast along the boom against every collider plus
 * the roofs and ceilings (camera-only solids); under a low ceiling (the kitchen under the
 * loft, the loft itself) a rising boom first flattens toward level, then shortens. Pulling in
 * is immediate; easing out takes `collision.restore` s.
 */
export const PROP_CAMERA = {
  seeker: { fov: 60, boom: 4.8, pivotHeight: PROP_HUNT.aim.pivotHeight, shoulder: PROP_HUNT.aim.shoulder, restPitch: rad(22), minPitch: rad(-20), maxPitch: rad(55) },
  hider: { fov: 62, boom: 5.4, pivotHeight: 0.95, shoulder: 0, restPitch: rad(26), minPitch: rad(6), maxPitch: rad(60) },
  /** Looking up lowers the camera by this share of the pitch (the rest tilts). */
  boomUpFactor: 0.6,
  /** Radians per pointer pixel (the other modes'). */
  sensitivity: 0.0024,
  /** Pivot smoothing time constants (s). */
  followXZ: 0.05,
  followY: 0.1,
  collision: { radius: 0.22, margin: 0.15, restore: 0.3, ceilingRise: rad(8) },
  /** Own body (or disguise) fades while the boom is shorter than these (m). */
  fade: { from: 1.3, to: 0.45, minOpacity: 0.25 },
  /**
   * The seeker's optional first-person view (V, or the Esc menu): the camera at eye height
   * (`eye` above the feet, `forward` m ahead of the body's axis along the view), a wider FOV,
   * more room to look up at the loft and down at the floor. The same aim and the same shot as
   * the shoulder camera: only the view changes (the shot still leaves the torso, see aim.ts).
   * The eye rides the body's height (smoothed over `followY` s, no head bob), never enters a
   * wall (`radius` from every solid, pulled back toward the chest if it would).
   */
  firstPerson: { fov: 70, boom: 0, pivotHeight: 0.9, shoulder: 0, restPitch: rad(8), minPitch: rad(-60), maxPitch: rad(65), eye: 1.68, forward: 0.12, followY: 0.05, radius: 0.12 },
} as const;
/** The seeker's two views (the hiders only ever have the third-person one). */
export type SeekerView = "third" | "first";
/** The key that swaps the seeker's view (unless a gameplay action is bound to it). */
export const VIEW_KEY = "KeyV";
/** The view a player's camera uses: first person only ever for the seeker. */
export const activeView = (view: SeekerView, role: PropRole): SeekerView => (role === "seeker" ? view : "third");
/** What V asks for: the seeker's other view; a hider has only one (nothing changes). */
export const toggledView = (view: SeekerView, role: PropRole): SeekerView => (role !== "seeker" ? view : view === "first" ? "third" : "first");
/**
 * Body parts the local seeker does not draw in first person: the camera is inside the head, the
 * chest sits just under it, and the arms and the round pelvis would hang in the view as blobs
 * when looking down. Only the legs stay (the feet under you); nobody else's body is touched.
 */
export const FIRST_PERSON_HIDDEN = ["head", "torso", "pelvis", "leftUpper", "rightUpper", "leftHand", "rightHand"] as const;

export const clampPitch = (view: ViewTuning, pitch: number) => Math.max(view.minPitch, Math.min(view.maxPitch, pitch));
/** A disguise's orbit pivot above its bottom: over the prop, so a small one sits low in the frame and a tall one fits. */
export const disguisePivot = (height: number) => Math.min(1.6, height * 0.75 + 0.35);

/**
 * What the camera stays out of: every collider except the ground and the invisible boundary
 * (near an edge the boom reaches out over the fence line, where the forest keeps its distance:
 * TREE_CLEARANCE), glass included (the boom never slips out through a window), plus
 * camera-only solids: the space under the lodge's and shed's gable roofs (their flat ceilings
 * are at the wall tops) and the pavilion's gable over its roof slab.
 */
export function propCameraBlockers(decoys: readonly ArenaCollider[] = []) {
  const solids: ArenaCollider[] = [...PROP_HUNT_MAP.colliders, ...decoys].filter((c) => c.role !== "floor" && c.role !== "boundary");
  const box = (role: ArenaCollider["role"], [x0, x1]: readonly [number, number], [y0, y1]: readonly [number, number], [z0, z1]: readonly [number, number]): ArenaCollider => ({
    role,
    shape: "box",
    center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2 },
    half: { x: (x1 - x0) / 2, y: (y1 - y0) / 2, z: (z1 - z0) / 2 },
  });
  solids.push(box("roof", LODGE.x, [LODGE.wallTop, LODGE.ridge + 1], LODGE.z));
  solids.push(box("roof", SHED.x, [SHED.wallTop, SHED.ridge + 1], SHED.z));
  // The pavilion's gable above its roof slab.
  solids.push(box("roof", [PAVILION.x[0] - PAVILION.overhang, PAVILION.x[1] + PAVILION.overhang], [PAVILION.eave, PAVILION.ridge], [PAVILION.z[0] - PAVILION.overhang, PAVILION.z[1] + PAVILION.overhang]));
  return colliderBlockers(solids);
}
export type PropBlockers = ReturnType<typeof propCameraBlockers>;

/**
 * The orbit pivot per rendered frame: horizontal follows tightly; height rides the surface
 * the body last stood on (a jump lifts the view only a little), easing on steps and drops.
 */
export class PropFollow {
  pivot: Point | null = null;
  /** Seconds of quick re-targeting left after the followed body changes (spectating). */
  blend = 0;
  /** The round's decoy colliders (a body standing on a crate rides its top). */
  decoys: readonly ArenaCollider[] = [];
  private ground = 0;
  reset() {
    this.pivot = null;
    this.blend = 0;
    this.ground = 0;
  }
  /**
   * `feet` the body's standing height (pelvis − 0.78, or a disguise's bottom), `lift` the pivot
   * above it. `firstPerson`: the eye follows the body's own height (a jump lifts it all the
   * way) over a shorter time constant, instead of riding the surface below.
   */
  update(x: number, feet: number, z: number, lift: number, airborne: boolean, dt: number, firstPerson = false): Point {
    const smooth = (tau: number) => 1 - Math.exp(-Math.min(dt, 0.1) / tau);
    const below = surfaceBelow(x, z, feet + 0.3, this.decoys);
    if (!airborne && Number.isFinite(below)) this.ground = below;
    else if (feet < this.ground - 0.2) this.ground = feet;
    const height = firstPerson ? feet + lift : this.ground + Math.max(-0.3, feet - this.ground) * 0.25 + lift;
    const target = { x, y: height, z };
    if (!this.pivot) return (this.pivot = target);
    this.blend = Math.max(0, this.blend - dt);
    const kxz = smooth(this.blend > 0 ? 0.2 : PROP_CAMERA.followXZ),
      ky = smooth(this.blend > 0 ? 0.2 : firstPerson ? PROP_CAMERA.firstPerson.followY : PROP_CAMERA.followY);
    this.pivot.x += (target.x - this.pivot.x) * kxz;
    this.pivot.z += (target.z - this.pivot.z) * kxz;
    this.pivot.y += (target.y - this.pivot.y) * ky;
    return this.pivot;
  }
}

export interface PropCameraPose {
  position: Point;
  /** Where the camera looks (unit). */
  look: Point;
  /** The shoulder point the aim line passes through. */
  shoulder: Point;
  boom: number;
  free: number;
}
/** Where the boom points from the shoulder toward the camera. */
export function boomDirection(yaw: number, pitch: number): Point {
  const d = aimDirection(yaw, pitch < 0 ? pitch * PROP_CAMERA.boomUpFactor : pitch);
  return { x: -d.x, y: -d.y, z: -d.z };
}
/**
 * One camera update for a pivot, yaw and pitch: the shoulder offset (checked against walls),
 * then a sphere cast along the boom. Under a low ceiling a rising boom flattens toward
 * `ceilingRise` before it is pulled in. `state.boom` carries the eased length between frames.
 */
export function propCameraPose(blockers: PropBlockers, view: ViewTuning, boomLength: number, pivot: Point, yaw: number, pitch: number, state: { boom: number | null }, dt: number): PropCameraPose {
  const c = PROP_CAMERA.collision,
    right = rightOf(yaw);
  const room = view.shoulder > 0 ? castBlockers(blockers, pivot, right, view.shoulder + c.margin, c.radius) - c.margin : 0;
  const offset = Math.max(0, Math.min(view.shoulder, room));
  const shoulder = { x: pivot.x + right.x * offset, y: pivot.y, z: pivot.z + right.z * offset };
  const full = boomLength + c.margin;
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
  let target = Math.max(0, Math.min(boomLength, free - c.margin));
  const at = (length: number) => ({ x: shoulder.x + dir.x * length, y: shoulder.y + dir.y * length, z: shoulder.z + dir.z * length });
  while (target > 0 && insideBlockers(blockers, at(target), c.radius * 0.75)) target = Math.max(0, target - 0.05);
  const boom = state.boom === null || target <= state.boom ? target : state.boom + (target - state.boom) * (1 - Math.exp(-Math.min(dt, 0.1) / c.restore));
  state.boom = boom;
  return { position: at(boom), look: aimDirection(yaw, pitch), shoulder, boom, free };
}

/**
 * The seeker's first-person camera: at the eye (`eye`, the smoothed eye point over the body's
 * axis), `forward` m ahead along the view, looking along the aim. It never sits in a wall, a
 * window, a roof or a prop: the line from the chest (`chest`, inside the body, which the physics
 * keeps out of every solid) to the eye is swept with a `radius` sphere and the eye stops short
 * of whatever it meets. The aim line starts at the camera itself (`shoulder` is the eye).
 */
export function propFirstPersonPose(blockers: PropBlockers, eye: Point, chest: Point, yaw: number, pitch: number): PropCameraPose {
  const f = PROP_CAMERA.firstPerson,
    want = { x: eye.x + Math.sin(yaw) * f.forward, y: eye.y, z: eye.z + Math.cos(yaw) * f.forward };
  const dx = want.x - chest.x,
    dy = want.y - chest.y,
    dz = want.z - chest.z,
    length = Math.hypot(dx, dy, dz);
  let position = want,
    free = length;
  if (length > 1e-6) {
    const dir = { x: dx / length, y: dy / length, z: dz / length };
    free = castBlockers(blockers, chest, dir, length + 0.02, f.radius);
    if (free < length + 0.02) {
      const d = Math.max(0, free - 0.02);
      position = { x: chest.x + dir.x * d, y: chest.y + dir.y * d, z: chest.z + dir.z * d };
    }
  }
  return { position, look: aimDirection(yaw, pitch), shoulder: position, boom: 0, free };
}

/** Own body / disguise opacity for a boom length (fades when the camera is pressed against it). */
export function ownOpacity(boom: number) {
  const { from, to, minOpacity } = PROP_CAMERA.fade;
  const k = Math.max(0, Math.min(1, (boom - to) / (from - to)));
  return minOpacity + (1 - minOpacity) * k;
}
