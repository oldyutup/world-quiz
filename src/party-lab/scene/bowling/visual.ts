import { CanvasTexture, PlaneGeometry, MeshBasicMaterial, DoubleSide, SRGBColorSpace, BoxGeometry, BufferGeometry, Color, Float32BufferAttribute, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOWLING, COURSE, CAR, courseBoxes, landingHalfWidth, roadHulls, wallHulls, obstacleZ, courseObstacles, roadHeight } from './config';

import { stuntVisual } from './stuntVisual';
import { BOWLING_PALETTE as palette, bowlingKitGeometry } from './palette';

/** One merged static mesh, shared kit geometry; no imported collision geometry. */
export function bowlingVisual(kit: Group, seed = 7281) {
  const obstacles=courseObstacles(seed);
  const root = new Group(), parts: BufferGeometry[] = [], owned: BufferGeometry[] = [];
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  const box = (size: [number, number, number], at: [number, number, number], color: string, pitch=0) => {
    const g = new BoxGeometry(...size).rotateX(pitch).translate(...at), rgb = new Color(color), c = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < c.length; i += 3) rgb.toArray(c, i);
    g.setAttribute('color', new Float32BufferAttribute(c, 3)); g.deleteAttribute('uv'); parts.push(g.toNonIndexed()); g.dispose();
  };
  // Quiet pale ground complements the stone and coral scenery; the existing two
  // surfaces provide subtle tone variation without extra geometry or textures.
  for (const c of courseBoxes().filter(c=>!c.carOnly)) {
    const floor=c.name==='floor'||c.name.startsWith('rack-wing-');
    box(c.half.map(x=>x*2) as [number,number,number],floor?[c.at[0],-.23,c.at[2]]:c.at,floor?palette.ground:palette.wall);
  }
  const hull=(points:Float32Array,color:string)=>{
    const g=new ConvexGeometry(Array.from({length:points.length/3},(_,i)=>new Vector3(points[i*3],points[i*3+1],points[i*3+2])));
    g.deleteAttribute('uv');const rgb=new Color(color),colors=new Float32Array(g.attributes.position.count*3);
    for(let i=0;i<colors.length;i+=3)rgb.toArray(colors,i);
    g.setAttribute('color',new Float32BufferAttribute(colors,3));parts.push(g);
  };
  // Steel trestles make the height and the downhill silhouette legible from
  // the descent. Merged static scenery, outside the playable road.
  for(const z of Array.from({length:5},(_,i)=>BOWLING.hillStart-9+i*(BOWLING.hillEnd-BOWLING.hillStart-3)/4))for(const side of [-1,1]){
    const h=roadHeight(z);
    box([.45,h,.55],[side*6.95,h/2,z],palette.steel);
    box([1.4,.3,1.4],[side*6.95,.15,z],palette.stone);
  }
  // Four ball groups have flush stage markings; the launch approach stays clear.
  for(const z of [-84,-56,-28,-10].map(obstacleZ)){
    box([11,.014,.18],[0,.024,z],palette.amber);
    for(const x of [-5.3,5.3])box([.5,.018,2],[x,.026,z+1],palette.amber);
  }
  // Landing distance stripes, flush with the slate-toned lane. They also reveal forward speed.
  for(let z=BOWLING.rampLip+20;z<BOWLING.headZ;z+=20) {
    box([10,.012,.18],[0,.019,z],palette.stone);
    for(const x of [-4.5,4.5])box([.8,.016,2],[x,.022,z],palette.chalk);
  }
  // Stunt stadium: tiered enclosing seats, aisle breaks and floodlight masts.
  // All static, merged geometry; no spectator bodies or off-road colliders.
  for(const side of [-1,1])for(let z=COURSE.obstacleStart+26;z<BOWLING.maxZ+1;z+=24){
    for(let tier=0;tier<5;tier++){
      box([2.8,.8,20],[side*(23+tier*2.5),1+tier*1.25,z],tier%2?palette.wall:palette.stone);
      box([.35,1.3,20],[side*(24+tier*2.5),1.5+tier*1.25,z],palette.chalk);
      for(let row=0;row<2;row++)for(let seat=0;seat<12;seat++)
        box([.6,.4,.65],[side*(22.5+tier*2.5+row*.9),1.65+tier*1.25,z-8.8+seat*1.55],[palette.seat,palette.seatAlternate][tier%2]);
    }
    if(z%48===-4 || z===-100){
      box([.5,17,.5],[side*20,8.5,z],palette.steel);
      box([4,1,.6],[side*20,17,z],palette.chalk);
    }
    box([.18,2.4,22],[side*17,1.2,z],palette.wall);
  }
  // High structures at the start, then a side corridor. The road crest hides
  // the lower hazards while the stadium silhouette stays legible.
  for(const side of [-1,1]){
    for(const z of [BOWLING.hillStart-21,BOWLING.hillStart]){
      box([.5,8,.5],[side*7,BOWLING.startHeight+4,z],palette.steel);
      box([3,.35,15],[side*8.5,BOWLING.startHeight+3,z+6],palette.wall);
      box([.35,8,.35],[side*10,BOWLING.startHeight+4,z],palette.steel);
    }
    for(let z=BOWLING.hillStart+15;z<BOWLING.hillEnd-3;z+=4){
      const h=roadHeight(z);
      box([.55,h+4,4],[side*7.3,(h+4)/2,z],palette.wall);
      box([.18,3.8,.22],[side*6.8,h+1.9,z],palette.stone);
    }
  }
  // Decorative backdrop only: frame the rack without moving any physical surface,
  // pin body or course bound. The unchanged runout continues behind this scenery.
  const backdropZ = COURSE.backdropZ;
  box([17,7,1],[0,3.5,backdropZ],palette.steel);
  box([10,.25,1],[0,7.1,backdropZ-.2],palette.amber);
  for(const x of [-8,8]){box([.4,8,.4],[x,4,backdropZ-1],palette.steel);box([2,.4,.7],[x,8,backdropZ-1],palette.chalk);}
  roadHulls().forEach(h=>hull(h,h[2]>=BOWLING.rampStart?palette.ramp:palette.asphalt));
  wallHulls().forEach(h=>hull(h,palette.stone));
  for(let i=0;i<10;i++)box([BOWLING.laneWidth/10-.003,.008,BOWLING.laneLength-1],[(i-4.5)*BOWLING.laneWidth/10,.004,(BOWLING.rampLip+BOWLING.maxZ-1)/2],i%2?palette.lane:palette.laneAlternate);
  box([COURSE.deck.maxX-COURSE.deck.minX,.018,COURSE.deck.maxZ-COURSE.deck.minZ],[0,.01,(COURSE.deck.minZ+COURSE.deck.maxZ)/2],palette.asphalt);
  box([10,.012,7],[0,.006,BOWLING.maxZ-4.5],palette.lane);
  // Fine markings follow the hill tangent; none float above the steeper road.
  const roadPitch=(z:number)=>-Math.atan((roadHeight(z+.1)-roadHeight(z-.1))/.2);
  for(let z=BOWLING.minZ+2;z<BOWLING.rampLip;z+=1)for(const x of [-BOWLING.roadWidth/2+.4,BOWLING.roadWidth/2-.4])box([.12,.02,.9],[x,roadHeight(z)+.025,z],palette.chalk,roadPitch(z));
  for(let z=BOWLING.startZ+1;z<BOWLING.rampStart;z+=3)box([.1,.02,1],[0,roadHeight(z)+.025,z],palette.stone,roadPitch(z));
  for(let i=0;i<12;i++)for(let j=0;j<2;j++)box([1,.02,.5],[-5.5+i,BOWLING.startHeight+.025,BOWLING.startZ+2+j*.5],(i+j)%2?palette.chalk:palette.steel);
  for(let z=BOWLING.prepStart;z<BOWLING.rampStart;z+=2)for(const x of [-5.3,5.3])box([.6,.02,.5],[x,.025,z],palette.amber);
  box([12,.02,.2],[0,.025,BOWLING.prepStart],palette.amber);box([12,.02,.2],[0,BOWLING.rampHeight+.02,BOWLING.rampLip],palette.chalk);
  box([14,.9,.8],[0,.45,CAR.catcherZ],palette.barrier);
  for(const x of [-7,7])box([.3,6,.3],[x,3,CAR.catcherZ],palette.steel);
  for(const y of [2,4,6])box([14,.06,.06],[0,y,CAR.catcherZ],palette.wall);
  box([180,.15,BOWLING.length+55],[0,-.4,(BOWLING.minZ+BOWLING.maxZ)/2],palette.groundEdge);
  const geometry = mergeGeometries(parts)!; parts.forEach(g => g.dispose()); owned.push(geometry); root.add(new Mesh(geometry, material));
  const matrix = new Matrix4();
  const kitGeometries = new Map<string, BufferGeometry>();
  const kitGeometry = (name: string) => {
    const source = kit.getObjectByName(name) as Mesh;
    if (!source?.isMesh) throw new Error(`Bowling kit missing ${name}`);
    let geometry = kitGeometries.get(name);
    if (!geometry) {
      geometry = bowlingKitGeometry(source.geometry, name);
      kitGeometries.set(name, geometry); owned.push(geometry);
    }
    return geometry;
  };
  const instances = (name: string, placements: { at: [number, number, number]; yaw?: number; pitch?: number; scale?: [number, number, number] }[]) => {
    const mesh = new InstancedMesh(kitGeometry(name), material, placements.length);
    const pose = new Group();
    placements.forEach((p, i) => { pose.position.set(...p.at); pose.rotation.set(p.pitch ?? 0, p.yaw ?? 0, 0); pose.scale.set(...(p.scale ?? [1, 1, 1])); pose.updateMatrix(); matrix.copy(pose.matrix); mesh.setMatrixAt(i, matrix); });
    mesh.computeBoundingSphere(); root.add(mesh); return mesh;
  };
  for(const [index,name] of ['BarrierRed','BarrierWhite'].entries()) instances(name,[-1,1].flatMap(side=>Array.from({length:Math.floor((BOWLING.length-4)/3)},(_,i)=>{const z=BOWLING.minZ+3+i*3+index*1.5;return {at:[side*(z<BOWLING.rampLip?BOWLING.roadWidth/2+.6:landingHalfWidth(z)+.6),roadHeight(Math.min(z,BOWLING.rampLip)),z] as [number,number,number],yaw:Math.PI/2,pitch:z<BOWLING.rampLip?roadPitch(z):0};})));
  instances('Stand',[-1,1].flatMap(side=>[...[-84,-56,-28].map(obstacleZ),BOWLING.prepStart+6,...Array.from({length:8},(_,i)=>BOWLING.rampLip+19+i*(BOWLING.laneLength-23)/7)].map(z=>({at:[side*19,0,z] as [number,number,number],yaw:-side*Math.PI/2}))));
  instances('Flag',[-1,1].flatMap(side=>[obstacleZ(-84),obstacleZ(-28),BOWLING.prepStart,...Array.from({length:7},(_,i)=>BOWLING.rampLip+i*(BOWLING.laneLength-11)/6)].map(z=>({at:[side*(z<BOWLING.rampLip?BOWLING.roadWidth/2+1:landingHalfWidth(z)+1),roadHeight(z),z] as [number,number,number],scale:[1.8,1,1] as [number,number,number]}))));
  instances('Gantry',[{at:[0,BOWLING.startHeight,BOWLING.startZ+3],scale:[2,1,1]}]);
  instances('Sign',[{at:[-9,0,6],scale:[3,2.5,1]},{at:[9,0,6],scale:[3,2.5,1]}]);
  instances('Arrow',[BOWLING.hillStart+15,BOWLING.hillStart+45,BOWLING.hillEnd-12,BOWLING.hillEnd+16.5,BOWLING.rampStart-5,BOWLING.rampStart-2].map(z=>({at:[0,roadHeight(z)+.03,z] as [number,number,number],yaw:Math.PI/2,pitch:roadPitch(z)})));
  instances('Pad',Array.from({length:10},(_,i)=>({at:[(i-4.5)*landingHalfWidth(BOWLING.maxZ)/5,0,BOWLING.maxZ-1.5] as [number,number,number],scale:[.95*landingHalfWidth(BOWLING.maxZ)/5,1.8,.9] as [number,number,number]})));
  instances('Tree',[-1,1].flatMap(side=>Array.from({length:24},(_,i)=>({at:[side*(43+i%3*4),0,-85+i*10] as [number,number,number],scale:[1+i%2*.4,1+i%2*.4,1+i%2*.4] as [number,number,number]}))));
  instances('Tent',[{at:[-11,0,26],yaw:Math.PI/2},{at:[11,0,26],yaw:-Math.PI/2}]);
  const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=256;
  const ctx=canvas.getContext('2d')!;ctx.fillStyle=palette.steel;ctx.fillRect(0,0,1024,256);
  ctx.textAlign='center';ctx.fillStyle=palette.amber;ctx.font='900 80px sans-serif';ctx.fillText('HUMAN BOWLING',512,115);
  ctx.fillStyle=palette.chalk;ctx.font='bold 32px sans-serif';ctx.fillText('PARTY LAB     /     STUNT SHOW',512,188);
  const signTexture=new CanvasTexture(canvas);signTexture.colorSpace=SRGBColorSpace;
  const signMaterial=new MeshBasicMaterial({map:signTexture,side:DoubleSide});
  const signGeometry=new PlaneGeometry(5.8,1.45);owned.push(signGeometry);
  for(const [x,y,z] of [[0,BOWLING.startHeight+4.73,BOWLING.startZ+3],[-15,3,BOWLING.headZ-61],[15,3,BOWLING.headZ-61]]){const sign=new Mesh(signGeometry,signMaterial);sign.position.set(x,y,z-.18);sign.rotation.y=Math.PI;root.add(sign);}
  const prepCanvas=document.createElement('canvas');prepCanvas.width=1024;prepCanvas.height=256;
  const prep=prepCanvas.getContext('2d')!;prep.fillStyle=palette.steel;prep.fillRect(0,0,1024,256);prep.fillStyle=palette.amber;prep.textAlign='center';prep.font='900 67px sans-serif';prep.fillText('FIRLATMA BÖLGESİ',512,110);prep.font='bold 34px sans-serif';prep.fillText('SPACE TUT  ·  AÇI SEÇ  ·  BIRAK',512,187);
  const prepTexture=new CanvasTexture(prepCanvas);prepTexture.colorSpace=SRGBColorSpace;const prepMaterial=new MeshBasicMaterial({map:prepTexture,side:DoubleSide});
  for(const x of [-9,9]){const sign=new Mesh(signGeometry,prepMaterial);sign.position.set(x,2,5.8);sign.rotation.y=Math.PI;root.add(sign);}
  // Preserve the original car shadow independently of the outer terrain palette.
  const shadowGeometry=new PlaneGeometry(2.6,4.5),shadowMaterial=new MeshBasicMaterial({color:'#8b9780',transparent:true,opacity:.18,depthWrite:false});owned.push(shadowGeometry);
  const shadow=new Mesh(shadowGeometry,shadowMaterial);shadow.rotation.x=-Math.PI/2;root.add(shadow);
  const car=new Group(),carMesh=new Mesh(kitGeometry('Car'),material);carMesh.position.y=-.64;car.add(carMesh);root.add(car);
  instances('Car',[{at:[-12,0,20],yaw:.45},{at:[12,0,22],yaw:-.4}]);
  instances('ServiceCar',[-1,1].flatMap(side=>[-58,-50,-42].map(z=>({at:[side*13,0,z] as [number,number,number],yaw:side*Math.PI/2}))));
  const pins = instances('Pin', Array.from({ length: 10 }, () => ({ at: [0, 0, 0] })));
  pins.frustumCulled = false; pins.instanceMatrix.setUsage(35048);
  const stunts=stuntVisual(kit,material,obstacles);root.add(stunts.root);
  return { root, pins, car, shadow, stunts, dispose() {
    stunts.dispose();
    root.traverse(node => { if (node instanceof InstancedMesh) node.dispose(); });
    owned.forEach(g => g.dispose());
    material.dispose();prepTexture.dispose();prepMaterial.dispose();signTexture.dispose();signMaterial.dispose();shadowMaterial.dispose();
  } };
}
