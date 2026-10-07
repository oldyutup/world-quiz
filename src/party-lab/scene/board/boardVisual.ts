import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Material,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { boardBounds, boardPath, numberedSquare, SQUARE_SIZE, type SquarePose } from "../../../../shared/party-lab/board/layout";
import type { SpecialType } from "../../../../shared/party-lab/board/config";
import type { BoardWire } from "../../../../shared/party-lab/board/wire";
import { connectorPoint, connectorSpan } from "./boardMotion";
import { GLYPH_STROKE, SQUARE_STYLE } from "./squareStyle";
import { PARTS, SHAPES } from "../ragdoll/config";
import { createCharacterVisual } from "../visual/characterVisual";
import type { CostumeId } from "../visual/costumes";

/*
 * Tahta Oyunu scenery, in the Party Lab primitive style: merged vertex-coloured, flat-shaded
 * low-poly pieces (one draw call for the whole landscape and path), canvas labels, and the
 * same nine-part characters as every arena, standing still as pawns.
 */
export const TILE_TOP = 0.24;
const PALETTE = {
  sky: "#cfe1d6",
  grass: "#9cba82",
  grassDark: "#8fae7c",
  rim: "#7d9c74",
  trail: "#d4bf91",
  tile: "#f6ecd3",
  tileAlt: "#ebdcb8",
  tileFive: "#f2c46b",
  start: "#7fb3a4",
  treasure: "#edbd4c",
  ink: "#2f3d3a",
};

function paint(geometry: BufferGeometry, hex: string) {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  if (flat !== geometry) geometry.dispose();
  flat.deleteAttribute("uv");
  const color = new Color(hex),
    n = flat.attributes.position.count,
    colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) color.toArray(colors, i * 3);
  flat.setAttribute("color", new Float32BufferAttribute(colors, 3));
  return flat;
}
function merge(pieces: BufferGeometry[]) {
  const result = mergeGeometries(pieces)!;
  pieces.forEach((g) => g.dispose());
  return result;
}
/** A seeded random source, so every page grows the same trees. */
function seeded(seed: number) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function canvasTexture(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext("2d")!);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
/** A special square's white glyph (24 × 24 SVG paths, stroked). */
function glyphTexture(type: SpecialType) {
  return canvasTexture(256, 256, (ctx) => {
    ctx.scale(256 / 24, 256 / 24);
    ctx.strokeStyle = "#fffaf0";
    ctx.lineWidth = GLYPH_STROKE;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke(new Path2D(SQUARE_STYLE[type].glyph));
  });
}
const UP = new Vector3(0, 1, 0);
/** A box from `a` to `b` (its length), `width` across and `height` up, for ladders and chutes. */
function beam(a: Vector3, b: Vector3, width: number, height: number) {
  const z = b.clone().sub(a),
    length = z.length();
  z.normalize();
  const x = new Vector3().crossVectors(UP, z);
  if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
  x.normalize();
  const y = new Vector3().crossVectors(z, x);
  return new BoxGeometry(width, height, length).applyMatrix4(new Matrix4().makeBasis(x, y, z).setPosition(a.clone().add(b).multiplyScalar(0.5)));
}
/** Points along a ladder or slide between two squares (the pawns follow the same curve). */
function connectorCurve(type: "ladder" | "slide", a: SquarePose, b: SquarePose, samples: number) {
  const { start, end } = connectorSpan(type, a, b);
  return Array.from({ length: samples + 1 }, (_, i) => {
    const p = connectorPoint(type, a, b, start + 0.005 + ((end - start - 0.01) * i) / samples);
    return new Vector3(p.x, TILE_TOP + p.y, p.z);
  });
}
/** A ladder lying over the gap between two rows: two rails and rungs on a low arch. */
function ladderPieces(a: SquarePose, b: SquarePose, add: (g: BufferGeometry, hex: string) => void) {
  const points = connectorCurve("ladder", a, b, 12);
  const across = new Vector3().crossVectors(UP, new Vector3(b.x - a.x, 0, b.z - a.z)).normalize().multiplyScalar(0.3);
  for (let i = 0; i < points.length - 1; i++)
    for (const side of [1, -1]) {
      const off = across.clone().multiplyScalar(side);
      add(beam(points[i].clone().add(off), points[i + 1].clone().add(off), 0.09, 0.09), "#2c63a6");
    }
  for (let i = 1; i < points.length - 1; i += 2) add(beam(points[i].clone().sub(across), points[i].clone().add(across), 0.08, 0.06), "#f3ead2");
}
/** A slide from its upper square down to the lower one: a chute with low walls on posts. */
function slidePieces(a: SquarePose, b: SquarePose, add: (g: BufferGeometry, hex: string) => void) {
  const points = connectorCurve("slide", a, b, 14);
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i],
      q = points[i + 1];
    const across = new Vector3().crossVectors(UP, q.clone().sub(p)).setY(0).normalize().multiplyScalar(0.36);
    add(beam(p.clone().setY(p.y - 0.03), q.clone().setY(q.y - 0.03), 0.74, 0.06), "#8456c8");
    for (const side of [1, -1]) {
      const off = across.clone().multiplyScalar(side).add(new Vector3(0, 0.1, 0));
      add(beam(p.clone().add(off), q.clone().add(off), 0.06, 0.22), "#6a3fb0");
    }
  }
  // Posts under the high part.
  for (const i of [0, 4]) {
    const p = points[i];
    if (p.y < TILE_TOP + 0.3) continue;
    add(new CylinderGeometry(0.06, 0.07, p.y, 6).translate(p.x, p.y / 2, p.z), "#5b3896");
  }
}

/** Flat text lying on a square, upright for the camera on the +Z side. */
function floorText(text: string, size: number, color = PALETTE.ink, font = 900) {
  const texture = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${font} ${text.length > 2 ? 78 : 150}px system-ui, sans-serif`;
    ctx.fillText(text, 128, 136);
  });
  const mesh = new Mesh(new PlaneGeometry(size, size), new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 2;
  return mesh;
}
export function nameTag(text: string, color: string) {
  const texture = canvasTexture(320, 72, (ctx) => {
    ctx.fillStyle = "rgba(47, 61, 58, 0.88)";
    ctx.beginPath();
    ctx.roundRect(4, 6, 312, 60, 24);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(36, 36, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f6ecd3";
    ctx.font = "700 30px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(text.length > 13 ? `${text.slice(0, 12)}…` : text, 58, 38);
  });
  const sprite = new Sprite(new SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, toneMapped: false, transparent: true }));
  sprite.scale.set(1.5, 0.34, 1);
  sprite.renderOrder = 6;
  return sprite;
}

/** Pip layout per value on a 3 × 3 grid. */
const PIPS: Record<number, [number, number][]> = {
  1: [[1, 1]],
  2: [[0, 0], [2, 2]],
  3: [[0, 0], [1, 1], [2, 2]],
  4: [[0, 0], [2, 0], [0, 2], [2, 2]],
  5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
  6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
};
/** BoxGeometry face order (+X, −X, +Y, −Y, +Z, −Z) → value; opposite faces add up to 7. */
export const FACE_VALUES = [3, 4, 1, 6, 2, 5] as const;
const FACE_NORMALS = [new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, -1, 0), new Vector3(0, 0, 1), new Vector3(0, 0, -1)];
/** The rotation that puts `value` on top (and its face square to the camera). */
export function faceUp(value: number) {
  const normal = FACE_NORMALS[FACE_VALUES.indexOf(value as (typeof FACE_VALUES)[number])];
  return new Quaternion().setFromUnitVectors(normal, new Vector3(0, 1, 0));
}
function dieMaterials() {
  return FACE_VALUES.map((value) => {
    const texture = canvasTexture(128, 128, (ctx) => {
      ctx.fillStyle = "#fbf6ea";
      ctx.fillRect(0, 0, 128, 128);
      ctx.fillStyle = value === 1 ? "#c8553d" : PALETTE.ink;
      for (const [x, y] of PIPS[value]) {
        ctx.beginPath();
        ctx.arc(30 + x * 34, 30 + y * 34, value === 1 ? 16 : 12, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    return new MeshStandardMaterial({ map: texture, roughness: 0.55 });
  });
}

export interface Pawn {
  group: Group;
  body: Group;
  tag: Sprite;
  shadow: Mesh;
  key: string;
  dispose(): void;
  /** Smoothed pose, eased toward the target each frame. */
  shown: { x: number; z: number; y: number; yaw: number; placed: boolean };
}
export function createPawn(color: string, costume: CostumeId, name: string, key: string): Pawn {
  const person = createCharacterVisual(color, costume);
  PARTS.forEach((part, index) => {
    const shape = SHAPES[part];
    person.root.children[index].position.set(shape.x, shape.y + 0.79, 0);
  });
  const body = new Group();
  body.add(person.root);
  const group = new Group();
  group.add(body);
  const shadow = new Mesh(new CircleGeometry(0.3, 20), new MeshBasicMaterial({ color: "#3d4c3f", transparent: true, opacity: 0.22, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = TILE_TOP + 0.01;
  const tag = nameTag(name, color);
  group.add(shadow, tag);
  return {
    group,
    body,
    tag,
    shadow,
    key,
    shown: { x: 0, z: 0, y: 0, yaw: 0, placed: false },
    dispose() {
      person.dispose();
      (shadow.material as Material).dispose();
      shadow.geometry.dispose();
      tag.material.map?.dispose();
      tag.material.dispose();
    },
  };
}

export interface BoardVisual {
  root: Group;
  path: SquarePose[];
  bounds: ReturnType<typeof boardBounds>;
  /** "+1" badge material for players holding a bonus die (one sprite per pawn shares it). */
  bonusBadge: SpriteMaterial;
  /** The bonus "+1" shown by the dice when a roll uses it. */
  bonusPlus: Sprite;
  /** Current-turn ring on a square (hidden with −1). */
  ring: Mesh;
  dice: Mesh[];
  plusOne: Sprite;
  chestLid: Group;
  sparkles: Group;
  treasure: Vector3;
  dispose(): void;
}

export function createBoardVisual(length: number, squares: BoardWire["squares"] = []): BoardVisual {
  const path = boardPath(length),
    bounds = boardBounds(path);
  const special = new Map(squares.map(([index, type, target]) => [index, { type, target }]));
  const root = new Group();
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.88, flatShading: true });
  const land: BufferGeometry[] = [];
  const add = (geometry: BufferGeometry, hex: string) => land.push(paint(geometry, hex));
  const cx = (bounds.minX + bounds.maxX) / 2,
    cz = (bounds.minZ + bounds.maxZ) / 2;
  const radius = Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2 + 7;
  // An island meadow: cream squares read clearly on the grass.
  add(new CylinderGeometry(radius, radius + 0.6, 0.8, 56).translate(cx, -0.4, cz), PALETTE.grass);
  add(new CylinderGeometry(radius + 0.6, radius + 1.4, 1.2, 56).translate(cx, -1.4, cz), PALETTE.rim);
  // Trail between neighbouring squares.
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1],
      b = path[i],
      dx = b.x - a.x,
      dz = b.z - a.z,
      d = Math.hypot(dx, dz);
    add(new BoxGeometry(0.42, 0.05, d).rotateY(Math.atan2(dx, dz)).translate((a.x + b.x) / 2, 0.06, (a.z + b.z) / 2), PALETTE.trail);
  }
  // Squares: start, special ones in their colour, every fifth (numbered), plain ones alternating, the treasure.
  path.forEach((pose, i) => {
    const kind = special.get(i)?.type;
    const color = i === 0 ? PALETTE.start : i === length ? PALETTE.treasure : kind ? SQUARE_STYLE[kind].color : numberedSquare(i, length) ? PALETTE.tileFive : i % 2 ? PALETTE.tile : PALETTE.tileAlt;
    const size = i === 0 || i === length ? SQUARE_SIZE + 0.15 : SQUARE_SIZE - 0.1;
    add(new RoundedBoxGeometry(size, TILE_TOP, size, 2, 0.09).rotateY(pose.yaw).translate(pose.x, TILE_TOP / 2, pose.z), color);
    if (i === 0 || i === length) add(new CylinderGeometry(size * 0.62, size * 0.66, 0.08, 6).translate(pose.x, 0.04, pose.z), i === 0 ? "#5f9585" : "#c99a35");
  });
  // Ladders and slides between rows.
  const connectorSpots: { x: number; z: number }[] = [];
  for (const [from, { type, target }] of special) {
    if (type !== "ladder" && type !== "slide") continue;
    const a = path[from],
      b = path[target];
    (type === "ladder" ? ladderPieces : slidePieces)(a, b, add);
    for (let k = 1; k < 8; k++) connectorSpots.push({ x: a.x + ((b.x - a.x) * k) / 8, z: a.z + ((b.z - a.z) * k) / 8 });
  }
  // Start flag, at the far corner so it never hides a pawn or the word.
  {
    const s = path[0],
      x = s.x - 0.95,
      z = s.z - 0.95;
    add(new CylinderGeometry(0.04, 0.05, 2.1, 8).translate(x, 1.05, z), "#6d5a44");
    add(new BoxGeometry(0.62, 0.38, 0.04).translate(x + 0.33, 1.84, z), "#e46f5a");
  }
  // Trees beyond the board's far side and flanks, low bushes and flowers anywhere clear.
  const random = seeded(length * 7919);
  const clear = (x: number, z: number, gap: number) => path.every((p) => Math.hypot(p.x - x, p.z - z) > gap) && connectorSpots.every((p) => Math.hypot(p.x - x, p.z - z) > gap * 0.8);
  const inside = (x: number, z: number, pad: number) => x > bounds.minX - pad && x < bounds.maxX + pad && z > bounds.minZ - pad && z < bounds.maxZ + pad;
  let trees = 0;
  for (let tries = 0; tries < 400 && trees < 26; tries++) {
    const angle = random() * Math.PI * 2,
      r = radius * (0.62 + random() * 0.33);
    const x = cx + Math.cos(angle) * r,
      z = cz + Math.sin(angle) * r;
    // Nothing tall between the camera (+Z) and the board.
    if (inside(x, z, 1.6) || z > bounds.maxZ - 1 || !clear(x, z, 2.4)) continue;
    const h = 1.2 + random() * 1.1;
    add(new CylinderGeometry(0.11, 0.15, h * 0.45, 6).translate(x, h * 0.22, z), "#7a5b40");
    add(new ConeGeometry(0.75 + random() * 0.3, h * 0.8, 7).translate(x, h * 0.45 + h * 0.4, z), random() < 0.5 ? "#5f8f62" : "#6f9c6a");
    add(new ConeGeometry(0.55, h * 0.6, 7).translate(x, h * 0.95 + h * 0.3, z), "#77a874");
    trees++;
  }
  for (let i = 0; i < 70; i++) {
    const x = bounds.minX - 3 + random() * (bounds.maxX - bounds.minX + 6),
      z = bounds.minZ - 3 + random() * (bounds.maxZ - bounds.minZ + 6);
    if (!clear(x, z, 1.25) || Math.hypot(x - cx, z - cz) > radius - 1) continue;
    const kind = random();
    if (kind < 0.35) add(new IcosahedronGeometry(0.28 + random() * 0.15, 0).scale(1, 0.75, 1).translate(x, 0.2, z), PALETTE.grassDark);
    else if (kind < 0.55) add(new DodecahedronGeometry(0.22 + random() * 0.12, 0).scale(1, 0.6, 1).translate(x, 0.1, z), "#b8b2a2");
    else
      for (let f = 0; f < 3; f++)
        add(new IcosahedronGeometry(0.07, 0).translate(x + (random() - 0.5) * 0.5, 0.12, z + (random() - 0.5) * 0.5), ["#f2d16b", "#e98fa0", "#f6f0e3"][f]);
  }
  root.add(new Mesh(merge(land), material));

  // Numbers on every fifth square, words on the start.
  const labels: Mesh[] = [];
  path.forEach((pose, i) => {
    if ((!numberedSquare(i, length) && i !== 0) || special.has(i)) return;
    const text = floorText(i === 0 ? "BAŞLA" : String(i), i === 0 ? 1.3 : 0.95, i === 0 ? "#f6ecd3" : PALETTE.ink);
    text.position.set(pose.x, TILE_TOP + 0.012, pose.z);
    labels.push(text);
    root.add(text);
  });

  // Glyphs on the special squares; İleri and Geri point along the path.
  const glyphs = new Map<SpecialType, MeshBasicMaterial>();
  for (const [i, { type }] of special) {
    let glyph = glyphs.get(type);
    if (!glyph) glyphs.set(type, (glyph = new MeshBasicMaterial({ map: glyphTexture(type), transparent: true, depthWrite: false, toneMapped: false })));
    const mesh = new Mesh(new PlaneGeometry(SQUARE_SIZE * 0.72, SQUARE_SIZE * 0.72), glyph);
    mesh.rotation.order = "YXZ";
    mesh.rotation.set(-Math.PI / 2, SQUARE_STYLE[type].directional ? path[i].yaw - Math.PI : 0, 0);
    mesh.position.set(path[i].x, TILE_TOP + 0.012, path[i].z);
    mesh.renderOrder = 2;
    root.add(mesh);
  }

  // The treasure chest on the last square: base, gold bands, a lid that opens at the end.
  const end = path[length];
  const chest = new Group();
  chest.position.set(end.x, TILE_TOP, end.z - 0.42);
  // Front (lock) toward the camera side.
  chest.rotation.y = 0;
  const wood = new MeshStandardMaterial({ color: "#8a5a35", roughness: 0.8, flatShading: true });
  const gold = new MeshStandardMaterial({ color: "#f0c04d", roughness: 0.35, metalness: 0.35, emissive: "#6b4a10", emissiveIntensity: 0.25, flatShading: true });
  const base = new Mesh(new BoxGeometry(0.95, 0.5, 0.62), wood);
  base.position.y = 0.25;
  const bands = [-0.3, 0.3].map((x) => {
    const band = new Mesh(new BoxGeometry(0.08, 0.52, 0.66), gold);
    band.position.set(x, 0.25, 0);
    return band;
  });
  const coins = new Mesh(new CylinderGeometry(0.4, 0.42, 0.12, 12).scale(1, 1, 0.62), gold);
  coins.position.y = 0.48;
  const chestLid = new Group();
  chestLid.position.set(0, 0.5, -0.31);
  const lid = new Mesh(new CylinderGeometry(0.31, 0.31, 0.95, 10, 1, false, 0, Math.PI).rotateZ(Math.PI / 2), wood);
  lid.position.z = 0.31;
  const lidBand = new Mesh(new CylinderGeometry(0.325, 0.325, 0.09, 10, 1, false, 0, Math.PI).rotateZ(Math.PI / 2), gold);
  lidBand.position.z = 0.31;
  const lock = new Mesh(new BoxGeometry(0.16, 0.18, 0.06), gold);
  lock.position.set(0, -0.02, 0.63);
  chestLid.add(lid, lidBand, lock);
  chest.add(base, ...bands, coins, chestLid);
  root.add(chest);
  const sparkles = new Group();
  sparkles.position.set(end.x, TILE_TOP + 0.9, end.z - 0.42);
  const sparkle = new MeshBasicMaterial({ color: "#ffe38a", toneMapped: false });
  const sparkleGeometry = new OctahedronGeometry(0.07, 0);
  for (let i = 0; i < 6; i++) {
    const s = new Mesh(sparkleGeometry, sparkle);
    s.position.set(Math.cos((i / 6) * Math.PI * 2) * 0.75, (i % 3) * 0.18, Math.sin((i / 6) * Math.PI * 2) * 0.75);
    sparkles.add(s);
  }
  root.add(sparkles);

  // Current-turn ring.
  const ring = new Mesh(new RingGeometry(0.62, 0.78, 40), new MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 3;
  ring.visible = false;
  root.add(ring);

  // Two dice (the second only for "two dice") and the "+1" badge.
  const faces = dieMaterials();
  const dieGeometry = new RoundedBoxGeometry(0.62, 0.62, 0.62, 3, 0.09);
  const dice = [0, 1].map(() => {
    const die = new Mesh(dieGeometry, faces);
    die.visible = false;
    root.add(die);
    return die;
  });
  const plusTexture = canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = "#2f8f6f";
    ctx.beginPath();
    ctx.arc(64, 64, 58, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fbf6ea";
    ctx.font = "900 62px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("+1", 64, 68);
  });
  const plusOne = new Sprite(new SpriteMaterial({ map: plusTexture, depthTest: false, toneMapped: false, transparent: true }));
  plusOne.scale.setScalar(0.55);
  plusOne.visible = false;
  plusOne.renderOrder = 7;
  root.add(plusOne);
  // Bonus die: a small die with "+1", over a player who holds one and by the dice that use it.
  const bonusTexture = canvasTexture(160, 128, (ctx) => {
    ctx.fillStyle = SQUARE_STYLE.bonus.color;
    ctx.beginPath();
    ctx.roundRect(4, 4, 152, 120, 30);
    ctx.fill();
    ctx.save();
    ctx.translate(14, 34);
    ctx.scale(2.5, 2.5);
    ctx.strokeStyle = "#fffaf0";
    ctx.lineWidth = GLYPH_STROKE;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke(new Path2D(SQUARE_STYLE.bonus.glyph));
    ctx.restore();
    ctx.fillStyle = "#fffaf0";
    ctx.font = "900 50px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText("+1", 82, 68);
  });
  const bonusBadge = new SpriteMaterial({ map: bonusTexture, depthTest: false, toneMapped: false, transparent: true });
  const bonusPlus = new Sprite(bonusBadge);
  bonusPlus.scale.set(0.7, 0.56, 1);
  bonusPlus.visible = false;
  bonusPlus.renderOrder = 7;
  root.add(bonusPlus);

  return {
    root,
    path,
    bounds,
    bonusBadge,
    bonusPlus,
    ring,
    dice,
    plusOne,
    chestLid,
    sparkles,
    treasure: new Vector3(end.x, TILE_TOP, end.z),
    dispose() {
      root.traverse((object) => {
        if (object instanceof Mesh || object instanceof Sprite) {
          if (object instanceof Mesh && object.geometry !== dieGeometry && object.geometry !== sparkleGeometry) object.geometry.dispose();
        }
      });
      dieGeometry.dispose();
      sparkleGeometry.dispose();
      for (const m of faces) {
        m.map?.dispose();
        m.dispose();
      }
      for (const text of labels) {
        (text.material as MeshBasicMaterial).map?.dispose();
        (text.material as Material).dispose();
      }
      plusTexture.dispose();
      plusOne.material.dispose();
      bonusTexture.dispose();
      bonusBadge.dispose();
      for (const glyph of glyphs.values()) {
        glyph.map?.dispose();
        glyph.dispose();
      }
      [material, wood, gold, sparkle, ring.material as Material].forEach((m) => m.dispose());
    },
  };
}
