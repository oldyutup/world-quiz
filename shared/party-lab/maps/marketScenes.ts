import { CHECKOUTS, GONDOLAS, MARKET } from "./market.js";
import type { MarketFamilyId, PropFamilyId } from "./propHuntProps.js";
import { corner, free, item, pick, sceneMaker, sceneSet, variant, wall, type PropScene, type Setting } from "./propScenes.js";

/**
 * Market's scene recipes (the generic machinery: propScenes.ts; dealt by marketLayout.ts). The
 * shop's fixtures never move; its ordinary decoys come from these scenes: restock boxes and a
 * forgotten cart in the aisles, promotions on the end caps, crates and melons round the produce,
 * carts queueing at the tills and nested in the corral, pallets in the depot.
 *
 * Every family is in play every round with at least three decoys (marketLayout.ts): a hider's
 * disguise is never one of a kind. Same-family groups are the point here (a row of carts, a
 * line of crates, melons round the pile, two can towers on an end cap).
 */

type F = PropFamilyId;
const I = MARKET.inside;

/** What kind of place a slot is: it decides which families are plausible there. */
export type MarketContext = "shelf" | "endCap" | "produce" | "chill" | "depot" | "till" | "entrance";
export const MARKET_CONTEXT_FAMILIES = {
  /** Against a gondola or the drinks wall: restocking and a shopper's things. */
  shelf: ["canTower", "drinkCrate", "parcel", "basketStack", "palletBoxes", "cart"],
  /** Promotions at an aisle's end. */
  endCap: ["canTower", "drinkCrate", "pumpkin", "watermelon", "parcel", "basketStack"],
  produce: ["watermelon", "pumpkin", "appleCrate", "orangeCrate", "produceBin", "basketStack", "parcel"],
  /** The fridge aisle and the freezer islands. */
  chill: ["drinkCrate", "parcel", "canTower", "basketStack", "trashBin", "cart", "palletBoxes"],
  depot: ["parcel", "palletBoxes", "drinkCrate", "trashBin", "cart", "produceBin", "appleCrate", "orangeCrate", "canTower"],
  /** The checkout lanes. */
  till: ["cart", "basketStack", "trashBin", "drinkCrate", "canTower"],
  entrance: ["cart", "basketStack", "trashBin", "pumpkin", "watermelon", "produceBin", "drinkCrate", "canTower", "appleCrate", "orangeCrate"],
} as const satisfies Record<MarketContext, readonly MarketFamilyId[]>;
/** Every family stands indoors (the whole map is one building). */
export const MARKET_FAMILY_SETTINGS: Readonly<Record<MarketFamilyId, readonly Setting[]>> = {
  canTower: ["indoor"],
  drinkCrate: ["indoor"],
  pumpkin: ["indoor"],
  basketStack: ["indoor"],
  watermelon: ["indoor"],
  parcel: ["indoor"],
  trashBin: ["indoor"],
  appleCrate: ["indoor"],
  orangeCrate: ["indoor"],
  cart: ["indoor"],
  produceBin: ["indoor"],
  palletBoxes: ["indoor"],
};
const scene = sceneMaker(() => "indoor");

const CRATES: F[] = ["appleCrate", "orangeCrate"];
const PROMO: F[] = ["canTower", "drinkCrate", "pumpkin", "watermelon", "basketStack"];
const RESTOCK: F[] = ["parcel", "canTower", "drinkCrate"];
/** A shelf-side slot (1.3 m along, 1.1 m deep): restock boxes, a pallet, a cart set against the shelf. */
const SIDE = { len: 1.3, depth: 1.1 };
/** A cart parked along a shelf or a counter (free, nose north or south). */
const PARKED = { len: 0.8, depth: 1.15 };
const AT = [-2.7, -0.9, 0.9, 2.7] as const;
const mid = ([x0, x1]: readonly [number, number]) => (x0 + x1) / 2;

/** One shelf aisle: the west shelf's face (`west`, the slot backs onto it on its −x side) and the east one's (`east`); null: open. */
function aisle(id: string, label: string, west: number | null, east: number, stock: F[]): PropScene {
  const specs: Record<string, ReturnType<typeof wall>> = {};
  AT.forEach((z, k) => {
    if (west !== null) specs[`w${k}`] = wall("-x", west, z, 0, SIDE, "shelf");
    specs[`e${k}`] = wall("+x", east, z, 0, SIDE, "shelf");
  });
  // A cart left along a shelf (nose up or down the aisle).
  if (west !== null) specs.cartW = free(west + 0.42, AT[1], 0, PARKED, "shelf", { turns: [0, 2] });
  specs.cartE = free(east - 0.42, AT[2], 0, PARKED, "shelf", { turns: [0, 2] });
  const w = (k: number) => (west === null ? `e${k}` : `w${k}`);
  return scene(id, "aisles", label, specs, [
    variant("restock", 2, pick(2, 4, item(["e0", "e1"], RESTOCK), item(["e2", "e3"], RESTOCK), item([w(0), w(1)], ["parcel", ...stock]), item([w(2), w(3)], ["parcel", ...stock]))),
    variant("pallet", 1.2, item(["e0", "e3", w(0), w(3)], "palletBoxes"), item(["e1", "e2", w(1), w(2)], ["parcel", ...stock], 0.6)),
    variant("cart", 1.5, item(west === null ? "cartE" : ["cartW", "cartE"], "cart"), item(["e0", "e3", w(1), w(2)], [...stock, "basketStack"], 0.6)),
    variant("stock", 1.5, pick(2, 4, item("e0", stock), item("e1", stock), item("e2", stock), item("e3", stock), item(w(0), stock), item(w(3), stock))),
    variant("quiet", 0.5, item(["e1", "e2", w(1), w(2)], ["parcel", "basketStack"], 0.7)),
  ]);
}
/** End caps of the three gondolas at one end: two promo spots each (`side` the gondola is on, `face` its end). */
function caps(id: string, label: string, side: "+z" | "-z", face: number): PropScene {
  const specs: Record<string, ReturnType<typeof wall>> = {};
  GONDOLAS.forEach((g, k) => {
    specs[`g${k}a`] = wall(side, face, mid(g) - 0.45, 0, { len: 0.86, depth: 0.82 }, "endCap");
    specs[`g${k}b`] = wall(side, face, mid(g) + 0.45, 0, { len: 0.86, depth: 0.82 }, "endCap");
  });
  const pair = (k: number, families: F[], chance = 1) => [item(`g${k}a`, families, chance), item(`g${k}b`, families, chance)];
  return scene(id, "aisles", label, specs, [
    // One promotion per end cap: the same kind twice, or a single one.
    variant("cans", 1.5, ...pair(0, ["canTower"]), item(["g1a", "g1b", "g2a", "g2b"], PROMO, 0.8)),
    variant("drinks", 1.5, ...pair(2, ["drinkCrate"]), item(["g0a", "g0b", "g1a", "g1b"], PROMO, 0.8)),
    variant("harvest", 1.2, ...pair(1, ["pumpkin", "watermelon"]), item(["g0a", "g2b"], ["canTower", "drinkCrate"], 0.7)),
    variant("mixed", 1, pick(3, 5, ...[0, 1, 2].flatMap((k) => pair(k, PROMO)))),
    variant("boxes", 0.6, item(["g0a", "g1b", "g2a"], "parcel"), item(["g0b", "g2b"], PROMO, 0.6)),
  ]);
}

export const MARKET_SCENES: readonly PropScene[] = [
  // ── Aisles ─────────────────────────────────────────────────────────────────
  aisle("aisles.west", "Konserve koridoru (batı)", null, GONDOLAS[0][0], ["canTower"]),
  aisle("aisles.cans", "Konserve–kahvaltılık koridoru", GONDOLAS[0][1], GONDOLAS[1][0], ["canTower", "basketStack"]),
  aisle("aisles.middle", "Atıştırmalık koridoru", GONDOLAS[1][1], GONDOLAS[2][0], ["canTower", "drinkCrate"]),
  aisle("aisles.drinks", "İçecek koridoru", GONDOLAS[2][1], 10.0, ["drinkCrate"]),
  caps("aisles.northCaps", "Kuzey reyon başları", "+z", -3.5),
  caps("aisles.southCaps", "Güney reyon başları", "-z", 3.5),
  scene(
    "aisles.back",
    "aisles",
    "Depo kapısı önü",
    {
      west: wall("-z", -6.0, 4.75, 0, { len: 1.5, depth: 1.1 }, "shelf"),
      east: wall("-z", -6.0, 9.4, 0, { len: 1.2, depth: 1.1 }, "shelf"),
    },
    [
      variant("pallet", 2, item("west", "palletBoxes"), item("east", ["parcel", "drinkCrate"], 0.6)),
      variant("boxes", 1.5, item(["west", "east"], "parcel"), item(["east", "west"], ["parcel", "canTower"], 0.5)),
      variant("cart", 1, item("east", "cart"), item("west", ["parcel", "palletBoxes"], 0.7)),
    ]
  ),

  // ── Produce ────────────────────────────────────────────────────────────────
  scene(
    "produce.melons",
    "produce",
    "Karpuz yığını",
    {
      n1: wall("+z", -3.2, -5.55, 0, { len: 0.86, depth: 0.6 }, "produce"),
      n2: wall("+z", -3.2, -4.65, 0, { len: 0.86, depth: 0.74 }, "produce"),
      s1: wall("-z", -1.6, -5.55, 0, { len: 0.86, depth: 0.74 }, "produce"),
      s2: wall("-z", -1.6, -4.65, 0, { len: 0.86, depth: 0.6 }, "produce"),
      e1: wall("-x", -4.3, -2.85, 0, { len: 0.86, depth: 0.6 }, "produce"),
      e2: wall("-x", -4.3, -1.95, 0, { len: 0.86, depth: 0.74 }, "produce"),
      pumpkinA: free(-4.15, -0.75, 0, { len: 0.86, depth: 0.86 }, "produce"),
    },
    [
      variant("melons", 2.5, pick(2, 4, item("n1", "watermelon"), item("n2", "watermelon"), item("s1", "watermelon"), item("s2", "watermelon"), item("e1", "watermelon"), item("e2", "watermelon")), item("pumpkinA", "pumpkin", 0.5)),
      variant("melonsPumpkins", 1.5, pick(1, 3, item("n1", "watermelon"), item("s2", "watermelon"), item("e1", "watermelon")), pick(1, 2, item("n2", "pumpkin"), item("e2", "pumpkin"), item("pumpkinA", "pumpkin"))),
      variant("pumpkins", 0.7, pick(2, 3, item("s1", "pumpkin"), item("e2", "pumpkin"), item("pumpkinA", "pumpkin"), item("n2", "pumpkin")), item(["n1", "e1"], "watermelon", 0.8)),
    ]
  ),
  scene(
    "produce.tables",
    "produce",
    "Manav tezgâhları",
    {
      t1n: wall("+z", -4.3, -7.9, 0, { len: 1.0, depth: 0.74 }, "produce"),
      t1s: wall("-z", -1.7, -7.9, 0, { len: 1.0, depth: 0.74 }, "produce"),
      t2n: wall("+z", 0.0, -7.9, 0, { len: 1.0, depth: 0.66 }, "produce"),
      t2s: wall("-z", 2.6, -7.9, 0, { len: 1.0, depth: 0.74 }, "produce"),
      t1e: wall("-x", -7.4, -3.0, 0, { len: 1.0, depth: 0.66 }, "produce"),
      t2e1: wall("-x", -7.4, 0.65, 0, { len: 1.0, depth: 0.66 }, "produce"),
      t2e2: wall("-x", -7.4, 1.95, 0, { len: 1.0, depth: 0.66 }, "produce"),
    },
    [
      variant("crates", 2.5, pick(3, 5, item("t1n", CRATES), item("t1s", CRATES), item("t2n", CRATES), item("t2s", CRATES), item("t1e", CRATES), item("t2e1", CRATES), item("t2e2", CRATES))),
      variant("apples", 1.2, pick(2, 3, item("t2e1", "appleCrate"), item("t2e2", "appleCrate"), item("t1e", "appleCrate"), item("t2s", "appleCrate")), item(["t1n", "t1s"], ["orangeCrate", "pumpkin"], 0.6)),
      variant("oranges", 1.2, pick(2, 3, item("t1n", "orangeCrate"), item("t1s", "orangeCrate"), item("t1e", "orangeCrate"), item("t2n", "orangeCrate")), item(["t2e1", "t2e2"], ["appleCrate", "basketStack"], 0.6)),
      variant("mixed", 1, pick(2, 3, item(["t1n", "t2s"], ["pumpkin", "basketStack", "parcel"]), item(["t1e", "t2e2"], CRATES), item(["t2n", "t1s"], CRATES))),
    ]
  ),
  scene(
    "produce.floor",
    "produce",
    "Manav ortası",
    {
      binA: free(-5.3, 0.2, 0, { len: 1.5, depth: 1.15 }, "produce", { turns: [0, 2] }),
      binB: free(-5.3, 2.6, 0, { len: 1.5, depth: 1.15 }, "produce", { turns: [0, 2] }),
      small: free(-4.3, 1.4, 0, { len: 0.9, depth: 0.9 }, "produce"),
    },
    [
      variant("bins", 2, item("binA", "produceBin"), item("binB", ["produceBin", ...CRATES]), item("small", ["pumpkin", "watermelon"], 0.5)),
      variant("one", 1.5, item(["binA", "binB"], "produceBin"), item("small", ["pumpkin", "basketStack", "watermelon"], 0.8)),
      variant("crates", 1, item("binA", CRATES), item("binB", CRATES), item("small", "pumpkin", 0.6)),
    ]
  ),
  scene(
    "produce.south",
    "produce",
    "Manav güney",
    {
      wallBin: wall("-x", -I, 4.45, 0, { len: 1.4, depth: 1.35 }, "produce"),
      a: free(-7.9, 4.5, 0, { len: 1.5, depth: 1.2 }, "produce", { turns: [0, 2] }),
      b: free(-5.6, 4.5, 0, { len: 1.5, depth: 1.2 }, "produce", { turns: [0, 2] }),
      nook: corner(["+z", "-x"], [-5.0, -I], 0, { len: 0.95, depth: 0.95 }, "produce"),
    },
    [
      variant("bins", 2, item(["a", "b"], "produceBin"), item("wallBin", ["produceBin", ...CRATES], 0.7), item("nook", ["parcel", "basketStack"], 0.5)),
      variant("crates", 1.5, item("a", CRATES), item("b", [...CRATES, "pumpkin"]), item("wallBin", "produceBin", 0.6), item("nook", CRATES, 0.5)),
      variant("melons", 1, item(["a", "b"], ["watermelon", "pumpkin"]), item("wallBin", "produceBin"), item("nook", "basketStack", 0.4)),
    ]
  ),

  // ── Fridges ────────────────────────────────────────────────────────────────
  scene(
    "fridges.aisle",
    "fridges",
    "Buzdolabı koridoru",
    {
      f1: wall("-z", -9.8, -8.5, 0, { len: 1.3, depth: 1.1 }, "chill"),
      f2: wall("-z", -9.8, -5.9, 0, { len: 1.3, depth: 0.75 }, "chill"),
      f3: wall("-z", -9.8, -3.3, 0, { len: 1.3, depth: 0.75 }, "chill"),
      f4: wall("-z", -9.8, -0.7, 0, { len: 1.3, depth: 1.1 }, "chill"),
      i1: wall("+z", -7.6, -8.0, 0, { len: 1.3, depth: 0.75 }, "chill"),
      i2: wall("+z", -7.6, -6.4, 0, { len: 1.3, depth: 0.75 }, "chill"),
      i3: wall("+z", -7.6, -2.4, 0, { len: 1.3, depth: 0.75 }, "chill"),
      i4: wall("+z", -7.6, -0.4, 0, { len: 1.3, depth: 0.75 }, "chill"),
      // Carts parked along the fridges (nose east or west).
      cartA: free(-5.9, -9.38, 0, { len: 1.15, depth: 0.8 }, "chill", { turns: [1, 3] }),
      cartB: free(-3.3, -9.38, 0, { len: 1.15, depth: 0.8 }, "chill", { turns: [1, 3] }),
      nook: corner(["-z", "+x"], [-I, 3.5], 0, { len: 1.5, depth: 0.9 }, "chill", { pocket: true }),
    },
    [
      variant("restock", 2, pick(2, 4, item("f1", ["drinkCrate", "parcel"]), item("f2", ["drinkCrate", "parcel"]), item("f3", ["drinkCrate", "parcel"]), item("f4", ["drinkCrate", "parcel"])), item("nook", ["trashBin", "parcel"], 0.6)),
      variant("islands", 1.5, pick(1, 2, item("i1", ["drinkCrate", "canTower", "basketStack"]), item("i2", ["drinkCrate", "canTower"]), item("i3", ["drinkCrate", "canTower", "basketStack"]), item("i4", ["parcel", "drinkCrate"])), item(["cartA", "cartB"], "cart", 0.6), item("nook", "trashBin", 0.7)),
      variant("pallet", 1, item(["f1", "f4"], "palletBoxes"), item(["i2", "i3"], ["drinkCrate", "parcel"], 0.8), item("nook", ["trashBin", "drinkCrate"], 0.6)),
      variant("quiet", 0.7, item("nook", "trashBin"), item(["f2", "i3"], ["drinkCrate", "canTower"], 0.7)),
    ]
  ),
  scene(
    "fridges.islands",
    "fridges",
    "Dondurucu adaları",
    {
      s1: wall("-z", -6.6, -8.4, 0, { len: 1.2, depth: 0.7 }, "chill"),
      s2: wall("-z", -6.6, -6.4, 0, { len: 1.2, depth: 0.7 }, "chill"),
      s3: wall("-z", -6.6, -2.4, 0, { len: 1.2, depth: 0.7 }, "chill"),
      s4: wall("-z", -6.6, -0.4, 0, { len: 1.2, depth: 0.7 }, "chill"),
      gap: wall("-x", -5.4, -7.1, 0, { len: 0.9, depth: 0.66 }, "chill"),
      east: wall("-x", 0.6, -7.1, 0, { len: 1.0, depth: 0.9 }, "chill"),
    },
    [
      variant("drinks", 2, pick(2, 3, item("s1", ["drinkCrate", "canTower"]), item("s2", ["drinkCrate", "basketStack"]), item("s3", ["drinkCrate", "canTower"]), item("s4", ["drinkCrate", "parcel"])), item("east", ["trashBin", "basketStack"], 0.6)),
      variant("bins", 1, item(["gap", "east"], "trashBin"), item(["s2", "s3"], ["canTower", "drinkCrate"], 0.8)),
      variant("boxes", 1, item(["s1", "s4"], "parcel"), item(["gap", "east"], ["drinkCrate", "basketStack"], 0.7)),
    ]
  ),

  // ── Depot ──────────────────────────────────────────────────────────────────
  scene(
    "depot.rack",
    "depot",
    "Depo rafı",
    {
      a: wall("-z", -9.6, 5.95, 0, { len: 1.6, depth: 1.15 }, "depot"),
      b: wall("-z", -9.6, 7.75, 0, { len: 1.6, depth: 1.15 }, "depot"),
      c: wall("-z", -9.6, 9.55, 0, { len: 1.6, depth: 1.15 }, "depot"),
    },
    [
      variant("pallets", 2, pick(2, 3, item("a", "palletBoxes"), item("b", "palletBoxes"), item("c", "palletBoxes")), item(["a", "c"], ["parcel", "drinkCrate"], 0.5)),
      variant("mixed", 1.5, item(["a", "b", "c"], "palletBoxes"), pick(1, 2, item("a", ["parcel", "drinkCrate", "canTower"]), item("b", ["parcel", "produceBin"]), item("c", [...CRATES, "parcel"]))),
      variant("boxes", 1, pick(2, 3, item("a", ["parcel", "drinkCrate"]), item("b", ["parcel", ...CRATES]), item("c", ["parcel", "produceBin"]))),
    ]
  ),
  scene(
    "depot.walls",
    "depot",
    "Depo duvarları",
    {
      east: wall("+x", I, -7.3, 0, { len: 1.4, depth: 1.2 }, "depot"),
      corner: corner(["+z", "-x"], [-6.3, 3.8], 0, { len: 0.95, depth: 0.65 }, "depot", { pocket: true }),
      front: wall("+z", -6.3, 9.4, 0, { len: 0.9, depth: 0.75 }, "depot"),
    },
    [
      variant("bins", 1.5, item("corner", "trashBin"), item("east", ["palletBoxes", "produceBin", "cart"], 0.8), item("front", ["drinkCrate", "parcel"], 0.5)),
      variant("boxes", 1.5, item("east", ["parcel", "palletBoxes"]), item("corner", ["parcel", "drinkCrate"], 0.7), item("front", "trashBin", 0.5)),
      variant("cart", 1, item("east", "cart"), item("corner", ["trashBin", "canTower"], 0.7)),
    ]
  ),

  // ── Checkout ───────────────────────────────────────────────────────────────
  scene(
    "checkout.lanes",
    "checkout",
    "Kasalar",
    {
      // Customers queue along each counter's east side (carts nose to tail); the cashier works on the west side.
      ...Object.fromEntries(
        CHECKOUTS.flatMap(([x0, x1], k) => [
          [`q${k}a`, free(x1 + 0.42, 7.5, 0, PARKED, "till", { turns: [0, 2] })],
          [`q${k}b`, free(x1 + 0.42, 8.7, 0, PARKED, "till", { turns: [0, 2] })],
          [`c${k}`, wall("+x", x0, 8.1, 0, { len: 1.0, depth: 0.72 }, "till")],
        ])
      ),
    },
    [
      variant("queue", 2, pick(2, 4, item(["q0a", "q0b"], "cart"), item(["q1a", "q1b"], "cart"), item(["q2a", "q2b"], "cart"), item(["q1a", "q2b"], "cart")), pick(2, 3, item("c0", ["basketStack", "trashBin"]), item("c1", ["trashBin", "drinkCrate"]), item("c2", ["basketStack", "canTower"]))),
      variant("baskets", 1.2, pick(1, 2, item("q0b", "cart"), item("q2a", "cart"), item("q1b", "cart")), pick(2, 3, item("c0", "basketStack"), item("c1", "basketStack"), item("c2", ["basketStack", "trashBin"]), item("q1a", "basketStack"))),
      variant("bins", 1, item(["c0", "c1", "c2"], "trashBin"), item(["c1", "c2"], "trashBin", 0.7), item(["q0a", "q1a", "q2a"], "cart")),
      variant("impulse", 0.8, item(["c0", "c2"], "canTower"), item("c1", ["drinkCrate", "canTower"]), item(["q0b", "q2b"], "cart", 0.7)),
    ]
  ),
  scene(
    "checkout.west",
    "checkout",
    "Kasa önü batı köşe",
    {
      corner: corner(["+z", "-x"], [I, -I], 0, "M", "till"),
      wallN: wall("-x", -I, 6.6, 0, { len: 1.2, depth: 1.0 }, "till"),
      island: free(-9.0, 7.75, 0, { len: 1.4, depth: 1.4 }, "till"),
    },
    [
      variant("drinks", 2, item("corner", "drinkCrate"), item("island", ["drinkCrate", "canTower"]), item("wallN", ["drinkCrate", "trashBin"], 0.6)),
      variant("carts", 1, item("island", "cart"), item("corner", ["drinkCrate", "basketStack"], 0.8), item("wallN", "trashBin", 0.6)),
      variant("cans", 1, item("island", "canTower"), item("corner", ["canTower", "drinkCrate"]), item("wallN", "basketStack", 0.5)),
    ]
  ),

  // ── Entrance ───────────────────────────────────────────────────────────────
  scene(
    "entrance.corral",
    "entrance",
    "Araba parkı",
    {
      // Two rows of carts nested nose to tail along the east wall (the second leaves a walkway to the wall when the first is short).
      ...Object.fromEntries([6.35, 7.5, 8.65, 9.8].flatMap((z, k) => [
        [`a${k}`, free(I - 0.42, z, 0, { len: 0.76, depth: 1.12 }, "entrance", { turns: [0] })],
        [`b${k}`, free(I - 1.5, z, 0, { len: 0.7, depth: 1.12 }, "entrance", { turns: [0] })],
      ])),
    },
    [
      variant("full", 1.5, item("a0", "cart"), item("a1", "cart"), item("a2", "cart"), item("a3", "cart", 0.7), pick(1, 3, item("b0", "cart"), item("b1", "cart"), item("b2", "cart"), item("b3", "cart"))),
      variant("row", 2, pick(2, 4, item("a0", "cart"), item("a1", "cart"), item("a2", "cart"), item("a3", "cart")), item(["b1", "b2"], ["cart", "trashBin"], 0.5)),
      variant("few", 1, pick(2, 3, item("a1", "cart"), item("a2", "cart"), item("b2", "cart"), item("a3", "cart")), item("b0", "trashBin", 0.6)),
    ]
  ),
  scene(
    "entrance.front",
    "entrance",
    "Giriş",
    {
      basketA: wall("+z", I, 4.55, 0, { len: 0.72, depth: 0.75 }, "entrance"),
      basketB: wall("+z", I, 5.3, 0, { len: 0.72, depth: 0.75 }, "entrance"),
      bin: wall("+z", I, 4.55, 0, { len: 0.72, depth: 0.75 }, "entrance"),
      promoA: free(5.6, 6.8, 0, { len: 1.6, depth: 1.3 }, "entrance", { turns: [0, 2] }),
      promoB: free(7.9, 6.6, 0, { len: 1.6, depth: 1.3 }, "entrance", { turns: [0, 2] }),
    },
    [
      variant("baskets", 2, item("basketA", "basketStack"), item("basketB", "basketStack", 0.8), item(["promoA", "promoB"], ["produceBin", "watermelon", "pumpkin", ...CRATES])),
      variant("promo", 1.5, item("promoA", ["produceBin", "drinkCrate", "canTower"]), item("promoB", ["watermelon", "pumpkin", "produceBin"]), item(["basketA", "basketB"], "basketStack")),
      variant("bin", 1, item("bin", "trashBin"), item("basketB", "basketStack"), item(["promoA", "promoB"], ["pumpkin", "watermelon", "drinkCrate"], 0.7)),
    ]
  ),
];

/** Market's recipes, indexed (the dealer and the bots read them through this). */
export const MARKET_SCENE_SET = sceneSet(MARKET_SCENES, MARKET_CONTEXT_FAMILIES, MARKET_FAMILY_SETTINGS);
