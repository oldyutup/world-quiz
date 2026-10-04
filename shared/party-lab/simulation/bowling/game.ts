import {DEFAULT_BOWLING_SETTINGS} from '../../bowlingSettings.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { createCharacter, restore, connect, type Character } from '../ragdoll/character.js';
import { control, normalDrive } from '../ragdoll/controller.js';
import { PARTS, RAGDOLL } from '../ragdoll/config.js';
import { rotate, product, yaw, cap, finite, length, sub } from '../ragdoll/math.js';
import { BOWLING, CAR, GROUP, groups, COURSE, courseBoxes, landingHalfWidth, roadHulls, wallHulls, aerobaticsDrag, FLIGHT, BULLET, flightTimeScale, launchAngle, angleDirection, courseObstacles, rackPositions, botThrow } from './config.js';
import { StuntCar, type CarInput } from './car.js';
import { courseSteering } from './courseDriving.js';

export type BowlingPhase = 'countdown' | 'drive' | 'flight' | 'score' | 'results';
export interface Pin { body: RAPIER.RigidBody; tiltTime: number; down: boolean; }
/** eject is held Space: release launches, with a committed-selection lip safety. */
export interface BowlingInput extends CarInput { eject: boolean; pitch?: number; }
export const IDLE_INPUT: BowlingInput = { throttle: 0, brake: 0, steer: 0, eject: false };
export class BowlingScore {
  throws: number[][];
  turn = 0;
  constructor(readonly players: 2 | 3) { this.throws = Array.from({ length: players }, () => []); }
  get current() { return this.turn % this.players; }
  get round() { return Math.min(3, Math.floor(this.turn / this.players) + 1); }
  get done() { return this.turn === this.players * 3; }
  get totals() { return this.throws.map(t => t.reduce((a, b) => a + b, 0)); }
  get winners() { const totals = this.totals; return totals.flatMap((n, i) => n === Math.max(...totals) ? [i] : []); }
  record(points: number) {
    if (this.done) return;
    this.throws[this.current].push(Math.max(0, Math.min(10, Math.floor(Number.isFinite(points) ? points : 0))));
    this.turn++;
  }
}
/** Rotation is body-local +Y; translation alone on the deck is never a knockdown. */
export function updatePin(pin: Pin, dt: number) {
  if (pin.down) return;
  const p = pin.body.translation(), up = rotate(pin.body.rotation(), { x: 0, y: 1, z: 0 });
  pin.tiltTime = up.y < 0.5 ? pin.tiltTime + dt : 0;
  const outside = p.x < COURSE.deck.minX || p.x > COURSE.deck.maxX || p.z < COURSE.deck.minZ || p.z > COURSE.deck.maxZ || p.y < -0.3;
  if (outside || pin.tiltTime + 1e-8 >= 0.2) pin.down = true;
}
function ringHull(rings: [number, number][]) {
  const points: number[] = [];
  for (const [y, r] of rings) for (let i = 0; i < 12; i++) points.push(Math.cos(i * Math.PI / 6) * r*COURSE.pinScale, y*COURSE.pinScale, Math.sin(i * Math.PI / 6) * r*COURSE.pinScale);
  return RAPIER.ColliderDesc.convexHull(new Float32Array(points))!;
}
export function createPins(world: RAPIER.World): Pin[] {
  return rackPositions().map(p => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setCcdEnabled(true).setCanSleep(true).setLinearDamping(BOWLING.pinLinearDamping).setAngularDamping(BOWLING.pinAngularDamping));
    const shapes = [
      RAPIER.ColliderDesc.cylinder(0.1*COURSE.pinScale, 0.135*COURSE.pinScale).setTranslation(0, 0.1*COURSE.pinScale, 0),
      ringHull([[0.2, 0.135], [0.38, 0.235], [0.6, 0.24], [0.93, 0.085]]),
      ringHull([[0.93, 0.085], [1.12, 0.085], [1.30, 0.125], [1.43, 0.095], [1.5, 0.025]]),
    ];
    shapes.forEach((shape, i) => world.createCollider(shape.setCollisionGroups(groups(GROUP.pin, GROUP.ground | GROUP.human | GROUP.pin)).setMass(BOWLING.pinMass * [0.3, 0.5, 0.2][i]).setFriction(BOWLING.pinFriction).setRestitution(BOWLING.pinRestitution), body));
    return { body, tiltTime: 0, down: false };
  });
}
/** The seat redirects forward momentum into the chosen angle. A small share of
 * actual ramp rise remains: release position and approach speed both matter. */
export function ejectVelocity(velocity: { x: number; y: number; z: number }, heading: number, angle: number) {
  const radians=Math.max(FLIGHT.angleMin,Math.min(FLIGHT.angleMax,angle))*Math.PI/180;
  const forward=Math.max(0,velocity.x*Math.sin(heading)+velocity.z*Math.cos(heading))*FLIGHT.speedGain;
  const side=velocity.x*Math.cos(heading)-velocity.z*Math.sin(heading);
  return cap({x:Math.sin(heading)*forward*Math.cos(radians)+Math.cos(heading)*side,
    y:forward*Math.sin(radians)+velocity.y*.15,
    z:Math.cos(heading)*forward*Math.cos(radians)-Math.sin(heading)*side},FLIGHT.maxSpeed);
}
/** Mass-weighted travel separates earned momentum from local limb tumble. */
export function bowlingBodyState(character:Character) {
  const bodies=PARTS.map(n=>({body:character.parts[n].body,mass:character.parts[n].collider.mass()})),mass=bodies.reduce((sum,b)=>sum+b.mass,0);
  const velocity=bodies.reduce((sum,b)=>{const v=b.body.linvel(),share=b.mass/mass;return {x:sum.x+v.x*share,y:sum.y+v.y*share,z:sum.z+v.z*share};},{x:0,y:0,z:0});
  return {position:{...character.body.translation()},velocity,
    kineticEnergy:bodies.reduce((sum,b)=>sum+.5*b.mass*length(b.body.linvel())**2,0),
    orientation:rotate(character.parts.torso.body.rotation(),{x:0,y:1,z:0})};
}
export type BowlingBodyState=ReturnType<typeof bowlingBodyState>;
export interface EntryMeasurement {
  firstPin:{time:number;airborne:boolean;segment:string;contactHeight:number;body:BowlingBodyState}|null;
  rack:{time:number;grounded:boolean;body:BowlingBodyState}|null;
  segments:string[];
  nudge:{before:BowlingBodyState;after:BowlingBodyState}|null;
}
/** Diagnostic only. Never consulted by scoring, forces, launch or turn completion. */
export function rackEntryClass(m:ThrowMeasurement) {
  if(m.entry.firstPin){
    if(m.entry.firstPin.airborne)return 'AIRBORNE';
    const gap=BOWLING.headZ-(m.impactPoint?.z??-Infinity);
    return gap<=12?'NEAR':gap<=30?'MEDIUM':'LONG';
  }
  if(!m.rackReached)return 'SHORT';
  return m.entry.rack&&!m.entry.rack.grounded&&m.entry.rack.body.position.y>BOWLING.pinHeight+1?'OVERFLIGHT':'MISS';
}
export interface ThrowMeasurement { entry:EntryMeasurement; groundContact:boolean; rackReached:boolean; maxForwardZ:number; angleDirection:'rising'|'falling'; totalTravel:number; slideDistance:number; groundTime:number; peakHeight:number; landingVelocity:{x:number;y:number;z:number}|null; carSpeed:number; releasePosition:{x:number;y:number;z:number}; aerobaticsSeconds:number; dragLoss:number; nudgeAt:number|null; obstacleHits:number; angle:number; initialVelocity:{x:number;y:number;z:number}; airTime:number; horizontalTravel:number; lateralCorrection:number; pins:number; capSteps:number; airborneCapSteps:number; flightSteps:number; launchCapped:boolean; impactPoint:{x:number;y:number;z:number}|null; impactSpeed:number; }
export class BowlingGame {
  readonly world = new RAPIER.World({ x: 0, y: RAGDOLL.gravity, z: 0 });
  readonly character: Character;
  readonly pins: Pin[];
  readonly score: BowlingScore;
  phase: BowlingPhase = 'countdown';
  readonly car: StuntCar;
  ejected = false;
  charging = false;
  launchCommitted = false;
  chargeTime = 0;
  private displayedChargeTime: number | null = null;
  nudgeUsed = false;
  private launchHeld = false;
  private pendingNudge = false;
  angle: number = FLIGHT.angleDefault;
  get angleDirection() { return angleDirection(this.chargeTime); }
  airVelocity = 0;
  airDistance = 0;
  airBudget = 0;
  pitchBudget = 0;
  forwardBudget = 0;
  activeAirSeconds = 0;
  landed = false;
  readonly obstacles;
  measurement: ThrowMeasurement | null = null;
  readonly measurements: ThrowMeasurement[] = [];
  cancelCharge() { this.charging=false; this.launchCommitted=false; this.displayedChargeTime=null; this.chargeTime=0; this.launchHeld=false;this.pendingNudge=false; }
  /** Called only after the gauge has synchronously reached the DOM. */
  acknowledgeLaunchAngle() { if(this.charging) this.displayedChargeTime=this.chargeTime; }
  get inLaunchRegion() {
    const p=this.car.body.translation();
    return p.z>=BOWLING.prepStart&&p.z<=BOWLING.rampLip&&Math.abs(p.x)<=BOWLING.roadWidth/2&&p.y>=-2;
  }

  tailTime = 0;
  realThrowTime = 0;
  airHeading = 0;
  get timeScale() { return this.phase==='drive'&&this.charging ? BULLET.scale : this.phase==='flight'&&!this.impact ? flightTimeScale(this.tailTime) : 1; }
  /** Angle/easing use presentation time. Nudge is latched until the next fixed step. */
  present(dt: number, input: BowlingInput = IDLE_INPUT) {
    if(this.phase!=='results') this.realThrowTime+=dt;
    if(this.phase==='flight') {
      this.tailTime+=dt;
      if(!this.online&&this.score.current>0) input={...IDLE_INPUT,eject:this.elapsed>=this.bot.nudgeAt};
      if(input.eject&&!this.launchHeld&&!this.impact&&!this.nudgeUsed) this.pendingNudge=true;
      this.launchHeld=input.eject;
      return;
    }
    if(this.phase!=='drive') return;
    input=this.driverInput(input);
    const z=this.car.body.translation().z;
    if(input.eject) {
      // Keep the marked entry, and accept an already-held key on the ramp itself.
      if(!this.launchCommitted&&this.inLaunchRegion&&(!this.launchHeld||z>=BOWLING.rampStart)) {
        this.charging=true;this.launchCommitted=true;this.chargeTime=0;this.angle=launchAngle(0);this.displayedChargeTime=null;
      }
      if(this.launchCommitted&&z>=BOWLING.rampLip) this.eject();
      else if(this.charging){this.chargeTime+=dt;this.angle=launchAngle(this.chargeTime);}
    } else if(this.charging) this.eject();
    this.launchHeld=input.eject;
  }
  private driverInput(input: BowlingInput): BowlingInput {
    if(this.online||this.score.current===0) return input;
    const p=this.car.body.translation();

    const hold=(this.bot.angle-FLIGHT.angleMin)/FLIGHT.angleRate;
    const chargeStart=this.bot.ejectZ-this.car.speed*hold*BULLET.scale;
    return {throttle:this.bot.throttle,brake:0,steer:courseSteering(p,this.car.heading,this.car.speed,this.obstacles,this.car.stuntStates,this.bot.targetX,this.bot.side,this.bot.quality),eject:this.charging?this.angle<this.bot.angle:p.z>=chargeStart};
  }
  missedEject = false;
  driveTime = 0;
  ejectPosition = { x: 0, y: 0, z: 0 };
  inherited = { x: 0, y: 0, z: 0 };
  elapsed = 0;
  phaseTime = 0;
  settled = 0;
  speed = 0;
  lastPoints = 0;
  lastPlayer = 0;
  retries = 0;
  retryNotice = false;
  impact = false;
  readonly durations: number[] = [];
  private bot = botThrow(0, 0, 0);
  private loose = { ...normalDrive(), posture: 0, mobility: 0, jump: false };
  private disposed = false;
  constructor(readonly players: 2 | 3 = 3, readonly seed = 7281, readonly online = false, readonly obstaclesEnabled = DEFAULT_BOWLING_SETTINGS.obstacles) {
    this.score = new BowlingScore(players);
    this.world.timestep = BOWLING.step;
    // One conservative CCD pass avoids impact re-advancement stretching light limbs.
    this.world.maxCcdSubsteps = 1;
    this.obstacles = courseObstacles(seed,1,this.obstaclesEnabled);
    for (const c of courseBoxes()) {
      const shape=RAPIER.ColliderDesc.cuboid(...c.half).setTranslation(...c.at);
      this.world.createCollider(shape.setFriction(c.carOnly?.6:BOWLING.laneFriction).setRestitution(0).setCollisionGroups(groups(GROUP.ground,c.carOnly?GROUP.car:GROUP.car|GROUP.human|GROUP.pin)));
    }
    for(const hull of [...roadHulls(),...wallHulls()]) this.world.createCollider(RAPIER.ColliderDesc.convexHull(hull)!.setFriction(BOWLING.laneFriction).setCollisionGroups(groups(GROUP.ground,GROUP.car|GROUP.human|GROUP.pin)));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(BOWLING.roadWidth/2+1,3,.6).setTranslation(0,3,CAR.catcherZ).setCollisionGroups(groups(GROUP.carStop,GROUP.car)).setRestitution(.05));
    this.car = new StuntCar(this.world, this.obstacles);
    this.character = createCharacter(this.world, 0, { x: 0, y: 1.61, z: 0.15 }, 0);
    for (const name of PARTS) {
      this.character.parts[name].collider.setCollisionGroups(groups(GROUP.human,GROUP.ground | GROUP.pin));
      this.character.parts[name].body.setAdditionalSolverIterations(4);
    }
    this.pins = createPins(this.world);
    this.resetThrow();
  }
  get knocked() { return this.pins.filter(p => p.down).length; }
  get mask() { return this.pins.reduce((n, p, i) => n | (p.down ? 1 << i : 0), 0); }
  resetThrow() {
    courseObstacles(this.seed,this.score.round,this.obstaclesEnabled).forEach((o,i)=>Object.assign(this.obstacles[i],o));
    this.car.reset();
    restore(this.character, { x: 0, y: 1.1, z: BOWLING.startZ }, 0);
    connect(this.world, this.character);
    for (const name of PARTS) this.character.parts[name].body.setEnabled(false);
    rackPositions().forEach((p, i) => {
      const pin = this.pins[i]; pin.down = false; pin.tiltTime = 0;
      pin.body.setTranslation(p, true); pin.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      pin.body.setLinvel({ x: 0, y: 0, z: 0 }, true); pin.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      pin.body.resetForces(true); pin.body.resetTorques(true);
    });
    this.phase = 'countdown'; this.phaseTime = this.elapsed = this.settled = this.speed = this.driveTime = 0;
    this.ejected = this.missedEject = this.impact = this.landed = false; this.pitchBudget=0;this.forwardBudget=0;this.activeAirSeconds=0;this.nudgeUsed=false;
    this.tailTime=this.realThrowTime=0; this.cancelCharge(); this.angle=FLIGHT.angleDefault; this.airVelocity=this.airDistance=this.airBudget=0; this.measurement=null;
    this.ejectPosition = { x: 0, y: 0, z: 0 }; this.inherited = { x: 0, y: 0, z: 0 };
    this.bot = botThrow(this.seed, this.score.current, this.score.round);
  }
  eject() {
    // Eligibility belongs to the committed selection, never the release position/speed.
    if (this.phase !== 'drive' || this.ejected || !this.launchCommitted) return false;
    if(this.displayedChargeTime!==null) {
      this.chargeTime=this.displayedChargeTime;this.angle=launchAngle(this.chargeTime);
    }
    const car = this.car.body.translation(), heading = this.car.heading;
    this.inherited = { ...this.car.body.linvel() };
    this.ejectPosition = { ...car };
    restore(this.character, { x: car.x, y: car.y + 1.05, z: car.z }, heading);
    // A coherent forward lean keeps all anatomical joint anchors aligned.
    const origin = this.character.body.translation(), lean = product(yaw(heading), { x: Math.sin(.25), y: 0, z: 0, w: Math.cos(.25) });
    const v = ejectVelocity(this.inherited, heading, this.angle);
    for (const name of PARTS) {
      const part=this.character.parts[name], b=part.body;
      const p=rotate(yaw(-heading),sub(b.translation(),origin));
      const r=rotate(lean,p);
      b.setTranslation({x:origin.x+r.x,y:origin.y+r.y,z:origin.z+r.z},true);b.setRotation(lean,true);
      b.setEnabled(true);b.setGravityScale(FLIGHT.gravityScale,true);b.setLinearDamping(BOWLING.linearDamping);b.setAngularDamping(BOWLING.angularDamping);
      part.collider.setFriction(BOWLING.bodyFriction);part.collider.setRestitution(.16);
      // A coherent rotation field avoids exploding joint anchors. The small
      // left/right asymmetry unfolds the limbs instead of freezing a dart pose.
      const spin=rotate(yaw(heading),{x:1.1+this.car.speed*.025+this.angle*.009-this.car.pitch*.7,y:this.car.heading*.6,z:this.inherited.x*.035+this.car.pitch*.3});
      b.setLinvel({x:v.x+spin.y*r.z-spin.z*r.y,y:v.y+spin.z*r.x-spin.x*r.z,z:v.z+spin.x*r.y-spin.y*r.x},true);
      b.setAngvel(spin,true);
    }
    this.measurement={entry:{firstPin:null,rack:null,segments:[],nudge:null},groundContact:false,rackReached:false,maxForwardZ:car.z,angleDirection:this.angleDirection,totalTravel:0,slideDistance:0,groundTime:0,peakHeight:origin.y,landingVelocity:null,carSpeed:this.car.speed,releasePosition:{...car},aerobaticsSeconds:0,dragLoss:0,nudgeAt:null,obstacleHits:this.car.hitCount,angle:this.angle,initialVelocity:{...v},airTime:0,horizontalTravel:0,lateralCorrection:0,pins:0,capSteps:0,airborneCapSteps:0,flightSteps:0,launchCapped:length(v)>=FLIGHT.maxSpeed-1e-6,impactPoint:null,impactSpeed:0};
    this.charging=false;this.launchCommitted=false;this.displayedChargeTime=null;this.tailTime=0;this.airHeading=heading;
    this.character.facing=heading;
    control(this.world,this.character,{x:0,z:0,jump:false},this.loose);
    this.speed=length(v);this.ejected=true;this.phase='flight';this.phaseTime=this.elapsed=0;this.retryNotice=false;
    return true;
  }
  private valid() {
    for (const body of [...PARTS.map(n => this.character.parts[n].body), ...this.pins.map(p => p.body)]) {
      const q = body.rotation();
      if (![body.translation(), body.linvel(), body.angvel(), q].every(finite) || !Number.isFinite(q.w)) return false;
    }
    return PARTS.every(n => length(sub(this.character.parts[n].body.translation(), this.character.body.translation())) < RAGDOLL.maxPartSeparation);
  }
  private guard() {
    let capped=false;
    for (const name of PARTS) {
      const b = this.character.parts[name].body;
      if (length(b.linvel()) > FLIGHT.maxSpeed) { capped=true;b.setLinvel(cap(b.linvel(), FLIGHT.maxSpeed), true); }
      if (length(b.angvel()) > RAGDOLL.maxAngularSpeed) b.setAngvel(cap(b.angvel(), RAGDOLL.maxAngularSpeed), true);
    }
    if(capped&&this.measurement) {this.measurement.capSteps++;if(!this.impact)this.measurement.airborneCapSteps++;}
  }
  finishThrow() {
    if (this.phase !== 'flight') return;
    if(this.measurement){if(!this.landed){const p=this.character.body.translation();this.measurement.airTime=this.elapsed;this.measurement.horizontalTravel=Math.hypot(p.x-this.ejectPosition.x,p.z-this.ejectPosition.z);this.measurement.lateralCorrection=this.airDistance;}this.measurement.pins=this.knocked;this.measurements.push({...this.measurement});}
    this.lastPoints = this.knocked; this.lastPlayer = this.score.current;
    this.durations.push(this.realThrowTime + BOWLING.resultSeconds); this.score.record(this.lastPoints);
    this.phase = this.score.done ? 'results' : 'score'; this.phaseTime = 0;
  }
  step(input: BowlingInput = IDLE_INPUT, presentationDt: number = BOWLING.step) {
    if(presentationDt>0) this.present(presentationDt,input);
    const dt = BOWLING.step;
    this.phaseTime += dt;
    if (this.phase === 'results') return;
    if (this.phase === 'score') { if (this.phaseTime >= BOWLING.resultSeconds) this.resetThrow(); return; }
    if (this.phase === 'countdown') {
      this.car.step({throttle:0,brake:1,steer:0});this.world.step();
      if(this.phaseTime >= BOWLING.countdown) { this.phase='drive';this.phaseTime=0; }
      return;
    }
    if (this.phase === 'drive') {
      this.driveTime += dt;
      const p=this.car.body.translation();
      input=this.driverInput(input);
      this.car.step(input);this.world.step();this.speed=this.car.speed;
      // Catch the first physics step crossing the lip, before any missed-throw path.
      if(this.launchCommitted&&this.car.body.translation().z>=BOWLING.rampLip) { this.eject();return; }
      if(p.z>CAR.catcherZ-2 || (!this.launchCommitted&&this.driveTime>=BOWLING.driveTimeout) || Math.abs(p.x)>BOWLING.width/2 || p.y< -2) {
        this.cancelCharge();
        this.missedEject=true;this.phase='flight';this.elapsed=0;this.finishThrow();
      }
      return;
    }
    if (!this.valid()) { this.retries++; this.retryNotice = true; this.resetThrow(); return; }
    if(this.measurement)this.measurement.flightSteps++;
    this.guard();
    const previous={...this.character.body.translation()}, beforeVelocity={...this.character.body.linvel()};
    this.car.step({throttle:0,brake:1,steer:0},true);
    control(this.world, this.character, { x: 0, z: 0, jump: false }, this.loose);
    if(!this.impact) {
      const p=this.character.body.translation(), velocity=this.character.body.linvel();
      const remainingTime=Math.max(0,(BOWLING.headZ-p.z)/Math.max(1,velocity.z));
      const projectedX=p.x+velocity.x*remainingTime;
      const steer=!this.online&&this.score.current>0?(this.elapsed<this.bot.airDuration?Math.max(-1,Math.min(1,(this.bot.targetX-projectedX)*.65)):0):Math.max(-1,Math.min(1,input.steer));
      const pitch=!this.online&&this.score.current>0?(this.elapsed<this.bot.airDuration?this.bot.pitch:0):Math.max(-1,Math.min(1,input.pitch??0));
      // Rapier reenables collider mass on the first world step. Keep a fresh
      // press latched until then, never consume a zero-mass impulse.
      if(this.pendingNudge&&!this.nudgeUsed&&this.character.body.mass()>0) {
        this.nudgeUsed=true;
        const nudgeBefore=bowlingBodyState(this.character);
        // Mass-weighted horizontal travel ignores the pelvis's tumbling velocity.
        const travel=PARTS.reduce((v,name)=>{const b=this.character.parts[name].body,w=b.linvel();return {x:v.x+w.x*b.mass(),z:v.z+w.z*b.mass()};},{x:0,z:0});
        const speed=Math.hypot(travel.x,travel.z), direction=speed>1e-6?{x:travel.x/speed,z:travel.z/speed}:{x:Math.sin(this.airHeading),z:Math.cos(this.airHeading)};
        for(const name of PARTS){const b=this.character.parts[name].body;b.applyImpulse({x:direction.x*b.mass()*FLIGHT.nudgeForward,y:b.mass()*FLIGHT.nudgeUp,z:direction.z*b.mass()*FLIGHT.nudgeForward},true);}
        if(this.measurement){this.measurement.nudgeAt=this.elapsed;this.measurement.entry.nudge={before:nudgeBefore,after:bowlingBodyState(this.character)};}
      }
      if(this.nudgeUsed)this.pendingNudge=false;
      const effort=Math.min(1,Math.hypot(steer,pitch));
      this.activeAirSeconds+=effort*dt;
      const drag=aerobaticsDrag(effort,this.activeAirSeconds);
      const retention=Math.exp(-drag*dt);
      if(this.measurement){
        if(effort>0)this.measurement.aerobaticsSeconds+=dt;
        this.measurement.dragLoss+=Math.hypot(velocity.x,velocity.z)*(1-retention);
      }
      // Drag uses pelvis travel as the flight reference, acting equally on all limbs,
      // retaining their relative velocities and the loose physical tumble.
      for(const name of PARTS){const b=this.character.parts[name].body,v=b.linvel();b.setLinvel({x:v.x-velocity.x*(1-retention),y:v.y,z:v.z-velocity.z*(1-retention)},true);}
      // Frozen launch yaw: +steer is A / screen-left, -steer is D / screen-right.
      // Neither trajectory nor torque axes follow the tumbling torso/pelvis.
      const torque=rotate(yaw(this.airHeading),{x:pitch*(pitch<0?.72:.4)*dt,y:steer*.3*dt,z:steer*.48*dt});
      this.character.parts.torso.body.applyTorqueImpulse(torque,true);
      this.character.body.applyTorqueImpulse({x:torque.x*.35,y:torque.y*.35,z:torque.z*.35},true);
      const forwardChange=Math.min(Math.max(0,pitch)*FLIGHT.forwardAcceleration*dt,Math.max(0,FLIGHT.forwardBudget-this.forwardBudget));
      this.forwardBudget+=forwardChange;
      const pitchChange=Math.sign(pitch)*Math.min(Math.abs(pitch)*FLIGHT.pitchAcceleration*dt,FLIGHT.pitchBudget-this.pitchBudget);
      this.pitchBudget+=Math.abs(pitchChange);
      // Equal and opposite impulses articulate limbs without moving the centre
      // of mass. Pose oscillation uses sim time, never random per-frame noise.
      for(const [i,name] of (['leftUpper','rightUpper','leftLeg','rightLeg'] as const).entries()) {
        const b=this.character.parts[name].body;
        const impulse={x:(Math.sin(this.elapsed*4.1+i*1.9)*.045+pitch*.025)*dt,y:0,z:(steer*.025+Math.sin(this.elapsed*2.7+i)*.018)*dt};
        b.applyTorqueImpulse(impulse,true);
        this.character.parts.torso.body.applyTorqueImpulse({x:-impulse.x,y:0,z:-impulse.z},true);
      }
      const old=this.airVelocity;
      let next=Math.max(-FLIGHT.airVelocityCap,Math.min(FLIGHT.airVelocityCap,old+steer*FLIGHT.airAcceleration*dt));
      // Bound total absolute travel caused by air control, including subsequent drift.
      const remaining=Math.max(0,FLIGHT.airDistanceCap-this.airBudget);
      next=Math.max(-remaining/dt,Math.min(remaining/dt,next));
      const dv=next-old;this.airVelocity=next;this.airDistance+=next*dt;this.airBudget+=Math.abs(next)*dt;
      const heading=this.airHeading;
      // Aerodynamic correction acts through the visible core; joints pull the
      // limbs along. W adds a small finite forward push; S reverses pitch/lift.
      const mass=PARTS.reduce((sum,name)=>sum+this.character.parts[name].body.mass(),0);
      for(const [name,share] of [['pelvis',.45],['torso',.55]] as const) {
        this.character.parts[name].body.applyImpulse({x:(Math.cos(heading)*dv+Math.sin(heading)*forwardChange)*mass*share,y:pitchChange*mass*share,z:(-Math.sin(heading)*dv+Math.cos(heading)*forwardChange)*mass*share},true);
      }
    }
    const beforeContact=bowlingBodyState(this.character);
    this.world.step();
    if (!this.valid()) { this.retries++; this.retryNotice = true; this.resetThrow(); return; }
    this.guard(); this.elapsed += dt;
    this.pins.forEach(pin => updatePin(pin, dt));
    if(this.measurement) {
      const p=this.character.body.translation(), distance=Math.hypot(p.x-previous.x,p.z-previous.z);
      this.measurement.totalTravel+=distance;
      if(!this.measurement.entry.rack&&p.z>=BOWLING.headZ)this.measurement.entry.rack={time:this.elapsed,grounded:this.landed,body:bowlingBodyState(this.character)};
      this.measurement.maxForwardZ=Math.max(this.measurement.maxForwardZ,p.z);
      // Reach is longitudinal range or confirmed pin impact (a leading limb
      // can hit pins while the pelvis stops just before the head-pin plane).
      this.measurement.rackReached ||= p.z>=BOWLING.headZ || this.knocked>0;
      this.measurement.peakHeight=Math.max(this.measurement.peakHeight,p.y);
      if(this.landed){this.measurement.slideDistance+=distance;this.measurement.groundTime+=dt;}
    }
    if(this.elapsed>.08 && (!this.landed || Math.abs(this.character.body.translation().z-BOWLING.headZ)<12*COURSE.pinScale)) {
      let contact=false, ground=false;
      for(const name of PARTS) {
        const collider=this.character.parts[name].collider;
        this.world.contactPairsWith(collider,other=>{
          this.world.contactPair(collider,other,manifold=>{
            if(manifold.numSolverContacts()>0){
              contact=true;const group=other.collisionGroups()>>>16;ground ||= group===GROUP.ground;
              if(group===GROUP.pin&&this.measurement){const entry=this.measurement.entry;
                entry.firstPin??={time:this.elapsed,airborne:!this.landed,segment:name,contactHeight:this.character.parts[name].body.translation().y,body:beforeContact};
                if(!entry.segments.includes(name))entry.segments.push(name);
              }
            }
          });
        });
      }
      if(contact) this.impact=true;
      // Contacts in the same fixed step have no reliable substep ordering.
      // Conservatively classify simultaneous floor/pin contact as recovery.
      if(ground&&this.measurement?.entry.firstPin?.time===this.elapsed)this.measurement.entry.firstPin.airborne=false;
      if(ground&&!this.landed) {
        this.landed=true;
        const p=this.character.body.translation();
        if(this.measurement){this.measurement.groundContact=true;this.measurement.airTime=this.elapsed;this.measurement.horizontalTravel=Math.hypot(p.x-this.ejectPosition.x,p.z-this.ejectPosition.z);this.measurement.lateralCorrection=this.airDistance;this.measurement.impactPoint={...p};this.measurement.impactSpeed=length(beforeVelocity);this.measurement.landingVelocity=beforeVelocity;}
        for(const name of PARTS){this.character.parts[name].body.setGravityScale(1,true);this.character.parts[name].body.setLinearDamping(BOWLING.impactDamping);}
      }
    }
    const bodies = [...this.pins.map(p => p.body), ...PARTS.map(n => this.character.parts[n].body)];
    const moving = bodies.some(b => {
      const p = b.translation();
      if (p.y < -3 || Math.abs(p.x) > Math.max(BOWLING.width/2,landingHalfWidth(p.z)) || p.z > BOWLING.maxZ+2 || p.z < BOWLING.minZ-2) return false;
      return length(b.linvel()) > 0.16 || length(b.angvel()) > 0.25;
    });
    this.settled = moving ? 0 : this.settled + dt;
    // A slow wobble can topple a standing pin after the normal resolution window.
    // Keep simulating that chain; an already-final strike needs no scoring grace.
    const pendingPins=this.knocked<10 && this.pins.some(pin=>{
      const v=length(pin.body.linvel()),w=length(pin.body.angvel());
      return pin.down ? v>.2 : v>.025 || w>.025;
    });
    const deadline=this.elapsed+1e-8>=BOWLING.maxThrowSeconds && (!pendingPins || this.elapsed+1e-8>=BOWLING.maxThrowSeconds+BOWLING.reactionGraceSeconds);
    if ((this.elapsed > 1 && this.settled >= BOWLING.settleSeconds && !pendingPins) || deadline) this.finishThrow();
  }
  dispose() { if (!this.disposed) { this.disposed = true; this.world.free(); } }
}
