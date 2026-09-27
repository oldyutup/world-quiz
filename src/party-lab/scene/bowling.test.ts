import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import { PerspectiveCamera, Vector3 } from 'three';
import { initializePhysics } from './physics';
import { PARTS, RAGDOLL } from './ragdoll/config';
import { length, rotate } from './ragdoll/math';
import { BOWLING, COURSE, courseBoxes, roadHulls, CAR, FLIGHT, GROUP, groups, OBSTACLES, roadHeight, rackPositions, botThrow, launchAngle, courseObstacles } from './bowling/config';
import { BowlingGame, bowlingBodyState, BowlingScore, updatePin, ejectVelocity, IDLE_INPUT, rackEntryClass, type ThrowMeasurement } from './bowling/game';
import { BowlingClock } from './bowling/clock';
import { courseSteering } from './bowling/courseDriving';
import { BULLET, flightTimeScale } from './bowling/config';
import { bowlingCamera, BOWLING_DRIVE_PRESETS } from './bowling/camera';
await initializePhysics();
const withGame=(fn:(g:BowlingGame)=>void,players:2|3=2)=>{const g=new BowlingGame(players);try{fn(g);}finally{g.dispose();}};
const drive={...IDLE_INPUT,throttle:1};
function ready(g:BowlingGame){while(g.phase==='countdown')g.step();}
function line(g:BowlingGame,side=1){return courseSteering(g.car.body.translation(),g.car.heading,g.car.speed,g.obstacles,g.car.stuntStates,0,side);}
function launch(g:BowlingGame,angle=25,z=28,side=1){
 ready(g);const clock=new BowlingClock();let started=false;
 for(let i=0;i<3600&&g.phase==='drive';i++){
  const p=g.car.body.translation();if(p.z>=z-g.car.speed*(angle-FLIGHT.angleMin)/FLIGHT.angleRate*BULLET.scale)started=true;
  clock.advance(g,1/120,{...drive,steer:line(g,side),eject:started&&(!g.charging||g.chargeTime+1e-8<angle/FLIGHT.angleRate)});
 }
 assert.equal(g.phase,'flight');assert.ok(g.ejected);
}
function finish(g:BowlingGame,steer=0){while(g.phase==='flight')g.step({...IDLE_INPUT,steer});}

/** Full approach: throttle/brake and the held/released gauge, no state injection. */
function courseShot(kmh:number,angle:number,nudge=Infinity){
 const g=new BowlingGame(2,7281),clock=new BowlingClock();let armed=false;
 try{
  for(let i=0;i<16000&&g.score.turn===0;i++){
   const speed=g.car.speed,p=g.car.body.translation();
   if(g.phase==='drive'&&p.z>=BOWLING.rampLip-1-speed*angle/FLIGHT.angleRate*BULLET.scale)armed=true;
   const input=g.phase==='drive'?{...IDLE_INPUT,throttle:speed<kmh/3.6?1:0,brake:speed>kmh/3.6+.1?.55:0,steer:line(g),eject:armed&&(!g.charging||g.chargeTime+1e-8<angle/FLIGHT.angleRate)}:{...IDLE_INPUT,eject:g.elapsed>=nudge};
   clock.advance(g,1/120,input);
  }
  assert.equal(g.score.turn,1);assert.equal(g.retries,0);
  const m=g.measurements[0];assert.ok(m);assert.ok(Math.abs(m.carSpeed*3.6-kmh)<.5);
  assert.equal(m.launchCapped,false);assert.equal(m.airborneCapSteps,0);return m;
 }finally{g.dispose();}
}

test('170.5m course has neighboring no-Nudge recipes at human approach speeds',()=>{
 for(const [speed,center] of [[145,25],[150,23],[155,21]]){
  const shots=[-3,-2,-1,0,1,2,3].map(delta=>courseShot(speed,center+delta));
  assert.ok(shots.every(m=>m.entry.firstPin),'all seven nearby angles must physically contact the rack');
  assert.ok(shots.filter(m=>m.entry.firstPin?.airborne).length>=4);
  assert.ok(shots.filter(m=>m.pins>0).length>=5,'useful angles must form a region');
  assert.ok(shots.every(m=>m.nudgeAt===null));
 }
});

test('unchanged one-use Nudge rescues marginal range and risks physical overflight',()=>{
 const marginal=courseShot(135,26),rescued=courseShot(135,26,1.2);
 assert.equal(marginal.entry.firstPin?.airborne,false);assert.equal(marginal.pins,0);
 assert.equal(rescued.entry.firstPin?.airborne,true);assert.ok(rescued.pins>0);
 assert.ok(rescued.entry.firstPin!.body.velocity.z>28);
 const strong=courseShot(145,26),excess=courseShot(145,26,.3);
 assert.equal(rackEntryClass(strong),'AIRBORNE');assert.ok(strong.pins>0);
 assert.equal(rackEntryClass(excess),'OVERFLIGHT');assert.equal(excess.pins,0);
 assert.equal(excess.entry.firstPin,null);assert.ok(excess.maxForwardZ>BOWLING.maxZ);
});

test('505m course, short staging, eased 26m descent and continuous lower kicker',()=>{
 assert.equal(BOWLING.maxZ-BOWLING.minZ,505);assert.equal(BOWLING.roadWidth,12);assert.equal(roadHeight(BOWLING.startZ),26);
 assert.equal(BOWLING.hillEnd-BOWLING.hillStart,87);assert.equal(BOWLING.flatEnd-BOWLING.hillEnd,190);
 for(let z=BOWLING.hillStart;z<BOWLING.hillEnd;z+=.1){const drop=roadHeight(z)-roadHeight(z+.1);assert.ok(drop>=-1e-9&&drop<=.058);}
 for(const z of [-255,-168,-162,-144,22])assert.ok(Math.abs(roadHeight(z-.001)-roadHeight(z+.001))<.0001);
 assert.equal(BOWLING.hillStart-BOWLING.startZ,12);assert.equal(roadHeight(-153),.4);
});
test('six bowling-ball slots, open launch approach, low eased ramp and coherent 170.5m rack',()=>{
 assert.equal(OBSTACLES.length,6);for(const c of OBSTACLES){assert.ok(Math.abs(c.at[0])+c.half[0]<6);assert.ok(c.at[2]+c.half[2]+1<BOWLING.prepStart);}
 assert.equal(BOWLING.rampStart-BOWLING.prepStart,30);assert.equal(BOWLING.rampLip-BOWLING.rampStart,7);assert.equal(roadHeight(29),1);assert.equal(BOWLING.headZ-BOWLING.rampLip,170.5);
 assert.equal(rackPositions().length,10);assert.equal(new Set(rackPositions().map(p=>`${p.x}:${p.z}`)).size,10);
});

test('generated road collision continuously matches surface from high start through ramp',()=>withGame(g=>{
 g.world.step();for(let z=BOWLING.minZ+1;z<29;z+=.23){const hit=g.world.castRay(new RAPIER.Ray({x:2.9,y:50,z},{x:0,y:-1,z:0}),55,true,RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);assert.ok(hit,`ray miss at ${z}`);assert.ok(Math.abs(50-hit.timeOfImpact-roadHeight(z))<.018,`seam at ${z}`);}
}));

test('car starts high, idle stable, resets fresh driver and rack',()=>withGame(g=>{
 const p={...g.car.body.translation()};assert.equal(p.z,BOWLING.startZ);assert.ok(p.y>26.6);for(const n of PARTS)assert.equal(g.character.parts[n].body.isEnabled(),false);
 ready(g);assert.ok(Math.abs(g.car.body.translation().y-BOWLING.startHeight-CAR.rideHeight)<.03);assert.equal(g.car.speed,0);
 launch(g);finish(g);g.resetThrow();assert.deepEqual({...g.car.body.translation()},p);assert.equal(g.knocked,0);assert.equal(g.charging,false);
}));

test('car stays behind, is excluded from pin collision and cannot score',()=>withGame(g=>{
 ready(g);g.car.body.setTranslation({x:0,y:.5,z:51},true);g.car.body.setLinvel({x:0,y:0,z:18},true);for(let i=0;i<30;i++)g.world.step();for(const p of g.pins){assert.ok(rotate(p.body.rotation(),{x:0,y:1,z:0}).y>.99);assert.ok(length(p.body.linvel())<.1);}
 g.resetThrow();launch(g);const z=g.car.body.translation().z;finish(g);assert.ok(g.car.body.translation().z>z);assert.ok(g.car.body.translation().z<CAR.catcherZ);assert.ok(g.car.speed<.1);
}));

test('no-eject and idle timeout advance with zero points, invalid ragdoll retries safely',()=>withGame(g=>{
 for(let i=0;i<1500&&g.score.turn===0;i++)g.step();assert.equal(g.missedEject,true);assert.equal(g.lastPoints,0);
 g.score.turn=0;g.resetThrow();launch(g);g.character.parts.head.body.setTranslation({x:100,y:0,z:0},true);g.step();assert.equal(g.phase,'countdown');assert.equal(g.retries,1);assert.equal(g.score.turn,0);
}));

test('stable horizon cameras reveal downhill, widen at speed, follow actual airborne body',()=>{
 const p={x:0,y:26.64,z:-267},slow=bowlingCamera('drive',p,false,p,0,0),fast=bowlingCamera('drive',p,false,p,0,46);
 assert.equal(slow.fov,58);assert.equal(fast.fov,68);assert.equal(fast.position.z,p.z-7);assert.ok(fast.target.y<fast.position.y);const flight=bowlingCamera('flight',{x:2,y:5,z:40},false,p,0,24);assert.equal(flight.position.x,2);assert.equal(flight.position.z,32);assert.ok(flight.fov>=65&&flight.fov<=72);
});

test('curated kit: one material, named car, bounded geometry, no external references',()=>{
 const bytes=fs.readFileSync(new URL('../../../public/party-lab/maps/bowling/bowling-kit.glb',import.meta.url));const json=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
 assert.ok(bytes.length<256000);assert.equal(json.meshes.length,14);assert.equal(json.materials.length,1);assert.equal(json.images,undefined);assert.ok(json.nodes.some((n:{name:string})=>n.name==='Car'));assert.ok(json.meshes.every((m:{primitives:unknown[]})=>m.primitives.length===1));
});

test('bowling pins: ten independent bodies, three simple colliders each, tuned mass, stand naturally for 30 seconds', () => withGame(g => {
  assert.equal(g.pins.length,10); assert.equal(new Set(g.pins.map(p=>p.body.handle)).size,10);
  for(let t=0;t<1800;t++)g.world.step();
  for(const p of g.pins){assert.equal(p.body.numColliders(),3);assert.ok(Math.abs(p.body.mass()-BOWLING.pinMass)<1e-5);assert.equal(p.body.isCcdEnabled(),true);assert.ok(rotate(p.body.rotation(),{x:0,y:1,z:0}).y>.99);assert.ok(Math.abs(p.body.translation().y)<.02);}
}));

test('bowling pin detection: sustained >60 degrees, temporary wobble ignored, upright sliding ignored, OOB and latch', () => withGame(g => {
  const p=g.pins[0]; const tilt=(degrees:number)=>p.body.setRotation({x:Math.sin(degrees*Math.PI/360),y:0,z:0,w:Math.cos(degrees*Math.PI/360)},true);
  tilt(65);updatePin(p,.1);assert.equal(p.down,false);tilt(0);updatePin(p,.1);assert.equal(p.tiltTime,0);
  p.body.setTranslation({x:.6,y:0,z:BOWLING.headZ+.5},true);updatePin(p,1);assert.equal(p.down,false);
  tilt(65);for(let i=0;i<12;i++)updatePin(p,1/60);assert.equal(p.down,true);tilt(0);updatePin(p,1);assert.equal(g.knocked,1);
  const q=g.pins[1];q.body.setTranslation({x:0,y:0,z:COURSE.deck.maxZ+.1},true);updatePin(q,1/60);assert.equal(g.knocked,2);updatePin(q,5);assert.equal(g.knocked,2);
}));

for(const players of [2,3] as const)test(`bowling scoring: ${players} players alternate exactly three throws, max 30 and shared ties`,()=>{
  const s=new BowlingScore(players);const turns=[];
  for(let i=0;i<players*3;i++){turns.push(s.current);assert.equal(s.round,Math.floor(i/players)+1);s.record(10);}
  assert.deepEqual(turns,Array.from({length:players*3},(_,i)=>i%players));assert.equal(s.done,true);assert.deepEqual(s.totals,Array(players).fill(30));assert.equal(s.winners.length,players);s.record(10);assert.equal(s.turn,players*3);assert.ok(s.throws.every(t=>t.length===3));
});

test('bowling scoring: invalid and out of range points cannot exceed 0–10',()=>{const s=new BowlingScore(2);[NaN,-4,99,3.9,0,10].forEach(n=>s.record(n));assert.deepEqual(s.throws,[[0,10,0],[0,3,10]]);assert.deepEqual(s.winners,[1]);});


test('six authored round layouts reset sensors and give every player the same obstacles',()=>{
 const layouts=Array.from({length:6},(_,seed)=>courseObstacles(seed));
 assert.equal(new Set(layouts.map(l=>JSON.stringify(l))).size,6);
 for(const layout of layouts)for(const box of layout)assert.ok(box.at[2]+box.half[2]+1<BOWLING.prepStart);
 withGame(g=>{const before=JSON.stringify(g.obstacles);g.score.turn=1;g.resetThrow();assert.equal(JSON.stringify(g.obstacles),before);
  g.score.turn=2;g.resetThrow();assert.notEqual(JSON.stringify(g.obstacles),before);
  g.obstacles.forEach((o,i)=>{assert.equal(g.car.props[i].collider.isEnabled(),o.active);assert.ok(Math.abs(g.car.props[i].collider.translation().x-o.at[0])<1e-5);});
 });
});
test('post-hill kicker unloads the chassis without ejecting the seated driver',()=>withGame(g=>{
 ready(g);let airborne=0;while(g.car.body.translation().z< -130){g.step(drive);if(g.car.body.translation().z> -155&&!g.car.grounded)airborne+=BOWLING.step;assert.equal(g.ejected,false);}
 assert.ok(airborne>.15&&airborne<.8);assert.ok(g.car.speed>20);
}));

test('legacy far camera: summit physically hides lower course, descent progressively reveals the rack',()=>withGame(g=>{
 g.world.step();
 for(const z of [BOWLING.startZ,-210]){
  const p={x:0,y:roadHeight(z)+CAR.rideHeight,z},camera=bowlingCamera('drive',p,false,p,0,0,16/9,3).position;
  const target={x:0,y:1,z:BOWLING.headZ},d={x:0,y:target.y-camera.y,z:target.z-camera.z},distance=Math.hypot(d.y,d.z);
  const hit=g.world.castRay(new RAPIER.Ray(camera,{x:0,y:d.y/distance,z:d.z/distance}),distance,true,undefined,groups(GROUP.human,GROUP.ground|GROUP.pin));
  if(z===BOWLING.startZ)assert.ok(hit&&hit.timeOfImpact<30,'road crest must occlude rack');
  else assert.ok(!hit||hit.timeOfImpact>distance-3,'rack opens during descent');
 }
}));

test('launch energy comes only from car velocity, angle redistributes it',()=>{
 const low=ejectVelocity({x:0,y:0,z:10},0,25),fast=ejectVelocity({x:0,y:0,z:20},0,25);
 assert.ok(Math.abs(length(fast)-length(low)*2)<1e-9);
 assert.equal(length(ejectVelocity({x:0,y:0,z:0},0,75)),0);
 const shallow=ejectVelocity({x:0,y:0,z:20},0,12),high=ejectVelocity({x:0,y:0,z:20},0,55);
 assert.ok(high.y>shallow.y&&high.z<shallow.z);assert.ok(Math.abs(length(high)-length(shallow))<1e-9);
 assert.equal(RAGDOLL.maxSpeed,18);assert.equal(RAGDOLL.gravity,-20);
});
test('angle reverses at 30 and zero every .9 presentation seconds, without wrapping',()=>{
 for(const [t,a] of [[0,0],[.45,15],[.9,30],[1.35,15],[1.8,0],[2.25,15],[2.7,30]])assert.ok(Math.abs(launchAngle(t)-a)<1e-9);
 assert.ok(launchAngle(.899)>29.9&&launchAngle(.901)>29.9);
 withGame(g=>{ready(g);g.step({...drive,pitch:1});assert.equal(g.angle,0);assert.equal('power' in g,false);});
});
test('early Space cannot arm; zone press slows physical progress and release ejects once',()=>withGame(g=>{
 ready(g);g.step({...drive,eject:true});assert.equal(g.charging,false);
 while(g.car.body.translation().z<12)g.step({...drive,steer:line(g),eject:true});assert.equal(g.charging,false);
 g.step({...drive,steer:line(g)});
 const c=new BowlingClock(),z=g.car.body.translation().z;
 for(let i=0;i<60;i++)c.advance(g,1/120,{...drive,eject:true});
 assert.equal(g.timeScale,.4);assert.ok(Math.abs(c.simulationTime-.2)<1e-8);assert.ok(g.car.body.translation().z>z+3);assert.ok(Math.abs(g.angle-launchAngle(.5))<.01);
 c.advance(g,1/120,IDLE_INPUT);assert.ok(g.ejected);assert.equal(g.eject(),false);
 assert.ok(Math.abs(g.world.timestep-BOWLING.step)<1e-8);
}));
test('canceling held launch never ejects or consumes a Nudge',()=>withGame(g=>{
 ready(g);while(g.car.body.translation().z<12)g.step({...drive,steer:line(g)});
 g.step({...drive,eject:true});assert.ok(g.charging);g.cancelCharge();g.step();assert.equal(g.ejected,false);assert.equal(g.nudgeUsed,false);
}));
test('holding past ramp safety ejects; turn still completes',()=>withGame(g=>{
 ready(g);for(let i=0;i<2400&&g.score.turn===0;i++)g.step({...drive,steer:line(g),eject:g.car.body.translation().z>=6});
 assert.equal(g.missedEject,false);assert.ok(g.ejected);assert.equal(g.score.turn,1);
}));
function placeOnRamp(g:BowlingGame,z:number,speed=3) {
 g.phase='drive';g.car.body.setTranslation({x:0,y:roadHeight(z)+CAR.rideHeight,z},true);
 g.car.body.setLinvel({x:0,y:0,z:speed},true);
}
for(const [name,start,end] of [
 ['entrance early',22,22.2],['entrance to middle',22,25.5],['middle',25.5,26],
 ['upper section',27,28],['near lip',28.8,28.95],['past old release boundary',22,31],
] as const)test(`committed ramp release: ${name}`,()=>withGame(g=>{
 placeOnRamp(g,start);g.present(.3,{...IDLE_INPUT,eject:true});
 assert.ok(g.launchCommitted);g.acknowledgeLaunchAngle();const shown=g.angle;
 placeOnRamp(g,end);g.present(.1,IDLE_INPUT);
 assert.ok(g.ejected);assert.equal(g.measurement!.angle,shown);
 assert.deepEqual(g.measurement!.initialVelocity,ejectVelocity(g.inherited,g.car.heading,shown));
 const measurement=g.measurement;assert.equal(g.eject(),false);assert.equal(g.measurement,measurement);
 assert.equal(g.launchCommitted,false);
}));
for(const duration of [1.85,3.65,5.45])test(`release after ${duration}s of repeated sweeps while on ramp`,()=>withGame(g=>{
 placeOnRamp(g,22,3);const clock=new BowlingClock();
 for(let i=0;i<Math.round(duration*120);i++) {
  clock.advance(g,1/120,{...IDLE_INPUT,eject:true});g.acknowledgeLaunchAngle();
 }
 assert.ok(g.charging);assert.ok(g.car.body.translation().z<29);
 assert.ok(Math.abs(g.angle-launchAngle(duration))<1e-8);
 const shown=g.angle;clock.advance(g,1/120,IDLE_INPUT);
 assert.ok(g.ejected);assert.equal(g.measurement!.angle,shown);
}));
for(const hz of [30,60,144])test(`ramp-end safety uses exact last rendered angle at ${hz} Hz`,()=>withGame(g=>{
 placeOnRamp(g,28,8);const clock=new BowlingClock();let shown=0;
 for(let i=0;i<hz*2&&!g.ejected;i++) {
  clock.advance(g,1/hz,{...IDLE_INPUT,eject:true});
  if(g.charging){g.acknowledgeLaunchAngle();shown=g.angle;}
 }
 assert.ok(g.ejected);assert.equal(g.missedEject,false);
 assert.ok(g.ejectPosition.z>=BOWLING.rampLip);
 assert.equal(g.measurement!.angle,shown);assert.equal(g.angle,shown);
 assert.deepEqual(g.measurement!.initialVelocity,ejectVelocity(g.inherited,g.car.heading,shown));
 clock.advance(g,.1,{...IDLE_INPUT,eject:true});assert.equal(g.nudgeUsed,false);
}));
test('pre-entry Space cannot launch; held input becomes eligible on physical ramp',()=>withGame(g=>{
 placeOnRamp(g,BOWLING.prepStart-.01);g.present(.2,{...IDLE_INPUT,eject:true});
 assert.equal(g.launchCommitted,false);g.present(.1);assert.equal(g.ejected,false);
 g.present(.1,{...IDLE_INPUT,eject:true});placeOnRamp(g,BOWLING.rampStart);
 g.present(.1,{...IDLE_INPUT,eject:true});assert.ok(g.launchCommitted);
 g.present(.1);assert.ok(g.ejected);
}));
test('reset and explicit cancellation clear committed selection for a new throw',()=>withGame(g=>{
 placeOnRamp(g,22);g.present(.3,{...IDLE_INPUT,eject:true});g.acknowledgeLaunchAngle();
 g.cancelCharge();g.present(.1);assert.equal(g.ejected,false);assert.equal(g.launchCommitted,false);
 g.present(.2,{...IDLE_INPUT,eject:true});assert.ok(g.launchCommitted);
 g.resetThrow();assert.equal(g.launchCommitted,false);assert.equal(g.charging,false);assert.equal(g.chargeTime,0);
 assert.equal(g.eject(),false);placeOnRamp(g,25);g.present(.1,{...IDLE_INPUT,eject:true});
 const shown=g.angle;g.present(.1);assert.ok(g.ejected);assert.equal(g.measurement!.angle,shown);
}));
test('a committed selection survives the driving deadline; genuine off-course KO clears it',()=>withGame(g=>{
 placeOnRamp(g,22);g.present(.3,{...IDLE_INPUT,eject:true});g.driveTime=BOWLING.driveTimeout;
 g.step({...IDLE_INPUT,eject:true},0);assert.ok(g.launchCommitted);assert.equal(g.phase,'drive');
 g.car.body.setTranslation({x:0,y:-3,z:22},true);g.step({...IDLE_INPUT,eject:true},0);
 assert.equal(g.launchCommitted,false);assert.equal(g.charging,false);assert.equal(g.ejected,false);
 assert.equal(g.missedEject,true);
}));
for(const angle of [0,10,20,30])test(`physical ragdoll stable at ${angle} degrees`,()=>withGame(g=>{
 launch(g,angle);while(g.phase==='flight'){g.step();for(const n of PARTS){const b=g.character.parts[n].body;assert.ok(Number.isFinite(b.translation().y));assert.ok(length(b.linvel())<=FLIGHT.maxSpeed+.001);}}
 assert.equal(g.retries,0);assert.equal(g.character.joints.length,8);assert.ok(g.lastPoints>=0&&g.lastPoints<=10);
}));
test('normal aiming preserves momentum and continuous input has a bounded physical cost',()=>{
 const shots:ThrowMeasurement[]=[];
 for(const [steer,pitch,duration] of [[0,0,0],[1,0,.25],[0,1,.9],[1,0,.9],[1,1,20]])withGame(g=>{
  launch(g);while(g.phase==='flight')g.step({...IDLE_INPUT,steer:g.elapsed<duration?steer:0,pitch:g.elapsed<duration?pitch:0});
  shots.push(g.measurements[0]);assert.equal(g.retries,0);assert.ok(g.airBudget<=FLIGHT.airDistanceCap+1e-8);assert.ok(g.forwardBudget<=FLIGHT.forwardBudget+1e-8);
 });
 assert.ok(shots[1].horizontalTravel>shots[0].horizontalTravel*.95);
 for(const m of shots.slice(2,4))assert.ok(m.horizontalTravel>shots[0].horizontalTravel*.90);
 assert.ok(shots[4].horizontalTravel>shots[0].horizontalTravel*.80);
 assert.ok(shots[4].dragLoss>shots[1].dragLoss);assert.ok(shots[1].dragLoss<.5);
});
test('Nudge is a forward and upward impulse exactly once, subsequent presses cannot relaunch',()=>withGame(g=>{
 launch(g);g.step();const centerY=()=>PARTS.reduce((sum,n)=>sum+g.character.parts[n].body.linvel().y*g.character.parts[n].body.mass(),0)/PARTS.reduce((sum,n)=>sum+g.character.parts[n].body.mass(),0);const before=centerY();
 g.present(.001,{...IDLE_INPUT,eject:true});g.step({...IDLE_INPUT,eject:true},0);
 assert.ok(g.nudgeUsed);assert.ok(Math.abs(centerY()-before-(FLIGHT.nudgeUp+RAGDOLL.gravity*FLIGHT.gravityScale*BOWLING.step))<.05);const at=g.measurement!.nudgeAt;
 for(let i=0;i<50;i++)g.step({...IDLE_INPUT,eject:i%2===0});assert.equal(g.measurement!.nudgeAt,at);
 g.resetThrow();assert.equal(g.nudgeUsed,false);
}));
test('Nudge after landing is unavailable and cannot bounce the body again',()=>withGame(g=>{
 launch(g,12);while(!g.landed)g.step();g.step({...IDLE_INPUT,eject:true});assert.equal(g.nudgeUsed,false);assert.equal(g.measurement!.nudgeAt,null);
}));
test('Nudge adds exact COM forward/up velocity at multiple timings, with no second impulse',()=>{
 for(const time of [0,.05,.5,1.2,1.8,2.8])withGame(g=>{
  launch(g);while(g.elapsed<time)g.step();
  const before=bowlingBodyState(g.character).velocity;
  g.step({...IDLE_INPUT,eject:true});if(!g.nudgeUsed)g.step({...IDLE_INPUT,eject:true});const n=g.measurement!.entry.nudge!;
  assert.ok(n);const h=Math.hypot(before.x,before.z),dv={x:n.after.velocity.x-n.before.velocity.x,y:n.after.velocity.y-n.before.velocity.y,z:n.after.velocity.z-n.before.velocity.z};
  assert.ok(Math.abs(dv.y-FLIGHT.nudgeUp)<1e-5);
  assert.ok(Math.abs((dv.x*before.x+dv.z*before.z)/h-FLIGHT.nudgeForward)<1e-5);
  assert.ok(n.after.velocity.z>n.before.velocity.z);
  g.step();g.step({...IDLE_INPUT,eject:true});assert.equal(g.measurement!.entry.nudge,n);
 });
});
test('course anchors move colliders, deck, rack and camera without retuning physics',()=>{
 const old={...COURSE},physics=JSON.stringify(FLIGHT),rack=rackPositions(),boxes=courseBoxes();
 try{
  COURSE.headZ+=10;COURSE.maxZ+=10;COURSE.rampStart+=2;COURSE.rampLip+=2;
  COURSE.roadWidth+=2;COURSE.obstacleStart-=5;COURSE.obstacleEnd-=3;
  assert.equal(COURSE.rackDistance,old.rackDistance+8);
  rackPositions().forEach((p,i)=>assert.ok(Math.abs(p.z-rack[i].z-10)<1e-8));
  assert.equal(courseBoxes()[0].half[2],boxes[0].half[2]+5);
  const hulls=roadHulls();assert.ok(hulls[hulls.length-1].some((v,i)=>i%3===2&&v===COURSE.rampLip));
  const camera=bowlingCamera('score',{x:0,y:0,z:0},true);assert.equal(camera.position.z,COURSE.headZ-8*COURSE.pinScale/1.6);
  withGame(g=>{assert.ok(Math.abs(g.pins[0].body.translation().z-COURSE.headZ)<1e-5);assert.equal(g.world.gravity.y,RAGDOLL.gravity);});
  assert.equal(JSON.stringify(FLIGHT),physics);
 }finally{for(const key of ['headZ','maxZ','rampStart','rampLip','roadWidth','obstacleStart','obstacleEnd'] as const)COURSE[key]=old[key];}
});
test('scaled pins have coherent dimensions, separated colliders and stable mass',()=>withGame(g=>{
 const rack=rackPositions();assert.equal(BOWLING.pinHeight,1.5*COURSE.pinScale);
 for(let i=0;i<rack.length;i++)for(let j=i+1;j<rack.length;j++)assert.ok(Math.hypot(rack[i].x-rack[j].x,rack[i].z-rack[j].z)>BOWLING.pinRadius*2);
 assert.ok(Math.abs(g.pins[0].body.collider(0).radius()-.135*COURSE.pinScale)<1e-6);
 assert.ok(Math.abs(g.pins[0].body.mass()-BOWLING.pinMass)<1e-5);
 assert.equal(BOWLING.roadWidth,12);assert.equal(BOWLING.laneWidth,10);
 assert.ok(COURSE.deck.maxX>BOWLING.width/2);
 assert.ok(Math.abs(BOWLING.pinHeight-7.2)<1e-8);assert.ok(Math.abs(BOWLING.spacing-4.032)<1e-8);
 for(let i=0;i<600;i++)g.world.step();
 for(const [i,pin] of g.pins.entries()){
  const p=pin.body.translation();
  assert.ok(Math.hypot(p.x-rack[i].x,p.z-rack[i].z)<.002);
  assert.ok(p.y>-.01&&p.y<.01);
  assert.ok(rotate(pin.body.rotation(),{x:0,y:1,z:0}).y>.999);
  assert.ok(length(pin.body.linvel())<.002);
 }
}));
test('far-end rack clears the restored backdrop and physical catcher through backward toppling',()=>withGame(g=>{
 const rack=rackPositions(),rearZ=Math.max(...rack.map(p=>p.z));
 const catcher=courseBoxes().find(box=>box.name==='catcher')!;
 const catcherFront=catcher.at[2]-catcher.half[2],wallFront=COURSE.backdropZ-.5;
 assert.equal(COURSE.backdropZ,220);assert.equal(COURSE.headZ,199.5);
 assert.equal(catcherFront-COURSE.deck.maxZ,.5);
 // Conservative bounding cylinder swept about the foot, covering mesh and colliders.
 const toppleReach=Math.hypot(BOWLING.pinHeight,BOWLING.pinRadius);
 assert.ok(rearZ+toppleReach<COURSE.deck.maxZ);
 assert.ok(catcherFront-rearZ-toppleReach>.6);
 assert.ok(wallFront-rearZ-toppleReach>2.1);
 for(const [i,pin] of g.pins.entries()){
  const p=pin.body.translation();assert.ok(Math.abs(p.z-rack[i].z)<1e-5);
  assert.ok(Math.abs(p.x-rack[i].x)<1e-5);assert.equal(pin.body.numColliders(),3);
  updatePin(pin,1/60);assert.equal(pin.down,false);
  for(let c=0;c<pin.body.numColliders();c++){
   const collider=pin.body.collider(c);
   g.world.forEachCollider(other=>{
    if(!other.parent()?.isFixed()||other.isSensor())return;
    const contact=collider.contactCollider(other,0);
    assert.ok(!contact||contact.distance>=0,`pin ${i} overlaps a course collider`);
   });
   for(const other of g.pins.slice(i+1))for(let k=0;k<other.body.numColliders();k++){
    const contact=collider.contactCollider(other.body.collider(k),0);
    assert.ok(!contact||contact.distance>=0,`pins ${i} and ${g.pins.indexOf(other)} overlap`);
   }
  }
 }
 const camera=bowlingCamera('score',{x:0,y:0,z:0},true);
 assert.equal(camera.position.z,COURSE.headZ-8*COURSE.pinScale/1.6);
 assert.equal(camera.target.z,(COURSE.deck.minZ+COURSE.deck.maxZ)/2);
}));
test('sparse course keeps three full-size decisions and recovery room in every variant',()=>{
 for(let seed=0;seed<6;seed++){
  const balls=courseObstacles(seed).filter(o=>o.active).sort((a,b)=>a.at[2]-b.at[2]);
  assert.equal(balls.length,3);
  for(const [i,ball] of balls.entries()){
   assert.ok(ball.half[0]>=1.5*1.35);
   if(i)assert.ok(ball.at[2]-balls[i-1].at[2]>=40);
   // Each row leaves ample combined road width around one major ball,
   // with no same-row shoulder blocker closing the alternate line.
   assert.ok(BOWLING.roadWidth-2*ball.half[0]>6);
  }
  const last=balls[balls.length-1];
  assert.ok(BOWLING.rampStart-last.at[2]-last.half[2]>60);
 }
});
test('aerobatics articulates body, preserves tumble and has finite pitch/displacement budgets',()=>withGame(g=>{
 launch(g);let inverted=false,limbSwing=false;
 for(let i=0;i<150;i++){g.step({...IDLE_INPUT,steer:1,pitch:1});const torso=g.character.parts.torso.body.rotation(),arm=g.character.parts.leftUpper.body.rotation();inverted ||= rotate(torso,{x:0,y:1,z:0}).y<0;limbSwing ||= Math.abs(torso.x*arm.x+torso.y*arm.y+torso.z*arm.z+torso.w*arm.w)<.95;}
 assert.ok(inverted&&limbSwing);assert.ok(g.pitchBudget<=FLIGHT.pitchBudget+1e-8);assert.ok(g.airBudget<=FLIGHT.airDistanceCap+1e-8);assert.equal(g.retries,0);
}));
test('obstacle losses persist to the ramp, no body spawning or random physics death',()=>{
 const speeds:number[]=[];
 for(const direct of [false,true])withGame(g=>{
  ready(g);const bodies=g.world.bodies.len();for(let i=0;i<1800&&g.phase==='drive'&&g.car.body.translation().z<28;i++)g.step({...drive,steer:direct?0:line(g)});
  speeds.push(g.car.speed);assert.equal(g.world.bodies.len(),bodies);if(direct)assert.ok(g.car.hitCount>=2);
  g.resetThrow();assert.equal(g.car.hitCount,0);assert.ok(g.car.props.every((p,i)=>!p.state.hit&&p.collider.isEnabled()===g.obstacles[i].active));
 });assert.ok(speeds[0]-speeds[1]>4);
});
test('landing retains momentum but early ground contact spends useful energy',()=>{
 const shots:ThrowMeasurement[]=[];
 // Shallow and near-rack recovery; the former 25° fixture now overflies.
 for(const angle of [8,16])withGame(g=>{launch(g,angle);while(g.phase==='flight'&&!g.landed)g.step();assert.ok(g.landed);assert.ok(Math.hypot(g.character.body.linvel().x,g.character.body.linvel().z)>5);finish(g);shots.push(g.measurements[0]);});
 assert.ok(shots[0].horizontalTravel<shots[1].horizontalTravel-20);assert.ok(shots[0].slideDistance>5);assert.ok(shots[0].horizontalTravel<110);
});
test('identical launch states produce identical physics under bullet presentation',()=>{
 const a=new BowlingGame(2),b=new BowlingGame(2);try{launch(a);launch(b);const clock=new BowlingClock();let steps=0;
 while(steps<180)clock.advance(b,1/240,IDLE_INPUT,()=>{a.step(IDLE_INPUT,0);steps++;});
 for(const n of PARTS)assert.deepEqual(a.character.parts[n].body.translation(),b.character.parts[n].body.translation());assert.equal(a.mask,b.mask);
 }finally{a.dispose();b.dispose();}
 assert.equal(flightTimeScale(BULLET.tailHold),.4);assert.equal(flightTimeScale(.45),1);
});
for(const players of [2,3] as const)test(`${players} players complete deterministic matches with varied bot inputs`,()=>{
 const run=()=>{const g=new BowlingGame(players),clock=new BowlingClock();try{
 for(let i=0;i<30000&&g.phase!=='results';i++){
  const z=g.car.body.translation().z;clock.advance(g,1/60,{...drive,steer:line(g),eject:g.phase==='drive'?z>=23&&g.angle<26:g.elapsed>2});
 }
 assert.equal(g.phase,'results');assert.equal(g.retries,0);assert.equal(g.score.turn,players*3);return g.score.throws;
 }finally{g.dispose();}};assert.deepEqual(run(),run());
 const profiles=Array.from({length:100},(_,i)=>botThrow(i,1,1));assert.equal(new Set(profiles.map(p=>p.skill)).size,3);assert.ok(new Set(profiles.map(p=>p.angle)).size>90);
});

for(const hz of [30,60,144])test(`return-pass angle selection uses presentation time at ${hz} Hz`,()=>withGame(g=>{
 ready(g);while(g.car.body.translation().z<BOWLING.prepStart+.3)g.step({...drive,steer:line(g)});
 const clock=new BowlingClock(),start=g.car.body.translation().z;
 for(let i=0;i<hz;i++)clock.advance(g,1/hz,{...drive,eject:true});
 assert.ok(Math.abs(g.angle-26.6666666667)<1e-7);assert.equal(g.angleDirection,'falling');
 assert.equal(g.timeScale,.4);assert.ok(Math.abs(clock.simulationTime-.4)<1e-8);
 assert.ok(g.car.body.translation().z>start+10);
 const shown=g.angle;clock.advance(g,1/hz,IDLE_INPUT);
 assert.equal(g.phase,'flight');assert.equal(g.measurement?.angle,shown);
 assert.equal(g.measurement?.angleDirection,'falling');assert.equal(g.eject(),false);
}));

// Flight correction must follow the launch basis even during inverted tumble.
test('A and D keep chase-view left/right semantics at every viable angle and tumble phase',()=>{
 for(const angle of [15,20,25,30])for(const delay of [.05,.55,1]){
  const samples:{x:number;heading:number}[]=[];
  for(const steer of [0,1,-1])withGame(g=>{
   launch(g,angle);while(g.elapsed<delay)g.step();
   const heading=g.airHeading,before=bowlingBodyState(g.character);
   g.step({...IDLE_INPUT,steer});const after=bowlingBodyState(g.character);
   samples.push({x:(after.velocity.x-before.velocity.x)*Math.cos(heading)-(after.velocity.z-before.velocity.z)*Math.sin(heading),heading});
   assert.equal(g.airHeading,heading);assert.equal(g.retries,0);
  });
  assert.ok(samples[1].x-samples[0].x>.02,`A: ${angle}/${delay}`);
  assert.ok(samples[2].x-samples[0].x<-.02,`D: ${angle}/${delay}`);
 }
});
test('half and one second correction moves COM metres with little forward loss',()=>{
 const samples:ReturnType<typeof bowlingBodyState>[]=[];
 for(const duration of [0,.25,.5,1])withGame(g=>{
  launch(g);while(g.elapsed<2.5)g.step({...IDLE_INPUT,steer:g.elapsed<duration?1:0});
  const bodies=PARTS.map(n=>g.character.parts[n].body),mass=bodies.reduce((sum,b)=>sum+b.mass(),0);
  const position=bodies.reduce((sum,b)=>{const p=b.translation(),w=b.mass()/mass;return {x:sum.x+p.x*w,y:sum.y+p.y*w,z:sum.z+p.z*w};},{x:0,y:0,z:0});
  samples.push({...bowlingBodyState(g.character),position});assert.equal(g.retries,0);
 });
 const base=samples[0];
 assert.ok(samples[1].position.x-base.position.x>.65);
 assert.ok(samples[2].position.x-base.position.x>1.5);
 assert.ok(samples[3].position.x-base.position.x>2.5);
 for(const s of samples.slice(1))assert.ok(s.velocity.z/base.velocity.z>.95);
});
test('enlarged course balls share mesh radii, sensor bounds, floor height and barrier clearance',()=>{
 for(let seed=0;seed<6;seed++)withGame(g=>{
  g.obstacles.splice(0,g.obstacles.length,...courseObstacles(seed));g.car.reset();
  for(const [i,o] of g.obstacles.entries())if(o.active){
   const c=g.car.props[i].collider;assert.ok(Math.abs(c.radius()-o.half[0])<1e-6);
   assert.ok(Math.abs(c.translation().y-o.half[0]-roadHeight(o.at[2]))<1e-5);
   assert.ok(Math.abs(o.at[0])+o.half[0]<=BOWLING.roadWidth/2-.149);
  }
 });
});
test('large ball central/glancing contacts at 130–165 km/h break once without tunneling or flipping',()=>{
 for(const kmh of [130,145,165])for(const kind of ['avoid','glance','central'])withGame(g=>{
  ready(g);const o=g.obstacles[0],r=o.half[0],offset=kind==='avoid'?r+1:kind==='glance'?Math.sqrt(r*r-(r-CAR.rideHeight)**2)+.4:0;
  const start={x:o.at[0]+offset,y:CAR.rideHeight,z:o.at[2]-8};
  g.car.body.setTranslation(start,true);g.car.body.setLinvel({x:0,y:0,z:kmh/3.6},true);
  const bodies=g.world.bodies.len();let lowest=Infinity;
  while(g.car.body.translation().z<o.at[2]+6){g.car.step({throttle:0,brake:0,steer:0});g.world.step();lowest=Math.min(lowest,g.car.body.translation().y);assert.ok(g.car.speed>kmh/3.6*.6);}
  assert.equal(g.car.hitCount,kind==='avoid'?0:1,`${kmh}/${kind}`);
  assert.ok(lowest>.4);assert.ok(Math.abs(g.car.body.rotation().z)<.001);assert.equal(g.world.bodies.len(),bodies);
 });
});


test('giant rack remains framed at desktop and narrow viewport aspect ratios',()=>{
 for(const aspect of [16/9,1366/768,390/844]) {
  const pose=bowlingCamera('score',{x:0,y:0,z:0},true,undefined,0,0,aspect);
  const camera=new PerspectiveCamera(pose.fov,aspect,.1,1000);
  camera.position.set(pose.position.x,pose.position.y,pose.position.z);
  camera.lookAt(pose.target.x,pose.target.y,pose.target.z);camera.updateMatrixWorld();
  for(const pin of rackPositions())for(const x of [-1,1])for(const z of [-1,1])for(const y of [0,BOWLING.pinHeight]) {
   const point=new Vector3(pin.x+x*BOWLING.pinRadius,pin.y+y,pin.z+z*BOWLING.pinRadius).project(camera);
   assert.ok(Math.abs(point.x)<.9&&Math.abs(point.y)<.9&&point.z<1,`rack clips at aspect ${aspect}: ${point.toArray()}`);
  }
 }
});

test('rack apron supports sideways topples while driving road and launch corridor stay narrow',()=>withGame(g=>{
 const reach=Math.hypot(BOWLING.pinHeight,BOWLING.pinRadius),rack=rackPositions();
 assert.ok(Math.max(...rack.map(p=>Math.abs(p.x)))+reach<COURSE.deck.maxX);
 const boxes=courseBoxes(),side=boxes.find(b=>b.name==='pad-right')!,rackSide=boxes.find(b=>b.name==='pad-right-rack')!;
 assert.equal(side.at[0]-side.half[0],5);assert.equal(rackSide.at[0]-rackSide.half[0],COURSE.deck.maxX);
 assert.ok(COURSE.deck.minZ>CAR.catcherZ);
 g.world.step();
 for(const x of [-13.8,13.8]){
  const hit=g.world.castRay(new RAPIER.Ray({x,y:10,z:COURSE.headZ},{x:0,y:-1,z:0}),12,true,RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
  assert.ok(hit&&Math.abs(10-hit.timeOfImpact)<1e-5,'rack wing must have physical floor');
 }
}));


test('driving presets keep the legacy far view and remain independent of airborne/rack framing',()=>{
 const p={x:1,y:CAR.rideHeight,z:-60};
 const views=BOWLING_DRIVE_PRESETS.map((_,preset)=>bowlingCamera('drive',p,false,p,.1,CAR.maxSpeed,16/9,preset));
 assert.equal(views.length,4);
 for(let i=1;i<views.length;i++) {
  assert.ok(views[i-1].position.z-views[i].position.z>.95);
  assert.ok(views[i].fov-views[i-1].fov>=3);
 }
 assert.equal(views[3].fov,74);
 assert.equal(views[3].position.z,p.z-Math.cos(.1)*7);
 assert.equal(views[3].position.y,p.y+2.7);
 for(const aspect of [1440/900,1366/768])for(const phase of ['flight','score','results'] as const)for(const impact of [false,true]) {
  const body={x:2,y:5,z:BOWLING.headZ-4};
  const approved=bowlingCamera(phase,body,impact,p,.2,46,aspect,3);
  for(let preset=0;preset<4;preset++)assert.deepEqual(bowlingCamera(phase,body,impact,p,.2,46,aspect,preset),approved);
 }
});

test('every driving preset clears the road across the crest, descent and ramp at driving speeds',()=>{
 for(let preset=0;preset<4;preset++)for(let z=BOWLING.minZ;z<=BOWLING.rampLip;z+=.5)for(const speed of [0,100/3.6,140/3.6,46]) {
  const p={x:0,y:roadHeight(z)+CAR.rideHeight,z};
  const pose=bowlingCamera('drive',p,false,p,0,speed,16/9,preset);
  assert.ok(pose.position.y>=roadHeight(pose.position.z)+.94);
  assert.ok(pose.position.z<p.z-3);
  assert.ok(pose.target.z>p.z);
  assert.ok(Number.isFinite(pose.target.y));
 }
});
