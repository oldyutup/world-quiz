import { BufferGeometry, Euler, Group, Matrix4, Mesh, MeshLambertMaterial, Quaternion, Vector3, type Object3D } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { BOMB_ARENA, CRATE_BLOCKS } from "../../../../shared/party-lab/maps/bomb";

/**
 * Bomba Sende's props from public/party-lab/maps/bomb/bomb-kit.glb
 * (scripts/build-party-lab-bomb-kit.mjs): the crates over their colliders (the only kit
 * piece inside the playground), low planters on the roof ledge outside the glass, and a few
 * clouds far out. Merged into two meshes (props, clouds): two draw calls, no physics, no
 * shadows, no per-frame work. The bomb and the slow traps' jaws are taken from the same kit
 * (BombVisuals: they move).
 *
 * Readability rules (bomb.test.ts checks them):
 * - inside the playground only the crates, each exactly over its collider;
 * - ledge decoration stays outside the perimeter and ≤ LEDGE_PROP_MAX tall, so it never
 *   hides a player or crowds the camera when it swings over the parapet;
 * - clouds keep ≥ CLOUD_CLEAR_RADIUS from the middle (the camera never gets past ~17 m).
 */
export const BOMB_KIT_URL = "/party-lab/maps/bomb/bomb-kit.glb";
export const LEDGE_PROP_MAX = 1.4;
export const CLOUD_CLEAR_RADIUS = 28;

export type BombKitNode = "Bomb" | "Crate" | "Pot" | "Bush" | "FlowerYellow" | "FlowerPurple" | "Cloud1" | "Cloud2" | "Cloud3" | "BearTrap";
export const BOMB_KIT_NODES: readonly BombKitNode[] = ["Bomb", "Crate", "Pot", "Bush", "FlowerYellow", "FlowerPurple", "Cloud1", "Cloud2", "Cloud3", "BearTrap"];
export type BombKit = Record<BombKitNode, BufferGeometry>;

export interface Placement {
  node: BombKitNode;
  /** Bottom-centre (the kit's pivot). */
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: readonly [number, number, number];
}

/** Crates: each crate collider filled with crates about 1.2 m long, stretched to fit exactly. */
export function cratePlacements(): Placement[] {
  const out: Placement[] = [];
  for (const b of CRATE_BLOCKS) {
    const sx = b.x[1] - b.x[0],
      sz = b.z[1] - b.z[0],
      alongX = sx >= sz,
      count = Math.max(1, Math.round((alongX ? sx : sz) / 1.2));
    for (let k = 0; k < count; k++) {
      const x = alongX ? b.x[0] + (sx * (k + 0.5)) / count : (b.x[0] + b.x[1]) / 2,
        z = alongX ? (b.z[0] + b.z[1]) / 2 : b.z[0] + (sz * (k + 0.5)) / count;
      out.push({ node: "Crate", x, y: 0, z, yaw: 0, scale: [alongX ? sx / count : sx, b.height, alongX ? sz : sz / count] });
    }
  }
  return out;
}

/** Planters on the roof ledge (between the parapet and the roof's edge): four corners, four mid-sides. */
export function ledgePlacements(): Placement[] {
  const out: Placement[] = [];
  const r = BOMB_ARENA.half + BOMB_ARENA.wall.thickness + BOMB_ARENA.ledge / 2;
  const spots: [number, number, "bush" | "flowers"][] = [
    [r, r, "bush"],
    [-r, r, "bush"],
    [r, -r, "bush"],
    [-r, -r, "bush"],
    [r, 4, "flowers"],
    [-r, -4, "flowers"],
    [4, -r, "flowers"],
    [-4, r, "flowers"],
  ];
  spots.forEach(([x, z, kind], k) => {
    const yaw = Math.abs(x) > Math.abs(z) ? Math.PI / 2 : 0;
    out.push({ node: "Pot", x, y: 0, z, yaw, scale: [1, 1, 1] });
    if (kind === "bush") out.push({ node: "Bush", x, y: 0.42, z, yaw: k * 1.3, scale: [0.9, 0.9, 0.9] });
    else
      for (let f = -1; f <= 1; f++) {
        const along = f * 0.42;
        out.push({ node: f === 0 ? "FlowerPurple" : "FlowerYellow", x: x + (yaw ? 0 : along), y: 0.42, z: z + (yaw ? along : 0), yaw: f, scale: [1, 1, 1] });
      }
  });
  return out;
}

/** Clouds far out round the roof, a little below and above it. */
export function cloudPlacements(): Placement[] {
  const nodes: BombKitNode[] = ["Cloud1", "Cloud2", "Cloud3"];
  return Array.from({ length: 10 }, (_, k) => {
    const a = (k / 10) * Math.PI * 2 + 0.3,
      r = 42 + (k % 3) * 7,
      s = 1.6 + (k % 4) * 0.45;
    return { node: nodes[k % 3], x: Math.cos(a) * r, y: -7 + (k % 5) * 2.2, z: Math.sin(a) * r, yaw: a * 2, scale: [s, s, s] as const };
  });
}

/** The kit's nodes as geometries (each one primitive, bottom-centre pivot). */
export function readBombKit(root: Object3D): BombKit {
  const kit = {} as BombKit;
  for (const node of BOMB_KIT_NODES) {
    const object = root.getObjectByName(node);
    const mesh = (object as Mesh | undefined)?.isMesh ? (object as Mesh) : (object?.children.find((c) => (c as Mesh).isMesh) as Mesh | undefined);
    if (!mesh) throw new Error(`bomb kit is missing ${node}`);
    kit[node] = mesh.geometry;
  }
  return kit;
}

const matrix = new Matrix4(),
  q = new Quaternion(),
  e = new Euler(),
  v = new Vector3(),
  s = new Vector3();
function merged(kit: BombKit, placements: readonly Placement[]) {
  const parts = placements.map((p) => {
    const g = kit[p.node].clone();
    // Keep only what the merge needs (the kit has POSITION / NORMAL / COLOR_0 only).
    matrix.compose(v.set(p.x, p.y, p.z), q.setFromEuler(e.set(0, p.yaw, 0)), s.set(...p.scale));
    g.applyMatrix4(matrix);
    return g;
  });
  const geometry = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  if (!geometry) throw new Error("bomb kit merge failed");
  geometry.computeBoundingSphere();
  return geometry;
}

export interface BombProps {
  group: Group;
  triangles: number;
  dispose(): void;
}
export function buildBombProps(kit: BombKit): BombProps {
  const props = new Mesh(merged(kit, [...cratePlacements(), ...ledgePlacements()]), new MeshLambertMaterial({ vertexColors: true }));
  props.name = "bomb-props";
  const clouds = new Mesh(merged(kit, cloudPlacements()), new MeshLambertMaterial({ vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0.25 }));
  clouds.name = "bomb-clouds";
  for (const mesh of [props, clouds]) mesh.matrixAutoUpdate = false;
  const group = new Group();
  group.name = "bomb-scenery";
  group.add(props, clouds);
  const count = (mesh: Mesh) => (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.getAttribute("position").count) / 3;
  return {
    group,
    triangles: count(props) + count(clouds),
    dispose() {
      for (const mesh of [props, clouds]) {
        mesh.geometry.dispose();
        (mesh.material as MeshLambertMaterial).dispose();
      }
    },
  };
}
