import { BufferGeometry, Color, CylinderGeometry, Float32BufferAttribute, IcosahedronGeometry, Matrix4, Mesh, MeshLambertMaterial, Quaternion, Vector3 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { mulberry32 } from "../../../../shared/party-lab/simulation/colors/layouts";

/**
 * "Prizma Meydanı": Renk Kaosu's background. Generated geometry only (no assets): pale
 * stone prisms floating far out, a few crystal shards and a low cloud bank under the
 * field — all merged into ONE mesh (one draw call), vertex coloured in desaturated stone
 * and white so the four gameplay colours stay the only strong colours on screen. No
 * collider, shadow or per-frame work.
 *
 * Readability rules (colors.test.ts): every vertex ≥ SCENERY_CLEAR_RADIUS from the axis (the
 * camera never gets further than ≈ 15 m out) and no top higher than SCENERY_TOP_MAX, so
 * nothing looms over the frame.
 */
export const SCENERY_CLEAR_RADIUS = 32;
export const SCENERY_TOP_MAX = 6;

export interface SceneryPiece {
  kind: "prism" | "shard" | "cloud";
  x: number;
  y: number;
  z: number;
  /** Radius (prisms, shards) or cloud size (m). */
  size: number;
  /** Height (prisms, shards). */
  height: number;
  tilt: number;
  spin: number;
  color: string;
}

/** The fixed layout (seeded, so every visit looks the same). */
export function sceneryPieces(): SceneryPiece[] {
  const random = mulberry32(4242),
    pieces: SceneryPiece[] = [];
  const stones = ["#ddd6cc", "#e6e0d7", "#d2cbc2", "#e9e4dd"];
  // Twelve low stone prisms floating around the square, 46–86 m out, tops within a few
  // metres of the field's level (small shapes on the horizon, never towers over it).
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2 + random() * 0.3,
      r = 46 + random() * 40,
      height = 2.5 + random() * 4;
    pieces.push({
      kind: "prism",
      x: Math.cos(angle) * r,
      z: Math.sin(angle) * r,
      y: -5 + random() * 6 - height / 2,
      size: 2 + random() * 2.6,
      height,
      tilt: (random() - 0.5) * 0.2,
      spin: random() * Math.PI,
      color: stones[i % stones.length],
    });
  }
  // Pale crystal shards floating between them (the "prism" in the name), faintly lilac.
  for (let i = 0; i < 8; i++) {
    const angle = random() * Math.PI * 2,
      r = 44 + random() * 36;
    pieces.push({
      kind: "shard",
      x: Math.cos(angle) * r,
      z: Math.sin(angle) * r,
      y: -5 + random() * 4,
      size: 0.7 + random() * 0.8,
      height: 2.5 + random() * 3.5,
      tilt: (random() - 0.5) * 0.6,
      spin: random() * Math.PI,
      color: i % 2 ? "#ece8f4" : "#e4e6f0",
    });
  }
  // A cloud bank under the field's level, 48–85 m out.
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2 + random() * 0.3,
      r = 48 + random() * 37;
    pieces.push({
      kind: "cloud",
      x: Math.cos(angle) * r,
      z: Math.sin(angle) * r,
      y: -9 + random() * 5,
      size: 3 + random() * 3.5,
      height: 0,
      tilt: 0,
      spin: random() * Math.PI,
      color: "#fbfaff",
    });
  }
  return pieces;
}

function pieceGeometry(piece: SceneryPiece): BufferGeometry[] {
  const place = (geometry: BufferGeometry, position: Vector3, scale: Vector3, tilt = 0, spin = 0) => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(Math.cos(spin), 0, Math.sin(spin)), tilt);
    return geometry.applyMatrix4(new Matrix4().compose(position, q, scale));
  };
  const at = new Vector3(piece.x, piece.y, piece.z);
  if (piece.kind === "prism") {
    // A hexagonal stone column, a little narrower at the bottom, with a flat top.
    const g = new CylinderGeometry(piece.size, piece.size * 0.8, piece.height, 6, 1).rotateY(piece.spin);
    return [place(g, at.clone().setY(piece.y + piece.height / 2), new Vector3(1, 1, 1), piece.tilt, piece.spin).toNonIndexed()];
  }
  if (piece.kind === "shard") {
    const g = new CylinderGeometry(0, piece.size, piece.height, 3, 1).rotateY(piece.spin);
    return [place(g, at.clone().setY(piece.y + piece.height / 2), new Vector3(1, 1, 1), piece.tilt, piece.spin).toNonIndexed()];
  }
  // Clouds: three flattened blobs.
  return [0, 1, 2].map((k) => {
    const g = new IcosahedronGeometry(piece.size * (1 - 0.2 * k), 1),
      offset = new Vector3(Math.cos(piece.spin + k * 2.1) * piece.size * 0.6 * k, 0, Math.sin(piece.spin + k * 2.1) * piece.size * 0.6 * k);
    return place(g, at.clone().add(offset), new Vector3(1, 0.42, 1));
  });
}

/** All pieces as one vertex-coloured, flat-shaded mesh. */
export function buildScenery() {
  const parts: BufferGeometry[] = [],
    color = new Color();
  for (const piece of sceneryPieces()) {
    color.set(piece.color);
    for (const g of pieceGeometry(piece)) {
      g.deleteAttribute("uv");
      const count = g.getAttribute("position").count,
        colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) colors.set([color.r, color.g, color.b], i * 3);
      g.setAttribute("color", new Float32BufferAttribute(colors, 3));
      g.computeVertexNormals();
      parts.push(g);
    }
  }
  const geometry = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  const mesh = new Mesh(geometry, new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.name = "prizma-scenery";
  mesh.matrixAutoUpdate = false;
  return mesh;
}
