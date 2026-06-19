import type { CSSProperties } from "react";

export type HomeTheme = "default" | "turkiye" | "adventure" | "dark-space";

export const HOME_THEME_KEY = "torble-theme";

export function getThemeDataAttr(theme: HomeTheme): HomeTheme | undefined {
  return theme === "default" ? undefined : theme;
}

export function readStoredHomeTheme(): HomeTheme {
  try {
    const saved = localStorage.getItem(HOME_THEME_KEY);
    if (saved === "default")    return "default";
    if (saved === "turkiye")    return "turkiye";
    if (saved === "adventure")  return "adventure";
    if (saved === "dark-space") return "dark-space";
    // Legacy: the removed "Mavi Dünya" (earth) theme normalizes to Türkiye so an
    // old saved preference never resolves to an unknown/blank theme.
    if (saved === "earth")      return "turkiye";
    return "adventure";
  } catch {
    return "adventure";
  }
}

const BG_BASE: CSSProperties = {
  backgroundSize: "cover",
  backgroundPosition: "center",
  backgroundRepeat: "no-repeat",
  minHeight: "100vh",
};

export function getThemeBackgroundStyle(theme: HomeTheme): CSSProperties {
  switch (theme) {
    case "turkiye":
      return {
        ...BG_BASE,
        backgroundImage:
          "linear-gradient(rgba(3, 7, 18, 0.26), rgba(3, 7, 18, 0.52)), url('/assets/backgrounds/turkiye.webp')",
      };
    case "adventure":
      return {
        ...BG_BASE,
        backgroundImage:
          "linear-gradient(rgba(3, 7, 18, 0.52), rgba(3, 7, 18, 0.72)), url('/assets/backgrounds/adventure-globale.webp')",
      };
    case "dark-space":
      return {
        ...BG_BASE,
        backgroundImage:
          "linear-gradient(rgba(0, 0, 0, 0.10), rgba(0, 0, 0, 0.30)), url('/assets/backgrounds/dark-space.webp')",
      };
    case "default":
    default:
      return {};
  }
}
