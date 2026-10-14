import { PerspectiveCamera, Vector3 } from "three";
import { LIGHT_TRAILS as L } from "../../../../shared/party-lab/simulation/trails/config";

/** Wall size round the arena, m (drawn outside the play area). */
export const WALL = { thickness: 0.35, height: 0.45 } as const;
/**
 * The view: a fixed camera almost straight above the arena (6° off vertical, towards the bottom
 * of the screen), the same for everyone, so the rail runs straight across and W is up for all.
 */
export const TRAIL_VIEW = {
  fov: 28,
  /** Tilt from straight down, radians. */
  tilt: (6 * Math.PI) / 180,
  /** What must fit: the walls (their tops) all round. */
  halfX: L.width / 2 + WALL.thickness,
  halfZ: L.depth / 2 + WALL.thickness,
  height: WALL.height,
} as const;
/** Canvas pixel ratio: never under 2 (thin neon lines looked soft at 1.5). */
export const TRAIL_DPR: [number, number] = [2, 2];
/** The HUD's left column (player cards, the train, the keys), px from the left edge; trails.css --pl-trail-column. */
export const TRAIL_COLUMN = 262;
/** Screen space the HUD keeps (px): the left column; elsewhere a small margin (the clock sits in the top-right corner). */
export const TRAIL_INSETS = { top: 16, bottom: 16, left: TRAIL_COLUMN + 12, right: 16 } as const;

const point = new Vector3();
/**
 * Places `camera` so the whole arena fits the space beside the HUD at this size: the distance
 * by bisection on the projected walls, then a view offset that centres the arena in that space.
 */
export function fitTrailCamera(camera: PerspectiveCamera, width: number, height: number, insets: { top: number; bottom: number; left: number; right: number } = TRAIL_INSETS) {
  const free = { w: Math.max(80, width - insets.left - insets.right), h: Math.max(80, height - insets.top - insets.bottom) };
  camera.fov = TRAIL_VIEW.fov;
  camera.aspect = width / Math.max(1, height);
  camera.near = 0.5;
  camera.far = 400;
  camera.clearViewOffset();
  const place = (distance: number) => {
    camera.position.set(0, distance * Math.cos(TRAIL_VIEW.tilt), distance * Math.sin(TRAIL_VIEW.tilt));
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
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        for (const y of [0, TRAIL_VIEW.height]) {
          point.set(sx * TRAIL_VIEW.halfX, y, sz * TRAIL_VIEW.halfZ).project(camera);
          const px = ((point.x + 1) / 2) * width,
            py = ((1 - point.y) / 2) * height;
          x0 = Math.min(x0, px);
          x1 = Math.max(x1, px);
          y0 = Math.min(y0, py);
          y1 = Math.max(y1, py);
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
