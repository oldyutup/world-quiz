/**
 * korNoktaBackgrounds — Kör Nokta gameplay ekranına özel arkaplan katmanı.
 *
 * Tek kaynak: aşağıdaki KOR_NOKTA_BACKGROUNDS mapping'i. Görseller
 * beğenilmezse YALNIZ bu dosyadaki path'leri değiştirmek yeterli (uzantı
 * dahil — jpg/webp'e geçilirse sadece burada güncellenir).
 *
 * Görseller public/ altında durur, bu yüzden runtime path'leri köke göre
 * mutlaktır (/assets/...). Vite bunları import etmez; <div> background-image
 * olarak doğrudan URL kullanılır.
 *
 * Fallback: resolveKnBackground her zaman geçerli bir key döndürür (en kötü
 * "default"). Dosya 404 verirse oyun KIRILMAZ — .kn-screen'in CSS'inde koyu
 * base color + overlay gradyanı kalır, paneller okunur durumda kalır
 * (bkz. KorNoktaGame.css). Konsola tarayıcı kendi 404 uyarısını basabilir.
 */

import type { KnPhase, KnRole } from "./korNoktaGameTypes";

export type KnBgKey =
  | "default"
  | "detective"
  | "reporter"
  | "mole"
  | "reveal"
  | "final";

/** Public path mapping — değiştirmek için TEK yer. */
export const KOR_NOKTA_BACKGROUNDS: Record<KnBgKey, string> = {
  default:   "/assets/backgrounds/kor-nokta/kn_bg_default.png",
  detective: "/assets/backgrounds/kor-nokta/kn_bg_detective.png",
  reporter:  "/assets/backgrounds/kor-nokta/kn_bg_reporter.png",
  mole:      "/assets/backgrounds/kor-nokta/kn_bg_mole.png",
  reveal:    "/assets/backgrounds/kor-nokta/kn_bg_reveal.png",
  final:     "/assets/backgrounds/kor-nokta/kn_bg_final.png",
};

/** Rol → arkaplan key (dedektif/raporcu/köstebek; izleyici → default). */
function roleBgKey(role: KnRole | null): KnBgKey {
  switch (role) {
    case "detective": return "detective";
    case "reporter":  return "reporter";
    case "mole":      return "mole";
    default:          return "default";
  }
}

/**
 * Faz + rol → arkaplan key. Spec §2 eşlemesi:
 *   role_reveal / observe_report → role bazlı
 *   detective_guess / report_judgement → dedektif: detective, diğerleri: default
 *   guess_reveal / round_reveal → reveal
 *   final_results → final
 *   bilinmeyen / null → default
 */
export function resolveKnBgKey(
  phase: KnPhase | null,
  role: KnRole | null,
): KnBgKey {
  switch (phase) {
    case "role_reveal":
    case "observe_report":
      return roleBgKey(role);
    case "detective_guess":
    case "report_judgement":
      return role === "detective" ? "detective" : "default";
    case "guess_reveal":
    case "round_reveal":
      return "reveal";
    case "final_results":
      return "final";
    default:
      return "default";
  }
}

export interface KnBackground {
  /** background-image URL (her zaman geçerli; en kötü default). */
  url: string;
  /** `.kn-theme-*` class adı (hafif accent/atmosfer farkı için). */
  themeClass: string;
}

/** Faz + rol → arkaplan URL'i ve tema class'ı. */
export function resolveKnBackground(
  phase: KnPhase | null,
  role: KnRole | null,
): KnBackground {
  const key = resolveKnBgKey(phase, role);
  return {
    url: KOR_NOKTA_BACKGROUNDS[key],
    themeClass: `kn-theme-${key}`,
  };
}
