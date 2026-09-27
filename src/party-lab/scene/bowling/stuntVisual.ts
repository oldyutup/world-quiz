import { SphereGeometry, Color, DynamicDrawUsage, Float32BufferAttribute, Group, InstancedMesh, type MeshStandardMaterial } from 'three';
import type { StuntObstacle } from './config';
import type { StuntHit } from './car';
import { BOWLING_PALETTE as paint } from './palette';

/** Original hollow stunt balls: three authored shell pieces per prop, one draw.
 * Contacts split shells for 1.4s, then leave cosmetic pieces on the shoulder.
 * No debris bodies, collision, textures or per-frame geometry allocation. */
export function stuntVisual(_kit: Group, material: MeshStandardMaterial, initial: StuntObstacle[]) {
 const root=new Group(),pose=new Group();
 const geometry=new SphereGeometry(1,12,10,0,Math.PI*2/3);
 const colors=new Float32Array(geometry.attributes.position.count*3),v=geometry.attributes.position;
 for(let i=0;i<v.count;i++){
  const y=v.getY(i),x=v.getX(i),z=v.getZ(i);
  // Original painted grip spots, not copied textures or logos.
  const dot=(x-.5)**2+(y-.6)**2+(z-.6)**2<.045||(x-.75)**2+(y-.3)**2+(z-.55)**2<.035;
  new Color(dot?paint.steel:paint.pin).toArray(colors,i*3);
 }
 geometry.setAttribute('color',new Float32BufferAttribute(colors,3));
 const shells=new InstancedMesh(geometry,material,initial.length*3);
 shells.frustumCulled=false;shells.instanceMatrix.setUsage(DynamicDrawUsage);root.add(shells);
 const palette=[paint.ballCoral,paint.ballTeal,paint.ballCoral,paint.ballTeal,paint.ballCoral,paint.ballTeal];
 for(let i=0;i<shells.count;i++)shells.setColorAt(i,new Color(palette[Math.floor(i/3)]));
 const previous=initial.map(()=>''),previousAge=initial.map(()=>-2);
 function update(states:readonly StuntHit[],obstacles:readonly StuntObstacle[]=initial){
  let dirty=false;
  obstacles.forEach((c,i)=>{
   const s=states[i],t=s?.hit?Math.min(1.4,s.age):-1;
   const key=`${c.at[0]}:${c.at[2]}:${c.half[0]}:${c.active}`;
   if(previousAge[i]===t&&previous[i]===key)return;
   previousAge[i]=t;previous[i]=key;dirty=true;
   const r=c.half[0],fly=t<0?0:1-Math.exp(-3*t),side=s?.side??1;
   for(let j=0;j<3;j++){
    pose.position.set(c.at[0]+side*fly*(3+j*.5),t<0?c.at[1]:r*(1-fly)+.15+Math.max(0,2.5*t-4.9*t*t),c.at[2]+fly*(2+j));
    pose.rotation.set(fly*(1.5+j),j*Math.PI*2/3+fly*side,.2*fly*j);
    pose.scale.setScalar(c.active?r:0);pose.updateMatrix();shells.setMatrixAt(i*3+j,pose.matrix);
   }
  });
  if(dirty)shells.instanceMatrix.needsUpdate=true;
 }
 update([]);
 return {root,update,dispose(){geometry.dispose();}};
}
