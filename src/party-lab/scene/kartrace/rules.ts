import { RACE, clamp, type Vec } from './config';
import { crossedGate, type RaceTrack } from './track';
export interface Progress {
  started:boolean; next:number; laps:number; finish:number|null; wrongDwell:number; rightDwell:number; wrong:boolean; resets:number; hold:number; stuck:number; lastReset:number;
}
export const newProgress=():Progress=>({started:false,next:0,laps:0,finish:null,wrongDwell:0,rightDwell:0,wrong:false,resets:0,hold:0,stuck:0,lastReset:-10});
export function missedCheckpoint(progress:Progress,track:RaceTrack,s:number){
  const past=track.wrap(s-track.checkpoints[progress.next].s);
  return progress.finish===null&&progress.hold===0&&past>2&&past<track.length/2;
}
export function advance(progress:Progress,track:RaceTrack,previous:Vec,current:Vec,time:number,laps:number=RACE.laps){
  if(progress.finish!==null||progress.hold>0||!crossedGate(previous,current,track.checkpoints[progress.next]))return false;
  if(progress.next===0){if(progress.started)progress.laps++;progress.started=true;if(progress.laps>=laps)progress.finish=time;}
  progress.next=(progress.next+1)%track.checkpoints.length;return true;
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
