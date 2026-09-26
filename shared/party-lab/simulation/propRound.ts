import RAPIER from "@dimforge/rapier3d-compat";
import type { MovementInput } from "../intent.js";
import { NET, TRANSFORM_BYTES, type GameEvent, type GameSnapshot, type OnlinePhase } from "../network/protocol.js";
import { DEFAULT_PROP_SETTINGS, type PropSettings } from "../propSettings.js";
import { roundLayout, type PropLayout } from "../maps/propHuntLayout.js";
import { PROP_FAMILIES, shapeHeight } from "../maps/propHuntProps.js";
import { PLAYERS, type PlayerId } from "./players.js";
import { PARTS } from "./ragdoll/config.js";
import { IDLE_INPUT } from "./physics.js";
import { retire } from "./layers/game.js";
import { capturePredictionState } from "./predictionState.js";
import { newRoomCounters, type OnlineSimulation, type RoomCounters } from "./online.js";
import { PropHuntGame, type CastHit } from "./prophunt/game.js";
import { propShape, yawRotation } from "./prophunt/disguise.js";
import { propSection, type PropOnlineEvent } from "./prophunt/wire.js";
import type { Vec } from "./ragdoll/math.js";

/** Room lifetime, including mode switches and reconnects. Seats rotate 0 → 1 → 2. */
export class PropRotation {
  next: PlayerId = 0;
  index = -1;
  layout: PropLayout | null = null;
  constructor(readonly seed: number) {}
  played() { this.next = ((this.next + 1) % 3) as PlayerId; }
}
interface HistoricalShape { slot: PlayerId; family: string | null; shape: RAPIER.Shape; at: Vec; rotation: { x: number; y: number; z: number; w: number }; }
interface PoseFrame { tick: number; shapes: HistoricalShape[]; }
const IDLE = PLAYERS.map(() => IDLE_INPUT);
const REWIND_TICKS = Math.floor(NET.maxPropRewindMs * NET.physicsHz / 1000);

/** Uses the approved game unchanged by default; room rules are explicit options. */
export class PropRoundSimulation implements OnlineSimulation {
  readonly mode = "prop_hunt" as const;
  game: PropHuntGame;
  phase: OnlinePhase = "waiting";
  mask = 0;
  settings: PropSettings = { ...DEFAULT_PROP_SETTINGS };
  readonly events: { recipient: PlayerId | null; event: PropOnlineEvent }[] = [];
  private history: PoseFrame[] = [];
  private consumed = false;
  readonly rewind = { shots: 0, lastMs: 0, maxMs: 0, clampedOld: 0, rejectedFuture: 0, lookupMs: 0 };
  constructor(readonly counters: RoomCounters = newRoomCounters(), readonly rotation = new PropRotation(1)) {
    this.game = new PropHuntGame();
  }
  get physics() { return this.game.physics; }
  get round() { return this.game.round; }
  get tick() { return this.counters.tick; }
  get roundId() { return this.counters.round; }
  get seconds() { return this.phase === "waiting" ? 0 : this.round.seconds; }
  get winner() { return this.round.outcome === "seeker" ? this.round.seeker : -1; }
  start(slots: readonly PlayerId[]) {
    if (this.phase !== "waiting" || new Set(slots).size !== 3 || !PLAYERS.every(({ id }) => slots.includes(id))) return false;
    const index = this.rotation.index + 1;
    const layout = roundLayout(this.rotation.seed, index, this.rotation.layout);
    this.game.dispose();
    this.game = new PropHuntGame(undefined, {
      roles: PLAYERS.map(({ id }) => id === this.rotation.next ? "seeker" : "hider"),
      seed: this.rotation.seed, layout, ...this.settings, online: true,
    });
    this.game.layoutRound = index;
    this.mask = 7;
    this.counters.round++;
    this.phase = "countdown";
    this.consumed = false;
    this.history = [];
    this.events.length = 0;
    return true;
  }
  cancelCountdown() { if (this.phase === "countdown") { this.phase = "waiting"; this.mask = 0; } }
  neutralize(_slot: PlayerId) { /* Mailbox is cleared by room; all authoritative state survives. */ }
  remove(slot: PlayerId) {
    if (!(this.mask & (1 << slot)) || this.phase !== "playing") return;
    this.game.disguises.remove(slot);
    retire(this.physics.players[slot]);
    this.round.alive[slot] = false;
    this.round.foundAt[slot] = this.round.searchTick;
    if (slot === this.round.seeker || !this.round.hidden.length) {
      this.round.outcome = slot === this.round.seeker ? "hiders" : "seeker";
      this.round.reason = "forfeit";
      this.round.endedAt = this.round.searchTick;
      this.round.phase = "results";
      this.round.tick = 0;
      this.game.revealHidden();
      this.phase = "results";
    }
  }
  private capture() {
    const shapes: HistoricalShape[] = [];
    for (const slot of this.round.hidden) {
      const w = this.game.disguiseOf(slot);
      if (w) {
        const p = w.body.translation();
        shapes.push({ slot, family: w.family, shape: propShape(PROP_FAMILIES[w.family].shape), at: { ...p, y: p.y + shapeHeight(PROP_FAMILIES[w.family].shape) / 2 }, rotation: yawRotation(w.yaw) });
      } else for (const name of PARTS) {
        const c = this.physics.players[slot].parts[name].collider;
        shapes.push({ slot, family: null, shape: c.shape, at: { ...c.translation() }, rotation: { ...c.rotation() } });
      }
    }
    this.history.push({ tick: this.tick, shapes });
    while (this.history.length > REWIND_TICKS + 1) this.history.shift();
  }
  private rewindFor(viewTick: number) {
    const began = performance.now();
    if (!Number.isFinite(viewTick) || viewTick > this.tick + 2) { this.rewind.rejectedFuture++; return null; }
    const oldest = this.tick - REWIND_TICKS;
    if (viewTick < oldest) this.rewind.clampedOld++;
    const wanted = Math.max(oldest, Math.min(this.tick, Math.ceil(viewTick)));
    const frame = [...this.history].reverse().find((f) => f.tick <= wanted && f.tick >= oldest);
    this.rewind.lookupMs += performance.now() - began;
    if (!frame) return null;
    this.rewind.shots++;
    this.rewind.lastMs = (this.tick - frame.tick) * 1000 / NET.physicsHz;
    this.rewind.maxMs = Math.max(this.rewind.maxMs, this.rewind.lastMs);
    return (origin: Vec, direction: Vec, range: number, shooter: PlayerId): CastHit | null => {
      let best = this.game.cast(origin, direction, range, shooter, true);
      const ray = new RAPIER.Ray(origin, direction);
      for (const h of frame.shapes) {
        // Never rewind across a transform or elimination boundary.
        if (!this.game.hidden(h.slot) || (this.game.disguiseOf(h.slot)?.family ?? null) !== h.family) continue;
        const d = h.shape.castRay(ray, h.at, h.rotation, best?.distance ?? range, true);
        if (d < 0 || !Number.isFinite(d) || d >= (best?.distance ?? range)) continue;
        best = { distance: d, point: { x: origin.x + direction.x * d, y: origin.y + direction.y * d, z: origin.z + direction.z * d }, hit: "hider", target: h.slot, decoy: null };
      }
      return best;
    };
  }
  step(inputs: readonly MovementInput[]): GameEvent[] {
    this.counters.tick++;
    this.events.length = 0;
    if (this.phase === "waiting") return [];
    // Do not run local auto-reset: the next round requires fresh Ready and role assignment.
    if (this.phase === "results") {
      if (this.round.step() === "reset") { this.phase = "waiting"; this.mask = 0; }
      return [];
    }
    const shot = inputs[this.round.seeker];
    this.game.shotCast = this.round.phase === "search" && shot?.attack && this.game.shotCooldown <= 1 ? this.rewindFor(shot.viewTick ?? this.tick) : null;
    const event = this.game.step(this.phase === "playing" ? inputs : IDLE, PLAYERS.filter(({ id }) => inputs[id]?.whistle).map(({ id }) => id));
    this.game.shotCast = null;
    if (event === "hiding") {
      this.phase = "playing";
      if (!this.consumed) {
        this.consumed = true;
        this.rotation.index = this.game.layoutRound;
        this.rotation.layout = this.game.layout;
        this.rotation.played();
      }
    }
    if (event === "finished") this.phase = "results";
    for (const e of this.game.events) {
      const base = { eid: ++this.counters.event, tick: this.tick, round: this.roundId };
      if (e.type === "near") this.events.push({ recipient: this.round.seeker, event: { ...base, type: "near" } });
      else if (e.type === "whistle") this.events.push({ recipient: null, event: { ...base, type: "whistle", at: { x: Math.round(e.at.x * 2) / 2, y: Math.round(e.at.y * 2) / 2, z: Math.round(e.at.z * 2) / 2 } } });
      else this.events.push({ recipient: ["disguise", "undisguise", "refused", "whistleCooldown"].includes(e.type) && "id" in e ? e.id : null, event: { ...base, ...e } });
    }
    this.capture();
    return [];
  }
  snapshot(ack: number[]): GameSnapshot {
    const transforms = new Uint8Array(TRANSFORM_BYTES), view = new DataView(transforms.buffer);
    let offset = 0;
    for (const p of this.physics.players) for (const name of PARTS) {
      const b = p.parts[name].body, at = b.translation(), q = b.rotation();
      for (const n of [at.x, at.y, at.z, q.x, q.y, q.z, q.w]) { view.setFloat32(offset, n, true); offset += 4; }
    }
    return { v: NET.version, mode: this.mode, seq: ++this.counters.snapshot, tick: this.tick, round: this.roundId,
      phase: this.phase, seconds: this.seconds, winner: this.winner, mask: this.mask,
      alive: this.round.alive.reduce((m, yes, id) => m | (yes ? 1 << id : 0), 0), states: [], meters: [], grips: [], ack, transforms,
      prop: propSection(this.game, this.rotation.seed, this.game.layoutRound, this.settings) };
  }
  prediction(slot: PlayerId) {
    const c = this.physics.players[slot];
    const state = capturePredictionState(c, { nextPunchHand: 0, alternateIn: 0, punches: [] });
    state.controller = [c.facing, c.gait, c.jumpIn, c.sprint, +c.anchored, c.anchorX, c.anchorZ];
    return state;
  }
  dispose() { this.game.dispose(); this.history.length = 0; this.events.length = 0; }
}
