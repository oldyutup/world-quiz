import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from "three";
import type { BarnKit } from "./buildBarn";
import { HELD_SCALE, type BarnFrame, type HeldView } from "./barnView";
import type { WeaponKind } from "../../../../shared/party-lab/simulation/barn/weapons";

/** Kit models point along −X with the grip at the origin; this turns −X onto +Z (the aim). */
const MODEL_TO_AIM = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
const KINDS: readonly WeaponKind[] = ["shotgun", "smg"];
const NODE: Readonly<Record<WeaponKind, "Shotgun" | "Smg">> = { shotgun: "Shotgun", smg: "Smg" };

/**
 * Weapons in hand: a visual only — no collider, no mass, never touching the ragdoll.
 * Each sits beside the torso at the gun hand and points along the aim, pushed back briefly by
 * recoil. Kit geometry/materials belong to the loader cache and are not disposed here.
 */
export function createHeldWeapons(kit: BarnKit, players: number) {
  const group = new Group();
  group.name = "held-weapons";
  const slots = Array.from({ length: players }, () => {
    const models = Object.fromEntries(
      KINDS.map((kind) => {
        const model = new Group();
        for (const part of kit[NODE[kind]]) model.add(new Mesh(part.geometry, part.material));
        model.scale.setScalar(HELD_SCALE);
        model.visible = false;
        group.add(model);
        return [kind, model];
      })
    ) as Record<WeaponKind, Group>;
    return models;
  });
  const back = new Vector3();
  return {
    group,
    update(held: readonly HeldView[]) {
      held.forEach((view, i) => {
        const models = slots[i];
        if (!models) return;
        for (const kind of KINDS) {
          const model = models[kind],
            shown = view.kind === kind;
          model.visible = shown;
          if (!shown) continue;
          model.quaternion.copy(view.aim).multiply(MODEL_TO_AIM);
          back.set(0, 0, -0.18 * view.kick).applyQuaternion(view.aim);
          model.position.copy(view.grip).add(back);
        }
      });
    },
  };
}

interface Particle {
  life: number;
  age: number;
}
/** A fixed pool of additive instances; expired ones are scaled to nothing. */
function pool(geometry: BoxGeometry | IcosahedronGeometry, size: number, color: string) {
  const material = new MeshBasicMaterial({ color: "#ffffff", blending: AdditiveBlending, transparent: true, depthWrite: false, fog: false, toneMapped: false });
  const mesh = new InstancedMesh(geometry, material, size);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.visible = false;
  const hidden = new Matrix4().makeScale(0, 0, 0),
    base = new Color(color),
    faded = new Color();
  for (let i = 0; i < size; i++) {
    mesh.setMatrixAt(i, hidden);
    mesh.setColorAt(i, base);
  }
  const items: (Particle & { matrix: (k: number, out: Matrix4) => Matrix4; color: Color })[] = [];
  let next = 0;
  const m = new Matrix4();
  return {
    mesh,
    material,
    add(life: number, color: Color | null, matrix: (k: number, out: Matrix4) => Matrix4) {
      items[next] = { life, age: 0, matrix, color: color ?? base };
      next = (next + 1) % size;
    },
    update(dt: number) {
      let live = 0;
      for (let i = 0; i < size; i++) {
        const p = items[i];
        if (!p || p.age >= p.life) {
          mesh.setMatrixAt(i, hidden);
          continue;
        }
        live++;
        p.age += dt;
        const k = Math.min(1, p.age / p.life);
        mesh.setMatrixAt(i, p.age >= p.life ? hidden : p.matrix(k, m));
        // Additive: fading toward black is fading out.
        mesh.setColorAt(i, faded.copy(p.color).multiplyScalar((1 - k) ** 1.5));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // No draw call while nothing is flying.
      mesh.visible = live > 0;
    },
  };
}

const TRACER_COLOR = new Color("#ffd27a"),
  BODY_HIT = new Color("#ff5a3c"),
  WORLD_HIT = new Color("#d9c29a"),
  FLASH = new Color("#ffe3a6");

/**
 * Shot feedback kept deliberately simple for readability: a short-lived tracer per
 * pellet/round from the muzzle to where it stopped, a muzzle flash, and a puff where
 * it landed (warm red on a character, dusty on the barn). Up to three instanced draw
 * calls, none while nothing is in flight.
 */
export function createBarnEffects() {
  const group = new Group();
  group.name = "barn-effects";
  const unitBox = new BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
  const ball = new IcosahedronGeometry(1, 1);
  const tracers = pool(unitBox, 64, "#ffd27a"),
    flashes = pool(ball, 12, "#ffe3a6"),
    puffs = pool(ball, 48, "#d9c29a");
  for (const p of [tracers, flashes, puffs]) group.add(p.mesh);
  const Z = new Vector3(0, 0, 1),
    scale = new Vector3(),
    q = new Quaternion();
  return {
    group,
    update(frame: BarnFrame) {
      for (const shot of frame.shots) {
        const muzzle = shot.muzzle.clone();
        const flashSize = shot.kind === "shotgun" ? 0.32 : 0.2;
        flashes.add(shot.kind === "shotgun" ? 0.07 : 0.045, FLASH, (k, out) => out.compose(muzzle, q.identity(), scale.setScalar(flashSize * (1 - 0.5 * k))));
        for (const pellet of shot.pellets) {
          const end = new Vector3(pellet.end.x, pellet.end.y, pellet.end.z),
            direction = end.clone().sub(muzzle),
            length = direction.length();
          if (length < 0.05) continue;
          const turn = new Quaternion().setFromUnitVectors(Z, direction.divideScalar(length)),
            width = shot.kind === "shotgun" ? 0.022 : 0.032;
          tracers.add(shot.kind === "shotgun" ? 0.08 : 0.06, TRACER_COLOR, (k, out) => out.compose(muzzle, turn, scale.set(width * (1 - 0.5 * k), width * (1 - 0.5 * k), length)));
          if (pellet.target !== null || pellet.blocked) {
            const body = pellet.target !== null;
            puffs.add(body ? 0.22 : 0.3, body ? BODY_HIT : WORLD_HIT, (k, out) => out.compose(end, q.identity(), scale.setScalar((body ? 0.1 : 0.07) + 0.14 * k)));
          }
        }
      }
      for (const impact of frame.impacts) {
        const at = impact.point.clone(),
          size = impact.strong ? 0.2 : 0.12;
        puffs.add(0.25, impact.body ? BODY_HIT : WORLD_HIT, (k, out) => out.compose(at, q.identity(), scale.setScalar(size + 0.18 * k)));
      }
      tracers.update(frame.dt);
      flashes.update(frame.dt);
      puffs.update(frame.dt);
    },
    dispose() {
      unitBox.dispose();
      ball.dispose();
      for (const p of [tracers, flashes, puffs]) {
        p.material.dispose();
        p.mesh.dispose();
      }
    },
  };
}
