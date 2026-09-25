import type { MovementInput } from "../../input/types";
import { IDLE_INPUT, PHYSICS } from "../physics";
import type { PlayerId } from "../players";
import { BOMB_MAP } from "../../../../shared/party-lab/maps/bomb";
import { BOMB_TAG } from "../../../../shared/party-lab/simulation/bomb/config";
import type { BombTagGame } from "../../../../shared/party-lab/simulation/bomb/game";
import { BombNav, type EdgeKind, type NavField } from "./nav";

/** One shared navigation grid (the map is static). */
let shared: BombNav | null = null;
export const bombNav = () => (shared ??= new BombNav(BOMB_MAP));

/** Tag reach the bot plans with (pelvis to pelvis, m, any direction): the tag assist's range. */
const REACH = BOMB_TAG.tag.range;
/** Straight-line chase inside this range when the way is clear (m). */
const DIRECT = 3.5;
/** Seconds between route decisions. */
const REPLAN = 0.3;
/**
 * What a bot makes of the slow traps it can see (armed or shut — never when a shut one will
 * reopen): routes pay `cost` (m-equivalent) per grid node within `zone` m of an armed trap,
 * so they go round unless that is clearly longer; a straight run (the close chase, string-
 * pulling a route) is not taken across one — passing within `clear` m of its centre — unless
 * it is urgent: the rival within `urgent` m, or under 2 s on the fuse. A runner with the lit
 * bomb within `panic.range` m forgets them for a route decision `panic.chance` of the time.
 * So a bot can still be baited over one, or run over one in a panic.
 */
export const TRAP = { zone: 0.95, cost: 1.0, clear: 0.85, urgent: 2.0, panic: { range: 3, chance: 0.5 } } as const;
/** Route costs per set of armed traps (bit i: trap i armed), per grid. */
const trapCosts = new WeakMap<BombNav, { zones: number[][]; byMask: Map<number, Float32Array> }>();
export function trapPenalty(nav: BombNav, game: BombTagGame): Float32Array | null {
  const traps = game.traps.traps;
  let mask = 0;
  traps.forEach((t, i) => t.armed && (mask |= 1 << i));
  if (!mask) return null;
  let cache = trapCosts.get(nav);
  if (!cache) trapCosts.set(nav, (cache = { zones: traps.map((t) => nav.floorNear(t.x, t.z, TRAP.zone)), byMask: new Map() }));
  let costs = cache.byMask.get(mask);
  if (!costs) {
    costs = new Float32Array(nav.nodes.length);
    for (let i = 0; i < traps.length; i++) if (mask & (1 << i)) for (const id of cache.zones[i]) costs[id] = TRAP.cost;
    cache.byMask.set(mask, costs);
  }
  return costs;
}
/** Whether walking straight from a to b passes within TRAP.clear of an armed trap's centre. */
function acrossTrap(game: BombTagGame, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax,
    dz = bz - az,
    length2 = dx * dx + dz * dz;
  for (const t of game.traps.traps) {
    if (!t.armed) continue;
    const k = length2 > 1e-9 ? Math.max(0, Math.min(1, ((t.x - ax) * dx + (t.z - az) * dz) / length2)) : 0;
    if (Math.hypot(ax + dx * k - t.x, az + dz * k - t.z) < TRAP.clear) return true;
  }
  return false;
}

type Mode = "idle" | "chase" | "stalk" | "flee";
interface Point {
  x: number;
  y: number;
  z: number;
}

/**
 * Local Bomba Sende opponent: a small state machine over plain movement intent (same
 * speed, jump and punch as a human), reading only what a player sees — positions, who has
 * the bomb and how long is left.
 *
 * - chase (it has the lit bomb): the nearest rival by path, not the one it just got the bomb
 *   from while that one is protected; straight at them (leading a little) once close and in
 *   the open, else along the grid route; sprints unless the rival is right there; punches
 *   (tags) when a rival is in reach, whichever side.
 * - stalk (it is the next carrier, the fuse not lit yet): walks toward the nearest rival and
 *   waits a few metres off.
 * - flee (someone else has the bomb): every 0.3 s picks a spot it reaches clearly before the
 *   carrier (both path distances from the grid), preferring far and open ground and keeping
 *   its current spot unless a new one is clearly better, so it runs round cover and loops
 *   instead of straight into a wall. Sprints while the carrier is near; sidesteps when the
 *   carrier closes in; now and then shoves a carrier that is right in front of it.
 * - Jumps where its route needs it (onto decks and tops, over hop walls, the gap
 *   shortcuts); unsticks itself if it stops making progress.
 * - Goes round armed slow traps when that costs little (TRAP), but not always: at close range
 *   or with the fuse nearly out it runs straight, and it never expects a shut trap to reopen.
 * - Human-like: 0.2–0.45 s to react when the bomb changes hands, imperfect punches.
 */
export class BombBot {
  readonly input: MovementInput = { x: 0, z: 0, jump: false };
  mode: Mode = "idle";
  private readonly nav = bombNav();
  private carrierSeen: PlayerId | null | -1 = -1;
  private react = 0;
  private replanIn = 0;
  private route: number[] = [];
  private goal = -1;
  private target: PlayerId | null = null;
  private punchCheck = 0;
  private juke = { side: 1, left: 0, cool: 0 };
  /** Progress watch; `unstuck` counts escapes (tests read it). */
  readonly stuck = { x: 0, z: 0, time: 0, escape: 0, dx: 0, dz: 0, unstuck: 0 };
  private jumped = 0;
  /** Minding the armed traps on this route (a panicking runner forgets them). */
  private heed = true;
  constructor(
    readonly id: PlayerId,
    private readonly random: () => number = Math.random
  ) {}
  reset() {
    this.mode = "idle";
    this.carrierSeen = -1;
    this.react = this.replanIn = 0;
    this.route = [];
    this.goal = -1;
    this.target = null;
    this.juke = { side: 1, left: 0, cool: 0 };
    Object.assign(this.stuck, { x: 0, z: 0, time: 0, escape: 0, dx: 0, dz: 0 });
    this.jumped = 0;
    this.heed = true;
  }

  update(game: BombTagGame): MovementInput {
    const i = this.input,
      dt = PHYSICS.step;
    i.x = i.z = 0;
    i.jump = i.punch = i.sprint = false;
    const round = game.round,
      me = game.physics.players[this.id];
    if (round.phase !== "playing" || !round.alive[this.id] || me.eliminated) {
      this.mode = "idle";
      return IDLE_INPUT;
    }
    const bomb = game.bomb,
      p = me.body.translation();
    if (bomb.carrier !== this.carrierSeen) {
      this.carrierSeen = bomb.carrier;
      // A human-like moment to take in who has it now.
      this.react = 0.2 + this.random() * 0.25;
      this.replanIn = 0;
      this.target = null;
    }
    this.react = Math.max(0, this.react - dt);
    this.replanIn -= dt;
    this.punchCheck -= dt;
    this.jumped = Math.max(0, this.jumped - dt);
    this.juke.left = Math.max(0, this.juke.left - dt);
    this.juke.cool = Math.max(0, this.juke.cool - dt);
    const rivals = round.survivors.filter((id) => id !== this.id && !game.physics.players[id].eliminated);
    if (!rivals.length) return i;
    const here = this.nav.nodeAt(p.x, p.y, p.z);
    const mine = bomb.carrier === this.id;
    this.mode = mine ? (bomb.phase === "armed" ? "chase" : "stalk") : bomb.carrier !== null ? "flee" : "idle";
    if (this.react > 0 && this.mode !== "flee") return i;
    if (this.mode === "chase" || this.mode === "stalk") this.hunt(game, p, here, rivals);
    else if (this.mode === "flee") this.flee(game, p, here, bomb.carrier!);
    this.unstick(p, dt);
    return i;
  }

  // ── The carrier ────────────────────────────────────────────────────────────

  private hunt(game: BombTagGame, p: Point, here: number, rivals: PlayerId[]) {
    const bomb = game.bomb,
      armed = bomb.phase === "armed",
      protectedId = bomb.immuneTicks > 0 ? bomb.immune : null;
    let field: NavField | null = null;
    if (this.replanIn <= 0 || this.target === null || !rivals.includes(this.target)) {
      this.replanIn = REPLAN;
      this.heed = true;
      field = this.nav.field(here, trapPenalty(this.nav, game));
      // Nearest rival by path; one that is protected only if nobody else is left.
      const open = rivals.filter((id) => id !== protectedId);
      const pool = open.length ? open : rivals;
      let best: PlayerId | null = null,
        bestD = Infinity;
      for (const id of pool) {
        const at = game.physics.players[id].body.translation(),
          d = field.dist[this.nav.nodeAt(at.x, at.y, at.z)] + (id === this.target ? -1.5 : 0);
        if (d < bestD) {
          bestD = d;
          best = id;
        }
      }
      this.target = best;
      if (best !== null) {
        const at = game.physics.players[best].body.translation();
        this.goal = this.nav.nodeAt(at.x, at.y, at.z);
        this.route = this.nav.path(field, this.goal);
      }
    }
    if (this.target === null) return;
    const other = game.physics.players[this.target],
      at = other.body.translation(),
      v = other.body.linvel(),
      dx = at.x - p.x,
      dz = at.z - p.z,
      d = Math.hypot(dx, dz),
      level = this.nav.nodes[here]?.y ?? 0;
    const waiting = !armed || this.target === protectedId;
    const hold = waiting ? 2.2 : 0;
    const urgent = d < TRAP.urgent || (armed && bomb.fuse < 2 * 60);
    if (d < DIRECT && Math.abs(at.y - p.y) < 0.5 && this.nav.clear(p.x, p.z, at.x, at.z, level) && (urgent || !acrossTrap(game, p.x, p.z, at.x, at.z))) {
      // In the open and close: straight at them, a little ahead of where they are going.
      const lead = Math.min(0.35, d / 6);
      const tx = at.x + v.x * lead - p.x,
        tz = at.z + v.z * lead - p.z;
      if (d > hold) this.steer(tx, tz, 1);
    } else this.follow(game, p, here);
    this.input.sprint = armed && (d > 1.6 || game.bomb.fuse < 4 * 60);
    // The tag reaches every side: in range is enough (not always taken at once, like a person).
    if (armed && !waiting && d < REACH + 0.1 && this.punchCheck <= 0) {
      this.punchCheck = 0.08;
      if (game.brawl.fighters[this.id].punchCooldown <= 0 && this.random() < 0.75) this.input.punch = true;
    }
  }

  // ── Everyone else ──────────────────────────────────────────────────────────

  private flee(game: BombTagGame, p: Point, here: number, carrier: PlayerId) {
    const threat = game.physics.players[carrier],
      at = threat.body.translation(),
      tv = threat.body.linvel(),
      dx = p.x - at.x,
      dz = p.z - at.z,
      d = Math.hypot(dx, dz),
      armed = game.bomb.phase === "armed";
    const threatNode = this.nav.nodeAt(at.x, at.y, at.z);
    let fC: NavField | null = null;
    if (this.replanIn <= 0 || this.goal < 0) {
      this.replanIn = REPLAN * (0.8 + this.random() * 0.4);
      this.heed = !(armed && d < TRAP.panic.range && this.random() < TRAP.panic.chance);
      const costs = this.heed ? trapPenalty(this.nav, game) : null;
      fC = this.nav.field(threatNode, costs);
      const fMe = this.nav.field(here, costs);
      this.choose(fC, fMe, here, costs);
    }
    const near = d < 7.5;
    // Closing in: a quick sidestep across its line (away from walls), then back to the route.
    const closing = ((tv.x * dx + tv.z * dz) / Math.max(d, 1e-3)) > 1;
    if (armed && d < 2.6 && closing && this.juke.left <= 0 && this.juke.cool <= 0 && this.random() < 0.08) {
      this.juke.side = this.random() < 0.5 ? -1 : 1;
      this.juke.left = 0.3 + this.random() * 0.2;
      this.juke.cool = 1.2;
    }
    if (this.juke.left > 0) {
      const sx = (-dz / Math.max(d, 1e-3)) * this.juke.side,
        sz = (dx / Math.max(d, 1e-3)) * this.juke.side;
      this.steer(sx + (dx / Math.max(d, 1e-3)) * 0.4, sz + (dz / Math.max(d, 1e-3)) * 0.4, 1);
    } else if (this.route.length && this.goal !== here) this.follow(game, p, here);
    else if (near) this.steer(dx, dz, 1);
    this.input.sprint = armed ? near : d < 4;
    // A carrier right in front: sometimes shove it away (the stagger buys a second).
    if (armed && d < REACH && this.punchCheck <= 0) {
      this.punchCheck = 0.15;
      const me = game.physics.players[this.id],
        ahead = -(Math.sin(me.facing) * dx + Math.cos(me.facing) * dz) / Math.max(d, 1e-3);
      if (ahead > 0.6 && game.brawl.fighters[this.id].punchCooldown <= 0 && this.random() < 0.3) this.input.punch = true;
    }
  }
  /**
   * Where to run: a node it reaches clearly before the carrier (≥ 1.5 m of path to spare,
   * the carrier being a little faster), scored by the carrier's path distance there (capped:
   * far enough is far enough), a little against its own distance, plus open ground. The
   * current goal gets a bonus so it does not dither. Never a spot on an armed trap.
   */
  private choose(fC: NavField, fMe: NavField, here: number, costs: Float32Array | null) {
    const nodes = this.nav.nodes,
      speed = 1 / BOMB_TAG.carrierSpeed;
    let best = -1,
      bestScore = -Infinity;
    const threatHere = fC.dist[here];
    for (let id = 0; id < nodes.length; id++) {
      const mine = fMe.dist[id],
        theirs = fC.dist[id];
      if (!Number.isFinite(mine) || !Number.isFinite(theirs) || mine > 12 || (costs && costs[id] > 0 && id !== here)) continue;
      if (theirs * speed < mine + 1.5 && id !== here) continue;
      const score = Math.min(theirs, 11) - 0.35 * mine + 3 * this.nav.openness[id] + (id === this.goal ? 1.2 : 0) + this.random() * 0.6;
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    // Nowhere safer: just away (the farthest-from-it neighbour ring).
    if (best < 0 || (best === here && threatHere > 9)) best = best < 0 ? here : best;
    this.goal = best;
    this.route = this.nav.path(fMe, best);
  }

  // ── Movement ───────────────────────────────────────────────────────────────

  /**
   * Along the route: steer at the farthest node ahead reachable by walking straight; at a
   * jump, hop, leap or drop steer at the far side and press jump where it needs one.
   */
  private follow(game: BombTagGame, p: Point, here: number) {
    const route = this.route;
    let at = route.indexOf(here);
    if (at < 0) {
      // Off the route (pushed, or it moved on): the nearest node of it ahead.
      let best = Infinity;
      route.forEach((id, k) => {
        const n = this.nav.nodes[id],
          dd = Math.hypot(n.x - p.x, n.z - p.z);
        if (dd < best) {
          best = dd;
          at = k;
        }
      });
      if (best > 1.5) {
        this.replanIn = 0;
        at = -1;
      }
    }
    if (at < 0 || at >= route.length - 1) {
      const last = this.nav.nodes[route[route.length - 1]];
      if (last) this.steer(last.x - p.x, last.z - p.z, Math.min(1, Math.hypot(last.x - p.x, last.z - p.z) / 0.5));
      return;
    }
    const level = this.nav.nodes[here]?.y ?? 0;
    let aim = route[at + 1];
    let kind: EdgeKind = this.nav.edge(route[at], route[at + 1])?.kind ?? "walk";
    if (kind === "walk") {
      // String-pull over plain walks (never cutting a corner across an armed trap).
      for (let k = at + 2; k < Math.min(route.length, at + 14); k++) {
        const e = this.nav.edge(route[k - 1], route[k]);
        if (!e || e.kind !== "walk") break;
        const n = this.nav.nodes[route[k]];
        if (!this.nav.clear(p.x, p.z, n.x, n.z, level) || (this.heed && acrossTrap(game, p.x, p.z, n.x, n.z))) break;
        aim = route[k];
      }
    }
    const n = this.nav.nodes[aim],
      dx = n.x - p.x,
      dz = n.z - p.z,
      d = Math.hypot(dx, dz);
    this.steer(dx, dz, 1);
    if (kind === "jump" || kind === "hop" || kind === "leap") {
      const me = game.physics.players[this.id],
        v = me.body.linvel(),
        toward = (v.x * dx + v.z * dz) / Math.max(d, 1e-3);
      // Take-off: close to the edge and already moving toward it.
      const ready = kind === "leap" ? d < 2.9 : kind === "hop" ? d < 1.8 : d < 1.6;
      // (Or already up against it: a slow jump still gets over a hop wall or onto a top. A hop's
      // far side can be 1.5 m off — the wall and the body's clearance on both sides of it.)
      const against = kind === "hop" ? d < 1.6 : kind === "jump" && d < 1.1;
      if (ready && (toward > 1.8 || against) && this.jumped <= 0) {
        this.input.jump = true;
        this.jumped = 0.5;
      }
      // A walking jump lands on the 2.5 m top across a 1.5 m gap; a sprinting one overshoots it.
      if (kind === "leap") this.input.sprint = false;
    }
  }
  /**
   * Stuck (trying to move but going nowhere for a while — wedged on a corner or a body):
   * walk a random way for a moment with a jump, then re-plan.
   */
  private unstick(p: Point, dt: number) {
    const s = this.stuck,
      i = this.input;
    if (s.escape > 0) {
      s.escape -= dt;
      this.steer(s.dx, s.dz, 1);
      if (s.escape <= 0) this.replanIn = 0;
      return;
    }
    if (Math.hypot(p.x - s.x, p.z - s.z) > 0.5 || Math.hypot(i.x, i.z) < 0.5) {
      s.x = p.x;
      s.z = p.z;
      s.time = 0;
      return;
    }
    s.time += dt;
    if (s.time > 1.2) {
      s.time = 0;
      s.unstuck++;
      const a = this.random() * Math.PI * 2;
      s.dx = Math.cos(a);
      s.dz = Math.sin(a);
      s.escape = 0.5;
      i.jump = true;
    }
  }
  private steer(dx: number, dz: number, magnitude: number) {
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) return;
    this.input.x = (dx / d) * magnitude;
    this.input.z = (dz / d) * magnitude;
  }
}
