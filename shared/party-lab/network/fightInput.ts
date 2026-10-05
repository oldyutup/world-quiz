export interface FightInputPacket {
  seq:number; round:number; life:number; moveX:number; moveZ:number; yaw:number; pitch:number;
  jumpHeld:boolean; sprintHeld:boolean; crouchHeld:boolean; gatherHeld:boolean; throwPressed:boolean;
}
const keys=['seq','round','life','moveX','moveZ','yaw','pitch','jumpHeld','sprintHeld','crouchHeld','gatherHeld','throwPressed'];
export function validateFightInput(value:unknown):FightInputPacket|null{
  if(!value||typeof value!=='object'||Array.isArray(value))return null;const p=value as FightInputPacket;
  if(Object.keys(p).length!==keys.length||Object.keys(p).some(k=>!keys.includes(k)))return null;
  if(![p.seq,p.round,p.life].every(Number.isSafeInteger)||p.seq<0||p.round<1||p.life<0)return null;
  if(![p.moveX,p.moveZ,p.yaw,p.pitch].every(n=>typeof n==='number'&&Number.isFinite(n))||Math.abs(p.yaw)>1e4)return null;
  if(![p.jumpHeld,p.sprintHeld,p.crouchHeld,p.gatherHeld,p.throwPressed].every(n=>typeof n==='boolean'))return null;
  const x=Math.max(-1,Math.min(1,p.moveX)),z=Math.max(-1,Math.min(1,p.moveZ)),n=Math.max(1,Math.hypot(x,z));
  return {...p,moveX:x/n,moveZ:z/n,yaw:Math.atan2(Math.sin(p.yaw),Math.cos(p.yaw)),pitch:Math.max(-.60,Math.min(.78,p.pitch))};
}
