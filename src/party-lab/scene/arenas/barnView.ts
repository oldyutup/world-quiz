import { Quaternion, Vector3 } from "three";
import type { BarnPellet } from "../../../../shared/party-lab/simulation/barn/combat";
import type { WeaponKind } from "../../../../shared/party-lab/simulation/barn/weapons";

/**
 * Presentation-only view of Barn combat, published once per rendered frame by the
 * arena loop (after the fixed steps and pose interpolation) to the barn's visual
 * parts. Nothing here feeds back into the simulation.
 */
export interface BarnPropsView {
  /** Weapons lying on their spots. */
  pickups: readonly { spot: string; kind: WeaponKind }[];
  /** Replacements about to appear: 0 → 1 over the telegraph window. */
  telegraphs: readonly { spot: string; progress: number }[];
  traps: readonly { id: string; armed: boolean; sprungFor: number; rearmIn: number; holding: boolean }[];
}
export interface HeldView {
  kind: WeaponKind | null;
  /** The weapon's grip: beside the torso at the gun hand. */
  grip: Vector3;
  /** Aim orientation: +Z points along the aim. */
  aim: Quaternion;
  /** Visual recoil 0…1 (decays). */
  kick: number;
}
export interface ShotEffect {
  kind: WeaponKind;
  muzzle: Vector3;
  pellets: readonly BarnPellet[];
}
export interface BarnFrame {
  elapsed: number;
  dt: number;
  props: BarnPropsView | null;
  held: HeldView[];
  /** New since the last frame; emptied after each publish. */
  shots: ShotEffect[];
  impacts: { point: Vector3; body: boolean; strong: boolean }[];
}

/** Held-weapon length from grip to muzzle (kit models point along −X, grip at the origin). */
export const MUZZLE: Readonly<Record<WeaponKind, number>> = { shotgun: 0.86, smg: 0.7 };
/** Scale of the held kit weapons: toy-sized next to the chunky characters, readable from the chase camera. */
export const HELD_SCALE = 1.6;

export class BarnBridge {
  readonly frame: BarnFrame = { elapsed: 0, dt: 0, props: null, held: [], shots: [], impacts: [] };
  private readonly subscribers = new Set<(frame: BarnFrame) => void>();
  subscribe(listener: (frame: BarnFrame) => void) {
    this.subscribers.add(listener);
    return () => void this.subscribers.delete(listener);
  }
  publish() {
    for (const listener of this.subscribers) listener(this.frame);
    this.frame.shots.length = 0;
    this.frame.impacts.length = 0;
  }
}
