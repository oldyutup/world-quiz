import { silentFeedback, type FeedbackSink } from "../feedback/events.js";
import RAPIER from "@dimforge/rapier3d-compat";
import type { MovementInput } from "../intent.js";
import { PLAYERS, type PlayerId } from "./players.js";
import {
  createCharacter,
  connect,
  restore,
  type Character,
} from "./ragdoll/character.js";
import {
  control,
  grounded,
  normalDrive,
  type CharacterDrive,
} from "./ragdoll/controller.js";
import { PARTS, RAGDOLL } from "./ragdoll/config.js";
import { cap, finite, length, sub, type Vec } from "./ragdoll/math.js";
export const PHYSICS = RAGDOLL;
export const IDLE_INPUT: MovementInput = { x: 0, z: 0, jump: false };
import { createArenaWorld } from "./world.js";
import { arenaMap, DEFAULT_ARENA_MAP_ID, spawnYaw, type ArenaMap } from "../maps/index.js";
let initialization: Promise<void> | undefined;
export function initializePhysics(): Promise<void> {
  return (initialization ??= RAPIER.init().catch((error) => {
    initialization = undefined;
    throw error;
  }));
}
/** 27 visible bodies, 24 anatomical joints. No master capsule or hidden controller body. */
export class PlaygroundPhysics {
  readonly world: RAPIER.World;
  readonly players: Character[];
  readonly normal = PLAYERS.map(normalDrive);
  readonly diagnostics = {
    invalidBodies: 0,
    velocityCaps: 0,
    maxSpeed: 0,
    maxAngularSpeed: 0,
  };
  private disposed = false;
  private readonly eliminations: PlayerId[] = [];
  constructor(
    private readonly feedback: FeedbackSink = silentFeedback,
    readonly map: ArenaMap = arenaMap(DEFAULT_ARENA_MAP_ID)
  ) {
    this.world = createArenaWorld(map);
    this.players = PLAYERS.map(({ id }) =>
      createCharacter(this.world, id, map.spawns[id], spawnYaw(map, id))
    );
  }
  isGrounded(id: PlayerId) {
    return grounded(this.world, this.players[id]);
  }
  clearPath(a: Vec, b: Vec) {
    const direction = sub(b, a),
      distance = length(direction);
    if (!finite(a) || !finite(b)) return false;
    if (distance < 0.001) return true;
    return !this.world.castRay(
      new RAPIER.Ray(a, {
        x: direction.x / distance,
        y: direction.y / distance,
        z: direction.z / distance,
      }),
      distance,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC
    );
  }
  /** Spawn/reset only. Every limb and anatomical joint is restored/recreated. */
  reset() {
    for (const { id } of PLAYERS) {
      const player = this.players[id],
        spawn = this.map.spawns[id];
      restore(player, spawn, spawnYaw(this.map, id));
      connect(this.world, player);
    }
    this.eliminations.length = 0;
  }
  private eliminate(player: Character) {
    if (player.eliminated) return;
    player.eliminated = true;
    if (player.body.translation().y < RAGDOLL.fallY)
      this.feedback({
        name: "fall",
        actor: player.id,
        x: player.body.translation().x,
      });
    for (const part of Object.values(player.parts)) part.body.setEnabled(false);
    this.eliminations.push(player.id);
  }
  private guard(player: Character): boolean {
    for (const part of Object.values(player.parts)) {
      const p = part.body.translation(),
        q = part.body.rotation(),
        v = part.body.linvel(),
        w = part.body.angvel();
      if (
        !finite(p) ||
        !finite(q) ||
        !Number.isFinite(q.w) ||
        !finite(v) ||
        !finite(w) ||
        length(sub(p, player.body.translation())) > RAGDOLL.maxPartSeparation
      ) {
        this.diagnostics.invalidBodies++;
        // Fault containment only: quarantine invalid state and eliminate.
        restore(player, this.map.spawns[player.id]);
        this.eliminate(player);
        return false;
      }
      const speed = length(v),
        spin = length(w);
      this.diagnostics.maxSpeed = Math.max(this.diagnostics.maxSpeed, speed);
      this.diagnostics.maxAngularSpeed = Math.max(
        this.diagnostics.maxAngularSpeed,
        spin
      );
      if (speed > RAGDOLL.maxSpeed) {
        part.body.setLinvel(cap(v, RAGDOLL.maxSpeed), true);
        this.diagnostics.velocityCaps++;
      }
      if (spin > RAGDOLL.maxAngularSpeed) {
        part.body.setAngvel(cap(w, RAGDOLL.maxAngularSpeed), true);
        this.diagnostics.velocityCaps++;
      }
    }
    return true;
  }
  step(
    inputs: readonly MovementInput[],
    drives: readonly CharacterDrive[] = this.normal
  ): readonly PlayerId[] {
    this.eliminations.length = 0;
    for (const player of this.players) {
      if (player.eliminated || !this.guard(player)) continue;
      if (player.body.translation().y < RAGDOLL.fallY) {
        this.eliminate(player);
        continue;
      }
      const jumpBefore = player.jumpIn;
      control(
        this.world,
        player,
        inputs[player.id] ?? IDLE_INPUT,
        drives[player.id] ?? this.normal[player.id]
      );
      if (player.jumpIn > jumpBefore)
        this.feedback({
          name: "jump",
          actor: player.id,
          x: player.body.translation().x,
        });
      for (const name of PARTS)
        player.parts[name].beforeVelocity = {
          ...player.parts[name].body.linvel(),
        };
    }
    this.world.step();
    for (const player of this.players) {
      if (player.eliminated || !this.guard(player)) continue;
      if (player.body.translation().y < RAGDOLL.fallY) this.eliminate(player);
    }
    return this.eliminations;
  }
  dispose() {
    if (!this.disposed) {
      this.disposed = true;
      this.world.free();
    }
  }
}
