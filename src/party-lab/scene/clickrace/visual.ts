import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Material,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { PARTS, SHAPES } from "../ragdoll/config";
import { createCharacterVisual } from "../visual/characterVisual";
import type { CostumeId } from "../visual/costumes";
import { FINISH_X, START_X, TRACK, carX, laneZ, trackBounds } from "./layout";

export interface ClickLaneLook {
  color: string;
  costume: CostumeId;
  name: string;
  self: boolean;
}

const PUFFS = 96;
/** Speed lines show from this speed (m/s) and are full at `STREAK_FULL` (a fast presser's cruise). */
const STREAK_FROM = 5.5;
const STREAK_FULL = 8.5;
const STREAKS = [
  { z: -0.62, y: 0.55, phase: 0 },
  { z: 0.05, y: 0.95, phase: 0.37 },
  { z: 0.66, y: 0.55, phase: 0.71 },
];
const PALETTE = { grass: "#93b678", grassDark: "#86aa6d", asphalt: "#3a4347", line: "#ece6d4", kerbA: "#e6e1cf", kerbB: "#ce6d59", dark: "#27363b" };

/**
 * Tıklama Yarışı scenery and cars: one merged vertex-coloured mesh for the ground, lanes and
 * lines, the Araba Yarışı kit car in each player's colour with their character at the wheel,
 * and one instanced mesh of exhaust puffs. `update` eases each car toward the server's count.
 */
export function clickRaceVisual(kit: Group, lanes: readonly ClickLaneLook[]) {
  const count = lanes.length,
    root = new Group(),
    owned: BufferGeometry[] = [],
    materials: Material[] = [],
    textures: CanvasTexture[] = [],
    people: { dispose(): void }[] = [];
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  materials.push(material);
  const parts: BufferGeometry[] = [];
  const box = (size: [number, number, number], at: [number, number, number], hex: string) => {
    const g = new BoxGeometry(...size).translate(...at).toNonIndexed();
    const c = new Color(hex),
      data = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < data.length; i += 3) c.toArray(data, i);
    g.setAttribute("color", new Float32BufferAttribute(data, 3));
    g.deleteAttribute("uv");
    parts.push(g);
  };
  const b = trackBounds(count),
    width = count * TRACK.laneWidth,
    // The asphalt ends inside the framed area, so grass shows around it on every screen.
    road = { from: b.minX + 0.8, to: b.maxX - 0.8 },
    length = road.to - road.from,
    midX = (road.to + road.from) / 2;
  // Ground far past any screen shape, then the asphalt and kerbs.
  box([260, 0.1, 260], [0, -0.06, 0], PALETTE.grass);
  for (let i = -6; i <= 6; i++) box([260, 0.02, 9], [0, -0.005, i * 18], PALETTE.grassDark);
  box([length, 0.06, width], [midX, 0.02, 0], PALETTE.asphalt);
  for (const side of [-1, 1])
    for (let x = road.from, i = 0; x < road.to - 0.01; x += 2, i++) box([Math.min(2, road.to - x), 0.08, 0.5], [x + Math.min(2, road.to - x) / 2, 0.04, side * (width / 2 + 0.25)], i % 2 ? PALETTE.kerbA : PALETTE.kerbB);
  // Dashed lane dividers, the start line and a checkered finish line.
  for (let lane = 1; lane < count; lane++) {
    const z = laneZ(lane, count) - TRACK.laneWidth / 2;
    for (let x = START_X; x < FINISH_X; x += 3) box([1.6, 0.07, 0.12], [x + 0.8, 0.05, z], PALETTE.line);
  }
  box([0.35, 0.07, width], [START_X, 0.055, 0], PALETTE.line);
  const cells = Math.max(2, Math.round(width / 0.5));
  for (let i = 0; i < cells; i++) for (let j = 0; j < 2; j++) box([0.5, 0.07, width / cells], [FINISH_X + 0.25 + j * 0.5, 0.06, -width / 2 + (i + 0.5) * (width / cells)], (i + j) % 2 ? PALETTE.line : PALETTE.dark);
  // Quarter marks on the kerbs.
  for (const q of [0.25, 0.5, 0.75]) box([0.18, 0.09, width + 1], [START_X + q * TRACK.run, 0.045, 0], "#cfc8b4");
  // Each lane's colour behind the start line.
  lanes.forEach((look, lane) => box([1.1, 0.075, TRACK.laneWidth - 0.5], [road.from + 0.7, 0.06, laneZ(lane, count)], look.color));
  const ground = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  owned.push(ground);
  root.add(new Mesh(ground, material));

  // Kit pieces: a crowd stand and trees around the track, flags at the finish.
  const kitMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.88 });
  materials.push(kitMaterial);
  const kitGeometry = (name: string, tint?: string) => {
    const source = kit.getObjectByName(name) as Mesh,
      g = source.geometry.clone();
    if (tint) {
      const a = g.getAttribute("color"),
        rgb = new Color(tint);
      if (a)
        for (let i = 0; i < a.count; i++) {
          const r = a.getX(i), green = a.getY(i), blue = a.getZ(i);
          if (r > green * 1.7 && r > blue * 1.7) a.setXYZ(i, rgb.r * (0.8 + 0.2 * r), rgb.g * (0.8 + 0.2 * r), rgb.b * (0.8 + 0.2 * r));
        }
    }
    owned.push(g);
    return g;
  };
  const place = new Group();
  const instances = (name: string, at: { x: number; z: number; yaw?: number; scale?: number }[]) => {
    const mesh = new InstancedMesh(kitGeometry(name), kitMaterial, at.length);
    at.forEach((p, i) => {
      place.position.set(p.x, 0, p.z);
      place.rotation.set(0, p.yaw ?? 0, 0);
      place.scale.setScalar(p.scale ?? 1);
      place.updateMatrix();
      mesh.setMatrixAt(i, place.matrix);
    });
    mesh.computeBoundingSphere();
    root.add(mesh);
  };
  const edge = width / 2 + 1.2;
  instances("Flag", [-1, 1].flatMap((side) => [{ x: FINISH_X + 0.5, z: side * edge }, { x: START_X, z: side * edge }]));
  // Crowd stands on both sides, then trees further out (a wide or tall screen shows more grass).
  instances("Stand", [-1, 1].flatMap((side) => [-12, 0, 12].map((x) => ({ x: x + side * 3, z: side * (edge + 5), yaw: side > 0 ? Math.PI : 0, scale: 1.2 }))));
  const trees: { x: number; z: number; scale: number }[] = [];
  for (let i = 0; i < 44; i++) {
    const side = i % 2 ? 1 : -1,
      x = -66 + ((i * 41) % 132),
      z = side * (edge + 10 + ((i * 7) % 23));
    if (Math.abs(x) < 20 && Math.abs(z) < edge + 13) continue;
    trees.push({ x, z, scale: 0.8 + ((i * 13) % 5) / 10 });
  }
  for (let i = 0; i < 12; i++) trees.push({ x: (i % 2 ? 1 : -1) * (34 + (i % 4) * 5), z: -16 + i * 3, scale: 0.9 });
  instances("Tree", trees);

  // Names on the asphalt behind the start line, turned to read along the screen.
  const labels: Group[] = [];
  lanes.forEach((look, lane) => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgba(0,0,0,0)";
    ctx.fillRect(0, 0, 512, 128);
    ctx.fillStyle = look.self ? "#fff3c4" : "#f1ecdd";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = "800 60px Barlow, sans-serif";
    ctx.fillText(look.self && look.name !== "Sen" ? `${look.name} · SEN` : look.name, 8, 64, 496);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    textures.push(texture);
    const label = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
    materials.push(label);
    const plane = new PlaneGeometry(4.4, 1.1);
    owned.push(plane);
    const mesh = new Mesh(plane, label);
    mesh.rotation.x = -Math.PI / 2;
    const pivot = new Group();
    pivot.add(mesh);
    // Between the lane's colour and the waiting car's tail.
    pivot.position.set((road.from + 1.5 + START_X - TRACK.carLength - 0.05) / 2, 0.09, laneZ(lane, count));
    root.add(pivot);
    labels.push(pivot);
  });
  let portrait: boolean | null = null;
  const turn = (tall: boolean) => {
    if (tall === portrait) return;
    portrait = tall;
    for (const pivot of labels) {
      // Wide: along the lane. Tall: across it, shrunk to its width.
      pivot.rotation.y = tall ? -Math.PI / 2 : 0;
      pivot.scale.setScalar(tall ? 0.72 : 0.78);
    }
  };
  turn(false);

  const streakGeometry = new PlaneGeometry(1, 0.11);
  owned.push(streakGeometry);
  // Cars: the kit car in the slot colour, the player's character in the seat, facing +x.
  const cars = lanes.map((look, lane) => {
    const group = new Group(),
      body = new Group();
    const car = new Mesh(kitGeometry("Car", look.color), kitMaterial);
    car.rotation.y = Math.PI / 2;
    body.add(car);
    const person = createCharacterVisual(look.color, look.costume);
    people.push(person);
    PARTS.forEach((part, index) => {
      const shape = SHAPES[part];
      person.root.children[index].position.set(shape.x, shape.y + 0.79, 0);
    });
    person.root.rotation.y = Math.PI / 2;
    person.root.scale.setScalar(1.05);
    person.root.position.set(-0.3, 0.05, 0);
    body.add(person.root);
    group.add(body);
    group.position.set(carX(0), 0, laneZ(lane, count));
    root.add(group);
    // Speed lines: thin white streaks trailing the car, only at high speed.
    const streakMaterial = new MeshBasicMaterial({ color: "#fbf7ea", transparent: true, opacity: 0, depthWrite: false });
    materials.push(streakMaterial);
    const streaks = STREAKS.map((line) => {
      const mesh = new Mesh(streakGeometry, streakMaterial);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      group.add(mesh);
      return { mesh, ...line };
    });
    return { group, body, shown: 0, pitch: 0, smoke: 0, speed: 0, streaks, streakMaterial, clock: lane * 0.29 };
  });

  // Exhaust puffs: one instanced mesh, each puff grows, drifts back and fades out by shrinking.
  const puffGeometry = new IcosahedronGeometry(0.28, 0);
  owned.push(puffGeometry);
  const puffMaterial = new MeshStandardMaterial({ color: "#e8e3d6", roughness: 1, transparent: true, opacity: 0.85 });
  materials.push(puffMaterial);
  const puffs = new InstancedMesh(puffGeometry, puffMaterial, PUFFS);
  puffs.frustumCulled = false;
  const zero = new Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < PUFFS; i++) puffs.setMatrixAt(i, zero);
  root.add(puffs);
  const puff = Array.from({ length: PUFFS }, () => ({ age: 1, x: 0, z: 0, vx: 0, vz: 0, spin: 0 }));
  let next = 0;
  const m = new Matrix4(),
    q = new Quaternion(),
    s = new Vector3(),
    p = new Vector3(),
    axis = new Vector3(0, 1, 0);

  /** A puff (two at speed) behind `lane`'s car. */
  const burst = (lane: number, strength = 1) => {
    const c = cars[lane];
    if (!c) return;
    for (let k = 0; k < (strength > 1 ? 2 : 1); k++) {
      const it = puff[next];
      next = (next + 1) % PUFFS;
      it.age = 0;
      it.x = c.group.position.x - TRACK.carLength / 2 - 0.15;
      it.z = c.group.position.z + (k ? 0.45 : -0.45) + (Math.random() - 0.5) * 0.2;
      it.vx = -1.6 - Math.random() * 1.2;
      it.vz = (Math.random() - 0.5) * 0.9;
      it.spin = Math.random() * 6;
    }
  };
  return {
    root,
    burst,
    /**
     * `progress[lane]`: where the server has the car (distance over the track, past 1 while
     * gliding beyond the line); `speed[lane]` its speed (m/s). `tall` turns the names.
     */
    update(progress: readonly number[], speed: readonly number[], dt: number, tall = false) {
      turn(tall);
      const ease = 1 - Math.exp(-dt * 18);
      cars.forEach((c, lane) => {
        // Each press is a pulse of speed; the effects follow a calmer speed.
        c.speed += ((speed[lane] ?? 0) - c.speed) * (1 - Math.exp(-dt * 5));
        const target = progress[lane] ?? 0,
          v = c.speed,
          fast = Math.max(0, Math.min(1, (v - STREAK_FROM) / (STREAK_FULL - STREAK_FROM)));
        c.shown += (target - c.shown) * ease;
        if (Math.abs(target - c.shown) < 1e-5) c.shown = target;
        c.pitch += (Math.min(0.08, v * 0.009) - c.pitch) * Math.min(1, dt * 8);
        c.group.position.x = carX(c.shown);
        c.body.rotation.z = c.pitch;
        // Exhaust grows with speed: about one puff per 1.2 m driven.
        c.smoke += v * dt * 0.85;
        while (c.smoke >= 1) {
          c.smoke -= 1;
          burst(lane, v > 7 ? 2 : 1);
        }
        // Speed lines trail the car at high speed, flowing backwards.
        c.clock += dt * (1.6 + v * 0.25);
        c.streakMaterial.opacity = 0.9 * Math.sqrt(fast);
        for (const line of c.streaks) {
          const cycle = (c.clock + line.phase) % 1,
            length = (1.5 + 3.5 * fast) * (0.6 + 0.4 * Math.sin(Math.PI * cycle));
          line.mesh.visible = fast > 0;
          line.mesh.scale.x = length;
          line.mesh.position.set(-TRACK.carLength / 2 - 0.4 - length / 2 - cycle * 1.4, line.y, line.z);
        }
      });
      for (let i = 0; i < PUFFS; i++) {
        const it = puff[i];
        if (it.age >= 1) {
          puffs.setMatrixAt(i, zero);
          continue;
        }
        it.age = Math.min(1, it.age + dt / 0.55);
        it.x += it.vx * dt;
        it.z += it.vz * dt;
        const size = Math.sin(Math.PI * Math.min(1, it.age * 1.4)) * (0.7 + it.age * 0.9);
        p.set(it.x, 0.35 + it.age * 0.6, it.z);
        q.setFromAxisAngle(axis, it.spin + it.age * 2);
        s.setScalar(Math.max(0, size));
        puffs.setMatrixAt(i, m.compose(p, q, s));
      }
      puffs.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      root.traverse((o) => {
        if (o instanceof InstancedMesh) o.dispose();
      });
      people.forEach((person) => person.dispose());
      owned.forEach((g) => g.dispose());
      materials.forEach((mat) => mat.dispose());
      textures.forEach((t) => t.dispose());
    },
  };
}
export type ClickRaceVisual = ReturnType<typeof clickRaceVisual>;
