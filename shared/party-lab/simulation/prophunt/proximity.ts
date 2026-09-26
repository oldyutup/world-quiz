import { PROP_HUNT_MAP } from "../../maps/propHunt.js";
import type { ArenaCollider, ColliderRole } from "../../maps/types.js";
import type { Vec } from "../ragdoll/math.js";
import { PROP_HUNT, PROP_TICKS } from "./config.js";

/**
 * Saklambaç's close-range hunch (pure geometry, no Rapier: deterministic, cheap, shared).
 *
 * A hider still hidden counts as close to the seeker when it is within `proximity.radius` m of
 * the seeker's pelvis horizontally, their feet are within `proximity.vertical` m of each other
 * (never the loft over the kitchen, never the lean-to roof over the yard), and the two share the
 * space: a line from the seeker's head to the hider's top, or from its chest to the hider's
 * middle, crosses no architecture (walls, glass, floors, decks, the loft, roofs, the woodpile's
 * bulk, the tents, the boundary). Furniture, rails, posts, steps, the stair, the fire pit and
 * every prop do not stop it: a crowd of props around a hider never makes it unreliable.
 */
const P = PROP_HUNT.proximity;

/** Roles that stop the hunch: the camp's architecture only. */
export const SENSE_BLOCKING: ReadonlySet<ColliderRole> = new Set<ColliderRole>(["wall", "glass", "floor", "deck", "loft", "roof", "woodpile", "tent", "boundary"]);

interface Plane {
  x: number;
  y: number;
  z: number;
  /** Inside: x·p.x + y·p.y + z·p.z ≤ d. */
  d: number;
}
interface Solid {
  min: Vec;
  max: Vec;
  planes: Plane[];
}
/** A collider as a convex solid (a box; a ramp is its box cut by the slope; a cylinder its box). */
function solidOf(c: ArenaCollider): Solid {
  const half = c.shape === "cylinder" ? { x: c.radius, y: c.halfHeight, z: c.radius } : c.half,
    min = { x: c.center.x - half.x, y: c.center.y - half.y, z: c.center.z - half.z },
    max = { x: c.center.x + half.x, y: c.center.y + half.y, z: c.center.z + half.z };
  const planes: Plane[] = [
    { x: 1, y: 0, z: 0, d: max.x },
    { x: -1, y: 0, z: 0, d: -min.x },
    { x: 0, y: 1, z: 0, d: max.y },
    { x: 0, y: -1, z: 0, d: -min.y },
    { x: 0, y: 0, z: 1, d: max.z },
    { x: 0, y: 0, z: -1, d: -min.z },
  ];
  if (c.shape === "ramp") {
    // The top face rises from min.y on the low side to max.y on the side it rises toward.
    const axis = c.rises[1] as "x" | "z",
      up = c.rises[0] === "+",
      k = (max.y - min.y) / (max[axis] - min[axis]),
      low = up ? min[axis] : max[axis],
      s = up ? 1 : -1;
    // y ≤ min.y + s·k·(a − low)  ⇔  y − s·k·a ≤ min.y − s·k·low
    planes.push({ x: axis === "x" ? -s * k : 0, y: 1, z: axis === "z" ? -s * k : 0, d: min.y - s * k * low });
  }
  return { min, max, planes };
}
/** The camp's architecture as solids (the map never changes; the round's decoys are never in it). */
export const SENSE_SOLIDS: readonly Solid[] = PROP_HUNT_MAP.colliders.filter((c) => SENSE_BLOCKING.has(c.role)).map(solidOf);

/** Whether the segment a→b passes more than 2 cm through any of `solids` (Cyrus–Beck clipping). */
export function segmentBlocked(a: Vec, b: Vec, solids: readonly Solid[] = SENSE_SOLIDS): boolean {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    dz = b.z - a.z,
    length = Math.hypot(dx, dy, dz);
  if (length < 1e-6) return false;
  const depth = 0.02 / length;
  for (const s of solids) {
    if (Math.max(a.x, b.x) < s.min.x || Math.min(a.x, b.x) > s.max.x || Math.max(a.y, b.y) < s.min.y || Math.min(a.y, b.y) > s.max.y || Math.max(a.z, b.z) < s.min.z || Math.min(a.z, b.z) > s.max.z) continue;
    let t0 = 0,
      t1 = 1,
      inside = true;
    for (const p of s.planes) {
      const denominator = p.x * dx + p.y * dy + p.z * dz,
        numerator = p.d - (p.x * a.x + p.y * a.y + p.z * a.z);
      if (Math.abs(denominator) < 1e-12) {
        if (numerator < 0) {
          inside = false;
          break;
        }
        continue;
      }
      const t = numerator / denominator;
      if (denominator > 0) t1 = Math.min(t1, t);
      else t0 = Math.max(t0, t);
      if (t0 > t1) {
        inside = false;
        break;
      }
    }
    if (inside && t1 - t0 > depth) return true;
  }
  return false;
}

/** Where a hider is for the hunch: its middle (x, z), its feet (a prop's bottom), a middle and a top point. */
export interface SenseTarget {
  x: number;
  z: number;
  feet: number;
  middle: number;
  top: number;
}
/** Seeker's head and chest above its feet (fixed offsets from the pelvis: no ragdoll wobble). */
const HEAD = 1.6,
  CHEST = 1.15;
/** Whether a hider is close to a seeker standing with its pelvis at `seeker` (feet 0.78 m below it). */
export function senses(seeker: Vec, hider: SenseTarget): boolean {
  if (Math.hypot(hider.x - seeker.x, hider.z - seeker.z) > P.radius) return false;
  const feet = seeker.y - 0.78;
  if (Math.abs(hider.feet - feet) > P.vertical) return false;
  return (
    !segmentBlocked({ x: seeker.x, y: feet + HEAD, z: seeker.z }, { x: hider.x, y: hider.top, z: hider.z }) ||
    !segmentBlocked({ x: seeker.x, y: feet + CHEST, z: seeker.z }, { x: hider.x, y: hider.middle, z: hider.z })
  );
}

/**
 * One pulse per approach. Only distance can rearm it: losing line of sight or stepping
 * outside the trigger radius is insufficient. Never tells which hider, or how many.
 */
export class ProximitySense {
  /** Ticks close in a row while armed. */
  dwell = 0;
  armed = true;
  outside = 0;
  /** Pulses this round (diagnostics). */
  pulses = 0;
  reset() {
    this.dwell = this.outside = this.pulses = 0;
    this.armed = true;
  }
  /** `outside` means beyond the rearm radius of EVERY living hider, regardless of walls. */
  step(close: () => boolean, outside: () => boolean): boolean {
    if (!this.armed) {
      this.dwell = 0;
      this.outside = outside() ? this.outside + 1 : 0;
      if (this.outside >= PROP_TICKS.proximityOutsideDwell) {
        this.armed = true;
        this.outside = 0;
      }
      return false;
    }
    if (!close()) {
      this.dwell = 0;
      return false;
    }
    if (++this.dwell < PROP_TICKS.proximityDwell) return false;
    this.dwell = 0;
    this.armed = false;
    this.pulses++;
    return true;
  }
}
