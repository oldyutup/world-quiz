import assert from 'node:assert/strict';
import {before,test} from 'node:test';
import {initializePhysics} from '../../../shared/party-lab/simulation/physics';
import {FightRoundSimulation} from '../../../shared/party-lab/simulation/fightRound';
import {SnowFightGame} from '../../../shared/party-lab/simulation/snowfight/game';
import {FIGHT as C,IDLE} from '../../../shared/party-lab/simulation/snowfight/config';
import {restoreFight} from '../../../shared/party-lab/simulation/snowfight/wire';
import {validateFightInput,type FightInputPacket} from '../../../shared/party-lab/network/fightInput';
import {InputMailbox,neutralIntent} from '../../../shared/party-lab/network/protocol';
import {SnapshotBuffer} from './gameStream';
before(initializePhysics);
const packet=(more:Partial<FightInputPacket>={}):FightInputPacket=>({seq:0,round:1,life:0,moveX:0,moveZ:0,yaw:Math.PI,pitch:0,jumpHeld:false,sprintHeld:false,crouchHeld:false,gatherHeld:false,throwPressed:false,...more});
test('Fight strict semantic input refuses position, origin, hit, ammo and score claims; throw pulse survives coalescing once',()=>{
 for(const extra of [{origin:[0,0,0]},{hit:1},{ammo:3},{score:8},{position:[1,2,3]},{hp:3}])assert.equal(validateFightInput({...packet(),...extra}),null);
 assert.equal(validateFightInput(packet({yaw:NaN})),null);assert.equal(validateFightInput(packet({life:-1})),null);
 const box=new InputMailbox();assert.ok(box.accept(packet({throwPressed:true}),1,0,'snowball_fight'));assert.ok(box.accept(packet({seq:1}),1,1,'snowball_fight'));
 assert.equal(box.read(2).fight?.throwPressed,true);assert.equal(box.read(3).fight?.throwPressed,false);assert.equal(box.read(302).fight,undefined);
});
for(const count of [2,3]as const)test(`Fight ${count}P complete timed authority preserves approved local trajectories and timer`,()=>{
 const s=new FightRoundSimulation(undefined,70),g=new SnowFightGame(count,71);g.bots=false;const slots=count===2?[0,2]as const:[0,1,2]as const;s.start(slots);
 try{for(let tick=0;tick<5200&&s.phase!=='results';tick++){
  s.step([]);g.step(IDLE);assert.equal(s.game.phase,g.phase);assert.equal(s.game.elapsed,g.elapsed);
  for(let i=0;i<count;i++)assert.deepEqual(s.game.players[i].body.translation(),g.players[i].body.translation());
 }
 assert.equal(s.phase,'results');assert.equal(s.game.elapsed,80);assert.equal(s.game.invalidBodies,0);
 }finally{s.dispose();g.dispose();}
});
test('Fight authoritative gather requires grounded snow, duration and capacity; reconnect never grants inventory',()=>{
 const s=new FightRoundSimulation();s.start([0,2]);s.phase='playing';s.game.phase='playing';const p=s.game.players[0];p.ammo=0;
 const intents=Array.from({length:3},neutralIntent);intents[0].fight=packet({gatherHeld:true});
 try{for(let i=0;i<46;i++)s.step(intents);assert.equal(p.ammo,0);s.step(intents);assert.equal(p.ammo,1);
  const f=s.snapshot([0,-1,-1]),b=new SnapshotBuffer();assert.ok(b.push(f,0));const replica=new SnowFightGame(2,f.fight!.seed);
  try{for(let i=0;i<12;i++)restoreFight(replica,f.fight!,b.latest!.values);assert.equal(replica.players[0].ammo,1);assert.equal(replica.world.bodies.len(),2);}finally{replica.dispose();}
  intents[0].fight=packet({gatherHeld:true,sprintHeld:true});for(let i=0;i<100;i++)s.step(intents);assert.equal(p.ammo,1);
  intents[0].fight=packet({gatherHeld:true});for(let i=0;i<200;i++)s.step(intents);assert.equal(p.ammo,C.inventory);
 }finally{s.dispose();}
});
test('Fight inventory, cadence, single-use projectiles and stale life inputs are server-owned',()=>{
 const s=new FightRoundSimulation();s.start([0,1]);s.phase='playing';s.game.phase='playing';const p=s.game.players[0],intents=Array.from({length:3},neutralIntent);
 try{
  for(let i=0;i<150;i++){intents[0].fight=packet({seq:i,throwPressed:i%2===0});s.step(intents);}
  assert.equal(p.ammo,0);assert.equal(p.throws,3);assert.equal(s.game.totals.throws,3);assert.ok(s.game.balls.length<=3);
  p.respawns=1;p.ammo=3;intents[0].fight=packet({throwPressed:true,life:0});for(let i=0;i<30;i++)s.step(intents);assert.equal(p.ammo,3);
  const ids=s.game.balls.map(b=>b.id);assert.equal(new Set(ids).size,ids.length);
  s.remove(1);for(let i=0;i<6000&&String(s.phase)!=='results';i++)s.step([]);assert.equal(s.phase,'results');assert.equal(s.game.players[1].hp,0);assert.equal(s.game.players[1].body.isEnabled(),false);
 }finally{s.dispose();}
});
