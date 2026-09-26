import type { GameSnapshot, AnyInputPacket } from "../../../../shared/party-lab/network/protocol";
import type { MovementInput } from "../../../../shared/party-lab/intent";
import type { PlayerId } from "../../../../shared/party-lab/simulation/players";
import { PARTS } from "../../../../shared/party-lab/simulation/ragdoll/config";
import { PropHuntGame } from "../../../../shared/party-lab/simulation/prophunt/game";
import { reconstructPropLayout } from "../../../../shared/party-lab/simulation/prophunt/wire";
import { PROP_FAMILY_IDS } from "../../../../shared/party-lab/maps/propHuntProps";
import { retire } from "../../../../shared/party-lab/simulation/layers/game";
import { connect } from "../../../../shared/party-lab/simulation/ragdoll/character";

/** Full authoritative restore, then replay only the recipient's unacknowledged movement. */
export class PropPrediction {
  game: PropHuntGame | null = null;
  private seq = -1;
  private round = -1;
  private seed = -1;
  private index = -1;
  private pending: { seq: number; input: MovementInput }[] = [];
  correction = 0;
  /** Presentation only: small reconciliation offsets ease away; physics always uses authority. */
  readonly visualOffset = { x: 0, y: 0, z: 0 };
  stepMs = 0;
  constructor(readonly slot: PlayerId) {}
  accept(snapshot: GameSnapshot) {
    const wire = snapshot.prop;
    if (!wire || snapshot.seq <= this.seq) return false;
    const fresh = snapshot.round !== this.round;
    if (fresh) this.pending = [];
    if (!this.game || wire.seed !== this.seed || wire.index !== this.index || this.game.seeker !== wire.seeker) {
      const layout = reconstructPropLayout(wire, this.game ? { seed: this.seed, index: this.index, layout: this.game.layout } : undefined);
      this.game?.dispose();
      this.game = new PropHuntGame(undefined, { layout, seed: wire.seed, roles: [0, 1, 2].map((id) => id === wire.seeker ? "seeker" : "hider"), ...wire.settings, online: true });
      this.game.layoutRound = wire.index;
      this.seed = wire.seed; this.index = wire.index;
    } else if (this.game.layout.id !== wire.hash) throw Error("Prop Hunt layout mismatch");
    const g = this.game, r = g.round;
    const priorFamily = g.disguiseOf(this.slot)?.family, priorAlive = r.alive[this.slot];
    const before = { ...(g.disguiseOf(this.slot)?.body ?? g.physics.players[this.slot].body).translation() };
    r.phase = wire.phase; r.tick = wire.t; r.outcome = wire.outcome; r.reason = wire.reason; r.endedAt = wire.ended;
    r.revision++;
    g.ammo = wire.ammo; g.shotCooldown = wire.shot;
    g.reveal.splice(0, g.reveal.length, ...wire.reveal);
    const pose = new DataView(snapshot.transforms.buffer, snapshot.transforms.byteOffset, snapshot.transforms.byteLength);
    for (const c of g.physics.players) {
      const id = c.id, d = wire.disguise[id];
      r.alive[id] = !!(wire.alive & (1 << id)); r.foundAt[id] = wire.found[id];
      g.toggleCooldown[id] = wire.toggle[id]; g.manualWhistleCooldown[id] = wire.whistle[id];
      const absent = !r.alive[id] || d[0] >= 0;
      if (absent) retire(c);
      else { if (c.eliminated) { c.eliminated = false; for (const name of PARTS) c.parts[name].body.setEnabled(true); connect(g.physics.world, c); } }
      for (let i = 0; i < PARTS.length; i++) {
        const b = c.parts[PARTS[i]].body, at = (id * 63 + i * 7) * 4;
        b.setTranslation({ x: pose.getFloat32(at, true), y: pose.getFloat32(at + 4, true), z: pose.getFloat32(at + 8, true) }, true);
        b.setRotation({ x: pose.getFloat32(at + 12, true), y: pose.getFloat32(at + 16, true), z: pose.getFloat32(at + 20, true), w: pose.getFloat32(at + 24, true) }, true);
      }
      if (d[0] < 0) g.disguises.remove(id);
      else {
        const family = PROP_FAMILY_IDS[d[0]], at = { x: d[2], y: d[3], z: d[4] };
        const w = g.disguises.wear(id, family, at, d[5]);
        w.vx = d[6]; w.vy = d[7]; w.vz = d[8]; w.grounded = !!d[9];
        g.sourceDecoys[id] = d[1];
      }
    }
    const p = snapshot.prediction, c = g.physics.players[this.slot];
    if (p?.slot === this.slot) {
      const [facing, gait, jumpIn, sprint, anchored, anchorX, anchorZ] = p.controller;
      Object.assign(c, { facing, gait, jumpIn, sprint, anchored: !!anchored, anchorX, anchorZ });
      const v = new DataView(p.velocities.buffer, p.velocities.byteOffset, p.velocities.byteLength);
      PARTS.forEach((name, i) => {
        const at = i * 24, b = c.parts[name].body;
        b.setLinvel({ x: v.getFloat32(at, true), y: v.getFloat32(at + 4, true), z: v.getFloat32(at + 8, true) }, true);
        b.setAngvel({ x: v.getFloat32(at + 12, true), y: v.getFloat32(at + 16, true), z: v.getFloat32(at + 20, true) }, true);
      });
    }
    g.physics.world.propagateModifiedBodyPositionsToColliders();
    this.pending = this.pending.filter((p) => p.seq > snapshot.ack[this.slot]);
    for (const p of this.pending) g.predictMovement(this.slot, p.input);
    const after = (g.disguiseOf(this.slot)?.body ?? c.body).translation();
    this.correction = fresh ? 0 : Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
    const offset = this.visualOffset;
    if (fresh || priorFamily !== g.disguiseOf(this.slot)?.family || priorAlive !== r.alive[this.slot] || this.correction > 1) Object.assign(offset, { x: 0, y: 0, z: 0 });
    else {
      offset.x += before.x - after.x; offset.y += before.y - after.y; offset.z += before.z - after.z;
      if (Math.hypot(offset.x, offset.y, offset.z) > 1) Object.assign(offset, { x: 0, y: 0, z: 0 });
    }
    this.seq = snapshot.seq; this.round = snapshot.round;
    return fresh;
  }
  step(input: MovementInput, packet: AnyInputPacket | null | undefined) {
    if (!this.game || !packet || this.pending.length >= 30) return;
    const started = performance.now();
    this.pending.push({ seq: packet.seq, input: { ...input, x: packet.moveX, z: packet.moveZ } });
    this.game.predictMovement(this.slot, this.pending[this.pending.length - 1].input);
    this.stepMs = performance.now() - started;
  }
  advanceVisual(dt: number) {
    const decay = Math.exp(-Math.min(dt, 0.1) / 0.1);
    this.visualOffset.x *= decay; this.visualOffset.y *= decay; this.visualOffset.z *= decay;
  }
  suspend() { this.pending = []; }
  dispose() { this.game?.dispose(); this.game = null; this.pending = []; }
}
