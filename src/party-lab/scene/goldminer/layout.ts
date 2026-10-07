import { GOLD_MINER as G } from "../../../../shared/party-lab/simulation/goldminer/config";

/**
 * Altın Madenci view geometry: a side cut through the mine. World x is the mine's x, world y
 * is up (mine depth d sits at y = −d, the pivots at y = 0), and a fixed orthographic camera
 * looks at it from the front.
 */
export const SCENE = {
  /** Grass on top of the mine, m above the pivots. */
  ground: 0.35,
  /** The winch drum's centre, each miner's feet, and the tallest thing to keep in view (a miner's head). */
  winchY: 0.95,
  feetY: 0.35,
  top: 2.75,
  /** Rock frame shown around the mine, m. */
  frame: 0.5,
} as const;
export const mineBounds = () => ({ minX: -G.width / 2 - SCENE.frame, maxX: G.width / 2 + SCENE.frame, minY: -G.depth - SCENE.frame, maxY: SCENE.top });

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
/** HUD space (score cards above, hint below) the camera keeps the mine out of, px. */
export function goldInsets(width: number, height: number): Insets {
  const compact = width < 700 || height < 520;
  return compact ? { top: 112, right: 8, bottom: 40, left: 8 } : { top: 104, right: 24, bottom: 56, left: 24 };
}
export interface GoldView {
  /** Camera centre (world x, y) and orthographic frustum. */
  x: number;
  y: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** World metres per screen pixel. */
  scale: number;
}
/** The fixed camera for a `width` × `height` px viewport: the whole mine and the miners fill the space the HUD leaves. */
export function fitGoldView(width: number, height: number, insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 }): GoldView {
  const b = mineBounds(),
    innerW = Math.max(1, width - insets.left - insets.right),
    innerH = Math.max(1, height - insets.top - insets.bottom);
  const scale = Math.max((b.maxX - b.minX) / innerW, (b.maxY - b.minY) / innerH);
  const x = (b.minX + b.maxX) / 2 - ((insets.left - insets.right) / 2) * scale,
    y = (b.minY + b.maxY) / 2 - ((insets.bottom - insets.top) / 2) * scale;
  return { x, y, left: -(width * scale) / 2, right: (width * scale) / 2, top: (height * scale) / 2, bottom: -(height * scale) / 2, scale };
}
/** Screen pixel of a world point under `view`. */
export function projectGoldView(view: GoldView, p: { x: number; y: number }) {
  return { x: (p.x - view.x - view.left) / view.scale, y: (view.y + view.top - p.y) / view.scale };
}
