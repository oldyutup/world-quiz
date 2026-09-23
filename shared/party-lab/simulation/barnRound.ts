import { PlaygroundPhysics, IDLE_INPUT, PHYSICS } from "./physics.js";
import { PhysicsFeedback } from "./feedback.js";
import { PLAYERS, type PlayerId } from "./players.js";
import { PARTS } from "./ragdoll/config.js";
import type { MovementInput } from "../intent.js";
import { arenaMap } from "../maps/index.js";
import { WEAPON_SPOTS } from "../maps/barn.js";
import type { FeedbackEvent } from "../feedback/events.js";
import {
  BARN_FIGHTER_FIELDS,
  BARN_FLAG,
  NET,
  TRANSFORM_BYTES,
  type BarnSnapshot,
  type GameEvent,
  type GameSnapshot,
  type OnlinePhase,
} from "../network/protocol.js";
import { BarnCombat, fighterDrive, weaponCode } from "./barn/combat.js";
import { BARN_COMBAT } from "./barn/config.js";
import { PoseHistory, type HistoricView } from "./barn/rewind.js";
import { captureBarnPredictionState } from "./predictionState.js";
import { newRoomCounters, type OnlineSimulation, type RoomCounters } from "./online.js";

/** Barn Shootout match: a 3 s countdown, 150 s of play, most kills wins (a tie is a draw). */
export const BARN_MATCH = {
  countdown: 3,
  duration: 150,
  results: 3.5,
} as const;
/** Oldest view a shot may be resolved against, in ticks (NET.maxRewindMs). */
export const MAX_REWIND_TICKS = Math.round((NET.maxRewindMs * NET.physicsHz) / 1000);
const SPOT_IDS = Object.keys(WEAPON_SPOTS);
const EPSILON = 1e-8;
const ds = (seconds: number) => Math.max(0, Math.ceil(seconds * 10 - 1e-6));

/**
 * Authoritative Barn Shootout round for the room server: the barn world, 2–3 active
 * ragdolls and the shared `BarnCombat` rules (health, weapons, pickups, traps,
 * punches, death, respawn), plus lag compensation and the match clock. Clients only
 * send intent; every outcome here is decided from server state.
 */
export class BarnRoundSimulation implements OnlineSimulation {
  readonly mode = "barn_shootout" as const;
  private pending: FeedbackEvent[] = [];
  private collect = (event: FeedbackEvent) => {
    this.pending.push(event);
  };
  readonly physics = new PlaygroundPhysics(this.collect, arenaMap("barn"));
  readonly barn: BarnCombat;
  private contacts = new PhysicsFeedback(this.physics, this.collect);
  readonly history = new PoseHistory();
  phase: OnlinePhase = "waiting";
  mask = 0;
  /** Match clock within the current phase (s). */
  private elapsed = 0;
  private countdownCue = 0;
  winner = -1;
  reason: "timeout" | "forfeit" | null = null;
  /** Newest tick sent in a snapshot: a client cannot have seen anything later. */
  private sentTick = -1;
  private readonly viewScratch: HistoricView = { tick: 0, poses: new Float32Array(PLAYERS.length * PARTS.length * 7), hittable: PLAYERS.map(() => false) };
  readonly rewind = {
    shots: 0,
    rewound: 0,
    clampedOld: 0,
    rejectedFuture: 0,
    missing: 0,
    lastMs: 0,
    maxMs: 0,
    lookupMs: 0,
  };
  constructor(readonly counters: RoomCounters = newRoomCounters(), random: () => number = Math.random) {
    this.barn = new BarnCombat(this.physics, this.collect, random);
    this.barn.rewind = (viewTick) => this.resolveView(viewTick);
    this.resetBodies([]);
  }
  get roundId() {
    return this.counters.round;
  }
  get tick() {
    return this.counters.tick;
  }
  get seconds() {
    if (this.phase === "waiting") return 0;
    const duration = this.phase === "countdown" ? BARN_MATCH.countdown : this.phase === "playing" ? BARN_MATCH.duration : BARN_MATCH.results;
    return Math.max(0, Math.ceil(duration - this.elapsed - EPSILON));
  }
  private active(id: PlayerId) {
    return !!(this.mask & (1 << id)) && !this.barn.fighters[id].inactive;
  }
  private resetBodies(slots: readonly PlayerId[]) {
    this.physics.reset();
    this.contacts.reset();
    // One weapon per player on the map: 2 for a duel, 3 for three.
    this.barn.reset(slots, Math.max(2, slots.length));
    this.history.clear();
    this.pending.length = 0;
    this.mask = slots.reduce<number>((mask, id) => mask | (1 << id), 0);
    for (const p of this.physics.players) {
      const active = slots.includes(p.id);
      p.eliminated = !active;
      for (const part of Object.values(p.parts)) part.body.setEnabled(active);
    }
  }
  start(slots: readonly PlayerId[]) {
    if (this.phase !== "waiting" || new Set(slots).size < 2) return false;
    this.counters.round++;
    this.resetBodies(slots);
    this.phase = "countdown";
    this.elapsed = 0;
    this.countdownCue = 0;
    this.winner = -1;
    this.reason = null;
    return true;
  }
  cancelCountdown() {
    if (this.phase !== "countdown") return;
    this.phase = "waiting";
    this.resetBodies([]);
  }
  neutralize(slot: PlayerId) {
    // Input is already neutral (the room clears the mailbox); stop a swing in progress.
    this.barn.fighters[slot].punch.age = -1;
  }
  remove(slot: PlayerId) {
    const p = this.physics.players[slot];
    this.barn.retire(this.barn.fighters[slot]);
    p.eliminated = true;
    for (const part of Object.values(p.parts)) part.body.setEnabled(false);
    // Departure is a forfeit: with one player left the match ends.
    if (this.phase === "playing" && PLAYERS.filter((q) => this.active(q.id)).length < 2) this.finish("forfeit");
  }
  private finish(reason: "timeout" | "forfeit") {
    this.phase = "results";
    this.elapsed = 0;
    this.reason = reason;
    const players = PLAYERS.filter((p) => this.mask & (1 << p.id)).map((p) => this.barn.fighters[p.id]);
    const contenders = reason === "forfeit" ? players.filter((f) => !f.inactive) : players;
    const best = Math.max(...contenders.map((f) => f.kills));
    const leaders = contenders.filter((f) => f.kills === best);
    this.winner = leaders.length === 1 ? leaders[0].id : -1;
    this.collect({ name: this.winner < 0 ? "draw" : "winner" });
  }
  /**
   * Lag compensation: the poses a shot is resolved against. The client's view tick
   * must be one it could have received (≤ the newest snapshot tick); a later one is
   * impossible and resolves against the current poses instead. Older than
   * MAX_REWIND_TICKS is clamped to that limit. Static geometry is never rewound.
   */
  private resolveView(viewTick: number | undefined): HistoricView | null {
    const began = performance.now();
    const now = this.history.latest;
    if (now < 0) return null;
    const r = this.rewind;
    r.shots++;
    let t = now;
    if (viewTick === undefined || !Number.isFinite(viewTick)) r.missing++;
    else if (viewTick > Math.min(now, this.sentTick) + 1e-6) r.rejectedFuture++;
    else if (viewTick < now - MAX_REWIND_TICKS) {
      r.clampedOld++;
      t = now - MAX_REWIND_TICKS;
    } else t = viewTick;
    let view = this.history.view(t, this.viewScratch);
    if (!view) {
      r.missing++;
      t = now;
      view = this.history.view(now, this.viewScratch);
    }
    if (t < now) r.rewound++;
    r.lastMs = ((now - t) * 1000) / NET.physicsHz;
    r.maxMs = Math.max(r.maxMs, r.lastMs);
    r.lookupMs += performance.now() - began;
    return view;
  }
  private record() {
    this.history.record(
      this.tick,
      this.physics,
      (id) => this.barn.fighters[id].alive,
      this.barn.fighters.map((f) => f.life)
    );
  }
  step(inputs: readonly MovementInput[]): GameEvent[] {
    this.counters.tick++;
    this.pending.length = 0;
    const dt = PHYSICS.step;
    if (this.phase === "waiting") return [];
    if (this.phase === "results") {
      this.elapsed += dt;
      if (this.elapsed + EPSILON >= BARN_MATCH.results) {
        this.phase = "waiting";
        this.resetBodies([]);
      }
    } else if (this.phase === "countdown") {
      if (this.seconds !== this.countdownCue) {
        this.countdownCue = this.seconds;
        this.collect({ name: "countdown", step: this.countdownCue });
      }
      // Frozen on the start spawns, but standing like in play (arms at rest, idle anchor).
      for (const f of this.barn.fighters)
        this.barn.inputs[f.id] = fighterDrive(f, this.physics.players[f.id], IDLE_INPUT, this.barn.drives[f.id]);
      for (const id of this.physics.step(this.barn.inputs, this.barn.drives)) this.barn.respawn(this.barn.fighters[id]);
      this.record();
      this.elapsed += dt;
      if (this.elapsed + EPSILON >= BARN_MATCH.countdown) {
        this.phase = "playing";
        this.elapsed = 0;
        this.collect({ name: "roundStart" });
      }
    } else {
      const intent = PLAYERS.map((p) => (this.active(p.id) ? inputs[p.id] ?? IDLE_INPUT : IDLE_INPUT));
      const { inputs: effective, drives } = this.barn.step(intent, dt);
      const faults = this.physics.step(effective, drives);
      this.barn.afterStep();
      this.contacts.afterStep(dt, this.pending);
      // The barn is enclosed: only a physics fault removes a body. That is a death.
      for (const id of faults) this.barn.environmentDeath(this.barn.fighters[id]);
      this.record();
      this.elapsed += dt;
      if (this.elapsed + EPSILON >= BARN_MATCH.duration) this.finish("timeout");
    }
    return this.pending.map((event) => ({
      ...event,
      id: ++this.counters.event,
      round: this.roundId,
      tick: this.tick,
    }));
  }
  /** Common poses plus a compact integer Barn section (see BarnSnapshot). */
  snapshot(ack: number[]): GameSnapshot {
    const transforms = new Uint8Array(TRANSFORM_BYTES),
      view = new DataView(transforms.buffer);
    let offset = 0;
    for (const p of this.physics.players)
      for (const name of PARTS) {
        const body = p.parts[name].body,
          position = body.translation(),
          q = body.rotation();
        for (const value of [position.x, position.y, position.z, q.x, q.y, q.z, q.w]) {
          view.setFloat32(offset, value, true);
          offset += 4;
        }
      }
    this.sentTick = this.tick;
    const barn = this.barn;
    const f: number[] = new Array(PLAYERS.length * BARN_FIGHTER_FIELDS);
    for (const fighter of barn.fighters) {
      const o = fighter.id * BARN_FIGHTER_FIELDS,
        w = fighter.weapon;
      f[o] =
        (fighter.alive ? BARN_FLAG.alive : 0) |
        (!this.physics.players[fighter.id].eliminated ? BARN_FLAG.present : 0) |
        (fighter.alive && fighter.stagger.time > 0 ? BARN_FLAG.staggered : 0);
      f[o + 1] = Math.ceil(fighter.hp);
      f[o + 2] = w ? weaponCode(w.kind) : 0;
      f[o + 3] = w?.ammo ?? 0;
      f[o + 4] = fighter.kills;
      f[o + 5] = fighter.deaths;
      f[o + 6] = fighter.alive || fighter.inactive ? 0 : ds(BARN_COMBAT.death.respawn - fighter.deadFor);
      f[o + 7] = ds(fighter.protection);
      f[o + 8] = ds(fighter.trapped);
      f[o + 9] = Math.round(fighter.aimPitch * 100);
    }
    const director = barn.pickups,
      telegraph = BARN_COMBAT.pickups.telegraph;
    const section: BarnSnapshot = {
      f,
      p: director.active.flatMap((a) => [SPOT_IDS.indexOf(a.spot), weaponCode(a.kind)]),
      t: director.pending.flatMap((q) =>
        q.spot && director.time >= q.due - telegraph
          ? [SPOT_IDS.indexOf(q.spot), Math.min(100, Math.round(((director.time - (q.due - telegraph)) / telegraph) * 100))]
          : []
      ),
      r: barn.traps.flatMap((t) => [t.armed ? 0 : ds(t.rearmIn), Math.min(255, Number.isFinite(t.sprungFor) ? Math.floor(t.sprungFor * 10) : 255)]),
    };
    return {
      v: NET.version,
      mode: this.mode,
      seq: ++this.counters.snapshot,
      tick: this.tick,
      round: this.roundId,
      phase: this.phase,
      seconds: this.seconds,
      winner: this.phase === "waiting" ? -1 : this.winner,
      mask: this.mask,
      alive: barn.fighters.reduce((mask, fighter) => mask | (fighter.alive && this.mask & (1 << fighter.id) ? 1 << fighter.id : 0), 0),
      states: [],
      meters: [],
      grips: [],
      ack,
      transforms,
      barn: section,
    };
  }
  prediction(slot: PlayerId) {
    return captureBarnPredictionState(this.physics.players[slot], this.barn.fighters[slot]);
  }
  dispose() {
    this.physics.dispose();
    this.history.clear();
    this.pending.length = 0;
  }
}
