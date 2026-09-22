import type { MovementInput } from "../input/types";
import type { PlayerId } from "./players";
import type { Consciousness } from "./combat/knockout";
import { BOT_COMBAT } from "./combatConfig";
export interface BotObservation {
  id: PlayerId;
  x: number;
  z: number;
  alive: boolean;
  grounded: boolean;
  state: Consciousness;
  cooldowns: readonly number[];
  grips: readonly (PlayerId | null)[];
  grabbedBy: PlayerId | null;
}
/** Removable input producer. No body writes or privileged force/hit/escape paths. */
export class LocalBot {
  readonly input: MovementInput = { x: 0, z: 0, jump: false };
  private decisionIn = 0;
  private actionIn = 1;
  private jumpIn = 2;
  private targetX = 0;
  private targetZ = 0;
  private holdFor = 0;
  private holdAge = 0;
  private firstHand = 0;
  private reactionIn = 0;
  private previousGrabber: PlayerId | null = null;
  constructor(
    readonly id: 1 | 2,
    private readonly random: () => number = Math.random
  ) {}
  reset() {
    this.decisionIn = 0;
    this.actionIn = 1;
    this.jumpIn = 2;
    this.holdFor = this.holdAge = this.reactionIn = 0;
    this.previousGrabber = null;
    Object.assign(this.input, {
      x: 0,
      z: 0,
      jump: false,
      left: false,
      right: false,
      punchLeft: false,
      punchRight: false,
      lift: false,
    });
  }
  update(
    dt: number,
    players: readonly BotObservation[],
    halfWidth: number,
    halfDepth: number
  ): MovementInput {
    const me = players[this.id],
      i = this.input;
    Object.assign(i, {
      jump: false,
      punchLeft: false,
      punchRight: false,
      left: false,
      right: false,
      lift: false,
    });
    if (!me.alive || me.state === "KNOCKED_OUT") {
      i.x = i.z = 0;
      this.holdFor = 0;
      return i;
    }
    this.actionIn -= dt;
    this.decisionIn -= dt;
    this.jumpIn -= dt;
    this.holdFor = Math.max(0, this.holdFor - dt);
    const opponents = players.filter((p) => p.id !== this.id && p.alive);
    const nearest = opponents.reduce<BotObservation | undefined>(
      (best, p) =>
        !best ||
        Math.hypot(p.x - me.x, p.z - me.z) <
          Math.hypot(best.x - me.x, best.z - me.z)
          ? p
          : best,
      undefined
    );
    if (this.decisionIn <= 0) {
      this.decisionIn = 0.65 + this.random() * 0.7;
      if (nearest && this.random() < 0.8) {
        this.targetX = nearest.x + (this.random() - 0.5) * 0.35;
        this.targetZ = nearest.z + (this.random() - 0.5) * 0.35;
      } else {
        this.targetX = (this.random() - 0.5) * 4;
        this.targetZ = (this.random() - 0.5) * 3;
      }
    }
    const edge =
      Math.abs(me.x) > halfWidth - 0.85 || Math.abs(me.z) > halfDepth - 0.85;
    let x = (edge ? 0 : this.targetX) - me.x,
      z = (edge ? 0 : this.targetZ) - me.z;
    if (me.grabbedBy !== this.previousGrabber) {
      this.previousGrabber = me.grabbedBy;
      this.reactionIn =
        BOT_COMBAT.reaction + this.random() * BOT_COMBAT.reactionSpread;
    }
    this.reactionIn = Math.max(0, this.reactionIn - dt);
    if (me.grabbedBy !== null && this.reactionIn <= 0) {
      const owner = players[me.grabbedBy];
      x = me.x - owner.x;
      z = me.z - owner.z;
      if (me.grounded && this.jumpIn <= 0) {
        i.jump = true;
        this.jumpIn = 0.85 + this.random();
      }
    }
    const holding = me.grips.find((id) => id !== null);
    if (holding !== undefined && holding !== null) {
      this.holdAge += dt;
      const target = players[holding];
      i.left =
        this.holdFor > 0 &&
        (this.firstHand === 0 || this.holdAge > BOT_COMBAT.secondHandDelay);
      i.right =
        this.holdFor > 0 &&
        (this.firstHand === 1 || this.holdAge > BOT_COMBAT.secondHandDelay);
      i.lift = target.state === "KNOCKED_OUT" || target.state === "DAZED";
      if (halfWidth - Math.abs(me.x) < halfDepth - Math.abs(me.z)) {
        x = Math.sign(me.x) || 1;
        z = 0;
      } else {
        x = 0;
        z = Math.sign(me.z) || 1;
      }
      if (edge && this.holdAge > 0.7) {
        i.left = i.right = false;
        this.holdFor = 0;
      }
    } else if (this.holdFor > 0) {
      this.holdAge += dt;
      i.left =
        this.firstHand === 0 || this.holdAge > BOT_COMBAT.secondHandDelay;
      i.right =
        this.firstHand === 1 || this.holdAge > BOT_COMBAT.secondHandDelay;
    } else this.holdAge = 0;
    if (
      nearest &&
      holding === undefined &&
      this.actionIn <= 0 &&
      Math.hypot(nearest.x - me.x, nearest.z - me.z) < 1.65
    ) {
      this.actionIn = BOT_COMBAT.interval + this.random() * BOT_COMBAT.spread;
      if (
        me.grabbedBy === null &&
        (nearest.state === "KNOCKED_OUT" ||
          this.random() < BOT_COMBAT.grabChance)
      ) {
        this.holdFor = BOT_COMBAT.hold + this.random() * BOT_COMBAT.holdSpread;
        this.firstHand = this.random() < 0.5 ? 0 : 1;
        this.holdAge = 0;
      } else {
        const hand = this.random() < 0.5 ? 0 : 1;
        if (me.cooldowns[hand] <= 0) {
          if (hand === 0) i.punchLeft = true;
          else i.punchRight = true;
        }
        // Briefly face a nearby grabber to fight back instead of perfect auto-escape.
        if (me.grabbedBy !== null) {
          const owner = players[me.grabbedBy];
          x = owner.x - me.x;
          z = owner.z - me.z;
        }
      }
    }
    const norm = Math.max(1, Math.hypot(x, z));
    i.x = x / norm;
    i.z = z / norm;
    if (me.grounded && this.jumpIn <= 0 && !edge && holding === undefined) {
      i.jump = this.random() < 0.3;
      this.jumpIn = 2 + this.random() * 2;
    }
    return i;
  }
}
