#!/usr/bin/env node
// Builds public/party-lab/maps/layers/layers-kit.glb: the background scenery of
// Katman Kaosu ("Gök Petekleri": a floating honeycomb high in the sky) from a small
// curated subset of three CC0 packs. The raw packs stay outside the repository and
// are only read:
//   - Quaternius "Platformer Game Kit - Dec 2021" (clouds, rock islands, a tree),
//   - Kenney Nature Kit 2.1 (ruined columns),
//   - Kenney Platformer Kit 4.1 (grass hex blocks, a flag).
//
// Cleanup applied:
// - every model is baked to one primitive with POSITION / NORMAL / COLOR_0 and
//   indices; UVs, tangents and textures are dropped;
// - colours come from one pastel palette. Flat source materials map to a palette
//   entry; Kenney Platformer's colormap atlas is sampled per triangle and each sample
//   is re-tinted to its palette role, keeping the atlas's light/dark shading as a
//   brightness ratio;
// - every material is opaque with metalness 0 (Kenney Nature ships metallicFactor 1,
//   which renders near-black without an environment map);
// - models are re-pivoted (bottom-centre) and scaled (Quaternius is ~2× Kenney).
//
// The gameplay tiles are generated in code and never come from this file, and
// nothing here has a collider: see src/party-lab/scene/layers/skyScenery.ts.
//
// Usage: node scripts/build-party-lab-layers-kit.mjs [path/to/PartyLabCollapseAssets]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'Downloads', 'PartyLabCollapseAssets'));
const outDir = path.join(projectRoot, 'public', 'party-lab', 'maps', 'layers');

const QUATERNIUS = 'QuaterniusPlatformer/Platformer Game Kit - Dec 2021/Nature/glTF';
const KENNEY_NATURE = 'Nature/Models/GLTF format';
const KENNEY_PLATFORMER = 'Platformer/Models/GLB format';

// sRGB palette (written as linear vertex colours). Softer and paler than the gameplay
// tiles: the scenery must never out-shout a tile.
const PALETTE = {
  Cloud: '#fbf7f1',
  IslandRock: '#cfae92',
  IslandStone: '#b3b9c8',
  Foliage: '#93c79a',
  Trunk: '#a3826a',
  RuinStone: '#ece4d8',
  RuinStoneDark: '#d6cbbd',
  HexGrass: '#8fcf86',
  HexEarth: '#d9a784',
  FlagPole: '#a9a4b8',
  FlagCloth: '#a98bd8',
};

/**
 * Node → source model. `scale` is uniform; `colors` maps flat source materials to the
 * palette; `roles` (textured models) maps colormap reference colours (sRGB) to the palette.
 */
const MODELS = [
  { node: 'Cloud1', file: `${QUATERNIUS}/Cloud_1.gltf`, scale: 0.5, colors: { Cloud: 'Cloud' } },
  { node: 'Cloud2', file: `${QUATERNIUS}/Cloud_2.gltf`, scale: 0.5, colors: { Cloud: 'Cloud' } },
  { node: 'Cloud3', file: `${QUATERNIUS}/Cloud_3.gltf`, scale: 0.5, colors: { Cloud: 'Cloud' } },
  { node: 'IslandLarge', file: `${QUATERNIUS}/RockPlatforms_Large.gltf`, scale: 0.5, colors: { Rock: 'IslandRock' } },
  { node: 'IslandMedium', file: `${QUATERNIUS}/RockPlatforms_Medium.gltf`, scale: 0.5, colors: { Rock: 'IslandRock' } },
  { node: 'IslandTall', file: `${QUATERNIUS}/RockPlatform_Tall.gltf`, scale: 0.5, colors: { Rock: 'IslandRock' } },
  { node: 'Rock2', file: `${QUATERNIUS}/Rock_2.gltf`, scale: 0.5, colors: { Rock_Grey: 'IslandStone' } },
  { node: 'Tree', file: `${QUATERNIUS}/Tree.gltf`, scale: 0.5, colors: { Wood: 'Trunk', Green: 'Foliage' } },
  { node: 'Bush', file: `${QUATERNIUS}/Bush.gltf`, scale: 0.5, colors: { Green: 'Foliage' } },
  { node: 'Column', file: `${KENNEY_NATURE}/statue_column.glb`, scale: 1, colors: { stone: 'RuinStone', stoneDark: 'RuinStoneDark', _defaultMat: 'RuinStone' } },
  { node: 'ColumnDamaged', file: `${KENNEY_NATURE}/statue_columnDamaged.glb`, scale: 1, colors: { stone: 'RuinStone', stoneDark: 'RuinStoneDark' } },
  { node: 'Obelisk', file: `${KENNEY_NATURE}/statue_obelisk.glb`, scale: 1, colors: { stone: 'RuinStone', stoneDark: 'RuinStoneDark' } },
  { node: 'Ring', file: `${KENNEY_NATURE}/statue_ring.glb`, scale: 1, colors: { stone: 'RuinStone', stoneDark: 'RuinStoneDark' } },
  {
    node: 'HexBlock',
    file: `${KENNEY_PLATFORMER}/block-grass-hexagon.glb`,
    scale: 1,
    roles: [
      { ref: '#5ac487', palette: 'HexGrass' },
      { ref: '#d9835c', palette: 'HexEarth' },
    ],
  },
  {
    node: 'HexOverhang',
    file: `${KENNEY_PLATFORMER}/block-grass-overhang-hexagon.glb`,
    scale: 1,
    roles: [
      { ref: '#5ac487', palette: 'HexGrass' },
      { ref: '#d9835c', palette: 'HexEarth' },
    ],
  },
  {
    node: 'Flag',
    file: `${KENNEY_PLATFORMER}/flag.glb`,
    scale: 1,
    roles: [
      { ref: '#797c91', palette: 'FlagPole' },
      { ref: '#ea6246', palette: 'FlagCloth' },
    ],
  },
];

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function fail(message) {
  console.error(`\n✗ build-party-lab-layers-kit: ${message}\n`);
  process.exit(1);
}

// ─── Colour ────────────────────────────────────────────────────────────────

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hexToLinear = (hex) => [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

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
function loadTriangles(relative) {
  const file = path.join(source, relative);
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

async function loadColormap() {
  const file = path.join(source, KENNEY_PLATFORMER, 'Textures', 'colormap.png');
  if (!fs.existsSync(file)) fail(`missing ${file}`);
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  /** Linear colour of the atlas at a UV (nearest texel, glTF UV origin top-left). */
  return ([u, v]) => {
    const x = Math.min(info.width - 1, Math.max(0, Math.floor(u * info.width)));
    const y = Math.min(info.height - 1, Math.max(0, Math.floor(v * info.height)));
    const o = (y * info.width + x) * info.channels;
    return [data[o], data[o + 1], data[o + 2]].map((c) => srgbToLinear(c / 255));
  };
}

function buildModel(spec, colormap) {
  const { triangles, bytes, textured } = loadTriangles(spec.file);
  const palette = Object.fromEntries(Object.entries(PALETTE).map(([name, hex]) => [name, hexToLinear(hex)]));
  const roles = spec.roles?.map((r) => ({ ...r, linear: hexToLinear(r.ref) }));
  const used = new Set();
  for (const t of triangles) {
    if (spec.roles) {
      if (!textured || !t.uv) fail(`${spec.file}: roles need a textured model`);
      // Nearest role reference; keep the atlas's shading as a brightness ratio.
      const sample = colormap(t.uv);
      const role = roles.reduce((best, r) => (distance(r.linear, sample) < distance(best.linear, sample) ? r : best));
      const ratio = Math.min(1.25, luma(sample) / luma(role.linear));
      t.color = palette[role.palette].map((c) => Math.min(1, c * ratio));
      used.add(role.palette);
    } else {
      const name = spec.colors[t.material];
      if (!name) fail(`${spec.file}: unmapped material ${t.material}`);
      t.color = palette[name];
      used.add(name);
    }
  }
  // Bottom-centre pivot, then the uniform scale.
  const { min, max } = bounds(triangles);
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

const CREDITS = `layers-kit.glb — Party Lab "Katman Kaosu" sky scenery kit ("Gök Petekleri")

Sources (all CC0 1.0 Universal, Public Domain Dedication,
https://creativecommons.org/publicdomain/zero/1.0/, per each pack's License.txt):
  Quaternius — Platformer Game Kit (Dec 2021)   https://quaternius.com
  Kenney — Nature Kit 2.1                        https://www.kenney.nl
  Kenney — Platformer Kit 4.1                    https://www.kenney.nl
Attribution is not required; credit is given here voluntarily.

Only this curated subset is included:
  Quaternius: Cloud_1, Cloud_2, Cloud_3, RockPlatforms_Large, RockPlatforms_Medium,
              RockPlatform_Tall, Rock_2, Tree, Bush
  Kenney Nature: statue_column, statue_columnDamaged, statue_obelisk, statue_ring
  Kenney Platformer: block-grass-hexagon, block-grass-overhang-hexagon, flag

Changes: merged into one GLB; each model baked to one primitive with positions,
normals and vertex colours (UVs, tangents and the colormap texture dropped; the
Platformer Kit's atlas colours sampled per triangle and re-tinted to a pastel
palette); all materials opaque with metalness 0; re-pivoted to bottom-centre;
Quaternius scaled 0.5×. Visual only: no gameplay collider comes from this file.
Rebuild with:
  node scripts/build-party-lab-layers-kit.mjs [path/to/PartyLabCollapseAssets]
`;

async function main() {
  if (!fs.existsSync(source)) fail(`source not found: ${source}`);
  const colormap = await loadColormap();
  const nodes = MODELS.map((spec) => buildModel(spec, colormap));

  const writer = new GlbWriter();
  const json = writer.json;
  Object.assign(json, {
    asset: {
      version: '2.0',
      generator: 'Party Lab build-party-lab-layers-kit.mjs',
      copyright: 'CC0 1.0: Quaternius (Platformer Game Kit), Kenney (Nature Kit, Platformer Kit)',
    },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    // White, rough, metalness 0: the vertex colours carry the palette.
    materials: [{ name: 'Scenery', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }],
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
  fs.writeFileSync(path.join(outDir, 'layers-kit.glb'), glb);
  fs.writeFileSync(path.join(outDir, 'CREDITS.txt'), CREDITS);

  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`layers-kit.glb: ${kb(glb.length)}, ${summary.reduce((n, s) => n + s.triangles, 0)} triangles, ${summary.reduce((n, s) => n + s.vertices, 0)} vertices`);
  for (const s of summary)
    console.log(`  ${s.node.padEnd(13)} ${String(s.triangles).padStart(5)} tris ${String(s.vertices).padStart(5)} verts  ${s.size.padEnd(20)} ${s.palette.join('/')}  ${s.file}`);
}

main();
