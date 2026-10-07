/**
 * Altın Madenci: every player swings a hook over one shared mine and fires it at the
 * gold. The server owns the mine, the hooks and the scores; every knob lives here.
 *
 * Coordinates: metres, x across the mine (−width/2 … width/2), y DOWN from the hooks'
 * pivots (0) to the bottom (`depth`). An angle of 0 points straight down, positive to +x.
 */
export const GOLD_KINDS = ["small", "big", "rock", "diamond", "sack"] as const;
export type GoldKind = (typeof GOLD_KINDS)[number];
/** A fixed count, or [min, max] picked at random for each round. */
export type GoldCount = number | readonly [number, number];

export const GOLD_MINER = {
  width: 18,
  depth: 12,
  /** A swinging hook hangs this far below its pivot; a shot starts from there. */
  restLength: 0.9,
  /** The hook takes the first item its tip passes within this distance of (plus the item's radius). */
  hookRadius: 0.25,
  /** Swing: ±`swingDeg` from straight down, one full swing (out and back) every `swingSeconds`. */
  swingDeg: 70,
  swingSeconds: 2.8,
  /** A shot reaches the bottom of the mine (straight down) in this long, s. */
  shotSeconds: 0.6,
  /** An empty hook comes back from the bottom in this long, s, and never takes longer than `emptyMax`. */
  emptySeconds: 0.5,
  emptyMax: 0.6,
  /** No full return takes longer than this, s (a rock from a far corner). */
  returnMax: 2,
  /**
   * Item kinds: points, size (radius, m) and `pull`: seconds to pull it up from the bottom
   * of the mine straight below the pivot (a shallower item comes up sooner).
   */
  items: {
    small: { value: 50, radius: 0.45, pull: 0.6 },
    big: { value: 250, radius: 0.95, pull: 1.3 },
    rock: { value: 10, radius: 0.72, pull: 2 },
    diamond: { value: 400, radius: 0.35, pull: 0.6 },
    /** Gizemli çuval: its points are rolled from `sackValue` when the mine is made. */
    sack: { value: 0, radius: 0.55, pull: 1 },
  },
  /** Gizemli çuval points: from [0] to [1] in steps of `sackStep`. */
  sackValue: [20, 400],
  sackStep: 10,
  /** Items in one round's mine, by player count. */
  counts: {
    2: { big: 2, small: 4, rock: 2, diamond: 1, sack: 2 },
    3: { big: 2, small: 5, rock: 3, diamond: [1, 2], sack: 2 },
  } as Readonly<Record<2 | 3, Readonly<Record<GoldKind, GoldCount>>>>,
  /** Mine generation rules (servers/party-lab/tests/goldMiner.test.ts checks them on many mines). */
  field: {
    /** Items sit at least this deep (their top edge)... */
    minDepth: 2.3,
    /** ...this far inside the walls and the bottom, and this far apart edge to edge. */
    margin: 0.35,
    gap: 0.3,
    /** At least this many big golds or diamonds can be hooked by two players or more. */
    shared: 1,
    /**
     * Each player's nearby value (the items they are the closest player to hook) stays within
     * this share of the average (a sack counts as its average).
     */
    balance: 0.3,
    /** Layouts tried before the most balanced valid one is taken. */
    attempts: 3000,
  },
  /** Simulation steps per second (the room's fixed step). */
  hz: 60,
  /** 3-2-1 before BAŞLA, seconds. */
  countdown: 3,
  /** Mining time, seconds. An item still on its way up at the end does not count. */
  limit: 30,
  /** Results screen, seconds. */
  results: 8,
  /**
   * Aim fairness: a shot is fired at the angle and moment the shooter pressed (on their
   * clock, ms after BAŞLA) when that was at most this long ago on the server's clock; an
   * older press is moved up to this limit.
   */
  aimToleranceMs: 150,
  /**
   * A press may also lead the server's clock by this much, ms: the shooter's clock follows the
   * snapshots, and the server's fixed step runs a little early or late against them. A press
   * further ahead is pulled back to this.
   */
  aheadMs: 50,
  /** Players (hooks) the engine and the view support. */
  maxLanes: 3,
} as const;
