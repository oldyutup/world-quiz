/**
 * SecurityActionSheet.tsx — mobil "Bildir / Engelle" alt-sayfası (action sheet).
 *
 * YALNIZ mobil PlayerProfileCard'ın tek "Bildir / Engelle" butonundan açılır.
 * Masaüstünde ayrı Engelle / Bildir / Bildir ve Engelle butonları korunur; bu
 * bileşen orada KULLANILMAZ.
 *
 * Salt sunum: hiçbir iş mantığı içermez. Seçenekler mevcut callback'leri (rapor
 * modalı / engelle onayı / birleşik akış) tetikler; onları PlayerProfileTrigger
 * yönetir. Seçilen aksiyon önce sheet'i KAPATIR, sonra ilgili modalı açar.
 *
 * Katman: document.body'e portallanır → parent stacking context'ten etkilenmez.
 * Profil kartının (--z-profile-card) BİR ÜST seviyesinde (--z-card-sheet) durur;
 * karttan sonra açılan ReportModal / ConfirmDialog (--z-modal-nested) bunun da
 * üstündedir (seçim anında sheet zaten kapandığından çakışma olmaz). ESC / backdrop
 * / Vazgeç YALNIZ sheet'i kapatır; alttaki profil kartı açık kalır (kartın ESC'si
 * trigger'da sheet açıkken bastırılır). Backdrop ayrı portal olduğundan tık
 * karttaki kapatmaya SIZMAZ.
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface SecurityActionSheetProps {
  /** Başlık altı bağlam etiketi (ör. "@kullanıcı için"). */
  title?: string;
  /** "Bildir" → sheet kapanır, mevcut ReportModal açılır. */
  onReport: () => void;
  /** "Engelle" → sheet kapanır, mevcut engelleme ConfirmDialog'u açılır. */
  onBlock: () => void;
  /** "Bildir ve Engelle" → sheet kapanır, mevcut birleşik akış açılır. */
  onReportAndBlock: () => void;
  /** "Vazgeç" / backdrop / ESC → yalnız sheet'i kapatır. */
  onClose: () => void;
}

export function SecurityActionSheet({
  title,
  onReport,
  onBlock,
  onReportAndBlock,
  onClose,
}: SecurityActionSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);

  // Açılınca odak sheet'e girer; kapanınca açan butona (Bildir / Engelle) döner.
  // Bir seçenek seçilirse (rapor/onay modalı açılır) o modal mount'ta kendini
  // odaklar (30ms) → bu senkron restore'u ezer, böylece odak doğru modala geçer.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => firstRef.current?.focus(), 20);
    return () => {
      window.clearTimeout(t);
      opener?.focus?.();
    };
  }, []);

  // ESC yalnız bu sheet'i kapatır (kartın ESC'si trigger'da bastırılmıştır).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Basit focus-trap — Tab yalnız sheet içinde döner.
  const onSheetKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const nodes = sheetRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
    if (!nodes || nodes.length === 0) return;
    const list = Array.from(nodes);
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="sec-sheet-overlay" role="presentation" onClick={onClose}>
      <div
        className="sec-sheet"
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Bildir veya engelle"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onSheetKeyDown}
      >
        <span className="sec-sheet-grip" aria-hidden="true" />
        {title && <p className="sec-sheet-title">{title}</p>}
        <button ref={firstRef} type="button" className="sec-sheet-opt" onClick={onReport}>
          Bildir
        </button>
        <button
          type="button"
          className="sec-sheet-opt sec-sheet-opt--danger"
          onClick={onBlock}
        >
          Engelle
        </button>
        <button
          type="button"
          className="sec-sheet-opt sec-sheet-opt--danger"
          onClick={onReportAndBlock}
        >
          Bildir ve Engelle
        </button>
        <button type="button" className="sec-sheet-cancel" onClick={onClose}>
          Vazgeç
        </button>
      </div>
    </div>,
    document.body,
  );
}
