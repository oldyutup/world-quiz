import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import type {AddressInfo} from 'node:net';
import {Client,type Room} from '@colyseus/sdk';
import {matchMaker} from '@colyseus/core';
import {createPartyServer} from '../src/server.js';
import type {PartyRoom} from '../src/PartyRoom.js';
import type {LobbyState} from '../src/state.js';
import {BowlingRoundSimulation} from '../../../shared/party-lab/simulation/bowlingRound.js';
import {NET,type GameSnapshot} from '../../../shared/party-lab/network/protocol.js';
import {encodeBowlingInput} from '../../../shared/party-lab/network/bowlingInput.js';
const {server,httpServer}=createPartyServer();let endpoint='';const rooms:Room<unknown,LobbyState>[]=[];
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(f:()=>boolean,ms=8000){const end=Date.now()+ms;while(!f()){if(Date.now()>end)throw Error('timeout');await pause(10);}}
before(async()=>{await server.listen(0,'127.0.0.1');endpoint=`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;});
after(async()=>{for(const r of rooms){r.reconnection.enabled=false;if(r.connection.isOpen)await r.leave().catch(()=>{});}await server.gracefullyShutdown(false);});
async function peer(code?:string){const client=new Client(endpoint),r=code?await client.joinById<LobbyState>(code,{protocol:NET.version,nickname:'Guest',intent:'join',code}):await client.create<LobbyState>('party_lab',{protocol:NET.version,nickname:'Host',intent:'create'});rooms.push(r);r.onMessage('notice',()=>{});r.onMessage('feedback',()=>{});const snapshots:GameSnapshot[]=[];r.onMessage('snapshot',(s:GameSnapshot)=>snapshots.push(s));Object.assign(r.reconnection,{minUptime:0,minDelay:100,maxDelay:150,maxRetries:10});return {r,snapshots};}
for(const count of [2,3])test(`Bowling ${count} seats: host/ready authority, inactive input, same-seat reconnect before turn, drive, flight, score`,{timeout:30000},async()=>{
 const peers=[await peer()];for(let i=1;i<count;i++)peers.push(await peer(peers[0].r.roomId));const room=matchMaker.getLocalRoomById(peers[0].r.roomId) as PartyRoom;
 peers[1].r.send('mode','human_bowling');await pause(100);assert.notEqual(room.selection,'human_bowling');
 peers[0].r.send('ready',true);await pause(50);peers[0].r.send('mode','human_bowling');await until(()=>room.selection==='human_bowling');assert.ok([...room.state.players.values()].every(p=>!p.ready));
 for(const p of peers)p.r.send('ready',true);await until(()=>room.game.phase==='playing');assert.ok(room.game instanceof BowlingRoundSimulation);const sim=room.game as BowlingRoundSimulation;
 assert.equal(sim.activeSeat,0);assert.deepEqual(sim.seats,Array.from({length:count},(_,i)=>i));
 const reconnect=async(index:number)=>{const r=peers[index].r,id=r.sessionId,slot=room.state.players.get(id)!.slot,turn=sim.game.score.turn,throws=JSON.stringify(sim.game.score.throws),nudged=sim.game.nudgeUsed,ejected=sim.game.ejected;
  r.connection.close(4010);await until(()=>!room.state.players.get(id)!.connected);await until(()=>room.state.players.get(id)!.connected);assert.equal(r.sessionId,id);assert.equal(room.state.players.get(id)!.slot,slot);assert.equal(sim.game.score.turn,turn);assert.equal(JSON.stringify(sim.game.score.throws),throws);assert.equal(sim.game.nudgeUsed,nudged);assert.equal(sim.game.ejected,ejected);
 };
 await reconnect(1);await reconnect(0);
 let seq=0;const send=(index:number,space:boolean,throttle=0,turn=sim.game.score.turn)=>peers[index].r.send('input',encodeBowlingInput({seq:++seq,round:sim.roundId,turn,throttle,brake:0,steer:0,pitch:0,space}));
 const z=sim.game.car.body.translation().z;send(1,false,1);await pause(120);assert.ok(Math.abs(sim.game.car.body.translation().z-z)<.1);
 // Near-ramp fixture isolates socket authority/edge/reconnect behavior. Full
 // physical approaches and matches are covered by the simulation and Chrome runs.
 sim.game.car.body.setTranslation({x:0,y:.64,z:24},true);sim.game.car.body.setLinvel({x:0,y:0,z:30},true);
 send(0,true);await until(()=>sim.game.charging);send(0,false);await until(()=>sim.game.ejected);const angle=sim.game.angle;
 await reconnect(0);assert.equal(sim.game.angle,angle);send(0,true);await until(()=>sim.game.nudgeUsed);send(0,false);await pause(30);send(0,true);await pause(30);assert.equal(sim.game.nudgeUsed,true);
 sim.game.finishThrow();const scored=JSON.stringify(sim.game.score.throws);await reconnect(0);assert.equal(JSON.stringify(sim.game.score.throws),scored);
 await until(()=>sim.game.phase==='countdown');const next=sim.activeSeat;assert.equal(next,1);send(0,true,1,0);await pause(60);assert.equal(sim.game.ejected,false);assert.equal(sim.game.score.turn,1);
 assert.ok(peers.every(p=>p.snapshots.some(s=>s.mode==='human_bowling'&&s.v===16)));
 for(const p of peers){p.r.reconnection.enabled=false;await p.r.leave();}
});


for (const enabled of [false, true]) test(`Bowling obstacle preference ${enabled}: serialized authority, Ready, Mixed, frozen match and reconnect`, {timeout:30000}, async()=>{
 const host=await peer(),guest=await peer(host.r.roomId),room=matchMaker.getLocalRoomById(host.r.roomId) as PartyRoom;
 const peers=[host,guest];
 const synchronized=async(value:boolean)=>until(()=>peers.every(p=>p.r.state?.bowlingObstacles===value));
 await synchronized(false);assert.equal(room.state.bowlingObstacles,false);
 host.r.send('mode','human_bowling');await until(()=>room.selection==='human_bowling');
 guest.r.send('bowlingSettings',{obstacles:true});await pause(80);assert.equal(room.state.bowlingObstacles,false);
 for(const invalid of [{obstacles:1},{obstacles:true,score:10},{},null])host.r.send('bowlingSettings',invalid);
 await pause(80);assert.equal(room.state.bowlingObstacles,false);
 // Exercise both directions, and a no-op that must not clear Ready.
 for(const value of [true,false,enabled]){
  guest.r.send('ready',true);await until(()=>room.state.players.get(guest.r.sessionId)!.ready);
  const changed:boolean=room.state.bowlingObstacles!==value;
  host.r.send('bowlingSettings',{obstacles:value});await synchronized(value);await pause(80);
  assert.equal(room.state.players.get(guest.r.sessionId)!.ready,!changed);
  if(changed)assert.ok([...room.state.players.values()].every(p=>!p.ready));
 }
 const reconnect=async()=>{
  const r=guest.r,id=r.sessionId,slot=room.state.players.get(id)!.slot;
  r.connection.close(4010);await until(()=>!room.state.players.get(id)!.connected);
  await until(()=>room.state.players.get(id)!.connected);await synchronized(enabled);
  assert.equal(r.sessionId,id);assert.equal(r.state.players.get(id)!.slot,slot);
 };
 await reconnect();
 host.r.send('mode','rooftop_brawl');await until(()=>room.selection==='rooftop_brawl');
 host.r.send('mode','mixed');await until(()=>room.selection==='mixed');
 assert.equal(room.state.bowlingObstacles,enabled);await synchronized(enabled);
 // Deterministically advance the Mixed bag to Bowling without simulating unrelated modes.
 while(room.rotation.next!=='human_bowling')room.rotation.played();room.upcoming=room.rotation.next;
 host.r.send('ready',true);guest.r.send('ready',true);await until(()=>room.game.phase==='countdown');
 assert.ok(room.game instanceof BowlingRoundSimulation);
 const sim=room.game as BowlingRoundSimulation;
 const frozen=()=>{
  assert.equal(sim.game.obstaclesEnabled,enabled);
  assert.equal(sim.game.obstacles.filter(o=>o.active).length,enabled?3:0);
  assert.ok(sim.game.car.props.every((p,i)=>p.collider.isEnabled()===sim.game.obstacles[i].active));
 };
 frozen();
 host.r.send('bowlingSettings',{obstacles:!enabled});await pause(100);
 assert.equal(room.state.bowlingObstacles,enabled);frozen();
 await until(()=>room.game.phase==='playing');
 await reconnect();frozen();
 host.r.send('bowlingSettings',{obstacles:!enabled});await pause(100);
 assert.equal(room.state.bowlingObstacles,enabled);frozen();
 await until(()=>peers.every(p=>p.snapshots.some(s=>s.v===16&&s.bowling?.obstacles===enabled)));
 for(const p of peers){p.r.reconnection.enabled=false;await p.r.leave();}
});
