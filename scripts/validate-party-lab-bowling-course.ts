/** Reproducible course survey and full physical seeded throws; no outcome filtering. */
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {initializePhysics} from '../src/party-lab/scene/physics';
import {BowlingGame,IDLE_INPUT} from '../src/party-lab/scene/bowling/game';
import {BowlingClock} from '../src/party-lab/scene/bowling/clock';
import {BOWLING,COURSE,obstacleZ,FLIGHT,BULLET,BOTTOM_EASE,KICKER,COURSE_VARIANTS,courseVariant,botThrow,roadHeight,ROAD_HULLS,WALL_HULLS} from '../src/party-lab/scene/bowling/config';
import {courseSteering} from '../src/party-lab/scene/bowling/courseDriving';
await initializePhysics();
const out=process.argv[2]??'/private/tmp/bowling-course-validation';mkdirSync(out,{recursive:true});
const save=(name:string,data:unknown)=>writeFileSync(`${out}/${name}.json`,JSON.stringify(data,null,2));
const mean=(a:number[])=>a.reduce((x,y)=>x+y,0)/Math.max(1,a.length);
const bots=[];
for(let seed=0;bots.length<300;seed++){
 const profile=botThrow(seed,1,1);if(profile.quality<.18)continue;
 const g=new BowlingGame(2,seed),clock=new BowlingClock();g.score.turn=1;g.resetThrow();
 for(let tick=0;tick<9000&&g.score.turn===1;tick++)clock.advance(g,1/60);
 assert.equal(g.score.turn,2);assert.equal(g.retries,0);
 bots.push({seed,variant:courseVariant(seed),quality:profile.quality,pins:g.lastPoints,hits:g.car.hitCount,miss:g.missedEject,measurement:g.measurements[0]??null});g.dispose();
 if(bots.length%50===0)console.log('Competent physical throws:',bots.length);
}
save('course-bots',bots);
const variants=COURSE_VARIANTS.map((name,variant)=>{
 const rows=bots.filter(b=>b.variant===variant),shots=rows.flatMap(b=>b.measurement?[b.measurement]:[]);
 return {variant,name,count:rows.length,histogram:Array.from({length:11},(_,pins)=>rows.filter(b=>b.pins===pins).length),strikes:rows.filter(b=>b.pins===10).length,averagePins:mean(rows.map(b=>b.pins)),obstacleHarmed:rows.filter(b=>b.hits>0).length,usefulSpeed:shots.filter(m=>m.carSpeed>=19).length,missedLaunch:rows.filter(b=>b.miss).length,averageEjectSpeed:mean(shots.map(m=>m.carSpeed)),averageAirtime:mean(shots.map(m=>m.airTime))};
});
const driving=[];
for(let seed=0;seed<6;seed++)for(const direct of [false,true]){
 const g=new BowlingGame(2,seed),clock=new BowlingClock();let armed=false,next=0,unloaded=0,previousHits=0;const contacts:any[]=[],samples:any[]=[];
 const zs=[BOWLING.hillEnd,KICKER.start,KICKER.end,...[-84,-56,-28,-10].map(obstacleZ),BOWLING.prepStart,BOWLING.rampStart,BOWLING.rampLip-1];
 for(let tick=0;tick<9000&&g.score.turn===0;tick++){
  const p=g.car.body.translation(),before=g.car.speed;
  if(p.z>=zs[next]){samples.push({landmark:zs[next],z:p.z,x:p.x,time:g.driveTime,speed:before,hits:g.car.hitCount});next++;}
  if(g.phase==='drive'&&p.z>KICKER.start&&p.z<KICKER.end&&!g.car.grounded)unloaded+=1/120;
  if(g.phase==='drive'&&p.z>=(BOWLING.rampLip-1)-before*25/FLIGHT.angleRate*BULLET.scale)armed=true;
  const steer=direct?0:courseSteering(p,g.car.heading,before,g.obstacles,g.car.stuntStates);
  clock.advance(g,1/120,g.phase==='drive'?{...IDLE_INPUT,throttle:1,steer,eject:armed&&g.angle<25}:IDLE_INPUT);
  if(g.car.hitCount>previousHits){contacts.push({z:p.z,before,after:g.car.speed,hits:g.car.hitCount});previousHits=g.car.hitCount;}
 }
 driving.push({seed,direct,unloaded,samples,contacts,miss:g.missedEject,measurement:g.measurements[0]??null});g.dispose();
}
save('course-driving',driving);
let maxGrade=0,pathLength=0;for(let z=BOWLING.minZ;z<BOWLING.rampLip;z+=.01){const next=Math.min(BOWLING.rampLip,z+.01),dy=roadHeight(next)-roadHeight(z);if(z>=BOWLING.hillStart&&z<BOWLING.hillEnd)maxGrade=Math.max(maxGrade,Math.abs(dy/(next-z)));pathLength+=Math.hypot(next-z,dy);}
const geometry={boundsLength:BOWLING.length,spawnToEnd:BOWLING.maxZ-BOWLING.startZ,spawnToLip:BOWLING.rampLip-BOWLING.startZ,startElevation:BOWLING.startHeight,startPlatform:BOWLING.hillStart-BOWLING.minZ,plateauAhead:BOWLING.hillStart-BOWLING.startZ,roadWidth:BOWLING.roadWidth,downhillHorizontal:BOWLING.hillEnd-BOWLING.hillStart,drop:BOWLING.startHeight,steepestGrade:maxGrade,steepestDegrees:Math.atan(maxGrade)*180/Math.PI,averageGrade:BOWLING.startHeight/(BOWLING.hillEnd-BOWLING.hillStart),bottomTransition:BOTTOM_EASE,lowerSection:BOWLING.rampStart-BOWLING.hillEnd,kicker:KICKER,groups:[-84,-56,-28,-10].map(obstacleZ),groupGaps:[obstacleZ(-56)-obstacleZ(-84),obstacleZ(-28)-obstacleZ(-56),obstacleZ(-10)-obstacleZ(-28)],clearApproach:COURSE.finalApproachEnd-COURSE.finalApproachStart,angleZone:BOWLING.rampLip-BOWLING.prepStart,ramp:{length:BOWLING.rampLength,rise:BOWLING.rampHeight,width:BOWLING.roadWidth,lip:BOWLING.rampLip},lipToHead:BOWLING.headZ-BOWLING.rampLip,pinDeckWidth:COURSE.deck.maxX-COURSE.deck.minX,roadPathLength:pathLength,roadSlabs:ROAD_HULLS.length,wallSlabs:WALL_HULLS.length};
save('course-summary',{geometry,variants,total:{count:bots.length,strikes:bots.filter(b=>b.pins===10).length,averagePins:mean(bots.map(b=>b.pins)),obstacleHarmed:bots.filter(b=>b.hits>0).length,usefulSpeed:bots.filter(b=>(b.measurement?.carSpeed??0)>=19).length,misses:bots.filter(b=>b.miss).length},definitions:{competent:'Original botThrow quality >= .18; no outcome selection',obstacleHarmed:'At least one real chassis/ball contact, each removes >=5.9m/s and changes heading',usefulLaunchSpeed:'>=19m/s at physical eject; threshold is a report definition, not a game assist'}});
console.log(JSON.stringify({geometry,variants},null,2));
