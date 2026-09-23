import { createArenaWorld } from "../../../../shared/party-lab/simulation/world";
import { arenaMap, spawnYaw } from "../../../../shared/party-lab/maps";
import { SPAWN_CANDIDATES, START_SPAWNS } from "../../../../shared/party-lab/maps/barn";
import { createCharacter } from "../../../../shared/party-lab/simulation/ragdoll/character";
import { control, normalDrive } from "../../../../shared/party-lab/simulation/ragdoll/controller";
import { PARTS, RAGDOLL } from "../../../../shared/party-lab/simulation/ragdoll/config";
import { cap, finite, length, sub } from "../../../../shared/party-lab/simulation/ragdoll/math";
import {
  fighterDrive,
  freshFighter,
  startAttack,
  tickFighter,
  type BarnFighter,
} from "../../../../shared/party-lab/simulation/barn/combat";
import { newWeapon, type WeaponKind } from "../../../../shared/party-lab/simulation/barn/weapons";
import { BARN_COMBAT } from "../../../../shared/party-lab/simulation/barn/config";
import { readBarnPredictionState } from "../../../../shared/party-lab/simulation/predictionState";
import type { PlayerId } from "../../../../shared/party-lab/simulation/players";
import type { MovementInput } from "../../../../shared/party-lab/intent";
import {
  BARN_FIGHTER_FIELDS,
  BARN_FLAG,
  VELOCITY_BYTES,
  WEAPON_CODES,
  type BarnInputPacket,
  type GameSnapshot,
} from "../../../../shared/party-lab/network/protocol";

/**
 * A predicted shot: which weapon life (a new pickup is a new life) and which of its
 * rounds (1-based). Presentation is keyed by (life, round), never by the tick a replay
 * happens to fire it on.
 */
export interface RigShot {
  kind: WeaponKind;
  spread: number;
  life: number;
  round: number;
}
/** What one predicted tick produced for presentation. */
export interface BarnStepResult {
  valid: boolean;
  swing: boolean;
  jumped: boolean;
  shot: RigShot | null;
}
/** The intent the server's mailbox makes of a barn packet on a given tick (edges on the first only). */
export function barnPacketIntent(p: BarnInputPacket, first: boolean): MovementInput {
  return {
    x: p.moveX,
    z: p.moveZ,
    jump: first && p.jumpPressed,
    sprint: p.sprintHeld,
    facing: p.aimYaw,
    aimPitch: p.aimPitch,
    aimEye: { x: p.eyeX, y: p.eyeY, z: p.eyeZ },
    attack: first && p.attackPressed,
    attackHeld: p.attackHeld,
    pickup: false,
    viewTick: p.viewTick,
  };
}
/** Whether the local Barn character can be predicted from this snapshot (alive, in play). */
export function canPredictBarn(snapshot: GameSnapshot, slot: number) {
  const f = snapshot.barn?.f;
  return (
    snapshot.mode === "barn_shootout" &&
    snapshot.phase === "playing" &&
    !!(snapshot.mask & snapshot.alive & (1 << slot)) &&
    !!f &&
    (f[slot * BARN_FIGHTER_FIELDS] & (BARN_FLAG.alive | BARN_FLAG.present)) === (BARN_FLAG.alive | BARN_FLAG.present)
  );
}

/**
 * The local player's Barn body: nine real bodies/eight joints in the static barn only,
 * driven by the same per-fighter rules as the server (`tickFighter`, `startAttack`,
 * `fighterDrive`): aim-facing, sprint blend, idle anchor, trap hold, stagger, the held
 * weapon's arms, punches and the weapon's own ammo/cadence. No hits, traps, pickups,
 * other players or damage — those are only ever the server's.
 */
export class BarnPredictionRig {
  readonly map = arenaMap("barn");
  readonly world = createArenaWorld(this.map);
  readonly character;
  fighter: BarnFighter;
  /** Weapon life, counted from the authority: a new weapon (kind change, more ammo, or after none). */
  weaponLife = 0;
  private serverWeapon: { kind: WeaponKind | null; ammo: number } = { kind: null, ammo: 0 };
  private readonly drive = normalDrive();
  private disposed = false;
  constructor(readonly slot: PlayerId) {
    this.character = createCharacter(this.world, slot, this.map.spawns[slot], spawnYaw(this.map, slot));
    this.fighter = freshFighter(slot, { id: START_SPAWNS[slot], ...SPAWN_CANDIDATES[START_SPAWNS[slot]] });
    // Populate static query structures before grounded tests on a restored snapshot.
    this.world.step();
  }
  restore(snapshot: GameSnapshot, poses: Float32Array) {
    const state = snapshot.prediction;
    if (
      !state ||
      state.slot !== this.slot ||
      !(state.velocities instanceof Uint8Array) ||
      state.velocities.byteLength !== VELOCITY_BYTES
    )
      return false;
    const c = readBarnPredictionState(state.barn);
    if (!c) return false;
    const view = new DataView(state.velocities.buffer, state.velocities.byteOffset, state.velocities.byteLength);
    const velocity = Array.from({ length: 54 }, (_, i) => view.getFloat32(i * 4, true));
    if (!velocity.every(Number.isFinite)) return false;
    const offset = this.slot * 63;
    for (let i = 0; i < 63; i++) if (!Number.isFinite(poses[offset + i])) return false;
    for (let i = 0; i < PARTS.length; i++) {
      const body = this.character.parts[PARTS[i]].body,
        at = offset + i * 7,
        v = i * 6;
      const q = { x: poses[at + 3], y: poses[at + 4], z: poses[at + 5], w: poses[at + 6] };
      if (Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) > 0.02) return false;
      body.setEnabled(true);
      body.setTranslation({ x: poses[at], y: poses[at + 1], z: poses[at + 2] }, true);
      body.setRotation(q, true);
      body.setLinvel(cap({ x: velocity[v], y: velocity[v + 1], z: velocity[v + 2] }, RAGDOLL.maxSpeed), true);
      body.setAngvel(cap({ x: velocity[v + 3], y: velocity[v + 4], z: velocity[v + 5] }, RAGDOLL.maxAngularSpeed), true);
      body.resetForces(true);
      body.resetTorques(true);
    }
    const ch = this.character;
    ch.facing = c.facing;
    ch.gait = c.gait;
    ch.jumpIn = c.jumpIn;
    ch.sprint = c.sprint;
    ch.anchored = c.anchored === 1;
    ch.anchorX = c.anchorX;
    ch.anchorZ = c.anchorZ;
    ch.eliminated = false;
    const f = this.fighter;
    f.alive = c.alive === 1;
    f.punchHand = c.punchHand === 0 ? 0 : 1;
    f.punchCooldown = c.punchCooldown;
    f.punch.age = c.punchAge;
    f.punch.cooldown = c.punchSwingCooldown;
    f.punch.hit = false;
    f.trapped = c.trapped;
    f.stagger = { time: c.staggerTime, posture: c.staggerPosture, mobility: c.staggerMobility };
    f.protection = c.protection;
    f.aimPitch = c.aimPitch;
    const kind = WEAPON_CODES[c.weapon] ?? null;
    const ammo = Math.round(c.ammo);
    // Server ammo only falls within one weapon's life; anything else is a new weapon.
    if (kind && (kind !== this.serverWeapon.kind || ammo > this.serverWeapon.ammo)) this.weaponLife++;
    this.serverWeapon = { kind, ammo };
    if (!kind) f.weapon = null;
    else {
      f.weapon = f.weapon?.kind === kind ? f.weapon : newWeapon(kind);
      f.weapon.ammo = Math.round(c.ammo);
      f.weapon.cooldown = c.weaponCooldown;
      f.weapon.bloom = c.bloom;
    }
    return this.valid();
  }
  /** One fixed tick of the server's per-fighter order: timers → attack → drive → physics. */
  step(input: MovementInput): BarnStepResult {
    const f = this.fighter;
    if (!f.alive) return { valid: this.valid(), swing: false, jumped: false, shot: null };
    tickFighter(f, RAGDOLL.step, !!input.attackHeld);
    const ammoBefore = f.weapon?.ammo ?? 0;
    const attack = startAttack(f, input);
    const effective = fighterDrive(f, this.character, input, this.drive);
    const jumpBefore = this.character.jumpIn;
    control(this.world, this.character, effective, this.drive);
    const jumped = this.character.jumpIn > jumpBefore;
    this.world.step();
    // Same safety limits as authority; an invalid preview is discarded, never "killed" locally.
    for (const part of Object.values(this.character.parts)) {
      part.body.setLinvel(cap(part.body.linvel(), RAGDOLL.maxSpeed), true);
      part.body.setAngvel(cap(part.body.angvel(), RAGDOLL.maxAngularSpeed), true);
    }
    return {
      valid: this.valid(),
      swing: attack?.kind === "punch",
      jumped,
      shot:
        attack?.kind === "fire"
          ? { kind: attack.weapon, spread: attack.spread, life: this.weaponLife, round: BARN_COMBAT[attack.weapon].ammo - ammoBefore + 1 }
          : null,
    };
  }
  stepPacket(packet: BarnInputPacket, first: boolean) {
    return this.step(barnPacketIntent(packet, first));
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
