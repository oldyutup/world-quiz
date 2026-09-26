#!/usr/bin/env node
// Builds public/party-lab/maps/prop-hunt/prop-hunt-kit.glb: every model Saklambaç's
// "Orman Kampı" draws, from a curated subset of five CC0 Quaternius packs. The raw packs stay
// outside the repository and are only read:
//   - Medieval Village MegaKit (Standard)  — doors, windows, rails, fences, the wagon, crates;
//   - Stylized Nature MegaKit (Standard)   — trees, bushes, rocks, ground cover;
//   - Ultimate House Interior Pack (2020)  — furniture (OBJ + MTL: this pack has no glTF);
//   - Survival Pack (2020)                 — camp props (OBJ + MTL);
//   - Medieval Village Pack (the Barn's source folder) — Barrel, Bags, Bench.
//
// Cleanup (the Bomba Sende / Katman Kaosu kit pipeline, extended):
// - every model is baked to one primitive with POSITION / NORMAL / COLOR_0 and indices; UVs,
//   tangents, textures and extra materials are dropped: the runtime needs one untextured
//   Lambert material for the whole camp;
// - flat source materials (MTL Kd, glTF base colours) map to one camp palette by name;
// - textured models (Medieval's trim sheets, Nature's bark and leaf cards) are sampled once per
//   triangle at its UV centroid (then optionally re-tinted, keeping the texel's lightness), and
//   leaf-card triangles whose centroid is transparent are dropped — the cards become faceted
//   low-poly foliage instead of opaque quads; Nature's bark vertex colours (baked AO) multiply in;
//   window frames drop their glass (the arena draws see-through panes);
// - metalness 0 everywhere (Medieval ships metallicFactor 1 on plaster and stone);
// - models are re-pivoted to bottom-centre and scaled; each transformable prop family is fitted
//   to exactly its gameplay shape (shared/party-lab/maps/propHuntProps.ts), so a disguise and a
//   decoy draw identically and cover their collider.
//
// Gameplay colliders are never derived from this file (shared/party-lab/maps/propHunt.ts).
//
// Usage: node scripts/build-party-lab-prop-hunt-kit.mjs [path/to/PartyLabPropHuntAssets] [path/to/PartyLabBarnAssets]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'Downloads', 'PartyLabPropHuntAssets'));
const barnSource = path.resolve(process.argv[3] ?? path.join(os.homedir(), 'Downloads', 'PartyLabBarnAssets'));
const outDir = path.join(projectRoot, 'public', 'party-lab', 'maps', 'prop-hunt');

const ROOTS = {
  MV: path.join(source, 'MedievalVillage', 'Medieval Village MegaKit[Standard]', 'glTF'),
  SN: path.join(source, 'StylizedNature', 'glTF'),
  HI: path.join(source, 'HouseInterior', 'Ultimate House Interior Pack - June 2020', 'OBJ'),
  SV: path.join(source, 'Survival', 'Survival Pack - Sept 2020', 'OBJ'),
  BA: path.join(barnSource, 'Medieval'),
};

// sRGB palette (written as linear vertex colours): a warm summer-camp look, light enough to
// read under the arena's soft hemisphere light.
const PALETTE = {
  Cream: '#efe4cf',
  White: '#f3f0e8',
  Stone: '#b3aa9c',
  StoneDark: '#8d8578',
  Wood: '#b8814f',
  WoodDark: '#7c5334',
  WoodLight: '#d6a570',
  Bark: '#8a5b3b',
  LogCut: '#e0b97f',
  Cushion: '#dcc9a3',
  Fabric: '#caa878',
  FabricDark: '#a88359',
  Mustard: '#dba543',
  Denim: '#5f82a8',
  Moss: '#728f4e',
  Red: '#c9533d',
  RedDark: '#963a2d',
  Tan: '#e2b376',
  Charcoal: '#3d3935',
  Metal: '#8e9196',
  Steel: '#bac0c6',
  Iron: '#5d6066',
  Glass: '#bfe0ee',
  Sage: '#8fb19c',
  Counter: '#dcd5c8',
  Leaf: '#72b04c',
  LeafDark: '#437d3c',
  Soil: '#7d5b3d',
  Lamp: '#fff2c8',
  Canvas: '#9d7d54',
  Olive: '#8b914f',
  Brass: '#cfa64b',
  Khaki: '#6f6f3d',
  Orange: '#e38a3b',
  Flame: '#ffab45',
  BinGreen: '#3f7f52',
  TentGreen: '#5f8049',
  TentLight: '#86a05f',
  Rope: '#d9c9a6',
  Sack: '#c9ae82',
  BarrelWood: '#9a6238',
  BarrelDark: '#6d4427',
  Hoop: '#6e7176',
  Brick: '#a39585',
};

/** OBJ/GLB flat material names (HouseInterior, Survival, the Barn pack) → palette. Per-model `colors` override. */
const MATERIALS = {
  White: 'Cream',
  'White.001': 'Cream',
  'White.002': 'Cream',
  Grey: 'Stone',
  Wood: 'Wood',
  Wood_Dark: 'WoodDark',
  Wood_Light: 'WoodLight',
  Cushin: 'Cushion',
  Couch_Beige: 'Fabric',
  Couch_BeigeDark: 'FabricDark',
  Couch_Mustard: 'Mustard',
  Couch_Blue: 'Denim',
  Couch_Green: 'Moss',
  Red: 'Red',
  DarkRed: 'RedDark',
  LightOrange: 'Tan',
  Black: 'Charcoal',
  Metal: 'Metal',
  'Metal.001': 'Metal',
  LightMetal: 'Steel',
  DarkMetal: 'Iron',
  Glass: 'Glass',
  Mirror: 'Glass',
  Kitchen: 'Sage',
  KitchenTop: 'Counter',
  Marble: 'Stone',
  Plant_Green: 'Leaf',
  DarkGreen: 'LeafDark',
  Brown: 'Soil',
  Light: 'Lamp',
  DarkWood: 'WoodDark',
  LightGrey: 'Steel',
  LightWood: 'LogCut',
  LightGreen: 'Olive',
  Gold: 'Brass',
  Green: 'Khaki',
  Orange: 'Orange',
  Fire: 'Flame',
  Yellow: 'Brass',
  DarkYellow: 'Brass',
  LightBlue: 'Glass',
  Stone: 'Iron',
  Bag: 'Sack',
};

const fam = (x, y, z) => ({ size: [x, y, z] });
/**
 * Node → source. `fit.size` scales each axis to exactly that size (m, after `turn`); `fit.scale`
 * is uniform; `fit.height` scales uniformly to that height. `turn`: quarter turns about +Y
 * applied first (so the model's front faces +z); `upright`: stand a lying model on its end
 * (the stump from the log). `colors` overrides MATERIALS; `sample` samples textures instead
 * (`hue`: re-tint to that hue, keeping lightness; `grade`: brightness × and saturation ×).
 */
const MODELS = [
  // ── Transformable families (fitted to their gameplay shapes) ──
  { node: 'Crate', src: 'MV', file: 'Prop_Crate.gltf', fit: fam(0.92, 0.92, 0.92), sample: { grade: [1.08, 1.05] } },
  { node: 'Log', src: 'SV', file: 'WoodLog.obj', fit: fam(1.5, 0.46, 0.46), colors: { Wood: 'Bark', LightWood: 'LogCut' } },
  { node: 'Stump', src: 'SV', file: 'WoodLog.obj', upright: true, fit: fam(0.72, 0.66, 0.72), colors: { Wood: 'Bark', LightWood: 'LogCut' } },
  { node: 'Backpack', src: 'SV', file: 'Backpack.obj', fit: fam(0.86, 0.8, 0.46), colors: { Brown: 'Canvas', LightGreen: 'Olive', Gold: 'Brass', Green: 'Khaki' } },
  { node: 'Propane', src: 'SV', file: 'PropaneTank.obj', fit: fam(0.64, 0.86, 0.64), colors: { White: 'White', Red: 'Red', Black: 'Charcoal', Orange: 'Orange' } },
  { node: 'WheelieBin', src: 'SV', file: 'Trashcan.obj', fit: fam(0.62, 1.1, 0.8), colors: { DarkGreen: 'BinGreen', Black: 'Charcoal' } },
  { node: 'MetalCan', src: 'HI', file: 'Trashcan_Large.obj', fit: fam(0.76, 1.15, 0.76), colors: { LightMetal: 'Steel' } },
  { node: 'Chair', src: 'HI', file: 'Chair_1.obj', fit: fam(0.5, 1.1, 0.54) },
  { node: 'Nightstand', src: 'HI', file: 'NightStand_2.obj', fit: fam(0.62, 0.62, 0.62) },
  { node: 'Dresser', src: 'HI', file: 'Drawer_5.obj', fit: fam(1.75, 0.84, 0.72) },
  { node: 'Armchair', src: 'HI', file: 'Couch_Small2.obj', fit: fam(1.32, 0.8, 1.25), colors: { Couch_Beige: 'Denim', Couch_BeigeDark: 'FabricDark' } },
  { node: 'SideTable', src: 'HI', file: 'Table_RoundSmall.obj', fit: fam(1.2, 0.72, 1.2) },
  { node: 'PottedPlant', src: 'HI', file: 'Houseplant_6.obj', fit: fam(0.8, 0.78, 0.8), colors: { Grey: 'Brick' } },
  { node: 'FlowerBush', src: 'SN', file: 'Bush_Common_Flowers.gltf', fit: fam(1.28, 1.1, 1.28), sample: { cut: true, grade: [1.05, 1.0] } },
  { node: 'Bush', src: 'SN', file: 'Bush_Common.gltf', fit: fam(1.28, 1.1, 1.28), sample: { cut: true, hue: 112, grade: [1.1, 0.85] } },
  { node: 'Boulder', src: 'SN', file: 'Rock_Medium_2.gltf', fit: fam(1.28, 0.8, 1.04), sample: { grade: [1.15, 0.8] } },
  { node: 'BoulderB', src: 'SN', file: 'Rock_Medium_1.gltf', fit: fam(1.2, 0.9, 1.2), sample: { grade: [1.1, 0.9] } },
  { node: 'Sapling', src: 'SN', file: 'Pine_5.gltf', fit: { height: 1.9 }, sample: { cut: true, grade: [1.05, 1.0] } },
  { node: 'Barrel', src: 'BA', file: 'Barrel.glb', fit: fam(0.78, 1.0, 0.78), colors: { Wood: 'BarrelWood', DarkWood: 'BarrelDark', Stone: 'Hoop' } },
  { node: 'Sacks', src: 'BA', file: 'Bags.glb', fit: fam(1.3, 0.56, 1.15), colors: { Bag: 'Sack' } },
  // ── Furniture and camp dressing (interior at 1.25× real size) ──
  { node: 'Fireplace', src: 'HI', file: 'Fireplace.obj', fit: fam(2.03, 1.6, 0.72), colors: { Marble: 'Stone' } },
  { node: 'Couch', src: 'HI', file: 'Couch_Medium2.obj', fit: fam(2.82, 1.22, 1.25), colors: { Couch_Mustard: 'Mustard', Wood: 'WoodDark' } },
  { node: 'DiningTable', src: 'HI', file: 'Table_RoundLarge.obj', fit: fam(2.32, 0.7, 1.21) },
  { node: 'BunkBed', src: 'HI', file: 'Bed_Bunk.obj', fit: fam(1.36, 1.89, 2.5), colors: { Grey: 'Iron' } },
  { node: 'Bookshelf', src: 'HI', file: 'Bookshelf.obj', fit: fam(1.45, 2.78, 0.48), colors: { White: 'Wood' } },
  { node: 'ToolShelf', src: 'HI', file: 'Shelf_Large.obj', fit: fam(2.11, 2.77, 0.47), colors: { White: 'WoodDark' } },
  { node: 'KitchenSink', src: 'HI', file: 'Kitchen_Sink.obj', fit: fam(0.63, 1.2, 0.7) },
  { node: 'KitchenDrawers', src: 'HI', file: 'Kitchen_2Drawers.obj', fit: fam(0.63, 1.01, 0.7) },
  { node: 'KitchenOven', src: 'HI', file: 'Kitchen_Oven.obj', fit: fam(0.63, 1.01, 0.7) },
  { node: 'Fridge', src: 'HI', file: 'Kitchen_Fridge.obj', fit: fam(0.81, 2.07, 0.81) },
  { node: 'FloorLamp', src: 'HI', file: 'Light_Stand2.obj', fit: { scale: 0.625 } },
  { node: 'HangingLamp', src: 'HI', file: 'Light_Cube.obj', fit: { scale: 0.625 } },
  { node: 'Rug', src: 'HI', file: 'Carpet_1.obj', fit: { scale: 0.625 } },
  { node: 'RugRound', src: 'HI', file: 'Carpet_Round.obj', fit: { scale: 0.625 } },
  { node: 'Bench', src: 'BA', file: 'Bench.glb', fit: { size: [1.6, 0.76, 0.5] }, colors: { Wood: 'Wood' } },
  { node: 'Wagon', src: 'MV', file: 'Prop_Wagon.gltf', fit: { scale: 1 }, sample: { grade: [1.08, 1.0] } },
  { node: 'Campfire', src: 'SV', file: 'Bonfire_Fire.obj', fit: { size: [1.4, 1.35, 1.3] }, colors: { Wood: 'Bark', LightWood: 'LogCut', Fire: 'Flame' } },
  { node: 'Torch', src: 'SV', file: 'WoodenTorch_Fire.obj', fit: { height: 1.7 }, colors: { LightGrey: 'Steel', Yellow: 'Rope', Fire: 'Flame' } },
  { node: 'Axe', src: 'SV', file: 'Axe.obj', fit: { height: 0.8 } },
  { node: 'Shovel', src: 'SV', file: 'Shovel.obj', fit: { height: 1.3 } },
  { node: 'Tent', src: 'SV', file: 'Tent.obj', fit: fam(2.8, 2.0, 4.8), colors: { Green: 'TentGreen', LightGreen: 'TentLight', DarkWood: 'WoodDark', Black: 'Rope' } },
  // ── Nature outside the play area ──
  { node: 'OakTree', src: 'SN', file: 'CommonTree_5.gltf', fit: { scale: 1 }, sample: { cut: true, grade: [1.08, 1.0] } },
  { node: 'RockLarge', src: 'SN', file: 'Rock_Medium_3.gltf', fit: { scale: 0.7 }, sample: { grade: [1.12, 0.85] } },
  { node: 'Fern', src: 'SN', file: 'Fern_1.gltf', fit: { scale: 0.6 }, sample: { cut: true } },
  { node: 'Agave', src: 'SN', file: 'Plant_1_Big.gltf', fit: { scale: 0.6 }, sample: { cut: true } },
  { node: 'Flowers', src: 'SN', file: 'Flower_3_Group.gltf', fit: { scale: 0.5 }, sample: { cut: true } },
  { node: 'Grass', src: 'SN', file: 'Grass_Common_Tall.gltf', fit: { scale: 0.5 }, sample: { cut: true } },
  // ── Architecture details (the shells are generated in code) ──
  { node: 'DoorFrame', src: 'MV', file: 'DoorFrame_Flat_WoodDark.gltf', fit: fam(2.6, 2.85, 0.42), sample: {} },
  { node: 'WindowWide', src: 'MV', file: 'Window_Wide_Flat1.gltf', fit: fam(1.5, 1.45, 0.5), sample: { dropGlass: true } },
  { node: 'WindowThin', src: 'MV', file: 'Window_Thin_Flat1.gltf', fit: fam(1.0, 1.45, 0.5), sample: { dropGlass: true } },
  { node: 'Shutters', src: 'MV', file: 'WindowShutters_Wide_Flat_Open.gltf', fit: fam(2.3, 1.3, 0.42), sample: { grade: [1.05, 1.0] } },
  { node: 'Railing', src: 'MV', file: 'Balcony_Cross_Straight.gltf', fit: fam(2.0, 1.0, 0.14), sample: {} },
  { node: 'Fence', src: 'MV', file: 'Prop_WoodenFence_Single.gltf', fit: { scale: 1.15 }, sample: {} },
  { node: 'FenceExt', src: 'MV', file: 'Prop_WoodenFence_Extension1.gltf', fit: { scale: 1.15 }, sample: {} },
  { node: 'Bracket', src: 'MV', file: 'Roof_Support2.gltf', fit: { scale: 1.3 }, sample: {} },
];

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function fail(message) {
  console.error(`\n✗ build-party-lab-prop-hunt-kit: ${message}\n`);
  process.exit(1);
}

// ─── Colour ────────────────────────────────────────────────────────────────

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const hexToLinear = (hex) => [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
const LINEAR = Object.fromEntries(Object.entries(PALETTE).map(([name, hex]) => [name, hexToLinear(hex)]));
function rgbToHsl([r, g, b]) {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min,
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToRgb([h, s, l]) {
  const k = (n) => (n + h / 30) % 12,
    a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map((n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
}
/** A sampled linear colour, graded in sRGB: optional hue, brightness × and saturation ×. */
function grade(linear, { hue, grade: [bright, sat] = [1, 1] } = {}) {
  let [h, s, l] = rgbToHsl(linear.map(linearToSrgb));
  if (hue !== undefined) h = hue;
  s = Math.min(1, s * sat);
  l = Math.min(0.97, l * bright);
  // Quantized to 32 levels per channel: neighbouring triangles of a texture region usually land
  // on the same colour and share vertices (the kit is about half the size), invisibly.
  return hslToRgb([h, s, l]).map((c) => srgbToLinear(Math.round(c * 31) / 31));
}

// ─── Readers ───────────────────────────────────────────────────────────────

function readGltf(file) {
  if (!fs.existsSync(file)) fail(`missing ${file}`);
  const bytes = fs.statSync(file).size;
  if (file.endsWith('.gltf')) {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const buffers = json.buffers.map((b) => (b.uri.startsWith('data:') ? Buffer.from(b.uri.slice(b.uri.indexOf(',') + 1), 'base64') : fs.readFileSync(path.join(path.dirname(file), b.uri))));
    return { json, buffers, bytes, dir: path.dirname(file) };
  }
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
  if (!json || !bin) fail(`${file}: missing JSON or BIN chunk`);
  return { json, buffers: [bin], bytes, dir: path.dirname(file) };
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
  const scale = accessor.normalized ? (Type === Uint8Array ? 1 / 255 : Type === Uint16Array ? 1 / 65535 : 1) : 1;
  for (let i = 0; i < accessor.count; i++)
    for (let k = 0; k < width; k++) {
      const at = buffer.byteOffset + base + i * stride + k * Type.BYTES_PER_ELEMENT;
      out[i * width + k] = new Type(buffer.buffer.slice(at, at + Type.BYTES_PER_ELEMENT))[0] * scale;
    }
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
function normalMatrix(m) {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e) || 1;
  // Inverse transpose of the 3×3 part.
  return [(e * i - f * h) / det, (g * f - d * i) / det, (d * h - g * e) / det, (h * c - b * i) / det, (a * i - g * c) / det, (g * b - a * h) / det, (b * f - e * c) / det, (d * c - a * f) / det, (a * e - d * b) / det];
}
const normalize = ([x, y, z]) => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};
const transformNormal = (n, [x, y, z]) => normalize([n[0] * x + n[1] * y + n[2] * z, n[3] * x + n[4] * y + n[5] * z, n[6] * x + n[7] * y + n[8] * z]);

/** Every triangle of a glTF/GLB with its material, centroid UV and mean vertex colour. */
function gltfTriangles(file) {
  const model = readGltf(file);
  const { json } = model;
  if (json.skins?.length) fail(`${file}: skinned models are not supported`);
  const triangles = [];
  const walk = (index, parent) => {
    const node = json.nodes[index];
    const matrix = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      const normals3 = normalMatrix(matrix);
      for (const primitive of json.meshes[node.mesh].primitives) {
        if ((primitive.mode ?? 4) !== 4) fail(`${file}: only triangle lists are supported`);
        const material = json.materials?.[primitive.material] ?? { name: 'Default' };
        const positions = readAccessor(model, primitive.attributes.POSITION);
        const normals = primitive.attributes.NORMAL !== undefined ? readAccessor(model, primitive.attributes.NORMAL) : null;
        const uvs = primitive.attributes.TEXCOORD_0 !== undefined ? readAccessor(model, primitive.attributes.TEXCOORD_0) : null;
        const colorAccessor = primitive.attributes.COLOR_0;
        const colors = colorAccessor !== undefined ? readAccessor(model, colorAccessor) : null;
        const cw = colorAccessor !== undefined ? WIDTH[json.accessors[colorAccessor].type] : 0;
        const count = positions.length / 3;
        const indices = primitive.indices !== undefined ? readAccessor(model, primitive.indices) : Array.from({ length: count }, (_, i) => i);
        for (let i = 0; i < indices.length; i += 3) {
          const corners = [indices[i], indices[i + 1], indices[i + 2]];
          const p = corners.map((k) => transformPoint(matrix, positions.slice(k * 3, k * 3 + 3)));
          const face = normalize(cross(sub(p[1], p[0]), sub(p[2], p[0])));
          const n = corners.map((k) => (normals ? transformNormal(normals3, normals.slice(k * 3, k * 3 + 3)) : face));
          const uv = uvs && [0, 1].map((c) => corners.reduce((sum, k) => sum + uvs[k * 2 + c], 0) / 3);
          const vcol = colors && [0, 1, 2].map((c) => corners.reduce((sum, k) => sum + colors[k * cw + c], 0) / 3);
          triangles.push({ material: material.name ?? 'Default', materialDef: material, uv, vcol, v: p.map((q, k) => ({ p: q, n: n[k] })) });
        }
      }
    }
    for (const child of node.children ?? []) walk(child, matrix);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const index of json.scenes[json.scene ?? 0].nodes) walk(index, identity);
  return { triangles, bytes: model.bytes, json, dir: model.dir };
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Every triangle of an OBJ (fans for polygons) with its `usemtl` material; normals from `vn`, else the face's. */
function objTriangles(file) {
  if (!fs.existsSync(file)) fail(`missing ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  const v = [],
    vn = [],
    triangles = [];
  let material = 'Default';
  const index = (token, list) => {
    const i = parseInt(token, 10);
    return i < 0 ? list.length + i : i - 1;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('v ')) v.push(line.slice(2).trim().split(/\s+/).map(Number));
    else if (line.startsWith('vn ')) vn.push(normalize(line.slice(3).trim().split(/\s+/).map(Number)));
    else if (line.startsWith('usemtl ')) material = line.slice(7).trim();
    else if (line.startsWith('f ')) {
      const corners = line
        .slice(2)
        .trim()
        .split(/\s+/)
        .map((token) => {
          const [a, , c] = token.split('/');
          return { p: v[index(a, v)], n: c ? vn[index(c, vn)] : null };
        });
      for (let k = 1; k + 1 < corners.length; k++) {
        const tri = [corners[0], corners[k], corners[k + 1]];
        const face = normalize(cross(sub(tri[1].p, tri[0].p), sub(tri[2].p, tri[0].p)));
        triangles.push({ material, uv: null, vcol: null, v: tri.map((c) => ({ p: [...c.p], n: c.n ? [...c.n] : face })) });
      }
    }
  }
  return { triangles, bytes: fs.statSync(file).size };
}

// ─── Textures ──────────────────────────────────────────────────────────────

const textures = new Map();
async function loadTexture(file) {
  if (textures.has(file)) return textures.get(file);
  if (!fs.existsSync(file)) fail(`missing texture ${file}`);
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const texture = { data, width: info.width, height: info.height, channels: info.channels };
  textures.set(file, texture);
  return texture;
}
/** Linear RGB and alpha (0…1) of a texture at a UV (nearest texel, repeat wrap, glTF origin top-left). */
function sampleTexture(texture, [u, v]) {
  const fu = u - Math.floor(u),
    fv = v - Math.floor(v);
  const x = Math.min(texture.width - 1, Math.floor(fu * texture.width));
  const y = Math.min(texture.height - 1, Math.floor(fv * texture.height));
  const o = (y * texture.width + x) * texture.channels;
  return { rgb: [0, 1, 2].map((c) => srgbToLinear(texture.data[o + c] / 255)), alpha: texture.data[o + 3] / 255 };
}

// ─── Models ────────────────────────────────────────────────────────────────

function bounds(triangles) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const t of triangles)
    for (const { p } of t.v)
      for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c], p[c]);
        max[c] = Math.max(max[c], p[c]);
      }
  return { min, max };
}
/** Quarter turns about +Y (x, z) → (z, −x) per turn: the model's +z front turns toward +x. */
const turnPoint = ([x, y, z], turns) => {
  let a = [x, y, z];
  for (let k = 0; k < ((turns % 4) + 4) % 4; k++) a = [a[2], a[1], -a[0]];
  return a;
};

async function buildModel(spec) {
  const file = path.join(ROOTS[spec.src], spec.file);
  const glb = file.endsWith('.gltf') || file.endsWith('.glb');
  const loaded = glb ? gltfTriangles(file) : objTriangles(file);
  const triangles = [];
  const used = new Set();
  let dropped = 0;
  for (const t of loaded.triangles) {
    if (spec.sample) {
      const def = t.materialDef ?? {};
      const pbr = def.pbrMetallicRoughness ?? {};
      // Window frames lose their glass: the arena's transparent panes stand in the openings.
      if (spec.sample.dropGlass && /glass/i.test(t.material)) {
        dropped++;
        continue;
      } else {
        let rgb = (pbr.baseColorFactor ?? [1, 1, 1, 1]).slice(0, 3);
        const texIndex = pbr.baseColorTexture?.index;
        if (texIndex !== undefined && t.uv) {
          const image = loaded.json.images[loaded.json.textures[texIndex].source];
          const texture = await loadTexture(path.join(loaded.dir, decodeURIComponent(image.uri)));
          const s = sampleTexture(texture, t.uv);
          if (spec.sample.cut && (def.alphaMode === 'MASK' || def.alphaMode === 'BLEND') && s.alpha < 0.5) {
            dropped++;
            continue;
          }
          rgb = rgb.map((c, k) => c * s.rgb[k]);
        }
        // Nature's bark carries baked AO in its vertex colours (leaves are white).
        if (t.vcol) rgb = rgb.map((c, k) => c * (0.35 + 0.65 * t.vcol[k]));
        t.color = grade(rgb, spec.sample);
        used.add(`sampled:${t.material}`);
      }
    } else {
      const name = spec.colors?.[t.material] ?? MATERIALS[t.material];
      if (!name || !LINEAR[name]) fail(`${spec.node} (${spec.file}): unmapped material ${t.material}`);
      t.color = LINEAR[name];
      used.add(name);
    }
    triangles.push(t);
  }
  if (!triangles.length) fail(`${spec.node} is empty`);
  // Orientation: stand the log on end (its long axis is x) for the stump, then quarter turns.
  for (const t of triangles)
    for (const vertex of t.v) {
      if (spec.upright) {
        vertex.p = [vertex.p[1], -vertex.p[0], vertex.p[2]];
        vertex.n = [vertex.n[1], -vertex.n[0], vertex.n[2]];
      }
      if (spec.turn) {
        vertex.p = turnPoint(vertex.p, spec.turn);
        vertex.n = turnPoint(vertex.n, spec.turn);
      }
    }
  // Bottom-centre pivot, then the fit.
  const { min, max } = bounds(triangles);
  const size = max.map((v, c) => v - min[c]);
  let scale;
  if (spec.fit.size) scale = spec.fit.size.map((s, c) => s / size[c]);
  else if (spec.fit.height) scale = [1, 1, 1].map(() => spec.fit.height / size[1]);
  else scale = [spec.fit.scale, spec.fit.scale, spec.fit.scale];
  const offset = [-(min[0] + max[0]) / 2, -min[1], -(min[2] + max[2]) / 2];
  for (const t of triangles)
    for (const vertex of t.v) {
      vertex.p = vertex.p.map((x, c) => (x + offset[c]) * scale[c]);
      // Non-uniform scale: normals scale by the inverse.
      vertex.n = normalize(vertex.n.map((x, c) => x / scale[c]));
    }
  return { node: spec.node, file: `${spec.src}/${spec.file}`, sourceBytes: loaded.bytes, triangles, palette: [...used], dropped, sourceTriangles: loaded.triangles.length };
}

/** One indexed primitive per node; vertices shared when position, normal and colour match. */
function primitiveOf(triangles) {
  const positions = [],
    normals = [],
    colors = [],
    indices = [],
    lookup = new Map();
  for (const t of triangles) {
    const rgba = [...t.color.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255)), 255];
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

const CREDITS = `prop-hunt-kit.glb — Party Lab "Saklambaç" (Prop Hunt) kit for the "Orman Kampı" map

Sources (all by Quaternius, CC0 1.0 Universal, Public Domain Dedication,
https://creativecommons.org/publicdomain/zero/1.0/, per each pack's License file;
the Barn's Medieval Village Pack via poly.pizza, CC0 as stated on its page):
  Medieval Village MegaKit (Standard)      https://quaternius.com
  Stylized Nature MegaKit (Standard)       https://quaternius.com
  Ultimate House Interior Pack (Jun 2020)  https://quaternius.com
  Survival Pack (Sept 2020)                https://quaternius.com
  Medieval Village Pack                    https://poly.pizza/l/NsHhjhlrfY
Attribution is not required; credit is given here voluntarily.

Only this curated subset is included:
${Object.entries(
  MODELS.reduce((acc, m) => {
    (acc[m.src] ??= new Set()).add(m.file.replace(/\.(gltf|glb|obj)$/, ''));
    return acc;
  }, {})
)
  .map(([src, files]) => `  ${{ MV: 'Medieval Village MegaKit', SN: 'Stylized Nature MegaKit', HI: 'House Interior', SV: 'Survival', BA: 'Medieval Village Pack' }[src]}: ${[...files].join(', ')}`)
  .join('\n')}

Changes: merged into one GLB; each model baked to one primitive with positions,
normals and vertex colours (UVs, tangents, textures and materials dropped; flat
materials mapped to one palette; Medieval and Nature textures sampled once per
triangle, transparent leaf-card triangles dropped, Bush_Common re-tinted green);
all materials opaque with metalness 0; re-pivoted to bottom-centre; transformable
props fitted to their gameplay sizes (HouseInterior furniture at 1.25× real size).
Visual only: no gameplay collider comes from this file. Rebuild with:
  node scripts/build-party-lab-prop-hunt-kit.mjs [path/to/PartyLabPropHuntAssets] [path/to/PartyLabBarnAssets]
`;

async function main() {
  for (const [name, root] of Object.entries(ROOTS)) if (!fs.existsSync(root)) fail(`source ${name} not found: ${root}`);
  const nodes = [];
  for (const spec of MODELS) nodes.push(await buildModel(spec));

  const writer = new GlbWriter();
  const json = writer.json;
  Object.assign(json, {
    asset: { version: '2.0', generator: 'Party Lab build-party-lab-prop-hunt-kit.mjs', copyright: 'CC0 1.0: Quaternius' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    // White, rough, metalness 0: the vertex colours carry the palette.
    materials: [{ name: 'Camp', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }],
  });
  const summary = [];
  for (const { node, file, triangles, palette, dropped, sourceTriangles } of nodes) {
    const p = primitiveOf(triangles);
    const mesh =
      json.meshes.push({
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
    summary.push({ node, file, triangles: triangles.length, source: sourceTriangles, dropped, vertices: p.positions.length / 3, palette, size: b.max.map((v, c) => (v - b.min[c]).toFixed(2)).join(' × ') });
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
  fs.writeFileSync(path.join(outDir, 'prop-hunt-kit.glb'), glb);
  fs.writeFileSync(path.join(outDir, 'CREDITS.txt'), CREDITS);

  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`prop-hunt-kit.glb: ${kb(glb.length)}, ${summary.length} nodes, ${summary.reduce((n, s) => n + s.triangles, 0)} triangles, ${summary.reduce((n, s) => n + s.vertices, 0)} vertices`);
  for (const s of summary)
    console.log(
      `  ${s.node.padEnd(15)} ${String(s.triangles).padStart(5)} tris${s.dropped ? ` (−${s.dropped} cut)` : ''.padEnd(0)} ${String(s.vertices).padStart(5)} verts  ${s.size.padEnd(20)} ${s.file}`
    );
}

main();
