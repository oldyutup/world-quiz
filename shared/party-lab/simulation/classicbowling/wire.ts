import RAPIER from '@dimforge/rapier3d-compat';
import type {ClassicGame,ClassicSnapshot,ClassicEvent} from './game.js';
export interface ClassicWire {seats:number[];seed:number;epoch:number;phaseStart:number;serverNow:number;time:number;velocity:number[];state:ClassicSnapshot;pinIds:number[];down:number[];ball:boolean;events:{id:number;kind:ClassicEvent}[];}
/** Eleven compact bodies: ball followed by stable pin ids; absent bodies have identity poses. */
export function classicTransforms(g:ClassicGame){const bytes=new Uint8Array(11*28),v=new DataView(bytes.buffer);for(let i=0;i<11;i++)v.setFloat32(i*28+24,1,true);
 const put=(b:RAPIER.RigidBody,id:number)=>{const p=b.translation(),q=b.rotation();[p.x,p.y,p.z,q.x,q.y,q.z,q.w].forEach((n,j)=>v.setFloat32((id*7+j)*4,n,true));};if(g.ball)put(g.ball,0);g.pins.forEach(p=>put(p.body,p.id+1));return bytes;
}
export function restoreClassic(g:ClassicGame,w:ClassicWire,poses:ArrayLike<number>){
 const s=w.state;Object.assign(g,{time:w.time,phase:s.phase,phaseTime:s.phaseTime,position:s.position,angle:s.angle,power:s.power,lastPins:s.lastPins,message:s.message});Object.assign(g.score,{seat:s.seat,frame:s.phase==='results'?3:s.frame-1,roll:s.roll,finished:s.phase==='results'});
 s.cards.forEach((card,i)=>card.forEach((f,j)=>Object.assign(g.score.cards[i][j],{...f,rolls:[...f.rolls]})));
 if(g.pins.map(p=>p.id).join(',')!==w.pinIds.join(','))g.resetRack(w.pinIds);
 if(!w.ball&&g.ball){g.world.removeRigidBody(g.ball);g.ball=null;g.ballCollider=null;}
 if(w.ball&&!g.ball)g.ball=g.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
 const put=(b:RAPIER.RigidBody,id:number)=>{const o=id*7;b.setTranslation({x:poses[o],y:poses[o+1],z:poses[o+2]},false);b.setRotation({x:poses[o+3],y:poses[o+4],z:poses[o+5],w:poses[o+6]},false);};
 if(g.ball){put(g.ball,0);g.ball.setLinvel({x:w.velocity[0],y:w.velocity[1],z:w.velocity[2]},false);}g.pins.forEach(p=>{put(p.body,p.id+1);p.down=w.down.includes(p.id);});g.events.length=0;
}
