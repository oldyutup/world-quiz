import { bindingLabel, type Bindings } from "../../input/bindings";

/** What drops the box: the player's Jump keys (Space by default). Mouse buttons do not (a click only focuses). */
export function dropBindings(bindings: Bindings): ReadonlySet<string> {
  const keys = bindings.jump.filter((binding): binding is string => !!binding && !binding.startsWith("Mouse"));
  return new Set(keys.length ? keys : ["Space"]);
}
/** "Space": what drops the box, for the HUD. */
export const dropLabel = (bindings: Bindings) => [...dropBindings(bindings)].map(bindingLabel).join(" / ");
