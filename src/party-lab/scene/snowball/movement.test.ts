import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import type { Cylinder } from '@dimforge/rapier3d-compat';
import { initializePhysics } from '../physics';
import { SNOWBALL as C, arenaRadiusAt, arenaShrinkSpeedAt } from './config';
import { SnowballGame } from './game';
import { snowballScreenInput } from './screenInput';
import { snowBot } from './bots';

before(initializePhysics);
function setup(vx=0,vz=0) {
  const g=new SnowballGame(2,200);g.bots=false;g.phase='playing';
  const b=g.balls[0];b.heading=0;b.body.setTranslation({x:0,y:C.radius+.016,z:0},true);
  b.body.setLinvel({x:vx,y:0,z:vz},true);b.body.setAngvel({x:vz/C.radius,y:0,z:-vx/C.radius},true);
  g.balls[1].body.setTranslation({x:100,y:C.radius+.016,z:100},true);return g;
}
function drive(g:SnowballGame,x:number,z:number){const b=g.balls[0],v=b.body.linvel();g.step(snowballScreenInput(x,z,b.heading,Math.hypot(v.x,v.z)));}

test('counter-input reverses both directions symmetrically with finite braking time and distance',()=>{
  const outcomes:number[][]=[];
  for(const sign of [-1,1]){
    const g=setup(0,sign*8);let stopped=0,reverse3=0,maxTravel=0;
    try {
      for(let i=0;i<240;i++){
        drive(g,0,-sign);const v=g.balls[0].body.linvel().z,travel=g.balls[0].body.translation().z*sign;
        maxTravel=Math.max(maxTravel,travel);
        if(i===11)assert.ok(v*sign>6,'still travelling the original way after 100 ms');
        if(!stopped&&v*sign<.1)stopped=(i+1)*C.step;
        if(!reverse3&&v*-sign>=3)reverse3=(i+1)*C.step;
      }
      assert.ok(stopped>.45&&stopped<.85);assert.ok(reverse3>.8&&reverse3<1.4);
      assert.ok(maxTravel>2&&maxTravel<3.2,'high speed still needs several metres');
      outcomes.push([stopped,reverse3,maxTravel]);assert.equal(g.invalidBodies,0);
    } finally {g.dispose();}
  }
  outcomes[0].forEach((v,i)=>assert.ok(Math.abs(v-outcomes[1][i])<.001));
});

test('held 90-degree input redirects velocity after heading settles; fast turns remain wider',()=>{
  const times=[];
  for(const speed of [2,5,8]){
    const g=setup(0,-speed);let time=0;
    try {
      for(let i=0;i<360;i++){
        drive(g,1,0);const v=g.balls[0].body.linvel();
        const angle=Math.atan2(v.x,-v.z)*180/Math.PI;
        if(i===11)assert.ok(angle<20,'no immediate trajectory snap');
        if(!time&&angle>=80)time=(i+1)*C.step;
      }
      assert.ok(time>.3&&time<1.6);times.push(time);
    } finally {g.dispose();}
  }
  assert.ok(times[0]<times[1]&&times[1]<times[2]);
});

test('release coast, equal sphere mass, friction and CCD remain unchanged',()=>{
  const g=setup(0,-8);
  try {
    for(let i=0;i<360;i++)g.step();
    assert.ok(Math.abs(-g.balls[0].body.translation().z-19.844)<.015);
    assert.ok(Math.abs(-g.balls[0].body.linvel().z-5.395)<.01);
    g.balls.forEach(b=>{assert.ok(Math.abs(b.body.mass()-80)<.001);assert.equal(b.body.numColliders(),1);assert.ok(b.body.isCcdEnabled());});
    assert.equal(C.radius,.95);assert.equal(C.friction,.22);assert.equal(C.floorFriction,.22);
    assert.equal(C.linearDamping,.12);assert.equal(C.angularDamping,.16);
  } finally {g.dispose();}
});

test('early shrink is gentle, later shrink accelerates continuously, radius never grows',()=>{
  assert.equal(arenaRadiusAt(27.999),10);assert.equal(arenaRadiusAt(28),10);
  assert.ok(Math.abs(arenaRadiusAt(32)-8.2)<1e-9);assert.equal(arenaRadiusAt(36),6.4);
  assert.ok(Math.abs(arenaRadiusAt(40)-2.8)<1e-9);assert.equal(arenaRadiusAt(44),0);
  assert.equal(arenaShrinkSpeedAt(27),0);assert.equal(arenaShrinkSpeedAt(30),.45);assert.equal(arenaShrinkSpeedAt(38),.9);
  for(const boundary of [28,36])assert.ok(Math.abs(arenaRadiusAt(boundary-.0001)-arenaRadiusAt(boundary+.0001))<.0002);
  for(let t=0;t<50;t+=C.step)assert.ok(arenaRadiusAt(t+C.step)<=arenaRadiusAt(t));
});

test('shrinking collider matches visible-radius state and departure still eliminates by gravity',()=>{
  const g=new SnowballGame(2);g.bots=false;g.phase='playing';
  try {
    for(const time of [28,32,36,40]){
      g.elapsed=time-C.step;g.step();
      assert.ok(Math.abs(g.radius-arenaRadiusAt(time))<1e-8);
      assert.ok(Math.abs((g.floor.shape as Cylinder).radius-g.radius)<1e-5);
    }
    const b=g.balls[0];b.body.setTranslation({x:4,y:C.radius+.016,z:0},true);b.body.setLinvel({x:0,y:0,z:0},true);
    g.step();assert.ok(b.alive,'crossing the shrinking edge is not an instant kill');
    for(let i=0;i<130;i++)g.step();assert.equal(b.alive,false);
    g.resetRound();assert.equal(g.radius,10);assert.ok(g.floor.isEnabled());assert.equal(g.elapsed,0);
  } finally {g.dispose();}
});

test('bots still attack at the late-round center and react to the retreating edge without stat bonuses',()=>{
  const me={id:2,x:0,z:0,vx:0,vz:0,heading:0,alive:true};
  const rival={...me,id:0,z:-1.5};
  const command=snowBot(me,[me,rival],2.5,40,4);
  assert.ok(command.throttle>0,'center is safe enough to target the rival during deep shrink');
  assert.deepEqual(command,snowBot(me,[me,rival],2.5,40,4));
  const nearEdge={...me,id:1,x:2.1,z:0,vx:3,heading:Math.PI/2};
  const recover=snowBot(nearEdge,[nearEdge,rival],3,39,4);
  assert.equal(recover.throttle,-1);assert.ok(Math.abs(recover.steer)<=1);
});
