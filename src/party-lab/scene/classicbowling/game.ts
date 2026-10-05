import RAPIER from '@dimforge/rapier3d-compat';
import { CLASSIC as C, PIN_PROFILE, PIN_SPLIT, ballSpeed, directionAt, positionAt, powerAt, rackPositions } from './config';
import { ClassicScore } from './rules';
import { botPlan, seededRandom, type BotPlan } from './bot';

export type ClassicPhase = 'position' | 'direction' | 'power' | 'rolling' | 'feedback' | 'return' | 'results';
export interface ClassicPin { id: number; body: RAPIER.RigidBody; down: boolean; downFor: number }
export interface ThrowMeasurement {
  seat: number; frame: number; roll: number; position: number; angle: number; power: number;
  launchSpeed: number; impactSpeed: number | null; impactTime: number | null; entryX: number | null;
  gutter: boolean; pins: number; downIds: number[]; duration: number; settleTime: number;
  path: { x: number; y: number; z: number }[];
}
export interface ClassicSnapshot {
  phase: ClassicPhase; phaseTime: number; position: number; angle: number; power: number;
  seat: number; frame: number; roll: number; totals: number[]; cards: ClassicScore['cards'];
  standing: number[]; winners: number[]; message: string; lastPins: number; bot: boolean;
}
export type ClassicEvent = 'release' | 'pin' | 'gutter' | 'strike' | 'spare' | 'score';
const magnitude = (p: { x: number; y: number; z: number }) => Math.hypot(p.x, p.y, p.z);
export function pinIsDown(position: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }) {
  return 1 - 2 * (q.x * q.x + q.z * q.z) < Math.cos(Math.PI / 4) || position.y < -.09 || Math.abs(position.x) > C.laneWidth / 2 + .06 || position.z > C.deckEnd + .08 || position.z < C.headZ - .65;
}
function hull(profile: typeof PIN_PROFILE) {
  return new Float32Array(profile.flatMap(([r, y]) => Array.from({ length: 12 }, (_, i) => [Math.cos(i * Math.PI / 6) * r, y, Math.sin(i * Math.PI / 6) * r]).flat()));
}
const lower = hull(PIN_PROFILE.slice(1, PIN_SPLIT + 1)), upper = hull(PIN_PROFILE.slice(PIN_SPLIT));

/** No imports from Human Bowling, no outcome lookup, no post-release ball/pin impulses. */
export class ClassicGame {
  readonly world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  readonly queue = new RAPIER.EventQueue(true);
  readonly score: ClassicScore;
  readonly random: () => number;
  readonly pins: ClassicPin[] = [];
  readonly measurements: ThrowMeasurement[] = [];
  readonly events: ClassicEvent[] = [];
  readonly colliderPins = new Map<number, number>();
  phase: ClassicPhase = 'position';
  phaseTime = 0;
  position = 0;
  angle = 0;
  power = 67.5;
  ball: RAPIER.RigidBody | null = null;
  ballCollider: number | null = null;
  plan: BotPlan;
  bots = true;
  autoHuman = false;
  physicsMs = 0;
  lastPins = 0;
  message = '';
  time = 0;
  launches = 0;
  private accumulator = 0;
  private rollTime = 0;
  private contactAt: number | null = null;
  private stableFor = 0;
  private shot: ThrowMeasurement | null = null;
  private pathClock = 0;
  constructor(readonly count: 2 | 3 = 2, seed = 7281) {
    this.score = new ClassicScore(count);
    this.random = seededRandom(seed);
    this.world.timestep = C.step;
    this.world.numSolverIterations = 6;
    this.world.maxCcdSubsteps = 2;
    const box = (x: number, y: number, z: number, hx: number, hy: number, hz: number, friction = .12, restitution = .05) => {
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(friction).setRestitution(restitution));
    };
    // Continuous lane and deck. Approach is scenery; launch starts at the foul line.
    box(0, -.25, (C.deckEnd - .5) / 2, C.laneWidth / 2, .25, (C.deckEnd + .5) / 2);
    for (const side of [-1, 1]) {
      // Three simple surfaces form a recessed U-channel. No gutter trigger teleports.
      box(side * (C.laneWidth / 2 + C.gutterWidth / 2), -C.gutterDepth - .04, C.deckEnd / 2, C.gutterWidth / 2, .04, C.deckEnd / 2, .18, .02);
      box(side * (C.laneWidth / 2 + C.gutterWidth + .04), .08, C.deckEnd / 2, .04, .35, C.deckEnd / 2, .12, .05);
      // Realistic kickbacks, only behind the head pin, return pins by collisions.
      box(side * (C.laneWidth / 2 + C.gutterWidth + .04), .55, C.headZ + .65, .04, .45, .95, .18, .35);
    }
    box(0, -.45, C.deckEnd + .65, 1.3, .08, .65, .65);
    box(0, .3, C.deckEnd + 1.25, 1.3, .8, .08, .5, .04);
    this.resetRack();
    this.plan = this.makePlan();
  }
  private makePlan() { return botPlan(this.random, (['straight', 'angle', 'power'] as const)[this.score.seat], this.pins.map(p => p.body.translation())); }
  resetRack(standing: number[] = Array.from({ length: 10 }, (_, i) => i)) {
    for (const p of this.pins) this.world.removeRigidBody(p.body);
    this.pins.length = 0; this.colliderPins.clear();
    const spots = rackPositions();
    for (const id of standing) {
      const spot = spots[id];
      // Seeded pinsetter tolerance only, 1.5 mm. No randomness is applied after release.
      const x = spot.x + (this.random() * 2 - 1) * C.pinPlacementTolerance;
      const z = spot.z + (this.random() * 2 - 1) * C.pinPlacementTolerance;
      const yaw = (this.random() * 2 - 1) * .02;
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, spot.y, z).setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }).setLinearDamping(.22).setAngularDamping(.3).setCanSleep(true));
      // Tiny flat four-contact foot avoids the single-contact drift of convex/cylinder bases.
      const base = this.world.createCollider(RAPIER.ColliderDesc.cuboid(.024, .008, .024).setTranslation(0, .008, 0).setMass(.18).setFriction(.24).setRestitution(.05).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), body);
      this.colliderPins.set(base.handle, id);
      for (const [points, mass] of [[lower, 1.10], [upper, .3]] as const) {
        const desc = RAPIER.ColliderDesc.convexHull(points)!;
        const col = this.world.createCollider(desc.setMass(mass).setFriction(.24).setRestitution(.22).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), body);
        this.colliderPins.set(col.handle, id);
      }
      body.sleep();
      this.pins.push({ id, body, down: false, downFor: 0 });
    }
  }
  /** Fresh semantic action edge only; the adapter owns key repeat/held suppression. */
  select() {
    if (this.phase === 'position') { this.phase = 'direction'; this.phaseTime = 0; }
    else if (this.phase === 'direction') { this.phase = 'power'; this.phaseTime = 0; }
    else if (this.phase === 'power') this.launch();
  }
  private launch() {
    const speed = ballSpeed(this.power), angle = this.angle * Math.PI / 180;
    this.ball = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(this.position, C.ballRadius + .002, C.launchZ).setCcdEnabled(true).setLinearDamping(.018).setAngularDamping(.025));
    this.ballCollider = this.world.createCollider(RAPIER.ColliderDesc.ball(C.ballRadius).setMass(C.ballMass).setFriction(.16).setRestitution(.035).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), this.ball).handle;
    const x = Math.sin(angle) * speed, z = Math.cos(angle) * speed;
    this.ball.setLinvel({ x, y: 0, z }, true);
    // Forward rolling, no vertical-axis spin/hook, no steering after release.
    this.ball.setAngvel({ x: z / C.ballRadius, y: 0, z: -x / C.ballRadius }, true);
    this.phase = 'rolling'; this.phaseTime = 0; this.rollTime = 0; this.contactAt = null; this.stableFor = 0; this.accumulator = 0; this.pathClock = 0;
    this.launches++;
    this.shot = { seat: this.score.seat, frame: this.score.frame + 1, roll: this.score.roll, position: this.position, angle: this.angle, power: this.power, launchSpeed: speed, impactSpeed: null, impactTime: null, entryX: null, gutter: false, pins: 0, downIds: [], duration: 0, settleTime: 0, path: [] };
    this.events.push('release');
  }
  /** Presentation delta drives gauges; physical motion always uses 120 Hz fixed steps. */
  advance(dt: number, select = false) {
    if (!Number.isFinite(dt) || dt < 0) return;
    this.events.length = 0;
    this.time += dt; this.phaseTime += dt;
    if (this.phase === 'position' || this.phase === 'direction' || this.phase === 'power') {
      if (this.phase === 'position') this.position = positionAt(this.phaseTime);
      if (this.phase === 'direction') this.angle = directionAt(this.phaseTime);
      if (this.phase === 'power') this.power = powerAt(this.phaseTime);
      const bot = this.bots && (this.score.seat > 0 || this.autoHuman);
      if (bot ? this.phaseTime >= this.plan[this.phase] : select && this.score.seat === 0) this.select();
    } else if (this.phase === 'rolling') {
      this.accumulator += Math.min(dt, .1);
      const start = performance.now();
      while (this.accumulator + 1e-9 >= C.step && this.phase === 'rolling') { this.stepPhysics(); this.accumulator -= C.step; }
      this.physicsMs = performance.now() - start;
    } else if (this.phase === 'feedback' && this.phaseTime >= C.resultDuration) {
      const standing = this.pins.filter(p => !p.down).map(p => p.id);
      const next = this.score.advance();
      if (this.ball) this.world.removeRigidBody(this.ball);
      this.ball = null; this.ballCollider = null;
      if (next === 'finished') { this.phase = 'results'; return; }
      this.resetRack(next === 'spare' ? standing : undefined);
      this.phase = 'return'; this.phaseTime = 0; this.plan = this.makePlan();
      this.position = 0; this.angle = 0; this.power = 67.5;
    } else if (this.phase === 'return' && this.phaseTime >= C.returnDuration) {
      this.phase = 'position'; this.phaseTime = 0; this.message = '';
    }
  }
  private stepPhysics() {
    if (!this.ball || !this.shot) return;
    const beforeSpeed = magnitude(this.ball.linvel());
    this.world.step(this.queue); this.rollTime += C.step;
    this.queue.drainCollisionEvents((a, b, started) => {
      if (!started) return;
      if (this.colliderPins.has(a) || this.colliderPins.has(b)) {
        if (a === this.ballCollider || b === this.ballCollider) {
          if (this.shot!.impactTime === null) {
            this.shot!.impactTime = this.rollTime; this.shot!.impactSpeed = beforeSpeed;
            this.shot!.entryX = this.ball!.translation().x; this.contactAt = this.rollTime;
          }
        }
        if ((this.colliderPins.has(a) && this.colliderPins.has(b)) || a === this.ballCollider || b === this.ballCollider) this.events.push('pin');
      }
    });
    const p = this.ball.translation();
    if (!this.shot.gutter && this.shot.impactTime === null && p.z < C.deckEnd && p.y < C.ballRadius - .07 && Math.abs(p.x) > C.laneWidth / 2) { this.shot.gutter = true; this.events.push('gutter'); }
    this.pathClock += C.step;
    if (this.pathClock >= .1) { this.shot.path.push({ ...p }); this.pathClock = 0; }
    for (const pin of this.pins) {
      pin.downFor = pinIsDown(pin.body.translation(), pin.body.rotation()) ? pin.downFor + C.step : 0;
      if (pin.downFor >= .18) pin.down = true;
    }
    if (this.contactAt === null && (p.z > C.deckEnd || magnitude(this.ball.linvel()) < .2 || p.y < -1)) this.contactAt = this.rollTime;
    const quiet = this.pins.every(pin => magnitude(pin.body.linvel()) < .15 && magnitude(pin.body.angvel()) < .8);
    this.stableFor = quiet ? this.stableFor + C.step : 0;
    const settling = this.contactAt === null ? 0 : this.rollTime - this.contactAt;
    if ((settling >= C.settleMin && this.stableFor >= C.stableDuration) || settling >= C.settleMax || this.rollTime >= C.rollTimeout) this.finishRoll(settling);
  }
  private finishRoll(settling: number) {
    const down = this.pins.filter(p => p.down).map(p => p.id);
    this.lastPins = down.length;
    const kind = this.score.record(down.length);
    this.message = kind === 'strike' ? 'STRIKE!' : kind === 'spare' ? 'SPARE!' : down.length ? `${down.length} PİN!` : this.shot?.gutter ? 'OLUK!' : 'TEKRAR DENE';
    this.events.push(kind === 'strike' || kind === 'spare' ? kind : 'score');
    Object.assign(this.shot!, { pins: down.length, downIds: down, duration: this.rollTime, settleTime: settling });
    this.measurements.push(this.shot!);
    this.phase = 'feedback'; this.phaseTime = 0;
  }
  snapshot(): ClassicSnapshot {
    return { phase: this.phase, phaseTime: this.phaseTime, position: this.position, angle: this.angle, power: this.power,
      seat: this.score.seat, frame: Math.min(C.frames, this.score.frame + 1), roll: this.score.roll,
      totals: this.score.totals, cards: this.score.cards.map(card => card.map(f => ({ ...f, rolls: [...f.rolls] }))), standing: this.pins.filter(p => !p.down).map(p => p.id), winners: this.score.winners,
      message: this.message, lastPins: this.lastPins, bot: this.score.seat > 0 };
  }
  stats() {
    let invalid = 0, dynamic = 0;
    this.world.bodies.forEach(b => { if (b.isDynamic()) dynamic++; if (![...Object.values(b.translation()), ...Object.values(b.rotation()), ...Object.values(b.linvel())].every(Number.isFinite)) invalid++; });
    return { bodies: this.world.bodies.len(), colliders: this.world.colliders.len(), dynamic, invalid, launches: this.launches };
  }
  dispose() { this.queue.free(); this.world.free(); }
}
