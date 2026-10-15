#!/usr/bin/env node
// Builds public/party-lab/maps/prop-hunt/market-kit.glb: the models Saklambaç's "Market" map
// draws on top of its generated shell and fixtures (scene/prophunt/market/arena.ts), from two
// CC0 Kenney packs read in place (never copied into the repository):
//   - Food Kit 2.0      — cans, bottles, cartons, fruit and veg, ice cream (the shelves' stock and
//                         the transformable families' contents);
//   - Furniture Kit 2.0 — the cardboard box and the bin.
// Everything else (crates, baskets, the cart, the pallet, the watermelon, cereal boxes) is
// generated here as low-poly shapes in the same flat style.
//
// Cleanup (the Orman Kampı kit's conventions, scripts/build-party-lab-prop-hunt-kit.mjs):
// - every model baked to one primitive with POSITION / COLOR_0 and indices (flat faces: the
//   arena computes the normals on load): one untextured, metalness-0 Lambert material;
// - the Food Kit's palette texture (colormap.png) is sampled once per triangle at its UV
//   centroid (flat, faceted colour), the Furniture Kit's flat base colours are taken as they are;
// - models re-pivoted to bottom-centre; the twelve transformable families are fitted to exactly
//   their gameplay shapes (shared/party-lab/maps/propHuntProps.ts), so a disguise and a decoy draw
//   identically and cover their collider; shelf stock is at 1.25× real size (the camp's interior
//   scale, the character being 1.92 m tall).
//
// Gameplay colliders never come from this file (shared/party-lab/maps/market.ts).
//
// Usage: node scripts/build-party-lab-market-kit.mjs [path/to/kenney_food-kit(.zip)] [path/to/kenney_furniture-kit]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(projectRoot, 'public', 'party-lab', 'maps', 'prop-hunt');

function fail(message) {
  console.error(`build-party-lab-market-kit: ${message}`);
  process.exit(1);
}
/** A pack folder, or its zip unpacked into a fresh temporary folder. */
function packFolder(given, name) {
  const base = path.resolve(given ?? path.join(os.homedir(), 'Downloads', name));
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) return base;
  const zip = base.endsWith('.zip') ? base : `${base}.zip`;
  if (!fs.existsSync(zip)) fail(`${name} not found (${base} or ${zip})`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  execFileSync('unzip', ['-q', zip, '-d', dir]);
  return dir;
}
const FOOD = path.join(packFolder(process.argv[2], 'kenney_food-kit'), 'Models', 'GLB format');
const FURNITURE = path.join(packFolder(process.argv[3], 'kenney_furniture-kit'), 'Models', 'GLTF format');

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

// ─── Colour ────────────────────────────────────────────────────────────────

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hex = (h) => [1, 3, 5].map((i) => srgbToLinear(parseInt(h.slice(i, i + 2), 16) / 255));
/** sRGB palette for the generated parts (written as linear vertex colours). */
const C = {
  crateRed: hex('#d4443a'),
  crateRedDark: hex('#a8322b'),
  basketRed: hex('#e0473c'),
  basketDark: hex('#9e2c25'),
  handle: hex('#2f3236'),
  wood: hex('#d2a46b'),
  woodDark: hex('#a8794a'),
  woodEnd: hex('#e6c08c'),
  pallet: hex('#c99a5e'),
  palletDark: hex('#9b7244'),
  steel: hex('#c8ced4'),
  steelDark: hex('#8f979f'),
  cartRed: hex('#d8443b'),
  wheel: hex('#2b2d30'),
  melon: hex('#3f8f4a'),
  melonLight: hex('#7cc36a'),
  melonDark: hex('#2d6b37'),
  stem: hex('#7a5a33'),
  mound: hex('#8a6a45'),
  moundGreen: hex('#6aa04f'),
  cardboard: hex('#c79a62'),
  tape: hex('#e7d3a6'),
  white: hex('#f4f1ea'),
  cerealRed: hex('#d9473b'),
  cerealYellow: hex('#f0b93a'),
  cerealBlue: hex('#3e78c8'),
  cerealGreen: hex('#58a84d'),
  pastaBlue: hex('#2f5fa8'),
  teaGreen: hex('#3f8a5a'),
};

// ─── Readers ───────────────────────────────────────────────────────────────

function readGlb(file) {
  if (!fs.existsSync(file)) fail(`missing ${file}`);
  const buffer = fs.readFileSync(file);
  if (buffer.readUInt32LE(0) !== 0x46546c67) fail(`${file}: not a GLB`);
  let offset = 12,
    json,
    bin;
  while (offset < buffer.length) {
    const length = buffer.readUInt32LE(offset),
      type = buffer.readUInt32LE(offset + 4);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    offset += 8 + length;
  }
  return { json, buffers: [bin], bytes: buffer.length };
}
function readAccessor({ json, buffers }, index) {
  const accessor = json.accessors[index];
  const view = json.bufferViews[accessor.bufferView];
  const Type = COMPONENT[accessor.componentType];
  const width = WIDTH[accessor.type];
  const stride = view.byteStride ?? width * Type.BYTES_PER_ELEMENT;
  const buffer = buffers[view.buffer];
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const out = new Array(accessor.count * width);
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[accessor.componentType];
  for (let i = 0; i < accessor.count; i++) for (let k = 0; k < width; k++) out[i * width + k] = dv[get](base + i * stride + k * Type.BYTES_PER_ELEMENT, true);
  return out;
}
function nodeMatrix(node) {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}
const transformPoint = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = ([x, y, z]) => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};

const textures = new Map();
async function loadTexture(file) {
  if (!textures.has(file)) {
    if (!fs.existsSync(file)) fail(`missing texture ${file}`);
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    textures.set(file, { data, width: info.width, height: info.height, channels: info.channels });
  }
  return textures.get(file);
}
function sampleTexture(t, [u, v]) {
  const fu = u - Math.floor(u),
    fv = v - Math.floor(v);
  const x = Math.min(t.width - 1, Math.floor(fu * t.width)),
    y = Math.min(t.height - 1, Math.floor(fv * t.height)),
    o = (y * t.width + x) * t.channels;
  return [0, 1, 2].map((c) => srgbToLinear(t.data[o + c] / 255));
}
/**
 * A Kenney GLB's triangles, flat-shaded (each triangle one colour: the Food Kit's palette texture
 * at its UV centroid, or the material's base colour), in the model's own units.
 */
async function kenney(file) {
  const model = readGlb(file);
  const { json } = model;
  const texture = json.images?.length ? await loadTexture(path.join(path.dirname(file), json.images[0].uri)) : null;
  const out = [];
  const walk = (index, parent) => {
    const node = json.nodes[index];
    const matrix = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined)
      for (const primitive of json.meshes[node.mesh].primitives) {
        const material = json.materials?.[primitive.material];
        const base = material?.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
        const positions = readAccessor(model, primitive.attributes.POSITION);
        const uvs = primitive.attributes.TEXCOORD_0 !== undefined ? readAccessor(model, primitive.attributes.TEXCOORD_0) : null;
        const indices = primitive.indices !== undefined ? readAccessor(model, primitive.indices) : Array.from({ length: positions.length / 3 }, (_, i) => i);
        for (let i = 0; i < indices.length; i += 3) {
          const corners = [indices[i], indices[i + 1], indices[i + 2]];
          const p = corners.map((k) => transformPoint(matrix, positions.slice(k * 3, k * 3 + 3)));
          const uv = uvs && [0, 1].map((c) => corners.reduce((sum, k) => sum + uvs[k * 2 + c], 0) / 3);
          const color = texture && uv ? sampleTexture(texture, uv).map((c, k) => c * base[k]) : base.slice(0, 3);
          out.push(tri(p[0], p[1], p[2], color));
        }
      }
    for (const child of node.children ?? []) walk(child, matrix);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const index of json.scenes[json.scene ?? 0].nodes) walk(index, identity);
  return out;
}
const food = (name) => kenney(path.join(FOOD, `${name}.glb`));
const furniture = (name) => kenney(path.join(FURNITURE, `${name}.glb`));

// ─── Geometry ──────────────────────────────────────────────────────────────

/** One flat triangle (positions counter-clockwise from its front). */
function tri(a, b, c, color) {
  const n = normalize(cross(sub(b, a), sub(c, a)));
  return { v: [a, b, c].map((p) => ({ p: [...p], n: [...n] })), color: [...color] };
}
const quad = (a, b, c, d, color) => [tri(a, b, c, color), tri(a, c, d, color)];
/** Axis-aligned box; `color` per face ("top", "bottom", "px", "nx", "pz", "nz"), null skips one. */
function box([x0, y0, z0], [x1, y1, z1], color) {
  const f = typeof color === 'function' ? color : () => color;
  const out = [];
  const add = (face, a, b, c, d) => {
    const tint = f(face);
    if (tint) out.push(...quad(a, b, c, d, tint));
  };
  add('top', [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
  add('bottom', [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  add('px', [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
  add('nx', [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
  add('pz', [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  add('nz', [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
  return out;
}
/** A shaded box: sides a little darker than the top (the camp's look without lighting tricks). */
const shaded = (color, k = 0.88) => (face) => (face === 'top' ? color : face === 'bottom' ? color.map((c) => c * 0.7) : color.map((c) => c * (face === 'nx' || face === 'nz' ? k : 0.95)));
/** A vertical cylinder (axis y) with caps; `segments` around. */
function cylinder(cx, cz, y0, y1, r, segments, color, caps = true) {
  const out = [];
  for (let k = 0; k < segments; k++) {
    const a0 = (k / segments) * Math.PI * 2,
      a1 = ((k + 1) / segments) * Math.PI * 2;
    const p0 = [cx + Math.cos(a0) * r, cz + Math.sin(a0) * r],
      p1 = [cx + Math.cos(a1) * r, cz + Math.sin(a1) * r];
    out.push(...quad([p0[0], y0, p0[1]], [p1[0], y0, p1[1]], [p1[0], y1, p1[1]], [p0[0], y1, p0[1]], color).map((t) => flip(t)));
    if (caps) {
      out.push(tri([cx, y1, cz], [p1[0], y1, p1[1]], [p0[0], y1, p0[1]], color));
      out.push(tri([cx, y0, cz], [p0[0], y0, p0[1]], [p1[0], y0, p1[1]], color));
    }
  }
  return out;
}
function flip(t) {
  const v = [t.v[0], t.v[2], t.v[1]];
  return { v: v.map((x) => ({ p: x.p, n: x.n.map((c) => -c) })), color: t.color };
}
/** Moves/turns/scales triangles: scale (per axis), then yaw about +Y (radians), then offset. */
function place(tris, { scale = [1, 1, 1], yaw = 0, at = [0, 0, 0] } = {}) {
  const s = typeof scale === 'number' ? [scale, scale, scale] : scale;
  const cos = Math.cos(yaw),
    sin = Math.sin(yaw);
  const turn = ([x, y, z]) => [x * cos + z * sin, y, -x * sin + z * cos];
  return tris.map((t) => ({
    color: t.color,
    v: t.v.map(({ p, n }) => {
      const q = turn(p.map((c, k) => c * s[k]));
      return { p: [q[0] + at[0], q[1] + at[1], q[2] + at[2]], n: normalize(turn(n.map((c, k) => c / s[k]))) };
    }),
  }));
}
function bounds(tris) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const { p } of t.v) for (let c = 0; c < 3; c++) ((min[c] = Math.min(min[c], p[c])), (max[c] = Math.max(max[c], p[c])));
  return { min, max, size: max.map((v, c) => v - min[c]) };
}
/** Re-pivoted to bottom-centre and scaled: to exactly `size` (per axis), or uniformly to `height`. */
function fit(tris, { size, height, scale }) {
  const { min, max } = bounds(tris);
  const offset = [-(min[0] + max[0]) / 2, -min[1], -(min[2] + max[2]) / 2];
  const centred = place(tris, { at: offset });
  const s = size ? size.map((v, c) => v / (max[c] - min[c])) : height ? Array(3).fill(height / (max[1] - min[1])) : Array(3).fill(scale ?? 1);
  return place(centred, { scale: s });
}
/** A model fitted to `width` across x (uniform scale), bottom-centre. */
const fitWidth = (tris, width) => {
  const { size } = bounds(tris);
  return fit(tris, { scale: width / size[0] });
};

// ─── Generated pieces ──────────────────────────────────────────────────────

/** An open-topped box (a crate or a bin): outer walls, inner walls, rim and floor, slats as colour bands. */
function openBox(w, h, d, wall, outer, inner, rim, { bands = 0, bandColor = null } = {}) {
  const out = [];
  const x = w / 2,
    z = d / 2,
    xi = x - wall,
    zi = z - wall;
  // Outer walls (horizontal bands alternate colour when `bands`).
  const strips = bands || 1;
  for (let k = 0; k < strips; k++) {
    const y0 = (h * k) / strips,
      y1 = (h * (k + 1)) / strips,
      c = bands && k % 2 ? bandColor : outer;
    out.push(...quad([-x, y0, z], [x, y0, z], [x, y1, z], [-x, y1, z], c));
    out.push(...quad([x, y0, -z], [-x, y0, -z], [-x, y1, -z], [x, y1, -z], c.map((v) => v * 0.9)));
    out.push(...quad([x, y0, z], [x, y0, -z], [x, y1, -z], [x, y1, z], c.map((v) => v * 0.95)));
    out.push(...quad([-x, y0, -z], [-x, y0, z], [-x, y1, z], [-x, y1, -z], c.map((v) => v * 0.88)));
  }
  // Inner walls (facing in), the rim, the floor.
  out.push(...quad([xi, 0.04, zi], [-xi, 0.04, zi], [-xi, h, zi], [xi, h, zi], inner));
  out.push(...quad([-xi, 0.04, -zi], [xi, 0.04, -zi], [xi, h, -zi], [-xi, h, -zi], inner));
  out.push(...quad([-xi, 0.04, zi], [-xi, 0.04, -zi], [-xi, h, -zi], [-xi, h, zi], inner.map((v) => v * 0.9)));
  out.push(...quad([xi, 0.04, -zi], [xi, 0.04, zi], [xi, h, zi], [xi, h, -zi], inner.map((v) => v * 0.9)));
  out.push(...quad([-x, h, z], [x, h, z], [xi, h, zi], [-xi, h, zi], rim));
  out.push(...quad([x, h, -z], [-x, h, -z], [-xi, h, -zi], [xi, h, -zi], rim));
  out.push(...quad([x, h, z], [x, h, -z], [xi, h, -zi], [xi, h, zi], rim));
  out.push(...quad([-x, h, -z], [-x, h, z], [-xi, h, zi], [-xi, h, -zi], rim));
  out.push(...quad([-xi, 0.04, zi], [xi, 0.04, zi], [xi, 0.04, -zi], [-xi, 0.04, -zi], inner.map((v) => v * 0.75)));
  out.push(...quad([-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z], outer.map((v) => v * 0.6)));
  return out;
}
/** A low mound (a heap of produce under the top layer), a flat-topped pyramid. */
function mound(w, d, y0, y1, color) {
  const x = w / 2,
    z = d / 2,
    xt = x * 0.6,
    zt = z * 0.6;
  return [
    ...quad([-x, y0, z], [x, y0, z], [xt, y1, zt], [-xt, y1, zt], color),
    ...quad([x, y0, -z], [-x, y0, -z], [-xt, y1, -zt], [xt, y1, -zt], color.map((v) => v * 0.9)),
    ...quad([x, y0, z], [x, y0, -z], [xt, y1, -zt], [xt, y1, zt], color.map((v) => v * 0.95)),
    ...quad([-x, y0, -z], [-x, y0, z], [-xt, y1, zt], [-xt, y1, -zt], color.map((v) => v * 0.88)),
    ...quad([-xt, y1, zt], [xt, y1, zt], [xt, y1, -zt], [-xt, y1, -zt], color),
  ];
}
/** A grid of one model over a rectangle at height y (`jitter` turns each a little). */
function grid(model, nx, nz, w, d, y, seed = 1) {
  let s = seed;
  const random = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const out = [];
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) out.push(...place(model, { yaw: random() * Math.PI * 2, at: [-w / 2 + (w * (i + 0.5)) / nx, y, -d / 2 + (d * (k + 0.5)) / nz] }));
  return out;
}
/** A lying ellipsoid along x, `segments` round the axis (alternating stripe colours), `rings` along it. */
function watermelon(segments = 14, rings = 8) {
  const out = [];
  const point = (i, k) => {
    const t = (i / rings) * Math.PI,
      a = (k / segments) * Math.PI * 2;
    const r = Math.sin(t);
    return [-Math.cos(t), r * Math.sin(a) * 0.98, r * Math.cos(a)];
  };
  for (let i = 0; i < rings; i++)
    for (let k = 0; k < segments; k++) {
      const color = k % 2 ? C.melonDark : C.melon;
      const a = point(i, k),
        b = point(i + 1, k),
        c = point(i + 1, k + 1),
        d = point(i, k + 1);
      if (i === 0) out.push(tri(a, c, b, color));
      else if (i === rings - 1) out.push(tri(a, d, b, color));
      else out.push(tri(a, c, b, color), tri(a, d, c, color));
    }
  out.push(...box([-1.04, -0.04, -0.04], [-0.96, 0.04, 0.04], C.stem));
  return out;
}
/** A tapered, open shopping basket (red plastic). */
function basket(w, d, h, bottom) {
  const out = [];
  const x = w / 2,
    z = d / 2,
    bx = bottom * x,
    bz = bottom * z;
  const sides = [
    [[-bx, 0, bz], [bx, 0, bz], [x, h, z], [-x, h, z], 1],
    [[bx, 0, -bz], [-bx, 0, -bz], [-x, h, -z], [x, h, -z], 0.88],
    [[bx, 0, bz], [bx, 0, -bz], [x, h, -z], [x, h, z], 0.95],
    [[-bx, 0, -bz], [-bx, 0, bz], [-x, h, z], [-x, h, -z], 0.9],
  ];
  for (const [a, b, c, dd, k] of sides) {
    out.push(...quad(a, b, c, dd, C.basketRed.map((v) => v * k)));
    // The inside (seen from above).
    out.push(...quad(b, a, dd, c, C.basketDark));
  }
  out.push(...quad([-bx, 0.01, bz], [bx, 0.01, bz], [bx, 0.01, -bz], [-bx, 0.01, -bz], C.basketDark));
  // Rim.
  out.push(...box([-x, h - 0.03, -z], [x, h, -z + 0.03], C.basketDark), ...box([-x, h - 0.03, z - 0.03], [x, h, z], C.basketDark));
  return out;
}
/** A shopping cart (nose +z, handle −z): wire basket from bars, chassis, four wheels. */
function cart() {
  const out = [];
  const bar = (a, b, t = 0.022, color = C.steel) => {
    const min = a.map((v, k) => Math.min(v, b[k]) - t / 2),
      max = a.map((v, k) => Math.max(v, b[k]) + t / 2);
    out.push(...box(min, max, shaded(color)));
  };
  const y0 = 0.42,
    y1 = 0.98,
    zb = -0.4,
    zf = 0.5,
    xw = 0.31;
  // Rails round the top and the bottom of the basket, the floor and the vertical bars.
  for (const y of [y0, y1, (y0 + y1) / 2]) {
    bar([-xw, y, zb], [xw, y, zb]);
    bar([-xw, y, zf], [xw, y, zf]);
    bar([-xw, y, zb], [-xw, y, zf]);
    bar([xw, y, zb], [xw, y, zf]);
  }
  for (let z = zb; z <= zf + 1e-6; z += 0.15) {
    bar([-xw, y0, z], [-xw, y1, z], 0.016);
    bar([xw, y0, z], [xw, y1, z], 0.016);
  }
  for (let x = -xw; x <= xw + 1e-6; x += 0.155) {
    bar([x, y0, zf], [x, y1, zf], 0.016);
    bar([x, y0, zb], [x, y1, zb], 0.016);
  }
  out.push(...quad([-xw, y0, zf], [xw, y0, zf], [xw, y0, zb], [-xw, y0, zb], C.steelDark));
  // Handle (red grip) and its posts, the lower tray, the chassis and the wheels.
  bar([-xw, y1, zb], [-xw, 1.03, -0.5]);
  bar([xw, y1, zb], [xw, 1.03, -0.5]);
  bar([-xw - 0.01, 1.03, -0.5], [xw + 0.01, 1.03, -0.5], 0.045, C.cartRed);
  bar([-0.25, 0.14, -0.38], [0.25, 0.14, 0.42], 0.02, C.steelDark);
  for (const x of [-0.25, 0.25]) {
    bar([x, 0.08, -0.42], [x, 0.08, 0.46], 0.035, C.steelDark);
    bar([x, 0.08, -0.42], [x, y0, -0.4], 0.03, C.steelDark);
    bar([x, 0.08, 0.46], [x, y0, 0.48], 0.03, C.steelDark);
  }
  for (const [x, z] of [
    [-0.25, -0.4],
    [0.25, -0.4],
    [-0.25, 0.44],
    [0.25, 0.44],
  ])
    // A wheel: a short cylinder turned onto its side (a quarter turn about z keeps its winding).
    out.push(...cylinder(0, 0, -0.025, 0.025, 0.065, 8, C.wheel).map((t) => ({ ...t, v: t.v.map(({ p, n }) => ({ p: [p[1] + x, -p[0] + 0.065, p[2] + z], n: [n[1], -n[0], n[2]] })) })));
  return out;
}
/** A wooden pallet (three stringers under seven top boards). */
function pallet(w, d, h) {
  const out = [];
  for (const z of [-d / 2 + 0.05, 0, d / 2 - 0.05]) out.push(...box([-w / 2, 0, z - 0.05], [w / 2, h - 0.03, z + 0.05], shaded(C.palletDark)));
  const boards = 7;
  for (let k = 0; k < boards; k++) {
    const x = -w / 2 + ((w - 0.12) * k) / (boards - 1);
    out.push(...box([x, h - 0.03, -d / 2], [x + 0.12, h, d / 2], shaded(k % 2 ? C.pallet : C.woodEnd)));
  }
  return out;
}
/** A breakfast box: a coloured box, a light front panel. */
function cereal(color, [w, h, d]) {
  return [
    ...box([-w / 2, 0, -d / 2], [w / 2, h, d / 2], shaded(color)),
    ...quad([-w * 0.32, h * 0.18, d / 2 + 0.002], [w * 0.32, h * 0.18, d / 2 + 0.002], [w * 0.32, h * 0.72, d / 2 + 0.002], [-w * 0.32, h * 0.72, d / 2 + 0.002], C.white),
  ];
}

// ─── The kit ───────────────────────────────────────────────────────────────

/** The families' gameplay sizes (propHuntProps.ts): x across, y up, z deep. */
const FAMILY_SIZE = {
  CanTower: [0.72, 0.66, 0.56],
  DrinkCrate: [0.66, 0.62, 0.5],
  Pumpkin: [0.72, 0.56, 0.72],
  BasketStack: [0.64, 0.7, 0.48],
  Watermelon: [0.8, 0.52, 0.52],
  Parcel: [0.82, 0.62, 0.62],
  TrashBin: [0.56, 0.9, 0.5],
  AppleCrate: [0.92, 0.6, 0.62],
  OrangeCrate: [0.92, 0.6, 0.62],
  Cart: [0.66, 1.05, 1.05],
  ProduceBin: [1.3, 0.85, 0.95],
  PalletBoxes: [1.25, 1.1, 1.05],
};

async function families() {
  const out = {};
  // Konserve kulesi: 3 + 2 + 1 cans in two rows, a groove between them.
  {
    const can = fit(await food('can'), { size: [0.235, 0.215, 0.235] });
    const tris = [];
    for (const z of [-0.16, 0.16]) for (const x of [-0.24, 0, 0.24]) tris.push(...place(can, { yaw: x * 7 + z, at: [x, 0, z] }));
    for (const x of [-0.12, 0.12]) tris.push(...place(can, { yaw: x * 5, at: [x, 0.218, 0] }));
    tris.push(...place(can, { yaw: 0.7, at: [0, 0.436, 0] }));
    out.CanTower = tris;
  }
  // Şişe kasası: a red crate of six bottles.
  {
    const bottle = fit(await food('soda-bottle'), { height: 0.57 });
    out.DrinkCrate = [...openBox(0.66, 0.32, 0.5, 0.03, C.crateRed, C.crateRedDark, C.crateRedDark, { bands: 3, bandColor: C.crateRedDark }), ...grid(bottle, 3, 2, 0.57, 0.4, 0.05, 3)];
  }
  out.Pumpkin = await food('pumpkin-basic');
  // Sepet yığını: four nested baskets, the top one with its handles.
  {
    const tris = [];
    for (let k = 0; k < 4; k++) tris.push(...place(basket(0.64, 0.48, 0.28, 0.84), { at: [0, k * 0.14, 0] }));
    tris.push(...box([-0.2, 0.7 - 0.02, -0.01], [0.2, 0.7, 0.01], C.handle));
    out.BasketStack = tris;
  }
  out.Watermelon = watermelon();
  out.Parcel = [...(await furniture('cardboardBoxClosed'))];
  out.TrashBin = await furniture('trashcan');
  for (const [node, fruit, seed] of [
    ['AppleCrate', 'apple', 5],
    ['OrangeCrate', 'orange', 9],
  ]) {
    const one = fit(await food(fruit), { height: 0.18 });
    out[node] = [...openBox(0.92, 0.42, 0.62, 0.035, C.wood, C.woodDark, C.woodEnd, { bands: 3, bandColor: C.woodDark }), ...mound(0.84, 0.54, 0.04, 0.42, C.mound), ...grid(one, 4, 3, 0.78, 0.5, 0.42, seed)];
  }
  out.Cart = cart();
  {
    const onion = fit(await food('onion'), { height: 0.2 });
    out.ProduceBin = [...openBox(1.3, 0.62, 0.95, 0.05, C.wood, C.woodDark, C.woodEnd, { bands: 4, bandColor: C.woodDark }), ...mound(1.2, 0.85, 0.05, 0.65, C.mound), ...grid(onion, 6, 4, 1.08, 0.74, 0.65, 7)];
  }
  {
    const parcel = fit(await furniture('cardboardBoxClosed'), { size: [0.6, 0.46, 0.5] });
    const tris = [...pallet(1.25, 1.05, 0.15)];
    for (const y of [0.15, 0.62]) for (const x of [-0.31, 0.31]) for (const z of [-0.26, 0.26]) tris.push(...place(parcel, { yaw: (x + z + y) * 4 > 0 ? 0 : Math.PI, at: [x, y, z] }));
    out.PalletBoxes = tris;
  }
  for (const node of Object.keys(out)) out[node] = fit(out[node], { size: FAMILY_SIZE[node] });
  return out;
}

/** Shelf stock and produce at 1.25× real size (heights in m). */
const STOCK = [
  ['Can', 'can', 0.15],
  ['CanSmall', 'can-small', 0.06],
  ['SodaBottle', 'soda-bottle', 0.38],
  ['OilBottle', 'bottle-oil', 0.36],
  ['WineRed', 'wine-red', 0.38],
  ['WineWhite', 'wine-white', 0.38],
  ['Ketchup', 'bottle-ketchup', 0.24],
  ['Mustard', 'bottle-musterd', 0.24],
  ['SodaCan', 'soda-can', 0.15],
  ['SodaBig', 'soda', 0.3],
  ['Carton', 'carton', 0.3],
  ['CartonSmall', 'carton-small', 0.2],
  ['Honey', 'honey', 0.15],
  ['PeanutButter', 'peanut-butter', 0.15],
  ['Pudding', 'pudding', 0.1],
  ['IceCream', 'ice-cream-cup', 0.12],
  ['Loaf', 'loaf', 0.16],
  ['Apple', 'apple', 0.1],
  ['Orange', 'orange', 0.1],
  ['Lemon', 'lemon', 0.09],
  ['Tomato', 'tomato', 0.09],
  ['Pear', 'pear', 0.12],
  ['Paprika', 'paprika', 0.11],
  ['Eggplant', 'eggplant', 0.2],
  ['Onion', 'onion', 0.1],
  ['Cabbage', 'cabbage', 0.2],
  ['Pineapple', 'pineapple', 0.3],
  ['Banana', 'banana', 0.08],
  ['Corn', 'corn', 0.14],
  ['Broccoli', 'broccoli', 0.18],
  ['Coconut', 'coconut', 0.12],
];
async function stock() {
  const out = {};
  for (const [node, file, height] of STOCK) out[node] = fit(await food(file), { height });
  out.CerealRed = fit(cereal(C.cerealRed, [0.26, 0.36, 0.09]), { scale: 1 });
  out.CerealYellow = fit(cereal(C.cerealYellow, [0.26, 0.36, 0.09]), { scale: 1 });
  out.CerealBlue = fit(cereal(C.cerealBlue, [0.22, 0.3, 0.08]), { scale: 1 });
  out.CerealGreen = fit(cereal(C.cerealGreen, [0.22, 0.3, 0.08]), { scale: 1 });
  out.Pasta = fit(cereal(C.pastaBlue, [0.18, 0.26, 0.07]), { scale: 1 });
  out.Tea = fit(cereal(C.teaGreen, [0.16, 0.12, 0.1]), { scale: 1 });
  // The watermelon heap's melons are the family's own model (a disguise beside the heap looks like one of it).
  return out;
}

/**
 * One indexed primitive per node; vertices shared when position and colour match. No normals:
 * every face is flat (one colour, one plane), so the arena computes them on load
 * (scene/prophunt/market/scenery.ts, non-indexed): a third of the bytes.
 */
function primitiveOf(triangles) {
  const positions = [],
    colors = [],
    indices = [],
    lookup = new Map();
  for (const t of triangles) {
    const rgba = [...t.color.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255)), 255];
    for (const v of t.v) {
      const key = [...v.p.map((x) => Math.round(x * 1e4)), ...rgba].join(',');
      let index = lookup.get(key);
      if (index === undefined) {
        index = positions.length / 3;
        lookup.set(key, index);
        positions.push(...v.p.map((x) => Math.round(x * 1e4) / 1e4));
        colors.push(...rgba);
      }
      indices.push(index);
    }
  }
  return { positions, colors, indices };
}

class GlbWriter {
  chunks = [];
  length = 0;
  json = { bufferViews: [], accessors: [] };
  view(data, target) {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const padding = (4 - (this.length % 4)) % 4;
    if (padding) {
      this.chunks.push(Buffer.alloc(padding));
      this.length += padding;
    }
    const view = { buffer: 0, byteOffset: this.length, byteLength: bytes.length };
    if (target) view.target = target;
    this.chunks.push(bytes);
    this.length += bytes.length;
    return this.json.bufferViews.push(view) - 1;
  }
  accessor(values, type, componentType, target, { withBounds = false, normalized = false } = {}) {
    const Type = COMPONENT[componentType];
    const bufferView = this.view(new Type(values), target);
    const accessor = { bufferView, componentType, count: values.length / WIDTH[type], type };
    if (normalized) accessor.normalized = true;
    if (withBounds) {
      const width = WIDTH[type];
      accessor.min = Array.from({ length: width }, () => Infinity);
      accessor.max = Array.from({ length: width }, () => -Infinity);
      values.forEach((v, i) => {
        accessor.min[i % width] = Math.min(accessor.min[i % width], v);
        accessor.max[i % width] = Math.max(accessor.max[i % width], v);
      });
    }
    return this.json.accessors.push(accessor) - 1;
  }
}

const CREDITS = `market-kit.glb — Party Lab "Saklambaç" (Prop Hunt) kit for the "Market" map

Sources (both by Kenney, www.kenney.nl, CC0 1.0 Universal, Public Domain Dedication,
https://creativecommons.org/publicdomain/zero/1.0/, per each pack's License.txt):
  Food Kit 2.0 (2024-06-26)        https://kenney.nl/assets/food-kit
  Furniture Kit 2.0 (2018-10-20)   https://kenney.nl/assets/furniture-kit
Attribution is not required; credit is given here voluntarily.

Only this curated subset is included:
  Food Kit: can, soda-bottle, pumpkin-basic, apple, orange, onion, ${STOCK.map(([, file]) => file)
    .filter((f) => !['can', 'soda-bottle', 'pumpkin', 'apple', 'orange', 'onion'].includes(f))
    .join(', ')}
  Furniture Kit: cardboardBoxClosed, trashcan

Changes: merged into one GLB; each model baked to one primitive with positions and
vertex colours, flat faces (the Food Kit's colormap.png sampled once per triangle;
UVs, tangents, textures and materials dropped); all materials opaque with metalness 0;
re-pivoted to bottom-centre; the transformable props fitted to their gameplay sizes,
the shelf stock at 1.25× real size. The crates, baskets, cart, pallet, watermelon and
cereal boxes are generated by the build script. Visual only: no gameplay collider
comes from this file. Rebuild with:
  node scripts/build-party-lab-market-kit.mjs [path/to/kenney_food-kit(.zip)] [path/to/kenney_furniture-kit]
`;

async function main() {
  const nodes = { ...(await families()), ...(await stock()) };
  const writer = new GlbWriter();
  const json = writer.json;
  Object.assign(json, {
    asset: { version: '2.0', generator: 'Party Lab build-party-lab-market-kit.mjs', copyright: 'CC0 1.0: Kenney (www.kenney.nl)' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    materials: [{ name: 'Market', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }],
  });
  const summary = [];
  for (const [node, triangles] of Object.entries(nodes)) {
    const p = primitiveOf(triangles);
    const mesh =
      json.meshes.push({
        name: node,
        primitives: [
          {
            attributes: {
              POSITION: writer.accessor(p.positions, 'VEC3', 5126, 34962, { withBounds: true }),
              COLOR_0: writer.accessor(p.colors, 'VEC4', 5121, 34962, { normalized: true }),
            },
            indices: writer.accessor(p.indices, 'SCALAR', p.positions.length / 3 > 65535 ? 5125 : 5123, 34963),
            material: 0,
          },
        ],
      }) - 1;
    json.scenes[0].nodes.push(json.nodes.push({ name: node, mesh }) - 1);
    summary.push({ node, triangles: triangles.length, vertices: p.positions.length / 3, size: bounds(triangles).size.map((v) => v.toFixed(2)).join(' × ') });
  }
  const bin = Buffer.concat(writer.chunks);
  const binPadded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  json.buffers = [{ byteLength: binPadded.length }];
  const jsonText = JSON.stringify(json);
  const jsonChunk = Buffer.concat([Buffer.from(jsonText), Buffer.alloc((4 - (jsonText.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binPadded.length, 8);
  const chunkHeader = (length, type) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(length, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  const glb = Buffer.concat([header, chunkHeader(jsonChunk.length, 0x4e4f534a), jsonChunk, chunkHeader(binPadded.length, 0x004e4942), binPadded]);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'market-kit.glb'), glb);
  fs.writeFileSync(path.join(outDir, 'MARKET-CREDITS.txt'), CREDITS);
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`market-kit.glb: ${kb(glb.length)}, ${summary.length} nodes, ${summary.reduce((n, s) => n + s.triangles, 0)} triangles, ${summary.reduce((n, s) => n + s.vertices, 0)} vertices`);
  for (const s of summary) console.log(`  ${s.node.padEnd(14)} ${String(s.triangles).padStart(5)} tris ${String(s.vertices).padStart(5)} verts  ${s.size}`);
}

main();
