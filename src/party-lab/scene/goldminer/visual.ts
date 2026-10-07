import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DodecahedronGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  Vector3,
  type Material,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GOLD_MINER as G, type GoldKind } from "../../../../shared/party-lab/simulation/goldminer/config";
import { pivotX } from "../../../../shared/party-lab/simulation/goldminer/mine";
import { itemKind, itemState, type GoldWire } from "../../../../shared/party-lab/simulation/goldminer/wire";
import { PARTS, SHAPES } from "../ragdoll/config";
import { createCharacterVisual } from "../visual/characterVisual";
import type { CostumeId } from "../visual/costumes";
import { SCENE } from "./layout";
import type { HookView } from "./online";

export interface GoldLaneLook {
  color: string;
  costume: CostumeId;
  name: string;
  self: boolean;
}

const PALETTE = {
  grass: "#86b260",
  grassDark: "#6c9a4b",
  soil: ["#a9774c", "#9a6a43", "#8a5d3c", "#7b5236", "#6d4831", "#5f3f2c"],
  frame: "#4f3727",
  frameEdge: "#34241a",
  pebble: "#6e5a4c",
  root: "#7a5534",
  wood: "#b07a47",
  woodDark: "#7d532f",
  rope: "#d8c193",
  metal: "#5d6469",
  hill: ["#a9c7b4", "#93b7a2", "#7ea68f"],
};
const ITEM_COLOR: Readonly<Record<GoldKind, string>> = { small: "#f0bf45", big: "#e9b23a", rock: "#8f8a84", diamond: "#a8ecff", sack: "#a87a4c" };
/** Popups ("+250") float this long, s. */
const POPUP_LIFE = 1.15;
const DRUM_R = 0.27;
/** The hook model's size (its tip is the point that catches). */
const HOOK_SCALE = 1.35;

/** Small deterministic noise, so the same mine looks the same on every screen. */
const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};
/** Colours every vertex of `g` `hex` (flat, for merged vertex-coloured meshes). */
function paint(g: BufferGeometry, hex: string) {
  const c = new Color(hex),
    data = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < data.length; i += 3) c.toArray(data, i);
  g.setAttribute("color", new Float32BufferAttribute(data, 3));
  return g;
}
/** Pushes every vertex out or in a little (low-poly lumps), the same way for the same `seed`. */
function lumpy(g: BufferGeometry, amount: number, seed: number) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = 1 + (hash(seed * 31 + Math.round(p.getX(i) * 97) * 7 + Math.round(p.getY(i) * 89) * 13 + Math.round(p.getZ(i) * 83) * 17) - 0.5) * amount;
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Altın Madenci scenery: a side cut through the mine (soil bands, pebbles, a dark rock frame
 * around the playable rect), each player's miner at a winch on the surface with their hook on
 * a rope, the round's items, and floating "+points". `update` places everything from
 * `hookViews` (online.ts): the view never decides what is caught.
 */
export function goldMinerVisual(lanes: readonly GoldLaneLook[], first: GoldWire) {
  const root = new Group(),
    owned: BufferGeometry[] = [],
    materials: Material[] = [],
    textures: CanvasTexture[] = [],
    people: { dispose(): void }[] = [];
  const count = lanes.length,
    W = G.width,
    D = G.depth;
  const flat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, flatShading: true });
  materials.push(flat);

  // Static scenery, merged into one vertex-coloured mesh.
  const parts: BufferGeometry[] = [];
  const box = (size: [number, number, number], at: [number, number, number], hex: string, rotZ = 0) => {
    const g = new BoxGeometry(...size).toNonIndexed();
    if (rotZ) g.rotateZ(rotZ);
    g.translate(...at);
    g.deleteAttribute("uv");
    parts.push(paint(g, hex));
  };
  /** A band of soil between two wavy lines, as a triangle strip at depth z. */
  const band = (top: (x: number) => number, bottom: (x: number) => number, from: number, to: number, z: number, hex: string, shade = 0) => {
    const step = 1.2,
      pos: number[] = [],
      col: number[] = [];
    const base = new Color(hex);
    for (let x = from; x < to - 1e-6; x += step) {
      const x2 = Math.min(to, x + step),
        c = base.clone().offsetHSL(0, 0, (hash(x * 3.1 + shade) - 0.5) * 0.035);
      // Counter-clockwise seen from the camera (+z), so the faces are drawn.
      const quad = [x, top(x), x2, bottom(x2), x2, top(x2), x, top(x), x, bottom(x), x2, bottom(x2)];
      for (let i = 0; i < quad.length; i += 2) {
        pos.push(quad[i], quad[i + 1], z);
        col.push(c.r, c.g, c.b);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    parts.push(g);
  };
  const reachX = 48;
  // Distant hills behind the surface, then the grass lip.
  PALETTE.hill.forEach((hex, k) => {
    const ridge = (x: number) => SCENE.ground + 0.9 + k * -0.35 + Math.sin(x * (0.22 + k * 0.07) + k * 2) * (0.7 - k * 0.12) + Math.sin(x * 0.9 + k) * 0.18;
    band(ridge, () => SCENE.ground - 0.05, -reachX, reachX, -6 + k, hex, k * 10);
  });
  box([reachX * 2, SCENE.ground + 0.02, 1.2], [0, SCENE.ground / 2 - 0.01, -0.9], PALETTE.grass);
  box([reachX * 2, 0.08, 1.21], [0, SCENE.ground - 0.03, -0.9], PALETTE.grassDark);
  // The soil, in bands that darken with depth.
  const lines = PALETTE.soil.map((_, k) => (x: number) => (k === 0 ? 0 : -k * (D / (PALETTE.soil.length - 0.6)) + Math.sin(x * (0.35 + k * 0.05) + k * 1.7) * 0.45 + Math.sin(x * 1.3 + k) * 0.12));
  PALETTE.soil.forEach((hex, k) => band(lines[k], k + 1 < lines.length ? lines[k + 1] : () => -D - 30, -reachX, reachX, -1.5, hex, k));
  // Pebbles and roots in the face (behind everything you can hook).
  for (let i = 0; i < 70; i++) {
    const x = (hash(i * 2.3) * 2 - 1) * (W / 2 + 3),
      y = -0.6 - hash(i * 5.7 + 1) * (D + 1),
      s = 0.08 + hash(i * 1.9) * 0.16;
    const g = new DodecahedronGeometry(s, 0);
    g.scale(1.4, 0.8, 0.4);
    g.translate(x, y, -1.35);
    g.deleteAttribute("uv");
    parts.push(paint(g, i % 3 ? PALETTE.pebble : "#857063"));
  }
  for (let i = 0; i < 7; i++) {
    const x = -W / 2 + 1.3 + ((i * 2.9 + hash(i) * 1.4) % (W - 2.6)),
      length = 0.35 + hash(i * 4.4) * 0.5;
    box([0.035, length, 0.03], [x, -length / 2 - 0.05, -1.4], PALETTE.root, (hash(i * 9.1) - 0.5) * 0.7);
    box([0.025, length * 0.45, 0.03], [x + 0.08, -length * 0.6, -1.39], PALETTE.root, 0.6 + hash(i) * 0.3);
  }
  // The rock frame around the playable mine (the hooks turn back at its edge).
  const edge = 0.14;
  box([30, D + 40, 0.4], [-W / 2 - 15, -D / 2 - 20 + 0.3, -1.1], PALETTE.frame);
  box([30, D + 40, 0.4], [W / 2 + 15, -D / 2 - 20 + 0.3, -1.1], PALETTE.frame);
  box([W, 30, 0.4], [0, -D - 15, -1.1], PALETTE.frame);
  box([edge, D + edge, 0.5], [-W / 2 - edge / 2, -D / 2 - edge / 2 + 0.3 - 0.15, -1.0], PALETTE.frameEdge);
  box([edge, D + edge, 0.5], [W / 2 + edge / 2, -D / 2 - edge / 2 + 0.3 - 0.15, -1.0], PALETTE.frameEdge);
  box([W + 2 * edge, edge, 0.5], [0, -D - edge / 2, -1.0], PALETTE.frameEdge);
  // Each player's winch: a plank, two A-frame legs, the drum's axle posts, a collar at the pulley.
  for (let lane = 0; lane < count; lane++) {
    const px = pivotX(lane, count);
    box([2.2, 0.12, 1.0], [px - 0.35, SCENE.ground + 0.06, -0.1], PALETTE.wood);
    for (const side of [-1, 1]) {
      box([0.1, 1.05, 0.12], [px + side * 0.24, SCENE.winchY - 0.38, -0.32], PALETTE.woodDark, side * 0.28);
      box([0.1, 1.05, 0.12], [px + side * 0.24, SCENE.winchY - 0.38, 0.26], PALETTE.woodDark, side * 0.28);
    }
    box([0.62, 0.16, 0.7], [px, 0.02, -0.05], PALETTE.woodDark);
  }
  const scenery = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  owned.push(scenery);
  root.add(new Mesh(scenery, flat));

  // Per-lane materials: the player's colour on the drum, the hook and the label.
  const metal = new MeshStandardMaterial({ color: PALETTE.metal, roughness: 0.5, metalness: 0.2, flatShading: true }),
    rope = new MeshStandardMaterial({ color: PALETTE.rope, roughness: 0.95 }),
    wood = new MeshStandardMaterial({ color: PALETTE.wood, roughness: 0.85, flatShading: true });
  materials.push(metal, rope, wood);
  const ropeGeometry = new CylinderGeometry(0.035, 0.035, 1, 6).translate(0, -0.5, 0),
    drumGeometry = new CylinderGeometry(DRUM_R, DRUM_R, 0.62, 10).rotateX(Math.PI / 2),
    coilGeometry = new CylinderGeometry(DRUM_R + 0.05, DRUM_R + 0.05, 0.42, 10).rotateX(Math.PI / 2),
    spokeGeometry = new BoxGeometry(DRUM_R * 1.9, 0.07, 0.04),
    handleGeometry = new CylinderGeometry(0.035, 0.035, 0.2, 6).rotateX(Math.PI / 2),
    pulleyGeometry = new TorusGeometry(0.16, 0.05, 6, 12),
    ringGeometry = new TorusGeometry(0.11, 0.035, 6, 10),
    shankGeometry = new BoxGeometry(0.1, 0.34, 0.1).translate(0, 0.26, 0),
    prongGeometry = new BoxGeometry(0.07, 0.3, 0.07).translate(0, -0.13, 0),
    tipGeometry = new OctahedronGeometry(0.06, 0);
  owned.push(ropeGeometry, drumGeometry, coilGeometry, spokeGeometry, handleGeometry, pulleyGeometry, ringGeometry, shankGeometry, prongGeometry, tipGeometry);
  const label = (text: string, color: string, self: boolean) => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 112;
    const ctx = canvas.getContext("2d")!;
    ctx.font = "800 64px Barlow, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 12;
    ctx.strokeStyle = "rgba(40,26,16,0.85)";
    const shown = self && text !== "Sen" ? `${text} · SEN` : text;
    ctx.strokeText(shown, 256, 58, 496);
    ctx.fillStyle = self ? "#fff2bf" : color;
    ctx.fillText(shown, 256, 58, 496);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    textures.push(texture);
    const material = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
    materials.push(material);
    const plane = new PlaneGeometry(2.3, 0.5);
    owned.push(plane);
    return new Mesh(plane, material);
  };

  const miners = lanes.map((look, lane) => {
    const px = pivotX(lane, count),
      tint = new MeshStandardMaterial({ color: look.color, roughness: 0.55, flatShading: true });
    materials.push(tint);
    // Winch: drum with the rope coil and a crank on its front face.
    const winch = new Group();
    winch.position.set(px, SCENE.winchY, 0);
    const drum = new Group();
    drum.add(new Mesh(drumGeometry, tint), new Mesh(coilGeometry, rope));
    const spoke = new Mesh(spokeGeometry, wood);
    spoke.position.z = 0.33;
    const handle = new Mesh(handleGeometry, metal);
    handle.position.set(DRUM_R * 0.85, 0, 0.42);
    drum.add(spoke, handle);
    winch.add(drum);
    root.add(winch);
    // The rope from the drum down to the pulley, and from the pulley to the hook.
    const feed = new Mesh(ropeGeometry, rope);
    feed.position.set(px, SCENE.winchY - DRUM_R, 0.05);
    feed.scale.y = SCENE.winchY - DRUM_R;
    const pulley = new Mesh(pulleyGeometry, metal);
    pulley.position.set(px, 0, 0.05);
    const line = new Mesh(ropeGeometry, rope);
    line.position.set(px, 0, 0.12);
    // The hook: a ring, a shank in the player's colour, two prongs and a point.
    const hook = new Group();
    const ring = new Mesh(ringGeometry, metal);
    ring.position.y = 0.46;
    const shank = new Mesh(shankGeometry, tint);
    const prongs = [-1, 1].map((side) => {
      const prong = new Mesh(prongGeometry, metal);
      prong.position.set(side * 0.05, 0.12, 0);
      prong.rotation.z = side * 0.55;
      hook.add(prong);
      return prong;
    });
    const point = new Mesh(tipGeometry, metal);
    point.position.y = 0.02;
    hook.add(ring, shank, point);
    hook.position.z = 0.3;
    hook.scale.setScalar(HOOK_SCALE);
    root.add(feed, pulley, line, hook);
    // The miner beside the winch, facing the camera, one hand on the crank.
    const person = createCharacterVisual(look.color, look.costume);
    people.push(person);
    const scale = 0.86;
    PARTS.forEach((part, index) => person.root.children[index].position.set(SHAPES[part].x, SHAPES[part].y + 0.79, 0));
    person.root.scale.setScalar(scale);
    person.root.position.set(px - 0.72, SCENE.feetY, 0.15);
    person.root.rotation.y = 0.35;
    root.add(person.root);
    const name = label(look.name, look.color, look.self);
    name.position.set(px - 0.4, SCENE.top - 0.18, 0.6);
    root.add(name);
    return { px, drum, line, hook, prongs, person: person.root, hand: PARTS.indexOf("rightHand"), spin: 0, length: G.restLength as number, state: "swing" as HookView["state"], bob: hash(lane * 7) * 6 };
  });

  // Items: one mesh each (static shapes, made once per round from the first wire).
  const gold = new MeshStandardMaterial({ color: ITEM_COLOR.small, roughness: 0.38, metalness: 0.25, emissive: "#6b4a00", emissiveIntensity: 0.35, flatShading: true }),
    rock = new MeshStandardMaterial({ color: ITEM_COLOR.rock, roughness: 0.95, flatShading: true }),
    diamond = new MeshStandardMaterial({ color: ITEM_COLOR.diamond, roughness: 0.15, metalness: 0.1, emissive: "#3aa8d8", emissiveIntensity: 0.55, flatShading: true }),
    sack = new MeshStandardMaterial({ color: ITEM_COLOR.sack, roughness: 0.9, flatShading: true }),
    tie = new MeshStandardMaterial({ color: "#6b4a2b", roughness: 0.9 });
  materials.push(gold, rock, diamond, sack, tie);
  const question = (() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext("2d")!;
    ctx.font = "900 96px Barlow, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f6e7c4";
    ctx.fillText("?", 64, 70);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    textures.push(texture);
    const m = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
    materials.push(m);
    return m;
  })();
  const questionPlane = new PlaneGeometry(0.62, 0.62);
  owned.push(questionPlane);
  const items = first.kind.map((_, i) => {
    const kind = itemKind(first, i),
      r = first.r[i],
      group = new Group();
    let spin = 0;
    if (kind === "small" || kind === "big") {
      const g = lumpy(new IcosahedronGeometry(r, kind === "big" ? 1 : 0), kind === "big" ? 0.32 : 0.36, i + 1);
      g.scale(1.12, 0.86, 0.8);
      owned.push(g);
      group.add(new Mesh(g, gold));
    } else if (kind === "rock") {
      const g = lumpy(new DodecahedronGeometry(r, 0), 0.3, i + 5);
      g.scale(1.1, 0.88, 0.75);
      owned.push(g);
      group.add(new Mesh(g, rock));
    } else if (kind === "diamond") {
      const g = new OctahedronGeometry(r * 1.05, 0);
      g.scale(1, 1.3, 0.8);
      owned.push(g);
      group.add(new Mesh(g, diamond));
      spin = 0.9;
    } else {
      // A sack: a lathed bag, a tie at its neck and a question mark.
      const outline = [0, 0.15, 0.62, 0.92, 1, 0.93, 0.7, 0.4, 0.3, 0.42].map((w, k, all) => new Vector2(Math.max(0.001, w * r), -r + (2 * r * k) / (all.length - 1)));
      const g = new LatheGeometry(outline, 9);
      g.scale(1, 1, 0.7);
      owned.push(g);
      group.add(new Mesh(g, sack));
      const knot = new CylinderGeometry(r * 0.34, r * 0.34, r * 0.18, 8).translate(0, r * 0.62, 0);
      owned.push(knot);
      group.add(new Mesh(knot, tie));
      const mark = new Mesh(questionPlane, question);
      mark.scale.setScalar(r * 1.25);
      mark.position.set(0, -r * 0.12, r * 0.72);
      group.add(mark);
    }
    group.rotation.z = (hash(i * 3.3) - 0.5) * 0.8;
    group.position.set(first.x[i], -first.y[i], 0);
    root.add(group);
    return { group, kind, spin, phase: hash(i) * 6, shown: true };
  });

  // Floating points: a small pool of sprites-as-planes facing the camera.
  const popups: { mesh: Mesh; material: MeshBasicMaterial; texture: CanvasTexture; ctx: CanvasRenderingContext2D; age: number }[] = [];
  const popupPlane = new PlaneGeometry(2.2, 0.95);
  owned.push(popupPlane);
  for (let i = 0; i < 8; i++) {
    const canvas = document.createElement("canvas");
    canvas.width = 384;
    canvas.height = 160;
    const ctx = canvas.getContext("2d")!;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    textures.push(texture);
    const material = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false });
    materials.push(material);
    const mesh = new Mesh(popupPlane, material);
    mesh.visible = false;
    mesh.renderOrder = 10;
    root.add(mesh);
    popups.push({ mesh, material, texture, ctx, age: POPUP_LIFE });
  }
  let nextPopup = 0;
  const popup = (text: string, color: string, x: number, y: number) => {
    const p = popups[nextPopup];
    nextPopup = (nextPopup + 1) % popups.length;
    const { ctx } = p;
    ctx.clearRect(0, 0, 384, 160);
    ctx.font = "900 96px Barlow, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 16;
    ctx.strokeStyle = "rgba(38,24,12,0.92)";
    ctx.strokeText(text, 192, 84, 370);
    ctx.fillStyle = color;
    ctx.fillText(text, 192, 84, 370);
    p.texture.needsUpdate = true;
    p.age = 0;
    p.mesh.position.set(x, y, 1);
    p.mesh.userData.y = y;
    p.mesh.visible = true;
  };

  let clock = 0;
  const crank = new Vector3(),
    rest = new Vector3(SHAPES.rightHand.x, SHAPES.rightHand.y + 0.79, 0);
  return {
    root,
    popup,
    /**
     * Places the hooks, ropes, drums, miners and items for `views` (one per lane) on `wire`
     * at `now` (ms after BAŞLA); `dt` (s) drives the purely visual motion.
     */
    update(wire: GoldWire, views: readonly HookView[], dt: number) {
      clock += dt;
      const carried = new Map<number, { x: number; y: number }>(),
        landed = new Set<number>();
      miners.forEach((m, lane) => {
        const v = views[lane];
        if (!v) return;
        const sx = Math.sin(v.angle),
          cy = Math.cos(v.angle);
        const tip = { x: m.px + sx * v.length, y: -cy * v.length };
        m.line.scale.y = Math.max(0.05, v.length - 0.57 * HOOK_SCALE);
        m.line.rotation.z = v.angle;
        m.hook.position.set(tip.x, tip.y, 0.3);
        m.hook.rotation.z = v.angle;
        m.hook.visible = m.line.visible = !wire.out[lane];
        // Prongs close on a catch.
        const closed = v.item >= 0 ? 0.25 : 0.55;
        m.prongs.forEach((prong, side) => (prong.rotation.z += ((side ? 1 : -1) * closed - prong.rotation.z) * Math.min(1, dt * 14)));
        // The drum turns with the rope (paying out or reeling in).
        const paid = v.length - m.length;
        m.length = v.length;
        m.drum.rotation.z -= paid / DRUM_R;
        m.state = v.state;
        // Reeling in: the miner cranks (a hand on the handle, a little bob); otherwise it rests.
        const hand = m.person.children[m.hand],
          ease = Math.min(1, dt * 12);
        if (v.state === "back" && !wire.out[lane]) {
          const a = m.drum.rotation.z;
          m.person.position.y = SCENE.feetY + Math.abs(Math.sin(a)) * 0.04;
          m.person.updateMatrixWorld();
          m.person.worldToLocal(crank.set(m.px + Math.cos(a) * DRUM_R * 0.85, SCENE.winchY + Math.sin(a) * DRUM_R * 0.85, 0.42));
          hand.position.lerp(crank, ease);
        } else {
          hand.position.lerp(rest, ease);
          m.person.position.y = SCENE.feetY + Math.sin(clock * 2.2 + m.bob) * 0.012;
        }
        if (v.item >= 0 && v.carry) carried.set(v.item, { x: tip.x + v.carry.x, y: tip.y - v.carry.y });
        if (v.landed >= 0) landed.add(v.landed);
      });
      items.forEach((it, i) => {
        const state = itemState(wire, i),
          at = carried.get(i);
        // Free items lie in the mine (or ride a hook the view already sees them on); a carried one rides its hook.
        it.group.visible = !landed.has(i) && (state === "free" || (state === "carried" && !!at));
        if (at) it.group.position.set(at.x, at.y, 0.1);
        else if (state === "free") it.group.position.set(wire.x[i], -wire.y[i], 0);
        if (it.spin) {
          it.group.rotation.y += dt * it.spin;
          (it.group.children[0] as Mesh).scale.setScalar(1 + Math.sin(clock * 3 + it.phase) * 0.04);
        }
      });
      for (const p of popups) {
        if (p.age >= POPUP_LIFE) continue;
        p.age = Math.min(POPUP_LIFE, p.age + dt);
        const k = p.age / POPUP_LIFE;
        p.mesh.position.y = (p.mesh.userData.y as number) + 1.3 * (1 - (1 - k) * (1 - k));
        p.material.opacity = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
        p.mesh.scale.setScalar(k < 0.12 ? 0.6 + (k / 0.12) * 0.5 : 1.1 - Math.min(0.1, (k - 0.12) * 0.4));
        p.mesh.visible = p.age < POPUP_LIFE;
      }
    },
    dispose() {
      people.forEach((person) => person.dispose());
      owned.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
    },
  };
}
export type GoldMinerVisual = ReturnType<typeof goldMinerVisual>;
