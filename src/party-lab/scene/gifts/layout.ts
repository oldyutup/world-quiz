import { PerspectiveCamera, Vector3 } from "three";
import { GIFT } from "../../../../shared/party-lab/simulation/gifts/config";

/**
 * The view: a fixed camera above the yard, tilted toward this player's home (at the bottom of
 * the screen, the pile above it), far enough to show the whole wall. Nothing turns or follows.
 */
export const GIFT_VIEW = {
  fov: 30,
  /** Tilt from straight down, radians. */
  tilt: (34 * Math.PI) / 180,
  /** What must fit: the wall's outside and its top, and anyone standing by it. */
  radius: GIFT.arena.radius + GIFT.arena.wall.thickness + 0.05,
  height: 1.9,
} as const;
/** The HUD's left column (player cards, controls, events), px; gifts.css --pl-gift-column. */
export const GIFT_COLUMN = 262;
export const GIFT_INSETS = { top: 14, bottom: 14, left: GIFT_COLUMN + 10, right: 14 } as const;
export const GIFT_DPR: [number, number] = [1.5, 2];

const point = new Vector3();
/**
 * Places `camera` so the yard fits beside the HUD at this size, looking up the screen along
 * `yaw` (the yaw "up the screen" points). Distance by bisection on the projected rim, then
 * the view is shifted so the yard sits in the middle of the free space.
 */
export function fitGiftCamera(camera: PerspectiveCamera, width: number, height: number, yaw: number, insets: { top: number; bottom: number; left: number; right: number } = GIFT_INSETS) {
  const free = { w: Math.max(80, width - insets.left - insets.right), h: Math.max(80, height - insets.top - insets.bottom) };
  camera.fov = GIFT_VIEW.fov;
  camera.aspect = width / Math.max(1, height);
  camera.near = 0.5;
  camera.far = 400;
  camera.clearViewOffset();
  const back = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  const place = (distance: number) => {
    camera.position.set(back.x * distance * Math.sin(GIFT_VIEW.tilt), distance * Math.cos(GIFT_VIEW.tilt), back.z * distance * Math.sin(GIFT_VIEW.tilt));
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
      for (const y of [0, GIFT_VIEW.height]) {
        point.set(Math.cos(a) * GIFT_VIEW.radius, y, Math.sin(a) * GIFT_VIEW.radius).project(camera);
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
  return { distance: hi, free };
}
