import RAPIER from "@dimforge/rapier3d-compat";
import type { PlayerId } from "../players.js";
import { PARTS, RAGDOLL, SHAPES, type PartName } from "./config.js";
import { add, rotate, yaw, zero, type Vec } from "./math.js";

export interface BodyPart {
  name: PartName;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  beforeVelocity: Vec;
}
export interface LimbJoint {
  name: string;
  joint: RAPIER.RevoluteImpulseJoint | RAPIER.SphericalImpulseJoint;
  torque: number;
  spherical: boolean;
}
export interface Character {
  id: PlayerId;
  parts: Record<PartName, BodyPart>;
  body: RAPIER.RigidBody;
  joints: LimbJoint[];
  eliminated: boolean;
  facing: number;
  gait: number;
  jumpIn: number;
}

// Six hard-limited hinges + two ball shoulders with passive cone correction.
// Limits remain during KO. No fixed or rotation-locked bodies.
const CONNECTIONS: [
  string,
  PartName,
  PartName,
  Vec,
  Vec,
  number,
  number,
  number
][] = [
  [
    "spine",
    "pelvis",
    "torso",
    { x: 0, y: 0.19, z: 0 },
    { x: 0, y: -0.19, z: 0 },
    -0.55,
    0.55,
    12,
  ],
  [
    "neck",
    "torso",
    "head",
    { x: 0, y: 0.29, z: 0 },
    { x: 0, y: -0.2, z: 0 },
    -0.75,
    0.75,
    4,
  ],
  [
    "leftShoulder",
    "torso",
    "leftUpper",
    { x: -0.45, y: 0.19, z: 0 },
    { x: 0, y: 0.26, z: 0 },
    -2.9,
    1.1,
    9,
  ],
  [
    "leftElbow",
    "leftUpper",
    "leftHand",
    { x: 0, y: -0.26, z: 0 },
    { x: 0, y: 0.23, z: 0 },
    -2.6,
    0.15,
    6,
  ],
  [
    "rightShoulder",
    "torso",
    "rightUpper",
    { x: 0.45, y: 0.19, z: 0 },
    { x: 0, y: 0.26, z: 0 },
    -2.9,
    1.1,
    9,
  ],
  [
    "rightElbow",
    "rightUpper",
    "rightHand",
    { x: 0, y: -0.26, z: 0 },
    { x: 0, y: 0.23, z: 0 },
    -2.6,
    0.15,
    6,
  ],
  [
    "leftHip",
    "pelvis",
    "leftLeg",
    { x: -0.17, y: -0.12, z: 0 },
    { x: 0, y: 0.3, z: 0 },
    -1.3,
    1.3,
    14,
  ],
  [
    "rightHip",
    "pelvis",
    "rightLeg",
    { x: 0.17, y: -0.12, z: 0 },
    { x: 0, y: 0.3, z: 0 },
    -1.3,
    1.3,
    14,
  ],
];

export function connect(world: RAPIER.World, character: Character) {
  for (const old of character.joints)
    if (old.joint.isValid()) world.removeImpulseJoint(old.joint, true);
  character.joints = CONNECTIONS.map(
    ([name, a, b, anchorA, anchorB, min, max, torque]) => {
      const spherical = name.endsWith("Shoulder");
      const joint = world.createImpulseJoint(
        spherical
          ? RAPIER.JointData.spherical(anchorA, anchorB)
          : RAPIER.JointData.revolute(anchorA, anchorB, { x: 1, y: 0, z: 0 }),
        character.parts[a].body,
        character.parts[b].body,
        true
      ) as RAPIER.RevoluteImpulseJoint | RAPIER.SphericalImpulseJoint;
      joint.setContactsEnabled(false);
      if (!spherical) {
        const hinge = joint as RAPIER.RevoluteImpulseJoint;
        hinge.setLimits(min, max);
        hinge.configureMotorModel(RAPIER.MotorModel.ForceBased);
      }
      return { name, joint, torque, spherical };
    }
  );
}

export function restore(
  character: Character,
  origin: Vec,
  facing = character.facing
) {
  character.facing = facing;
  character.gait = 0;
  character.jumpIn = 0;
  character.eliminated = false;
  const q = yaw(facing);
  for (const name of PARTS) {
    const part = character.parts[name],
      shape = SHAPES[name];
    part.body.setEnabled(true);
    part.body.setTranslation(
      add(origin, rotate(q, { x: shape.x, y: shape.y, z: 0 })),
      true
    );
    part.body.setRotation(q, true);
    part.body.setLinvel(zero(), true);
    part.body.setAngvel(zero(), true);
    part.body.resetForces(true);
    part.body.resetTorques(true);
    part.beforeVelocity = zero();
  }
}

export function createCharacter(
  world: RAPIER.World,
  id: PlayerId,
  spawn: Vec
): Character {
  // Filter same-character contacts (including nonadjacent limbs), retain all opponents/environment.
  const membership = 1 << (id + 1),
    mask = 0xffff ^ membership;
  const parts = Object.fromEntries(
    PARTS.map((name) => {
      const shape = SHAPES[name];
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setLinearDamping(RAGDOLL.damping)
          .setAngularDamping(RAGDOLL.angularDamping)
          .setCcdEnabled(true)
      );
      const desc = shape.half
        ? RAPIER.ColliderDesc.capsule(shape.half, shape.radius)
        : RAPIER.ColliderDesc.ball(shape.radius);
      const inertia = Math.max(
        RAGDOLL.minimumInertia,
        shape.mass * (shape.radius ** 2 + shape.half ** 2) * 0.4
      );
      const collider = world.createCollider(
        desc
          .setMassProperties(
            shape.mass,
            zero(),
            { x: inertia, y: inertia, z: inertia },
            { x: 0, y: 0, z: 0, w: 1 }
          )
          .setFriction(RAGDOLL.friction)
          .setRestitution(0)
          .setCollisionGroups((membership << 16) | mask),
        body
      );
      return [name, { name, body, collider, beforeVelocity: zero() }];
    })
  ) as Record<PartName, BodyPart>;
  const character: Character = {
    id,
    parts,
    body: parts.pelvis.body,
    joints: [],
    eliminated: false,
    facing: Math.atan2(-spawn.x, -spawn.z),
    gait: 0,
    jumpIn: 0,
  };
  restore(character, spawn);
  connect(world, character);
  return character;
}
