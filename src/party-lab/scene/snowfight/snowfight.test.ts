import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { before, test } from 'node:test';
import { initializePhysics } from '../physics';
import { SnowFightGame } from './game';
import { FIGHT as C, IDLE, add, flight, leaders, seeded, type FightInput, type Vec } from './config';
import { MAP, gatherSurface, safeSpawn, inside, castMap, clearLine } from './map';
import { CAMERA, newCamera, updateCamera } from './camera';
import { FightBot, perceivableBalls } from './bots';
import { NET } from '../../../../shared/party-lab/network/protocol';
import { MODE_SELECTIONS } from '../../../../shared/party-lab/modes';
before(initializePhysics);
const run=(g:SnowFightGame,s:number,i:FightInput=IDLE)=>{for(let n=0;n<Math.round(s/C.step);n++)g.step(i);};
function place(g:SnowFightGame,id:number,p:Vec){const player=g.players[id];player.body.setTranslation(p,true);player.body.setLinvel({x:0,y:0,z:0},true);player.previous={...p};}
function fixture(){const g=new SnowFightGame(2);g.bots=false;g.phase='playing';place(g,0,{x:0,y:.025,z:0});place(g,1,{x:5,y:.025,z:0});run(g,.2);return g;}
function ball(g:SnowFightGame,owner:number,origin:Vec,v:Vec){g.balls.push({id:1000+g.totals.hits,owner,p:{...origin},previous:{...origin},v:{...v},born:g.time,age:0});}

test('approved two or three seats; Snowball Fight is registered online',()=>{assert.equal(NET.version,16);assert.ok(MODE_SELECTIONS.includes(C.id));assert.throws(()=>new SnowFightGame(4 as 2));});
test('fresh Mouse1 consumes one prepared ball; held button never repeats',()=>{const g=fixture(),i={...IDLE,yaw:Math.PI/2,throw:true,aim:{x:10,y:1.4,z:0}};g.step(i);assert.equal(g.players[0].ammo,2);assert.equal(g.balls.length,1);assert.ok(g.balls[0].p.x<1);run(g,.9,i);assert.equal(g.players[0].throws,1);g.step(IDLE);g.step(i);assert.equal(g.players[0].throws,2);assert.equal(g.players[0].ammo,1);g.dispose();});
test('E takes 0.78s per ball; early release cancels; inventory capped',()=>{const g=fixture(),p=g.players[0];p.ammo=0;run(g,.5,{...IDLE,gather:true});assert.equal(p.ammo,0);assert.ok(p.gather>.45);g.step();assert.equal(p.gather,0);run(g,.5,{...IDLE,gather:true});assert.equal(p.ammo,0);run(g,.3,{...IDLE,gather:true});assert.equal(p.ammo,1);run(g,4,{...IDLE,gather:true});assert.equal(p.ammo,3);assert.equal(p.gather,0);g.dispose();});
test('gather only snow: ground/bank yes, wood/stone/roof/air no',()=>{assert.ok(gatherSurface(MAP,{x:0,y:.025,z:0},true));assert.ok(gatherSurface(MAP,{x:-5,y:1.225,z:2},true));for(const p of [{x:-10,y:.325,z:6.8},{x:-3.4,y:1.925,z:-3.2},{x:-10,y:3.625,z:9.5},{x:0,y:1,z:0}])assert.equal(gatherSurface(MAP,p,true),false);assert.equal(gatherSurface(MAP,{x:0,y:.025,z:0},false),false);const g=fixture();g.players[0].ammo=0;run(g,1,{...IDLE,gather:true,sprint:true});assert.equal(g.players[0].ammo,0);g.dispose();});
test('walk/sprint/crouch/gather speeds, actual reduced collider and stable feet',()=>{for(const [i,speed]of [[{...IDLE,x:1},C.walk],[{...IDLE,x:1,sprint:true},C.sprint],[{...IDLE,x:1,crouch:true},C.crouch],[{...IDLE,x:1,gather:true},C.gatherSpeed]]as const){const g=fixture();place(g,1,{x:12,y:.025,z:12});g.players[0].ammo=0;run(g,.6,i);const p=g.players[0],v=p.body.linvel();assert.ok(Math.abs(v.x-speed)<.08,`${v.x} vs ${speed}`);if(i.crouch){assert.ok(Math.abs(p.collider.halfHeight()-(C.crouchHeight/2-C.radius))<1e-6);assert.ok(Math.abs(p.body.translation().y)<.04);}g.dispose();}});
test('jump is moderate; holding Space cannot bunny hop; gather blocks jump',()=>{const g=fixture();let peak=0,jumps=0;for(let n=0;n<120;n++){g.step({...IDLE,jump:true});peak=Math.max(peak,g.players[0].body.translation().y);jumps+=g.events.filter(e=>e.kind==='jump').length;}assert.ok(peak>.65&&peak<.90,`${peak}`);assert.equal(jumps,1);g.players[0].ammo=0;g.step();g.step({...IDLE,jump:true,gather:true});assert.ok(g.players[0].grounded);g.dispose();});
test('standing up under solid head room is refused until clear',()=>{const g=fixture(),p=g.players[0];g.step({...IDLE,crouch:true});const ceiling=g.world.createCollider(RAPIER.ColliderDesc.cuboid(1,.1,1).setTranslation(0,1.24,0));g.world.step();g.step();assert.equal(p.crouch,true);g.world.removeCollider(ceiling,true);g.step();assert.equal(p.crouch,false);g.dispose();});
test('one swept projectile gives exactly one damage, puff and bounded recoil',()=>{const g=fixture(),p=g.players[1];ball(g,0,{x:3,y:1.1,z:0},{x:18,y:0,z:0});run(g,.16);assert.equal(p.hp,2);assert.equal(g.balls.length,0);assert.equal(g.totals.hits,1);assert.ok(p.body.linvel().x>0&&p.body.linvel().x<3);run(g,.5);assert.equal(p.hp,2);g.dispose();});
test('head and body both do one damage; head is cosmetic extra recoil',()=>{for(const [height,head]of[[1.1,false],[1.66,true]]as const){const g=fixture();ball(g,0,{x:4.4,y:height,z:0},{x:18,y:0,z:0});let found=false;for(let n=0;n<6;n++){g.step();if(g.events.some(e=>e.kind==='hit'&&e.head===head))found=true;}assert.ok(found);assert.equal(g.players[1].hp,2);g.dispose();}});
test('hit interrupts E and leaves movement active during short flinch',()=>{const g=fixture(),p=g.players[0];p.ammo=0;run(g,.5,{...IDLE,gather:true});ball(g,1,{x:-.6,y:1,z:0},{x:18,y:0,z:0});g.step({...IDLE,gather:true});g.step({...IDLE,gather:true});assert.equal(p.hp,2);assert.equal(p.gather,0);assert.equal(p.ammo,0);run(g,.1,{...IDLE,z:1});assert.ok(p.body.linvel().z>.2);g.dispose();});
test('three hits -> one score, 2s respawn, protection ends on attack',()=>{const g=fixture(),p=g.players[1];for(let i=0;i<3;i++){place(g,1,{x:5,y:.025,z:0});g.world.step();ball(g,0,{x:4.4,y:1.1,z:0},{x:18,y:0,z:0});run(g,.08);}assert.equal(p.hp,0);assert.equal(g.players[0].score,1);run(g,1.7);assert.equal(p.hp,0);run(g,.4);assert.equal(p.hp,3);assert.equal(p.ammo,3);assert.equal(p.respawns,1);assert.ok(p.protection>g.time);const at=p.body.translation();ball(g,0,add(at,{x:-.6,y:1.1,z:0}),{x:18,y:0,z:0});run(g,.1);assert.equal(p.hp,3);g.throwBall(p,add(at,{x:5,y:1,z:0}));assert.equal(p.protection,0);assert.equal(g.world.bodies.len(),2);g.dispose();});
test('safe respawns separated and on usable snow',()=>{const enemies=[{x:-5.5,y:0,z:10.5},{x:5.5,y:0,z:-10.5}];const a=safeSpawn(MAP,enemies,1);assert.ok(enemies.every(e=>Math.hypot(e.x-a.x,e.z-a.z)>9));assert.ok(gatherSurface(MAP,a,true));assert.deepEqual(a,safeSpawn(MAP,enemies,1));});
test('projectiles follow gravity, expire and do not allocate bodies; rapid throws bounded',()=>{assert.deepEqual(flight({x:0,y:1,z:0},{x:18,y:0,z:0},1),{x:18,y:-3.25,z:0});const g=fixture();for(let n=0;n<600;n++){for(const p of g.players){p.ammo=3;g.throwBall(p,add(g.hand(p),{x:0,y:40,z:3}));}g.step();assert.ok(g.balls.length<=C.ballCap);}assert.equal(g.world.bodies.len(),2);run(g,4);assert.equal(g.balls.length,0);g.dispose();});
test('low cover protects crouch but exposes standing upper body',()=>{for(const crouch of[false,true]){const g=fixture();place(g,0,{x:-5,y:.025,z:3.2});place(g,1,{x:-5,y:.025,z:-1});run(g,.2,{...IDLE,crouch});ball(g,1,{x:-5,y:1.68,z:0},{x:0,y:0,z:18});run(g,.25,{...IDLE,crouch});assert.equal(g.players[0].hp,crouch?3:2);g.dispose();}});
test('snowballs break on low/medium/tall cover and hand origin cannot cross a wall',()=>{const g=fixture();ball(g,0,{x:-5,y:.8,z:0},{x:0,y:0,z:18});run(g,.2);assert.equal(g.balls.length,0);assert.equal(g.totals.hits,0);place(g,0,{x:-7.56,y:.025,z:-3});g.players[0].yaw=-Math.PI/2;g.world.step();g.throwBall(g.players[0],{x:-12,y:1.3,z:-3});assert.equal(g.totals.blocked,1);assert.equal(g.balls.length,0);g.dispose();});
test('camera shoulder/boom collides, recovers smoothly, pitch limited and stable',()=>{const state=newCamera(),feet={x:0,y:.025,z:0};updateCamera(state,MAP,feet,Math.PI,CAMERA.pitch,false,1/60);assert.ok(state.position.y>2.3&&state.position.y<2.8);const wallFeet={x:0,y:.025,z:12.5};for(let i=0;i<180;i++)updateCamera(state,MAP,wallFeet,Math.PI,CAMERA.pitch,false,1/60);assert.ok(state.boom<2);assert.ok(!MAP.some(s=>inside(state.position,s,CAMERA.radius-.01)));const before=state.boom;updateCamera(state,MAP,feet,Math.PI,CAMERA.pitch,false,1/60);assert.ok(state.boom<before+.5);for(let i=0;i<180;i++)updateCamera(state,MAP,feet,Math.PI,CAMERA.pitch,false,1/60);assert.ok(Math.abs(state.boom-(CAMERA.distance-.06))<.01);assert.ok(castMap(MAP,{x:-5,y:.8,z:0},{x:0,y:0,z:1},10)<2);assert.equal(clearLine(MAP,{x:-5,y:.8,z:0},{x:-5,y:.8,z:4}),false);});
test('bot only reacts to visible released balls after reaction time; pre-release is invisible',()=>{const g=fixture(),sense=g.sense(0);sense.now=1;sense.me.p={x:0,y:.025,z:0};const bullet={id:1,owner:1,p:{x:0,y:1,z:-4},v:{x:0,y:0,z:18},born:2};sense.projectiles=[bullet];assert.deepEqual(perceivableBalls(sense,Math.PI),[]);const a=new FightBot(0,seeded(9)),b=new FightBot(0,seeded(9));assert.deepEqual(a.think(sense),b.think({...sense,projectiles:[]}));bullet.born=.9;assert.equal(perceivableBalls(sense,Math.PI).length,1);const c=new FightBot(0,seeded(9));assert.deepEqual(c.think(sense),new FightBot(0,seeded(9)).think({...sense,projectiles:[]}));g.dispose();});
test('match timer and deterministic tie; full 2P/3P bot matches and seeded state',()=>{assert.deepEqual(leaders([2,2,1]),[0,1]);for(const count of[2,3]as const){const g=new SnowFightGame(count);g.autoHuman=true;run(g,C.countdown+C.duration+.1);assert.equal(g.phase,'results');assert.equal(g.elapsed,80);assert.equal(g.invalidBodies,0);assert.ok(g.totals.throws>20);assert.ok(g.totals.gathers>10);g.dispose();}const a=new SnowFightGame(3,123),b=new SnowFightGame(3,123);a.autoHuman=b.autoHuman=true;run(a,20);run(b,20);assert.deepEqual(a.stats(),b.stats());assert.deepEqual(a.players.map(p=>p.body.translation()),b.players.map(p=>p.body.translation()));a.dispose();b.dispose();});

test('snow under a tree canopy is gatherable; overhead foliage is not the supporting surface',()=>{
  assert.ok(gatherSurface(MAP,{x:-9.2,y:.025,z:0},true));
  const g=fixture();place(g,0,{x:-9.2,y:.025,z:0});g.players[0].ammo=0;run(g,1,{...IDLE,gather:true});assert.equal(g.players[0].ammo,1);g.dispose();
});
test('physical hits during sprint and airborne jump cause one damage without removing control',()=>{
  for(const airborne of[false,true]){
    const g=fixture(),p=g.players[0];run(g,airborne?.22:.3,{...IDLE,z:-1,sprint:!airborne,jump:airborne});const at=p.body.translation();assert.equal(p.grounded,!airborne);
    ball(g,1,{x:at.x-.65,y:at.y+1,z:at.z-.10},{x:18,y:0,z:0});run(g,.08,{...IDLE,z:-1,sprint:!airborne});assert.equal(p.hp,2);assert.ok(p.body.linvel().z<-.2);assert.equal(g.totals.hits,1);g.dispose();
  }
});
test('close through long ballistic hits have stable swept collision, equal damage, no duplicate impact',()=>{
  for(const range of[1,5,10,15,20]){
    const g=fixture(),p=g.players[1];place(g,0,{x:0,y:.025,z:12});place(g,1,{x:range-10,y:.025,z:-.7});g.world.step();
    const angle=.5*Math.asin(C.ballGravity*range/C.throwSpeed**2);
    ball(g,0,{x:-10,y:1,z:-.7},{x:Math.cos(angle)*C.throwSpeed,y:Math.sin(angle)*C.throwSpeed,z:0});run(g,1.5);
    assert.equal(p.hp,2,`range ${range}`);assert.equal(g.totals.hits,1);assert.equal(g.balls.length,0);g.dispose();
  }
});
test('medium fences, tall hut and tree trunk each break a physical projectile',()=>{
  for(const [origin,v]of[[{x:-6,y:1.3,z:-3},{x:-18,y:0,z:0}],[{x:-6,y:1.4,z:9.5},{x:-18,y:0,z:0}],[{x:-8,y:1.2,z:0},{x:-18,y:0,z:0}]] as [Vec,Vec][]){
    const g=fixture();place(g,0,{x:0,y:.025,z:10});place(g,1,{x:0,y:.025,z:-10});g.world.step();ball(g,0,origin,v);run(g,.4);assert.equal(g.balls.length,0);assert.equal(g.totals.impacts,1);assert.equal(g.totals.hits,0);g.dispose();
  }
});
test('camera does not falsely retract just above low cover and never enters blockers while orbiting',()=>{
  const state=newCamera();for(let i=0;i<90;i++)updateCamera(state,MAP,{x:0,y:.025,z:7.5},Math.PI,.16,false,1/60);assert.ok(state.boom>5);
  for(const feet of[{x:-7.45,y:.025,z:9.5},{x:-8.9,y:.025,z:0},{x:-1.9,y:.025,z:-3.2},{x:-5,y:.025,z:3.4}]){
    const camera=newCamera();for(let j=0;j<360;j++){updateCamera(camera,MAP,feet,j*Math.PI/180,.16,false,1/60);assert.ok(!MAP.some(s=>inside(camera.position,s,.21)),`${JSON.stringify(feet)} angle ${j}`);}
  }
});

test('moderate jump reaches the snow step and gathering uses its raised support',()=>{
  const g=fixture(),p=g.players[0];place(g,0,{x:-11,y:.025,z:-4.8});run(g,.2);run(g,.36,{...IDLE,z:-1,jump:true});run(g,.65);assert.ok(p.body.translation().y>.27&&p.body.translation().y<.34);assert.ok(p.grounded);p.ammo=0;run(g,.8,{...IDLE,gather:true});assert.equal(p.ammo,1);g.dispose();
});
