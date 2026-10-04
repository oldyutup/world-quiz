// npx tsx scripts/test-party-lab-snowball-collisions.ts [output.json] [module-directory]
// Same initial states and 120 Hz solver in before/after runs. Positions below
// are fixtures only; no post-contact position/velocity is assigned.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import RAPIER from '@dimforge/rapier3d-compat';
import type { SnowballGame as Game } from '../src/party-lab/scene/snowball/game';
const root=resolve(process.argv[3]??'src/party-lab/scene/snowball');
const {SnowballGame}=await import(pathToFileURL(root+'/game.ts').href);
const {SNOWBALL:C}=await import(pathToFileURL(root+'/config.ts').href);
const {snowballScreenInput}=await import(pathToFileURL(root+'/screenInput.ts').href);
await RAPIER.init();
type Pose=[number,number,number,number];
const scenarios:{name:string;a:Pose;b:Pose;elapsed?:number}[]=[
  {name:'low-frontal',a:[-3,0,1.5,0],b:[0,0,0,0]},
  {name:'medium-frontal',a:[-3,0,5.5,0],b:[0,0,0,0]},
  {name:'full-frontal',a:[-3,0,9.15,0],b:[0,0,0,0]},
  {name:'head-on',a:[-3,0,8,0],b:[3,0,-8,0]},
  {name:'side-hit',a:[-3,0,9.15,0],b:[0,-0.68,0,5.5]},
  {name:'glancing',a:[-3,1.55,9.15,0],b:[0,0,0,0]},
  {name:'near-edge',a:[4.5,0,9.15,0],b:[7.5,0,0,0]},
  {name:'near-edge-braced',a:[4.8,0,9.15,0],b:[7.8,0,0,0]},
  {name:'weak-edge-tap',a:[4.5,0,1.5,0],b:[7.5,0,0,0]},
  {name:'overcommit',a:[7.5,-2,0,9.15],b:[8,1,0,-6]},
  {name:'during-shrink',a:[2,0,9.15,0],b:[5,0,0,0],elapsed:36},
  {name:'CCD-stress',a:[-4,0,65,0],b:[4,0,-65,0]},
];
const round=(n:number)=>Math.round(n*1000)/1000;
const vector=(v:{x:number;y:number;z:number})=>[v.x,v.y,v.z].map(round);
const measure=[];
for(const s of scenarios)for(const mode of ['released','counter-input','defender-counter'] as const){
  const g:Game=new SnowballGame(2);g.bots=false;g.phase='playing';g.elapsed=s.elapsed??0;
  [s.a,s.b].forEach(([x,z,vx,vz],i)=>{const b=g.balls[i];b.heading=Math.PI/2;b.body.setTranslation({x,y:C.radius+.016,z},true);b.body.setLinvel({x:vx,y:0,z:vz},true);b.body.setAngvel({x:vz/C.radius,y:0,z:-vx/C.radius},true);});
  const p=()=>g.balls.map(b=>b.body.translation()),v=()=>g.balls.map(b=>b.body.linvel());
  let contactTick=-1,impact:unknown=null,normal={x:1,y:0,z:0},contactPositions=p(),last=p(),distance=[0,0],atHalf:unknown=null,atOne:unknown=null,min=100;
  const trace:unknown[]=[];
  for(let i=0;i<720;i++){
    const beforeP=p(),beforeV=v();
    const inputs=g.balls.map((b,id)=>{
      if(mode==='released'||contactTick<0||(mode==='defender-counter'&&id===0))return{throttle:0,steer:0};
      // Both hold toward the contact: attacker continues the ram; defender
      // counters the hit. This isolates input cancelling physical separation.
      const sign=id===0?1:-1,velocity=b.body.linvel();
      return snowballScreenInput(normal.x*sign,normal.z*sign,b.heading,Math.hypot(velocity.x,velocity.z));
    });
    g.step(inputs[0],inputs);const nowP=p(),nowV=v();let normalImpulse=0;
    g.world.contactPair(g.balls[0].body.collider(0),g.balls[1].body.collider(0),manifold=>{
      for(let k=0;k<manifold.numContacts();k++)normalImpulse+=manifold.contactImpulse(k);
    });
    // Eliminated bodies are disabled, so later visual crossings aren't solver overlap.
    if(g.balls.every(b=>b.alive))min=Math.min(min,Math.hypot(nowP[0].x-nowP[1].x,nowP[0].y-nowP[1].y,nowP[0].z-nowP[1].z));
    // Predictive solver contacts can exist a tick before an actual impulse.
    if(contactTick<0&&normalImpulse>0.01){
      const dx=beforeP[1].x-beforeP[0].x,dy=beforeP[1].y-beforeP[0].y,dz=beforeP[1].z-beforeP[0].z,len=Math.hypot(dx,dy,dz);normal={x:dx/len,y:dy/len,z:dz/len};
      contactTick=i;contactPositions=nowP;last=nowP;
      const closing=(beforeV[0].x-beforeV[1].x)*normal.x+(beforeV[0].y-beforeV[1].y)*normal.y+(beforeV[0].z-beforeV[1].z)*normal.z;
      const separation=(nowV[1].x-nowV[0].x)*normal.x+(nowV[1].y-nowV[0].y)*normal.y+(nowV[1].z-nowV[0].z)*normal.z;
      impact={at:round(g.elapsed),pre:beforeV.map(vector),post:nowV.map(vector),closing:round(closing),separation:round(separation),normalImpulse:round(normalImpulse)};
    }
    if(contactTick>=0){
      nowP.forEach((a,id)=>{distance[id]+=Math.hypot(a.x-last[id].x,a.z-last[id].z);});last=nowP;
      const after=(i-contactTick)*C.step;
      const sample=()=>({after:round(after),displacement:nowP.map((p,id)=>round(Math.hypot(p.x-contactPositions[id].x,p.z-contactPositions[id].z))),path:distance.map(round),velocity:nowV.map(vector),alive:g.balls.map(b=>b.alive)});
      if(i-contactTick===60)atHalf=sample();if(i-contactTick===120)atOne=sample();
      if((i-contactTick)%12===0||i-contactTick===1)trace.push(sample());
      if(after>=2.5)break;
    }
  }
  measure.push({name:s.name,mode,impact,atHalf,atOne,eliminated:g.balls.map(b=>!b.alive),invalid:g.invalidBodies,maxOverlap:round(Math.max(0,2*C.radius-min)),contacts:g.collisionCount,trace});g.dispose();
}
const result={config:C,measure};
if(process.argv[2]){writeFileSync(process.argv[2],JSON.stringify(result,null,2));console.log(JSON.stringify({output:process.argv[2],cases:measure.length,invalid:measure.reduce((n,m)=>n+m.invalid,0)}));}
else console.log(JSON.stringify(result,null,2));
