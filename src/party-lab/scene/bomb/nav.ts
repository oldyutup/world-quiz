import type { ArenaCollider, ArenaMap } from "../../../../shared/party-lab/maps/types";

/**
 * Bomba Sende's bot navigation: a 0.5 m grid over the playground where each cell holds one
 * node per standable surface (the floor, a block's top, a ramp's slope), built once from the
 * map's colliders — no navmesh, no hand-placed waypoints, so it follows any layout change.
 *
 * Edges (8 neighbours; jumps along the 4 axes only), from the measured ragdoll:
 * - walk: height change ≤ 0.35 m per cell (flat floor, ramps, a step);
 * - jump: up 0.35…1.15 m onto a neighbouring top (a running jump makes 1.1 m easily);
 * - drop: down off a top (anything here, ≤ 1.1 m);
 * - hop: floor to floor over a blocker ≤ 1.0 m tall and ≤ 1 m wide (the hop walls, AC units);
 * - leap: top to top across a gap of 1…2.5 m at about the same height (the jump shortcuts).
 */
export const NAV = {
  cell: 0.5,
  /** Body radius kept from anything that rises more than a step above the surface (m). */
  clearance: 0.3,
  /** A block's top is standable this far inside its edge (m). */
  topMargin: 0.2,
  step: 0.65,
  walk: 0.35,
  jumpUp: 1.15,
  hopMax: 1.0,
  headroom: 1.8,
  /** Extra cost (m-equivalent) of each special move: bots prefer walking unless it saves time. */
  cost: { jump: 0.9, drop: 0.3, hop: 0.7, leap: 0.7 },
} as const;

export type EdgeKind = "walk" | "jump" | "drop" | "hop" | "leap";
export interface NavNode {
  readonly id: number;
  readonly ix: number;
  readonly iz: number;
  readonly x: number;
  readonly z: number;
  /** Surface height (m). */
  readonly y: number;
}
export interface NavEdge {
  readonly to: number;
  readonly cost: number;
  readonly kind: EdgeKind;
}
export interface NavField {
  readonly from: number;
  /** Path metres from `from` (Infinity: unreachable). */
  readonly dist: Float64Array;
  /** Previous node on the best path from `from` (−1: none). */
  readonly prev: Int32Array;
  /** Kind of the edge that reached each node. */
  readonly via: (EdgeKind | null)[];
}

/** Top of a collider at floor point (x, z), with the point clamped into its footprint (ramps: the slope there). */
export function colliderTopAt(c: ArenaCollider, x: number, z: number): number {
  if (c.shape === "cylinder") return c.center.y + c.halfHeight;
  const { center: m, half: h } = c;
  if (c.shape === "box") return m.y + h.y;
  const alongX = c.rises[1] === "x",
    half = alongX ? h.x : h.z,
    a = Math.max(-half, Math.min(half, alongX ? x - m.x : z - m.z)),
    sign = c.rises[0] === "+" ? 1 : -1;
  return m.y - h.y + (2 * h.y * (sign * a + half)) / (2 * half);
}
const bottomOf = (c: ArenaCollider) => (c.shape === "cylinder" ? c.center.y - c.halfHeight : c.center.y - c.half.y);
/** Horizontal distance from (x, z) to a collider's footprint (0 inside). */
function footprintDistance(c: ArenaCollider, x: number, z: number) {
  if (c.shape === "cylinder") return Math.max(0, Math.hypot(x - c.center.x, z - c.center.z) - c.radius);
  const dx = Math.max(0, Math.abs(x - c.center.x) - c.half.x),
    dz = Math.max(0, Math.abs(z - c.center.z) - c.half.z);
  return Math.hypot(dx, dz);
}
/** How far inside a footprint (x, z) is (negative outside). */
function inset(c: ArenaCollider, x: number, z: number) {
  if (c.shape === "cylinder") return c.radius - Math.hypot(x - c.center.x, z - c.center.z);
  return Math.min(c.half.x - Math.abs(x - c.center.x), c.half.z - Math.abs(z - c.center.z));
}

const AXES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
const DIAGONALS = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

export class BombNav {
  readonly nodes: NavNode[] = [];
  readonly edges: NavEdge[][] = [];
  /** Node ids per cell (ix + iz · size), lowest surface first. */
  private readonly cells: number[][];
  readonly size: number;
  private readonly origin: number;
  /** Walkable floor/top nodes within 2 m of each node, 0…1 (open ground scores high). */
  readonly openness: Float32Array;
  private readonly solids: ArenaCollider[];

  constructor(readonly map: ArenaMap) {
    const { bounds } = map;
    this.origin = bounds.minX;
    this.size = Math.round((bounds.maxX - bounds.minX) / NAV.cell);
    this.solids = map.colliders.filter((c) => c.role !== "floor");
    this.cells = Array.from({ length: this.size * this.size }, () => []);
    for (let iz = 0; iz < this.size; iz++)
      for (let ix = 0; ix < this.size; ix++) {
        const x = this.center(ix),
          z = this.center(iz);
        for (const y of this.surfaces(x, z)) {
          const node: NavNode = { id: this.nodes.length, ix, iz, x, z, y };
          this.nodes.push(node);
          this.cells[ix + iz * this.size].push(node.id);
        }
      }
    for (const node of this.nodes) this.edges.push(this.link(node));
    this.openness = Float32Array.from(this.nodes, (node) => {
      let count = 0;
      for (let dz = -4; dz <= 4; dz++)
        for (let dx = -4; dx <= 4; dx++) {
          if (dx * dx + dz * dz > 16) continue;
          if (this.at(node.ix + dx, node.iz + dz).some((id) => Math.abs(this.nodes[id].y - node.y) <= NAV.walk)) count++;
        }
      return count / 49;
    });
  }
  private center(i: number) {
    return this.origin + (i + 0.5) * NAV.cell;
  }
  private at(ix: number, iz: number): number[] {
    return ix < 0 || iz < 0 || ix >= this.size || iz >= this.size ? [] : this.cells[ix + iz * this.size];
  }
  /** Standable surface heights at cell centre (x, z). */
  private surfaces(x: number, z: number): number[] {
    const tops = [0];
    for (const c of this.solids) if (inset(c, x, z) >= NAV.topMargin) tops.push(colliderTopAt(c, x, z));
    const out: number[] = [];
    for (const y of tops) {
      // Something rising more than a step above this surface too close, or overhead: no room.
      const blocked = this.solids.some((c) => {
        const top = colliderTopAt(c, x, z),
          bottom = bottomOf(c);
        if (bottom >= y + NAV.headroom || top <= y + 0.05) return false;
        const d = footprintDistance(c, x, z);
        return d === 0 ? top > y + 0.05 : top > y + NAV.step && d < NAV.clearance;
      });
      if (!blocked && !out.some((o) => Math.abs(o - y) < 0.05)) out.push(y);
    }
    return out.sort((a, b) => a - b);
  }
  /**
   * Highest blocker top on the straight line between two cell centres, not counting what
   * either end stands on (a deck's own edge is not a barrier to leaping off it).
   */
  private barrier(a: NavNode, b: NavNode) {
    let top = 0;
    const steps = 10,
      under = this.solids.filter((c) => footprintDistance(c, a.x, a.z) === 0 || footprintDistance(c, b.x, b.z) === 0);
    for (let k = 1; k < steps; k++) {
      const x = a.x + ((b.x - a.x) * k) / steps,
        z = a.z + ((b.z - a.z) * k) / steps;
      for (const c of this.solids) if (!under.includes(c) && footprintDistance(c, x, z) === 0) top = Math.max(top, colliderTopAt(c, x, z));
    }
    return top;
  }
  private link(node: NavNode): NavEdge[] {
    const out: NavEdge[] = [];
    const similar = (ix: number, iz: number, y: number) => this.at(ix, iz).find((id) => Math.abs(this.nodes[id].y - y) <= NAV.walk);
    // Walks: the 8 neighbours at about the same height.
    for (const [dx, dz] of [...AXES, ...DIAGONALS]) {
      const diagonal = dx !== 0 && dz !== 0,
        id = similar(node.ix + dx, node.iz + dz, node.y);
      if (id === undefined) continue;
      // No corner cutting: both orthogonal cells must be walkable at this height too.
      if (diagonal && (similar(node.ix + dx, node.iz, node.y) === undefined || similar(node.ix, node.iz + dz, node.y) === undefined)) continue;
      if (this.barrier(node, this.nodes[id]) > Math.max(node.y, this.nodes[id].y) + NAV.walk) continue;
      out.push({ to: id, cost: NAV.cell * (diagonal ? Math.SQRT2 : 1), kind: "walk" });
    }
    for (const [dx, dz] of AXES) {
      // Level changes and hops: the first cell along the axis (≤ 1.5 m; the body's clearance
      // leaves blocked cells in front of a ledge) that has any surface.
      if (similar(node.ix + dx, node.iz + dz, node.y) === undefined)
        for (let k = 1; k <= 3; k++) {
          const ids = this.at(node.ix + dx * k, node.iz + dz * k);
          if (!ids.length) continue;
          const length = k * NAV.cell;
          for (const id of ids) {
            const other = this.nodes[id],
              rise = other.y - node.y;
            if (rise > NAV.walk && rise <= NAV.jumpUp) out.push({ to: id, cost: length + NAV.cost.jump, kind: "jump" });
            else if (rise < -NAV.walk) out.push({ to: id, cost: length + NAV.cost.drop, kind: "drop" });
            else if (Math.abs(rise) <= NAV.walk && k >= 2 && node.y < 0.05) {
              const barrier = this.barrier(node, other);
              if (barrier > NAV.step && barrier <= NAV.hopMax + 0.1) out.push({ to: id, cost: length + NAV.cost.hop, kind: "hop" });
            }
          }
          break;
        }
      // Leaps: from a top, across a gap to the next top at about the same height (≤ 2.5 m).
      if (node.y >= 0.6 && similar(node.ix + dx, node.iz + dz, node.y) === undefined)
        for (let k = 2; k <= 5; k++) {
          const id = similar(node.ix + dx * k, node.iz + dz * k, node.y);
          if (id === undefined) continue;
          if (this.barrier(node, this.nodes[id]) <= node.y - 0.3) out.push({ to: id, cost: k * NAV.cell + NAV.cost.leap, kind: "leap" });
          break;
        }
    }
    return out;
  }

  /** The node a body stands on or over: pelvis (x, y, z); its feet are ≈ 0.78 m lower. */
  nodeAt(x: number, y: number, z: number): number {
    const feet = y - 0.78,
      ix = Math.floor((x - this.origin) / NAV.cell),
      iz = Math.floor((z - this.origin) / NAV.cell);
    let best = -1,
      bestScore = Infinity;
    for (let ring = 0; ring <= 3 && best < 0; ring++)
      for (let dz = -ring; dz <= ring; dz++)
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          for (const id of this.at(ix + dx, iz + dz)) {
            const n = this.nodes[id];
            // Prefer the surface under the feet (not above them), then the nearest.
            const above = n.y - feet;
            const score = Math.hypot(n.x - x, n.z - z) + (above > 0.4 ? 3 + above : Math.max(0, -above) * 0.5);
            if (score < bestScore) {
              bestScore = score;
              best = id;
            }
          }
        }
    return best;
  }
  /** Floor nodes (surface ≈ 0) whose cell centre is within `radius` of floor point (x, z). */
  floorNear(x: number, z: number, radius: number): number[] {
    const out: number[] = [],
      reach = Math.ceil(radius / NAV.cell) + 1,
      ix = Math.floor((x - this.origin) / NAV.cell),
      iz = Math.floor((z - this.origin) / NAV.cell);
    for (let dz = -reach; dz <= reach; dz++)
      for (let dx = -reach; dx <= reach; dx++)
        for (const id of this.at(ix + dx, iz + dz)) {
          const n = this.nodes[id];
          if (n.y < 0.05 && Math.hypot(n.x - x, n.z - z) <= radius) out.push(id);
        }
    return out;
  }
  /**
   * Dijkstra from one node over every edge. `extra`: an added cost (m-equivalent) for
   * entering each node — a hazard to go round unless going through saves more.
   */
  field(from: number, extra?: Float32Array | null): NavField {
    const n = this.nodes.length,
      dist = new Float64Array(n).fill(Infinity),
      prev = new Int32Array(n).fill(-1),
      via: (EdgeKind | null)[] = new Array(n).fill(null);
    if (from < 0) return { from, dist, prev, via };
    const heap = new MinHeap();
    dist[from] = 0;
    heap.push(from, 0);
    while (heap.size) {
      const [u, d] = heap.pop();
      if (d > dist[u]) continue;
      for (const e of this.edges[u]) {
        const nd = d + e.cost + (extra ? extra[e.to] : 0);
        if (nd < dist[e.to]) {
          dist[e.to] = nd;
          prev[e.to] = u;
          via[e.to] = e.kind;
          heap.push(e.to, nd);
        }
      }
    }
    return { from, dist, prev, via };
  }
  /** Node ids from the field's origin to `to` (both included); empty if unreachable. */
  path(field: NavField, to: number): number[] {
    if (to < 0 || !Number.isFinite(field.dist[to])) return [];
    const out: number[] = [];
    for (let at = to; at >= 0; at = field.prev[at]) out.push(at);
    return out.reverse();
  }
  /** Kind of the edge from `a` to `b` (null: not neighbours). */
  edge(a: number, b: number): NavEdge | null {
    return this.edges[a]?.find((e) => e.to === b) ?? null;
  }
  /**
   * Whether a body can walk straight from (x0, z0) to (x1, z1) on surface height `y`: every
   * sample (centre line and ±0.25 m) is over a cell with a walkable node at about that height.
   */
  clear(x0: number, z0: number, x1: number, z1: number, y: number) {
    const length = Math.hypot(x1 - x0, z1 - z0),
      steps = Math.ceil(length / 0.25);
    if (!steps) return true;
    const sx = (-(z1 - z0) / length) * 0.25,
      sz = ((x1 - x0) / length) * 0.25;
    let level = y;
    for (let k = 1; k <= steps; k++) {
      const x = x0 + ((x1 - x0) * k) / steps,
        z = z0 + ((z1 - z0) * k) / steps;
      let next = level;
      for (const side of [0, -1, 1]) {
        const px = x + side * sx,
          pz = z + side * sz,
          id = this.at(Math.floor((px - this.origin) / NAV.cell), Math.floor((pz - this.origin) / NAV.cell)).find((i) => Math.abs(this.nodes[i].y - level) <= NAV.walk);
        if (id === undefined) return false;
        if (side === 0) next = this.nodes[id].y;
      }
      level = next;
    }
    return true;
  }
}

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, key: number) {
    const ids = this.ids,
      keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): [number, number] {
    const ids = this.ids,
      keys = this.keys,
      top: [number, number] = [ids[0], keys[0]],
      lastId = ids.pop()!,
      lastKey = keys.pop()!;
    if (ids.length) {
      let i = 0;
      const n = ids.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= lastKey) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = lastId;
      keys[i] = lastKey;
    }
    return top;
  }
}
