import { PerspectiveCamera, Vector3 } from "three";
import { OUTER } from "../../../../shared/party-lab/simulation/bomber/arena";
import { toWorld } from "./source";

/** The view: a fixed camera above the arena, tilted a little towards the bottom of the screen. */
export const BOMBER_VIEW = {
  fov: 32,
  /** Tilt from straight down, radians. */
  tilt: (22 * Math.PI) / 180,
  /** What must fit: the rim (its top) and anyone standing on the far edge. */
  radius: OUTER + 0.45,
  height: 1.3,
} as const;
/** Screen space the HUD keeps (px): the clock on top, the player cards below. */
export function bomberInsets(_width: number, height: number) {
  const short = height < 560;
  return { top: short ? 56 : 78, bottom: short ? 92 : 124, left: 16, right: 16 };
}

const point = new Vector3();
/**
 * Places `camera` so the whole arena fits the space between the HUD at this size, turned by
 * `yaw` (the player's start at the bottom). Finds the distance by bisection on the projected
 * rim, then shifts the view so the arena sits in the middle of that space.
 */
export function fitBomberCamera(camera: PerspectiveCamera, width: number, height: number, yaw: number, insets = bomberInsets(width, height)) {
  const free = { w: Math.max(80, width - insets.left - insets.right), h: Math.max(80, height - insets.top - insets.bottom) };
  camera.fov = BOMBER_VIEW.fov;
  camera.aspect = width / Math.max(1, height);
  camera.near = 0.5;
  camera.far = 400;
  camera.clearViewOffset();
  const down = toWorld(0, 1, yaw);
  const place = (distance: number) => {
    camera.position.set(down.x * distance * Math.sin(BOMBER_VIEW.tilt), distance * Math.cos(BOMBER_VIEW.tilt), down.z * distance * Math.sin(BOMBER_VIEW.tilt));
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
  };
  const box = () => {
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      for (const y of [0, BOMBER_VIEW.height]) {
        point.set(Math.cos(a) * BOMBER_VIEW.radius, y, Math.sin(a) * BOMBER_VIEW.radius).project(camera);
        const px = ((point.x + 1) / 2) * width,
          py = ((1 - point.y) / 2) * height;
        x0 = Math.min(x0, px);
        x1 = Math.max(x1, px);
        y0 = Math.min(y0, py);
        y1 = Math.max(y1, py);
      }
    }
    return { x0, x1, y0, y1 };
  };
  let lo = 4,
    hi = 400;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    place(mid);
    const b = box();
    if (b.x1 - b.x0 <= free.w && b.y1 - b.y0 <= free.h) hi = mid;
    else lo = mid;
  }
  place(hi);
  const b = box(),
    dx = insets.left + free.w / 2 - (b.x0 + b.x1) / 2,
    dy = insets.top + free.h / 2 - (b.y0 + b.y1) / 2;
  camera.setViewOffset(width, height, -dx, -dy, width, height);
  camera.updateProjectionMatrix();
  return { distance: hi, box: { x0: b.x0 + dx, x1: b.x1 + dx, y0: b.y0 + dy, y1: b.y1 + dy }, free };
}
