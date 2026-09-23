import { BARN_COMBAT } from "./config.js";
import { WEAPON_KINDS, type WeaponKind } from "./weapons.js";
import type { Vec } from "../ragdoll/math.js";

/**
 * Weapon pickups: a few of the map's spots hold a weapon at once. Taking one empties
 * its spot and schedules a replacement `replace` seconds later somewhere else — never
 * the spot just emptied, never next to a living player, preferably far from everyone
 * and not a recently emptied spot — so finding the next weapon means moving through
 * the barn. The replacement's spot is chosen and telegraphed `telegraph` seconds early.
 * Pure state: positions come in, nothing physical is created.
 */
export interface PickupSpot {
  readonly id: string;
  readonly x: number;
  /** Floor height the weapon rests on. */
  readonly y: number;
  readonly z: number;
}
export interface ActivePickup {
  readonly spot: string;
  readonly kind: WeaponKind;
}
export interface PendingPickup {
  /** The spot that was emptied (excluded for this replacement). */
  readonly emptied: string;
  /** Director time the weapon appears. */
  readonly due: number;
  /** Chosen (and telegraphed) once the telegraph window opens. */
  spot: string | null;
  kind: WeaponKind | null;
}
/** Living players' pelvis positions (feet are 0.78 m lower). */
export type Positions = readonly Vec[];

const PELVIS = 0.78;
/** Distance from a player to a spot, counting a floor of height difference as extra distance. */
function reach(p: Vec, s: PickupSpot) {
  return Math.hypot(p.x - s.x, (p.y - PELVIS - s.y) * 1.5, p.z - s.z);
}

export class PickupDirector {
  readonly active: ActivePickup[] = [];
  readonly pending: PendingPickup[] = [];
  /** Most recently emptied spots, newest first. */
  readonly recent: string[] = [];
  time = 0;
  private readonly byId: Map<string, PickupSpot>;
  constructor(
    readonly spots: readonly PickupSpot[],
    private readonly random: () => number,
    private readonly config: typeof BARN_COMBAT.pickups = BARN_COMBAT.pickups
  ) {
    this.byId = new Map(spots.map((s) => [s.id, s]));
  }
  spot(id: string) {
    return this.byId.get(id)!;
  }
  /** Start of play: `active` weapons (default: the config's) spread over the map, both kinds present. */
  reset(players: Positions, active: number = this.config.active) {
    this.active.length = this.pending.length = this.recent.length = 0;
    this.time = 0;
    const count = Math.min(active, this.spots.length);
    for (let i = 0; i < count; i++) {
      const spot = this.choose(players, null, true);
      if (!spot) break;
      this.active.push({ spot: spot.id, kind: this.pickKind() });
    }
  }
  /** Telegraphs and replacements that are due. Returns the weapons that appeared this tick. */
  tick(dt: number, players: Positions): ActivePickup[] {
    this.time += dt;
    const appeared: ActivePickup[] = [];
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      if (p.spot === null && this.time >= p.due - this.config.telegraph) {
        p.spot = this.choose(players, p.emptied)?.id ?? null;
        p.kind = this.pickKind();
      }
      if (this.time >= p.due) {
        // A late choice (e.g. every spot was blocked at telegraph time) is retried here.
        const id = p.spot ?? this.choose(players, p.emptied)?.id ?? null;
        if (!id) continue; // Nowhere free this tick; try again next tick.
        const pickup = { spot: id, kind: p.kind ?? this.pickKind() };
        this.active.push(pickup);
        appeared.push(pickup);
        this.pending.splice(i--, 1);
      }
    }
    return appeared;
  }
  /** The nearest active pickup within reach of a pelvis position, if any. */
  nearest(pelvis: Vec, radius: number = BARN_COMBAT.pickup.radius, height: number = BARN_COMBAT.pickup.height): ActivePickup | null {
    let best: ActivePickup | null = null,
      bestDistance = Infinity;
    for (const pickup of this.active) {
      const s = this.spot(pickup.spot),
        d = Math.hypot(pelvis.x - s.x, pelvis.z - s.z);
      if (d <= radius && Math.abs(pelvis.y - PELVIS - s.y) <= height && d < bestDistance) {
        best = pickup;
        bestDistance = d;
      }
    }
    return best;
  }
  /** Removes a pickup and schedules its replacement elsewhere. */
  take(pickup: ActivePickup) {
    const i = this.active.indexOf(pickup);
    if (i < 0) return false;
    this.active.splice(i, 1);
    this.recent.unshift(pickup.spot);
    this.recent.length = Math.min(this.recent.length, this.config.recent);
    this.pending.push({ emptied: pickup.spot, due: this.time + this.config.replace, spot: null, kind: null });
    return true;
  }
  /** Spots holding or about to hold a weapon. */
  private taken(id: string) {
    return this.active.some((a) => a.spot === id) || this.pending.some((p) => p.spot === id);
  }
  /**
   * Best free spot: hard rules (free, not `emptied`, clear of living players) relaxed
   * only if nothing passes; then farthest from living players and from other
   * weapons, recent spots penalised, with a little randomness so it is not predictable.
   */
  private choose(players: Positions, emptied: string | null, initial = false): PickupSpot | null {
    const free = this.spots.filter((s) => !this.taken(s.id) && s.id !== emptied);
    const clear = free.filter((s) => players.every((p) => reach(p, s) >= this.config.clearance));
    const pool = clear.length ? clear : free;
    if (!pool.length) return null;
    const others = this.spots.filter((s) => this.taken(s.id));
    let best: PickupSpot | null = null,
      bestScore = -Infinity;
    for (const s of pool) {
      const fromPlayers = players.length ? Math.min(...players.map((p) => reach(p, s))) : 20;
      const fromWeapons = others.length ? Math.min(...others.map((o) => Math.hypot(o.x - s.x, (o.y - s.y) * 1.5, o.z - s.z))) : 20;
      const recent = this.recent.indexOf(s.id);
      const score =
        Math.min(fromPlayers, 20) +
        (initial ? 1.5 : 0.5) * Math.min(fromWeapons, 20) -
        (recent >= 0 ? 12 / (recent + 1) : 0) +
        this.random() * 4;
      if (score > bestScore) {
        best = s;
        bestScore = score;
      }
    }
    return best;
  }
  /** 50/50, except that the other kind is forced when every other weapon (active or coming) is the same. */
  private pickKind(): WeaponKind {
    const kinds = [...this.active.map((a) => a.kind), ...this.pending.flatMap((p) => (p.kind ? [p.kind] : []))];
    if (kinds.length && kinds.every((k) => k === kinds[0])) return kinds[0] === "shotgun" ? "smg" : "shotgun";
    return WEAPON_KINDS[this.random() < 0.5 ? 0 : 1];
  }
}
