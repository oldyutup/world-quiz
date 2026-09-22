import {
  BufferGeometry, CapsuleGeometry, CatmullRomCurve3, Color, ExtrudeGeometry,
  Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  OctahedronGeometry, Shape, SphereGeometry, TorusGeometry, TubeGeometry, Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PARTS, SHAPES, type PartName } from '../ragdoll/config';
import { resolveCostume, type CostumeId } from './costumes';

const C = { cream: '#f2dec0', face: '#ffe8d3', orange: '#df913f', brown: '#655454', pink: '#dd918c', ink: '#302a2c', gold: '#e8b648' };
type XYZ = [number, number, number];
function paint(geometry: BufferGeometry, color: string) {
  const rgb = new Color(color), count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) rgb.toArray(colors, i * 3);
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return geometry;
}
function oval(color: string, scale: XYZ, position: XYZ) {
  return paint(new SphereGeometry(1, 12, 8).scale(...scale).translate(...position), color);
}
function merge(pieces: BufferGeometry[]) {
  const flat = pieces.map(piece => {
    const geometry = piece.index ? piece.toNonIndexed() : piece;
    geometry.deleteAttribute('uv');
    if (geometry !== piece) piece.dispose();
    return geometry;
  });
  const result = mergeGeometries(flat)!;
  flat.forEach(piece => piece.dispose());
  result.computeBoundingSphere();
  return result;
}
function ear(side: number, inner: boolean) {
  const shape = new Shape();
  shape.moveTo(-0.115, 0);
  shape.quadraticCurveTo(-0.12, 0.12, -0.065, 0.24);
  shape.quadraticCurveTo(-0.045, 0.29, 0.005, 0.24);
  shape.lineTo(0.13, 0.015);
  shape.closePath();
  const geometry = new ExtrudeGeometry(shape, {
    depth: inner ? 0.012 : 0.09, bevelEnabled: true,
    bevelThickness: 0.018, bevelSize: 0.018, bevelSegments: 2, steps: 1, curveSegments: 4,
  });
  if (inner) geometry.scale(0.58, 0.65, 1);
  geometry.rotateY(side === 1 ? Math.PI : 0);
  geometry.translate(side * 0.23, inner ? 0.245 : 0.215, inner ? 0.10 : 0);
  return paint(geometry, inner ? C.pink : side < 0 ? C.orange : C.brown);
}
function catPart(name: PartName, slotColor: string) {
  const shape = SHAPES[name];
  const radius = name === 'head' ? 0.335 : shape.radius * 1.05;
  const body = name === 'torso'
    ? new SphereGeometry(1, 16, 10).scale(0.365, 0.44, 0.34)
    : name === 'pelvis'
    ? new SphereGeometry(1, 16, 10).scale(0.32, 0.33, 0.30)
    : shape.half
    ? new CapsuleGeometry(radius, shape.half * 2, 4, 12)
    : new SphereGeometry(radius, 20, 14).scale(1.08, 1, 0.96);
  paint(body, C.cream);
  // Broad calico patches are vertex colors, no textures or extra draw calls.
  const positions = body.getAttribute('position'), colors = body.getAttribute('color');
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
    let patch: string = C.cream;
    if (name === 'head') {
      if (x < -0.07 && y > 0.01) patch = C.orange;
      if (x > 0.13 && y > -0.04) patch = C.brown;
    } else if (name === 'leftLeg') patch = y < -0.05 ? C.brown : C.cream;
    else if (name === 'rightLeg' || name === 'leftUpper') patch = C.orange;
    else if (name === 'rightUpper') patch = C.brown;
    else if (name === 'torso' || name === 'pelvis') {
      if (x < -0.12 && y > -0.17 && z < 0.16) patch = C.brown;
      if (x > 0.13 && y < 0.12) patch = C.orange;
    }
    const color = new Color(patch);
    colors.setXYZ(i, color.r, color.g, color.b);
  }
  const pieces: BufferGeometry[] = [body];
  if (name === 'head') {
    pieces.push(oval(C.face, [0.267, 0.224, 0.09], [0, -0.044, 0.27]));
    for (const side of [-1, 1]) {
      pieces.push(ear(side, false), ear(side, true));
      pieces.push(oval(C.ink, [0.032, 0.057, 0.021], [side * 0.094, -0.022, 0.354]));
    }
    pieces.push(oval(C.pink, [0.035, 0.023, 0.021], [0, 0.228, 0.255]));
  }
  if (name === 'torso') {
    // Keep the slot's roster color on the collar.
    pieces.push(paint(new TorusGeometry(0.31, 0.038, 6, 16).rotateX(Math.PI / 2).translate(0, 0.27, 0), slotColor));
    pieces.push(oval(C.gold, [0.065, 0.073, 0.05], [0, 0.215, 0.35]));
    pieces.push(oval(C.ink, [0.012, 0.026, 0.008], [0, 0.202, 0.399]));
  }
  if (name.endsWith('Hand')) {
    pieces.push(oval(C.pink, [0.06, 0.058, 0.022], [0, -0.10, 0.137]));
    for (const x of [-0.06, 0, 0.06])
      pieces.push(oval(C.pink, [0.023, 0.026, 0.015], [x, -0.018, 0.135]));
  }
  if (name === 'pelvis') {
    const curve = new CatmullRomCurve3([
      new Vector3(0, -0.08, -0.25), new Vector3(0.05, -0.10, -0.43),
      new Vector3(0.20, 0.01, -0.55), new Vector3(0.25, 0.20, -0.55),
    ]);
    const tail = paint(new TubeGeometry(curve, 12, 0.072, 6, false), C.orange);
    const colors = tail.getAttribute('color'), uv = tail.getAttribute('uv');
    const brown = new Color(C.brown);
    for (let i = 0; i < colors.count; i++)
      if (uv.getX(i) > 0.3 && uv.getX(i) < 0.6) colors.setXYZ(i, brown.r, brown.g, brown.b);
    pieces.push(tail, oval(C.orange, [0.072, 0.072, 0.072], [0.25, 0.20, -0.55]));
  }
  return merge(pieces);
}
const FISH = { blue: '#71849d', fin: '#526780', silver: '#c8d3d8', belly: '#f0e8d8' };

/** Small rounded fin plates; merged into body-local skins, never independent rigs. */
function fishFin(points: [number, number][], color: string) {
  const shape = new Shape();
  shape.moveTo(...points[0]);
  for (const point of points.slice(1)) shape.lineTo(...point);
  shape.closePath();
  return paint(new ExtrudeGeometry(shape, {
    depth: 0.025, bevelEnabled: true, bevelSize: 0.015,
    bevelThickness: 0.012, bevelSegments: 2, steps: 1,
  }).translate(0, 0, -0.0125), color);
}

function anchovyPart(name: PartName, slotColor: string) {
  const shape = SHAPES[name];
  // Same rounded humanoid proportions as the existing costume, no fish-body rig.
  const body = name === 'torso'
    ? new SphereGeometry(1, 16, 10).scale(0.365, 0.44, 0.34)
    : name === 'pelvis'
    ? new SphereGeometry(1, 16, 10).scale(0.32, 0.33, 0.30)
    : name === 'head'
    ? new SphereGeometry(0.335, 20, 14).scale(1.08, 1, 0.96)
    : new CapsuleGeometry(shape.radius * 1.05, shape.half * 2, 4, 12);
  paint(body, FISH.blue);
  const vertices = body.getAttribute('position'), colors = body.getAttribute('color');
  for (let i = 0; i < vertices.count; i++) {
    const x = Math.abs(vertices.getX(i)), y = vertices.getY(i), z = vertices.getZ(i);
    let color: string = FISH.blue;
    if ((name === 'torso' || name === 'pelvis') && z > 0.08)
      color = x < 0.21 ? FISH.belly : FISH.silver;
    if (name.endsWith('Hand') && y > 0.08) color = FISH.silver;
    const rgb = new Color(color);
    colors.setXYZ(i, rgb.r, rgb.g, rgb.b);
  }
  const pieces: BufferGeometry[] = [body];
  if (name === 'head') {
    // Hood opening and Party Lab eyes remain distinct from the big costume eyes.
    pieces.push(oval(FISH.silver, [0.283, 0.243, 0.087], [0, -0.05, 0.252]));
    pieces.push(oval(C.face, [0.253, 0.21, 0.074], [0, -0.05, 0.283]));
    for (const side of [-1, 1]) {
      pieces.push(oval(C.ink, [0.032, 0.057, 0.021], [side * 0.094, -0.027, 0.352]));
      const eye = (color: string, scale: XYZ, position: XYZ) =>
        oval(color, scale, position).rotateY(side * 0.7).translate(side * 0.24, 0.17, 0.19);
      pieces.push(eye(FISH.belly, [0.105, 0.117, 0.047], [0, 0, 0]));
      pieces.push(eye(C.ink, [0.058, 0.071, 0.022], [0, 0.012, 0.044]));
      pieces.push(eye(FISH.belly, [0.018, 0.02, 0.008], [-0.015, 0.041, 0.063]));
      const fin = fishFin([[0, 0.055], [0.18, -0.035], [0.22, -0.16], [0.13, -0.19], [0, -0.09]], FISH.fin);
      fin.rotateY(side < 0 ? Math.PI : 0).translate(side * 0.30, -0.045, 0.015);
      pieces.push(fin);
      // One pale ray per side fin is sufficient at arena scale.
      pieces.push(oval(FISH.silver, [0.016, 0.08, 0.009], [0, 0, 0])
        .rotateZ(side * 0.65).translate(side * 0.405, -0.14, 0.045));
    }
    const dorsal = fishFin([[-0.19, 0], [-0.12, 0.29], [-0.055, 0.26], [0.17, 0]], FISH.fin);
    dorsal.rotateY(Math.PI / 2 - 0.3).translate(0, 0.28, -0.04);
    pieces.push(dorsal);
    const mouth = new CatmullRomCurve3([
      new Vector3(-0.10, 0.23, 0.267), new Vector3(-0.055, 0.215, 0.279),
      new Vector3(0, 0.245, 0.27), new Vector3(0.055, 0.215, 0.279), new Vector3(0.10, 0.23, 0.267),
    ]);
    pieces.push(paint(new TubeGeometry(mouth, 8, 0.012, 5, false), FISH.fin));
  }
  if (name === 'torso')
    pieces.push(paint(new TorusGeometry(0.30, 0.025, 6, 16).rotateX(Math.PI / 2).translate(0, 0.27, 0), slotColor));
  if (name === 'pelvis') {
    pieces.push(oval(FISH.blue, [0.085, 0.09, 0.15], [0, -0.035, -0.33]));
    // Forked tail across the back, small enough to keep hand/leg silhouettes clear.
    const tail = fishFin([[0, -0.04], [0.25, -0.23], [0.29, -0.19], [0.20, 0], [0.29, 0.19], [0.25, 0.23], [0, 0.04]], FISH.fin);
    tail.translate(0, -0.035, -0.46);
    pieces.push(tail);
    for (const direction of [-1, 1])
      pieces.push(oval(FISH.silver, [0.085, 0.012, 0.008], [0, 0, 0])
        .rotateZ(direction * 0.65).translate(0.15, -0.035 + direction * 0.11, -0.492));
  }
  return merge(pieces);
}

const DEER = { tan: '#bc824b', caramel: '#996437', cream: '#f4e5cc', inner: '#d99c92', hoof: '#5b423a', horn: '#6c4c36' };

function gazelleAntler(side: number, branch = false) {
  const points = branch
    ? [[side * 0.19, 0.39, 0.015], [side * 0.26, 0.47, 0.045], [side * 0.27, 0.52, 0.045]]
    : [[side * 0.16, 0.25, -0.025], [side * 0.175, 0.39, -0.025], [side * 0.21, 0.55, -0.025]];
  const curve = new CatmullRomCurve3(points.map(([x, y, z]) => new Vector3(x, y, z)));
  return paint(new TubeGeometry(curve, 6, branch ? 0.018 : 0.027, 5, false), DEER.horn);
}

function gazellePart(name: PartName, slotColor: string) {
  const shape = SHAPES[name];
  const body: BufferGeometry = name === 'torso'
    ? new SphereGeometry(1, 16, 10).scale(0.365, 0.44, 0.34)
    : name === 'pelvis'
    ? new SphereGeometry(1, 16, 10).scale(0.32, 0.33, 0.30)
    : name === 'head'
    ? new SphereGeometry(0.335, 20, 14).scale(1.08, 1, 0.96)
    : new CapsuleGeometry(shape.radius * 1.05, shape.half * 2, 4, 12);
  paint(body, DEER.tan);
  const positions = body.getAttribute('position'), colors = body.getAttribute('color');
  const tan = new Color(DEER.tan), cream = new Color(DEER.cream), hoof = new Color(DEER.hoof);
  for (let i = 0; i < positions.count; i++) {
    const y = positions.getY(i), z = positions.getZ(i);
    const shade = name.endsWith('Hand') || name.endsWith('Leg')
      ? y < -0.07 ? hoof : tan
      : (name === 'torso' || name === 'pelvis') && z > 0.12 ? cream : tan;
    colors.setXYZ(i, shade.r, shade.g, shade.b);
  }
  const pieces: BufferGeometry[] = [body];
  if (name === 'head') {
    pieces.push(oval(DEER.cream, [0.267, 0.222, 0.088], [0, -0.045, 0.267]));
    for (const side of [-1, 1]) {
      // Flattened oval ears and shallow inner ears make a broad, soft silhouette.
      pieces.push(oval(DEER.caramel, [0.12, 0.235, 0.071], [0, 0, 0])
        .rotateZ(-side * 0.47).translate(side * 0.38, 0.25, -0.015));
      pieces.push(oval(DEER.inner, [0.075, 0.17, 0.014], [0, 0, 0])
        .rotateZ(-side * 0.47).translate(side * 0.39, 0.26, 0.054));
      pieces.push(gazelleAntler(side), gazelleAntler(side, true));
      pieces.push(oval(C.ink, [0.033, 0.056, 0.021], [side * 0.098, -0.025, 0.352]));
      // Sparse cream hood spots, readable without a texture.
      pieces.push(oval(DEER.cream, [0.036, 0.029, 0.01], [side * 0.24, 0.135, 0.229]));
    }
    pieces.push(oval(DEER.hoof, [0.032, 0.022, 0.013], [0, 0.22, 0.28]));
  }
  if (name === 'torso') {
    pieces.push(oval(DEER.cream, [0.245, 0.325, 0.071], [0, -0.025, 0.30]));
    // A few low-poly spots on the flanks and back keep the deer cue visible in motion.
    for (const side of [-1, 1]) for (const y of [-0.11, 0.085]) {
      pieces.push(paint(new SphereGeometry(1, 8, 6)
        .scale(0.038, 0.032, 0.009).translate(side * 0.29, y, 0.14), DEER.cream));
      pieces.push(paint(new SphereGeometry(1, 8, 6)
        .scale(0.038, 0.032, 0.009).translate(side * 0.18, y, -0.305), DEER.cream));
    }
    pieces.push(paint(new TorusGeometry(0.31, 0.026, 6, 16)
      .rotateX(Math.PI / 2).translate(0, 0.27, 0), slotColor));
  }
  if (name === 'pelvis') {
    pieces.push(oval(DEER.tan, [0.085, 0.075, 0.145], [0, -0.04, -0.36]));
    pieces.push(oval(DEER.cream, [0.075, 0.07, 0.07], [0, -0.05, -0.49]));
  }
  return merge(pieces);
}

function basePart(name: PartName, color: string) {
  const shape = SHAPES[name];
  const pieces = [paint(shape.half
    ? new CapsuleGeometry(shape.radius, shape.half * 2, 4, 10)
    : new SphereGeometry(shape.radius, 12, 8), color)];
  if (name === 'head') for (const side of [-1, 1])
    pieces.push(oval(C.ink, [0.0345, 0.046, 0.023], [side * 0.105, 0.045, 0.267]));
  return merge(pieces);
}
const builders: Record<CostumeId, typeof basePart> = { default: basePart, cat: catPart, anchovy: anchovyPart, gazelle: gazellePart };
type Resources = { parts: BufferGeometry[]; star: OctahedronGeometry; stars: MeshBasicMaterial; users: number };
const cache = new Map<string, Resources>();

/** Nine body-local groups, in wire order. Accessories are baked into their parent skin. */
export function createCharacterVisual(color: string, costume: CostumeId = 'default') {
  const id = resolveCostume(costume), key = `${id}:${color}`;
  let resources = cache.get(key);
  if (!resources) {
    resources = {
      parts: PARTS.map(name => builders[id](name, color)),
      star: new OctahedronGeometry(0.08, 0),
      stars: new MeshBasicMaterial({ color: '#f3d586' }), users: 0,
    };
    cache.set(key, resources);
  }
  const shared = resources;
  shared.users++;
  // Flash is mutable per player, never shared between opponents.
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, emissive: '#f5c66c', emissiveIntensity: 0 });
  const root = new Group();
  root.userData.costume = id;
  PARTS.forEach((name, index) => {
    const part = new Group();
    part.name = name;
    const skin = new Mesh(shared.parts[index], material);
    skin.name = 'skin';
    part.add(skin);
    root.add(part);
    if (name === 'head') {
      const stars = new Group();
      stars.name = 'stars';
      stars.position.y = id === 'default' ? 0.42 : id === 'anchovy' ? 0.72 : id === 'gazelle' ? 0.69 : 0.66;
      stars.visible = false;
      for (let i = 0; i < 3; i++) {
        const star = new Mesh(shared.star, shared.stars);
        star.position.set(Math.cos(i * Math.PI * 2 / 3) * 0.3, 0, Math.sin(i * Math.PI * 2 / 3) * 0.3);
        stars.add(star);
      }
      part.add(stars);
    }
  });
  let disposed = false;
  return { root, dispose() {
    if (disposed) return;
    disposed = true;
    material.dispose();
    if (--shared.users === 0) {
      shared.parts.forEach(part => part.dispose());
      shared.star.dispose();
      shared.stars.dispose();
      cache.delete(key);
    }
  } };
}
