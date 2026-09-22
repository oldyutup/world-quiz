export interface Vec {
  x: number;
  y: number;
  z: number;
}
export interface Quat extends Vec {
  w: number;
}
export const zero = (): Vec => ({ x: 0, y: 0, z: 0 });
export const add = (a: Vec, b: Vec): Vec => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});
export const sub = (a: Vec, b: Vec): Vec => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});
export const mul = (a: Vec, n: number): Vec => ({
  x: a.x * n,
  y: a.y * n,
  z: a.z * n,
});
export const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y + a.z * b.z;
export const length = (a: Vec) => Math.hypot(a.x, a.y, a.z);
export const unit = (a: Vec): Vec => mul(a, 1 / Math.max(0.0001, length(a)));
export const cap = (a: Vec, maximum: number): Vec =>
  mul(a, Math.min(1, maximum / Math.max(0.0001, length(a))));
export const clamp = (n: number, lo = 0, hi = 1) =>
  Math.max(lo, Math.min(hi, n));
export const finite = (a: Vec) => [a.x, a.y, a.z].every(Number.isFinite);
export const conjugate = (q: Quat): Quat => ({
  x: -q.x,
  y: -q.y,
  z: -q.z,
  w: q.w,
});
export function product(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
export function rotate(q: Quat, v: Vec): Vec {
  const p = product(product(q, { ...v, w: 0 }), conjugate(q));
  return { x: p.x, y: p.y, z: p.z };
}
export const yaw = (angle: number): Quat => ({
  x: 0,
  y: Math.sin(angle / 2),
  z: 0,
  w: Math.cos(angle / 2),
});
