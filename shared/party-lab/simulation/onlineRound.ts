import { PlaygroundPhysics, IDLE_INPUT, PHYSICS } from "./physics.js";
import { CombatSimulation } from "./combat.js";
import { PhysicsFeedback } from "./feedback.js";
import { RoundLogic } from "./roundLogic.js";
import { PLAYERS, type PlayerId } from "./players.js";
import { PARTS, HANDS } from "./ragdoll/config.js";
import type { MovementInput } from "../intent.js";
import type { FeedbackEvent } from "../feedback/events.js";
import {
  CONDITIONS,
  NET,
  TRANSFORM_BYTES,
  type GameEvent,
  type GameSnapshot,
  type OnlinePhase,
} from "../network/protocol.js";

/** Same physical rules as LocalRoundSimulation; no bots or browser dependencies. */
export class OnlineRoundSimulation {
  private pending: FeedbackEvent[] = [];
  private collect = (event: FeedbackEvent) => {
    this.pending.push(event);
  };
  readonly physics = new PlaygroundPhysics(this.collect);
  readonly combat = new CombatSimulation(this.physics, this.collect);
  private contacts = new PhysicsFeedback(this.physics, this.collect);
  round = new RoundLogic();
  phase: OnlinePhase = "waiting";
  roundId = 0;
  tick = 0;
  mask = 0;
  private eventId = 0;
  private snapshotId = 0;
  private countdown = 0;
  constructor() {
    this.resetBodies([]);
  }
  private resetBodies(slots: readonly PlayerId[]) {
    this.combat.reset();
    this.physics.reset();
    this.contacts.reset();
    this.pending.length = 0;
    this.mask = slots.reduce<number>((mask, id) => mask | (1 << id), 0);
    for (const p of this.physics.players) {
      const active = slots.includes(p.id);
      p.eliminated = !active;
      this.round.alive[p.id] = active;
      for (const part of Object.values(p.parts)) part.body.setEnabled(active);
    }
  }
  start(slots: readonly PlayerId[]) {
    if (this.phase !== "waiting" || new Set(slots).size < 2) return false;
    this.round = new RoundLogic();
    this.roundId++;
    this.countdown = 0;
    this.resetBodies(slots);
    this.phase = "countdown";
    return true;
  }
  cancelCountdown() {
    if (this.phase !== "countdown") return;
    this.phase = "waiting";
    this.round = new RoundLogic();
    this.resetBodies([]);
  }
  neutralize(slot: PlayerId) {
    for (const hand of HANDS)
      this.combat.grips.release(slot, hand, "disconnect");
    this.combat.players[slot].punches.forEach((p) => {
      p.age = -1;
    });
    this.combat.players[slot].heldFor.fill(0);
  }
  remove(slot: PlayerId) {
    this.neutralize(slot);
    this.combat.grips.releasePlayer(slot);
    const p = this.physics.players[slot];
    p.eliminated = true;
    this.round.alive[slot] = false;
    for (const part of Object.values(p.parts)) part.body.setEnabled(false);
    // Departure is a forfeit, not a physical fall: no cat cue.
  }
  step(inputs: readonly MovementInput[]): GameEvent[] {
    this.tick++;
    this.pending.length = 0;
    if (this.phase === "waiting") return [];
    if (this.phase === "results") {
      if (this.round.tick(PHYSICS.step) === "reset") {
        this.phase = "waiting";
        this.resetBodies([]);
      }
    } else {
      if (this.phase === "countdown" && this.round.seconds !== this.countdown) {
        this.countdown = this.round.seconds;
        this.collect({ name: "countdown", step: this.countdown });
      }
      const intent = PLAYERS.map((p) =>
        this.phase === "playing" && this.round.alive[p.id]
          ? inputs[p.id] ?? IDLE_INPUT
          : IDLE_INPUT
      );
      const drives =
        this.phase === "playing"
          ? this.combat.step(intent, PHYSICS.step, "playing")
          : this.physics.normal;
      const eliminated = this.physics.step(intent, drives);
      if (this.phase === "playing") {
        this.combat.afterStep();
        this.contacts.afterStep(PHYSICS.step, this.pending);
      }
      const event = this.round.tick(PHYSICS.step, eliminated);
      this.phase = this.round.phase;
      if (event === "started") this.collect({ name: "roundStart" });
      if (event === "finished") {
        this.combat.stop();
        this.collect({ name: this.round.winner === null ? "draw" : "winner" });
      }
    }
    return this.pending.map((event) => ({
      ...event,
      id: ++this.eventId,
      round: this.roundId,
      tick: this.tick,
    }));
  }
  snapshot(ack: number[]): GameSnapshot {
    const transforms = new Uint8Array(TRANSFORM_BYTES),
      view = new DataView(transforms.buffer);
    let offset = 0;
    for (const p of this.physics.players)
      for (const name of PARTS) {
        const body = p.parts[name].body,
          position = body.translation(),
          q = body.rotation();
        for (const value of [
          position.x,
          position.y,
          position.z,
          q.x,
          q.y,
          q.z,
          q.w,
        ]) {
          view.setFloat32(offset, value, true);
          offset += 4;
        }
      }
    return {
      v: NET.version,
      seq: ++this.snapshotId,
      tick: this.tick,
      round: this.roundId,
      phase: this.phase,
      seconds: this.phase === "waiting" ? 0 : this.round.seconds,
      winner: this.round.winner ?? -1,
      mask: this.mask,
      alive: this.round.alive.reduce(
        (mask, alive, id) => mask | (alive ? 1 << id : 0),
        0
      ),
      states: this.combat.players.map((p) =>
        CONDITIONS.indexOf(p.condition.state)
      ),
      meters: this.combat.players.map((p) => Math.round(p.condition.meter)),
      grips: this.combat.grips.hands.flatMap((h) =>
        h.map((g) => g?.target ?? -1)
      ),
      ack,
      transforms,
    };
  }
  dispose() {
    this.combat.stop();
    this.physics.dispose();
  }
}
