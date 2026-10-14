import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NormalBlending,
  Object3D,
  Plane,
  PlaneGeometry,
  Points,
  PointsMaterial,
  RepeatWrapping,
  RingGeometry,
  ShaderMaterial,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  SRGBColorSpace,
  SpriteMaterial,
  Vector3,
  type Material,
} from "three";
import { LIGHT_TRAILS as L } from "../../../../shared/party-lab/simulation/trails/config";
import { RUSH_AT } from "../../../../shared/party-lab/simulation/trails/game";
import { MAX_POINTS } from "../../../../shared/party-lab/simulation/trails/wire";
import { trainSpan, trainState } from "../../../../shared/party-lab/simulation/trails/train";
import { createCharacterVisual } from "../visual/characterVisual";
import { PARTS, SHAPES } from "../ragdoll/config";
import { textSprite } from "../bomber/visual";
import { WALL } from "./layout";
import type { TrailFrame, TrailLook, TrailRun } from "./source";

const HALF_X = L.width / 2,
  HALF_Z = L.depth / 2,
  /** The rail bed's half width: the band the train wipes (its body plus the trail's thickness). */
  BED = L.train.halfWidth + L.trailRadius;
/** Character size on the arena (the shared skins stand 1.48 m). */
export const PERSON_SCALE = 0.78;
const PALETTE = {
  void: "#04060c",
  floor: "#0a1020",
  wall: "#132544",
  neon: "#56d6ff",
  rush: "#ff4fb8",
  bed: "#161b27",
  sleeper: "#3b3531",
  rail: "#b7c0cf",
  warn: "#ff2638",
  body: "#c9372c",
  dark: "#242a36",
  stripe: "#f3ecdc",
  glass: "#8fd8ff",
  lamp: "#fff1b8",
};
/** Points drawn per ribbon at most: a whole trail plus the predicted end. */
const RIBBON_POINTS = MAX_POINTS + 48;

const VERTEX = /* glsl */ `
attribute float alpha;
attribute float side;
varying float vAlpha;
varying float vSide;
void main() {
  vAlpha = alpha;
  vSide = side;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAGMENT = /* glsl */ `
uniform vec3 color;
uniform float opacity;
uniform float core;
varying float vAlpha;
varying float vSide;
void main() {
  float d = abs(vSide);
  float shape = core > 0.5 ? 1.0 - smoothstep(0.55, 1.0, d) : pow(1.0 - d, 2.2);
  gl_FragColor = vec4(color, shape * vAlpha * opacity);
  #include <colorspace_fragment>
}`;

/** A flat glowing ribbon along a trail's runs (rebuilt every frame from the frame's points). */
function ribbon(color: string, width: number, core: boolean, y: number) {
  const positions = new Float32Array(RIBBON_POINTS * 2 * 3),
    alphas = new Float32Array(RIBBON_POINTS * 2),
    sides = new Float32Array(RIBBON_POINTS * 2),
    index = new Uint16Array((RIBBON_POINTS - 1) * 6);
  for (let i = 0; i < RIBBON_POINTS; i++) (sides[i * 2] = -1), (sides[i * 2 + 1] = 1);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage));
  geometry.setAttribute("alpha", new BufferAttribute(alphas, 1).setUsage(DynamicDrawUsage));
  geometry.setAttribute("side", new BufferAttribute(sides, 1));
  geometry.setIndex(new BufferAttribute(index, 1).setUsage(DynamicDrawUsage));
  const tint = new Color(color);
  if (core) tint.lerp(new Color("#ffffff"), 0.35);
  const material = new ShaderMaterial({
    uniforms: { color: { value: tint }, opacity: { value: core ? 1 : 0.62 }, core: { value: core ? 1 : 0 } },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: core ? NormalBlending : AdditiveBlending,
  });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = core ? 3 : 2;
  return {
    mesh,
    update(runs: readonly TrailRun[]) {
      let v = 0,
        n = 0;
      for (const run of runs) {
        const count = Math.min(run.x.length, RIBBON_POINTS - v);
        if (count < 2) continue;
        for (let i = 0; i < count; i++) {
          // Along the line at this point: the mean of the pieces either side.
          const a = Math.max(0, i - 1),
            b = Math.min(count - 1, i + 1);
          let tx = run.x[b] - run.x[a],
            tz = run.z[b] - run.z[a];
          const length = Math.hypot(tx, tz) || 1;
          tx /= length;
          tz /= length;
          const h = width / 2,
            k = (v + i) * 2;
          positions.set([run.x[i] + tz * h, y, run.z[i] - tx * h, run.x[i] - tz * h, y, run.z[i] + tx * h], k * 3);
          alphas[k] = alphas[k + 1] = run.alpha[i];
          if (i > 0) {
            const p = k - 2;
            index.set([p, p + 1, k, p + 1, k + 1, k], n);
            n += 6;
          }
        }
        v += count;
      }
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.alpha.needsUpdate = true;
      geometry.index!.needsUpdate = true;
      geometry.setDrawRange(0, n);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/** A soft round glow (for the floor under each player, a blast's flash). */
function glowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 31);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.45)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
/** A soft band across a strip (the glow along the walls). */
function bandTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.5, "rgba(255,255,255,1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 64);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
/** The floor's metre grid. */
function gridTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = PALETTE.floor;
  ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = "rgba(86,150,255,0.22)";
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, 64, 64);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.repeat.set(L.width, L.depth);
  texture.anisotropy = 4;
  return texture;
}

/**
 * The Işık İzi arena: a dark floor with a metre grid, neon walls, the rail across the middle
 * (red while a train is coming) and its train, everyone's glowing trail, the players, blasts.
 * It draws a TrailFrame; it decides nothing.
 */
export function trailVisual(looks: readonly TrailLook[]) {
  const root = new Group();
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);
  const glow = keep(glowTexture());

  // The ground: the void round the arena, the gridded floor inside the walls.
  const outside = new Mesh(keep(new PlaneGeometry(L.width * 3, L.depth * 3)), keep(new MeshBasicMaterial({ color: PALETTE.void })));
  outside.rotation.x = -Math.PI / 2;
  outside.position.y = -0.02;
  const floor = new Mesh(keep(new PlaneGeometry(L.width, L.depth)), keep(new MeshBasicMaterial({ map: keep(gridTexture()) })));
  floor.rotation.x = -Math.PI / 2;
  root.add(outside, floor);

  // Walls with a neon top.
  const wallMat = keep(new MeshBasicMaterial({ color: PALETTE.wall })),
    neonMat = keep(new MeshBasicMaterial({ color: PALETTE.neon })),
    haloMat = keep(new MeshBasicMaterial({ color: PALETTE.neon, map: keep(bandTexture()), transparent: true, opacity: 0.25, blending: AdditiveBlending, depthWrite: false }));
  const t = WALL.thickness;
  for (const [w, d, x, z] of [
    [L.width + 2 * t, t, 0, -HALF_Z - t / 2],
    [L.width + 2 * t, t, 0, HALF_Z + t / 2],
    [t, L.depth, -HALF_X - t / 2, 0],
    [t, L.depth, HALF_X + t / 2, 0],
  ]) {
    const wall = new Mesh(keep(new BoxGeometry(w, WALL.height, d)), wallMat);
    wall.position.set(x, WALL.height / 2, z);
    const along = w > d;
    const top = new Mesh(keep(new BoxGeometry(along ? w : w * 0.5, 0.04, along ? d * 0.5 : d)), neonMat);
    top.position.set(x, WALL.height + 0.02, z);
    // A soft glow either side of the wall, along it.
    const halo = new Mesh(keep(new PlaneGeometry(Math.max(w, d) + 0.6, 1.5)), haloMat);
    halo.rotation.x = -Math.PI / 2;
    if (!along) halo.rotation.z = Math.PI / 2;
    halo.position.set(x, 0.01, z);
    root.add(wall, top, halo);
  }

  // The rail: a bed, sleepers, two steel rails, a red warning glow, tunnel mouths in the side walls.
  const bed = new Mesh(keep(new PlaneGeometry(L.width, BED * 2)), keep(new MeshBasicMaterial({ color: PALETTE.bed })));
  bed.rotation.x = -Math.PI / 2;
  bed.position.y = 0.004;
  const sleeperCount = Math.floor(L.width / 0.55),
    sleepers = new InstancedMesh(keep(new BoxGeometry(0.16, 0.025, BED * 1.7)), keep(new MeshBasicMaterial({ color: PALETTE.sleeper })), sleeperCount),
    m = new Matrix4();
  for (let i = 0; i < sleeperCount; i++) sleepers.setMatrixAt(i, m.makeTranslation(-HALF_X + 0.3 + i * 0.55, 0.014, 0));
  const railMat = keep(new MeshStandardMaterial({ color: PALETTE.rail, metalness: 0.7, roughness: 0.3, emissive: PALETTE.warn, emissiveIntensity: 0 }));
  const rails = [-0.4, 0.4].map((z) => {
    const rail = new Mesh(keep(new BoxGeometry(L.width, 0.05, 0.07)), railMat);
    rail.position.set(0, 0.04, z);
    return rail;
  });
  const warnMat = keep(new MeshBasicMaterial({ color: PALETTE.warn, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false }));
  const warn = new Mesh(keep(new PlaneGeometry(L.width, BED * 2 + 0.3)), warnMat);
  warn.rotation.x = -Math.PI / 2;
  warn.position.y = 0.02;
  const mouthMat = keep(new MeshBasicMaterial({ color: "#020306" })),
    lampMat = keep(new MeshBasicMaterial({ color: PALETTE.warn }));
  const lamps = [-1, 1].map((side) => {
    const mouth = new Mesh(keep(new BoxGeometry(t * 1.2, WALL.height + 0.25, BED * 2 + 0.2)), mouthMat);
    mouth.position.set(side * (HALF_X + t / 2), (WALL.height + 0.25) / 2, 0);
    const lamp = new Mesh(keep(new SphereGeometry(0.13, 12, 8)), lampMat);
    lamp.position.set(side * (HALF_X + t / 2), WALL.height + 0.32, 0);
    root.add(mouth, lamp);
    return lamp;
  });
  // Arrows on the rail pointing the way the train will come.
  const arrowShape = new Shape();
  arrowShape.moveTo(0.45, 0);
  arrowShape.lineTo(-0.2, 0.42);
  arrowShape.lineTo(-0.05, 0);
  arrowShape.lineTo(-0.2, -0.42);
  arrowShape.closePath();
  const arrowGeo = keep(new ShapeGeometry(arrowShape)),
    arrowMat = keep(new MeshBasicMaterial({ color: PALETTE.warn, transparent: true, opacity: 0.9, depthWrite: false }));
  const arrows = [0, 1, 2].map((i) => {
    const arrow = new Mesh(arrowGeo, arrowMat);
    arrow.rotation.x = -Math.PI / 2;
    arrow.position.set(0, 0.03, 0);
    arrow.userData.i = i;
    root.add(arrow);
    return arrow;
  });
  root.add(bed, sleepers, ...rails, warn);

  // The train: a locomotive and four cars behind its front (local −x), cut off outside the walls.
  const clip = [new Plane(new Vector3(1, 0, 0), HALF_X + t), new Plane(new Vector3(-1, 0, 0), HALF_X + t)];
  const trainMat = (color: string, extra: Partial<{ emissive: string; emissiveIntensity: number }> = {}) => keep(new MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.2, clippingPlanes: clip, ...extra }));
  const bodyMat = trainMat(PALETTE.body),
    darkMat = trainMat(PALETTE.dark),
    stripeMat = trainMat(PALETTE.stripe),
    glassMat = trainMat(PALETTE.glass, { emissive: PALETTE.glass, emissiveIntensity: 0.5 }),
    lightMat = keep(new MeshBasicMaterial({ color: PALETTE.lamp, clippingPlanes: clip }));
  const train = new Group();
  const box = (w: number, h: number, d: number, x: number, y: number, mat: Material) => {
    const mesh = new Mesh(keep(new BoxGeometry(w, h, d)), mat);
    mesh.position.set(x, y, 0);
    train.add(mesh);
    return mesh;
  };
  box(3.4, 0.8, 1.5, -1.7, 0.5, bodyMat);
  box(3.42, 0.12, 1.52, -1.7, 0.62, stripeMat);
  box(1.3, 0.42, 1.36, -2.5, 1.1, darkMat);
  box(0.06, 0.26, 1.2, -1.83, 1.12, glassMat);
  box(0.5, 0.5, 1.5, -0.25, 0.32, darkMat);
  for (let k = 0; k < 4; k++) {
    const x = -3.4 - 0.3 - k * 4.2 - 1.95;
    box(3.9, 0.78, 1.42, x, 0.5, k % 2 ? bodyMat : darkMat);
    box(3.92, 0.1, 1.44, x, 0.66, stripeMat);
    box(0.3, 0.12, 0.4, x + 2.1, 0.3, darkMat);
  }
  for (const z of [-0.45, 0.45]) {
    const lamp = new Mesh(keep(new SphereGeometry(0.09, 10, 8)), lightMat);
    lamp.position.set(0.02, 0.5, z);
    train.add(lamp);
  }
  const beamMat = keep(new MeshBasicMaterial({ color: PALETTE.lamp, map: glow, transparent: true, opacity: 0.5, blending: AdditiveBlending, depthWrite: false, clippingPlanes: clip }));
  const beam = new Mesh(keep(new PlaneGeometry(5, 2.2)), beamMat);
  beam.rotation.x = -Math.PI / 2;
  beam.position.set(2.2, 0.03, 0);
  train.add(beam);
  train.visible = false;
  root.add(train);

  // Trails: a wide soft glow under a bright thin core, per player.
  const trails = looks.map((look) => {
    const halo = ribbon(look.color, 0.95, false, 0.03),
      core = ribbon(look.color, 2 * L.trailRadius + 0.04, true, 0.045);
    root.add(halo.mesh, core.mesh);
    disposables.push(halo, core);
    return { halo, core };
  });

  // Players: the character, a glowing ring and pool of light under it, a name tag, a start arrow.
  const people = looks.map((look) => {
    const person = createCharacterVisual(look.color, look.costume);
    person.root.scale.setScalar(PERSON_SCALE);
    PARTS.forEach((name, index) => person.root.children[index].position.set(SHAPES[name].x, SHAPES[name].y, 0));
    person.root.rotation.order = "YXZ";
    const skin = (person.root.children[0].children[0] as Mesh).material as MeshStandardMaterial;
    const ring = new Mesh(keep(new RingGeometry(0.3, 0.42, 32)), keep(new MeshBasicMaterial({ color: look.color, transparent: true, opacity: 0.95, blending: AdditiveBlending, depthWrite: false })));
    ring.rotation.x = -Math.PI / 2;
    const pool = new Mesh(keep(new CircleGeometry(1, 24)), keep(new MeshBasicMaterial({ color: look.color, map: glow, transparent: true, opacity: 0.4, blending: AdditiveBlending, depthWrite: false })));
    pool.rotation.x = -Math.PI / 2;
    const tag = textSprite(look.name, look.color, 1.4);
    const pointer = new Mesh(arrowGeo, keep(new MeshBasicMaterial({ color: look.color, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false })));
    pointer.rotation.x = -Math.PI / 2;
    root.add(person.root, ring, pool, tag, pointer);
    return { person, skin, ring, pool, tag, pointer, gait: 0, lean: 0, lastA: NaN, alive: true, fall: 0 };
  });

  // Blasts: sparks (one points cloud), a ring that spreads, a flash.
  const MAX = 320;
  const positions = new Float32Array(MAX * 3).fill(-1000),
    colors = new Float32Array(MAX * 3),
    velocity = new Float32Array(MAX * 3),
    life = new Float32Array(MAX);
  const cloudGeo = keep(new BufferGeometry());
  cloudGeo.setAttribute("position", new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage));
  cloudGeo.setAttribute("color", new BufferAttribute(colors, 3).setUsage(DynamicDrawUsage));
  const cloud = new Points(cloudGeo, keep(new PointsMaterial({ size: 0.2, vertexColors: true, transparent: true, opacity: 0.95, blending: AdditiveBlending, depthWrite: false })));
  cloud.frustumCulled = false;
  root.add(cloud);
  let cursor = 0;
  function burst(x: number, y: number, z: number, tint: string, count: number, speed: number) {
    const c = new Color(tint);
    for (let j = 0; j < count; j++) {
      const i = cursor++ % MAX,
        a = j * 2.39996 + Math.random(),
        v = speed * (0.4 + Math.random() * 0.8);
      life[i] = 0.45 + Math.random() * 0.45;
      positions.set([x, y, z], i * 3);
      velocity.set([Math.cos(a) * v, 1 + Math.random() * 2.4, Math.sin(a) * v], i * 3);
      colors.set([c.r, c.g, c.b], i * 3);
    }
  }
  const waves = [0, 1, 2].map(() => {
    const mat = keep(new MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false }));
    const wave = new Mesh(keep(new RingGeometry(0.8, 1, 40)), mat);
    wave.rotation.x = -Math.PI / 2;
    wave.position.y = 0.06;
    wave.visible = false;
    const flashMat = keep(new MeshBasicMaterial({ color: "#ffffff", map: glow, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false }));
    const flash = new Mesh(keep(new CircleGeometry(1, 24)), flashMat);
    flash.rotation.x = -Math.PI / 2;
    flash.position.y = 0.07;
    flash.visible = false;
    root.add(wave, flash);
    return { wave, mat, flash, flashMat, age: 9 };
  });
  let nextWave = 0;
  function blast(x: number, z: number, tint: string, big: boolean) {
    burst(x, 0.5, z, tint, big ? 46 : 34, big ? 5 : 3.6);
    burst(x, 0.5, z, "#fff4d6", 16, 2.4);
    burst(x, 0.5, z, "#ff9a3c", 14, 3);
    const w = waves[nextWave++ % waves.length];
    w.age = 0;
    w.mat.color.set(tint);
    w.wave.position.x = w.flash.position.x = x;
    w.wave.position.z = w.flash.position.z = z;
    w.wave.visible = w.flash.visible = true;
    w.flash.userData.big = big;
  }

  let clock = 0;
  const neon = new Color(PALETTE.neon),
    rushTint = new Color(PALETTE.rush);
  function update(frame: TrailFrame, dt: number) {
    clock += dt;
    const w = frame.wire,
      step = frame.step,
      playing = w.phase === "playing";

    // Walls turn hot pink for the last 15 s.
    const rush = playing && step > RUSH_AT ? Math.min(1, (step - RUSH_AT) / 30) : w.phase === "results" && w.step > RUSH_AT ? 1 : 0;
    neonMat.color.copy(neon).lerp(rushTint, rush);
    haloMat.color.copy(neonMat.color);
    haloMat.opacity = 0.25 + rush * (0.12 + 0.08 * Math.sin(clock * 9));

    // The rail and its train.
    const state = trainState(playing ? step : -1),
      warning = playing && state.phase === "warn",
      blink = 0.5 + 0.5 * Math.sin(clock * Math.PI * 2 * 3.2);
    warnMat.opacity = warning ? 0.12 + 0.5 * blink : playing && state.phase === "run" ? 0.22 : 0;
    railMat.emissiveIntensity = warning ? 0.4 + 1.6 * blink : playing && state.phase === "run" ? 0.8 : 0;
    lamps.forEach((lamp, i) => {
      const entry = state.dir > 0 ? 0 : 1;
      lamp.visible = warning ? i === entry && blink > 0.4 : playing && state.phase === "run";
    });
    arrows.forEach((arrow) => {
      const i = arrow.userData.i as number,
        travel = ((clock * 2.2 + i / 3) % 1) * 3;
      arrow.visible = warning && state.dir !== 0;
      arrow.rotation.z = state.dir > 0 ? 0 : Math.PI;
      arrow.position.x = state.dir * (-HALF_X + 1.2 + i * 1.1 + travel * 0.4);
      (arrow.material as MeshBasicMaterial).opacity = 0.35 + 0.6 * blink;
    });
    const span = playing ? trainSpan(step) : null;
    train.visible = !!span;
    if (span) {
      train.position.set(span.front, 0.02 * Math.sin(clock * 60), 0);
      train.rotation.y = span.dir > 0 ? 0 : Math.PI;
      if (Math.abs(span.front) < HALF_X) {
        burst(span.front - span.dir * 0.3, 0.1, -0.4, "#ffd27a", 1, 1.2);
        burst(span.front - span.dir * 0.3, 0.1, 0.4, "#ffd27a", 1, 1.2);
      }
    }

    // Trails.
    trails.forEach((trail, lane) => {
      const runs = frame.trails[lane] ?? [];
      trail.halo.update(runs);
      trail.core.update(runs);
    });

    // Players.
    people.forEach((pv, lane) => {
      const alive = frame.alive[lane],
        x = frame.x[lane],
        z = frame.z[lane],
        a = frame.a[lane],
        out = w.out[lane] && w.cause[lane] === 6;
      if (pv.alive && !alive && w.phase !== "countdown") blast(x, z, looks[lane]?.color ?? "#fff", w.cause[lane] === 5);
      pv.alive = alive;
      const r = pv.person.root;
      r.visible = !out;
      pv.ring.visible = pv.pool.visible = alive;
      pv.tag.visible = alive && (lane !== frame.self || w.phase === "countdown");
      pv.pointer.visible = w.phase === "countdown";
      // Facing its heading (the skin looks along +z), leaning into turns.
      const turn = Number.isFinite(pv.lastA) && dt > 0 ? Math.atan2(Math.sin(a - pv.lastA), Math.cos(a - pv.lastA)) / dt : 0;
      pv.lastA = a;
      pv.lean += (Math.max(-0.4, Math.min(0.4, turn * 0.09)) - pv.lean) * Math.min(1, dt * 10);
      if (alive) {
        pv.fall = 0;
        pv.gait += dt * (playing ? 15 : 0);
        const swing = playing ? Math.sin(pv.gait) * 0.6 : 0;
        r.position.set(x, playing ? Math.abs(Math.sin(pv.gait)) * 0.05 : 0, z);
        r.rotation.set(playing ? 0.18 : 0, Math.atan2(Math.cos(a), Math.sin(a)), pv.lean);
        r.children[7].rotation.x = swing;
        r.children[8].rotation.x = -swing;
        r.children[3].rotation.x = -swing * 0.8;
        r.children[5].rotation.x = swing * 0.8;
        pv.skin.color.setRGB(1, 1, 1);
      } else {
        // Down: it tips over forwards and dims.
        pv.fall = Math.min(1, pv.fall + dt / 0.35);
        const e = 1 - (1 - pv.fall) ** 3;
        r.position.set(x, 0.04 * e, z);
        r.rotation.set(e * (Math.PI / 2 - 0.12), Math.atan2(Math.cos(a), Math.sin(a)), 0);
        pv.skin.color.setRGB(1 - 0.6 * e, 1 - 0.6 * e, 1 - 0.55 * e);
      }
      pv.ring.position.set(x, 0.02, z);
      pv.pool.position.set(x, 0.015, z);
      const self = lane === frame.self && w.phase !== "results";
      pv.pool.scale.setScalar(self ? 1.15 + 0.12 * Math.sin(clock * 5) : 0.95);
      pv.tag.position.set(x, 1.8, z);
      // Where everyone will run at BAŞLA: an arrow sliding out ahead.
      const lead = 1.15 + 0.25 * ((clock * 1.6) % 1);
      pv.pointer.position.set(x + Math.cos(a) * lead, 0.04, z + Math.sin(a) * lead);
      pv.pointer.rotation.z = -a;
      (pv.pointer.material as MeshBasicMaterial).opacity = 0.75 + 0.25 * Math.sin(clock * 6);
    });

    // Sparks, rings, flashes.
    for (let i = 0; i < MAX; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      if (life[i] <= 0) {
        positions[i * 3 + 1] = -1000;
        continue;
      }
      velocity[i * 3 + 1] -= dt * 7;
      for (let j = 0; j < 3; j++) positions[i * 3 + j] += velocity[i * 3 + j] * dt;
      if (positions[i * 3 + 1] < 0.02) {
        positions[i * 3 + 1] = 0.02;
        velocity[i * 3 + 1] *= -0.3;
      }
    }
    cloudGeo.attributes.position.needsUpdate = true;
    cloudGeo.attributes.color.needsUpdate = true;
    for (const wv of waves) {
      if (wv.age > 1) {
        wv.wave.visible = wv.flash.visible = false;
        continue;
      }
      wv.age += dt;
      const big = !!wv.flash.userData.big,
        e = Math.min(1, wv.age / 0.55);
      wv.wave.scale.setScalar(0.3 + e * (big ? 3.4 : 2.4));
      wv.mat.opacity = Math.max(0, 0.9 * (1 - e));
      wv.flash.scale.setScalar((big ? 2.6 : 1.9) * (0.6 + 0.4 * e));
      wv.flashMat.opacity = Math.max(0, 1 - wv.age / 0.25);
    }
  }
  return {
    root,
    update,
    blast,
    dispose() {
      for (const p of people) {
        p.person.dispose();
        (p.tag.material as SpriteMaterial).map?.dispose();
        p.tag.material.dispose();
      }
      for (const d of disposables) d.dispose();
      root.traverse((o: Object3D) => {
        if (o instanceof InstancedMesh) o.dispose();
      });
    },
  };
}
export type TrailVisual = ReturnType<typeof trailVisual>;
