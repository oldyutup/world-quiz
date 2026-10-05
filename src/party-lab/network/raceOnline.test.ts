import assert from 'node:assert/strict';
import {before,test} from 'node:test';
import {initializePhysics} from '../../../shared/party-lab/simulation/physics';
import {RaceRoundSimulation} from '../../../shared/party-lab/simulation/raceRound';
import {RaceGame} from '../../../shared/party-lab/simulation/kartrace/game';
import {IDLE} from '../../../shared/party-lab/simulation/kartrace/config';
import {restoreRace} from '../../../shared/party-lab/simulation/kartrace/wire';
import {validateRaceInput,type RaceInputPacket} from '../../../shared/party-lab/network/raceInput';
import {InputMailbox,neutralIntent} from '../../../shared/party-lab/network/protocol';
import {SnapshotBuffer} from './gameStream';
import {RacePrediction} from '../scene/kartrace/online';
before(initializePhysics);
const packet=(more:Partial<RaceInputPacket>={}):RaceInputPacket=>({seq:0,round:1,resetEpoch:0,throttle:0,brake:0,steer:0,handbrake:false,reset:false,...more});
test('Race accepts semantic actions only and preserves one reset edge across packet coalescing',()=>{
 for(const extra of [{position:[1,2,3]},{lap:3},{checkpoint:17},{finish:1},{camera:2}])assert.equal(validateRaceInput({...packet(),...extra}),null);
 assert.equal(validateRaceInput(packet({steer:NaN})),null);assert.equal(validateRaceInput(packet({resetEpoch:-1})),null);
 const b=new InputMailbox();assert.ok(b.accept(packet({reset:true}),1,0,'kart_race'));assert.ok(b.accept(packet({seq:1}),1,1,'kart_race'));assert.equal(b.read(2).race?.reset,true);assert.equal(b.read(3).race?.reset,false);assert.equal(b.read(302).race,undefined);
});
for(const count of [2,3]as const)test(`Race ${count}P server matches approved full three-lap physics and ordered progress`,()=>{
 const s=new RaceRoundSimulation(),g=new RaceGame(count);g.autoHuman=true;const slots=count===2?[0,2]as const:[0,1,2]as const;s.start(slots);
 try{for(let t=0;t<9500&&s.phase!=='results';t++){
  const intents=Array.from({length:3},neutralIntent);s.seats.forEach((slot,i)=>{const d=s.game.drivers[i].input(s.game.cars[i],s.game.cars,s.game.track,s.game.time,s.game.progress[i]);intents[slot].race=packet({...d,handbrake:!!d.handbrake,reset:!!d.reset,seq:t,resetEpoch:s.game.progress[i].resets});});
  // Both simulations consume exactly the same semantic actions; local AI is only the test driver.
  s.step(intents);g.bots=false;g.step(IDLE,s.seats.map(slot=>intents[slot].race!));
  assert.deepEqual(s.game.progress,g.progress);s.game.cars.forEach((c,i)=>assert.deepEqual(c.body.translation(),g.cars[i].body.translation()));
 }
 assert.equal(s.phase,'results');assert.ok(s.game.progress.every(p=>p.laps===3&&p.finish!==null));assert.equal(s.game.invalid,0);
 const f=s.snapshot([0,0,0]),b=new SnapshotBuffer();assert.ok(b.push(f,0));const copy=new RaceGame(count);try{for(let n=0;n<10;n++)restoreRace(copy,f.race!,b.latest!.values);assert.equal(copy.world.bodies.len(),count);assert.deepEqual(copy.progress,s.game.progress);}finally{copy.dispose();}
 }finally{s.dispose();g.dispose();}
});
for(const kind of ['side','rear','head-on']as const)test(`Race authoritative ${kind} contact survives replay, including handbrake`,()=>{
 const s=new RaceRoundSimulation();s.start([0,1]);s.phase='playing';const g=s.game;g.phase='racing';const [a,b]=g.cars;
 a.place({x:0,y:.64,z:40},0);b.place({x:kind==='side'?-4:0,y:.64,z:kind==='rear'?34:kind==='head-on'?49:41},kind==='head-on'?Math.PI:kind==='side'?.6:0);
 a.body.setLinvel({x:0,y:0,z:kind==='rear'?8:18},true);b.body.setLinvel({x:kind==='side'?11:0,y:0,z:kind==='head-on'?-18:kind==='side'?18:22},true);
 const buffer=new SnapshotBuffer(),p=new RacePrediction(0,2);let maxSpeed=0;
 try{for(let t=0;t<120;t++){const intents=Array.from({length:3},neutralIntent);intents[0].race=packet({seq:t,handbrake:t<30,steer:.25});s.step(intents);maxSpeed=Math.max(maxSpeed,a.speed);if(t%3===0){const f=s.snapshot([t,-1,-1]);buffer.push(f,t*1000/60);p.reconcile(buffer.latest!,t*1000/60);}p.step(packet({seq:t+1,handbrake:t<30,steer:.25}),t*1000/60);p.visual(1/60);}
 assert.ok(g.contacts>0);assert.ok(maxSpeed<40);assert.equal(g.invalid,0);assert.ok(p.game.stats().invalid===0);assert.ok(p.history.records.length<=48);assert.ok(p.metrics.replaySteps<1200);
 }finally{p.dispose();s.dispose();}
});
test('Race stale reset epochs cannot steer a reset car; departure cannot stall match',()=>{
 const s=new RaceRoundSimulation();s.start([0,2]);s.phase='playing';s.game.phase='racing';const intents=Array.from({length:3},neutralIntent);intents[0].race=packet({reset:true});
 try{s.step(intents);assert.equal(s.game.progress[0].resets,1);intents[0].race=packet({throttle:1});for(let t=0;t<120;t++)s.step(intents);assert.ok(s.game.cars[0].speed<.1);s.remove(2);for(let t=0;t<10000&&String(s.phase)!=='results';t++)s.step([]);assert.equal(s.phase,'results');assert.equal(s.game.cars[1].body.isEnabled(),false);}finally{s.dispose();}
});
