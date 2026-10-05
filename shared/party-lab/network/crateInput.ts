export interface CrateInputPacket {
  seq: number; round: number; stage: number; moveX: number; moveZ: number;
  jumpHeld: boolean; sprintHeld: boolean;
}
const keys = ['seq', 'round', 'stage', 'moveX', 'moveZ', 'jumpHeld', 'sprintHeld'];
export function validateCrateInput(value: unknown): CrateInputPacket | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as CrateInputPacket;
  if (Object.keys(p).length !== keys.length || Object.keys(p).some(k => !keys.includes(k))) return null;
  if (![p.seq, p.round, p.stage].every(Number.isSafeInteger) || p.seq < 0 || p.round < 1 || p.stage < 1 || p.stage > 3) return null;
  if (![p.moveX, p.moveZ].every(n => typeof n === 'number' && Number.isFinite(n)) || typeof p.jumpHeld !== 'boolean' || typeof p.sprintHeld !== 'boolean') return null;
  const x = Math.max(-1, Math.min(1, p.moveX)), z = Math.max(-1, Math.min(1, p.moveZ)), length = Math.max(1, Math.hypot(x, z));
  return { ...p, moveX: x / length, moveZ: z / length };
}
