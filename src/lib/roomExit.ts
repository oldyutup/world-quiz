/**
 * roomExit.ts — ORTAK GÜVENLİ ÇIKIŞ EL SIKIŞMASI.
 *
 * SORUN:
 * Davet linki kabul edildiğinde App'in oyuncuyu mevcut odasından çıkarması
 * gerekiyor. Ama "güvenli çıkış"ın ne demek olduğu MODA GÖRE DEĞİŞİYOR:
 *   • lobide         → leave_room RPC (host devri / oda silme sunucuda)
 *   • maç sırasında  → forfeit (otoritatif bitiş yazılır), leave DEĞİL
 *   • Bayrak 1v1'de  → tek RPC status'tan türetiyor (phase-aware)
 * App bu semantiği BİLEMEZ. Tahmin ederse ya hayalet slot bırakır ya da
 * host olarak leave_room çağırıp devam eden bir maçı yok eder.
 *
 * ÇÖZÜM:
 * `GUEST_SIGNUP_EVENT` ile aynı desen — sekiz-dokuz bileşene prop geçirmek
 * yerine tek bir global olay. App "güvenli çık" DİYE SORAR; kararı ve işi
 * modun kendisi yapar, KENDİ MEVCUT çıkış fonksiyonuyla. Burada yeni bir
 * leave/forfeit mantığı YOKTUR — bu dosya yalnız köprüdür.
 *
 * ZAMAN AŞIMI YOK — "cevap gelmedi, başarılı saydım" YAPILMAZ:
 * CustomEvent dinleyicileri SENKRON çalışır. App olayı gönderdikten hemen
 * sonra `claim` çağrılıp çağrılmadığına bakar:
 *   • çağrılmadı → o modda aktif oda YOK (ya da bileşen mount değil) — kesin
 *     bilgi, tahmin değil.
 *   • çağrıldı   → modun verdiği promise beklenir; ancak RESOLVE olursa
 *     başarı sayılır, REJECT olursa çıkış başarısızdır.
 */
import { useEffect, useRef } from "react";
import type { RoomCodeModeKey } from "./roomCodeShared";

export const ROOM_EXIT_REQUEST_EVENT = "torble:request-room-exit";

export interface RoomExitRequestDetail {
  /** Hangi modun çıkması isteniyor. */
  mode: RoomCodeModeKey;
  /**
   * Mod isteği ÜSTLENİR ve çıkış işleminin promise'ini verir.
   * SENKRON çağrılmalıdır (olay dinleyicisinin içinde) — App dispatch'ten
   * hemen sonra üstlenilip üstlenilmediğine bakar.
   * İlk üstlenen kazanır; sonraki çağrılar yok sayılır.
   */
  claim(exit: Promise<void>): void;
}

export type RoomExitOutcome =
  /** Mod çıkışı tamamladı. */
  | { ok: true }
  /** O modda aktif oda yok / bileşen dinlemiyor — çıkılacak bir şey yoktu. */
  | { ok: false; reason: "no-active-room" }
  /** Mod üstlendi ama çıkış hata verdi — oda DOKUNULMAMIŞ sayılmalı. */
  | { ok: false; reason: "exit-failed"; error: unknown };

/**
 * İlgili moddan güvenli çıkış ister.
 *
 * Çağıran, `ok: true` DÖNMEDEN başka hiçbir şey yapmamalıdır (yönlendirme,
 * oturum temizliği vb.). `no-active-room` bir HATA DEĞİLDİR: çıkılacak oda
 * yoktu, çağıran normal akışına devam edebilir.
 */
export async function requestRoomExit(
  mode: RoomCodeModeKey
): Promise<RoomExitOutcome> {
  if (typeof window === "undefined") return { ok: false, reason: "no-active-room" };

  let claimed: Promise<void> | null = null;
  const detail: RoomExitRequestDetail = {
    mode,
    claim(exit) {
      if (claimed) return; // tek atış — ilk üstlenen kazanır
      claimed = exit;
    },
  };

  window.dispatchEvent(new CustomEvent(ROOM_EXIT_REQUEST_EVENT, { detail }));

  // Dinleyiciler senkron koştu; şimdi kesin olarak biliyoruz.
  if (!claimed) return { ok: false, reason: "no-active-room" };

  try {
    await claimed;
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: "exit-failed", error };
  }
}

export interface RoomExitHandler {
  /**
   * ŞU AN çıkılacak gerçek bir oda var mı? `false` ise istek üstlenilmez ve
   * App "aktif oda yok" cevabını alır.
   */
  canExit: () => boolean;
  /**
   * Modun KENDİ mevcut güvenli çıkış yolu. Lobi/maç ayrımını mod kendi
   * state'ine bakarak yapar. Reject ederse çıkış BAŞARISIZ sayılır.
   */
  exit: () => Promise<void>;
}

/**
 * Bir oda moduna ortak çıkış el sıkışmasını bağlar.
 *
 * Bileşende TEK satır; içeride yeni leave/forfeit mantığı yazılmaz, yalnız
 * modun zaten var olan fonksiyonları verilir.
 */
export function useRoomExitHandler(
  mode: RoomCodeModeKey,
  handler: RoomExitHandler
): void {
  // Handler her render'da tazelenir; dinleyici yeniden bağlanmaz (bayat
  // closure ile "odada değilim" demesini engeller).
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    const onRequest = (e: Event) => {
      const detail = (e as CustomEvent<RoomExitRequestDetail>).detail;
      if (!detail || detail.mode !== mode) return;
      if (!ref.current.canExit()) return; // odada değiliz → üstlenme
      // exit() SENKRON başlatılır, promise'i App bekler.
      detail.claim(
        (async () => { await ref.current.exit(); })()
      );
    };
    window.addEventListener(ROOM_EXIT_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(ROOM_EXIT_REQUEST_EVENT, onRequest);
  }, [mode]);
}
