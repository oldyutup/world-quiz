import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  RepeatWrapping,
  SphereGeometry,
  SRGBColorSpace,
  TubeGeometry,
  CatmullRomCurve3,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
  type Texture,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { BOMB } from "../../../../shared/party-lab/simulation/marksman/waves";
import { PARTS, SHAPES } from "../ragdoll/config";
import { createCharacterVisual } from "../visual/characterVisual";
import { GALLERY as G, galleryBounds, laneX, slotPoint } from "./layout";
import { LOWER_MS, type LaneView, type MarksmanFrame, type MarksmanLook } from "./source";

const PALETTE = {
  wall: "#24464f",
  wallStripe: "#2c5560",
  planks: "#b07f52",
  plankLine: "#8c6038",
  range: "#c8b083",
  counter: "#8a5a34",
  counterTop: "#a8713f",
  cover: "#f1e6cf",
  awning: ["#d9473a", "#f6ecd8"],
  bulb: "#ffe7a3",
  post: "#6d4c33",
  bomb: "#25252c",
  fuse: "#c9a46a",
  spark: "#ffb347",
};
/** Target motion, ms: rising out of the cover, tipping back when hit, an explosion, the shot's flash. */
const RISE_MS = 130;
const TIP_MS = 170;
const BLAST_MS = 480;
const FLASH_MS = 90;
const CHEER_MS = 700;
/** A knock-out: the big blast, the fall, the lane going dark, ms. */
const BOOM_MS = 950;
const FALL_MS = 520;
const DARK_MS = 600;

/** Small deterministic noise. */
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
/** A target face: rings in the player's colour around a gold bull's-eye. */
function targetTexture(color: string) {
  return canvasTexture(256, 256, (ctx) => {
    const rings = ["#fbf6ea", color, "#fbf6ea", color, "#fbf6ea", "#f2b631"];
    rings.forEach((fill, i) => {
      ctx.beginPath();
      ctx.arc(128, 128, 128 - i * 20.5, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
    });
    ctx.beginPath();
    ctx.arc(128, 128, 9, 0, Math.PI * 2);
    ctx.fillStyle = "#c2412f";
    ctx.fill();
    ctx.strokeStyle = "rgba(40,30,20,0.35)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(128, 128, 125, 0, Math.PI * 2);
    ctx.stroke();
  });
}
/** Vertical stripes for the back wall, and planks for the floor. */
function stripeTexture(a: string, b: string, stripes: number) {
  const t = canvasTexture(stripes * 32, 8, (ctx) => {
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 ? b : a;
      ctx.fillRect(i * 32, 0, 32, 8);
    }
  });
  return t;
}
function plankTexture() {
  const t = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = PALETTE.planks;
    ctx.fillRect(0, 0, 256, 256);
    for (let row = 0; row < 8; row++) {
      ctx.fillStyle = `rgba(0,0,0,${0.03 + hash(row) * 0.06})`;
      ctx.fillRect(0, row * 32, 256, 32);
      ctx.fillStyle = PALETTE.plankLine;
      ctx.fillRect(0, row * 32 + 30, 256, 2);
      const seam = Math.floor(hash(row * 5 + 1) * 256);
      ctx.fillRect(seam, row * 32, 2, 32);
    }
  });
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}
/** The awning's scalloped valance: red and cream stripes. */
function awningTexture() {
  return canvasTexture(512, 64, (ctx) => {
    for (let i = 0; i < 16; i++) {
      ctx.fillStyle = PALETTE.awning[i % 2];
      ctx.fillRect(i * 32, 0, 32, 40);
      ctx.beginPath();
      ctx.arc(i * 32 + 16, 40, 16, 0, Math.PI);
      ctx.fill();
    }
  });
}

/** The character's poses (parts' places with the feet on the floor, facing +z before the turn). */
const FEET = 0.79;
type Pose = { x: number; y: number; z: number; rx: number; rz: number }[];
const REST: Pose = PARTS.map((part) => ({ x: SHAPES[part].x, y: SHAPES[part].y + FEET, z: 0, rx: 0, rz: 0 }));
const HEAD = PARTS.indexOf("head");
const posed = (changes: Partial<Record<(typeof PARTS)[number], Partial<Pose[number]>>>): Pose => PARTS.map((part, i) => ({ ...REST[i], ...changes[part] }));
const POSES = {
  /** Both hands forward on the blaster. */
  aim: posed({
    rightUpper: { x: 0.36, y: 0.46 + FEET, z: 0.16, rx: 1.25, rz: -0.12 },
    rightHand: { x: 0.24, y: 0.47 + FEET, z: 0.5, rx: Math.PI / 2 },
    leftUpper: { x: -0.36, y: 0.46 + FEET, z: 0.16, rx: 1.25, rz: 0.3 },
    leftHand: { x: -0.02, y: 0.45 + FEET, z: 0.52, rx: Math.PI / 2 },
  }),
  /** Arms up and out. */
  cheer: posed({
    head: { y: SHAPES.head.y + FEET + 0.04 },
    leftUpper: { x: -0.52, y: 0.7 + FEET, rz: 0.46 },
    rightUpper: { x: 0.52, y: 0.7 + FEET, rz: -0.46 },
    leftHand: { x: -0.7, y: 1.1 + FEET, z: 0.05, rz: 0.46 },
    rightHand: { x: 0.7, y: 1.1 + FEET, z: 0.05, rz: -0.46 },
  }),
  /** Head down, arms hanging. */
  sad: posed({
    head: { y: SHAPES.head.y + FEET - 0.16, z: 0.12 },
    torso: { y: SHAPES.torso.y + FEET - 0.06, z: 0.05 },
    leftHand: { x: -0.34, y: SHAPES.leftHand.y + FEET - 0.08, z: 0.1, rz: 0.15 },
    rightHand: { x: 0.34, y: SHAPES.rightHand.y + FEET - 0.08, z: 0.1, rz: -0.15 },
  }),
} as const;
/** The blaster's muzzle in the character's own frame (before its scale). */
const MUZZLE = new Vector3(0.12, 0.52 + FEET, 0.98);

const UP = new Vector3(0, 1, 0);
/** Points a unit cylinder (y from 0 to 1) from `from` to `to`, `radius` wide. */
function beam(mesh: Object3D, from: Vector3, to: Vector3, radius: number) {
  const dir = new Vector3().subVectors(to, from),
    length = dir.length();
  mesh.position.copy(from);
  mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
  mesh.scale.set(radius, length, radius);
}
/** Back-out ease: overshoots a little and settles. */
const backOut = (k: number) => {
  const c = 1.9;
  return 1 + (c + 1) * (k - 1) ** 3 + c * (k - 1) ** 2;
};

/**
 * Nişancı scenery: a shooting gallery booth. The players stand in a row behind one counter,
 * seen from behind; straight ahead of each are their three slots on a panel in their colour.
 * Targets and bombs pop up out of the cover board, tip back when hit, and a hit bomb blows up.
 * Each player's laser shows their aim; a stunned player wobbles under circling stars; a knocked
 * out player goes down in a big blast and their stretch of the gallery goes dark.
 * `update` draws a frame from `laneViews` (source.ts); the view decides nothing.
 */
export function marksmanVisual(looks: readonly MarksmanLook[], self: number) {
  const count = looks.length,
    root = new Group(),
    owned: BufferGeometry[] = [],
    materials: Material[] = [],
    textures: Texture[] = [];
  const own = <T extends BufferGeometry>(g: T) => (owned.push(g), g);
  const mat = <T extends Material>(m: T) => (materials.push(m), m);
  const tex = <T extends Texture>(t: T) => (textures.push(t), t);

  // The booth: floor, range, back wall with an awning and bulbs, the cover board and the counter.
  const b = galleryBounds(count),
    width = count * G.pitch + 4;
  const planks = tex(plankTexture());
  planks.repeat.set(width / 3, 2);
  const floor = new Mesh(own(new PlaneGeometry(width + 30, 14)), mat(new MeshStandardMaterial({ map: planks, roughness: 0.9 })));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, 4.5);
  const range = new Mesh(own(new PlaneGeometry(width, -G.targetZ + 1.5)), mat(new MeshStandardMaterial({ color: PALETTE.range, roughness: 1 })));
  range.rotation.x = -Math.PI / 2;
  range.position.set(0, -0.01, (G.targetZ - 2.4) / 2);
  const stripes = tex(stripeTexture(PALETTE.wall, PALETTE.wallStripe, Math.round(width)));
  const wall = new Mesh(own(new PlaneGeometry(width, 5.4)), mat(new MeshStandardMaterial({ map: stripes, roughness: 0.95 })));
  wall.position.set(0, 2.7, G.targetZ - 1.2);
  const awning = new Mesh(own(new PlaneGeometry(width, 0.75)), mat(new MeshStandardMaterial({ map: tex(awningTexture()), roughness: 0.8, transparent: true, alphaTest: 0.5 })));
  (awning.material as MeshStandardMaterial).map!.wrapS = RepeatWrapping;
  (awning.material as MeshStandardMaterial).map!.repeat.set(width / 8, 1);
  awning.position.set(0, b.far.maxY + 0.42, G.targetZ - 1.1);
  const bulbGeometry = own(new SphereGeometry(0.075, 10, 8)),
    bulbMaterial = mat(new MeshBasicMaterial({ color: PALETTE.bulb }));
  const bulbs: Mesh[] = [];
  for (let x = -width / 2 + 0.5; x < width / 2; x += 0.7) {
    const bulb = new Mesh(bulbGeometry, bulbMaterial);
    bulb.position.set(x, b.far.maxY + 0.02, G.targetZ - 1.0);
    bulbs.push(bulb);
  }
  const counter = new Mesh(own(new BoxGeometry(width - 1, G.counterY - 0.08, G.counterDepth)), mat(new MeshStandardMaterial({ color: PALETTE.counter, roughness: 0.75 })));
  counter.position.set(0, (G.counterY - 0.08) / 2, G.counterZ - G.counterDepth / 2);
  const counterTop = new Mesh(own(new RoundedBoxGeometry(width - 0.8, 0.1, G.counterDepth + 0.14, 2, 0.04)), mat(new MeshStandardMaterial({ color: PALETTE.counterTop, roughness: 0.6 })));
  counterTop.position.set(0, G.counterY - 0.04, G.counterZ - G.counterDepth / 2);
  root.add(floor, range, wall, awning, ...bulbs, counter, counterTop);

  const shared = {
    disc: own(new CylinderGeometry(G.radius, G.radius, 0.08, 40)),
    post: own(new BoxGeometry(0.09, 1, 0.07)),
    bomb: own(new SphereGeometry(G.bomb, 28, 18)),
    cap: own(new CylinderGeometry(0.12, 0.14, 0.12, 14)),
    fuse: own(new TubeGeometry(new CatmullRomCurve3([new Vector3(0, 0, 0), new Vector3(0.05, 0.12, 0.02), new Vector3(0.14, 0.2, 0.04), new Vector3(0.22, 0.2, 0.05)]), 12, 0.022, 6)),
    spark: own(new SphereGeometry(0.06, 10, 8)),
    glow: own(new SphereGeometry(1, 16, 10)),
    beam: own(new CylinderGeometry(1, 1, 1, 8, 1, true).translate(0, 0.5, 0)),
    dot: own(new SphereGeometry(0.07, 12, 8)),
    star: own(new OctahedronGeometry(0.09)),
    debris: own(new BoxGeometry(0.08, 0.08, 0.08)),
    coverBoard: own(new BoxGeometry(G.pitch - 0.08, G.coverY, 0.16)),
    panel: own(new RoundedBoxGeometry(G.pitch - 0.5, 2.55, 0.1, 3, 0.12)),
    gun: own(new RoundedBoxGeometry(0.14, 0.17, 0.42, 2, 0.04)),
    barrel: own(new CylinderGeometry(0.045, 0.05, 0.26, 12)),
  };
  shared.barrel.rotateX(Math.PI / 2);
  const post = mat(new MeshStandardMaterial({ color: PALETTE.post, roughness: 0.8 })),
    discEdge = mat(new MeshStandardMaterial({ color: "#d9c39b", roughness: 0.7 })),
    bombMaterial = mat(new MeshStandardMaterial({ color: PALETTE.bomb, roughness: 0.32, metalness: 0.25 })),
    capMaterial = mat(new MeshStandardMaterial({ color: "#55565e", roughness: 0.5, metalness: 0.4 })),
    fuseMaterial = mat(new MeshStandardMaterial({ color: PALETTE.fuse, roughness: 0.9 })),
    sparkMaterial = mat(new MeshBasicMaterial({ color: PALETTE.spark })),
    sparkGlow = mat(new MeshBasicMaterial({ color: "#ffcf6e", transparent: true, opacity: 0.45, blending: AdditiveBlending, depthWrite: false })),
    blastMaterial = mat(new MeshBasicMaterial({ color: "#ffb347", transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false })),
    blastCore = mat(new MeshBasicMaterial({ color: "#fff2c4", transparent: true, opacity: 1, blending: AdditiveBlending, depthWrite: false })),
    debrisMaterial = mat(new MeshStandardMaterial({ color: "#2d2a2a", roughness: 0.8 })),
    starMaterial = mat(new MeshBasicMaterial({ color: "#ffd84a" })),
    gunMaterial = mat(new MeshStandardMaterial({ color: "#3a3d47", roughness: 0.4, metalness: 0.3 })),
    flashMaterial = mat(new MeshBasicMaterial({ color: "#fff1b0", transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false }));

  const people: { dispose(): void }[] = [];
  const lanes = looks.map((look, lane) => {
    const tint = new Color(look.color),
      mine = lane === self,
      cx = laneX(lane, count);
    // The lane's panel on the back wall (its colour washed in) and its stretch of the cover.
    const panelMaterial = mat(new MeshStandardMaterial({ color: new Color(PALETTE.wall).lerp(tint, mine ? 0.42 : 0.28), roughness: 0.9, emissive: mine ? tint : new Color(0), emissiveIntensity: mine ? 0.08 : 0 }));
    const panel = new Mesh(shared.panel, panelMaterial);
    panel.position.set(cx, G.targetY + 0.15, G.targetZ - 0.95);
    const coverMaterial = mat(new MeshStandardMaterial({ color: new Color(PALETTE.cover).lerp(tint, 0.55), roughness: 0.8 }));
    const cover = new Mesh(shared.coverBoard, coverMaterial);
    cover.position.set(cx, G.coverY / 2, G.targetZ + 0.45);
    const trim = new Mesh(own(new BoxGeometry(G.pitch - 0.08, 0.08, 0.2)), mat(new MeshStandardMaterial({ color: new Color(look.color).multiplyScalar(0.7), roughness: 0.6 })));
    trim.position.set(cx, G.coverY, G.targetZ + 0.45);
    root.add(panel, cover, trim);

    // Three slots, each with a target and a bomb on a pivot at the cover's top.
    const face = mat(new MeshStandardMaterial({ map: tex(targetTexture(look.color)), roughness: 0.65 }));
    const slots = [0, 1, 2].map((slot) => {
      const p = slotPoint(lane, count, slot),
        rise = G.targetY - G.coverY;
      const pivot = new Group();
      pivot.position.set(p.x, G.coverY, p.z);
      const target = new Group();
      const disc = new Mesh(shared.disc, [discEdge, face, discEdge]);
      disc.rotation.x = Math.PI / 2;
      disc.position.y = rise;
      const stick = new Mesh(shared.post, post);
      stick.scale.y = rise;
      stick.position.set(0, rise / 2 - 0.05, -0.06);
      target.add(disc, stick);
      const bomb = new Group();
      const ball = new Mesh(shared.bomb, bombMaterial);
      ball.position.y = rise - 0.05;
      const cap = new Mesh(shared.cap, capMaterial);
      cap.position.set(0, rise - 0.05 + G.bomb * 0.92, 0);
      const fuse = new Mesh(shared.fuse, fuseMaterial);
      fuse.position.set(0, rise - 0.05 + G.bomb + 0.03, 0);
      const spark = new Mesh(shared.spark, sparkMaterial);
      spark.position.set(0.22, rise + G.bomb + 0.18, 0.05);
      const glow = new Mesh(shared.glow, sparkGlow);
      glow.position.copy(spark.position);
      const bombStick = new Mesh(shared.post, post);
      bombStick.scale.y = rise - G.bomb;
      bombStick.position.set(0, (rise - G.bomb) / 2 - 0.05, 0);
      bomb.add(ball, cap, fuse, spark, glow, bombStick);
      pivot.add(target, bomb);
      // The explosion (at the bomb's place, not on the pivot: it stays up while the bomb is gone).
      const blast = new Group();
      blast.position.set(p.x, p.y - 0.05, p.z + 0.1);
      const fire = new Mesh(shared.glow, blastMaterial.clone());
      const core = new Mesh(shared.glow, blastCore.clone());
      materials.push(fire.material as Material, core.material as Material);
      const bits = Array.from({ length: 7 }, (_, i) => {
        const bit = new Mesh(shared.debris, debrisMaterial);
        bit.userData.dir = new Vector3(Math.cos((i / 7) * Math.PI * 2 + 0.4), 0.6 + hash(i + lane * 3 + slot) * 0.9, 0.3 + hash(i * 7 + slot) * 0.5);
        return bit;
      });
      blast.add(fire, core, ...bits);
      blast.visible = false;
      root.add(pivot, blast);
      return { pivot, target, bomb, spark, glow, blast, fire, core, bits };
    });

    // The character, its blaster, its laser and the stun stars.
    const person = createCharacterVisual(look.color, look.costume);
    people.push(person);
    REST.forEach((p, index) => person.root.children[index].position.set(p.x, p.y, p.z));
    const gun = new Group();
    const gunBody = new Mesh(shared.gun, gunMaterial);
    const stripe = new Mesh(own(new BoxGeometry(0.15, 0.05, 0.3)), mat(new MeshStandardMaterial({ color: tint, roughness: 0.5, emissive: tint, emissiveIntensity: 0.3 })));
    stripe.position.set(0, 0.07, 0);
    const barrel = new Mesh(shared.barrel, gunMaterial);
    barrel.position.set(0, 0.02, 0.32);
    const flash = new Mesh(shared.glow, flashMaterial.clone());
    materials.push(flash.material as Material);
    flash.position.set(0, 0.02, 0.5);
    flash.visible = false;
    gun.add(gunBody, stripe, barrel, flash);
    gun.position.set(MUZZLE.x, MUZZLE.y - 0.04, MUZZLE.z - 0.48);
    person.root.add(gun);
    person.root.scale.setScalar(G.personScale);
    root.add(person.root);
    const laserColor = new Color(look.color).lerp(new Color("#ffffff"), 0.35);
    const core = new Mesh(shared.beam, mat(new MeshBasicMaterial({ color: laserColor, transparent: true, opacity: mine ? 0.95 : 0.75, depthWrite: false })));
    const halo = new Mesh(shared.beam, mat(new MeshBasicMaterial({ color: tint, transparent: true, opacity: mine ? 0.3 : 0.18, blending: AdditiveBlending, depthWrite: false })));
    const dot = new Mesh(shared.dot, mat(new MeshBasicMaterial({ color: laserColor })));
    const dotGlow = new Mesh(shared.glow, mat(new MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false })));
    dotGlow.scale.setScalar(0.2);
    root.add(core, halo, dot, dotGlow);
    const stars = Array.from({ length: 3 }, () => new Mesh(shared.star, starMaterial));
    root.add(...stars);
    // The knock-out: a big blast where the player stands, bits flying out.
    const boom = new Group();
    boom.position.set(cx, 1.3, G.personZ - 0.2);
    const boomFire = new Mesh(shared.glow, blastMaterial.clone()),
      boomCore = new Mesh(shared.glow, blastCore.clone()),
      boomSmoke = new Mesh(shared.glow, mat(new MeshBasicMaterial({ color: "#3b3433", transparent: true, opacity: 0.6, depthWrite: false })));
    materials.push(boomFire.material as Material, boomCore.material as Material);
    const boomBits = Array.from({ length: 14 }, (_, i) => {
      const bit = new Mesh(shared.debris, debrisMaterial);
      bit.userData.dir = new Vector3(Math.cos((i / 14) * Math.PI * 2), 0.5 + hash(i * 5 + lane) * 1.2, Math.sin((i / 14) * Math.PI * 2) * 0.8);
      bit.scale.setScalar(1.6);
      return bit;
    });
    boom.add(boomSmoke, boomFire, boomCore, ...boomBits);
    boom.visible = false;
    root.add(boom);
    // The colours to go dark from.
    const base = { panel: panelMaterial.color.clone(), cover: coverMaterial.color.clone(), face: new Color(1, 1, 1) };
    return { cx, slots, person: person.root, gun, flash, core, halo, dot, dotGlow, stars, boom, boomFire, boomCore, boomSmoke, boomBits, panelMaterial, coverMaterial, face, base, aimX: cx, bob: hash(lane * 7) * 6 };
  });

  let clock = 0;
  const dark = new Color("#26272d"),
    muzzle = new Vector3(),
    end = new Vector3(),
    goal = new Vector3(),
    lifts = [0, 0, 0];
  return {
    root,
    /** Draws `views` (one per lane, from `laneViews`) at the frame's moment; `dt` (s) drives idle motion. */
    update(frame: MarksmanFrame, views: readonly LaneView[], dt: number) {
      clock += dt;
      const t = frame.now,
        wire = frame.wire,
        ended = wire.phase === "results";
      bulbs.forEach((bulb, i) => bulb.scale.setScalar(0.85 + 0.25 * Math.max(0, Math.sin(clock * 3 + i * 0.9))));
      lanes.forEach((y, lane) => {
        const v = views[lane];
        if (!v) return;
        const out = wire.out[lane];
        // Slots: up while their wave is, down before and after; a hit target tips back, a hit bomb blows up.
        y.slots.forEach((s, slot) => {
          const view = v.slots[slot];
          let lift = 0,
            tip = 0,
            blast = -1;
          if (view && !out) {
            const up = Math.min(1, Math.max(0, (t - view.open) / RISE_MS)),
              down = t >= view.close ? Math.min(1, (t - view.close) / LOWER_MS) : 0;
            lift = t < view.open ? 0 : backOut(up) * (1 - down);
            if (view.hit) {
              const since = t - view.hit.at;
              if (view.kind === BOMB) {
                blast = since;
                lift = 0;
              } else {
                tip = Math.min(1, Math.max(0, since / TIP_MS));
                lift *= 1 - Math.max(0, Math.min(1, (since - TIP_MS - 120) / 260));
              }
            }
          }
          lifts[slot] = view?.hit ? 0 : lift;
          const bombHere = view?.kind === BOMB;
          s.target.visible = !bombHere && lift > 0.001;
          s.bomb.visible = bombHere && lift > 0.001;
          s.pivot.position.y = G.coverY - 1.5 * (1 - lift);
          s.pivot.rotation.x = -1.35 * tip * tip;
          if (s.bomb.visible) {
            const flicker = 0.7 + 0.3 * Math.sin(clock * 37 + slot * 2) * Math.sin(clock * 23 + lane);
            s.spark.scale.setScalar(0.8 + 0.5 * flicker);
            s.glow.scale.setScalar(0.11 + 0.08 * flicker);
          }
          // The explosion: a flash, a fireball that swells and fades, bits flying out.
          s.blast.visible = blast >= 0 && blast < BLAST_MS;
          if (s.blast.visible) {
            const k = blast / BLAST_MS;
            s.core.scale.setScalar(0.35 + 0.5 * Math.min(1, k * 4));
            (s.core.material as MeshBasicMaterial).opacity = Math.max(0, 1 - k * 3);
            s.fire.scale.setScalar(0.4 + 1.1 * Math.sqrt(k));
            (s.fire.material as MeshBasicMaterial).opacity = 0.9 * (1 - k) ** 1.5;
            s.bits.forEach((bit) => {
              const d = bit.userData.dir as Vector3;
              bit.position.set(d.x * k * 1.6, d.y * k * 1.8 - 2.2 * k * k, d.z * k * 1.2);
              bit.rotation.set(k * 9 + d.x, k * 7, k * 5);
            });
          }
        });

        // The character turns with its aim; a shot kicks the blaster; a bomb leaves it wobbling under stars.
        const person = y.person,
          dead = v.diedAt >= 0 && t >= v.diedAt,
          sinceDeath = dead ? t - v.diedAt : -1,
          stunned = !dead && wire.phase === "shooting" && t >= 0 && t < v.stunUntil,
          won = ended && frame.winner === lane,
          lost = ended && frame.winner !== lane && frame.winner >= 0,
          sinceShot = t - v.shotAt,
          lastGood = v.hits.filter((h) => h.points > 0).reduce((m, h) => Math.max(m, h.at), -1e9),
          cheer = won || (!ended && t - lastGood >= 0 && t - lastGood < CHEER_MS && !stunned);
        const ease = Math.min(1, dt * (lane === frame.self ? 30 : 18));
        const aimSlot = slotPoint(lane, count, v.aim + 1);
        y.aimX += (aimSlot.x - y.aimX) * ease;
        // Facing −z, turned toward the aim (a positive turn about y would look left).
        const yaw = -Math.atan2(y.aimX - y.cx, G.personZ - G.targetZ);
        let pose: Pose = POSES.aim,
          lift = Math.sin(clock * 2.2 + y.bob) * 0.012;
        if (dead) pose = POSES.sad;
        else if (won) {
          pose = POSES.cheer;
          lift = Math.max(0, Math.sin(Math.PI * ((clock * 1.6) % 1))) * 0.5;
        } else if (lost) pose = POSES.sad;
        else if (cheer) lift += Math.max(0, Math.sin((Math.PI * (t - lastGood)) / CHEER_MS)) * 0.12;
        const pe = Math.min(1, dt * 14);
        pose.forEach((p, index) => {
          const part = person.children[index];
          part.position.lerp(goal.set(p.x + (index === HEAD && stunned ? Math.sin(clock * 11) * 0.05 : 0), p.y, p.z), pe);
          part.rotation.x += (p.rx - part.rotation.x) * pe;
          part.rotation.z += (p.rz - part.rotation.z) * pe;
        });
        // Knocked out: blown up a little, then down on its back (toward the camera), and it stays down.
        const fall = dead ? Math.min(1, sinceDeath / FALL_MS) : 0;
        if (dead) lift = Math.max(0, Math.sin(Math.PI * Math.min(1, sinceDeath / (FALL_MS * 0.8)))) * 0.55;
        person.position.set(y.cx, lift, G.personZ + fall * 0.3);
        person.rotation.set(1.42 * fall * fall, Math.PI + (ended || dead ? 0 : yaw), stunned ? Math.sin(clock * 9) * 0.12 : dead ? 0.25 * fall : 0);
        person.visible = !out;
        // The big blast, and the lane going dark (its targets too).
        y.boom.visible = dead && sinceDeath < BOOM_MS;
        if (y.boom.visible) {
          const k = sinceDeath / BOOM_MS;
          y.boomCore.scale.setScalar(0.6 + 1.1 * Math.min(1, k * 5));
          (y.boomCore.material as MeshBasicMaterial).opacity = Math.max(0, 1 - k * 3.5);
          y.boomFire.scale.setScalar(0.8 + 2.2 * Math.sqrt(k));
          (y.boomFire.material as MeshBasicMaterial).opacity = 0.95 * (1 - k) ** 1.4;
          y.boomSmoke.scale.setScalar(0.6 + 2.6 * k);
          y.boomSmoke.position.y = 0.4 * k;
          (y.boomSmoke.material as MeshBasicMaterial).opacity = 0.55 * (1 - k);
          y.boomBits.forEach((bit) => {
            const d = bit.userData.dir as Vector3;
            bit.position.set(d.x * k * 3, d.y * k * 3.2 - 4 * k * k, d.z * k * 2.4);
            bit.rotation.set(k * 11 + d.x, k * 8, k * 6);
          });
        }
        const gloom = dead ? Math.min(1, sinceDeath / DARK_MS) * 0.82 : 0;
        y.panelMaterial.color.copy(y.base.panel).lerp(dark, gloom);
        y.coverMaterial.color.copy(y.base.cover).lerp(dark, gloom);
        y.face.color.copy(y.base.face).lerp(dark, gloom);
        y.gun.visible = (!ended || !won) && !dead;
        const kick = sinceShot >= 0 && sinceShot < FLASH_MS * 1.6 ? Math.sin((Math.PI * sinceShot) / (FLASH_MS * 1.6)) : 0;
        y.gun.position.z = MUZZLE.z - 0.48 - kick * 0.08;
        y.gun.rotation.x = -kick * 0.25;
        y.flash.visible = sinceShot >= 0 && sinceShot < FLASH_MS && !out && !dead;
        if (y.flash.visible) {
          const k = sinceShot / FLASH_MS;
          y.flash.scale.setScalar(0.07 + 0.1 * Math.sin(Math.PI * k));
        }
        // The stars circle the head while stunned.
        const head = person.children[HEAD].position;
        y.stars.forEach((star, i) => {
          star.visible = stunned && !out;
          if (!star.visible) return;
          const a = clock * 5 + (i * Math.PI * 2) / 3;
          star.position.set(y.cx + Math.cos(a) * 0.38, (head.y + 0.45) * G.personScale + lift, G.personZ + Math.sin(a) * 0.38);
          star.rotation.set(clock * 3, clock * 4 + i, 0);
        });
        // The laser: from the muzzle to the slot it points at; faint and flickering while stunned.
        person.updateMatrixWorld(true);
        muzzle.copy(MUZZLE).applyMatrix4(person.matrixWorld);
        // On the target's face while one stands in the aimed slot, else on the panel behind it.
        end.set(y.aimX, G.targetY, lifts[v.aim + 1] > 0.6 ? G.targetZ + 0.06 : G.targetZ - 0.88);
        const laser = out || dead ? 0 : !ended && wire.phase !== "countdown" ? 1 : wire.phase === "countdown" ? 0.6 : 0;
        y.core.visible = y.halo.visible = y.dot.visible = y.dotGlow.visible = laser > 0;
        if (laser > 0) {
          const shot = sinceShot >= 0 && sinceShot < FLASH_MS * 2 ? 1 - sinceShot / (FLASH_MS * 2) : 0,
            dim = stunned ? 0.25 + 0.2 * Math.max(0, Math.sin(clock * 30)) : 1;
          beam(y.core, muzzle, end, 0.012 + 0.012 * shot);
          beam(y.halo, muzzle, end, 0.04 + 0.05 * shot);
          (y.core.material as MeshBasicMaterial).opacity = (lane === frame.self ? 0.95 : 0.7) * dim * laser;
          (y.halo.material as MeshBasicMaterial).opacity = ((lane === frame.self ? 0.3 : 0.18) + 0.4 * shot) * dim * laser;
          y.dot.position.copy(end);
          y.dotGlow.position.copy(end);
          y.dotGlow.scale.setScalar(0.17 + 0.18 * shot + 0.02 * Math.sin(clock * 8));
        }
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
export type MarksmanVisual = ReturnType<typeof marksmanVisual>;
