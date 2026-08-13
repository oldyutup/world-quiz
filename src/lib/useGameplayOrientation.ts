/**
 * useGameplayOrientation — puts the native app in landscape while a
 * landscape-first gameplay screen is mounted, and releases it on exit.
 *
 * ── Platform split ───────────────────────────────────────────────────────
 *
 * • Native (Capacitor iOS / Android) — the official `@capacitor/screen-
 *   orientation` plugin locks to landscape on mount and unlocks on unmount.
 *   On iOS `unlock()` makes UIKit re-evaluate against the orientations in
 *   `Info.plist` (Portrait + LandscapeLeft + LandscapeRight) and the device's
 *   physical position, so a player who never physically turned the phone —
 *   the app rotated for them — snaps straight back to portrait for the
 *   lobby and home. Nothing here narrows the app's declared orientation
 *   policy; Info.plist is untouched.
 *
 * • Web, including mobile web — deliberately does nothing. Browsers only
 *   honour `screen.orientation.lock()` in fullscreen (and WebKit not at
 *   all), so attempting it produces a rejected promise on every phone that
 *   matters and no behaviour change. The responsive landscape layout plus
 *   the rotate hint carry that path instead.
 *
 * ── Lifecycle ────────────────────────────────────────────────────────────
 * Every lock/unlock goes through one module-level serial queue and a holder
 * count, which is what makes the awkward cases safe:
 *   - React 18 StrictMode double-mounts in dev → lock, unlock, lock, and the
 *     app still ends up locked.
 *   - Leaving gameplay before the lock promise settles → the unlock is
 *     queued *after* it, so the app can never be left stuck in landscape.
 *   - Two screens asking at once → the lock is taken once and released once.
 * Rejections are swallowed and surfaced as status instead: a failed lock
 * must never take the game screen down with it.
 */

import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { ScreenOrientation } from "@capacitor/screen-orientation";

export type GameplayOrientationStatus =
  /** Not requested — the hook is inactive. */
  | "idle"
  /** Native request in flight. */
  | "locking"
  /** The platform accepted landscape. */
  | "locked"
  /** No lock is possible here (web, desktop) — use the rotate hint. */
  | "unsupported"
  /** The platform refused, e.g. an OS-level restriction. Hint applies. */
  | "failed";

export interface GameplayOrientationState {
  status:   GameplayOrientationStatus;
  isNative: boolean;
  /** Platform error text when `status` is "failed"; useful in bug reports. */
  error:    string | null;
}

function isNativeApp(): boolean {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
}

// ── Lock ownership ───────────────────────────────────────────────────────
// Built over an injectable driver so the lifecycle rules (no duplicate lock,
// never stuck locked, a rejection never stalls the chain) can be exercised in
// `scripts/check-gameplay-orientation.mjs` without a device.

export interface OrientationDriver {
  lockLandscape(): Promise<void>;
  unlock():        Promise<void>;
}

export interface OrientationLock {
  acquire(): Promise<void>;
  release(): void;
  /** Test/diagnostic view of the holder count. */
  holders(): number;
}

export function createOrientationLock(driver: OrientationDriver): OrientationLock {
  let holders = 0;
  // Serialising through one promise chain is what guarantees an unlock queued
  // during an in-flight lock still lands *after* it, instead of racing it and
  // leaving the app stranded in landscape.
  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T,>(op: () => Promise<T>): Promise<T> => {
    // `.then(op, op)` so one rejected step never stalls the rest of the chain.
    const next = queue.then(op, op) as Promise<T>;
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    acquire() {
      holders += 1;
      if (holders > 1) return Promise.resolve();      // already held
      return enqueue(() => driver.lockLandscape());
    },
    release() {
      holders = Math.max(0, holders - 1);
      if (holders > 0) return;                        // someone still needs it
      void enqueue(() => driver.unlock()).catch(() => undefined);
    },
    holders: () => holders,
  };
}

const nativeLock = createOrientationLock({
  lockLandscape: () => ScreenOrientation.lock({ orientation: "landscape" }),
  unlock:        () => ScreenOrientation.unlock(),
});

/**
 * @param active While true, hold landscape. Flip to false the moment the
 *               player leaves gameplay (lobby, home, match over) so the rest
 *               of the app returns to its normal orientation behaviour.
 */
export function useGameplayOrientation(active: boolean): GameplayOrientationState {
  const [state, setState] = useState<GameplayOrientationState>({
    status: "idle", isNative: isNativeApp(), error: null,
  });

  useEffect(() => {
    const native = isNativeApp();
    if (!active) {
      setState({ status: "idle", isNative: native, error: null });
      return;
    }
    if (!native) {
      // Mobile web / desktop: the rotate hint is the whole strategy here.
      setState({ status: "unsupported", isNative: false, error: null });
      return;
    }

    let cancelled = false;
    setState({ status: "locking", isNative: true, error: null });

    nativeLock.acquire().then(
      () => { if (!cancelled) setState({ status: "locked", isNative: true, error: null }); },
      (err: unknown) => {
        // Reaching here means the OS refused (device restriction, unsupported
        // form factor). The game stays playable; the player just gets the
        // "turn your phone" hint instead of an automatic rotation.
        if (!cancelled) {
          setState({
            status: "failed",
            isNative: true,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

    return () => {
      cancelled = true;
      nativeLock.release();
    };
  }, [active]);

  return state;
}
