import RAPIER from "@dimforge/rapier3d-compat";
import { silentFeedback, type FeedbackEvent, type FeedbackSink } from "../../feedback/events.js";
import type { MovementInput } from "../../intent.js";
import { decoyHalf, HIDER_SPAWNS, HIDER_YAW, PROP_HUNT_MAP, SEEKER_SPAWN, SEEKER_YAW, type DecoyPlacement, type PropRole } from "../../maps/propHunt.js";
import { layoutChange, roundLayout, type PropLayout } from "../../maps/propHuntLayout.js";
import { PROP_FAMILIES, shapeHeight, type PropFamilyId } from "../../maps/propHuntProps.js";
import type { Vec3 } from "../../maps/types.js";
import { retire } from "../layers/game.js";
import { IDLE_INPUT, PlaygroundPhysics } from "../physics.js";
import { addStaticCollider } from "../world.js";
import { PLAYERS, type PlayerId } from "../players.js";
import { connect, restore, type Character } from "../ragdoll/character.js";
import { PARTS } from "../ragdoll/config.js";
import { floorBelow, normalDrive, type CharacterDrive } from "../ragdoll/controller.js";
import type { Vec } from "../ragdoll/math.js";
import { aimDirection, aimEye } from "./aim.js";
import { PROP_HUNT, PROP_TICKS, WHISTLE_TICKS } from "./config.js";
import { DisguiseSystem, yawRotation, type Disguise } from "./disguise.js";
import { ProximitySense, senses, type SenseTarget } from "./proximity.js";
import { PropHuntRound, type PropRoundEvent } from "./round.js";

export type { PropRole } from "../../maps/propHunt.js";
export type PropRefusal = "noProp" | "noRoom" | "airborne" | "cooldown";
export type ShotHit = "hider" | "decoy" | "world" | "none";
export type PropHuntEvent =
  | { type: "disguise"; id: PlayerId; family: PropFamilyId; decoy: number; at: Vec; yaw: number }
  | { type: "undisguise"; id: PlayerId; at: Vec }
  | { type: "refused"; id: PlayerId; why: PropRefusal }
  | { type: "shot"; shooter: PlayerId; origin: Vec; end: Vec; hit: ShotHit; target: PlayerId | null; decoy: number | null; ammo: number }
  | { type: "found"; id: PlayerId; by: PlayerId; family: PropFamilyId | null; at: Vec; yaw: number }
  | { type: "dry"; shooter: PlayerId }
  /** The periodic whistle: where the sound comes from (a disguise's middle, or the body's chest). */
  | { type: "whistle"; id: PlayerId; at: Vec; disguised: boolean }
  | { type: "whistleCooldown"; id: PlayerId }
  /**
   * The seeker's hunch: some hider still hidden has been close for a moment. Deliberately
   * nothing else — not which hider, how many, which way or how far (a server would send it to
   * the seeker alone).
   */
  | { type: "near"; seeker: PlayerId };
/** A hider still hidden when the round was decided: where it was, as what (null: in plain body). */
export interface PropReveal {
  id: PlayerId;
  family: PropFamilyId | null;
  /** Bottom-centre of its prop, or its feet. */
  at: Vec;
  yaw: number;
}
export interface DecoyPick {
  index: number;
  /** Horizontal gap from the hider's pelvis to the decoy's footprint (m). */
  distance: number;
}
export interface PropHuntOptions {
  /** Role per slot, exactly one seeker (default: slot 0 seeks, slots 1 and 2 hide). */
  roles?: readonly PropRole[];
  /** The match's layout seed: every round deals its decoys from it (the same seed, the same layouts). Default 1. */
  seed?: number;
  /** One fixed layout for every round instead of the dealt ones (tests). */
  layout?: PropLayout;
  /** Online authority options; omitted by local play. */
  ammo?: 5 | 10 | 15;
  proximity?: boolean;
  online?: boolean;

}
export interface CastHit {
  point: Vec;
  distance: number;
  hit: Exclude<ShotHit, "none">;
  target: PlayerId | null;
  decoy: number | null;
}

/** Pelvis height over the surface for a spawn or a hider stepping out of a disguise. */
const STAND = 0.9;
/** The standing body tested for room before a hider steps out (half extents, m). */
const BODY = { x: 0.46, y: 0.95, z: 0.34 } as const;
const D = PROP_HUNT.disguise;

/**
 * Saklambaç (Prop Hunt), local V1: one seeker, two hiders, the shared ragdoll physics in the
 * forest camp (maps/propHunt.ts). Deterministic for the same inputs: the local arena drives it
 * with a human and bots, and a room server could drive it the same way.
 *
 * Round (round.ts): countdown (everyone frozen) → hiding (hiders move and disguise; the seeker
 * is frozen and blind) → search (the seeker hunts with 15 shots) → results, with every hider
 * still hidden revealed where it was (`reveal`). Each round deals its decoy layout from the
 * match seed and the round before it (propHuntLayout.ts): the decoys' static colliders are
 * swapped at every reset, the architecture never changes.
 *
 * One hiding/search step:
 * 1. Transforms: a hider's Grab press (E) copies the nearest decoy in reach and sight (its
 *    ragdoll retires, a kinematic prop body appears where it stood — nudged to fit, never
 *    inside anything) or, disguised, steps back out (only where a standing body fits).
 * 2. Disguised hiders move through the character controller (slow, no jump).
 * 3. Physics (the ragdolls: the seeker, undisguised hiders; the seeker is idle while hiding).
 * 4. The seeker's shot (search only): the Barn's two-ray hitscan against the world as it now
 *    is — a disguised hider's prop shape or an undisguised hider's body is found; a decoy or
 *    anything else only costs the shot.
 * 5. The round: the last hider found → the seeker wins at once; the seeker's last shot spent
 *    (and not finding the last hider) or the search running out with a hider left → the hiders
 *    win. Then the hiders still hidden are recorded for the result's reveal.
 * 6. The periodic whistle: at 60, 45, 30 and 15 s left, each hider still hidden whistles once
 *    (slot order, 0.6 s apart) from its prop or body — an event for the presentation's
 *    positional sound, nothing else.
 * 7. The seeker's hunch: a hider still hidden close to the seeker (same floor, same space) for
 *    0.9 s → one generic "near" event; leave 6.5 m for 1.25 s before rearming (proximity.ts).
 */
export class PropHuntGame {
  readonly physics: PlaygroundPhysics;
  readonly round: PropHuntRound;
  readonly disguises: DisguiseSystem;
  /** This step's events (transforms, refusals, shots, finds). */
  readonly events: PropHuntEvent[] = [];
  /** This step's found hiders. */
  readonly found: PlayerId[] = [];
  /** The seeker's shots left this round. */
  ammo: number = PROP_HUNT.seeker.ammo;
  /** Ticks until the seeker can shoot again. */
  shotCooldown = 0;
  /** Ticks until each hider can transform or step out again. */
  readonly toggleCooldown = PLAYERS.map(() => 0);
  /**
   * The hiders still hidden when the round was decided (empty until then, and again from the
   * next reset): the result shows each of them where it was.
   */
  readonly reveal: PropReveal[] = [];
  /** Shots fired and decoys hit this round (diagnostics). */
  readonly stats = { shots: 0, decoyHits: 0, worldHits: 0, misses: 0, finds: 0 };
  /** This round's decoys (dealt afresh at every reset). */
  layout!: PropLayout;
  /** The round's index in the match (its layout is dealt from the match seed and this). */
  layoutRound = 0;
  /** Share of the ordinary decoys that moved since the previous round (null: the first round, or a fixed layout). */
  layoutChanged: number | null = null;
  /** Search tick each hider whistles on next (−1: none due), and how often each has whistled this round. */
  private readonly whistleDue = PLAYERS.map(() => -1);
  readonly whistles = PLAYERS.map(() => 0);
  readonly manualWhistles = PLAYERS.map(() => 0);
  readonly manualWhistleCooldown = PLAYERS.map(() => 0);
  /** The next of `WHISTLE_TICKS` to come this round. */
  private whistleNext = 0;
  /** The seeker's broad hunch (dwell and rearm latch; never who). */
  readonly sense = new ProximitySense();
  readonly seed: number;
  readonly ammoMax: number;
  readonly proximityEnabled: boolean;
  private readonly online: boolean;
  /** Server-only historical ray query during an accepted shot. */
  shotCast: ((origin: Vec, direction: Vec, range: number, shooter: PlayerId) => CastHit | null) | null = null;
  readonly sourceDecoys = [-1, -1, -1];
  private readonly fixedLayout: PropLayout | null;
  private readonly partOf = new Map<number, PlayerId>();
  private readonly decoyOf = new Map<number, number>();
  private decoyHandle: number[] = [];
  private decoyColliders: RAPIER.Collider[] = [];
  /** Static collider handle of each decoy (sight lines that must not stop at the prop looked at). */
  get decoyHandles(): readonly number[] {
    return this.decoyHandle;
  }
  private readonly drives: CharacterDrive[] = PLAYERS.map(() => ({ ...normalDrive(), anchor: true }));
  private readonly idle: MovementInput[] = PLAYERS.map(() => IDLE_INPUT);
  private readonly pending: FeedbackEvent[] = [];
  private readonly collect: FeedbackSink = (event) => this.pending.push(event);
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  private countdownCue = 0;

  constructor(
    private readonly feedback: FeedbackSink = silentFeedback,
    options: PropHuntOptions = {}
  ) {
    const roles = options.roles ?? (["seeker", "hider", "hider"] as const);
    if (roles.length !== PLAYERS.length || roles.filter((r) => r === "seeker").length !== 1) throw new Error("Saklambaç needs exactly one seeker among three players");
    this.round = new PropHuntRound(roles);
    this.ammoMax = options.ammo ?? PROP_HUNT.seeker.ammo;
    this.ammo = this.ammoMax;
    this.proximityEnabled = options.proximity ?? true;
    this.online = options.online ?? false;
    this.seed = (options.seed ?? 1) >>> 0;
    this.fixedLayout = options.layout ?? null;
    this.physics = new PlaygroundPhysics(this.collect, PROP_HUNT_MAP);
    for (const player of this.physics.players) for (const part of PARTS) this.partOf.set(player.parts[part].collider.handle, player.id);
    this.applyLayout(this.fixedLayout ?? roundLayout(this.seed, 0, null));
    this.disguises = new DisguiseSystem(this.physics.world, (collider, id) => this.partOf.get(collider.handle) === id);
    this.placeAll();
  }
  get roles(): readonly PropRole[] {
    return this.round.roles;
  }
  get seeker(): PlayerId {
    return this.round.seeker;
  }
  /** Where a slot starts: the seeker's spawn, or the hiders' in slot order. */
  spawnOf(id: PlayerId): { at: Vec3; yaw: number } {
    if (this.round.roles[id] === "seeker") return { at: SEEKER_SPAWN, yaw: SEEKER_YAW };
    return { at: HIDER_SPAWNS[this.round.hiders.indexOf(id)], yaw: HIDER_YAW };
  }
  /** The round's decoys. */
  get decoys(): readonly DecoyPlacement[] {
    return this.layout.decoys;
  }
  /**
   * Puts a layout's decoys in the world: the previous round's decoy colliders go, one static
   * collider per decoy comes (in layout order, so decoy i is `decoyHandles[i]`). Called at a
   * reset, before the next physics step (the step brings the scene queries up to date).
   */
  private applyLayout(layout: PropLayout) {
    for (const collider of this.decoyColliders) this.physics.world.removeCollider(collider, false);
    this.decoyOf.clear();
    this.layout = layout;
    this.decoyColliders = layout.colliders.map((c) => addStaticCollider(this.physics.world, c));
    this.decoyHandle = this.decoyColliders.map((c) => c.handle);
    this.decoyHandle.forEach((handle, i) => this.decoyOf.set(handle, i));
  }
  /** The next round's layout: dealt from the match seed (never the previous one again), unless fixed. */
  private dealLayout() {
    if (this.fixedLayout) return;
    const previous = this.layout;
    this.layoutRound++;
    const next = roundLayout(this.seed, this.layoutRound, previous);
    this.layoutChanged = layoutChange(previous, next);
    this.applyLayout(next);
  }
  private placeAll() {
    for (const character of this.physics.players) {
      const { at, yaw } = this.spawnOf(character.id);
      restore(character, at, yaw);
      connect(this.physics.world, character);
    }
  }
  /** A fresh round from the countdown (the same roles). */
  reset() {
    this.round.phase = "countdown";
    this.round.tick = 0;
    this.round.outcome = this.round.reason = null;
    this.round.endedAt = -1;
    for (const { id } of PLAYERS) {
      this.round.alive[id] = true;
      this.round.foundAt[id] = -1;
    }
    this.round.revision++;
    this.resetWorld();
  }
  private resetWorld() {
    this.disguises.clear();
    this.dealLayout();
    this.whistleDue.fill(-1);
    this.whistles.fill(0);
    this.manualWhistles.fill(0);
    this.manualWhistleCooldown.fill(0);
    this.whistleNext = 0;
    this.sense.reset();
    this.reveal.length = 0;
    this.ammo = this.ammoMax;
    this.sourceDecoys.fill(-1);
    this.shotCooldown = 0;
    this.toggleCooldown.fill(0);
    this.countdownCue = 0;
    Object.assign(this.stats, { shots: 0, decoyHits: 0, worldHits: 0, misses: 0, finds: 0 });
    this.placeAll();
  }

  /** Whether a slot is a hider who has not been found. */
  hidden(id: PlayerId) {
    return this.round.roles[id] === "hider" && this.round.alive[id];
  }
  disguiseOf(id: PlayerId): Disguise | null {
    return this.disguises.worn[id];
  }

  /** Recipient movement prediction only: never transforms, shoots, senses or decides a result. */
  predictMovement(id: PlayerId, input: MovementInput) {
    const allowed = this.round.alive[id] && (this.round.phase === "search" || (this.round.phase === "hiding" && this.roles[id] === "hider"));
    const worn = this.disguises.worn[id];
    if (allowed && worn) this.disguises.move(id, input.x, input.z);
    const live = PLAYERS.map(({ id: slot }) => slot === id && allowed && !worn
      ? { ...input, pickup: false, attack: false, facing: this.roles[id] === "hider" ? undefined : input.facing }
      : IDLE_INPUT);
    this.physics.step(live, this.drives);
  }

  step(inputs: readonly MovementInput[], manualWhistles: readonly PlayerId[] = []): PropRoundEvent {
    this.pending.length = 0;
    this.events.length = 0;
    this.found.length = 0;
    const event = this.advance(inputs, manualWhistles);
    for (const cue of this.pending) this.feedback(cue);
    return event;
  }
  private advance(inputs: readonly MovementInput[], manualWhistles: readonly PlayerId[]): PropRoundEvent {
    const round = this.round;
    if (round.phase === "results") {
      this.physics.step(this.idle, this.drives);
      const event = round.step();
      if (event === "reset") this.resetWorld();
      return event;
    }
    if (round.phase === "countdown") {
      this.physics.step(this.idle, this.drives);
      const event = round.step();
      if (round.phase === "countdown" && round.seconds !== this.countdownCue) {
        this.countdownCue = round.seconds;
        this.collect({ name: "countdown", step: this.countdownCue });
      }
      if (event === "hiding") this.collect({ name: "roundStart" });
      return event;
    }
    if (this.shotCooldown > 0) this.shotCooldown--;
    for (const { id } of PLAYERS) if (this.manualWhistleCooldown[id] > 0) this.manualWhistleCooldown[id]--;
    for (const { id } of PLAYERS) if (this.toggleCooldown[id] > 0) this.toggleCooldown[id]--;
    const seeker = round.seeker,
      searching = round.phase === "search";
    // 1. Transforms.
    for (const id of round.hidden) if (inputs[id]?.pickup) this.toggle(id);
    // 2. Disguised hiders move.
    for (const id of round.hidden) {
      if (!this.disguises.worn[id]) continue;
      const input = inputs[id] ?? IDLE_INPUT;
      this.disguises.move(id, input.x, input.z);
    }
    // 3. The ragdolls: the seeker (frozen while the hiders hide) and hiders on foot.
    const live = PLAYERS.map(({ id }) => {
      if (id === seeker) return searching ? inputs[id] ?? IDLE_INPUT : IDLE_INPUT;
      return round.alive[id] && !this.disguises.worn[id] ? { ...(inputs[id] ?? IDLE_INPUT), facing: undefined, attack: false } : IDLE_INPUT;
    });
    this.physics.step(live, this.drives);
    // 4. The seeker's shot.
    if (searching && inputs[seeker]?.attack) this.fire(seeker, inputs[seeker]!);
    // 5. The round (this tick's shot is resolved first: its finds, then whether the gun is empty).
    const event = round.step(this.found, searching && this.ammo <= 0);
    if (event === "search") this.collect({ name: "roundStart" });
    else if (event === "finished") {
      this.revealHidden();
      this.collect({ name: "winner", actor: round.outcome === "seeker" ? seeker : round.hidden[0] ?? seeker });
    }
    // 6. The periodic whistle.
    if (round.phase === "search") this.whistle();
    // Local taunts use a separate clock; automatic calls never spend or check this cooldown.
    if ((!this.online && round.phase === "hiding") || round.phase === "search") {
      for (const { id } of PLAYERS) {
        if (!manualWhistles.includes(id) || !this.hidden(id)) continue;
        if (this.manualWhistleCooldown[id] > 0) this.events.push({ type: "whistleCooldown", id });
        else {
          this.manualWhistleCooldown[id] = PROP_TICKS.manualWhistleCooldown;
          this.manualWhistles[id]++;
          this.emitWhistle(id);
        }
      }
    }
    // 7. The seeker's hunch.
    if (this.proximityEnabled && round.phase === "search" && this.sense.step(() => this.hiderNear(seeker), () => this.outsideProximity(seeker))) this.events.push({ type: "near", seeker });
    return event;
  }
  /**
   * At each of `WHISTLE_TICKS` (60, 45, 30 and 15 s left in the search), every hider still
   * hidden gets a whistle due, in slot order `whistle.stagger` apart; each sounds once, from
   * where the hider is then (a found hider's due whistle never sounds).
   */
  private whistle() {
    const round = this.round;
    if (this.whistleNext < WHISTLE_TICKS.length && round.tick >= WHISTLE_TICKS[this.whistleNext]) {
      this.whistleNext++;
      round.hidden.forEach((id, k) => (this.whistleDue[id] = round.tick + k * PROP_TICKS.whistleStagger));
    }
    for (const id of round.hiders) {
      if (this.whistleDue[id] < 0 || round.tick < this.whistleDue[id]) continue;
      this.whistleDue[id] = -1;
      if (!round.alive[id]) continue;
      this.whistles[id]++;
      this.emitWhistle(id);
    }
  }
  private emitWhistle(id: PlayerId) {
    const worn = this.disguises.worn[id];
    const at = worn ? { ...worn.body.translation() } : { ...this.physics.players[id].parts.torso.body.translation() };
    if (worn) at.y += shapeHeight(PROP_FAMILIES[worn.family].shape) / 2;
    this.events.push({ type: "whistle", id, at, disguised: !!worn });
  }
  /** Occlusion cannot rearm the cue: the seeker must leave the whole nearby area. */
  outsideProximity(seeker: PlayerId = this.round.seeker): boolean {
    const at = this.physics.players[seeker].body.translation();
    return this.round.hidden.every((id) => {
      const h = this.senseTarget(id);
      return Math.hypot(h.x - at.x, h.z - at.z) > PROP_HUNT.proximity.rearmRadius;
    });
  }
  /** Whether any hider still hidden is close to the seeker now (proximity.ts: radius, floor, no wall between). Diagnostics and tests: the seeker bot only ever gets the "near" event. */
  hiderNear(seeker: PlayerId = this.round.seeker): boolean {
    const at = this.physics.players[seeker].body.translation();
    return this.round.hidden.some((id) => senses(at, this.senseTarget(id)));
  }
  /** Where a hider is for the seeker's hunch: its prop (bottom, middle, near its top) or its body. */
  senseTarget(id: PlayerId): SenseTarget {
    const worn = this.disguises.worn[id];
    if (worn) {
      const b = worn.body.translation(),
        height = shapeHeight(PROP_FAMILIES[worn.family].shape),
        feet = b.y - D.skin;
      return { x: b.x, z: b.z, feet, middle: feet + height * 0.5, top: feet + height * 0.85 };
    }
    const p = this.physics.players[id].body.translation();
    return { x: p.x, z: p.z, feet: p.y - 0.78, middle: p.y + 0.4, top: p.y + 0.87 };
  }

  /** Where each hider still hidden is at the decision (its prop's bottom-centre, or its feet). */
  revealHidden() {
    this.reveal.length = 0;
    for (const id of this.round.hidden) {
      const worn = this.disguises.worn[id],
        character = this.physics.players[id];
      if (worn) {
        const b = worn.body.translation();
        this.reveal.push({ id, family: worn.family, at: { x: b.x, y: b.y - D.skin, z: b.z }, yaw: worn.yaw });
      } else if (!character.eliminated) this.reveal.push({ id, family: null, at: { ...character.body.translation(), y: this.feet(character) }, yaw: character.facing });
    }
  }

  // ── Hiders ────────────────────────────────────────────────────────────────

  private refuse(id: PlayerId, why: PropRefusal) {
    this.events.push({ type: "refused", id, why });
  }
  private toggle(id: PlayerId) {
    if (this.toggleCooldown[id] > 0) return this.refuse(id, "cooldown");
    if (this.disguises.worn[id]) this.stepOut(id);
    else this.disguise(id);
  }
  /** Feet height of an undisguised body (its pelvis less the floor gap straight below). */
  feet(character: Character): number {
    const p = character.body.translation(),
      gap = floorBelow(this.physics.world, p, 2);
    return gap === null ? p.y - 0.78 : p.y - gap;
  }
  /**
   * The decoy a hider would copy now: every decoy whose footprint is within `range` of the
   * pelvis (horizontally), standing within `heightGap` of the hider's feet, and in plain sight
   * (a line from the chest or the pelvis to its middle reaches it without touching anything
   * else: no copying through walls, glass, floors or other props). The nearest one.
   */
  nearestDecoy(id: PlayerId): DecoyPick | null {
    const character = this.physics.players[id];
    if (character.eliminated || this.disguises.worn[id]) return null;
    const p = character.body.translation(),
      feet = this.feet(character);
    const candidates: DecoyPick[] = [];
    this.layout.decoys.forEach((decoy, index) => {
      if (Math.abs(decoy.y - feet) > D.heightGap) return;
      const shape = PROP_FAMILIES[decoy.family].shape;
      let distance: number;
      if (shape.kind === "cylinder") distance = Math.max(0, Math.hypot(p.x - decoy.x, p.z - decoy.z) - shape.radius);
      else {
        const h = decoyHalf(decoy);
        distance = Math.hypot(Math.max(0, Math.abs(p.x - decoy.x) - h.x), Math.max(0, Math.abs(p.z - decoy.z) - h.z));
      }
      if (distance <= D.range) candidates.push({ index, distance });
    });
    candidates.sort((a, b) => a.distance - b.distance || a.index - b.index);
    for (const pick of candidates) if (this.sees(character, pick.index)) return pick;
    return null;
  }
  /** Whether a hider's chest or pelvis has a clear line to a decoy's middle. */
  private sees(character: Character, index: number): boolean {
    const decoy = this.layout.decoys[index],
      target = { x: decoy.x, y: decoy.y + shapeHeight(PROP_FAMILIES[decoy.family].shape) * 0.5, z: decoy.z },
      handle = this.decoyHandle[index];
    for (const from of [character.parts.torso.body.translation(), character.body.translation()]) {
      const dx = target.x - from.x,
        dy = target.y - from.y,
        dz = target.z - from.z,
        d = Math.hypot(dx, dy, dz);
      if (d < 1e-3) return true;
      this.ray.origin = from;
      this.ray.dir = { x: dx / d, y: dy / d, z: dz / d };
      const hit = this.physics.world.castRay(this.ray, d, true, undefined, undefined, undefined, undefined, (collider) => collider.handle !== handle && !this.partOf.has(collider.handle));
      if (!hit) return true;
    }
    return false;
  }
  private disguise(id: PlayerId) {
    const character = this.physics.players[id];
    if (!this.physics.isGrounded(id)) return this.refuse(id, "airborne");
    const pick = this.nearestDecoy(id);
    if (!pick) return this.refuse(id, "noProp");
    const decoy = this.layout.decoys[pick.index],
      p = character.body.translation(),
      feet = this.feet(character),
      source = (decoy.turns * Math.PI) / 2;
    // The copied decoy's turn first (it lines up with the room), then the hider's own facing, then the other turns.
    const yaws = [source, character.facing, source + Math.PI / 2, source + Math.PI, source + (3 * Math.PI) / 2];
    for (const yaw of yaws) {
      const at = this.disguises.place(id, decoy.family, p.x, p.z, feet, yaw);
      if (!at) continue;
      retire(character);
      const wrapped = Math.atan2(Math.sin(yaw), Math.cos(yaw));
      this.disguises.wear(id, decoy.family, at, wrapped);
      this.sourceDecoys[id] = pick.index;
      this.toggleCooldown[id] = PROP_TICKS.disguiseCooldown;
      this.events.push({ type: "disguise", id, family: decoy.family, decoy: pick.index, at, yaw: wrapped });
      this.collect({ name: "grab", actor: id, x: at.x, intensity: 0.7 });
      return;
    }
    this.refuse(id, "noRoom");
  }
  /** Where a standing body fits over a disguise's spot (the spot itself or a little aside). */
  standingRoom(id: PlayerId, worn: Disguise): Vec | null {
    const b = worn.body.translation(),
      shape = new RAPIER.Cuboid(BODY.x, BODY.y, BODY.z),
      rotation = yawRotation(worn.yaw);
    for (const r of [0, 0.2, 0.4, 0.6]) {
      const n = r === 0 ? 1 : 8;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2,
          x = b.x + Math.cos(a) * r,
          z = b.z + Math.sin(a) * r;
        const blocked = this.physics.world.intersectionWithShape({ x, y: b.y + BODY.y + 0.05, z }, rotation, shape, undefined, undefined, undefined, undefined, (collider) => this.partOf.get(collider.handle) !== id && this.disguises.ownerOf(collider.handle) !== id);
        if (!blocked) return { x, y: b.y, z };
      }
    }
    return null;
  }
  private stepOut(id: PlayerId) {
    const worn = this.disguises.worn[id]!,
      room = this.standingRoom(id, worn);
    if (!room) return this.refuse(id, "noRoom");
    const yaw = worn.yaw;
    this.disguises.remove(id);
    const character = this.physics.players[id];
    restore(character, { x: room.x, y: room.y + STAND, z: room.z }, yaw);
    connect(this.physics.world, character);
    this.toggleCooldown[id] = PROP_TICKS.disguiseCooldown;
    this.events.push({ type: "undisguise", id, at: room });
    this.collect({ name: "release", actor: id, x: room.x, intensity: 0.6 });
  }

  // ── The seeker ────────────────────────────────────────────────────────────

  /** Whether a slot can be hit: a hider not found yet (the shooter never). */
  private hittable(id: PlayerId, shooter: PlayerId) {
    return id !== shooter && this.hidden(id);
  }
  /** First thing along a unit ray: static geometry (walls, glass, furniture), a decoy, a disguise or a hider's body. */
  cast(origin: Vec, direction: Vec, range: number, shooter: PlayerId, staticOnly = false): CastHit | null {
    if (!staticOnly && this.shotCast) return this.shotCast(origin, direction, range, shooter);
    this.ray.origin = origin;
    this.ray.dir = direction;
    const hit = this.physics.world.castRay(this.ray, range, true, undefined, undefined, undefined, undefined, (collider) => {
      const part = this.partOf.get(collider.handle);
      if (part !== undefined) return !staticOnly && this.hittable(part, shooter) && !this.disguises.worn[part] && !this.physics.players[part].eliminated;
      const owner = this.disguises.ownerOf(collider.handle);
      if (owner !== null) return !staticOnly && this.hittable(owner, shooter);
      return true;
    });
    if (!hit) return null;
    const t = hit.timeOfImpact,
      point = { x: origin.x + direction.x * t, y: origin.y + direction.y * t, z: origin.z + direction.z * t },
      handle = hit.collider.handle;
    const part = this.partOf.get(handle) ?? this.disguises.ownerOf(handle);
    if (part !== null && part !== undefined) return { point, distance: t, hit: "hider", target: part, decoy: null };
    const decoy = this.decoyOf.get(handle);
    if (decoy !== undefined) return { point, distance: t, hit: "decoy", target: null, decoy };
    return { point, distance: t, hit: "world", target: null, decoy: null };
  }
  /**
   * Where the seeker's crosshair points and the direction a shot leaves its torso toward it
   * (the Barn's rule: converge on the aim point unless it is practically inside the shooter or
   * behind it; then along the look direction).
   */
  aim(input: MovementInput) {
    const seeker = this.round.seeker,
      character = this.physics.players[seeker],
      yaw = Number.isFinite(input.facing) ? input.facing! : character.facing,
      pitch = Math.max(-1.2, Math.min(1.2, Number.isFinite(input.aimPitch) ? input.aimPitch! : 0)),
      look = aimDirection(yaw, pitch),
      eye = aimEye(character.body.translation(), yaw, input.aimEye),
      range = PROP_HUNT.aim.range;
    const hit = this.cast(eye, look, range, seeker);
    const point = hit?.point ?? { x: eye.x + look.x * range, y: eye.y + look.y * range, z: eye.z + look.z * range };
    const origin = { ...character.parts.torso.body.translation() },
      dx = point.x - origin.x,
      dy = point.y - origin.y,
      dz = point.z - origin.z,
      d = Math.hypot(dx, dy, dz),
      forward = d > 0 ? (dx * look.x + dy * look.y + dz * look.z) / d : -1;
    const direction = d < PROP_HUNT.aim.minConvergence || forward < PROP_HUNT.aim.minForward ? look : { x: dx / d, y: dy / d, z: dz / d };
    return { origin, direction, point, look, eye, target: hit };
  }
  private fire(seeker: PlayerId, input: MovementInput) {
    if (this.shotCooldown > 0) return;
    this.shotCooldown = PROP_TICKS.shotCooldown;
    if (this.ammo <= 0) {
      this.events.push({ type: "dry", shooter: seeker });
      this.collect({ name: "weaponEmpty", actor: seeker });
      return;
    }
    this.ammo--;
    this.stats.shots++;
    const { origin, direction } = this.aim(input),
      range = PROP_HUNT.seeker.range,
      hit = this.cast(origin, direction, range, seeker),
      end = hit?.point ?? { x: origin.x + direction.x * range, y: origin.y + direction.y * range, z: origin.z + direction.z * range };
    this.events.push({ type: "shot", shooter: seeker, origin, end, hit: hit?.hit ?? "none", target: hit?.target ?? null, decoy: hit?.decoy ?? null, ammo: this.ammo });
    this.collect({ name: "smgFire", actor: seeker, x: origin.x, intensity: 0.8 });
    if (!hit) this.stats.misses++;
    else if (hit.hit === "decoy") {
      this.stats.decoyHits++;
      this.collect({ name: "bulletHit", actor: seeker, x: end.x, intensity: 0.4 });
    } else if (hit.hit === "world") this.stats.worldHits++;
    if (hit?.hit === "hider" && hit.target !== null) this.find(hit.target, seeker);
  }
  /** A hider is found: out of the round (its prop or body goes; presentation shows the reveal). */
  private find(id: PlayerId, by: PlayerId) {
    const worn = this.disguises.worn[id],
      character = this.physics.players[id],
      at = worn ? { ...worn.body.translation() } : { ...character.body.translation(), y: this.feet(character) },
      yaw = worn ? worn.yaw : character.facing;
    this.disguises.remove(id);
    retire(character);
    this.found.push(id);
    this.stats.finds++;
    this.events.push({ type: "found", id, by, family: worn?.family ?? null, at, yaw });
    this.collect({ name: "death", actor: id, target: by, x: at.x, intensity: 1 });
  }

  dispose() {
    this.physics.dispose();
  }
}
