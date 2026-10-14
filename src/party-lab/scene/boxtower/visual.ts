import {
  BoxGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  EdgesGeometry,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Material,
  type Texture,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { BOX_TOWER as T } from "../../../../shared/party-lab/simulation/boxtower/config";
import { PARTS, SHAPES } from "../ragdoll/config";
import { createCharacterVisual } from "../visual/characterVisual";
import { YARD, columnX, levelY, rowBounds, yardX } from "./layout";
import type { TowerFrame, TowerLook, YardView } from "./source";

const PALETTE = {
  skyTop: "#8fc3e8",
  skyLow: "#f3e2c4",
  hills: ["#a7cfa0", "#8fbf88"],
  ground: "#7fae5b",
  groundEdge: "#5f8a43",
  stone: "#cfc4b2",
  stoneDark: "#a99d8a",
  wall: "#f6f1e7",
  line: "#2b2b2b",
};
/** Effects after a box lands, ms: the yard shakes, the box squashes, dust puffs. */
const SHAKE_MS = 260;
const SQUASH_MS = 200;
const PUFF_MS = 320;
/** Character reactions, ms. */
const CHEER_MS = 900;
const SAD_MS = 1000;

/** Small deterministic noise (the same on every screen). */
const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};
function canvasTexture(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx) draw(ctx);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
/** A shipping crate face: light planks, a darker frame and a brace (tinted by the material colour). */
function crateTexture() {
  return canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = "#f4f1ea";
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = "#e3ddd2";
    for (let y = 0; y < 128; y += 32) ctx.fillRect(0, y + 30, 128, 2);
    ctx.strokeStyle = "#b9b0a2";
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(18, 110);
    ctx.lineTo(110, 18);
    ctx.stroke();
    ctx.strokeStyle = "#8f8676";
    ctx.lineWidth = 14;
    ctx.strokeRect(7, 7, 114, 114);
    ctx.fillStyle = "#6f6759";
    for (const [x, y] of [[14, 14], [114, 14], [14, 114], [114, 114]]) {
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}
/** The yard's back wall: faint column bands and level ticks every box. */
function wallTexture() {
  const W = T.columns * 64,
    H = Math.round(YARD.wallTop * 64);
  return canvasTexture(W, H, (ctx) => {
    ctx.fillStyle = PALETTE.wall;
    ctx.fillRect(0, 0, W, H);
    for (let c = 0; c < T.columns; c++) {
      ctx.fillStyle = c % 2 ? "rgba(0,0,0,0.035)" : "rgba(255,255,255,0.05)";
      ctx.fillRect(c * 64, 0, 64, H);
    }
    ctx.fillStyle = "rgba(0,0,0,0.07)";
    for (let level = 1; level < YARD.wallTop; level++) {
      const y = H - level * 64;
      for (let c = 0; c < T.columns; c++) ctx.fillRect(c * 64 + 26, y - 1, 12, 2);
    }
  });
}
/** A chequered finish band. */
function finishTexture() {
  return canvasTexture(T.columns * 32, 16, (ctx) => {
    for (let x = 0; x < T.columns * 4; x++)
      for (let y = 0; y < 2; y++) {
        ctx.fillStyle = (x + y) % 2 ? "#1f1f1f" : "#fbfbfb";
        ctx.fillRect(x * 8, y * 8, 8, 8);
      }
  });
}
/** Sky backdrop: a soft vertical gradient with two rows of hills. */
function skyTexture() {
  return canvasTexture(64, 256, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, PALETTE.skyTop);
    g.addColorStop(0.75, PALETTE.skyLow);
    g.addColorStop(1, PALETTE.skyLow);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 256);
  });
}

/** A box's outline (the ghost where the sliding box would land). */
function edges(size: number) {
  const box = new BoxGeometry(size, size, size),
    lines = new EdgesGeometry(box);
  box.dispose();
  return lines;
}

/** The yard's stone base: the ground's top is this far below the yard's floor (y = 0). */
const GROUND = 0.3;
/** The character's poses: every part's place (feet on the ground) and its tilt about z. */
const FEET = 0.79;
type Pose = { x: number; y: number; z: number; rz: number }[];
const REST: Pose = PARTS.map((part) => ({ x: SHAPES[part].x, y: SHAPES[part].y + FEET, z: 0, rz: 0 }));
const HEAD = PARTS.indexOf("head");
const posed = (changes: Partial<Record<(typeof PARTS)[number], Partial<Pose[number]>>>): Pose => PARTS.map((part, i) => ({ ...REST[i], ...changes[part] }));
const POSES = {
  rest: REST,
  /** Arms up and out (the jump is added on top). */
  cheer: posed({
    head: { y: SHAPES.head.y + FEET + 0.04 },
    leftUpper: { x: -0.52, y: 0.7 + FEET, rz: 0.46 },
    rightUpper: { x: 0.52, y: 0.7 + FEET, rz: -0.46 },
    leftHand: { x: -0.7, y: 1.1 + FEET, z: 0.05, rz: 0.46 },
    rightHand: { x: 0.7, y: 1.1 + FEET, z: 0.05, rz: -0.46 },
  }),
  /** Head down, shoulders in, arms hanging. */
  sad: posed({
    head: { y: SHAPES.head.y + FEET - 0.16, z: 0.12 },
    torso: { y: SHAPES.torso.y + FEET - 0.06, z: 0.05 },
    leftUpper: { x: -0.4, y: SHAPES.leftUpper.y + FEET - 0.06, z: 0.05, rz: 0.15 },
    rightUpper: { x: 0.4, y: SHAPES.rightUpper.y + FEET - 0.06, z: 0.05, rz: -0.15 },
    leftHand: { x: -0.34, y: SHAPES.leftHand.y + FEET - 0.08, z: 0.1, rz: 0.15 },
    rightHand: { x: 0.34, y: SHAPES.rightHand.y + FEET - 0.08, z: 0.1, rz: -0.15 },
  }),
} as const;

/**
 * Kutu Kulesi scenery: a row of yards (one per player, theirs lit up), each with a back wall,
 * a finish band at `goal`, the column under the sliding box lit and a ghost box where it would
 * land, the boxes in the player's colour, and the player's character beside it reacting to
 * every box. `update` draws a frame from `yardViews` (source.ts); the view decides nothing.
 */
export function towerVisual(looks: readonly TowerLook[], self: number) {
  const count = looks.length,
    root = new Group(),
    owned: BufferGeometry[] = [],
    materials: Material[] = [],
    textures: Texture[] = [];
  const own = <G extends BufferGeometry>(g: G) => (owned.push(g), g);
  const mat = <M extends Material>(m: M) => (materials.push(m), m);
  const tex = <X extends Texture>(t: X) => (textures.push(t), t);

  // Backdrop and ground.
  const bounds = rowBounds(count),
    width = bounds.maxX - bounds.minX;
  const sky = new Mesh(own(new PlaneGeometry(width * 4, 60)), mat(new MeshBasicMaterial({ map: tex(skyTexture()), depthWrite: false })));
  sky.position.set((bounds.minX + bounds.maxX) / 2, 16, -30);
  root.add(sky);
  PALETTE.hills.forEach((color, row) => {
    const hillGeometry = own(new SphereGeometry(1, 24, 12));
    const hillMaterial = mat(new MeshStandardMaterial({ color, roughness: 1, flatShading: true }));
    for (let i = 0; i < 7; i++) {
      const hill = new Mesh(hillGeometry, hillMaterial);
      const r = 9 + hash(i * 3 + row * 11) * 7;
      hill.scale.set(r * 1.6, r * 0.55, r * 0.5);
      hill.position.set(bounds.minX - 20 + i * ((width + 40) / 6) + hash(i + row) * 6, -2 - row * 0.5, -22 + row * 5);
      root.add(hill);
    }
  });
  const ground = new Mesh(own(new BoxGeometry(width + 60, 1, 14)), mat(new MeshStandardMaterial({ color: PALETTE.ground, roughness: 1 })));
  ground.position.set((bounds.minX + bounds.maxX) / 2, -0.5 - GROUND, -2);
  root.add(ground);

  // Shared pieces.
  const crate = tex(crateTexture()),
    boxGeometry = own(new RoundedBoxGeometry(YARD.box, YARD.box, YARD.box, 2, 0.06)),
    wallGeometry = own(new PlaneGeometry(T.columns + 0.2, YARD.wallTop)),
    wallMap = tex(wallTexture()),
    finishMap = tex(finishTexture()),
    finishGeometry = own(new PlaneGeometry(T.columns + 0.2, 0.2)),
    postGeometry = own(new BoxGeometry(0.16, YARD.wallTop + 0.2, 0.16)),
    baseGeometry = own(new BoxGeometry(T.columns + 0.5, GROUND, 1.7)),
    stripGeometry = own(new PlaneGeometry(0.98, 1)),
    ghostGeometry = own(edges(YARD.box)),
    puffGeometry = own(new SphereGeometry(0.22, 10, 6)),
    stone = mat(new MeshStandardMaterial({ color: PALETTE.stone, roughness: 0.9 })),
    finishMaterial = mat(new MeshBasicMaterial({ map: finishMap })),
    puffMaterial = mat(new MeshBasicMaterial({ color: "#efe7da", transparent: true, opacity: 0.55, depthWrite: false })),
    railGeometry = own(new PlaneGeometry(0.06, 1));

  const people: { dispose(): void }[] = [];
  const matrix = new Matrix4(),
    quaternion = new Quaternion(),
    scale = new Vector3(),
    at = new Vector3();
  const yards = looks.map((look, lane) => {
    const tint = new Color(look.color),
      mine = lane === self;
    const group = new Group();
    root.add(group);
    const cx = yardX(lane, count);
    // Stone base and the back wall in a light wash of the player's colour (brighter for this player).
    const base = new Mesh(baseGeometry, stone);
    base.position.set(cx, -GROUND / 2, 0);
    const trim = new Mesh(own(new BoxGeometry(T.columns + 0.56, 0.08, 1.76)), mat(new MeshStandardMaterial({ color: tint, roughness: 0.6 })));
    trim.position.set(cx, -0.04, 0);
    const wall = new Mesh(wallGeometry, mat(new MeshStandardMaterial({ map: wallMap, color: new Color(PALETTE.wall).lerp(tint, mine ? 0.32 : 0.16), roughness: 0.95, emissive: mine ? tint : new Color(0), emissiveIntensity: mine ? 0.12 : 0 })));
    wall.position.set(cx, YARD.wallTop / 2, -0.65);
    const frameMaterial = mat(new MeshStandardMaterial({ color: mine ? tint : new Color(PALETTE.stoneDark), roughness: 0.6, emissive: mine ? tint : new Color(0), emissiveIntensity: mine ? 0.25 : 0 }));
    const posts = [-1, 1].map((side) => {
      const post = new Mesh(postGeometry, frameMaterial);
      post.position.set(cx + side * (T.columns / 2 + 0.18), (YARD.wallTop + 0.2) / 2, -0.55);
      return post;
    });
    const top = new Mesh(own(new BoxGeometry(T.columns + 0.52, 0.16, 0.16)), frameMaterial);
    top.position.set(cx, YARD.wallTop + 0.12, -0.55);
    const finish = new Mesh(finishGeometry, finishMaterial);
    finish.position.set(cx, T.goal, -0.6);
    const flagMaterial = mat(new MeshStandardMaterial({ color: tint, roughness: 0.5, side: DoubleSide }));
    const flags = [-1, 1].map((side) => {
      const flag = new Mesh(own(new PlaneGeometry(0.5, 0.32)), flagMaterial);
      flag.position.set(cx + side * (T.columns / 2 + 0.43), T.goal + 0.02, -0.5);
      return flag;
    });
    group.add(base, trim, wall, ...posts, top, finish, ...flags);
    // The column under the sliding box, lit from the ground up to the box, and where it would land.
    // The lit column: a wash of the player's colour between two solid rails.
    const strip = new Mesh(stripGeometry, mat(new MeshBasicMaterial({ color: tint, transparent: true, opacity: mine ? 0.34 : 0.22, depthWrite: false })));
    const rail = mat(new MeshBasicMaterial({ color: new Color(look.color).multiplyScalar(0.8), transparent: true, opacity: 0.9 }));
    for (const side of [-1, 1]) {
      const r = new Mesh(railGeometry, rail);
      r.position.set((side * 0.98) / 2, 0, 0.01);
      strip.add(r);
    }
    strip.visible = false;
    const ghost = new Group(),
      outline = new LineSegments(ghostGeometry, mat(new LineBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.85 })));
    ghost.add(new Mesh(boxGeometry, mat(new MeshBasicMaterial({ color: tint, transparent: true, opacity: mine ? 0.34 : 0.26, depthWrite: false }))), outline);
    ghost.visible = false;
    group.add(strip, ghost);
    // Boxes: every standing box (instanced) and the one sliding or falling.
    const boxMaterial = mat(new MeshStandardMaterial({ map: crate, color: tint, roughness: 0.72 }));
    const boxes = new InstancedMesh(boxGeometry, boxMaterial, T.columns * (T.goal + 1));
    boxes.count = 0;
    boxes.frustumCulled = false;
    const active = new Mesh(boxGeometry, mat(new MeshStandardMaterial({ map: crate, color: tint, roughness: 0.6, emissive: tint, emissiveIntensity: 0.18 })));
    active.visible = false;
    group.add(boxes, active);
    const puffs = [0, 1, 2].map(() => {
      const puff = new Mesh(puffGeometry, puffMaterial);
      puff.visible = false;
      group.add(puff);
      return puff;
    });
    // The character on the left of the yard (on the ground), turned a little toward it.
    const person = createCharacterVisual(look.color, look.costume);
    people.push(person);
    REST.forEach((p, index) => person.root.children[index].position.set(p.x, p.y, p.z));
    person.root.scale.setScalar(YARD.personScale);
    person.root.position.set(cx - T.columns / 2 - YARD.personX, -GROUND, 0.1);
    person.root.rotation.y = 0.45;
    root.add(person.root);
    return { cx, group, strip, ghost, outline, boxes, active, puffs, person: person.root, bob: hash(lane * 7) * 6 };
  });

  let clock = 0;
  const target = new Vector3();
  return {
    root,
    /** Draws `views` (one per lane, from `yardViews`) at the frame's moment; `dt` (s) drives idle motion. */
    update(frame: TowerFrame, views: readonly YardView[], dt: number) {
      clock += dt;
      const t = frame.now,
        wire = frame.wire,
        ease = Math.min(1, dt * 14);
      yards.forEach((y, lane) => {
        const v = views[lane];
        if (!v) return;
        const out = wire.out[lane];
        const sinceLand = v.landed ? t - v.landed.land : Infinity;
        // Shake: a short jolt when a box lands.
        if (sinceLand >= 0 && sinceLand < SHAKE_MS) {
          const shake = Math.exp(-sinceLand / 70) * 0.07;
          y.group.position.set(shake * Math.sin(sinceLand * 0.11), -shake * 0.6 * Math.abs(Math.sin(sinceLand * 0.08)), 0);
        } else y.group.position.set(0, 0, 0);
        // Standing boxes; the newest squashes as it lands.
        let n = 0;
        v.heights.forEach((height, column) => {
          for (let level = 0; level < height && n < y.boxes.instanceMatrix.count; level++) {
            const newest = v.landed && v.landed.column === column && level === height - 1 && sinceLand >= 0 && sinceLand < SQUASH_MS;
            const k = newest ? sinceLand / SQUASH_MS : 1,
              squash = newest ? 1 - 0.2 * Math.sin(Math.PI * k) * (1 - k * 0.5) : 1;
            at.set(columnX(lane, count, column), levelY(level) - (1 - squash) * 0.46, 0);
            scale.set(2 - squash, squash, 2 - squash);
            quaternion.identity();
            matrix.compose(at, quaternion, scale);
            y.boxes.setMatrixAt(n++, matrix);
          }
        });
        y.boxes.count = n;
        y.boxes.instanceMatrix.needsUpdate = true;
        // The moving box: sliding along the top, or falling into its column.
        y.active.visible = !out && (!!v.slider || !!v.falling);
        y.strip.visible = y.ghost.visible = false;
        if (v.slider && !out) {
          const pop = Math.min(1, v.slider.age / 120);
          y.active.position.set(columnX(lane, count, v.slider.x), YARD.hoverY + (1 - pop) * 0.35, 0);
          y.active.scale.setScalar(0.4 + 0.6 * pop);
          const h = v.heights[v.slider.column] ?? 0;
          y.strip.visible = y.ghost.visible = true;
          y.strip.position.set(columnX(lane, count, v.slider.column), YARD.hoverY / 2, -0.6);
          y.strip.scale.y = YARD.hoverY;
          y.ghost.position.set(columnX(lane, count, v.slider.column), levelY(h), 0);
          (y.outline.material as LineBasicMaterial).opacity = 0.55 + 0.35 * Math.sin(clock * 8);
        } else if (v.falling && !out) {
          const h = v.heights[v.falling.column] ?? 0,
            p = v.falling.progress;
          y.active.position.set(columnX(lane, count, v.falling.column), YARD.hoverY - (YARD.hoverY - levelY(h)) * p * p, 0);
          y.active.scale.setScalar(1);
        }
        // Dust from both sides of a landing box.
        y.puffs.forEach((puff, i) => {
          const live = !!v.landed && sinceLand >= 0 && sinceLand < PUFF_MS;
          puff.visible = live;
          if (!live || !v.landed) return;
          const k = sinceLand / PUFF_MS,
            h = (v.heights[v.landed.column] ?? 1) - 1,
            side = i === 0 ? -1 : i === 1 ? 1 : 0;
          puff.position.set(columnX(lane, count, v.landed.column) + side * (0.45 + k * 0.5), levelY(h) - 0.42 + k * 0.25, side === 0 ? 0.5 + k * 0.3 : 0.3);
          puff.scale.set(0.5 + k * 0.9, 0.35 + k * 0.5, 0.5 + k * 0.9);
        });
        // The character: cheers when the tower grows, droops at a miss; at the end, the winner jumps.
        const person = y.person,
          ended = wire.phase === "results",
          won = ended && frame.winner === lane,
          cheer = won || (!ended && !!v.landed?.good && sinceLand >= 0 && sinceLand < CHEER_MS),
          sad = (ended && frame.winner !== lane) || (!ended && !!v.landed && !v.landed.good && sinceLand >= 0 && sinceLand < SAD_MS);
        const base = y.cx - T.columns / 2 - YARD.personX;
        let lift = Math.sin(clock * 2.2 + y.bob) * 0.015,
          pose = POSES.rest;
        if (cheer) {
          const k = won ? (clock * 1.6) % 1 : Math.min(1, sinceLand / 500);
          lift = Math.max(0, Math.sin(Math.PI * k)) * 0.55;
          pose = POSES.cheer;
        } else if (sad) pose = POSES.sad;
        const shakeHead = sad && !ended ? Math.sin(clock * 15) * 0.06 * Math.max(0, 1 - sinceLand / SAD_MS) : 0;
        pose.forEach((p, index) => {
          const part = person.children[index];
          part.position.lerp(target.set(p.x + (index === HEAD ? shakeHead : 0), p.y, p.z), ease);
          part.rotation.z += (p.rz - part.rotation.z) * ease;
        });
        person.position.set(base, lift - GROUND, 0.1);
        person.visible = !out;
      });
    },
    dispose() {
      people.forEach((person) => person.dispose());
      owned.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
    },
  };
}
export type TowerVisual = ReturnType<typeof towerVisual>;
