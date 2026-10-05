import { BoxGeometry, BufferGeometry, CanvasTexture, CircleGeometry, Color, ConeGeometry, CylinderGeometry, DynamicDrawUsage, Float32BufferAttribute, Group, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, Quaternion, RingGeometry, SphereGeometry, Sprite, SpriteMaterial, SRGBColorSpace, Vector3 } from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { COLORS, FIGHT as C, NAMES, clamp, type Vec } from './config';
import { MAP } from './map';
import type { SnowFightGame } from './game';

const P={snow:'#eaf3f2',shade:'#bfd9dd',ice:'#94bfc6',wood:'#aa7053',darkWood:'#765044',green:'#70968b',pine:'#538479',cream:'#f3d4a0',ink:'#344b53'};
function painted(g:BufferGeometry,color:string){const c=new Color(color),n=g.attributes.position.count,a=new Float32Array(n*3);for(let i=0;i<n;i++)c.toArray(a,i*3);g.setAttribute('color',new Float32BufferAttribute(a,3));return g;}
function merge(gs:BufferGeometry[]){const pieces=gs.map(g=>{const n=g.index?g.toNonIndexed():g;n.deleteAttribute('uv');if(n!==g)g.dispose();return n;});const g=mergeGeometries(pieces)!;pieces.forEach(p=>p.dispose());g.computeBoundingSphere();return g;}
const box=(s:number[],p:number[],c:string,rounded=0)=>painted((rounded?new RoundedBoxGeometry(s[0],s[1],s[2],2,rounded):new BoxGeometry(s[0],s[1],s[2])).translate(p[0],p[1],p[2]),c);
const oval=(s:number[],p:number[],c:string)=>painted(new SphereGeometry(1,10,7).scale(s[0],s[1],s[2]).translate(p[0],p[1],p[2]),c);
function tag(text:string,color:string){const canvas=document.createElement('canvas');canvas.width=256;canvas.height=64;const c=canvas.getContext('2d')!;c.fillStyle=P.ink;c.beginPath();c.roundRect(3,4,250,55,22);c.fill();c.fillStyle=color;c.font='700 26px system-ui';c.textAlign='center';c.fillText(text,128,41);const map=new CanvasTexture(canvas);map.colorSpace=SRGBColorSpace;return new Sprite(new SpriteMaterial({map,depthWrite:false,toneMapped:false}));}

/** Original low-poly geometry, merged scenery + shared meshes + 96 pooled snow puffs. */
export function fightVisual(count:number,names=NAMES){
  const root=new Group(),material=new MeshStandardMaterial({vertexColors:true,roughness:1,flatShading:true});
  const pieces:BufferGeometry[]=[];
  const add=(s:number[],p:number[],c:string,r=0)=>pieces.push(box(s,p,c,r));
  add([90,.7,90],[0,-.39,0],P.snow);
  // Cool soft patches give the snow depth and motion reference, all remain gatherable.
  for(let i=0;i<36;i++){const x=Math.sin(i*7.8)*13,z=Math.cos(i*4.1)*13;pieces.push(oval([.4+(i%4)*.24,.014,.3+(i%3)*.17],[x,.01,z],i%2? '#dcebec':'#e3eeef'));}
  for(const s of MAP){const {p,half:h}=s;
    if(s.kind==='boundary')continue;
    if(s.kind==='tree'){
      if(s.id.startsWith('crown')){pieces.push(oval([1.28,1.4,1.28],[p.x,p.y,p.z],P.green),oval([1.23,.9,1.23],[p.x,p.y+.65,p.z],P.snow));}
      else {pieces.push(painted(new CylinderGeometry(.23,.35,2.4,7).translate(p.x,1.2,p.z),P.darkWood));}
    }else if(s.kind==='bank'){
      add([h.x*2,h.y*2,h.z*2],[p.x,p.y,p.z],P.shade,.15);
      add([h.x*2+.02,.22,h.z*2+.02],[p.x,p.y+h.y-.10,p.z],P.snow,.10);
    }else if(s.kind==='hut'){
      const warm=s.id.includes('west');
      add([4,2.7,4],[p.x,1.35,p.z],warm?'#bb8060':'#7c9b99',.08);
      for(let y=.4;y<2.6;y+=.34){add([4.01,.024,4.01],[p.x,y,p.z],warm?'#a96d52':'#668d8a');}
      // Snowy gable is original triangular geometry, bounded by the hut collider.
      const roof=new ConeGeometry(3.14,1.10,4).rotateY(Math.PI/4).scale(1,1,1).translate(p.x,3.15,p.z);pieces.push(painted(roof,P.snow));
      const front=warm?-1:1,z=p.z+front*2.025;
      add([.9,1.9,.07],[p.x-.9,.95,z],P.darkWood,.04);add([.10,.10,.08],[p.x-.6,1,z+front*.06],P.cream);
      add([1.25,1.1,.09],[p.x+.9,1.6,z],P.darkWood,.03);add([1.03,.86,.12],[p.x+.9,1.6,z+front*.04],P.cream,.02);
      add([.055,.96,.14],[p.x+.9,1.6,z+front*.07],P.wood);add([1.15,.055,.14],[p.x+.9,1.6,z+front*.07],P.wood);
      add([.55,.8,.6],[p.x+1.1,3.5,p.z+.7],P.darkWood,.025);add([.7,.14,.72],[p.x+1.1,3.94,p.z+.7],P.snow,.05);
    }else if(s.kind==='porch'){
      add([h.x*2,h.y*2,h.z*2],[p.x,p.y,p.z],P.wood,.025);
      for(let x=p.x-h.x+.2;x<p.x+h.x;x+=.35)add([.016,.014,h.z*2],[x,p.y+h.y+.004,p.z],P.darkWood);
    }else if(s.kind==='rock'){
      // Rounded block silhouette closely matches its solid, snowy cap is decorative.
      add([h.x*2,h.y*2,h.z*2],[p.x,p.y,p.z],'#9fadb3',.28);
      add([h.x*2+.02,.2,h.z*2+.02],[p.x,p.y+h.y-.07,p.z],P.snow,.08);
    }else if(s.kind==='fence'){
      add([h.x*2,h.y*2,h.z*2],[p.x,p.y,p.z],P.wood,.015);
      for(let z=p.z-h.z;z<p.z+h.z;z+=.36)add([h.x*2+.05,h.y*2+.04,.025],[p.x,p.y,z],P.darkWood);
      add([.4,.16,h.z*2+.14],[p.x,2.1,p.z],P.snow,.06);
    }
  }
  // Continuous boundary snow wall, with distant firs and rolling snow outside it.
  for(const sign of [-1,1]){add([.65,2.2,28.7],[sign*14.3,1.1,0],P.shade,.2);add([28,.0+2.2,.65],[0,1.1,sign*14.3],P.shade,.2);add([.72,.20,28.7],[sign*14.3,2.14,0],P.snow,.08);add([28,.20,.72],[0,2.14,sign*14.3],P.snow,.08);}
  for(let i=0;i<32;i++){
    const a=i*Math.PI/16,r=19+(i%3)*2,x=Math.sin(a)*r,z=Math.cos(a)*r,h=3+i%4;
    pieces.push(painted(new CylinderGeometry(.17,.3,h*.7,6).translate(x,h*.35,z),P.darkWood));
    for(let j=0;j<3;j++){const y=h*.35+j*h*.22,rr=1.8-j*.37;pieces.push(painted(new ConeGeometry(rr,h*.60,7).translate(x,y,z),j%2?P.snow:P.pine));}
  }
  for(let i=0;i<9;i++)pieces.push(oval([9,3+i%3,6],[Math.sin(i*2.4)*34,0,Math.cos(i*2.4)*34],i%2?P.shade:P.snow));
  // Park sign and cozy snowman: landmarks outside combat lanes.
  add([.16,2.1,.16],[-.9,1.05,-15.5],P.darkWood);add([2.2,.8,.15],[-.9,1.9,-15.5],P.wood,.04);
  const sign=tag('KAR PARKI',P.cream);sign.position.set(-.9,1.9,-15.38);sign.scale.set(2,.5,1);root.add(sign);
  pieces.push(oval([.6,.64,.6],[11.8,.64,11.8],P.snow),oval([.43,.43,.43],[11.8,1.57,11.8],P.snow));
  add([.48,.14,.5],[11.8,1.96,11.8],P.ink,.03);add([.34,.32,.35],[11.8,2.1,11.8],P.ink,.025);
  pieces.push(oval([.08,.06,.24],[11.8,1.58,12.18],COLORS[0]));
  root.add(new Mesh(merge(pieces),material));

  const snowMat=new MeshStandardMaterial({color:P.snow,roughness:.85,flatShading:true}),snowGeometry=new IcosahedronGeometry(1,1);
  const darkMat=new MeshBasicMaterial({color:P.ink,transparent:true,opacity:.14,depthWrite:false});
  const people=Array.from({length:count},(_,i)=>{
    const group=new Group(),skinMat=new MeshStandardMaterial({vertexColors:true,roughness:1,flatShading:true,transparent:true});root.add(group);
    const torso=new Mesh(merge([oval([.34,.38,.24],[0,0,0],COLORS[i]),oval([.29,.18,.23],[0,-.34,0],P.ink),box([.5,.07,.51],[0,.20,0],P.cream,.03),box([.10,.40,.08],[.15,.05,.25],P.cream,.025),oval([.045,.045,.04],[0,-.06,.24],P.ink)]),skinMat);group.add(torso);
    const head=new Mesh(merge([oval([.28,.29,.27],[0,0,0],'#f4d1ac'),oval([.295,.18,.285],[0,.23,0],COLORS[i]),box([.56,.1,.52],[0,.15,0],P.cream,.05),oval([.095,.095,.095],[0,.41,0],P.cream),oval([.028,.044,.03],[-.085,-.01,.256],P.ink),oval([.028,.044,.03],[.085,-.01,.256],P.ink),oval([.04,.032,.045],[0,-.085,.276],'#d9a585')]),skinMat);group.add(head);
    const arms=[-1,1].map(side=>{const arm=new Mesh(merge([oval([.13,.26,.13],[0,-.12,0],COLORS[i]),oval([.135,.13,.14],[0,-.36,0],P.cream)]),skinMat);arm.position.x=side*.34;group.add(arm);return arm;});
    const legs=[-1,1].map(side=>{const leg=new Mesh(merge([box([.22,.39,.23],[0,-.13,0],P.ink,.06),box([.25,.17,.37],[0,-.37,.05],'#78625b',.06)]),skinMat);leg.position.x=side*.16;group.add(leg);return leg;});
    const held=new Mesh(snowGeometry,snowMat);held.scale.setScalar(C.ballRadius);group.add(held);
    const splat=new Mesh(snowGeometry,snowMat);splat.scale.set(.23,.20,.04);group.add(splat);
    const label=tag(`${i+1} · ${names[i]}`,COLORS[i]);label.scale.set(1.35,.34,1);root.add(label);
    const shadow=new Mesh(new CircleGeometry(.46,20),darkMat);shadow.rotation.x=-Math.PI/2;root.add(shadow);
    const ring=new Mesh(new RingGeometry(.43,.48,32),new MeshBasicMaterial({color:P.cream,transparent:true,opacity:.85,side:2,depthWrite:false}));ring.rotation.x=-Math.PI/2;root.add(ring);
    return {group,torso,head,arms,legs,held,splat,label,shadow,ring,skinMat,stance:0};
  });
  const projectiles=new InstancedMesh(snowGeometry,snowMat,C.ballCap),puffs=new InstancedMesh(snowGeometry,snowMat,96);
  for(const m of [projectiles,puffs]){m.instanceMatrix.setUsage(DynamicDrawUsage);m.frustumCulled=false;m.count=0;root.add(m);}
  const pool=Array.from({length:96},()=>({p:{x:0,y:-100,z:0},v:{x:0,y:0,z:0},life:0}));let cursor=0;
  const matrix=new Matrix4(),v3=new Vector3(),q=new Quaternion(),scale=new Vector3();
  return {root,
    burst(at:Vec,big=false){for(let j=0;j<(big?16:8);j++){const n=cursor++%pool.length,a=n*2.399,p=pool[n];p.life=.34+(n%4)*.055;p.p={...at};p.v={x:Math.sin(a)*(big?2.5:1.5),y:.6+(j%4)*.42,z:Math.cos(a)*(big?2.5:1.5)};}},
    update(g:SnowFightGame,dt:number,alpha:number,boom:number,self=0){
      people.forEach((visual,i)=>{
        const p=g.players[i],at=p.body.translation(),vel=p.body.linvel(),v=visual;
        v.group.visible=v.label.visible=v.shadow.visible=v.ring.visible=p.hp>0;if(p.hp<=0)return;
        v.group.position.set(p.previous.x+(at.x-p.previous.x)*alpha,p.previous.y+(at.y-p.previous.y)*alpha,p.previous.z+(at.z-p.previous.z)*alpha);v.group.rotation.set(0,p.yaw,0);
        v.stance+=((p.crouch?1:0)-v.stance)*(1-Math.exp(-dt/.06));const c=v.stance,gather=p.gather>0;
        const flinch=Math.max(0,p.flinch-g.time)/C.flinch;
        v.group.rotation.x=-flinch*.16;
        v.torso.position.y=1.00-c*.48;v.torso.scale.y=1-c*.20;v.torso.rotation.x=gather?-.22:0;
        v.head.position.y=1.46-c*.76;v.head.scale.setScalar(1-c*.13);
        const gait=Math.sin(g.time*11)*Math.min(.6,Math.hypot(vel.x,vel.z)*.09)*Number(p.grounded);
        v.legs.forEach((leg,j)=>{leg.position.y=.48-c*.15;leg.scale.y=1-c*.55;leg.rotation.x=c*.6+(j?gait:-gait)*(1-c*.3);});
        v.arms.forEach((arm,j)=>{arm.position.y=1.17-c*.48;arm.rotation.x=gather?-.95: j===0?-.9-Math.max(0,p.throwAt-g.time)/C.throwInterval*1.0:gait*.6;arm.rotation.z=gather?(j===0?.6:-.6):0;});
        v.held.position.set(-.34,1.32-c*.59,.40);v.held.visible=p.ammo>0&&!gather;
        v.splat.position.set(0,.98-c*.48,.25);v.splat.visible=g.time-p.lastHit<.8;
        v.label.position.set(at.x,at.y+(p.crouch?1.4:2.18),at.z);v.label.visible=i!==self&&p.hp>0;
        v.shadow.position.set(at.x,g.floor(at)+.018,at.z);v.shadow.visible=p.grounded;
        v.ring.position.set(at.x,at.y+.025,at.z);v.ring.visible=p.protection>g.time;
        v.skinMat.opacity=i===self?clamp((boom-.35)/.9,.12,1):1;v.skinMat.depthWrite=v.skinMat.opacity>.95;
      });
      g.balls.forEach((b,i)=>{v3.set(b.previous.x+(b.p.x-b.previous.x)*alpha,b.previous.y+(b.p.y-b.previous.y)*alpha,b.previous.z+(b.p.z-b.previous.z)*alpha);scale.setScalar(C.ballRadius);matrix.compose(v3,q,scale);projectiles.setMatrixAt(i,matrix);});projectiles.count=g.balls.length;projectiles.instanceMatrix.needsUpdate=true;
      let n=0;for(const p of pool){p.life-=dt;if(p.life<=0)continue;p.v.y-=dt*3;for(const k of ['x','y','z']as const)p.p[k]+=p.v[k]*dt;v3.set(p.p.x,p.p.y,p.p.z);scale.setScalar(Math.min(.10,p.life*.3));matrix.compose(v3,q,scale);puffs.setMatrixAt(n++,matrix);}puffs.count=n;puffs.instanceMatrix.needsUpdate=true;
    },
    dispose(){const gs=new Set<BufferGeometry>(),ms=new Set<MeshStandardMaterial|MeshBasicMaterial|SpriteMaterial>();root.traverse(o=>{if(o instanceof Mesh||o instanceof Sprite){if('geometry'in o)gs.add(o.geometry);(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>ms.add(m));}});gs.forEach(g=>g.dispose());ms.forEach(m=>{m.map?.dispose();m.dispose();});projectiles.dispose();puffs.dispose();},
  };
}
