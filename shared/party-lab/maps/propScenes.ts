import type { PropFamilyId } from "./propHuntProps.js";
import type { ZoneId } from "./propTypes.js";

/**
 * Saklambaç's scene recipes, the generic part (every map's recipes are built with these):
 *
 *   match seed → round → which scenes change → each changed scene's variant → its props
 *
 * - A **scene** is one coherent group (the dining table's chairs, a shelf aisle's end cap). It
 *   owns a handful of **slots** (safe spots, each with a floor, a size, what it backs onto and a
 *   semantic context) and a few **variants**.
 * - A **variant** is a recipe: items (a slot out of a short list, a family out of a short list,
 *   sometimes only by chance) and picks ("two to four of these seats").
 * - **Contexts** are a map's plausibility rules (which families a slot may hold).
 *
 * Orman Kampı's recipes are in propHuntScenes.ts, Market's in marketScenes.ts; the dealer
 * (propDealer.ts) places, validates and deals them.
 */

type Span = readonly [number, number];
type F = PropFamilyId;
export type Turn = 0 | 1 | 2 | 3;
/** The side of the slot the solid it backs onto is on ("-z": a wall to its north). */
export type Side = "-x" | "+x" | "-z" | "+z";
export type Setting = "indoor" | "covered" | "outdoor";

export interface PropSlot {
  /** "<scene>.<name>". */
  readonly id: string;
  readonly scene: string;
  readonly zone: ZoneId;
  /** Its map's context name (the map's `contextFamilies` key). */
  readonly context: string;
  readonly setting: Setting;
  /** The floor it stands on (m). */
  readonly y: number;
  /** Where a prop placed here may be (world rectangle, m): it never reaches outside it. */
  readonly x: Span;
  readonly z: Span;
  /** What it backs onto: the prop sits flush against these sides and faces away from the first ([]: free-standing). */
  readonly against: readonly Side[];
  /** Faces toward what it backs onto instead (chairs at a table). */
  readonly faceIn: boolean;
  /** Quarter turns a free-standing box may take. */
  readonly turns: readonly Turn[];
  /** A dead-end nook: gaps there are pockets, not passages (no squeeze rule). */
  readonly pocket: boolean;
}
/** Slot size presets (footprint along × deep): S 0.95 m, M 1.4 m, L 1.85 × 1.3 m, LONG 1.85 × 0.95 m. */
const SIZE = { S: { len: 0.95, depth: 0.95 }, M: { len: 1.4, depth: 1.4 }, L: { len: 1.85, depth: 1.3 }, LONG: { len: 1.85, depth: 0.95 } } as const;
export type Size = keyof typeof SIZE | { len: number; depth: number };
export interface SlotOptions {
  faceIn?: boolean;
  pocket?: boolean;
  turns?: readonly Turn[];
  /** A slot of another zone than its scene's (a scene straddling a zone line). */
  zone?: ZoneId;
}
/** A slot before its scene names it. */
export interface SlotSpec {
  readonly x: Span;
  readonly z: Span;
  readonly y: number;
  readonly against: readonly Side[];
  readonly context: string;
  readonly o: SlotOptions;
}
const dims = (size: Size) => (typeof size === "string" ? SIZE[size] : size);
/** Against a solid on `side` whose face is at `face`, centred at `at` along it. */
export function wall(side: Side, face: number, at: number, y: number, size: Size, context: string, o: SlotOptions = {}): SlotSpec {
  const { len, depth } = dims(size),
    along: Span = [at - len / 2, at + len / 2],
    across: Span = side[0] === "-" ? [face, face + depth] : [face - depth, face];
  return side[1] === "z" ? { x: along, z: across, y, against: [side], context, o } : { x: across, z: along, y, against: [side], context, o };
}
/** In the corner of two solids: flush against both; faces away from the first. */
export function corner(sides: readonly [Side, Side], faces: readonly [number, number], y: number, size: Size, context: string, o: SlotOptions = {}): SlotSpec {
  const { len, depth } = dims(size);
  const span = (side: Side, face: number, extent: number): Span => (side[0] === "-" ? [face, face + extent] : [face - extent, face]);
  // The first side's wall runs along the slot's length; the second closes its end.
  const [a, b] = sides,
    first = span(a, faces[0], depth),
    second = span(b, faces[1], len);
  return a[1] === "z" ? { x: second, z: first, y, against: sides, context, o } : { x: first, z: second, y, against: sides, context, o };
}
/** Free-standing, centred at (x, z) (`len` along x, `depth` along z). */
export function free(x: number, z: number, y: number, size: Size, context: string, o: SlotOptions = {}): SlotSpec {
  const { len, depth } = dims(size);
  return { x: [x - len / 2, x + len / 2], z: [z - depth / 2, z + depth / 2], y, against: [], context, o };
}

// ─── Recipes ────────────────────────────────────────────────────────────────

/** One prop: a slot out of `slots` (repeats weight the draw) and a family out of `families`, with this chance. */
export interface RecipeItem {
  readonly slots: readonly string[];
  readonly families: readonly F[];
  readonly chance: number;
}
/** Between `count[0]` and `count[1]` (uniform) of these items, drawn at random. */
export interface RecipePick {
  readonly count: readonly [number, number];
  readonly of: readonly RecipeItem[];
}
export type RecipeEntry = RecipeItem | RecipePick;
export interface SceneVariant {
  readonly id: string;
  readonly weight: number;
  readonly entries: readonly RecipeEntry[];
}
export interface PropScene {
  readonly id: string;
  readonly zone: ZoneId;
  /** Turkish name (debug readout, docs). */
  readonly label: string;
  /** Always the same (a landmark decoy): never changes between rounds. */
  readonly fixed: boolean;
  readonly slots: readonly PropSlot[];
  readonly variants: readonly SceneVariant[];
}
export const item = (slots: string | readonly string[], families: F | readonly F[], chance = 1): RecipeItem => ({ slots: typeof slots === "string" ? [slots] : slots, families: typeof families === "string" ? [families] : families, chance });
export const pick = (min: number, max: number, ...of: RecipeItem[]): RecipePick => ({ count: [min, max], of });
export const variant = (id: string, weight: number, ...entries: RecipeEntry[]): SceneVariant => ({ id, weight, entries });
/** A map's scene builder: `setting` gives each of its contexts' setting (indoor, covered, outdoor). */
export function sceneMaker(setting: (context: string) => Setting) {
  return function scene(id: string, zone: ZoneId, label: string, specs: Record<string, SlotSpec>, variants: readonly SceneVariant[], fixed = false): PropScene {
    const slots = Object.entries(specs).map(([name, s]): PropSlot => ({
      id: `${id}.${name}`,
      scene: id,
      zone: s.o.zone ?? zone,
      context: s.context,
      setting: setting(s.context),
      y: s.y,
      x: s.x,
      z: s.z,
      against: s.against,
      faceIn: s.o.faceIn ?? false,
      turns: s.o.turns ?? [0, 1, 2, 3],
      pocket: s.o.pocket ?? false,
    }));
    // Recipes name slots locally ("W1"); stored with the scene's prefix.
    const local = (name: string) => {
      if (!(name in specs)) throw new Error(`scene ${id}: no slot ${name}`);
      return `${id}.${name}`;
    };
    const qualify = (i: RecipeItem): RecipeItem => ({ ...i, slots: i.slots.map(local) });
    return {
      id,
      zone,
      label,
      fixed,
      slots,
      variants: variants.map((v) => ({ ...v, entries: v.entries.map((e) => ("count" in e ? { ...e, of: e.of.map(qualify) } : qualify(e))) })),
    };
  };
}
/** The recipe items of a scene's variant, flattened (picks included). */
export const variantItems = (v: SceneVariant): RecipeItem[] => v.entries.flatMap((e) => ("count" in e ? e.of : [e]));

/** A map's recipes, indexed: what the dealer and the bots read. */
export interface SceneSet {
  readonly scenes: readonly PropScene[];
  readonly slots: readonly PropSlot[];
  slotById(id: string): PropSlot | null;
  sceneById(id: string): PropScene | null;
  /** Every family a recipe may put in each slot (hider bots look for empty ones among these). */
  readonly slotFamilies: ReadonlyMap<string, readonly F[]>;
  /** The families plausible in each of the map's contexts. */
  readonly contextFamilies: Readonly<Record<string, readonly F[]>>;
  /** Where each of the map's families can stand at all (a second, coarser check on the contexts). */
  readonly familySettings: Readonly<Partial<Record<F, readonly Setting[]>>>;
}
export function sceneSet(scenes: readonly PropScene[], contextFamilies: Readonly<Record<string, readonly F[]>>, familySettings: Readonly<Partial<Record<F, readonly Setting[]>>>): SceneSet {
  const slots = scenes.flatMap((s) => s.slots);
  const slotMap = new Map(slots.map((s) => [s.id, s]));
  const sceneMap = new Map(scenes.map((s) => [s.id, s]));
  const families = new Map<string, Set<F>>();
  for (const s of scenes) for (const v of s.variants) for (const i of variantItems(v)) for (const slot of i.slots) for (const f of i.families) (families.get(slot) ?? families.set(slot, new Set()).get(slot)!).add(f);
  return {
    scenes,
    slots,
    slotById: (id) => slotMap.get(id) ?? null,
    sceneById: (id) => sceneMap.get(id) ?? null,
    slotFamilies: new Map([...families].map(([k, v]) => [k, [...v]])),
    contextFamilies,
    familySettings,
  };
}
