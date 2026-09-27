import { BOWLING, COURSE, type StuntObstacle } from './config';
/** Receding-horizon lane selection. Reads nearby visible obstacles and current
 * heading; no seed-to-route table, future trajectory, or launch assistance. */
export function courseSteering(p: {x:number;z:number}, heading:number, speed:number,
 obstacles:readonly StuntObstacle[], hits:readonly {hit:boolean}[], targetX=0, preference=1, skill=1) {
 const visible=obstacles.filter((o,i)=>o.active&&!hits[i]?.hit&&o.at[2]+o.half[2]+2>p.z&&o.at[2]<p.z+Math.max(18,speed*1.55));
 let target=targetX,lookAhead=Math.max(14,BOWLING.headZ-p.z);
 if(visible.length) {
  const nearest=Math.min(...visible.map(o=>o.at[2]));
  const row=visible.filter(o=>o.at[2]<nearest+5);
  let best=Infinity;
  for(let x=-BOWLING.roadWidth/2+1.4;x<=BOWLING.roadWidth/2-1.39;x+=.4){
   let cost=Math.abs(x-p.x)*.3+Math.abs(x-targetX)*.06-preference*x*.018;
   for(const o of row){
    const clearance=Math.abs(x-o.at[0])-o.half[0]-1.1;
    cost+=clearance<0?35-clearance*15:1/(clearance+.3);
   }
   if(cost<best){best=cost;target=x;}
  }
  lookAhead=Math.max(6,Math.min(17,nearest-p.z));
 } else if(p.z< COURSE.prepStart+1) { target=p.x*.96;lookAhead=16; }
 return Math.max(-1,Math.min(1,(Math.atan2(target-p.x,lookAhead)-heading)*(9+skill*3)));
}
