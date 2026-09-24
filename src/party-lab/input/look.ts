import { isUIInput } from "./device";

/**
 * Mouse/trackpad look for the barn's third-person camera. Two ways to steer:
 *
 * - "lock" (default): Pointer Lock after an explicit click inside the arena. Any
 *   pointer movement then turns the camera — a mouse, or one finger on a trackpad
 *   without pressing it — and the cursor can't run off the screen. Esc releases it
 *   (browser-owned); it is also released when settings open or the arena closes.
 * - "drag": no lock; the camera turns while the primary button (or a pressed
 *   trackpad) is held and dragged. Fallback for browsers that refuse the lock.
 *
 * Only relative deltas leave this module; yaw/pitch/aim live with the camera.
 * `claimsClick` tells the gameplay mouse bindings which presses belong to looking:
 * the click that acquires the lock (any button) and, in drag mode, the drag button —
 * so taking the lock never also punches or fires.
 *
 * `onLockLost` reports a lock the page did not give up itself: Esc (the browser's own
 * unlock gesture, never intercepted here), focus or tab loss. The arena opens its menu
 * on it. Releases asked for through `setEnabled(false)` / `setMode` / `dispose` do not
 * report: the caller already knows.
 */
export type LookMode = "lock" | "drag";
export type LookStatus = "unlocked" | "locked" | "dragging" | "error";

/** A single event larger than this is a browser glitch (some report a jump on lock), not a flick. */
const MAX_EVENT_DELTA = 250;

const STORAGE_KEY = "party-lab-barn-look-v1";
export function loadLookMode(): LookMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "drag" ? "drag" : "lock";
  } catch {
    return "lock";
  }
}
export function saveLookMode(mode: LookMode) {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Private mode / blocked storage: the choice lasts for this session only.
  }
}

export function bindLook(surface: HTMLElement, initialMode: LookMode, onStatus: (status: LookStatus) => void, onLockLost?: () => void) {
  let mode = initialMode,
    enabled = true,
    dragging = false,
    dx = 0,
    dy = 0,
    status: LookStatus = "unlocked",
    /** The last press used for looking (whichever listener sees it first, it stays look input). */
    claimed: MouseEvent | null = null;
  const locked = () => document.pointerLockElement === surface;
  const set = (next: LookStatus) => {
    if (next === status) return;
    status = next;
    onStatus(next);
  };
  const add = (x: number, y: number) => {
    if (Math.abs(x) > MAX_EVENT_DELTA || Math.abs(y) > MAX_EVENT_DELTA) return;
    dx += x;
    dy += y;
  };
  function request() {
    try {
      // Chrome returns a promise (rejects e.g. right after an Esc); older engines return nothing.
      const result = surface.requestPointerLock() as unknown as Promise<void> | undefined;
      result?.catch?.((error: unknown) => {
        console.warn("Party Lab: pointer lock refused", error);
        set("error");
      });
    } catch (error) {
      console.warn("Party Lab: pointer lock refused", error);
      set("error");
    }
  }
  function mouseDown(event: MouseEvent) {
    if (!enabled || isUIInput(event.target)) return;
    if (mode === "lock") {
      if (!locked()) {
        claimed = event;
        request();
      }
    } else if (event.button === 0) {
      claimed = event;
      dragging = true;
      set("dragging");
    }
  }
  function mouseMove(event: MouseEvent) {
    if (!enabled) return;
    if (mode === "lock" ? locked() : dragging && (event.buttons & 1) !== 0) add(event.movementX, event.movementY);
  }
  function mouseUp(event: MouseEvent) {
    if (event.button !== 0 || !dragging) return;
    dragging = false;
    set("unlocked");
  }
  function lockChange() {
    if (locked()) set("locked");
    else if (status === "locked") {
      // Still "locked" here means nobody on the page asked for this release.
      set("unlocked");
      onLockLost?.();
    }
    dx = dy = 0;
  }
  const lockError = () => set("error");
  const release = () => {
    dragging = false;
    dx = dy = 0;
    if (locked()) document.exitPointerLock();
  };
  surface.addEventListener("mousedown", mouseDown);
  window.addEventListener("mousemove", mouseMove);
  window.addEventListener("mouseup", mouseUp);
  document.addEventListener("pointerlockchange", lockChange);
  document.addEventListener("pointerlockerror", lockError);
  window.addEventListener("blur", release);
  return {
    get mode() {
      return mode;
    },
    get status() {
      return status;
    },
    /**
     * Whether a mouse press is look input rather than gameplay: while unlocked in lock
     * mode (this press acquires the lock), or the primary button in drag mode.
     */
    claimsClick(event: MouseEvent) {
      if (event === claimed) return true;
      if (!enabled || isUIInput(event.target)) return false;
      return mode === "lock" ? !locked() : event.button === 0;
    },
    /** Pixel deltas since the last call. */
    consume() {
      const out = { dx, dy };
      dx = dy = 0;
      return out;
    },
    setMode(next: LookMode) {
      if (next === mode) return;
      // Status first: the release that follows is the page's own, not a lost lock.
      set("unlocked");
      release();
      mode = next;
    },
    /** Settings open / tab hidden: drop the lock and any drag. */
    setEnabled(value: boolean) {
      enabled = value;
      if (!value) {
        set("unlocked");
        release();
      }
    },
    dispose() {
      surface.removeEventListener("mousedown", mouseDown);
      window.removeEventListener("mousemove", mouseMove);
      window.removeEventListener("mouseup", mouseUp);
      document.removeEventListener("pointerlockchange", lockChange);
      document.removeEventListener("pointerlockerror", lockError);
      window.removeEventListener("blur", release);
      release();
    },
  };
}
export type LookController = ReturnType<typeof bindLook>;
