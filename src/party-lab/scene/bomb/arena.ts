import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, MeshLambertMaterial } from "three";
import {
  AC_UNITS,
  BOMB_ARENA,
  BOMB_TRAPS,
  CATWALKS,
  CRATE_BLOCKS,
  HOP_WALLS,
  JUMP_SHORTCUTS,
  L_WALL_NW,
  L_WALL_SE,
  PERIMETER,
  RAMPS,
  type Block,
} from "../../../../shared/party-lab/maps/bomb";

/**
 * "Oyun Parkı" gameplay geometry, generated from the shared map data (maps/bomb.ts) so what
 * you see is exactly what you collide with: one vertex-coloured, flat-shaded Lambert mesh
 * (floor, parapet, pocket walls, AC units, catwalks, ramps, hop walls, the glass guard's
 * posts and rail, the painted marks) and one transparent mesh (the glass). No textures, no
 * shadows. The crates come from the kit (scenery.ts) over their colliders.
 *
 * Visual language: jumpable edges carry yellow-and-black stripes (catwalk ledges, hop walls,
 * the jump shortcuts' chevrons, the rim of each trap's mat: step round or jump over); walls
 * that stop you are plain.
 */
type V = readonly [number, number, number];
const PALETTE = {
  floorA: "#a8c3bd",
  floorB: "#9db9b3",
  floorEdge: "#8eaaa5",
  plaza: "#ec9a52",
  ledge: "#cfc8bc",
  facade: "#b98d73",
  facadeLow: "#8d6b5a",
  brick: "#c7704f",
  brickDark: "#a95c40",
  cap: "#efe2cd",
  post: "#8e98a5",
  plaster: "#ece1cc",
  plasterBase: "#cdbfa6",
  plasterCap: "#f7efe0",
  acBody: "#cfd5dc",
  acTop: "#e4e8ec",
  acDark: "#4b5461",
  acFan: "#77818f",
  plankA: "#c89c6c",
  plankB: "#b98c5c",
  steel: "#6c7480",
  concrete: "#bdc4cc",
  concreteTop: "#d2d8de",
  hazard: "#f2c230",
  hazardDark: "#2d2b30",
  crate: "#c58a52",
  trapMat: "#3b3742",
} as const;
/**
 * Each slow trap stands on a dark round mat with a striped rim (radii, m). The mat covers
 * everywhere a foot springs the trap (BOMB_TAG.trap.radius) with room to spare: a foot on the
 * rim never springs it.
 */
export const TRAP_MAT = { inner: 0.6, outer: 0.74 } as const;
const color = (hex: string) => new Color(hex);

class Mesher {
  private positions: number[] = [];
  private normals: number[] = [];
  private colors: number[] = [];
  /** A planar quad, corners counter-clockwise seen from its front. */
  quad(a: V, b: V, c: V, d: V, tint: Color) {
    const n = newell([a, b, c, d]);
    for (const p of [a, b, c, a, c, d]) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(n[0], n[1], n[2]);
      this.colors.push(tint.r, tint.g, tint.b);
    }
  }
  /** Axis-aligned box; `faces` picks a colour per face (null: skip it). */
  box(min: V, max: V, faces: (face: "top" | "bottom" | "px" | "nx" | "pz" | "nz") => Color | null) {
    const [x0, y0, z0] = min,
      [x1, y1, z1] = max;
    const f = (name: Parameters<typeof faces>[0], a: V, b: V, c: V, d: V) => {
      const tint = faces(name);
      if (tint) this.quad(a, b, c, d, tint);
    };
    f("top", [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
    f("bottom", [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    f("px", [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
    f("nx", [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    f("pz", [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    f("nz", [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
  }
  /** A flat mark on a horizontal surface at height y (slightly above it), facing up whatever the corner order. */
  decal(points: readonly [number, number][], y: number, tint: Color) {
    const [a, b, c, d] = points.map(([x, z]): V => [x, y + 0.004, z]);
    if (newell([a, b, c, d])[1] > 0) this.quad(a, b, c, d, tint);
    else this.quad(d, c, b, a, tint);
  }
  build() {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("normal", new Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute("color", new Float32BufferAttribute(this.colors, 3));
    geometry.computeBoundingSphere();
    return geometry;
  }
  get triangles() {
    return this.positions.length / 9;
  }
}

/** Unit normal of a polygon by Newell's method (a repeated corner is fine), from its winding. */
function newell(points: readonly V[]): [number, number, number] {
  let x = 0,
    y = 0,
    z = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i],
      q = points[(i + 1) % points.length];
    x += (p[1] - q[1]) * (p[2] + q[2]);
    y += (p[2] - q[2]) * (p[0] + q[0]);
    z += (p[0] - q[0]) * (p[1] + q[1]);
  }
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}
const shade = (c: Color, k: number) => c.clone().multiplyScalar(k);
/** Side shading so boxes read in flat light: tops brightest, faces toward −z darker. */
const sides = (base: Color, top: Color = base) => (face: string) =>
  face === "top" ? top : face === "bottom" ? null : face === "nz" || face === "nx" ? shade(base, 0.82) : base;

function stripes(m: Mesher, x: readonly [number, number], z: readonly [number, number], y: number, along: "x" | "z", width = 0.3) {
  const [a0, a1] = along === "x" ? x : z,
    count = Math.max(1, Math.round((a1 - a0) / width)),
    step = (a1 - a0) / count,
    yellow = color(PALETTE.hazard),
    dark = color(PALETTE.hazardDark);
  for (let k = 0; k < count; k++) {
    const s0 = a0 + k * step,
      s1 = s0 + step;
    const pts: [number, number][] =
      along === "x"
        ? [
            [s0, z[0]],
            [s1, z[0]],
            [s1, z[1]],
            [s0, z[1]],
          ]
        : [
            [x[0], s0],
            [x[1], s0],
            [x[1], s1],
            [x[0], s1],
          ];
    m.decal(pts, y, k % 2 ? dark : yellow);
  }
}
/** Three chevrons from `from` toward `to` on a surface at `y`. */
function chevrons(m: Mesher, from: { x: number; z: number }, to: { x: number; z: number }, y: number) {
  const dx = to.x - from.x,
    dz = to.z - from.z,
    l = Math.hypot(dx, dz),
    ux = dx / l,
    uz = dz / l,
    px = -uz,
    pz = ux,
    tint = color(PALETTE.hazard);
  for (let k = 0; k < 3; k++) {
    const cx = from.x - ux * (0.25 + k * 0.42),
      cz = from.z - uz * (0.25 + k * 0.42);
    // One chevron = two thin quads meeting at the tip.
    for (const side of [-1, 1]) {
      const tip: [number, number] = [cx + ux * 0.16, cz + uz * 0.16],
        wing: [number, number] = [cx - ux * 0.14 + px * side * 0.3, cz - uz * 0.14 + pz * side * 0.3];
      const w = 0.07;
      const pts: [number, number][] = [
        [tip[0] - ux * w, tip[1] - uz * w],
        [tip[0], tip[1]],
        [wing[0], wing[1]],
        [wing[0] - ux * w, wing[1] - uz * w],
      ];
      // Keep a consistent winding (decal flips it to face up).
      m.decal(side > 0 ? pts : [pts[1], pts[0], pts[3], pts[2]], y, tint);
    }
  }
}

export interface BombArenaMeshes {
  group: Group;
  triangles: number;
  dispose(): void;
}

export function buildBombArena(): BombArenaMeshes {
  const m = new Mesher(),
    H = BOMB_ARENA.half,
    W = BOMB_ARENA.wall,
    OUT = H + W.thickness,
    EDGE = OUT + BOMB_ARENA.ledge;
  // ── Floor: 2 m rubber tiles, a darker band along the walls, the plaza ring ──
  for (let i = 0; i < 10; i++)
    for (let j = 0; j < 10; j++) {
      const x0 = -H + i * 2,
        z0 = -H + j * 2,
        edge = i === 0 || j === 0 || i === 9 || j === 9;
      const tint = color((i + j) % 2 ? PALETTE.floorA : PALETTE.floorB);
      m.quad([x0, 0, z0 + 2], [x0 + 2, 0, z0 + 2], [x0 + 2, 0, z0], [x0, 0, z0], edge ? shade(tint, 0.95) : tint);
    }
  const plaza = color(PALETTE.plaza);
  for (let k = 0; k < 48; k++) {
    const a0 = (k / 48) * Math.PI * 2,
      a1 = ((k + 1) / 48) * Math.PI * 2,
      r0 = 2.7,
      r1 = 2.95;
    m.decal(
      [
        [Math.cos(a0) * r0, Math.sin(a0) * r0],
        [Math.cos(a0) * r1, Math.sin(a0) * r1],
        [Math.cos(a1) * r1, Math.sin(a1) * r1],
        [Math.cos(a1) * r0, Math.sin(a1) * r0],
      ],
      0,
      plaza
    );
  }
  // ── The roof ledge outside the parapet and the building's facade down to the haze ──
  const ledge = color(PALETTE.ledge);
  for (const [x0, x1, z0, z1] of [
    [-EDGE, EDGE, -EDGE, -OUT],
    [-EDGE, EDGE, OUT, EDGE],
    [-EDGE, -OUT, -OUT, OUT],
    [OUT, EDGE, -OUT, OUT],
  ])
    m.quad([x0, 0, z1], [x1, 0, z1], [x1, 0, z0], [x0, 0, z0], ledge);
  const facade = color(PALETTE.facade),
    low = color(PALETTE.facadeLow),
    bottom = BOMB_ARENA.slabBottom;
  m.box([-EDGE, bottom, -EDGE], [EDGE, 0, EDGE], (face) => (face === "top" || face === "bottom" ? null : face === "nz" || face === "nx" ? shade(facade, 0.85) : facade));
  m.box([-EDGE + 0.01, bottom - 0.01, -EDGE + 0.01], [EDGE - 0.01, bottom + 1.2, EDGE - 0.01], (face) => (face === "top" || face === "bottom" ? null : low));
  // ── Parapet (brick to 1 m, a cap) and the glass guard's posts and top rail ──
  const brick = color(PALETTE.brick),
    brickDark = color(PALETTE.brickDark),
    cap = color(PALETTE.cap),
    post = color(PALETTE.post);
  for (const b of PERIMETER) {
    m.box([b.x[0], 0, b.z[0]], [b.x[1], W.brick - 0.08, b.z[1]], (face) => (face === "top" || face === "bottom" ? null : face === "nz" || face === "nx" ? brickDark : brick));
    m.box([b.x[0] - 0.03, W.brick - 0.08, b.z[0] - 0.03], [b.x[1] + 0.03, W.brick, b.z[1] + 0.03], sides(shade(cap, 0.92), cap));
    m.box([b.x[0], W.height - 0.1, b.z[0]], [b.x[1], W.height, b.z[1]], sides(post, shade(post, 1.1)));
    const alongX = b.x[1] - b.x[0] > b.z[1] - b.z[0],
      [a0, a1] = alongX ? b.x : b.z,
      count = Math.round((a1 - a0) / 2.5);
    for (let k = 0; k <= count; k++) {
      const a = a0 + ((a1 - a0) * k) / count,
        cx = alongX ? a : (b.x[0] + b.x[1]) / 2,
        cz = alongX ? (b.z[0] + b.z[1]) / 2 : a;
      m.box([cx - 0.05, W.brick, cz - 0.05], [cx + 0.05, W.height - 0.1, cz + 0.05], sides(post));
    }
  }
  // ── Pocket L-walls: plaster, a darker base, a light cap ──
  const plaster = color(PALETTE.plaster),
    base = color(PALETTE.plasterBase),
    plasterCap = color(PALETTE.plasterCap);
  for (const b of [...L_WALL_NW, ...L_WALL_SE]) {
    m.box([b.x[0], 0, b.z[0]], [b.x[1], 0.25, b.z[1]], sides(base));
    m.box([b.x[0], 0.25, b.z[0]], [b.x[1], b.height - 0.06, b.z[1]], sides(plaster));
    m.box([b.x[0] - 0.03, b.height - 0.06, b.z[0] - 0.03], [b.x[1] + 0.03, b.height, b.z[1] + 0.03], sides(shade(plasterCap, 0.9), plasterCap));
  }
  // ── AC units: metal box, top vents, a fan on the long face toward the middle ──
  for (const b of AC_UNITS) acUnit(m, b);
  // ── Catwalks: planks on steel, stripes along the open inner ledge ──
  for (const b of CATWALKS) {
    deck(m, b);
    const inner = b.z[0] < 0 ? b.z[1] : b.z[0];
    stripes(m, b.x, inner > 0 ? [inner, inner + 0.14] : [inner - 0.14, inner], b.height, "x");
  }
  for (const r of RAMPS) ramp(m, r);
  // ── Hop walls: concrete with a striped top ──
  const concrete = color(PALETTE.concrete);
  for (const b of HOP_WALLS) {
    m.box([b.x[0], 0, b.z[0]], [b.x[1], b.height, b.z[1]], sides(concrete, color(PALETTE.concreteTop)));
    stripes(m, b.x, b.z, b.height, "z", 0.4);
  }
  // ── Jump shortcuts: chevrons at the take-off and on the landing ──
  for (const s of JUMP_SHORTCUTS) {
    chevrons(m, { x: s.from.x + Math.sign(s.to.x - s.from.x) * 0.35, z: s.from.z }, s.to, CATWALKS[0].height);
    chevrons(m, { x: s.to.x + Math.sign(s.to.x - s.from.x) * 0.45, z: s.to.z }, { x: s.to.x + Math.sign(s.to.x - s.from.x) * 2, z: s.to.z }, AC_UNITS[1].height);
  }
  // ── Slow traps: a dark mat with a striped rim under each (just over the plaza ring's paint) ──
  const mat = color(PALETTE.trapMat),
    yellow = color(PALETTE.hazard),
    dark = color(PALETTE.hazardDark);
  for (const t of BOMB_TRAPS) {
    const at = (a: number, r: number): [number, number] => [t.x + Math.cos(a) * r, t.z + Math.sin(a) * r];
    for (let k = 0; k < 24; k++) {
      const a0 = (k / 24) * Math.PI * 2,
        a1 = ((k + 1) / 24) * Math.PI * 2;
      m.decal([[t.x, t.z], [t.x, t.z], at(a0, TRAP_MAT.inner), at(a1, TRAP_MAT.inner)], t.y + 0.003, mat);
      m.decal([at(a0, TRAP_MAT.inner), at(a0, TRAP_MAT.outer), at(a1, TRAP_MAT.outer), at(a1, TRAP_MAT.inner)], t.y + 0.003, k % 2 ? dark : yellow);
    }
  }
  const solid = new Mesh(m.build(), new MeshLambertMaterial({ vertexColors: true }));
  solid.name = "bomb-arena";
  solid.matrixAutoUpdate = false;
  // ── The glass guard (one transparent mesh) ──
  const g = new Mesher(),
    glassTint = color("#d4ecf2");
  for (const b of PERIMETER) g.box([b.x[0] + 0.2, W.brick, b.z[0] + 0.2], [b.x[1] - 0.2, W.height - 0.1, b.z[1] - 0.2], (face) => (face === "top" || face === "bottom" ? null : glassTint));
  const glass = new Mesh(g.build(), new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.16, depthWrite: false, side: DoubleSide }));
  glass.name = "bomb-glass";
  glass.renderOrder = 1;
  glass.matrixAutoUpdate = false;
  const group = new Group();
  group.name = "bomb-arena";
  group.add(solid, glass);
  const triangles = m.triangles + g.triangles;
  return {
    group,
    triangles,
    dispose() {
      for (const mesh of [solid, glass]) {
        mesh.geometry.dispose();
        (mesh.material as MeshLambertMaterial | MeshBasicMaterial).dispose();
      }
    },
  };
}

function acUnit(m: Mesher, b: Block) {
  const body = color(PALETTE.acBody),
    top = color(PALETTE.acTop),
    dark = color(PALETTE.acDark),
    fan = color(PALETTE.acFan);
  m.box([b.x[0], 0.08, b.z[0]], [b.x[1], b.height, b.z[1]], sides(body, top));
  m.box([b.x[0] + 0.05, 0, b.z[0] + 0.05], [b.x[1] - 0.05, 0.08, b.z[1] - 0.05], sides(dark));
  // Vent slats on top.
  const alongX = b.x[1] - b.x[0] >= b.z[1] - b.z[0];
  for (let k = 0; k < 3; k++) {
    const t = (k + 1) / 4;
    const pts: [number, number][] = alongX
      ? [
          [b.x[0] + 0.15, b.z[0] + (b.z[1] - b.z[0]) * t - 0.04],
          [b.x[1] - 0.15, b.z[0] + (b.z[1] - b.z[0]) * t - 0.04],
          [b.x[1] - 0.15, b.z[0] + (b.z[1] - b.z[0]) * t + 0.04],
          [b.x[0] + 0.15, b.z[0] + (b.z[1] - b.z[0]) * t + 0.04],
        ]
      : [
          [b.x[0] + (b.x[1] - b.x[0]) * t - 0.04, b.z[0] + 0.15],
          [b.x[0] + (b.x[1] - b.x[0]) * t + 0.04, b.z[0] + 0.15],
          [b.x[0] + (b.x[1] - b.x[0]) * t + 0.04, b.z[1] - 0.15],
          [b.x[0] + (b.x[1] - b.x[0]) * t - 0.04, b.z[1] - 0.15],
        ];
    m.decal(pts, b.height, dark);
  }
  // Fan grille (an octagon of quads) on the face toward the middle of the arena.
  const cx = (b.x[0] + b.x[1]) / 2,
    cz = (b.z[0] + b.z[1]) / 2;
  const faceZ = alongX ? (Math.abs(b.z[0]) < Math.abs(b.z[1]) ? b.z[0] : b.z[1]) : null,
    faceX = alongX ? null : Math.abs(b.x[0]) < Math.abs(b.x[1]) ? b.x[0] : b.x[1];
  const out = faceZ !== null ? Math.sign(faceZ - cz) : Math.sign(faceX! - cx);
  const fans = alongX ? 2 : 1,
    span = alongX ? b.x[1] - b.x[0] : b.z[1] - b.z[0],
    r = Math.min(0.36, b.height * 0.33);
  for (let f = 0; f < fans; f++) {
    const along = (alongX ? b.x[0] : b.z[0]) + (span * (f + 0.5)) / fans,
      y = b.height * 0.52;
    for (let k = 0; k < 8; k++) {
      const a0 = (k / 8) * Math.PI * 2,
        a1 = ((k + 1) / 8) * Math.PI * 2;
      const ring = (a: number, rr: number): V =>
        faceZ !== null ? [along + Math.cos(a) * rr, y + Math.sin(a) * rr, faceZ + out * 0.006] : [faceX! + out * 0.006, y + Math.sin(a) * rr, along + Math.cos(a) * rr];
      const tint = k % 2 ? dark : fan;
      const quad = [ring(a0, r * 0.25), ring(a0, r), ring(a1, r), ring(a1, r * 0.25)] as const;
      // Face outward.
      if ((faceZ !== null ? out : -out) > 0) m.quad(quad[0], quad[1], quad[2], quad[3], tint);
      else m.quad(quad[3], quad[2], quad[1], quad[0], tint);
    }
  }
}

function deck(m: Mesher, b: Block) {
  const steel = color(PALETTE.steel),
    a = color(PALETTE.plankA),
    bb = color(PALETTE.plankB),
    top = b.height;
  m.box([b.x[0], 0, b.z[0]], [b.x[1], top - 0.12, b.z[1]], (face) => (face === "top" || face === "bottom" ? null : face === "nz" || face === "nx" ? shade(steel, 0.85) : steel));
  // Planks across the walkway (along x), alternating shades, 0.3 m.
  const count = Math.round((b.x[1] - b.x[0]) / 0.3);
  for (let k = 0; k < count; k++) {
    const x0 = b.x[0] + ((b.x[1] - b.x[0]) * k) / count,
      x1 = b.x[0] + ((b.x[1] - b.x[0]) * (k + 1)) / count;
    m.box([x0, top - 0.12, b.z[0]], [x1, top, b.z[1]], (face) => (face === "top" ? (k % 2 ? a : bb) : face === "bottom" ? null : shade(k % 2 ? a : bb, 0.8)));
  }
}

function ramp(m: Mesher, r: (typeof RAMPS)[number]) {
  const steel = color(PALETTE.steel),
    a = color(PALETTE.plankA),
    bb = color(PALETTE.plankB),
    up = r.rises === "+x" ? 1 : -1,
    [x0, x1] = r.x,
    [z0, z1] = r.z,
    low = up > 0 ? x0 : x1,
    high = up > 0 ? x1 : x0,
    h = r.height;
  const hAt = (x: number) => (h * (x - low)) / (high - low);
  // Slope in planks.
  const count = 7;
  for (let k = 0; k < count; k++) {
    const xa = low + ((high - low) * k) / count,
      xb = low + ((high - low) * (k + 1)) / count,
      tint = k % 2 ? a : bb;
    const p: V[] = [
      [xa, hAt(xa), z1],
      [xb, hAt(xb), z1],
      [xb, hAt(xb), z0],
      [xa, hAt(xa), z0],
    ];
    if (up > 0) m.quad(p[0], p[1], p[2], p[3], tint);
    else m.quad(p[3], p[2], p[1], p[0], tint);
  }
  // Side triangles (as degenerate quads) and the tall end.
  for (const z of [z0, z1]) {
    const tri: V[] = [
      [low, 0, z],
      [high, 0, z],
      [high, h, z],
      [high, h, z],
    ];
    const front = (z === z1) === up > 0;
    if (front) m.quad(tri[0], tri[1], tri[2], tri[3], z === z0 ? shade(steel, 0.85) : steel);
    else m.quad(tri[3], tri[2], tri[1], tri[0], z === z0 ? shade(steel, 0.85) : steel);
  }
  // A stripe across the foot (the slope starts here).
  stripes(m, up > 0 ? [low, low + 0.14] : [low - 0.14, low], [z0, z1], 0.002, "z", 0.3);
}

/** The crate colliders' footprints (the kit's crates are stretched over them; also the fallback boxes). */
export const CRATE_FOOTPRINTS: readonly Block[] = CRATE_BLOCKS;
export const CRATE_COLOR = PALETTE.crate;
