/**
 * ConfirmDialog.tsx — premium koyu-mavi onay modalı (paylaşılan).
 *
 * Torble modal dilini (uc-/pem- ile aynı cam + blur + pop) izleyen, yıkıcı
 * aksiyonlar için küçük onay diyaloğu. Opsiyonel "Bir daha sorma" onay kutusu;
 * onaylanırken işaretli olup olmadığını onConfirm'e geçirir (çağıran kalıcılığı
 * kendi yönetir — örn. localStorage). z-index bildirim bottom-sheet'inin (6301)
 * üstündedir, böylece mobilde panel açıkken de görünür.
 */
import { useEffect, useRef, useState } from "react";

interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Verilirse "Bir daha sorma" onay kutusu gösterilir. */
  dontAskAgainLabel?: string;
  /** Yıkıcı aksiyon → onay butonu kırmızımsı tonda. */
  destructive?: boolean;
  /** İşlem sürerken butonları kilitler. */
  busy?: boolean;
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  dontAskAgainLabel,
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const t = setTimeout(() => confirmRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  return (
    <div
      className="confirm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={() => !busy && onCancel()}
    >
      <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="confirm-title">{title}</h2>
        <p className="confirm-desc">{description}</p>

        {dontAskAgainLabel && (
          <label className="confirm-check">
            <input
              type="checkbox"
              checked={dontAskAgain}
              disabled={busy}
              onChange={(e) => setDontAskAgain(e.target.checked)}
            />
            <span>{dontAskAgainLabel}</span>
          </label>
        )}

        <div className="confirm-actions">
          <button
            type="button"
            className="confirm-btn confirm-btn--ghost"
            onClick={() => !busy && onCancel()}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`confirm-btn ${destructive ? "confirm-btn--danger" : "confirm-btn--primary"}`}
            onClick={() => !busy && onConfirm(dontAskAgain)}
            disabled={busy}
          >
            {busy ? "İşleniyor…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
