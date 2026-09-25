#!/usr/bin/env node
// Builds public/party-lab/maps/bomb/bomb-kit.glb: the props of Bomba Sende's "Oyun Parkı"
// (a compact rooftop playground) from a small curated subset of CC0 packs. The raw
// packs stay outside the repository and are only read:
//   - Quaternius "Platformer Game Kit - Dec 2021" (the bomb, crates, clouds),
//   - Kenney Nature Kit 2.1 (planters, bushes, flowers),
//   - Quaternius "Toon Shooter Game Kit" (the slow traps: the Barn's bear trap model, in
//     Bomba Sende's own colours), from the Barn's asset folder.
//
// Same cleanup as build-party-lab-layers-kit.mjs (this is its pipeline with another model
// list):
// - every model is baked to one primitive with POSITION / NORMAL / COLOR_0 and
//   indices; UVs, tangents and textures are dropped;
// - colours come from one palette: each flat source material maps to a palette entry;
// - every material is opaque with metalness 0 (Kenney Nature ships metallicFactor 1,
//   which renders near-black without an environment map);
// - models are re-pivoted (bottom-centre) and scaled (the crate to a 1 m cube: the
//   arena stretches it over each crate collider).
//
// Gameplay geometry (floor, walls, decks, ramps, AC units, hop walls) is generated in code
// from the shared map data and never comes from this file, and nothing here has a
// collider: see src/party-lab/scene/bomb/arena.ts and scenery.ts.
//
// Usage: node scripts/build-party-lab-bomb-kit.mjs [path/to/PartyLabCollapseAssets] [path/to/PartyLabBarnAssets]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'Downloads', 'PartyLabCollapseAssets'));
const barnSource = path.resolve(process.argv[3] ?? path.join(os.homedir(), 'Downloads', 'PartyLabBarnAssets'));
const outDir = path.join(projectRoot, 'public', 'party-lab', 'maps', 'bomb');

const QUATERNIUS = 'QuaterniusPlatformer/Platformer Game Kit - Dec 2021';
const KENNEY_NATURE = 'Nature/Models/GLTF format';

// sRGB palette (written as linear vertex colours). The bomb reads as the darkest, most
// saturated thing on screen; the decoration is soft and stays out of the way.
const PALETTE = {
  BombBody: '#27232e',
  BombMetal: '#8a8494',
  BombShine: '#f6f1e8',
  CrateWood: '#c58a52',
  CrateLight: '#e2b27a',
  PotWood: '#b67a52',
  PotDark: '#7d5439',
  Leaves: '#7fc07c',
  Petal: '#f3c64d',
  PetalPurple: '#b58be0',
  Cloud: '#fbf8f3',
  TrapSteel: '#7d8694',
  TrapTeeth: '#e6eaef',
};

/**
 * Node → source model. `scale` is uniform; `colors` maps flat source materials to the palette;
 * `root: 'barn'` reads from the Barn's asset folder; `tone(height)` overrides the colour by a
 * triangle's centroid height (0 bottom … 1 top) for a one-material model.
 */
const MODELS = [
  { node: 'Bomb', file: `${QUATERNIUS}/Level and Mechanics/glTF/Bomb.gltf`, scale: 0.4, colors: { Black: 'BombBody', DarkMetal: 'BombMetal', White: 'BombShine' } },
  { node: 'Crate', file: `${QUATERNIUS}/Cubes/glTF/Cube_Crate.gltf`, scale: 1 / 2.02, colors: { Wood: 'CrateWood', Wood_Light: 'CrateLight' } },
  { node: 'Pot', file: `${KENNEY_NATURE}/pot_large.glb`, scale: 2.6, colors: { wood: 'PotWood', woodBarkDark: 'PotDark' } },
  { node: 'Bush', file: `${KENNEY_NATURE}/plant_bushDetailed.glb`, scale: 2.0, colors: { grass: 'Leaves' } },
  { node: 'FlowerYellow', file: `${KENNEY_NATURE}/flower_yellowA.glb`, scale: 2.4, colors: { grass: 'Leaves', colorYellow: 'Petal' } },
  { node: 'FlowerPurple', file: `${KENNEY_NATURE}/flower_purpleA.glb`, scale: 2.4, colors: { grass: 'Leaves', colorPurple: 'PetalPurple' } },
  { node: 'Cloud1', file: `${QUATERNIUS}/Nature/glTF/Cloud_1.gltf`, scale: 1, colors: { Cloud: 'Cloud' } },
  { node: 'Cloud2', file: `${QUATERNIUS}/Nature/glTF/Cloud_2.gltf`, scale: 1, colors: { Cloud: 'Cloud' } },
  { node: 'Cloud3', file: `${QUATERNIUS}/Nature/glTF/Cloud_3.gltf`, scale: 1, colors: { Cloud: 'Cloud' } },
  // Open jaws ≈ 0.79 × 0.93 m (the Barn's size); light teeth over a mid steel base, so it reads on the dark trap mat.
  { node: 'BearTrap', root: 'barn', file: 'Shooter/Bear Trap.glb', scale: 0.9, colors: { Grey: 'TrapSteel' }, tone: (h) => (h > 0.45 ? 'TrapTeeth' : 'TrapSteel') },
];

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function fail(message) {
  console.error(`\n✗ build-party-lab-bomb-kit: ${message}\n`);
  process.exit(1);
}

// ─── Colour ────────────────────────────────────────────────────────────────

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hexToLinear = (hex) => [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255));

// ─── glTF reading (.glb or .gltf with embedded/external buffers) ───────────

function readModel(file) {
  if (!fs.existsSync(file)) fail(`missing ${file}`);
  const bytes = fs.statSync(file).size;
  if (file.endsWith('.gltf')) {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const buffers = json.buffers.map((b) =>
      b.uri.startsWith('data:') ? Buffer.from(b.uri.slice(b.uri.indexOf(',') + 1), 'base64') : fs.readFileSync(path.join(path.dirname(file), b.uri))
    );
    return { json, buffers, bytes };
  }
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
  return { json, buffers: [bin], bytes };
}

function readAccessor({ json, buffers }, index) {
  const accessor = json.accessors[index];
  const view = json.bufferViews[accessor.bufferView];
  const Type = COMPONENT[accessor.componentType];
  const width = WIDTH[accessor.type];
  const stride = view.byteStride ?? width * Type.BYTES_PER_ELEMENT;
  const buffer = buffers[view.buffer ?? 0];
  const base = buffer.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const data = new DataView(buffer.buffer);
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
  const a = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  if (Math.abs(det) < 1e-12) fail('singular node transform');
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

/** Every triangle of a source file in file space, with its material name and (textured) centroid UV. */
function loadTriangles(relative, root = source) {
  const file = path.join(root, relative);
  const model = readModel(file);
  const { json } = model;
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
        const positions = readAccessor(model, primitive.attributes.POSITION);
        if (primitive.attributes.NORMAL === undefined) fail(`${relative}: missing normals`);
        const normals = readAccessor(model, primitive.attributes.NORMAL);
        const uvs = primitive.attributes.TEXCOORD_0 !== undefined ? readAccessor(model, primitive.attributes.TEXCOORD_0) : null;
        const count = positions.length / 3;
        const indices = primitive.indices !== undefined ? readAccessor(model, primitive.indices) : Array.from({ length: count }, (_, i) => i);
        const vertex = (i) => ({
          p: transformPoint(matrix, positions.slice(i * 3, i * 3 + 3)),
          n: transformNormal(normals3, normals.slice(i * 3, i * 3 + 3)),
        });
        for (let i = 0; i < indices.length; i += 3) {
          const corners = [indices[i], indices[i + 1], indices[i + 2]];
          const uv = uvs && [0, 1].map((c) => corners.reduce((sum, k) => sum + uvs[k * 2 + c], 0) / 3);
          triangles.push({ material, uv, v: corners.map(vertex) });
        }
      }
    }
    for (const child of node.children ?? []) walk(child, matrix);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const index of json.scenes[json.scene ?? 0].nodes) walk(index, identity);
  return { triangles, bytes: model.bytes, textured: triangles.some((t) => t.uv) };
}

// ─── Models ────────────────────────────────────────────────────────────────

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

function buildModel(spec) {
  const { triangles, bytes } = loadTriangles(spec.file, spec.root === 'barn' ? barnSource : source);
  const palette = Object.fromEntries(Object.entries(PALETTE).map(([name, hex]) => [name, hexToLinear(hex)]));
  const used = new Set();
  const { min, max } = bounds(triangles);
  for (const t of triangles) {
    let name = spec.colors[t.material];
    if (!name) fail(`${spec.file}: unmapped material ${t.material}`);
    if (spec.tone) name = spec.tone((t.v.reduce((sum, v) => sum + v.p[1], 0) / 3 - min[1]) / (max[1] - min[1] || 1));
    t.color = palette[name];
    used.add(name);
  }
  // Bottom-centre pivot, then the uniform scale.
  const offset = [-(min[0] + max[0]) / 2, -min[1], -(min[2] + max[2]) / 2];
  for (const t of triangles) for (const v of t.v) v.p = v.p.map((x, c) => (x + offset[c]) * spec.scale);
  return { node: spec.node, file: spec.file, sourceBytes: bytes, triangles, palette: [...used] };
}

/** One indexed primitive per node; vertices shared when position, normal and colour match. */
function primitiveOf(triangles) {
  const positions = [], normals = [], colors = [], indices = [], lookup = new Map();
  for (const t of triangles) {
    const rgba = [...t.color.map((c) => Math.round(c * 255)), 255];
    for (const v of t.v) {
      const key = [...v.p.map((x) => Math.round(x * 1e4)), ...v.n.map((x) => Math.round(x * 1e3)), ...rgba].join(',');
      let index = lookup.get(key);
      if (index === undefined) {
        index = positions.length / 3;
        lookup.set(key, index);
        positions.push(...v.p);
        normals.push(...v.n);
        colors.push(...rgba);
      }
      indices.push(index);
    }
  }
  return { positions, normals, colors, indices };
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

const CREDITS = `bomb-kit.glb — Party Lab "Bomba Sende" props ("Oyun Parkı")

Sources (all CC0 1.0 Universal, Public Domain Dedication,
https://creativecommons.org/publicdomain/zero/1.0/, per each pack's License.txt, or, for
the Toon Shooter Game Kit, as stated on its poly.pizza bundle page — see the Barn's
CREDITS.txt):
  Quaternius — Platformer Game Kit (Dec 2021)   https://quaternius.com
  Kenney — Nature Kit 2.1                        https://www.kenney.nl
  Quaternius — Toon Shooter Game Kit             https://poly.pizza/l/qraiSXoAru
Attribution is not required; credit is given here voluntarily.

Only this curated subset is included:
  Quaternius: Bomb, Cube_Crate, Cloud_1, Cloud_2, Cloud_3
  Kenney Nature: pot_large, plant_bushDetailed, flower_yellowA, flower_purpleA
  Quaternius Toon Shooter: Bear Trap (the slow traps; the same model as the Barn's)

Changes: merged into one GLB; each model baked to one primitive with positions,
normals and vertex colours (UVs, tangents and textures dropped; flat materials mapped
to one palette; the bear trap two-toned by height); all materials opaque with
metalness 0; re-pivoted to bottom-centre; scaled (the crate to a 1 m cube). Visual only: no gameplay collider comes from this
file (the arena geometry is generated from the shared map data).
Rebuild with:
  node scripts/build-party-lab-bomb-kit.mjs [path/to/PartyLabCollapseAssets] [path/to/PartyLabBarnAssets]
`;

async function main() {
  if (!fs.existsSync(source)) fail(`source not found: ${source}`);
  if (!fs.existsSync(barnSource)) fail(`Barn assets not found: ${barnSource}`);
  const nodes = MODELS.map((spec) => buildModel(spec));

  const writer = new GlbWriter();
  const json = writer.json;
  Object.assign(json, {
    asset: {
      version: '2.0',
      generator: 'Party Lab build-party-lab-bomb-kit.mjs',
      copyright: 'CC0 1.0: Quaternius (Platformer Game Kit, Toon Shooter Game Kit), Kenney (Nature Kit)',
    },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    // White, rough, metalness 0: the vertex colours carry the palette.
    materials: [{ name: 'Props', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }],
  });
  const summary = [];
  for (const { node, file, triangles, palette } of nodes) {
    if (!triangles.length) fail(`${node} is empty`);
    const p = primitiveOf(triangles);
    const mesh = json.meshes.push({
      name: node,
      primitives: [
        {
          attributes: {
            POSITION: writer.accessor(p.positions, 'VEC3', 5126, 34962, { withBounds: true }),
            NORMAL: writer.accessor(p.normals, 'VEC3', 5126, 34962),
            COLOR_0: writer.accessor(p.colors, 'VEC4', 5121, 34962, { normalized: true }),
          },
          indices: writer.accessor(p.indices, 'SCALAR', p.positions.length / 3 > 65535 ? 5125 : 5123, 34963),
          material: 0,
        },
      ],
    }) - 1;
    json.scenes[0].nodes.push(json.nodes.push({ name: node, mesh }) - 1);
    const b = bounds(triangles);
    summary.push({ node, file, triangles: triangles.length, vertices: p.positions.length / 3, palette, size: b.max.map((v, c) => (v - b.min[c]).toFixed(2)).join(' × ') });
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
  fs.writeFileSync(path.join(outDir, 'bomb-kit.glb'), glb);
  fs.writeFileSync(path.join(outDir, 'CREDITS.txt'), CREDITS);

  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`bomb-kit.glb: ${kb(glb.length)}, ${summary.reduce((n, s) => n + s.triangles, 0)} triangles, ${summary.reduce((n, s) => n + s.vertices, 0)} vertices`);
  for (const s of summary)
    console.log(`  ${s.node.padEnd(13)} ${String(s.triangles).padStart(5)} tris ${String(s.vertices).padStart(5)} verts  ${s.size.padEnd(20)} ${s.palette.join('/')}  ${s.file}`);
}

main();
