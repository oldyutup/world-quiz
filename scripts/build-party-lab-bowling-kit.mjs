#!/usr/bin/env node
// Curated, licensed visual-only kit. Raw sources are only read, never copied.
import fs from 'node:fs';
import sharp from 'sharp';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { Vector3, Matrix3, TextureLoader, Texture } from 'three';
const source = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'Downloads/PartyLabHumanBowlingAssets'));
const legacySource = path.join(os.homedir(), 'Downloads/PartyLabBowlingAssets');
for (const pack of ['Car','ToyCar','Racing','Skyboxes','Particles']) {
 const license=fs.readFileSync(path.join(source,pack,'License.txt'),'utf8');
 if(!license.includes('CC0')) throw Error('Unverified license: '+pack);
}
if(!fs.readFileSync(path.join(legacySource,'Prototype/License.txt'),'utf8').includes('CC0')) throw Error('Prototype license');
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/party-lab/maps/bowling');
const PIN_HASH = '1ccaedda09b94125df071d44c00f85ac6295dbcffe11daa396aed036daadf663';
const specs = [
 ['Car','Car/Models/GLB format/race.glb',1],
 ['ServiceCar','ToyCar/Models/GLB format/vehicle-racer.glb',2.4],
 ['Tree','Racing/Models/GLTF format/treeLarge.glb',5],
 ['Tent','Racing/Models/GLTF format/tent.glb',4],
 ['BarrierRed','Racing/Models/GLTF format/barrierRed.glb',6],
 ['BarrierWhite','Racing/Models/GLTF format/barrierWhite.glb',6],
 ['Stand','Racing/Models/GLTF format/grandStand.glb',4],
 ['Flag','Racing/Models/GLTF format/flagCheckers.glb',2.4],
 ['Gantry','Racing/Models/GLTF format/overhead.glb',6],
 ['Sign','Racing/Models/GLTF format/billboardLower.glb',4],
 ['Cone','Racing/Models/GLTF format/pylon.glb',5],
 ['Arrow','Prototype/Models/GLB format/indicator-special-arrow.glb',1],
 ['Pad','Prototype/Models/GLB format/shape-cube-rounded.glb',1],
];
const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function fail(message) {
  console.error(`\n✗ build-party-lab-bowling-kit: ${message}\n`);
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


function normalizeModel(triangles, scale) {
 const {min,max}=bounds(triangles), offset=[-(min[0]+max[0])/2,-min[1],-(min[2]+max[2])/2];
 for(const t of triangles) for(const v of t.v) v.p=v.p.map((x,c)=>(x+offset[c])*scale);
 return triangles;
}
function scenery([node,file,scale]) {
 const root=file.startsWith('Prototype/')?legacySource:source;
 let {triangles}=loadTriangles(file,root);
 if(node==='Flag') {
  // Bake a readable checker cloth instead of sampling a repeated texture once
  // per long source triangle (which creates high-frequency diagonal stripes).
  const cloth=triangles.filter(t=>/check/i.test(t.material)), b=bounds(cloth);
  triangles=triangles.filter(t=>!/check/i.test(t.material));
  const z=(b.min[2]+b.max[2])/2;
  for(let row=0;row<8;row++)for(let col=0;col<3;col++)for(const side of [-1,1]) {
   const x0=b.min[0]+(b.max[0]-b.min[0])*col/3,x1=b.min[0]+(b.max[0]-b.min[0])*(col+1)/3;
   const y0=b.min[1]+(b.max[1]-b.min[1])*row/8,y1=b.min[1]+(b.max[1]-b.min[1])*(row+1)/8;
   const corners=[[x0,y0,z],[x1,y0,z],[x1,y1,z],[x0,y1,z]];
   for(const indices of (side===1?[[0,1,2],[0,2,3]]:[[2,1,0],[3,2,0]]))triangles.push({material:'bakedCheckers',color:hexToLinear((row+col)%2?'#344c55':'#f0e5c8'),v:indices.map(i=>({p:corners[i].slice(),n:[0,0,side]}))});
  }
 }
 const {json}=readModel(path.join(root,file));
 const colors=Object.fromEntries(json.materials.map(m=>[m.name,m.pbrMetallicRoughness?.baseColorFactor?.slice(0,3)??[.8,.8,.8]]));
 for(const t of triangles) {
  t.color=t.color??colors[t.material];
  if((node==='Car'||node==='ServiceCar') && t.uv) {
    const palette=node==='Car'?carTexture:serviceTexture;
    const x=Math.max(0,Math.min(palette.info.width-1,Math.floor(t.uv[0]*palette.info.width)));
    const y=Math.max(0,Math.min(palette.info.height-1,Math.floor(t.uv[1]*palette.info.height)));
    const i=(y*palette.info.width+x)*palette.info.channels;
    t.color=Array.from(palette.data.subarray(i,i+3),v=>srgbToLinear(v/255));
  }
  if(node==='Pad')t.color=hexToLinear('#669e9a');
  if(node==='Arrow')t.color=hexToLinear('#e8ad46');
  if(node==='Flag' && t.uv && /check/i.test(t.material))t.color=hexToLinear((Math.floor(t.uv[0]*8)+Math.floor(t.uv[1]*8))%2?'#344c55':'#f0e5c8');
 }
 if(node==='Car'){const b=bounds(triangles);scale=4.3/(b.max[2]-b.min[2]);}
 return {node,triangles:normalizeModel(triangles,scale)};
}
// Split only at stripe boundaries, preserving the source silhouette and smooth
// normals while making clean painted bands rather than triangle-shaped patches.
function splitAtHeight(triangle, height) {
 const clip = above => {
  const out=[];
  for(let i=0;i<3;i++) {
   const a=triangle.v[i], b=triangle.v[(i+1)%3];
   const inside=v=>above ? v.p[1]>=height : v.p[1]<=height;
   if(inside(a))out.push(a);
   if(inside(a)!==inside(b)) {
    const t=(height-a.p[1])/(b.p[1]-a.p[1]);
    out.push({p:a.p.map((x,c)=>x+(b.p[c]-x)*t),n:normalize(a.n.map((x,c)=>x+(b.n[c]-x)*t))});
   }
  }
  return out.slice(2).map((v,i)=>({v:[out[0],out[i+1],v]}));
 };
 if(triangle.v.every(v=>v.p[1]>=height)||triangle.v.every(v=>v.p[1]<=height))return [triangle];
 return [...clip(false),...clip(true)];
}
function pin() {
 const file=path.join(legacySource,'Bowling/SM_Bowling_Pin.fbx'), bytes=fs.readFileSync(file);
 if(createHash('sha256').update(bytes).digest('hex')!==PIN_HASH)throw Error('Pin differs from verified CC0 source. Reverify provenance before importing.');
 // The supplied FBX references a missing texture. Replace it deliberately, with no texture IO.
 const original=TextureLoader.prototype.load;let scene;
 try {TextureLoader.prototype.load=()=>new Texture();scene=new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');}
 finally {TextureLoader.prototype.load=original;}
 scene.updateMatrixWorld(true);const triangles=[];
 scene.traverse(m=>{if(!m.isMesh)return;const a=m.geometry.attributes.position,n=m.geometry.attributes.normal,normalMatrix=new Matrix3().getNormalMatrix(m.matrixWorld),count=m.geometry.index?.count??a.count;
 for(let i=0;i<count;i+=3){const v=[];for(let j=0;j<3;j++){const k=m.geometry.index?.getX(i+j)??i+j;v.push({p:new Vector3().fromBufferAttribute(a,k).applyMatrix4(m.matrixWorld).toArray(),n:new Vector3().fromBufferAttribute(n,k).applyNormalMatrix(normalMatrix).toArray()});}triangles.push({v});}});
 const b=bounds(triangles);normalizeModel(triangles,1.5/(b.max[1]-b.min[1]));
 let striped=triangles;
 for(const y of [.96,1.01,1.07,1.12])striped=striped.flatMap(t=>splitAtHeight(t,y));
 for(const t of striped){const y=t.v.reduce((s,v)=>s+v.p[1],0)/3;t.color=hexToLinear((y>.96&&y<1.01)||(y>1.07&&y<1.12)?'#d3584b':'#f5ecda');}
 return {node:'Pin',triangles:striped};
}
const carModel=readModel(path.join(source,specs[0][1]));
const carImage=carModel.json.images[0], view=carModel.json.bufferViews[carImage.bufferView];
const carTexture=await sharp(view ? carModel.buffers[view.buffer??0].subarray(view.byteOffset??0,(view.byteOffset??0)+view.byteLength) : path.join(source,path.dirname(specs[0][1]),carImage.uri)).raw().toBuffer({resolveWithObject:true});
const serviceModel=readModel(path.join(source,specs.find(s=>s[0]==='ServiceCar')[1]));
const serviceImage=serviceModel.json.images[0], serviceView=serviceModel.json.bufferViews[serviceImage.bufferView];
const serviceTexture=await sharp(serviceView ? serviceModel.buffers[serviceView.buffer??0].subarray(serviceView.byteOffset??0,(serviceView.byteOffset??0)+serviceView.byteLength) : path.join(source,'ToyCar/Models/GLB format',serviceImage.uri)).raw().toBuffer({resolveWithObject:true});
const models=[pin(),...specs.map(scenery)], writer=new GlbWriter(),json=writer.json;
Object.assign(json,{asset:{version:'2.0',generator:'Party Lab bowling kit',copyright:'CC0: SkywolfGameStudios, Kenney'},scene:0,scenes:[{nodes:[]}],nodes:[],meshes:[],materials:[{name:'BowlingPalette',pbrMetallicRoughness:{baseColorFactor:[1,1,1,1],metallicFactor:0,roughnessFactor:.75}}]});
for(const {node,triangles} of models){const p=primitiveOf(triangles),mesh=json.meshes.length;json.meshes.push({name:node,primitives:[{attributes:{POSITION:writer.accessor(p.positions,'VEC3',5126,34962,{withBounds:true}),NORMAL:writer.accessor(p.normals,'VEC3',5126,34962),COLOR_0:writer.accessor(p.colors,'VEC4',5121,34962,{normalized:true})},indices:writer.accessor(p.indices,'SCALAR',5123,34963),material:0}]});json.scenes[0].nodes.push(json.nodes.length);json.nodes.push({name:node,mesh});console.log(node,triangles.length,'triangles');}
const pad=(b,fill=0)=>Buffer.concat([b,Buffer.alloc((4-b.length%4)%4,fill)]),bin=pad(Buffer.concat(writer.chunks));json.buffers=[{byteLength:bin.length}];const j=pad(Buffer.from(JSON.stringify(json)),32),head=Buffer.alloc(12);head.writeUInt32LE(0x46546c67);head.writeUInt32LE(2,4);head.writeUInt32LE(28+j.length+bin.length,8);const chunk=(b,t)=>{const h=Buffer.alloc(8);h.writeUInt32LE(b.length);h.writeUInt32LE(t,4);return Buffer.concat([h,b]);};const glb=Buffer.concat([head,chunk(j,0x4e4f534a),chunk(bin,0x004e4942)]);
fs.mkdirSync(outDir,{recursive:true});fs.writeFileSync(path.join(outDir,'bowling-kit.glb'),glb);
fs.writeFileSync(path.join(outDir,'CREDITS.txt'),`Human Bowling / İnsan Bowlingi visual kit. License audit: 2026-09-26.

Selected pin: SkywolfGameStudios, CC0Tree. CC0 1.0 Universal.
https://skywolfgamestudios.itch.io/cc0tree
https://github.com/SkywolfGameStudios/CC0Tree
https://creativecommons.org/publicdomain/zero/1.0/
Exact source: ~/Downloads/PartyLabBowlingAssets/Bowling/SM_Bowling_Pin.fbx
SHA256: ${PIN_HASH}
Provenance: macOS WhereFroms metadata identifies the author's CC0Tree itch.io download (game 4568881, file 17538031). Identical SHA256 to ~/Downloads/SM_Bowling_Pin.fbx. Author page explicitly licenses assets CC0 and lists Bowling Pin (26 kB). Author's linked repository independently states CC0 including redistribution.
Modification: bake rotation/scale, bottom-center pivot, uniform height 1.5 m; discard missing PG_84211bc6.png reference; original vertex-color cream/red bands, one material/primitive; source 288 triangles, split only at four painted stripe boundaries. No bowling ball included.

Alternate audited, NOT included: Deplorable Mountaineer, Bowling Ball and Pins.
https://deplorablemountaineer.itch.io/bowling-ball-and-pins
Exact source: ~/Downloads/PartyLabBowlingAssets/Bowling/Bowling/FBX v7400/Pin Low Poly.fbx
SHA256: 3be7144bc7ddf0b98a58fc699c818ca56e86468b2f35aebcea281742e940cb44
README lacks a license but the author's page explicitly declares Asset license: Creative Commons Zero v1.0 Universal. Downloads/Bowling.zip WhereFroms identifies that page; its Pin Low Poly.fbx member is byte-identical. Preferred CC0Tree pin chosen per user preference.

Selected vehicle: Kenney Car Kit 3.1 race.glb (open cockpit, full-sized stunt silhouette). Compared with Toy Car Kit 1.2 vehicle-speedster, not included. Car is 4.3 m long with baked palette texture colors.
Service vehicles: Kenney Toy Car Kit vehicle-racer, original palette baked to vertex colours.
Sky: Kenney Skyboxes 1.0 skybox-day.png (light blue daytime / soft white clouds and sun), CC0, resized to 1024x512 WebP.
Source: ~/Downloads/PartyLabHumanBowlingAssets/Skyboxes/Skyboxes/skybox-day.png
License/source: supplied Skyboxes/License.txt, created/distributed by Kenney (www.kenney.nl).
Source SHA256: b7d98fe95157e74b3899a1dd468a1e478005bcd1f668b29b5b42a48cb5358fa2
Effect: Kenney Particle Pack 1.1 PNG (Transparent)/smoke_04.png resized to 128px.
All five new pack License.txt files inspected, explicitly CC0.

Scenery: Kenney Racing Kit 2.0 and Prototype Kit 1.0, CC0 1.0, per supplied License.txt files. https://kenney.nl
Exact sources relative to ~/Downloads/PartyLabHumanBowlingAssets/ (Prototype and original approved pin from ~/Downloads/PartyLabBowlingAssets/):
${specs.map(s=>s[1]).join('\n')}
Changes: baked authoring transforms, normalized bottom-center pivots/scales; one vertex-color primitive per model, texture references removed/replaced with colors; flag cloth rebuilt as a readable 3×8 vertex-color checker grid while retaining the source pole. All collision geometry is generated separately in code. No raw packs included.

Rebuild: node scripts/build-party-lab-bowling-kit.mjs [path/to/PartyLabHumanBowlingAssets]
`);
console.log('bowling-kit.glb',glb.length,'bytes');

await sharp(path.join(source,'Skyboxes/Skyboxes/skybox-day.png')).resize(1024,512).webp({quality:80}).toFile(path.join(outDir,'sky-day.webp'));
await sharp(path.join(source,'Particles/PNG (Transparent)/smoke_04.png')).resize(128,128).webp({quality:80}).toFile(path.join(outDir,'dust.webp'));
