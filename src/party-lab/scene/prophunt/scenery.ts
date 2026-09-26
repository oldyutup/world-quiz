import { BoxGeometry, BufferGeometry, Color, CylinderGeometry, Euler, Float32BufferAttribute, Group, Matrix4, Mesh, MeshLambertMaterial, Quaternion, Vector3, type Object3D } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  CAMP,
  LOFT,
  OPENINGS,
  PORCH,
  PORCH_POST_Z,
  PORCH_POSTS,
  PORCH_RAIL_Z,
  PORCH_RAILS,
  SCENERY_PLACEMENTS,
  TENTS,
  WALLS,
  WOODPILE,
  sceneryCollider,
  type DecoyPlacement,
  type Tent,
} from "../../../../shared/party-lab/maps/propHunt";
import { PROP_FAMILIES, PROP_FAMILY_IDS, SCENERY, type PropFamilyId } from "../../../../shared/party-lab/maps/propHuntProps";

/**
 * Saklambaç's kit props (public/party-lab/maps/prop-hunt/prop-hunt-kit.glb, built by
 * scripts/build-party-lab-prop-hunt-kit.mjs): furniture and camp dressing, tents, the
 * architecture's details (door frames, window frames and shutters, the loft and porch
 * railings, the boundary fence), logs stacked on the woodpile, and the forest outside the
 * boundary, merged into two static meshes (camp, forest): two draw calls, no physics, no
 * shadows, no per-frame work. The round's decoys change every round: they are merged into a
 * third mesh of their own, rebuilt when a new layout is dealt (`buildDecoyGeometry`, drawn by
 * PropVisuals). The stair's steps are generated from its collider (arena.ts).
 *
 * The decoys and a disguised hider share `PROP_MATERIAL` and the kit's node geometry, so a
 * disguise is drawn exactly like the decoys of its family.
 *
 * Readability rules (prophunt.test.ts checks them):
 * - inside the play area, every kit piece with a collider stands exactly over it;
 * - trees keep ≥ TREE_CLEARANCE from the boundary, so no foliage hangs into the camp and a
 *   camera reaching out past an edge never ends up inside a canopy.
 */
export const PROP_KIT_URL = "/party-lab/maps/prop-hunt/prop-hunt-kit.glb";
/** Trees stand at least this far outside the boundary: the camera may reach ~5 m past it near an edge. */
export const TREE_CLEARANCE = 4.2;

export const PROP_KIT_NODES = [
  ...PROP_FAMILY_IDS.map((id) => PROP_FAMILIES[id].node),
  "Fireplace",
  "Couch",
  "DiningTable",
  "BunkBed",
  "Bookshelf",
  "ToolShelf",
  "KitchenSink",
  "KitchenDrawers",
  "KitchenOven",
  "Fridge",
  "FloorLamp",
  "HangingLamp",
  "Rug",
  "RugRound",
  "Bench",
  "Wagon",
  "Campfire",
  "Torch",
  "Axe",
  "Shovel",
  "Tent",
  "OakTree",
  "RockLarge",
  "Fern",
  "Agave",
  "Flowers",
  "Grass",
  "DoorFrame",
  "WindowWide",
  "WindowThin",
  "Shutters",
  "Railing",
  "Fence",
  "FenceExt",
  "Bracket",
] as const;
export type PropKitNode = (typeof PROP_KIT_NODES)[number];
export type PropKit = Record<PropKitNode, BufferGeometry>;

export interface Placement {
  node: PropKitNode;
  /** Bottom-centre (the kit's pivot). */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Lean about the model's own x axis (radians). */
  tilt?: number;
  scale: readonly [number, number, number];
}
const ONE = [1, 1, 1] as const;

/** One shared material for everything drawn from the kit, disguises included. */
export const PROP_MATERIAL = new MeshLambertMaterial({ vertexColors: true });

/** A layout's decoys, exactly over their colliders. */
export function decoyPlacements(decoys: readonly DecoyPlacement[]): Placement[] {
  return decoys.map((d) => ({ node: PROP_FAMILIES[d.family].node as PropKitNode, x: d.x, y: d.y, z: d.z, yaw: (d.turns * Math.PI) / 2, scale: ONE }));
}
/** Furniture and camp dressing (never transformable). */
export function furniturePlacements(): Placement[] {
  return SCENERY_PLACEMENTS.map((p) => ({ node: SCENERY[p.kind].node as PropKitNode, x: p.x, y: p.y, z: p.z, yaw: (p.turns * Math.PI) / 2, tilt: p.tilt, scale: p.scale ? [p.scale, p.scale, p.scale] : ONE }));
}
const ENTRANCE_YAW: Readonly<Record<Tent["entrance"], number>> = { "+z": 0, "+x": Math.PI / 2, "-z": Math.PI, "-x": -Math.PI / 2 };
export function tentPlacements(): Placement[] {
  return TENTS.map((t) => ({ node: "Tent", x: (t.x[0] + t.x[1]) / 2, y: 0, z: (t.z[0] + t.z[1]) / 2, yaw: ENTRANCE_YAW[t.entrance], scale: ONE }));
}
/** Door frames, window frames and shutters, the railings, the porch brackets. */
export function detailPlacements(): Placement[] {
  const out: Placement[] = [];
  for (const o of OPENINGS) {
    const wall = WALLS[o.wall],
      mid = (o.span[0] + o.span[1]) / 2,
      across = (wall.across[0] + wall.across[1]) / 2,
      x = wall.along === "x" ? mid : across,
      z = wall.along === "x" ? across : mid,
      yaw = wall.along === "x" ? 0 : Math.PI / 2,
      width = o.span[1] - o.span[0],
      height = o.top - o.bottom;
    if (o.kind === "door") out.push({ node: "DoorFrame", x, y: o.bottom - 0.02, z, yaw, scale: [(width + 0.4) / 2.6, (height + 0.25) / 2.85, 1] });
    else {
      const wide = width >= 1.1;
      out.push({ node: wide ? "WindowWide" : "WindowThin", x, y: o.bottom - 0.12, z, yaw, scale: [(width + 0.3) / (wide ? 1.5 : 1.0), (height + 0.25) / 1.45, 0.8] });
      // Open shutters on the lodge's south windows at ground level (the porch side).
      if (o.wall === "lodgeS" && o.bottom < 2) out.push({ node: "Shutters", x, y: o.bottom + 0.02, z: wall.across[1] + 0.08, yaw: 0, scale: [(width + 1.0) / 2.3, height / 1.3, 0.6] });
    }
  }
  // Loft rail: two sections along the loft's open edge.
  const [r0, r1] = LOFT.rail,
    section = (r1 - r0) / 2;
  for (let k = 0; k < 2; k++) out.push({ node: "Railing", x: LOFT.x[0] + 0.05, y: LOFT.top, z: r0 + section * (k + 0.5), yaw: Math.PI / 2, scale: [section / 2, LOFT.railHeight, 1] });
  // Porch rails between the posts.
  for (const [a, b] of PORCH_RAILS) {
    const n = Math.max(1, Math.round((b - a) / 2.2)),
      w = (b - a) / n;
    for (let k = 0; k < n; k++) out.push({ node: "Railing", x: a + w * (k + 0.5), y: PORCH.top, z: (PORCH_RAIL_Z[0] + PORCH_RAIL_Z[1]) / 2, yaw: 0, scale: [w / 2, PORCH.railHeight, 1] });
  }
  // Brackets under the porch roof at the posts.
  for (const [a, b] of PORCH_POSTS) out.push({ node: "Bracket", x: (a + b) / 2, y: PORCH.roof - 0.97, z: PORCH_POST_Z[0] - 0.02, yaw: Math.PI, scale: [1, 1, 0.55] });
  return out;
}
/** Logs stacked on the woodpile (three courses, filling its footprint). */
export function woodpileLogs(): Placement[] {
  const out: Placement[] = [],
    rows = 3,
    course = WOODPILE.top / rows,
    per = Math.floor((WOODPILE.z[1] - WOODPILE.z[0]) / 0.44),
    step = (WOODPILE.z[1] - WOODPILE.z[0]) / per,
    k = course / 0.46;
  for (let r = 0; r < rows; r++)
    for (let i = 0; i < per; i++) out.push({ node: "Log", x: (WOODPILE.x[0] + WOODPILE.x[1]) / 2 + (((i + r) % 3) - 1) * 0.02, y: r * course, z: WOODPILE.z[0] + step * (i + 0.5), yaw: 0, scale: [(WOODPILE.x[1] - WOODPILE.x[0]) / 1.5, k, (step / 0.46) * 0.98] });
  return out;
}
/** The split-rail fence just outside the south and east edges (behind the border bushes). */
export function fencePlacements(): Placement[] {
  const out: Placement[] = [],
    H = CAMP.half,
    edge = H + 0.2;
  const run = (from: number, to: number, fixed: number, alongX: boolean) => {
    const n = Math.round((to - from) / 2.35),
      w = (to - from) / n;
    for (let k = 0; k < n; k++) {
      const s = from + w * (k + 0.5);
      out.push({ node: k % 2 ? "FenceExt" : "Fence", x: alongX ? s : fixed, y: 0, z: alongX ? fixed : s, yaw: alongX ? 0 : Math.PI / 2, scale: [w / 2.35, 1, 1] });
    }
  };
  run(-6.2, H, edge, true);
  run(-5.5, H, edge, false);
  return out;
}
/**
 * The forest: two loose rows of trees outside the boundary — the near one pines (the sapling's
 * model at tree size) and broadleaf trees, the far one pines only (the cheaper model) — and a
 * few big rocks, all ≥ TREE_CLEARANCE from the play area. Deterministic.
 */
export function forestPlacements(): Placement[] {
  const out: Placement[] = [],
    H = CAMP.half;
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  for (const [ring, spacing, oaks] of [
    [H + 5.2, 5.8, 0.45],
    [H + 9.4, 9, 0],
  ] as const) {
    const n = Math.round((8 * ring) / spacing);
    for (let k = 0; k < n; k++) {
      // Walk the square's perimeter at this offset.
      const t = (k / n) * 8 * ring,
        side = Math.floor(t / (2 * ring)),
        s = (t % (2 * ring)) - ring + (random() - 0.5) * spacing * 0.5;
      const jitter = (random() - 0.5) * 1.2;
      const [x, z] = side === 0 ? [s, -ring - jitter] : side === 1 ? [ring + jitter, s] : side === 2 ? [-s, ring + jitter] : [-ring - jitter, -s];
      const pine = random() >= oaks,
        scale = pine ? 3.4 + random() * 1.2 : 0.95 + random() * 0.35;
      out.push({ node: pine ? "Sapling" : "OakTree", x, y: 0, z, yaw: random() * Math.PI * 2, scale: [scale, scale, scale] });
    }
  }
  for (const [x, z, s] of [
    [-15.6, 14.8, 1.1],
    [15.4, -15.2, 1.3],
    [15.3, 15.8, 0.9],
    [-15.5, -15.9, 1.2],
    [4.5, 15.6, 0.9],
    [15.8, 2.4, 1.0],
  ] as const)
    out.push({ node: "RockLarge", x, y: -0.2, z, yaw: x * 1.7, scale: [s, s, s] });
  return out;
}

/** The kit's nodes as geometries (each one primitive, bottom-centre pivot). */
export function readPropKit(root: Object3D): PropKit {
  const kit = {} as PropKit;
  for (const node of PROP_KIT_NODES) {
    const object = root.getObjectByName(node);
    const mesh = (object as Mesh | undefined)?.isMesh ? (object as Mesh) : (object?.children.find((c) => (c as Mesh).isMesh) as Mesh | undefined);
    if (!mesh) throw new Error(`prop hunt kit is missing ${node}`);
    kit[node] = mesh.geometry;
  }
  return kit;
}
/** The family's geometry for a disguise (the same one its decoys draw). */
export const familyGeometry = (kit: PropKit, family: PropFamilyId) => kit[PROP_FAMILIES[family].node as PropKitNode];

const matrix = new Matrix4(),
  q = new Quaternion(),
  e = new Euler(0, 0, 0, "YXZ"),
  v = new Vector3(),
  s = new Vector3();
function merged(kit: PropKit, placements: readonly Placement[]) {
  const parts = placements.map((p) => {
    const g = kit[p.node].clone();
    matrix.compose(v.set(p.x, p.y, p.z), q.setFromEuler(e.set(p.tilt ?? 0, p.yaw, 0)), s.set(...p.scale));
    g.applyMatrix4(matrix);
    return g;
  });
  const geometry = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  if (!geometry) throw new Error("prop hunt kit merge failed");
  geometry.computeBoundingSphere();
  return geometry;
}

export interface PropSceneryMeshes {
  group: Group;
  triangles: number;
  dispose(): void;
}
export function buildPropScenery(kit: PropKit): PropSceneryMeshes {
  const camp = new Mesh(merged(kit, [...furniturePlacements(), ...tentPlacements(), ...detailPlacements(), ...woodpileLogs(), ...fencePlacements()]), PROP_MATERIAL);
  camp.name = "prop-camp";
  const forest = new Mesh(merged(kit, forestPlacements()), PROP_MATERIAL);
  forest.name = "prop-forest";
  for (const mesh of [camp, forest]) mesh.matrixAutoUpdate = false;
  const group = new Group();
  group.name = "prop-scenery";
  group.add(camp, forest);
  const count = (mesh: Mesh) => (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.getAttribute("position").count) / 3;
  return {
    group,
    triangles: count(camp) + count(forest),
    dispose() {
      camp.geometry.dispose();
      forest.geometry.dispose();
    },
  };
}

/** A plain stand-in per family until the kit loads: its shape, in one neutral wood colour. */
export function fallbackFamilyGeometry(family: PropFamilyId): BufferGeometry {
  const shape = PROP_FAMILIES[family].shape;
  const g = (shape.kind === "box" ? new BoxGeometry(shape.x, shape.y, shape.z) : new CylinderGeometry(shape.radius, shape.radius, shape.height, 14)).translate(0, (shape.kind === "box" ? shape.y : shape.height) / 2, 0);
  const plain = g.toNonIndexed();
  g.dispose();
  const count = plain.getAttribute("position").count,
    colors = new Float32Array(count * 3),
    tint = new Color("#b98b5c");
  for (let i = 0; i < count; i++) tint.toArray(colors, i * 3);
  plain.setAttribute("color", new Float32BufferAttribute(colors, 3));
  return plain;
}
/**
 * A layout's decoys as one geometry: the kit's models (or, until the kit loads or if it never
 * does, each family's plain shape — an obstacle is never invisible).
 */
export function buildDecoyGeometry(kit: PropKit | null, decoys: readonly DecoyPlacement[]): BufferGeometry {
  if (kit) return merged(kit, decoyPlacements(decoys));
  const parts = decoys.map((d) => fallbackFamilyGeometry(d.family).applyMatrix4(matrix.compose(v.set(d.x, d.y, d.z), q.setFromEuler(e.set(0, (d.turns * Math.PI) / 2, 0)), s.set(1, 1, 1))));
  const geometry = mergeGeometries(parts, false)!;
  parts.forEach((g) => g.dispose());
  geometry.computeBoundingSphere();
  return geometry;
}
/** The blockout drawn until the kit loads (or if it fails): every furniture collider's shape (the decoys draw their own). */
export function buildBlockout(): PropSceneryMeshes {
  const parts: BufferGeometry[] = [];
  for (const p of SCENERY_PLACEMENTS) {
    const c = sceneryCollider(p);
    if (!c || c.shape !== "box") continue;
    const g = new BoxGeometry(c.half.x * 2, c.half.y * 2, c.half.z * 2).toNonIndexed().translate(c.center.x, c.center.y, c.center.z);
    const count = g.getAttribute("position").count,
      colors = new Float32Array(count * 3),
      tint = new Color("#9c8a74");
    for (let i = 0; i < count; i++) tint.toArray(colors, i * 3);
    g.setAttribute("color", new Float32BufferAttribute(colors, 3));
    parts.push(g);
  }
  const geometry = mergeGeometries(parts, false)!;
  parts.forEach((g) => g.dispose());
  const mesh = new Mesh(geometry, PROP_MATERIAL);
  mesh.name = "prop-blockout";
  const group = new Group();
  group.add(mesh);
  return { group, triangles: geometry.getAttribute("position").count / 3, dispose: () => geometry.dispose() };
}
