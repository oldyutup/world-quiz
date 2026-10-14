import { PerspectiveCamera, Vector3 } from "three";
import { BOX_TOWER as T } from "../../../../shared/party-lab/simulation/boxtower/config";

/**
 * Kutu Kulesi view geometry. One box is one world unit. The yards stand side by side on the
 * ground (y = 0), facing the camera (+z); each player's character stands on the left of their
 * yard. Column c of a yard is centred at `columnX(lane, count, c)`.
 */
export const YARD = {
  /** Box size (a little under a column, so neighbours show a seam). */
  box: 0.92,
  /** The sliding box's middle rides this high (above the finish line at `goal`). */
  hoverY: T.goal + 1.75,
  /** The back wall's top. */
  wallTop: T.goal + 2.7,
  /** Room on a yard's left for its character, and between yards. */
  side: 2.5,
  gap: 1.1,
  /** The character's size and its place left of the yard. */
  personScale: 1.7,
  personX: 1.35,
} as const;
const HALF = T.columns / 2;
/** Distance between yard centres. */
export const PITCH = T.columns + YARD.side + YARD.gap;
/** Yard `lane`'s centre x among `count` yards (the whole row, characters included, centred on 0). */
export const yardX = (lane: number, count: number) => (lane - (count - 1) / 2) * PITCH + YARD.side / 2;
/** World x of column `c` (fractional for the sliding box) in yard `lane`. */
export const columnX = (lane: number, count: number, c: number) => yardX(lane, count) + c - (T.columns - 1) / 2;
/** World y of the middle of the box `level` boxes up (0 = on the ground). */
export const levelY = (level: number) => level + 0.5;
/** What must fit on screen: every yard, its wall, its character. */
export function rowBounds(count: number) {
  return { minX: yardX(0, count) - HALF - YARD.side - 0.1, maxX: yardX(count - 1, count) + HALF + 0.35, minY: -0.6, maxY: YARD.wallTop + 0.2 };
}

export const TOWER_VIEW = {
  fov: 26,
  /** The camera looks down this much (radians) so the box tops show. */
  tilt: (9 * Math.PI) / 180,
} as const;
/** HUD space kept clear (px): the player cards and clock on top, the hint below. */
export const TOWER_INSETS = { top: 118, bottom: 54, left: 24, right: 24 } as const;

const point = new Vector3();
/**
 * Places `camera` in front of the row so every yard fits the space between the HUD at this size:
 * the distance by bisection on the projected bounds, then a view offset that centres the row in
 * that space.
 */
export function fitTowerCamera(camera: PerspectiveCamera, width: number, height: number, count: number, insets: { top: number; bottom: number; left: number; right: number } = TOWER_INSETS) {
  const free = { w: Math.max(80, width - insets.left - insets.right), h: Math.max(80, height - insets.top - insets.bottom) },
    b = rowBounds(count),
    centre = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  camera.fov = TOWER_VIEW.fov;
  camera.aspect = width / Math.max(1, height);
  camera.near = 0.5;
  camera.far = 600;
  camera.clearViewOffset();
  const place = (distance: number) => {
    camera.position.set(centre.x, centre.y + distance * Math.sin(TOWER_VIEW.tilt), distance * Math.cos(TOWER_VIEW.tilt));
    camera.up.set(0, 1, 0);
    camera.lookAt(centre.x, centre.y, 0);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
  };
  const box = () => {
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (const x of [b.minX, b.maxX])
      for (const y of [b.minY, b.maxY])
        for (const z of [-0.8, 0.8]) {
          point.set(x, y, z).project(camera);
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
    hi = 600;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    place(mid);
    const r = box();
    if (r.x1 - r.x0 <= free.w && r.y1 - r.y0 <= free.h) hi = mid;
    else lo = mid;
  }
  place(hi);
  const r = box(),
    dx = insets.left + free.w / 2 - (r.x0 + r.x1) / 2,
    dy = insets.top + free.h / 2 - (r.y0 + r.y1) / 2;
  camera.setViewOffset(width, height, -dx, -dy, width, height);
  camera.updateProjectionMatrix();
  return { distance: hi, box: { x0: r.x0 + dx, x1: r.x1 + dx, y0: r.y0 + dy, y1: r.y1 + dy }, free };
}
/** Screen pixel of a world point (after `fitTowerCamera`). */
export function projectTower(camera: PerspectiveCamera, width: number, height: number, x: number, y: number, z = 0) {
  point.set(x, y, z).project(camera);
  return { x: ((point.x + 1) / 2) * width, y: ((1 - point.y) / 2) * height };
}
