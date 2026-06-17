/**
 * ClearNotificationsButton.tsx — paylaşılan "Bildirimleri Temizle" aksiyonu.
 *
 * Tek yerde toplanmış temizleme akışı: onay modalı + "Bir daha sorma" kalıcılığı
 * (localStorage) + clear_my_notifications RPC + sonuç toast'u. Hem desktop/mobil
 * web bildirim paneli (NotificationCenter) hem de native Arkadaşlar sosyal
 * merkezi (SocialCenterSheet → Bildirimler) bunu kullanır; mantık ikiye
 * bölünmez (drift önlenir). Sunum yalnız bir metin butonu olduğundan görünüm
 * `className` ile çağırana bırakılır — web paneli aynı `notif-clear` stilini
 * korur, sheet kendi düzenini verir.
 *
 * RPC sunucu otoritesidir: aksiyon gerektiren bildirimler (bekleyen arkadaşlık
 * isteği / okunmamış davet) korunur; sonuç (preserved) toast metnini belirler.
 */
import { useState } from "react";
import { useSocial } from "./SocialContext";
import { ConfirmDialog } from "./ConfirmDialog";

/** "Bir daha sorma" tercihi — ileride ayarlardan sıfırlanabilir. */
const SKIP_CLEAR_CONFIRM_KEY = "torble_skip_clear_notifications_confirm";

interface Props {
  /** Buton görünümü çağırana bırakılır (web paneli: "notif-clear"). */
  className?: string;
  /** Buton etiketi (varsayılan "Temizle"). */
  label?: string;
}

export function ClearNotificationsButton({ className = "notif-clear", label = "Temizle" }: Props) {
  const social = useSocial();
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  // Temizleme: sonucu toast'a çevirir (panel/badge zaten context refresh ile düşer).
  const runClear = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      const res = await social.clearNotifications();
      if (!res.ok) {
        social.toast("Bildirimler temizlenemedi, tekrar dene.");
      } else if (res.preserved > 0) {
        social.toast("Bildirimler temizlendi. Aksiyon gerektiren bildirimler korundu.");
      } else {
        social.toast("Bildirimler temizlendi.");
      }
    } finally {
      setClearing(false);
    }
  };

  // "Temizle" tıklaması: "bir daha sorma" işaretliyse direkt temizle, değilse onay iste.
  const handleClearClick = () => {
    let skip = false;
    try {
      skip = localStorage.getItem(SKIP_CLEAR_CONFIRM_KEY) === "1";
    } catch {
      skip = false;
    }
    if (skip) {
      void runClear();
    } else {
      setConfirmClear(true);
    }
  };

  const handleConfirmClear = (dontAskAgain: boolean) => {
    if (dontAskAgain) {
      try {
        localStorage.setItem(SKIP_CLEAR_CONFIRM_KEY, "1");
      } catch {
        /* localStorage erişilemezse tercih saklanmaz; akış bozulmaz. */
      }
    }
    setConfirmClear(false);
    void runClear();
  };

  return (
    <>
      <button type="button" className={className} onClick={handleClearClick} disabled={clearing}>
        {label}
      </button>

      {confirmClear && (
        <ConfirmDialog
          title="Bildirimleri temizle?"
          description="Bu işlem bildirim panelindeki bildirimleri temizler. Devam etmek istiyor musun?"
          confirmLabel="Temizle"
          cancelLabel="Vazgeç"
          dontAskAgainLabel="Bir daha sorma"
          destructive
          busy={clearing}
          onConfirm={handleConfirmClear}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </>
  );
}
