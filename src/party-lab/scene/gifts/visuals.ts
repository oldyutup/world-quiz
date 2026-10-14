import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Points,
  PointsMaterial,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  type Material,
  type MeshStandardMaterial as StandardMaterial,
} from "three";
import { GIFT_DECOR, homeCenter, homeAngle } from "../../../../shared/party-lab/maps/gifts";
import { GIFT } from "../../../../shared/party-lab/simulation/gifts/config";
import type { GiftEvent } from "../../../../shared/party-lab/simulation/gifts/game";
import { PARTS } from "../../../../shared/party-lab/simulation/ragdoll/config";
import { createCharacterVisual } from "../visual/characterVisual";
import type { GiftFrame, GiftLook } from "./source";

const BOX = GIFT.box.size;
const PEDESTAL_TOP = GIFT.pedestal.height;
const HEAD = PARTS.indexOf("head");
/** Wrapping paper and ribbon pairs; a box keeps its pair (by id) wherever it goes. */
const PAPERS: readonly [string, string][] = [
  ["#d8453d", "#f4d36a"],
  ["#3a9a63", "#f6efe0"],
  ["#3d72c8", "#f4d36a"],
  ["#e3b13a", "#c8433c"],
  ["#8d5bc6", "#f6efe0"],
  ["#2aa29c", "#f2c95f"],
];
/**
 * The middle pile on the stand, bottom up (taken from the top): 7 round the middle, then 4,
 * then 2 — 13 for three players, 9 (the bottom 7 and two above) for two.
 */
const PILE_SLOTS: readonly { x: number; y: number; z: number; yaw: number }[] = (() => {
  const out: { x: number; y: number; z: number; yaw: number }[] = [{ x: 0, y: 0, z: 0, yaw: 0.2 }];
  for (let i = 0; i < 6; i++) out.push({ x: Math.sin((i * Math.PI) / 3) * 0.5, y: 0, z: Math.cos((i * Math.PI) / 3) * 0.5, yaw: i * 0.55 });
  for (const [x, z] of [[-0.24, -0.24], [0.24, -0.24], [0.24, 0.24], [-0.24, 0.24]]) out.push({ x, y: BOX, z, yaw: x * z * 6 });
  out.push({ x: 0, y: 2 * BOX, z: -0.13, yaw: 0.4 }, { x: 0, y: 2 * BOX, z: 0.13, yaw: -0.3 });
  return out;
})();
/** A home's stack: rows of three across the back of the home (toward the wall), then a second wall of rows in front. */
function stackSlot(players: number, seat: number, index: number) {
  const angle = homeAngle(players, seat),
    out = { x: Math.sin(angle), z: Math.cos(angle) },
    across = { x: Math.cos(angle), z: -Math.sin(angle) },
    c = homeCenter(players, seat),
    perLayer = 3,
    rows = 5,
    wall = Math.floor(index / (perLayer * rows)),
    inWall = index % (perLayer * rows),
    row = Math.floor(inWall / perLayer),
    col = (inWall % perLayer) - 1,
    back = 1.05 - wall * (BOX + 0.04);
  return { x: c.x + out.x * back + across.x * col * (BOX + 0.03), y: row * BOX, z: c.z + out.z * back + across.z * col * (BOX + 0.03), yaw: angle + (index % 2 ? 0.06 : -0.05) };
}

/** Canvas text texture (numbers, popups). */
function textTexture(text: string, color: string, width = 256, height = 128, size = 92) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `900 ${size}px Barlow, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = Math.round(size * 0.16);
  ctx.strokeStyle = "rgba(16,20,30,0.88)";
  ctx.strokeText(text, width / 2, height / 2 + 4);
  ctx.fillStyle = color;
  ctx.fillText(text, width / 2, height / 2 + 4);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Every gift in the yard drawn as four instanced meshes (paper, two ribbons, bow). */
class GiftBatch {
  readonly group = new Group();
  private readonly body: InstancedMesh;
  private readonly ribbonA: InstancedMesh;
  private readonly ribbonB: InstancedMesh;
  private readonly bow: InstancedMesh;
  private count = 0;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly tilt = new Quaternion();
  private readonly p = new Vector3();
  private readonly s = new Vector3();
  private readonly offset = new Vector3();
  private readonly up = new Vector3(0, 1, 0);
  private readonly side = new Vector3(1, 0, 0);
  private readonly color = new Color();
  constructor(readonly capacity: number) {
    const cube = new BoxGeometry(1, 1, 1),
      paper = new MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 }),
      ribbon = new MeshStandardMaterial({ roughness: 0.35, metalness: 0.25 });
    this.body = new InstancedMesh(cube, paper, capacity);
    this.ribbonA = new InstancedMesh(cube, ribbon, capacity);
    this.ribbonB = new InstancedMesh(cube, ribbon, capacity);
    this.bow = new InstancedMesh(new SphereGeometry(0.5, 10, 8), ribbon, capacity);
    for (const mesh of [this.body, this.ribbonA, this.ribbonB, this.bow]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
  }
  begin() {
    this.count = 0;
  }
  /** One gift standing at (x, y, z) (its bottom), turned by `yaw`, tumbled by `roll` (rad), scaled by `size` (m). */
  add(x: number, y: number, z: number, yaw: number, size: number, paper: number, roll = 0) {
    if (this.count >= this.capacity) return;
    const i = this.count++,
      [paperColor, ribbonColor] = PAPERS[((paper % PAPERS.length) + PAPERS.length) % PAPERS.length];
    this.q.setFromAxisAngle(this.up, yaw);
    if (roll) this.q.multiply(this.tilt.setFromAxisAngle(this.side, roll));
    const centre = this.p.set(x, y + size / 2, z);
    const put = (mesh: InstancedMesh, sx: number, sy: number, sz: number, oy = 0) => {
      this.offset.set(0, oy, 0).applyQuaternion(this.q);
      this.m.compose(this.offset.add(centre), this.q, this.s.set(sx, sy, sz));
      mesh.setMatrixAt(i, this.m);
    };
    put(this.body, size, size, size);
    put(this.ribbonA, size * 1.03, size * 1.03, size * 0.2);
    put(this.ribbonB, size * 0.2, size * 1.03, size * 1.03);
    put(this.bow, size * 0.5, size * 0.26, size * 0.5, size * 0.56);
    this.body.setColorAt(i, this.color.set(paperColor));
    this.ribbonA.setColorAt(i, this.color.set(ribbonColor));
    this.ribbonB.setColorAt(i, this.color);
    this.bow.setColorAt(i, this.color);
  }
  end() {
    for (const mesh of [this.body, this.ribbonA, this.ribbonB, this.bow]) {
      mesh.count = this.count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
  dispose() {
    this.body.geometry.dispose();
    this.bow.geometry.dispose();
    (this.body.material as Material).dispose();
    (this.ribbonA.material as Material).dispose();
    for (const mesh of [this.body, this.ribbonA, this.ribbonB, this.bow]) mesh.dispose();
  }
}

/** Short bursts of sparks (CPU-moved points). */
class Sparks {
  readonly points: Points;
  private readonly position: Float32Array;
  private readonly colors: Float32Array;
  private readonly velocity: Float32Array;
  private readonly life: Float32Array;
  private next = 0;
  private readonly color = new Color();
  constructor(readonly capacity = 240) {
    this.position = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.velocity = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(this.position, 3));
    geometry.setAttribute("color", new BufferAttribute(this.colors, 3));
    this.points = new Points(geometry, new PointsMaterial({ size: 0.16, vertexColors: true, transparent: true, depthWrite: false, blending: AdditiveBlending }));
    this.points.frustumCulled = false;
    for (let i = 0; i < capacity; i++) this.position[i * 3 + 1] = -50;
  }
  burst(x: number, y: number, z: number, tint: string, count = 22, speed = 3) {
    this.color.set(tint);
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % this.capacity;
      const a = Math.random() * Math.PI * 2,
        v = speed * (0.4 + Math.random() * 0.8);
      this.position.set([x, y, z], i * 3);
      this.velocity.set([Math.cos(a) * v, 2 + Math.random() * 2.5, Math.sin(a) * v], i * 3);
      const k = 0.75 + Math.random() * 0.5;
      this.colors.set([Math.min(1, this.color.r * k + 0.15), Math.min(1, this.color.g * k + 0.15), Math.min(1, this.color.b * k + 0.15)], i * 3);
      this.life[i] = 0.55 + Math.random() * 0.35;
    }
  }
  update(dt: number) {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const o = i * 3;
      this.velocity[o + 1] -= 9 * dt;
      this.position[o] += this.velocity[o] * dt;
      this.position[o + 1] += this.velocity[o + 1] * dt;
      this.position[o + 2] += this.velocity[o + 2] * dt;
      if (this.life[i] <= 0 || this.position[o + 1] < 0) {
        this.life[i] = 0;
        this.position[o + 1] = -50;
      }
    }
    (this.points.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute("color") as BufferAttribute).needsUpdate = true;
  }
  dispose() {
    this.points.geometry.dispose();
    (this.points.material as Material).dispose();
  }
}

interface Floater {
  sprite: Sprite;
  age: number;
  rise: number;
}

/**
 * Everything drawn in the yard: the ground, the candy-striped wall, the stand with the pile,
 * the homes (a ring and a stack of boxes with a big count over it), the six little trees,
 * the characters, carried / flying / loose boxes, stun stars, a guard ring, sparks and the
 * "+1"/"−1" popups. It only shows a frame; it decides nothing.
 */
export class GiftVisuals {
  readonly root = new Group();
  private readonly people: { root: Group; dispose(): void; skin: StandardMaterial | null; stars: Object3D | null; starsY: number }[];
  private readonly batch = new GiftBatch(64);
  private readonly sparks = new Sparks();
  private readonly homes: { group: Group; label: Sprite; count: number; texture: CanvasTexture | null }[] = [];
  private readonly rings: Mesh[] = [];
  private readonly shadows: Mesh[] = [];
  private readonly guards: Mesh[] = [];
  private readonly floaters: Floater[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private readonly pileRing: Mesh;
  private clock = 0;
  private seenEvent = -1;
  constructor(readonly looks: readonly GiftLook[], readonly seats: readonly number[]) {
    const keep = <T extends { dispose(): void }>(thing: T) => (this.disposables.push(thing), thing);
    const players = seats.length;
    // Ground: the yard (snow-white flagstones) and the dark lawn round the wall.
    const lawn = new Mesh(keep(new CircleGeometry(40, 64)), keep(new MeshStandardMaterial({ color: "#24384a", roughness: 1 })));
    lawn.rotation.x = -Math.PI / 2;
    lawn.position.y = -0.02;
    const yard = new Mesh(keep(new CircleGeometry(GIFT.arena.radius, 96)), keep(new MeshStandardMaterial({ color: "#eef0ea", roughness: 0.95 })));
    yard.rotation.x = -Math.PI / 2;
    const rings = [3.2, 5.0, 8.2].map((r) => {
      const ring = new Mesh(keep(new RingGeometry(r - 0.03, r + 0.03, 96)), keep(new MeshBasicMaterial({ color: "#d9dcd4" })));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.004;
      return ring;
    });
    this.root.add(lawn, yard, ...rings);
    // Where the pile can be reached from.
    this.pileRing = new Mesh(keep(new RingGeometry(GIFT.pedestal.radius + GIFT.reach.pile - 0.06, GIFT.pedestal.radius + GIFT.reach.pile, 72)), keep(new MeshBasicMaterial({ color: "#d9b25c", transparent: true, opacity: 0.85 })));
    this.pileRing.rotation.x = -Math.PI / 2;
    this.pileRing.position.y = 0.006;
    this.root.add(this.pileRing);
    // The wall: the colliders' 36 segments, red and white in turn, with a gold cap.
    const { thickness, height, segments } = GIFT.arena.wall,
      r = GIFT.arena.radius + thickness / 2,
      half = r * Math.tan(Math.PI / segments) + 0.08,
      wall = new InstancedMesh(keep(new BoxGeometry(half * 2, height, thickness)), keep(new MeshStandardMaterial({ roughness: 0.6 })), segments),
      cap = new Mesh(keep(new TorusGeometry(r, 0.07, 6, 96)), keep(new MeshStandardMaterial({ color: "#e8c463", metalness: 0.4, roughness: 0.35 }))),
      dummy = new Object3D(),
      tint = new Color();
    for (let i = 0; i < segments; i++) {
      const a = (2 * Math.PI * i) / segments;
      dummy.position.set(Math.sin(a) * r, height / 2, Math.cos(a) * r);
      dummy.rotation.set(0, a, 0);
      dummy.updateMatrix();
      wall.setMatrixAt(i, dummy.matrix);
      wall.setColorAt(i, tint.set(i % 2 ? "#f4eee2" : "#c9403a"));
    }
    cap.rotation.x = Math.PI / 2;
    cap.position.y = height;
    this.root.add(wall, cap);
    // The stand: a dark wooden drum with a gold band, the pile on top.
    const stand = new Mesh(keep(new CylinderGeometry(GIFT.pedestal.radius, GIFT.pedestal.radius * 1.04, PEDESTAL_TOP, 40)), keep(new MeshStandardMaterial({ color: "#6d4429", roughness: 0.75 })));
    stand.position.y = PEDESTAL_TOP / 2;
    const band = new Mesh(keep(new TorusGeometry(GIFT.pedestal.radius + 0.01, 0.05, 6, 48)), keep(new MeshStandardMaterial({ color: "#e8c463", metalness: 0.45, roughness: 0.35 })));
    band.rotation.x = Math.PI / 2;
    band.position.y = PEDESTAL_TOP - 0.05;
    this.root.add(stand, band);
    // Six little fir trees (the obstacles' colliders).
    const needles = keep(new MeshStandardMaterial({ color: "#2f7a4f", roughness: 0.85 })),
      trunk = keep(new MeshStandardMaterial({ color: "#6a4630", roughness: 0.9 })),
      coneA = keep(new ConeGeometry(GIFT.decor.radius + 0.1, 0.9, 10)),
      coneB = keep(new ConeGeometry(GIFT.decor.radius - 0.04, 0.7, 10)),
      stem = keep(new CylinderGeometry(0.1, 0.12, 0.4, 8)),
      starGeometry = keep(new SphereGeometry(0.09, 8, 6)),
      starMaterial = keep(new MeshBasicMaterial({ color: "#ffe28a" }));
    for (const p of GIFT_DECOR) {
      const tree = new Group();
      const s = new Mesh(stem, trunk);
      s.position.y = 0.2;
      const a = new Mesh(coneA, needles);
      a.position.y = 0.75;
      const b = new Mesh(coneB, needles);
      b.position.y = 1.2;
      const top = new Mesh(starGeometry, starMaterial);
      top.position.y = GIFT.decor.height - 0.02;
      tree.add(s, a, b, top);
      tree.position.set(p.x, 0, p.z);
      this.root.add(tree);
    }
    // Homes: a coloured mat with a bright rim, and the count over the stack.
    const mat = keep(new CircleGeometry(GIFT.homes.radius, 64)),
      rim = keep(new RingGeometry(GIFT.homes.radius - 0.12, GIFT.homes.radius, 64));
    seats.forEach((_, seat) => {
      const look = looks[seat],
        c = homeCenter(players, seat),
        angle = homeAngle(players, seat),
        group = new Group();
      const floor = new Mesh(mat, keep(new MeshBasicMaterial({ color: look?.color ?? "#ccc", transparent: true, opacity: 0.32, depthWrite: false })));
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(c.x, 0.008, c.z);
      const edge = new Mesh(rim, keep(new MeshBasicMaterial({ color: look?.color ?? "#ccc" })));
      edge.rotation.x = -Math.PI / 2;
      edge.position.set(c.x, 0.01, c.z);
      const label = new Sprite(keep(new SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false })));
      label.renderOrder = 12;
      label.scale.set(2.2, 1.1, 1);
      label.position.set(c.x + Math.sin(angle) * 1.05, 2.9, c.z + Math.cos(angle) * 1.05);
      group.add(floor, edge, label);
      this.root.add(group);
      this.homes.push({ group, label, count: -1, texture: null });
    });
    // The characters and their floor rings, shadows and guard rings.
    const ring = keep(new RingGeometry(0.42, 0.52, 40)),
      blob = keep(new CircleGeometry(0.42, 24)),
      shade = keep(new MeshBasicMaterial({ color: "#000", transparent: true, opacity: 0.22, depthWrite: false })),
      guard = keep(new TorusGeometry(0.62, 0.035, 6, 40));
    this.people = [0, 1, 2].map((slot) => {
      const seat = seats.indexOf(slot),
        look = looks[seat];
      if (!look) return { root: new Group(), dispose() {}, skin: null, stars: null, starsY: 0.66 };
      const person = createCharacterVisual(look.color, look.costume);
      person.root.visible = false;
      this.root.add(person.root);
      const foot = new Mesh(ring, keep(new MeshBasicMaterial({ color: look.color, transparent: true, opacity: 0.9, depthWrite: false })));
      foot.rotation.x = -Math.PI / 2;
      foot.visible = false;
      const shadow = new Mesh(blob, shade);
      shadow.rotation.x = -Math.PI / 2;
      shadow.visible = false;
      const bubble = new Mesh(guard, keep(new MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.6, depthWrite: false })));
      bubble.rotation.x = Math.PI / 2;
      bubble.visible = false;
      this.rings[slot] = foot;
      this.shadows[slot] = shadow;
      this.guards[slot] = bubble;
      this.root.add(foot, shadow, bubble);
      const head = person.root.children[HEAD],
        stars = head?.getObjectByName("stars") ?? null;
      return {
        root: person.root,
        dispose: person.dispose,
        skin: ((person.root.children[0]?.getObjectByName("skin") as Mesh | undefined)?.material as StandardMaterial | undefined) ?? null,
        stars,
        starsY: stars?.position.y ?? 0.66,
      };
    });
    this.root.add(this.batch.group, this.sparks.points);
  }
  /** Draws `frame`; returns this frame's new box events (each once) for sounds and callouts. */
  update(frame: GiftFrame, dt: number): GiftEvent[] {
    this.clock += dt;
    const gift = frame.gift,
      tick = frame.tick;
    // Characters.
    for (let slot = 0; slot < this.people.length; slot++) {
      const person = this.people[slot],
        pose = frame.poses[slot];
      if (!person) continue;
      const shown = !!pose;
      person.root.visible = shown;
      if (this.rings[slot]) this.rings[slot].visible = shown;
      if (this.shadows[slot]) this.shadows[slot].visible = shown;
      if (this.guards[slot]) this.guards[slot].visible = false;
      if (!pose) continue;
      for (let i = 0; i < PARTS.length; i++) {
        const node = person.root.children[i],
          at = i * 7;
        node.position.set(pose[at], pose[at + 1], pose[at + 2]);
        node.quaternion.set(pose[at + 3], pose[at + 4], pose[at + 5], pose[at + 6]);
      }
      if (person.skin) person.skin.emissiveIntensity = frame.flash[slot] * 0.7;
      const hx = pose[0],
        hz = pose[2];
      this.rings[slot]?.position.set(hx, 0.012, hz);
      this.shadows[slot]?.position.set(hx, 0.011, hz);
      const stunned = gift.stunUntil[slot] > tick;
      if (person.stars) {
        person.stars.visible = stunned;
        person.stars.rotation.y = this.clock * 5;
      }
      const guarded = gift.guardUntil[slot] > tick && frame.phase === "playing";
      const bubble = this.guards[slot];
      if (bubble) {
        bubble.visible = guarded;
        bubble.position.set(hx, pose[1] + 0.05, hz);
        (bubble.material as MeshBasicMaterial).opacity = 0.35 + 0.3 * Math.sin(this.clock * 14) ** 2;
      }
    }
    // Gifts: the pile, the homes' stacks, the ones carried, flying and lying about.
    const b = this.batch;
    b.begin();
    for (let i = 0; i < Math.min(gift.pile, PILE_SLOTS.length); i++) {
      const s = PILE_SLOTS[i];
      b.add(s.x, PEDESTAL_TOP + s.y, s.z, s.yaw, BOX, i);
    }
    gift.seats.forEach((slot, seat) => {
      const count = Math.max(0, gift.home[slot]);
      for (let i = 0; i < count; i++) {
        const s = stackSlot(gift.players, seat, i);
        b.add(s.x, s.y, s.z, s.yaw, BOX, seat * 2 + i);
      }
      const home = this.homes[seat];
      if (home && home.count !== count) {
        home.count = count;
        home.texture?.dispose();
        home.texture = textTexture(String(count), this.looks[seat]?.color ?? "#fff");
        (home.label.material as SpriteMaterial).map = home.texture;
        (home.label.material as SpriteMaterial).needsUpdate = true;
      }
      if (home) home.label.position.y = 1.0 + Math.ceil(Math.min(count, 15) / 3) * BOX + 0.55;
    });
    for (const slot of gift.seats) {
      const pose = frame.poses[slot];
      if (!gift.carrying[slot] || !pose) continue;
      const at = HEAD * 7,
        y = pose[at + 1] + (this.people[slot]?.starsY ?? 0.66) - 0.05,
        bob = Math.sin(this.clock * 9 + slot) * 0.03;
      b.add(pose[at], y + bob, pose[at + 2], this.clock * 0.6 + slot, GIFT.box.carried, 3 + slot);
    }
    for (const box of gift.boxes) {
      if (tick >= box.land) {
        b.add(box.x, 0, box.z, box.id * 1.3, BOX, box.id);
        continue;
      }
      const u = Math.max(0, Math.min(1, (tick - box.at) / Math.max(1, box.land - box.at))),
        x = box.fx + (box.x - box.fx) * u,
        z = box.fz + (box.z - box.fz) * u,
        y = box.fy * (1 - u) + GIFT.drop.apex * 4 * u * (1 - u);
      b.add(x, Math.max(0, y), z, box.id * 1.3 + u * 4, BOX, box.id, u * Math.PI * 1.5);
    }
    b.end();
    // The pile's reach ring fades with the pile.
    this.pileRing.visible = gift.pile > 0;
    // New box events: sparks and popups.
    const fresh = gift.events.filter((e) => e.id > this.seenEvent);
    if (gift.events.length) this.seenEvent = Math.max(this.seenEvent, gift.events[gift.events.length - 1].id);
    for (const e of fresh) this.present(e, frame);
    this.sparks.update(dt);
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.age += dt;
      f.sprite.position.y += f.rise * dt;
      (f.sprite.material as SpriteMaterial).opacity = Math.max(0, 1 - (f.age / 1.1) ** 2);
      if (f.age >= 1.1) {
        this.root.remove(f.sprite);
        (f.sprite.material as SpriteMaterial).map?.dispose();
        (f.sprite.material as SpriteMaterial).dispose();
        this.floaters.splice(i, 1);
      }
    }
    return fresh;
  }
  /** Forget the events already in the first frame (a reconnect must not replay them). */
  skipEvents(events: readonly GiftEvent[]) {
    if (events.length) this.seenEvent = Math.max(this.seenEvent, events[events.length - 1].id);
  }
  private colorOf(slot: number) {
    return this.looks[this.seats.indexOf(slot)]?.color ?? "#ffffff";
  }
  private popup(text: string, color: string, x: number, y: number, z: number) {
    const sprite = new Sprite(new SpriteMaterial({ map: textTexture(text, color), transparent: true, depthWrite: false, depthTest: false }));
    sprite.renderOrder = 14;
    sprite.scale.set(1.2, 0.6, 1);
    sprite.position.set(x, y, z);
    this.root.add(sprite);
    this.floaters.push({ sprite, age: 0, rise: 1.1 });
  }
  private present(e: GiftEvent, frame: GiftFrame) {
    const head = (slot: number) => {
      const pose = frame.poses[slot];
      return pose ? { x: pose[HEAD * 7], y: pose[HEAD * 7 + 1] + 0.5, z: pose[HEAD * 7 + 2] } : null;
    };
    if (e.kind === "deposit") {
      this.sparks.burst(e.x, 1.2, e.z, this.colorOf(e.actor), 26, 2.6);
      this.popup("+1", this.colorOf(e.actor), e.x, 2.4, e.z);
    } else if (e.kind === "steal") {
      this.sparks.burst(e.x, 1.0, e.z, "#ff6a55", 26, 3.2);
      this.popup("−1", "#ff6a55", e.x, 2.3, e.z);
    } else if (e.kind === "knock") {
      const at = head(e.actor) ?? { x: e.x, y: 1.6, z: e.z };
      this.sparks.burst(at.x, at.y, at.z, "#ffd36a", 30, 3.6);
    } else if (e.kind === "drop") {
      const at = head(e.actor) ?? { x: e.x, y: 1.6, z: e.z };
      this.sparks.burst(at.x, at.y, at.z, "#d8dde6", 14, 1.6);
    } else if (e.kind === "home") {
      this.sparks.burst(e.x, 0.4, e.z, this.colorOf(e.actor), 20, 2.2);
      this.popup("+1", this.colorOf(e.actor), e.x, 2.0, e.z);
    } else if (e.kind === "pile" || e.kind === "loose") {
      const at = head(e.actor);
      if (at) this.sparks.burst(at.x, at.y, at.z, "#fff3c4", 10, 1.4);
    }
  }
  dispose() {
    for (const person of this.people) person?.dispose();
    for (const home of this.homes) home.texture?.dispose();
    for (const f of this.floaters) {
      (f.sprite.material as SpriteMaterial).map?.dispose();
      (f.sprite.material as SpriteMaterial).dispose();
    }
    this.batch.dispose();
    this.sparks.dispose();
    for (const thing of this.disposables) thing.dispose();
  }
}
