import { clamp, type Vec } from './config';
import { ShapeUtils, Vector2 } from 'three';

export interface RoutePoint extends Vec { s: number; tx: number; tz: number; width: number; curve: number }
export interface Barrier { x: number; z: number; yaw: number; length: number; height: number }
export interface Projection { s: number; lateral: number; distance: number; point: RoutePoint }
/** Five tangent-continuous corner events, separated by real zero-curvature straights.
 * Heading is clockwise from +z. The only slower corner is the final park bend. */
const VERTICES = [[0,-45],[0,135],[125,135],[150,-5],[65,-75]];
const RADII = [18,38,32,32,30];
export interface TrackSection { name:string; start:number; length:number; radius:number; turn:number }
function circuit(scale:number) {
  const corners=VERTICES.map((p,i)=>{
    const a=VERTICES[(i+4)%5],b=VERTICES[(i+1)%5];
    const incoming=Math.atan2(p[0]-a[0],p[1]-a[1]),outgoing=Math.atan2(b[0]-p[0],b[1]-p[1]);
    const turn=(outgoing-incoming+Math.PI*2)%(Math.PI*2),radius=RADII[i]*scale,t=radius*Math.tan(turn/2);
    return {incoming,outgoing,turn,radius,entry:{x:p[0]*scale-Math.sin(incoming)*t,z:p[1]*scale-Math.cos(incoming)*t},exit:{x:p[0]*scale+Math.sin(outgoing)*t,z:p[1]*scale+Math.cos(outgoing)*t}};
  });
  const raw:Vec[]=[],sections:TrackSection[]=[];let length=0;
  const line=(a:{x:number;z:number},b:{x:number;z:number},name:string)=>{
    const n=Math.hypot(b.x-a.x,b.z-a.z);sections.push({name,start:length,length:n,radius:0,turn:0});
    const steps=Math.ceil(n/1.5);for(let i=0;i<steps;i++)raw.push({x:a.x+(b.x-a.x)*i/steps,y:0,z:a.z+(b.z-a.z)*i/steps});length+=n;
  };
  const names=['Son park virajı','Hızlı kuzey yayı','Geniş doğu virajı','Güney yayı','Batı dönüşü'];
  const start={x:0,z:20*scale};let from=start;
  for(const i of [1,2,3,4,0]){
    const c=corners[i];line(from,c.entry,i===1?'Start düzlüğü':`Düzlük ${i}`);
    const n=c.radius*c.turn;sections.push({name:names[i],start:length,length:n,radius:c.radius,turn:c.turn});
    const cx=c.entry.x+Math.cos(c.incoming)*c.radius,cz=c.entry.z-Math.sin(c.incoming)*c.radius,steps=Math.ceil(n/1.2);
    for(let j=0;j<steps;j++){const h=c.incoming+c.turn*j/steps;raw.push({x:cx-Math.cos(h)*c.radius,y:0,z:cz+Math.sin(h)*c.radius});}
    length+=n;from=c.exit;
  }
  line(from,start,'Bitiş yaklaşımı');return {raw,sections};
}
export class RaceTrack {
  readonly points: RoutePoint[] = [];
  readonly sections:TrackSection[];
  readonly checkpoints: RoutePoint[];
  readonly barriers: Barrier[] = [];
  readonly trees:{x:number;z:number;scale:number}[]=[];
  readonly length: number;
  readonly land:Vec[];
  readonly landIndices:number[];
  constructor(readonly scale = 1, readonly width = 10) {
    let s=0;
    const {raw,sections}=circuit(scale);this.sections=sections;
    raw.forEach((p,i)=>{
      if(i)s+=Math.hypot(p.x-raw[i-1].x,p.z-raw[i-1].z);
      const a=raw[(i-1+raw.length)%raw.length],b=raw[(i+1)%raw.length],len=Math.hypot(b.x-a.x,b.z-a.z);
      const turn=Math.atan2(b.x-p.x,b.z-p.z)-Math.atan2(p.x-a.x,p.z-a.z);
      this.points.push({...p,s,tx:(b.x-a.x)/len,tz:(b.z-a.z)/len,width,curve:Math.abs(Math.atan2(Math.sin(turn),Math.cos(turn)))/Math.max(.1,len/2)});
    });
    const last=raw[raw.length-1];this.length=s+Math.hypot(last.x-raw[0].x,last.z-raw[0].z);
    // Broad passing lanes on the main and east straights; asphalt width only.
    for(const p of this.points){const f=p.s/this.length;p.width=width+(f<.14||f>.89||f>.39&&f<.56?2:0);}
    this.checkpoints=Array.from({length:18},(_,i)=>this.at(i*this.length/18));
    const xs=raw.map(p=>p.x),zs=raw.map(p=>p.z),left=Math.min(...xs)-32,right=Math.max(...xs)+35,top=Math.max(...zs)+32,bottom=Math.min(...zs)-32;
    // One solid park plateau. The single inset bay exposes the ridge; the infield
    // stays grass, so broad recovery lines never encounter an accidental ribbon hole.
    this.land=[{x:left,y:0,z:top},{x:right,y:0,z:top}];
    for(let f=.43;f<=.546;f+=.005){const p=this.at(f*this.length),w=f>.44&&f<.535?p.width/2+1.5:p.width/2+22;this.land.push({x:p.x-p.tz*w,y:0,z:p.z+p.tx*w});}
    this.land.push({x:right,y:0,z:bottom},{x:left,y:0,z:bottom});
    this.landIndices=ShapeUtils.triangulateShape(this.land.map(p=>new Vector2(p.x,p.z)),[]).flatMap(([a,b,c])=>[a,c,b]);
    for(let d=0;d<this.length;d+=3){const p=this.at(d),f=d/this.length;
      for(const side of [-1,1]){
        // Outside of the ridge is open; several other corners have generous grass run-off.
        if(this.risk(d)&&side===-1)continue;
        if(f>.16&&f<.34&&side===1||f>.56&&f<.87&&side===1)continue;
        const off=side*(p.width/2+3.3);
        this.barriers.push({x:p.x+p.tz*off,z:p.z-p.tx*off,yaw:Math.atan2(p.tx,p.tz),length:3.12,height:.8});
      }
    }
    for(let d=0;d<this.length;d+=16){const p=this.at(d);for(const side of [-1,1]){
      if(this.risk(d)&&side===-1)continue;
      const off=side*(p.width/2+13+(Math.sin(d*3)+1)*3),x=p.x+p.tz*off,z=p.z-p.tx*off;
      if(this.project({x,y:0,z}).distance>=11)this.trees.push({x,z,scale:.8+.3*(1+Math.sin(d))});
    }}
  }
  wrap(s:number){return (s%this.length+this.length)%this.length;}
  at(distance:number):RoutePoint {
    const s=this.wrap(distance);let lo=0,hi=this.points.length-1;
    while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(this.points[mid].s<=s)lo=mid;else hi=mid-1;}
    const a=this.points[lo],b=this.points[(lo+1)%this.points.length],t=(s-a.s)/((b.s||this.length)-a.s),tx=a.tx+(b.tx-a.tx)*t,tz=a.tz+(b.tz-a.tz)*t,l=Math.hypot(tx,tz);
    return {x:a.x+(b.x-a.x)*t,y:0,z:a.z+(b.z-a.z)*t,s,tx:tx/l,tz:tz/l,width:a.width+(b.width-a.width)*t,curve:a.curve+(b.curve-a.curve)*t};
  }
  project(p:Vec):Projection {
    let best=Infinity,result:Projection|undefined;
    for(let i=0;i<this.points.length;i++){
      const a=this.points[i],b=this.points[(i+1)%this.points.length],dx=b.x-a.x,dz=b.z-a.z,t=clamp(((p.x-a.x)*dx+(p.z-a.z)*dz)/(dx*dx+dz*dz),0,1),x=a.x+dx*t,z=a.z+dz*t,d=(p.x-x)**2+(p.z-z)**2;
      if(d>=best)continue;best=d;const s=a.s+t*((b.s||this.length)-a.s),q={...a,x,z,s};result={s,lateral:(p.x-x)*a.tz-(p.z-z)*a.tx,distance:Math.sqrt(d),point:q};
    }
    return result!;
  }
  risk(s:number){const f=this.wrap(s)/this.length;return f>.44&&f<.535;}
  landWidth(s:number,side:number){const p=this.at(s);return this.risk(s)&&side===-1?p.width/2+1.5:p.width/2+22;}
  pose(s:number,offset=0):Vec {const p=this.at(s);return {x:p.x+p.tz*offset,y:.64,z:p.z-p.tx*offset};}
  grid(id:number):{p:Vec;heading:number}{const s=-7-(id===2?6:0),p=this.at(s);return {p:this.pose(s,id===0?-2:id===1?2:0),heading:Math.atan2(p.tx,p.tz)};}
}

/** Swept, forward-only gate crossing. The finite gate also checks height; no air/void laps. */
export function crossedGate(previous:Vec,current:Vec,gate:RoutePoint){
  const a=(previous.x-gate.x)*gate.tx+(previous.z-gate.z)*gate.tz,b=(current.x-gate.x)*gate.tx+(current.z-gate.z)*gate.tz;
  if(a>0||b<=0||b-a<.0001)return false;
  const t=-a/(b-a),x=previous.x+(current.x-previous.x)*t,z=previous.z+(current.z-previous.z)*t,y=previous.y+(current.y-previous.y)*t;
  return Math.abs((x-gate.x)*gate.tz-(z-gate.z)*gate.tx)<=gate.width/2+1.4&&y>0&&y<1.8;
}
