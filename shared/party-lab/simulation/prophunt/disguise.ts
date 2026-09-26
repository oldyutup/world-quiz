import RAPIER from "@dimforge/rapier3d-compat";
import { PROP_FAMILIES, shapeHeight, type PropFamilyId, type PropShape } from "../../maps/propHuntProps.js";
import type { PlayerId } from "../players.js";
import type { Vec } from "../ragdoll/math.js";
import { PROP_HUNT } from "./config.js";

const D = PROP_HUNT.disguise;
const STEP = 1 / 60;
/** A contact normal pointing up less than this is a wall (steeper than the climbable slope). */
const WALL_NORMAL_Y = Math.cos((D.maxSlope * Math.PI) / 180);

/** Rotation about +Y by a body yaw (atan2(x, z): the model's +z turns toward +x). */
export const yawRotation = (angle: number) => ({ x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) });
/** A family's Rapier shape, centred (the body sits `height / 2` below its centre). `shrink` pulls every face in. */
export function propShape(shape: PropShape, shrink = 0): RAPIER.Shape {
  return shape.kind === "box"
    ? new RAPIER.Cuboid(shape.x / 2 - shrink, shape.y / 2 - shrink, shape.z / 2 - shrink)
    : new RAPIER.Cylinder(shape.height / 2 - shrink, shape.radius - shrink);
}
function colliderDesc(shape: PropShape): RAPIER.ColliderDesc {
  const h = shapeHeight(shape) / 2;
  const desc = shape.kind === "box" ? RAPIER.ColliderDesc.cuboid(shape.x / 2, h, shape.z / 2) : RAPIER.ColliderDesc.cylinder(h, shape.radius);
  // The body's origin is the prop's bottom centre (the kit's pivot).
  return desc.setTranslation(0, h, 0).setFriction(0.6).setRestitution(0);
}

/**
 * A disguised hider: no ragdoll, one kinematic body carrying the prop's shape (the same shape
 * as the decoys: it is what other bodies bump into, what the seeker's shot tests, and what the
 * character controller moves). Never a dynamic prop: no tipping, no pushes, no physics
 * explosions; it walks, steps up the lodge's 0.45 m floor, climbs the stair and the lean-to
 * roof, and falls off edges.
 */
export interface Disguise {
  readonly id: PlayerId;
  readonly family: PropFamilyId;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  /** Body yaw (atan2(x, z)). */
  yaw: number;
  vx: number;
  vz: number;
  vy: number;
  grounded: boolean;
  /** Metres moved since it appeared (bots, tests, diagnostics). */
  travelled: number;
}

/**
 * The disguises of one world. `skip(collider, id)` names colliders a player's own shape must
 * ignore (its retired ragdoll's parts, which stay in the scene queries for one step after they
 * are disabled).
 */
export class DisguiseSystem {
  readonly worn: (Disguise | null)[] = [null, null, null];
  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly owner = new Map<number, PlayerId>();

  constructor(
    private readonly world: RAPIER.World,
    private readonly skip: (collider: RAPIER.Collider, id: PlayerId) => boolean
  ) {
    const c = world.createCharacterController(D.skin);
    c.setUp({ x: 0, y: 1, z: 0 });
    c.enableAutostep(D.step, 0.1, false);
    c.enableSnapToGround(0.3);
    c.setMaxSlopeClimbAngle((D.maxSlope * Math.PI) / 180);
    c.setMinSlopeSlideAngle(((D.maxSlope + 10) * Math.PI) / 180);
    c.setApplyImpulsesToDynamicBodies(false);
    c.setSlideEnabled(true);
    this.controller = c;
  }
  /** The player owning a disguise collider (null: not a disguise). */
  ownerOf(handle: number): PlayerId | null {
    return this.owner.get(handle) ?? null;
  }
  /**
   * Whether `family` fits with its bottom at (x, y, z) facing `yaw`: its shape (a hair smaller)
   * overlaps nothing solid — walls, props, other disguises, other bodies.
   */
  fits(id: PlayerId, family: PropFamilyId, x: number, y: number, z: number, yaw: number): boolean {
    const shape = PROP_FAMILIES[family].shape;
    const hit = this.world.intersectionWithShape(
      { x, y: y + shapeHeight(shape) / 2 + 0.01, z },
      yawRotation(yaw),
      propShape(shape, 0.015),
      undefined,
      undefined,
      undefined,
      undefined,
      (collider) => !this.skip(collider, id) && this.ownerOf(collider.handle) !== id
    );
    return hit === null;
  }
  /**
   * Where the shape's bottom comes to rest dropped straight down from `top` at (x, z): the
   * highest solid under its whole footprint (null: nothing within `depth`).
   */
  restingHeight(id: PlayerId, family: PropFamilyId, x: number, z: number, yaw: number, top: number, depth = 2.5): number | null {
    const shape = PROP_FAMILIES[family].shape,
      half = shapeHeight(shape) / 2;
    const hit = this.world.castShape(
      { x, y: top + half, z },
      yawRotation(yaw),
      { x: 0, y: -1, z: 0 },
      propShape(shape, 0.015),
      0,
      depth,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      (collider) => !this.skip(collider, id) && this.ownerOf(collider.handle) !== id
    );
    if (!hit) return null;
    // The cast shape is 0.015 m smaller on every side, so when it touches, the real shape's bottom
    // is 0.015 m below the surface: rest it on the surface instead.
    return top - hit.time_of_impact + 0.015;
  }
  /**
   * A spot for `family` near floor point (x, z) around feet height `feet`: the point itself if
   * the shape fits there, else the nearest fitting point on rings out to `fitSearch` (12
   * directions each); for every candidate the shape settles on whatever is under its whole
   * footprint, and it must fit there without overlapping anything. Null: no room.
   */
  place(id: PlayerId, family: PropFamilyId, x: number, z: number, feet: number, yaw: number): Vec | null {
    const rings = [0, 0.15, 0.3, 0.45, 0.6, 0.75, D.fitSearch];
    for (const r of rings) {
      const n = r === 0 ? 1 : 12;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2,
          px = x + Math.cos(a) * r,
          pz = z + Math.sin(a) * r;
        const y = this.restingHeight(id, family, px, pz, yaw, feet + 0.7);
        if (y === null || Math.abs(y - feet) > 0.75) continue;
        if (this.fits(id, family, px, y + D.skin, pz, yaw)) return { x: px, y: y + D.skin, z: pz };
      }
    }
    return null;
  }
  /** Puts the disguise on (bottom centre at `at`). */
  wear(id: PlayerId, family: PropFamilyId, at: Vec, yaw: number): Disguise {
    this.remove(id);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(at.x, at.y, at.z).setRotation(yawRotation(yaw)));
    const collider = this.world.createCollider(colliderDesc(PROP_FAMILIES[family].shape), body);
    this.owner.set(collider.handle, id);
    const worn: Disguise = { id, family, body, collider, yaw, vx: 0, vz: 0, vy: 0, grounded: true, travelled: 0 };
    this.worn[id] = worn;
    return worn;
  }
  remove(id: PlayerId) {
    const worn = this.worn[id];
    if (!worn) return;
    this.owner.delete(worn.collider.handle);
    this.world.removeRigidBody(worn.body);
    this.worn[id] = null;
  }
  clear() {
    for (let id = 0; id < this.worn.length; id++) this.remove(id as PlayerId);
  }
  /**
   * One step of a disguised hider's movement (before the world steps): `moveX`/`moveZ` is the
   * wanted world direction (length ≤ 1). Eases toward `speed`, turns toward where it goes (only
   * if the turned shape still fits), and moves through the character controller: it slides
   * along walls, steps up ≤ `step`, climbs ≤ `maxSlope` and falls off edges.
   */
  move(id: PlayerId, moveX: number, moveZ: number, mobility = 1) {
    const worn = this.worn[id];
    if (!worn) return;
    const length = Math.hypot(moveX, moveZ),
      k = length > 1 ? 1 / length : 1,
      tx = moveX * k * D.speed * mobility,
      tz = moveZ * k * D.speed * mobility,
      dvx = tx - worn.vx,
      dvz = tz - worn.vz,
      dv = Math.hypot(dvx, dvz),
      limit = D.acceleration * STEP;
    const s = dv > limit ? limit / dv : 1;
    worn.vx += dvx * s;
    worn.vz += dvz * s;
    const p = worn.body.translation();
    if (length > 0.15) {
      const want = Math.atan2(moveX, moveZ),
        delta = Math.atan2(Math.sin(want - worn.yaw), Math.cos(want - worn.yaw)),
        turn = Math.max(-D.turnRate * STEP, Math.min(D.turnRate * STEP, delta)),
        next = worn.yaw + turn;
      if (Math.abs(turn) > 1e-6 && this.fits(id, worn.family, p.x, p.y + 0.01, p.z, next)) {
        worn.yaw = Math.atan2(Math.sin(next), Math.cos(next));
        worn.body.setNextKinematicRotation(yawRotation(worn.yaw));
      }
    }
    worn.vy = worn.grounded ? -1 : Math.max(-15, worn.vy - D.gravity * STEP);
    this.controller.computeColliderMovement(
      worn.collider,
      { x: worn.vx * STEP, y: worn.vy * STEP, z: worn.vz * STEP },
      undefined,
      undefined,
      (collider) => !this.skip(collider, id)
    );
    const m = this.controller.computedMovement();
    worn.grounded = this.controller.computedGrounded();
    // Held up by a wall (anything steeper than a climbable slope): drop the part of the speed
    // going into it, so it slides along at the rest. Slopes and steps keep the speed.
    if (Math.hypot(m.x, m.z) < Math.hypot(worn.vx, worn.vz) * STEP * 0.95)
      for (let i = 0; i < this.controller.numComputedCollisions(); i++) {
        const n = this.controller.computedCollision(i)?.normal1;
        if (!n || n.y >= WALL_NORMAL_Y) continue;
        const h = Math.hypot(n.x, n.z);
        if (h < 1e-6) continue;
        const into = (worn.vx * n.x + worn.vz * n.z) / h;
        if (into < 0) {
          worn.vx -= (into * n.x) / h;
          worn.vz -= (into * n.z) / h;
        }
      }
    worn.travelled += Math.hypot(m.x, m.z);
    worn.body.setNextKinematicTranslation({ x: p.x + m.x, y: p.y + m.y, z: p.z + m.z });
  }
}
