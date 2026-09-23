import RAPIER from "@dimforge/rapier3d-compat";
import type { PlaygroundPhysics } from "../physics.js";
import type { PlayerId } from "../players.js";
import { PARTS, type PartName } from "../ragdoll/config.js";
import type { Character } from "../ragdoll/character.js";
import type { Vec } from "../ragdoll/math.js";
import { BARN_COMBAT } from "./config.js";
import { castHistoric, type HistoricView } from "./rewind.js";

/**
 * Hitscan for the Barn, resolved by whoever owns the simulation (the local mode
 * today, the room server later). Input carries only intent — aim yaw/pitch and a
 * bounded point on the aim line — never "I hit player X".
 *
 * 1. The aim line: from the chase camera's line through the crosshair (reconstructed
 *    from the pelvis, yaw and pitch; a client's own camera point is accepted within
 *    `aim.maxEyeOffset`), followed to the first thing it meets: the aim point.
 * 2. The shot: from the shooter's torso (always inside their own body, never inside a
 *    wall) toward the aim point, so cover in front of the body stops it even when the
 *    camera sees over it. Static geometry — walls, cover, rails, decks — blocks; a
 *    living character's part takes the hit. The shooter and dead bodies are skipped.
 */
export interface ShotTarget {
  id: PlayerId;
  part: PartName;
}
export interface RayHit {
  point: Vec;
  distance: number;
  /** Null for static geometry. */
  target: ShotTarget | null;
}

// Pure aim math lives in aim.ts (no Rapier), so the lobby/session bundle can use it.
export { aimDirection, aimEye, shoulderEye } from "./aim.js";
import { aimDirection, aimEye } from "./aim.js";
/** Muzzle side of every shot: the torso's centre. */
export const shotOrigin = (character: Character): Vec => ({ ...character.parts.torso.body.translation() });

/** Collider handle → character part, for every part of every character. */
export function partIndex(physics: PlaygroundPhysics) {
  const index = new Map<number, ShotTarget>();
  for (const player of physics.players) for (const part of PARTS) index.set(player.parts[part].collider.handle, { id: player.id, part });
  return index;
}

export class Hitscan {
  readonly stats = { rays: 0, ms: 0 };
  private readonly index: Map<number, ShotTarget>;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  constructor(
    private readonly physics: PlaygroundPhysics,
    /** Whether a character can currently be hit (living); others are passed through. */
    private readonly hittable: (id: PlayerId) => boolean
  ) {
    this.index = partIndex(physics);
  }
  /**
   * First static surface or hittable character part along a unit ray, skipping `shooter`.
   * With a historical `view` (server lag compensation) characters are tested at those
   * poses instead of the current ones; static geometry is always the current world.
   */
  cast(origin: Vec, direction: Vec, range: number, shooter: PlayerId, view?: HistoricView | null): RayHit | null {
    if (view) return this.castView(origin, direction, range, shooter, view);
    const start = performance.now();
    this.ray.origin = origin;
    this.ray.dir = direction;
    const hit = this.physics.world.castRay(this.ray, range, true, undefined, undefined, undefined, undefined, (collider) => {
      const target = this.index.get(collider.handle);
      return !target || (target.id !== shooter && this.hittable(target.id));
    });
    this.stats.rays++;
    this.stats.ms += performance.now() - start;
    if (!hit) return null;
    const t = hit.timeOfImpact;
    return {
      point: { x: origin.x + direction.x * t, y: origin.y + direction.y * t, z: origin.z + direction.z * t },
      distance: t,
      target: this.index.get(hit.collider.handle) ?? null,
    };
  }
  private castView(origin: Vec, direction: Vec, range: number, shooter: PlayerId, view: HistoricView): RayHit | null {
    const start = performance.now();
    this.ray.origin = origin;
    this.ray.dir = direction;
    const wall = this.physics.world.castRay(this.ray, range, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
    const reach = wall ? wall.timeOfImpact : range;
    const body = castHistoric(view, origin, direction, reach, shooter, this.hittable);
    this.stats.rays++;
    this.stats.ms += performance.now() - start;
    const t = body ? body.distance : wall ? wall.timeOfImpact : -1;
    if (t < 0) return null;
    return {
      point: { x: origin.x + direction.x * t, y: origin.y + direction.y * t, z: origin.z + direction.z * t },
      distance: t,
      target: body ? { id: body.id, part: body.part } : null,
    };
  }
  /**
   * Where the crosshair points and the direction a shot leaves the torso toward it —
   * even point blank, where the crosshair line (0.45 m right, head high) and a parallel
   * line from the torso would pass either side of a target. Only an aim point inside
   * the shooter or behind them falls back to the look direction.
   */
  aim(character: Character, yaw: number, pitch: number, eyeOffset?: Vec | null, view?: HistoricView | null) {
    const look = aimDirection(yaw, pitch),
      eye = aimEye(character.body.translation(), yaw, eyeOffset),
      origin = shotOrigin(character),
      range = BARN_COMBAT.aim.range;
    const hit = this.cast(eye, look, range, character.id, view);
    const point = hit?.point ?? { x: eye.x + look.x * range, y: eye.y + look.y * range, z: eye.z + look.z * range };
    const dx = point.x - origin.x,
      dy = point.y - origin.y,
      dz = point.z - origin.z,
      d = Math.hypot(dx, dy, dz);
    const forward = d > 0 ? (dx * look.x + dy * look.y + dz * look.z) / d : -1;
    const direction = d < BARN_COMBAT.aim.minConvergence || forward < BARN_COMBAT.aim.minForward ? look : { x: dx / d, y: dy / d, z: dz / d };
    return { origin, direction, point, look };
  }
}
