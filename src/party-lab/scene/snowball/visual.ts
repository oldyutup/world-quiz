import { BufferAttribute, BufferGeometry, CanvasTexture, CircleGeometry, ConeGeometry, CylinderGeometry, Group, IcosahedronGeometry, Mesh, MeshBasicMaterial, MeshStandardMaterial, Points, PointsMaterial, RingGeometry, Sprite, SpriteMaterial, SRGBColorSpace, TorusGeometry } from 'three';
import { SNOWBALL as C, SNOW_COLORS, SNOW_NAMES } from './config';

/** Original generated geometry only. No downloaded models, textures or audio. */
export function snowVisual(count: number, names: readonly string[] = SNOW_NAMES, self = 0) {
  const root = new Group(), platform = new Group(); root.add(platform);
  const ice = new MeshStandardMaterial({ color:'#7dbfd8', roughness:0.38, metalness:0.04, flatShading:true });
  const snow = new MeshStandardMaterial({ color:'#edf4ee', roughness:0.95, flatShading:true });
  const cliff = new MeshStandardMaterial({ color:'#6599b4', roughness:0.85, flatShading:true });
  const mesh = (geometry: ConstructorParameters<typeof Mesh>[0], material: ConstructorParameters<typeof Mesh>[1], parent = root) => {
    const m = new Mesh(geometry, material); parent.add(m); return m;
  };
  const top = mesh(new CylinderGeometry(1,1,1.3,96), ice, platform); top.position.y=-0.65;
  const lower = mesh(new CylinderGeometry(0.99,0.72,3,32),cliff,platform);lower.position.y=-2.8;
  const edge = mesh(new RingGeometry(0.972,1,96),snow,platform);edge.rotation.x=-Math.PI/2;edge.position.y=0.008;
  const center = mesh(new RingGeometry(1.9,1.94,48),new MeshBasicMaterial({color:'#c8e4e9'}));center.rotation.x=-Math.PI/2;center.position.y=0.012;
  // Sparse, distant snowy peaks below the playing surface leave the edge clear.
  for(let i=0;i<14;i++) {
    const angle=i*2.39996, distance=40+(i%3)*13, h=12+(i%5)*2;
    const mountain = mesh(new ConeGeometry(12+i%4,h,5),cliff);
    mountain.position.set(Math.sin(angle)*distance,-24+h/2,Math.cos(angle)*distance); mountain.rotation.y=angle;mountain.scale.x=1.4;
    const cap=mesh(new ConeGeometry((12+i%4)*0.54,h*0.54,5),snow);
    cap.position.copy(mountain.position);cap.position.y+=h*0.23+0.12;cap.rotation.y=angle;cap.scale.x=1.4;
  }
  const balls: Group[] = [], markers: Group[] = [];
  const labels: Sprite[] = [];
  for(let i=0;i<count;i++) {
    const ball=new Group();root.add(ball);balls.push(ball);
    mesh(new IcosahedronGeometry(C.radius,2),snow,ball);
    const bandMaterial=new MeshStandardMaterial({color:SNOW_COLORS[i],roughness:0.85,flatShading:true});
    const band=mesh(new TorusGeometry(C.radius*0.97,0.085,5,32),bandMaterial,ball);band.rotation.x=Math.PI/2;
    const patch=mesh(new IcosahedronGeometry(0.25,0),bandMaterial,ball);patch.position.set(0.52,0.5,0.6);patch.scale.z=0.35;
    const marker=new Group();root.add(marker);markers.push(marker);
    const shadow=mesh(new CircleGeometry(1.03,32),new MeshBasicMaterial({color:'#315d72',transparent:true,opacity:0.18,depthWrite:false}),marker);shadow.rotation.x=-Math.PI/2;
    if(i===self) {
      const ring=mesh(new RingGeometry(1.1,1.18,48),new MeshBasicMaterial({color:SNOW_COLORS[i]}),marker);ring.rotation.x=-Math.PI/2;
      const arrow=mesh(new ConeGeometry(0.24,0.58,3),bandMaterial,marker);arrow.rotation.x=-Math.PI/2;arrow.position.set(0,0.03,-1.55);
    }
    const canvas=document.createElement('canvas');canvas.width=256;canvas.height=64;
    const ctx=canvas.getContext('2d')!;
    ctx.fillStyle='#243c50';ctx.beginPath();ctx.roundRect(12,4,232,54,20);ctx.fill();
    ctx.fillStyle='#edf4ee';ctx.font='bold 27px system-ui';ctx.textAlign='center';ctx.fillText(`${i+1} · ${names[i]}`,128,40);
    const texture=new CanvasTexture(canvas);texture.colorSpace=SRGBColorSpace;
    const label=new Sprite(new SpriteMaterial({map:texture,depthTest:false,depthWrite:false,fog:false,toneMapped:false}));label.scale.set(2.6,0.65,1);root.add(label);labels.push(label);
  }
  const positions=new Float32Array(48*3), life=new Float32Array(48), velocity=new Float32Array(48*3);
  const geometry=new BufferGeometry();geometry.setAttribute('position',new BufferAttribute(positions,3));
  const puffs=new Points(geometry,new PointsMaterial({color:'#edf4ee',size:0.16,transparent:true,opacity:0.8,depthWrite:false}));puffs.frustumCulled=false;root.add(puffs);
  positions.fill(-1000);let cursor=0;
  return {root,platform,balls,markers,labels,edge,center,
    burst(p:{x:number;y:number;z:number}) {for(let k=0;k<10;k++) {const i=cursor++%48,a=k*2.39996;life[i]=0.5;positions.set([p.x,p.y,p.z],i*3);velocity.set([Math.sin(a)*2,1.5+(k%3),Math.cos(a)*2],i*3);}},
    update(dt:number) {for(let i=0;i<48;i++){if(life[i]>0){life[i]-=dt;velocity[i*3+1]-=6*dt;for(let j=0;j<3;j++)positions[i*3+j]+=velocity[i*3+j]*dt;}else positions[i*3+1]=-1000;}geometry.attributes.position.needsUpdate=true;},
    dispose() {const geometries=new Set<BufferGeometry>(),materials=new Set<MeshStandardMaterial|MeshBasicMaterial|SpriteMaterial|PointsMaterial>();root.traverse(o=>{if(o instanceof Mesh||o instanceof Sprite||o instanceof Points){if('geometry' in o)geometries.add(o.geometry);(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>materials.add(m));}});geometries.forEach(g=>g.dispose());materials.forEach(m=>{m.map?.dispose();m.dispose();});},
  };
}
