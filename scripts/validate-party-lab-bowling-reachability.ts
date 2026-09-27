/** Local reachability calibration. Matrix drives the full course with throttle/brake;
 * bot cohort is selected by input quality only, before any outcomes are known. */
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {initializePhysics} from '../src/party-lab/scene/physics';
import {BowlingGame,IDLE_INPUT} from '../src/party-lab/scene/bowling/game';
import {BowlingClock} from '../src/party-lab/scene/bowling/clock';
import {BOWLING,COURSE,FLIGHT,BULLET,botThrow} from '../src/party-lab/scene/bowling/config';
import {courseSteering} from '../src/party-lab/scene/bowling/courseDriving';
await initializePhysics();
const out=process.argv[2]??'/private/tmp/bowling-reachability',count=Number(process.argv[3]??500);
mkdirSync(out,{recursive:true});
// Optional isolated-process comparison with a different rack distance.
if(process.argv[4])COURSE.headZ=BOWLING.rampLip+Number(process.argv[4]);
const save=(name:string,value:unknown)=>writeFileSync(`${out}/${name}.json`,JSON.stringify(value,null,2));
function shot(target:number,angle:number,extra:{nudge?:number;duration?:number;steer?:number;pitch?:number}={}) {
 const g=new BowlingGame(2,7281),clock=new BowlingClock();let armed=false;
 for(let i=0;i<10000&&g.score.turn===0;i++){
  const p=g.car.body.translation(),speed=g.car.speed;
  if(g.phase==='drive'&&p.z>=BOWLING.rampLip-1-speed*angle/FLIGHT.angleRate*BULLET.scale)armed=true;
  const input=g.phase==='drive'?{...IDLE_INPUT,throttle:speed<target/3.6?1:0,brake:speed>target/3.6+.1?.55:0,steer:courseSteering(p,g.car.heading,speed,g.obstacles,g.car.stuntStates),eject:armed&&(!g.charging||g.chargeTime+1e-8<angle/FLIGHT.angleRate)}:{...IDLE_INPUT,steer:g.elapsed<(extra.duration??0)?extra.steer??0:0,pitch:g.elapsed<(extra.duration??0)?extra.pitch??0:0,eject:g.elapsed>=(extra.nudge??Infinity)};
  clock.advance(g,1/240,input);
 }
 assert.equal(g.score.turn,1);assert.equal(g.retries,0);
 const result={target,angle,...extra,pins:g.lastPoints,miss:g.missedEject,measurement:g.measurements[0]??null};g.dispose();return result;
}
const matrix=[120,135,145,155,165].flatMap(speed=>[10,15,20,25,30].map(angle=>shot(speed,angle)));
save('matrix',matrix);
const effects={low:[0,5,8,10,15,20,25,30].map(angle=>shot(145,angle)),nudge:[120,135,145].flatMap(speed=>[15,20,25].flatMap(angle=>[undefined,1.2].map(nudge=>shot(speed,angle,{nudge})))),aerobatics:[{}, {steer:1,duration:.2},{pitch:1,duration:.3},{pitch:-1,duration:.3},{steer:1,duration:10}].map(extra=>shot(145,25,extra))};
save('effects',effects);
const bots=[];
for(let seed=0;bots.length<count;seed++){
 const profile=botThrow(seed,1,1);if(profile.quality<.18)continue;
 const g=new BowlingGame(2,seed),clock=new BowlingClock();g.score.turn=1;g.resetThrow();
 for(let i=0;i<9000&&g.score.turn===1;i++)clock.advance(g,1/60);
 assert.equal(g.score.turn,2);assert.equal(g.retries,0);
 bots.push({seed,profile,pins:g.lastPoints,miss:g.missedEject,measurement:g.measurements[0]??null});g.dispose();
 if(bots.length%50===0)console.log('Competent seeded throws',bots.length);
}
save('bots',bots);
const summary={distance:BOWLING.headZ-BOWLING.rampLip,count:bots.length,reached:bots.filter(b=>b.measurement?.rackReached).length,short:bots.filter(b=>b.measurement&&!b.measurement.rackReached).length,missedEject:bots.filter(b=>b.miss).length,bins:[bots.filter(b=>b.pins===0).length,bots.filter(b=>b.pins>=1&&b.pins<=3).length,bots.filter(b=>b.pins>=4&&b.pins<=6).length,bots.filter(b=>b.pins>=7&&b.pins<=9).length,bots.filter(b=>b.pins===10).length],matrix:matrix.map(s=>({speed:s.target,angle:s.angle,actual:s.measurement?.carSpeed! *3.6,reach:s.measurement?.rackReached,maxZ:s.measurement?.maxForwardZ,pins:s.pins}))};
save('summary',summary);console.log(JSON.stringify(summary,null,2));
