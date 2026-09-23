import type { ActionIntent } from "../../input/actions";
import type { MovementInput } from "../../input/types";
import { cameraRelativeMove } from "./barnCamera";

/** Barn-only reads of the same bindings that the rooftop intent does not carry. */
export interface BarnIntentExtra {
  /** The Punch binding is held (automatic fire). */
  attackHeld?: boolean;
  /** The Grab binding was pressed this step (pick up). */
  pickup?: boolean;
  /** Camera pitch (> 0 looks down). */
  aimPitch?: number;
  /** A point on the camera's aim line relative to the pelvis (the simulation bounds it). */
  aimEye?: { x: number; y: number; z: number };
}

/**
 * Barn meaning of the device-free action intent. Movement is camera-relative, the
 * body faces the aim, and the rooftop's bindings are read contextually: Punch
 * (F / left click) is the attack — a punch when unarmed, fire when armed — Grab
 * (E / right click) picks up a weapon, and Lift (Shift) sprints. The rooftop's
 * punch/grab/lift never reach the barn, so no grab or lift gameplay can start here,
 * and saved controls need no new actions. Everything travels as `MovementInput`
 * intent, which a server can replay; hits are resolved by the simulation.
 */
export function barnIntent(raw: ActionIntent, aimYaw: number, extra: BarnIntentExtra = {}): MovementInput {
  return {
    ...cameraRelativeMove(raw.x, raw.z, aimYaw),
    jump: raw.jump,
    facing: aimYaw,
    sprint: raw.lift,
    attack: raw.punch,
    attackHeld: !!extra.attackHeld,
    pickup: !!extra.pickup,
    ...(extra.aimPitch !== undefined && { aimPitch: extra.aimPitch }),
    ...(extra.aimEye && { aimEye: extra.aimEye }),
  };
}
