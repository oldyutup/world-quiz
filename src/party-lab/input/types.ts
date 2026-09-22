/** Input intent only. Taps are consumed once per fixed step. */
export interface MovementInput {
  x: number;
  z: number;
  jump: boolean;
  /** Abstract human actions; per-hand fields below remain bot/physics intents. */
  punch?: boolean;
  grab?: boolean;
  left?: boolean;
  right?: boolean;
  punchLeft?: boolean;
  punchRight?: boolean;
  lift?: boolean;
}
