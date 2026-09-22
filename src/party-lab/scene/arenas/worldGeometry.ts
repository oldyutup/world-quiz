import { BufferGeometry, Float32BufferAttribute } from "three";

export type Face = "px" | "nx" | "py" | "ny" | "pz" | "nz";
export const ALL_FACES: readonly Face[] = ["px", "nx", "py", "ny", "pz", "nz"];

type V3 = readonly [number, number, number];
// In-plane axes per face with u × v = outward normal, so quads wind counter-clockwise from outside.
const FRAMES: Record<Face, { n: V3; u: V3; v: V3 }> = {
  px: { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  nx: { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  py: { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  ny: { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  pz: { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  nz: { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Accumulates axis-aligned boxes/quads into one geometry with world-scaled UVs
 * (one texture tile per `tile` metres), so every surface of a material is a
 * single draw call and texel density matches across pieces.
 */
export class WorldGeometry {
  private positions: number[] = [];
  private normals: number[] = [];
  private uvs: number[] = [];
  private colors: number[] = [];
  private tinted = false;
  private indices: number[] = [];
  constructor(private readonly tile: number) {}

  /** `tint` (linear RGB 0–1) becomes a vertex colour, so differently tinted boxes share one draw call. */
  box(min: V3, max: V3, faces: readonly Face[] = ALL_FACES, tint: V3 = [1, 1, 1]) {
    if (tint.some((c) => c !== 1)) this.tinted = true;
    for (const face of faces) {
      const { n, u, v } = FRAMES[face];
      const corner = (su: number, sv: number): V3 => [0, 1, 2].map((axis) => {
        if (n[axis] !== 0) return n[axis] > 0 ? max[axis] : min[axis];
        const along = u[axis] !== 0 ? (u[axis] * su > 0 ? max[axis] : min[axis]) : v[axis] * sv > 0 ? max[axis] : min[axis];
        return along;
      }) as unknown as V3;
      this.quad([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], n, u, v, tint);
    }
    return this;
  }

  private quad(corners: V3[], n: V3, u: V3, v: V3, tint: V3) {
    const base = this.positions.length / 3;
    for (const p of corners) {
      this.positions.push(...p);
      this.normals.push(...n);
      this.colors.push(...tint);
      // Texture V runs downward in glTF-loaded images (flipY = false).
      this.uvs.push(dot(p, u) / this.tile, -dot(p, v) / this.tile);
    }
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  get empty() {
    return this.indices.length === 0;
  }

  build() {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("normal", new Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute("uv", new Float32BufferAttribute(this.uvs, 2));
    if (this.tinted) geometry.setAttribute("color", new Float32BufferAttribute(this.colors, 3));
    geometry.setIndex(this.indices);
    geometry.computeBoundingSphere();
    return geometry;
  }
}
