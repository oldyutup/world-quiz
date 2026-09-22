import { silentFeedback, type FeedbackSink } from "../../audio/events";
import type { MovementInput } from "../../input/types";
import { COMBAT } from "../combatConfig";
import type { PlaygroundPhysics } from "../physics";
import { PLAYERS, type PlayerId } from "../players";
import {
  HANDS,
  HAND_PARTS,
  PARTS,
  type Hand,
  type PartName,
} from "../ragdoll/config";
import { handPoint } from "../ragdoll/controller";
import {
  add,
  sub,
  mul,
  dot,
  length,
  unit,
  cap,
  rotate,
  conjugate,
  finite,
  clamp,
  type Vec,
} from "../ragdoll/math";
import { resistance, type KnockoutState } from "./knockout";

export interface Grip {
  owner: PlayerId;
  hand: Hand;
  target: PlayerId;
  part: PartName;
  anchor: Vec;
  age: number;
  fatigue: number;
  overload: number;
  force: number;
  liftTime: number;
  turnIn: number;
  jumpIn: number;
  lastX: number;
  lastZ: number;
}
export interface Reach {
  target: PlayerId;
  part: PartName;
  point: Vec;
  distance: number;
}
export class HandGrips {
  readonly hands: [Grip | null, Grip | null][] = PLAYERS.map(() => [
    null,
    null,
  ]);
  readonly incoming = PLAYERS.map(() => new Set<string>());
  readonly protection = PLAYERS.map(() => 0);
  readonly stats = {
    grabs: 0,
    releases: 0,
    escapes: 0,
    overloads: 0,
    twoHands: 0,
  };
  constructor(
    readonly physics: PlaygroundPhysics,
    readonly states: readonly KnockoutState[],
    private readonly feedback: FeedbackSink = silentFeedback
  ) {}
  count(owner: PlayerId, target?: PlayerId) {
    return this.hands[owner].filter(
      (g) => g && (target === undefined || g.target === target)
    ).length;
  }
  private cycles(
    owner: PlayerId,
    target: PlayerId,
    seen = new Set<PlayerId>()
  ): boolean {
    if (target === owner) return true;
    if (seen.has(target)) return false;
    seen.add(target);
    return this.hands[target].some(
      (g) => g && this.cycles(owner, g.target, seen)
    );
  }
  validTarget(owner: PlayerId, target: PlayerId) {
    return (
      !!this.physics.players[owner] &&
      !!this.physics.players[target] &&
      owner !== target &&
      !this.physics.players[owner].eliminated &&
      !this.physics.players[target].eliminated &&
      this.states[owner].state !== "KNOCKED_OUT" &&
      this.protection[target] <= 0 &&
      !this.cycles(owner, target)
    );
  }
  reach(owner: PlayerId, hand: Hand, target?: PlayerId, preferOtherPart?: PartName): Reach | null {
    const character = this.physics.players[owner],
      palm = handPoint(character, hand),
      root = character.body.translation();
    let nearest: Reach | null = null;
    let alternate: Reach | null = null;
    for (const other of this.physics.players) {
      if (target !== undefined && other.id !== target) continue;
      if (!this.validTarget(owner, other.id)) continue;
      const delta = sub(other.body.translation(), root);
      if (
        length(delta) > COMBAT.grip.reach ||
        dot(unit(delta), {
          x: Math.sin(character.facing),
          y: 0,
          z: Math.cos(character.facing),
        }) < -0.15
      )
        continue;
      for (const part of PARTS) {
        const projection = other.parts[part].collider.projectPoint(palm, true);
        if (!projection) continue;
        const point = projection.point;
        const distance = length(sub(point, palm));
        if (finite(point) && this.physics.clearPath(palm, point)) {
          const reach = { target: other.id, part, point, distance };
          if (!nearest || distance < nearest.distance) nearest = reach;
          if (part !== preferOtherPart && (!alternate || distance < alternate.distance)) alternate = reach;
        }
      }
    }
    // Prefer a distinct body part when already within palm acquisition range.
    return preferOtherPart && alternate && alternate.distance <= COMBAT.grip.range ? alternate : nearest;
  }
  acquire(
    owner: PlayerId,
    hand: Hand,
    target: PlayerId,
    part: PartName
  ): Grip | null {
    if (
      !this.validTarget(owner, target) ||
      !HANDS.includes(hand) ||
      this.hands[owner][hand] ||
      !PARTS.includes(part)
    )
      return null;
    const character = this.physics.players[owner],
      other = this.physics.players[target],
      palm = handPoint(character, hand);
    const body = other.parts[part].body,
      projection = other.parts[part].collider.projectPoint(palm, true);
    if (!projection) return null;
    const point = projection.point;
    if (
      !finite(point) ||
      length(sub(palm, point)) > COMBAT.grip.range ||
      length(sub(character.body.translation(), other.body.translation())) >
        COMBAT.grip.maxRootDistance ||
      !this.physics.clearPath(palm, point)
    )
      return null;
    const grip: Grip = {
      owner,
      hand,
      target,
      part,
      anchor: rotate(
        conjugate(body.rotation()),
        sub(point, body.translation())
      ),
      age: 0,
      fatigue: 0,
      overload: 0,
      force: 0,
      liftTime: 0,
      turnIn: 0,
      jumpIn: 0,
      lastX: 0,
      lastZ: 0,
    };
    this.hands[owner][hand] = grip;
    this.incoming[target].add(`${owner}:${hand}`);
    this.stats.grabs++;
    this.feedback({ name: this.count(owner, target) === 2 ? "secondGrab" : "grab", actor: owner, target, x: point.x });
    if (this.count(owner, target) === 2) this.stats.twoHands++;
    return grip;
  }
  release(owner: PlayerId, hand: Hand, reason = "release") {
    const grip = this.hands[owner][hand];
    if (!grip) return null;
    this.hands[owner][hand] = null;
    this.incoming[grip.target].delete(`${owner}:${hand}`);
    if (!this.incoming[grip.target].size)
      this.protection[grip.target] = COMBAT.grip.protection;
    this.stats.releases++;
    if (reason === "escape" || reason === "overload" || reason === "distance")
      this.feedback({ name: "gripBreak", actor: owner, target: grip.target, x: this.physics.players[owner].body.translation().x });
    else if (reason === "release" && this.count(owner, grip.target) === 0) {
      const body = this.physics.players[grip.target].parts.torso.body;
      const speed = length(body.linvel());
      this.feedback({ name: speed >= 2.5 ? "throw" : "release", actor: owner, target: grip.target, x: body.translation().x, intensity: clamp(speed / 10) });
    }
    if (reason === "escape") this.stats.escapes++;
    if (reason === "overload") this.stats.overloads++;
    return grip;
  }
  releasePlayer(id: PlayerId) {
    for (const { id: owner } of PLAYERS)
      for (const hand of HANDS) {
        const grip = this.hands[owner][hand];
        if (grip && (owner === id || grip.target === id))
          this.release(owner, hand, "elimination");
      }
  }
  clear() {
    for (const { id } of PLAYERS)
      for (const hand of HANDS) this.release(id, hand, "round");
    this.protection.fill(0);
    for (const refs of this.incoming) refs.clear();
  }
  point(grip: Grip) {
    const body = this.physics.players[grip.target].parts[grip.part].body;
    return add(body.translation(), rotate(body.rotation(), grip.anchor));
  }
  update(inputs: readonly MovementInput[], dt: number) {
    for (const { id } of PLAYERS)
      this.protection[id] = Math.max(0, this.protection[id] - dt);
    for (const { id: owner } of PLAYERS)
      for (const hand of HANDS) {
        const grip = this.hands[owner][hand];
        if (!grip) continue;
        const actor = this.physics.players[owner],
          target = this.physics.players[grip.target];
        if (
          actor.eliminated ||
          target.eliminated ||
          this.states[owner].state === "KNOCKED_OUT"
        ) {
          this.release(owner, hand, "elimination");
          continue;
        }
        if (!(inputs[owner]?.grab ?? (hand === 0 ? inputs[owner]?.left : inputs[owner]?.right))) {
          this.release(owner, hand);
          continue;
        }
        const palm = handPoint(actor, hand),
          point = this.point(grip),
          delta = sub(point, palm);
        if (
          !finite(delta) ||
          length(delta) > COMBAT.grip.breakDistance ||
          length(sub(actor.body.translation(), target.body.translation())) >
            COMBAT.grip.maxRootDistance ||
          !this.physics.clearPath(palm, point) ||
          grip.age > COMBAT.grip.maxDuration
        ) {
          this.release(owner, hand, "distance");
          continue;
        }
        grip.age += dt;
        grip.turnIn = Math.max(0, grip.turnIn - dt);
        grip.jumpIn = Math.max(0, grip.jumpIn - dt);
        const input = inputs[grip.target],
          x = input?.x ?? 0,
          z = input?.z ?? 0,
          effort = Math.min(1, Math.hypot(x, z));
        const away = unit(
          sub(target.body.translation(), actor.body.translation())
        );
        const opposing = clamp(x * away.x + z * away.z),
          resist = resistance(this.states[grip.target]);
        const two = this.count(owner, grip.target) > 1;
        const maximum =
          (two ? COMBAT.grip.twoForce : COMBAT.grip.oneForce) *
          (1 - 0.35 * grip.fatigue);
        const handBody = actor.parts[HAND_PARTS[hand]].body,
          targetBody = target.parts[grip.part].body;
        const raw = sub(
          mul(delta, COMBAT.grip.spring),
          mul(
            sub(
              handBody.velocityAtPoint(palm),
              targetBody.velocityAtPoint(point)
            ),
            COMBAT.grip.damping
          )
        );
        grip.force = length(raw);
        grip.overload =
          grip.force > maximum * COMBAT.grip.overloadRatio
            ? grip.overload + dt
            : Math.max(0, grip.overload - dt * 2);
        let escape =
          (COMBAT.grip.passiveFatigue +
            COMBAT.grip.escapeRate * effort * (0.35 + 0.65 * opposing) +
            COMBAT.grip.stressFatigue * clamp(grip.force / maximum - 0.6)) *
          dt;
        if (
          effort > 0.5 &&
          grip.turnIn <= 0 &&
          Math.hypot(grip.lastX, grip.lastZ) > 0.5 &&
          x * grip.lastX + z * grip.lastZ < 0.2
        ) {
          escape += COMBAT.grip.turnBonus;
          grip.turnIn = COMBAT.grip.turnInterval;
        }
        if (grip.turnIn <= 0) {
          grip.lastX = x;
          grip.lastZ = z;
        }
        if (
          input?.jump &&
          this.physics.isGrounded(grip.target) &&
          grip.jumpIn <= 0
        ) {
          escape += COMBAT.grip.jumpBonus;
          grip.jumpIn = COMBAT.grip.jumpInterval;
        }
        grip.fatigue = clamp(
          grip.fatigue +
            escape * resist * (two ? COMBAT.grip.twoHandResistance : 1)
        );
        if (grip.fatigue >= 1 || grip.overload >= COMBAT.grip.overloadTime) {
          this.release(owner, hand, grip.fatigue >= 1 ? "escape" : "overload");
          continue;
        }
        const impulse = mul(cap(raw, maximum), dt);
        handBody.applyImpulseAtPoint(impulse, palm, true);
        targetBody.applyImpulseAtPoint(mul(impulse, -1), point, true);
      }
  }
}
