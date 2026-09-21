import type { MovementInput } from "../input/keyboard";
import type { PlayerId } from "./players";

export interface BotObservation {
  id: PlayerId;
  x: number;
  z: number;
  alive: boolean;
  grounded: boolean;
}

/** Replaceable input producer: cannot change a rigid body or round outcome. */
export class LocalBot {
  readonly input: MovementInput = { x: 0, z: 0, jump: false };
  private decisionIn = 0;
  private jumpIn = 2;
  private targetX = 0;
  private targetZ = 0;

  constructor(readonly id: 1 | 2, private readonly random: () => number = Math.random) {}

  reset() {
    this.decisionIn = 0;
    this.jumpIn = 1.5 + this.random() * 2;
    this.input.x = this.input.z = 0;
    this.input.jump = false;
  }

  update(dt: number, players: readonly BotObservation[], halfWidth: number, halfDepth: number): MovementInput {
    const me = players[this.id];
    this.input.jump = false;
    if (!me.alive) {
      this.input.x = this.input.z = 0;
      return this.input;
    }
    this.decisionIn -= dt;
    this.jumpIn -= dt;
    if (this.decisionIn <= 0 || Math.hypot(this.targetX - me.x, this.targetZ - me.z) < 0.4) {
      this.decisionIn = 0.8 + this.random();
      const choice = this.random();
      const opponents = players.filter(player => player.id !== this.id && player.alive);
      if (choice < 0.55 && opponents.length) {
        // Favor the human sometimes, but bots can also bump each other.
        const opponent = players[0].alive && this.random() < 0.55
          ? players[0] : opponents[Math.floor(this.random() * opponents.length)];
        this.targetX = opponent.x + (this.random() - 0.5) * 0.7;
        this.targetZ = opponent.z + (this.random() - 0.5) * 0.7;
      } else {
        const spread = choice < 0.75 ? 1.4 : 1;
        this.targetX = (this.random() * 2 - 1) * (choice < 0.75 ? spread : halfWidth - 1.1);
        this.targetZ = (this.random() * 2 - 1) * (choice < 0.75 ? spread : halfDepth - 1.1);
      }
    }
    const nearEdge = Math.abs(me.x) > halfWidth - 1 || Math.abs(me.z) > halfDepth - 1;
    const x = (nearEdge ? 0 : this.targetX) - me.x;
    const z = (nearEdge ? 0 : this.targetZ) - me.z;
    const length = Math.hypot(x, z) || 1;
    this.input.x = x / length;
    this.input.z = z / length;
    if (this.jumpIn <= 0 && me.grounded && !nearEdge) {
      this.input.jump = true;
      this.jumpIn = 2 + this.random() * 2.5;
    }
    return this.input;
  }
}
