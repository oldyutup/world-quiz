import { BufferGeometry, Color, Euler, Float32BufferAttribute, Group, InstancedMesh, Matrix4, Mesh, Quaternion, Vector3, type Object3D } from "three";
import { BoxGeometry } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { MARKET_FIXTURES, fixtureCollider, type Fixture } from "../../../../../shared/party-lab/maps/market";
import { MARKET_FAMILY_IDS, PROP_FAMILIES } from "../../../../../shared/party-lab/maps/propHuntProps";
import { PROP_MATERIAL, type PropSceneryMeshes } from "../scenery";
import { FREEZER_FLOOR, FRIDGE_SHELVES, MELON_BIN, PALLET_DECKS, PRODUCE_TIERS, SHELF_LEVELS } from "./arena";

/**
 * Market's kit (public/party-lab/maps/prop-hunt/market-kit.glb, built by
 * scripts/build-party-lab-market-kit.mjs from Kenney's CC0 Food and Furniture kits): the twelve
 * transformable families and the stock — cans, bottles, cartons, breakfast boxes, fruit and veg,
 * ice cream. The stock fills the fixtures the arena draws (market/arena.ts): every product one
 * InstancedMesh (≈ 40 draw calls for ≈ 2,400 products), no physics, no shadows, no per-frame
 * work. The round's decoys and a disguise draw the families' nodes (PropVisuals), so a hider
 * looks exactly like the decoys of its kind; the watermelon heap and the depot's rack hold the
 * same models as the families (a melon beside the heap is one of the heap).
 *
 * The kit has no normals (flat faces): they are computed on load (non-indexed, one per face).
 */
export const MARKET_KIT_URL = "/party-lab/maps/prop-hunt/market-kit.glb";
const FRUIT = ["Apple", "Orange", "Lemon", "Tomato", "Pear", "Paprika", "Eggplant", "Onion", "Cabbage", "Pineapple", "Banana", "Corn", "Broccoli", "Coconut"] as const;
const CANS = ["Can", "CanSmall", "Honey", "PeanutButter", "Ketchup", "Mustard"] as const;
const BREAKFAST = ["CerealRed", "CerealYellow", "CerealBlue", "CerealGreen", "Pasta", "Tea", "Loaf"] as const;
const SNACKS = ["Honey", "PeanutButter", "Pudding", "Tea", "OilBottle", "Pasta", "Can"] as const;
const DRINKS = ["SodaBottle", "SodaBig", "SodaCan", "WineRed", "WineWhite", "OilBottle", "Carton"] as const;
const CHILLED = ["Carton", "CartonSmall", "SodaCan", "Pudding", "SodaBottle"] as const;
export const MARKET_KIT_NODES = [...MARKET_FAMILY_IDS.map((id) => PROP_FAMILIES[id].node), ...new Set([...CANS, ...BREAKFAST, ...SNACKS, ...DRINKS, ...CHILLED, ...FRUIT, "IceCream"])] as const;
export type MarketKit = Readonly<Record<string, BufferGeometry>>;

/** The kit's nodes as flat-shaded, non-indexed geometries (bottom-centre pivots). */
export function readMarketKit(root: Object3D): MarketKit {
  const kit: Record<string, BufferGeometry> = {};
  for (const node of MARKET_KIT_NODES) {
    const object = root.getObjectByName(node);
    const mesh = (object as Mesh | undefined)?.isMesh ? (object as Mesh) : (object?.children.find((c) => (c as Mesh).isMesh) as Mesh | undefined);
    if (!mesh) throw new Error(`market kit is missing ${node}`);
    const flat = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    flat.computeVertexNormals();
    flat.computeBoundingBox();
    kit[node] = flat;
  }
  return kit;
}

/** One product: a kit node, its bottom-centre and yaw (radians), scale. */
export interface Stock {
  node: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale?: number;
}
/** Deterministic 0…1 sequence (the shop is stocked the same every time). */
function sequence(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}
/** A shelf run along z (`x`: the products' line, `yaw` facing the aisle): blocks of 3–6 facings of one product. */
function shelfRun(out: Stock[], kit: MarketKit, nodes: readonly string[], x: number, y: number, z0: number, z1: number, yaw: number, random: () => number) {
  let z = z0 + 0.06;
  while (z < z1 - 0.1) {
    const node = nodes[Math.floor(random() * nodes.length)],
      box = kit[node].boundingBox!,
      width = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) + 0.025,
      facings = 3 + Math.floor(random() * 4);
    for (let k = 0; k < facings && z + width / 2 < z1 - 0.04; k++) {
      out.push({ node, x, y, z: z + width / 2, yaw: yaw + (random() - 0.5) * 0.12 });
      z += width;
    }
    z += 0.04;
  }
}
/** The same along x (fridges: `z` the line, facing +z). */
function shelfRunX(out: Stock[], kit: MarketKit, nodes: readonly string[], z: number, y: number, x0: number, x1: number, random: () => number) {
  let x = x0 + 0.06;
  while (x < x1 - 0.1) {
    const node = nodes[Math.floor(random() * nodes.length)],
      box = kit[node].boundingBox!,
      width = box.max.x - box.min.x + 0.03,
      facings = 3 + Math.floor(random() * 4);
    for (let k = 0; k < facings && x + width / 2 < x1 - 0.04; k++) {
      out.push({ node, x: x + width / 2, y, z, yaw: (random() - 0.5) * 0.15 });
      x += width;
    }
    x += 0.05;
  }
}
const STOCK_OF: Readonly<Record<string, readonly string[]>> = { cans: CANS, breakfast: BREAKFAST, snacks: SNACKS, drinks: DRINKS };

/** Everything the fixtures hold (deterministic). */
export function stockPlacements(kit: MarketKit): Stock[] {
  const out: Stock[] = [],
    random = sequence(41);
  for (const f of MARKET_FIXTURES) {
    const [x0, x1] = f.x,
      [z0, z1] = f.z;
    if (f.kind === "gondola" || f.kind === "wallShelf") {
      const nodes = STOCK_OF[f.stock ?? "cans"];
      const faces = f.kind === "gondola" ? (["-x", "+x"] as const) : (["-x"] as const);
      for (const face of faces)
        for (const y of SHELF_LEVELS) {
          const x = face === "-x" ? x0 + 0.2 : x1 - 0.2;
          shelfRun(out, kit, nodes, x, y, z0, z1, face === "-x" ? -Math.PI / 2 : Math.PI / 2, random);
        }
    } else if (f.kind === "fridge") for (const y of FRIDGE_SHELVES) shelfRunX(out, kit, CHILLED, (z0 + z1) / 2 + 0.1, y, x0, x1, random);
    else if (f.kind === "freezer")
      for (let x = x0 + 0.2; x < x1 - 0.15; x += 0.17) for (let z = z0 + 0.2; z < z1 - 0.15; z += 0.19) out.push({ node: "IceCream", x, y: FREEZER_FLOOR, z, yaw: random() * 0.6 });
    else if (f.kind === "produceRack") produce(out, f, random);
    else if (f.kind === "produceTable") {
      // Crates of produce on the table (the families' crates at a little over half size).
      const crates = ["AppleCrate", "OrangeCrate"];
      for (let i = 0; i < 2; i++)
        for (let k = 0; k < 4; k++) out.push({ node: crates[(i + k) % 2], x: x0 + 0.27 + i * 0.46, y: f.height, z: z0 + 0.36 + k * 0.63, yaw: Math.PI / 2, scale: 0.55 });
    } else if (f.kind === "melonPile") {
      const cx = (x0 + x1) / 2,
        cz = (z0 + z1) / 2;
      for (const [dx, dz, y, yaw] of [
        [-0.5, -0.38, 0.1, 1.5],
        [0, -0.38, 0.1, 1.62],
        [0.5, -0.38, 0.1, 1.48],
        [-0.5, 0.38, 0.1, 1.66],
        [0, 0.38, 0.1, 1.52],
        [0.5, 0.38, 0.1, 1.6],
        [-0.26, 0, 0.44, 1.58],
        [0.26, 0, 0.44, 1.5],
      ] as const)
        out.push({ node: "Watermelon", x: cx + dx, y: Math.max(y, MELON_BIN * 0.2), z: cz + dz, yaw });
    } else if (f.kind === "palletRack")
      for (const y of PALLET_DECKS) for (let x = x0 + 0.5; x < x1 - 0.4; x += 0.92) out.push({ node: random() < 0.2 ? "DrinkCrate" : "Parcel", x, y, z: (z0 + z1) / 2, yaw: random() < 0.5 ? 0 : Math.PI });
    else if (f.kind === "checkout") {
      // A shopper's things on the belt.
      const n = 1 + Math.floor(random() * 3);
      for (let k = 0; k < n; k++) out.push({ node: [...CHILLED, "Can", "SodaBottle", "Loaf"][Math.floor(random() * 8)], x: (x0 + x1) / 2 + (random() - 0.5) * 0.3, y: f.height + 0.03, z: z0 + 0.4 + k * 0.35, yaw: random() * Math.PI });
    }
  }
  return out;
}
/** The produce rack's tiers: a section of one kind of fruit or veg every 1.2 m, two rows per tier. */
function produce(out: Stock[], f: Fixture, random: () => number) {
  const [z0, z1] = f.z;
  PRODUCE_TIERS.forEach(([a0, a1, y0, y1], tier) => {
    for (let z = z0 + 0.1; z < z1 - 0.08; ) {
      const node = FRUIT[Math.floor(random() * FRUIT.length)],
        end = Math.min(z1 - 0.06, z + 1.1),
        step = node === "Cabbage" || node === "Pineapple" ? 0.26 : node === "Banana" || node === "Eggplant" || node === "Broccoli" || node === "Corn" ? 0.18 : 0.13;
      for (; z < end; z += step)
        for (const t of [0.28, 0.72]) {
          const x = a0 + (a1 - a0) * t,
            y = y0 + (y1 - y0) * t;
          out.push({ node, x, y: y - 0.02, z, yaw: random() * Math.PI * 2 });
        }
      z = end + 0.06;
    }
    void tier;
  });
}

const matrix = new Matrix4(),
  q = new Quaternion(),
  e = new Euler(0, 0, 0, "YXZ"),
  v = new Vector3(),
  s = new Vector3();
/** The stock as one InstancedMesh per product. */
export function buildMarketScenery(kit: MarketKit): PropSceneryMeshes {
  const group = new Group();
  group.name = "market-stock";
  const byNode = new Map<string, Stock[]>();
  for (const p of stockPlacements(kit)) (byNode.get(p.node) ?? byNode.set(p.node, []).get(p.node)!).push(p);
  let triangles = 0;
  const meshes: InstancedMesh[] = [];
  for (const [node, list] of byNode) {
    const geometry = kit[node],
      mesh = new InstancedMesh(geometry, PROP_MATERIAL, list.length);
    list.forEach((p, i) => mesh.setMatrixAt(i, matrix.compose(v.set(p.x, p.y, p.z), q.setFromEuler(e.set(0, p.yaw, 0)), s.setScalar(p.scale ?? 1))));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.name = `stock-${node}`;
    mesh.matrixAutoUpdate = false;
    meshes.push(mesh);
    group.add(mesh);
    triangles += (geometry.getAttribute("position").count / 3) * list.length;
  }
  return { group, triangles, dispose: () => meshes.forEach((m) => m.dispose()) };
}

/** Until the kit loads: nothing to draw beyond the arena's own fixtures (the stock is decoration). */
export function buildMarketBlockout(): PropSceneryMeshes {
  const parts: BufferGeometry[] = [];
  // The melon heap as one plain mound, so the heap is never a hole.
  for (const f of MARKET_FIXTURES) {
    if (f.kind !== "melonPile") continue;
    const c = fixtureCollider(f);
    const g = new BoxGeometry(c.half.x * 1.8, 0.5, c.half.z * 1.8).toNonIndexed().translate(c.center.x, MELON_BIN + 0.1, c.center.z);
    const count = g.getAttribute("position").count,
      colors = new Float32Array(count * 3),
      tint = new Color("#3f8f4a");
    for (let i = 0; i < count; i++) tint.toArray(colors, i * 3);
    g.setAttribute("color", new Float32BufferAttribute(colors, 3));
    parts.push(g);
  }
  const geometry = mergeGeometries(parts, false)!;
  parts.forEach((g) => g.dispose());
  const mesh = new Mesh(geometry, PROP_MATERIAL);
  mesh.name = "market-blockout";
  const group = new Group();
  group.add(mesh);
  return { group, triangles: geometry.getAttribute("position").count / 3, dispose: () => geometry.dispose() };
}
