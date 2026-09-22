#!/usr/bin/env node
// Builds public/party-lab/maps/rooftop/rooftop-kit.glb from a curated subset of
// Quaternius' Downtown City MegaKit (Standard, CC0). The raw pack stays outside
// the repository and is only read.
//
// Cleanup applied (see the rooftop audit):
// - only POSITION / NORMAL / TEXCOORD_0 + indices are kept (vertex colours, which
//   tint Cornice_Metal red in three.js, and the second UV set are dropped);
// - base colour only: no ORM (metalness 1 renders near-black without an
//   environment map) and no normal maps;
// - metalness 0, fixed roughness, opaque dark glass;
// - textures resized to 1024 WebP (EXT_texture_webp); the Ornaments atlas is
//   cropped to the band the three props use and their UVs are remapped.
//
// Gameplay colliders are NOT derived from this file; they live in
// shared/party-lab/maps/rooftop.ts.
//
// Usage: node scripts/build-party-lab-rooftop-kit.mjs [path/to/DowntownCityMegaKit_extracted]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'Downloads', 'DowntownCityMegaKit_extracted'));
const gltfDir = path.join(source, 'Exports', 'glTF (Godot)');
const outDir = path.join(projectRoot, 'public', 'party-lab', 'maps', 'rooftop');
const TEXTURE_SIZE = 1024;

// Ornaments atlas band used by Prop_ACUnit / Prop_Drain / Prop_ManholeCover (pixels of the 2048 source).
const ORNAMENTS_CROP = { left: 0, top: 1147, width: 1720, height: 901 };

const MATERIALS = {
  Asphalt: { texture: 'T_Concrete_Asphalt_BaseColor', roughness: 0.92 },
  Concrete: { texture: 'T_Concrete_BaseColor', roughness: 0.9 },
  RedBrick: { texture: 'T_RedBrick_BaseColor', roughness: 0.9 },
  MetalConcrete: { texture: 'T_MetalConcrete_BaseColor', roughness: 0.72 },
  Ornaments: { texture: 'T_Ornaments_BaseColor', roughness: 0.7, crop: ORNAMENTS_CROP },
  Glass: { color: [0.07, 0.09, 0.11, 1], roughness: 0.3 },
};
const SOURCE_MATERIAL = {
  MI_Asphalt: 'Asphalt',
  MI_Concrete: 'Concrete',
  MI_RedBrick: 'RedBrick',
  MI_InteriorWall: 'RedBrick',
  MI_Trim_MetalConcrete: 'MetalConcrete',
  MI_Ornaments: 'Ornaments',
  MI_Glass: 'Glass',
};
// Node name → source model and a translation. Pivots are normalised so the
// renderer can place pieces from the shared collider data: bottom at y=0,
// centred on x/z unless noted.
const MODELS = [
  { node: 'ACUnit', file: 'Prop_ACUnit', pivot: 'bottom-centre' }, // fan faces +Z
  { node: 'Parapet', file: 'Cornice_Brick_Center', pivot: 'bottom-centre' }, // 2 × 1 × 0.4 m, long axis X
  { node: 'Stairs', file: 'Stairs_Entrance_Concrete', pivot: 'bottom-centre' }, // landing at −Z, foot at +Z
  { node: 'DoorFrame', file: 'DoorFrame_Metal_Single', pivot: 'keep' }, // back face z = −0.2, opening x ±0.5
  { node: 'Door', file: 'Door_1', pivot: 'keep', translate: [0.5, 0, 0] }, // hinge-edge pivot → frame opening
  { node: 'Drain', file: 'Prop_Drain', pivot: 'keep' },
  { node: 'Hatch', file: 'Prop_ManholeCover', pivot: 'keep' },
];

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function fail(message) {
  console.error(`\n✗ build-party-lab-rooftop-kit: ${message}\n`);
  process.exit(1);
}

function readAccessor(gltf, bin, index) {
  const accessor = gltf.accessors[index];
  const view = gltf.bufferViews[accessor.bufferView];
  const Type = COMPONENT[accessor.componentType];
  const width = WIDTH[accessor.type];
  if (view.byteStride && view.byteStride !== width * Type.BYTES_PER_ELEMENT) fail(`interleaved accessor ${index} is not supported`);
  const offset = bin.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const copy = bin.buffer.slice(offset, offset + accessor.count * width * Type.BYTES_PER_ELEMENT);
  return Array.from(new Type(copy));
}

function loadModel({ node, file, pivot, translate = [0, 0, 0] }) {
  const gltfPath = path.join(gltfDir, `${file}.gltf`);
  if (!fs.existsSync(gltfPath)) fail(`missing ${gltfPath}`);
  const gltf = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));
  if (gltf.nodes.length !== 1 || gltf.nodes[0].translation || gltf.nodes[0].rotation || gltf.nodes[0].scale) fail(`${file}: expected one untransformed node`);
  const bin = fs.readFileSync(path.join(gltfDir, gltf.buffers[0].uri));
  const primitives = gltf.meshes[gltf.nodes[0].mesh].primitives.map((primitive) => {
    const sourceName = gltf.materials[primitive.material].name;
    const material = SOURCE_MATERIAL[sourceName];
    if (!material) fail(`${file}: unmapped material ${sourceName}`);
    return {
      material,
      positions: readAccessor(gltf, bin, primitive.attributes.POSITION),
      normals: readAccessor(gltf, bin, primitive.attributes.NORMAL),
      uvs: readAccessor(gltf, bin, primitive.attributes.TEXCOORD_0),
      indices: readAccessor(gltf, bin, primitive.indices),
    };
  });
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of primitives)
    for (let i = 0; i < p.positions.length; i += 3)
      for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c], p.positions[i + c]);
        max[c] = Math.max(max[c], p.positions[i + c]);
      }
  const shift = pivot === 'bottom-centre'
    ? [-(min[0] + max[0]) / 2, -min[1], -(min[2] + max[2]) / 2]
    : [0, 0, 0];
  for (const p of primitives) {
    for (let i = 0; i < p.positions.length; i += 3)
      for (let c = 0; c < 3; c++) p.positions[i + c] += shift[c] + translate[c];
    if (p.material === 'Ornaments') {
      const crop = ORNAMENTS_CROP;
      for (let i = 0; i < p.uvs.length; i += 2) {
        p.uvs[i] = (p.uvs[i] * 2048 - crop.left) / crop.width;
        p.uvs[i + 1] = (p.uvs[i + 1] * 2048 - crop.top) / crop.height;
        if (p.uvs[i] < -0.001 || p.uvs[i] > 1.001 || p.uvs[i + 1] < -0.001 || p.uvs[i + 1] > 1.001)
          fail(`${file}: UV outside the cropped Ornaments band`);
      }
    }
  }
  return { node, file, primitives, triangles: primitives.reduce((n, p) => n + p.indices.length / 3, 0) };
}

// A 1 × 1 m quad per tiling material, so every material ships even if no kit mesh uses it.
function swatch(material) {
  return {
    material,
    positions: [0, 0, 0, 1, 0, 0, 1, 0, -1, 0, 0, -1],
    normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

async function texture(name, crop) {
  const file = path.join(gltfDir, `${name}.png`);
  if (!fs.existsSync(file)) fail(`missing ${file}`);
  let image = sharp(file);
  const meta = await image.metadata();
  if (meta.width !== 2048 || meta.height !== 2048) fail(`${name}: expected 2048², got ${meta.width}×${meta.height}`);
  if (crop) image = image.extract(crop);
  return image
    .resize(TEXTURE_SIZE, crop ? TEXTURE_SIZE / 2 : TEXTURE_SIZE, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .webp({ quality: 80, effort: 6 })
    .toBuffer();
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
  accessor(values, type, componentType, target, withBounds) {
    const Type = COMPONENT[componentType];
    const bufferView = this.view(new Type(values), target);
    const accessor = { bufferView, componentType, count: values.length / WIDTH[type], type };
    if (withBounds) {
      const width = WIDTH[type];
      accessor.min = Array.from({ length: width }, (_, c) => Math.min(...values.filter((_, i) => i % width === c)));
      accessor.max = Array.from({ length: width }, (_, c) => Math.max(...values.filter((_, i) => i % width === c)));
    }
    return this.json.accessors.push(accessor) - 1;
  }
}

async function main() {
  if (!fs.existsSync(gltfDir)) fail(`source not found: ${gltfDir}`);
  const license = path.join(source, 'License_Standard.txt');
  if (!fs.existsSync(license) || !fs.readFileSync(license, 'utf8').includes('CC0 1.0')) fail('License_Standard.txt with the CC0 dedication was not found');

  const models = MODELS.map(loadModel);
  const writer = new GlbWriter();
  const json = writer.json;
  Object.assign(json, {
    asset: { version: '2.0', generator: 'Party Lab build-party-lab-rooftop-kit.mjs', copyright: 'Quaternius (CC0 1.0), Downtown City MegaKit Standard' },
    extensionsUsed: ['EXT_texture_webp'],
    extensionsRequired: ['EXT_texture_webp'],
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    materials: [],
    textures: [],
    images: [],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
  });

  const materialIndex = {};
  const textureBytes = {};
  for (const [name, spec] of Object.entries(MATERIALS)) {
    const pbr = { metallicFactor: 0, roughnessFactor: spec.roughness };
    if (spec.texture) {
      const data = await texture(spec.texture, spec.crop);
      textureBytes[spec.texture] = data.length;
      const image = json.images.push({ name: spec.texture, mimeType: 'image/webp', bufferView: writer.view(data) }) - 1;
      const tex = json.textures.push({ sampler: 0, extensions: { EXT_texture_webp: { source: image } } }) - 1;
      pbr.baseColorTexture = { index: tex };
    } else pbr.baseColorFactor = spec.color;
    materialIndex[name] = json.materials.push({ name, pbrMetallicRoughness: pbr, doubleSided: true }) - 1;
  }

  const addNode = (name, primitives) => {
    const mesh = json.meshes.push({
      name,
      primitives: primitives.map((p) => ({
        attributes: {
          POSITION: writer.accessor(p.positions, 'VEC3', 5126, 34962, true),
          NORMAL: writer.accessor(p.normals, 'VEC3', 5126, 34962),
          TEXCOORD_0: writer.accessor(p.uvs, 'VEC2', 5126, 34962),
        },
        indices: writer.accessor(p.indices, 'SCALAR', 5123, 34963),
        material: materialIndex[p.material],
      })),
    }) - 1;
    json.scenes[0].nodes.push(json.nodes.push({ name, mesh }) - 1);
  };
  for (const model of models) addNode(model.node, model.primitives);
  addNode('Swatches', ['Asphalt', 'Concrete', 'RedBrick'].map(swatch));

  const bin = Buffer.concat(writer.chunks);
  const binPadded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  json.buffers = [{ byteLength: binPadded.length }];
  const jsonText = JSON.stringify(json);
  const jsonChunk = Buffer.concat([Buffer.from(jsonText), Buffer.alloc((4 - (jsonText.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  const total = 12 + 8 + jsonChunk.length + 8 + binPadded.length;
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const chunkHeader = (length, type) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(length, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  const glb = Buffer.concat([header, chunkHeader(jsonChunk.length, 0x4e4f534a), jsonChunk, chunkHeader(binPadded.length, 0x004e4942), binPadded]);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'rooftop-kit.glb'), glb);

  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`rooftop-kit.glb: ${kb(glb.length)}`);
  for (const m of models) console.log(`  ${m.node.padEnd(10)} ${m.file.padEnd(26)} ${String(m.triangles).padStart(4)} tris`);
  for (const [name, bytes] of Object.entries(textureBytes)) console.log(`  ${name.padEnd(30)} ${kb(bytes)}`);
}

await main();
