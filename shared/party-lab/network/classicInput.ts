export interface ClassicInputPacket {seq:number;round:number;epoch:number;pressed:boolean;eventTime:number;}
const keys=['seq','round','epoch','pressed','eventTime'];
export function validateClassicInput(value:unknown):ClassicInputPacket|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;const p=value as ClassicInputPacket;
 if(Object.keys(p).length!==keys.length||Object.keys(p).some(k=>!keys.includes(k)))return null;
 if(![p.seq,p.round,p.epoch].every(Number.isSafeInteger)||p.seq<0||p.round<1||p.epoch<0||typeof p.pressed!=='boolean'||typeof p.eventTime!=='number'||!Number.isFinite(p.eventTime)||p.eventTime<0)return null;
 return {...p};
}
/** Room-clock event time: bounded history, no client-authored gauge values. */
export const CLASSIC_INPUT_WINDOW_MS=250;
export function classicEventTime(eventTime:number,now:number,start:number){return Math.max(start,Math.min(now+25,Math.max(now-CLASSIC_INPUT_WINDOW_MS,eventTime)));}
