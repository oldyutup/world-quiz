import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { PropLayout } from "../../../../shared/party-lab/maps/propHuntLayout";
import { PROP_FAMILIES, type PropFamilyId } from "../../../../shared/party-lab/maps/propHuntProps";
import { buildDecoyGeometry, fallbackFamilyGeometry, familyGeometry, PROP_MATERIAL, type PropKit } from "./scenery";

const ZERO = new Matrix4().makeScale(0, 0, 0);
const FLAT = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
/** Seconds a tracer, a muzzle flash, an impact puff and a reveal burst last. */
const TRACER = 0.12,
  FLASH = 0.06,
  PUFF = 0.55,
  BURST = 0.9;
export const SEEKER_ORANGE = "#ff7a2f";
export const HIDER_TEAL = "#3fd0b6";
/** The result's reveal of the hiders still hidden: a gold outline and a column of light. */
export const REVEAL_GOLD = "#ffd84a";
/** A hider revealed in plain body (never disguised): a standing column the body's size. */
const BODY_GLOW = new CylinderGeometry(0.5, 0.5, 1.95, 16).translate(0, 0.975, 0);

/** The seeker's toy blaster (generated): a chunky orange body, a teal barrel, a dark grip. Forward is +z; bottom-centre at the grip. */
function blasterGeometry() {
  const tint = (g: BufferGeometry, hex: string) => {
    const plain = g.toNonIndexed(),
      count = plain.getAttribute("position").count,
      colors = new Float32Array(count * 3),
      c = new Color(hex);
    for (let i = 0; i < count; i++) c.toArray(colors, i * 3);
    plain.setAttribute("color", new Float32BufferAttribute(colors, 3));
    g.dispose();
    return plain;
  };
  const body = tint(new BoxGeometry(0.16, 0.18, 0.42).translate(0, 0.19, 0.05), SEEKER_ORANGE),
    barrel = tint(new CylinderGeometry(0.05, 0.06, 0.3, 10).rotateX(Math.PI / 2).translate(0, 0.21, 0.4), "#2bb5a0"),
    tip = tint(new CylinderGeometry(0.07, 0.07, 0.05, 10).rotateX(Math.PI / 2).translate(0, 0.21, 0.56), "#f4f1e8"),
    grip = tint(new BoxGeometry(0.1, 0.2, 0.1).rotateX(-0.25).translate(0, 0.07, -0.06), "#3a3440"),
    tank = tint(new SphereGeometry(0.075, 10, 8).translate(0, 0.32, -0.02), "#ffd05a");
  const g = mergeGeometries([body, barrel, tip, grip, tank], false)!;
  [body, barrel, tip, grip, tank].forEach((x) => x.dispose());
  return g;
}
/** Muzzle distance ahead of the grip along +z (m). */
export const BLASTER_MUZZLE = 0.6;
/** The blaster's size as a first-person view model (it sits a hand's length from the eye). */
export const VIEW_MODEL_SCALE = 0.42;

/**
 * Saklambaç's per-frame presentation: the round's decoys (one merged mesh, rebuilt when a new
 * layout is dealt), the disguised hiders' props (the decoys' own geometry and material, so they
 * read identically), contact shadows under bodies, the ring under the decoy a hider would copy,
 * the seeker's blaster, tracers, muzzle flashes, impact puffs and the burst when a hider is
 * found. No physics, no shadows.
 */
export class PropVisuals {
  readonly group = new Group();
  private kit: PropKit | null = null;
  /** The round's decoys, and what they were built from (a layout and whether the kit was in). */
  readonly decoys = new Mesh(new BufferGeometry(), PROP_MATERIAL);
  private decoysOf: { layout: PropLayout | null; kit: boolean } = { layout: null, kit: false };
  private readonly disguises: Mesh[];
  /** The local player's own disguise draws with its own material so it can fade near the camera. */
  private readonly ownMaterial = new MeshLambertMaterial({ vertexColors: true });
  private readonly shadows: InstancedMesh;
  private readonly ring: Mesh;
  readonly blaster: Mesh;
  /** The blaster is the first-person view model (drawn last, over the world). */
  private viewModel = false;
  private readonly tracers: { mesh: Mesh; age: number }[] = [];
  private readonly flashes: { mesh: Mesh; age: number }[] = [];
  private readonly puffs: InstancedMesh;
  /** Per slot: the result's reveal (an outline shell, a see-through fill and a light column). */
  private readonly reveals: { shell: Mesh; fill: Mesh; beam: Mesh; family: PropFamilyId | null | undefined; kit: boolean }[];
  private readonly revealShell = new MeshBasicMaterial({ color: REVEAL_GOLD, side: BackSide, transparent: true, depthTest: false, depthWrite: false });
  private readonly revealFill = new MeshBasicMaterial({ color: "#ffe98a", transparent: true, opacity: 0.3, depthTest: false, depthWrite: false });
  private readonly revealBeam = new MeshBasicMaterial({ color: REVEAL_GOLD, transparent: true, opacity: 0.25, blending: AdditiveBlending, depthTest: false, depthWrite: false });
  private readonly revealGeometry = new Map<string, BufferGeometry>();
  private readonly particles: { p: Vector3; v: Vector3; age: number; life: number; size: number; color: Color }[] = [];
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly v = new Vector3();
  private readonly s = new Vector3();

  constructor() {
    this.group.name = "prop-visuals";
    this.decoys.name = "prop-decoys";
    this.decoys.matrixAutoUpdate = false;
    this.group.add(this.decoys);
    this.disguises = [0, 1, 2].map(() => {
      const mesh = new Mesh(new BufferGeometry(), PROP_MATERIAL);
      mesh.visible = false;
      mesh.matrixAutoUpdate = true;
      this.group.add(mesh);
      return mesh;
    });
    this.shadows = new InstancedMesh(new CircleGeometry(0.42, 20), new MeshBasicMaterial({ color: 0x1b2430, transparent: true, opacity: 0.24, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }), 3);
    this.shadows.instanceMatrix.setUsage(DynamicDrawUsage);
    this.shadows.frustumCulled = false;
    this.shadows.renderOrder = 2;
    for (let i = 0; i < 3; i++) this.shadows.setMatrixAt(i, ZERO);
    this.ring = new Mesh(new RingGeometry(0.9, 1, 40).applyQuaternion(FLAT), new MeshBasicMaterial({ color: "#fff3b0", transparent: true, opacity: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }));
    this.ring.visible = false;
    this.ring.renderOrder = 3;
    this.blaster = new Mesh(blasterGeometry(), new MeshLambertMaterial({ vertexColors: true, emissive: 0x331a00, emissiveIntensity: 0.4 }));
    this.blaster.visible = false;
    const puffMaterial = new MeshBasicMaterial({ vertexColors: false, transparent: true, depthWrite: false });
    this.puffs = new InstancedMesh(new IcosahedronGeometry(1, 0), puffMaterial, 96);
    this.puffs.instanceMatrix.setUsage(DynamicDrawUsage);
    this.puffs.frustumCulled = false;
    for (let i = 0; i < 96; i++) {
      this.puffs.setMatrixAt(i, ZERO);
      this.puffs.setColorAt(i, new Color("#ffffff"));
    }
    this.group.add(this.shadows, this.ring, this.blaster, this.puffs);
    this.reveals = [0, 1, 2].map(() => {
      const shell = new Mesh(new BufferGeometry(), this.revealShell),
        fill = new Mesh(new BufferGeometry(), this.revealFill),
        beam = new Mesh(new CylinderGeometry(0.16, 0.16, 7, 10, 1, true).translate(0, 3.5, 0), this.revealBeam);
      shell.renderOrder = 21;
      fill.renderOrder = 22;
      beam.renderOrder = 20;
      for (const m of [shell, fill, beam]) {
        m.visible = false;
        m.frustumCulled = false;
        this.group.add(m);
      }
      return { shell, fill, beam, family: undefined as PropFamilyId | null | undefined, kit: false };
    });
  }
  /** A family's (or a body's) shape grown by `scale` about its middle, for the reveal (built once, cached). */
  private revealShape(family: PropFamilyId | null, scale: number) {
    const key = `${family ?? "body"}|${scale}|${this.kit ? 1 : 0}`;
    let g = this.revealGeometry.get(key);
    if (!g) {
      const base = family ? this.geometryFor(family) : BODY_GLOW;
      g = base.clone();
      g.computeBoundingBox();
      const c = g.boundingBox!.getCenter(new Vector3());
      g.translate(-c.x, -c.y, -c.z).scale(scale, scale, scale).translate(c.x, c.y, c.z);
      if (family && !this.kit) base.dispose();
      this.revealGeometry.set(key, g);
    }
    return g;
  }
  /**
   * The result's reveal of a hider still hidden (`family` undefined: none for this slot): its prop
   * (or its body) outlined in pulsing gold and filled faintly, seen through walls and roofs — the
   * round is over — with a column of light over it.
   */
  setReveal(slot: number, family: PropFamilyId | null | undefined, at: Vector3 | null, yaw: number, time: number) {
    const r = this.reveals[slot];
    if (family === undefined || !at) {
      r.shell.visible = r.fill.visible = r.beam.visible = false;
      return;
    }
    if (r.family !== family || r.kit !== !!this.kit) {
      r.shell.geometry = this.revealShape(family, 1.2);
      r.fill.geometry = this.revealShape(family, 1.0);
      r.family = family;
      r.kit = !!this.kit;
    }
    for (const m of [r.shell, r.fill]) {
      m.position.copy(at);
      m.rotation.set(0, yaw, 0);
      m.visible = true;
    }
    r.beam.position.copy(at);
    r.beam.visible = true;
    const pulse = 0.5 + 0.5 * Math.sin(time * 5);
    this.revealShell.opacity = 0.65 + 0.35 * pulse;
    this.revealFill.opacity = 0.3 + 0.25 * pulse;
    this.revealBeam.opacity = 0.2 + 0.15 * pulse;
  }
  setKit(kit: PropKit | null) {
    this.kit = kit;
  }
  /** Draws a layout's decoys (rebuilt only when the layout, or whether the kit is in, changes; ~ms at a round's start). */
  setDecoys(layout: PropLayout) {
    if (this.decoysOf.layout === layout && this.decoysOf.kit === !!this.kit) return;
    this.decoys.geometry.dispose();
    this.decoys.geometry = buildDecoyGeometry(this.kit, layout.decoys);
    this.decoysOf = { layout, kit: !!this.kit };
  }
  private geometryFor(family: PropFamilyId) {
    return this.kit ? familyGeometry(this.kit, family) : fallbackFamilyGeometry(family);
  }
  /**
   * A slot's disguise this frame (null: none). `own`: the local player's (fades by `opacity`).
   * Family changes swap the geometry; fallback geometries are disposed when replaced.
   */
  setDisguise(slot: number, family: PropFamilyId | null, at: Vector3 | null, yaw: number, own: boolean, opacity = 1) {
    const mesh = this.disguises[slot];
    if (!family || !at) {
      mesh.visible = false;
      return;
    }
    if (mesh.userData.family !== family || mesh.userData.kit !== !!this.kit) {
      if (!mesh.userData.kit && mesh.userData.family) mesh.geometry.dispose();
      mesh.geometry = this.geometryFor(family);
      mesh.userData.family = family;
      mesh.userData.kit = !!this.kit;
    }
    const fade = own && opacity < 0.999;
    const material = fade ? this.ownMaterial : PROP_MATERIAL;
    if (mesh.material !== material) mesh.material = material;
    if (fade) {
      this.ownMaterial.transparent = true;
      this.ownMaterial.depthWrite = false;
      this.ownMaterial.opacity = opacity;
    }
    mesh.position.copy(at);
    mesh.rotation.set(0, yaw, 0);
    mesh.visible = true;
  }
  /** Contact shadow per slot at its feet (null: none). */
  setShadow(slot: number, feet: Vector3 | null) {
    if (!feet) this.shadows.setMatrixAt(slot, ZERO);
    else this.shadows.setMatrixAt(slot, this.m.compose(this.v.set(feet.x, feet.y + 0.012, feet.z), FLAT, this.s.set(1, 1, 1)));
    this.shadows.instanceMatrix.needsUpdate = true;
  }
  /** The ring under the decoy a hider would copy now (null: none), sized to its footprint. */
  setTarget(at: Vector3 | null, family: PropFamilyId | null, time: number) {
    if (!at || !family) {
      this.ring.visible = false;
      return;
    }
    const shape = PROP_FAMILIES[family].shape,
      r = shape.kind === "cylinder" ? shape.radius + 0.18 : Math.hypot(shape.x, shape.z) / 2 + 0.12;
    this.ring.position.set(at.x, at.y + 0.02, at.z);
    this.ring.scale.setScalar(r * (1 + 0.04 * Math.sin(time * 6)));
    (this.ring.material as MeshBasicMaterial).opacity = 0.45 + 0.25 * (0.5 + 0.5 * Math.sin(time * 6));
    this.ring.visible = true;
  }
  /** The blaster in the seeker's hand (null: hidden), pointing along `aim`. */
  setBlaster(grip: Vector3 | null, aim: Quaternion, kick: number) {
    if (!grip) {
      this.blaster.visible = false;
      return;
    }
    this.blaster.visible = true;
    this.blaster.position.copy(grip);
    this.blaster.quaternion.copy(aim);
    this.blaster.translateZ(-0.12 * kick);
    this.blaster.rotateX(-0.35 * kick);
  }
  /**
   * First person: the blaster becomes a view model — drawn after everything else with the depth
   * cleared first (so a wall right in front of the camera never cuts into it), a little smaller.
   * Third person: an ordinary object in the seeker's hand again.
   */
  setViewModel(on: boolean) {
    if (this.viewModel === on) return;
    this.viewModel = on;
    const material = this.blaster.material as MeshLambertMaterial;
    // Transparent (at full opacity) sorts it into the last pass, after every opaque and see-through thing.
    material.transparent = on;
    material.needsUpdate = true;
    this.blaster.renderOrder = on ? 1000 : 0;
    this.blaster.scale.setScalar(on ? VIEW_MODEL_SCALE : 1);
    this.blaster.onBeforeRender = on ? (renderer) => renderer.clearDepth() : () => {};
  }
  /** A shot: a tracer from the muzzle to where it stopped, a flash at the muzzle, a puff where it hit. */
  shot(muzzle: Vector3, end: Vector3, hit: "hider" | "decoy" | "world" | "none") {
    const length = muzzle.distanceTo(end);
    if (length > 0.05) {
      const tracer = new Mesh(new CylinderGeometry(0.025, 0.025, 1, 6, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2), new MeshBasicMaterial({ color: "#fff1a8", transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false }));
      tracer.position.copy(muzzle);
      tracer.lookAt(end);
      tracer.scale.set(1, 1, length);
      this.group.add(tracer);
      this.tracers.push({ mesh: tracer, age: 0 });
    }
    const flash = new Mesh(new SphereGeometry(0.12, 10, 8), new MeshBasicMaterial({ color: "#ffd27a", transparent: true, opacity: 1, blending: AdditiveBlending, depthWrite: false }));
    flash.position.copy(muzzle);
    this.group.add(flash);
    this.flashes.push({ mesh: flash, age: 0 });
    if (hit === "decoy") this.puff(end, "#c79b6a", 10, 1.6, 0.07);
    else if (hit === "world") this.puff(end, "#d9d2c4", 7, 1.2, 0.06);
  }
  /** A found hider: a big white-and-teal burst at the prop (or body). */
  reveal(at: Vector3) {
    this.puff(this.v.copy(at).add(this.s.set(0, 0.6, 0)), "#ffffff", 26, 3.4, 0.16, BURST);
    this.puff(this.v.copy(at).add(this.s.set(0, 0.9, 0)), HIDER_TEAL, 14, 4.2, 0.08, BURST);
  }
  /** A disguise appearing or dropping: a small soft puff. */
  poof(at: Vector3) {
    this.puff(this.v.copy(at).add(this.s.set(0, 0.35, 0)), "#f4f1e8", 12, 1.5, 0.12, 0.45);
  }
  private puff(at: Vector3, hex: string, count: number, speed: number, size: number, life = PUFF) {
    const color = new Color(hex);
    for (let k = 0; k < count; k++) {
      if (this.particles.length >= 96) this.particles.shift();
      const a = Math.random() * Math.PI * 2,
        up = Math.random() * 0.8 + 0.2,
        s = speed * (0.4 + Math.random() * 0.6);
      this.particles.push({ p: at.clone(), v: new Vector3(Math.cos(a) * s * (1 - up * 0.5), up * s, Math.sin(a) * s * (1 - up * 0.5)), age: 0, life: life * (0.7 + Math.random() * 0.5), size: size * (0.6 + Math.random() * 0.8), color });
    }
  }
  update(dt: number) {
    for (let k = this.tracers.length - 1; k >= 0; k--) {
      const t = this.tracers[k];
      t.age += dt;
      (t.mesh.material as MeshBasicMaterial).opacity = Math.max(0, 0.9 * (1 - t.age / TRACER));
      if (t.age >= TRACER) {
        this.group.remove(t.mesh);
        t.mesh.geometry.dispose();
        (t.mesh.material as MeshBasicMaterial).dispose();
        this.tracers.splice(k, 1);
      }
    }
    for (let k = this.flashes.length - 1; k >= 0; k--) {
      const f = this.flashes[k];
      f.age += dt;
      f.mesh.scale.setScalar(1 + f.age * 12);
      (f.mesh.material as MeshBasicMaterial).opacity = Math.max(0, 1 - f.age / FLASH);
      if (f.age >= FLASH) {
        this.group.remove(f.mesh);
        f.mesh.geometry.dispose();
        (f.mesh.material as MeshBasicMaterial).dispose();
        this.flashes.splice(k, 1);
      }
    }
    let i = 0;
    for (let k = this.particles.length - 1; k >= 0; k--) {
      const p = this.particles[k];
      p.age += dt;
      if (p.age >= p.life) {
        this.particles.splice(k, 1);
        continue;
      }
      p.v.y -= 6 * dt;
      p.v.multiplyScalar(Math.exp(-2.5 * dt));
      p.p.addScaledVector(p.v, dt);
    }
    for (const p of this.particles) {
      const k = 1 - p.age / p.life;
      this.puffs.setMatrixAt(i, this.m.compose(p.p, this.q.identity(), this.s.setScalar(p.size * (0.6 + 0.6 * k))));
      this.puffs.setColorAt(i, p.color);
      i++;
    }
    for (; i < 96; i++) this.puffs.setMatrixAt(i, ZERO);
    this.puffs.instanceMatrix.needsUpdate = true;
    if (this.puffs.instanceColor) this.puffs.instanceColor.needsUpdate = true;
    (this.puffs.material as MeshBasicMaterial).opacity = 0.85;
  }
  clear() {
    for (const t of [...this.tracers, ...this.flashes]) {
      this.group.remove(t.mesh);
      t.mesh.geometry.dispose();
      (t.mesh.material as MeshBasicMaterial).dispose();
    }
    this.tracers.length = this.flashes.length = this.particles.length = 0;
    for (const mesh of this.disguises) mesh.visible = false;
    for (const r of this.reveals) r.shell.visible = r.fill.visible = r.beam.visible = false;
    this.ring.visible = false;
  }
  dispose() {
    this.clear();
    this.decoys.geometry.dispose();
    for (const mesh of this.disguises) if (!mesh.userData.kit && mesh.userData.family) mesh.geometry.dispose();
    this.shadows.geometry.dispose();
    (this.shadows.material as MeshBasicMaterial).dispose();
    this.ring.geometry.dispose();
    (this.ring.material as MeshBasicMaterial).dispose();
    this.blaster.geometry.dispose();
    (this.blaster.material as MeshLambertMaterial).dispose();
    this.puffs.geometry.dispose();
    (this.puffs.material as MeshBasicMaterial).dispose();
    this.ownMaterial.dispose();
    for (const g of this.revealGeometry.values()) g.dispose();
    for (const r of this.reveals) r.beam.geometry.dispose();
    this.revealShell.dispose();
    this.revealFill.dispose();
    this.revealBeam.dispose();
  }
}
