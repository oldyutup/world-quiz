/**
 * AccountModerationGate.tsx — hesabı kısıtlı (suspended/banned) kullanıcıya
 * durumunu bildiren bilgilendirme modalı (App Store 1.2 UGC güvenlik).
 *
 * GERÇEK ZORLAMA SUNUCUDADIR: banned/suspended hesap yeni sosyal/UGC işlem
 * yapamaz (migration 20260806120000 trigger/RPC'leri). Bu modal yalnız
 * BİLGİLENDİRİR; hesap silmeyi / gizlilik / destek erişimini ENGELLEMEZ
 * (kapatılabilir). moderation_note ASLA gösterilmez / çekilmez.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getMyModerationStatus, type ModerationStatus } from "../lib/moderation";
import { CONTACT_EMAIL } from "../legal/content/chrome";

interface Props {
  /** Aktif profil id — değişince (giriş/çıkış) durum yeniden okunur. */
  profileId: string | null;
}

export function AccountModerationGate({ profileId }: Props) {
  const [status, setStatus] = useState<ModerationStatus>("active");
  const [until, setUntil] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!profileId) {
      setStatus("active");
      setDismissed(false);
      return;
    }
    let alive = true;
    void getMyModerationStatus().then((s) => {
      if (!alive) return;
      setStatus(s.status);
      setUntil(s.suspendedUntil);
      setDismissed(false);
    });
    return () => {
      alive = false;
    };
  }, [profileId]);

  if (status === "active" || dismissed) return null;

  const banned = status === "banned";
  let untilText: string | null = null;
  if (!banned && until) {
    const d = new Date(until);
    if (!Number.isNaN(d.getTime())) {
      untilText = d.toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });
    }
  }

  return createPortal(
    <div
      className="confirm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={banned ? "Hesap yasaklandı" : "Hesap kısıtlandı"}
    >
      <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="confirm-title">
          {banned ? "Hesabın kalıcı olarak kısıtlandı" : "Hesabın geçici olarak kısıtlandı"}
        </h2>
        <p className="confirm-desc">
          {banned
            ? "Topluluk kurallarının ihlali nedeniyle hesabın kalıcı olarak kısıtlandı. Mesajlaşma, davet, arkadaşlık ve bildirme gibi çevrim içi sosyal özellikleri kullanamazsın."
            : `Hesabın geçici olarak kısıtlandı${untilText ? ` (${untilText} tarihine kadar)` : ""}. Bu süre boyunca çevrim içi sosyal özellikleri kullanamazsın.`}
        </p>
        <p className="report-note">
          İtirazın veya sorun için{" "}
          <a className="amg-mail" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>{" "}
          ile iletişime geçebilirsin. Dilersen hesap ayarlarından hesabını silebilir, gizlilik ve
          destek sayfalarına ulaşabilirsin.
        </p>
        <div className="confirm-actions">
          <button
            type="button"
            className="confirm-btn confirm-btn--primary"
            onClick={() => setDismissed(true)}
          >
            Anladım
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
