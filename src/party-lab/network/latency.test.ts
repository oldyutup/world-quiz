import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializePhysics } from '../../../shared/party-lab/simulation/physics';
import { OnlineRoundSimulation } from '../../../shared/party-lab/simulation/onlineRound';
import { InputMailbox, type InputPacket, type GameSnapshot, type GameEvent } from '../../../shared/party-lab/network/protocol';
import { GameStream } from './gameStream';

test('0/50/100 ms simulated RTT preserves server authority and measures presentation delay',async()=>{
 await initializePhysics();
 for(const rtt of [0,50,100]){
  const sim=new OnlineRoundSimulation(),stream=new GameStream(),mailbox=new InputMailbox();
  sim.start([0,1]);for(let i=0;i<360;i++)sim.step([]);
  const inputQueue:{due:number;packet:InputPacket}[]=[],outputQueue:{due:number;snapshot:GameSnapshot;events:GameEvent[]}[]=[];
  let seq=0,authority=-1,heard=-1,visible=-1;const x0=sim.physics.players[0].body.translation().x;
  let events:GameEvent[]=[];
  try{
   for(let i=0;i<150;i++){
    const now=i*1000/60;
    if(i%2===0){inputQueue.push({due:now+rtt/2,packet:{seq:++seq,round:1,moveX:now>=500&&now<1100?1:0,moveZ:0,punchPressed:i===30,jumpPressed:false,grabHeld:false,liftHeld:false}});}
    while(inputQueue[0]?.due<=now){const item=inputQueue.shift()!;mailbox.accept(item.packet,1,now);}
    const cues=sim.step([mailbox.read(now)]);events.push(...cues);
    if(cues.some(e=>e.name==='punchSwing'))authority=now;
    if(i%3===0){outputQueue.push({due:now+rtt/2,snapshot:sim.snapshot([mailbox.seq,-1,-1]),events});events=[];}
    while(outputQueue[0]?.due<=now){const item=outputQueue.shift()!;stream.snapshots.push(item.snapshot,now);stream.acceptEvents(item.events);}
    const frame=stream.snapshots.sample(now);
    if(frame){
     const x=frame.a.values[0]+(frame.b.values[0]-frame.a.values[0])*frame.alpha;
     if(visible<0&&x>x0+.1)visible=now;
     if(stream.drain(1,stream.snapshots.renderMs).some(e=>e.name==='punchSwing'))heard=now;
    }
   }
   assert.ok(authority>=500+rtt/2);assert.ok(heard>=authority);assert.ok(visible>=500);assert.equal(sim.combat.stats.punches,1);
   console.log(JSON.stringify({simulatedRttMs:rtt,punchAcceptedAfterMs:Math.round(authority-500),authoritativeSwingPresentedAfterMs:Math.round(heard-500),movementVisibleAfterMs:Math.round(visible-500)}));
  }finally{sim.dispose();}
 }
});
