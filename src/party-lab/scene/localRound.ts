import type { MovementInput } from "../input/types";
import { CombatSimulation } from "./combat";
import { LocalBot, type BotObservation } from "./bots";
import { IDLE_INPUT, PHYSICS, PLATFORM, PlaygroundPhysics } from "./physics";
import { PLAYERS } from "./players";
import { RoundLogic, type RoundEvent } from "./roundLogic";
export class LocalRoundSimulation {
  readonly physics = new PlaygroundPhysics();
  readonly round = new RoundLogic();
  readonly combat = new CombatSimulation(this.physics);
  private readonly bots: readonly LocalBot[];
  private readonly inputs: MovementInput[] = PLAYERS.map(() => IDLE_INPUT);
  private readonly observations: BotObservation[] = PLAYERS.map((p) => ({
    id: p.id,
    x: p.spawn.x,
    z: p.spawn.z,
    alive: true,
    grounded: false,
    state: "CONSCIOUS",
    cooldowns: [0, 0],
    grips: [null, null],
    grabbedBy: null,
  }));
  constructor(random: () => number = Math.random) {
    this.bots = [new LocalBot(1, random), new LocalBot(2, random)];
    this.bots.forEach((b) => b.reset());
  }
  step(humanInput: MovementInput): RoundEvent {
    if (this.round.phase === "results") {
      const event = this.round.tick(PHYSICS.step);
      if (event === "reset") {
        this.combat.reset(); // Drop every hand reference before anatomical joints are recreated.
        this.physics.reset();
        this.bots.forEach((b) => b.reset());
        this.inputs.fill(IDLE_INPUT);
      }
      return event;
    }
    if (this.round.phase === "countdown") {
      this.inputs.fill(IDLE_INPUT);
      this.physics.step(this.inputs);
      return this.round.tick(PHYSICS.step);
    }
    for (const player of this.physics.players) {
      const p = player.body.translation(),
        o = this.observations[player.id],
        c = this.combat.players[player.id];
      const grabber = this.physics.players.find((other) =>
        this.combat.grips.hands[other.id].some(
          (grip) => grip?.target === player.id
        )
      );
      Object.assign(o, {
        x: p.x,
        z: p.z,
        alive: !player.eliminated,
        grounded: this.physics.isGrounded(player.id),
        state: c.condition.state,
        cooldowns: c.punches.map((h) => h.cooldown),
        grips: this.combat.grips.hands[player.id].map((h) => h?.target ?? null),
        grabbedBy: grabber?.id ?? null,
      });
    }
    this.inputs[0] = this.round.alive[0] ? humanInput : IDLE_INPUT;
    for (const bot of this.bots)
      this.inputs[bot.id] = bot.update(
        PHYSICS.step,
        this.observations,
        PLATFORM.width / 2,
        PLATFORM.depth / 2
      );
    const drives = this.combat.step(this.inputs, PHYSICS.step, "playing");
    const eliminated = this.physics.step(this.inputs, drives);
    this.combat.afterStep();
    const event = this.round.tick(PHYSICS.step, eliminated);
    if (event === "finished") this.combat.stop();
    return event;
  }
  dispose() {
    this.combat.stop();
    this.physics.dispose();
  }
}
