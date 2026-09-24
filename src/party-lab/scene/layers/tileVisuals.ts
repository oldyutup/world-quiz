import {
  BufferGeometry,
  CircleGeometry,
  Color,
  DynamicDrawUsage,
  Euler,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  RingGeometry,
  Vector3,
} from "three";
import { HEX, LAYER_INDICES, LAYER_TILES, LAYER_TOPS } from "../../../../shared/party-lab/maps/layers";
import type { TileStage, TileView } from "../../../../shared/party-lab/simulation/layers/timeline";
import { LAYER_CAMERA } from "./layerCamera";

/** Generated low-poly look (no textures): pastel stone per layer. */
export const LAYER_COLORS = ["#f2e1c1", "#bfe6cf", "#bdc6f1", "#f6c7a8"] as const;
const WARN_TINT = new Color("#fff6de");
const CRACK_TINT = new Color("#f0a04b");
const BREAK_TINT = new Color("#e4553a");
const CRACK_INK = "vec3(0.17, 0.10, 0.08)";
/** Seconds a GONE tile's piece falls, tumbles, shrinks and fades. */
export const DEBRIS_SECONDS = 0.6;
const DEBRIS_CAPACITY = 64;

// ─── Geometry ───────────────────────────────────────────────────────────────

type V = [number, number, number];
/**
 * One hex tile, walking surface at y = 0: a flat top inset for the 6 cm groove, a
 * bevelled rim, straight sides and a narrower underside. Flat-shaded, with a grey
 * vertex shade per band that the per-tile colour multiplies (the light top, a
 * brighter bevel, darker sides and underside).
 */
function tileGeometry() {
  const apothem = HEX.width / 2 - HEX.groove / 2;
  const bands: [number, number][] = [
    [apothem - 0.05, 0],
    [apothem, -0.05],
    [apothem, -HEX.thickness + 0.08],
    [apothem - 0.1, -HEX.thickness],
  ];
  const shades = [1.08, 0.8, 0.62];
  const ring = ([a, y]: [number, number]) =>
    Array.from({ length: 6 }, (_, k): V => {
      const angle = ((30 + 60 * k) * Math.PI) / 180,
        r = a / Math.cos(Math.PI / 6);
      return [r * Math.cos(angle), y, r * Math.sin(angle)];
    });
  const rings = bands.map(ring);
  const positions: number[] = [],
    normals: number[] = [],
    colors: number[] = [];
  const triangle = (a: V, b: V, c: V, outward: V, shade: number) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n: V = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] < 0) {
      [b, c] = [c, b];
      n = [-n[0], -n[1], -n[2]];
    }
    const l = Math.hypot(...n);
    for (const p of [a, b, c]) {
      positions.push(...p);
      normals.push(n[0] / l, n[1] / l, n[2] / l);
      colors.push(shade, shade, shade);
    }
  };
  const fan = (corners: V[], outward: V, shade: number) => {
    for (let k = 1; k < 5; k++) triangle(corners[0], corners[k], corners[k + 1], outward, shade);
  };
  fan(rings[0], [0, 1, 0], 1);
  for (let i = 0; i < 3; i++)
    for (let k = 0; k < 6; k++) {
      const a = rings[i][k],
        b = rings[i][(k + 1) % 6],
        c = rings[i + 1][(k + 1) % 6],
        d = rings[i + 1][k];
      const mid: V = [(a[0] + b[0]) / 2, 0, (a[2] + b[2]) / 2];
      triangle(a, b, c, mid, shades[i]);
      triangle(a, c, d, mid, shades[i]);
    }
  fan(rings[3], [0, -1, 0], 0.5);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

// ─── Material: per-tile cracks, rim glow and fade in the shader ─────────────

/**
 * Per instance `tileState` = (crack level 0…2, rim glow −1…1, seed, alpha). Cracks are
 * drawn on the top from the level (radial, more and longer when breaking); a positive
 * glow lights the rim warm (armed), a negative one red (collapse warning). No
 * textures and no extra draw calls.
 */
function tileMaterial(transparent: boolean) {
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, transparent, depthWrite: !transparent });
  material.customProgramCacheKey = () => "party-lab-layer-tile";
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute vec4 tileState;
varying vec4 vTileState;
varying vec3 vTileLocal;
varying float vTileTop;`
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vTileState = tileState;
vTileLocal = position;
vTileTop = normal.y;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec4 vTileState;
varying vec3 vTileLocal;
varying float vTileTop;
float tileApothem(vec2 p) {
  return max(abs(p.x), max(abs(dot(p, vec2(0.5, 0.8660254))), abs(dot(p, vec2(-0.5, 0.8660254)))));
}
float tileCracks(vec2 p, float level, float seed) {
  vec2 d = p - vec2(sin(seed * 12.9898), cos(seed * 78.233)) * 0.22;
  float r = length(d);
  float spokes = level > 1.0 ? 7.0 : 5.0;
  float u = atan(d.y, d.x) / 6.2831853 * spokes + seed * 3.7 + sin(r * 7.0 + seed * 11.0) * 0.12;
  float f = fract(u);
  float across = min(f, 1.0 - f) * 6.2831853 / spokes * r;
  float reach = 0.3 + 0.55 * min(level, 1.0) + 0.35 * max(level - 1.0, 0.0);
  float width = 0.024 * (1.0 - 0.55 * r / max(reach, 0.01));
  float spoke = (1.0 - smoothstep(width, width + 0.012, across)) * step(r, reach);
  float ring = level > 1.0 ? (1.0 - smoothstep(0.012, 0.024, abs(r - 0.5))) * step(0.4, fract(u * 0.5 + seed)) : 0.0;
  return clamp(max(spoke, ring), 0.0, 1.0);
}`
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
if (vTileTop > 0.5 && vTileState.x > 0.0)
  diffuseColor.rgb = mix(diffuseColor.rgb, ${CRACK_INK}, tileCracks(vTileLocal.xz, vTileState.x, vTileState.z) * 0.92);
diffuseColor.a *= vTileState.w;`
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
if (vTileTop > 0.5 && vTileState.y != 0.0) {
  // Armed: a warm rim. Collapse warning: a wider, stronger red band.
  bool doomed = vTileState.y < 0.0;
  float rim = doomed ? smoothstep(0.42, 0.86, tileApothem(vTileLocal.xz)) : smoothstep(0.62, 0.9, tileApothem(vTileLocal.xz));
  vec3 glow = doomed ? vec3(1.0, 0.16, 0.1) : vec3(1.0, 0.92, 0.7);
  totalEmissiveRadiance += glow * rim * abs(vTileState.y) * (doomed ? 1.2 : 0.85);
}`
      );
  };
  return material;
}

function instanced(geometry: BufferGeometry, material: MeshStandardMaterial, count: number) {
  const g = geometry.clone();
  g.setAttribute("tileState", new InstancedBufferAttribute(new Float32Array(count * 4), 4).setUsage(DynamicDrawUsage));
  const mesh = new InstancedMesh(g, material, count);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(count * 3), 3).setUsage(DynamicDrawUsage);
  // Tiles move (sink, fall); the whole field is always near the camera anyway.
  mesh.frustumCulled = false;
  return mesh;
}

const seedOf = (id: number) => ((id * 0.618034) % 1) + 0.05;
const ZERO = new Matrix4().makeScale(0, 0, 0);

interface Debris {
  id: number;
  age: number;
  from: Matrix4;
  color: Color;
  axis: Vector3;
  spin: number;
}
export type LandingMarker =
  | { kind: "none" }
  | { kind: "safe"; tile: number; x: number; z: number }
  | { kind: "danger"; x: number; y: number; z: number };

/**
 * Katman Kaosu's tiles as one InstancedMesh per layer (4 draw calls for 297 tiles),
 * plus one pooled mesh for falling pieces and a landing marker. Presentation only:
 * it reads the shared tile field and never touches physics.
 */
export class LayerTileVisuals {
  readonly group = new Group();
  readonly layers: InstancedMesh[];
  private readonly materials: MeshStandardMaterial[];
  private readonly debrisMesh: InstancedMesh;
  private readonly debris: Debris[] = [];
  /** Index of a tile inside its layer's mesh. */
  private readonly slot = new Int32Array(LAYER_TILES.length);
  private readonly shown: (TileStage | null)[] = LAYER_TILES.map(() => null);
  private readonly base = LAYER_INDICES.map((layer) => new Color(LAYER_COLORS[layer]));
  readonly opacity = LAYER_INDICES.map(() => 1);
  private readonly marker: Group;
  private readonly markerRing: Mesh<RingGeometry, MeshBasicMaterial>;
  private readonly markerDot: Mesh<CircleGeometry, MeshBasicMaterial>;
  private readonly geometry = tileGeometry();
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly e = new Euler();
  private readonly p = new Vector3();
  private readonly s = new Vector3(1, 1, 1);
  private readonly c = new Color();

  constructor() {
    this.materials = LAYER_INDICES.map(() => tileMaterial(false));
    const counts = LAYER_INDICES.map(() => 0);
    for (const tile of LAYER_TILES) this.slot[tile.id] = counts[tile.layer]++;
    this.layers = LAYER_INDICES.map((layer) => {
      const mesh = instanced(this.geometry, this.materials[layer], counts[layer]);
      mesh.name = `layer-${layer + 1}`;
      this.group.add(mesh);
      return mesh;
    });
    const debrisMaterial = tileMaterial(true);
    this.materials.push(debrisMaterial);
    this.debrisMesh = instanced(this.geometry, debrisMaterial, DEBRIS_CAPACITY);
    this.debrisMesh.count = 0;
    this.debrisMesh.name = "tile-debris";
    this.group.add(this.debrisMesh);
    // Landing marker: a hex outline on the tile below plus a dot straight under the body.
    // The outline draws over everything: mid-fall that tile is behind the body and the rim
    // of the hole being fallen through, and this is gameplay feedback, not scenery.
    this.markerRing = new Mesh(
      new RingGeometry(0.8, 1.12, 6, 1, Math.PI / 6).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.9, depthWrite: false, depthTest: false, fog: false })
    );
    this.markerDot = new Mesh(
      new CircleGeometry(0.2, 20).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.9, depthWrite: false, fog: false })
    );
    this.markerRing.renderOrder = 20;
    this.markerDot.renderOrder = 5;
    this.marker = new Group();
    this.marker.add(this.markerRing);
    this.group.add(this.marker, this.markerDot);
    this.marker.visible = this.markerDot.visible = false;
    this.reset();
  }

  /** Every tile solid and in place; no falling pieces. */
  reset() {
    this.debris.length = 0;
    this.debrisMesh.count = 0;
    for (const tile of LAYER_TILES) this.shown[tile.id] = null;
  }

  /**
   * Per frame. `tick` is the fractional round tick (for smooth stage motion); `time`
   * the clock for pulses; `focusY` the followed pelvis (layers above it fade).
   */
  update(field: TileView, tick: number, time: number, dt: number, focusY: number | null) {
    for (const tile of LAYER_TILES) {
      const stage = field.stage(tile.id, tick);
      if (stage === "solid" && this.shown[tile.id] === "solid") continue;
      this.shown[tile.id] = stage;
      const mesh = this.layers[tile.layer],
        i = this.slot[tile.id],
        state = mesh.geometry.getAttribute("tileState") as InstancedBufferAttribute;
      if (stage === "gone") {
        mesh.setMatrixAt(i, ZERO);
        continue;
      }
      const f = field.progress(tile.id, tick),
        seed = seedOf(tile.id);
      let sink = 0,
        crack = 0,
        glow = 0;
      this.c.copy(this.base[tile.layer]);
      this.q.identity();
      this.p.set(tile.x, tile.top, tile.z);
      if (stage === "marked") {
        // Collapse warning: a red pulse and a fast shiver (motion, not only colour).
        glow = -(0.75 + 0.25 * Math.sin(time * 15));
        this.c.lerp(BREAK_TINT, 0.15);
        this.p.y += 0.025 * Math.sin(time * 38 + seed * 20);
      }
      else if (stage === "warn") {
        this.c.lerp(WARN_TINT, 0.35);
        glow = 0.65 + 0.35 * Math.sin(time * 20);
      } else if (stage === "crack") {
        this.c.lerp(CRACK_TINT, 0.5);
        sink = 0.03;
        crack = 0.55 + f;
        glow = 0.25;
      } else if (stage === "break") {
        this.c.lerp(BREAK_TINT, 0.72);
        sink = 0.1;
        crack = 1.2 + f;
        glow = 0.2;
        // Shake and a slight tilt that grows toward the break.
        const shake = 0.018 * (0.6 + f);
        this.p.x += Math.sin(time * 132 + seed * 40) * shake;
        this.p.z += Math.cos(time * 147 + seed * 23) * shake;
        const tilt = ((2 + 3 * f) * Math.PI) / 180;
        this.e.set(Math.cos(seed * 30) * tilt, 0, Math.sin(seed * 30) * tilt);
        this.q.setFromEuler(this.e);
      }
      this.p.y -= sink;
      this.m.compose(this.p, this.q, this.s);
      mesh.setMatrixAt(i, this.m);
      mesh.setColorAt(i, this.c);
      state.setXYZW(i, crack, glow, seed, 1);
    }
    for (const mesh of this.layers) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.geometry.getAttribute("tileState").needsUpdate = true;
    }
    this.fade(focusY, dt);
    this.animateDebris(dt);
  }

  /** Layers above the followed character fade (eased), so their own layer reads. */
  private fade(focusY: number | null, dt: number) {
    const k = 1 - Math.exp(-Math.min(dt, 0.1) / LAYER_CAMERA.fade.seconds);
    for (const layer of LAYER_INDICES) {
      const above = focusY !== null && LAYER_TOPS[layer] > focusY + 0.3;
      const target = above ? LAYER_CAMERA.fade.opacity : 1;
      this.opacity[layer] += (target - this.opacity[layer]) * k;
      if (Math.abs(this.opacity[layer] - target) < 0.004) this.opacity[layer] = target;
      const material = this.materials[layer],
        transparent = this.opacity[layer] < 0.999;
      material.opacity = this.opacity[layer];
      if (material.transparent !== transparent) {
        material.transparent = transparent;
        material.depthWrite = !transparent;
        // Opaque programs force alpha to 1 (three's OPAQUE define): switch program variant.
        material.needsUpdate = true;
      }
    }
  }

  /** Tiles that just went GONE: a presentation-only piece falls from where each was. */
  spawnDebris(ids: readonly number[], time: number) {
    for (const id of ids) {
      if (this.debris.length >= DEBRIS_CAPACITY) this.debris.shift();
      const tile = LAYER_TILES[id],
        seed = seedOf(id),
        mesh = this.layers[tile.layer],
        from = new Matrix4();
      mesh.getMatrixAt(this.slot[id], from);
      if (from.determinant() === 0) from.makeTranslation(tile.x, tile.top - 0.1, tile.z);
      const color = this.base[tile.layer].clone().lerp(BREAK_TINT, 0.72);
      const axis = new Vector3(Math.cos(seed * 50 + time), 0, Math.sin(seed * 50 + time)).normalize();
      this.debris.push({ id, age: 0, from, color, axis, spin: 1.1 + seed });
      mesh.setMatrixAt(this.slot[id], ZERO);
      this.shown[id] = "gone";
    }
  }
  private animateDebris(dt: number) {
    let n = 0;
    const state = this.debrisMesh.geometry.getAttribute("tileState") as InstancedBufferAttribute;
    for (let i = 0; i < this.debris.length; i++) {
      const d = this.debris[i];
      d.age += dt;
      if (d.age >= DEBRIS_SECONDS) continue;
      const k = d.age / DEBRIS_SECONDS;
      this.p.setFromMatrixPosition(d.from);
      this.p.y -= 0.5 * 14 * d.age * d.age;
      this.q.setFromAxisAngle(d.axis, d.spin * k);
      const scale = 1 - 0.6 * k;
      this.s.set(scale, scale, scale);
      this.m.compose(this.p, this.q, this.s);
      this.s.set(1, 1, 1);
      this.debrisMesh.setMatrixAt(n, this.m);
      this.debrisMesh.setColorAt(n, d.color);
      state.setXYZW(n, 1.8, 0, seedOf(d.id), 1 - k * k);
      this.debris[n++] = d;
    }
    this.debris.length = n;
    this.debrisMesh.count = n;
    this.debrisMesh.instanceMatrix.needsUpdate = true;
    if (this.debrisMesh.instanceColor) this.debrisMesh.instanceColor.needsUpdate = true;
    state.needsUpdate = true;
  }

  /** Where the followed character will land (white), or nothing below (red, pulsing). */
  setMarker(marker: LandingMarker, time: number) {
    const ring = this.markerRing,
      dot = this.markerDot;
    if (marker.kind === "none") {
      this.marker.visible = dot.visible = false;
      return;
    }
    this.marker.visible = dot.visible = true;
    if (marker.kind === "safe") {
      const tile = LAYER_TILES[marker.tile];
      this.marker.position.set(tile.x, tile.top + 0.03, tile.z);
      this.marker.scale.setScalar(1);
      dot.position.set(marker.x, tile.top + 0.035, marker.z);
      ring.material.color.set("#ffffff");
      dot.material.color.set("#ffffff");
      ring.material.opacity = dot.material.opacity = 0.9;
    } else {
      this.marker.position.set(marker.x, marker.y + 0.03, marker.z);
      this.marker.scale.setScalar(0.8 + 0.15 * Math.sin(time * 18));
      dot.position.set(marker.x, marker.y + 0.035, marker.z);
      ring.material.color.set("#ff3b2f");
      dot.material.color.set("#ff3b2f");
      ring.material.opacity = dot.material.opacity = 0.65 + 0.3 * Math.sin(time * 18);
    }
  }

  /** Triangles drawn for the tile field (visible tiles only). */
  get triangles() {
    const perTile = (this.geometry.getAttribute("position").count / 3) | 0;
    return perTile * (LAYER_TILES.length + this.debrisMesh.count);
  }
  dispose() {
    for (const mesh of [...this.layers, this.debrisMesh]) mesh.geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometry.dispose();
    this.markerRing.geometry.dispose();
    this.markerRing.material.dispose();
    this.markerDot.geometry.dispose();
    this.markerDot.material.dispose();
  }
}
