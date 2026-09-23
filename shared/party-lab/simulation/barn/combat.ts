import { hitSound, silentFeedback, type FeedbackSink } from "../../feedback/events.js";
import type { MovementInput } from "../../intent.js";
import { SPAWN_CANDIDATES, SPAWN_LIFT, START_SPAWNS, TRAPS, WEAPON_SPOTS, type BarnSpawnId } from "../../maps/barn.js";
import { COMBAT } from "../combatConfig.js";
import { activePunch, newPunch, punchArmDrive, punchPower, tickPunch, type Punch } from "../combat/punch.js";
import { IDLE_INPUT, type PlaygroundPhysics } from "../physics.js";
import { PLAYERS, type PlayerId } from "../players.js";
import { connect, restore, type Character } from "../ragdoll/character.js";
import { HAND_PARTS, HANDS, PARTS, SHAPES, type Hand, type PartName } from "../ragdoll/config.js";
import { normalDrive, type ArmDrive, type CharacterDrive } from "../ragdoll/controller.js";
import { add, clamp, dot, rotate, sub, unit, yaw, type Vec } from "../ragdoll/math.js";
import { BARN_COMBAT } from "./config.js";
import { Hitscan } from "./hitscan.js";
import { PickupDirector, type ActivePickup } from "./pickups.js";
import type { HistoricView } from "./rewind.js";
import { createTraps, feet, resetTraps, spring, tickTraps, trapUnder, type TrapState } from "./traps.js";
import {
  currentSpread,
  falloff,
  newWeapon,
  shotDamage,
  shotDirections,
  tickWeapon,
  tryFire,
  weaponRange,
  type HeldWeapon,
  type WeaponKind,
} from "./weapons.js";

/**
 * Barn Shootout combat (local V1): health, disposable weapons, hitscan, unarmed
 * punches, bear traps, death and respawn, weapon pickups. Written as simulation
 * state driven only by per-step `MovementInput` intent, so the room server can run
 * this same class later; the local mode calls it directly. Rooftop combat
 * (CombatSimulation) is neither used nor changed.
 *
 * Per fixed step: `step()` (timers, respawns, traps, pickups, shots — before physics,
 * against the poses the players saw) returns the effective inputs and drives for
 * `PlaygroundPhysics.step`; `afterStep()` resolves punch contacts from the physical
 * arm, as on the rooftop.
 */
export interface BarnSpawnPoint {
  readonly id: BarnSpawnId;
  /** Floor point stood on. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}
export interface BarnFighter {
  readonly id: PlayerId;
  hp: number;
  alive: boolean;
  weapon: HeldWeapon | null;
  /** Seconds since death (dead only). */
  deadFor: number;
  /** Seconds of spawn protection left: no damage, no traps. */
  protection: number;
  /** Seconds left in a bear trap. */
  trapped: number;
  stagger: { time: number; posture: number; mobility: number };
  punch: Punch;
  punchHand: Hand;
  punchCooldown: number;
  /** Seconds of hit flash left (presentation). */
  flash: number;
  /** Last aim pitch (presentation of the held weapon). */
  aimPitch: number;
  /** Where this fighter last (re)spawned; local dummies hold this spot. */
  home: BarnSpawnPoint;
  kills: number;
  deaths: number;
  /** Not in this match (an empty online slot, or a player who left): never spawns, never a target. */
  inactive: boolean;
  /** Last other player to damage this fighter, and when (combat clock): credit for trap/environment deaths. */
  lastHitBy: PlayerId | null;
  lastHitAt: number;
  /** Increments on every respawn (lag compensation never blends poses across lives). */
  life: number;
}
export interface BarnPellet {
  /** Where the pellet/round stopped (surface hit or end of range). */
  end: Vec;
  /** Character struck, if any. */
  target: PlayerId | null;
  /** Static geometry stopped it. */
  blocked: boolean;
}
export interface BarnShot {
  shooter: PlayerId;
  kind: WeaponKind;
  origin: Vec;
  /** Where the crosshair line met something. */
  aimPoint: Vec;
  pellets: BarnPellet[];
}
export type BarnDamageSource = WeaponKind | "punch" | "trap";
export interface BarnHit {
  source: BarnDamageSource;
  attacker: PlayerId | null;
  target: PlayerId;
  damage: number;
  /** Target HP after the hit. */
  hp: number;
  killed: boolean;
  point: Vec;
  /** Shotgun: pellets that landed. */
  pellets?: number;
}
export type BarnNotice =
  | { type: "pickup"; id: PlayerId; kind: WeaponKind; spot: string; replaced: WeaponKind | null }
  | { type: "empty"; id: PlayerId; kind: WeaponKind }
  | { type: "appear"; spot: string; kind: WeaponKind }
  | { type: "trap"; id: PlayerId; trap: string }
  | { type: "rearm"; trap: string }
  | { type: "death"; id: PlayerId; by: PlayerId | null }
  | { type: "respawn"; id: PlayerId; spawn: BarnSpawnId };

const spawnPoint = (id: BarnSpawnId): BarnSpawnPoint => ({ id, ...SPAWN_CANDIDATES[id] });
export const REST_ARM: ArmDrive = { shoulder: -0.25, elbow: -0.35 };
const LIMP_ARM: ArmDrive = { shoulder: 0, elbow: 0 };
const CHEST = 0.55;
/**
 * The hand that holds a weapon: hand 0 sits at body-local −x, which is the chase
 * camera's right (its shoulder side) — the rig's left/right part names are mirrored
 * relative to that view.
 */
export const GUN_HAND: Hand = 0;
const finiteNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
/** Weapon code on the wire and in event detail: 1 shotgun, 2 SMG (0 unarmed). */
export const weaponCode = (kind: WeaponKind) => (kind === "shotgun" ? 1 : 2);
const cm = (n: number) => Math.round(n * 100);

export function freshFighter(id: PlayerId, home: BarnSpawnPoint, protection = 0): BarnFighter {
  return {
    id,
    hp: BARN_COMBAT.health,
    alive: true,
    weapon: null,
    deadFor: 0,
    protection,
    trapped: 0,
    stagger: { time: 0, posture: 1, mobility: 1 },
    punch: newPunch(),
    punchHand: 1,
    punchCooldown: 0,
    flash: 0,
    aimPitch: 0,
    home,
    kills: 0,
    deaths: 0,
    inactive: false,
    lastHitBy: null,
    lastHitAt: -Infinity,
    life: 0,
  };
}

/**
 * Per-step timers of a living fighter. Shared by the authority and the client's
 * prediction rig (which runs it for its own fighter only), so both count down the
 * same protection, trap hold, stagger, punch and weapon cadence.
 */
export function tickFighter(f: BarnFighter, dt: number, attackHeld: boolean) {
  f.protection = Math.max(0, f.protection - dt);
  f.trapped = Math.max(0, f.trapped - dt);
  f.stagger.time = Math.max(0, f.stagger.time - dt);
  f.punchCooldown = Math.max(0, f.punchCooldown - dt);
  tickPunch(f.punch, dt);
  if (f.weapon) tickWeapon(f.weapon, dt, attackHeld);
}

export type BarnAttack =
  | { kind: "fire"; weapon: WeaponKind; spread: number; emptied: boolean }
  | { kind: "punch" }
  | null;
/**
 * The attack this step's intent starts, with its bookkeeping only (ammo, cadence,
 * punch timing, protection) — no physics, no hit. Armed: fire when the weapon allows
 * (the last round removes the weapon). Unarmed: a punch every `punch.cooldown`,
 * alternating hands. Shared with the prediction rig (its own fighter only).
 */
export function startAttack(f: BarnFighter, input: MovementInput): BarnAttack {
  if (finiteNumber(input.aimPitch)) f.aimPitch = clamp(input.aimPitch, -1.2, 1.2);
  const pressed = !!input.attack,
    held = !!input.attackHeld,
    weapon = f.weapon;
  if (weapon) {
    const spread = currentSpread(weapon);
    if (!tryFire(weapon, pressed, held)) return null;
    f.protection = 0;
    const emptied = weapon.ammo <= 0;
    if (emptied) f.weapon = null;
    return { kind: "fire", weapon: weapon.kind, spread, emptied };
  }
  if (pressed && f.punchCooldown <= 1e-9) {
    f.punch = newPunch();
    f.punch.age = 0;
    f.punchHand = f.punchHand === 0 ? 1 : 0;
    f.punchCooldown = BARN_COMBAT.punch.cooldown;
    f.protection = 0;
    return { kind: "punch" };
  }
  return null;
}

/**
 * Two-handed hold, raised or lowered with the aim. The gun hand is the one on the
 * chase camera's side (`GUN_HAND`), out past the torso's edge so the weapon reads
 * beside the body instead of hiding behind it; the other hand supports the barrel.
 */
function holdArms(character: Character, pitch: number): [ArmDrive, ArmDrive] {
  const q = yaw(character.facing),
    p = character.body.translation(),
    lift = clamp(-Math.sin(pitch) * 0.45, -0.3, 0.3),
    side = GUN_HAND === 0 ? -1 : 1;
  const gun: ArmDrive = { shoulder: -1.1, elbow: -0.4, target: add(p, rotate(q, { x: side * 0.52, y: 0.28 + lift, z: 0.34 })), force: 30 },
    support: ArmDrive = { shoulder: -1.1, elbow: -0.6, target: add(p, rotate(q, { x: side * 0.18, y: 0.3 + lift, z: 0.64 })), force: 26 };
  return GUN_HAND === 0 ? [gun, support] : [support, gun];
}
/**
 * A fighter's drive for this step and the input the body actually gets: dead is the
 * only full ragdoll; stagger lowers posture/mobility; a trap stops walking, sprinting
 * and jumping (aim and attacks still work); arms hold the weapon or throw the punch.
 * Standing still holds position (`anchor`). Shared with the prediction rig.
 */
export function fighterDrive(f: BarnFighter, character: Character, input: MovementInput, drive: CharacterDrive): MovementInput {
  if (!f.alive) {
    // Death is the only full ragdoll: no balance, locomotion or arm motors.
    drive.posture = drive.mobility = 0;
    drive.jump = false;
    drive.anchor = false;
    drive.arms = [LIMP_ARM, LIMP_ARM];
    return IDLE_INPUT;
  }
  const staggered = f.stagger.time > 0;
  drive.posture = staggered ? f.stagger.posture : 1;
  drive.mobility = staggered ? f.stagger.mobility : 1;
  drive.jump = f.trapped <= 0 && !staggered;
  drive.anchor = true;
  if (f.weapon) drive.arms = holdArms(character, f.aimPitch);
  else {
    const strike = punchArmDrive(character, f.punchHand, f.punch);
    drive.arms = HANDS.map((hand) => (strike && hand === f.punchHand ? strike : REST_ARM)) as [ArmDrive, ArmDrive];
  }
  // In a trap: no walking, sprinting or jumping; the aim (facing) and attacks still work.
  return f.trapped > 0 ? { ...input, x: 0, z: 0, jump: false, sprint: false } : input;
}

export interface BarnCombatOptions {
  /** Weapons on the map at once (3 for the three-character local test; online: one per player). */
  activePickups?: number;
}

export class BarnCombat {
  readonly fighters: BarnFighter[];
  readonly drives = PLAYERS.map(normalDrive);
  /** Effective per-step inputs (dead: idle; trapped: no walking/jumping). */
  readonly inputs: MovementInput[] = PLAYERS.map(() => IDLE_INPUT);
  readonly pickups: PickupDirector;
  readonly traps: TrapState[] = createTraps(TRAPS);
  readonly hitscan: Hitscan;
  /** This step's shots, hits and state changes (presentation reads them after each step). */
  readonly shots: BarnShot[] = [];
  readonly hits: BarnHit[] = [];
  readonly notices: BarnNotice[] = [];
  readonly stats = { shots: 0, pellets: 0, hits: 0, punches: 0, punchHits: 0, kills: 0, traps: 0, pickups: 0, contested: 0 };
  /**
   * Server lag compensation: the historical poses a shot with this `viewTick` is
   * resolved against (null: current poses). Unset locally.
   */
  rewind: ((viewTick: number | undefined) => HistoricView | null) | null = null;
  /** Combat clock (seconds of play), for the kill-credit window. */
  time = 0;
  private activePickups: number;

  constructor(
    readonly physics: PlaygroundPhysics,
    private readonly feedback: FeedbackSink = silentFeedback,
    private readonly random: () => number = Math.random,
    options: BarnCombatOptions = {}
  ) {
    if (physics.map.id !== "barn") throw new Error("BarnCombat needs the barn map");
    this.activePickups = options.activePickups ?? BARN_COMBAT.pickups.active;
    this.fighters = PLAYERS.map(({ id }) => freshFighter(id, spawnPoint(START_SPAWNS[id])));
    this.hitscan = new Hitscan(physics, (id) => this.fighters[id].alive);
    this.pickups = new PickupDirector(
      Object.entries(WEAPON_SPOTS).map(([id, p]) => ({ id, ...p })),
      random
    );
    this.pickups.reset(this.living(), this.activePickups);
  }

  /**
   * Round start: every slot in `slots` (default: all) on its start spawn (the caller
   * resets the bodies), fresh pickups and traps. Other slots sit the match out.
   */
  reset(slots: readonly PlayerId[] = PLAYERS.map((p) => p.id), activePickups = this.activePickups) {
    this.activePickups = activePickups;
    this.time = 0;
    PLAYERS.forEach(({ id }, i) => {
      this.fighters[i] = freshFighter(id, spawnPoint(START_SPAWNS[id]));
      if (!slots.includes(id)) this.retire(this.fighters[i]);
      this.drives[i] = normalDrive();
      this.inputs[i] = IDLE_INPUT;
    });
    resetTraps(this.traps);
    this.pickups.reset(this.living(), activePickups);
    this.shots.length = this.hits.length = this.notices.length = 0;
  }
  /** Out of the match for good (left the room): no body, no respawn, never a target. Scores stay. */
  retire(f: BarnFighter) {
    f.inactive = true;
    f.alive = false;
    f.weapon = null;
    f.trapped = f.protection = f.punchCooldown = 0;
    f.stagger.time = 0;
    f.punch.age = -1;
  }
  /** Pelvis positions of living characters, optionally without one. */
  private living(except?: PlayerId): Vec[] {
    return this.fighters.filter((f) => f.alive && f.id !== except).map((f) => ({ ...this.physics.players[f.id].body.translation() }));
  }

  step(inputs: readonly MovementInput[], dt: number) {
    this.shots.length = this.hits.length = this.notices.length = 0;
    this.time += dt;
    for (const f of this.fighters) {
      if (f.inactive) continue;
      f.flash = Math.max(0, f.flash - dt);
      if (!f.alive) {
        f.deadFor += dt;
        if (f.deadFor >= BARN_COMBAT.death.respawn) this.respawn(f);
        continue;
      }
      tickFighter(f, dt, !!inputs[f.id]?.attackHeld);
    }
    this.stepTraps(dt);
    this.stepPickups(inputs, dt);
    for (const f of this.fighters) if (f.alive) this.attack(f, inputs[f.id] ?? IDLE_INPUT);
    for (const f of this.fighters) this.inputs[f.id] = fighterDrive(f, this.physics.players[f.id], inputs[f.id] ?? IDLE_INPUT, this.drives[f.id]);
    return { inputs: this.inputs, drives: this.drives };
  }

  // ─── Traps ────────────────────────────────────────────────────────────────

  private stepTraps(dt: number) {
    for (const t of tickTraps(this.traps, dt)) this.notices.push({ type: "rearm", trap: t.id });
    for (const f of this.fighters) {
      if (!f.alive || f.protection > 0 || f.trapped > 0) continue;
      const character = this.physics.players[f.id],
        trap = trapUnder(this.traps, feet(character));
      if (!trap) continue;
      spring(trap);
      this.stats.traps++;
      f.trapped = BARN_COMBAT.trap.hold;
      // The jaws stop a runner where the trap is instead of letting them slide past it.
      const v = character.body.linvel();
      this.push(character, { x: -v.x * BARN_COMBAT.trap.stop, y: 0, z: -v.z * BARN_COMBAT.trap.stop });
      this.stagger(f, BARN_COMBAT.trap.stagger);
      const hp = Math.max(0, f.hp - BARN_COMBAT.trap.damage);
      this.feedback({ name: "trapSnap", actor: f.id, x: trap.x, intensity: 1, barn: { damage: f.hp - hp, hp, killed: hp <= 0, point: [cm(trap.x), cm(trap.y), cm(trap.z)] } });
      this.notices.push({ type: "trap", id: f.id, trap: trap.id });
      this.damage(f, BARN_COMBAT.trap.damage, { source: "trap", attacker: null, point: { x: trap.x, y: trap.y, z: trap.z } });
    }
  }

  // ─── Pickups ──────────────────────────────────────────────────────────────

  private stepPickups(inputs: readonly MovementInput[], dt: number) {
    for (const p of this.pickups.tick(dt, this.living())) this.notices.push({ type: "appear", spot: p.spot, kind: p.kind });
    // Requests in the same step for the same weapon: the nearest player takes it (an
    // exact tie is decided at random), never whoever has the lower slot number.
    const requests: { f: BarnFighter; pickup: ActivePickup; distance: number; order: number }[] = [];
    for (const f of this.fighters) {
      if (!f.alive || !inputs[f.id]?.pickup) continue;
      const at = this.physics.players[f.id].body.translation(),
        pickup = this.pickups.nearest(at);
      if (!pickup) continue;
      const spot = this.pickups.spot(pickup.spot);
      requests.push({ f, pickup, distance: Math.hypot(at.x - spot.x, at.z - spot.z), order: 0 });
    }
    if (requests.length > 1) {
      if (new Set(requests.map((r) => r.pickup)).size < requests.length) this.stats.contested++;
      for (const r of requests) r.order = this.random();
      requests.sort((a, b) => a.distance - b.distance || a.order - b.order);
    }
    for (const r of requests) this.equip(r.f, r.pickup);
  }
  /** Unarmed: equip. Armed: swap — the old weapon is destroyed, never dropped. */
  equip(f: BarnFighter, pickup: ActivePickup) {
    if (!f.alive || !this.pickups.take(pickup)) return false;
    const replaced = f.weapon?.kind ?? null;
    f.weapon = newWeapon(pickup.kind);
    f.protection = 0;
    f.punch.age = -1;
    this.stats.pickups++;
    this.feedback({ name: "weaponPickup", actor: f.id, x: this.physics.players[f.id].body.translation().x });
    this.notices.push({ type: "pickup", id: f.id, kind: pickup.kind, spot: pickup.spot, replaced });
    return true;
  }

  // ─── Attacks ──────────────────────────────────────────────────────────────

  private attack(f: BarnFighter, input: MovementInput) {
    const attack = startAttack(f, input);
    if (!attack) return;
    const x = this.physics.players[f.id].body.translation().x;
    if (attack.kind === "punch") {
      this.stats.punches++;
      this.feedback({ name: "punchSwing", actor: f.id, x });
      return;
    }
    this.fire(f, attack.weapon, attack.spread, input);
    if (attack.emptied) {
      this.feedback({ name: "weaponEmpty", actor: f.id, x });
      this.notices.push({ type: "empty", id: f.id, kind: attack.weapon });
    }
  }

  private fire(f: BarnFighter, kind: WeaponKind, spread: number, input: MovementInput) {
    const character = this.physics.players[f.id],
      aimYaw = finiteNumber(input.facing) ? input.facing : character.facing;
    const view = this.rewind?.(input.viewTick) ?? null;
    const aim = this.hitscan.aim(character, aimYaw, f.aimPitch, input.aimEye, view);
    const range = weaponRange(kind);
    const shot: BarnShot = { shooter: f.id, kind, origin: aim.origin, aimPoint: aim.point, pellets: [] };
    const landed = new Map<PlayerId, { damage: number; power: number; pellets: number; push: Vec; point: Vec }>();
    for (const direction of shotDirections(kind, aim.direction, spread, this.random)) {
      const hit = this.hitscan.cast(aim.origin, direction, range, f.id, view);
      const end = hit?.point ?? add(aim.origin, { x: direction.x * range, y: direction.y * range, z: direction.z * range });
      shot.pellets.push({ end, target: hit?.target?.id ?? null, blocked: !!hit && !hit.target });
      this.stats.pellets++;
      if (!hit?.target) continue;
      const damage = shotDamage(kind, hit.distance);
      if (damage <= 0) continue;
      const entry = landed.get(hit.target.id) ?? { damage: 0, power: 0, pellets: 0, push: { x: 0, y: 0, z: 0 }, point: hit.point };
      entry.damage += damage;
      entry.power += falloff(kind, hit.distance);
      entry.pellets++;
      entry.push = add(entry.push, direction);
      landed.set(hit.target.id, entry);
      // SMG: a small push at the struck part — a wobble, never enough to topple.
      if (kind === "smg" && this.fighters[hit.target.id].protection <= 0)
        this.physics.players[hit.target.id].parts[hit.target.part].body.applyImpulseAtPoint(
          { x: direction.x * BARN_COMBAT.smg.partImpulse, y: 0, z: direction.z * BARN_COMBAT.smg.partImpulse },
          hit.point,
          true
        );
    }
    this.shots.push(shot);
    this.stats.shots++;
    this.feedback({
      name: kind === "shotgun" ? "shotgunFire" : "smgFire",
      actor: f.id,
      x: aim.origin.x,
      intensity: 1,
      barn: {
        weapon: weaponCode(kind),
        ends: shot.pellets.flatMap((p) => [cm(p.end.x), cm(p.end.y), cm(p.end.z)]),
        struck: shot.pellets.map((p) => (p.target !== null ? p.target : p.blocked ? -2 : -1)),
      },
    });
    for (const [id, hit] of landed) {
      const target = this.fighters[id];
      if (!target.alive || target.protection > 0) continue;
      const along = unit({ x: hit.push.x, y: 0, z: hit.push.z }),
        victim = this.physics.players[id];
      if (kind === "shotgun") {
        const s = BARN_COMBAT.shotgun,
          dv = Math.min(s.maxKnockback, s.knockbackPerPellet * hit.power);
        this.push(victim, { x: along.x * dv, y: s.lift * dv, z: along.z * dv });
        if (hit.pellets >= s.stagger.pellets) this.stagger(target, s.stagger);
      } else this.push(victim, { x: along.x * BARN_COMBAT.smg.knockback, y: 0, z: along.z * BARN_COMBAT.smg.knockback });
      this.stats.hits++;
      const hp = Math.max(0, target.hp - hit.damage);
      this.feedback({
        name: "bulletHit",
        actor: f.id,
        target: id,
        x: hit.point.x,
        intensity: clamp(hit.damage / 60, 0.2, 1),
        barn: { damage: target.hp - hp, hp, killed: hp <= 0, point: [cm(hit.point.x), cm(hit.point.y), cm(hit.point.z)] },
      });
      this.damage(target, hit.damage, { source: kind, attacker: f.id, point: hit.point, pellets: hit.pellets });
    }
  }

  /** Punch contact from the physically moving hand (rooftop's rule), turned into Barn damage. */
  afterStep() {
    for (const f of this.fighters) {
      if (!f.alive || f.weapon || !activePunch(f.punch)) continue;
      const actor = this.physics.players[f.id],
        hand = actor.parts[HAND_PARTS[f.punchHand]],
        facing = { x: Math.sin(actor.facing), y: 0, z: Math.cos(actor.facing) };
      let best: { target: BarnFighter; part: PartName; power: number; point: Vec; direction: Vec } | null = null;
      for (const other of this.fighters) {
        if (other.id === f.id || !other.alive) continue;
        const target = this.physics.players[other.id];
        for (const name of PARTS) {
          const part = target.parts[name],
            contact = hand.collider.contactCollider(part.collider, COMBAT.punch.contactMargin);
          if (!contact) continue;
          const direction = unit(sub(part.body.translation(), hand.body.translation())),
            closing = Math.max(0, dot(sub(hand.beforeVelocity, part.beforeVelocity), direction)),
            alignment = clamp(dot(facing, unit({ x: direction.x, y: 0, z: direction.z })), 0, 1),
            power = punchPower(name, closing, alignment);
          if (power > 0 && (!best || power > best.power) && this.physics.clearPath(hand.body.translation(), contact.point2))
            best = { target: other, part: name, power, point: contact.point2, direction };
        }
      }
      if (!best) continue;
      f.punch.hit = true;
      this.stats.punchHits++;
      const p = BARN_COMBAT.punch,
        dealt = best.target.protection > 0 ? 0 : Math.min(best.target.hp, p.damage),
        hp = best.target.hp - dealt;
      this.feedback({
        name: hitSound(best.part),
        actor: f.id,
        target: best.target.id,
        x: best.point.x,
        intensity: clamp(best.power / COMBAT.knockout.head),
        barn: { damage: dealt, hp, killed: dealt > 0 && hp <= 0, point: [cm(best.point.x), cm(best.point.y), cm(best.point.z)] },
      });
      if (best.target.protection > 0) continue;
      const along = unit({ x: best.direction.x, y: 0, z: best.direction.z });
      this.push(this.physics.players[best.target.id], { x: along.x * p.knockback, y: p.lift, z: along.z * p.knockback });
      this.stagger(best.target, p.stagger);
      this.damage(best.target, p.damage, { source: "punch", attacker: f.id, point: best.point });
    }
  }

  // ─── Health, death, respawn ───────────────────────────────────────────────

  private damage(target: BarnFighter, amount: number, hit: Omit<BarnHit, "target" | "damage" | "hp" | "killed">) {
    if (!target.alive || target.protection > 0 || !(amount > 0)) return;
    if (hit.attacker !== null && hit.attacker !== target.id) {
      target.lastHitBy = hit.attacker;
      target.lastHitAt = this.time;
    }
    target.hp = Math.max(0, target.hp - amount);
    target.flash = 0.15;
    const killed = target.hp <= 0;
    this.hits.push({ ...hit, target: target.id, damage: amount, hp: target.hp, killed });
    if (killed) this.kill(target, hit.attacker ?? this.recentAttacker(target));
  }
  /**
   * Who a trap or environment death is credited to: the last other player to damage
   * the victim within `credit.window` seconds, else nobody.
   */
  recentAttacker(f: BarnFighter): PlayerId | null {
    return f.lastHitBy !== null && this.time - f.lastHitAt <= BARN_COMBAT.credit.window ? f.lastHitBy : null;
  }
  /** A body lost to a physics fault (the barn is enclosed): a death, credited like a trap. */
  environmentDeath(f: BarnFighter) {
    if (f.alive) this.kill(f, this.recentAttacker(f));
  }
  private kill(f: BarnFighter, by: PlayerId | null) {
    f.alive = false;
    f.deadFor = 0;
    f.weapon = null;
    f.trapped = f.protection = f.punchCooldown = 0;
    f.stagger.time = 0;
    f.punch.age = -1;
    f.deaths++;
    if (by !== null && by !== f.id) this.fighters[by].kills++;
    this.stats.kills++;
    const x = this.physics.players[f.id].body.translation().x;
    this.feedback({ name: "death", actor: f.id, ...(by !== null && by !== f.id && { target: by }), x, intensity: 1, barn: { by: by !== null && by !== f.id ? by : -1 } });
    this.notices.push({ type: "death", id: f.id, by });
  }
  /** Also used after a fault/fall-out in the local mode: back on a spawn, full health, unarmed. */
  respawn(f: BarnFighter) {
    const spawn = this.chooseSpawn(f.id),
      character = this.physics.players[f.id];
    restore(character, { x: spawn.x, y: spawn.y + SPAWN_LIFT, z: spawn.z }, spawn.yaw);
    connect(this.physics.world, character);
    const kept = { kills: f.kills, deaths: f.deaths, life: f.life + 1 };
    Object.assign(f, freshFighter(f.id, spawn, BARN_COMBAT.death.protection), kept);
    this.drives[f.id] = normalDrive();
    this.feedback({ name: "respawn", actor: f.id, x: spawn.x });
    this.notices.push({ type: "respawn", id: f.id, spawn: spawn.id });
  }
  /**
   * Weighted respawn choice among the map's candidates. Candidates closer than
   * `respawn.clearance` to a living enemy are only used when every one is. Then, best
   * score: farther from the nearest living enemy (up to 25 m), not in any living
   * enemy's chest-to-chest sightline, not beside an active weapon or an armed trap,
   * not the spot this player last used, plus a little randomness. Something is always
   * chosen; every candidate passed the chase camera's boom-clearance test (barn.test.ts).
   */
  chooseSpawn(id: PlayerId): BarnSpawnPoint {
    const others = this.living(id),
      w = BARN_COMBAT.respawn,
      last = this.fighters[id].home.id,
      weapons = this.pickups.active.map((a) => this.pickups.spot(a.spot)),
      traps = this.traps.filter((t) => t.armed);
    const scored = (Object.keys(SPAWN_CANDIDATES) as BarnSpawnId[]).map((sid) => {
      const s = spawnPoint(sid),
        chest = { x: s.x, y: s.y + 0.78 + CHEST, z: s.z };
      const near = others.length ? Math.min(...others.map((o) => Math.hypot(o.x - s.x, (o.y - 0.78 - s.y) * 1.5, o.z - s.z))) : 25;
      const seen = others.filter((o) => this.physics.clearPath({ x: o.x, y: o.y + CHEST, z: o.z }, chest)).length;
      const weapon = weapons.length ? Math.min(...weapons.map((p) => Math.hypot(p.x - s.x, (p.y - s.y) * 1.5, p.z - s.z))) : Infinity;
      const trap = traps.length ? Math.min(...traps.map((t) => Math.hypot(t.x - s.x, (t.y - s.y) * 1.5, t.z - s.z))) : Infinity;
      const score =
        Math.min(near, 25) -
        w.seenPenalty * seen -
        w.weaponPenalty * Math.max(0, w.weaponClearance - weapon) -
        w.trapPenalty * Math.max(0, w.trapClearance - trap) -
        (sid === last ? w.repeatPenalty : 0) +
        this.random() * w.randomness;
      return { s, near, score };
    });
    const clear = scored.filter((c) => c.near >= w.clearance);
    return (clear.length ? clear : scored).reduce((a, b) => (b.score > a.score ? b : a)).s;
  }

  // ─── Physical response ────────────────────────────────────────────────────

  /** Whole-body velocity change: every part gets mass × Δv, so the body moves as one (no limb whip). */
  private push(character: Character, dv: Vec) {
    for (const name of PARTS) {
      const m = SHAPES[name].mass;
      character.parts[name].body.applyImpulse({ x: dv.x * m, y: dv.y * m, z: dv.z * m }, true);
    }
  }
  /** Non-lethal hits: a short loss of posture/mobility that never drops below the measured safe 0.6. */
  private stagger(f: BarnFighter, s: { time: number; posture: number; mobility: number }) {
    if (f.stagger.time > 0) {
      f.stagger.posture = Math.min(f.stagger.posture, s.posture);
      f.stagger.mobility = Math.min(f.stagger.mobility, s.mobility);
      f.stagger.time = Math.max(f.stagger.time, s.time);
    } else f.stagger = { ...s };
  }
}
