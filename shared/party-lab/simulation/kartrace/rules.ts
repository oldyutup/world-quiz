import { RACE, clamp, type Vec } from './config.js';
import { crossedGate, gateCrossing, type RaceTrack } from './track.js';
export interface Progress {
  started:boolean; next:number; laps:number; finish:number|null; wrongDwell:number; rightDwell:number; wrong:boolean; resets:number; hold:number; stuck:number; lastReset:number;
  /** The car went past its next checkpoint without passing through it (markMissed); cleared when it is earned or on a reset. */
  missed:boolean;
}
export const newProgress=():Progress=>({started:false,next:0,laps:0,finish:null,wrongDwell:0,rightDwell:0,wrong:false,resets:0,hold:0,stuck:0,lastReset:-10,missed:false});
/** "KONTROL NOKTASINI KAÇIRDIN": only after a real miss (never behind the checkpoint, driving the wrong way or respawning). */
export function missedCheckpoint(progress:Progress){
  return progress.missed&&progress.finish===null&&progress.hold===0;
}
export function advance(progress:Progress,track:RaceTrack,previous:Vec,current:Vec,time:number,laps:number=RACE.laps){
  if(progress.finish!==null||progress.hold>0||!crossedGate(previous,current,track.checkpoints[progress.next]))return false;
  if(progress.next===0){if(progress.started)progress.laps++;progress.started=true;if(progress.laps>=laps)progress.finish=time;}
  progress.next=(progress.next+1)%track.checkpoints.length;progress.missed=false;return true;
}
/**
 * A move that did not earn the next checkpoint is a miss when it crossed that checkpoint's line
 * forward beside it (beyond `gateMargin`, within `missReach` m of the asphalt), or crossed the line
 * of one of the `missLookahead` checkpoints after it. Driving back, the wrong way or behind it never is.
 */
export function markMissed(progress:Progress,track:RaceTrack,previous:Vec,current:Vec){
  if(progress.finish!==null||progress.hold>0||progress.missed||!progress.started)return false;
  const n=track.checkpoints.length;
  for(let k=0;k<=RACE.missLookahead;k++){
    const gate=track.checkpoints[(progress.next+k)%n],c=gateCrossing(previous,current,gate);
    if(c&&c.lateral<=gate.width/2+RACE.missReach&&c.y>-1&&c.y<6)return progress.missed=true;
  }
  return false;
}
export function wrongWay(progress:Progress,alongSpeed:number,dt:number){
  if(alongSpeed< -3){progress.wrongDwell+=dt;progress.rightDwell=0;}
  else {progress.wrongDwell=Math.max(0,progress.wrongDwell-dt*.6);progress.rightDwell+=dt;}
  if(progress.wrongDwell>2.1)progress.wrong=true;
  if(progress.rightDwell>.65){progress.wrong=false;progress.wrongDwell=0;}
}
export function raceDistance(progress:Progress,track:RaceTrack,s:number){
  if(!progress.started)return -track.wrap(-s);
  const n=track.checkpoints.length,last=(progress.next-1+n)%n,base=last*track.length/n;
  let d=track.wrap(s-base);if(d>track.length/2)d-=track.length;
  return progress.laps*track.length+base+clamp(d,0,track.length/n);
}
export function raceOrder(progress:Progress[],track:RaceTrack,distances:number[]){
  return progress.map((_,i)=>i).sort((a,b)=>{
    const x=progress[a],y=progress[b];
    if(x.finish!==null||y.finish!==null)return x.finish===null?1:y.finish===null?-1:x.finish-y.finish||a-b;
    // Earned laps/gates remain primary even when a reset places a car just
    // behind its last gate. A projected shortcut can never win this comparison.
    if(x.laps!==y.laps)return y.laps-x.laps;
    const n=track.checkpoints.length,gx=x.started?(x.next-1+n)%n:-1,gy=y.started?(y.next-1+n)%n:-1;
    if(gx!==gy)return gy-gx;
    return raceDistance(y,track,distances[b])-raceDistance(x,track,distances[a])||a-b;
  });
}
