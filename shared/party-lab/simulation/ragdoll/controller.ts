import RAPIER from "@dimforge/rapier3d-compat";
import type { MovementInput } from "../../intent.js";
import type { Character } from "./character.js";
import {
  HANDS,
  HAND_PARTS,
  PARTS,
  RAGDOLL,
  SHAPES,
  TOTAL_MASS,
} from "./config.js";
import {
  add,
  sub,
  mul,
  cap,
  clamp,
  rotate,
  product,
  conjugate,
  yaw,
  type Vec,
} from "./math.js";

export interface ArmDrive {
  shoulder: number;
  elbow: number;
  target?: Vec;
  force?: number;
}
export interface CharacterDrive {
  posture: number;
  mobility: number;
  jump: boolean;
  arms: [ArmDrive, ArmDrive];
}
export const normalDrive = (): CharacterDrive => ({
  posture: 1,
  mobility: 1,
  jump: true,
  arms: [
    { shoulder: -0.25, elbow: -0.35 },
    { shoulder: -0.25, elbow: -0.35 },
  ],
});
export function handPoint(character: Character, hand: 0 | 1): Vec {
  const body = character.parts[HAND_PARTS[hand]].body;
  return add(
    body.translation(),
    rotate(body.rotation(), { x: 0, y: -0.19, z: 0 })
  );
}

/** Static ground only. Heads/arms and other players can never grant a jump. */
export function floorBelow(world: RAPIER.World, position: Vec, range: number) {
  const ray = new RAPIER.Ray(position, { x: 0, y: -1, z: 0 });
  const hit = world.castRayAndGetNormal(
    ray,
    range,
    false,
    RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC
  );
  return hit && hit.normal.y > 0.65 ? hit.timeOfImpact : null;
}
export function grounded(world: RAPIER.World, character: Character): boolean {
  if (
    character.eliminated ||
    character.jumpIn > 0 ||
    character.body.linvel().y > 0.6
  )
    return false;
  const up = rotate(character.body.rotation(), { x: 0, y: 1, z: 0 });
  if (up.y < 0.6) return false;
  return (["leftLeg", "rightLeg"] as const).some((name) => {
    const part = character.parts[name],
      shape = SHAPES[name];
    const toe = add(
      part.body.translation(),
      rotate(part.body.rotation(), { x: 0, y: -shape.half, z: 0 })
    );
    return floorBelow(world, toe, shape.radius + RAGDOLL.groundMargin) !== null;
  });
}

function upright(character: Character, strength: number, dt: number) {
  for (const name of ["pelvis", "torso"] as const) {
    const body = character.parts[name].body;
    const error = product(yaw(character.facing), conjugate(body.rotation()));
    const axis = mul(error, error.w < 0 ? -2 : 2);
    const torque = cap(
      sub(
        mul(axis, RAGDOLL.postureSpring),
        mul(body.angvel(), RAGDOLL.postureDamping)
      ),
      RAGDOLL.postureTorque * strength
    );
    body.applyTorqueImpulse(mul(torque, dt * strength), true);
  }
}

export function control(
  world: RAPIER.World,
  character: Character,
  input: MovementInput,
  drive: CharacterDrive
) {
  const dt = RAGDOLL.step;
  character.jumpIn = Math.max(0, character.jumpIn - dt);
  const movement = Math.min(1, Math.hypot(input.x, input.z));
  if (movement > 0.15 && drive.mobility > 0) {
    const angle = Math.atan2(input.x, input.z),
      delta = Math.atan2(
        Math.sin(angle - character.facing),
        Math.cos(angle - character.facing)
      );
    character.facing += clamp(
      delta,
      -RAGDOLL.turnSpeed * dt,
      RAGDOLL.turnSpeed * dt
    );
  }
  character.gait += dt * RAGDOLL.gaitFrequency * movement;
  for (const { name, joint, torque, spherical } of character.joints) {
    let target = 0;
    if (name === "leftHip")
      target = Math.sin(character.gait) * RAGDOLL.gaitAmplitude * movement;
    if (name === "rightHip")
      target = -Math.sin(character.gait) * RAGDOLL.gaitAmplitude * movement;
    if (name === "leftShoulder") target = drive.arms[0].shoulder;
    if (name === "rightShoulder") target = drive.arms[1].shoulder;
    if (name === "leftElbow") target = drive.arms[0].elbow;
    if (name === "rightElbow") target = drive.arms[1].elbow;
    if (spherical) {
      // Rapier 0.20 returns a generic wrapper for spherical descriptors. Drive
      // actual shoulder bodies with bounded equal/opposite corrective torques.
      const parent = joint.body1(),
        child = joint.body2();
      const desired = product(parent.rotation(), {
        x: Math.sin(target / 2),
        y: 0,
        z: 0,
        w: Math.cos(target / 2),
      });
      const error = product(desired, conjugate(child.rotation()));
      const correction = cap(
        sub(
          mul(error, (error.w < 0 ? -1 : 1) * RAGDOLL.shoulderSpring),
          mul(sub(child.angvel(), parent.angvel()), RAGDOLL.shoulderDamping)
        ),
        RAGDOLL.shoulderTorque * drive.posture
      );
      child.applyTorqueImpulse(mul(correction, dt * drive.posture), true);
      parent.applyTorqueImpulse(mul(correction, -dt * drive.posture), true);
      // Passive broad shoulder cone remains even when conscious motors are off.
      const a = joint.body1(),
        b = joint.body2(),
        q = product(b.rotation(), conjugate(a.rotation()));
      const angle = 2 * Math.acos(clamp(Math.abs(q.w), 0, 1));
      if (angle > RAGDOLL.shoulderCone) {
        const correction = cap(
          mul(q, (q.w < 0 ? 1 : -1) * (angle - RAGDOLL.shoulderCone) * 8),
          RAGDOLL.shoulderLimitTorque
        );
        b.applyTorqueImpulse(mul(correction, dt), true);
        a.applyTorqueImpulse(mul(correction, -dt), true);
      }
    } else {
      const hinge = joint as RAPIER.RevoluteImpulseJoint;
      hinge.configureMotorPosition(
        target,
        RAGDOLL.motorSpring * drive.posture,
        RAGDOLL.motorDamping * drive.posture
      );
      hinge.setMotorMaxForce(torque * drive.posture);
    }
  }
  if (drive.posture <= 0) return; // KO: no balance, locomotion, arm assistance, or jumping.
  upright(character, drive.posture, dt);
  const p = character.body.translation(),
    velocity = character.body.linvel();
  const onGround = grounded(world, character);
  const support = floorBelow(world, p, RAGDOLL.supportRange);
  // Ground-conditioned stand-up assistance, applied to the real pelvis, never a hidden root.
  if (support !== null && character.jumpIn <= 0 && velocity.y < 2) {
    const force = clamp(
      TOTAL_MASS * -RAGDOLL.gravity +
        (RAGDOLL.standHeight - support) * RAGDOLL.supportSpring -
        velocity.y * RAGDOLL.supportDamping,
      0,
      RAGDOLL.maxSupport
    );
    character.body.applyImpulse(
      { x: 0, y: force * dt * drive.posture, z: 0 },
      true
    );
  }
  const normalizer = Math.max(1, Math.hypot(input.x, input.z));
  const desired = {
    x: (input.x / normalizer) * RAGDOLL.speed * drive.mobility,
    y: 0,
    z: (input.z / normalizer) * RAGDOLL.speed * drive.mobility,
  };
  const accel =
    onGround || support !== null
      ? movement
        ? RAGDOLL.acceleration
        : RAGDOLL.braking
      : RAGDOLL.airAcceleration * movement;
  const change = cap(
    sub(desired, { x: velocity.x, y: 0, z: velocity.z }),
    accel * dt * drive.mobility
  );
  // Drive visible pelvis/torso, with the feet and joints taking real contacts.
  character.body.applyImpulse(mul(change, TOTAL_MASS * 0.55), true);
  character.parts.torso.body.applyImpulse(mul(change, TOTAL_MASS * 0.45), true);
  if (input.jump && drive.jump && onGround) {
    for (const name of PARTS) {
      const body = character.parts[name].body;
      body.applyImpulse(
        {
          x: 0,
          y:
            Math.max(0, RAGDOLL.jumpSpeed - body.linvel().y) *
            SHAPES[name].mass,
          z: 0,
        },
        true
      );
    }
    character.jumpIn = RAGDOLL.jumpCooldown;
  }
  for (const hand of HANDS) {
    const arm = drive.arms[hand];
    const body = character.parts[HAND_PARTS[hand]].body,
      point = handPoint(character, hand);
    const target =
      arm.target ??
      add(
        character.body.translation(),
        rotate(yaw(character.facing), {
          x: hand === 0 ? -0.4 : 0.4,
          y: 0.43,
          z: 0.3,
        })
      );
    const force = cap(
      sub(
        mul(sub(target, point), RAGDOLL.handSpring),
        mul(
          sub(body.velocityAtPoint(point), character.body.linvel()),
          RAGDOLL.handDamping
        )
      ),
      arm.force ?? RAGDOLL.handForce
    );
    body.applyImpulse(mul(force, dt), true);
    character.parts.torso.body.applyImpulse(mul(force, -dt), true);
  }
}
