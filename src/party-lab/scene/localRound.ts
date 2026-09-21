import type { MovementInput } from "../input/keyboard";
import { LocalBot, type BotObservation } from "./bots";
import { IDLE_INPUT, PHYSICS, PLATFORM, PlaygroundPhysics } from "./physics";
import { PLAYERS } from "./players";
import { RoundLogic, type RoundEvent } from "./roundLogic";

/** Local wiring only. Round rules and physics do not depend on these bots. */
export class LocalRoundSimulation {
  readonly physics = new PlaygroundPhysics();
  readonly round = new RoundLogic();
  private readonly bots: readonly LocalBot[];
  private readonly inputs: MovementInput[] = PLAYERS.map(() => IDLE_INPUT);
  private readonly observations: BotObservation[] = PLAYERS.map(player => ({
    id: player.id, x: player.spawn.x, z: player.spawn.z, alive: true, grounded: false,
  }));

  constructor(random: () => number = Math.random) {
    this.bots = [new LocalBot(1, random), new LocalBot(2, random)];
    this.bots.forEach(bot => bot.reset());
  }

  step(humanInput: MovementInput): RoundEvent {
    if (this.round.phase === "results") {
      const event = this.round.tick(PHYSICS.step);
      if (event === "reset") {
        this.physics.reset();
        this.bots.forEach(bot => bot.reset());
        this.inputs.fill(IDLE_INPUT);
      }
      return event;
    }
    if (this.round.phase === "countdown") {
      // Gravity settles the beans, but nobody can move or jump before GO.
      this.inputs.fill(IDLE_INPUT);
      this.physics.step(this.inputs);
      return this.round.tick(PHYSICS.step);
    }

    for (const player of this.physics.players) {
      const position = player.body.translation();
      const observation = this.observations[player.id];
      observation.x = position.x;
      observation.z = position.z;
      observation.alive = !player.eliminated;
      observation.grounded = this.physics.isGrounded(player.id);
    }
    this.inputs[0] = this.round.alive[0] ? humanInput : IDLE_INPUT;
    for (const bot of this.bots) {
      this.inputs[bot.id] = bot.update(PHYSICS.step, this.observations, PLATFORM.width / 2, PLATFORM.depth / 2);
    }
    const eliminated = this.physics.step(this.inputs);
    return this.round.tick(PHYSICS.step, eliminated);
  }

  dispose() { this.physics.dispose(); }
}
