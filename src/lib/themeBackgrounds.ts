import type { CSSProperties } from "react";

export type HomeTheme = "default" | "turkiye" | "adventure" | "dark-space";

export const HOME_THEME_KEY = "torble-theme";

/* ═══════════════════════════════════════════════════════════════
   CANONICAL HOME-THEME REGISTRY
   ───────────────────────────────────────────────────────────────
   Tek kaynak: her temanın internal key'i, kullanıcıya görünen adı,
   renk dili (accent + picker swatch'i) ve hem masaüstü hem mobil
   arka plan dosyaları burada tanımlı. Masaüstü ve mobil için AYRI,
   zamanla kopabilecek paralel listeler YOK — picker listesi
   (HOME_THEMES), mobil arka plan değişkeni ve select-modal overlay
   stili hepsi bu tek diziden türetilir.

   NOT: `dark-space` yalnız internal key; kullanıcıya "Zümrüt Vadi"
   olarak görünür. Masaüstü .home-screen arka planları App.css'teki
   `.home-screen--<key>` sınıflarında render edilir ve buradaki
   `desktopBackground` yollarını birebir AYNALAR (CSS, JS importu
   yapamadığı için kaçınılmaz; yol değişirse iki yer de güncellenir). */
export interface HomeThemeDef {
  /** Internal key — localStorage + data-theme + CSS sınıf eki. */
  key: HomeTheme;
  /** Kullanıcıya görünen ad (picker etiketi). */
  label: string;
  /** Picker swatch'i — temanın renk dilini özetleyen gradyan. */
  swatch: string;
  /** Birincil accent rengi (seçili-tema vurgusu / mobil CTA tonu). */
  accent: string;
  /** Accent'in "r, g, b" hali — rgba() ile alpha kompozisyonu için. */
  accentRgb: string;
  /** Masaüstü arka plan görseli (App.css .home-screen--<key> ile aynı). */
  desktopBackground: string;
  /** Dar/narrow + native app arka plan görseli (portre, hafif WebP). */
  mobileBackground: string;
  /** Select-modal overlay'inde kullanılan koyulaştırma katmanı. */
  overlayScrim: string;
}

export const HOME_THEME_REGISTRY: readonly HomeThemeDef[] = [
  {
    key: "default",
    label: "Gece",
    swatch: "linear-gradient(135deg, #0b1430 0%, #115e67 100%)",
    accent: "#58a6ff",
    accentRgb: "88, 166, 255",
    desktopBackground: "/assets/backgrounds/night-atlas.webp",
    mobileBackground: "/assets/backgrounds/night-atlas-mobile.webp",
    overlayScrim: "linear-gradient(rgba(3, 7, 18, 0.30), rgba(3, 7, 18, 0.54))",
  },
  {
    key: "turkiye",
    label: "Türkiye",
    swatch: "linear-gradient(135deg, #16c0c8 0%, #1e6bd9 100%)",
    accent: "#16c0c8",
    accentRgb: "22, 192, 200",
    desktopBackground: "/assets/backgrounds/turkiye.webp",
    mobileBackground: "/assets/backgrounds/turkiye-mobile.webp",
    overlayScrim: "linear-gradient(rgba(3, 7, 18, 0.26), rgba(3, 7, 18, 0.52))",
  },
  {
    key: "adventure",
    label: "Adventure",
    swatch: "linear-gradient(135deg, #0ea5e9 0%, #22c55e 100%)",
    accent: "#0ea5e9",
    accentRgb: "14, 165, 233",
    desktopBackground: "/assets/backgrounds/adventure-globale.webp",
    mobileBackground: "/assets/backgrounds/adventure-mobile.webp",
    overlayScrim: "linear-gradient(rgba(3, 7, 18, 0.52), rgba(3, 7, 18, 0.72))",
  },
  {
    key: "dark-space",
    label: "Zümrüt Vadi",
    swatch: "linear-gradient(135deg, #102a22 0%, #1f5a45 100%)",
    accent: "#3ad2c1",
    accentRgb: "58, 210, 193",
    desktopBackground: "/assets/backgrounds/dark-space.webp",
    mobileBackground: "/assets/backgrounds/dark-space-mobile.webp",
    overlayScrim: "linear-gradient(rgba(0, 0, 0, 0.10), rgba(0, 0, 0, 0.30))",
  },
];

const DEFAULT_THEME_DEF = HOME_THEME_REGISTRY[0];

export function getThemeDef(theme: HomeTheme): HomeThemeDef {
  return HOME_THEME_REGISTRY.find((t) => t.key === theme) ?? DEFAULT_THEME_DEF;
}

/** Picker listesi (masaüstü HomeThemePicker + mobil SocialCenterSheet ortak
 *  kullanır) — registry'den türetilir, ayrı bir liste tutulmaz. */
export const HOME_THEMES: { id: HomeTheme; name: string; swatch: string }[] =
  HOME_THEME_REGISTRY.map((t) => ({ id: t.key, name: t.label, swatch: t.swatch }));

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

/** Select-modal overlay arka planı (masaüstü). Yol + scrim registry'den gelir. */
export function getThemeBackgroundStyle(theme: HomeTheme): CSSProperties {
  if (theme === "default") return {};
  const def = getThemeDef(theme);
  return {
    ...BG_BASE,
    backgroundImage: `${def.overlayScrim}, url('${def.desktopBackground}')`,
  };
}

/** Mobil/native arka plan görseli — `url('...')` döner; scrim CSS'te kalır.
 *  `.home-screen` üzerinde `--home-mobile-bg` CSS değişkeni olarak yazılır,
 *  böylece tema değişince ≤600px arka planı da değişir (app tıklama bug fix). */
export function getMobileThemeBackground(theme: HomeTheme): string {
  return `url('${getThemeDef(theme).mobileBackground}')`;
}
