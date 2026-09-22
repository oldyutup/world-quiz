import {
  collisionStrength,
  type FeedbackEvent,
  type FeedbackSink,
} from "../feedback/events.js";
import {
  CollisionGate,
  collisionSound,
  type CollisionCandidate,
} from "../feedback/policy.js";
import type { PlaygroundPhysics } from "./physics.js";
import { PARTS } from "./ragdoll/config.js";
import type { BodyPart } from "./ragdoll/character.js";

/** Read-only contact observer; never applies forces or changes combat outcomes. */
export class PhysicsFeedback {
  private gate = new CollisionGate();
  private parts = new Map<number, { part: BodyPart; actor: number }>();
  private time = 0;
  private grounded = [true, true, true];
  private airborne = [0, 0, 0];
  private descent = [0, 0, 0];
  private punchedUntil = new Map<string, number>();
  constructor(
    private readonly physics: PlaygroundPhysics,
    private readonly emit: FeedbackSink
  ) {
    for (const player of physics.players)
      for (const name of PARTS)
        this.parts.set(player.parts[name].collider.handle, {
          part: player.parts[name],
          actor: player.id,
        });
  }
  reset() {
    this.gate.clear();
    this.time = 0;
    this.grounded.fill(true);
    this.airborne.fill(0);
    this.descent.fill(0);
    this.punchedUntil.clear();
  }
  afterStep(dt: number, events: readonly FeedbackEvent[]) {
    this.time += dt;
    for (const event of events)
      if (
        ["bodyHit", "headHit", "limbHit"].includes(event.name) &&
        event.target !== undefined
      )
        this.punchedUntil.set(
          [event.actor, event.target].sort().join(":"),
          this.time + 0.18
        );
    const candidates: CollisionCandidate[] = [];
    const visited = new Set<string>();
    const landed = new Set<number>();
    for (const player of this.physics.players) {
      if (player.eliminated) continue;
      const grounded = this.physics.isGrounded(player.id);
      this.descent[player.id] = Math.max(
        this.descent[player.id],
        -player.parts.pelvis.beforeVelocity.y
      );
      if (!grounded) this.airborne[player.id] += dt;
      if (grounded && !this.grounded[player.id]) {
        // Balance/support may already have slowed the pelvis when feet regain
        // ground; retain real descent from this airborne interval.
        const speed = this.descent[player.id];
        if (this.airborne[player.id] > 0.12 && speed > 1.3) {
          this.emit({
            name: "landing",
            actor: player.id,
            x: player.body.translation().x,
            intensity: Math.min(1, speed / 8),
          });
          landed.add(player.id);
        }
        this.airborne[player.id] = 0;
      }
      this.grounded[player.id] = grounded;
      if (grounded) this.descent[player.id] = 0;
      for (const name of PARTS) {
        const part = player.parts[name];
        this.physics.world.contactPairsWith(part.collider, (other) => {
          const pair = [part.collider.handle, other.handle]
            .sort((a, b) => a - b)
            .join(":");
          if (visited.has(pair)) return;
          visited.add(pair);
          const otherPart = this.parts.get(other.handle);
          const group = otherPart
            ? [player.id, otherPart.actor].sort().join(":")
            : `${player.id}:environment`;
          if ((this.punchedUntil.get(group) ?? 0) > this.time) return;
          this.physics.world.contactPair(
            part.collider,
            other,
            (manifold, flipped) => {
              let impulse = 0;
              for (let i = 0; i < manifold.numContacts(); i++)
                if (manifold.contactDist(i) <= 0.025)
                  impulse += manifold.contactImpulse(i);
              const n = manifold.normal();
              const a = part.beforeVelocity,
                b = otherPart?.part.beforeVelocity ?? { x: 0, y: 0, z: 0 };
              const speed = Math.max(
                0,
                ((a.x - b.x) * n.x + (a.y - b.y) * n.y + (a.z - b.z) * n.z) *
                  (flipped ? -1 : 1)
              );
              const floor = !otherPart && Math.abs(n.y) > 0.65;
              if (floor && landed.has(player.id) && name !== "head") return;
              const hitPart =
                name === "head" || otherPart?.part.name !== "head"
                  ? name
                  : "head";
              candidates.push({
                pair,
                group,
                actor: player.id,
                x: part.body.translation().x,
                part: hitPart,
                floor,
                speed,
                impulse,
                intensity: collisionStrength(speed, impulse),
              });
            }
          );
        });
      }
    }
    for (const candidate of this.gate.select(candidates, this.time))
      this.emit({
        name: collisionSound(candidate),
        actor: candidate.actor,
        x: candidate.x,
        intensity: candidate.intensity,
      });
  }
}
