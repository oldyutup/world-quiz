import { PerspectiveCamera, Vector3 } from "three";

/**
 * Nişancı view geometry (metres). The players stand side by side on the floor (y = 0) behind
 * one long counter, facing −z; the camera looks over their shoulders at the gallery. Each
 * player's three target slots stand in a row straight ahead of them, at `targetZ`.
 */
export const GALLERY = {
  /** Distance between two players (and their stretches of the gallery). */
  pitch: 4.8,
  /** The slots' spacing across, their distance and the target's centre height. */
  slotGap: 1.45,
  targetZ: -10,
  targetY: 1.75,
  /** Target disc radius; the bomb's radius. */
  radius: 0.55,
  bomb: 0.46,
  /** The cover board in front of the slots hides a lowered target up to this height. */
  coverY: 1.0,
  /** The counter: its front edge, depth and top. */
  counterZ: -1.05,
  counterDepth: 0.8,
  counterY: 1.02,
  /** The character's size and where it stands. */
  personScale: 1.25,
  personZ: 0.15,
} as const;

/** Lane `lane`'s centre x among `count` (the row centred on 0). */
export const laneX = (lane: number, count: number) => (lane - (count - 1) / 2) * GALLERY.pitch;
/** World centre of a target in `slot` (0 left … 2 right) of lane `lane`. */
export const slotPoint = (lane: number, count: number, slot: number) => ({ x: laneX(lane, count) + (slot - 1) * GALLERY.slotGap, y: GALLERY.targetY, z: GALLERY.targetZ });
/** What must fit on screen: every slot (with the booth around it) and every player. */
export function galleryBounds(count: number) {
  const half = (count * GALLERY.pitch) / 2;
  return {
    far: { minX: -half + 0.2, maxX: half - 0.2, minY: 0, maxY: GALLERY.targetY + GALLERY.radius + 0.75, z: GALLERY.targetZ },
    // The players from the hips up (their legs may run off the bottom).
    near: { minX: laneX(0, count) - 0.9, maxX: laneX(count - 1, count) + 0.9, minY: 0.95, maxY: 2.5, z: GALLERY.personZ },
  };
}

export const MARKSMAN_VIEW = {
  fov: 22,
  /** The camera looks down this much (radians) over the players' heads. */
  tilt: (15 * Math.PI) / 180,
} as const;
/** HUD space kept clear (px): the player cards and the clock on top, the hint below. */
export const MARKSMAN_INSETS = { top: 104, bottom: 56, left: 20, right: 20 } as const;

const point = new Vector3();
/**
 * Places `camera` behind the players so the whole gallery and every player fit the space between
 * the HUD at this size: the distance by bisection on the projected bounds, then a view offset that
 * centres them in that space.
 */
export function fitMarksmanCamera(camera: PerspectiveCamera, width: number, height: number, count: number, insets: { top: number; bottom: number; left: number; right: number } = MARKSMAN_INSETS) {
  const free = { w: Math.max(80, width - insets.left - insets.right), h: Math.max(80, height - insets.top - insets.bottom) },
    b = galleryBounds(count),
    look = { x: 0, y: 1.3, z: (GALLERY.targetZ + GALLERY.personZ) / 2 };
  camera.fov = MARKSMAN_VIEW.fov;
  camera.aspect = width / Math.max(1, height);
  camera.near = 0.3;
  camera.far = 400;
  camera.clearViewOffset();
  const place = (distance: number) => {
    camera.position.set(look.x, look.y + distance * Math.sin(MARKSMAN_VIEW.tilt), look.z + distance * Math.cos(MARKSMAN_VIEW.tilt));
    camera.up.set(0, 1, 0);
    camera.lookAt(look.x, look.y, look.z);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
  };
  const box = () => {
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (const r of [b.far, b.near])
      for (const x of [r.minX, r.maxX])
        for (const y of [r.minY, r.maxY]) {
          point.set(x, y, r.z).project(camera);
          const px = ((point.x + 1) / 2) * width,
            py = ((1 - point.y) / 2) * height;
          x0 = Math.min(x0, px);
          x1 = Math.max(x1, px);
          y0 = Math.min(y0, py);
          y1 = Math.max(y1, py);
        }
    return { x0, x1, y0, y1 };
  };
  // Never closer than the players' backs allow (the near row must stay in front of the camera).
  let lo = 7,
    hi = 400;
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
/** Screen pixel of a world point (after `fitMarksmanCamera`). */
export function projectMarksman(camera: PerspectiveCamera, width: number, height: number, x: number, y: number, z: number) {
  point.set(x, y, z).project(camera);
  return { x: ((point.x + 1) / 2) * width, y: ((1 - point.y) / 2) * height };
}
