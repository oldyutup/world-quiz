import { silentFeedback, type FeedbackEvent, type FeedbackSink } from "../../feedback/events.js";
import type { MovementInput } from "../../intent.js";
import { GIFT_MAP, giftSpawn, giftSpawnYaw, homeCenter, restingPoint } from "../../maps/gifts.js";
import { ranksByScore } from "../../board/rules.js";
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
import { GIFT, GIFT_TICKS, pileSize } from "./config.js";
import { reachAt, type GiftReach } from "./reach.js";

/**
 * What happened to a box this step:
 * - `pile`: `actor` took one from the middle pile; `loose`: picked one up off the floor (`box`);
 * - `steal`: took one from `owner`'s home; `deposit`: brought one home (auto, entering it);
 * - `knock`: `owner`'s punch knocked `actor`'s box off (`box` flies to x, z);
 * - `drop`: `actor` dropped theirs (disconnected or left; `box` falls at their feet);
 * - `home`: box `box` landed in `actor`'s home and counts there.
 */
export const GIFT_EVENT_KINDS = ["pile", "loose", "steal", "deposit", "knock", "drop", "home"] as const;
export type GiftEventKind = (typeof GIFT_EVENT_KINDS)[number];
export interface GiftEvent {
  id: number;
  /** Round tick it happened on. */
  tick: number;
  kind: GiftEventKind;
  actor: number;
  /** The other player involved (the robbed home's owner, the puncher), −1 for none. */
  owner: number;
  /** Where (m): the pile, the home, the landing point. */
  x: number;
  z: number;
  /** The box on the floor or in the air (−1 for none). */
  box: number;
}
/**
 * A box on the floor or in the air: it leaves (fx, fy, fz) on round tick `at` and rests at
 * (x, z) from tick `land`. Nobody can take it before it lands.
 */
export interface GiftBox {
  id: number;
  x: number;
  z: number;
  fx: number;
  fy: number;
  fz: number;
  at: number;
  land: number;
}
export interface GiftPose {
  pelvis: Vec;
  chest: Vec;
}
export interface GiftGameOptions {
  /** 2 or 3 players in the match (slots 0…n−1 until `begin`). */
  players?: 2 | 3;
  /** Seeds where knocked boxes fly. Same seed + inputs → same match. */
  seed?: number;
}
/** Timers count seconds in 1/60 steps; this absorbs the rounding. */
const EPSILON = 1e-9;
const horizontal = (a: Vec, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Hediye Kapmaca (Grifting Gifts): the shared ragdoll physics in the round yard
 * (maps/gifts.ts), Bomba Sende's shove punch, Katman Kaosu's round (here: 40 s, then the most
 * boxes at home wins). Deterministic for the same seed and inputs; the local arena drives it
 * with a human and bots, the online room (`GiftRoundSimulation`) with the players' inputs.
 *
 * One playing step (round tick t): boxes in the air land (in a home: that home's count) →
 * stun, guard and press timers → punches and drives (a carrier or a stunned player cannot
 * punch) → physics → punch contacts (a guarded player is untouchable; a carrier hit loses the
 * box and is stunned), then the carrier assist → presses take boxes (nearest wins a contest)
 * → carriers inside their own home put the box down → the clock decides the round.
 */
export class GiftGame {
  readonly physics: PlaygroundPhysics;
  readonly brawl: LayerBrawl;
  readonly round = new LayerRound(GIFT_TICKS);
  players: 2 | 3;
  /** Slots in seat order (seat = home). */
  seats: PlayerId[] = [];
  /** Seat of each slot (−1: not in the match). */
  readonly seatOf = PLAYERS.map(() => -1);
  /** Boxes left on the middle pile. */
  pile = 0;
  /** Round tick the pile ran out on (−1: not yet). */
  pileEmptyAt = -1;
  /** Boxes in each slot's home. */
  readonly home = PLAYERS.map(() => 0);
  readonly carrying = PLAYERS.map(() => false);
  /** Boxes on the floor or flying. */
  boxes: GiftBox[] = [];
  /** Ticks left: stunned (no walking, punching or taking), guarded (punches cannot touch), a Tut press waiting. */
  readonly stun = PLAYERS.map(() => 0);
  readonly guard = PLAYERS.map(() => 0);
  readonly want = PLAYERS.map(() => 0);
  /** Left the match for good (online). */
  readonly forfeited = PLAYERS.map(() => false);
  /** This step's box events, and the recent ones (`GIFT.eventWindow` ticks) for the wire. */
  readonly events: GiftEvent[] = [];
  readonly log: GiftEvent[] = [];
  /** Server-only: per attacker, the poses that player was looking at when the punch was pressed. */
  rewind: (readonly GiftPose[] | null)[] = PLAYERS.map(() => null);
  readonly stats = { knocks: 0, assists: 0, steals: 0, deposits: 0, pile: 0, loose: 0, landedHome: 0 };
  private nextBox = 0;
  private nextEvent = 0;
  private readonly staggered = PLAYERS.map(() => false);
  private readonly pending: FeedbackEvent[] = [];
  private readonly collect: FeedbackSink = (event) => this.pending.push(event);
  private readonly physicalFeedback: PhysicsFeedback;
  private readonly idle: MovementInput[] = PLAYERS.map(() => IDLE_INPUT);
  private readonly random: () => number;
  private countdownCue = 0;

  constructor(
    private readonly feedback: FeedbackSink = silentFeedback,
    options: GiftGameOptions = {}
  ) {
    this.players = options.players ?? 3;
    this.random = mulberry32(options.seed ?? Math.floor(Math.random() * 2 ** 32));
    this.physics = new PlaygroundPhysics(this.collect, GIFT_MAP);
    this.brawl = new LayerBrawl(this.physics, this.collect, GIFT.punch, (_attacker, target) => this.guard[target] > 0);
    this.physicalFeedback = new PhysicsFeedback(this.physics, this.collect);
    this.begin(PLAYERS.filter(({ id }) => id < this.players).map(({ id }) => id));
  }
  /** Home centre of a slot in the match. */
  homeOf(slot: number) {
    return homeCenter(this.players, Math.max(0, this.seatOf[slot]));
  }
  /** A fresh round from the countdown for these slots (2 or 3, seats in slot order); everyone else sits out. */
  begin(slots: readonly PlayerId[]) {
    this.seats = [...new Set(slots)].sort((a, b) => a - b);
    this.players = this.seats.length === 2 ? 2 : 3;
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
    this.round.setActive(this.seats);
    this.seatOf.fill(-1);
    this.seats.forEach((slot, seat) => (this.seatOf[slot] = seat));
    for (const character of this.physics.players) {
      const seat = this.seatOf[character.id];
      if (seat < 0) retire(character);
      else restore(character, giftSpawn(this.players, seat), giftSpawnYaw(this.players, seat));
    }
    this.pile = pileSize(this.players);
    this.pileEmptyAt = -1;
    this.home.fill(0);
    this.carrying.fill(false);
    this.boxes = [];
    this.stun.fill(0);
    this.guard.fill(0);
    this.want.fill(0);
    this.forfeited.fill(false);
    this.staggered.fill(false);
    this.events.length = 0;
    this.log.length = 0;
    this.rewind = PLAYERS.map(() => null);
    this.nextBox = this.nextEvent = 0;
    this.countdownCue = 0;
    for (const key of Object.keys(this.stats) as (keyof typeof this.stats)[]) this.stats[key] = 0;
  }
  /** Pelvis position of a slot (bots). */
  position(slot: number) {
    return this.physics.players[slot].body.translation();
  }
  /** Horizontal pelvis velocity of a slot (bots). */
  velocity(slot: number) {
    const v = this.physics.players[slot].body.linvel();
    return { x: v.x, z: v.z };
  }
  /** Still playing: in the match, not left, body in the world. */
  playing(slot: number) {
    return this.seatOf[slot] >= 0 && this.round.alive[slot] && !this.forfeited[slot] && !this.physics.players[slot].eliminated;
  }

  step(inputs: readonly MovementInput[]): LayerRoundEvent {
    this.pending.length = 0;
    this.events.length = 0;
    const event = this.advance(inputs);
    this.rewind = PLAYERS.map(() => null);
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
    this.land(t);
    this.timers();
    const live = PLAYERS.map(({ id }) => {
      const input = inputs[id] ?? IDLE_INPUT;
      if (!this.playing(id)) return IDLE_INPUT;
      // Stunned: no walking, jumping, punching or taking.
      if (this.stun[id] > 0) return IDLE_INPUT;
      if (input.pickup && !this.carrying[id]) this.want[id] = GIFT_TICKS.pressBuffer;
      // No sprint in this mode; a carrier cannot punch.
      return { x: input.x, z: input.z, jump: input.jump, punch: !!input.punch && !this.carrying[id], sprint: false };
    });
    const { inputs: effective, drives } = this.brawl.step(live, PHYSICS.step);
    const fell = this.physics.step(effective, drives);
    this.brawl.afterStep();
    for (const shove of this.brawl.shoves) if (this.carrying[shove.target]) this.knock(shove.attacker, shove.target, t);
    for (const id of this.seats) this.assist(id, live[id].punch ? this.rewind[id] : null, t);
    this.pickups(t);
    this.deposits(t);
    if (this.pile === 0 && this.pileEmptyAt < 0) this.pileEmptyAt = t;
    this.physicalFeedback.afterStep(PHYSICS.step, this.pending);
    // Recent events only (the wire's window).
    while (this.log.length && this.log[0].tick < t - GIFT.eventWindow) this.log.shift();
    const event = round.step(fell);
    if (event === "finished") {
      if (round.reason === "timeout") round.winner = this.leader();
      this.brawl.stop();
      this.collect({ name: round.winner === null ? "draw" : "winner" });
    }
    return event;
  }
  /** The single player still in with the most boxes at home, or null on a tie for the most. */
  leader(): PlayerId | null {
    const contenders = this.seats.filter((id) => !this.forfeited[id]);
    if (!contenders.length) return null;
    const best = Math.max(...contenders.map((id) => this.home[id])),
      top = contenders.filter((id) => this.home[id] === best);
    return top.length === 1 ? top[0] : null;
  }
  /**
   * Places per slot (0 best, ties share): by boxes at home; a player who left is below
   * everyone still in; −1 for slots not in the match.
   */
  placements(): number[] {
    return ranksByScore(PLAYERS.map(({ id }) => (this.seatOf[id] < 0 ? null : this.forfeited[id] ? -1 : this.home[id])));
  }
  private timers() {
    for (const id of this.seats) {
      if (this.want[id] > 0) this.want[id]--;
      if (this.guard[id] > 0) this.guard[id]--;
      const fighter = this.brawl.fighters[id];
      if (this.stun[id] > 0 && --this.stun[id] === 0) {
        // The stun ends: guarded for a while, so nobody can knock them straight back down.
        fighter.stagger.time = 0;
        this.guard[id] = Math.max(this.guard[id], GIFT_TICKS.stunGuard);
      }
      const staggered = fighter.stagger.time > EPSILON;
      if (this.staggered[id] && !staggered && this.stun[id] === 0) this.guard[id] = Math.max(this.guard[id], GIFT_TICKS.staggerGuard);
      this.staggered[id] = staggered;
    }
  }
  private record(kind: GiftEventKind, tick: number, actor: number, owner: number, x: number, z: number, box = -1) {
    const event: GiftEvent = { id: this.nextEvent++, tick, kind, actor, owner, x, z, box };
    this.events.push(event);
    this.log.push(event);
    return event;
  }
  /** Boxes landing this tick: inside a home they count there, elsewhere they lie on the floor. */
  private land(t: number) {
    for (const box of [...this.boxes]) {
      if (box.land !== t) continue;
      const owner = this.seats.find((id) => horizontal({ x: box.x, y: 0, z: box.z }, this.homeOf(id)) <= GIFT.homes.radius);
      if (owner === undefined) continue;
      this.boxes.splice(this.boxes.indexOf(box), 1);
      this.home[owner]++;
      this.stats.landedHome++;
      this.record("home", t, owner, -1, box.x, box.z, box.id);
    }
  }
  /** `victim`'s box leaves their hands: knocked along `toward` (a punch) or dropped at their feet. */
  private launch(victim: PlayerId, t: number, toward: { x: number; z: number } | null) {
    const body = this.physics.players[victim],
      p = body.body.translation(),
      head = body.parts.head.body.translation();
    let at = { x: p.x, z: p.z },
      flight = GIFT_TICKS.dropFlight;
    if (toward) {
      const angle = Math.atan2(toward.x, toward.z) + (this.random() * 2 - 1) * GIFT.drop.spread,
        [near, far] = GIFT.drop.distance,
        distance = near + (far - near) * this.random();
      at = { x: p.x + Math.sin(angle) * distance, z: p.z + Math.cos(angle) * distance };
      flight = GIFT_TICKS.flight;
    }
    const rest = restingPoint(at.x, at.z),
      box: GiftBox = { id: this.nextBox++, x: rest.x, z: rest.z, fx: p.x, fy: head.y + 0.35, fz: p.z, at: t, land: t + flight };
    this.boxes.push(box);
    this.carrying[victim] = false;
    return box;
  }
  /** A punch landed on a carrier: the box flies off along the hit and the carrier is stunned. */
  private knock(attacker: PlayerId, victim: PlayerId, t: number) {
    const a = this.physics.players[attacker].body.translation(),
      v = this.physics.players[victim].body.translation(),
      d = Math.hypot(v.x - a.x, v.z - a.z),
      facing = this.physics.players[attacker].facing,
      dir = d > 1e-3 ? { x: (v.x - a.x) / d, z: (v.z - a.z) / d } : { x: Math.sin(facing), z: Math.cos(facing) };
    const box = this.launch(victim, t, dir);
    const fighter = this.brawl.fighters[victim];
    fighter.stagger = { time: GIFT.stun.time, posture: GIFT.stun.posture, mobility: GIFT.stun.mobility };
    fighter.punch.age = -1;
    this.stun[victim] = GIFT_TICKS.stun;
    this.staggered[victim] = true;
    this.want[victim] = 0;
    this.stats.knocks++;
    this.record("knock", t, victim, attacker, box.x, box.z, box.id);
  }
  /**
   * The carrier assist: while `id`'s punch swings and has not landed, the nearest unguarded
   * carrier within `assist.range` (any direction, same footing, clear sight lines) is hit as by
   * a landed punch, and the punch is spent. `poses`: the view the puncher pressed it on.
   */
  private assist(id: PlayerId, poses: readonly GiftPose[] | null, t: number) {
    if (!this.playing(id) || this.carrying[id] || this.stun[id] > 0) return;
    const fighter = this.brawl.fighters[id],
      punch = fighter.punch;
    if (punch.hit || punch.age < 0 || punch.age >= COMBAT.punch.startup + COMBAT.punch.active) return;
    const target = this.assistPick(id, poses);
    if (target === null) return;
    punch.hit = true;
    const from = this.physics.players[id].body.translation(),
      victim = this.physics.players[target],
      to = victim.body.translation(),
      d = Math.max(1e-6, Math.hypot(to.x - from.x, to.z - from.z)),
      p = GIFT.punch;
    push(victim, { x: ((to.x - from.x) / d) * p.push, y: p.lift, z: ((to.z - from.z) / d) * p.push });
    this.brawl.fighters[target].flash = 0.15;
    this.collect({ name: "bodyHit", actor: id, target, x: to.x, intensity: 0.6 });
    this.stats.assists++;
    this.knock(id, target, t);
  }
  /** Who `from`'s swinging punch would knock the box off now (the nearest valid carrier), or null. */
  assistPick(from: PlayerId, poses: readonly GiftPose[] | null = null): PlayerId | null {
    const me = this.physics.players[from],
      p = poses?.[from]?.pelvis ?? me.body.translation();
    let best: PlayerId | null = null,
      distance = Infinity;
    for (const id of this.seats) {
      if (id === from || !this.carrying[id] || this.guard[id] > 0 || !this.playing(id)) continue;
      const other = this.physics.players[id],
        q = poses?.[id]?.pelvis ?? other.body.translation(),
        d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d > GIFT.assist.range || d >= distance) continue;
      if (!(poses ? this.reachablePose(poses[from], poses[id]) : this.reachable(me, other))) continue;
      best = id;
      distance = d;
    }
    return best;
  }
  private reachable(a: Character, b: Character) {
    const p = a.body.translation(),
      q = b.body.translation();
    if (Math.abs(q.y - p.y) > GIFT.assist.heightGap) return false;
    return this.physics.clearPath(p, q) && this.physics.clearPath(a.parts.torso.body.translation(), b.parts.torso.body.translation());
  }
  private reachablePose(a: GiftPose | undefined, b: GiftPose | undefined) {
    if (!a || !b) return false;
    if (Math.abs(b.pelvis.y - a.pelvis.y) > GIFT.assist.heightGap) return false;
    return this.physics.clearPath(a.pelvis, b.pelvis) && this.physics.clearPath(a.chest, b.chest);
  }
  /**
   * What a waiting press of `id` reaches now, nearest first: a box on the floor within
   * `reach.loose`, else the pile (within `reach.pile` of the stand), else a rival's home it
   * stands in (one with boxes). Never its own home.
   */
  reachOf(id: PlayerId, t = this.round.tick): GiftReach | null {
    return reachAt(this.physics.players[id].body.translation(), id, this, t);
  }
  /**
   * Waiting presses take boxes. Everyone's reach is worked out on the same positions; when
   * more want one thing than it has (a floor box, the pile's last ones, a home's last ones),
   * the nearest wins, then the lower slot. A loser's press keeps waiting.
   */
  private pickups(t: number) {
    const claims: { id: PlayerId; kind: "loose" | "pile" | "steal"; target: number; distance: number }[] = [];
    for (const id of this.seats) {
      if (this.want[id] <= 0 || this.carrying[id] || this.stun[id] > 0 || !this.playing(id)) continue;
      const reach = this.reachOf(id, t);
      if (reach) claims.push({ id, ...reach });
    }
    claims.sort((a, b) => a.distance - b.distance || a.id - b.id);
    for (const claim of claims) {
      const { id, kind, target } = claim;
      if (kind === "loose") {
        const index = this.boxes.findIndex((box) => box.id === target);
        if (index < 0) continue;
        const [box] = this.boxes.splice(index, 1);
        this.stats.loose++;
        this.record("loose", t, id, -1, box.x, box.z, box.id);
      } else if (kind === "pile") {
        if (this.pile <= 0) continue;
        this.pile--;
        this.stats.pile++;
        this.record("pile", t, id, -1, 0, 0);
      } else {
        if (this.home[target] <= 0) continue;
        this.home[target]--;
        this.stats.steals++;
        const at = this.homeOf(target);
        this.record("steal", t, id, target, at.x, at.z);
      }
      this.carrying[id] = true;
      this.want[id] = 0;
    }
  }
  /** A carrier inside its own home puts the box down there at once. */
  private deposits(t: number) {
    for (const id of this.seats) {
      if (!this.carrying[id] || !this.playing(id)) continue;
      const home = this.homeOf(id);
      if (horizontal(this.physics.players[id].body.translation(), home) > GIFT.homes.radius) continue;
      this.carrying[id] = false;
      this.home[id]++;
      this.stats.deposits++;
      this.record("deposit", t, id, -1, home.x, home.z);
    }
  }
  /** Disconnected: the box falls at their feet and any waiting press is forgotten. */
  neutralize(slot: PlayerId) {
    this.want[slot] = 0;
    this.brawl.fighters[slot].punch.age = -1;
    if (this.round.phase === "playing" && this.carrying[slot]) {
      const box = this.launch(slot, this.round.tick, null);
      this.record("drop", this.round.tick, slot, -1, box.x, box.z, box.id);
    }
  }
  /** Left for good: the box falls, the body leaves the yard; one player left wins at once. */
  forfeit(slot: PlayerId) {
    if (this.seatOf[slot] < 0 || this.forfeited[slot]) return;
    this.neutralize(slot);
    this.carrying[slot] = false;
    this.forfeited[slot] = true;
    retire(this.physics.players[slot]);
    if (this.round.phase === "playing" && this.round.alive[slot]) {
      this.round.alive[slot] = false;
      this.round.outAt[slot] = this.round.tick;
    }
  }
  /** Boxes accounted for: the pile, the homes, the hands, the floor and the air (always the start's count). */
  total() {
    return this.pile + this.seats.reduce<number>((n, id) => n + this.home[id] + (this.carrying[id] ? 1 : 0), 0) + this.boxes.length;
  }
  dispose() {
    this.brawl.stop();
    this.physicalFeedback.reset();
    this.physics.dispose();
  }
}
