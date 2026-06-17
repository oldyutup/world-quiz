/**
 * cosmetics.ts — profil kartı kozmetik ALTYAPISI (katalog + çözümleyiciler).
 *
 * KAPSAM / NİYET (önemli):
 *   - Bu dosya yalnızca KOZMETİK görünüm altyapısıdır. Şu an SATIŞ / PREMIUM /
 *     ödeme / unlock akışı YOKTUR. Kullanıcıya hiçbir satın-alma seçeneği
 *     gösterilmez. Kozmetikler oyun avantajı VERMEZ — tamamen görseldir.
 *   - Sunucuda kozmetik seçimleri profile_cosmetics tablosunda tutulur
 *     (active_avatar_frame_id / active_profile_theme_id / active_name_color_id /
 *      active_profile_card_style_id / active_profile_title_id /
 *      active_profile_effect_id). Default değer = null → bu modüldeki "default"
 *     girişi uygulanır. Bugün herkes default'tadır.
 *   - Katalogdaki "locked" girişler ileride (mağaza geldiğinde) açılacak
 *     örneklerdir; UI'da "Yakında" olarak gösterilebilir. Şu an seçilebilir
 *     DEĞİLDİR ve hiç kimsede aktif olmadığından karta etki ETMEZ.
 *
 * Çözümleyiciler savunmacıdır: null / bilinmeyen id → güvenli default. Böylece
 * sunucudan beklenmedik bir id gelse bile kart bozulmaz.
 *
 * Desktop/mobil web ortak. Native özel dosyalara dokunulmaz.
 */

export type CosmeticCategory =
  | "frame"
  | "cardTheme"
  | "nameColor"
  | "title"
  | "effect";

interface BaseCosmetic {
  id: string;
  /** Kullanıcıya görünen ad (gelecekteki editör için). */
  label: string;
  /** Henüz açılmamış / "Yakında" — şu an seçilemez. Default girişler false. */
  locked: boolean;
}

/* ── Avatar çerçevesi ──────────────────────────────────────────────────────
   Görsel uygulama PlayerAvatar (data-frame) + .player-avatar--framed[data-frame]
   üzerinden yürür. Burada yalnız katalog tutulur. */
export interface ProfileFrameDef extends BaseCosmetic {}

export const DEFAULT_FRAME_ID = "frame_default";

export const PROFILE_FRAMES: ProfileFrameDef[] = [
  { id: DEFAULT_FRAME_ID, label: "Klasik", locked: false },
  { id: "frame_gold", label: "Altın Çerçeve", locked: true },
  { id: "frame_neon", label: "Neon Halka", locked: true },
];

/* ── Kart teması (arka plan) ───────────────────────────────────────────────
   cssKey → .ppc-card[data-theme="<cssKey>"]. Bugün yalnız "default" stillenir. */
export interface CardThemeDef extends BaseCosmetic {
  cssKey: string;
}

export const DEFAULT_CARD_THEME_ID = "theme_default";

export const CARD_THEMES: CardThemeDef[] = [
  { id: DEFAULT_CARD_THEME_ID, label: "Gece Mavisi", locked: false, cssKey: "default" },
  { id: "theme_aurora", label: "Auroral", locked: true, cssKey: "aurora" },
  { id: "theme_ember", label: "Köz", locked: true, cssKey: "ember" },
];

/* ── İsim rengi ────────────────────────────────────────────────────────────
   color === null → CSS default (.ppc-uname). Aksi halde inline color. */
export interface NameColorDef extends BaseCosmetic {
  color: string | null;
}

export const DEFAULT_NAME_COLOR_ID = "name_default";

export const NAME_COLORS: NameColorDef[] = [
  { id: DEFAULT_NAME_COLOR_ID, label: "Varsayılan", locked: false, color: null },
  { id: "name_gold", label: "Altın", locked: true, color: "#ffd9a0" },
  { id: "name_mint", label: "Nane", locked: true, color: "#7ef0c2" },
];

/* ── Unvan ─────────────────────────────────────────────────────────────────
   text === null → unvan gösterilmez. Default unvan YOKTUR. */
export interface TitleDef extends BaseCosmetic {
  text: string | null;
}

export const PROFILE_TITLES: TitleDef[] = [
  { id: "title_explorer", label: "Kaşif", locked: true, text: "Kaşif" },
  { id: "title_legend", label: "Efsane", locked: true, text: "Efsane" },
];

/* ── Kart efekti ───────────────────────────────────────────────────────────
   cssKey → .ppc-card[data-effect="<cssKey>"]. Bugün yalnız "none". */
export interface CardEffectDef extends BaseCosmetic {
  cssKey: string;
}

export const DEFAULT_CARD_EFFECT_ID = "effect_none";

export const CARD_EFFECTS: CardEffectDef[] = [
  { id: DEFAULT_CARD_EFFECT_ID, label: "Yok", locked: false, cssKey: "none" },
  { id: "effect_sheen", label: "Parıltı", locked: true, cssKey: "sheen" },
  { id: "effect_holo", label: "Holografik", locked: true, cssKey: "holo" },
];

/* ── Çözümleyiciler (savunmacı; bilinmeyen/null → default) ─────────────────── */

function findById<T extends BaseCosmetic>(list: T[], id: string | null | undefined): T | undefined {
  if (!id) return undefined;
  return list.find((c) => c.id === id);
}

/** Kart teması cssKey'i (data-theme). Bilinmeyen/null → "default". */
export function resolveCardThemeKey(id: string | null | undefined): string {
  return findById(CARD_THEMES, id)?.cssKey ?? "default";
}

/** Kart efekti cssKey'i (data-effect). Bilinmeyen/null → "none". */
export function resolveCardEffectKey(id: string | null | undefined): string {
  return findById(CARD_EFFECTS, id)?.cssKey ?? "none";
}

/** İsim rengi (inline color). Default/bilinmeyen → null (CSS default kullanılır). */
export function resolveNameColor(id: string | null | undefined): string | null {
  return findById(NAME_COLORS, id)?.color ?? null;
}

/** Unvan metni. Yoksa null → unvan satırı gösterilmez. */
export function resolveTitleText(id: string | null | undefined): string | null {
  return findById(PROFILE_TITLES, id)?.text ?? null;
}

/** Çerçeve id'sini PlayerAvatar'a aktarmadan önce normalize eder
 *  (default → null, görsel olarak nötr wrapper). */
export function resolveFrameId(id: string | null | undefined): string | null {
  if (!id || id === DEFAULT_FRAME_ID) return null;
  return findById(PROFILE_FRAMES, id) ? id : null;
}
