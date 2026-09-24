import { createArenaWorld } from "../../../../shared/party-lab/simulation/world";
import { spawnYaw } from "../../../../shared/party-lab/maps";
import { LAYER_TILES, LAYERS_MAP } from "../../../../shared/party-lab/maps/layers";
import { createCharacter } from "../../../../shared/party-lab/simulation/ragdoll/character";
import { control, normalDrive } from "../../../../shared/party-lab/simulation/ragdoll/controller";
import { PARTS, RAGDOLL } from "../../../../shared/party-lab/simulation/ragdoll/config";
import { cap, finite, length, sub } from "../../../../shared/party-lab/simulation/ragdoll/math";
import { freshLayerFighter, stepLayerFighter, type LayerFighter } from "../../../../shared/party-lab/simulation/layers/brawl";
import { createTileColliders, parkTileCollider, restoreTileCollider } from "../../../../shared/party-lab/simulation/layers/tiles";
import { decodeLayerSnapshot, LAYER_FLAG, LayerTileKnowledge } from "../../../../shared/party-lab/simulation/layers/wire";
import { readLayerPredictionState } from "../../../../shared/party-lab/simulation/predictionState";
import type { PlayerId } from "../../../../shared/party-lab/simulation/players";
import type { MovementInput } from "../../../../shared/party-lab/intent";
import { normalizeMove, VELOCITY_BYTES, type GameSnapshot, type LayerInputPacket } from "../../../../shared/party-lab/network/protocol";

/** The intent the server's mailbox makes of a layer packet on a given tick (edges on the first only). */
export function layerPacketIntent(p: LayerInputPacket, first: boolean): MovementInput {
  // The server validates (normalises) the packet it receives: replay the same numbers.
  const move = normalizeMove(p.moveX, p.moveZ);
  return { x: move.x, z: move.z, jump: first && p.jumpPressed, punch: first && p.punchPressed, sprint: p.sprintHeld };
}
/** Whether the local Katman Kaosu character can be predicted from this snapshot (in play, alive, body present). */
export function canPredictLayer(snapshot: GameSnapshot, slot: number) {
  const flags = snapshot.layers?.f?.[slot] ?? 0;
  return (
    snapshot.mode === "layer_chaos" &&
    snapshot.phase === "playing" &&
    !!(snapshot.mask & snapshot.alive & (1 << slot)) &&
    (flags & (LAYER_FLAG.alive | LAYER_FLAG.body)) === (LAYER_FLAG.alive | LAYER_FLAG.body)
  );
}

/**
 * The local player's Katman Kaosu body: nine real bodies/eight joints on its own copy of
 * the 297 tile colliders, driven by the server's own per-fighter step
 * (`stepLayerFighter`: punch timers and alternation, stagger posture/mobility/no jump,
 * sprint) and the shared controller. No arming, hits, other players or eliminations —
 * those are only ever the server's.
 *
 * Tiles: each replayed or predicted tick has a round tick; a tile's collider is there iff
 * that tick is before the tile's GONE tick, which every snapshot fixes (armed tiles: arm
 * tick + break time; GONE ones; untouched ones: the collapse schedule). The local body
 * therefore drops through a tile on exactly the tick the server removes it, and never
 * stands on a tile the server has already removed.
 */
export class LayerPredictionRig {
  readonly map = LAYERS_MAP;
  readonly world = createArenaWorld(LAYERS_MAP);
  readonly colliders = createTileColliders(this.world);
  readonly character;
  fighter: LayerFighter;
  /** Tile state as of the last restore (GONE ticks for every tick of the replay). */
  readonly tiles = new LayerTileKnowledge();
  /** Round tick the next step's rules use. */
  tick = 0;
  /** Collider state per tile (1 in place, 0 parked). */
  private readonly present = new Uint8Array(LAYER_TILES.length).fill(1);
  private readonly drive = normalDrive();
  /** Tiles brought back by a restore (a replay went back before their GONE tick). */
  restored = 0;
  private disposed = false;
  constructor(readonly slot: PlayerId) {
    this.character = createCharacter(this.world, slot, LAYERS_MAP.spawns[slot], spawnYaw(LAYERS_MAP, slot));
    this.fighter = freshLayerFighter(slot);
    // Populate static query structures before grounded tests on a restored snapshot.
    this.world.step();
  }
  /** Colliders as of round tick `t` (true: a tile came back, which queries only see after a world step). */
  private syncTiles(t: number) {
    let back = false;
    for (let id = 0; id < LAYER_TILES.length; id++) {
      const want = t < this.tiles.goneTick(id) ? 1 : 0;
      if (want === this.present[id]) continue;
      this.present[id] = want;
      if (want) {
        restoreTileCollider(this.colliders[id], LAYER_TILES[id]);
        back = true;
        this.restored++;
      } else parkTileCollider(this.colliders[id], LAYER_TILES[id]);
    }
    return back;
  }
  restore(snapshot: GameSnapshot, poses: Float32Array) {
    const state = snapshot.prediction;
    if (!state || state.slot !== this.slot || !(state.velocities instanceof Uint8Array) || state.velocities.byteLength !== VELOCITY_BYTES) return false;
    const c = readLayerPredictionState(state.layers);
    const layers = decodeLayerSnapshot(snapshot.layers);
    if (!c || !layers) return false;
    const view = new DataView(state.velocities.buffer, state.velocities.byteOffset, state.velocities.byteLength);
    const velocity = Array.from({ length: 54 }, (_, i) => view.getFloat32(i * 4, true));
    if (!velocity.every(Number.isFinite)) return false;
    const offset = this.slot * 63;
    for (let i = 0; i < 63; i++) if (!Number.isFinite(poses[offset + i])) return false;
    // Tiles first: a tile a previous prediction had removed may be back (the replay starts
    // before its GONE tick). Ray queries (the controller's support and ground probes) only see
    // it after a world step, so take one now with the body switched off — a solver pass with no
    // time step over the jointed body would throw it around — then restore the body below.
    this.tiles.reset(snapshot.round);
    this.tiles.apply(snapshot.round, layers);
    this.tick = layers.t;
    if (this.syncTiles(this.tick)) this.refreshQueries();
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
  /** A world step that only updates the query structure (the body is disabled and restored after). */
  private refreshQueries() {
    for (const name of PARTS) this.character.parts[name].body.setEnabled(false);
    this.world.timestep = 0;
    this.world.step();
    this.world.timestep = RAGDOLL.step;
  }
  /** One fixed tick of the server's order: tiles due go → fighter step → controller → physics. */
  step(input: MovementInput) {
    this.syncTiles(this.tick);
    const { input: effective, swing } = stepLayerFighter(this.fighter, this.character, input, this.drive, RAGDOLL.step);
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
