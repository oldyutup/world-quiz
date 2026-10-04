/** Approved Bowling tuning, shared by local play and the authoritative server. */
/** Authoritative geometry, metres. Physics tuning below never depends on rack distance.
 * Edit anchors here; derived surfaces, target planes, scenery and surveys follow. */
export const COURSE = {
  minZ:-285, maxZ:220, startZ:-267, startHeight:26,
  hillStart:-255, hillEnd:-168, obstacleStart:-126, obstacleEnd:-15,
  // Giant rack, 10m closer. Compact rows leave a full backward topple before
  // the fixed catcher/backdrop; only the non-driving rack apron grows wider.
  prepStart:-8, rampStart:22, rampLip:29, rampHeight:1, headZ:199.5,
  backdropZ:220,
  width:24, roadWidth:12, laneWidth:10, pinScale:4.80, basePinSpacing:.72,
  get finalApproachStart(){return this.obstacleEnd+2;},
  get finalApproachEnd(){return this.rampStart;},
  get rackDistance(){return this.headZ-this.rampLip;},
  get spacing(){return this.basePinSpacing*this.pinScale;},
  get deck(){return {minX:-3*this.pinScale,maxX:3*this.pinScale,minZ:this.headZ-2*this.pinScale,maxZ:this.headZ+3.75*this.pinScale};},
  get runout(){return {minZ:this.deck.maxZ,maxZ:this.maxZ};},
};
export const BOWLING = {
  mode:'human_bowling', label:'İnsan Bowlingi', step:1/60,
  get width(){return COURSE.width;}, get length(){return COURSE.maxZ-COURSE.minZ;},
  get roadWidth(){return COURSE.roadWidth;}, get laneWidth(){return COURSE.laneWidth;},
  get laneLength(){return COURSE.maxZ-COURSE.rampLip;},
  get minZ(){return COURSE.minZ;}, get maxZ(){return COURSE.maxZ;}, get startZ(){return COURSE.startZ;}, get startHeight(){return COURSE.startHeight;},
  get hillStart(){return COURSE.hillStart;}, get hillEnd(){return COURSE.hillEnd;}, get flatEnd(){return COURSE.rampStart;}, get prepStart(){return COURSE.prepStart;},
  get rampStart(){return COURSE.rampStart;}, get rampLip(){return COURSE.rampLip;}, get rampLength(){return COURSE.rampLip-COURSE.rampStart;}, get rampHeight(){return COURSE.rampHeight;},
  get headZ(){return COURSE.headZ;}, get spacing(){return COURSE.spacing;},
  get pinHeight(){return 1.5*COURSE.pinScale;}, get pinRadius(){return .24*COURSE.pinScale;},
  // Gameplay mass is independent of the approved giant visual/collider scale.
  // Controlled ragdoll impacts need both lighter pins and a closer rack to
  // transfer energy. Keep the shape-derived COM and 30/50/20 mass distribution.
  pinMass:5, pinLinearDamping:.12, pinAngularDamping:.22, pinRestitution:.12,
  linearDamping:.035, impactDamping:.10, angularDamping:.10,
  laneFriction:.36, bodyFriction:.20, pinFriction:.38,
  countdown:2.1, driveTimeout:18, settleSeconds:.75, maxThrowSeconds:13, reactionGraceSeconds:12, resultSeconds:1.3,
} as const;
export const CAR = { acceleration:7, brake:18, maxSpeed:46, coast:.65, rideHeight:.64, mass:240, get catcherZ(){return COURSE.rampLip+16;} } as const;
/** Explicit Bowling-only physics profile; geometry never silently retunes it. */
export const FLIGHT = {
  // Explicit 7 m/s² airborne profile for the 170.5m course. Keep unit car
  // momentum transfer; normal gravity resumes on physical ground contact.
  maxSpeed:62, gravityScale:.35, speedGain:1,
  angleMin:0, angleMax:30, angleDefault:0, angleRate:30/.9,
  airAcceleration:1.8, airVelocityCap:1.8, airDistanceCap:4,
  pitchAcceleration:.6, pitchBudget:.8, forwardAcceleration:.7, forwardBudget:.8,
  aerobaticsDrag:.018, sustainedDrag:.032, dragGrace:.35, dragRamp:1.5,
  nudgeForward:1.8, nudgeUp:2.6,
} as const;
/** Effort integrates only while correcting: taps cost almost nothing, sustained
 * input gradually reaches a mild .05/s. No angle, rack or score dependence. */
export function aerobaticsDrag(effort:number,activeSeconds:number){
 return effort*(FLIGHT.aerobaticsDrag+FLIGHT.sustainedDrag*Math.max(0,Math.min(1,(activeSeconds-FLIGHT.dragGrace)/FLIGHT.dragRamp)));
}
export const GROUP = { ground: 1, human: 2, pin: 4, car: 8, carStop: 16 } as const;
export const groups = (member: number, filter: number) => (member << 16) | filter;
/** Integrated grade: 12m rounded crest, 48m steep middle, 27m compression.
 * Profile and colliders share the same sampled curve. */
export const HILL_EASE = 12;
export const BOTTOM_EASE = 27;
export const KICKER = { get start(){return COURSE.hillEnd+6;}, get end(){return COURSE.hillEnd+24;}, height:.4 } as const;
export function roadHeight(z: number): number {
  if (z <= BOWLING.hillStart) return BOWLING.startHeight;
  if (z < BOWLING.hillEnd) {
    const t=z-BOWLING.hillStart, run=BOWLING.hillEnd-BOWLING.hillStart;
    const grade=BOWLING.startHeight/(run-(HILL_EASE+BOTTOM_EASE)/2);
    const drop=t<HILL_EASE?t*t/(2*HILL_EASE):t>run-BOTTOM_EASE?
      run-(HILL_EASE+BOTTOM_EASE)/2-(run-t)**2/(2*BOTTOM_EASE):t-HILL_EASE/2;
    return BOWLING.startHeight-grade*drop;
  }
  if (z>KICKER.start && z<KICKER.end) return KICKER.height*Math.sin(Math.PI*(z-KICKER.start)/(KICKER.end-KICKER.start))**2;
  if (z <= BOWLING.rampStart) return 0;
  if (z <= BOWLING.rampLip) {
    const t=(z-BOWLING.rampStart)/BOWLING.rampLength;
    return BOWLING.rampHeight*t*t*(2-t);
  }
  return 0;
}
export function rackPositions() {
  return Array.from({ length: 4 }, (_, row) => Array.from({ length: row + 1 }, (_, col) => ({ x: (col-row/2)*BOWLING.spacing, y: .006, z: BOWLING.headZ+row*BOWLING.spacing*Math.sqrt(3)/2 }))).flat();
}
export interface BowlingBox { name: string; at: [number, number, number]; half: [number, number, number]; carOnly?: boolean; }
export interface StuntObstacle extends BowlingBox { kind: 'ball'; active: boolean; group: number; }
export const COURSE_BALL_SCALE = 1.35;
export const COURSE_VARIANTS = ['Split entry', 'Late switch', 'Open shoulder', 'Double centre', 'Wide rhythm', 'Tight finish'] as const;
export const courseVariant = (seed: number, round = 1) => ((seed+round-1)%6+6)%6;
/** Authored lane occupancy, not procedural scattering. A round gives each player
 * the same arrangement; replaying a match/round seed reproduces it exactly.
 * Three major decisions leave breathing room before the unchanged final approach.
 * Inactive slots retain reset/shell indices without adding visible hazards. */
export function courseObstacles(seed = 7281, round = 1, enabled = true): StuntObstacle[] {
  const layouts = [
    [[-2.3,-84,1.7],[2.2,-56,1.7],[-1.8,-28,1.65],[0,-10,0],[4.5,-84,0],[-4.6,-56,0]],
    [[2.1,-84,1.8],[-2.2,-56,1.6],[2.1,-28,1.7],[-1.3,-10,0],[-4.4,-84,0],[4.5,-56,0]],
    [[-2.5,-84,1.6],[1.7,-56,1.7],[-2.3,-28,1.5],[1,-10,0],[4.5,-84,0],[-4.5,-56,0]],
    [[0,-84,1.8],[-2.5,-56,1.6],[0,-28,1.7],[0,-10,0],[4.5,-84,0],[4.6,-56,0]],
    [[2.7,-84,1.7],[-2.4,-56,1.7],[1.8,-28,1.5],[-1.5,-10,0],[-4.5,-84,0],[4.6,-56,0]],
    [[-1.7,-84,1.7],[2.4,-56,1.75],[-2,-28,1.6],[.7,-10,0],[4.5,-84,0],[-4.5,-56,0]],
  ];
  return layouts[courseVariant(seed,round)].map(([x,z,r],i)=>{
    const radius=Math.max(.1,r*COURSE_BALL_SCALE);
    // Keep the enlarged shell and sensor clear of the road barriers.
    const limit=BOWLING.roadWidth/2-radius-.15;
    const lateral=Math.max(-limit,Math.min(limit,x*BOWLING.roadWidth/12));
    const depth=obstacleZ(z);
    return {name:`ball-${i}`,kind:'ball',active:enabled&&r>0,group:i<4?i:i-4,
      at:[lateral,radius+roadHeight(depth),depth],half:[radius,radius,radius],carOnly:true};
  });
}
export const obstacleZ=(authored:number)=>COURSE.obstacleStart+(authored+84)/74*(COURSE.obstacleEnd-COURSE.obstacleStart);
export const OBSTACLES = courseObstacles();
/** Landing corridor opens only at the rack apron, long after the car catcher. */
export const landingHalfWidth = (z:number) => z<COURSE.deck.minZ?BOWLING.laneWidth/2:Math.max(BOWLING.laneWidth/2,COURSE.deck.maxX);
export function courseBoxes(): BowlingBox[] {return [
  {name:'floor',at:[0,-.2,(BOWLING.minZ+BOWLING.maxZ)/2],half:[BOWLING.width/2,.2,BOWLING.length/2]},
  // Coplanar wings extend the floor without overlapping the existing collider.
  ...[-1,1].flatMap(side=>COURSE.deck.maxX>BOWLING.width/2?[{name:`rack-wing-${side}`,at:[side*(BOWLING.width/2+COURSE.deck.maxX)/2,-.2,(COURSE.deck.minZ+BOWLING.maxZ)/2] as [number,number,number],half:[(COURSE.deck.maxX-BOWLING.width/2)/2,.2,(BOWLING.maxZ-COURSE.deck.minZ)/2] as [number,number,number]}]:[]),
  {name:'catcher',at:[0,1,BOWLING.maxZ-1],half:[landingHalfWidth(BOWLING.maxZ),1,1]},
  ...[-1,1].flatMap(side=>[[BOWLING.rampLip,COURSE.deck.minZ,BOWLING.laneWidth/2],[COURSE.deck.minZ,BOWLING.maxZ-1,landingHalfWidth(BOWLING.maxZ)]].map(([start,end,width],i)=>({name:`pad-${side<0?'left':'right'}${i?'-rack':''}`,at:[side*(width+.3),.4,(start+end)/2] as [number,number,number],half:[.3,.4,(end-start)/2] as [number,number,number]}))),
];}
export const BOWLING_BOXES=courseBoxes();
/** Connected convex slabs; one metre on bends, long slabs on the flat. */
export function roadHull(z0:number,z1:number) {
  const a=roadHeight(z0),b=roadHeight(z1),w=BOWLING.roadWidth/2;
  return new Float32Array([-w,a-.3,z0,w,a-.3,z0,-w,b-.3,z1,w,b-.3,z1,-w,a,z0,w,a,z0,-w,b,z1,w,b,z1]);
}
const section=(from:number,to:number)=>Array.from({length:Math.ceil(to-from)},(_,i)=>roadHull(from+i,Math.min(to,from+i+1)));
export const roadHulls = () => [roadHull(BOWLING.minZ,BOWLING.hillStart),...section(BOWLING.hillStart,BOWLING.hillEnd),
  roadHull(BOWLING.hillEnd,KICKER.start),...section(KICKER.start,KICKER.end),roadHull(KICKER.end,BOWLING.rampStart),...section(BOWLING.rampStart,BOWLING.rampLip)];
export const wallHulls = () => roadHulls().flatMap(h => [-1,1].map(side => Float32Array.from(h,(v,i)=>i%3===0?side*(BOWLING.roadWidth/2+.3)+(v<0?-.3:.3):i%3===1?v+(i<12?0:.7):v)));
export const ROAD_HULLS=roadHulls(), WALL_HULLS=wallHulls();
export const RAMP_POINTS = ROAD_HULLS[ROAD_HULLS.length-1];
/** Presentation-time angle sweep: no power state or independent launch energy. */
export const angleSweepSeconds = (FLIGHT.angleMax-FLIGHT.angleMin)/FLIGHT.angleRate;
export function launchAngle(seconds:number) {
  const phase=Math.max(0,seconds)%(2*angleSweepSeconds);
  return FLIGHT.angleMin+FLIGHT.angleRate*(phase<=angleSweepSeconds?phase:2*angleSweepSeconds-phase);
}
export const angleDirection = (seconds:number): 'rising' | 'falling' =>
  Math.max(0,seconds)%(2*angleSweepSeconds)<angleSweepSeconds?'rising':'falling';
export function botThrow(seed:number,player:number,round:number) {
  let s=(seed^Math.imul(player+1,0x45d9f3b)^Math.imul(round+1,0x27d4eb2d))>>>0;
  // Avalanche adjacent seeds before sampling skill; nearby seeds must not all be weak.
  s=Math.imul(s^(s>>>16),0x7feb352d);s=Math.imul(s^(s>>>15),0x846ca68b);s=(s^(s>>>16))>>>0;
  const next=()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};
  const quality=next(),bad=quality<.18,good=quality>.65;
  return {
    quality, skill: bad?'bad':good?'good':'average',
    targetX:(next()-.5)*(bad?6:good?1.6:3),
    ejectZ:bad?BOWLING.rampStart-6+next()*(BOWLING.rampLength+7):BOWLING.rampLip-4+next()*4,
    throttle:bad?.45+next()*.35:.9+next()*.1,
    angle:bad?next()*30:good?13+next()*11:8+next()*20,
    side:good ? (seed%2?-1:1) : bad ? (next()<.5?-1:1) : (next()<.85?1:-1)*(seed%2?-1:1),
    nudgeAt:bad?next()*.6:next()<.45?.6+next()*2.8:Infinity,
    airDuration:bad?2+next()*2:good?.12+next()*.3:.3+next()*.7,
    pitch:bad?(next()<.5?-1:1):0,
  };

}

/** Presentation seconds; Rapier always keeps its 1/60 fixed step. */
export const BULLET = { scale: .4, tailHold: .15, tailRamp: .3 } as const;
export function flightTimeScale(seconds: number) {
 const t=Math.max(0,Math.min(1,(seconds-BULLET.tailHold)/BULLET.tailRamp));
 return BULLET.scale+(1-BULLET.scale)*t*t*(3-2*t);
}
