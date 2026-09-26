import type { ActionIntent } from "../../input/actions";
import type { MovementInput } from "../../input/types";
import type { Bindings } from "../../input/bindings";
import { cameraRelativeMove } from "../arenas/barnCamera";

/** Local auxiliary action, like V. Never steals a saved gameplay binding or spectator E. */
export function whistleKey(bindings: Bindings): string {
  const used = new Set(Object.values(bindings).flat());
  return ["KeyQ", "KeyT", "KeyR", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP", "KeyJ", "KeyL", "KeyZ", "KeyX", "KeyC", "KeyB", "KeyN", "KeyM", "Digit1", "Digit2", "Digit3"].find((key) => !used.has(key))!;
}

/**
 * Saklambaç meaning of the shared bindings (no new actions, so saved controls stay valid):
 * WASD relative to the camera yaw, Lift (Shift) sprints, Jump jumps (never while disguised:
 * the simulation ignores it). The seeker's body faces its aim and Punch (F / left click) fires;
 * a hider turns toward where it walks and Grab (E / right click) takes the nearest prop's shape
 * or, disguised, steps back out. Everything travels as `MovementInput` intent a server could
 * replay; shots and transforms are resolved by the simulation.
 */
export function seekerIntent(raw: ActionIntent, yaw: number, pitch: number, eye: { x: number; y: number; z: number } | null): MovementInput {
  return {
    ...cameraRelativeMove(raw.x, raw.z, yaw),
    jump: raw.jump,
    sprint: raw.lift,
    facing: yaw,
    aimPitch: pitch,
    attack: raw.punch,
    ...(eye && { aimEye: eye }),
  };
}
export function hiderIntent(raw: ActionIntent, yaw: number, transform: boolean): MovementInput {
  return { ...cameraRelativeMove(raw.x, raw.z, yaw), jump: raw.jump, sprint: raw.lift, pickup: transform };
}
