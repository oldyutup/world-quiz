import { ACTIONS, type Action } from "./actions";

export type Binding = string;
export type BindingSlots = readonly [Binding, Binding | null];
export type Bindings = Readonly<Record<Action, BindingSlots>>;
const COMMON_KEYS = new Set([
  "Space",
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "CapsLock",
  "Backquote",
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Semicolon",
  "Quote",
  "Comma",
  "Period",
  "Slash",
  "NumpadAdd",
  "NumpadSubtract",
  "NumpadMultiply",
  "NumpadDivide",
  "NumpadDecimal",
  "NumpadEnter",
  "MouseLeft",
  "MouseRight",
  "MouseMiddle",
]);
export function isBinding(value: unknown): value is Binding {
  return (
    typeof value === "string" &&
    (/^(Key[A-Z]|Digit[0-9]|Numpad[0-9])$/.test(value) ||
      COMMON_KEYS.has(value))
  );
}
export function conflicts(
  bindings: Bindings,
  action: Action,
  binding: Binding
): Action[] {
  return ACTIONS.filter(
    (other) => other !== action && bindings[other].includes(binding)
  );
}
export function changeBinding(
  bindings: Bindings,
  action: Action,
  slot: 0 | 1,
  binding: Binding | null
): Bindings | null {
  // Primary is always present; optional secondary never makes an action inaccessible.
  if (
    (!binding && slot === 0) ||
    (binding !== null &&
      (!isBinding(binding) || conflicts(bindings, action, binding).length))
  )
    return null;
  const slots = [...bindings[action]] as [Binding, Binding | null];
  if (slot === 0) slots[0] = binding!;
  else slots[1] = binding;
  return { ...bindings, [action]: slots };
}
export function validBindings(value: unknown): value is Bindings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== ACTIONS.length) return false;
  if (
    !ACTIONS.every((action) => {
      const slots = record[action];
      return (
        Array.isArray(slots) &&
        slots.length === 2 &&
        isBinding(slots[0]) &&
        (slots[1] === null || isBinding(slots[1]))
      );
    })
  )
    return false;
  const bindings = value as Bindings;
  return ACTIONS.every((action) =>
    bindings[action].every(
      (binding) =>
        binding === null || conflicts(bindings, action, binding).length === 0
    )
  );
}
const LABELS: Record<string, string> = {
  MouseLeft: "Sol Tık",
  MouseRight: "Sağ Tık",
  MouseMiddle: "Orta Tık",
  Space: "SPACE",
  ShiftLeft: "Sol SHIFT",
  ShiftRight: "Sağ SHIFT",
  ControlLeft: "Sol CTRL",
  ControlRight: "Sağ CTRL",
  AltLeft: "Sol ALT",
  AltRight: "Sağ ALT",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};
export const bindingLabel = (binding: Binding) =>
  LABELS[binding] ??
  binding.replace(/^Key|^Digit/, "").replace(/^Numpad/, "Num ");
export const actionBindingLabel = (bindings: Bindings, action: Action) =>
  [
    ...new Set(
      bindings[action].filter((b): b is string => b !== null).map(bindingLabel)
    ),
  ].join(" / ");
