/** Small profile identity only. The mesh definitions remain client-side. */
export const SELECTABLE_COSTUME_IDS = ["cat", "anchovy", "gazelle"] as const;
export type SelectableCostumeId = (typeof SELECTABLE_COSTUME_IDS)[number];
export const DEFAULT_COSTUME_ID: SelectableCostumeId = "cat";

export function isSelectableCostumeId(value: unknown): value is SelectableCostumeId {
  return typeof value === "string" &&
    (SELECTABLE_COSTUME_IDS as readonly string[]).includes(value);
}

/** Old or malformed admission/storage values receive the same safe fallback. */
export function selectedCostumeId(value: unknown): SelectableCostumeId {
  return isSelectableCostumeId(value) ? value : DEFAULT_COSTUME_ID;
}
