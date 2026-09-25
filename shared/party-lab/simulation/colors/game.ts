import { silentFeedback, type FeedbackEvent, type FeedbackSink } from "../../feedback/events.js";
import type { MovementInput } from "../../intent.js";
import { spawnYaw } from "../../maps/index.js";
import { colorSpawn, COLORS_MAP } from "../../maps/colors.js";
import { PhysicsFeedback } from "../feedback.js";
import { IDLE_INPUT, PHYSICS, PlaygroundPhysics } from "../physics.js";
import { PLAYERS, type PlayerId } from "../players.js";
import { restore } from "../ragdoll/character.js";
import { LayerBrawl } from "../layers/brawl.js";
import { retire } from "../layers/game.js";
import { LayerRound, type LayerRoundEvent } from "../layers/round.js";
import { COLOR_CHAOS, COLOR_TICKS } from "./config.js";
import { ColorTileField } from "./field.js";
import { mulberry32 } from "./layouts.js";
import { ColorSchedule, type ColorEvent } from "./schedule.js";

/**
 * Hips below the walking surface on a restore tick: the body is in a hole (or sliding down
 * a tile's side, which it cannot climb) and is out — before the returning tiles' colliders
 * come back around its legs. Standing hips are ≈ 0.8 m up, lying flat ≈ 0.15 m. The online
 * prediction rig applies the same rule on the same tick.
 */
export const IN_HOLE_Y = 0;

export interface ColorGameOptions {
  /** 2 or 3 players in the match (slots 0…n−1). */
  players?: 2 | 3;
  /** Seeds every round's layouts and targets (default: random). Same seed + inputs → same match. */
  seed?: number;
}

/**
 * Renk Kaosu: the shared ragdoll physics on one field of coloured hex tiles, with the
 * colour schedule, Katman Kaosu's shove punch (Renk Kaosu's own tuning, same values) and
 * Katman Kaosu's round (last alive wins, same-tick draw; Renk Kaosu's timing).
 * Deterministic for the same seed and inputs; the local arena drives it with a human and
 * bots, and the online room server (`ColorRoundSimulation`) drives it the same way.
 *
 * One playing step (round tick t): schedule (target / drop / restore on t: colliders
 * change before physics; on a restore, whoever is down in a hole is out first) → punches
 * and drives → physics → punch contacts → eliminations decide the round. Countdown: frozen
 * bodies, no punches, every tile standing.
 *
 * The online server (`ColorRoundSimulation`) drives the same game through `begin` with
 * the room's slots; the local arena uses slots 0…n−1 from the constructor.
 */
export class ColorChaosGame {
  readonly physics: PlaygroundPhysics;
  readonly field: ColorTileField;
  readonly brawl: LayerBrawl;
  readonly round = new LayerRound(COLOR_TICKS);
  readonly schedule: ColorSchedule;
  /** This step's schedule event (null: none). */
  event: ColorEvent = null;
  /** This step's eliminations. */
  readonly eliminated: PlayerId[] = [];
  /** Rounds started (the round seed is drawn from the match seed). */
  rounds = 0;
  players: 2 | 3;
  /** Slots in the match and the spawn (index into COLOR_SPAWN_CELLS[players]) of each. */
  private active: PlayerId[];
  private spawnOf: number[] = PLAYERS.map(({ id }) => id);
  private readonly pending: FeedbackEvent[] = [];
  private readonly collect: FeedbackSink = (event) => this.pending.push(event);
  private readonly physicalFeedback: PhysicsFeedback;
  private readonly idle: MovementInput[] = PLAYERS.map(() => IDLE_INPUT);
  private readonly seeds: () => number;
  private countdownCue = 0;

  constructor(
    private readonly feedback: FeedbackSink = silentFeedback,
    options: ColorGameOptions = {}
  ) {
    this.players = options.players ?? 3;
    this.active = PLAYERS.filter(({ id }) => id < this.players).map(({ id }) => id);
    this.seeds = mulberry32(options.seed ?? Math.floor(Math.random() * 2 ** 32));
    this.physics = new PlaygroundPhysics(this.collect, COLORS_MAP);
    this.field = new ColorTileField(this.physics.world);
    this.brawl = new LayerBrawl(this.physics, this.collect, COLOR_CHAOS.punch);
    this.physicalFeedback = new PhysicsFeedback(this.physics, this.collect);
    this.schedule = new ColorSchedule(this.nextSeed(), this.players);
    this.applySlots();
  }
  /** Slots in the match. */
  get slots(): PlayerId[] {
    return [...this.active];
  }
  private nextSeed() {
    this.rounds++;
    return Math.floor(this.seeds() * 2 ** 32);
  }
  private applySlots() {
    this.round.setActive(this.slots);
    for (const character of this.physics.players) {
      const spawn = this.spawnOf[character.id];
      if (!this.active.includes(character.id)) retire(character);
      else if (this.players === 2) {
        // Two players stand on opposite sides (the map's spawns are the three-player ones).
        const at = colorSpawn(2, spawn);
        restore(character, at, Math.atan2(-at.x, -at.z));
      } else restore(character, colorSpawn(3, spawn), spawnYaw(COLORS_MAP, spawn));
    }
  }
  /**
   * A fresh round from the countdown (new seed) for these slots — 2 or 3 of them; `spawns[i]`
   * is the spawn of `slots[i]` among the ones for that player count (default: in order).
   * Everyone else sits the match out. No slots: an empty world (the online lobby).
   */
  begin(slots: readonly PlayerId[], spawns: readonly number[] = slots.map((_, i) => i)) {
    this.players = slots.length === 2 ? 2 : 3;
    this.active = [...slots];
    this.spawnOf = PLAYERS.map(({ id }) => id);
    slots.forEach((slot, i) => (this.spawnOf[slot] = spawns[i] ?? i));
    this.round.phase = "countdown";
    this.round.tick = 0;
    this.round.winner = this.round.reason = null;
    this.round.endedAt = -1;
    this.resetWorld();
  }
  private resetWorld() {
    this.field.restore();
    this.schedule.reset(this.nextSeed(), this.players);
    this.event = null;
    this.brawl.reset();
    this.physicalFeedback.reset();
    this.physics.reset();
    this.countdownCue = 0;
    this.applySlots();
  }

  step(inputs: readonly MovementInput[]): LayerRoundEvent {
    this.pending.length = 0;
    this.eliminated.length = 0;
    this.event = null;
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
    this.event = this.schedule.advance(t);
    if (this.event === "drop") {
      this.field.drop(this.schedule.dropping());
      this.collect({ name: "floorFlop", intensity: 0.6, x: 0 });
    } else if (this.event === "restore") {
      for (const character of this.physics.players) {
        if (character.eliminated || !round.alive[character.id]) continue;
        const at = character.body.translation();
        if (at.y >= IN_HOLE_Y) continue;
        retire(character);
        this.eliminated.push(character.id);
        this.collect({ name: "fall", actor: character.id, x: at.x });
      }
      this.field.restore(this.schedule.cycle.present);
    }
    else if (this.event === "target" && this.schedule.cycle.index > 1) this.collect({ name: "roundStart" });
    const live = inputs.map((input, id) => (round.alive[id] ? input : IDLE_INPUT));
    const { inputs: effective, drives } = this.brawl.step(live, PHYSICS.step);
    this.eliminated.push(...this.physics.step(effective, drives));
    this.brawl.afterStep();
    this.physicalFeedback.afterStep(PHYSICS.step, this.pending);
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
