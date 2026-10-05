/** Player contacts only. Ice keeps its own zero restitution and friction. */
export const SNOWBALL_CONTACT = Object.freeze({
  recoil: 3,
  rampSpeed: 0.4,
  speedScale: 0.85,
  recoverySeconds: 0.18,
  initialAuthority: 0.15,
});

/** A soft minimum: continuous at zero, including almost stationary touches.
 * This is desired relative normal separation, not either body's final velocity. */
export function contactSeparation(approach: number) {
  if (approach <= 0) return 0;
  return SNOWBALL_CONTACT.speedScale * approach
    + SNOWBALL_CONTACT.recoil * -Math.expm1(-approach / SNOWBALL_CONTACT.rampSpeed);
}

export function impactAuthority(remaining: number) {
  const t = Math.max(0, Math.min(1, 1 - remaining / SNOWBALL_CONTACT.recoverySeconds));
  return SNOWBALL_CONTACT.initialAuthority
    + (1 - SNOWBALL_CONTACT.initialAuthority) * t * t * (3 - 2 * t);
}
