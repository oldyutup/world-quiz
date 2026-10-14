import { GIFT_MAP } from "../../../../shared/party-lab/maps/gifts";
import { spawnYaw } from "../../../../shared/party-lab/maps";
import { GIFT } from "../../../../shared/party-lab/simulation/gifts/config";
import { decodeGiftWire } from "../../../../shared/party-lab/simulation/gifts/wire";
import { createArenaWorld } from "../../../../shared/party-lab/simulation/world";
import { createCharacter } from "../../../../shared/party-lab/simulation/ragdoll/character";
import { control, normalDrive } from "../../../../shared/party-lab/simulation/ragdoll/controller";
import { PARTS, RAGDOLL } from "../../../../shared/party-lab/simulation/ragdoll/config";
import { cap, finite, length, sub } from "../../../../shared/party-lab/simulation/ragdoll/math";
import { freshLayerFighter, stepLayerFighter, type LayerFighter } from "../../../../shared/party-lab/simulation/layers/brawl";
import { readGiftPredictionState } from "../../../../shared/party-lab/simulation/predictionState";
import { LAYER_FLAG, normalizeMove, VELOCITY_BYTES, type GameSnapshot, type GiftInputPacket } from "../../../../shared/party-lab/network/protocol";
import type { MovementInput } from "../../../../shared/party-lab/intent";
import type { PlayerId } from "../../../../shared/party-lab/simulation/players";

export function giftPacketIntent(p: GiftInputPacket, first: boolean): MovementInput {
  const move = normalizeMove(p.moveX, p.moveZ);
  return { x: move.x, z: move.z, jump: first && p.jumpPressed, punch: first && p.punchPressed };
}
export function canPredictGift(snapshot: GameSnapshot, slot: number) {
  const gift = decodeGiftWire(snapshot.gift),
    flags = gift?.flags[slot] ?? 0;
  return snapshot.mode === "gift_grab" && snapshot.phase === "playing" &&
    !!(snapshot.mask & snapshot.alive & (1 << slot)) &&
    (flags & (LAYER_FLAG.alive | LAYER_FLAG.body)) === (LAYER_FLAG.alive | LAYER_FLAG.body);
}

/**
 * Local-only body replay for Hediye Kapmaca: walking, jumping, the punch's arm and the
 * staggers/stun the server sent. Boxes, homes, hits and the round stay server-owned; the rig
 * only knows its own carrying (a carrier never punches; entering its home puts the box down).
 */
export class GiftPredictionRig {
  readonly world = createArenaWorld(GIFT_MAP);
  readonly character;
  fighter: LayerFighter;
  tick = 0;
  carrying = false;
  stunTicks = 0;
  home = { x: 0, z: 0 };
  private readonly drive = normalDrive();
  private disposed = false;
  constructor(readonly slot: PlayerId) {
    this.character = createCharacter(this.world, slot, GIFT_MAP.spawns[slot], spawnYaw(GIFT_MAP, slot));
    this.fighter = freshLayerFighter(slot);
    this.world.step();
  }
  restore(snapshot: GameSnapshot, poses: Float32Array) {
    const state = snapshot.prediction;
    if (!state || state.slot !== this.slot || !(state.velocities instanceof Uint8Array) || state.velocities.byteLength !== VELOCITY_BYTES) return false;
    const own = readGiftPredictionState(state.gift),
      gift = decodeGiftWire(snapshot.gift);
    if (!own || !gift) return false;
    const view = new DataView(state.velocities.buffer, state.velocities.byteOffset, state.velocities.byteLength),
      velocity = Array.from({ length: 54 }, (_, i) => view.getFloat32(i * 4, true)),
      offset = this.slot * 63;
    if (!velocity.every(Number.isFinite)) return false;
    for (let i = 0; i < 63; i++) if (!Number.isFinite(poses[offset + i])) return false;
    for (let i = 0; i < PARTS.length; i++) {
      const body = this.character.parts[PARTS[i]].body,
        at = offset + i * 7,
        v = i * 6,
        q = { x: poses[at + 3], y: poses[at + 4], z: poses[at + 5], w: poses[at + 6] };
      if (Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) > 0.02) return false;
      body.setEnabled(true);
      body.setTranslation({ x: poses[at], y: poses[at + 1], z: poses[at + 2] }, true);
      body.setRotation(q, true);
      body.setLinvel(cap({ x: velocity[v], y: velocity[v + 1], z: velocity[v + 2] }, RAGDOLL.maxSpeed), true);
      body.setAngvel(cap({ x: velocity[v + 3], y: velocity[v + 4], z: velocity[v + 5] }, RAGDOLL.maxAngularSpeed), true);
      body.resetForces(true);
      body.resetTorques(true);
    }
    const c = this.character;
    c.facing = own.facing;
    c.gait = own.gait;
    c.jumpIn = own.jumpIn;
    c.sprint = own.sprint;
    c.eliminated = false;
    const f = this.fighter;
    f.punchHand = own.punchHand === 0 ? 0 : 1;
    f.punchCooldown = own.punchCooldown;
    f.punch.age = own.punchAge;
    f.punch.cooldown = own.punchSwingCooldown;
    f.punch.hit = false;
    f.stagger = { time: own.staggerTime, posture: own.staggerPosture, mobility: own.staggerMobility };
    f.flash = 0;
    this.carrying = own.carrying > 0.5;
    this.stunTicks = Math.max(0, Math.round(own.stunTicks));
    this.home = { x: own.homeX, z: own.homeZ };
    this.tick = gift.tick;
    return this.valid();
  }
  step(input: MovementInput) {
    // The server's order: the stun counts down first; a stunned player does nothing, a carrier never punches.
    if (this.stunTicks > 0 && --this.stunTicks === 0) this.fighter.stagger.time = 0;
    const own = this.stunTicks > 0 ? { x: 0, z: 0, jump: false } : { ...input, sprint: false, punch: !!input.punch && !this.carrying };
    const { input: effective, swing } = stepLayerFighter(this.fighter, this.character, own, this.drive, RAGDOLL.step, GIFT.punch);
    const jumpBefore = this.character.jumpIn;
    control(this.world, this.character, effective, this.drive);
    const jumped = this.character.jumpIn > jumpBefore;
    this.world.step();
    this.tick++;
    for (const part of Object.values(this.character.parts)) {
      part.body.setLinvel(cap(part.body.linvel(), RAGDOLL.maxSpeed), true);
      part.body.setAngvel(cap(part.body.angvel(), RAGDOLL.maxAngularSpeed), true);
    }
    // Entering its own home puts the box down (the server does the same after physics).
    const p = this.character.body.translation();
    if (this.carrying && Math.hypot(p.x - this.home.x, p.z - this.home.z) <= GIFT.homes.radius) this.carrying = false;
    return { valid: this.valid(), swing, jumped };
  }
  stepPacket(packet: GiftInputPacket, first: boolean) { return this.step(giftPacketIntent(packet, first)); }
  valid() {
    const root = this.character.body.translation();
    return Object.values(this.character.parts).every(({ body }) =>
      finite(body.translation()) && finite(body.rotation()) && Number.isFinite(body.rotation().w) &&
      finite(body.linvel()) && finite(body.angvel()) && length(sub(body.translation(), root)) <= RAGDOLL.maxPartSeparation
    );
  }
  pose(out = new Float32Array(63)) {
    let i = 0;
    for (const name of PARTS) {
      const body = this.character.parts[name].body,
        p = body.translation(),
        q = body.rotation();
      for (const value of [p.x, p.y, p.z, q.x, q.y, q.z, q.w]) out[i++] = value;
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
