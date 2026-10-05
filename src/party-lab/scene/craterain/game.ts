import RAPIER from '@dimforge/rapier3d-compat';
import { BOXES, BOX_KINDS, CRATE_SIZE, baseLandingTime, CRATE_RAIN as C, FEET, IDLE, clamp, seeded, waveAt, roundWinner, type BoxKind, type Input } from './config';
import { CrateBot } from './bots';

type Vec = { x: number; y: number; z: number };
export type CratePhase = 'countdown' | 'playing' | 'roundOver' | 'results';
export interface CratePlayer {
  id: number; body: RAPIER.RigidBody; collider: RAPIER.Collider; alive: boolean; heading: number;
  grounded: boolean; support: number | null; coyote: number; buffer: number; jumpHeld: boolean;
  positionBefore: Vec; input: Input; reason: 'impact' | null; stepped: number;
}
export interface Cell { index: number; x: number; z: number; layers: number; reserved: boolean }
export interface Warning { cell: number; impactAt: number; id: number; kind: BoxKind; x: number; z: number; y: number; since: number; spawnAt: number; spawned: boolean; landed: boolean }
export interface Crate { id: number; kind: BoxKind; body: RAPIER.RigidBody; collider: RAPIER.Collider; before: Vec; warnedAt: number; spawnedAt: number; firstHit: boolean; cell: number; startY: number; landingY: number; impactAt: number }
export interface Impact { player: number; crate: number; kind: BoxKind; speed: number; downward: number; impulse: number; lethal: boolean; tick: number }
export interface CrateSnapshot { phase: CratePhase; round: number; seconds: number; alive: boolean[]; wins: number[]; winner: number; elapsed: number; boxes: number; wave: number; timeout: boolean; danger: boolean }
export interface PhysicsStats { awake: number; sleeping: number; dynamic: number; kinematic: number; fixed: number; invalid: number; tunneled: number; bodies: number; colliders: number; maxSpeed: number; maxHeight: number }
const ZERO = { x: 0, y: 0, z: 0 }, ROT = { x: 0, y: 0, z: 0, w: 1 };
/** An independent LOCAL simulation. No shared protocol, prediction, or server dependencies. */
export class CrateRainGame {
  readonly world = new RAPIER.World({ x: 0, y: -C.gravity, z: 0 });
  readonly players: CratePlayer[] = [];
  readonly crates: Crate[] = [];
  readonly warnings: Warning[] = [];
  readonly cells: Cell[] = [];
  readonly fallingShape = new RAPIER.Cuboid(CRATE_SIZE / 2, CRATE_SIZE / 2, CRATE_SIZE / 2);
  readonly crateByCollider = new Map<number, Crate>();
  readonly half: number;
  readonly shape = new RAPIER.Capsule(C.playerHalf, C.playerRadius);
  phase: CratePhase = 'countdown'; round = 1; phaseTime = 0; elapsed = 0; tick = 0;
  wins: number[]; winner = -1; timeout = false; bots = true; spawning = true;
  physicsMs = 0; invalidBodies = 0; tunneling = 0; peakSpeed = 0;
  impacts: Impact[] = []; hits: { x: number; y: number; z: number; speed: number }[] = [];
  history: { round: number; seconds: number; winner: number; boxes: number; timeout: boolean }[] = [];
  private random: () => number;
  private botBrains: CrateBot[] = [];
  private planned = 0; private nextId = 0;
  private lastSound = -10;
  constructor(readonly count: 2 | 3 = 3, readonly seed = 71, readonly arenaSize: number = C.arenaSize, readonly cap: number = C.boxCap) {
    if (count !== 2 && count !== 3) throw new Error('Local Crate Rain requires 2 or 3 seats');
    this.half = arenaSize / 2; this.wins = Array(count).fill(0); this.random = seeded(seed);
    const side = Math.round(arenaSize / CRATE_SIZE);
    if (Math.abs(side * CRATE_SIZE - arenaSize) > 1e-6) throw new Error('Arena must fit whole 1.4 m cells');
    for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) this.cells.push({ index: z * side + x, x: -this.half + (x + .5) * CRATE_SIZE, z: -this.half + (z + .5) * CRATE_SIZE, layers: 0, reserved: false });
    this.world.timestep = C.step; this.world.numSolverIterations = 8; this.world.maxCcdSubsteps = 2;
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(this.half + 1, 0.5, this.half + 1).setTranslation(0, -0.5, 0).setFriction(0.9).setRestitution(0));
    // Tall solid containment, matched by the visible cargo cage on every side.
    // Common multi-level piles remain far below the perimeter.
    for (const axis of ['x', 'z'] as const) for (const sign of [-1, 1]) {
      const x = axis === 'x' ? sign * (this.half + 0.22) : 0, z = axis === 'z' ? sign * (this.half + 0.22) : 0;
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(axis === 'x' ? 0.22 : this.half + 0.44, C.wallHeight / 2, axis === 'z' ? 0.22 : this.half + 0.44)
        .setTranslation(x, C.wallHeight / 2, z).setFriction(0.12).setRestitution(0));
    }
    for (let id = 0; id < count; id++) {
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().lockRotations().setCanSleep(true).setCcdEnabled(true));
      const collider = this.world.createCollider(RAPIER.ColliderDesc.capsule(C.playerHalf, C.playerRadius).setMass(C.playerMass).setFriction(0.65).setRestitution(0)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min).setContactSkin(0.01), body);
      this.players.push({ id, body, collider, alive: true, heading: 0, grounded: false, support: null, coyote: 0, buffer: 0, jumpHeld: false, positionBefore: { ...ZERO }, input: { ...IDLE }, reason: null, stepped: 0 });
    }
    this.resetRound();
  }
  resetRound() {
    // The ONLY gameplay removal path for crates. There is no per-wave/age cleanup.
    for (const c of this.crates) this.world.removeRigidBody(c.body);
    this.crates.length = 0; this.crateByCollider.clear(); this.warnings.length = 0; this.impacts.length = 0; this.hits.length = 0;
    this.phase = 'countdown'; this.phaseTime = this.elapsed = this.tick = 0; this.winner = -1; this.timeout = false;
    this.planned = this.nextId = 0; this.lastSound = -10;
    this.cells.forEach(cell => { cell.layers = 0; cell.reserved = false; });
    this.random = seeded(this.seed + this.round * 997);
    this.botBrains = this.players.map(p => new CrateBot(p.id, seeded(this.seed + this.round * 131 + p.id * 17)));
    this.players.forEach(p => {
      const a = Math.PI * 2 * p.id / this.count + (this.round - 1) * 0.6;
      p.body.setEnabled(true); p.body.setTranslation({ x: Math.sin(a) * this.half * 0.48, y: FEET + 0.035, z: Math.cos(a) * this.half * 0.48 }, true);
      p.body.setLinvel(ZERO, true); p.body.setAngvel(ZERO, true); p.body.setRotation(ROT, true); p.body.resetForces(true); p.body.resetTorques(true);
      p.positionBefore = p.body.translation();
      Object.assign(p, { alive: true, heading: a + Math.PI, grounded: false, support: null, coyote: 0, buffer: 0, jumpHeld: false, reason: null, input: { ...IDLE }, stepped: 0 });
    });
    this.world.propagateModifiedBodyPositionsToColliders();
  }
  cellAt(x: number, z: number) {
    const side = Math.round(this.arenaSize / CRATE_SIZE);
    return this.cells[clamp(Math.floor((z + this.half) / CRATE_SIZE), 0, side - 1) * side + clamp(Math.floor((x + this.half) / CRATE_SIZE), 0, side - 1)];
  }
  /** Analytic static support; no raycast, moving support, or sleeping-body bookkeeping. */
  surface(x: number, z: number, from = 40) {
    const top = this.cellAt(x, z).layers * CRATE_SIZE;
    return { y: Math.min(top, Math.max(0, from)), normal: { x: 0, y: 1, z: 0 } };
  }
  /** Local fixtures use the same aligned, supported lifecycle as the scheduler. */
  addCrate(kind: BoxKind, x: number, y: number, z: number, _yaw = 0, warnedAt = this.elapsed, duration = waveAt(this.elapsed).warning) {
    const cell = this.cellAt(x, z);
    if (this.crates.length >= this.cap || cell.reserved) return null;
    const landingY = cell.layers * CRATE_SIZE + CRATE_SIZE / 2;
    const landed = y <= landingY + .05;
    const body = this.world.createRigidBody((landed ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.kinematicPositionBased()).setTranslation(cell.x, landed ? landingY : y, cell.z));
    const collider = this.world.createCollider(RAPIER.ColliderDesc.cuboid(CRATE_SIZE / 2, CRATE_SIZE / 2, CRATE_SIZE / 2)
      .setSensor(!landed).setFriction(C.friction).setRestitution(0), body);
    const crate: Crate = { id: this.nextId++, kind, body, collider, before: body.translation(), warnedAt, spawnedAt: this.elapsed,
      firstHit: landed, cell: cell.index, startY: y, landingY, impactAt: this.elapsed + duration };
    if (landed) cell.layers++; else cell.reserved = true;
    this.crates.push(crate); this.crateByCollider.set(collider.handle, crate);
    this.world.propagateModifiedBodyPositionsToColliders();
    return crate;
  }
  warn(kind: BoxKind, x: number, z: number, duration = waveAt(this.elapsed).warning) {
    const cell = this.cellAt(x, z), y = cell.layers * CRATE_SIZE;
    const c = this.addCrate(kind, cell.x, y + C.spawnHeight + CRATE_SIZE / 2, cell.z, 0, this.elapsed, duration);
    if (!c) return null;
    const warning: Warning = { id: c.id, cell: cell.index, kind, x: cell.x, z: cell.z, y, since: this.elapsed,
      spawnAt: this.elapsed, impactAt: c.impactAt, spawned: true, landed: false };
    this.warnings.push(warning); return warning;
  }
  private schedule() {
    if (!this.spawning) return;
    const total = this.cells.length;
    // Warning is computed for its landing deadline, so every crate is down on time.
    while (this.planned < total && this.crates.length < this.cap) {
      const impactAt = baseLandingTime(this.planned, total), warning = waveAt(impactAt).warning;
      if (this.elapsed + 1e-8 < Math.max(0, impactAt - warning)) break;
      const empty = this.cells.filter(c => !c.layers && !c.reserved);
      if (!empty.length) { this.planned = total; break; }
      // No future player positions. Prefer dispersed visible threats when possible.
      const separated = empty.filter(c => this.warnings.every(w => Math.hypot(c.x - w.x, c.z - w.z) >= CRATE_SIZE * 1.9));
      const candidates = separated.length ? separated : empty;
      const cell = candidates[Math.floor(this.random() * candidates.length)];
      const w = this.warn(BOX_KINDS[Math.floor(this.random() * BOX_KINDS.length)], cell.x, cell.z, warning);
      if (!w) break;
      this.planned++;
    }
    // Final pressure is allowed only after ALL base cells are actually landed.
    // It always gets a full warning; nothing scheduled too late is squeezed in.
    if (this.cells.every(c => c.layers) && this.elapsed + .65 <= C.maxRoundTime + 1e-8) {
      const available = this.cells.filter(c => !c.reserved && c.layers < 4);
      const live = this.players.filter(p => p.alive).map(p => p.body.translation());
      const nearby = available.filter(c => live.some(p => Math.hypot(c.x - p.x, c.z - p.z) < 3.5));
      const candidates = this.random() < .65 && nearby.length ? nearby : available;
      if (candidates.length && this.warnings.length < 6) {
        const cell = candidates[Math.floor(this.random() * candidates.length)];
        this.warn(BOX_KINDS[Math.floor(this.random() * 3)], cell.x, cell.z, .65);
      }
    }
  }
  /** Exact convex sweep of cube AND capsule displacement, independent of solver impulses.
   * Falling sensors never push players through the floor before this test. */
  private landAndHit() {
    const eliminated = new Set<number>();
    for (const c of this.crates) if (!c.firstHit) {
      const at = c.body.translation(), motion = { x: 0, y: at.y - c.before.y, z: 0 };
      for (const p of this.players) if (p.alive && p.body.isEnabled()) {
        const end = p.body.translation(), travel = { x: end.x - p.positionBefore.x, y: end.y - p.positionBefore.y, z: end.z - p.positionBefore.z };
        const hit = this.fallingShape.castShape(c.before, ROT, motion, this.shape, p.positionBefore, ROT, travel, 0, 1, true);
        if (hit && motion.y < -1e-8) {
          eliminated.add(p.id);
          this.impacts.push({ player: p.id, crate: c.id, kind: c.kind, speed: -motion.y / C.step, downward: -motion.y / C.step, impulse: 0, lethal: true, tick: this.tick });
        }
      }
      if (this.elapsed + 1e-8 >= c.impactAt) {
        c.body.setTranslation({ x: at.x, y: c.landingY, z: at.z }, false);
        c.body.setLinvel(ZERO, false); c.body.setAngvel(ZERO, false);
        c.body.setBodyType(RAPIER.RigidBodyType.Fixed, false); c.collider.setSensor(false);
        c.firstHit = true;
        const cell = this.cells[c.cell]; cell.layers++; cell.reserved = false;
        const w = this.warnings.find(w => w.id === c.id); if (w) w.landed = true;
        if (this.elapsed - this.lastSound >= .12 && this.hits.length < 2) {
          this.hits.push({ x: at.x, y: c.landingY - CRATE_SIZE / 2, z: at.z, speed: -motion.y / C.step }); this.lastSound = this.elapsed;
        }
      }
    }
    // Same-tick eliminations are simultaneous, including a draw.
    eliminated.forEach(id => { const p = this.players[id]; p.alive = false; p.reason = 'impact'; p.body.setEnabled(false); });
    for (let i = this.warnings.length - 1; i >= 0; i--) if (this.warnings[i].landed) this.warnings.splice(i, 1);
  }
  private ground(p: CratePlayer) {
    const at = p.body.translation(), velocity = p.body.linvel();
    p.grounded = false; p.support = null;
    if (velocity.y > 2.5) return;
    for (const [dx, dz] of [[0, 0], [0.20, 0], [-0.20, 0], [0, 0.20], [0, -0.20]]) {
      const ray = new RAPIER.Ray({ x: at.x + dx, y: at.y - FEET + 0.19, z: at.z + dz }, { x: 0, y: -1, z: 0 });
      const hit = this.world.castRayAndGetNormal(ray, 0.29, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, p.collider, p.body,
        c => !this.players.some(other => other.collider.handle === c.handle));
      if (hit && hit.normal.y > 0.58 && hit.timeOfImpact < 0.26) {
        p.grounded = true; p.support = this.crateByCollider.get(hit.collider.handle)?.id ?? null; return;
      }
    }
  }
  private drive(p: CratePlayer, input: Input) {
    const body = p.body, at = body.translation(), v = body.linvel();
    this.ground(p); p.coyote = p.grounded ? C.coyote : Math.max(0, p.coyote - C.step);
    p.buffer = input.jump && !p.jumpHeld ? C.jumpBuffer : Math.max(0, p.buffer - C.step); p.jumpHeld = input.jump;
    let jumping = false;
    if (p.buffer > 0 && p.coyote > 0) { body.setLinvel({ x: v.x, y: C.jumpSpeed, z: v.z }, true); p.buffer = p.coyote = 0; p.grounded = false; p.support = null; jumping = true; }

    const magnitude = Math.hypot(input.x, input.z), norm = Math.max(1, magnitude), speed = input.sprint ? C.sprintSpeed : C.walkSpeed;
    const targetX = input.x / norm * speed, targetZ = input.z / norm * speed;
    const ax = targetX - v.x, az = targetZ - v.z, error = Math.hypot(ax, az);
    const max = (p.grounded ? C.acceleration : C.airAcceleration) * C.step;
    // Idle contact islands can sleep: no needless wake-up or vertical stand force.
    if (error > 0.075) { const k = Math.min(1, max / error); body.applyImpulse({ x: ax * k * C.playerMass, y: 0, z: az * k * C.playerMass }, true); }
    if (magnitude > 0.1) p.heading = Math.atan2(input.x, input.z);
    p.stepped = Math.max(0, p.stepped - C.step);
    // A modest stair lip, not a crate-height teleport. Full capsule clearance at
    // both raised and forward poses and real ground are required.
    if (p.grounded && !jumping && magnitude > 0.2 && p.stepped <= 0 && Math.hypot(v.x, v.z) < speed * 0.65) {
      const dx = input.x / norm * 0.44, dz = input.z / norm * 0.44;
      const top = this.surface(at.x + dx, at.z + dz, at.y + 0.2).y;
      const rise = top - (at.y - FEET);
      if (rise > 0.045 && rise <= C.stepHeight) {
        const raised = { x: at.x + dx * 0.25, y: at.y + rise + 0.035, z: at.z + dz * 0.25 };
        if (!this.world.intersectionWithShape(raised, ROT, this.shape, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, p.collider, body)) { body.setTranslation(raised, true); p.stepped = 0.15; }
      }
    }
  }
  step(human: Input = IDLE, overrides?: readonly Input[]) {
    if (this.phase === 'results') return;
    this.hits.length = 0; this.phaseTime += C.step; this.tick++;
    if (this.phase === 'roundOver') {
      if (this.phaseTime >= C.resultTime) { if (this.round >= C.rounds) { this.phase = 'results'; this.phaseTime = 0; } else { this.round++; this.resetRound(); } }
      return;
    }
    if (this.phase === 'countdown' && this.phaseTime + 1e-8 >= C.countdown) { this.phase = 'playing'; this.phaseTime = 0; }
    if (this.phase === 'playing') { this.elapsed = Math.min(C.maxRoundTime, this.elapsed + C.step); this.schedule(); }
    for (const p of this.players) if (p.alive) {
      let input = IDLE;
      if (this.phase === 'playing') {
        if (overrides) input = overrides[p.id] ?? IDLE;
        else if (p.id === 0) input = human;
        else if (this.bots) {
          const at = p.body.translation();
          input = this.botBrains[p.id].think({ ...at, grounded: p.grounded, elapsed: this.elapsed, half: this.half,
            warnings: this.warnings.filter(w => !w.landed).map(w => ({ id: w.id, x: w.x, z: w.z, radius: BOXES[w.kind].size[0] / 2, since: w.since })),
            height: (x, z) => this.surface(x, z).y,
            clear: (x, z, y) => !this.world.intersectionWithShape({ x, y, z }, ROT, this.shape, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, p.collider, p.body), });
        }
      }
      p.input = input; this.drive(p, input); p.positionBefore = p.body.translation();
    }
    for (const c of this.crates) if (!c.firstHit) {
      c.before = c.body.translation();
      const progress = clamp((this.elapsed - c.spawnedAt) / (c.impactAt - c.spawnedAt), 0, 1);
      c.body.setNextKinematicTranslation({ x: c.before.x, y: c.startY + (c.landingY - c.startY) * progress * progress, z: c.before.z });
    }
    const start = performance.now(); this.world.step(); this.physicsMs = performance.now() - start;
    if (this.phase === 'playing') this.landAndHit();
    // Fixed crates have immutable, finite grid transforms. Validate only simulated bodies.
    for (const body of [...this.crates.filter(c => !c.firstHit).map(c => c.body), ...this.players.filter(p => p.alive).map(p => p.body)]) {
      const p = body.translation(), v = body.linvel();
      if (![p.x, p.y, p.z, v.x, v.y, v.z].every(Number.isFinite)) this.invalidBodies++;
      if (p.y < -1 || Math.abs(p.x) > this.half + 2 || Math.abs(p.z) > this.half + 2) this.tunneling++;
      this.peakSpeed = Math.max(this.peakSpeed, Math.hypot(v.x, v.y, v.z));
    }
    if (this.phase === 'playing') {
      if (this.elapsed + 1e-8 >= C.maxRoundTime) this.elapsed = C.maxRoundTime;
      const winner = roundWinner(this.players.map(p => p.alive));
      if (winner !== null || this.elapsed + 1e-8 >= C.maxRoundTime) {
        this.winner = winner ?? -1; this.timeout = winner === null;
        if (this.winner >= 0) this.wins[this.winner]++;
        this.history.push({ round: this.round, seconds: this.elapsed, winner: this.winner, boxes: this.crates.length, timeout: this.timeout });
        this.phase = 'roundOver'; this.phaseTime = 0;
      }
    }
  }
  stats(): PhysicsStats {
    const fixed = this.crates.filter(c => c.body.isFixed()).length, kinematic = this.crates.length - fixed;
    return { awake: kinematic, sleeping: 0, fixed, kinematic, dynamic: this.players.filter(p => p.body.isEnabled()).length, invalid: this.invalidBodies, tunneled: this.tunneling,
      bodies: this.world.bodies.len(), colliders: this.world.colliders.len(), maxSpeed: this.peakSpeed,
      maxHeight: this.crates.reduce((h, c) => c.firstHit ? Math.max(h, c.body.translation().y + BOXES[c.kind].size[1] / 2) : h, 0) };
  }
  coverage() { const base = this.cells.filter(c => c.layers > 0).length, landed = this.cells.reduce((n, c) => n + c.layers, 0); return { time: this.elapsed, playable: this.cells.length, base, percent: 100 * base / this.cells.length, spawned: this.crates.length, stacked: landed - base, maxLayers: Math.max(...this.cells.map(c => c.layers)) }; }
  snapshot(): CrateSnapshot { const at = this.players[0].body.translation(); return { danger: this.warnings.some(w => !w.landed && Math.hypot(w.x - at.x, w.z - at.z) < 1.65), phase: this.phase, round: this.round, seconds: this.phase === 'countdown' ? Math.ceil(C.countdown - this.phaseTime) : Math.max(0, Math.ceil(C.maxRoundTime - this.elapsed - 1e-8)), alive: this.players.map(p => p.alive), wins: [...this.wins], winner: this.winner, elapsed: this.elapsed, boxes: this.crates.length, wave: waveAt(this.elapsed).phase, timeout: this.timeout }; }
  dispose() { this.world.free(); }
}
