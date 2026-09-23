/** Metres, kilograms, seconds. Local prototype; no rendering/server dependencies. */
export const RAGDOLL = {
  step: 1 / 60,
  gravity: -20,
  speed: 4.6,
  /** MovementInput.sprint: target speed and gait cadence multiplier. */
  sprintMultiplier: 1.4,
  /** Seconds for the sprint blend to go fully in or out. */
  sprintRamp: 0.25,
  acceleration: 25,
  airAcceleration: 5,
  braking: 9,
  damping: 0.45,
  angularDamping: 1.4,
  friction: 0.55,
  jumpSpeed: 6.5,
  jumpCooldown: 0.45,
  fallY: -5,
  groundMargin: 0.1,
  standHeight: 0.76,
  supportRange: 0.97,
  supportSpring: 180,
  supportDamping: 35,
  maxSupport: 190,
  postureSpring: 18,
  postureDamping: 3.8,
  postureTorque: 18,
  motorSpring: 25,
  motorDamping: 2.5,
  shoulderCone: 2.8,
  shoulderLimitTorque: 2,
  minimumInertia: 0.035,
  shoulderSpring: 1.2,
  shoulderDamping: 0.3,
  shoulderTorque: 1.2,
  gaitAmplitude: 0.22,
  gaitFrequency: 7,
  turnSpeed: 5,
  /** Turn rate toward an explicit aim yaw (MovementInput.facing), rad/s. */
  aimTurnSpeed: 12,
  /**
   * Idle anchor (CharacterDrive.anchor, barn only): standing still, the target velocity
   * is gain × (anchor − pelvis), at most maxSpeed, through the normal braking limit —
   * never a position edit. A push beyond `anchorRelease` re-anchors where the body is.
   */
  anchorGain: 3,
  anchorMaxSpeed: 0.5,
  anchorRelease: 0.35,
  /** The anchor is only taken once the pelvis moves slower than this (m/s). */
  anchorSettle: 0.3,
  handSpring: 100,
  handDamping: 8,
  handForce: 24,
  maxSpeed: 18,
  maxAngularSpeed: 20,
  maxPartSeparation: 2.6,
} as const;

export const PARTS = [
  "pelvis",
  "torso",
  "head",
  "leftUpper",
  "leftHand",
  "rightUpper",
  "rightHand",
  "leftLeg",
  "rightLeg",
] as const;
export type PartName = (typeof PARTS)[number];
export type Hand = 0 | 1;
export const HANDS = [0, 1] as const;
export const HAND_PARTS = ["leftHand", "rightHand"] as const;
export const SHAPES: Record<
  PartName,
  { x: number; y: number; radius: number; half: number; mass: number }
> = {
  pelvis: { x: 0, y: 0, radius: 0.29, half: 0.07, mass: 0.7 },
  torso: { x: 0, y: 0.38, radius: 0.32, half: 0.12, mass: 0.8 },
  head: { x: 0, y: 0.87, radius: 0.29, half: 0, mass: 0.35 },
  leftUpper: { x: -0.45, y: 0.31, radius: 0.115, half: 0.15, mass: 0.2 },
  leftHand: { x: -0.45, y: -0.18, radius: 0.13, half: 0.12, mass: 0.175 },
  rightUpper: { x: 0.45, y: 0.31, radius: 0.115, half: 0.15, mass: 0.2 },
  rightHand: { x: 0.45, y: -0.18, radius: 0.13, half: 0.12, mass: 0.175 },
  leftLeg: { x: -0.17, y: -0.42, radius: 0.16, half: 0.18, mass: 0.4 },
  rightLeg: { x: 0.17, y: -0.42, radius: 0.16, half: 0.18, mass: 0.4 },
};
export const TOTAL_MASS = PARTS.reduce(
  (sum, name) => sum + SHAPES[name].mass,
  0
);
