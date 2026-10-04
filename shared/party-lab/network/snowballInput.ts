/** Ten bytes: sequence, match epoch, round (1–3), held W/A/S/D bits. No camera or state claims. */
export interface SnowballInputPacket { seq: number; round: number; stage: number; keys: number }
export const SNOWBALL_INPUT_BYTES = 10;
export function encodeSnowballInput(p: SnowballInputPacket) {
  const bytes = new Uint8Array(SNOWBALL_INPUT_BYTES), v = new DataView(bytes.buffer);
  v.setUint32(0, p.seq, true); v.setUint32(4, p.round, true); bytes[8] = p.stage; bytes[9] = p.keys;
  return bytes;
}
export function validateSnowballInput(value: unknown): SnowballInputPacket | null {
  if (value instanceof Uint8Array) {
    if (value.byteLength !== SNOWBALL_INPUT_BYTES) return null;
    const v = new DataView(value.buffer, value.byteOffset, value.byteLength);
    value = { seq: v.getUint32(0, true), round: v.getUint32(4, true), stage: value[8], keys: value[9] };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as SnowballInputPacket, keys = ['seq', 'round', 'stage', 'keys'];
  if (Object.keys(p).length !== 4 || Object.keys(p).some(k => !keys.includes(k))) return null;
  if (![p.seq, p.round, p.stage, p.keys].every(Number.isInteger) || p.seq < 0 || p.seq > 0xffffffff || p.round < 1 || p.round > 0xffffffff || p.stage < 1 || p.stage > 3 || p.keys < 0 || p.keys > 15) return null;
  return { seq: p.seq, round: p.round, stage: p.stage, keys: p.keys };
}
export const snowballAxes = (keys: number) => ({ x: Number(!!(keys & 8)) - Number(!!(keys & 2)), z: Number(!!(keys & 4)) - Number(!!(keys & 1)) });
