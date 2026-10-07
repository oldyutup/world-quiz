/**
 * Tıklama Yarışı geometry: straight side-by-side lanes along +x (start → finish) and a
 * fixed, slightly tilted orthographic camera that fits the whole track into the screen.
 * A tall screen turns the track so it runs bottom → top.
 */
export const TRACK = {
  laneWidth: 3.4,
  /** Start line to finish line, m. */
  run: 40,
  carLength: 4.3,
  /** Grass framed around the track (start grid, finish run-out, sides), m. */
  frame: { back: 10, front: 4, side: 1.4 },
  /** Tallest thing that must stay in view (a driver's head), m. */
  height: 2.2,
  /** Camera tilt from straight down, radians: enough to read the drivers. */
  tilt: (24 * Math.PI) / 180,
} as const;
export const START_X = -TRACK.run / 2;
export const FINISH_X = TRACK.run / 2;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
/** Lane centre across the track; lane 0 is drawn first (top, or left on a tall screen). */
export const laneZ = (lane: number, lanes: number) => (lane - (lanes - 1) / 2) * TRACK.laneWidth;
/** Car centre for a progress of 0–1: the nose sits on the start line, then crosses the finish. */
export const carX = (progress: number) => START_X - TRACK.carLength / 2 + clamp01(progress) * TRACK.run;

export function trackBounds(lanes: number) {
  const half = (lanes * TRACK.laneWidth) / 2 + TRACK.frame.side;
  return { minX: START_X - TRACK.frame.back, maxX: FINISH_X + TRACK.frame.front, minZ: -half, maxZ: half };
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
/** HUD space (lane cards above, hint below) the camera keeps the track out of, px. */
export function clickInsets(width: number, height: number): Insets {
  const compact = width < 700 || height < 520;
  return compact ? { top: 128, right: 12, bottom: 44, left: 12 } : { top: 150, right: 28, bottom: 64, left: 28 };
}
type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export interface ClickView {
  portrait: boolean;
  /** Camera position (looking at the origin), up vector and orthographic frustum. */
  position: V3;
  up: V3;
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** World metres per screen pixel. */
  scale: number;
}
/**
 * The fixed camera for `lanes` lanes on a `width` × `height` px viewport: the track, its
 * frame and the drivers fill the area left free by the HUD `insets` (px).
 */
export function fitClickView(lanes: number, width: number, height: number, insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 }): ClickView {
  const portrait = height > width;
  // Ground axes of the screen: right and up (start at the left, or at the bottom).
  const right: V3 = portrait ? [0, 0, 1] : [1, 0, 0];
  const ahead: V3 = portrait ? [1, 0, 0] : [0, 0, -1];
  const { tilt } = TRACK,
    up: V3 = [ahead[0] * Math.cos(tilt), Math.sin(tilt), ahead[2] * Math.cos(tilt)],
    forward: V3 = [ahead[0] * Math.sin(tilt), -Math.cos(tilt), ahead[2] * Math.sin(tilt)];
  const b = trackBounds(lanes);
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const x of [b.minX, b.maxX])
    for (const y of [0, TRACK.height])
      for (const z of [b.minZ, b.maxZ]) {
        const sx = dot([x, y, z], right),
          sy = dot([x, y, z], up);
        minX = Math.min(minX, sx);
        maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy);
        maxY = Math.max(maxY, sy);
      }
  const innerW = Math.max(1, width - insets.left - insets.right),
    innerH = Math.max(1, height - insets.top - insets.bottom);
  const scale = Math.max((maxX - minX) / innerW, (maxY - minY) / innerH);
  // Put the track's centre on the free area's centre.
  const cx = (minX + maxX) / 2 - ((insets.left - insets.right) / 2) * scale,
    cy = (minY + maxY) / 2 - ((insets.bottom - insets.top) / 2) * scale;
  const distance = 80;
  return {
    portrait,
    position: [-forward[0] * distance, -forward[1] * distance, -forward[2] * distance],
    up,
    left: cx - (width * scale) / 2,
    right: cx + (width * scale) / 2,
    top: cy + (height * scale) / 2,
    bottom: cy - (height * scale) / 2,
    scale,
  };
}

/** Screen pixel of a world point under `view` (for tests and HUD anchoring). */
export function projectClickView(view: ClickView, width: number, height: number, p: V3) {
  const right: V3 = view.portrait ? [0, 0, 1] : [1, 0, 0];
  const sx = dot(p, right),
    sy = dot(p, view.up);
  return { x: ((sx - view.left) / (view.right - view.left)) * width, y: ((view.top - sy) / (view.top - view.bottom)) * height };
}
