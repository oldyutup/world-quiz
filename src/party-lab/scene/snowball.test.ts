import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { initializePhysics } from './physics';
import { SnowballGame } from './snowball/game';
import { SNOWBALL as C, IDLE, arenaRadiusAt, snowSpawns, isSnowOut, snowWinner } from './snowball/config';
import { snowBot, type SnowSense } from './snowball/bots';
import { GAME_MODES, MODE_SELECTIONS } from '../../../shared/party-lab/modes';
import { NET } from '../../../shared/party-lab/network/protocol';

before(initializePhysics);
const ticks=(g:SnowballGame,n:number,input=IDLE)=>{for(let i=0;i<n;i++)g.step(input);};
const playing=(count:2|3=2,radius:number=C.arenaRadius)=>{const g=new SnowballGame(count,radius);g.bots=false;ticks(g,361);return g;};
const place=(g:SnowballGame,id:number,x:number,z:number,vx=0,vz=0,y=C.radius+0.016)=>{
  const b=g.balls[id].body;b.setTranslation({x,y,z},true);b.setLinvel({x:vx,y:0,z:vz},true);b.setAngvel({x:vz/C.radius,y:0,z:-vx/C.radius},true);
};
test('local config leaves seven online modes, Mixed, and protocol 10 intact',()=>{
  assert.equal(C.id,'snowball_brawl');assert.deepEqual(C.players,[2,3]);assert.equal(C.rounds,3);
  assert.equal(NET.version,10);assert.equal(GAME_MODES.length,7);assert.equal(MODE_SELECTIONS.length,8);
  assert.ok(![...MODE_SELECTIONS].some(m=>String(m)===C.id));
});
test('equal spaced spawns are inside arena and cannot overlap, including future capacity',()=>{
  for(const count of [2,3,8])for(const radius of [9,10,11,13])for(let round=1;round<=3;round++){
    const spawns=snowSpawns(count,radius,round);assert.equal(spawns.length,count);
    spawns.forEach((p,i)=>{assert.ok(Math.hypot(p.x,p.z)+C.radius<radius);spawns.slice(i+1).forEach(q=>assert.ok(Math.hypot(p.x-q.x,p.z-q.z)>C.radius*2));
      assert.ok(p.x*Math.sin(p.heading)+p.z*-Math.cos(p.heading)<0);});
  }
  assert.throws(()=>snowSpawns(1));
});
test('visible edge is not an elimination ring; falling below threshold is',()=>{
  assert.equal(isSnowOut({x:11,y:C.radius,z:0},10),false);
  assert.equal(isSnowOut({x:12,y:-3.49,z:0},10),false);
  assert.equal(isSnowOut({x:12,y:-3.51,z:0},10),true);
  assert.equal(isSnowOut({x:26,y:10,z:0},10),true);
});
test('winner supports draw and still-active rounds',()=>{
  assert.equal(snowWinner([true,true]),null);assert.equal(snowWinner([false,true,false]),1);assert.equal(snowWinner([false,false]),-1);
});
test('shrink starts late, is continuous, deterministic, and exhausts support',()=>{
  assert.equal(arenaRadiusAt(0),10);assert.equal(arenaRadiusAt(28),10);assert.equal(arenaRadiusAt(36),6.4);assert.ok(Math.abs(arenaRadiusAt(40)-2.8)<1e-9);assert.equal(arenaRadiusAt(100),0);
  const g=playing();g.elapsed=50.6;ticks(g,1);assert.equal(g.radius,0);assert.equal(g.floor.isEnabled(),false);g.dispose();
});
test('intro is three seconds and ignores thrust; one sphere of equal mass per slot',()=>{
  const g=new SnowballGame(3);const start=g.balls[0].body.translation();ticks(g,350,{throttle:1,steer:1});
  assert.equal(g.phase,'countdown');assert.ok(Math.abs(g.balls[0].body.translation().z-start.z)<0.001);
  assert.equal(g.world.bodies.len(),3);g.balls.forEach(b=>{assert.ok(Math.abs(b.body.mass()-80)<0.001);assert.equal(b.body.numColliders(),1);assert.ok(b.body.isCcdEnabled());});
  ticks(g,12);assert.equal(g.phase,'playing');g.dispose();
});
test('actual edge departure falls through gravity and two falling balls draw',()=>{
  const g=playing();place(g,0,11,0,4,0);place(g,1,-11,0,-4,0);
  assert.equal(g.balls[0].alive,true);ticks(g,300);assert.equal(g.phase,'roundOver');assert.equal(g.winner,-1);assert.deepEqual(g.wins,[0,0]);assert.equal(g.invalidBodies,0);g.dispose();
});
test('last survivor scores once, reset restores physics, three rounds end in results',()=>{
  const g=playing(3);
  for(let round=1;round<=3;round++){
    place(g,1,0,0,0,0,-4);place(g,2,0,0,0,0,-4);ticks(g,115);
    assert.equal(g.phase,'roundOver');assert.equal(g.winner,0);assert.equal(g.wins[0],round);
    ticks(g,425);
    if(round<3){assert.equal(g.phase,'countdown');assert.equal(g.round,round+1);assert.ok(g.balls.every(b=>b.alive));assert.equal(g.radius,C.arenaRadius);
      g.balls.forEach(b=>{assert.ok(Math.hypot(b.body.linvel().x,b.body.linvel().z)<0.01);assert.deepEqual(b.input,IDLE);});ticks(g,361);}
  }
  assert.equal(g.phase,'results');ticks(g,1200);assert.deepEqual(g.wins,[3,0,0]);g.dispose();
});
test('bot decisions are repeatable, bounded, and brake on an outward edge trajectory',()=>{
  const me:SnowSense={id:1,x:8,z:0,vx:6,vz:0,heading:Math.PI/2,alive:true};const rival={...me,id:0,x:0,vx:0};
  const input=snowBot(me,[me,rival],10,12,4);assert.equal(input.throttle,-1);assert.ok(Math.abs(input.steer)<=1);assert.deepEqual(input,snowBot(me,[me,rival],10,12,4));
  const charging={...me,x:0,z:0,vx:0,vz:-7.5,heading:0}, ahead={...rival,x:0,z:-6};
  assert.equal(snowBot({...charging,id:1},[ahead],10,3,1).throttle,1);
  assert.equal(snowBot({...charging,id:2},[ahead],10,3,1).throttle,0.45);
});
test('momentum builds, coasts, and cannot reverse instantly',()=>{
  const g=playing(2,100);place(g,0,0,0);place(g,1,50,50);g.balls[0].heading=0;
  ticks(g,60,{throttle:1,steer:0});const low=-g.balls[0].body.linvel().z;assert.ok(low>1&&low<4);
  ticks(g,300,{throttle:1,steer:0});assert.ok(-g.balls[0].body.linvel().z>7);
  ticks(g,60);assert.ok(-g.balls[0].body.linvel().z>6);
  ticks(g,12,{throttle:-1,steer:0});assert.ok(-g.balls[0].body.linvel().z>5);
  const q=g.balls[0].body.rotation();assert.ok(Math.abs(q.x)+Math.abs(q.z)>0.1);g.dispose();
});
test('equal-speed head-on contacts reverse both balls, no ghosting, NaNs or overlap',()=>{
  const g=playing();place(g,0,-3,0,10,0);place(g,1,3,0,-10,0);let hit=false,min=100;
  for(let i=0;i<100;i++){g.step();hit ||= g.hits.length>0;const a=g.balls[0].body.translation(),b=g.balls[1].body.translation();min=Math.min(min,Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z));}
  assert.ok(hit);assert.ok(g.balls[0].body.linvel().x<0);assert.ok(g.balls[1].body.linvel().x>0);assert.ok(min>C.radius*2-0.02);assert.equal(g.invalidBodies,0);g.dispose();
});
test('higher approach speed transfers more momentum; stationary ball loses the contact',()=>{
  const impacts=[5,9].map(speed=>{const g=playing();place(g,0,-4,0,speed);place(g,1,0,0);let target=0;
    for(let i=0;i<120;i++){g.step();if(g.hits.length){target=g.balls[1].body.linvel().x;assert.ok(target>g.balls[0].body.linvel().x);break;}}g.dispose();return target;});
  assert.ok(impacts[0]>3);assert.ok(impacts[1]>impacts[0]*1.5);
});
test('near-edge braking can recover; same unbraked entry self-eliminates',()=>{
  const outcomes=[true,false].map(brake=>{const g=playing();place(g,0,6.3,0,5,0);place(g,1,-5,0);g.balls[0].heading=Math.PI/2;
    ticks(g,240,brake?{throttle:-1,steer:0}:IDLE);const alive=g.balls[0].alive;g.dispose();return alive;});
  assert.deepEqual(outcomes,[true,false]);
});
