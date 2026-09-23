/** Input intent only. Taps are consumed once per fixed step. */
export interface MovementInput {
  x: number;
  z: number;
  jump: boolean;
  /** Abstract human actions; per-hand fields below remain bot/physics intents. */
  punch?: boolean;
  grab?: boolean;
  left?: boolean;
  right?: boolean;
  punchLeft?: boolean;
  punchRight?: boolean;
  lift?: boolean;
  /**
   * Aim yaw (radians, atan2(x, z) like the body's facing). When set, the body turns
   * toward it instead of toward the movement direction, so it can strafe and walk
   * backward while aiming. Only the barn's camera sets it; rooftop input never does.
   */
  facing?: number;
  /**
   * Held sprint: raises the locomotion target speed and step cadence by
   * `RAGDOLL.sprintMultiplier`. Only the barn sets it (from the Lift binding); rooftop
   * input never does, so its movement is unchanged.
   */
  sprint?: boolean;
  /**
   * Barn Shootout only (rooftop input never sets these). Contextual attack pressed
   * this step: punch when unarmed, fire when armed.
   */
  attack?: boolean;
  /** Barn: attack held (automatic fire). */
  attackHeld?: boolean;
  /** Barn: pick up the nearest weapon in reach (pressed this step). */
  pickup?: boolean;
  /** Barn: aim pitch (radians, > 0 looks down); `facing` is the aim yaw. */
  aimPitch?: number;
  /**
   * Barn: a point on the camera's aim line, relative to the pelvis. Only the view
   * origin (the simulation bounds it); hits are always resolved by the simulation.
   */
  aimEye?: { x: number; y: number; z: number };
  /**
   * Barn online: the server tick of the remote poses the client was looking at when it
   * attacked (lag compensation). The server validates and bounds it; local play leaves
   * it out and shots resolve against the current poses.
   */
  viewTick?: number;
}
