import type RAPIER from '@dimforge/rapier3d-compat';
import assert from 'node:assert/strict';
import {before,test} from 'node:test';
import {Packr} from 'msgpackr';
import {initializePhysics} from '../../../shared/party-lab/simulation/physics';
import {SnowballRoundSimulation,snowballTie} from '../../../shared/party-lab/simulation/snowballRound';
import {SnowballGame} from '../../../shared/party-lab/simulation/snowball/game';
import {SNOWBALL as C,IDLE,arenaRadiusAt} from '../../../shared/party-lab/simulation/snowball/config';
import {snowballScreenInput} from '../../../shared/party-lab/simulation/snowball/screenInput';
import {snowballAxes,encodeSnowballInput,validateSnowballInput,type SnowballInputPacket} from '../../../shared/party-lab/network/snowballInput';
import {NET,InputMailbox,neutralIntent,type GameSnapshot} from '../../../shared/party-lab/network/protocol';
import {GAME_MODES,MixedRotation} from '../../../shared/party-lab/modes';
import {SnapshotBuffer} from './gameStream';
import {SnowballPrediction} from './prediction/snowballRig';
before(initializePhysics);
const packet=(seq=1,keys=1,stage=1):SnowballInputPacket=>({seq,round:1,stage,keys});
const inputs=(keys:number[],stage=1)=>keys.map(k=>({...neutralIntent(),snowball:packet(1,k,stage)}));
const playing=(count:2|3=2)=>{const s=new SnowballRoundSimulation(undefined,731);s.start(count===2?[0,1]:[0,1,2]);while(s.phase==='countdown')s.step([]);return s;};
const place=(s:SnowballRoundSimulation,i:number,x:number,z:number,vx=0,vz=0,y=.966)=>{const b=s.game.balls[i];b.body.setTranslation({x,y,z},true);b.body.setLinvel({x:vx,y:0,z:vz},true);b.body.setAngvel({x:vz/C.radius,y:0,z:-vx/C.radius},true);};
test('protocol 12: 10-byte WASD only, no state, V, seat or winner claims',()=>{
  assert.equal(NET.version,12);for(let keys=0;keys<16;keys++)assert.deepEqual(validateSnowballInput(encodeSnowballInput(packet(4,keys))),packet(4,keys));
  for(const extra of [{slot:2},{position:[0,0,0]},{velocity:[1,2,3]},{camera:1},{winner:0},{score:3},{V:true}])assert.equal(validateSnowballInput({...packet(),...extra}),null);
  for(const patch of [{keys:16},{keys:-1},{stage:0},{stage:4},{seq:NaN},{round:0},{seq:2**32}])assert.equal(validateSnowballInput({...packet(),...patch}),null);
  assert.equal(validateSnowballInput(new Uint8Array(11)),null);
  assert.deepEqual(snowballAxes(1),{x:0,z:-1});assert.deepEqual(snowballAxes(15),{x:0,z:0});
});
test('ordered match epochs, neutral stale/disconnect mailboxes and no delayed reset inputs',()=>{
  const m=new InputMailbox();assert.ok(m.accept(encodeSnowballInput(packet()),1,0,'snowball_brawl'));
  assert.equal(m.accept(packet(),1,1,'snowball_brawl'),false);assert.equal(m.accept({...packet(2),round:2},1,1,'snowball_brawl'),false);
  assert.equal(m.read(0).snowball?.keys,1);assert.equal(m.read(301).snowball,undefined);assert.ok(m.accept(packet(3),1,302,'snowball_brawl'));m.clear();assert.equal(m.read(302).snowball,undefined);assert.equal(m.accept(packet(2),1,302,'snowball_brawl'),false);
  const s=playing();s.game.round=2;const z=s.game.balls[0].body.translation().z;for(let i=0;i<60;i++)s.step(inputs([1,0],1));assert.ok(Math.abs(s.game.balls[0].body.translation().z-z)<.01);s.dispose();
});
test('2/3 occupied seats; symmetric safe spawns, no exact-three restriction',()=>{
  for(const seats of [[0,2],[0,1,2]] as const){const s=new SnowballRoundSimulation();assert.ok(s.start(seats));assert.deepEqual(s.seats,seats);assert.equal(s.game.balls.length,seats.length);const pts=s.game.balls.map(b=>b.body.translation());assert.ok(Math.abs(pts.reduce((n,p)=>n+p.x,0))<1e-5);assert.ok(Math.abs(pts.reduce((n,p)=>n+p.z,0))<1e-5);s.dispose();}
  for(const seats of [[0],[0,0],[0,1,2,2]]){const s=new SnowballRoundSimulation();assert.equal(s.start(seats as (0|1|2)[]),false);s.dispose();}
});
test('server motor, collisions and 120 Hz substeps exactly match approved local physics',()=>{
  const s=playing(3),g=new SnowballGame(3,10,731);g.bots=false;for(let i=0;i<s.game.tick;i++)g.step(IDLE,[]);
  for(let i=0;i<1400&&s.game.phase==='playing';i++){
    const keys=[i%180<120?1:4,i%200<100?8:2,i%140<70?3:12];
    s.step(inputs(keys));for(let sub=0;sub<2;sub++)g.step(IDLE,g.balls.map((b,id)=>{const a=snowballAxes(keys[id]),v=b.body.linvel();return snowballScreenInput(a.x,a.z,b.heading,Math.hypot(v.x,v.z));}));
    for(let id=0;id<3;id++){assert.deepEqual(s.game.balls[id].body.translation(),g.balls[id].body.translation());assert.deepEqual(s.game.balls[id].body.linvel(),g.balls[id].body.linvel());}
  }s.dispose();g.dispose();
});
test('online ties: later elimination wins; exact tick rotates deterministically; forfeits cannot win',()=>{
  assert.equal(snowballTie([123,124],new Set(),1,0),1);assert.equal(snowballTie([123,123],new Set(),1,0),0);assert.equal(snowballTie([123,123],new Set(),2,0),1);
  assert.equal(snowballTie([123,124],new Set([1]),1,0),0);assert.equal(snowballTie([-1,-1],new Set(),1,0),-1);
  for(const simultaneous of [false,true]){const s=playing();place(s,0,0,0,0,0,-4);if(simultaneous)place(s,1,0,0,0,0,-4);s.step([]);if(!simultaneous){for(let i=0;i<6;i++)s.step([]);place(s,1,0,0,0,0,-4);}for(let i=0;i<70;i++)s.step([]);assert.equal(s.game.phase,'roundOver');assert.equal(s.game.winner,simultaneous?1:1);assert.deepEqual(s.game.wins,[0,1]);for(let i=0;i<70;i++)s.step([]);assert.deepEqual(s.game.wins,[0,1]);s.dispose();}
});
test('shrink authoritative radius/collider and physical falls at 28/36 seconds; dead inputs inert',()=>{
  const s=playing();for(const elapsed of [27.9,28.1,35.9,36.1,45]){s.game.elapsed=elapsed;s.step([]);assert.ok(Math.abs(s.game.radius-arenaRadiusAt(s.game.elapsed))<=.011);if(s.game.radius>0)assert.equal((s.game.floor.shape as RAPIER.Cylinder).radius,s.game.radius);else assert.equal(s.game.floor.isEnabled(),false);assert.equal(s.snapshot([]).snowball!.radius,s.game.radius);}
  place(s,0,0,0,0,0,-4);s.step([]);assert.equal(s.accepts(0,1),false);const p=s.game.balls[0].body.translation();for(let i=0;i<20;i++)s.step(inputs([15,0]));assert.deepEqual(s.game.balls[0].body.translation(),p);s.dispose();
});
for(const count of [2,3] as const)test(`${count}P idle full match resolves three rounds with synchronized scores, reset, and bounded cost`,()=>{
  const s=playing(count),packr=new Packr({useRecords:false}),times:number[]=[],sizes:number[]=[],stages=new Set<number>();let scores=0;
  for(let i=0;i<12000&&s.phase!=='results';i++){const t=performance.now();s.step([]);times.push(performance.now()-t);stages.add(s.game.round);if(i%3===0){const snap=s.snapshot([-1,-1,-1]);sizes.push(packr.pack(snap).length);const buf=new SnapshotBuffer();assert.ok(buf.push(snap,i*1000/60));assert.equal(snap.snowball!.wins.reduce((a,b)=>a+b,0)>=scores,true);scores=snap.snowball!.wins.reduce((a,b)=>a+b,0);}}
  assert.equal(s.phase,'results');assert.deepEqual([...stages],[1,2,3]);assert.equal(scores,3);assert.equal(s.game.invalidBodies,0);assert.ok(Math.max(...sizes)<850);
  const sorted=times.sort((a,b)=>a-b);console.log(JSON.stringify({snowballPlayers:count,stepAvgMs:times.reduce((a,b)=>a+b,0)/times.length,p95:sorted[Math.floor(times.length*.95)],p99:sorted[Math.floor(times.length*.99)],maxBytes:Math.max(...sizes),inputHz:60,snapshotHz:20,inputBytes:10,scores:s.game.wins}));
  for(let i=0;i<601;i++)s.step([]);assert.equal(s.phase,'waiting');assert.ok(s.start(count===2?[0,1]:[0,1,2]));assert.deepEqual(s.game.wins,Array(count).fill(0));s.dispose();
});
test('disconnect expiry forfeits current/future rounds; neutralization retains sphere and momentum',()=>{
  const s=playing(3),body=s.game.balls[0].body;body.setLinvel({x:4,y:0,z:0},true);s.neutralize(0);assert.equal(s.game.balls[0].body,body);assert.equal(body.linvel().x,4);
  s.remove(0);assert.equal(s.accepts(0,1),false);for(let i=0;i<12000&&s.phase!=='results';i++)s.step([]);assert.equal(s.phase,'results');assert.equal(s.game.wins[0],0);assert.equal(s.game.invalidBodies,0);s.dispose();
});
test('Mixed: 8 at 3P, 7 at 2P, Snowball once and no bag boundary repeat',()=>{
  for(const n of [2,3]){const r=new MixedRotation();r.setPlayers(n);const expected=GAME_MODES.filter(m=>n===3||m!=='prop_hunt');assert.equal(expected.length,n===3?8:7);let last='';for(let b=0;b<100;b++){const seen=[];for(let i=0;i<expected.length;i++){assert.notEqual(r.next,last);seen.push(r.next);last=r.next;r.played();}assert.deepEqual(seen.sort(),[...expected].sort());assert.equal(seen.filter(m=>m==='snowball_brawl').length,1);}}
});
for(const [rtt,jitter,loss] of [[0,0,0],[150,40,.02],[250,60,.05]])test(`authoritative high-speed head-on prediction ${rtt}ms RTT / ${jitter}ms jitter / ${loss*100}% packet loss`,()=>{
  const s=playing(),pred=[new SnowballPrediction(0,2),new SnowballPrediction(1,2)],buffers=[new SnapshotBuffer(),new SnapshotBuffer()];
  place(s,0,0,6,0,-8.5);place(s,1,0,-6,0,8.5);s.game.balls[1].heading=Math.PI;
  let seed=73;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32),delay=()=>rtt/2+random()*jitter;
  const up:{at:number;p:SnowballInputPacket;slot:number}[]=[],down:{at:number;s:GameSnapshot;slot:number}[]=[];const mail=[new InputMailbox(),new InputMailbox()];
  let hit=false;const pre=s.game.balls.map(b=>b.body.linvel());
  for(let tick=0;tick<400;tick++){
    const now=tick*1000/60;
    for(let slot=0;slot<2;slot++){const p=packet(tick+1,tick<45?(slot?4:1):0);if(random()>=loss)up.push({at:now+delay(),p,slot});pred[slot].step(p,now);}
    up.sort((a,b)=>a.at-b.at);while(up[0]?.at<=now){const p=up.shift()!;mail[p.slot].accept(p.p,1,now,'snowball_brawl');}
    s.step(mail.map(m=>m.read(now)));hit ||= s.game.collisionCount>0;
    if(tick%3===0){const snapshot=s.snapshot(mail.map(m=>m.processedSeq));for(let slot=0;slot<2;slot++)if(random()>=loss)down.push({at:now+delay(),s:snapshot,slot});}
    down.sort((a,b)=>a.at-b.at);while(down[0]?.at<=now){const d=down.shift()!;if(buffers[d.slot].push(d.s,now))pred[d.slot].reconcile(buffers[d.slot].latest!,now);}
    pred.forEach(p=>{if(p.active)p.visual(1/60);});
  }
  assert.ok(hit);assert.equal(s.game.invalidBodies,0);for(const p of pred){assert.equal(p.metrics.overflows,0);assert.ok(p.metrics.maxError<3.5);assert.equal(p.metrics.hard,0);}
  const final=s.snapshot([10000,10000]);for(let i=0;i<2;i++){buffers[i].push(final,10000);pred[i].reconcile(buffers[i].latest!,10000);assert.deepEqual(buffers[i].latest!.snapshot.snowball!.wins,s.game.wins);assert.deepEqual(pred[i].game.balls[i].body.linvel(),s.game.balls[i].body.linvel());}
  console.log(JSON.stringify({headOn:{rtt,jitter,loss,pre,post:s.game.balls.map(b=>({p:b.body.translation(),v:b.body.linvel(),alive:b.alive})),corrections:pred.map(p=>p.metrics),wins:s.game.wins}}));pred.forEach(p=>p.dispose());s.dispose();
});
