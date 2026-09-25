import { boomDirection, type Point } from "../layers/layerCamera";

const rad = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Renk Kaosu's elevated third-person chase camera: centred on the character (no shoulder
 * offset), a little lower and closer than Katman Kaosu's (one floor, nothing overhead, so
 * no collision is needed: the pitch never lets it dip under the field). Mouse/trackpad
 * orbit; WASD camera-relative; the body turns toward where it walks.
 */
export const COLOR_CAMERA = {
  /** Vertical field of view (°). */
  fov: 60,
  boom: 5.3,
  /** Orbit pivot above the pelvis (m). */
  pivotHeight: 0.9,
  restPitch: rad(28),
  minPitch: rad(12),
  maxPitch: rad(60),
  /** Radians per pointer pixel (Barn's and Katman Kaosu's). */
  sensitivity: 0.0024,
  /** Pivot smoothing (s): horizontal; vertical (two cascaded stages, no jolt at take-off or landing). */
  followXZ: 0.06,
  followY: 0.06,
  /** Falling through a hole, the pivot follows the pelvis closely … */
  followFall: 0.03,
  /**
   * … but never below standing height (m): the camera stays at its height over the field and
   * looks down through the hole at the body dropping away (`fallLook`).
   */
  lowestPivot: 1.68,
  /** A jump lifts the view only by this share of the pelvis rise (a steady frame). */
  jumpShare: 0.15,
  /** Standing pelvis height over the field (m). */
  stand: 0.78,
  /** Falling, look this share of the way down toward the body (at most `max` m). */
  fallLook: { share: 0.5, max: 3.5, seconds: 0.2 },
  /** Pivot smoothing (s) for a while after the followed character changes. */
  switchFollow: 0.2,
} as const;

export const clampColorPitch = (pitch: number) => Math.max(COLOR_CAMERA.minPitch, Math.min(COLOR_CAMERA.maxPitch, pitch));

/**
 * Falling through the field (camera and spectating only; physics decides elimination):
 * the pelvis has sunk well below standing height while descending — a hole under it or
 * off the rim. A jump never gets there (its lowest point is the landing, ≈ standing).
 */
export const COLOR_FALL = { below: 0.35, descend: 1, rest: 0.5, recovered: 0.6 } as const;
export class ColorFall {
  falling = false;
  reset() {
    this.falling = false;
  }
  update(y: number, vy: number) {
    if (!this.falling) this.falling = y < COLOR_FALL.below && vy < -COLOR_FALL.descend;
    // Caught a tile's edge and climbed back up.
    else if (y > COLOR_FALL.recovered && Math.abs(vy) < COLOR_FALL.rest) this.falling = false;
    return this.falling;
  }
}

/** The orbit pivot (and how far below it the camera looks) per rendered frame. */
export class ColorFollow {
  pivot: Point | null = null;
  lookDrop = 0;
  /** Seconds of `switchFollow` smoothing left after the followed character changes. */
  blend = 0;
  private lift = 0;
  reset() {
    this.pivot = null;
    this.lookDrop = 0;
    this.blend = 0;
  }
  update(pelvis: Point, falling: boolean, dt: number): Point {
    const smooth = (tau: number) => 1 - Math.exp(-Math.min(dt, 0.1) / tau);
    const { stand, jumpShare, pivotHeight, lowestPivot } = COLOR_CAMERA;
    const height = falling ? pelvis.y : stand + Math.max(-0.3, pelvis.y - stand) * jumpShare;
    const target = { x: pelvis.x, y: Math.max(lowestPivot, height + pivotHeight), z: pelvis.z };
    if (!this.pivot) {
      this.pivot = target;
      this.lift = target.y;
    } else {
      this.blend = Math.max(0, this.blend - dt);
      const kxz = smooth(this.blend > 0 ? COLOR_CAMERA.switchFollow : COLOR_CAMERA.followXZ);
      this.pivot.x += (target.x - this.pivot.x) * kxz;
      this.pivot.z += (target.z - this.pivot.z) * kxz;
      if (this.blend > 0 || falling) {
        this.lift = target.y;
        this.pivot.y += (target.y - this.pivot.y) * smooth(this.blend > 0 ? COLOR_CAMERA.switchFollow : COLOR_CAMERA.followFall);
      } else {
        const ky = smooth(COLOR_CAMERA.followY);
        this.lift += (target.y - this.lift) * ky;
        this.pivot.y += (this.lift - this.pivot.y) * ky;
      }
    }
    const { share, max, seconds } = COLOR_CAMERA.fallLook;
    const drop = falling ? Math.min(max, Math.max(0, this.pivot.y - pivotHeight - pelvis.y) * share) : 0;
    this.lookDrop += (drop - this.lookDrop) * smooth(seconds);
    return this.pivot;
  }
}

/** Camera position for a pivot, orbit yaw and pitch. */
export function colorCameraPosition(pivot: Point, yaw: number, pitch: number): Point {
  const dir = boomDirection(yaw, clampColorPitch(pitch));
  return { x: pivot.x + dir.x * COLOR_CAMERA.boom, y: pivot.y + dir.y * COLOR_CAMERA.boom, z: pivot.z + dir.z * COLOR_CAMERA.boom };
}
