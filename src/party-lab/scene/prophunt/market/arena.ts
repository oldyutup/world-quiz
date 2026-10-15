import { Color, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshLambertMaterial } from "three";
import { DEPOT, GONDOLAS, MARKET, MARKET_FIXTURES, MARKET_OPENINGS, MARKET_WALLS, marketWallColliders, type Fixture, type MarketWallId } from "../../../../../shared/party-lab/maps/market";
import { bounds, color, Mesher, shade, type Face, type V } from "../arena";
import type { PropArenaMeshes } from "../arena";

/**
 * "Market" gameplay geometry, generated from the shared map data (maps/market.ts) so what you see
 * is what you collide with: one vertex-coloured, flat-shaded Lambert mesh (the tiled floor, the
 * walls with their brand stripe, the ceiling, the shop front's frame, the depot, every fixture:
 * fridges, freezers, gondolas, the drinks wall, the produce rack and tables, the melon heap's
 * bin, the tills, the pallet rack), one transparent mesh (the shop front's glass, the fridge
 * doors, the freezer lids, the depot's strip curtains) and one unlit mesh (the ceiling's light
 * panels, the fridges' lit backs). No textures, no shadows. The stock on the shelves, the produce
 * and every prop come from the kit (market/scenery.ts).
 */
const PALETTE = {
  tileA: "#e9e6df",
  tileB: "#dcd8cf",
  aisleTile: "#d3dbe0",
  wall: "#f2efe8",
  wallLow: "#d9d4ca",
  stripe: "#2e9a6f",
  stripeDark: "#23795a",
  ceiling: "#e8e8e4",
  beam: "#c9c9c4",
  frame: "#5d6670",
  frameDark: "#454c54",
  steel: "#c7cdd3",
  steelDark: "#9aa2aa",
  fridgeBody: "#f4f6f7",
  fridgeHeader: "#2f7fc0",
  fridgeInside: "#dfeef8",
  freezerBody: "#f1f3f4",
  freezerInside: "#cfe6f6",
  shelfMetal: "#d8dcdf",
  shelfBack: "#b9c1c7",
  plinth: "#59616a",
  header: "#2e9a6f",
  headerAlt: "#e2a13a",
  wood: "#c9995f",
  woodDark: "#9b7344",
  counter: "#3d6f8a",
  counterTop: "#e6e3dc",
  belt: "#2b2d30",
  register: "#3a3d42",
  rackOrange: "#e3812f",
  rackBlue: "#2f63a8",
  depotFloor: "#c9c6bd",
  sidewalk: "#c9c7c1",
  asphalt: "#5e6268",
  lines: "#f2f0e8",
  hedge: "#5f9a4e",
  glass: "#d6eef8",
  strip: "#cfe3ea",
  light: "#ffffff",
} as const;
const tint = (hex: string) => color(hex);
const sides = (base: Color, k = 0.86) => (f: Face) => (f === "bottom" ? null : f === "top" ? base : shade(base, f === "nx" || f === "nz" ? k : 0.94));
const H = MARKET.half,
  I = MARKET.inside,
  CEILING = MARKET.ceiling;

/** The floor: 0.6 m tiles in two tones, the depot plain, the aisles' runways a little cooler. */
function floor(m: Mesher) {
  const a = tint(PALETTE.tileA),
    b = tint(PALETTE.tileB),
    depot = tint(PALETTE.depotFloor),
    cell = 0.6;
  for (let x = -I; x < I - 1e-6; x += cell)
    for (let z = -I; z < I - 1e-6; z += cell) {
      const x1 = Math.min(I, x + cell),
        z1 = Math.min(I, z + cell),
        inDepot = x >= DEPOT.x[0] - 0.3 && z1 <= DEPOT.z[1] + 0.31,
        k = Math.round((x + I) / cell) + Math.round((z + I) / cell);
      m.quad([x, 0, z1], [x1, 0, z1], [x1, 0, z], [x, 0, z], inDepot ? shade(depot, k % 2 ? 1 : 0.97) : k % 2 ? a : b);
    }
  // Outside the shop front: the pavement, the car park and its lines, a hedge.
  m.quad([-30, 0, 13.2], [30, 0, 13.2], [30, 0, H], [-30, 0, H], tint(PALETTE.sidewalk));
  m.quad([-30, 0, 40], [30, 0, 40], [30, 0, 13.2], [-30, 0, 13.2], tint(PALETTE.asphalt));
  for (let x = -14; x <= 14; x += 2.8) m.decal([[x - 0.06, 15], [x + 0.06, 15], [x + 0.06, 20], [x - 0.06, 20]], 0.01, tint(PALETTE.lines));
  m.box([-30, 0, 13.2], [-1.0, 0.7, 13.9], sides(tint(PALETTE.hedge)));
  m.box([1.0, 0, 13.2], [30, 0.7, 13.9], sides(tint(PALETTE.hedge)));
}
/** A wall piece facing the shop (`inside` the side its face is on): plaster, a low skirting band, the brand stripe. */
function wallPiece(m: Mesher, c: ReturnType<typeof marketWallColliders>[number], along: "x" | "z", inside: "+" | "-", reveals = true) {
  const b = bounds(c),
    face = along === "x" ? (inside === "+" ? b.z1 : b.z0) : inside === "+" ? b.x1 : b.x0;
  const [s0, s1] = along === "x" ? [b.x0, b.x1] : [b.z0, b.z1];
  const strip = (y0: number, y1: number, hex: string) => {
    if (y1 <= b.y0 || y0 >= b.y1) return;
    const lo = Math.max(y0, b.y0),
      hi = Math.min(y1, b.y1),
      t = tint(hex);
    if (along === "x") m.faced([[s0, lo, face], [s1, lo, face], [s1, hi, face], [s0, hi, face]], [0, 0, inside === "+" ? 1 : -1], t);
    else m.faced([[face, lo, s0], [face, lo, s1], [face, hi, s1], [face, hi, s0]], [inside === "+" ? 1 : -1, 0, 0], t);
  };
  strip(0, 0.18, PALETTE.wallLow);
  strip(0.18, 2.9, PALETTE.wall);
  strip(2.9, 3.25, PALETTE.stripe);
  strip(3.25, CEILING + 0.5, PALETTE.wall);
  // Ends and tops of the pieces (door and window reveals).
  if (reveals) m.box([b.x0, b.y0, b.z0], [b.x1, b.y1, b.z1], (f) => (f === "px" || f === "nx" ? (along === "z" ? null : shade(tint(PALETTE.wallLow), 0.92)) : f === "pz" || f === "nz" ? (along === "x" ? null : shade(tint(PALETTE.wallLow), 0.92)) : f === "top" || f === "bottom" ? tint(PALETTE.wallLow) : null));
}
/** Shop-front frame: the low wall's top and dark mullions round every pane, glass in them. */
function shopFront(m: Mesher, glass: Mesher) {
  const dark = tint(PALETTE.frame);
  for (const c of marketWallColliders("front")) {
    const b = bounds(c);
    if (c.role === "glass") {
      glass.box([b.x0, b.y0, b.z0], [b.x1, b.y1, b.z1], (f) => (f === "top" || f === "bottom" ? null : tint(PALETTE.glass)));
      m.box([b.x0 - 0.06, b.y0 - 0.05, I - 0.04], [b.x1 + 0.06, b.y0, I + 0.04], sides(dark));
      m.box([b.x0 - 0.06, b.y1, I - 0.04], [b.x1 + 0.06, b.y1 + 0.06, I + 0.04], sides(dark));
      for (let x = b.x0; x <= b.x1 + 1e-6; x += (b.x1 - b.x0) / Math.max(1, Math.round((b.x1 - b.x0) / 1.4))) m.box([x - 0.04, b.y0, I - 0.04], [x + 0.04, b.y1, I + 0.04], sides(dark));
    } else wallPiece(m, c, "x", "-");
  }
  // The entrance doors' sliding leaves (a seam down the middle) and the sign box over them.
  const door = MARKET_OPENINGS.find((o) => o.label === "entrance doors")!;
  const mid = (door.span[0] + door.span[1]) / 2;
  m.box([mid - 0.03, door.bottom, I - 0.05], [mid + 0.03, door.top, I + 0.05], sides(dark));
  m.box([door.span[0] - 0.2, door.top + 0.3, I - 0.12], [door.span[1] + 0.2, door.top + 0.8, I], sides(tint(PALETTE.stripe)));
}
/** A depot doorway's frame and its PVC strip curtain (see-through strips; nothing solid). */
function doorway(m: Mesher, glass: Mesher, wall: MarketWallId, span: readonly [number, number], top: number) {
  const spec = MARKET_WALLS[wall],
    [a0, a1] = spec.across,
    dark = tint(PALETTE.frame);
  const box = (s0: number, s1: number, y0: number, y1: number, c0: number, c1: number, hex: Color, target = m) =>
    spec.along === "x" ? target.box([s0, y0, c0], [s1, y1, c1], sides(hex)) : target.box([c0, y0, s0], [c1, y1, s1], sides(hex));
  box(span[0] - 0.08, span[0], 0, top + 0.08, a0 - 0.02, a1 + 0.02, dark);
  box(span[1], span[1] + 0.08, 0, top + 0.08, a0 - 0.02, a1 + 0.02, dark);
  box(span[0] - 0.08, span[1] + 0.08, top, top + 0.08, a0 - 0.02, a1 + 0.02, dark);
  const mid = (a0 + a1) / 2;
  for (let s = span[0] + 0.02; s < span[1] - 0.05; s += 0.22) box(s, s + 0.18, 0.15, top, mid - 0.005, mid + 0.005, tint(PALETTE.strip), glass);
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

/** Upright glass-door fridges: white body, blue header, lit back, shelves; the doors are glass. */
function fridges(m: Mesher, glass: Mesher, lit: Mesher, f: Fixture) {
  const body = tint(PALETTE.fridgeBody),
    [x0, x1] = f.x,
    [z0, z1] = f.z,
    h = f.height;
  m.box([x0, 0, z0], [x1, 0.16, z1], sides(tint(PALETTE.plinth)));
  m.box([x0, h - 0.32, z0], [x1, h, z1], sides(tint(PALETTE.fridgeHeader)));
  m.box([x0, 0.16, z0], [x1, h - 0.32, z0 + 0.12], sides(body));
  m.quad([x1, 0, z1], [x1, 0, z0], [x1, h, z0], [x1, h, z1], shade(body, 0.92));
  m.quad([x0, 0, z0], [x0, 0, z1], [x0, h, z1], [x0, h, z0], shade(body, 0.88));
  lit.quad([x0, 0.16, z0 + 0.121], [x1, 0.16, z0 + 0.121], [x1, h - 0.32, z0 + 0.121], [x0, h - 0.32, z0 + 0.121], tint(PALETTE.fridgeInside));
  for (const y of FRIDGE_SHELVES) m.box([x0, y - 0.025, z0 + 0.12], [x1, y, z1 - 0.06], (face) => (face === "top" ? tint(PALETTE.shelfMetal) : face === "pz" ? tint(PALETTE.steelDark) : null));
  // Door frames every 1.0 m along the front; the glass in between.
  const doors = Math.round((x1 - x0) / 1.0);
  for (let k = 0; k <= doors; k++) {
    const x = x0 + ((x1 - x0) * k) / doors;
    m.box([x - 0.04, 0.16, z1 - 0.05], [x + 0.04, h - 0.32, z1], sides(tint(PALETTE.steel)));
  }
  glass.box([x0, 0.16, z1 - 0.04], [x1, h - 0.32, z1 - 0.02], (face) => (face === "pz" || face === "nz" ? tint(PALETTE.glass) : null));
}
export const FRIDGE_SHELVES = [0.2, 0.62, 1.04, 1.46, 1.84] as const;
/** A chest freezer: white tub, a darker rim, sliding glass lids, the cold blue inside. */
function freezer(m: Mesher, glass: Mesher, f: Fixture) {
  const [x0, x1] = f.x,
    [z0, z1] = f.z,
    h = f.height;
  m.box([x0, 0, z0], [x1, h, z1], (face) => (face === "top" ? null : face === "bottom" ? null : shade(tint(PALETTE.freezerBody), face === "nx" || face === "nz" ? 0.88 : 0.96)));
  m.box([x0, h - 0.06, z0], [x1, h, z0 + 0.08], sides(tint(PALETTE.steelDark)));
  m.box([x0, h - 0.06, z1 - 0.08], [x1, h, z1], sides(tint(PALETTE.steelDark)));
  m.box([x0, h - 0.06, z0], [x0 + 0.08, h, z1], sides(tint(PALETTE.steelDark)));
  m.box([x1 - 0.08, h - 0.06, z0], [x1, h, z1], sides(tint(PALETTE.steelDark)));
  m.decal([[x0 + 0.08, z0 + 0.08], [x1 - 0.08, z0 + 0.08], [x1 - 0.08, z1 - 0.08], [x0 + 0.08, z1 - 0.08]], FREEZER_FLOOR, tint(PALETTE.freezerInside));
  // The tub's inner walls (seen through the lids).
  const inner = shade(tint(PALETTE.freezerInside), 0.9),
    [a0, a1, b0, b1, y0] = [x0 + 0.08, x1 - 0.08, z0 + 0.08, z1 - 0.08, FREEZER_FLOOR];
  m.faced([[a0, y0, b0], [a1, y0, b0], [a1, h, b0], [a0, h, b0]], [0, 0, 1], inner);
  m.faced([[a0, y0, b1], [a1, y0, b1], [a1, h, b1], [a0, h, b1]], [0, 0, -1], inner);
  m.faced([[a0, y0, b0], [a0, y0, b1], [a0, h, b1], [a0, h, b0]], [1, 0, 0], inner);
  m.faced([[a1, y0, b0], [a1, y0, b1], [a1, h, b1], [a1, h, b0]], [-1, 0, 0], inner);
  for (let x = x0 + 0.08; x < x1 - 0.1; x += 1.0) glass.box([x, h - 0.02, z0 + 0.08], [Math.min(x1 - 0.08, x + 0.98), h - 0.01, z1 - 0.08], (face) => (face === "top" ? tint(PALETTE.glass) : null));
}
export const FREEZER_FLOOR = 0.55;
/** Shelf levels of the gondolas and the drinks wall (tops of the shelf boards). */
export const SHELF_LEVELS = [0.1, 0.58, 1.06, 1.54] as const;
/** A shelf unit: plinth, back panel, shelf boards on its open side(s), uprights, a header strip. */
function shelving(m: Mesher, f: Fixture, faces: readonly ("+x" | "-x")[], header: string) {
  const [x0, x1] = f.x,
    [z0, z1] = f.z,
    h = f.height,
    mid = (x0 + x1) / 2;
  const back = faces.length === 2 ? [mid - 0.05, mid + 0.05] : faces[0] === "-x" ? [x1 - 0.08, x1] : [x0, x0 + 0.08];
  m.box([back[0], 0, z0], [back[1], h - 0.18, z1], sides(tint(PALETTE.shelfBack)));
  m.box([x0, 0, z0], [x1, 0.1, z1], sides(tint(PALETTE.plinth)));
  m.box([x0, h - 0.18, z0], [x1, h, z1], (face) => (face === "bottom" ? null : face === "top" ? tint(PALETTE.shelfBack) : shade(tint(header), face === "nx" || face === "nz" ? 0.9 : 1)));
  for (const face of faces) {
    const [s0, s1] = face === "-x" ? [x0, back[0]] : [back[1], x1];
    for (const y of SHELF_LEVELS.slice(1)) m.box([s0, y - 0.03, z0], [s1, y, z1], (fc) => (fc === "top" ? tint(PALETTE.shelfMetal) : fc === "bottom" ? null : tint(PALETTE.steelDark)));
    // Price rails along the shelf fronts.
    const edge = face === "-x" ? s0 : s1;
    for (const y of SHELF_LEVELS) m.box([edge - 0.015, y - 0.07, z0], [edge + 0.015, y - 0.02, z1], sides(tint(PALETTE.lines)));
  }
  // Uprights at the ends and every 1.4 m, end panels.
  for (let z = z0; z <= z1 + 1e-6; z += (z1 - z0) / Math.round((z1 - z0) / 1.4)) m.box([x0, 0.1, z - 0.03], [x1, h - 0.18, z + 0.03], sides(tint(PALETTE.steel)));
}
/** The produce rack against the west wall: three sloping wooden tiers rising to the wall. */
function produceRack(m: Mesher, f: Fixture) {
  const [x0, x1] = f.x,
    [z0, z1] = f.z,
    wood = tint(PALETTE.wood),
    dark = tint(PALETTE.woodDark);
  for (const [k, [a0, a1, y0, y1]] of PRODUCE_TIERS.entries()) {
    // A solid step under each sloping tier (stepping up toward the wall), its lip in front.
    m.box([a1, 0, z0], [a0, y0, z1], (face) => (face === "top" || face === "bottom" ? null : shade(dark, face === "px" ? 1 : 0.9)));
    m.faced([[a0, y0, z0], [a1, y1, z0], [a1, y1, z1], [a0, y0, z1]], [0.4, 1, 0], k % 2 ? wood : shade(wood, 1.05));
    m.faced([[a0, y0, z0], [a1, y0, z0], [a1, y1, z0]], [0, 0, -1], dark);
    m.faced([[a0, y0, z1], [a1, y0, z1], [a1, y1, z1]], [0, 0, 1], dark);
    m.box([a0 - 0.04, y0 - 0.02, z0], [a0, y0 + 0.08, z1], sides(dark));
  }
  m.box([x0, 0, z0 - 0.04], [x1, f.height, z0], sides(dark));
  m.box([x0, 0, z1], [x1, f.height, z1 + 0.04], sides(dark));
  m.box([x0, f.height - 0.02, z0], [x0 + 0.12, f.height + 0.5, z1], sides(tint(PALETTE.stripe)));
}
/** The rack's tiers (x from its front edge back toward the wall, rising): [x0, x1, y0, y1]. */
export const PRODUCE_TIERS: readonly (readonly [number, number, number, number])[] = [
  [-9.7, -10.05, 0.5, 0.68],
  [-10.05, -10.38, 0.8, 0.98],
  [-10.38, -10.7, 1.1, 1.25],
];
/** A produce table: a wooden stand with a sloping top (crates of produce sit on it). */
function produceTable(m: Mesher, f: Fixture) {
  const [x0, x1] = f.x,
    [z0, z1] = f.z,
    wood = tint(PALETTE.wood),
    dark = tint(PALETTE.woodDark);
  m.box([x0 + 0.06, 0, z0 + 0.06], [x1 - 0.06, 0.62, z1 - 0.06], sides(dark));
  m.box([x0, 0.62, z0], [x1, f.height - 0.12, z1], sides(wood));
  m.box([x0, f.height - 0.12, z0], [x1, f.height, z1], (face) => (face === "bottom" ? null : face === "top" ? shade(wood, 1.06) : dark));
}
/** The watermelon heap's bin: a low wooden crate (the melons come from the kit, scenery.ts). */
function melonBin(m: Mesher, f: Fixture) {
  const [x0, x1] = f.x,
    [z0, z1] = f.z,
    wood = tint(PALETTE.wood),
    dark = tint(PALETTE.woodDark),
    h = MELON_BIN;
  for (const [a, b] of [
    [[x0, 0, z0], [x1, h, z0 + 0.06]],
    [[x0, 0, z1 - 0.06], [x1, h, z1]],
    [[x0, 0, z0], [x0 + 0.06, h, z1]],
    [[x1 - 0.06, 0, z0], [x1, h, z1]],
  ] as [V, V][])
    m.box(a, b, (face) => (face === "bottom" ? null : face === "top" ? dark : wood));
  m.decal([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], 0.12, shade(dark, 0.8));
  // A price sign on a stick.
  m.box([x1 - 0.05, 0, (z0 + z1) / 2 - 0.02], [x1 - 0.01, 1.35, (z0 + z1) / 2 + 0.02], sides(dark));
  m.box([x1 - 0.06, 1.15, (z0 + z1) / 2 - 0.3], [x1, 1.5, (z0 + z1) / 2 + 0.3], sides(tint(PALETTE.headerAlt)));
}
export const MELON_BIN = 0.45;
/** A checkout counter: the cabinet, the counter top, the belt, the register at the cashier's end. */
function checkout(m: Mesher, f: Fixture) {
  const [x0, x1] = f.x,
    [z0, z1] = f.z,
    h = f.height;
  m.box([x0, 0, z0], [x1, h - 0.06, z1], sides(tint(PALETTE.counter)));
  m.box([x0, h - 0.06, z0], [x1, h, z1], sides(tint(PALETTE.counterTop)));
  m.box([x0 + 0.12, h, z0 + 0.15], [x1 - 0.12, h + 0.03, z0 + 1.55], sides(tint(PALETTE.belt)));
  m.box([x0 + 0.05, h, z1 - 0.7], [x0 + 0.45, h + 0.32, z1 - 0.35], sides(tint(PALETTE.register)));
  m.box([x0 + 0.08, h + 0.32, z1 - 0.62], [x0 + 0.42, h + 0.36, z1 - 0.43], sides(tint(PALETTE.frameDark)));
  // The lane's number light on a pole.
  m.box([x1 - 0.06, h, z0 + 0.05], [x1 - 0.02, 2.4, z0 + 0.09], sides(tint(PALETTE.frame)));
  m.box([x1 - 0.12, 2.25, z0 - 0.05], [x1 + 0.04, 2.6, z0 + 0.19], sides(tint(PALETTE.stripe)));
}
/** The depot's pallet rack: orange uprights, blue beams, decks at 1.05 and 2.05 m. */
function palletRack(m: Mesher, f: Fixture) {
  const [x0, x1] = f.x,
    [z0, z1] = f.z,
    h = f.height,
    orange = tint(PALETTE.rackOrange),
    blue = tint(PALETTE.rackBlue);
  for (let x = x0; x <= x1 + 1e-6; x += (x1 - x0) / 4) for (const z of [z0 + 0.06, z1 - 0.06]) m.box([x - 0.05, 0, z - 0.05], [x + 0.05, h, z + 0.05], sides(orange));
  for (const y of PALLET_DECKS) {
    for (const z of [z0 + 0.06, z1 - 0.06]) m.box([x0, y - 0.12, z - 0.05], [x1, y, z + 0.05], sides(blue));
    m.box([x0, y - 0.02, z0], [x1, y, z1], (face) => (face === "top" ? tint(PALETTE.steelDark) : null));
  }
  m.quad([x0, 0, z0 + 0.01], [x1, 0, z0 + 0.01], [x1, h, z0 + 0.01], [x0, h, z0 + 0.01], shade(tint(PALETTE.wall), 0.85));
}
export const PALLET_DECKS = [0.12, 1.05, 2.05] as const;

/** The ceiling: plain panels, light strips over the aisles and the till, hanging aisle signs. */
function ceiling(m: Mesher, lit: Mesher) {
  m.faced([[-I, CEILING, -I], [I, CEILING, -I], [I, CEILING, I], [-I, CEILING, I]], [0, -1, 0], tint(PALETTE.ceiling));
  for (let x = -I + 1.5; x < I; x += 3) m.box([x - 0.1, CEILING - 0.18, -I], [x + 0.1, CEILING, I], (f) => (f === "top" ? null : tint(PALETTE.beam)));
  // Light strips: along every aisle, over the produce, the fridges and the tills, and in the depot.
  const strip = (x0: number, x1: number, z0: number, z1: number) => lit.box([x0, CEILING - 0.26, z0], [x1, CEILING - 0.2, z1], (f) => (f === "bottom" ? tint(PALETTE.light) : null));
  for (const [g0, g1] of [[-3.7, -1.1], [0, 2.6], [3.7, 6.3], [7.4, 10]] as const) strip((g0 + g1) / 2 - 0.15, (g0 + g1) / 2 + 0.15, -4.5, 4.5);
  for (const x of [-9, -6, -4.6]) strip(x - 0.15, x + 0.15, -5, 5);
  for (const z of [-8.6, 6.0, 8.2]) strip(-10, 3, z - 0.15, z + 0.15);
  strip(4.5, 10, 7.9, 8.2);
  strip(4.5, 10, -8.3, -8.0);
  // Aisle signs: a coloured board over each aisle on two chains.
  for (const [k, [g0, g1]] of ([[-3.7, -1.1], [0, 2.6], [3.7, 6.3], [7.4, 10]] as const).entries()) {
    const x = (g0 + g1) / 2,
      c = tint([PALETTE.stripe, PALETTE.headerAlt, PALETTE.fridgeHeader, "#d9473b"][k]);
    m.box([x - 0.9, 4.05, -0.05], [x + 0.9, 4.45, 0.05], sides(c));
    for (const dx of [-0.7, 0.7]) m.box([x + dx - 0.01, 4.45, -0.01], [x + dx + 0.01, CEILING - 0.18, 0.01], sides(tint(PALETTE.frame)));
  }
}

export function buildMarketArena(): PropArenaMeshes {
  const m = new Mesher(),
    glass = new Mesher(),
    lit = new Mesher();
  floor(m);
  for (const [id, along, inside] of [
    ["north", "x", "+"],
    ["west", "z", "+"],
    ["east", "z", "-"],
    ["depotS", "x", "-"],
    ["depotW", "z", "-"],
  ] as const)
    for (const c of marketWallColliders(id)) wallPiece(m, c, along, inside);
  // The depot's walls are seen from both sides.
  for (const [id, along] of [
    ["depotS", "x"],
    ["depotW", "z"],
  ] as const)
    for (const c of marketWallColliders(id)) wallPiece(m, c, along, "+", false);
  shopFront(m, glass);
  for (const o of MARKET_OPENINGS) if (o.kind === "door") doorway(m, glass, o.wall, o.span, o.top);
  ceiling(m, lit);
  for (const f of MARKET_FIXTURES) {
    if (f.kind === "fridge") fridges(m, glass, lit, f);
    else if (f.kind === "freezer") freezer(m, glass, f);
    else if (f.kind === "gondola") shelving(m, f, ["-x", "+x"], GONDOLAS.findIndex((g) => g[0] === f.x[0]) === 1 ? PALETTE.headerAlt : PALETTE.header);
    else if (f.kind === "wallShelf") shelving(m, f, ["-x"], PALETTE.fridgeHeader);
    else if (f.kind === "produceRack") produceRack(m, f);
    else if (f.kind === "produceTable") produceTable(m, f);
    else if (f.kind === "melonPile") melonBin(m, f);
    else if (f.kind === "checkout") checkout(m, f);
    else if (f.kind === "palletRack") palletRack(m, f);
  }
  const material = new MeshLambertMaterial({ vertexColors: true });
  const mesh = new Mesh(m.build(), material);
  mesh.name = "market-arena";
  mesh.matrixAutoUpdate = false;
  const glassMaterial = new MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.26, depthWrite: false, side: DoubleSide });
  const panes = new Mesh(glass.build(), glassMaterial);
  panes.name = "market-glass";
  panes.renderOrder = 3;
  panes.matrixAutoUpdate = false;
  const litMaterial = new MeshBasicMaterial({ vertexColors: true });
  const lights = new Mesh(lit.build(), litMaterial);
  lights.name = "market-lights";
  lights.matrixAutoUpdate = false;
  const group = new Group();
  group.name = "market-arena";
  group.add(mesh, panes, lights);
  return {
    group,
    triangles: m.triangles + glass.triangles + lit.triangles,
    dispose() {
      for (const x of [mesh, panes, lights]) x.geometry.dispose();
      material.dispose();
      glassMaterial.dispose();
      litMaterial.dispose();
    },
  };
}
export const MARKET_BACKGROUND = new Color("#cfe4f2");
