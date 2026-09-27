/** Controls only. A throw epoch prevents queued controls reaching another driver. */
export interface BowlingInputPacket {
  seq: number; round: number; turn: number;
  throttle: number; brake: number; steer: number; pitch: number; space: boolean;
}
export const BOWLING_INPUT_BYTES = 29;
export function encodeBowlingInput(p: BowlingInputPacket) {
  const bytes = new Uint8Array(BOWLING_INPUT_BYTES), v = new DataView(bytes.buffer);
  [p.seq,p.round,p.turn].forEach((n,i)=>v.setUint32(i*4,n,true));
  [p.throttle,p.brake,p.steer,p.pitch].forEach((n,i)=>v.setFloat32(12+i*4,n,true));
  bytes[28]=+p.space; return bytes;
}
export function validateBowlingInput(value: unknown): BowlingInputPacket | null {
  if(value instanceof Uint8Array) {
    if(value.length!==BOWLING_INPUT_BYTES || value[28]>1)return null;
    const v=new DataView(value.buffer,value.byteOffset,value.byteLength);
    value={seq:v.getUint32(0,true),round:v.getUint32(4,true),turn:v.getUint32(8,true),throttle:v.getFloat32(12,true),brake:v.getFloat32(16,true),steer:v.getFloat32(20,true),pitch:v.getFloat32(24,true),space:!!value[28]};
  }
  if(!value || typeof value!=='object' || Array.isArray(value))return null;
  const p=value as BowlingInputPacket,keys=['seq','round','turn','throttle','brake','steer','pitch','space'];
  if(Object.keys(p).length!==keys.length||Object.keys(p).some(k=>!keys.includes(k)))return null;
  if(![p.seq,p.round,p.turn].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=0xffffffff)||p.round<1||p.turn>8)return null;
  if(![p.throttle,p.brake,p.steer,p.pitch].every(n=>typeof n==='number'&&Number.isFinite(n))||typeof p.space!=='boolean')return null;
  return {...p,throttle:Math.max(0,Math.min(1,p.throttle)),brake:Math.max(0,Math.min(1,p.brake)),steer:Math.max(-1,Math.min(1,p.steer)),pitch:Math.max(-1,Math.min(1,p.pitch))};
}
