import assert from 'node:assert/strict';
import {before,test} from 'node:test';
import {initializePhysics} from '../../../shared/party-lab/simulation/physics';
import {ClassicRoundSimulation} from '../../../shared/party-lab/simulation/classicRound';
import {ClassicGame} from '../../../shared/party-lab/simulation/classicbowling/game';
import {positionAt,directionAt,powerAt} from '../../../shared/party-lab/simulation/classicbowling/config';
import {restoreClassic} from '../../../shared/party-lab/simulation/classicbowling/wire';
import {validateClassicInput,classicEventTime,type ClassicInputPacket} from '../../../shared/party-lab/network/classicInput';
import {InputMailbox,neutralIntent} from '../../../shared/party-lab/network/protocol';
import {SnapshotBuffer} from './gameStream';
before(initializePhysics);
const packet=(more:Partial<ClassicInputPacket>={}):ClassicInputPacket=>({seq:0,round:1,epoch:0,pressed:false,eventTime:0,...more});
test('Classic rejects values, pins and scores; held press is consumed only once with original event timestamp',()=>{
 for(const extra of [{angle:4.3},{position:.1},{power:80},{pins:10},{score:30}])assert.equal(validateClassicInput({...packet(),...extra}),null);
 assert.equal(validateClassicInput(packet({eventTime:NaN})),null);assert.equal(validateClassicInput(packet({epoch:-1})),null);
 const b=new InputMailbox();assert.ok(b.accept(packet({pressed:true,eventTime:100}),1,0,'classic_bowling'));assert.ok(b.accept(packet({seq:1,pressed:true,eventTime:200}),1,1,'classic_bowling'));assert.equal(b.read(2).classic?.eventTime,100);assert.equal(b.read(3).classic?.pressed,false);
 assert.ok(b.accept(packet({seq:2}),1,4,'classic_bowling'));assert.ok(b.accept(packet({seq:3,pressed:true,eventTime:300}),1,5,'classic_bowling'));assert.equal(b.read(6).classic?.eventTime,300);
 assert.equal(classicEventTime(0,1000,500),750);assert.equal(classicEventTime(9999,1000,500),1025);assert.equal(classicEventTime(700,1000,900),900);
});
for(const rtt of [100,150,200])test(`Classic ${rtt} ms RTT locks the visibly sampled sweep, rejects stale phase and waiting player`,()=>{
 let now=10000;const s=new ClassicRoundSimulation(undefined,20,()=>now);s.start([0,2]);for(let t=0;t<181;t++){now+=1000/60;s.step([]);}assert.equal(s.phase,'playing');
 const intents=Array.from({length:3},neutralIntent);
 try{for(const [phase,fn]of [['position',positionAt],['direction',directionAt],['power',powerAt]]as const){assert.equal(s.game.phase,phase);const epoch=s.epoch,eventTime=s.phaseStart+321;now=eventTime+rtt/2;
  intents[2].classic=packet({seq:epoch,epoch,eventTime,pressed:true});s.step(intents);assert.equal(s.game.phase,phase);
  intents[0].classic=packet({seq:epoch+1,epoch,eventTime,pressed:true});s.step(intents);const chosen=phase==='position'?s.game.position:phase==='direction'?s.game.angle:s.game.power;assert.ok(Math.abs(chosen-fn(.321))<1e-10);
  const next=s.game.phase;now+=16;s.step(intents);assert.equal(s.game.phase,next);intents[0]=neutralIntent();intents[2]=neutralIntent();
 }
 assert.equal(s.game.launches,1);assert.equal(s.game.phase,'rolling');assert.equal(s.game.stats().invalid,0);
 }finally{s.dispose();}
});
for(const count of [2,3]as const)test(`Classic ${count}P full authoritative match has physical rolls, second rolls and idempotent reconnect in every phase`,()=>{
 let now=10000;const s=new ClassicRoundSimulation(undefined,7280,()=>now);const slots=count===2?[0,2]as const:[0,1,2]as const;s.start(slots);const copy=new ClassicGame(count),b=new SnapshotBuffer(),seen=new Set<string>();let seq=0,second=0,rolling=0;
 try{for(let t=0;t<30000&&s.phase!=='results';t++){
  now+=1000/60;const g=s.game,intents=Array.from({length:3},neutralIntent);if(s.phase==='playing'&&['position','direction','power'].includes(g.phase)){
   const key=g.phase as 'position'|'direction'|'power',target=g.plan[key];if(now-s.phaseStart>=target*1000)intents[s.seats[g.score.seat]].classic=packet({seq:++seq,epoch:s.epoch,pressed:true,eventTime:s.phaseStart+target*1000});
  }
  s.step(intents);const tag=`${g.score.seat}:${g.score.frame}:${g.score.roll}:${g.phase}`;if(!seen.has(tag)){seen.add(tag);if(g.phase==='rolling'){rolling++;if(g.score.roll===2)second++;}const f=s.snapshot([seq,seq,seq]);b.push(f,t*1000/60);for(let n=0;n<4;n++)restoreClassic(copy,f.classic!,b.latest!.values);assert.deepEqual(copy.score.totals,g.score.totals);assert.equal(copy.world.bodies.len(),g.pins.length+(g.ball?1:0));assert.equal(copy.stats().invalid,0);}
 }
 assert.equal(s.phase,'results');assert.ok(second>0);assert.ok(rolling>=count*3);assert.equal(s.game.launches,rolling);assert.ok(s.game.score.cards.every(c=>c.every(f=>f.rolls.length>=1&&f.rolls.length<=2)));assert.ok(s.game.score.totals.every(n=>n<=30));assert.equal(s.game.stats().invalid,0);
 }finally{copy.dispose();s.dispose();}
});
test('Classic departed active seat and idle connected seat cannot stall selection indefinitely',()=>{
 let now=10000;const s=new ClassicRoundSimulation(undefined,1,()=>now);s.start([0,1]);s.remove(0);
 try{for(let t=0;t<40000&&s.phase!=='results';t++){now+=1000/60;s.step([]);}assert.equal(s.phase,'results');assert.deepEqual(s.game.score.totals,[0,0]);}finally{s.dispose();}
});
