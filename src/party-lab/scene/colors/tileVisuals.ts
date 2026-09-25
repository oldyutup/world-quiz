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
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from "three";
import { HEX } from "../../../../shared/party-lab/maps/layers";
import { COLOR_TILES } from "../../../../shared/party-lab/maps/colors";
import { COLOR_TICKS } from "../../../../shared/party-lab/simulation/colors/config";
import { NO_COLOR } from "../../../../shared/party-lab/simulation/colors/layouts";
import type { ColorCycleState } from "../../../../shared/party-lab/simulation/colors/schedule";
import { TILE_HEX } from "./palette";

/** Pale stone of the tile bodies (sides and underside); the colour is only on top. */
const STONE = "vec3(0.83, 0.80, 0.76)";
/** Seconds of the white flash on tiles that change colour at a restore. */
const FLASH_SECONDS = 0.25;
/** Last share of the reaction time in which the tiles about to drop tremble. */
const TREMBLE_SECONDS = 0.5;
/** Top of a grey tile in its last cycle (the shrink): dark ash, no symbol. */
const ASH = new Color(0.2, 0.19, 0.24);
/** A tile leaving for good sinks this far, tumbling, over `GONE_SECONDS` (a normal drop: 1.4 m in 0.3 s). */
const GONE_DEPTH = 9;
const GONE_SECONDS = 0.9;

// ─── Geometry ───────────────────────────────────────────────────────────────

type V = [number, number, number];
/**
 * One hex tile, walking surface at y = 0 (Katman Kaosu's proportions: 6 cm visual groove,
 * 0.5 m deep): a flat top, a bevelled rim, straight sides, a narrower underside. `aTop` is
 * 1 on the top face and bevel (they take the gameplay colour), 0 on the stone body; the
 * vertex colour is a flat-shading band (light top, darker sides and underside).
 */
function tileGeometry() {
  const apothem = HEX.width / 2 - HEX.groove / 2;
  const bands: [number, number][] = [
    [apothem - 0.06, 0],
    [apothem, -0.06],
    [apothem, -HEX.thickness + 0.08],
    [apothem - 0.12, -HEX.thickness],
  ];
  const shades = [0.86, 0.8, 0.62];
  const tops = [1, 0, 0];
  const ring = ([a, y]: [number, number]) =>
    Array.from({ length: 6 }, (_, k): V => {
      const angle = ((30 + 60 * k) * Math.PI) / 180,
        r = a / Math.cos(Math.PI / 6);
      return [r * Math.cos(angle), y, r * Math.sin(angle)];
    });
  const rings = bands.map(ring);
  const positions: number[] = [],
    normals: number[] = [],
    colors: number[] = [],
    top: number[] = [];
  const triangle = (a: V, b: V, c: V, outward: V, shade: number, isTop: number) => {
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
      top.push(isTop);
    }
  };
  const fan = (corners: V[], outward: V, shade: number, isTop: number) => {
    for (let k = 1; k < 5; k++) triangle(corners[0], corners[k], corners[k + 1], outward, shade, isTop);
  };
  fan(rings[0], [0, 1, 0], 1, 1);
  for (let i = 0; i < 3; i++)
    for (let k = 0; k < 6; k++) {
      const a = rings[i][k],
        b = rings[i][(k + 1) % 6],
        c = rings[i + 1][(k + 1) % 6],
        d = rings[i + 1][k];
      const mid: V = [(a[0] + b[0]) / 2, 0, (a[2] + b[2]) / 2];
      triangle(a, b, c, mid, shades[i], tops[i]);
      triangle(a, c, d, mid, shades[i], tops[i]);
    }
  fan(rings[3], [0, -1, 0], 0.5, 0);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geometry.setAttribute("aTop", new Float32BufferAttribute(top, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

// ─── Material ───────────────────────────────────────────────────────────────

/**
 * Per instance: `tileColor` (the gameplay colour, linear), `tileState` = (symbol 0…3 or
 * 4 none, target glow 0…1, dim 0…1, white flash 0…1) and `tileMark` (the shrink: 0 none,
 * 1 marked — leaves after this cycle, 2 grey — leaves at this drop). The top gets the
 * colour plus its symbol (circle / stripes / triangle / cross, drawn a shade lighter or
 * darker), a pulsing white outline when it is the target, and a grey dim when it is not;
 * the body stays stone. A marked tile gets a black-and-white dashed border that runs
 * around it and a dark body; a grey one the same, faster. No textures, one draw call.
 */
function tileMaterial(time: { value: number }) {
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0 });
  material.customProgramCacheKey = () => "party-lab-color-tile";
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTileTime = time;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute float aTop;
attribute vec3 tileColor;
attribute vec4 tileState;
attribute float tileMark;
varying float vTop;
varying vec3 vTileColor;
varying vec4 vTileState;
varying vec2 vTileLocal;
varying float vTileMark;`
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vTop = aTop;
vTileColor = tileColor;
vTileState = tileState;
vTileLocal = position.xz;
vTileMark = tileMark;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying float vTop;
varying vec3 vTileColor;
varying vec4 vTileState;
varying vec2 vTileLocal;
varying float vTileMark;
uniform float uTileTime;
float tileApothem(vec2 p) {
  return max(abs(p.x), max(abs(dot(p, vec2(0.5, 0.8660254))), abs(dot(p, vec2(-0.5, 0.8660254)))));
}
float band(float d, float w) { return 1.0 - smoothstep(w - 0.02, w + 0.02, d); }
/** 0 circle (ring), 1 stripes, 2 triangle (outline), 3 cross; 1 inside the symbol. */
float tileSymbol(vec2 p, float kind) {
  if (kind < 0.5) return band(abs(length(p) - 0.46), 0.09);
  if (kind < 1.5) {
    float s = fract((p.x + p.y) * 1.25);
    return band(abs(s - 0.5) * 0.8, 0.13) * band(tileApothem(p), 0.72);
  }
  if (kind < 2.5) {
    // Point toward -z; |p·n| over the three edge normals.
    vec2 n0 = vec2(0.0, 1.0), n1 = vec2(0.8660254, -0.5), n2 = vec2(-0.8660254, -0.5);
    float t = max(dot(p, n0), max(dot(p, n1), dot(p, n2)));
    return band(abs(t - 0.27), 0.075);
  }
  if (kind > 3.5) return 0.0;
  return max(band(abs(p.x), 0.1) * band(abs(p.y), 0.52), band(abs(p.y), 0.1) * band(abs(p.x), 0.52));
}`
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
vec3 tileTop = vTileColor;
float tileLuma = dot(tileTop, vec3(0.2126, 0.7152, 0.0722));
vec3 tileMark = tileLuma > 0.35 ? tileTop * 0.62 : mix(tileTop, vec3(1.0), 0.38);
tileTop = mix(tileTop, tileMark, tileSymbol(vTileLocal, vTileState.x) * 0.5);
// Not the target: greyed and darkened (the target keeps its full colour).
tileTop = mix(tileTop, vec3(tileLuma), vTileState.z * 0.7) * (1.0 - 0.4 * vTileState.z);
tileTop = mix(tileTop, vec3(1.0), vTileState.w * 0.7);
// The shrink: a dashed black-and-white border inside the target outline that runs around
// the tile (faster on a grey tile), and a dark body under it.
if (vTileMark > 0.5) {
  float a = atan(vTileLocal.y, vTileLocal.x) / 6.2831853;
  float dash = step(0.5, fract(a * 12.0 + uTileTime * (vTileMark > 1.5 ? 1.6 : 0.7)));
  float edge = tileApothem(vTileLocal);
  float border = smoothstep(0.6, 0.63, edge) * (1.0 - smoothstep(0.75, 0.78, edge));
  tileTop = mix(tileTop, mix(vec3(0.04, 0.035, 0.06), vec3(1.0), dash), border * 0.92);
}
vec3 tileBody = vTileMark > 0.5 ? vec3(0.3, 0.28, 0.34) : ${STONE};
diffuseColor.rgb *= mix(tileBody, tileTop, vTop);`
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
if (vTop > 0.5) {
  // Keep the gameplay colour vivid under any light; the target pulses brighter inside a
  // crisp white outline (≈ 10 cm at the rim), so its colour is never washed out.
  totalEmissiveRadiance += diffuseColor.rgb * (0.28 + 0.22 * vTileState.y);
  float rim = smoothstep(0.78, 0.83, tileApothem(vTileLocal));
  totalEmissiveRadiance += vec3(1.0, 0.98, 0.92) * rim * vTileState.y * 1.1;
}`
      );
  };
  return material;
}

const ZERO = new Matrix4().makeScale(0, 0, 0);
const seedOf = (id: number) => ((id * 0.618034) % 1) + 0.05;
const easeOut = (k: number) => 1 - (1 - k) * (1 - k);

/** What the tile field shows: the local schedule, or online what the snapshots told (ColorFieldKnowledge). */
export interface ColorFieldView {
  readonly cycle: ColorCycleState;
  readonly previous: ColorCycleState | null;
}

/**
 * Renk Kaosu's 85 tiles as one InstancedMesh, plus a contact shadow under each player.
 * Presentation only: it reads the schedule and never touches physics. The colliders change
 * on exact ticks; here the tiles that drop fall 1.4 m and shrink over 0.3 s, and the ones
 * that return rise into place over 0.45 s at the start of the next cycle's preview. Tiles
 * the shrink takes for good sink 9 m, tumbling, over 0.9 s, and are not drawn again.
 */
export class ColorTileVisuals {
  readonly group = new Group();
  readonly mesh: InstancedMesh;
  private readonly time = { value: 0 };
  private readonly material = tileMaterial(this.time);
  private readonly geometry = tileGeometry();
  private readonly colorAttribute: InstancedBufferAttribute;
  private readonly stateAttribute: InstancedBufferAttribute;
  private readonly markAttribute: InstancedBufferAttribute;
  private readonly palette = TILE_HEX.map((hex) => new Color(hex));
  private readonly shadows: InstancedMesh;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly e = new Euler();
  private readonly p = new Vector3();
  private readonly s = new Vector3(1, 1, 1);

  constructor() {
    const count = COLOR_TILES.length;
    this.colorAttribute = new InstancedBufferAttribute(new Float32Array(count * 3), 3).setUsage(DynamicDrawUsage);
    this.stateAttribute = new InstancedBufferAttribute(new Float32Array(count * 4), 4).setUsage(DynamicDrawUsage);
    this.markAttribute = new InstancedBufferAttribute(new Float32Array(count), 1).setUsage(DynamicDrawUsage);
    this.geometry.setAttribute("tileColor", this.colorAttribute);
    this.geometry.setAttribute("tileState", this.stateAttribute);
    this.geometry.setAttribute("tileMark", this.markAttribute);
    this.mesh = new InstancedMesh(this.geometry, this.material, count);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.name = "color-tiles";
    this.group.add(this.mesh);
    // Contact shadows: where each body's support point is (and none over a hole).
    this.shadows = new InstancedMesh(
      new CircleGeometry(0.34, 20).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: "#1c1a2a", transparent: true, opacity: 0.3, depthWrite: false, fog: false }),
      3
    );
    this.shadows.instanceMatrix.setUsage(DynamicDrawUsage);
    this.shadows.frustumCulled = false;
    this.shadows.renderOrder = 2;
    this.shadows.name = "contact-shadows";
    this.group.add(this.shadows);
  }

  /**
   * Per frame. `tick` is the fractional round tick; `highlight` false in the countdown
   * (no target yet), `time` drives the pulses.
   */
  update(view: ColorFieldView, tick: number, time: number, highlight: boolean) {
    const { cycle, previous } = view,
      colors = cycle.colors,
      running = highlight && tick >= cycle.announce && tick < cycle.drop,
      dropping = highlight && tick >= cycle.drop,
      restoring = previous && tick >= cycle.start ? (tick - cycle.start) / COLOR_TICKS.restore : 1,
      untilDrop = (cycle.drop - tick) / 60,
      pulse = 0.6 + 0.4 * Math.sin(time * 11);
    this.time.value = time;
    for (const tile of COLOR_TILES) {
      const id = tile.id,
        color = colors[id],
        target = color === cycle.target,
        grey = color === NO_COLOR,
        seed = seedOf(id);
      if (!cycle.present[id] && !target) {
        // Gone for good (its long fall ended in the previous cycle's unsafe window).
        this.mesh.setMatrixAt(id, ZERO);
        continue;
      }
      let glow = 0,
        dim = 0,
        flash = 0,
        lift = 0,
        scale = 1;
      this.q.identity();
      this.p.set(tile.x, tile.top, tile.z);
      if (restoring < 1 && previous) {
        const returned = previous.colors[id] !== previous.target,
          k = Math.max(0, restoring);
        if (returned) {
          lift = -1.4 * (1 - easeOut(k));
          scale = 0.3 + 0.7 * easeOut(k);
        } else flash = Math.max(0, 1 - (tick - cycle.start) / 60 / FLASH_SECONDS);
      }
      if (running) {
        if (target) {
          glow = pulse;
          lift = 0.035;
        } else {
          // Greyed as the timer runs, trembling in its last half second.
          dim = 0.45 + 0.4 * Math.min(1, (tick - cycle.announce) / Math.max(1, cycle.drop - cycle.announce));
          if (untilDrop < TREMBLE_SECONDS) {
            const shake = 0.012 * (1 - untilDrop / TREMBLE_SECONDS + 0.3);
            this.p.x += Math.sin(time * 130 + seed * 40) * shake;
            this.p.z += Math.cos(time * 145 + seed * 23) * shake;
          }
        }
      } else if (dropping) {
        if (!target) {
          // Leaving for good (grey now, or marked and not the target): the long fall.
          const forGood = grey || cycle.warned[id] === 1,
            k = ((tick - cycle.drop) / 60) / (forGood ? GONE_SECONDS : COLOR_TICKS.drop / 60);
          if (k >= 1) {
            this.mesh.setMatrixAt(id, ZERO);
            continue;
          }
          lift = (forGood ? -GONE_DEPTH : -1.4) * k * k;
          scale = forGood ? 1 - 0.6 * k : 1 - 0.5 * k;
          dim = 0.85;
          const tilt = (((forGood ? 30 : 8) + (forGood ? 50 : 10) * seed) * k * Math.PI) / 180;
          this.e.set(Math.cos(seed * 30) * tilt, forGood ? tilt * 0.6 : 0, Math.sin(seed * 30) * tilt);
          this.q.setFromEuler(this.e);
        }
      }
      this.p.y += lift;
      this.s.set(scale, scale, scale);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(id, this.m);
      const c = grey ? ASH : this.palette[color];
      this.colorAttribute.setXYZ(id, c.r, c.g, c.b);
      this.stateAttribute.setXYZW(id, grey ? 4 : color, glow, dim, flash);
      this.markAttribute.setX(id, !highlight ? 0 : grey ? 2 : cycle.warned[id] ? 1 : 0);
    }
    this.s.set(1, 1, 1);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.colorAttribute.needsUpdate = true;
    this.stateAttribute.needsUpdate = true;
    this.markAttribute.needsUpdate = true;
  }

  /** Contact shadow per slot: pelvis (x, y, z), or null (no body / no tile under it). */
  setShadow(slot: number, at: { x: number; y: number; z: number } | null) {
    if (!at) {
      this.shadows.setMatrixAt(slot, ZERO);
    } else {
      // Smaller as the body rises (a jump), so the landing point still reads.
      const k = Math.max(0.35, 1 - Math.max(0, at.y - 0.78) * 0.35);
      this.p.set(at.x, 0.012, at.z);
      this.s.set(k, 1, k);
      this.q.identity();
      this.m.compose(this.p, this.q, this.s);
      this.s.set(1, 1, 1);
      this.shadows.setMatrixAt(slot, this.m);
    }
    this.shadows.instanceMatrix.needsUpdate = true;
  }

  /** Triangles of one tile (the whole field is 85 of them). */
  get trianglesPerTile() {
    return (this.geometry.getAttribute("position").count / 3) | 0;
  }
  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.shadows.geometry.dispose();
    (this.shadows.material as MeshBasicMaterial).dispose();
  }
}
