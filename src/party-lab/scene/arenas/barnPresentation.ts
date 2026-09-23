import { Color, Vector3 } from "three";
import { GUN_HAND } from "../../../../shared/party-lab/simulation/barn/combat";
import type { WeaponKind } from "../../../../shared/party-lab/simulation/barn/weapons";

/** Barn presentation shared by the local test arena and the online arena (visual only). */
export const WEAPON_NAMES: Readonly<Record<WeaponKind, string>> = { shotgun: "Pompalı", smg: "Hafif Makineli" };
/** Hit flash (red) and spawn protection shimmer (pale blue) on the character's skin. */
export const HIT_GLOW = new Color("#ff4a36"),
  SHIELD_GLOW = new Color("#9fd8ff"),
  PUNCH_GLOW = new Color("#f5c66c");
/** Visual view punch per shot (radians), decaying; the aim itself never moves. */
export const VIEW_KICK: Readonly<Record<WeaponKind, number>> = { shotgun: 0.032, smg: 0.009 };
/**
 * Held weapon grip relative to the torso (facing yaw only): out on the gun hand's
 * side and low, past the chunky body and head that would otherwise hide it from the
 * chase camera (seen from behind, a forward-pointing gun is a short upright bar),
 * a little forward — where the gun hand is driven.
 */
export const GRIP = new Vector3(GUN_HAND === 0 ? -0.58 : 0.58, -0.12, 0.3);
export const UP = new Vector3(0, 1, 0);
