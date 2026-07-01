/**
 * useEscapePass — Çark Modu için "Pas Geç" klavye kısayolu (Escape / Esc).
 *
 * Ayrı bir pas mantığı YAZMAZ. Escape'e basıldığında, ref'lenen mevcut
 * "Pas Geç" butonunun `.click()`'ini tetikler; böylece butonun onClick'ine
 * bağlı gerçek pass handler'ı (skor, pas hakkı, sıra/tur geçişi, multiplayer
 * sync ve reveal) birebir çalışır. Butonun görünürlüğü ve `disabled` durumu
 * tek doğruluk kaynağı olarak kalır — kısayol onların ötesine geçmez.
 *
 * Guard'lar:
 *  - Yalnız Escape/Esc çalışır; tuş basılı tutulunca (`e.repeat`) tekrar
 *    pas event'i üretmez.
 *  - input / textarea / select / contenteditable (ör. sohbet kutusu) odaktaysa
 *    yok sayılır — mevcut kapatma/çıkış davranışı bozulmaz.
 *  - Açık bir modal/dialog (`[role="dialog"]` ya da `[aria-modal="true"]`)
 *    varken yok sayılır.
 *  - `enabled` false ise, buton DOM'da yoksa (aktif hedef yok / tur çözülmüş /
 *    oyun aktif değil) ya da buton `disabled` ise hiçbir şey yapmaz.
 *
 * Çağıran bileşen, kendi faz ve modal durumundan türettiği `enabled` bayrağını
 * ve "Pas Geç" butonuna bağlı ref'i geçirir; listener mantığı burada merkezîdir
 * (her ekrana kopyala-yapıştır edilmez).
 *
 * @param passButtonRef Mevcut "Pas Geç" butonuna işaret eden ref.
 * @param enabled       Oyun aktif ve pas'a izin veren durumda mı.
 */

import { useEffect, type RefObject } from "react";

export function useEscapePass(
  passButtonRef: RefObject<HTMLButtonElement>,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Esc") return;
      // Tuşa basılı tutulunca tek pas: tekrar eden keydown'ları yok say.
      if (e.repeat) return;

      // Metin girişi / seçim odaktaysa Esc'i pas'a çevirme; mevcut davranışı
      // (temizleme, blur, kapatma vb.) olduğu gibi bırak.
      const active = document.activeElement as HTMLElement | null;
      if (active) {
        const tag = active.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          active.isContentEditable
        ) {
          return;
        }
      }

      // Açık bir modal/dialog varsa Esc onun kapatma davranışına ait; pasa
      // müdahale etme.
      if (document.querySelector('[role="dialog"], [aria-modal="true"]')) {
        return;
      }

      // Butonu bul: yoksa (görünmüyorsa) ya da disabled ise pas yok.
      const btn = passButtonRef.current;
      if (!btn || btn.disabled) return;

      // Tıklamayla birebir aynı: butonun onClick'ine bağlı pass handler'ını
      // tetikler. Tek Esc → tek click → tek pass event.
      btn.click();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, passButtonRef]);
}
