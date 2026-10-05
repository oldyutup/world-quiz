export interface RaceInputPacket {seq:number;round:number;resetEpoch:number;throttle:number;brake:number;steer:number;handbrake:boolean;reset:boolean;}
const keys=['seq','round','resetEpoch','throttle','brake','steer','handbrake','reset'];
export function validateRaceInput(value:unknown):RaceInputPacket|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;const p=value as RaceInputPacket;
 if(Object.keys(p).length!==keys.length||Object.keys(p).some(k=>!keys.includes(k)))return null;
 if(![p.seq,p.round,p.resetEpoch].every(Number.isSafeInteger)||p.seq<0||p.round<1||p.resetEpoch<0)return null;
 if(![p.throttle,p.brake,p.steer].every(n=>typeof n==='number'&&Number.isFinite(n))||typeof p.handbrake!=='boolean'||typeof p.reset!=='boolean')return null;
 return {...p,throttle:Math.max(0,Math.min(1,p.throttle)),brake:Math.max(0,Math.min(1,p.brake)),steer:Math.max(-1,Math.min(1,p.steer))};
}
