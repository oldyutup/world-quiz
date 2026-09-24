import { hitSound, silentFeedback, type FeedbackSink } from "../../feedback/events.js";
import type { MovementInput } from "../../intent.js";
import { COMBAT } from "../combatConfig.js";
import { activePunch, newPunch, punchArmDrive, punchPower, tickPunch, type Punch } from "../combat/punch.js";
import { IDLE_INPUT, type PlaygroundPhysics } from "../physics.js";
import { PLAYERS, type PlayerId } from "../players.js";
import type { Character } from "../ragdoll/character.js";
import { HAND_PARTS, HANDS, PARTS, SHAPES, type Hand, type PartName } from "../ragdoll/config.js";
import { normalDrive, type ArmDrive, type CharacterDrive } from "../ragdoll/controller.js";
import { clamp, dot, sub, unit, type Vec } from "../ragdoll/math.js";
import { LAYER_CHAOS } from "./config.js";

export interface LayerFighter {
  readonly id: PlayerId;
  punch: Punch;
  punchHand: Hand;
  /** Seconds until the next punch may start. */
  punchCooldown: number;
  stagger: { time: number; posture: number; mobility: number };
  /** Seconds of hit flash left (presentation). */
  flash: number;
}
export interface LayerShove {
  attacker: PlayerId;
  target: PlayerId;
  part: PartName;
  point: Vec;
  /** Whether this hit started a stagger (a hit during one only pushes). */
  staggered: boolean;
}

const REST_ARM: ArmDrive = { shoulder: -0.25, elbow: -0.35 };
/** Timers count seconds in 1/60 steps; this absorbs the rounding (0.35 s is exactly 21 steps). */
const EPSILON = 1e-9;
export const freshLayerFighter = (id: PlayerId): LayerFighter => ({
  id,
  punch: newPunch(),
  punchHand: 1,
  punchCooldown: 0,
  stagger: { time: 0, posture: 1, mobility: 1 },
  flash: 0,
});

/**
 * Katman Kaosu's only contact: a punch that shoves. No health, no knockout meter, no
 * damage — a landed punch gives the target a whole-body velocity change (every part
 * mass × Δv, `punch.push` horizontally + `punch.lift` up) and a short stagger (lower
 * posture and mobility, no jump). A hit during a stagger still pushes but never
 * extends it. Punches start from the Punch intent, alternate hands every
 * `punch.cooldown`, and land only by real hand contact (the rooftop/Barn rule). No
 * grab, lift, weapons or traps.
 *
 * Per playing step: `step()` before physics returns the effective inputs and drives;
 * `afterStep()` resolves this step's hand contacts.
 */
export class LayerBrawl {
  readonly fighters = PLAYERS.map(({ id }) => freshLayerFighter(id));
  readonly drives = PLAYERS.map(normalDrive);
  /** Effective per-step inputs: movement, jump and sprint only. */
  readonly inputs: MovementInput[] = PLAYERS.map(() => IDLE_INPUT);
  /** This step's landed shoves. */
  readonly shoves: LayerShove[] = [];
  readonly stats = { punches: 0, hits: 0, staggers: 0 };
  constructor(
    readonly physics: PlaygroundPhysics,
    private readonly feedback: FeedbackSink = silentFeedback
  ) {}

  reset() {
    PLAYERS.forEach(({ id }) => {
      this.fighters[id] = freshLayerFighter(id);
      this.drives[id] = normalDrive();
      this.inputs[id] = IDLE_INPUT;
    });
    this.shoves.length = 0;
  }
  /** Countdown/results: no punches in flight. */
  stop() {
    for (const f of this.fighters) {
      f.punch.age = -1;
      f.stagger.time = 0;
    }
    this.shoves.length = 0;
  }

  step(inputs: readonly MovementInput[], dt: number) {
    this.shoves.length = 0;
    for (const f of this.fighters) {
      const character = this.physics.players[f.id];
      const { input, swing } = stepLayerFighter(f, character, inputs[f.id] ?? IDLE_INPUT, this.drives[f.id], dt);
      if (swing) {
        this.stats.punches++;
        this.feedback({ name: "punchSwing", actor: f.id, x: character.body.translation().x });
      }
      this.inputs[f.id] = input;
    }
    return { inputs: this.inputs, drives: this.drives };
  }

  /** Punch contact from the physically moving hand, turned into a shove. */
  afterStep() {
    for (const f of this.fighters) {
      const actor = this.physics.players[f.id];
      if (actor.eliminated || !activePunch(f.punch)) continue;
      const hand = actor.parts[HAND_PARTS[f.punchHand]],
        facing = { x: Math.sin(actor.facing), y: 0, z: Math.cos(actor.facing) };
      let best: { target: PlayerId; part: PartName; power: number; point: Vec; direction: Vec } | null = null;
      for (const other of this.physics.players) {
        if (other.id === f.id || other.eliminated) continue;
        for (const name of PARTS) {
          const part = other.parts[name],
            contact = hand.collider.contactCollider(part.collider, COMBAT.punch.contactMargin);
          if (!contact) continue;
          const direction = unit(sub(part.body.translation(), hand.body.translation())),
            closing = Math.max(0, dot(sub(hand.beforeVelocity, part.beforeVelocity), direction)),
            alignment = clamp(dot(facing, unit({ x: direction.x, y: 0, z: direction.z })), 0, 1),
            power = punchPower(name, closing, alignment);
          if (power > 0 && (!best || power > best.power) && this.physics.clearPath(hand.body.translation(), contact.point2))
            best = { target: other.id, part: name, power, point: contact.point2, direction };
        }
      }
      if (!best) continue;
      f.punch.hit = true;
      this.stats.hits++;
      const target = this.fighters[best.target],
        along = unit({ x: best.direction.x, y: 0, z: best.direction.z }),
        p = LAYER_CHAOS.punch;
      push(this.physics.players[best.target], { x: along.x * p.push, y: p.lift, z: along.z * p.push });
      const staggered = target.stagger.time <= EPSILON;
      if (staggered) {
        target.stagger = { ...p.stagger };
        this.stats.staggers++;
      }
      target.flash = 0.15;
      this.shoves.push({ attacker: f.id, target: best.target, part: best.part, point: best.point, staggered });
      this.feedback({
        name: hitSound(best.part),
        actor: f.id,
        target: best.target,
        x: best.point.x,
        intensity: clamp(best.power / COMBAT.knockout.head),
      });
    }
  }
}

/**
 * One fighter's step before physics (the server's `LayerBrawl.step` and the online
 * prediction rig run exactly this): timers, a punch starting from the Punch intent
 * (every `punch.cooldown`, alternating hands), the drive (stagger lowers posture and
 * mobility and blocks the jump; the punching arm), then the stagger counts this step
 * off. Returns the intent that reaches the controller — movement, jump and sprint only:
 * no aim facing (the body turns toward its movement), no grab or lift — and whether a
 * punch started.
 */
export function stepLayerFighter(f: LayerFighter, character: Character, input: MovementInput, drive: CharacterDrive, dt: number): { input: MovementInput; swing: boolean } {
  f.flash = Math.max(0, f.flash - dt);
  f.punchCooldown = Math.max(0, f.punchCooldown - dt);
  tickPunch(f.punch, dt);
  if (character.eliminated) {
    f.stagger.time = 0;
    return { input: IDLE_INPUT, swing: false };
  }
  let swing = false;
  if (input.punch && f.punchCooldown <= EPSILON) {
    f.punch = newPunch();
    f.punch.age = 0;
    f.punchHand = f.punchHand === 0 ? 1 : 0;
    f.punchCooldown = LAYER_CHAOS.punch.cooldown;
    swing = true;
  }
  // The stagger's seconds are staggered steps: drive with it, then count this step off.
  driveLayerFighter(f, character, drive);
  f.stagger.time = Math.max(0, f.stagger.time - dt);
  return { input: { x: input.x, z: input.z, jump: input.jump, sprint: !!input.sprint }, swing };
}
function driveLayerFighter(f: LayerFighter, character: Character, drive: CharacterDrive) {
  const staggered = f.stagger.time > EPSILON;
  drive.posture = staggered ? f.stagger.posture : 1;
  drive.mobility = staggered ? f.stagger.mobility : 1;
  drive.jump = !staggered;
  const strike = punchArmDrive(character, f.punchHand, f.punch);
  drive.arms = HANDS.map((hand) => (strike && hand === f.punchHand ? strike : REST_ARM)) as [ArmDrive, ArmDrive];
}

/** Whole-body velocity change: every part gets mass × Δv, so the body moves as one. */
export function push(character: Character, dv: Vec) {
  for (const name of PARTS) {
    const m = SHAPES[name].mass;
    character.parts[name].body.applyImpulse({ x: dv.x * m, y: dv.y * m, z: dv.z * m }, true);
  }
}
