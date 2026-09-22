import { validBindings, type Bindings } from "./bindings";
import { defaultBindings } from "./defaults";
export const CONTROLS_KEY = "party-lab-controls-v1";
type StorageAccess = Pick<Storage, "getItem" | "setItem">;
export const serializeControls = (bindings: Bindings) =>
  JSON.stringify({ version: 1, bindings });
export function deserializeControls(raw: string | null): Bindings {
  try {
    const data: unknown = JSON.parse(raw ?? "null");
    if (
      data &&
      typeof data === "object" &&
      "version" in data &&
      data.version === 1 &&
      "bindings" in data &&
      validBindings(data.bindings)
    )
      return data.bindings;
  } catch {
    /* Malformed or older data cannot disable essential actions. */
  }
  return defaultBindings();
}
export function loadControls(storage?: StorageAccess): Bindings {
  try {
    return deserializeControls(
      (storage ?? window.localStorage).getItem(CONTROLS_KEY)
    );
  } catch {
    return defaultBindings();
  }
}
export function saveControls(
  bindings: Bindings,
  storage?: StorageAccess
): boolean {
  if (!validBindings(bindings)) return false;
  try {
    (storage ?? window.localStorage).setItem(
      CONTROLS_KEY,
      serializeControls(bindings)
    );
    return true;
  } catch {
    return false;
  }
}
