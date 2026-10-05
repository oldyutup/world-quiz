import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import type {AddressInfo} from 'node:net';
import {Client,type Room} from '@colyseus/sdk';
import {matchMaker} from '@colyseus/core';
import {createPartyServer} from '../src/server.js';
import type {PartyRoom} from '../src/PartyRoom.js';
import type {LobbyState} from '../src/state.js';
import {CrateRoundSimulation} from '../../../shared/party-lab/simulation/crateRound.js';
import {FightRoundSimulation} from '../../../shared/party-lab/simulation/fightRound.js';
import {RaceRoundSimulation} from '../../../shared/party-lab/simulation/raceRound.js';
import {ClassicRoundSimulation} from '../../../shared/party-lab/simulation/classicRound.js';
import {NET,type GameSnapshot} from '../../../shared/party-lab/network/protocol.js';
const modes=['crate_rain','snowball_fight','kart_race','classic_bowling']as const;
const {server,httpServer}=createPartyServer();let endpoint='';const rooms:Room<unknown,LobbyState>[]=[];
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(f:()=>boolean,ms=8000){const end=Date.now()+ms;while(!f()){if(Date.now()>end)throw Error('timeout');await pause(10);}}
before(async()=>{await server.listen(0,'127.0.0.1');endpoint=`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;});
after(async()=>{for(const r of rooms){r.reconnection.enabled=false;if(r.connection.isOpen)await r.leave().catch(()=>{});}await server.gracefullyShutdown(false);});
async function peer(code?:string){const c=new Client(endpoint),r=code?await c.joinById<LobbyState>(code,{protocol:NET.version,nickname:'Guest',intent:'join',code}):await c.create<LobbyState>('party_lab',{protocol:NET.version,nickname:'Host',intent:'create'});rooms.push(r);r.onMessage('notice',()=>{});r.onMessage('feedback',()=>{});const snapshots:GameSnapshot[]=[];r.onMessage('snapshot',(s:GameSnapshot)=>snapshots.push(s));Object.assign(r.reconnection,{minUptime:0,minDelay:70,maxDelay:100,maxRetries:10});return{r,snapshots};}
type Peer=Awaited<ReturnType<typeof peer>>;
async function begin(mode:typeof modes[number],count=2){const peers=[await peer()];for(let i=1;i<count;i++)peers.push(await peer(peers[0].r.roomId));const room=matchMaker.getLocalRoomById(peers[0].r.roomId)as PartyRoom;
 peers[0].r.send('ready',true);await pause(30);peers[1].r.send('mode',mode);await pause(30);assert.notEqual(room.selection,mode);peers[0].r.send('mode',mode);await until(()=>room.selection===mode);assert.ok([...room.state.players.values()].every(p=>!p.ready));
 for(const p of peers)p.r.send('ready',true);await until(()=>room.game.phase==='countdown');await until(()=>room.game.phase==='playing');return{peers,room};}
async function reconnect(peers:Peer[],room:PartyRoom,index:number){const r=peers[index].r,id=r.sessionId,slot=room.state.players.get(id)!.slot,sim=room.game,round=sim.roundId,before=peers[index].snapshots.length;
 r.connection.close(4010);await until(()=>!room.state.players.get(id)!.connected);await until(()=>room.state.players.get(id)!.connected);await until(()=>peers[index].snapshots.length>before);
 assert.equal(r.sessionId,id);assert.equal(room.state.players.get(id)!.slot,slot);assert.equal(room.state.players.size,peers.length);assert.equal(room.game,sim);assert.equal(sim.roundId,round);assert.equal(peers[index].snapshots.at(-1)!.v,NET.version);
}
async function close(peers:Peer[]){for(const p of peers){p.r.reconnection.enabled=false;await p.r.leave();}}
for(const count of [2,3])test(`Crate ${count}P reconnect: warning/fall, fixed occupancy, KO, transition`,{timeout:30000},async()=>{
 const {peers,room}=await begin('crate_rain',count),s=room.game as CrateRoundSimulation,g=s.game;assert.ok(s instanceof CrateRoundSimulation);
 await until(()=>g.crates.some(c=>!c.firstHit));const handles=g.players.map(p=>p.body.handle);await reconnect(peers,room,0);assert.deepEqual(g.players.map(p=>p.body.handle),handles);
 await until(()=>g.crates.some(c=>c.firstHit));const fixed=g.crates.filter(c=>c.firstHit).map(c=>[c.id,c.body.handle]);await reconnect(peers,room,1);for(const [id,handle]of fixed)assert.equal(g.crates[id].body.handle,handle);
 g.players[0].alive=false;g.players[0].body.setEnabled(false);await reconnect(peers,room,0);assert.equal(g.players[0].alive,false);
 for(let i=1;i<count-1;i++){g.players[i].alive=false;g.players[i].body.setEnabled(false);}await until(()=>g.phase==='roundOver');const wins=[...g.wins];await reconnect(peers,room,0);assert.deepEqual(g.wins,wins);
 await until(()=>g.round===2);await reconnect(peers,room,0);assert.deepEqual(g.wins,wins);assert.equal(g.players.length,count);await close(peers);
});
for(const count of [2,3])test(`Fight ${count}P reconnect: gather, flight, KO, respawn, result`,{timeout:30000},async()=>{
 const {peers,room}=await begin('snowball_fight',count),s=room.game as FightRoundSimulation,g=s.game;assert.ok(s instanceof FightRoundSimulation);let seq=0;
 const send=(extra:Record<string,unknown>)=>peers[0].r.send('input',{seq:++seq,round:s.roundId,life:g.players[0].respawns,moveX:0,moveZ:0,yaw:Math.PI,pitch:0,jumpHeld:false,sprintHeld:false,crouchHeld:false,gatherHeld:false,throwPressed:false,...extra});
 const p=g.players[0];p.ammo=0;send({gatherHeld:true});await until(()=>p.gather>.1);await reconnect(peers,room,0);assert.equal(p.ammo,0);assert.equal(g.world.bodies.len(),count);
 p.ammo=3;send({throwPressed:true});await until(()=>g.balls.length>0);const throws=p.throws;await reconnect(peers,room,0);assert.equal(p.throws,throws);assert.equal(p.ammo,2);
 p.hp=0;p.respawnAt=g.time+1;p.body.setEnabled(false);p.collider.setEnabled(false);const respawns=p.respawns;await reconnect(peers,room,0);assert.equal(p.hp,0);await until(()=>p.respawns===respawns+1);await reconnect(peers,room,0);assert.equal(p.hp,3);assert.equal(p.ammo,3);assert.equal(p.respawns,respawns+1);
 g.elapsed=79.5;await reconnect(peers,room,1);await until(()=>s.phase==='results');await reconnect(peers,room,0);assert.equal(g.balls.length,0);await close(peers);
});
for(const count of [2,3])test(`Race ${count}P reconnect: checkpoint, lap, reset, finish`,{timeout:25000},async()=>{
 const {peers,room}=await begin('kart_race',count),s=room.game as RaceRoundSimulation,g=s.game;assert.ok(s instanceof RaceRoundSimulation);
 const handles=g.cars.map(c=>c.body.handle);const p=g.progress[0];p.started=true;p.next=5;p.laps=1;await reconnect(peers,room,0);assert.equal(p.next,5);assert.equal(p.laps,1);assert.deepEqual(g.cars.map(c=>c.body.handle),handles);
 g.cars[0].body.setTranslation({x:0,y:-4,z:40},true);await until(()=>p.resets===1);await reconnect(peers,room,0);assert.equal(p.resets,1);assert.equal(p.next,5);assert.equal(p.laps,1);
 p.finish=g.time;p.laps=3;g.firstFinish=p.finish;await reconnect(peers,room,0);assert.equal(p.laps,3);assert.ok(p.finish!==null);assert.equal(g.world.bodies.len(),count);await close(peers);
});
for(const count of [2,3])test(`Classic ${count}P reconnect: waiting, all selections, rolling, feedback, second roll`,{timeout:30000},async()=>{
 const {peers,room}=await begin('classic_bowling',count),s=room.game as ClassicRoundSimulation,g=s.game;assert.ok(s instanceof ClassicRoundSimulation);let seq=0;
 await reconnect(peers,room,1);assert.equal(g.score.seat,0);
 for(const phase of ['position','direction','power']){assert.equal(g.phase,phase);const epoch=s.epoch;await reconnect(peers,room,0);assert.equal(s.epoch,epoch);peers[0].r.send('input',{seq:++seq,round:s.roundId,epoch,pressed:true,eventTime:Date.now()});await until(()=>g.phase!==phase);peers[0].r.send('input',{seq:++seq,round:s.roundId,epoch,pressed:false,eventTime:0});await pause(30);}
 assert.equal(g.launches,1);await reconnect(peers,room,0);assert.equal(g.launches,1);await until(()=>g.phase==='feedback');const totals=[...g.score.totals];await reconnect(peers,room,1);assert.deepEqual(g.score.totals,totals);
 const standing=g.pins.filter(p=>!p.down).map(p=>p.id);await until(()=>g.phase==='position');if(standing.length){assert.equal(g.score.roll,2);assert.deepEqual(g.pins.map(p=>p.id),standing);}await reconnect(peers,room,0);assert.equal(g.launches,1);assert.deepEqual(g.score.totals,totals);await close(peers);
});
test('four modes keep 15-second seat grace, then forfeit without duplicating or reviving',{timeout:30000},async()=>{
 const fixtures=await Promise.all(modes.map(m=>begin(m)));for(const {peers,room}of fixtures){const r=peers[1].r;r.reconnection.enabled=false;r.connection.close(4010);await until(()=>!room.state.players.get(r.sessionId)!.connected);assert.equal(room.state.players.size,2);}
 await Promise.all(fixtures.map(async({peers,room})=>{await until(()=>!room.state.players.has(peers[1].r.sessionId),17500);const s=room.game;if(s instanceof CrateRoundSimulation)assert.equal(s.game.players[1].alive,false);else if(s instanceof FightRoundSimulation)assert.equal(s.game.players[1].hp,0);else if(s instanceof RaceRoundSimulation)assert.equal(s.game.cars[1].body.isEnabled(),false);else assert.ok(s instanceof ClassicRoundSimulation);await close(peers.slice(0,1));}));
});
