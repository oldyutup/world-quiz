import {
  AdditiveBlending,
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
  TorusGeometry,
  Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { BOMB_TICKS } from "../../../../shared/party-lab/simulation/bomb/config";
import type { BombTrap } from "../../../../shared/party-lab/simulation/bomb/traps";
import { TRAP_MAT } from "./arena";
import type { BombKit } from "./scenery";

export const BOMB_RED = "#ff4b3a";
/** Seconds the blast's flash, shock ring and scorch mark last. */
const FLASH = 0.3,
  SHOCK = 0.55,
  SCORCH = 3;
/** Last seconds of the fuse in which the bomb glows red and swells. */
export const FUSE_PANIC = 3;
/** A slowed player's ring. */
export const TRAP_AMBER = "#ffb020";
/**
 * Trap jaws: they snap shut in SNAP s; they start opening REOPEN s before the trap is armed
 * again, so jaws that look open are always armed (never the other way round).
 */
const SNAP = 0.06,
  REOPEN = 0.3,
  /** The flash round a trap when it is armed again (s). */
  REARM_FLASH = 0.45;
/** A pass: the bomb arcs from the passer's head to the receiver's over this long (s), whichever side they stand. */
const HAND_OFF = 0.16;
/** Each trap's fixed turn (so the three don't look stamped). */
const TRAP_YAW = [0.35, -0.6, 1.15];

const ZERO = new Matrix4().makeScale(0, 0, 0);
const FLAT = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
const UP = new Vector3(0, 1, 0);

/** A stand-in bomb until the kit is in: a dark ball and a short fuse (bottom-centre pivot, like the kit's). */
function fallbackBomb() {
  const ball = new SphereGeometry(0.22, 16, 12).translate(0, 0.24, 0),
    cap = new CylinderGeometry(0.07, 0.08, 0.08, 10).translate(0, 0.49, 0),
    fuse = new CylinderGeometry(0.02, 0.02, 0.16, 6).translate(0, 0.6, 0);
  const g = mergeGeometries([ball.toNonIndexed(), cap.toNonIndexed(), fuse.toNonIndexed()], false)!;
  const count = g.getAttribute("position").count,
    colors = new Float32Array(count * 3),
    body = new Color("#27232e");
  for (let i = 0; i < count; i++) body.toArray(colors, i * 3);
  g.setAttribute("color", new Float32BufferAttribute(colors, 3));
  [ball, cap, fuse].forEach((x) => x.dispose());
  return g;
}
/** A stand-in trap until the kit is in: a steel ring of jaws over a base plate (bottom-centre pivot, like the kit's). */
function fallbackTrap() {
  const base = new CylinderGeometry(0.34, 0.38, 0.05, 20).translate(0, 0.025, 0),
    jaws = new TorusGeometry(0.33, 0.035, 6, 24).rotateX(Math.PI / 2).translate(0, 0.09, 0);
  const g = mergeGeometries([base.toNonIndexed(), jaws.toNonIndexed()], false)!;
  const count = g.getAttribute("position").count,
    colors = new Float32Array(count * 3),
    steel = new Color("#7d8694"),
    teeth = new Color("#e6eaef"),
    positions = g.getAttribute("position");
  for (let i = 0; i < count; i++) (positions.getY(i) > 0.06 ? teeth : steel).toArray(colors, i * 3);
  g.setAttribute("color", new Float32BufferAttribute(colors, 3));
  [base, jaws].forEach((x) => x.dispose());
  return g;
}
/** The highest point of a geometry (where the fuse's spark sits). */
function topPoint(g: BufferGeometry) {
  const p = g.getAttribute("position"),
    out = new Vector3(0, -Infinity, 0);
  for (let i = 0; i < p.count; i++) if (p.getY(i) > out.y) out.set(p.getX(i), p.getY(i), p.getZ(i));
  return out;
}

export interface CarrierView {
  /** Head top and feet (floor under the body) of the carrier, drawn positions. */
  head: Vector3;
  feet: Vector3;
  /** The fuse is burning (pending: the next carrier, unlit). */
  lit: boolean;
  /** Seconds left on the fuse. */
  fuse: number;
}

/**
 * Bomba Sende's per-frame presentation: contact shadows, the bomb over the carrier's head
 * (the kit's model, a spark at the fuse while it burns; red glow and a swell in the last 3 s;
 * unlit and still over the next carrier while the fuse waits), a red ring round the carrier's
 * feet, a white ring round a player the carrier cannot tag back, the blast (a flash, a
 * shock ring, a scorch mark), and the slow traps (updateTraps). All unlit basic/Lambert, no
 * lights or particles; hidden meshes cost no draw call.
 */
export class BombVisuals {
  readonly group = new Group();
  private readonly shadows: InstancedMesh;
  private readonly ring: Mesh;
  private readonly shield: Mesh;
  private readonly bomb = new Group();
  private readonly bombMesh: Mesh;
  private readonly bombMaterial: MeshLambertMaterial;
  private readonly spark: Mesh;
  private readonly sparkAt = new Vector3();
  private readonly fallback: BufferGeometry;
  private readonly flash: Mesh;
  private readonly shock: Mesh;
  private readonly scorch: Mesh;
  private blastAge = Infinity;
  private scorchAge = Infinity;
  private handOffAge = Infinity;
  private readonly handOffFrom = new Vector3();
  private readonly m = new Matrix4();
  private readonly v = new Vector3();
  private readonly s = new Vector3();
  private readonly q = new Quaternion();
  private readonly traps: InstancedMesh;
  private readonly trapFallback: BufferGeometry;
  /** Armed traps' rim glow (and the flash when one is armed again). */
  private readonly trapGlow: InstancedMesh;
  /** A shut trap's rearm progress round its rim. */
  private readonly rearm: Mesh[] = [];
  private readonly trapWasArmed: boolean[] = [];
  private readonly trapFlash: number[] = [];
  /** Each slowed player's ring at their feet, with the slow left as an arc. */
  private readonly slows: Mesh[] = [];
  private readonly tint = new Color();

  constructor() {
    this.group.name = "bomb-visuals";
    this.shadows = new InstancedMesh(new CircleGeometry(0.42, 20), new MeshBasicMaterial({ color: 0x1b2430, transparent: true, opacity: 0.24, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }), 3);
    this.shadows.instanceMatrix.setUsage(DynamicDrawUsage);
    this.shadows.frustumCulled = false;
    this.shadows.renderOrder = 2;
    for (let i = 0; i < 3; i++) this.shadows.setMatrixAt(i, ZERO);
    const flatRing = (inner: number, outer: number, color: string, opacity: number) => {
      const mesh = new Mesh(new RingGeometry(inner, outer, 40), new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }));
      mesh.quaternion.copy(FLAT);
      mesh.renderOrder = 3;
      mesh.visible = false;
      return mesh;
    };
    this.ring = flatRing(0.52, 0.7, BOMB_RED, 0.9);
    this.shield = flatRing(0.55, 0.64, "#ffffff", 0.85);
    this.fallback = fallbackBomb();
    this.bombMaterial = new MeshLambertMaterial({ vertexColors: true, emissive: new Color(BOMB_RED), emissiveIntensity: 0 });
    this.bombMesh = new Mesh(this.fallback, this.bombMaterial);
    this.spark = new Mesh(new IcosahedronGeometry(0.07, 0), new MeshBasicMaterial({ color: "#ffd34d" }));
    this.sparkAt.copy(topPoint(this.fallback));
    this.bomb.add(this.bombMesh, this.spark);
    this.bomb.visible = false;
    this.flash = new Mesh(new IcosahedronGeometry(1, 2), new MeshBasicMaterial({ color: "#ffb347", transparent: true, depthWrite: false }));
    this.flash.visible = false;
    this.shock = flatRing(0.88, 1, "#fff1d6", 0.9);
    this.scorch = new Mesh(new CircleGeometry(1.1, 24), new MeshBasicMaterial({ color: 0x241c1a, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
    this.scorch.quaternion.copy(FLAT);
    this.scorch.visible = false;
    this.group.add(this.shadows, this.ring, this.shield, this.bomb, this.flash, this.shock, this.scorch);
    // ── Slow traps ──
    this.trapFallback = fallbackTrap();
    this.traps = new InstancedMesh(this.trapFallback, new MeshLambertMaterial({ vertexColors: true }), 3);
    this.traps.instanceMatrix.setUsage(DynamicDrawUsage);
    this.traps.frustumCulled = false;
    this.trapGlow = new InstancedMesh(
      new RingGeometry(TRAP_MAT.inner, TRAP_MAT.outer, 40).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: "#ffffff", blending: AdditiveBlending, transparent: true, depthWrite: false, fog: false, toneMapped: false }),
      3
    );
    this.trapGlow.instanceMatrix.setUsage(DynamicDrawUsage);
    this.trapGlow.frustumCulled = false;
    this.trapGlow.renderOrder = 3;
    for (let i = 0; i < 3; i++) {
      this.traps.setMatrixAt(i, ZERO);
      this.traps.setColorAt(i, this.tint.setRGB(1, 1, 1));
      this.trapGlow.setMatrixAt(i, ZERO);
      this.trapGlow.setColorAt(i, this.tint.setRGB(0, 0, 0));
      const arc = new Mesh(
        new RingGeometry(TRAP_MAT.inner, TRAP_MAT.outer, 48, 1, Math.PI / 2, Math.PI * 2),
        new MeshBasicMaterial({ color: "#f4f6f8", transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 })
      );
      arc.quaternion.copy(FLAT);
      arc.renderOrder = 3;
      arc.visible = false;
      this.rearm.push(arc);
      const slow = new Mesh(
        // Outside the carrier's red ring (0.52–0.7 m) and the protected player's white one.
        new RingGeometry(0.8, 0.92, 40, 1, Math.PI / 2, Math.PI * 2),
        new MeshBasicMaterial({ color: TRAP_AMBER, transparent: true, opacity: 0.95, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 })
      );
      slow.quaternion.copy(FLAT);
      slow.renderOrder = 4;
      slow.visible = false;
      this.slows.push(slow);
      this.trapWasArmed.push(true);
      this.trapFlash.push(Infinity);
    }
    this.group.add(this.traps, this.trapGlow, ...this.rearm, ...this.slows);
  }
  /** The kit's bomb model (null: the stand-in). */
  setKit(kit: BombKit | null) {
    const geometry = kit?.Bomb ?? this.fallback;
    this.bombMesh.geometry = geometry;
    this.sparkAt.copy(topPoint(geometry));
    this.traps.geometry = kit?.BearTrap ?? this.trapFallback;
  }
  /** Contact shadow per slot at its feet (null: none). */
  setShadow(slot: number, feet: Vector3 | null) {
    if (!feet) this.shadows.setMatrixAt(slot, ZERO);
    else this.shadows.setMatrixAt(slot, this.m.compose(this.v.set(feet.x, feet.y + 0.01, feet.z), FLAT, this.s.set(1, 1, 1)));
    this.shadows.instanceMatrix.needsUpdate = true;
  }
  /** The bomb just changed hands: it arcs over from `from` (the passer's head top) to the new carrier. */
  handOff(from: Vector3) {
    this.handOffFrom.copy(from);
    this.handOffAge = 0;
  }
  /** A blast at the carrier's feet. */
  explode(at: Vector3, floor: number) {
    this.blastAge = this.scorchAge = 0;
    this.flash.position.set(at.x, at.y + 0.9, at.z);
    this.shock.position.set(at.x, floor + 0.03, at.z);
    this.scorch.position.set(at.x, floor + 0.012, at.z);
  }
  update(time: number, dt: number, carrier: CarrierView | null, immune: Vector3 | null) {
    // ── The bomb over the carrier's head ──
    this.bomb.visible = !!carrier;
    this.ring.visible = !!carrier;
    if (carrier) {
      const panic = carrier.lit ? Math.max(0, Math.min(1, (FUSE_PANIC - carrier.fuse) / FUSE_PANIC)) : 0;
      const beat = carrier.lit ? 0.5 + 0.5 * Math.sin(time * (7 + 14 * panic)) : 0;
      this.bomb.position.set(carrier.head.x, carrier.head.y + 0.28 + 0.05 * Math.sin(time * 4), carrier.head.z);
      this.handOffAge += dt;
      if (this.handOffAge < HAND_OFF) {
        const k = this.handOffAge / HAND_OFF,
          ease = k * k * (3 - 2 * k);
        this.v.set(this.handOffFrom.x, this.handOffFrom.y + 0.28, this.handOffFrom.z).lerp(this.bomb.position, ease);
        this.bomb.position.set(this.v.x, this.v.y + 0.35 * Math.sin(Math.PI * k), this.v.z);
      }
      this.bomb.rotation.y = time * 1.4;
      this.bomb.scale.setScalar(1 + panic * 0.18 * beat);
      this.bombMaterial.emissiveIntensity = panic * (0.35 + 0.5 * beat);
      this.spark.visible = carrier.lit;
      this.spark.position.copy(this.sparkAt);
      this.spark.scale.setScalar(0.8 + 0.6 * Math.abs(Math.sin(time * 31)) + 0.4 * panic);
      this.ring.position.set(carrier.feet.x, carrier.feet.y + 0.02, carrier.feet.z);
      const ringScale = carrier.lit ? 1 + 0.08 * beat : 0.9;
      this.ring.scale.set(ringScale, ringScale, 1);
      (this.ring.material as MeshBasicMaterial).opacity = carrier.lit ? 0.9 : 0.45;
    }
    this.shield.visible = !!immune;
    if (immune) {
      this.shield.position.set(immune.x, immune.y + 0.025, immune.z);
      (this.shield.material as MeshBasicMaterial).opacity = 0.55 + 0.3 * Math.sin(time * 18);
    }
    // ── The blast ──
    this.blastAge += dt;
    this.scorchAge += dt;
    const f = this.blastAge / FLASH;
    this.flash.visible = f < 1;
    if (f < 1) {
      // A quick puff, not a wall: the body's flight and the shock ring stay readable through it.
      this.flash.scale.setScalar(0.3 + 2.1 * Math.sqrt(f));
      (this.flash.material as MeshBasicMaterial).opacity = 0.75 * (1 - f) * (1 - f);
    }
    const k = this.blastAge / SHOCK;
    this.shock.visible = k < 1;
    if (k < 1) {
      const r = 0.6 + 3.6 * k;
      this.shock.scale.set(r, r, 1);
      (this.shock.material as MeshBasicMaterial).opacity = 0.9 * (1 - k);
    }
    const c = this.scorchAge / SCORCH;
    this.scorch.visible = c < 1;
    if (c < 1) (this.scorch.material as MeshBasicMaterial).opacity = 0.5 * (1 - c * c);
  }
  /**
   * The traps and who they slowed, per frame. Armed: open jaws and a soft pulsing glow on the
   * rim. Sprung: the jaws snap shut (a little jolt), dim, and a white arc fills the rim as it
   * rearms; the jaws reopen just before it is armed again, which flashes the rim.
   * `slowed[slot]`: the feet of a slowed player (null: not slowed), `slowLeft[slot]` 1 → 0.
   */
  updateTraps(time: number, dt: number, traps: readonly BombTrap[], slowed: readonly (Vector3 | null)[], slowLeft: readonly number[]) {
    const rearmTotal = BOMB_TICKS.trapRearm / 60;
    traps.forEach((t, i) => {
      const since = rearmTotal - t.rearmIn / 60,
        left = t.rearmIn / 60;
      // 0 open … 1 shut.
      const shut = t.armed ? 0 : left < REOPEN ? left / REOPEN : Math.min(1, since / SNAP);
      const jolt = !t.armed && since < 0.18 ? Math.sin((since / 0.18) * Math.PI) * 0.35 : 0;
      this.q.setFromAxisAngle(UP, TRAP_YAW[i % TRAP_YAW.length]);
      this.traps.setMatrixAt(i, this.m.compose(this.v.set(t.x, t.y + 0.005, t.z), this.q, this.s.set(1 - 0.58 * shut, 1 + 0.5 * shut + jolt, 1)));
      const dim = 1 - 0.45 * shut;
      this.traps.setColorAt(i, this.tint.setRGB(dim, dim, dim));
      if (t.armed && !this.trapWasArmed[i]) this.trapFlash[i] = 0;
      this.trapWasArmed[i] = t.armed;
      this.trapFlash[i] += dt;
      const flash = Math.max(0, 1 - this.trapFlash[i] / REARM_FLASH);
      if (t.armed) {
        const pulse = 0.22 + 0.1 * Math.sin(time * 3 + i * 2.1);
        const grow = 1 + 0.25 * flash;
        this.trapGlow.setMatrixAt(i, this.m.compose(this.v.set(t.x, t.y + 0.02, t.z), this.q.identity(), this.s.set(grow, 1, grow)));
        this.trapGlow.setColorAt(i, this.tint.set("#ffc233").multiplyScalar(pulse + 0.9 * flash));
      } else this.trapGlow.setMatrixAt(i, ZERO);
      const arc = this.rearm[i];
      arc.visible = !t.armed;
      if (arc.visible) {
        arc.position.set(t.x, t.y + 0.015, t.z);
        const segments = Math.max(1, Math.round(48 * Math.min(1, since / rearmTotal)));
        arc.geometry.setDrawRange(0, segments * 6);
      }
    });
    this.traps.instanceMatrix.needsUpdate = true;
    if (this.traps.instanceColor) this.traps.instanceColor.needsUpdate = true;
    this.trapGlow.instanceMatrix.needsUpdate = true;
    if (this.trapGlow.instanceColor) this.trapGlow.instanceColor.needsUpdate = true;
    this.slows.forEach((ring, slot) => {
      const feet = slowed[slot];
      ring.visible = !!feet;
      if (!feet) return;
      ring.position.set(feet.x, feet.y + 0.03, feet.z);
      const k = 1 + 0.08 * Math.sin(time * 20);
      ring.scale.set(k, k, 1);
      ring.geometry.setDrawRange(0, Math.max(1, Math.ceil(40 * Math.max(0, Math.min(1, slowLeft[slot])))) * 6);
    });
  }
  /** Countdown / reset: no blast leftovers. */
  clear() {
    this.blastAge = this.scorchAge = this.handOffAge = Infinity;
    this.flash.visible = this.shock.visible = this.scorch.visible = false;
    this.trapFlash.fill(Infinity);
    this.trapWasArmed.fill(true);
  }
  dispose() {
    for (const mesh of [this.shadows, this.ring, this.shield, this.spark, this.flash, this.shock, this.scorch, this.trapGlow, ...this.rearm, ...this.slows]) {
      mesh.geometry.dispose();
      (mesh.material as MeshBasicMaterial).dispose();
    }
    this.fallback.dispose();
    this.bombMaterial.dispose();
    this.trapFallback.dispose();
    (this.traps.material as MeshLambertMaterial).dispose();
    this.traps.dispose();
    this.trapGlow.dispose();
  }
}
