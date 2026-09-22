import { silentFeedback, type FeedbackEvent, type FeedbackSink } from "../audio/events";
import { PhysicsFeedback } from "./feedback";
import type { MovementInput } from "../input/types";
import { CombatSimulation } from "./combat";
import { LocalBot, botArena, type BotArena, type BotObservation } from "./bots";
import { IDLE_INPUT, PHYSICS, PlaygroundPhysics } from "./physics";
import { PLAYERS } from "./players";
import { RoundLogic, type RoundEvent } from "./roundLogic";
import { arenaMap, DEFAULT_ARENA_MAP_ID, type ArenaMap } from "../../../shared/party-lab/maps";
export class LocalRoundSimulation {
  private readonly pendingFeedback: FeedbackEvent[] = [];
  private readonly collectFeedback: FeedbackSink = event => this.pendingFeedback.push(event);
  readonly physics: PlaygroundPhysics;
  readonly round = new RoundLogic();
  readonly combat: CombatSimulation;
  private readonly physicalFeedback: PhysicsFeedback;
  private countdownCue = 0;
  private readonly bots: readonly LocalBot[];
  private readonly botArena: BotArena;
  private readonly inputs: MovementInput[] = PLAYERS.map(() => IDLE_INPUT);
  private readonly observations: BotObservation[];
  private readonly feedback: FeedbackSink;
  constructor(
    random: () => number = Math.random,
    feedback: FeedbackSink = silentFeedback,
    readonly map: ArenaMap = arenaMap(DEFAULT_ARENA_MAP_ID)
  ) {
    this.feedback = feedback;
    this.physics = new PlaygroundPhysics(this.collectFeedback, map);
    this.combat = new CombatSimulation(this.physics, this.collectFeedback);
    this.physicalFeedback = new PhysicsFeedback(this.physics, this.collectFeedback);
    this.botArena = botArena(map);
    this.observations = PLAYERS.map((p) => ({
      id: p.id,
      x: map.spawns[p.id].x,
      z: map.spawns[p.id].z,
      alive: true,
      grounded: false,
      state: "CONSCIOUS",
      cooldowns: [0, 0],
      grips: [null, null],
      grabbedBy: null,
    }));
    this.bots = [new LocalBot(1, random), new LocalBot(2, random)];
    this.bots.forEach((b) => b.reset());
  }
  step(humanInput: MovementInput): RoundEvent {
    this.pendingFeedback.length = 0;
    const event = this.advance(humanInput);
    if (this.round.phase === "countdown" && this.round.seconds !== this.countdownCue) {
      this.countdownCue = this.round.seconds;
      this.collectFeedback({ name: "countdown", step: this.countdownCue });
    }
    if (event === "started") this.collectFeedback({ name: "roundStart" });
    if (event === "finished") this.collectFeedback({ name: this.round.winner === null ? "draw" : "winner" });
    for (const cue of this.pendingFeedback) this.feedback(cue);
    return event;
  }
  private advance(humanInput: MovementInput): RoundEvent {
    if (this.round.phase === "results") {
      const event = this.round.tick(PHYSICS.step);
      if (event === "reset") {
        this.countdownCue = 0;
        this.physicalFeedback.reset();
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
      this.inputs[bot.id] = bot.update(PHYSICS.step, this.observations, this.botArena);
    const drives = this.combat.step(this.inputs, PHYSICS.step, "playing");
    const eliminated = this.physics.step(this.inputs, drives);
    this.combat.afterStep();
    this.physicalFeedback.afterStep(PHYSICS.step, this.pendingFeedback);
    const event = this.round.tick(PHYSICS.step, eliminated);
    if (event === "finished") this.combat.stop();
    return event;
  }
  dispose() {
    this.combat.stop();
    this.physicalFeedback.reset();
    this.pendingFeedback.length = 0;
    this.physics.dispose();
  }
}
