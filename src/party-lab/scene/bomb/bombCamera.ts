import { BOMB_ARENA, BOMB_MAP, surfaceBelow } from "../../../../shared/party-lab/maps/bomb";
import type { ArenaCollider } from "../../../../shared/party-lab/maps/types";
import { castBlockers, colliderBlockers, insideBlockers } from "../arenas/barnCamera";
import { boomDirection, type Point } from "../layers/layerCamera";

const rad = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Bomba Sende's third-person chase camera: centred on the character, a little farther and
 * higher than Katman Kaosu's so the small arena reads around the player (who is where, where
 * the bomb is), looking ~30° down. Mouse/trackpad orbit (Pointer Lock or drag, as in the other
 * modes); WASD camera-relative; the body turns toward where it walks. Sprinting eases the view
 * out a little (a longer boom, a few degrees of FOV); a jump barely lifts it.
 */
export const BOMB_CAMERA = {
  /** Vertical field of view (°), and how much a full sprint adds. */
  fov: 60,
  sprintFov: 3,
  boom: 6.4,
  /** Extra boom (m) at a full sprint. */
  sprintBoom: 0.7,
  /** Seconds for the sprint widening to ease in or out. */
  sprintEase: 0.6,
  /** Orbit pivot above the standing pelvis (m). */
  pivotHeight: 1.0,
  restPitch: rad(30),
  minPitch: rad(20),
  maxPitch: rad(50),
  /** Radians per pointer pixel (the other modes'). */
  sensitivity: 0.0024,
  /** Pivot smoothing (s): horizontal; vertical, per stage of two cascaded stages. */
  followXZ: 0.07,
  followY: 0.08,
  /** A jump lifts the view only by this share of the pelvis rise. */
  jumpShare: 0.2,
  /** Standing pelvis height over the surface (m). */
  stand: 0.78,
  /** Pivot smoothing (s) for a while after the followed character changes (spectating). */
  switchFollow: 0.25,
  collision: {
    /** Camera sphere radius and extra clearance (m). */
    radius: 0.25,
    margin: 0.15,
    /** Seconds to ease back out once clear (pulling in is immediate). */
    restore: 0.35,
  },
  /** Own character fades while the boom is shorter than these (m). */
  fade: { from: 1.6, to: 0.6, minOpacity: 0.3 },
} as const;

export const clampBombPitch = (pitch: number) => Math.max(BOMB_CAMERA.minPitch, Math.min(BOMB_CAMERA.maxPitch, pitch));

/**
 * What the camera stays out of: every collider except the floor, with the perimeter cut to
 * its brick parapet — the glass guard above it is see-through, so the camera may pass over
 * the parapet (outside the playground) instead of being pulled in against every wall.
 */
export function bombCameraBlockers() {
  const solids: ArenaCollider[] = BOMB_MAP.colliders
    .filter((c) => c.role !== "floor")
    .map((c) => {
      if (c.role !== "parapet" || c.shape !== "box") return c;
      const brick = BOMB_ARENA.wall.brick;
      return { ...c, center: { ...c.center, y: brick / 2 }, half: { ...c.half, y: brick / 2 } };
    });
  return colliderBlockers(solids);
}
export type BombBlockers = ReturnType<typeof bombCameraBlockers>;

/**
 * The orbit pivot per rendered frame. It rides at standing height over the surface the body
 * last stood on (floor, deck, a top) and follows only `jumpShare` of the pelvis above that,
 * so jumps and the gap shortcuts keep a steady frame; stepping or dropping to another level
 * eases through two stages (no jolt).
 */
export class BombFollow {
  pivot: Point | null = null;
  /** Seconds of `switchFollow` smoothing left after the followed character changes. */
  blend = 0;
  /** Surface the followed body stands on (kept through a jump). */
  ground = 0;
  private lift = 0;
  reset() {
    this.pivot = null;
    this.blend = 0;
    this.ground = 0;
  }
  update(pelvis: Point, vy: number, dt: number): Point {
    const smooth = (tau: number) => 1 - Math.exp(-Math.min(dt, 0.1) / tau);
    const { stand, jumpShare, pivotHeight } = BOMB_CAMERA;
    const below = surfaceBelow(pelvis.x, pelvis.z, pelvis.y - 0.4);
    if (Number.isFinite(below) && pelvis.y - below < stand + 0.3 && Math.abs(vy) < 1.5) this.ground = below;
    else if (pelvis.y - stand < this.ground - 0.2) this.ground = pelvis.y - stand;
    const height = this.ground + stand + Math.max(-0.3, pelvis.y - this.ground - stand) * jumpShare;
    const target = { x: pelvis.x, y: height + pivotHeight, z: pelvis.z };
    if (!this.pivot) {
      this.pivot = target;
      this.lift = target.y;
      return this.pivot;
    }
    this.blend = Math.max(0, this.blend - dt);
    const switching = this.blend > 0,
      kxz = smooth(switching ? BOMB_CAMERA.switchFollow : BOMB_CAMERA.followXZ);
    this.pivot.x += (target.x - this.pivot.x) * kxz;
    this.pivot.z += (target.z - this.pivot.z) * kxz;
    if (switching) {
      this.lift = target.y;
      this.pivot.y += (target.y - this.pivot.y) * smooth(BOMB_CAMERA.switchFollow);
    } else {
      const ky = smooth(BOMB_CAMERA.followY);
      this.lift += (target.y - this.lift) * ky;
      this.pivot.y += (this.lift - this.pivot.y) * ky;
    }
    return this.pivot;
  }
}

export interface BombCameraPose {
  position: Point;
  boom: number;
  /** The unobstructed boom length for this frame. */
  free: number;
}
/**
 * Camera position for a pivot, yaw, pitch and sprint share (0…1): a sphere cast along the
 * boom against the blockers; pulling in is immediate, easing back out takes
 * `collision.restore` s (`state.boom` carries it between frames).
 */
export function bombCameraPose(blockers: BombBlockers, pivot: Point, yaw: number, pitch: number, sprint: number, state: { boom: number | null }, dt: number): BombCameraPose {
  const { radius, margin, restore } = BOMB_CAMERA.collision;
  const wanted = BOMB_CAMERA.boom + BOMB_CAMERA.sprintBoom * sprint;
  const dir = boomDirection(yaw, clampBombPitch(pitch));
  const free = castBlockers(blockers, pivot, dir, wanted + margin, radius);
  let target = Math.max(0, Math.min(wanted, free - margin));
  const at = (length: number) => ({ x: pivot.x + dir.x * length, y: pivot.y + dir.y * length, z: pivot.z + dir.z * length });
  // Corners the grown solids miss: step in until the camera sphere is clear.
  while (target > 0 && insideBlockers(blockers, at(target), radius * 0.75)) target = Math.max(0, target - 0.05);
  const boom = state.boom === null || target <= state.boom ? target : state.boom + (target - state.boom) * (1 - Math.exp(-Math.min(dt, 0.1) / restore));
  state.boom = boom;
  return { position: at(boom), boom, free };
}

/** Local-character opacity for a boom length (fades when the camera is pressed against it). */
export function bombOwnOpacity(boom: number) {
  const { from, to, minOpacity } = BOMB_CAMERA.fade;
  const k = Math.max(0, Math.min(1, (boom - to) / (from - to)));
  return minOpacity + (1 - minOpacity) * k;
}
