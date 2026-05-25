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
