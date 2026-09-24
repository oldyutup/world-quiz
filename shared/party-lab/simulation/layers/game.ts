import { silentFeedback, type FeedbackEvent, type FeedbackSink } from "../../feedback/events.js";
import type { MovementInput } from "../../intent.js";
import { PhysicsFeedback } from "../feedback.js";
import { IDLE_INPUT, PHYSICS, PlaygroundPhysics } from "../physics.js";
import { PLAYERS, type PlayerId } from "../players.js";
import { restore, type Character } from "../ragdoll/character.js";
import { spawnYaw } from "../../maps/index.js";
import { LAYERS_MAP } from "../../maps/layers.js";
import { LayerBrawl } from "./brawl.js";
import { LayerRound, type LayerRoundEvent } from "./round.js";
import { TileField } from "./tiles.js";
import { supportingTile, type SupportVia } from "./trigger.js";

export interface LayerGameOptions {
  /** 2 or 3 players in the match (slots 0…n−1). */
  players?: 2 | 3;
}
export interface LayerArming {
  tile: number;
  actor: PlayerId;
  via: SupportVia;
}

/** Out of this match: no body, never probed, never a target. */
export function retire(character: Character) {
  character.eliminated = true;
  for (const part of Object.values(character.parts)) part.body.setEnabled(false);
}

/**
 * Katman Kaosu: the shared ragdoll physics on the layered tile field, with the shared
 * tile, trigger, punch and round rules. Deterministic for the same inputs; the local
 * arena (human + bots) and the online server (`LayerRoundSimulation`) both drive it and
 * supply inputs from outside.
 *
 * One playing step: collapse + GONE (tile field, round tick t) → punches and drives →
 * physics → punch contacts → every standing player arms the tile under their hips on
 * tick t → eliminations decide the round.
 */
export class LayerChaosGame {
  readonly physics: PlaygroundPhysics;
  readonly field: TileField;
  readonly brawl: LayerBrawl;
  readonly round = new LayerRound();
  /** This step's arming by players (collapse arming is in the field's stats). */
  readonly armed: LayerArming[] = [];
  /** This step's eliminations. */
  readonly eliminated: PlayerId[] = [];
  private readonly pending: FeedbackEvent[] = [];
  private readonly collect: FeedbackSink = (event) => this.pending.push(event);
  private readonly physicalFeedback: PhysicsFeedback;
  private readonly idle: MovementInput[] = PLAYERS.map(() => IDLE_INPUT);
  private countdownCue = 0;
  players: 2 | 3;
  /** Slots in the match and the spawn (index into LAYERS_MAP.spawns) each one starts on. */
  private active: PlayerId[];
  private spawnOf: number[] = PLAYERS.map(({ id }) => id);

  constructor(private readonly feedback: FeedbackSink = silentFeedback, options: LayerGameOptions = {}) {
    this.players = options.players ?? 3;
    this.active = PLAYERS.filter(({ id }) => id < this.players).map(({ id }) => id);
    this.physics = new PlaygroundPhysics(this.collect, LAYERS_MAP);
    this.field = new TileField(this.physics.world);
    this.brawl = new LayerBrawl(this.physics, this.collect);
    this.physicalFeedback = new PhysicsFeedback(this.physics, this.collect);
    this.applySlots();
  }
  /** Slots in the match. */
  get slots(): PlayerId[] {
    return [...this.active];
  }
  private applySlots() {
    this.round.setActive(this.active);
    for (const character of this.physics.players) {
      if (!this.active.includes(character.id)) retire(character);
      else if (this.spawnOf[character.id] !== character.id) {
        // Online duels rotate which two of the three spawns are used (the joints are already connected).
        const spawn = this.spawnOf[character.id];
        restore(character, LAYERS_MAP.spawns[spawn], spawnYaw(LAYERS_MAP, spawn));
      }
    }
  }
  /** A fresh round from the countdown (tiles, bodies, punches), e.g. after changing the player count. */
  restart(players: 2 | 3 = this.players) {
    this.players = players;
    this.begin(PLAYERS.filter(({ id }) => id < players).map(({ id }) => id));
  }
  /**
   * A fresh round from the countdown for these slots; `spawns[i]` is the spawn of
   * `slots[i]` (default: its own). Everyone else sits the match out.
   */
  begin(slots: readonly PlayerId[], spawns: readonly number[] = slots) {
    this.active = [...slots];
    this.spawnOf = PLAYERS.map(({ id }) => id);
    slots.forEach((slot, i) => (this.spawnOf[slot] = spawns[i] ?? slot));
    this.round.phase = "countdown";
    this.round.tick = 0;
    this.round.winner = this.round.reason = null;
    this.round.endedAt = -1;
    this.resetWorld();
  }
  private resetWorld() {
    this.field.reset();
    this.brawl.reset();
    this.physicalFeedback.reset();
    this.physics.reset();
    this.countdownCue = 0;
    this.applySlots();
  }

  step(inputs: readonly MovementInput[]): LayerRoundEvent {
    this.pending.length = 0;
    this.armed.length = 0;
    this.eliminated.length = 0;
    this.field.vanished.length = 0;
    const event = this.advance(inputs);
    for (const cue of this.pending) this.feedback(cue);
    return event;
  }
  private advance(inputs: readonly MovementInput[]): LayerRoundEvent {
    const round = this.round;
    if (round.phase === "results") {
      const event = round.step();
      if (event === "reset") this.resetWorld();
      return event;
    }
    if (round.phase === "countdown") {
      // Frozen: nobody moves or punches and no tile can arm.
      this.physics.step(this.idle);
      const event = round.step();
      if (round.phase === "countdown" && round.seconds !== this.countdownCue) {
        this.countdownCue = round.seconds;
        this.collect({ name: "countdown", step: this.countdownCue });
      }
      if (event === "started") this.collect({ name: "roundStart" });
      return event;
    }
    const t = round.tick;
    this.field.advance(t);
    const live = inputs.map((input, id) => (round.alive[id] ? input : IDLE_INPUT));
    const { inputs: effective, drives } = this.brawl.step(live, PHYSICS.step);
    this.eliminated.push(...this.physics.step(effective, drives));
    this.brawl.afterStep();
    this.physicalFeedback.afterStep(PHYSICS.step, this.pending);
    for (const character of this.physics.players) {
      if (!round.alive[character.id] || character.eliminated) continue;
      const support = supportingTile(this.physics.world, character, this.field);
      if (support && this.field.arm(support.tile, t, "player")) this.armed.push({ tile: support.tile, actor: character.id, via: support.via });
    }
    const event = round.step(this.eliminated);
    if (event === "finished") {
      this.brawl.stop();
      this.collect({ name: round.winner === null ? "draw" : "winner" });
    }
    return event;
  }
  dispose() {
    this.brawl.stop();
    this.physicalFeedback.reset();
    this.physics.dispose();
  }
}
