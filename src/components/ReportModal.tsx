/**
 * ReportModal.tsx — Yeniden kullanılabilir "Bildir" modalı (UGC güvenlik).
 *
 * Kullanıcıyı VEYA bir mesajı bildirmek için ortak, mobil-öncelikli, klavye
 * erişilebilir diyalog. Torble modal dilini (confirm-* cam + blur + pop) izler;
 * document.body'e portallanır, ESC / backdrop / × ile kapanır, scroll lock'lar.
 *
 * Sözleşme: içerik/karar dışarıda. onSubmit(reason, detail) çağrılır; modal
 * yalnız loading → success/error durumlarını yönetir. Snapshot veya yasaklı
 * metin ASLA kullanıcıya geri gösterilmez.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  REPORT_REASONS,
  REPORT_DETAIL_MAX,
  type ReportReason,
  type ReportResult,
} from "../lib/moderation";

export interface ReportSubmitResult extends ReportResult {
  /** Başarı durumunda ek not (ör. "Kullanıcı engellendi."). */
  successNote?: string;
}

interface ReportModalProps {
  /** Başlık: kullanıcı mı mesaj mı bildiriliyor. */
  kind: "user" | "message";
  onSubmit: (reason: ReportReason, detail: string | null) => Promise<ReportSubmitResult>;
  onClose: () => void;
}

export function ReportModal({ kind, onSubmit, onClose }: ReportModalProps) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [detail, setDetail] = useState("");
  const [phase, setPhase] = useState<"form" | "submitting" | "done">("form");
  const [error, setError] = useState<string | null>(null);
  const [successNote, setSuccessNote] = useState<string | null>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const title = kind === "user" ? "Kullanıcıyı bildir" : "Mesajı bildir";

  useEffect(() => {
    const t = setTimeout(() => firstRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  // Scroll lock + ESC (submitting sırasında kapatma yok).
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "submitting") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, phase]);

  // Basit focus-trap — Tab modal içinde döner.
  const onModalKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const nodes = modalRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
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

  const submit = async () => {
    if (!reason || phase === "submitting") return;
    setPhase("submitting");
    setError(null);
    const res = await onSubmit(reason, reason === "other" ? detail.trim() || null : null);
    if (res.ok) {
      setSuccessNote(res.successNote ?? null);
      setPhase("done");
    } else {
      setError(res.error ?? "Bildirim gönderilemedi, tekrar dene.");
      setPhase("form");
    }
  };

  const busy = phase === "submitting";

  return createPortal(
    <div
      className="confirm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={() => !busy && onClose()}
    >
      <div
        className="confirm-modal report-modal"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onModalKeyDown}
      >
        <button
          type="button"
          className="report-close"
          onClick={() => !busy && onClose()}
          aria-label="Kapat"
          disabled={busy}
        >
          ×
        </button>

        {phase === "done" ? (
          <div className="report-done">
            <div className="report-done-mark" aria-hidden="true">✓</div>
            <h2 className="confirm-title">Bildirin alındı</h2>
            <p className="confirm-desc">
              Bildirimin incelenmek üzere iletildi.{successNote ? ` ${successNote}` : ""}
            </p>
            <p className="report-note">Bildirimin, bildirdiğin kişiye gösterilmez.</p>
            <div className="confirm-actions">
              <button
                type="button"
                className="confirm-btn confirm-btn--primary"
                onClick={onClose}
                ref={firstRef}
              >
                Tamam
              </button>
            </div>
          </div>
        ) : (
          <>
            <h2 className="confirm-title">{title}</h2>
            <p className="confirm-desc">Neden bildiriyorsun?</p>

            <div className="report-reasons" role="radiogroup" aria-label="Bildirme nedeni">
              {REPORT_REASONS.map((opt, i) => {
                const active = reason === opt.value;
                return (
                  <button
                    key={opt.value}
                    ref={i === 0 ? firstRef : undefined}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`report-reason${active ? " report-reason--active" : ""}`}
                    onClick={() => setReason(opt.value)}
                    disabled={busy}
                  >
                    <span className="report-radio" aria-hidden="true" />
                    <span>{opt.label}</span>
                  </button>
                );
              })}
            </div>

            {reason === "other" && (
              <textarea
                className="report-detail"
                placeholder="Kısaca açıkla (isteğe bağlı)"
                value={detail}
                maxLength={REPORT_DETAIL_MAX}
                onChange={(e) => setDetail(e.target.value)}
                disabled={busy}
                rows={3}
              />
            )}

            {error && <p className="report-error" role="alert">{error}</p>}
            <p className="report-note">Bildirimin, bildirdiğin kişiye gösterilmez.</p>

            <div className="confirm-actions">
              <button
                type="button"
                className="confirm-btn confirm-btn--ghost"
                onClick={() => !busy && onClose()}
                disabled={busy}
              >
                Vazgeç
              </button>
              <button
                type="button"
                className="confirm-btn confirm-btn--danger"
                onClick={() => void submit()}
                disabled={busy || !reason}
              >
                {busy ? "Gönderiliyor…" : "Bildir"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
