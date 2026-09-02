/**
 * useQuickMatchCountdown.ts — `quickMatchStart.ts` kararının React köprüsü.
 *
 * NEDEN HOOK, NEDEN "TÜRETİLMİŞ"
 * ──────────────────────────────
 * Önceki hâlde geri sayım her modda `joinQuickMatchRoom` içinde TEK ATIŞ
 * kuruluyordu: `started_at` okunup bir interval başlatılıyordu. Bu, geri
 * sayımı "odaya nasıl girdiğime" bağlıyordu — yani:
 *   • RÖVANŞ (aynı/yeni odada yeni `started_at`) geri sayım ÜRETMİYORDU,
 *   • yeniden yükleme / reconnect sonrası geri sayım KAYBOLUYORDU,
 *   • her mod aynı ~20 satırı kopyalıyordu.
 *
 * Bu hook geri sayımı ODA SATIRINDAN TÜRETİR: `room_source` + `status` +
 * `started_at` üçlüsü değiştiğinde kendini yeniden kurar. Böylece odaya HANGİ
 * yoldan gelindiği (ilk eşleşme, rövanş, oturum geri yükleme, realtime UPDATE)
 * önemsizleşir; sunucunun yazdığı `started_at` tek otoritedir.
 *
 * Saat: `getSyncedNowMs()` (sunucu-senkron). Cihaz saati sapsa bile iki
 * istemci aynı saniyeyi görür.
 */
import { useEffect, useState } from "react";
import { getSyncedNowMs } from "./serverClock";
import {
  computeStartCountdownSeconds,
  type QuickMatchStartProbe,
} from "./quickMatchStart";

/** Kalan geri sayım saniyesi (0 = geri sayım yok / maç başladı). */
export function useQuickMatchCountdown(
  room: QuickMatchStartProbe | null | undefined,
): number {
  const roomSource = room?.room_source ?? null;
  const status     = room?.status ?? null;
  const startedAt  = room?.started_at ?? null;

  const [seconds, setSeconds] = useState(() =>
    computeStartCountdownSeconds({
      room: { room_source: roomSource, status, started_at: startedAt },
      syncedNowMs: getSyncedNowMs(),
    }),
  );

  useEffect(() => {
    const probe: QuickMatchStartProbe = {
      room_source: roomSource,
      status,
      started_at: startedAt,
    };
    const read = () =>
      computeStartCountdownSeconds({ room: probe, syncedNowMs: getSyncedNowMs() });

    const first = read();
    setSeconds(first);
    if (first <= 0) return;

    // 200 ms: tek saniyelik adımlar gözle görülür şekilde geç kalmasın.
    // Değer her tick'te SIFIRDAN hesaplanır (biriken sayaç YOK) → sekme arka
    // planda throttle edilse bile geri dönüşte doğru değere oturur.
    const id = setInterval(() => {
      const next = read();
      setSeconds(next);
      if (next <= 0) clearInterval(id);
    }, 200);
    return () => clearInterval(id);
  }, [roomSource, status, startedAt]);

  return seconds;
}
