import {
  AdditiveBlending,
  BoxGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  TorusGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
} from "three";
import { PARTS, SHAPES } from "../../../../shared/party-lab/simulation/ragdoll/config";
import { beatAt, sectionOf, type SongSection } from "../../../../shared/party-lab/simulation/rhythm/song";
import { RHYTHM as R } from "../../../../shared/party-lab/simulation/rhythm/config";
import { createCharacterVisual } from "../visual/characterVisual";
import type { RhythmFrame, RhythmLook } from "./source";

/** The stage: where the dancers stand and how the camera frames them in the top part of the screen. */
export const STAGE = {
  spacing: 2.3,
  /** The dancers' height share of the screen, and the width that must fit (m). */
  heightShare: 0.3,
  fitWidth: 8.2,
  /** The dancers' middle sits this far from the top of the screen (a share of its height). */
  middleY: 0.27,
  fov: 28,
} as const;
/** A dancer's x. */
export const dancerX = (lane: number, count: number) => (lane - (count - 1) / 2) * STAGE.spacing;

/**
 * The fixed camera: far enough that a dancer (about 1.9 m) is `heightShare` of the screen and
 * `fitWidth` metres fit across, its view shifted so the dancers stand in the upper part (the
 * lanes take the lower part).
 */
export function fitRhythmCamera(camera: PerspectiveCamera, width: number, height: number) {
  const aspect = width / Math.max(1, height),
    tan = Math.tan((STAGE.fov * Math.PI) / 360);
  const distance = Math.max(1.9 / STAGE.heightShare / (2 * tan), STAGE.fitWidth / aspect / (2 * tan));
  camera.fov = STAGE.fov;
  camera.aspect = aspect;
  camera.near = 0.5;
  camera.far = 80;
  camera.position.set(0, 1.25, distance);
  camera.lookAt(0, 0.95, 0);
  camera.setViewOffset(width, height, 0, height * (0.5 - STAGE.middleY), width, height);
  camera.updateProjectionMatrix();
}

const FEET = 0.79;
const REST = PARTS.map((part) => ({ x: SHAPES[part].x, y: SHAPES[part].y + FEET, z: 0 }));
const I = Object.fromEntries(PARTS.map((p, i) => [p, i])) as Record<(typeof PARTS)[number], number>;
/** A combo this long dances flat out. */
const FULL_COMBO = 24;
const STUMBLE_MS = 700;
const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};
/** Lights by part of the song. */
const SECTION_GLOW: Readonly<Record<SongSection, number>> = { intro: 0.35, main: 0.6, lift: 0.85, finale: 1, end: 0.7 };

interface PartGoal {
  x: number;
  y: number;
  z: number;
  rx: number;
  rz: number;
}
/**
 * A dancer's goal pose at `beat` with `energy` (0 a gentle sway, 1 flat out: hops, arms up),
 * mixed with a stumble (`trip` 0–1 through it). Parts as in the ragdoll, feet on the floor.
 */
export function dancePose(beat: number, energy: number, trip: number, side: number) {
  const e = Math.max(0, Math.min(1, energy)),
    swing = Math.sin(Math.PI * beat),
    hop = Math.abs(swing),
    nod = Math.sin(2 * Math.PI * beat);
  const parts: PartGoal[] = REST.map((p) => ({ ...p, rx: 0, rz: 0 }));
  const set = (part: (typeof PARTS)[number], g: Partial<PartGoal>) => Object.assign(parts[I[part]], g);
  // Head nods on every beat, more as the combo grows.
  set("head", { y: REST[I.head].y + 0.025 * nod * (0.5 + e), z: 0.04 * Math.max(0, nod) * (0.4 + e), rx: 0.1 * Math.max(0, nod) * (0.5 + e) });
  // Arms: a sway, then punches up in turn, then both up and pumping.
  const groove = Math.max(0, Math.min(1, (e - 0.25) / 0.35)),
    wild = Math.max(0, Math.min(1, (e - 0.65) / 0.3));
  const arm = (hand: "leftHand" | "rightHand", upper: "leftUpper" | "rightUpper", s: number) => {
    const up = Math.max(0, s * swing);
    const calm = { hx: s * 0.47 + 0.05 * swing, hy: REST[I[hand]].y + 0.05 * up, hz: 0.06 };
    const punch = { hx: s * 0.42, hy: REST[I[hand]].y + 0.75 * up + 0.12, hz: 0.25 };
    const cheer = { hx: s * 0.66, hy: 1.12 + FEET + 0.12 * hop, hz: 0.04 };
    const mix = (a: number, b: number, c: number) => a + (b - a) * groove + (c - (a + (b - a) * groove)) * wild;
    const hx = mix(calm.hx, punch.hx, cheer.hx),
      hy = mix(calm.hy, punch.hy, cheer.hy),
      hz = mix(calm.hz, punch.hz, cheer.hz);
    set(hand, { x: hx, y: hy, z: hz, rz: -s * 0.5 * wild });
    set(upper, { x: (REST[I[upper]].x + hx) / 2 + s * 0.05, y: (REST[I[upper]].y + hy) / 2 + 0.12, z: hz / 2, rz: -s * (0.15 + 0.35 * wild) });
  };
  arm("leftHand", "leftUpper", -side);
  arm("rightHand", "rightUpper", side);
  // Steps: one leg then the other.
  set("leftLeg", { y: REST[I.leftLeg].y + 0.07 * Math.max(0, swing) * (0.3 + e) });
  set("rightLeg", { y: REST[I.rightLeg].y + 0.07 * Math.max(0, -swing) * (0.3 + e) });
  let lift = 0.035 * (0.35 + e) * hop + 0.2 * wild * hop,
    tilt = 0.07 * swing * (0.5 + e),
    lean = 0,
    twist = 0.25 * wild * Math.sin((Math.PI * beat) / 2);
  // A stumble: thrown sideways and forward, arms out, head down, then back.
  if (trip > 0 && trip < 1) {
    const k = Math.sin(Math.PI * trip);
    for (const p of parts) p.y -= 0.04 * k;
    set("head", { y: parts[I.head].y - 0.1 * k, z: parts[I.head].z + 0.12 * k, rx: 0.4 * k });
    set("leftHand", { x: parts[I.leftHand].x - 0.35 * k, y: parts[I.leftHand].y + 0.45 * k });
    set("rightHand", { x: parts[I.rightHand].x + 0.35 * k, y: parts[I.rightHand].y + 0.45 * k });
    lift *= 1 - k;
    tilt = tilt * (1 - k) + 0.4 * k * side;
    lean = 0.3 * k;
    twist *= 1 - k;
  }
  return { parts, lift, tilt, lean, twist };
}
/** Winning: arms up, hopping; losing: head down, arms hanging. */
function endPose(won: boolean, t: number) {
  const parts: PartGoal[] = REST.map((p) => ({ ...p, rx: 0, rz: 0 }));
  if (won) {
    parts[I.leftHand] = { x: -0.7, y: 1.1 + FEET, z: 0.05, rx: 0, rz: 0.46 };
    parts[I.rightHand] = { x: 0.7, y: 1.1 + FEET, z: 0.05, rx: 0, rz: -0.46 };
    parts[I.leftUpper] = { x: -0.52, y: 0.7 + FEET, z: 0, rx: 0, rz: 0.46 };
    parts[I.rightUpper] = { x: 0.52, y: 0.7 + FEET, z: 0, rx: 0, rz: -0.46 };
    return { parts, lift: Math.max(0, Math.sin(Math.PI * ((t / 600) % 1))) * 0.4, tilt: 0, lean: 0, twist: 0 };
  }
  parts[I.head] = { ...parts[I.head], y: parts[I.head].y - 0.16, z: 0.12, rx: 0.35 };
  parts[I.torso] = { ...parts[I.torso], y: parts[I.torso].y - 0.05, z: 0.05 };
  parts[I.leftHand] = { ...parts[I.leftHand], y: parts[I.leftHand].y - 0.08, z: 0.1, rz: 0.15 };
  parts[I.rightHand] = { ...parts[I.rightHand], y: parts[I.rightHand].y - 0.08, z: 0.1, rz: -0.15 };
  return { parts, lift: 0, tilt: 0, lean: 0.08, twist: 0 };
}

/**
 * Ritim Ustası scenery: a small disco stage with the players' characters on it, an equaliser
 * wall and sweeping lights. The dancers move on the song's beats; a growing combo makes them
 * dance harder, a broken one makes them stumble; the winner cheers at the end.
 */
export function rhythmVisual(looks: readonly RhythmLook[], self: number) {
  const count = looks.length,
    root = new Group(),
    owned: BufferGeometry[] = [],
    materials: Material[] = [];
  const own = <T extends BufferGeometry>(g: T) => (owned.push(g), g);
  const mat = <T extends Material>(m: T) => (materials.push(m), m);

  // The stage and its glowing rim.
  const stage = new Mesh(own(new CylinderGeometry(5.6, 5.9, 0.36, 64)), mat(new MeshStandardMaterial({ color: "#2a2147", roughness: 0.55, metalness: 0.1 })));
  stage.position.y = -0.18;
  const rimMaterial = mat(new MeshBasicMaterial({ color: "#ff5fd2" }));
  const rim = new Mesh(own(new TorusGeometry(5.62, 0.05, 8, 96)), rimMaterial);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.005;
  const floorGlowMaterial = mat(new MeshBasicMaterial({ color: "#7a5cff", transparent: true, opacity: 0.18, blending: AdditiveBlending, depthWrite: false }));
  const floorGlow = new Mesh(own(new CircleGeometry(5.5, 64)), floorGlowMaterial);
  floorGlow.rotation.x = -Math.PI / 2;
  floorGlow.position.y = 0.01;
  root.add(stage, rim, floorGlow);

  // The back wall: dark, with an equaliser of glowing bars.
  const wall = new Mesh(own(new PlaneGeometry(30, 12)), mat(new MeshStandardMaterial({ color: "#151229", roughness: 0.9 })));
  wall.position.set(0, 4, -4.2);
  root.add(wall);
  const BARS = 24;
  const barMaterial = mat(new MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.85 }));
  const bars = new InstancedMesh(own(new BoxGeometry(0.42, 1, 0.08)), barMaterial, BARS);
  const barColor = new Color();
  for (let i = 0; i < BARS; i++) bars.setColorAt(i, barColor.setHSL(0.78 - (i / BARS) * 0.62, 0.85, 0.6));
  bars.position.set(0, 0.35, -4.1);
  root.add(bars);
  const barHeights = new Float32Array(BARS);
  const m4 = new Matrix4();

  // Light beams sweeping from above.
  const beams = [0, 1, 2, 3].map((i) => {
    const material = mat(new MeshBasicMaterial({ color: ["#ff4fd8", "#4fc3ff", "#ffd84f", "#7dff8a"][i], transparent: true, opacity: 0.08, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }));
    const cone = new Mesh(own(new ConeGeometry(1.4, 8, 24, 1, true)), material);
    cone.geometry.translate(0, -4, 0);
    const pivot = new Group();
    pivot.position.set((i - 1.5) * 3.2, 7.6, -1.5);
    pivot.add(cone);
    root.add(pivot);
    return { pivot, material, phase: i * 1.7 };
  });

  // The dancers, each on a disc of their colour (this player's brighter).
  const people = looks.map((look, lane) => {
    const person = createCharacterVisual(look.color, look.costume);
    REST.forEach((p, index) => person.root.children[index].position.set(p.x, p.y, p.z));
    const x = dancerX(lane, count);
    person.root.position.set(x, 0, 0);
    const discMaterial = mat(new MeshBasicMaterial({ color: look.color, transparent: true, opacity: lane === self ? 0.6 : 0.3, blending: AdditiveBlending, depthWrite: false }));
    const disc = new Mesh(own(new CircleGeometry(0.85, 40)), discMaterial);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(x, 0.02, 0);
    const ringMaterial = mat(new MeshBasicMaterial({ color: look.color, transparent: true, opacity: lane === self ? 0.95 : 0.55 }));
    const ring = new Mesh(own(new TorusGeometry(0.9, lane === self ? 0.045 : 0.03, 8, 48)), ringMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, 0.03, 0);
    root.add(person.root, disc, ring);
    return { person, disc, discMaterial, ring, x, energy: 0, combo: 0, tripAt: -1e9, side: lane % 2 ? -1 : 1 };
  });
  const goal = new Vector3();

  return {
    root,
    update(frame: RhythmFrame, dt: number) {
      const t = frame.now,
        wire = frame.wire,
        playing = wire.phase === "playing" && t >= 0,
        beat = t >= 0 ? beatAt(t) : t / 1000,
        q = ((beat % 1) + 1) % 1,
        pulse = playing ? (1 - q) ** 3 : 0.2,
        section = playing ? sectionOf(Math.floor(beat / R.song.beatsPerBar)) : "intro",
        glow = SECTION_GLOW[section];
      rimMaterial.color.setHSL((0.86 + beat * 0.01) % 1, 0.9, 0.45 + 0.25 * pulse * glow);
      floorGlowMaterial.opacity = 0.1 + 0.18 * pulse * glow;
      for (let i = 0; i < BARS; i++) {
        const target = playing ? (0.4 + 2.6 * glow * hash(i * 13 + Math.floor(beat * 2)) * (0.5 + 0.5 * pulse)) * (1 - Math.abs(i - BARS / 2) / BARS) : 0.2;
        barHeights[i] += (target - barHeights[i]) * Math.min(1, dt * 14);
        m4.makeScale(1, Math.max(0.05, barHeights[i]), 1).setPosition((i - (BARS - 1) / 2) * 0.62, barHeights[i] / 2, 0);
        bars.setMatrixAt(i, m4);
      }
      bars.instanceMatrix.needsUpdate = true;
      beams.forEach((b) => {
        b.pivot.rotation.z = Math.sin(beat * 0.5 + b.phase) * 0.45;
        b.pivot.rotation.x = Math.cos(beat * 0.37 + b.phase) * 0.25;
        b.material.opacity = (0.04 + 0.08 * pulse) * glow;
      });

      const ended = wire.phase === "results";
      people.forEach((p, lane) => {
        const view = frame.lanes[lane],
          combo = view?.combo ?? 0;
        // A broken combo (of at least two) trips the dancer.
        if (p.combo >= 2 && combo === 0 && playing) p.tripAt = t;
        p.combo = combo;
        const target = playing ? Math.min(1, combo / FULL_COMBO) : 0;
        p.energy += (target - p.energy) * Math.min(1, dt * (target < p.energy ? 6 : 2.5));
        const trip = (t - p.tripAt) / STUMBLE_MS;
        const pose = ended ? endPose(frame.winner === lane, t + lane * 170) : dancePose(playing ? beat : t / 1000 + lane * 0.3, playing ? p.energy : 0, trip, p.side);
        const ease = Math.min(1, dt * 16);
        pose.parts.forEach((g, index) => {
          const part = p.person.root.children[index];
          part.position.lerp(goal.set(g.x, g.y, g.z), ease);
          part.rotation.x += (g.rx - part.rotation.x) * ease;
          part.rotation.z += (g.rz - part.rotation.z) * ease;
        });
        const r = p.person.root;
        r.position.y += (pose.lift - r.position.y) * ease;
        r.rotation.z += (pose.tilt - r.rotation.z) * ease;
        r.rotation.x += (pose.lean - r.rotation.x) * ease;
        r.rotation.y += (pose.twist - r.rotation.y) * ease;
        r.visible = !wire.out[lane];
        p.disc.visible = p.ring.visible = !wire.out[lane];
        p.discMaterial.opacity = (lane === frame.self ? 0.45 : 0.22) + 0.3 * pulse * (0.3 + p.energy);
      });
    },
    dispose() {
      people.forEach((p) => p.person.dispose());
      bars.dispose();
      owned.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
    },
  };
}
