#!/usr/bin/env node
// Builds public/party-lab/maps/barn/barn-kit.glb from a curated subset of three
// Quaternius packs (CC0, via poly.pizza): Farm Buildings Bundle, Medieval Village
// Pack and Toon Shooter Game Kit. The raw packs stay outside the repository and
// are only read.
//
// Cleanup applied (see the Barn Shootout audit):
// - only POSITION / NORMAL + indices are kept (the weapons' all-white COLOR_0 and
//   unused UV sets are dropped; nothing is textured);
// - every material becomes an opaque, metalness-0 flat colour from one shared
//   palette (Medieval/Shooter ship metallicFactor 0.4, which renders near-black
//   without an environment map; the SMG's duplicated BLEND materials merge into
//   their opaque twins);
// - primitives sharing a palette colour are merged, so each node draws once per colour;
// - props are re-pivoted (bottom-centre) and scaled to their gameplay sizes.
//
// The barn itself (walls, roofs, floors, decks) is built procedurally in
// src/party-lab/scene/arenas/buildBarn.ts: the four-wing plan has no ready-made
// shell. From Big Barn only its pair of sliding doors is kept (the south entrance).
//
// Gameplay colliders are NOT derived from this file; they live in
// shared/party-lab/maps/barn.ts.
//
// Usage: node scripts/build-party-lab-barn-kit.mjs [path/to/PartyLabBarnAssets]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'Downloads', 'PartyLabBarnAssets'));
const outDir = path.join(projectRoot, 'public', 'party-lab', 'maps', 'barn');

/** Big Barn's two sliding doors, scaled to a 2.9 m high entrance (8 m across). */
const DOOR_SCALE = 1.36;
const DOOR_NODES = /^BigBarn_Door/;

// Linear-RGB palette. Every source material maps to one of these; metalness is always 0.
const PALETTE = {
  BarnRed: { color: [0.274, 0.056, 0.042], roughness: 0.9 },
  BarnRedDark: { color: [0.202, 0.043, 0.032], roughness: 0.9 },
  BarnTrim: { color: [0.64, 0.64, 0.64], roughness: 0.9 },
  Hay: { color: [0.431, 0.313, 0.096], roughness: 0.95 },
  Strap: { color: [0.07, 0.047, 0.015], roughness: 0.85 },
  Sack: { color: [0.231, 0.181, 0.103], roughness: 0.95 },
  WoodDark: { color: [0.122, 0.055, 0.019], roughness: 0.85 },
  WoodDarker: { color: [0.07, 0.032, 0.012], roughness: 0.85 },
  Iron: { color: [0.078, 0.082, 0.095], roughness: 0.6 },
  CrateWood: { color: [0.301, 0.162, 0.047], roughness: 0.85 },
  CrateWoodLight: { color: [0.511, 0.298, 0.081], roughness: 0.85 },
  Steel: { color: [0.22, 0.23, 0.281], roughness: 0.45 },
  Gunmetal: { color: [0.053, 0.053, 0.053], roughness: 0.45 },
  GunGrey: { color: [0.114, 0.114, 0.114], roughness: 0.45 },
  GunBlack: { color: [0.024, 0.024, 0.024], roughness: 0.45 },
};

const BARN_MATERIALS = { LightRed: 'BarnRed', DarkRed: 'BarnRedDark', White: 'BarnTrim' };
/**
 * Node → source model. `size` fits the bottom-centred model to exact metres per axis;
 * `scale` is uniform; pivot 'keep' leaves the source origin (the weapons' grip).
 */
const MODELS = [
  { node: 'HayBale', file: 'Medieval/Package-kYvD6QCQRd.glb', size: [1.7, 0.8, 1.1], materials: { Bag: 'Hay', Leather: 'Strap' } },
  { node: 'HaySheaf', file: 'Medieval/Hay.glb', scale: 6, materials: { Hay: 'Hay' } },
  { node: 'Barrel', file: 'Medieval/Barrel.glb', scale: 5, materials: { Wood: 'WoodDark', DarkWood: 'WoodDarker', Stone: 'Iron' } },
  { node: 'Sacks', file: 'Medieval/Bags.glb', scale: 5.5, materials: { Bag: 'Sack' } },
  { node: 'Rail', file: 'Medieval/Fence.glb', scale: 3, materials: { Wood: 'WoodDark' } }, // long axis X
  { node: 'Crate', file: 'Shooter/Crate.glb', size: [1.03, 1.03, 1.03], materials: { Wood: 'CrateWood', Wood_Light: 'CrateWoodLight' } },
  { node: 'Pallet', file: 'Shooter/Pallet.glb', scale: 1, materials: { Wood: 'CrateWood' } },
  // Held size (×0.7); muzzle toward −X, origin at the grip.
  { node: 'Shotgun', file: 'Shooter/Shotgun.glb', scale: 0.7, pivot: 'keep', materials: { Wood: 'CrateWood', Grey2: 'GunGrey', DarkGrey: 'Gunmetal', Grey: 'Steel' } },
  { node: 'Smg', file: 'Shooter/Smg.glb', scale: 0.7, pivot: 'keep', materials: { DarkGrey: 'Gunmetal', Grey: 'Steel', Black: 'GunBlack', Grey2: 'GunGrey' } },
  { node: 'BearTrap', file: 'Shooter/Bear Trap.glb', scale: 0.9, materials: { Grey: 'Steel' } },
];
const BARN_FILE = 'Farm/Big Barn.glb';

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function fail(message) {
  console.error(`\n✗ build-party-lab-barn-kit: ${message}\n`);
  process.exit(1);
}

// ─── glTF reading ──────────────────────────────────────────────────────────

function readGlb(file) {
  if (!fs.existsSync(file)) fail(`missing ${file}`);
  const buffer = fs.readFileSync(file);
  if (buffer.readUInt32LE(0) !== 0x46546c67) fail(`${file}: not a GLB`);
  let offset = 12, json, bin;
  while (offset < buffer.length) {
    const length = buffer.readUInt32LE(offset), type = buffer.readUInt32LE(offset + 4);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    offset += 8 + length;
  }
  if (!json || !bin) fail(`${file}: missing JSON or BIN chunk`);
  return { json, bin, bytes: buffer.length };
}

function readAccessor({ json, bin }, index) {
  const accessor = json.accessors[index];
  const view = json.bufferViews[accessor.bufferView];
  const Type = COMPONENT[accessor.componentType];
  const width = WIDTH[accessor.type];
  const stride = view.byteStride ?? width * Type.BYTES_PER_ELEMENT;
  const base = bin.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const data = new DataView(bin.buffer);
  const read = {
    5126: (o) => data.getFloat32(o, true), 5125: (o) => data.getUint32(o, true), 5123: (o) => data.getUint16(o, true),
    5121: (o) => data.getUint8(o), 5122: (o) => data.getInt16(o, true), 5120: (o) => data.getInt8(o),
  }[accessor.componentType];
  const out = new Array(accessor.count * width);
  for (let i = 0; i < accessor.count; i++)
    for (let c = 0; c < width; c++) out[i * width + c] = read(base + i * stride + c * Type.BYTES_PER_ELEMENT);
  return out;
}

// Column-major 4×4 matrices, as in glTF.
function nodeMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + w * z) * sx, 2 * (x * z - w * y) * sx, 0,
    2 * (x * y - w * z) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + w * x) * sy, 0,
    2 * (x * z + w * y) * sz, 2 * (y * z - w * x) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++) out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
  return out;
}
const transformPoint = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
/** Inverse-transpose of the upper 3×3 (row-major result), for normals. */
function normalMatrix(m) {
  const a = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]; // row-major 3×3
  const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  if (Math.abs(det) < 1e-12) fail('singular node transform');
  // Cofactor matrix = det · inverse-transpose.
  const c = [
    a[4] * a[8] - a[5] * a[7], -(a[3] * a[8] - a[5] * a[6]), a[3] * a[7] - a[4] * a[6],
    -(a[1] * a[8] - a[2] * a[7]), a[0] * a[8] - a[2] * a[6], -(a[0] * a[7] - a[1] * a[6]),
    a[1] * a[5] - a[2] * a[4], -(a[0] * a[5] - a[2] * a[3]), a[0] * a[4] - a[1] * a[3],
  ];
  return c.map((v) => v / det);
}
const normalize = ([x, y, z]) => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};
const transformNormal = (n, [x, y, z]) => normalize([n[0] * x + n[1] * y + n[2] * z, n[3] * x + n[4] * y + n[5] * z, n[6] * x + n[7] * y + n[8] * z]);

/** Every triangle of a source file in file space, with its source material and node name. */
function loadTriangles(relative) {
  const file = path.join(source, relative);
  const glb = readGlb(file);
  const { json } = glb;
  if (json.skins?.length || json.animations?.length) fail(`${relative}: skinned/animated models are not supported`);
  const triangles = [];
  const walk = (index, parent) => {
    const node = json.nodes[index];
    const matrix = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      const normals3 = normalMatrix(matrix);
      for (const primitive of json.meshes[node.mesh].primitives) {
        if ((primitive.mode ?? 4) !== 4) fail(`${relative}: only triangle lists are supported`);
        const material = json.materials?.[primitive.material]?.name;
        if (!material) fail(`${relative}: primitive without a named material`);
        const positions = readAccessor(glb, primitive.attributes.POSITION);
        if (primitive.attributes.NORMAL === undefined) fail(`${relative}: missing normals`);
        const normals = readAccessor(glb, primitive.attributes.NORMAL);
        const indices = primitive.indices !== undefined ? readAccessor(glb, primitive.indices) : positions.map((_, i) => i).filter((i) => i < positions.length / 3);
        const vertex = (i) => ({
          p: transformPoint(matrix, positions.slice(i * 3, i * 3 + 3)),
          n: transformNormal(normals3, normals.slice(i * 3, i * 3 + 3)),
        });
        for (let i = 0; i < indices.length; i += 3)
          triangles.push({ node: node.name ?? '', material, v: [vertex(indices[i]), vertex(indices[i + 1]), vertex(indices[i + 2])] });
      }
    }
    for (const child of node.children ?? []) walk(child, matrix);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const index of json.scenes[json.scene ?? 0].nodes) walk(index, identity);
  return { triangles, bytes: glb.bytes };
}

// ─── Geometry helpers ──────────────────────────────────────────────────────

function bounds(triangles) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const t of triangles)
    for (const { p } of t.v)
      for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c], p[c]);
        max[c] = Math.max(max[c], p[c]);
      }
  return { min, max };
}
/** Applies a per-axis scale and offset; normals follow the inverse scale. */
function place(triangles, scale, offset) {
  for (const t of triangles)
    for (const v of t.v) {
      v.p = v.p.map((x, c) => x * scale[c] + offset[c]);
      v.n = normalize(v.n.map((x, c) => x / scale[c]));
    }
}

// ─── Models ────────────────────────────────────────────────────────────────

function buildProp(spec) {
  const { triangles, bytes } = loadTriangles(spec.file);
  for (const t of triangles) {
    const mapped = spec.materials[t.material];
    if (!mapped) fail(`${spec.file}: unmapped material ${t.material}`);
    t.material = mapped;
  }
  const { min, max } = bounds(triangles);
  if (spec.pivot === 'keep') {
    const s = spec.scale;
    place(triangles, [s, s, s], [0, 0, 0]);
  } else {
    const centre = [-(min[0] + max[0]) / 2, -min[1], -(min[2] + max[2]) / 2];
    place(triangles, [1, 1, 1], centre);
    const scale = spec.size ? spec.size.map((size, c) => size / (max[c] - min[c])) : [spec.scale, spec.scale, spec.scale];
    place(triangles, scale, [0, 0, 0]);
  }
  return { node: spec.node, file: spec.file, sourceBytes: bytes, triangles };
}

/** Big Barn's two sliding doors (with their trim), bottom-centred; the barn is not used otherwise. */
function buildDoors() {
  const { triangles, bytes } = loadTriangles(BARN_FILE);
  const doors = triangles.filter((t) => DOOR_NODES.test(t.node));
  if (doors.length < 400) fail(`${BARN_FILE}: door meshes not found`);
  for (const t of doors) {
    const material = BARN_MATERIALS[t.material];
    if (!material) fail(`${BARN_FILE}: unmapped material ${t.material}`);
    t.material = material;
  }
  const { min, max } = bounds(doors);
  place(doors, [1, 1, 1], [-(min[0] + max[0]) / 2, -min[1], -(min[2] + max[2]) / 2]);
  place(doors, [DOOR_SCALE, DOOR_SCALE, DOOR_SCALE], [0, 0, 0]);
  return { node: 'BarnDoors', file: BARN_FILE, sourceBytes: bytes, triangles: doors };
}

/** Merges a node's triangles into one indexed primitive per palette material. */
function primitivesOf(triangles) {
  const groups = new Map();
  for (const t of triangles) {
    if (!groups.has(t.material)) groups.set(t.material, { positions: [], normals: [], indices: [], lookup: new Map() });
    const g = groups.get(t.material);
    for (const v of t.v) {
      const key = [...v.p, ...v.n].map((x) => Math.round(x * 1e4)).join(',');
      let index = g.lookup.get(key);
      if (index === undefined) {
        index = g.positions.length / 3;
        g.lookup.set(key, index);
        g.positions.push(...v.p);
        g.normals.push(...v.n);
      }
      g.indices.push(index);
    }
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([material, g]) => ({ material, positions: g.positions, normals: g.normals, indices: g.indices }));
}

// ─── GLB writing ───────────────────────────────────────────────────────────

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
  accessor(values, type, componentType, target, withBounds) {
    const Type = COMPONENT[componentType];
    const bufferView = this.view(new Type(values), target);
    const accessor = { bufferView, componentType, count: values.length / WIDTH[type], type };
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

function main() {
  if (!fs.existsSync(source)) fail(`source not found: ${source}`);
  const nodes = [buildDoors(), ...MODELS.map(buildProp)];

  const writer = new GlbWriter();
  const json = writer.json;
  Object.assign(json, {
    asset: {
      version: '2.0',
      generator: 'Party Lab build-party-lab-barn-kit.mjs',
      copyright: 'Quaternius (CC0 1.0): Farm Buildings Bundle, Medieval Village Pack, Toon Shooter Game Kit',
    },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    materials: [],
  });
  const used = [...new Set(nodes.flatMap((n) => n.triangles.map((t) => t.material)))].sort();
  const materialIndex = {};
  for (const name of used) {
    const spec = PALETTE[name];
    if (!spec) fail(`palette is missing ${name}`);
    materialIndex[name] = json.materials.push({
      name,
      pbrMetallicRoughness: { baseColorFactor: [...spec.color, 1], metallicFactor: 0, roughnessFactor: spec.roughness },
    }) - 1;
  }
  const summary = [];
  for (const { node, file, triangles } of nodes) {
    if (!triangles.length) fail(`${node} is empty`);
    const primitives = primitivesOf(triangles);
    const mesh = json.meshes.push({
      name: node,
      primitives: primitives.map((p) => ({
        attributes: {
          POSITION: writer.accessor(p.positions, 'VEC3', 5126, 34962, true),
          NORMAL: writer.accessor(p.normals, 'VEC3', 5126, 34962),
        },
        indices: writer.accessor(p.indices, 'SCALAR', p.positions.length / 3 > 65535 ? 5125 : 5123, 34963),
        material: materialIndex[p.material],
      })),
    }) - 1;
    json.scenes[0].nodes.push(json.nodes.push({ name: node, mesh }) - 1);
    const b = bounds(triangles);
    summary.push({ node, file, triangles: triangles.length, materials: primitives.length, size: b.max.map((v, c) => (v - b.min[c]).toFixed(2)).join(' × ') });
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
  fs.writeFileSync(path.join(outDir, 'barn-kit.glb'), glb);

  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`barn-kit.glb: ${kb(glb.length)}, ${used.length} materials, ${summary.reduce((n, s) => n + s.triangles, 0)} triangles`);
  for (const s of summary) console.log(`  ${s.node.padEnd(13)} ${String(s.triangles).padStart(5)} tris  ${s.materials} mat  ${s.size.padEnd(22)} ${s.file}`);
}

main();
