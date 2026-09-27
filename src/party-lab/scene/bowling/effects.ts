import { BufferGeometry, Float32BufferAttribute, Points, PointsMaterial, type Texture } from 'three';
import { BOWLING_PALETTE } from './palette';
/** Fixed 36-point pool, one draw call, no physics bodies or frame allocations. */
export function bowlingDust(texture: Texture) {
  const count=36,positions=new Float32Array(count*3),velocity=new Float32Array(count*3),life=new Float32Array(count),geometry=new BufferGeometry();
  positions.fill(-1000);geometry.setAttribute('position',new Float32BufferAttribute(positions,3));
  const material=new PointsMaterial({map:texture,color:BOWLING_PALETTE.chalk,size:.55,transparent:true,opacity:.24,depthWrite:false});
  const points=new Points(geometry,material);points.frustumCulled=false;points.visible=false;
  let cursor=0,trailTime=0,active=0;
  const emit=(p:{x:number;y:number;z:number},n:number,strength:number)=>{for(let j=0;j<n;j++){
    const i=cursor++%count,a=i*2.399;life[i]=.55;
    positions[i*3]=p.x;positions[i*3+1]=p.y;positions[i*3+2]=p.z;
    velocity[i*3]=Math.sin(a)*strength;velocity[i*3+1]=.5+i%3*.2;velocity[i*3+2]=Math.cos(a)*strength;
  }};
  return {points,get active(){return active;},burst(p:{x:number;y:number;z:number}){emit(p,12,2);},trail(p:{x:number;y:number;z:number},dt:number,skid:boolean){trailTime+=dt;if(trailTime>.12){trailTime=0;emit({x:p.x-.7,y:p.y-.45,z:p.z-1.5},skid?3:1,.6);emit({x:p.x+.7,y:p.y-.45,z:p.z-1.5},skid?3:1,.6);}},step(dt:number){
    active=0;for(let i=0;i<count;i++) {life[i]-=dt;if(life[i]<=0){positions[i*3+1]=-1000;continue;}active++;for(let c=0;c<3;c++)positions[i*3+c]+=velocity[i*3+c]*dt;}
    points.visible=active>0;geometry.attributes.position.needsUpdate=true;
  },dispose(){geometry.dispose();material.dispose();}};
}
