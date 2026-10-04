import RAPIER from '@dimforge/rapier3d-compat';
import { SNOWBALL as C, IDLE, clamp, arenaRadiusAt, snowSpawns, isSnowOut, snowWinner, type SnowInput } from './config.js';
import { snowBot, botReaction, type SnowSense } from './bots.js';

export type SnowPhase = 'countdown' | 'playing' | 'roundOver' | 'results';
export interface SnowBall { id: number; body: RAPIER.RigidBody; alive: boolean; heading: number; input: SnowInput }
export interface SnowSnapshot { phase: SnowPhase; round: number; seconds: number; alive: boolean[]; wins: number[]; winner: number; radius: number; elapsed: number }
export class SnowballGame {
  readonly world = new RAPIER.World({ x: 0, y: -C.gravity, z: 0 });
  readonly balls: SnowBall[] = [];
  readonly floor: RAPIER.Collider;
  phase: SnowPhase = 'countdown';
  round = 1; phaseTime = 0; elapsed = 0; tick = 0; radius: number;
  wins: number[]; winner = -1; bots = true;
  physicsMs = 0; invalidBodies = 0; collisionCount = 0;
  /** Bounded visual events; they never apply gameplay impulses. */
  hits: { x: number; y: number; z: number; energy: number }[] = [];
  private contacts = new Set<string>();
  private finishTime = 0;
  constructor(readonly count: 2 | 3 = 3, readonly initialRadius: number = C.arenaRadius, readonly seed = 17) {
    this.radius = initialRadius; this.wins = Array(count).fill(0);
    this.world.timestep = C.step;
    this.world.numSolverIterations = 8;
    this.world.maxCcdSubsteps = 4;
    this.floor = this.world.createCollider(RAPIER.ColliderDesc.cylinder(0.65, initialRadius)
      .setTranslation(0, -0.65, 0).setFriction(C.floorFriction).setRestitution(0)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min));
    for (let id = 0; id < count; id++) {
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true).setSoftCcdPrediction(2)
        .setLinearDamping(C.linearDamping).setAngularDamping(C.angularDamping).setCanSleep(false));
      this.world.createCollider(RAPIER.ColliderDesc.ball(C.radius).setMass(C.mass).setContactSkin(0.015)
        .setFriction(C.friction).setRestitution(C.restitution), body);
      this.balls.push({ id, body, alive: true, heading: 0, input: { ...IDLE } });
    }
    this.resetRound();
  }
  resetRound() {
    this.phase = 'countdown'; this.phaseTime = 0; this.elapsed = 0; this.tick = 0; this.winner = -1;
    this.radius = this.initialRadius; this.floor.setShape(new RAPIER.Cylinder(0.65, this.radius)); this.floor.setEnabled(true);
    this.contacts.clear(); this.hits.length = 0; this.finishTime = 0;
    const spawns = snowSpawns(this.count, this.initialRadius, this.round);
    this.balls.forEach((b, i) => {
      b.body.setEnabled(true); b.body.setTranslation(spawns[i], true);
      b.body.setLinvel({ x: 0, y: 0, z: 0 }, true); b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      b.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      b.body.resetForces(true); b.body.resetTorques(true);
      b.alive = true; b.heading = spawns[i].heading; b.input = { ...IDLE };
    });
  }
  sense(): SnowSense[] {
    return this.balls.map(b => { const p = b.body.translation(), v = b.body.linvel();
      return { id: b.id, x: p.x, z: p.z, vx: v.x, vz: v.z, heading: b.heading, alive: b.alive }; });
  }
  /** Forces/torques only during play. Quaternion never determines input axes. */
  drive(b: SnowBall, input: SnowInput) {
    const p = b.body.translation(), v = b.body.linvel(), speed = Math.hypot(v.x, v.z);
    const steer = clamp(input.steer, -1, 1), throttle = clamp(input.throttle, -1, 1);
    b.heading += steer * C.turnRate / (1 + speed * 0.12) * C.step;
    b.heading = Math.atan2(Math.sin(b.heading), Math.cos(b.heading));
    // No air steering or invisible support beyond the physical platform.
    if (p.y < C.radius - 0.12 || p.y > C.radius + 0.15 || Math.hypot(p.x, p.z) > this.radius + 0.1) return;
    const fx = Math.sin(b.heading), fz = -Math.cos(b.heading), rx = -fz, rz = fx;
    const forward = v.x * fx + v.z * fz;
    let ax = 0, az = 0;
    if (throttle) {
      const direction = Math.sign(throttle), along = forward * direction;
      const acceleration = direction > 0 ? C.acceleration : C.reverse;
      // Counter-travel input gets bounded braking first, then symmetric drive.
      // Blend near zero so velocity crosses through zero continuously.
      const a = along < 0
        ? acceleration + (C.brake - acceleration) * clamp(-along / 1.5, 0, 1)
        : acceleration * clamp(1 - along / C.usefulSpeed, 0, 1);
      ax += fx * a * throttle; az += fz * a * throttle;
    }
    // A held direction keeps bending velocity after the heading settles.
    // Release still coasts. High speed has a wider turn and bounded grip.
    if (throttle || steer) {
      const grip = C.steeringGrip / (1 + Math.max(0, speed - 5) * 0.12);
      const side = clamp(-(v.x * rx + v.z * rz) * C.steeringResponse, -grip, grip);
      ax += rx * side; az += rz * side;
    }
    b.body.applyImpulse({ x: ax * C.mass * C.step, y: 0, z: az * C.mass * C.step }, true);
    // A bounded rolling motor couples surface motion to angular inertia. It never
    // overwrites spin, position or velocity, so impacts remain Rapier's solution.
    const w = b.body.angvel(), inertia = 0.4 * C.mass * C.radius ** 2;
    const tx = clamp((v.z / C.radius - w.x) * 5 + az / C.radius, -12, 12);
    const tz = clamp((-v.x / C.radius - w.z) * 5 - ax / C.radius, -12, 12);
    if (throttle || steer) b.body.applyTorqueImpulse({ x: tx * inertia * C.step, y: 0, z: tz * inertia * C.step }, true);
  }
  step(human: SnowInput = IDLE, overrides?: readonly SnowInput[]) {
    if (this.phase === 'results') return;
    this.hits.length = 0;
    this.phaseTime += C.step; this.tick++;
    if (this.phase === 'roundOver') {
      if (this.phaseTime >= C.resultTime) {
        if (this.round >= C.rounds) { this.phase = 'results'; this.phaseTime = 0; }
        else { this.round++; this.resetRound(); }
      }
      return;
    }
    if (this.phase === 'countdown' && this.phaseTime >= C.countdown) { this.phase = 'playing'; this.phaseTime = 0; }
    const before = this.balls.map(b => b.body.linvel());
    if (this.phase === 'playing') {
      this.elapsed += C.step;
      const radius = arenaRadiusAt(this.elapsed, this.initialRadius);
      if (Math.abs(radius - this.radius) > 0.01 || radius === 0) {
        this.radius = radius;
        if (radius > 0) this.floor.setShape(new RAPIER.Cylinder(0.65, radius));
        else this.floor.setEnabled(false);
      }
      const senses = this.sense();
      for (const b of this.balls) if (b.alive) {
        if (overrides) b.input = overrides[b.id] ?? IDLE;
        else if (b.id === 0) b.input = human;
        else if (!this.bots) b.input = IDLE;
        else if (this.tick % botReaction(b.id) === 0) b.input = snowBot(senses[b.id], senses, this.radius, this.elapsed, this.seed + this.round);
        this.drive(b, b.input);
      }
    }
    const start = performance.now(); this.world.step(); this.physicsMs = performance.now() - start;
    const nextContacts = new Set<string>();
    for (const b of this.balls) {
      const p = b.body.translation(), v = b.body.linvel(), w = b.body.angvel(), q = b.body.rotation();
      if (![p.x,p.y,p.z,v.x,v.y,v.z,w.x,w.y,w.z,q.x,q.y,q.z,q.w].every(Number.isFinite)) this.invalidBodies++;
      if (b.alive && isSnowOut(p, this.initialRadius)) { b.alive = false; b.body.setEnabled(false); }
      for (const other of this.balls) if (b.id < other.id && b.alive && other.alive) {
        this.world.contactPair(b.body.collider(0), other.body.collider(0), manifold => {
          if (!manifold.numSolverContacts()) return;
          const key = `${b.id}:${other.id}`; nextContacts.add(key);
          if (!this.contacts.has(key)) {
            this.collisionCount++;
            const a = before[b.id], c = before[other.id], energy = Math.hypot(a.x-c.x, a.z-c.z);
            if (energy > 2) this.hits.push({ x:p.x, y:p.y, z:p.z, energy });
          }
        });
      }
    }
    this.contacts = nextContacts;
    if (this.phase === 'playing') {
      const winner = snowWinner(this.balls.map(b => b.alive));
      // Resolve after a short physical fall grace, never award a ball already
      // dropping beside its opponent before its own elimination is registered.
      if (winner !== null) this.finishTime += C.step; else this.finishTime = 0;
      if (winner !== null && this.finishTime >= C.fallGrace) { this.winner = winner; if (winner >= 0) this.wins[winner]++; this.phase = 'roundOver'; this.phaseTime = 0; }
    }
  }
  snapshot(): SnowSnapshot { return { phase:this.phase, round:this.round, seconds:Math.max(0,Math.ceil(C.countdown-this.phaseTime)), alive:this.balls.map(b=>b.alive), wins:[...this.wins], winner:this.winner, radius:this.radius, elapsed:this.elapsed }; }
  dispose() { this.world.free(); }
}
