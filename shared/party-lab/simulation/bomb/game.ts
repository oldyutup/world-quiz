import { silentFeedback, type FeedbackEvent, type FeedbackSink } from "../../feedback/events.js";
import type { MovementInput } from "../../intent.js";
import { BOMB_MAP, BOMB_TRAPS, bombSpawn, surfaceBelow } from "../../maps/bomb.js";
import { feet } from "../barn/traps.js";
import { COMBAT } from "../combatConfig.js";
import { mulberry32 } from "../colors/layouts.js";
import { PhysicsFeedback } from "../feedback.js";
import { LayerBrawl, push } from "../layers/brawl.js";
import { retire } from "../layers/game.js";
import { LayerRound, type LayerRoundEvent } from "../layers/round.js";
import { IDLE_INPUT, PHYSICS, PlaygroundPhysics } from "../physics.js";
import { PLAYERS, type PlayerId } from "../players.js";
import { restore, type Character } from "../ragdoll/character.js";
import type { Vec } from "../ragdoll/math.js";
import { BOMB_TAG, BOMB_TICKS } from "./config.js";
import { BombRules, type BombEvent, type PassRefusal } from "./rules.js";
import { BombTraps, type BombTrap, type TrapSpring } from "./traps.js";

export interface BombGameOptions {
  /** 2 or 3 players in the match (slots 0…n−1). */
  players?: 2 | 3;
  /** Seeds every round's carrier picks (default: random). Same seed + inputs → same match. */
  seed?: number;
}
/** Who a carrier's punch would tag right now (the tag assist), or the protected player it was refused for. */
export interface TagPick {
  target: PlayerId | null;
  /** The nearest rival that passed every geometry rule but may not take it back yet (tag-back). */
  refused: PlayerId | null;
  /** Horizontal pelvis distance to `target` (m; Infinity: none). */
  distance: number;
}
/** Timers count seconds in 1/60 steps; this absorbs the rounding. */
const EPSILON = 1e-9;
/** Horizontal pelvis-to-pelvis distance (m). */
function horizontal(a: Character, b: Character) {
  const p = a.body.translation(),
    q = b.body.translation();
  return Math.hypot(q.x - p.x, q.z - p.z);
}
export interface BombBlast {
  carrier: PlayerId;
  x: number;
  y: number;
  z: number;
  /** Everyone the blast shoved. */
  shoved: PlayerId[];
}
export interface BombTagPose {
  pelvis: Vec;
  chest: Vec;
}

/**
 * Bomba Sende ("hot potato"): the shared ragdoll physics in the walled playground
 * (maps/bomb.ts), Katman Kaosu's shove punch (Bomba Sende's own tuning, same values),
 * Katman Kaosu's round (last one standing wins, same-tick draw; Bomba Sende's timing),
 * the bomb (rules.ts) and three slow traps (traps.ts). Deterministic for the same seed and
 * inputs; the local arena drives it with a human and bots, and an online room could drive
 * it the same way (`begin` with the room's slots, the bomb and trap state in each snapshot).
 *
 * One playing step (round tick t): the bomb (lights on t = 0; burns; a blast retires the
 * carrier and shoves everyone near before physics) → the traps (reopen; slows count down;
 * feet on an armed trap spring it) → punches and drives (a lit bomb's carrier runs at
 * `carrierSpeed`; a trapped player at `trap.slow` of their speed) → physics → punch
 * contacts: the carrier's first landed punch passes the bomb; failing that, while its punch
 * swings, the tag assist (`tagPick`, any direction) → eliminations decide the round.
 * Countdown: frozen bodies, the first carrier already chosen and shown.
 */
export class BombTagGame {
  readonly physics: PlaygroundPhysics;
  readonly brawl: LayerBrawl;
  readonly round = new LayerRound(BOMB_TICKS);
  readonly bomb: BombRules;
  /** This step's bomb events. */
  readonly events: BombEvent[] = [];
  /** This step's blast (at most one: one bomb). */
  blast: BombBlast | null = null;
  /** This step's landed carrier punches that did not pass the bomb (HUD: "no tag-back"). */
  readonly refused: { from: PlayerId; to: PlayerId; why: PassRefusal }[] = [];
  /** This step's eliminations. */
  readonly eliminated: PlayerId[] = [];
  /** The slow traps. */
  readonly traps = new BombTraps(BOMB_TRAPS);
  /** This step's trap springs and reopened traps. */
  readonly sprung: TrapSpring[] = [];
  readonly rearmed: BombTrap[] = [];
  /** Passes by tag assist this round (diagnostics). */
  tags = 0;
  /** The punch a tag-back refusal was already reported for (once per swing). */
  private refusedPunch: object | null = null;
  players: 2 | 3;
  private active: PlayerId[];
  private spawnOf: number[] = PLAYERS.map(({ id }) => id);
  private readonly pending: FeedbackEvent[] = [];
  private readonly collect: FeedbackSink = (event) => this.pending.push(event);
  private readonly physicalFeedback: PhysicsFeedback;
  private readonly idle: MovementInput[] = PLAYERS.map(() => IDLE_INPUT);
  private readonly random: () => number;
  private countdownCue = 0;
  /** Server-only, one-step historical poses for conservative tag rewind. */
  tagRewind: readonly BombTagPose[] | null = null;

  constructor(
    private readonly feedback: FeedbackSink = silentFeedback,
    options: BombGameOptions = {}
  ) {
    this.players = options.players ?? 3;
    this.active = PLAYERS.filter(({ id }) => id < this.players).map(({ id }) => id);
    this.random = mulberry32(options.seed ?? Math.floor(Math.random() * 2 ** 32));
    this.physics = new PlaygroundPhysics(this.collect, BOMB_MAP);
    this.brawl = new LayerBrawl(this.physics, this.collect, BOMB_TAG.punch);
    this.physicalFeedback = new PhysicsFeedback(this.physics, this.collect);
    this.bomb = new BombRules(this.random);
    this.applySlots();
    this.bomb.start(this.active);
  }
  /** Slots in the match. */
  get slots(): PlayerId[] {
    return [...this.active];
  }
  private applySlots() {
    this.round.setActive(this.active);
    for (const character of this.physics.players) {
      if (!this.active.includes(character.id)) {
        retire(character);
        continue;
      }
      const at = bombSpawn(this.players, this.spawnOf[character.id]);
      restore(character, at, Math.atan2(-at.x, -at.z));
    }
  }
  /**
   * A fresh round from the countdown for these slots (2 or 3); `spawns[i]` is the spawn of
   * `slots[i]` among the ones for that player count (default: in order). Everyone else sits
   * the match out.
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
    this.brawl.reset();
    this.physicalFeedback.reset();
    this.physics.reset();
    this.countdownCue = 0;
    this.events.length = 0;
    this.blast = null;
    this.tags = 0;
    this.refusedPunch = null;
    this.traps.reset();
    this.sprung.length = this.rearmed.length = 0;
    this.applySlots();
    this.bomb.start(this.active);
  }

  step(inputs: readonly MovementInput[]): LayerRoundEvent {
    this.pending.length = 0;
    this.events.length = 0;
    this.refused.length = 0;
    this.eliminated.length = 0;
    this.sprung.length = this.rearmed.length = 0;
    this.blast = null;
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
    const bomb = this.bomb;
    if (round.tick === 0) this.record(bomb.light());
    const before = bomb.fuse;
    for (const e of bomb.tick(round.survivors)) this.record(e);
    if (bomb.phase === "armed") this.tickCue(before, bomb.fuse);
    this.stepTraps();
    const live = inputs.map((input, id) => (round.alive[id] ? input : IDLE_INPUT));
    const { inputs: effective, drives } = this.brawl.step(live, PHYSICS.step);
    const carrier = bomb.phase === "armed" ? bomb.carrier : null;
    // The lit bomb's carrier is a little faster (never while staggered); a trapped player slower.
    if (carrier !== null && !this.physics.players[carrier].eliminated && drives[carrier].mobility === 1) drives[carrier].mobility = BOMB_TAG.carrierSpeed;
    for (const id of this.active) drives[id].mobility *= this.traps.mobility(id);
    const fell = this.physics.step(effective, drives);
    this.brawl.afterStep();
    let passed = false;
    for (const shove of this.brawl.shoves) {
      if (shove.attacker !== bomb.carrier || bomb.phase !== "armed") continue;
      // A real hand contact passes it only under the assist's rules (range and geometry): an
      // arm reaching over a hop wall or round an AC unit's corner, up at someone on the
      // catwalk, or at someone farther than `tag.range`, still shoves (physics) but never
      // hands the bomb on.
      const a = this.physics.players[shove.attacker],
        b = this.physics.players[shove.target];
      if (horizontal(a, b) > BOMB_TAG.tag.range || !this.reachable(a, b)) continue;
      const survivors = round.survivors;
      const why = bomb.refusal(shove.attacker, shove.target, survivors),
        punch = this.brawl.fighters[shove.attacker].punch;
      if (why) {
        // Once per swing (the assist may already have reported it during the wind-up).
        if (this.refusedPunch !== punch) this.refused.push({ from: shove.attacker, to: shove.target, why });
        this.refusedPunch = punch;
      } else {
        this.record(this.withReach(bomb.pass(shove.attacker, shove.target, survivors), "punch"));
        passed = true;
      }
    }
    if (!passed && carrier !== null && bomb.carrier === carrier && !this.physics.players[carrier].eliminated)
      this.assist(carrier, inputs[carrier]?.punch ? this.tagRewind : null);
    this.tagRewind = null;
    this.physicalFeedback.afterStep(PHYSICS.step, this.pending);
    this.eliminated.push(...fell);
    // A carrier who left without a blast (a fall): the bomb moves on as after one.
    if (bomb.carrier !== null && fell.includes(bomb.carrier)) for (const e of bomb.drop(round.survivors.filter((id) => !fell.includes(id)))) this.record(e);
    const event = round.step(this.eliminated);
    if (event === "finished") {
      this.brawl.stop();
      this.collect({ name: round.winner === null ? "draw" : "winner" });
    }
    return event;
  }
  /**
   * The tag assist, while the carrier's punch swings and has not landed: the nearest valid
   * rival takes the bomb with the same shove and stagger as a landed punch, and the punch is
   * spent (its hand cannot shove again). A protected rival (tag-back) is reported once.
   */
  private assist(carrier: PlayerId, poses: readonly BombTagPose[] | null = null) {
    const fighter = this.brawl.fighters[carrier],
      punch = fighter.punch;
    if (punch.hit || punch.age < 0 || punch.age >= COMBAT.punch.startup + COMBAT.punch.active) return;
    const pick = this.tagPick(carrier, poses);
    if (pick.target === null) {
      if (pick.refused !== null && this.refusedPunch !== punch) {
        this.refusedPunch = punch;
        this.refused.push({ from: carrier, to: pick.refused, why: "tag-back" });
      }
      return;
    }
    const pass = this.bomb.pass(carrier, pick.target, this.round.survivors);
    if (!pass) return;
    punch.hit = true;
    this.tags++;
    const from = this.physics.players[carrier].body.translation(),
      victim = this.physics.players[pick.target],
      to = victim.body.translation(),
      d = Math.max(1e-6, Math.hypot(to.x - from.x, to.z - from.z)),
      p = this.brawl.tuning,
      target = this.brawl.fighters[pick.target];
    push(victim, { x: ((to.x - from.x) / d) * p.push, y: p.lift, z: ((to.z - from.z) / d) * p.push });
    if (target.stagger.time <= EPSILON) target.stagger = { ...p.stagger };
    target.flash = 0.15;
    this.collect({ name: "bodyHit", actor: carrier, target: pick.target, x: to.x, intensity: 0.6 });
    this.record(this.withReach(pass, "tag"));
  }
  /**
   * Who a punch by `from` (the lit bomb's carrier) would tag now: every other rival still in
   * that is within `tag.range` (horizontal, pelvis to pelvis) in any direction — no facing
   * rule — on a surface within `tag.surfaceStep` of its own and with pelvises within
   * `tag.heightGap`, with the pelvis and chest lines clear of the arena's colliders: the
   * nearest one the rules let take it. Cheap: distance first, rays only for a rival already
   * that close.
   */
  tagPick(from: PlayerId, poses: readonly BombTagPose[] | null = null): TagPick {
    const { range } = BOMB_TAG.tag,
      me = this.physics.players[from],
      p = poses?.[from]?.pelvis ?? me.body.translation(),
      survivors = this.round.survivors;
    let target: PlayerId | null = null,
      distance = Infinity,
      refused: PlayerId | null = null,
      refusedAt = Infinity;
    for (const other of this.physics.players) {
      if (other.id === from || other.eliminated || !this.round.alive[other.id]) continue;
      const q = poses?.[other.id]?.pelvis ?? other.body.translation(),
        d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d > range || !(poses ? this.reachablePose(poses[from], poses[other.id]) : this.reachable(me, other))) continue;
      if (this.bomb.refusal(from, other.id, survivors)) {
        if (d < refusedAt) {
          refused = other.id;
          refusedAt = d;
        }
      } else if (d < distance) {
        target = other.id;
        distance = d;
      }
    }
    return { target, refused: target === null ? refused : null, distance };
  }
  /**
   * The geometry rules a pass must meet, by assist or by hand contact: on surfaces within
   * `tag.surfaceStep` of each other (never floor ↔ catwalk or AC top), pelvises within
   * `tag.heightGap`, and the pelvis-to-pelvis and chest-to-chest lines both clear of every
   * static collider.
   */
  private reachable(a: Character, b: Character) {
    const { surfaceStep, heightGap } = BOMB_TAG.tag,
      p = a.body.translation(),
      q = b.body.translation();
    if (Math.abs(q.y - p.y) > heightGap) return false;
    if (Math.abs(surfaceBelow(q.x, q.z, q.y - 0.5) - surfaceBelow(p.x, p.z, p.y - 0.5)) > surfaceStep) return false;
    return this.physics.clearPath(p, q) && this.physics.clearPath(a.parts.torso.body.translation(), b.parts.torso.body.translation());
  }
  private reachablePose(a: BombTagPose | undefined, b: BombTagPose | undefined) {
    if (!a || !b) return false;
    const { surfaceStep, heightGap } = BOMB_TAG.tag,
      p = a.pelvis,
      q = b.pelvis;
    if (Math.abs(q.y - p.y) > heightGap) return false;
    if (Math.abs(surfaceBelow(q.x, q.z, q.y - 0.5) - surfaceBelow(p.x, p.z, p.y - 0.5)) > surfaceStep) return false;
    return this.physics.clearPath(p, q) && this.physics.clearPath(a.chest, b.chest);
  }
  private withReach(event: BombEvent | null, via: "punch" | "tag"): BombEvent | null {
    if (!event || event.type !== "pass") return event;
    return { ...event, via, reach: horizontal(this.physics.players[event.from], this.physics.players[event.to]) };
  }
  /**
   * The traps' tick (before the drives): reopenings, the slows, and springs by the feet of
   * everyone still in. A spring snaps (the Barn trap's sound) and takes `trap.slow`'s share of
   * the victim's horizontal speed at once, so the slow bites on the spot instead of easing in.
   */
  private stepTraps() {
    const { rearmed, sprung } = this.traps.tick(this.active, (id) =>
      this.round.alive[id] && !this.physics.players[id].eliminated ? feet(this.physics.players[id]) : null
    );
    this.rearmed.push(...rearmed);
    this.sprung.push(...sprung);
    for (const { trap, id } of sprung) {
      const victim = this.physics.players[id],
        v = victim.body.linvel(),
        k = 1 - BOMB_TAG.trap.slow;
      push(victim, { x: -v.x * k, y: 0, z: -v.z * k });
      this.collect({ name: "trapSnap", actor: id, x: trap.x, intensity: 1 });
    }
  }
  private record(event: BombEvent | null) {
    if (!event) return;
    this.events.push(event);
    if (event.type === "blast") this.explode(event.carrier);
    else if (event.type === "pass") this.collect({ name: "bombPass", actor: event.from, target: event.to, x: this.physics.players[event.to].body.translation().x });
    else if (event.type === "armed" && this.round.tick > 0) this.collect({ name: "roundStart" });
  }
  /** The carrier is out; everyone near is shoved away and staggered. */
  private explode(id: PlayerId) {
    const character = this.physics.players[id],
      at = { ...character.body.translation() },
      { radius, push: speed, lift, stagger } = BOMB_TAG.blast,
      shoved: PlayerId[] = [];
    retire(character);
    this.eliminated.push(id);
    for (const other of this.physics.players) {
      if (other.id === id || other.eliminated || !this.round.alive[other.id]) continue;
      const p = other.body.translation(),
        dx = p.x - at.x,
        dz = p.z - at.z,
        d = Math.hypot(dx, dz);
      if (d > radius || Math.abs(p.y - at.y) > radius) continue;
      // Straight away from the blast (a body exactly on it goes along its facing).
      const ux = d > 1e-3 ? dx / d : Math.sin(other.facing),
        uz = d > 1e-3 ? dz / d : Math.cos(other.facing),
        k = speed * (1 - (0.5 * d) / radius);
      push(other, { x: ux * k, y: lift, z: uz * k });
      const fighter = this.brawl.fighters[other.id];
      if (fighter.stagger.time < stagger.time) fighter.stagger = { ...stagger };
      shoved.push(other.id);
    }
    this.blast = { carrier: id, x: at.x, y: at.y, z: at.z, shoved };
    this.collect({ name: "bombBlast", actor: id, x: at.x, intensity: 1 });
  }
  /** A tick each second over the last 5 s, and each half second over the last 2 s. */
  private tickCue(before: number, after: number) {
    const mark = (fuse: number) => (fuse <= 120 ? Math.ceil(fuse / 30) : fuse <= 300 ? Math.ceil(fuse / 60) * 2 : 99);
    if (after > 0 && mark(after) !== mark(before) && after <= 300) this.collect({ name: "bombTick", step: Math.ceil(after / 60), intensity: after <= 120 ? 1 : 0.6 });
  }
  dispose() {
    this.brawl.stop();
    this.physicalFeedback.reset();
    this.physics.dispose();
  }
}
