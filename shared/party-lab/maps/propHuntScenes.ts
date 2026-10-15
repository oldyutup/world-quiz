import { CAMP, LODGE, LOFT, PORCH, SHED, WOODPILE } from "./propHunt.js";
import type { CampFamilyId, PropFamilyId } from "./propHuntProps.js";
import { corner, free, item, pick, sceneMaker, sceneSet, variant, wall, type PropScene, type Setting } from "./propScenes.js";
export { variantItems } from "./propScenes.js";
export type { PropScene, PropSlot, RecipeEntry, RecipeItem, RecipePick, SceneVariant, Setting, Side, Turn } from "./propScenes.js";

/**
 * Saklambaç's scene recipes: how each corner of Orman Kampı is dressed. The architecture, the
 * furniture and the landmarks never move; the ordinary decoys come from these authored scenes,
 * so a round's layout looks furnished on purpose rather than scattered:
 *
 *   match seed → round → which scenes change → each changed scene's variant → its props
 *
 * - A **scene** is one coherent group: the dining table's chairs, the shed's back wall, the
 *   yard's storage row, the fire ring, a stretch of the south fence. It owns a handful of
 *   **slots** (safe spots, each with a floor, a size, what it backs onto and a semantic
 *   context) and a few **variants**.
 * - A **variant** is a recipe: items (a slot out of a short list, a family out of a short list,
 *   sometimes only by chance) and picks ("two to four of these seats"). Counts are never fixed:
 *   the dining table seats two to five, the shed holds zero to five crates, the fire has two to
 *   four logs or stumps round it, a fence stretch one to three bushes, rocks or saplings.
 * - **Contexts** are the plausibility rules (CONTEXT_FAMILIES): living-room furniture indoors,
 *   storage in the shed and the yard, camp gear by the tents and the fire, nature along the
 *   edges. A slot only ever holds a family its context allows, so a dresser never stands by
 *   the campfire and a bush never grows in the dining room.
 * - Same-family clusters are normal (three chairs at the table, crates stacked along the shed
 *   wall, logs round the fire, bushes along the fence): there is no "never three of a kind"
 *   rule a hider joining a cluster would give away.
 *
 * The chopping block (the stump the yard's axe is stuck in) is the one fixed decoy: a
 * landmark, always there. propHuntLayout.ts places, validates and deals all of this.
 */

type F = PropFamilyId;

/** What kind of place a slot is: it decides which families are plausible there. */
export type Context = "home" | "homeStore" | "hearth" | "kitchen" | "porch" | "pavilion" | "storage" | "work" | "woodpile" | "campfire" | "camp" | "nature";
/** The families plausible in each context (the semantic rules; every recipe item respects them). */
export const CONTEXT_FAMILIES: Readonly<Record<string, readonly F[]>> = {
  /** The lodge's and the loft's living furniture. */
  home: ["chair", "nightstand", "dresser", "armchair", "sideTable", "pottedPlant", "backpack"],
  /** Indoor corners (under the stair's top, the loft's corner): storage, or a chair tucked away. */
  homeStore: ["crate", "backpack", "pottedPlant", "chair", "nightstand", "armchair"],
  /** Firewood by the fireplace. */
  hearth: ["log", "crate"],
  /** The kitchen's east wall (a pantry crate, a spare chair, a reading corner). */
  kitchen: ["chair", "crate", "backpack", "pottedPlant", "nightstand", "armchair"],
  porch: ["chair", "sideTable", "pottedPlant", "backpack", "crate", "log"],
  pavilion: ["chair", "pottedPlant", "backpack", "crate", "metalCan"],
  /** The shed. */
  storage: ["crate", "propane", "wheelieBin", "metalCan", "barrel", "sacks", "backpack", "log"],
  /** The work yard (the stump is its chopping block). */
  work: ["crate", "propane", "wheelieBin", "metalCan", "barrel", "sacks", "backpack", "log", "stump"],
  woodpile: ["crate", "backpack", "sacks"],
  campfire: ["log", "stump", "backpack", "crate", "boulder", "boulderB"],
  /** Beside the tents. */
  camp: ["log", "stump", "backpack", "crate", "propane"],
  /** The edges: the fence, the tent camp's corners, the open field. */
  nature: ["bush", "flowerBush", "boulder", "boulderB", "sapling", "log", "stump"],
} satisfies Record<Context, readonly F[]>;
export const CONTEXT_SETTING: Readonly<Record<string, Setting>> = {
  home: "indoor",
  homeStore: "indoor",
  hearth: "indoor",
  kitchen: "indoor",
  storage: "indoor",
  porch: "covered",
  pavilion: "covered",
  work: "outdoor",
  woodpile: "outdoor",
  campfire: "outdoor",
  camp: "outdoor",
  nature: "outdoor",
} satisfies Record<Context, Setting>;
/** Where each family can stand at all (a second, coarser check on the contexts). */
/** (Typed over every family for indexing; it holds the camp's twenty: a market family is never looked up here.) */
export const FAMILY_SETTINGS = {
  crate: ["indoor", "covered", "outdoor"],
  log: ["indoor", "covered", "outdoor"],
  stump: ["covered", "outdoor"],
  backpack: ["indoor", "covered", "outdoor"],
  propane: ["indoor", "outdoor"],
  wheelieBin: ["indoor", "outdoor"],
  metalCan: ["indoor", "covered", "outdoor"],
  chair: ["indoor", "covered"],
  nightstand: ["indoor"],
  dresser: ["indoor"],
  armchair: ["indoor", "covered"],
  sideTable: ["indoor", "covered"],
  pottedPlant: ["indoor", "covered"],
  flowerBush: ["outdoor"],
  bush: ["outdoor"],
  boulder: ["outdoor"],
  boulderB: ["outdoor"],
  sapling: ["outdoor"],
  barrel: ["indoor", "outdoor"],
  sacks: ["indoor", "outdoor"],
} satisfies Record<CampFamilyId, readonly Setting[]> as unknown as Readonly<Record<PropFamilyId, readonly Setting[]>>;

const scene = sceneMaker((context) => CONTEXT_SETTING[context as Context]);
const L = LODGE.floor,
  U = LOFT.top,
  P = PORCH.top,
  S = SHED.floor,
  W = WOODPILE.top,
  H = CAMP.half;
/** A lone chair on one side of the dining table: at either seat, now and then pulled back ("o"). */
const WEST_SEAT = ["W1", "W1", "W1o", "W2", "W2", "W2o"],
  EAST_SEAT = ["E1", "E1", "E1o", "E2", "E2", "E2o"];
const SEAT = { len: 0.6, depth: 0.6 };
const BUSHES: F[] = ["bush", "flowerBush"],
  ROCKS: F[] = ["boulder", "boulderB"];

export const PROP_SCENES: readonly PropScene[] = [
  // ── Lodge (+0.45) ─────────────────────────────────────────────────────────
  scene(
    "lodge.dining",
    "lodge",
    "Yemek masası",
    {
      // Two a side at the table, or three on one side; "o": pulled back 0.25 m (only a chair alone on its side:
      // pulled back beside a neighbour it would leave a squeeze).
      W1: wall("+x", -4.905, -6.9, L, SEAT, "home", { faceIn: true }),
      W2: wall("+x", -4.905, -5.7, L, SEAT, "home", { faceIn: true }),
      E1: wall("-x", -3.695, -6.9, L, SEAT, "home", { faceIn: true }),
      E2: wall("-x", -3.695, -5.7, L, SEAT, "home", { faceIn: true }),
      W1o: wall("+x", -5.155, -6.9, L, SEAT, "home", { faceIn: true }),
      W2o: wall("+x", -5.155, -5.7, L, SEAT, "home", { faceIn: true }),
      E1o: wall("-x", -3.445, -6.9, L, SEAT, "home", { faceIn: true }),
      E2o: wall("-x", -3.445, -5.7, L, SEAT, "home", { faceIn: true }),
      Wa: wall("+x", -4.905, -7.1, L, SEAT, "home", { faceIn: true }),
      Wb: wall("+x", -4.905, -6.3, L, SEAT, "home", { faceIn: true }),
      Wc: wall("+x", -4.905, -5.5, L, SEAT, "home", { faceIn: true }),
      Ea: wall("-x", -3.695, -7.1, L, SEAT, "home", { faceIn: true }),
      Eb: wall("-x", -3.695, -6.3, L, SEAT, "home", { faceIn: true }),
      Ec: wall("-x", -3.695, -5.5, L, SEAT, "home", { faceIn: true }),
      // The corner under the stair's top, a few steps from the table.
      nook: corner(["-z", "-x"], [-10.7, -3.3], L, { len: 1.4, depth: 1.4 }, "homeStore"),
    },
    [
      variant("four", 2, item("W1", "chair"), item("W2", "chair"), item("E1", "chair"), item("E2", "chair"), item("nook", ["crate", "backpack", "pottedPlant", "armchair"], 0.4)),
      // Two on one side; the one on the other side, alone there, is now and then pulled back.
      variant("threeWest", 1.25, item("W1", "chair"), item("W2", "chair"), item(EAST_SEAT, "chair"), item("nook", ["crate", "backpack", "pottedPlant", "armchair"], 0.6)),
      variant("threeEast", 1.25, item("E1", "chair"), item("E2", "chair"), item(WEST_SEAT, "chair"), item("nook", ["crate", "backpack", "pottedPlant", "armchair"], 0.6)),
      variant("twoApart", 1, item(WEST_SEAT, "chair"), item(EAST_SEAT, "chair"), item("nook", ["pottedPlant", "crate", "backpack"])),
      variant("twoWest", 0.25, item("W1", "chair"), item("W2", "chair"), item("nook", ["pottedPlant", "crate", "backpack"])),
      variant("twoEast", 0.25, item("E1", "chair"), item("E2", "chair"), item("nook", ["pottedPlant", "crate", "backpack"])),
      variant("longWest", 1, item("Wa", "chair"), item("Wb", "chair"), item("Wc", "chair"), pick(1, 2, item("E1", "chair"), item("E2", "chair")), item("nook", ["crate", "armchair"], 0.4)),
      variant("longEast", 1, item("Ea", "chair"), item("Eb", "chair"), item("Ec", "chair"), pick(1, 2, item("W1", "chair"), item("W2", "chair")), item("nook", ["pottedPlant", "armchair"], 0.4)),
    ]
  ),
  scene(
    "lodge.great",
    "lodge",
    "Oturma odası",
    {
      hearth: wall("-x", -9.98, -6.2, L, { len: 1.85, depth: 0.5 }, "hearth"),
      sofaWall: wall("+z", -2.8, -9.12, L, "L", "home"),
      corner: wall("+z", -2.8, -9.45, L, "S", "home"),
      couchEnd: wall("-z", -4.79, -8.6, L, "S", "home"),
    },
    [
      variant("sideboard", 2, item("sofaWall", "dresser"), item("hearth", "log", 0.7)),
      variant("table", 2, item("sofaWall", "sideTable"), item("hearth", "log", 0.7)),
      variant("couchEnd", 1.5, item("couchEnd", ["pottedPlant", "nightstand"]), item("corner", ["backpack", "pottedPlant", "chair"], 0.7), item("hearth", "log", 0.5)),
      variant("firewood", 1, item("hearth", "log"), item("corner", ["pottedPlant", "chair"], 0.8)),
    ]
  ),
  scene(
    "lodge.kitchen",
    "lodge",
    "Mutfak doğu duvarı",
    {
      north: wall("+x", 1.7, -9.2, L, "M", "kitchen"),
      middle: wall("+x", 1.7, -8.35, L, "M", "kitchen"),
      south: wall("+x", 1.7, -7.5, L, "M", "kitchen"),
    },
    [
      variant("pantry", 2, item("north", "crate"), item("south", ["crate", "backpack", "chair"], 0.8)),
      variant("chair", 1.5, item("south", "chair"), item("north", "crate", 0.8), item("middle", "backpack", 0.3)),
      variant("cabinet", 1, item("middle", "nightstand"), item("north", "backpack", 0.4)),
      variant("plant", 1, item("south", "pottedPlant"), item("north", ["backpack", "crate"], 0.7)),
      variant("armchair", 2, item("south", "armchair"), item("north", ["crate", "backpack"], 0.6)),
    ]
  ),
  scene(
    "lodge.south",
    "lodge",
    "Mutfak güney duvarı",
    {
      reading: wall("+z", -2.8, -2.35, L, "L", "home"),
      window: wall("+z", -2.8, -0.4, L, "LONG", "home"),
      corner: corner(["+z", "+x"], [-2.8, 1.7], L, { len: 0.9, depth: 0.9 }, "home"),
    },
    [
      variant("armchair", 2.5, item("reading", "armchair"), item("corner", ["pottedPlant", "nightstand"], 0.7), item("window", "dresser", 0.3)),
      variant("dresser", 2.5, item("window", "dresser"), item("reading", ["chair", "pottedPlant", "sideTable"], 0.7)),
      variant("table", 1.5, item("reading", "sideTable"), item("corner", ["chair", "pottedPlant"], 0.7)),
      variant("stands", 1, item("window", "dresser"), item("corner", "nightstand"), item("reading", "chair", 0.5)),
    ]
  ),

  // ── Loft (+3.65): a bunk room — never crowded ─────────────────────────────
  scene(
    "loft.bunk",
    "loft",
    "Ranza",
    {
      side: wall("+x", 0.34, -5.55, U, { len: 0.75, depth: 0.7 }, "home"),
      foot: corner(["-z", "+x"], [-5.1, 1.7], U, "S", "home"),
      corner: corner(["+z", "+x"], [-2.8, 1.7], U, "S", "homeStore"),
    },
    [
      variant("bedside", 2, item("foot", "nightstand"), item("corner", ["backpack", "crate"], 0.6)),
      variant("twoStands", 1, item("foot", "nightstand"), item("side", "nightstand")),
      variant("gear", 1.5, item("side", "nightstand"), item("foot", "backpack", 0.8)),
      variant("chair", 1, item("corner", "chair"), item("foot", "nightstand", 0.7)),
    ]
  ),
  scene(
    "loft.north",
    "loft",
    "Çatı katı kuzey duvarı",
    {
      west: wall("-z", -10.7, -0.7, U, { len: 2.0, depth: 0.75 }, "home"),
      east: wall("-z", -10.7, 0.8, U, { len: 0.95, depth: 0.6 }, "home"),
    },
    [
      variant("dresser", 4, item("west", "dresser"), item("east", ["backpack", "chair"], 0.5)),
      variant("chairs", 1, item("west", "chair"), item("east", "chair", 0.6)),
      variant("backpack", 0.8, item("east", "backpack"), item("west", "nightstand", 0.7)),
    ]
  ),
  scene(
    "loft.middle",
    "loft",
    "Çatı katı ortası",
    {
      // The middle keeps ≥ 1.27 m on both sides (the rail walk, the gap by the bunk bed): props ≤ 1 m.
      a: free(-1.43, -6.3, U, { len: 1.0, depth: 1.0 }, "home"),
      b: free(-1.43, -7.6, U, { len: 1.0, depth: 1.0 }, "homeStore"),
      c: free(-1.43, -6.95, U, { len: 1.0, depth: 1.0 }, "home"),
    },
    [
      variant("clear", 0.7),
      variant("one", 2, item(["a", "b", "c"], ["chair", "nightstand", "backpack", "pottedPlant"])),
      variant("storage", 1, item("b", "crate"), item("a", "backpack", 0.5)),
    ]
  ),
  scene(
    "loft.south",
    "loft",
    "Çatı katı güney duvarı",
    {
      wide: wall("+z", -2.8, -0.85, U, "L", "home"),
      small: wall("+z", -2.8, -1.5, U, { len: 0.8, depth: 0.8 }, "home"),
    },
    [
      variant("armchair", 2.5, item("wide", "armchair")),
      variant("dresser", 1.5, item("wide", "dresser")),
      variant("table", 1.5, item("wide", "sideTable")),
      variant("plant", 1, item("small", ["pottedPlant", "nightstand", "chair"])),
    ]
  ),

  // ── Porch (+0.45): along the lodge's south face, clear of the front walk and the doorway ──
  scene(
    "porch.west",
    "porch",
    "Sundurma batı",
    {
      corner: corner(["-z", "-x"], [-2.5, -H], P, "S", "porch"),
      seatA: wall("-z", -2.5, -9.55, P, "S", "porch"),
      seatB: wall("-z", -2.5, -8.6, P, "S", "porch"),
      bench: wall("-z", -2.5, -9.1, P, "LONG", "porch"),
    },
    [
      variant("pair", 2, item("seatA", "chair"), item("seatB", "chair"), item("corner", ["pottedPlant", "crate"], 0.8)),
      variant("chairPlant", 1.5, item(["seatA", "seatB"], "chair"), item("corner", "pottedPlant")),
      variant("gear", 1, item("corner", "crate"), item("seatA", "backpack", 0.8), item("seatB", "chair", 0.7)),
      variant("log", 1, item("bench", "log"), item("corner", ["pottedPlant", "crate"], 0.8)),
    ]
  ),
  scene(
    "porch.east",
    "porch",
    "Sundurma doğu",
    {
      plant: wall("-z", -2.5, -4.7, P, { len: 0.8, depth: 0.8 }, "porch"),
      seatL2: wall("-z", -2.5, -4.35, P, SEAT, "porch"),
      seatL1: wall("-z", -2.5, -3.65, P, SEAT, "porch"),
      table: wall("-z", -2.5, -2.7, P, { len: 1.3, depth: 1.25 }, "porch"),
      tableRight: wall("-z", -2.5, -1.9, P, { len: 1.3, depth: 1.25 }, "porch"),
      seatR1: wall("-z", -2.5, -1.75, P, SEAT, "porch"),
      seatR2: wall("-z", -2.5, -1.05, P, SEAT, "porch"),
      log: wall("-z", -2.5, 0.24, P, { len: 1.68, depth: 0.8 }, "porch"),
      end: wall("-z", -2.5, 1.54, P, { len: 0.92, depth: 0.95 }, "porch"),
    },
    [
      variant("tableTwo", 2, item("table", "sideTable"), item("seatL1", "chair"), item("seatR1", "chair"), item("end", ["crate", "backpack", "pottedPlant"], 0.8)),
      variant("tableOne", 1.5, item("table", "sideTable"), item(["seatL1", "seatR1"], "chair"), item("plant", "pottedPlant", 0.8), item("log", "log", 0.5)),
      variant("tableThree", 1, item("table", "sideTable"), item("seatL1", "chair"), item("seatL2", "chair"), item("seatR1", "chair"), item("end", "crate", 0.3)),
      variant("tableRight", 1.5, item("tableRight", "sideTable"), item("seatL1", "chair"), item("seatR2", "chair", 0.5), item("end", "pottedPlant", 0.6)),
      variant("gear", 1, item("end", "crate"), item("log", "log", 0.7), item("plant", "pottedPlant", 0.7), item("seatR2", "chair", 0.5)),
    ]
  ),

  // ── The woodpile's top (+1.2), north of the route onto the lean-to roof ──
  scene(
    "leanTo.woodpile",
    "leanTo",
    "Odun yığını",
    {
      north: corner(["-z", "+x"], [-H, 6.5], W, "S", "woodpile"),
      northWest: corner(["-z", "-x"], [-H, 5.0], W, "S", "woodpile"),
      middle: wall("+x", 6.5, -9.4, W, "S", "woodpile"),
      sacks: wall("-z", -H, 5.75, W, { len: 1.5, depth: 1.2 }, "woodpile"),
    },
    [variant("bare", 0.8), variant("crate", 1.5, item(["north", "northWest"], "crate"), item("middle", "backpack", 0.3)), variant("crateBackpack", 1, item("northWest", "crate"), item("middle", "backpack")), variant("sacks", 1.2, item("sacks", "sacks"), item("middle", "backpack", 0.5))]
  ),

  // ── Shed (+0.15) ──
  scene(
    "shed.north",
    "shed",
    "Kulübe arka duvarı",
    {
      west: corner(["-z", "-x"], [-10.7, 6.8], S, "S", "storage"),
      middle: wall("-z", -10.7, 8.225, S, "S", "storage"),
      wide: wall("-z", -10.7, 9.4, S, "M", "storage"),
      east: corner(["-z", "+x"], [-10.7, 10.7], S, "S", "storage"),
    },
    [
      variant("crates", 2, pick(1, 3, item("west", "crate"), item("middle", "crate"), item(["wide", "east"], "crate"))),
      variant("crateBarrel", 1.5, item("west", "crate"), item("middle", "barrel"), item("east", ["crate", "metalCan"], 0.8)),
      variant("sacksCrate", 1.5, item("wide", "sacks"), item("west", "crate"), item("middle", "crate", 0.8)),
      variant("propaneCrate", 1, item("east", "propane"), item("middle", "crate"), item("west", "crate", 0.8)),
      variant("barrels", 1, pick(2, 3, item("west", "barrel"), item("middle", "barrel"), item("east", "barrel"))),
    ]
  ),
  scene(
    "shed.west",
    "shed",
    "Kulübe batı duvarı",
    {
      long: wall("-x", 6.8, -8.85, S, "LONG", "storage"),
      door: wall("-x", 6.8, -7.5, S, "S", "storage"),
    },
    [
      variant("bin", 1.5, item("door", ["wheelieBin", "metalCan"]), item("long", ["crate", "barrel"], 0.9)),
      variant("crateBackpack", 1.5, item("long", "crate"), item("door", ["backpack", "wheelieBin"], 0.9)),
      variant("log", 1, item("long", "log"), item("door", "propane", 0.8)),
      variant("barrels", 1, item("long", "barrel"), item("door", "barrel", 0.9)),
    ]
  ),
  scene(
    "shed.east",
    "shed",
    "Kulübe doğu duvarı",
    {
      south: wall("+x", 10.7, -7.7, S, "M", "storage"),
      north: wall("+x", 10.7, -8.9, S, "M", "storage"),
    },
    [
      variant("barrelPropane", 1.5, item("north", "barrel"), item("south", "propane", 0.9)),
      variant("sacks", 1.5, item("north", "sacks"), item("south", ["crate", "metalCan"], 0.9)),
      variant("binCrate", 1, item("south", "wheelieBin"), item("north", "crate", 0.9)),
      variant("can", 1, item("south", "metalCan"), item("north", ["barrel", "sacks"], 0.9)),
    ]
  ),

  // ── Work yard (ground) ──
  // The chopping block by the wagon (the axe stands in it): a landmark decoy, always there.
  scene("yard.chop", "yard", "Kütük kesme yeri", { block: wall("+z", -2.925, 6.1, 0, { len: 0.72, depth: 0.72 }, "work") }, [variant("block", 1, item("block", "stump"))], true),
  scene(
    "yard.wagon",
    "yard",
    "Araba çevresi",
    {
      north: wall("+z", -2.925, 7.6, 0, { len: 1.6, depth: 0.6 }, "work"),
      west: wall("+x", 5.2, -1.975, 0, "S", "work"),
      south: wall("-z", -1.025, 6.8, 0, { len: 1.85, depth: 1.2 }, "work"),
    },
    [
      variant("firewood", 1.5, item("north", "log"), item("south", ["log", "sacks"], 0.8), item("west", "crate", 0.4)),
      variant("sacks", 1.5, item("south", "sacks"), item("west", "crate", 0.7)),
      variant("barrel", 1, item("west", "barrel"), item("south", "crate", 0.8)),
      variant("gear", 1, item("north", "backpack"), item("west", ["crate", "propane"], 0.8), item("south", "barrel", 0.5)),
    ]
  ),
  scene(
    "yard.east",
    "yard",
    "Avlu depo sırası",
    {
      a: wall("+x", H, -3.7, 0, "S", "work"),
      b: wall("+x", H, -2.75, 0, "S", "work"),
      c: wall("+x", H, -1.8, 0, "S", "work"),
      d: wall("+x", H, -0.7, 0, "M", "work"),
      ab: wall("+x", H, -3.25, 0, "M", "work"),
      cd: wall("+x", H, -1.3, 0, "S", "work"),
      yard: free(8.9, -3.3, 0, "S", "work"),
    },
    [
      variant("cratesBarrel", 1.5, item("a", "crate"), item("b", "crate"), item("c", "barrel"), item("yard", "barrel", 0.3)),
      variant("cratesSacks", 1.5, item("a", "crate"), item("b", "crate"), item("c", "crate"), item("d", "sacks")),
      variant("barrelPropane", 1.5, item("a", "barrel"), item("b", "propane"), item("c", "crate"), item("d", ["sacks", "crate"], 0.5)),
      variant("bins", 1.2, item("a", "wheelieBin"), item("b", ["wheelieBin", "metalCan"]), item("c", "crate"), item("d", "backpack", 0.6)),
      variant("barrelsSacks", 1, item("b", "barrel"), item("c", "barrel"), item("d", "sacks"), item("a", "crate", 0.6)),
      variant("sacksCrate", 1, item("ab", "sacks"), item("cd", "barrel"), item("d", "crate", 0.6), item("yard", "crate", 0.4)),
    ]
  ),
  scene(
    "yard.shedFront",
    "yard",
    "Kulübe önü",
    {
      west: wall("-z", -5.5, 6.9, 0, { len: 0.8, depth: 0.78 }, "work"),
      east: corner(["-z", "+x"], [-5.5, H], 0, { len: 0.9, depth: 0.95 }, "work"),
    },
    [
      variant("propane", 1.5, item("west", "propane"), item("east", "barrel", 0.85)),
      variant("bins", 1.5, item("east", "wheelieBin"), item("west", "metalCan", 0.85)),
      variant("gas", 0.8, item("west", "propane"), item("east", "propane")),
      variant("barrel", 1, item("east", "barrel"), item("west", ["metalCan", "propane"], 0.85)),
    ]
  ),
  scene(
    "yard.leanTo",
    "yard",
    "Odunluk önü",
    {
      long: wall("-z", -7.0, 3.1, 0, { len: 1.8, depth: 0.6 }, "work"),
      end: wall("-z", -7.0, 4.5, 0, { len: 0.95, depth: 0.95 }, "work"),
    },
    [
      variant("firewood", 2, item("long", "log"), item("end", ["crate", "propane"], 0.9)),
      variant("propane", 1, item("end", "propane"), item("long", ["backpack", "log"], 0.7)),
      variant("barrel", 1, item("end", "barrel"), item("long", "log", 0.8)),
      variant("crate", 1, item("end", "crate"), item("long", "log", 0.7)),
    ]
  ),
  scene(
    "yard.lodgeSide",
    "yard",
    "Ev yanı",
    {
      bin: wall("-x", 2.0, -3.3, 0, "S", "work"),
      field: free(4.4, -0.75, 0, "S", "work"),
    },
    [
      variant("trash", 2, item("bin", ["wheelieBin", "metalCan"]), item("field", ["crate", "barrel"], 0.5)),
      variant("trashField", 1, item("bin", "wheelieBin"), item("field", ["barrel", "crate"])),
      variant("field", 1, item("field", ["crate", "barrel", "propane"]), item("bin", "metalCan", 0.7)),
    ]
  ),

  // ── Campfire plaza (ground): two to four logs or stumps round the fire ──
  scene(
    "plaza.fire",
    "plaza",
    "Kamp ateşi",
    {
      n: free(-1, 2.4, 0, { len: 1.5, depth: 0.75 }, "campfire", { turns: [0] }),
      s: free(-1, 7.6, 0, { len: 1.5, depth: 0.75 }, "campfire", { turns: [0] }),
      w: free(-3.6, 5.0, 0, { len: 0.75, depth: 1.5 }, "campfire", { turns: [1] }),
      e: free(1.6, 5.0, 0, { len: 0.75, depth: 1.5 }, "campfire", { turns: [1] }),
      ne: free(0.85, 3.15, 0, { len: 0.95, depth: 0.95 }, "campfire"),
      nw: free(-2.85, 3.15, 0, { len: 0.95, depth: 0.95 }, "campfire"),
      se: free(0.85, 6.85, 0, { len: 0.95, depth: 0.95 }, "campfire"),
      sw: free(-2.85, 6.85, 0, { len: 0.95, depth: 0.95 }, "campfire"),
    },
    [
      // Seats (logs, stumps) come only from the recipe; the optional extras are gear.
      variant("fourLogs", 1, item("n", "log"), item("s", "log"), item("w", "log"), item("e", "log"), item(["ne", "nw", "se", "sw"], ["backpack", "crate"], 0.4)),
      variant("threeLogs", 2, pick(3, 3, item("n", "log"), item("s", "log"), item("w", "log"), item("e", "log")), item(["ne", "nw", "se", "sw"], ["backpack", "crate"], 0.5)),
      variant("twoLogsStump", 1.2, pick(2, 2, item("n", "log"), item("s", "log"), item("w", "log"), item("e", "log")), pick(1, 1, item("ne", "stump"), item("nw", "stump"), item("se", "stump"), item("sw", "stump")), item(["ne", "nw", "se", "sw"], ["backpack", "crate"], 0.3)),
      variant("mixed", 0.8, pick(2, 2, item("n", "log"), item("s", "log"), item("w", "log"), item("e", "log")), pick(2, 2, item("ne", "stump"), item("nw", "stump"), item("se", "stump"), item("sw", "stump"))),
      variant("stumps", 1, pick(2, 3, item("ne", "stump"), item("nw", "stump"), item("se", "stump"), item("sw", "stump")), item(["n", "s", "w", "e"], "log", 0.5)),
      variant("twoLogs", 1, pick(2, 2, item("n", "log"), item("s", "log"), item("w", "log"), item("e", "log")), item(["ne", "nw", "se", "sw"], ["backpack", "crate"], 0.8)),
    ]
  ),
  scene(
    "plaza.edge",
    "plaza",
    "Meydan kenarı",
    {
      bush: free(-4.35, 6.5, 0, "M", "nature"),
      south: free(-2.2, 8.7, 0, "S", "campfire"),
      southEast: free(1.3, 8.9, 0, "S", "campfire"),
      rock: free(2.5, 6.2, 0, "M", "campfire"),
      east: free(3.0, 3.2, 0, "S", "campfire"),
    },
    [
      variant("rock", 1.5, item("rock", ROCKS), item("south", ["backpack", "crate"], 0.8), item("bush", BUSHES, 0.4)),
      variant("bush", 1.5, item("bush", BUSHES), item("southEast", ["crate", "stump"], 0.8), item("east", ["crate", "backpack"], 0.5)),
      variant("gear", 1, item("south", "crate"), item("southEast", "backpack", 0.7), item("rock", ROCKS, 0.5), item("east", "stump", 0.5)),
      variant("stump", 1, item("southEast", "stump"), item("bush", "bush", 0.7), item("rock", ROCKS, 0.5)),
    ]
  ),

  // ── Tent camp (ground) ──
  scene(
    "camp.tent1",
    "camp",
    "Büyük çadır",
    {
      a: wall("-x", -8.2, 3.0, 0, "S", "camp"),
      long: wall("-x", -8.2, 4.2, 0, { len: 1.85, depth: 0.8 }, "camp"),
      b: wall("-x", -8.2, 5.4, 0, "S", "camp"),
      door: wall("-z", 6.3, -8.9, 0, "S", "camp", { pocket: true }),
    },
    [
      variant("gear", 2, item("a", "backpack"), item("b", "stump", 0.8), item("door", "crate", 0.5)),
      variant("log", 1.5, item("long", "log"), item("a", "backpack", 0.7), item("door", ["backpack", "crate"], 0.5)),
      variant("crate", 1, item("b", "crate"), item("door", "backpack", 0.8), item("a", "stump", 0.5)),
      variant("propane", 1, item("a", "propane"), item("b", "crate", 0.8), item("door", "backpack", 0.4)),
    ]
  ),
  scene(
    "camp.tent2",
    "camp",
    "Küçük çadır",
    {
      door: wall("-x", -6.2, 9.0, 0, "S", "camp"),
      corner: corner(["+z", "-x"], [H, -6.2], 0, "S", "camp"),
      free: free(-4.7, 8.6, 0, "S", "camp"),
    },
    [
      variant("gear", 2, item("door", "backpack"), item("corner", "crate", 0.8), item("free", "stump", 0.4)),
      variant("stumps", 1.5, item("free", "stump"), item("door", "stump", 0.8)),
      variant("crate", 1, item("corner", "crate"), item("door", "propane", 0.5), item("free", ["stump", "backpack"], 0.5)),
      variant("backpackStump", 1, item("door", "backpack"), item("free", "stump")),
    ]
  ),
  scene(
    "camp.nature",
    "camp",
    "Kamp doğası",
    {
      nook: corner(["-z", "-x"], [6.3, -H], 0, "M", "nature", { pocket: true }),
      rock: free(-5.0, 3.0, 0, "M", "nature"),
      bush: free(-6.3, 7.35, 0, "M", "nature"),
      a: free(-5.5, 3.8, 0, "S", "nature"),
      b: free(-5.5, 6.6, 0, "S", "nature"),
      south: wall("+z", H, -4.55, 0, "M", "nature"),
      logSpot: free(-5.6, 5.2, 0, { len: 1.6, depth: 0.8 }, "nature", { turns: [0] }),
    },
    [
      variant("rocks", 1.5, item("rock", ROCKS), item("bush", ["boulderB", "bush"], 0.8), item("south", "sapling", 0.3)),
      variant("bushes", 1.5, item("nook", BUSHES), item("bush", BUSHES), item("south", "sapling", 0.8), item("a", "stump", 0.4)),
      variant("sapling", 1, item("south", "sapling"), item("b", "stump", 0.8), item("rock", ROCKS, 0.8)),
      variant("log", 1, item("logSpot", "log"), item("a", "stump", 0.8), item("nook", "bush", 0.7), item("south", "sapling", 0.4)),
    ]
  ),

  // ── Picnic pavilion (ground, under the roof): the tables stay, chairs come and go ──
  scene(
    "pavilion.chairs",
    "pavilion",
    "Piknik sandalyeleri",
    {
      aN: wall("+z", 5.05, 5.95, 0, { len: 0.8, depth: 0.95 }, "pavilion", { faceIn: true }),
      aS: wall("-z", 6.95, 5.95, 0, { len: 0.8, depth: 0.95 }, "pavilion", { faceIn: true }),
      bN: wall("+z", 5.05, 8.05, 0, { len: 0.8, depth: 0.95 }, "pavilion", { faceIn: true }),
      bS: wall("-z", 6.95, 8.05, 0, { len: 0.8, depth: 0.95 }, "pavilion", { faceIn: true }),
    },
    [
      variant("one", 1, item(["aN", "aS", "bN", "bS"], "chair")),
      variant("two", 2, pick(2, 2, item("aN", "chair"), item("aS", "chair"), item("bN", "chair"), item("bS", "chair"))),
      variant("three", 1.5, pick(3, 3, item("aN", "chair"), item("aS", "chair"), item("bN", "chair"), item("bS", "chair"))),
      variant("four", 1, item("aN", "chair"), item("aS", "chair"), item("bN", "chair"), item("bS", "chair")),
    ]
  ),
  scene(
    "pavilion.edge",
    "pavilion",
    "Piknik kenarı",
    {
      west: wall("+x", 4.85, 6.0, 0, "S", "pavilion"),
      nw: free(4.35, 4.6, 0, "S", "pavilion"),
      sw: free(4.35, 7.4, 0, "S", "pavilion"),
      outside: free(7.7, 3.0, 0, "S", "camp", { zone: "pavilion" }),
    },
    [
      variant("trash", 1.5, item("nw", "metalCan"), item("sw", ["backpack", "crate"], 0.8), item("west", "crate", 0.4)),
      variant("cooler", 1.5, item("west", "crate"), item("nw", ["backpack", "metalCan"], 0.9), item("outside", ["crate", "backpack"], 0.5)),
      variant("plant", 1, item("sw", "pottedPlant"), item("nw", "metalCan", 0.7), item("west", "chair", 0.4)),
      variant("chair", 1, item("west", "chair"), item("sw", "backpack", 0.7), item("outside", "stump", 0.5)),
    ]
  ),

  // ── Border (ground): the south fence, the south-east corner, the open field ──
  scene(
    "border.southWest",
    "border",
    "Güney çiti batı",
    {
      a: wall("+z", H, -3.1, 0, "M", "nature"),
      b: wall("+z", H, -1.5, 0, "M", "nature"),
      c: wall("+z", H, 0.25, 0, "S", "nature"),
      log: wall("+z", H, -2.3, 0, { len: 1.6, depth: 0.6 }, "nature"),
    },
    [
      variant("bushes", 2, pick(1, 2, item("a", BUSHES), item("b", BUSHES)), item("c", "stump", 0.7)),
      variant("rocks", 1.5, pick(2, 2, item("a", ROCKS), item("b", ROCKS)), item("c", "stump", 0.5)),
      variant("mixed", 1.5, item("a", BUSHES), item("b", ROCKS), item("c", "stump", 0.6)),
      variant("log", 1, item("log", "log"), item("c", "stump", 0.8), item("a", BUSHES, 0.5)),
    ]
  ),
  scene(
    "border.southMiddle",
    "border",
    "Güney çiti orta",
    {
      a: wall("+z", H, 1.1, 0, "M", "nature"),
      b: wall("+z", H, 1.9, 0, "M", "nature"),
      c: wall("+z", H, 2.7, 0, "M", "nature"),
      d: wall("+z", H, 3.5, 0, "M", "nature"),
      e: wall("+z", H, 4.4, 0, "M", "nature"),
      log: wall("+z", H, 2.7, 0, { len: 1.6, depth: 0.6 }, "nature"),
    },
    [
      variant("bushes", 2, pick(2, 3, item("a", BUSHES), item("c", BUSHES), item("e", BUSHES))),
      variant("sapling", 1.5, item(["b", "d"], "sapling"), item(["a", "e"], [...BUSHES, "sapling"], 0.8)),
      variant("rocks", 1.5, item(["a", "b"], ROCKS), item(["d", "e"], [...ROCKS, "sapling"], 0.8)),
      variant("log", 1, item("log", "log"), item("e", ["stump", "sapling"], 0.7), item("a", BUSHES, 0.6)),
    ]
  ),
  scene(
    "border.southEast",
    "border",
    "Güney çiti doğu",
    {
      a: wall("+z", H, 5.3, 0, "M", "nature"),
      b: wall("+z", H, 6.2, 0, "M", "nature"),
      c: wall("+z", H, 7.05, 0, "M", "nature"),
      d: wall("+z", H, 7.8, 0, "M", "nature"),
      e: wall("+z", H, 8.55, 0, "M", "nature"),
      log: wall("+z", H, 6.6, 0, { len: 1.6, depth: 0.6 }, "nature"),
    },
    [
      variant("bushes", 2, pick(2, 3, item("a", BUSHES), item("c", BUSHES), item("e", BUSHES))),
      variant("sapling", 1.5, item(["a", "b"], "sapling"), item(["d", "e"], ["sapling", ...BUSHES])),
      variant("rocks", 1.5, item(["b", "c"], ROCKS), item("e", [...BUSHES, ...ROCKS], 0.9), item("a", "sapling", 0.4)),
      variant("log", 1, item("log", "log"), item("e", "stump", 0.7), item("a", ROCKS, 0.4)),
    ]
  ),
  scene(
    "border.corner",
    "border",
    "Güneydoğu köşe",
    {
      corner: corner(["+z", "+x"], [H, H], 0, "M", "nature"),
      east: wall("+x", H, 1.2, 0, "M", "nature"),
      pavilion: wall("+x", H, 2.8, 0, "M", "nature", { zone: "pavilion" }),
    },
    [
      variant("bushes", 1.5, item("corner", BUSHES), item("east", BUSHES, 0.8), item("pavilion", ROCKS, 0.4)),
      variant("rock", 1.5, item("corner", ROCKS), item("pavilion", [...BUSHES, "sapling"], 0.8), item("east", "bush", 0.4)),
      variant("sapling", 1, item("corner", "sapling"), item("east", ROCKS, 0.8)),
      variant("east", 1, item("east", ["bush", "sapling"]), item("pavilion", ROCKS, 0.7), item("corner", BUSHES, 0.4)),
    ]
  ),
  scene(
    "border.field",
    "border",
    "Açıklık",
    {
      a: free(7.0, 2.0, 0, "M", "nature"),
      b: free(5.2, 1.6, 0, "M", "nature"),
    },
    [variant("rock", 1.5, item("a", ROCKS), item("b", "stump", 0.6)), variant("stump", 1, item("b", "stump"), item("a", BUSHES, 0.8)), variant("bush", 1, item("a", BUSHES), item("b", ["stump", "sapling"], 0.8)), variant("open", 0.3)]
  ),
];

/** The camp's recipes, indexed (the dealer and the bots read a map's scenes through this). */
export const CAMP_SCENES = sceneSet(PROP_SCENES, CONTEXT_FAMILIES, FAMILY_SETTINGS);
export const PROP_SLOTS = CAMP_SCENES.slots;
export const slotById = CAMP_SCENES.slotById;
export const sceneById = CAMP_SCENES.sceneById;
/** Every family a recipe may put in each slot (hider bots look for empty ones among these). */
export const SLOT_FAMILIES = CAMP_SCENES.slotFamilies;
