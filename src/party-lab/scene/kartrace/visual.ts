import { BoxGeometry, BufferGeometry, CanvasTexture, Color, DoubleSide, Float32BufferAttribute, Group, InstancedMesh, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, SRGBColorSpace } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { COLORS, angle } from './config';
import type { RaceGame } from './game';
import type { RaceTrack } from './track';

/** A sunny countryside toy circuit: dark road, sage grass, ivory/coral kerbs.
 * Batched static geometry and reused CC0 Kenney kit; no mesh scenery colliders. */
export function raceVisual(kit:Group,track:RaceTrack,count:number){
  const root=new Group(),owned:BufferGeometry[]=[],parts:BufferGeometry[]=[],materials:(MeshStandardMaterial|MeshBasicMaterial)[]=[];
  // Long straights need only their ends (and width transitions) in the rendered
  // ribbon. Keep the full sampled centerline for physics, gates and bot routing.
  const roadPoints=track.points.filter((p,i,a)=>i===0||p.curve>1e-7||p.width!==a[(i-1+a.length)%a.length].width||p.width!==a[(i+1)%a.length].width);
  const material=new MeshStandardMaterial({vertexColors:true,roughness:.88,side:DoubleSide});materials.push(material);
  const paint=(g:BufferGeometry,color:string)=>{const c=new Color(color),data=new Float32Array(g.attributes.position.count*3);for(let i=0;i<data.length;i+=3)c.toArray(data,i);g.setAttribute('color',new Float32BufferAttribute(data,3));g.deleteAttribute('uv');return g;};
  const box=(size:[number,number,number],p:[number,number,number],color:string,yaw=0)=>{const g=paint(new BoxGeometry(...size).rotateY(yaw).translate(...p),color);parts.push(g.toNonIndexed());g.dispose();};
  const ribbon=(offset:(s:number,side:number)=>number,y:number,color:string,skirt=false)=>{
    const vertices:number[]=[],indices:number[]=[];
    for(const p of roadPoints)for(const side of [-1,1]){const w=offset(p.s,side);vertices.push(p.x+p.tz*w,y,p.z-p.tx*w);}
    for(let i=0;i<roadPoints.length;i++){const a=i*2,b=(a+2)%(roadPoints.length*2);indices.push(a,b,a+1,a+1,b,b+1);}
    const g=new BufferGeometry();g.setAttribute('position',new Float32BufferAttribute(vertices,3));g.setIndex(indices);g.computeVertexNormals();paint(g,color);parts.push(g.toNonIndexed());g.dispose();
    if(skirt)for(const side of [-1,1])for(let i=0;i<track.points.length;i++){
      const a=track.points[i],b=track.points[(i+1)%track.points.length],wa=offset(a.s,side),wb=offset(b.s,side),ax=a.x+a.tz*wa,az=a.z-a.tx*wa,bx=b.x+b.tz*wb,bz=b.z-b.tx*wb;
      const h=new BufferGeometry();h.setAttribute('position',new Float32BufferAttribute([ax,0,az,bx,0,bz,ax,-8,az,bx,0,bz,bx,-8,bz,ax,-8,az],3));h.computeVertexNormals();paint(h,i%5?'#af9271':'#bea37e');parts.push(h);
    }
  };
  const land=new BufferGeometry();land.setAttribute('position',new Float32BufferAttribute(track.land.flatMap(p=>[p.x,-.025,p.z]),3));land.setIndex(track.landIndices);land.computeVertexNormals();paint(land,'#88a86e');parts.push(land.toNonIndexed());land.dispose();
  for(let i=0;i<track.land.length;i++){const a=track.land[i],b=track.land[(i+1)%track.land.length],g=new BufferGeometry();g.setAttribute('position',new Float32BufferAttribute([a.x,-.03,a.z,b.x,-.03,b.z,a.x,-8,a.z,b.x,-.03,b.z,b.x,-8,b.z,a.x,-8,a.z],3));g.computeVertexNormals();paint(g,'#b59b78');parts.push(g);}
  ribbon((s,side)=>side*track.at(s).width/2,.015,'#343d42');
  for(const side of [-1,1]){
    ribbon((s,edge)=>side*(track.at(s).width/2+(edge===-1?0:.55)),.025,'#eee7d6');
    for(let s=0;s<track.length;s+=4){const p=track.at(s),off=side*(p.width/2+.275);box([.55,.025,1.9],[p.x+p.tz*off,.04,p.z-p.tx*off],'#ca6250',Math.atan2(p.tx,p.tz));}
  }
  // Visible start/finish, and staggered grid boxes facing the actual tangent.
  const start=track.at(0),heading=Math.atan2(start.tx,start.tz);
  for(let i=0;i<12;i++)for(let j=0;j<2;j++){const p=track.pose(j*.5,(i-5.5)*start.width/12);box([start.width/12,.025,.5],[p.x,.05,p.z],(i+j)%2?'#eae5d8':'#27363b',heading);}
  for(let id=0;id<3;id++){const g=track.grid(id);for(const side of [-1,1]){const p=g.p;box([.10,.02,4.6],[p.x+Math.cos(g.heading)*side*1.2,.045,p.z-Math.sin(g.heading)*side*1.2],'#dedcca',g.heading);}}
  for(const [i,b]of track.barriers.entries())box([.56,b.height,b.length],[b.x,b.height/2,b.z],i%2?'#e6e1cf':'#ce6d59',b.yaw);
  // Warning posts define the ONE exposed ridge without silently adding a wall.
  for(let s=0;s<track.length;s+=6)if(track.risk(s)){const p=track.at(s),off=-(p.width/2+1.45);box([.14,.85,.14],[p.x+p.tz*off,.425,p.z-p.tx*off],'#d1a749');}
  const geometry=mergeGeometries(parts)!;parts.forEach(p=>p.dispose());owned.push(geometry);root.add(new Mesh(geometry,material));
  const cache=new Map<string,BufferGeometry>();
  const kitGeometry=(name:string,color?:string)=>{
    const key=name+(color??'');if(cache.has(key))return cache.get(key)!;
    const source=kit.getObjectByName(name) as Mesh,g=source.geometry.clone();
    if(color){const a=g.getAttribute('color'),rgb=new Color(color);for(let i=0;i<a.count;i++){const r=a.getX(i),green=a.getY(i),b=a.getZ(i);if(r>green*1.7&&r>b*1.7)a.setXYZ(i,rgb.r*(.8+.2*r),rgb.g*(.8+.2*r),rgb.b*(.8+.2*r));}}
    cache.set(key,g);owned.push(g);return g;
  };
  const pose=new Group();
  const instances=(name:string,placements:{x:number;y?:number;z:number;yaw?:number;scale?:number}[])=>{const mesh=new InstancedMesh(kitGeometry(name),material,placements.length);placements.forEach((p,i)=>{pose.position.set(p.x,p.y??0,p.z);pose.rotation.set(0,p.yaw??0,0);pose.scale.setScalar(p.scale??1);pose.updateMatrix();mesh.setMatrixAt(i,pose.matrix);});mesh.computeBoundingSphere();root.add(mesh);};
  instances('Tree',track.trees);
  instances('Stand',[{x:-15,z:40,yaw:Math.PI/2,scale:1.7},{x:-15,z:67,yaw:Math.PI/2,scale:1.7}]);
  instances('Tent',[{x:-22,z:17,scale:1.3}]);
  instances('Flag',[-1,1].flatMap(side=>[0,30,100,160,260,360,440].map(s=>{const p=track.at(s),off=side*(p.width/2+5);return{x:p.x+p.tz*off,z:p.z-p.tx*off,scale:1.3};})));
  // Gantry deliberately high enough that every view sees the road underneath.
  const gantry=new Group();for(const side of [-1,1]){const p=new Mesh(new BoxGeometry(.35,6,.35),new MeshStandardMaterial({color:'#e4dec9'}));owned.push(p.geometry);materials.push(p.material);p.position.set(side*(start.width/2+1),3,0);gantry.add(p);}
  const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=160;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#344a43';ctx.fillRect(0,0,1024,160);ctx.fillStyle='#f0e5c9';ctx.textAlign='center';ctx.font='900 73px sans-serif';ctx.fillText('ARABA YARIŞI',512,102);
  const texture=new CanvasTexture(canvas);texture.colorSpace=SRGBColorSpace;const signMat=new MeshBasicMaterial({map:texture,side:DoubleSide});materials.push(signMat);const signGeo=new PlaneGeometry(start.width+2,1.9);owned.push(signGeo);const sign=new Mesh(signGeo,signMat);sign.position.y=5.7;sign.rotation.y=Math.PI;gantry.add(sign);gantry.position.set(start.x,0,start.z);gantry.rotation.y=heading;root.add(gantry);
  const cars=Array.from({length:count},(_,i)=>{const g=new Group(),mesh=new Mesh(kitGeometry('Car',COLORS[i]),material);mesh.position.y=-.64;g.add(mesh);root.add(g);return g;});
  const shadowGeo=new PlaneGeometry(2.4,4.1),shadowMat=new MeshBasicMaterial({color:'#26342c',transparent:true,opacity:.20,depthWrite:false});owned.push(shadowGeo);materials.push(shadowMat);
  const shadows=cars.map(()=>{const m=new Mesh(shadowGeo,shadowMat);m.rotation.x=-Math.PI/2;root.add(m);return m;});
  return {root,cars,update(g:RaceGame,alpha:number){g.cars.forEach((c,i)=>{const p=c.body.translation(),a=c.previous;cars[i].position.set(a.x+(p.x-a.x)*alpha,a.y+(p.y-a.y)*alpha,a.z+(p.z-a.z)*alpha);cars[i].rotation.y=c.previousHeading+angle(c.heading-c.previousHeading)*alpha;shadows[i].position.set(p.x,.07,p.z);shadows[i].rotation.z=-c.heading;shadows[i].visible=p.y>0&&p.y<2;});},dispose(){root.traverse(o=>{if(o instanceof InstancedMesh)o.dispose();});owned.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());texture.dispose();}};
}
