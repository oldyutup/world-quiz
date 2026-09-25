import { createArenaWorld } from "../../../../shared/party-lab/simulation/world";
import { spawnYaw } from "../../../../shared/party-lab/maps";
import { COLOR_TILES, COLORS_MAP } from "../../../../shared/party-lab/maps/colors";
import { createCharacter } from "../../../../shared/party-lab/simulation/ragdoll/character";
import { control, normalDrive } from "../../../../shared/party-lab/simulation/ragdoll/controller";
import { PARTS, RAGDOLL } from "../../../../shared/party-lab/simulation/ragdoll/config";
import { cap, finite, length, sub } from "../../../../shared/party-lab/simulation/ragdoll/math";
import { freshLayerFighter, stepLayerFighter, type LayerFighter } from "../../../../shared/party-lab/simulation/layers/brawl";
import { retire } from "../../../../shared/party-lab/simulation/layers/game";
import { createTileColliders, parkTileCollider, restoreTileCollider } from "../../../../shared/party-lab/simulation/layers/tiles";
import { COLOR_CHAOS } from "../../../../shared/party-lab/simulation/colors/config";
import { IN_HOLE_Y } from "../../../../shared/party-lab/simulation/colors/game";
import { ColorFieldKnowledge, decodeColorSnapshot } from "../../../../shared/party-lab/simulation/colors/wire";
import { readLayerPredictionState } from "../../../../shared/party-lab/simulation/predictionState";
import type { PlayerId } from "../../../../shared/party-lab/simulation/players";
import type { MovementInput } from "../../../../shared/party-lab/intent";
import { LAYER_FLAG, VELOCITY_BYTES, type GameSnapshot, type LayerInputPacket } from "../../../../shared/party-lab/network/protocol";
import { layerPacketIntent } from "./layerRig";
import { refreshTileQueries } from "./tileQueries";

/** Whether the local Renk Kaosu character can be predicted from this snapshot (in play, alive, body present). */
export function canPredictColor(snapshot: GameSnapshot, slot: number) {
  const flags = snapshot.colors?.f?.[slot] ?? 0;
  return (
    snapshot.mode === "color_chaos" &&
    snapshot.phase === "playing" &&
    !!(snapshot.mask & snapshot.alive & (1 << slot)) &&
    (flags & (LAYER_FLAG.alive | LAYER_FLAG.body)) === (LAYER_FLAG.alive | LAYER_FLAG.body)
  );
}

/**
 * The local player's Renk Kaosu body: nine real bodies/eight joints on its own copy of the
 * 85 tile colliders, driven by the server's own per-fighter step (`stepLayerFighter` with
 * Renk Kaosu's shove tuning: punch timers and alternation, stagger posture/mobility/no
 * jump, sprint) and the shared controller. No hits, other players or eliminations by
 * falling — those are only ever the server's.
 *
 * Tiles: a replayed or predicted round tick has exactly the server's colliders
 * (`ColorFieldKnowledge.standing`: the target colour always, the rest of the cycle's tiles
 * until its drop tick, from the restore tick the tiles that had a colour). So the body
 * keeps its momentum grace, drops through a tile, and is caught by a target edge on the
 * same ticks as on the server.
 *
 * The below-floor rule: on a restore tick, hips below the floor are out before the tiles
 * come back — the server's rule, on the same tick. The rig then stops (`out`) instead of
 * closing the returning colliders around the body; the server's snapshot confirms it.
 */
export class ColorPredictionRig {
  readonly map = COLORS_MAP;
  readonly world = createArenaWorld(COLORS_MAP);
  readonly colliders = createTileColliders(this.world, COLOR_TILES);
  readonly character;
  fighter: LayerFighter;
  /** The field as of the last restore (the colliders of every tick of the replay). */
  readonly field = new ColorFieldKnowledge();
  /** Round tick the next step's rules use. */
  tick = 0;
  /** Out by the below-floor rule on a predicted restore tick (−1: not). */
  outTick = -1;
  /** Collider state per tile (1 in place, 0 parked). */
  private readonly present = new Uint8Array(COLOR_TILES.length).fill(1);
  private readonly drive = normalDrive();
  /** Tiles brought back by a snapshot restore (the replay went back before a drop the prediction had passed). */
  restored = 0;
  private disposed = false;
  constructor(readonly slot: PlayerId) {
    this.character = createCharacter(this.world, slot, COLORS_MAP.spawns[slot], spawnYaw(COLORS_MAP, slot));
    this.fighter = freshLayerFighter(slot);
    // Populate static query structures before grounded tests on a restored snapshot.
    this.world.step();
  }
  get out() {
    return this.outTick >= 0;
  }
  /** Colliders as of round tick `t` (true: a tile came back, which queries only see after a world step). */
  private syncTiles(t: number) {
    let back = false;
    for (let id = 0; id < COLOR_TILES.length; id++) {
      const want = this.field.standing(id, t) ? 1 : 0;
      if (want === this.present[id]) continue;
      this.present[id] = want;
      if (want) {
        restoreTileCollider(this.colliders[id], COLOR_TILES[id]);
        back = true;
      } else parkTileCollider(this.colliders[id], COLOR_TILES[id]);
    }
    return back;
  }
  restore(snapshot: GameSnapshot, poses: Float32Array) {
    const state = snapshot.prediction;
    if (!state || state.slot !== this.slot || !(state.velocities instanceof Uint8Array) || state.velocities.byteLength !== VELOCITY_BYTES) return false;
    const c = readLayerPredictionState(state.layers);
    const colors = decodeColorSnapshot(snapshot.colors);
    if (!c || !colors) return false;
    const view = new DataView(state.velocities.buffer, state.velocities.byteOffset, state.velocities.byteLength);
    const velocity = Array.from({ length: 54 }, (_, i) => view.getFloat32(i * 4, true));
    if (!velocity.every(Number.isFinite)) return false;
    const offset = this.slot * 63;
    for (let i = 0; i < 63; i++) if (!Number.isFinite(poses[offset + i])) return false;
    // Tiles first, as the server's world holds them after its last step (tick t − 1, ray
    // queries included): a tile the previous prediction dropped may be back, and queries
    // only see it after a world step — taken now with the body off (see refreshTileQueries).
    this.field.reset(snapshot.round);
    this.field.apply(snapshot.round, colors);
    this.tick = colors.t;
    if (this.syncTiles(Math.max(0, this.tick - 1))) {
      this.restored++;
      refreshTileQueries(this.world, this.character);
    }
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
    ch.eliminated = false;
    this.outTick = -1;
    const f = this.fighter;
    f.punchHand = c.punchHand === 0 ? 0 : 1;
    f.punchCooldown = c.punchCooldown;
    f.punch.age = c.punchAge;
    f.punch.cooldown = c.punchSwingCooldown;
    f.punch.hit = false;
    f.stagger = { time: c.staggerTime, posture: c.staggerPosture, mobility: c.staggerMobility };
    f.flash = 0;
    return this.valid();
  }
  /** One fixed tick of the server's order: below-floor rule (restore ticks) → tiles → fighter step → controller → physics. */
  step(input: MovementInput) {
    if (!this.out && this.field.isRestore(this.tick) && this.character.body.translation().y < IN_HOLE_Y) {
      retire(this.character);
      this.outTick = this.tick;
    }
    if (this.out) {
      this.tick++;
      return { valid: true, swing: false, jumped: false };
    }
    this.syncTiles(this.tick);
    const { input: effective, swing } = stepLayerFighter(this.fighter, this.character, input, this.drive, RAGDOLL.step, COLOR_CHAOS.punch);
    const jumpBefore = this.character.jumpIn;
    control(this.world, this.character, effective, this.drive);
    const jumped = this.character.jumpIn > jumpBefore;
    this.world.step();
    this.tick++;
    // Same safety limits as authority; an invalid preview is discarded, never "eliminated" locally.
    for (const part of Object.values(this.character.parts)) {
      part.body.setLinvel(cap(part.body.linvel(), RAGDOLL.maxSpeed), true);
      part.body.setAngvel(cap(part.body.angvel(), RAGDOLL.maxAngularSpeed), true);
    }
    return { valid: this.valid(), swing, jumped };
  }
  stepPacket(packet: LayerInputPacket, first: boolean) {
    return this.step(layerPacketIntent(packet, first));
  }
  /** Whether tile `id`'s collider is in place right now (tests). */
  standing(id: number) {
    return this.present[id] === 1;
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
