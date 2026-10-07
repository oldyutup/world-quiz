import { MathUtils, PerspectiveCamera, Vector3 } from "three";

/**
 * Board camera: always looking down from the +Z side at BOARD_PITCH (so numbers on the
 * squares read upright), sliding between the whole board (between rounds), the player
 * whose turn it is, and the player who is hopping. Distances ease, never jump.
 */
export const BOARD_PITCH = MathUtils.degToRad(50);
export const BOARD_FOV = 42;
export const FOCUS_DISTANCE = 12;
export const FOLLOW_DISTANCE = 9.5;
export const WINNER_DISTANCE = 7;

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export const cameraOffset = (distance: number, pitch = BOARD_PITCH) =>
  new Vector3(0, Math.sin(pitch) * distance, Math.cos(pitch) * distance);

/**
 * The closest distance at which the whole board (its corners, plus `height` for pawns
 * and the chest) fits inside `margin` of the screen, looking at the board's centre.
 */
export function overviewFit(bounds: Bounds, aspect: number, height = 1.4, margin = 0.88, pitch = BOARD_PITCH, fov = BOARD_FOV) {
  const target = new Vector3((bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2);
  const camera = new PerspectiveCamera(fov, aspect, 0.1, 500);
  const corners: Vector3[] = [];
  for (const x of [bounds.minX, bounds.maxX]) for (const z of [bounds.minZ, bounds.maxZ]) for (const y of [0, height]) corners.push(new Vector3(x, y, z));
  const fits = (distance: number) => {
    camera.position.copy(target).add(cameraOffset(distance, pitch));
    camera.lookAt(target);
    camera.updateMatrixWorld();
    return corners.every((corner) => {
      const p = corner.clone().project(camera);
      return Math.abs(p.x) <= margin && Math.abs(p.y) <= margin && p.z < 1;
    });
  };
  let lo = 2,
    hi = 400;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return { target, distance: hi };
}

/** Eased camera state: target point and distance approach what the shot wants. */
export class BoardCameraRig {
  readonly target = new Vector3();
  distance = 30;
  private placed = false;
  update(camera: PerspectiveCamera, target: Vector3, distance: number, dt: number, pitch = BOARD_PITCH) {
    if (!this.placed) {
      this.target.copy(target);
      this.distance = distance;
      this.placed = true;
    } else {
      const k = 1 - Math.exp(-Math.min(dt, 0.1) * 3.2);
      this.target.lerp(target, k);
      this.distance += (distance - this.distance) * k;
    }
    camera.position.copy(this.target).add(cameraOffset(this.distance, pitch));
    camera.lookAt(this.target);
  }
}
