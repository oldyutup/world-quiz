import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { initializePhysics } from '../physics';
import { NET } from '../../../../shared/party-lab/network/protocol';
import { MODE_SELECTIONS } from '../../../../shared/party-lab/modes';
import { CAR, CAR_LENGTH, CATCH_UP, DRAFT, IDLE, RACE, angle, clamp, steeringRate, type DriveInput } from './config';
import { RaceTrack, crossedGate } from './track';
import { RaceGame } from './game';
import { advance, markMissed, missedCheckpoint, newProgress, raceDistance, raceOrder, wrongWay } from './rules';
import { VIEWS, newCamera, updateCamera } from './camera';
before(initializePhysics);
test('simpler circuit has five readable corners, long straights and a similar lap length',()=>{
  const t=new RaceTrack(),corners=t.sections.filter(s=>s.radius>0),straights=t.sections.filter(s=>s.radius===0);
  assert.ok(t.length>=550&&t.length<=620);assert.equal(corners.length,5);
  assert.ok(corners.every(s=>s.turn<=Math.PI/2+.001));assert.equal(corners.filter(s=>s.radius<30).length,1);
  assert.ok(straights[0].length+straights[straights.length-1].length>125);
  assert.ok(straights.filter(s=>s.length>60).length>=4);
  assert.ok(t.points.every(p=>p.width>=10&&p.width<=12&&Number.isFinite(p.curve)));
  assert.ok(straights.slice(0,-1).every(s=>t.at(s.start+s.length/2).curve<.00001));
  for(let i=0;i<t.checkpoints.length;i++){const p=t.checkpoints[i];assert.ok(Math.abs(p.s-i*t.length/t.checkpoints.length)<.001);assert.ok(t.project(p).distance<.001);}
  assert.ok(t.barriers.length<350);assert.ok(t.risk(t.length*.48));
});
const run=(g:RaceGame,seconds:number,input:DriveInput=IDLE)=>{for(let i=0;i<Math.round(seconds/RACE.step);i++)g.step(input);};
const gateCross=(track:RaceTrack,n:number,backward=false)=>{const p=track.checkpoints[n],a={x:p.x-p.tx,y:.64,z:p.z-p.tz},b={x:p.x+p.tx,y:.64,z:p.z+p.tz};return backward?[b,a]:[a,b];};
function fixture(){const g=new RaceGame(2);g.phase='racing';g.bots=false;g.cars[0].place({x:0,y:.64,z:36},0);g.cars[1].place(g.track.pose(160),0);run(g,.2);return g;}

test('approved identity joins online/mixed selection',()=>{assert.equal(NET.version, 24);assert.ok(MODE_SELECTIONS.some(m=>String(m)===RACE.id));assert.throws(()=>new RaceGame(4 as 2));});
test('grid has separate equal front row and staggered third seat',()=>{for(const count of [2,3]as const){const g=new RaceGame(count);try{for(let a=0;a<count;a++)for(let b=a+1;b<count;b++){const p=g.cars[a].body.translation(),q=g.cars[b].body.translation();assert.ok(Math.hypot(p.x-q.x,p.z-q.z)>3.9);}assert.equal(g.world.bodies.len(),count);assert.ok(g.cars.every(c=>c.body.isCcdEnabled()));}finally{g.dispose();}}});
test('countdown ignores throttle, brake, steering and reset',()=>{const g=new RaceGame(3);try{const starts=g.cars.map(c=>c.body.translation());run(g,2.8,{throttle:1,brake:1,steer:1,reset:true});assert.equal(g.phase,'countdown');g.cars.forEach((c,i)=>{assert.ok(Math.hypot(c.body.translation().x-starts[i].x,c.body.translation().z-starts[i].z)<.01);assert.equal(g.progress[i].resets,0);});run(g,.3);assert.equal(g.phase,'racing');}finally{g.dispose();}});
test('ordered gates arm the start, count exactly three complete laps and finish once',()=>{const t=new RaceTrack(),p=newProgress();let time=0;for(let lap=0;lap<=3;lap++)for(let i=0;i<18;i++){if(lap===3&&i>0)break;const [a,b]=gateCross(t,i);assert.ok(advance(p,t,a,b,++time));assert.equal(p.laps,lap);}assert.equal(p.laps,3);assert.equal(p.finish,55);const [a,b]=gateCross(t,1);assert.equal(advance(p,t,a,b,56),false);});
test('skipping a gate, interior cutting and finish spam cannot advance',()=>{const t=new RaceTrack(),p=newProgress();const [a,b]=gateCross(t,0);advance(p,t,a,b,0);for(const n of [2,5,8,17,0,0]){const [x,y]=gateCross(t,n);assert.equal(advance(p,t,x,y,1),false);}assert.equal(p.next,1);assert.equal(p.laps,0);const gate=t.checkpoints[1],outside={x:gate.x+gate.tz*25,y:.64,z:gate.z-gate.tx*25};assert.equal(advance(p,t,{x:outside.x-gate.tx,y:.64,z:outside.z-gate.tz},{x:outside.x+gate.tx,y:.64,z:outside.z+gate.tz},2),false);});
test('backward finish, reversing across next gate and airborne/void crossing fail',()=>{const t=new RaceTrack(),p=newProgress();for(const n of [0,1]){p.next=n;const [a,b]=gateCross(t,n,true);assert.equal(advance(p,t,a,b,2),false);}const [a,b]=gateCross(t,0);assert.equal(crossedGate({...a,y:4},{...b,y:4},t.checkpoints[0]),false);assert.equal(crossedGate({...a,y:-3},{...b,y:-3},t.checkpoints[0]),false);});
test('swept gates detect a full max-speed physics step, independent of render FPS',()=>{const t=new RaceTrack(),g=t.checkpoints[2];for(const speed of [90,110,130,150]){const d=speed/3.6/60;assert.ok(crossedGate({x:g.x-g.tx*d*.4,y:.64,z:g.z-g.tz*d*.4},{x:g.x+g.tx*d*.6,y:.64,z:g.z+g.tz*d*.6},g));}});
test('wrong-way dwell ignores spins and short reverse recovery; clears with hysteresis',()=>{const p=newProgress();for(let i=0;i<80;i++)wrongWay(p,-10,1/60);assert.equal(p.wrong,false);for(let i=0;i<60;i++)wrongWay(p,4,1/60);assert.equal(p.wrong,false);for(let i=0;i<130;i++)wrongWay(p,-10,1/60);assert.equal(p.wrong,true);for(let i=0;i<30;i++)wrongWay(p,10,1/60);assert.equal(p.wrong,true);for(let i=0;i<11;i++)wrongWay(p,10,1/60);assert.equal(p.wrong,false);});
test('order uses lap then ordered sector and clamped segment progress',()=>{const t=new RaceTrack(),p=[newProgress(),newProgress(),newProgress()];p.forEach(x=>{x.started=true;x.next=4;});p[0].laps=1;p[2].next=5;assert.deepEqual(raceOrder(p,t,[110,120,140]),[0,2,1]);const before=raceDistance(p[1],t,120),cut=raceDistance(p[1],t,t.length*.7);assert.ok(cut<=4*t.length/18);assert.ok(before>0);const reset=[{...newProgress(),started:true,laps:1,next:1},{...newProgress(),started:true,laps:0,next:0}];assert.deepEqual(raceOrder(reset,t,[t.length-2,t.length-1]),[0,1]);p[1].finish=80;p[2].finish=79;p[0].finish=82;assert.deepEqual(raceOrder(p,t,[1,2,3]),[2,1,0]);});
test('fall resets only to last valid gate, preserves all progress and applies hold/cooldown',()=>{const g=fixture();try{const p=g.progress[0];p.started=true;p.next=6;p.laps=1;g.cars[0].body.setTranslation({x:70,y:-4,z:60},true);g.step();assert.equal(p.resets,1);assert.equal(p.laps,1);assert.equal(p.next,6);assert.ok(p.hold>1);assert.equal(g.cars[0].speed,0);const at=g.cars[0].body.translation();run(g,.7,{...IDLE,throttle:1,reset:true});assert.equal(p.resets,1);assert.ok(Math.hypot(g.cars[0].body.translation().x-at.x,g.cars[0].body.translation().z-at.z)<.01);assert.equal(p.next,6);}finally{g.dispose();}});
test('stationary off-road and inverted chassis recover with same reset rules',()=>{for(const upside of [false,true]){const g=fixture();try{const c=g.cars[0];c.place(g.track.pose(150,10),0);if(upside)c.body.setRotation({x:1,y:0,z:0,w:0},true);run(g,4.5);assert.ok(g.progress[0].resets>=1);assert.equal(g.progress[0].laps,0);}finally{g.dispose();}}});
test('manual reset is edge triggered and cannot jump to unearned sectors',()=>{const g=fixture();try{g.progress[0].started=true;g.progress[0].next=2;g.cars[0].place(g.track.pose(300),0);run(g,6,{...IDLE,reset:true});assert.equal(g.progress[0].resets,1);assert.equal(g.progress[0].next,2);}finally{g.dispose();}});
const beside=(track:RaceTrack,n:number,offset:number,backward=false)=>{const p=track.checkpoints[n],o={x:p.tz*offset,z:-p.tx*offset},a={x:p.x+o.x-p.tx,y:.64,z:p.z+o.z-p.tz},b={x:p.x+o.x+p.tx,y:.64,z:p.z+o.z+p.tz};return backward?[b,a]:[a,b];};
test('missed gate warning only after a real miss: beside the gate or through a later one, never behind or backwards',()=>{
  const t=new RaceTrack(),p=newProgress();p.started=true;p.next=5;const w=t.checkpoints[5].width/2;
  // Within 5 m of the asphalt it is earned, not missed.
  for(const side of [1,-1]){const q={...p},[a,b]=beside(t,5,side*(w+RACE.gateMargin-.1));assert.ok(advance(q,t,a,b,1));assert.equal(q.next,6);assert.equal(q.missed,false);}
  // Behind it, driving back over it and beside it backwards: no warning.
  for(const [a,b] of [beside(t,4,0),beside(t,5,0,true),beside(t,5,w+9,true)]){assert.equal(advance(p,t,a,b,1),false);assert.equal(markMissed(p,t,a,b),false);}
  assert.equal(missedCheckpoint(p),false);
  // Beside it (beyond the margin): a miss, kept until the gate is earned.
  let [a,b]=beside(t,5,w+RACE.gateMargin+1);assert.equal(advance(p,t,a,b,1),false);assert.equal(markMissed(p,t,a,b),true);assert.equal(missedCheckpoint(p),true);assert.equal(p.next,5);
  p.hold=1;assert.equal(missedCheckpoint(p),false);p.hold=0;
  [a,b]=gateCross(t,5);assert.ok(advance(p,t,a,b,2));assert.equal(missedCheckpoint(p),false);
  // Through a later checkpoint (a shortcut): a miss; it never earns anything.
  const q={...newProgress(),started:true,next:5};[a,b]=gateCross(t,8);assert.equal(advance(q,t,a,b,1),false);assert.equal(markMissed(q,t,a,b),true);assert.equal(q.next,5);
});
test('bot physically backtracks to a missed gate and completes all laps without reset',()=>{const g=new RaceGame(3);try{g.autoHuman=true;const c=g.cars[1],p=g.progress[1];while(String(g.phase)!=="racing"||p.next!==4)g.step();const gate=g.track.checkpoints[p.next],expected=p.next;/* Gate 4: open infield beside it (no barrier to get stuck behind). */c.place(g.track.pose(gate.s-2,gate.width/2+RACE.gateMargin+3),Math.atan2(gate.tx,gate.tz));c.body.setLinvel({x:gate.tx*12,y:0,z:gate.tz*12},true);for(let i=0;i<20&&!p.missed;i++)g.step();assert.equal(p.next,expected);assert.equal(p.missed,true);g.step();assert.equal(g.drivers[1].recovering,expected);while(g.phase!=='results')g.step();assert.equal(p.laps,3);assert.ok(p.finish!==null);assert.equal(p.resets,0);assert.equal(g.invalid,0);}finally{g.dispose();}});
test('asphalt has more acceleration and lateral grip; S brakes before reversing',()=>{const asphalt=fixture(),grass=fixture();try{grass.cars[0].place({x:-7,y:.64,z:36},0);run(asphalt,1,{...IDLE,throttle:1});run(grass,1,{...IDLE,throttle:1});assert.ok(asphalt.cars[0].speed>grass.cars[0].speed*1.7);assert.ok(grass.cars[0].grass);asphalt.cars[0].body.setLinvel({x:0,y:0,z:20},true);run(asphalt,.5,{...IDLE,brake:1});assert.ok(asphalt.cars[0].forwardSpeed>9);run(asphalt,1.8,{...IDLE,brake:1});assert.ok(asphalt.cars[0].forwardSpeed< -2);assert.ok(asphalt.cars[0].forwardSpeed>= -CAR.reverse-.1);assert.ok(steeringRate(8)>steeringRate(25));}finally{asphalt.dispose();grass.dispose();}});
test('real head-on contact slows both cars without invalid bodies or giant rotation',()=>{const g=fixture();try{const [a,b]=g.cars;a.place({x:0,y:.64,z:32},0);b.place({x:0,y:.64,z:44},Math.PI);a.body.setLinvel({x:0,y:0,z:24},true);b.body.setLinvel({x:0,y:0,z:-20},true);run(g,.5);assert.ok(g.contacts>0);assert.ok(a.speed<10&&b.speed<10);assert.equal(g.invalid,0);assert.ok(Math.abs(a.body.angvel().y)<=3);}finally{g.dispose();}});
test('physical 90/110/150 km/h barrier impacts cannot tunnel through its outer face',()=>{for(const speed of [90,110,150]){const g=fixture();try{const c=g.cars[0],p=g.track.at(15);c.place(g.track.pose(15,p.width/2-1.5),Math.atan2(p.tz,-p.tx));c.body.setLinvel({x:p.tz*speed/3.6,y:0,z:-p.tx*speed/3.6},true);let far=0;for(let i=0;i<60;i++){g.step();far=Math.max(far,c.projection.distance);}assert.ok(g.contacts>0);assert.ok(far<8.2,`${speed} km/h: ${far} m`);assert.equal(g.invalid,0);}finally{g.dispose();}}});
test('physical skipped-gate, backwards finish and driven infield cuts do not earn progress',()=>{
  const g=fixture();try{const c=g.cars[0],p=g.progress[0];p.started=true;p.next=1;let q=g.track.checkpoints[2];c.place(g.track.pose(q.s-2),Math.atan2(q.tx,q.tz));c.body.setLinvel({x:q.tx*25,y:0,z:q.tz*25},true);run(g,.3);assert.equal(p.next,1);
    p.next=0;q=g.track.checkpoints[0];c.place(g.track.pose(2),Math.atan2(q.tx,q.tz)+Math.PI);c.body.setLinvel({x:-q.tx*20,y:0,z:-q.tz*20},true);run(g,.3);assert.equal(p.next,0);assert.equal(p.laps,0);
    p.next=2;c.place({x:12,y:.64,z:60},Math.PI/2);run(g,5,{...IDLE,throttle:1});assert.ok(c.body.translation().x>40);assert.equal(p.next,2);assert.equal(p.laps,0);
  }finally{g.dispose();}
});
test('full throttle reaches but cannot engine-accelerate above race-specific top speed',()=>{const g=new RaceGame(2,{scale:5,width:100});try{g.phase='racing';g.bots=false;g.cars[0].place(g.track.pose(80),0);run(g,5,{...IDLE,throttle:1});assert.ok(g.cars[0].speed>CAR.maxSpeed-.5);assert.ok(g.cars[0].speed<CAR.maxSpeed+.1);}finally{g.dispose();}});
test('all four camera views remain world-up and pull in at solid scenery',()=>{const g=fixture();try{for(let i=0;i<VIEWS.length;i++){const c=newCamera();updateCamera(c,g.world,{x:0,y:.64,z:36},0,20,1/60,i);assert.ok(c.position.y>1);assert.ok(c.fov>=58);}const c=newCamera();updateCamera(c,g.world,{x:-10,y:.64,z:40},Math.PI/2,0,1/60,3);assert.ok(c.boom<VIEWS[3].distance);assert.ok(c.position.x>-12);}finally{g.dispose();}});
test('handbrake duration trades speed for bounded rotation and lateral slip',()=>{
  const results=[0,.1,.4,1.5].map(hold=>{const g=new RaceGame(2,{width:150});try{g.phase='racing';g.bots=false;const c=g.cars[0],p=g.track.at(205),h=Math.atan2(p.tx,p.tz);g.cars[1].place(g.track.pose(400),0);c.place(g.track.pose(205),h);c.body.setLinvel({x:p.tx*65/3.6,y:0,z:p.tz*65/3.6},true);let slip=0;for(let i=0;i<90;i++){g.step({...IDLE,steer:.5,handbrake:i<hold*60});const v=c.body.linvel();slip=Math.max(slip,Math.abs(v.x*Math.cos(c.heading)-v.z*Math.sin(c.heading)));}assert.equal(g.invalid,0);assert.ok(Math.abs(c.body.angvel().y)<3);return {speed:c.speed,yaw:Math.abs(c.heading-h),slip};}finally{g.dispose();}});
  for(let i=1;i<results.length;i++){assert.ok(results[i].speed<results[i-1].speed);assert.ok(results[i].yaw>results[i-1].yaw);}
  assert.ok(results[1].yaw-results[0].yaw<.1);assert.ok(results[2].slip>results[0].slip*1.5);assert.ok(results[3].speed<results[0].speed*.3);
});
test('handbrake before, during and after a real side impact retains momentum without instability',()=>{
  for(const timing of [0,1,2]){const g=fixture();try{const [a,b]=g.cars;a.place({x:0,y:.64,z:40},0);b.place({x:-4,y:.64,z:41},.6);a.body.setLinvel({x:0,y:0,z:18},true);b.body.setLinvel({x:11,y:0,z:18},true);let impact=-1,displaced=0;for(let i=0;i<120;i++){g.step({...IDLE,steer:.25,handbrake:timing===0?i<15:timing===1?i<35:impact>=0&&i>impact&&i<impact+24});if(impact<0&&g.events.some(e=>e.kind==='impact'))impact=i;displaced=Math.max(displaced,Math.abs(a.body.translation().x));assert.ok(a.speed<40);}assert.ok(impact>=0);assert.ok(displaced>.5);assert.equal(g.invalid,0);}finally{g.dispose();}}
});
test('asphalt slip settles faster than grass while grass acceleration stays penalized',()=>{
  const g=fixture();try{const c=g.cars[0];c.body.setLinvel({x:4,y:0,z:15},true);run(g,.1);const road=Math.abs(c.body.linvel().x);c.place({x:-7,y:.64,z:36},0);c.body.setLinvel({x:4,y:0,z:15},true);run(g,.1);assert.ok(c.grass);assert.ok(Math.abs(c.body.linvel().x)>road*2);assert.ok(CAR.grip>CAR.grassGrip*4);}finally{g.dispose();}
});
test('2P and 3P bots run real complete three-lap races; rematch starts clean',()=>{for(const n of [2,3]as const){const g=new RaceGame(n);try{g.autoHuman=true;for(let i=0;i<9000&&g.phase!=='results';i++)g.step();assert.equal(g.phase,'results');assert.ok(g.progress.every(p=>p.finish!==null&&p.laps===3));assert.ok(g.time>75&&g.time<125,`${g.time}`);assert.equal(g.invalid,0);assert.ok(g.progress.every(p=>p.resets===0));}finally{g.dispose();}const fresh=new RaceGame(n);try{assert.equal(fresh.phase,'countdown');assert.equal(fresh.time,0);assert.ok(fresh.progress.every(p=>p.laps===0&&p.finish===null&&p.resets===0));assert.equal(fresh.world.bodies.len(),n);}finally{fresh.dispose();}}});

test('checkpoints count up to 5 m beyond the asphalt on every corner gate, never further',()=>{
  assert.equal(RACE.gateMargin,5);
  for(const gate of [3,4,6,11,14,16,17])for(const side of [1,-1])for(const off of [2,4.9,5.3]){
    const g=new RaceGame(2);try{g.phase='racing';g.bots=false;g.cars[1].place(g.track.pose(gate*33+200),0);
      const p=g.progress[0],cp=g.track.checkpoints[gate];p.started=true;p.next=gate;
      // The line through the gate, like a car on the grass or scraping a barrier (sideways moves are not driving).
      const [a,b]=beside(g.track,gate,side*(cp.width/2+off));
      assert.equal(advance(p,g.track,a,b,1),off<RACE.gateMargin,`gate ${gate} side ${side} ${off} m off the asphalt`);
    }finally{g.dispose();}
  }
});
test('R always respawns at the last checkpoint passed and never adds progress, from anywhere on or off the track',()=>{
  for(const [next,where] of [[2,300],[9,40],[0,580],[1,200],[14,470]] as const){
    const g=fixture();try{const p=g.progress[0],c=g.cars[0];p.started=true;p.next=next;p.laps=1;c.place(g.track.pose(where,where%2?9:-4),where/40);run(g,.2);
      const before={laps:p.laps,next:p.next};g.time+=4;g.step({...IDLE,reset:true});assert.equal(p.resets,1);assert.deepEqual({laps:p.laps,next:p.next},before);
      const last=g.track.checkpoints[(next+17)%18],at=c.body.translation(),q=g.track.project(at);let behind=g.track.wrap(last.s-q.s);if(behind>g.track.length/2)behind-=g.track.length;
      assert.ok(behind>=0&&behind<15,`next ${next}: ${behind} m behind the last checkpoint`);assert.equal(missedCheckpoint(p),false);
      run(g,1.3);assert.deepEqual({laps:p.laps,next:p.next},before,'the hold never adds anything');
    }finally{g.dispose();}
  }
});
/** Two cars on a long straight (a 5× circuit), the second `gap` m behind the first bumper to bumper, `side` m off its line, both at `speed`. */
function towFixture(gap:number,side=0,speed=26){
  const g=new RaceGame(2,{scale:5,width:100});g.phase='racing';g.bots=false;const t=g.track,lead=t.at(200),h=Math.atan2(lead.tx,lead.tz);
  g.progress.forEach(p=>{p.started=true;p.next=1;});
  g.cars[0].place(t.pose(200),h);g.cars[1].place(t.pose(200-gap-CAR_LENGTH,side),h);
  for(const c of g.cars)c.body.setLinvel({x:lead.tx*speed,y:0,z:lead.tz*speed},true);
  return g;
}
const both=(g:RaceGame,seconds:number,throttle=1)=>run2(g,seconds,[{...IDLE,throttle},{...IDLE,throttle}]);
const run2=(g:RaceGame,seconds:number,inputs:DriveInput[])=>{for(let i=0;i<Math.round(seconds/RACE.step);i++)g.step(IDLE,inputs);};
/** Bumper-to-bumper gap between two cars in line. */
const bumper=(g:RaceGame,a=0,b=1)=>{const p=g.cars[a].body.translation(),q=g.cars[b].body.translation();return Math.hypot(p.x-q.x,p.z-q.z)-CAR_LENGTH;};
/** Steering that holds a lateral offset along the track (a driver keeping a line). */
const hold=(c:RaceGame['cars'][number],lateral:number)=>{const pt=c.projection.point;return clamp((lateral-c.projection.lateral)*.08-angle(c.heading-Math.atan2(pt.tx,pt.tz))*1.6,-1,1);};
test('tow zone: 3–12 m behind the bumper, in a narrow cone, aligned and fast; it eases out in the last metres and gives nothing on the bumper',()=>{
  assert.deepEqual({minGap:DRAFT.minGap,maxGap:DRAFT.maxGap,speedBonus:DRAFT.speedBonus,accelBonus:DRAFT.accelBonus,fade:DRAFT.fade},{minGap:3,maxGap:12,speedBonus:.12,accelBonus:.1,fade:2});
  assert.ok(Math.abs(CAR_LENGTH-4.06)<1e-9);
  const cases:[number,number,number,boolean][]=[[8,0,26,true],[3.2,.5,26,true],[11.8,2,26,true],[2.5,0,26,false],[12.5,0,26,false],[8,2.2,26,false],[-12,0,26,false],[8,0,10,false]];
  for(const [gap,side,speed,tow] of cases){const g=towFixture(gap,side,speed);try{g.step(IDLE,[IDLE,IDLE]);assert.equal(g.inTow(1,0),tow,`${gap} m behind, ${side} m aside, ${speed} m/s`);if(gap>0)assert.equal(g.inTow(0,1),false,'the leader is never towed by the car behind');}finally{g.dispose();}}
  const turned=towFixture(8);try{const c=turned.cars[1];c.place(c.body.translation(),c.heading+.45);c.body.setLinvel({x:Math.sin(c.heading)*26,y:0,z:Math.cos(c.heading)*26},true);turned.step(IDLE,[IDLE,IDLE]);assert.equal(turned.inTow(1,0),false,'not aligned');}finally{turned.dispose();}
  // How much of a tow works: all of it from 6.5 m, easing to nothing at 3 m, none on the bumper; beside a car, all of it.
  for(const [gap,side,room] of [[9,0,1],[DRAFT.minGap+DRAFT.ease,0,1],[DRAFT.minGap+DRAFT.ease*.75,0,.75],[DRAFT.minGap+DRAFT.ease/4,0,.25],[2.5,0,0],[.5,1,0],[1,2.5,1],[-3,3,1]] as const){
    const g=towFixture(gap,side);try{g.step(IDLE,[IDLE,IDLE]);assert.ok(Math.abs(g.cars[1].room-room)<.02,`${gap} m behind, ${side} m aside: ${g.cars[1].room}`);assert.equal(g.cars[0].room,1);assert.equal(g.snapshot(1).tooClose,room<.5);}finally{g.dispose();}
  }
});
test('tow builds after 0.6 s in the zone, fills in 1.5 s and fades slowly (2 s) once out of it',()=>{
  const g=towFixture(9);try{
    both(g,DRAFT.charge-.1);assert.equal(g.cars[1].draft,0,'no tow before the charge');
    both(g,.4);assert.ok(g.cars[1].draft>0&&g.cars[1].draft<.4,`building ${g.cars[1].draft}`);
    // Hold the gap (the leader at full throttle, the follower easing) until full.
    for(let i=0;i<120;i++)g.step(IDLE,[{...IDLE,throttle:1},{...IDLE,throttle:bumper(g)>8?1:0}]);
    assert.equal(g.cars[1].draft,1);assert.equal(g.cars[0].draft,0,'the leader gets nothing');assert.equal(g.snapshot(1).draft,1);
    // Out of the zone (well wide of the car ahead): it lasts, gone after 2 s.
    const c=g.cars[1],at=c.body.translation();c.body.setTranslation({x:at.x+Math.cos(c.heading)*7,y:at.y,z:at.z-Math.sin(c.heading)*7},true);
    both(g,1);assert.ok(c.draft>.4&&c.draft<.6,`fading ${c.draft}`);assert.equal(c.room,1);both(g,1.05);assert.equal(c.draft,0);
  }finally{g.dispose();}
});
test('a full tow lifts the top speed by up to 12% with soft pull, eases out in the wake and never puts the car on the bumper',()=>{
  const g=towFixture(12,0,CAR.maxSpeed-.2);try{let peak=0,closest=Infinity,surge=0;
    for(let i=0;i<Math.round(6/RACE.step);i++){const before=g.cars[1].forwardSpeed;g.step(IDLE,[{...IDLE,throttle:1,steer:hold(g.cars[0],0)},{...IDLE,throttle:1,steer:hold(g.cars[1],0)}]);
      peak=Math.max(peak,g.cars[1].forwardSpeed);surge=Math.max(surge,(g.cars[1].forwardSpeed-before)/RACE.step);closest=Math.min(closest,bumper(g));
      assert.ok(!g.events.some(e=>e.kind==='impact'),'never touches the car ahead');}
    assert.ok(peak>CAR.maxSpeed*1.04,`towed ${(peak*3.6).toFixed(1)} km/h`);assert.ok(peak<=CAR.maxSpeed*(1+DRAFT.speedBonus)+.05);
    assert.ok(surge<CAR.acceleration*(1+DRAFT.accelBonus)+.01,`pull ${surge.toFixed(2)} m/s²`);
    assert.ok(closest>2.8,`closest ${closest.toFixed(2)} m`);
    assert.ok(bumper(g)<4,'it settles in the wake, a few metres back');assert.equal(g.cars[1].draft,1,'and keeps its tow for the pass');
    assert.ok(Math.abs(g.cars[1].forwardSpeed-g.cars[0].forwardSpeed)<.4,'at the speed of the car ahead');
    assert.ok(g.cars[0].forwardSpeed<=CAR.maxSpeed+.05,'the leader stays at the normal cap');
  }finally{g.dispose();}
});
test('the tow pulls only forwards: no sideways pull towards the car ahead, no steering',()=>{
  const g=towFixture(8,1);try{both(g,4);const c=g.cars[1];assert.ok(c.draft>.5,`towed ${c.draft}`);
    assert.ok(Math.abs(c.projection.lateral-1)<.02,`kept its line: ${c.projection.lateral}`);assert.ok(Math.abs(c.body.angvel().y)<1e-6);assert.equal(c.steer,0);
  }finally{g.dispose();}
});
test('the slingshot: pulling out of the wake keeps the tow alongside and carries the car past',()=>{
  const g=towFixture(12,0,CAR.maxSpeed-.2);try{const [l,f]=g.cars;
    for(let i=0;i<Math.round(6/RACE.step);i++)g.step(IDLE,[{...IDLE,throttle:1,steer:hold(l,0)},{...IDLE,throttle:1,steer:hold(f,0)}]);
    assert.equal(f.draft,1);assert.ok(bumper(g)>2.8&&bumper(g)<4);
    // Pull out 3.2 m: the tow holds while alongside, then fades over 2 s and carries the car clear.
    let level=-1,clear=-1;
    for(let i=0;i<Math.round(9/RACE.step)&&clear<0;i++){g.step(IDLE,[{...IDLE,throttle:1,steer:hold(l,0)},{...IDLE,throttle:1,steer:hold(f,3.2)}]);
      const ahead=g.track.wrap(f.projection.s-l.projection.s+g.track.length/2)-g.track.length/2;
      if(level<0&&ahead>=0){level=i*RACE.step;assert.ok(f.draft>.95,`kept alongside: ${f.draft}`);}
      if(ahead>CAR_LENGTH+1)clear=i*RACE.step;
      assert.ok(!g.events.some(e=>e.kind==='impact'),'a clean pass');}
    assert.ok(level>0&&level<4.5,`level after ${level.toFixed(1)} s`);assert.ok(clear>0&&clear<9,`clear ahead after ${clear.toFixed(1)} s`);
  }finally{g.dispose();}
});
test('catch-up helps only the last car still racing, from 40 m behind, fully at 120 m (+5%)',()=>{
  const g=new RaceGame(3,{scale:5,width:100});try{g.phase='racing';g.bots=false;const t=g.track;
    g.progress.forEach(p=>{p.started=true;p.next=3;});
    const at=(id:number,s:number)=>{g.cars[id].place(t.pose(s,(id-1)*20),Math.atan2(t.at(s).tx,t.at(s).tz));};
    const check=(gap:number,expected:number)=>{at(0,500);at(1,480);at(2,480-gap);g.step(IDLE,[IDLE,IDLE,IDLE]);assert.ok(Math.abs(g.cars[2].catchUp-expected)<.02,`${gap} m: ${g.cars[2].catchUp}`);assert.equal(g.cars[0].catchUp,0);assert.equal(g.cars[1].catchUp,0);};
    check(30,0);check(80,.5);check(160,1);
    // The car ahead finished: the help is measured to the next one still racing; alone, none.
    g.progress[1].finish=10;at(2,300);g.step(IDLE,[IDLE,IDLE,IDLE]);assert.ok(Math.abs(g.cars[2].catchUp-1)<.02);
    g.progress[0].finish=11;g.step(IDLE,[IDLE,IDLE,IDLE]);assert.equal(g.cars[2].catchUp,0);
    assert.deepEqual({...CATCH_UP},{from:40,full:120,speedBonus:.05,accelBonus:.1});
  }finally{g.dispose();}
  const solo=new RaceGame(2,{scale:5,width:100});try{solo.phase='racing';solo.bots=false;const t=solo.track;solo.progress.forEach(p=>{p.started=true;p.next=3;});solo.progress[0].laps=1;
    solo.cars[0].place(t.pose(900),Math.atan2(t.at(900).tx,t.at(900).tz));solo.cars[1].place(t.pose(1250),Math.atan2(t.at(1250).tx,t.at(1250).tz));
    run2(solo,9,[IDLE,{...IDLE,throttle:1}]);assert.equal(solo.cars[1].catchUp,1);assert.ok(solo.cars[1].speed>CAR.maxSpeed*1.04&&solo.cars[1].speed<=CAR.maxSpeed*(1+CATCH_UP.speedBonus)+.05,`${solo.cars[1].speed}`);
  }finally{solo.dispose();}
});
test('bots use the tow (tuck in, pull out, pass) and still finish clean races without misses',()=>{
  let towed=0,passes=0;
  for(const n of [2,3] as const){const g=new RaceGame(n);try{g.autoHuman=true;let order:number[]=[],contacts=0;
    for(let i=0;i<9000&&g.phase!=='results';i++){g.step();towed+=g.cars.filter(c=>c.draft*c.room>.5).length*RACE.step;assert.ok(g.progress.every(p=>!p.missed),'bots on the racing line never miss');
      const now=raceOrder(g.progress,g.track,g.cars.map(c=>c.projection.s));if(g.time>8&&order.length&&now.join()!==order.join())passes++;order=now;if(g.time>5)contacts+=g.events.filter(e=>e.kind==='impact').length;}
    assert.equal(g.phase,'results');assert.ok(g.progress.every(p=>p.finish!==null&&p.laps===3));assert.equal(g.invalid,0);assert.ok(contacts<=4,`${n}P contacts ${contacts}`);
    assert.ok(g.cars.every(c=>c.projection.distance<c.projection.point.width/2+3));}finally{g.dispose();}}
  assert.ok(towed>10,`bots towed ${towed.toFixed(1)} s`);assert.ok(passes>=2,`bots passed ${passes} times`);
});
test('a bot behind a car at the top speed tucks in, pulls out on the slingshot and passes it',()=>{
  const g=new RaceGame(2,{scale:5,width:100});try{g.phase='racing';const t=g.track,lead=t.at(200),h=Math.atan2(lead.tx,lead.tz),[you,bot]=g.cars;
    const next=t.checkpoints.findIndex(c=>c.s>200);g.progress.forEach(p=>{p.started=true;p.next=next;});you.place(t.pose(200),h);bot.place(t.pose(200-11-CAR_LENGTH),h);
    for(const c of g.cars)c.body.setLinvel({x:lead.tx*CAR.maxSpeed,y:0,z:lead.tz*CAR.maxSpeed},true);
    let tucked=false,pulledOut=false,passed=false,topSpeed=0;
    for(let i=0;i<Math.round(20/RACE.step)&&!passed;i++){g.step({...IDLE,throttle:1,steer:hold(you,0)});
      tucked||=g.inTow(1,0);pulledOut||=g.drivers[1].passing===0;topSpeed=Math.max(topSpeed,bot.forwardSpeed);
      passed=t.wrap(bot.projection.s-you.projection.s+t.length/2)-t.length/2>CAR_LENGTH+1;assert.ok(!g.events.some(e=>e.kind==='impact'),'a clean pass');assert.ok(!g.progress[1].missed);}
    assert.ok(tucked&&pulledOut&&passed,`tucked ${tucked}, pulled out ${pulledOut}, passed ${passed}`);
    assert.ok(topSpeed>CAR.maxSpeed*1.06,`the bot used the tow's top speed: ${(topSpeed*3.6).toFixed(0)} km/h`);
  }finally{g.dispose();}
});
