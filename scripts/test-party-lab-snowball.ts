// Reproducible local tuning experiments. Run: npx tsx scripts/test-party-lab-snowball.ts
import { writeFileSync } from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import { SnowballGame } from '../src/party-lab/scene/snowball/game';
import { SNOWBALL as C, IDLE } from '../src/party-lab/scene/snowball/config';

await RAPIER.init();
const round = (n:number) => Math.round(n*1000)/1000;
const vec = (v:{x:number;y:number;z:number})=>[v.x,v.y,v.z].map(round);
const speed=(g:SnowballGame)=>{const v=g.balls[0].body.linvel();return Math.hypot(v.x,v.z);};
function setup(radius:number=C.arenaRadius) {const g=new SnowballGame(2,radius);g.bots=false;g.phase='playing';return g;}
function pose(g:SnowballGame,id:number,x:number,z:number,vx=0,vz=0) {
  const b=g.balls[id].body;b.setTranslation({x,y:C.radius+0.001,z},true);b.setLinvel({x:vx,y:0,z:vz},true);b.setAngvel({x:vz/C.radius,y:0,z:-vx/C.radius},true);
}
const cases=[
  {name:'A stationary / medium',a:[-4,0,6,0],b:[0,0,0,0]},
  {name:'B stationary / high',a:[-4,0,10,0],b:[0,0,0,0]},
  {name:'C head-on',a:[-3,0,10,0],b:[3,0,-10,0]},
  {name:'D perpendicular',a:[-4,0,8,0],b:[0,-2.1,0,5]},
  {name:'E glancing',a:[-4,1.55,10,0],b:[0,0,0,0]},
  {name:'F edge defender',a:[4,0,10,0],b:[8,0,0,0]},
  {name:'G both at edge',a:[7.5,-2.5,0,8],b:[8,1.4,0,-5]},
  {name:'CCD stress',a:[-4,0,65,0],b:[4,0,-65,0]},
];
const collisions=cases.map(c=>{
  const g=setup();pose(g,0,...c.a as [number,number,number,number]);pose(g,1,...c.b as [number,number,number,number]);
  let pre=g.balls.map(b=>vec(b.body.linvel())),post:number[][]=[],impact=-1,minDistance=100,maxSpeed=0;
  const initial=g.balls.map(b=>b.body.translation());
  for(let i=0;i<480;i++){
    const before=g.balls.map(b=>vec(b.body.linvel()));g.step();
    const p=g.balls.map(b=>b.body.translation()),dist=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y,p[0].z-p[1].z);minDistance=Math.min(minDistance,dist);
    maxSpeed=Math.max(maxSpeed,...g.balls.map(b=>Math.hypot(...vec(b.body.linvel()))));
    if(!post.length&&g.hits.length){pre=before;post=g.balls.map(b=>vec(b.body.linvel()));impact=i*C.step;}
    if(g.phase!=='playing')break;
  }
  const result={name:c.name,pre,post,impact:round(impact),displacement:g.balls.map((b,i)=>{const p=b.body.translation();return round(Math.hypot(p.x-initial[i].x,p.z-initial[i].z));}),eliminated:g.balls.map(b=>!b.alive),maxOverlap:round(Math.max(0,2*C.radius-minDistance)),maxSpeed:round(maxSpeed),invalid:g.invalidBodies};g.dispose();return result;
});
const g=setup(200);pose(g,0,0,0);pose(g,1,100,100);let medium=-1,top=-1;
for(let i=0;i<1800;i++){g.step({throttle:1,steer:0});if(medium<0&&speed(g)>=5)medium=(i+1)*C.step;if(top<0&&speed(g)>=8)top=(i+1)*C.step;}
const terminal=speed(g),release=g.balls[0].body.translation();for(let i=0;i<360;i++)g.step();
const coast=g.balls[0].body.translation();const coast3=round(Math.hypot(coast.x-release.x,coast.z-release.z));
pose(g,0,0,0,0,-8);let stopTime=0;for(let i=0;i<600;i++){g.step({throttle:-1,steer:0});stopTime=(i+1)*C.step;if(speed(g)<0.3)break;}
const stopDistance=round(Math.hypot(g.balls[0].body.translation().x,g.balls[0].body.translation().z));g.dispose();
const steering=[2,8].map(v=>{const g=setup(200);pose(g,0,0,0,0,-v);pose(g,1,100,100);let time=0;
  while(g.balls[0].heading<Math.PI/2&&time<5){g.step({throttle:0,steer:1});time+=C.step;}
  const p=g.balls[0].body.translation(),vel=g.balls[0].body.linvel();const result={initialSpeed:v,time:round(time),position:vec(p),speed:round(speed(g)),trajectoryDegrees:round(Math.atan2(vel.x,-vel.z)*180/Math.PI)};g.dispose();return result;});
const surfaceVariants=[{name:'looser',friction:0.12,linear:0.06,angular:0.08},{name:'selected',friction:C.friction,linear:C.linearDamping,angular:C.angularDamping},{name:'grippier',friction:0.38,linear:0.22,angular:0.3}].map(tuning=>{
  const g=setup(200);g.floor.setFriction(tuning.friction);g.balls.forEach(b=>{b.body.collider(0).setFriction(tuning.friction);b.body.setLinearDamping(tuning.linear);b.body.setAngularDamping(tuning.angular);});pose(g,0,0,0,0,-8);pose(g,1,100,100);
  for(let i=0;i<360;i++)g.step();const coast3=round(-g.balls[0].body.translation().z),remainingSpeed=round(speed(g));pose(g,0,0,0,0,-8);let stop=0;
  while(speed(g)>0.3&&stop<4){g.step({throttle:-1,steer:0});stop+=C.step;}
  const result={...tuning,coast3,remainingSpeed,stopSeconds:round(stop),stopDistance:round(-g.balls[0].body.translation().z)};g.dispose();return result;
});
const pacing=[];
for(const radius of [9,10,11,13])for(const count of [2,3] as const){const durations:number[]=[],shrink:number[]=[],wins:number[][]=[];
  for(let seed=1;seed<=12;seed++) {const g=new SnowballGame(count,radius,seed);let lastRound=1;
    // All slots use the same delayed bot decisions as live rivals, including slot 0.
    for(let i=0;i<120*250&&g.phase!=='results';i++){
      const senses=g.sense();if(i%29===0)g.balls[0].input=snowBot(senses[0],senses,g.radius,g.elapsed,seed+g.round);
      const previous=g.phase;g.step(g.balls[0].input);
      if(previous==='playing'&&g.phase==='roundOver'){durations.push(round(g.elapsed));if(g.elapsed>C.shrinkStart)shrink.push(g.round);}
      lastRound=g.round;
    }wins.push(g.wins);if(g.phase!=='results')throw Error(`unfinished ${radius}/${count}/${seed}/${lastRound}`);if(g.invalidBodies)throw Error('invalid');g.dispose();
  }
  const sorted=[...durations].sort((a,b)=>a-b);pacing.push({diameter:radius*2,players:count,rounds:durations.length,mean:round(durations.reduce((a,b)=>a+b)/durations.length),median:sorted[Math.floor(sorted.length/2)],min:sorted[0],max:sorted.at(-1),shrinkRounds:shrink.length,wins});
}
import { snowBot } from '../src/party-lab/scene/snowball/bots';
const report={config:C,collisions,controls:{medium5:round(medium),useful8:round(top),terminal:round(terminal),coast3,stopFrom8:{time:round(stopTime),distance:stopDistance},steering},surfaceVariants,pacing};
const output=process.argv[2];if(output)writeFileSync(output,JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
