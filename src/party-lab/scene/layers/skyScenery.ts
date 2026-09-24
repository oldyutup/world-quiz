import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type Object3D,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * "Gök Petekleri": Katman Kaosu's background, a floating honeycomb high in the sky.
 * Visual only — no collider, rigid body or shadow; the gameplay tiles stay generated
 * (tileVisuals.ts) and are always the strongest thing on screen. Pieces come from
 * public/party-lab/maps/layers/layers-kit.glb (scripts/build-party-lab-layers-kit.mjs)
 * and are merged into two meshes (solid scenery, clouds): two draw calls.
 *
 * Readability rules (layers.test.ts checks them):
 * - nothing within SKY_CLEAR_RADIUS of the stack's axis: the chase camera never leaves
 *   ≈ 16 m, so scenery can never come between the camera and a tile or a player, never
 *   sits under a hole, never clips the camera and never looms at the frame's edge;
 * - the cloud sea and the broken stumps stay below the last layer (tops ≤ CLOUD_TOP_MAX); the
 *   islands and decorative hexes keep their tops clear of every layer's walking height, so
 *   nothing reads as a place to land;
 * - distance, fog, a paler palette and a mix toward the sky colour keep it low-contrast.
 */
export const LAYERS_KIT_URL = "/party-lab/maps/layers/layers-kit.glb";
export const SKY_COLOR = "#cfdff0";
/** Horizontal distance from the axis every scenery vertex keeps (m). */
export const SKY_CLEAR_RADIUS = 30;
/** Highest point of the cloud sea (m): well below the last layer (0 m). */
export const CLOUD_TOP_MAX = -1.2;
/** Vertical clearance of an island's or decorative hex's top from any layer's walking height (m). */
export const HEX_LAYER_CLEARANCE = 1.5;

export type SkyNode =
  | "Cloud1"
  | "Cloud2"
  | "Cloud3"
  | "IslandLarge"
  | "IslandMedium"
  | "IslandTall"
  | "Rock2"
  | "Tree"
  | "Bush"
  | "Column"
  | "ColumnDamaged"
  | "Obelisk"
  | "Ring"
  | "HexBlock"
  | "HexOverhang"
  | "Flag";
export const SKY_NODES: readonly SkyNode[] = [
  "Cloud1",
  "Cloud2",
  "Cloud3",
  "IslandLarge",
  "IslandMedium",
  "IslandTall",
  "Rock2",
  "Tree",
  "Bush",
  "Column",
  "ColumnDamaged",
  "Obelisk",
  "Ring",
  "HexBlock",
  "HexOverhang",
  "Flag",
];
export type SkyGroup = "cloud" | "island" | "ruin" | "flag" | "hex";

export interface SkyPiece {
  node: SkyNode;
  group: SkyGroup;
  /** Bottom-centre of the piece (the kit's pivot). */
  x: number;
  y: number;
  z: number;
  /** Turn about +y (rad). */
  yaw: number;
  /** Per-axis scale; a negative y hangs the piece upside down (an island's underside). */
  scale: readonly [number, number, number];
  /** Lean (rad) about the piece's own horizontal x axis (after the yaw). */
  tilt: number;
  /** Share of the way the colours are mixed toward the sky (aerial perspective), 0…1. */
  haze: number;
}

const rad = (degrees: number) => (degrees * Math.PI) / 180;
/** Polar placement: `angle` from +x toward +z (the spawns are at 0°, 120°, 240°). */
const polar = (angle: number, radius: number) => ({ x: radius * Math.cos(rad(angle)), z: radius * Math.sin(rad(angle)) });
const piece = (
  node: SkyNode,
  group: SkyGroup,
  angle: number,
  radius: number,
  y: number,
  scale: number | readonly [number, number, number],
  options: { yaw?: number; tilt?: number; haze?: number; dx?: number; dz?: number } = {}
): SkyPiece => {
  const at = polar(angle, radius);
  return {
    node,
    group,
    x: at.x + (options.dx ?? 0),
    y,
    z: at.z + (options.dz ?? 0),
    yaw: rad(options.yaw ?? 0),
    scale: typeof scale === "number" ? [scale, scale, scale] : scale,
    tilt: rad(options.tilt ?? 0),
    haze: options.haze ?? 0,
  };
};

// ─── Layout ─────────────────────────────────────────────────────────────────

/** Cloud sea: a few flattened clusters whose tops break through the haze floor (−4.2 m). */
const CLOUD_SEA: readonly SkyPiece[] = [
  { angle: 20, radius: 40, yaw: 20 },
  { angle: 95, radius: 48, yaw: 140 },
  { angle: 150, radius: 40, yaw: 75 },
  { angle: 212, radius: 54, yaw: 200 },
  { angle: 268, radius: 42, yaw: 310 },
  { angle: 330, radius: 58, yaw: 250 },
].flatMap(({ angle, radius, yaw }, i) => [
  piece("Cloud3", "cloud", angle, radius, -6.6, [6, 3, 6], { yaw }),
  piece(i % 2 ? "Cloud1" : "Cloud2", "cloud", angle + 8, radius + 7, -5.2, [4.5, 2.4, 4.5], { yaw: yaw + 60 }),
]);

/**
 * Distant floating islands (50–90 m, six): a rock platform over a craggy stone underside
 * (a boulder hung upside down), with a little vegetation or a ruin on top. Their tops sit
 * between the layer heights or high above them, never level with a walking surface.
 */
const ISLANDS: readonly SkyPiece[] = [
  // North-east: the big one, with the only tree.
  piece("IslandLarge", "island", 42, 64, 7.5, 3.4, { yaw: 30, haze: 0.15 }),
  piece("Rock2", "island", 42, 64, 7.7, [9, -6, 8], { yaw: 80, haze: 0.15 }),
  piece("Tree", "island", 42, 64, 13.4, 1.6, { dx: -1.5, dz: 1, yaw: 10, haze: 0.15 }),
  piece("Bush", "island", 42, 64, 13.4, 1.5, { dx: 3.2, dz: -1.5, haze: 0.15 }),
  // West, high and far.
  piece("IslandMedium", "island", 140, 66, 22, 3.8, { yaw: 60, haze: 0.25 }),
  piece("Rock2", "island", 140, 66, 22.2, [7, -5, 7], { yaw: 15, haze: 0.25 }),
  // South-west, low: a broken column on it.
  piece("IslandTall", "island", 203, 50, 2, 3.2, { yaw: 45, haze: 0.15 }),
  piece("Rock2", "island", 203, 50, 2.2, [4, -4.5, 4], { yaw: 120, haze: 0.15 }),
  piece("ColumnDamaged", "ruin", 203, 50, 8.7, 5, { dx: 0.4, yaw: 30, haze: 0.15 }),
  // South, far and hazy: an obelisk.
  piece("IslandLarge", "island", 283, 76, 0.5, 4.4, { yaw: 200, haze: 0.25 }),
  piece("Rock2", "island", 283, 76, 0.7, [11, -7, 10], { yaw: 250, haze: 0.25 }),
  piece("Obelisk", "ruin", 283, 76, 8.3, 7, { dx: -2, dz: 1, haze: 0.25 }),
  // East, high: the stone ring.
  piece("IslandMedium", "island", 346, 64, 25, 3, { yaw: 300, haze: 0.25 }),
  piece("Rock2", "island", 346, 64, 25.2, [3.6, -4, 3.6], { yaw: 10, haze: 0.25 }),
  piece("Ring", "ruin", 346, 64, 29.4, 4.5, { yaw: 76, haze: 0.25 }),
  // Far north-west, the sixth: a lone hazy rock.
  piece("IslandTall", "island", 246, 88, 15, [5, 4, 5], { yaw: 10, haze: 0.3 }),
  piece("Rock2", "island", 246, 88, 15.2, [5, -6, 5], { yaw: 70, haze: 0.3 }),
];

/**
 * Three ruined landmark columns rising out of the cloud sea between the spawns: each spawn
 * looks across the crown toward one. A pennant tops each. Plus two broken stumps.
 */
const LANDMARK_ANGLES = [60, 180, 300] as const;
const LANDMARK = { radius: 50, bottom: -7, width: 6.5, height: 20 } as const;
const RUINS: readonly SkyPiece[] = [
  ...LANDMARK_ANGLES.map((angle) =>
    piece("Column", "ruin", angle, LANDMARK.radius, LANDMARK.bottom, [LANDMARK.width, LANDMARK.height, LANDMARK.width], { yaw: angle, haze: 0.3 })
  ),
  piece("ColumnDamaged", "ruin", 112, 40, -8.5, [7, 10, 7], { yaw: 35, tilt: 6, haze: 0.1 }),
  piece("ColumnDamaged", "ruin", 232, 44, -8, [6, 8, 6], { yaw: 160, tilt: -5, haze: 0.1 }),
];
const FLAGS: readonly SkyPiece[] = LANDMARK_ANGLES.map((angle) =>
  piece("Flag", "flag", angle, LANDMARK.radius, LANDMARK.bottom + LANDMARK.height, 5, { yaw: angle + 90, haze: 0.2 })
);

/** Floating decorative hexes: tall grassy columns, tilted, with their tops between the layer heights. */
const HEXES: readonly SkyPiece[] = [
  piece("HexBlock", "hex", 8, 42, 6.5, 2.6, { yaw: 12, tilt: 8, haze: 0.1 }),
  piece("HexOverhang", "hex", 78, 46, 19.5, 3, { yaw: 40, tilt: -7, haze: 0.1 }),
  piece("HexBlock", "hex", 128, 40, 0, 2.2, { yaw: 5, tilt: 10, haze: 0.1 }),
  piece("HexOverhang", "hex", 172, 50, 11, 3.2, { yaw: 22, tilt: 6, haze: 0.1 }),
  piece("HexBlock", "hex", 250, 42, 5, 2.4, { yaw: 50, tilt: -9, haze: 0.1 }),
  piece("HexOverhang", "hex", 318, 48, 10.6, 2.8, { yaw: 18, tilt: 7, haze: 0.1 }),
];

export const SKY_PIECES: readonly SkyPiece[] = [...CLOUD_SEA, ...ISLANDS, ...RUINS, ...FLAGS, ...HEXES];

// ─── Building ───────────────────────────────────────────────────────────────

/** The kit's nodes (bottom-centred, vertex-coloured geometry), by name. */
export function readSkyKit(root: Object3D): Record<SkyNode, BufferGeometry> {
  const kit = {} as Record<SkyNode, BufferGeometry>;
  for (const name of SKY_NODES) {
    const node = root.getObjectByName(name);
    let geometry: BufferGeometry | undefined;
    node?.traverse((o) => {
      if ((o as Mesh).isMesh && !geometry) geometry = (o as Mesh).geometry;
    });
    if (!geometry) throw new Error(`layers-kit.glb is missing ${name}`);
    if (!geometry.getAttribute("color")) throw new Error(`layers-kit.glb ${name} has no vertex colours`);
    kit[name] = geometry;
  }
  return kit;
}

/** A piece's placement: yaw, then the lean, at its bottom-centre. */
export function pieceMatrix(p: SkyPiece) {
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), p.yaw);
  if (p.tilt) q.premultiply(new Quaternion().setFromAxisAngle(new Vector3(Math.cos(p.yaw), 0, -Math.sin(p.yaw)), p.tilt));
  return new Matrix4().compose(new Vector3(p.x, p.y, p.z), q, new Vector3(...p.scale));
}

/** One placed copy: float RGB colours mixed toward the sky, winding fixed for mirrored pieces. */
function placed(source: BufferGeometry, p: SkyPiece, sky: Color) {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", source.getAttribute("position").clone());
  geometry.setAttribute("normal", source.getAttribute("normal").clone());
  const color = source.getAttribute("color"),
    rgb = new Float32Array(color.count * 3);
  for (let i = 0; i < color.count; i++) {
    rgb[i * 3] = color.getX(i) + (sky.r - color.getX(i)) * p.haze;
    rgb[i * 3 + 1] = color.getY(i) + (sky.g - color.getY(i)) * p.haze;
    rgb[i * 3 + 2] = color.getZ(i) + (sky.b - color.getZ(i)) * p.haze;
  }
  geometry.setAttribute("color", new Float32BufferAttribute(rgb, 3));
  const index = Array.from(source.getIndex()!.array);
  const matrix = pieceMatrix(p);
  if (matrix.determinant() < 0) for (let i = 0; i < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
  geometry.setIndex(index);
  geometry.applyMatrix4(matrix);
  return geometry;
}

export interface SkyScenery {
  readonly group: Group;
  readonly drawCalls: number;
  readonly triangles: number;
  dispose(): void;
}

/**
 * Merges every piece into one solid mesh and one cloud mesh (flat pastel Lambert, fog on,
 * no shadows). Static: nothing is updated per frame.
 */
export function buildSkyScenery(kit: Record<SkyNode, BufferGeometry>, pieces: readonly SkyPiece[] = SKY_PIECES): SkyScenery {
  const sky = new Color(SKY_COLOR);
  const group = new Group();
  group.name = "sky-scenery";
  const parts: Record<"solid" | "cloud", BufferGeometry[]> = { solid: [], cloud: [] };
  for (const p of pieces) parts[p.group === "cloud" ? "cloud" : "solid"].push(placed(kit[p.node], p, sky));
  const materials = {
    solid: new MeshLambertMaterial({ vertexColors: true }),
    // Clouds glow a little so their undersides stay soft rather than grey.
    cloud: new MeshLambertMaterial({ vertexColors: true, emissive: new Color("#e9eef7"), emissiveIntensity: 0.35 }),
  };
  const meshes: Mesh[] = [];
  let triangles = 0;
  for (const kind of ["solid", "cloud"] as const) {
    if (!parts[kind].length) continue;
    const merged = mergeGeometries(parts[kind]);
    parts[kind].forEach((g) => g.dispose());
    if (!merged) throw new Error(`sky scenery: could not merge ${kind}`);
    merged.computeBoundingSphere();
    triangles += merged.getIndex()!.count / 3;
    const mesh = new Mesh(merged, materials[kind]);
    mesh.name = `sky-${kind}`;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = mesh.receiveShadow = false;
    // After the tiles and players: whatever they cover is rejected by the depth test.
    mesh.renderOrder = 1;
    group.add(mesh);
    meshes.push(mesh);
  }
  return {
    group,
    drawCalls: meshes.length,
    triangles,
    dispose() {
      for (const mesh of meshes) mesh.geometry.dispose();
      materials.solid.dispose();
      materials.cloud.dispose();
    },
  };
}
