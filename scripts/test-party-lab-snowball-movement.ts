// Deterministic measurements through the same screen-input adapter used in Chrome.
// npx tsx scripts/test-party-lab-snowball-movement.ts [output.json] [module-directory]
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import RAPIER from '@dimforge/rapier3d-compat';
import type { SnowballGame as Game } from '../src/party-lab/scene/snowball/game';
const root=resolve(process.argv[3] ?? 'src/party-lab/scene/snowball');
const {SnowballGame}=await import(pathToFileURL(root+'/game.ts').href);
const {SNOWBALL:C,arenaRadiusAt}=await import(pathToFileURL(root+'/config.ts').href);
const {snowballScreenInput}=await import(pathToFileURL(root+'/screenInput.ts').href);
const {snowBot}=await import(pathToFileURL(root+'/bots.ts').href);
await RAPIER.init();
const round=(n:number|null)=>n===null?null:Math.round(n*1000)/1000;
const vel=(g:Game)=>g.balls[0].body.linvel();
const speed=(g:Game)=>{const v=vel(g);return Math.hypot(v.x,v.z);};
function pose(g:Game,id:number,x:number,z:number,vx=0,vz=0,heading=0){const b=g.balls[id];b.heading=heading;b.body.setTranslation({x,y:C.radius+.016,z},true);b.body.setLinvel({x:vx,y:0,z:vz},true);b.body.setAngvel({x:vz/C.radius,y:0,z:-vx/C.radius},true);}
function setup(vx=0,vz=0){const g:Game=new SnowballGame(2,200);g.phase='playing';g.bots=false;pose(g,0,0,0,vx,vz);pose(g,1,100,100);return g;}
function input(g:Game,x:number,z:number){return snowballScreenInput(x,z,g.balls[0].heading,speed(g));}
function accel(z:number){const g=setup();let to3=null,to5=null,to8=null;for(let i=0;i<1800;i++){g.step(input(g,0,z));const s=speed(g),t=(i+1)*C.step;if(to3===null&&s>=3)to3=t;if(to5===null&&s>=5)to5=t;if(to8===null&&s>=8)to8=t;}const result={to3:round(to3),to5:round(to5),to8:round(to8),terminal:round(speed(g))};g.dispose();return result;}
const forward=accel(-1),reverse=accel(1);
function reversal(initial:number,wantedZ:number){const g=setup(0,initial);let stop=null,reverse1=null,reverse3=null,stopDistance=null;
  for(let i=0;i<1200;i++){g.step(input(g,0,wantedZ));const along=vel(g).z*wantedZ,t=(i+1)*C.step;
    if(stop===null&&along>=-.1){stop=t;stopDistance=Math.abs(g.balls[0].body.translation().z);}
    if(reverse1===null&&along>=1)reverse1=t;if(reverse3===null&&along>=3)reverse3=t;
    if(reverse3!==null)break;
  }const r={initial:round(initial),stop:round(stop),stopDistance:round(stopDistance),reverse1:round(reverse1),reverse3:round(reverse3)};g.dispose();return r;
}
const turns=[2,5,8].map(initial=>{
  const g=setup(0,-initial);let heading90=null,trajectory45=null,trajectory80=null,trajectory85=null;let atHalf:unknown=null;
  for(let i=0;i<960;i++){g.step(input(g,1,0));const v=vel(g),angle=Math.atan2(v.x,-v.z)*180/Math.PI,t=(i+1)*C.step;
    if(heading90===null&&g.balls[0].heading>=Math.PI/2-.01)heading90=t;
    if(trajectory45===null&&angle>=45)trajectory45=t;
    if(trajectory80===null&&angle>=80)trajectory80=t;
    if(trajectory85===null&&angle>=85)trajectory85=t;
    if(i===59)atHalf={speed:round(speed(g)),trajectory:round(angle),heading:round(g.balls[0].heading*180/Math.PI)};
  }const r={initial,heading90:round(heading90),trajectory45:round(trajectory45),trajectory80:round(trajectory80),trajectory85:round(trajectory85),atHalf};g.dispose();return r;
});
const coast=[5,8].map(initial=>{const g=setup(0,-initial);for(let i=0;i<360;i++)g.step();const r={initial,after3Seconds:round(speed(g)),distance3Seconds:round(-g.balls[0].body.translation().z)};g.dispose();return r;});
const collisions=[{name:'medium-stationary',a:[-4,0,6,0],b:[0,0,0,0]},{name:'high-stationary',a:[-4,0,10,0],b:[0,0,0,0]},{name:'head-on',a:[-3,0,10,0],b:[3,0,-10,0]},{name:'glancing',a:[-4,1.55,10,0],b:[0,0,0,0]}].map(c=>{
  const g=setup();pose(g,0,...c.a as [number,number,number,number]);pose(g,1,...c.b as [number,number,number,number]);let pre:unknown=null,post:unknown=null,min=100;
  const velocities=()=>g.balls.map(b=>{const v=b.body.linvel();return[round(v.x),round(v.z)];});
  for(let i=0;i<240;i++){const before=velocities();g.step();const a=g.balls[0].body.translation(),b=g.balls[1].body.translation();min=Math.min(min,Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z));if(post===null&&g.hits.length){pre=before;post=velocities();}}
  const r={name:c.name,pre,post,maxOverlap:round(Math.max(0,C.radius*2-min)),invalid:g.invalidBodies};g.dispose();return r;
});
const pacing=[];
for(const count of [2,3] as const)for(const style of ['aggressive','defensive','bots']){
  const durations:number[]=[],deep:number[]=[],hits:number[]=[],shrink:number[]=[];
  for(let seed=1;seed<=8;seed++){
    const g:Game=new SnowballGame(count,C.arenaRadius,seed);let human={throttle:0,steer:0},keyX=0,keyZ=0;
    for(let i=0;i<120*180&&g.phase!=='results';i++){
      if(i%28===0){const me=g.sense()[0],rad=Math.hypot(me.x,me.z),out=(me.x*me.vx+me.z*me.vz)/Math.max(1,rad);
        if(style==='bots')human=snowBot(me,g.sense(),g.radius,g.elapsed,seed+g.round);
        else {const rival=g.sense().filter(b=>b.id!==0&&b.alive).sort((a,b)=>Math.hypot(a.x-me.x,a.z-me.z)-Math.hypot(b.x-me.x,b.z-me.z))[0];
          const edge=rad+Math.max(0,out)*.55>g.radius-1.8;
          const angle=g.elapsed*.7+seed;
          const tx=edge?0:style==='defensive'?Math.sin(angle)*g.radius*.38:rival?.x??0;
          const tz=edge?0:style==='defensive'?Math.cos(angle)*g.radius*.38:rival?.z??0;
          const dx=tx-me.x,dz=tz-me.z,max=Math.max(Math.abs(dx),Math.abs(dz));
          keyX=max>.3&&Math.abs(dx)>max*.42?Math.sign(dx):0;keyZ=max>.3&&Math.abs(dz)>max*.42?Math.sign(dz):0;
        }
      }
      if(style!=='bots')human=input(g,keyX,keyZ);
      const prev=g.phase;g.step(human);
      if(prev==='playing'&&g.phase==='roundOver'){durations.push(g.elapsed);hits.push(g.collisionCount);if(g.elapsed>C.shrinkStart)shrink.push(g.round);if(g.radius<5)deep.push(g.round);}
    }if(g.phase!=='results'||g.invalidBodies)throw Error('invalid or unfinished pacing run');g.dispose();
  }
  const sorted=[...durations].sort((a,b)=>a-b);pacing.push({count,style,rounds:durations.length,mean:round(durations.reduce((a,b)=>a+b)/durations.length),median:round(sorted[Math.floor(sorted.length/2)]),min:round(sorted[0]),max:round(sorted.at(-1)!),shrinkRounds:shrink.length,deepShrinkRounds:deep.length});
}
const result={config:C,forward,reverse,reversals:{forwardToReverse:reversal(-forward.terminal!,1),reverseToForward:reversal(reverse.terminal!,-1),from8:reversal(-8,1),from5:reversal(-5,1)},turns,coast,collisions,pacing,shrink:[0,25,28,30,32,35,38,40,42,45,50.5].map(seconds=>({seconds,radius:round(arenaRadiusAt(seconds))}))};
if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
