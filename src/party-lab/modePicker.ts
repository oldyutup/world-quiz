/**
 * The lobby's compact mode picker, independent of React/DOM so it can be tested.
 *
 * The list is `position: fixed` so the scrolling details column never clips it. It opens
 * under its trigger with the right edges aligned, flips above when only that side has
 * room, and always stays inside the viewport gutter (scrolling itself when neither side
 * fits it whole).
 */
export const MODE_LIST_MIN_WIDTH = 320;
const GAP_PX = 6;

export interface AnchorRect {
  top: number;
  bottom: number;
  right: number;
  width: number;
}
export interface Viewport {
  width: number;
  height: number;
}
export interface ModeListPlacement {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  above: boolean;
}

/** `width` first (the list wraps to it), then place it with its height at that width. */
export function modeListWidth(anchor: AnchorRect, viewport: Viewport, gutter = 16) {
  return Math.max(0, Math.min(Math.max(anchor.width, MODE_LIST_MIN_WIDTH), viewport.width - 2 * gutter));
}

export function placeModeList(anchor: AnchorRect, listHeight: number, viewport: Viewport, gutter = 16): ModeListPlacement {
  const width = modeListWidth(anchor, viewport, gutter);
  const left = Math.max(gutter, Math.min(anchor.right - width, viewport.width - gutter - width));
  const below = Math.max(0, viewport.height - gutter - anchor.bottom - GAP_PX);
  const aboveRoom = Math.max(0, anchor.top - GAP_PX - gutter);
  const above = listHeight > below && aboveRoom > below;
  const maxHeight = above ? aboveRoom : below;
  const top = above ? anchor.top - GAP_PX - Math.min(listHeight, maxHeight) : anchor.bottom + GAP_PX;
  return { top, left, width, maxHeight, above };
}

/** Arrow/Home/End focus movement over `count` options (wrapping); null for other keys. */
export function modeListStep(key: string, index: number, count: number): number | null {
  if (key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
