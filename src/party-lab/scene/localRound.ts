import { silentFeedback, type FeedbackEvent, type FeedbackSink } from "../audio/events";
import { PhysicsFeedback } from "./feedback";
import type { MovementInput } from "../input/types";
import { CombatSimulation } from "./combat";
import { LocalBot, botArena, type BotArena, type BotObservation } from "./bots";
import { IDLE_INPUT, PHYSICS, PlaygroundPhysics } from "./physics";
import { PLAYERS, type PlayerId } from "./players";
import { RoundLogic, type RoundEvent } from "./roundLogic";
import { connect, restore } from "./ragdoll/character";
import { arenaMap, DEFAULT_ARENA_MAP_ID, spawnYaw, type ArenaMap } from "../../../shared/party-lab/maps";
import { BarnCombat } from "../../../shared/party-lab/simulation/barn/combat";
/** Explore-mode dummies: correct drift beyond `radius` with input under the 0.15 facing threshold. */
const EXPLORE_HOLD = { radius: 0.25, input: 0.14 } as const;
/** Barn dummies stop walking home for this long after a hit, so knockback reads fully. */
const DUMMY_REST_AFTER_HIT = 1.5;
export interface LocalRoundOptions {
  /**
   * Untimed free play (the barn): slots 1–2 are standing dummies instead of bots,
   * there is no rooftop combat and no time limit, and a player who falls out or
   * faults is put back on their spawn instead of being eliminated.
   */
  explore?: boolean;
  /**
   * Barn Shootout local combat on top of explore's untimed play (barn map only):
   * health, disposable weapons, pickups, traps, punches, death and respawn, run by
   * the shared `BarnCombat`. The dummies become passive targets that respawn.
   */
  barnCombat?: boolean;
}
export class LocalRoundSimulation {
  private readonly pendingFeedback: FeedbackEvent[] = [];
  private readonly collectFeedback: FeedbackSink = event => this.pendingFeedback.push(event);
  readonly physics: PlaygroundPhysics;
  readonly round = new RoundLogic();
  readonly combat: CombatSimulation;
  private readonly physicalFeedback: PhysicsFeedback;
  private countdownCue = 0;
  private readonly dummyRest = PLAYERS.map(() => 0);
  private readonly bots: readonly LocalBot[];
  private readonly botArena: BotArena;
  private readonly inputs: MovementInput[] = PLAYERS.map(() => IDLE_INPUT);
  private readonly observations: BotObservation[];
  private readonly feedback: FeedbackSink;
  /** Barn combat (only with `options.barnCombat`). */
  readonly barn: BarnCombat | null;
  constructor(
    random: () => number = Math.random,
    feedback: FeedbackSink = silentFeedback,
    readonly map: ArenaMap = arenaMap(DEFAULT_ARENA_MAP_ID),
    readonly options: LocalRoundOptions = {}
  ) {
    this.feedback = feedback;
    this.physics = new PlaygroundPhysics(this.collectFeedback, map);
    this.combat = new CombatSimulation(this.physics, this.collectFeedback);
    this.physicalFeedback = new PhysicsFeedback(this.physics, this.collectFeedback);
    this.barn = options.barnCombat ? new BarnCombat(this.physics, this.collectFeedback, random) : null;
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
    if (this.options.explore) return this.explore(humanInput);
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
  /** Untimed free movement; the round stays in "playing". */
  private explore(humanInput: MovementInput): RoundEvent {
    this.inputs[0] = humanInput;
    this.inputs[1] = this.holdSpawn(1);
    this.inputs[2] = this.holdSpawn(2);
    const barn = this.barn;
    if (barn) {
      const { inputs, drives } = barn.step(this.inputs, PHYSICS.step);
      const eliminated = this.physics.step(inputs, drives);
      barn.afterStep();
      for (const hit of barn.hits) this.dummyRest[hit.target] = DUMMY_REST_AFTER_HIT;
      this.physicalFeedback.afterStep(PHYSICS.step, this.pendingFeedback);
      // Enclosed barn: only a physics fault can eliminate; treat it as a fresh respawn.
      for (const id of eliminated) barn.respawn(barn.fighters[id]);
      return null;
    }
    const eliminated = this.physics.step(this.inputs);
    this.physicalFeedback.afterStep(PHYSICS.step, this.pendingFeedback);
    for (const id of eliminated) this.respawn(id);
    return null;
  }
  /**
   * Idle active ragdolls creep slowly toward where they face (~1–1.4 m per 20 s on
   * every map). Dummies walk back with ordinary input below the turning threshold,
   * so they keep facing the same way and stay near their spawn (an upper-floor dummy would
   * otherwise wander off the edge).
   */
  private holdSpawn(id: PlayerId): MovementInput {
    if (this.dummyRest[id] > 0) {
      this.dummyRest[id] = Math.max(0, this.dummyRest[id] - PHYSICS.step);
      return IDLE_INPUT;
    }
    const b = this.physics.players[id].body.translation(),
      s = this.barn?.fighters[id].home ?? this.map.spawns[id];
    const dx = s.x - b.x,
      dz = s.z - b.z,
      d = Math.hypot(dx, dz);
    return d < EXPLORE_HOLD.radius ? IDLE_INPUT : { x: (dx / d) * EXPLORE_HOLD.input, z: (dz / d) * EXPLORE_HOLD.input, jump: false };
  }
  private respawn(id: PlayerId) {
    const character = this.physics.players[id],
      spawn = this.map.spawns[id];
    restore(character, spawn, spawnYaw(this.map, id));
    connect(this.physics.world, character);
  }
  dispose() {
    this.combat.stop();
    this.physicalFeedback.reset();
    this.pendingFeedback.length = 0;
    this.physics.dispose();
  }
}
