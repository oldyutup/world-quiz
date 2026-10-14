/**
 * Swept tests: a head moving from (px, pz) by (dx, dz) in one step, checked along the whole
 * move, so a fast head can never jump over a thin line. Each returns the earliest share of the
 * move (0…1) at which the head touches, or Infinity when it does not.
 */

/** Earliest f at which the moving point comes within `r` of the point (cx, cz). */
export function sweepCircle(px: number, pz: number, dx: number, dz: number, cx: number, cz: number, r: number) {
  const fx = px - cx,
    fz = pz - cz,
    c = fx * fx + fz * fz - r * r;
  if (c <= 0) return 0;
  const a = dx * dx + dz * dz;
  if (a < 1e-18) return Infinity;
  const b = 2 * (fx * dx + fz * dz),
    disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const f = (-b - Math.sqrt(disc)) / (2 * a);
  return f >= 0 && f <= 1 ? f : Infinity;
}

/** Distance from (px, pz) to the segment a–b. */
export function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const ux = bx - ax,
    uz = bz - az,
    l2 = ux * ux + uz * uz;
  const t = l2 > 1e-18 ? Math.max(0, Math.min(1, ((px - ax) * ux + (pz - az) * uz) / l2)) : 0;
  return Math.hypot(px - (ax + ux * t), pz - (az + uz * t));
}

/** Earliest f at which the moving point comes within `r` of the segment a–b (a capsule). */
export function sweepSegment(px: number, pz: number, dx: number, dz: number, ax: number, az: number, bx: number, bz: number, r: number) {
  if (segmentDistance(px, pz, ax, az, bx, bz) <= r) return 0;
  let best = Math.min(sweepCircle(px, pz, dx, dz, ax, az, r), sweepCircle(px, pz, dx, dz, bx, bz, r));
  const ux = bx - ax,
    uz = bz - az,
    length = Math.hypot(ux, uz);
  if (length > 1e-9) {
    const tx = ux / length,
      tz = uz / length,
      // Signed distance from the line and the moving rate of it.
      s0 = (px - ax) * -tz + (pz - az) * tx,
      sd = dx * -tz + dz * tx;
    for (const side of [r, -r]) {
      if (Math.abs(sd) < 1e-18) continue;
      const f = (side - s0) / sd;
      if (f < 0 || f > 1 || f >= best) continue;
      // Only when it moves towards the line from outside this side.
      if (side > 0 ? !(s0 > side && sd < 0) : !(s0 < side && sd > 0)) continue;
      const along = (px + dx * f - ax) * tx + (pz + dz * f - az) * tz;
      if (along >= 0 && along <= length) best = f;
    }
  }
  return best;
}

/** Earliest f at which the moving point enters the box [x0, x1] × [z0, z1] (0 when it starts inside). */
export function sweepBox(px: number, pz: number, dx: number, dz: number, x0: number, x1: number, z0: number, z1: number) {
  let enter = 0,
    leave = 1;
  for (const [p, d, lo, hi] of [
    [px, dx, x0, x1],
    [pz, dz, z0, z1],
  ]) {
    if (Math.abs(d) < 1e-18) {
      if (p < lo || p > hi) return Infinity;
      continue;
    }
    let a = (lo - p) / d,
      b = (hi - p) / d;
    if (a > b) [a, b] = [b, a];
    enter = Math.max(enter, a);
    leave = Math.min(leave, b);
    if (enter > leave) return Infinity;
  }
  return enter;
}

/** Earliest f at which the moving point leaves the box [-hx, hx] × [-hz, hz] (Infinity while inside). */
export function sweepOut(px: number, pz: number, dx: number, dz: number, hx: number, hz: number) {
  let best = Infinity;
  if (Math.abs(px) > hx || Math.abs(pz) > hz) return 0;
  if (px + dx > hx) best = Math.min(best, (hx - px) / dx);
  if (px + dx < -hx) best = Math.min(best, (-hx - px) / dx);
  if (pz + dz > hz) best = Math.min(best, (hz - pz) / dz);
  if (pz + dz < -hz) best = Math.min(best, (-hz - pz) / dz);
  return best;
}

/** Does the segment a–b come within `r` of the box [x0, x1] × [z0, z1]? (The train wiping a trail.) */
export function segmentNearBox(ax: number, az: number, bx: number, bz: number, x0: number, x1: number, z0: number, z1: number, r: number) {
  return sweepBox(ax, az, bx - ax, bz - az, x0 - r, x1 + r, z0 - r, z1 + r) <= 1;
}
