import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Points,
  PointsMaterial,
  RingGeometry,
  SphereGeometry,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
} from "three";
import { BOMBER as B, ticks } from "../../../../shared/party-lab/simulation/bomber/config";
import { BOX, CELLS, EDGES, OUTER, RINGS, SECTORS, SECTOR_ANGLE, cellCenter, ringOf, sectorOf } from "../../../../shared/party-lab/simulation/bomber/arena";
import { collapseFallAt, ringStates } from "../../../../shared/party-lab/simulation/bomber/game";
import { BURNING, type BomberWire } from "../../../../shared/party-lab/simulation/bomber/wire";
import { createCharacterVisual } from "../visual/characterVisual";
import { PARTS, SHAPES } from "../ragdoll/config";
import type { BomberFrame, BomberLook } from "./source";
import { blastTimes, previewLook } from "./preview";

const FUSE = ticks(B.fuse),
  FLAME = ticks(B.flame);
/** Low blocks: from (nearly) above, tall ones hid the cells behind them. */
const PILLAR_HEIGHT = 0.42,
  BOX_HEIGHT = 0.36,
  /** The hub's bomb, scaled from 0.95 m. */
  STATUE = 0.45;
/** Character size on the arena (the shared skins stand 1.48 m). */
export const PERSON_SCALE = 0.85;
const PALETTE = {
  floorA: "#a9d080",
  floorB: "#9cc574",
  floorSide: "#6f8f53",
  pillar: "#8793a0",
  pillarTop: "#a2adb9",
  box: "#c88b4a",
  hub: "#5b6878",
  hubTop: "#6c7a8b",
  rim: "#4a5563",
  warn: "#c81e3a",
  flameHot: "#ffd35a",
  previewEarly: "#ff6a00",
  previewLate: "#d40f28",
  flameEdge: "#ff7a1f",
  bomb: "#2a2d36",
};

type V3 = [number, number, number];
/** Triangles of a convex polygon, wound to face `outward`. */
function polygon(points: V3[], outward: V3, out: number[], uvs: number[], uv: [number, number][]) {
  const a = points[0],
    b = points[1],
    c = points[2];
  const n: V3 = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
  const flip = n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] < 0;
  for (let i = 1; i < points.length - 1; i++) {
    const tri = flip ? [0, i + 1, i] : [0, i, i + 1];
    for (const k of tri) {
      out.push(...points[k]);
      uvs.push(...uv[k]);
    }
  }
}
const at = (r: number, a: number, y: number): V3 => [r * Math.cos(a), y, r * Math.sin(a)];
/**
 * A ring sector as a block (sector 0's angles; instances turn it): top, both arcs and both
 * radial sides, `inset` metres in from the cell's edges. UVs: top u along the arc, v outwards;
 * sides u along, v up.
 */
function sectorBlock(r0: number, r1: number, y0: number, y1: number, inset: number, segments = 6, sides = true) {
  const ri = r0 + inset,
    ro = r1 - inset,
    a0 = inset / ((r0 + r1) / 2),
    a1 = SECTOR_ANGLE - a0;
  const pos: number[] = [],
    uv: number[] = [];
  for (let i = 0; i < segments; i++) {
    const s0 = a0 + ((a1 - a0) * i) / segments,
      s1 = a0 + ((a1 - a0) * (i + 1)) / segments,
      u0 = i / segments,
      u1 = (i + 1) / segments,
      mid = (s0 + s1) / 2;
    polygon([at(ri, s0, y1), at(ro, s0, y1), at(ro, s1, y1), at(ri, s1, y1)], [0, 1, 0], pos, uv, [[u0, 0], [u0, 1], [u1, 1], [u1, 0]]);
    if (!sides) continue;
    polygon([at(ro, s0, y0), at(ro, s1, y0), at(ro, s1, y1), at(ro, s0, y1)], [Math.cos(mid), 0, Math.sin(mid)], pos, uv, [[u0, 0], [u1, 0], [u1, 1], [u0, 1]]);
    polygon([at(ri, s0, y0), at(ri, s1, y0), at(ri, s1, y1), at(ri, s0, y1)], [-Math.cos(mid), 0, -Math.sin(mid)], pos, uv, [[u0, 0], [u1, 0], [u1, 1], [u0, 1]]);
  }
  if (sides) {
    polygon([at(ri, a0, y0), at(ro, a0, y0), at(ro, a0, y1), at(ri, a0, y1)], [Math.sin(a0), 0, -Math.cos(a0)], pos, uv, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    polygon([at(ri, a1, y0), at(ro, a1, y0), at(ro, a1, y1), at(ri, a1, y1)], [-Math.sin(a1), 0, Math.cos(a1)], pos, uv, [[0, 0], [1, 0], [1, 1], [0, 1]]);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

function crateTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#d39a57";
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = "rgba(110,62,24,0.55)";
  ctx.lineWidth = 3;
  for (let y = 24; y < 128; y += 26) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(128, y);
    ctx.stroke();
  }
  ctx.strokeStyle = "#7a4a1f";
  ctx.lineWidth = 14;
  ctx.strokeRect(7, 7, 114, 114);
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(10, 10);
  ctx.lineTo(118, 118);
  ctx.stroke();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
function stoneTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = "rgba(40,48,58,0.35)";
  ctx.lineWidth = 2;
  for (const y of [21, 43]) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(64, y);
    ctx.stroke();
  }
  for (const [x, y0, y1] of [[32, 0, 21], [16, 21, 43], [48, 21, 43], [32, 43, 64]]) {
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
/** A text sprite (names, points). */
export function textSprite(text: string, color: string, size = 1) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "800 38px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 8;
  ctx.strokeStyle = "rgba(18,22,30,0.85)";
  ctx.strokeText(text, 128, 34);
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 34);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false }));
  sprite.scale.set(1.6 * size, 0.4 * size, 1);
  sprite.renderOrder = 10;
  return sprite;
}

const TURNS = Array.from({ length: SECTORS }, (_, s) => new Matrix4().makeRotationY(-s * SECTOR_ANGLE));
const turn = (sector: number) => TURNS[sector];
const mix = (a: string, b: string, t: number) => new Color(a).lerp(new Color(b), t);

/**
 * The Bombacı arena: floor blocks, pillars and boxes per ring (instanced, turned per sector),
 * the hub with its big bomb, the rim, the bombs, the flames, the players, puffs and points.
 * It draws a BomberFrame; it decides nothing.
 */
export function bomberVisual(looks: readonly BomberLook[], first: BomberWire) {
  const root = new Group();
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);
  const matrix = new Matrix4(),
    color = new Color(),
    around = new Matrix4();
  /** `matrix` scaled by (sxz, sy, sxz) about the middle of `cell` (on the ground). */
  const scaleAbout = (cell: number, sxz: number, sy: number) => {
    const c = cellCenter(cell);
    matrix.premultiply(around.makeTranslation(-c.x, 0, -c.z)).premultiply(around.makeScale(sxz, sy, sxz)).premultiply(around.makeTranslation(c.x, 0, c.z));
  };

  const stone = keep(stoneTexture()),
    crate = keep(crateTexture());
  const floorMat = keep(new MeshStandardMaterial({ roughness: 0.92, metalness: 0 }));
  const pillarMat = keep(new MeshStandardMaterial({ color: PALETTE.pillar, map: stone, roughness: 0.85 }));
  const boxMat = keep(new MeshStandardMaterial({ map: crate, roughness: 0.8 }));
  // Plain (not additive) blending: on the light floor additive flames washed out to white.
  const flameMat = keep(new MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false, side: DoubleSide }));
  // Blast preview: per-instance colour and opacity (a `previewAlpha` attribute).
  const previewMat = keep(new MeshBasicMaterial({ transparent: true, depthWrite: false }));
  previewMat.onBeforeCompile = (shader) => {
    shader.vertexShader = "attribute float previewAlpha;\nvarying float vPreviewAlpha;\n" + shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n vPreviewAlpha = previewAlpha;");
    shader.fragmentShader = "varying float vPreviewAlpha;\n" + shader.fragmentShader.replace("#include <alphamap_fragment>", "#include <alphamap_fragment>\n diffuseColor.a *= vPreviewAlpha;");
  };

  // Floor, pillars, boxes and flames: one instanced mesh per ring, an instance per sector.
  const floors: InstancedMesh[] = [],
    pillars: (InstancedMesh | null)[] = [],
    boxes: InstancedMesh[] = [],
    flames: InstancedMesh[] = [],
    previews: { mesh: InstancedMesh; alpha: InstancedBufferAttribute }[] = [],
    cores: InstancedMesh[] = [];
  const pocketOf = new Int8Array(CELLS).fill(-1);
  first.spawns.forEach((_, lane) => {
    // Every pocket is the 3 × 3 around the pillar inwards of the start.
    const spawn = first.spawns[lane];
    for (let ring = 2; ring <= 4; ring++) for (let d = -1; d <= 1; d++) pocketOf[ring * SECTORS + ((sectorOf(spawn) + d + SECTORS) % SECTORS)] = lane;
  });
  for (let ring = 0; ring < RINGS; ring++) {
    const r0 = EDGES[ring],
      r1 = EDGES[ring + 1];
    const floor = new InstancedMesh(keep(sectorBlock(r0, r1, -0.45, 0, 0.025)), floorMat, SECTORS);
    for (let s = 0; s < SECTORS; s++) {
      floor.setMatrixAt(s, turn(s));
      floor.setColorAt(s, baseFloor(ring, s));
    }
    floor.instanceMatrix.setUsage(DynamicDrawUsage);
    floors.push(floor);
    root.add(floor);
    if (ring % 2 === 1) {
      const p = new InstancedMesh(keep(sectorBlock(r0, r1, 0, PILLAR_HEIGHT, 0.05)), pillarMat, SECTORS / 2);
      for (let i = 0; i < SECTORS / 2; i++) p.setMatrixAt(i, turn(i * 2 + 1));
      p.instanceMatrix.setUsage(DynamicDrawUsage);
      pillars.push(p);
      root.add(p);
    } else pillars.push(null);
    const box = new InstancedMesh(keep(sectorBlock(r0, r1, 0, BOX_HEIGHT, 0.09)), boxMat, SECTORS);
    box.instanceMatrix.setUsage(DynamicDrawUsage);
    box.count = 0;
    boxes.push(box);
    root.add(box);
    const preview = new InstancedMesh(keep(sectorBlock(r0, r1, 0, 0.014, 0.03, 6, false)), previewMat, SECTORS);
    preview.instanceMatrix.setUsage(DynamicDrawUsage);
    const alpha = new InstancedBufferAttribute(new Float32Array(SECTORS), 1).setUsage(DynamicDrawUsage);
    preview.geometry.setAttribute("previewAlpha", alpha);
    preview.count = 0;
    preview.frustumCulled = false;
    preview.renderOrder = 1;
    previews.push({ mesh: preview, alpha });
    root.add(preview);
    const flame = new InstancedMesh(keep(sectorBlock(r0, r1, 0, 0.06, 0.04, 6, false)), flameMat, SECTORS);
    flame.instanceMatrix.setUsage(DynamicDrawUsage);
    flame.count = 0;
    flame.frustumCulled = false;
    flames.push(flame);
    root.add(flame);
    const core = new InstancedMesh(keep(sectorBlock(r0, r1, 0.08, 0.5, 0.22, 6, true)), flameMat, SECTORS);
    core.instanceMatrix.setUsage(DynamicDrawUsage);
    core.count = 0;
    core.frustumCulled = false;
    cores.push(core);
    root.add(core);
  }
  function baseFloor(ring: number, sector: number) {
    const cell = ring * SECTORS + sector,
      lane = pocketOf[cell];
    const base = (ring + sector) % 2 ? PALETTE.floorA : PALETTE.floorB;
    // A light tint: stronger ones were mistaken for the blast preview.
    return lane >= 0 && looks[lane] ? mix(base, looks[lane].color, 0.16) : new Color(base);
  }

  // The hub: a stone dais with a big bomb, the rim round the edge.
  const hub = new Mesh(keep(new CylinderGeometry(EDGES[0] - 0.06, EDGES[0] + 0.05, 0.75, 64)), keep(new MeshStandardMaterial({ color: PALETTE.hub, map: stone, roughness: 0.9 })));
  hub.position.y = -0.1;
  root.add(hub);
  const hubTop = new Mesh(keep(new CircleGeometry(EDGES[0] - 0.2, 64)), keep(new MeshStandardMaterial({ color: PALETTE.hubTop, roughness: 0.95 })));
  hubTop.rotation.x = -Math.PI / 2;
  hubTop.position.y = 0.276;
  root.add(hubTop);
  const statue = new Group();
  const statueBody = new Mesh(keep(new SphereGeometry(0.95, 32, 20)), keep(new MeshStandardMaterial({ color: PALETTE.bomb, roughness: 0.35, metalness: 0.2 })));
  const statueCap = new Mesh(keep(new CylinderGeometry(0.28, 0.32, 0.3, 20)), keep(new MeshStandardMaterial({ color: "#9aa3ad", roughness: 0.4, metalness: 0.5 })));
  statueCap.position.y = 0.95;
  const statueSpark = new Mesh(keep(new SphereGeometry(0.16, 12, 8)), keep(new MeshBasicMaterial({ color: "#ffcf5a" })));
  statueSpark.position.set(0.12, 1.32, 0);
  statue.add(statueBody, statueCap, statueSpark);
  // A small ornament: the hub is no landmark to look at.
  statue.scale.setScalar(STATUE);
  statue.position.y = 0.28 + 0.95 * STATUE;
  root.add(statue);
  const rimMat = keep(new MeshStandardMaterial({ color: PALETTE.rim, map: stone, roughness: 0.9 }));
  const rim = new Mesh(keep(new CylinderGeometry(OUTER + 0.42, OUTER + 0.42, 0.85, 96, 1, true)), rimMat);
  rim.position.y = -0.17;
  const rimInner = new Mesh(keep(new CylinderGeometry(OUTER + 0.03, OUTER + 0.03, 0.85, 96, 1, true)), keep(new MeshStandardMaterial({ color: PALETTE.rim, roughness: 0.9, side: DoubleSide })));
  rimInner.position.y = -0.17;
  const rimTop = new Mesh(keep(new RingGeometry(OUTER + 0.03, OUTER + 0.42, 96)), rimMat);
  rimTop.rotation.x = -Math.PI / 2;
  rimTop.position.y = 0.26;
  root.add(rim, rimInner, rimTop);

  // Start markers (gone with their ring).
  const marks: Mesh[] = [];
  first.spawns.forEach((spawn, lane) => {
    const mark = new Mesh(keep(new RingGeometry(0.3, 0.4, 32)), keep(new MeshBasicMaterial({ color: looks[lane]?.color ?? "#fff", transparent: true, opacity: 0.85, depthWrite: false })));
    const at = cellCenter(spawn);
    mark.rotation.x = -Math.PI / 2;
    mark.position.set(at.x, 0.012, at.z);
    mark.userData.cell = spawn;
    marks.push(mark);
    root.add(mark);
  });

  // Bombs: a small pool.
  const bombBody = keep(new SphereGeometry(0.3, 24, 16)),
    bombBand = keep(new TorusGeometry(0.3, 0.045, 8, 28)),
    bombFuse = keep(new CylinderGeometry(0.03, 0.03, 0.2, 6)),
    sparkGeo = keep(new SphereGeometry(0.07, 8, 6));
  const fuseMat = keep(new MeshStandardMaterial({ color: "#8a7a5a", roughness: 0.9 }));
  const bandMats = looks.map((l) => keep(new MeshStandardMaterial({ color: l.color, roughness: 0.5 })));
  const pool: { group: Group; body: Mesh; band: Mesh; spark: Mesh; mat: MeshStandardMaterial; phase: number; key: string }[] = [];
  function bombMesh() {
    const mat = keep(new MeshStandardMaterial({ color: PALETTE.bomb, roughness: 0.35, metalness: 0.15, emissive: "#ff2a10", emissiveIntensity: 0 }));
    const group = new Group(),
      body = new Mesh(bombBody, mat),
      band = new Mesh(bombBand, bandMats[0]),
      fuse = new Mesh(bombFuse, fuseMat),
      spark = new Mesh(sparkGeo, keep(new MeshBasicMaterial({ color: "#ffdd66" })));
    body.position.y = 0.3;
    band.rotation.x = Math.PI / 2;
    band.position.y = 0.3;
    fuse.position.set(0.06, 0.66, 0);
    fuse.rotation.z = -0.35;
    spark.position.set(0.1, 0.78, 0);
    group.add(body, band, fuse, spark);
    root.add(group);
    const item = { group, body, band, spark, mat, phase: 0, key: "" };
    pool.push(item);
    return item;
  }

  // Players.
  const people = looks.map((look) => {
    const person = createCharacterVisual(look.color, look.costume);
    person.root.scale.setScalar(PERSON_SCALE);
    PARTS.forEach((name, index) => {
      const shape = SHAPES[name];
      person.root.children[index].position.set(shape.x, shape.y, 0);
    });
    const ring = new Mesh(keep(new RingGeometry(0.3, 0.42, 28)), keep(new MeshBasicMaterial({ color: look.color, transparent: true, opacity: 0.9, depthWrite: false })));
    ring.rotation.x = -Math.PI / 2;
    const shadow = new Mesh(keep(new CircleGeometry(0.34, 20)), keep(new MeshBasicMaterial({ color: "#1f2a1a", transparent: true, opacity: 0.28, depthWrite: false })));
    shadow.rotation.x = -Math.PI / 2;
    const tag = textSprite(look.name, look.color, 1.5);
    root.add(person.root, ring, shadow, tag);
    return { person, ring, shadow, tag, yaw: 0, gait: 0, last: { x: NaN, z: NaN }, alive: true };
  });

  // Puffs and debris: one points cloud.
  const MAX = 240;
  const positions = new Float32Array(MAX * 3).fill(-1000),
    colors = new Float32Array(MAX * 3),
    velocity = new Float32Array(MAX * 3),
    life = new Float32Array(MAX);
  const cloudGeo = keep(new BufferGeometry());
  cloudGeo.setAttribute("position", new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage));
  cloudGeo.setAttribute("color", new BufferAttribute(colors, 3).setUsage(DynamicDrawUsage));
  const cloud = new Points(cloudGeo, keep(new PointsMaterial({ size: 0.16, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false })));
  cloud.frustumCulled = false;
  root.add(cloud);
  let cursor = 0;
  function burst(x: number, y: number, z: number, tint: string, count: number, speed: number) {
    const c = new Color(tint);
    for (let j = 0; j < count; j++) {
      const i = cursor++ % MAX,
        a = j * 2.39996 + Math.random(),
        v = speed * (0.5 + Math.random() * 0.7);
      life[i] = 0.5 + Math.random() * 0.4;
      positions.set([x, y, z], i * 3);
      velocity.set([Math.cos(a) * v, 1.2 + Math.random() * 2, Math.sin(a) * v], i * 3);
      colors.set([c.r, c.g, c.b], i * 3);
    }
  }
  const floaters: { sprite: Sprite; age: number; ghost: boolean }[] = [];
  function popup(text: string, tint: string, x: number, z: number) {
    const sprite = textSprite(text, tint, 1.1);
    sprite.position.set(x, 1.6, z);
    root.add(sprite);
    floaters.push({ sprite, age: 0, ghost: false });
  }
  const ghostTexture = (() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return keep(new CanvasTexture(canvas));
  })();
  function ghost(x: number, z: number, tint: string) {
    const sprite = new Sprite(new SpriteMaterial({ map: ghostTexture, color: tint, transparent: true, depthWrite: false }));
    sprite.scale.set(0.9, 0.9, 1);
    sprite.position.set(x, 0.6, z);
    root.add(sprite);
    floaters.push({ sprite, age: 0, ghost: true });
  }

  const burnt = new Set<number>();
  let clock = 0;
  function update(frame: BomberFrame, dt: number) {
    clock += dt;
    const w = frame.wire,
      states = ringStates(Math.floor(frame.step)),
      step = frame.step;
    for (const mark of marks) mark.visible = states[ringOf(mark.userData.cell as number)] !== 2;
    statue.rotation.y += dt * 0.4;
    statue.position.y = 0.28 + 0.95 * STATUE + Math.sin(clock * 2) * 0.03;
    statueSpark.scale.setScalar(0.8 + Math.random() * 0.5);
    // Rings: blinking before they fall, then dropping away.
    for (let ring = 0; ring < RINGS; ring++) {
      const k = (B.collapse.rings as readonly number[]).indexOf(ring),
        fell = states[ring] === 2 ? (step - collapseFallAt(k)) / B.hz : -1,
        drop = fell < 0 ? 0 : 0.5 * 14 * fell * fell,
        gone = fell > 1.2,
        blink = states[ring] === 1 && Math.floor(clock * 6) % 2 === 0;
      for (let s = 0; s < SECTORS; s++) {
        matrix.copy(turn(s));
        if (drop) matrix.setPosition(0, -drop, 0);
        if (gone) matrix.makeScale(0, 0, 0);
        floors[ring].setMatrixAt(s, matrix);
        floors[ring].setColorAt(s, blink ? color.set(PALETTE.warn) : states[ring] === 2 ? color.set(PALETTE.floorSide) : baseFloor(ring, s));
      }
      floors[ring].instanceMatrix.needsUpdate = true;
      const floorColors = floors[ring].instanceColor;
      if (floorColors) floorColors.needsUpdate = true;
      const p = pillars[ring];
      if (p) {
        for (let i = 0; i < SECTORS / 2; i++) {
          matrix.copy(turn(i * 2 + 1));
          if (drop) matrix.setPosition(0, -drop, 0);
          if (gone) matrix.makeScale(0, 0, 0);
          p.setMatrixAt(i, matrix);
        }
        p.instanceMatrix.needsUpdate = true;
      }
      // Boxes: whole, burning (shrinking, glowing), gone.
      let n = 0;
      for (let s = 0; s < SECTORS; s++) {
        const cell = ring * SECTORS + s,
          code = w.cells[cell];
        if (code === BURNING && !burnt.has(cell)) {
          burnt.add(cell);
          const c = cellCenter(cell);
          burst(c.x, 0.4, c.z, "#b0763a", 12, 1.6);
        }
        if (code !== BOX && code !== BURNING) continue;
        const shrink = code === BURNING ? 0.55 + 0.25 * Math.sin(clock * 30) : 1;
        matrix.copy(turn(s));
        if (shrink !== 1) scaleAbout(cell, shrink, shrink);
        if (drop) matrix.setPosition(matrix.elements[12], matrix.elements[13] - drop, matrix.elements[14]);
        boxes[ring].setMatrixAt(n, matrix);
        boxes[ring].setColorAt(n, code === BURNING ? color.set("#ff9a4a") : color.set("#ffffff"));
        n++;
      }
      boxes[ring].count = n;
      boxes[ring].instanceMatrix.needsUpdate = true;
      const boxColors = boxes[ring].instanceColor;
      if (boxColors) boxColors.needsUpdate = true;
    }
    // Where the bombs will burn (chains included): faint orange to blinking red as fuses run out.
    const times = blastTimes(w, frame.bombs),
      shownPreview = new Array(RINGS).fill(0);
    for (let cell = 0; cell < CELLS; cell++) {
      if (!(times[cell] < Infinity)) continue;
      const ring = ringOf(cell),
        n = shownPreview[ring]++,
        look = previewLook(times[cell], clock);
      previews[ring].mesh.setMatrixAt(n, turn(sectorOf(cell)));
      previews[ring].mesh.setColorAt(n, mix(PALETTE.previewEarly, PALETTE.previewLate, look.u));
      previews[ring].alpha.setX(n, look.alpha);
    }
    previews.forEach(({ mesh, alpha }, ring) => {
      mesh.count = shownPreview[ring];
      mesh.instanceMatrix.needsUpdate = alpha.needsUpdate = true;
      const colors = mesh.instanceColor;
      if (colors) colors.needsUpdate = true;
    });
    // Flames: hot while fresh, then fading.
    const fireCount = new Array(RINGS).fill(0);
    for (let i = 0; i + 2 < w.fire.length; i += 3) {
      const cell = w.fire[i],
        left = Math.max(0, w.fire[i + 1] - (step - w.step)),
        ring = ringOf(cell),
        heat = Math.min(1, left / FLAME + 0.15),
        n = fireCount[ring]++;
      const pulse = 1 + Math.sin(clock * 40 + cell) * 0.06;
      matrix.copy(turn(sectorOf(cell)));
      flames[ring].setMatrixAt(n, matrix);
      flames[ring].setColorAt(n, mix("#c2410c", PALETTE.flameEdge, heat));
      scaleAbout(cell, pulse, 0.6 + heat * 0.8);
      cores[ring].setMatrixAt(n, matrix);
      cores[ring].setColorAt(n, mix(PALETTE.flameEdge, PALETTE.flameHot, heat));
    }
    for (let ring = 0; ring < RINGS; ring++) {
      flames[ring].count = cores[ring].count = fireCount[ring];
      for (const m of [flames[ring], cores[ring]]) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    }
    // Bombs: owner band, a pulse quickening as the fuse runs out, red at the end.
    const shown = new Set<string>();
    frame.bombs.forEach((bomb) => {
      const item = pool.find((p) => p.key === bomb.key) ?? pool.find((p) => !p.key || !frame.bombs.some((b) => b.key === p.key)) ?? bombMesh();
      item.key = bomb.key;
      shown.add(bomb.key);
      const c = cellCenter(bomb.cell),
        left = Math.max(0, bomb.fuse) / FUSE;
      item.group.visible = true;
      item.group.position.set(c.x, 0, c.z);
      item.band.material = bandMats[bomb.owner] ?? bandMats[0];
      item.phase += dt * (5 + 22 * (1 - left));
      const s = 1 + Math.sin(item.phase) * (0.05 + 0.07 * (1 - left));
      item.body.scale.setScalar(s);
      item.mat.emissiveIntensity = left < 0.25 ? (0.5 + 0.5 * Math.sin(item.phase * 2)) * 0.9 : 0;
      item.spark.scale.setScalar(0.7 + Math.random() * 0.6);
    });
    for (const item of pool)
      if (!shown.has(item.key)) {
        item.group.visible = false;
        item.key = "";
      }
    // Players.
    people.forEach((pv, lane) => {
      const alive = frame.alive[lane] && !w.out[lane];
      const x = frame.x[lane],
        z = frame.z[lane];
      if (pv.alive && !alive && !w.out[lane]) {
        burst(x, 0.6, z, looks[lane]?.color ?? "#fff", 18, 2.2);
        burst(x, 0.6, z, "#f4f1ea", 10, 1.6);
        ghost(x, z, looks[lane]?.color ?? "#fff");
      }
      pv.alive = alive;
      const moved = Number.isFinite(pv.last.x) ? Math.hypot(x - pv.last.x, z - pv.last.z) : 0;
      pv.last = { x, z };
      const speed = dt > 0 ? moved / dt : 0;
      const blink = w.shield[lane] > 0 && Math.floor(clock * 10) % 2 === 0;
      const show = alive && !blink;
      pv.person.root.visible = show;
      pv.ring.visible = pv.shadow.visible = alive;
      pv.tag.visible = alive && lane !== frame.self;
      if (!alive) return;
      const target = frame.face[lane];
      let d = target - pv.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      pv.yaw += d * Math.min(1, dt * 14);
      pv.gait += dt * Math.min(14, speed * 4.2);
      const swing = Math.sin(pv.gait) * Math.min(0.55, speed * 0.16);
      const r = pv.person.root;
      r.position.set(x, Math.abs(Math.sin(pv.gait)) * Math.min(0.05, speed * 0.015), z);
      r.rotation.y = pv.yaw;
      r.children[7].rotation.x = swing;
      r.children[8].rotation.x = -swing;
      r.children[3].rotation.x = -swing * 0.8;
      r.children[5].rotation.x = swing * 0.8;
      pv.ring.position.set(x, 0.015, z);
      pv.shadow.position.set(x, 0.01, z);
      pv.tag.position.set(x, 1.9, z);
    });
    // Particles and floating points.
    for (let i = 0; i < MAX; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      if (life[i] <= 0) {
        positions[i * 3 + 1] = -1000;
        continue;
      }
      velocity[i * 3 + 1] -= dt * 6;
      for (let j = 0; j < 3; j++) positions[i * 3 + j] += velocity[i * 3 + j] * dt;
    }
    cloudGeo.attributes.position.needsUpdate = true;
    cloudGeo.attributes.color.needsUpdate = true;
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.age += dt;
      f.sprite.position.y += dt * (f.ghost ? 1.4 : 0.9);
      (f.sprite.material as SpriteMaterial).opacity = Math.max(0, 1 - f.age / (f.ghost ? 1 : 1.3));
      if (f.age > (f.ghost ? 1 : 1.3)) {
        root.remove(f.sprite);
        (f.sprite.material as SpriteMaterial).map?.dispose?.();
        f.sprite.material.dispose();
        floaters.splice(i, 1);
      }
    }
  }
  function blast(cell: number) {
    const c = cellCenter(cell);
    burst(c.x, 0.4, c.z, "#ffb340", 26, 3.4);
    burst(c.x, 0.4, c.z, "#5b5b5b", 12, 1.4);
  }
  return {
    root,
    update,
    popup,
    blast,
    dispose() {
      for (const p of people) p.person.dispose();
      for (const d of disposables) d.dispose();
      for (const p of people) {
        (p.tag.material as SpriteMaterial).map?.dispose();
        p.tag.material.dispose();
      }
      for (const f of floaters) f.sprite.material.dispose();
      root.traverse((o: Object3D) => {
        if (o instanceof InstancedMesh) o.dispose();
      });
    },
  };
}
export type BomberVisual = ReturnType<typeof bomberVisual>;
