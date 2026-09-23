import { createArenaWorld } from "../../../../shared/party-lab/simulation/world";
import {
  arenaMap,
  ONLINE_ARENA_MAP_ID,
  spawnYaw,
} from "../../../../shared/party-lab/maps";
import { createCharacter } from "../../../../shared/party-lab/simulation/ragdoll/character";
import {
  control,
  normalDrive,
} from "../../../../shared/party-lab/simulation/ragdoll/controller";
import {
  PARTS,
  HANDS,
  RAGDOLL,
  type Hand,
} from "../../../../shared/party-lab/simulation/ragdoll/config";
import {
  cap,
  finite,
  length,
  sub,
} from "../../../../shared/party-lab/simulation/ragdoll/math";
import { COMBAT } from "../../../../shared/party-lab/simulation/combatConfig";
import {
  newPunch,
  tickPunch,
  startPunch,
  punchArmDrive,
} from "../../../../shared/party-lab/simulation/combat/punch";
import type { PlayerId } from "../../../../shared/party-lab/simulation/players";
import type { MovementInput } from "../../../../shared/party-lab/intent";
import {
  VELOCITY_BYTES,
  type GameSnapshot,
} from "../../../../shared/party-lab/network/protocol";

/**
 * Nine real bodies/eight joints, static environment only. No combat, grips, rounds or feedback sink.
 * Builds the same static map as the authoritative server (ONLINE_ARENA_MAP_ID).
 */
export class PredictionRig {
  readonly map = arenaMap(ONLINE_ARENA_MAP_ID);
  readonly world = createArenaWorld(this.map);
  readonly character;
  readonly punches = [newPunch(), newPunch()];
  nextHand: Hand = 0;
  alternateIn = 0;
  private disposed = false;
  constructor(readonly slot: PlayerId) {
    this.character = createCharacter(this.world, slot, this.map.spawns[slot], spawnYaw(this.map, slot));
    // Populate static query structures before grounded tests on a restored snapshot.
    this.world.step();
  }
  restore(snapshot: GameSnapshot, poses: Float32Array) {
    const state = snapshot.prediction;
    if (
      !state ||
      state.slot !== this.slot ||
      !(state.velocities instanceof Uint8Array) ||
      state.velocities.byteLength !== VELOCITY_BYTES ||
      !Array.isArray(state.controller) ||
      state.controller.length !== 9 ||
      !state.controller.every(Number.isFinite)
    )
      return false;
    const view = new DataView(
      state.velocities.buffer,
      state.velocities.byteOffset,
      state.velocities.byteLength
    );
    const velocity = Array.from({ length: 54 }, (_, i) =>
      view.getFloat32(i * 4, true)
    );
    if (!velocity.every(Number.isFinite)) return false;
    const offset = this.slot * 63;
    for (let i = 0; i < 63; i++)
      if (!Number.isFinite(poses[offset + i])) return false;
    for (let i = 0; i < PARTS.length; i++) {
      const body = this.character.parts[PARTS[i]].body,
        at = offset + i * 7,
        v = i * 6;
      const q = {
        x: poses[at + 3],
        y: poses[at + 4],
        z: poses[at + 5],
        w: poses[at + 6],
      };
      if (Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) > 0.02) return false;
      body.setTranslation(
        { x: poses[at], y: poses[at + 1], z: poses[at + 2] },
        true
      );
      body.setRotation(q, true);
      body.setLinvel(
        cap(
          { x: velocity[v], y: velocity[v + 1], z: velocity[v + 2] },
          RAGDOLL.maxSpeed
        ),
        true
      );
      body.setAngvel(
        cap(
          { x: velocity[v + 3], y: velocity[v + 4], z: velocity[v + 5] },
          RAGDOLL.maxAngularSpeed
        ),
        true
      );
      body.resetForces(true);
      body.resetTorques(true);
    }
    const c = state.controller;
    this.character.facing = c[0];
    this.character.gait = c[1];
    this.character.jumpIn = c[2];
    this.character.eliminated = false;
    this.nextHand = c[3] === 1 ? 1 : 0;
    this.alternateIn = c[4];
    this.punches.forEach((p, i) => {
      p.age = c[5 + i * 2];
      p.cooldown = c[6 + i * 2];
      p.hit = false;
    });
    return this.valid();
  }
  step(input: MovementInput): {
    valid: boolean;
    swing: boolean;
    jumped: boolean;
  } {
    const drive = normalDrive();
    this.alternateIn = Math.max(0, this.alternateIn - RAGDOLL.step);
    const hand = this.nextHand;
    let swing = false;
    for (const h of HANDS) {
      tickPunch(this.punches[h], RAGDOLL.step);
      if (
        input.punch &&
        h === hand &&
        this.alternateIn <= 0 &&
        startPunch(this.punches[h])
      ) {
        this.nextHand = h === 0 ? 1 : 0;
        this.alternateIn = COMBAT.punch.alternateInterval;
        swing = true;
      }
      drive.arms[h] =
        punchArmDrive(this.character, h, this.punches[h]) ?? drive.arms[h];
    }
    const jumpBefore = this.character.jumpIn;
    control(this.world, this.character, input, drive);
    const jumped = this.character.jumpIn > jumpBefore;
    this.world.step();
    // Same safety limits as authority; an invalid preview is discarded, never "eliminated" locally.
    for (const part of Object.values(this.character.parts)) {
      part.body.setLinvel(cap(part.body.linvel(), RAGDOLL.maxSpeed), true);
      part.body.setAngvel(
        cap(part.body.angvel(), RAGDOLL.maxAngularSpeed),
        true
      );
    }
    return { valid: this.valid(), swing, jumped };
  }
  valid() {
    const root = this.character.body.translation();
    return Object.values(this.character.parts).every(
      ({ body }) =>
        finite(body.translation()) &&
        finite(body.rotation()) &&
        Number.isFinite(body.rotation().w) &&
        finite(body.linvel()) &&
        finite(body.angvel()) &&
        length(sub(body.translation(), root)) <= RAGDOLL.maxPartSeparation
    );
  }
  pose(out = new Float32Array(63)) {
    let i = 0;
    for (const name of PARTS) {
      const b = this.character.parts[name].body,
        p = b.translation(),
        q = b.rotation();
      for (const n of [p.x, p.y, p.z, q.x, q.y, q.z, q.w]) out[i++] = n;
    }
    return out;
  }
  dispose() {
    if (!this.disposed) {
      this.disposed = true;
      this.world.free();
    }
  }
}
