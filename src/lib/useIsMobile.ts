/**
 * useIsMobile — viewport classification hook for the Conquest mobile shell.
 *
 * Returns `{ isMobile, orientation }` keyed off the same media predicates
 * already used by the Conquest CSS mobile patches:
 *
 *   portrait : (max-width: 600px) and (orientation: portrait)
 *              OR (max-width: 600px) and (min-height: 501px)
 *   landscape: (max-height: 500px) and (orientation: landscape)
 *
 * Backed by useSyncExternalStore so React 18 stays in sync with matchMedia
 * change events without leaking listeners.  SSR / pre-hydration snapshot
 * returns "desktop" so server renders never produce a phone layout.
 */

import { useSyncExternalStore } from "react";
import { Capacitor } from "@capacitor/core";
import { isMobileSurface } from "./screenPolicy";

const PORTRAIT_QUERY =
  "(max-width: 600px) and (orientation: portrait), (max-width: 600px) and (min-height: 501px)";
const LANDSCAPE_QUERY = "(max-height: 500px) and (orientation: landscape)";

type Snapshot = "desktop" | "mobile-portrait" | "mobile-landscape";

function subscribe(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const portraitMQ  = window.matchMedia(PORTRAIT_QUERY);
  const landscapeMQ = window.matchMedia(LANDSCAPE_QUERY);
  portraitMQ.addEventListener("change", callback);
  landscapeMQ.addEventListener("change", callback);
  return () => {
    portraitMQ.removeEventListener("change", callback);
    landscapeMQ.removeEventListener("change", callback);
  };
}

function getSnapshot(): Snapshot {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "desktop";
  }
  // Landscape wins when both could theoretically match (very small landscape
  // viewports), mirroring the cascade order of the existing CSS patches.
  if (window.matchMedia(LANDSCAPE_QUERY).matches) return "mobile-landscape";
  if (window.matchMedia(PORTRAIT_QUERY).matches)  return "mobile-portrait";
  return "desktop";
}

function getServerSnapshot(): Snapshot {
  return "desktop";
}

export interface UseIsMobileResult {
  isMobile:    boolean;
  orientation: "portrait" | "landscape";
}

export function useIsMobile(): UseIsMobileResult {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    isMobile:    snapshot !== "desktop",
    orientation: snapshot === "mobile-landscape" ? "landscape" : "portrait",
  };
}

/** Capacitor native shell, resolved once at module eval — same guard as the
 *  IS_NATIVE_APP const in App.tsx (a missing bridge in dev/SSR must not throw). */
const IS_NATIVE_APP = (() => {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
})();

/**
 * "Am I on a phone?" as a plain boolean.
 *
 * No new detection: this is screenPolicy's existing `isMobileSurface()`
 * predicate with its two inputs already filled in — the native shell (any
 * viewport) OR the useIsMobile viewport threshold. Components that only need
 * the boolean (map overlays, the Rota play header) use this instead of
 * assembling an AppSurface by hand; the rule itself still lives in exactly one
 * place. Desktop web is false in both terms, so every caller is a no-op there.
 */
export function useMobileSurface(): boolean {
  const { isMobile } = useIsMobile();
  return isMobileSurface({ isNativeApp: IS_NATIVE_APP, isMobileViewport: isMobile });
}
