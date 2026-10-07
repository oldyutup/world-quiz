import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import type {AddressInfo} from 'node:net';
import {Client,type Room} from '@colyseus/sdk';
import {matchMaker} from '@colyseus/core';
import {createPartyServer} from '../src/server.js';
import type {PartyRoom} from '../src/PartyRoom.js';
import type {LobbyState} from '../src/state.js';
import {SnowballRoundSimulation} from '../../../shared/party-lab/simulation/snowballRound.js';
import {NET,type GameSnapshot} from '../../../shared/party-lab/network/protocol.js';
import {encodeSnowballInput} from '../../../shared/party-lab/network/snowballInput.js';
const {server,httpServer}=createPartyServer();let endpoint='';const rooms:Room<unknown,LobbyState>[]=[];
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(f:()=>boolean,ms=8000){const end=Date.now()+ms;while(!f()){if(Date.now()>end)throw Error('timeout');await pause(10);}}
before(async()=>{await server.listen(0,'127.0.0.1');endpoint=`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;});
after(async()=>{for(const r of rooms){r.reconnection.enabled=false;if(r.connection.isOpen)await r.leave().catch(()=>{});}await server.gracefullyShutdown(false);});
async function peer(code?:string){const client=new Client(endpoint),r=code?await client.joinById<LobbyState>(code,{protocol:NET.version,nickname:'Guest',intent:'join',code}):await client.create<LobbyState>('party_lab',{protocol:NET.version,nickname:'Host',intent:'create'});rooms.push(r);r.onMessage('notice',()=>{});r.onMessage('feedback',()=>{});const snapshots:GameSnapshot[]=[];r.onMessage('snapshot',(s:GameSnapshot)=>snapshots.push(s));Object.assign(r.reconnection,{minUptime:0,minDelay:100,maxDelay:150,maxRetries:10});return {r,snapshots};}
test('health is 15; a protocol-14 browser is refused before room creation',async()=>{
  assert.deepEqual(await (await fetch(`${endpoint}/health`)).json(),{ok:true,service:'party-lab',protocol:15});
  await assert.rejects(new Client(endpoint).create('party_lab',{protocol:14,nickname:'OldClient',intent:'create'}),/PROTOCOL_MISMATCH/);
});
for(const count of [2,3])test(`Snowball ${count} seats: host/Ready, WASD ownership, same-seat reconnect in five phases, scores and rematch`,{timeout:30000},async()=>{
  const peers=[await peer()];for(let i=1;i<count;i++)peers.push(await peer(peers[0].r.roomId));const room=matchMaker.getLocalRoomById(peers[0].r.roomId) as PartyRoom;
  peers[1].r.send('mode','snowball_brawl');await pause(100);assert.notEqual(room.selection,'snowball_brawl');
  peers[0].r.send('ready',true);await pause(50);peers[0].r.send('mode','snowball_brawl');await until(()=>room.selection==='snowball_brawl');assert.ok([...room.state.players.values()].every(p=>!p.ready));
  const ready=async()=>{for(const p of peers)p.r.send('ready',true);await until(()=>room.game.phase==='countdown');};
  await ready();const sim=room.game as SnowballRoundSimulation;assert.ok(sim instanceof SnowballRoundSimulation);
  const reconnect=async(index:number,checkGame=true)=>{const r=peers[index].r,id=r.sessionId,slot=room.state.players.get(id)!.slot,stage=sim.game.round,wins=[...sim.game.wins],alive=sim.game.balls.map(b=>b.alive),bodies=sim.game.balls.map(b=>b.body.handle),elapsed=sim.game.elapsed;
    r.connection.close(4010);await until(()=>!room.state.players.get(id)!.connected);await until(()=>room.state.players.get(id)!.connected);
    assert.equal(r.sessionId,id);assert.equal(room.state.players.get(id)!.slot,slot);assert.equal(room.state.players.size,count);assert.deepEqual(sim.game.balls.map(b=>b.body.handle),bodies);
    if(checkGame){assert.equal(sim.game.round,stage);assert.deepEqual(sim.game.wins,wins);assert.deepEqual(sim.game.balls.map(b=>b.alive),alive);assert.ok(sim.game.elapsed>=elapsed);}
  };
  // Existing room convention cancels an initial countdown and asks everyone to Ready again.
  await reconnect(0,false);assert.equal(sim.phase,'waiting');assert.ok([...room.state.players.values()].every(p=>!p.ready));await ready();sim.game.phaseTime=2.99;await until(()=>sim.phase==='playing');
  await reconnect(1);
  let seq=0;const send=(i:number,keys:number,stage=sim.game.round)=>peers[i].r.send('input',encodeSnowballInput({seq:++seq,round:sim.roundId,stage,keys}));
  const before=sim.game.balls.map(b=>b.body.translation());send(0,1);await pause(150);assert.ok(sim.game.balls[0].body.translation().z<before[0].z);assert.ok(Math.abs(sim.game.balls[1].body.translation().z-before[1].z)<.001);
  // A forged owner/body/score claim is rejected; packets cannot select another seat.
  peers[0].r.send('input',{seq:++seq,round:sim.roundId,stage:1,keys:8,slot:1,score:99});await pause(30);assert.deepEqual(sim.game.wins,Array(count).fill(0));
  sim.game.balls[0].body.setTranslation({x:0,y:-4,z:0},true);await until(()=>!sim.game.balls[0].alive);const dead=sim.game.balls[0].body.translation();send(0,15);await reconnect(0);assert.deepEqual(sim.game.balls[0].body.translation(),dead);assert.equal(sim.game.balls[0].alive,false);
  for(let i=1;i<count-1;i++)sim.game.balls[i].body.setTranslation({x:0,y:-4,z:0},true);
  await until(()=>sim.game.phase==='roundOver');const wins=[...sim.game.wins];await reconnect(0);assert.deepEqual(sim.game.wins,wins);
  sim.game.phaseTime=3.49;await until(()=>sim.game.round===2);send(0,15,1);await pause(100);assert.equal(sim.game.phase,'countdown');assert.equal(sim.game.balls[0].body.linvel().x,0);
  // Fast-forward only in this socket lifecycle test. Headed matches run wall-clock rounds.
  for(let i=0;i<12000&&(sim.phase as string)!=='results';i++)sim.step([]);
  assert.equal(sim.phase,'results');await reconnect(0);await until(()=>peers.every(p=>p.snapshots.some(s=>s.phase==='results')));
  assert.ok(peers.every(p=>JSON.stringify(p.snapshots.at(-1)!.snowball!.wins)===JSON.stringify(sim.game.wins)));
  (sim as unknown as {resultTime:number}).resultTime=9.99;await until(()=>sim.phase==='waiting');await until(()=>peers.every(p=>p.r.state.phase==='waiting'));
  await ready();assert.deepEqual(sim.game.wins,Array(count).fill(0));assert.equal(sim.game.balls.length,count);
  for(const p of peers){p.r.reconnection.enabled=false;await p.r.leave();}
});
test('active disconnect keeps 15-second seat grace, then forfeits without stalling or reviving',{timeout:24000},async()=>{
  const a=await peer(),b=await peer(a.r.roomId),room=matchMaker.getLocalRoomById(a.r.roomId) as PartyRoom;
  a.r.send('mode','snowball_brawl');await until(()=>room.selection==='snowball_brawl');a.r.send('ready',true);b.r.send('ready',true);await until(()=>room.game.phase==='countdown');const sim=room.game as SnowballRoundSimulation;sim.game.phaseTime=2.99;await until(()=>sim.phase==='playing');
  b.r.reconnection.enabled=false;b.r.connection.close(4010);await until(()=>!room.state.players.get(b.r.sessionId)!.connected);assert.equal(room.state.players.size,2);assert.equal(sim.game.balls[1].alive,true);
  await until(()=>!room.state.players.has(b.r.sessionId),17500);assert.equal(sim.game.balls[1].alive,false);assert.equal(sim.forfeits.has(1),true);
  await until(()=>sim.game.phase==='roundOver');assert.equal(sim.game.winner,0);assert.deepEqual(sim.game.wins,[1,0]);a.r.reconnection.enabled=false;await a.r.leave();
});
