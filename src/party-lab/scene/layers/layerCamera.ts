import {
  HEX,
  HEX_DIRECTIONS,
  hexAt,
  hexContains,
  LAYER_INDICES,
  LAYER_TOPS,
  tileAtCell,
  type LayerIndex,
} from "../../../../shared/party-lab/maps/layers";
import type { TileView } from "../../../../shared/party-lab/simulation/layers/timeline";
import type { LayerFall } from "./fall";

export interface Point {
  x: number;
  y: number;
  z: number;
}
const rad = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Katman Kaosu's elevated third-person chase camera: centred on the character (no
 * shoulder offset), looking down at the tile underfoot. Yaw orbits with the mouse or
 * trackpad and makes WASD camera-relative; the body turns toward where it walks
 * (no aim facing). Under an upper layer the camera first lowers its pitch, then
 * shortens its boom, so it never enters the layer above; that layer fades. Only a real
 * fall between layers (fall.ts) makes it follow the body down and look toward the
 * landing point; a jump barely moves it.
 */
export const LAYER_CAMERA = {
  /** Vertical field of view (°). */
  fov: 60,
  boom: 5.6,
  /**
   * Shortest boom (m). Standing anywhere, lowering the pitch always leaves at least this
   * much room under the layer above (layers.test.ts). Only a body falling past a layer
   * (through a hole or beside the rim) can need less; the camera then keeps this length
   * and passes through that layer, which is above the body and so already faded.
   */
  minBoom: 3,
  /** Orbit pivot above the pelvis (m). */
  pivotHeight: 0.9,
  /**
   * The pivot never follows a fall below this (m): falling out, the camera stays at the last
   * layer and watches the body drop past it into the haze (−4.2 m; the fall line is −5 m).
   */
  lowestPivot: 1.0,
  restPitch: rad(30),
  minPitch: rad(18),
  maxPitch: rad(55),
  /** Radians per pointer pixel (the Barn's). */
  sensitivity: 0.0024,
  /**
   * Pivot smoothing (s): horizontal; vertical in normal play, per stage of two cascaded
   * stages (no jolt at take-off or landing); vertical while falling between layers.
   */
  followXZ: 0.06,
  followY: 0.06,
  followFall: 0.03,
  /**
   * In normal play the pivot rides at standing height over the ground layer and follows only
   * this share of the pelvis above it: a 0.96 m jump lifts the view 0.14 m and the character
   * rises and lands in a steady frame. Under an intact layer the rest pitch leaves ≈ 0.17 m of
   * headroom; a larger share would lower the pitch on every jump.
   */
  jumpShare: 0.15,
  collision: {
    /** Camera sphere radius and extra clearance from a tile (m). */
    radius: 0.25,
    margin: 0.2,
    /** Seconds to ease back out once clear (pulling in or down is immediate). */
    restore: 0.35,
    /** Sampling step along the boom inside a layer's slab (m). */
    sample: 0.1,
  },
  /** Layers above the followed character. */
  fade: { opacity: 0.3, seconds: 0.25 },
  /**
   * Falling between layers, the camera looks this share of the way from the pivot down toward
   * the landing point (at most `max` m, eased over `seconds`), so the landing marker is in view.
   */
  fallLook: { share: 0.5, max: 3, seconds: 0.2 },
  /** Pivot smoothing (s) for a while after the followed character changes. */
  switchFollow: 0.2,
} as const;

export const clampLayerPitch = (pitch: number) => Math.max(LAYER_CAMERA.minPitch, Math.min(LAYER_CAMERA.maxPitch, pitch));
/** From the pivot toward the camera: behind the look yaw (atan2(x, z)), raised by the pitch. */
export function boomDirection(yaw: number, pitch: number): Point {
  return { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
}

/** An intact tile of `layer` covering (x, z), grown by `inflate` (the containing cell and its neighbours). */
export function intactTileNear(field: TileView, layer: LayerIndex, x: number, z: number, inflate: number) {
  const cell = hexAt(x, z);
  for (const d of [{ q: 0, r: 0 }, ...HEX_DIRECTIONS]) {
    const tile = tileAtCell(layer, { q: cell.q + d.q, r: cell.r + d.r });
    if (tile && field.intact(tile.id) && hexContains(tile, x, z, inflate)) return true;
  }
  return false;
}

/**
 * How far a camera sphere can travel from `pivot` along `dir` (rising) before it
 * would touch an intact tile of a layer above: each slab (grown by the sphere
 * radius) the segment crosses is sampled, holes let it through.
 */
export function freeBoom(field: TileView, pivot: Point, dir: Point, max: number): number {
  const { radius, sample } = LAYER_CAMERA.collision;
  if (dir.y <= 1e-6) return max;
  let best = max;
  for (const layer of LAYER_INDICES) {
    const top = LAYER_TOPS[layer] + radius,
      bottom = LAYER_TOPS[layer] - HEX.thickness - radius;
    if (top <= pivot.y) continue; // Below the pivot: the boom only rises.
    const from = Math.max(0, (bottom - pivot.y) / dir.y),
      to = Math.min(best, (top - pivot.y) / dir.y);
    for (let s = from; s <= to; s += sample)
      if (intactTileNear(field, layer, pivot.x + dir.x * s, pivot.z + dir.z * s, radius)) {
        best = Math.min(best, s);
        break;
      }
  }
  return best;
}

export interface LayerCameraState {
  /** Collision pitch reduction currently applied (eased back), rad. */
  drop: number;
  boom: number | null;
}
export interface LayerCameraPose {
  position: Point;
  pitch: number;
  boom: number;
  /** The unobstructed boom at the chosen pitch. */
  free: number;
}

/**
 * One camera update. The wanted pitch is kept when the full boom fits; otherwise the
 * highest pitch that fits is found by bisection (continuous as the pivot moves), and
 * only if even the lowest pitch is blocked the boom shortens, never below `minBoom`.
 * Lowering and pulling in are immediate; both ease back over `collision.restore`.
 */
export function updateLayerCamera(field: TileView, pivot: Point, yaw: number, wantedPitch: number, state: LayerCameraState, dt: number): LayerCameraPose {
  const { margin, restore } = LAYER_CAMERA.collision;
  const full = LAYER_CAMERA.boom + margin;
  const wanted = clampLayerPitch(wantedPitch);
  const fits = (pitch: number) => freeBoom(field, pivot, boomDirection(yaw, pitch), full) >= full;
  let pitch = wanted;
  if (!fits(wanted)) {
    let lo = LAYER_CAMERA.minPitch,
      hi = wanted;
    if (fits(lo)) {
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
    }
    pitch = lo;
  }
  const k = 1 - Math.exp(-Math.min(dt, 0.1) / restore);
  const needed = wanted - pitch;
  state.drop = needed >= state.drop ? needed : state.drop + (needed - state.drop) * k;
  pitch = Math.max(LAYER_CAMERA.minPitch, wanted - state.drop);
  const dir = boomDirection(yaw, pitch),
    free = freeBoom(field, pivot, dir, full);
  const target = Math.max(LAYER_CAMERA.minBoom, Math.min(LAYER_CAMERA.boom, free - margin));
  const boom = state.boom === null || target <= state.boom ? target : state.boom + (target - state.boom) * k;
  state.boom = boom;
  return { position: { x: pivot.x + dir.x * boom, y: pivot.y + dir.y * boom, z: pivot.z + dir.z * boom }, pitch, boom, free };
}

/**
 * The orbit pivot and how far below it the camera looks, per rendered frame. In normal
 * play (jumps included) the pivot height is the stance plus `jumpShare` of the drawn
 * pelvis above it, eased through two stages. Falling between layers it follows the drawn
 * pelvis closely and looks part of the way down to `landingY` (the marker's point).
 */
export class LayerFollow {
  pivot: Point | null = null;
  lookDrop = 0;
  /** Seconds of `switchFollow` smoothing left after the followed character changes. */
  blend = 0;
  /** First vertical stage (m). */
  private lift = 0;
  reset() {
    this.pivot = null;
    this.lookDrop = 0;
    this.blend = 0;
  }
  update(pelvis: Point, fall: Pick<LayerFall, "falling" | "stance">, landingY: number | null, dt: number): Point {
    const smooth = (tau: number) => 1 - Math.exp(-Math.min(dt, 0.1) / tau);
    const height = fall.falling ? pelvis.y : fall.stance + (pelvis.y - fall.stance) * LAYER_CAMERA.jumpShare;
    const target = { x: pelvis.x, y: Math.max(LAYER_CAMERA.lowestPivot, height + LAYER_CAMERA.pivotHeight), z: pelvis.z };
    if (!this.pivot) {
      this.pivot = target;
      this.lift = target.y;
    } else {
      this.blend = Math.max(0, this.blend - dt);
      const kxz = smooth(this.blend > 0 ? LAYER_CAMERA.switchFollow : LAYER_CAMERA.followXZ);
      this.pivot.x += (target.x - this.pivot.x) * kxz;
      this.pivot.z += (target.z - this.pivot.z) * kxz;
      if (this.blend > 0 || fall.falling) {
        this.lift = target.y;
        this.pivot.y += (target.y - this.pivot.y) * smooth(this.blend > 0 ? LAYER_CAMERA.switchFollow : LAYER_CAMERA.followFall);
      } else {
        const ky = smooth(LAYER_CAMERA.followY);
        this.lift += (target.y - this.lift) * ky;
        this.pivot.y += (this.lift - this.pivot.y) * ky;
      }
    }
    const { share, max, seconds } = LAYER_CAMERA.fallLook;
    const drop = landingY === null ? 0 : Math.min(max, Math.max(0, this.pivot.y - landingY) * share);
    this.lookDrop += (drop - this.lookDrop) * smooth(seconds);
    return this.pivot;
  }
}
