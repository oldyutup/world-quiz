import type { CSSProperties } from "react";

export type HomeTheme = "default" | "earth" | "adventure" | "dark-space";

export const HOME_THEME_KEY = "torble-theme";

export function getThemeDataAttr(theme: HomeTheme): HomeTheme | undefined {
  return theme === "default" ? undefined : theme;
}

export function readStoredHomeTheme(): HomeTheme {
  try {
    const saved = localStorage.getItem(HOME_THEME_KEY);
    if (saved === "default")    return "default";
    if (saved === "earth")      return "earth";
    if (saved === "adventure")  return "adventure";
    if (saved === "dark-space") return "dark-space";
    return "earth";
  } catch {
    return "earth";
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
    case "earth":
      return {
        ...BG_BASE,
        backgroundImage:
          "linear-gradient(rgba(3, 7, 18, 0.42), rgba(3, 7, 18, 0.66)), url('/assets/backgrounds/arkaplan.webp')",
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
