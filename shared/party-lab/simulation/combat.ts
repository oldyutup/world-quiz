import {
  hitSound,
  silentFeedback,
  type FeedbackSink,
} from "../feedback/events.js";
import type { MovementInput } from "../intent.js";
import { COMBAT } from "./combatConfig.js";
import { HandGrips } from "./combat/grab.js";
import {
  createKnockout,
  resetKnockout,
  tickKnockout,
  controlStrength,
  impact,
} from "./combat/knockout.js";
import { liftQuality } from "./combat/lift.js";
import {
  newPunch,
  startPunch,
  tickPunch,
  activePunch,
  punchPower,
} from "./combat/punch.js";
import { IDLE_INPUT, type PlaygroundPhysics } from "./physics.js";
import { PLAYERS } from "./players.js";
import { HANDS, HAND_PARTS, PARTS, type Hand } from "./ragdoll/config.js";
import { normalDrive } from "./ragdoll/controller.js";
import {
  add,
  sub,
  mul,
  dot,
  unit,
  length,
  clamp,
  rotate,
  yaw,
} from "./ragdoll/math.js";
import type { RoundPhase } from "./roundLogic.js";

export class CombatSimulation {
  readonly players = PLAYERS.map(({ id }) => ({
    id,
    condition: createKnockout(),
    punches: [newPunch(), newPunch()],
    heldFor: [0, 0],
    flash: 0,
    alternateIn: 0,
    releaseIn: 0,
    nextPunchHand: 0 as Hand,
  }));
  readonly grips: HandGrips;
  readonly drives = PLAYERS.map(normalDrive);
  readonly stats = {
    punches: 0,
    hits: 0,
    headHits: 0,
    knockouts: 0,
    lifts: 0,
    releases: 0,
  };
  constructor(
    readonly physics: PlaygroundPhysics,
    private readonly feedback: FeedbackSink = silentFeedback
  ) {
    this.grips = new HandGrips(
      physics,
      this.players.map((p) => p.condition),
      feedback
    );
  }
  reset() {
    this.grips.clear();
    for (const p of this.players) {
      resetKnockout(p.condition);
      p.punches = [newPunch(), newPunch()];
      p.heldFor = [0, 0];
      p.nextPunchHand = 0;
      p.flash = p.alternateIn = p.releaseIn = 0;
      this.drives[p.id] = normalDrive();
    }
  }
  stop() {
    this.grips.clear();
    for (const p of this.players) {
      p.punches.forEach((h) => {
        h.age = -1;
      });
      p.heldFor.fill(0);
    }
  }
  cleanupEliminations() {
    for (const p of this.physics.players)
      if (p.eliminated) this.grips.releasePlayer(p.id);
  }
  step(inputs: readonly MovementInput[], dt: number, phase: RoundPhase) {
    if (phase !== "playing") {
      this.stop();
      return this.drives;
    }
    this.cleanupEliminations();
    for (const p of this.players) {
      const previousCondition = p.condition.state;
      tickKnockout(p.condition, dt);
      if (
        previousCondition === "KNOCKED_OUT" &&
        p.condition.state === "RECOVERING"
      )
        this.feedback({
          name: "recovery",
          actor: p.id,
          x: this.physics.players[p.id].body.translation().x,
        });
      p.flash = Math.max(0, p.flash - dt);
      p.alternateIn = Math.max(0, p.alternateIn - dt);
      p.releaseIn = Math.max(0, p.releaseIn - dt);
      const actor = this.physics.players[p.id],
        input = inputs[p.id] ?? IDLE_INPUT;
      const strength = controlStrength(p.condition),
        drive = this.drives[p.id];
      drive.posture = strength;
      drive.mobility =
        p.condition.state === "DAZED"
          ? COMBAT.knockout.dazedMobility
          : strength;
      drive.jump = strength > 0.65;
      // Human Punch chooses a physical hand only here. Bots retain their intents.
      let requestedHand = p.nextPunchHand;
      if (this.grips.hands[p.id][requestedHand])
        requestedHand = requestedHand === 0 ? 1 : 0;
      const firstReachHand =
        input.grab && !this.grips.count(p.id)
          ? HANDS.filter(
              (hand) => p.punches[hand].age < 0 && !this.grips.hands[p.id][hand]
            )
              .map((hand) => ({ hand, reach: this.grips.reach(p.id, hand) }))
              .sort(
                (a, b) =>
                  (a.reach?.distance ?? Infinity) -
                  (b.reach?.distance ?? Infinity)
              )[0]?.hand
          : undefined;
      for (const hand of HANDS) {
        const down = input.grab ?? (hand === 0 ? !!input.left : !!input.right),
          request = input.punch
            ? hand === requestedHand
            : hand === 0
            ? input.punchLeft
            : input.punchRight;
        const punch = p.punches[hand];
        tickPunch(punch, dt);
        p.heldFor[hand] = down ? p.heldFor[hand] + dt : 0;
        const grip = this.grips.hands[p.id][hand];
        if (grip && !down) {
          // Momentum is preserved on release. One small horizontal assist per owner,
          // only after an intentional lift with movement; never a canned throw.
          if (
            input.lift &&
            Math.hypot(input.x, input.z) > 0.3 &&
            grip.liftTime >= COMBAT.release.minimumLift &&
            p.releaseIn <= 0 &&
            strength > 0
          ) {
            const target = this.physics.players[grip.target];
            target.parts.torso.body.applyImpulse(
              {
                x: Math.sin(actor.facing) * COMBAT.release.assist,
                y: 0,
                z: Math.cos(actor.facing) * COMBAT.release.assist,
              },
              true
            );
            p.releaseIn = COMBAT.release.cooldown;
            this.stats.releases++;
          }
          this.grips.release(p.id, hand);
        }
        if (actor.eliminated || p.condition.state === "KNOCKED_OUT") {
          punch.age = -1;
          this.grips.release(p.id, hand, "knockout");
          drive.arms[hand] = { shoulder: 0, elbow: 0 };
          continue;
        }
        if (request && !grip && p.alternateIn <= 0 && startPunch(punch)) {
          if (input.punch) p.nextPunchHand = hand === 0 ? 1 : 0;
          p.alternateIn = COMBAT.punch.alternateInterval;
          this.stats.punches++;
          this.feedback({
            name: "punchSwing",
            actor: p.id,
            x: actor.body.translation().x,
          });
        }
        const reaching =
          down &&
          (input.grab !== undefined ||
            p.heldFor[hand] >= COMBAT.holdThreshold) &&
          punch.age < 0;
        drive.arms[hand] = { shoulder: -0.25, elbow: -0.35 };
        if (
          punch.age >= 0 &&
          punch.age < COMBAT.punch.startup + COMBAT.punch.active
        ) {
          drive.arms[hand] = {
            shoulder:
              punch.age < COMBAT.punch.startup ? -0.35 : COMBAT.punch.shoulder,
            elbow: COMBAT.punch.elbow,
          };
          if (punch.age >= COMBAT.punch.startup) {
            drive.arms[hand].target = add(
              actor.body.translation(),
              rotate(yaw(actor.facing), {
                x: hand === 0 ? -0.14 : 0.14,
                y: 0.82,
                z: 0.95,
              })
            );
            drive.arms[hand].force = COMBAT.punch.handForce;
          }
        } else if (reaching && !this.grips.hands[p.id][hand]) {
          const paired = this.grips.hands[p.id].find((g) => g !== null);
          // Before acquisition only the best available hand reaches. Afterwards
          // the other hand must seek this opponent, never a second player.
          if (input.grab && !paired && hand !== firstReachHand) continue;
          const reach = this.grips.reach(
            p.id,
            hand,
            input.grab ? paired?.target : undefined,
            input.grab ? paired?.part : undefined
          );
          if (reach) {
            drive.arms[hand] = {
              shoulder: -1,
              elbow: -0.5,
              target: reach.point,
              force: COMBAT.lift.reachForce,
            };
            if (reach.distance <= COMBAT.grip.range)
              this.grips.acquire(p.id, hand, reach.target, reach.part);
          } else drive.arms[hand] = { shoulder: -1.25, elbow: -0.2 };
        }
      }
    }
    this.grips.update(inputs, dt);
    for (const p of this.players) {
      const actor = this.physics.players[p.id],
        input = inputs[p.id] ?? IDLE_INPUT;
      for (const hand of HANDS) {
        const grip = this.grips.hands[p.id][hand];
        if (!grip) continue;
        const target = this.physics.players[grip.target],
          targetInput = inputs[grip.target] ?? IDLE_INPUT;
        const effort = Math.min(1, Math.hypot(targetInput.x, targetInput.z));
        const condition = this.players[grip.target].condition;
        const quality = liftQuality(
          this.grips.count(p.id, grip.target),
          condition.state,
          condition.state === "KNOCKED_OUT" ? 0 : effort,
          length(sub(actor.body.translation(), target.body.translation()))
        );
        const lift = input.lift ? quality : 0;
        if (lift > 0.3) {
          if (grip.liftTime === 0) {
            this.stats.lifts++;
            this.feedback({
              name: "lift",
              actor: p.id,
              x: actor.body.translation().x,
              intensity: quality,
            });
          }
          grip.liftTime += dt;
        }
        // Raised arm targets pull the actual hand; the point hold transmits that force
        // to whichever target limb was grabbed. The target gets no lift velocity edit.
        const offset = {
          x: hand === 0 ? -0.34 : 0.34,
          y: input.lift ? 0.25 + COMBAT.lift.height * lift : 0.25,
          z: COMBAT.lift.forward,
        };
        const point = add(
          actor.body.translation(),
          rotate(yaw(actor.facing), offset)
        );
        this.drives[p.id].arms[hand] = {
          shoulder: input.lift ? -2.5 : -1.3,
          elbow: -0.4,
          target: point,
          force: COMBAT.lift.reachForce + COMBAT.lift.force * lift,
        };
      }
      if (this.grips.count(p.id) > 0)
        this.drives[p.id].mobility *= COMBAT.lift.carrySpeed;
    }
    return this.drives;
  }
  /** Contact of an actively punching physical forearm, not a cone/range attack. */
  afterStep() {
    this.cleanupEliminations();
    for (const attacker of this.players) {
      const actor = this.physics.players[attacker.id];
      if (actor.eliminated || attacker.condition.state === "KNOCKED_OUT")
        continue;
      for (const hand of HANDS) {
        const punch = attacker.punches[hand];
        if (!activePunch(punch)) continue;
        const part = actor.parts[HAND_PARTS[hand]],
          facing = {
            x: Math.sin(actor.facing),
            y: 0,
            z: Math.cos(actor.facing),
          };
        let best: {
          target: typeof actor;
          part: typeof actor.parts.torso;
          power: number;
          point: { x: number; y: number; z: number };
          direction: { x: number; y: number; z: number };
        } | null = null;
        for (const other of this.physics.players) {
          if (other.id === actor.id || other.eliminated) continue;
          for (const name of PARTS) {
            const targetPart = other.parts[name],
              contact = part.collider.contactCollider(
                targetPart.collider,
                COMBAT.punch.contactMargin
              );
            if (!contact) continue;
            const direction = unit(
              sub(targetPart.body.translation(), part.body.translation())
            );
            const relative = sub(
              part.beforeVelocity,
              targetPart.beforeVelocity
            );
            const closing = Math.max(0, dot(relative, direction));
            const alignment = clamp(
              dot(facing, unit({ x: direction.x, y: 0, z: direction.z })),
              0,
              1
            );
            const power = punchPower(name, closing, alignment);
            if (
              power > 0 &&
              (!best || power > best.power) &&
              this.physics.clearPath(part.body.translation(), contact.point2)
            )
              best = {
                target: other,
                part: targetPart,
                power,
                point: contact.point2,
                direction,
              };
          }
        }
        if (best) {
          punch.hit = true;
          this.stats.hits++;
          if (best.part.name === "head") this.stats.headHits++;
          const victim = this.players[best.target.id];
          victim.flash = COMBAT.punch.flash;
          this.feedback({
            name: hitSound(best.part.name),
            actor: attacker.id,
            target: victim.id,
            x: best.point.x,
            intensity: clamp(best.power / COMBAT.knockout.head),
          });
          const assist = mul(
            best.direction,
            COMBAT.punch.maxAssist * clamp(best.power / COMBAT.knockout.head)
          );
          best.part.body.applyImpulseAtPoint(assist, best.point, true);
          part.body.applyImpulse(mul(assist, -COMBAT.punch.recoil), true);
          if (impact(victim.condition, best.power)) {
            this.stats.knockouts++;
            this.feedback({
              name: "knockout",
              actor: victim.id,
              x: best.point.x,
              intensity: 1,
            });
            for (const hand of HANDS)
              this.grips.release(victim.id, hand, "knockout");
            victim.punches.forEach((p) => (p.age = -1));
          }
        }
      }
    }
  }
}
