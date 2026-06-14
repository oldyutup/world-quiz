/**
 * AvatarPickerModal.tsx — profile customization sheet (Avatar Phase 1B+).
 *
 * The only FUNCTIONAL surface is "Ücretsiz Avatarlar": the curated catalog
 * (src/data/avatars.ts) plus a "Varsayılan" tile that resets to the
 * username-initial fallback (avatar_id = null). Selection is local until
 * "Kaydet"; saving still calls updateAvatar(profile.id, selected), which writes
 * ONLY avatar_id + updated_at — byte-identical to before. On success the parent
 * patches profile.avatar_id in React state and closes the modal.
 *
 * The remaining sections (achievements, premium, frames, own-photo) are purely
 * visual "Yakında" placeholders: no clicks, no ids, no persistence, no backend,
 * no payments, no uploads, no permissions, no prices. They preview where
 * customization is heading without enabling anything. Nothing here touches
 * gameplay / auth / friends / navigation.
 *
 * Visuals reuse the dark glass language; on the native app the same markup is a
 * bottom sheet (scrolling body + pinned footer) via html.is-native-app rules.
 */
import { useEffect, useState } from "react";
import { AVATARS } from "../data/avatars";
import { updateAvatar, type Profile } from "../lib/auth";
import { Avatar } from "./Avatar";

/* ── Placeholder previews ────────────────────────────────────────────────────
 * NONE of the entries below are selectable, persisted, or tied to any backend.
 * No id here ever reaches updateAvatar. They exist only to show users what is
 * coming, so the screen reads as future-ready without unlocking anything. */
const ACHIEVEMENT_PREVIEWS = [
  { emoji: "🏁", label: "Bayrak Ustası", gradient: "linear-gradient(135deg,#ee0979,#ff6a00)" },
  { emoji: "🏰", label: "Kuşatma Fatihi", gradient: "linear-gradient(135deg,#8e2de2,#4a00e0)" },
  { emoji: "🧭", label: "Rota Uzmanı", gradient: "linear-gradient(135deg,#c94b4b,#4b134f)" },
  { emoji: "🔥", label: "Seri Galibiyet", gradient: "linear-gradient(135deg,#f7b733,#fc4a1a)" },
  { emoji: "💯", label: "İlk 100 Oyuncu", gradient: "linear-gradient(135deg,#1a2980,#26d0ce)" },
] as const;

const PREMIUM_PREVIEWS = [
  { emoji: "👑", gradient: "linear-gradient(135deg,#f9d423,#e6912b)" },
  { emoji: "💎", gradient: "linear-gradient(135deg,#43cea2,#185a9d)" },
  { emoji: "🔱", gradient: "linear-gradient(135deg,#654ea3,#eaafc8)" },
] as const;

const FRAME_PREVIEWS = [
  { ring: "apk-frame--gold", label: "Altın" },
  { ring: "apk-frame--neon", label: "Neon" },
  { ring: "apk-frame--aurora", label: "Aurora" },
] as const;

function LockIcon() {
  return (
    <svg
      className="apk-ico"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.5" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </svg>
  );
}

interface Props {
  profile: Profile;
  onClose: () => void;
  /** Fires with the saved avatar id (or null for default) after a successful
   *  write so the parent can patch profile state. */
  onSuccess: (avatarId: string | null) => void;
}

export function AvatarPickerModal({ profile, onClose, onSuccess }: Props) {
  const [selected, setSelected] = useState<string | null>(profile.avatar_id ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  const current = profile.avatar_id ?? null;
  const unchanged = selected === current;

  async function handleSave() {
    if (submitting || unchanged) return;
    setError(null);
    setSubmitting(true);
    try {
      const { data, error: updErr } = await updateAvatar(profile.id, selected);
      if (updErr || !data) {
        setError(updErr?.message || "Avatar kaydedilemedi, tekrar dene.");
        return;
      }
      onSuccess(data.avatar_id ?? null);
    } catch {
      setError("Bağlantı hatası, tekrar dene.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="apk-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Avatarını Seç"
      onClick={() => !submitting && onClose()}
    >
      <div className="apk-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="apk-close"
          onClick={() => !submitting && onClose()}
          aria-label="Kapat"
        >
          ×
        </button>

        <div className="apk-head">
          <h2 className="apk-title">Avatarını Seç</h2>
          <p className="apk-sub">Profilini kişiselleştir.</p>
        </div>

        <div className="apk-body">
          {/* Section A — Ücretsiz Avatarlar (the only active surface). */}
          <section className="apk-section">
            <header className="apk-section-head">
              <span className="apk-section-label">Ücretsiz Avatarlar</span>
            </header>
            <div className="apk-free-row" role="group" aria-label="Ücretsiz Avatarlar">
              {/* Varsayılan / null — reset to the username-initial fallback. */}
              <button
                type="button"
                className={`apk-tile${selected === null ? " apk-tile--active" : ""}`}
                onClick={() => setSelected(null)}
                aria-pressed={selected === null}
              >
                <Avatar avatarId={null} username={profile.username} size={56} />
                <span className="apk-tile-label">Varsayılan</span>
                {selected === null && <span className="apk-check" aria-hidden="true">✓</span>}
              </button>

              {AVATARS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`apk-tile${selected === a.id ? " apk-tile--active" : ""}`}
                  onClick={() => setSelected(a.id)}
                  aria-pressed={selected === a.id}
                  title={a.label}
                >
                  <Avatar avatarId={a.id} username={profile.username} size={56} />
                  <span className="apk-tile-label">{a.label}</span>
                  {selected === a.id && <span className="apk-check" aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
          </section>

          {/* Section B — Başarımla Açılanlar (locked preview, no action). */}
          <section className="apk-section apk-section--locked">
            <header className="apk-section-head">
              <span className="apk-section-label">Başarımla Açılanlar</span>
              <span className="apk-badge apk-badge--locked">
                <LockIcon />
                Başarımla açılır
              </span>
            </header>
            <div className="apk-lock-row" aria-disabled="true">
              {ACHIEVEMENT_PREVIEWS.map((a) => (
                <div className="apk-lock-tile" key={a.label}>
                  <span className="apk-lock-avatar" style={{ background: a.gradient }}>
                    <span aria-hidden="true">{a.emoji}</span>
                    <span className="apk-lock-glyph">
                      <LockIcon />
                    </span>
                  </span>
                  <span className="apk-tile-label">{a.label}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Section C — Premium Avatarlar (locked preview, no prices, no payment). */}
          <section className="apk-section apk-section--locked">
            <header className="apk-section-head">
              <span className="apk-section-label">Premium Avatarlar</span>
              <span className="apk-badge apk-badge--soon">Yakında</span>
            </header>
            <div className="apk-premium" aria-disabled="true">
              <div className="apk-premium-orbs">
                {PREMIUM_PREVIEWS.map((p) => (
                  <span className="apk-premium-orb" style={{ background: p.gradient }} key={p.emoji}>
                    <span aria-hidden="true">{p.emoji}</span>
                  </span>
                ))}
                <span className="apk-premium-orb apk-premium-orb--more" aria-hidden="true">
                  <LockIcon />
                </span>
              </div>
              <p className="apk-section-note">Özel avatar paketleri yakında.</p>
            </div>
          </section>

          {/* Section D — Profil Çerçeveleri (locked preview, no frame_id). */}
          <section className="apk-section apk-section--locked">
            <header className="apk-section-head">
              <span className="apk-section-label">Profil Çerçeveleri</span>
              <span className="apk-badge apk-badge--soon">Yakında</span>
            </header>
            <div className="apk-frame-row" aria-disabled="true">
              {FRAME_PREVIEWS.map((f) => (
                <span className={`apk-frame-prev ${f.ring}`} key={f.label}>
                  <Avatar avatarId={profile.avatar_id} username={profile.username} size={44} />
                </span>
              ))}
            </div>
            <p className="apk-section-note">Avatar çerçeveleri yakında.</p>
          </section>

          {/* Section E — Kendi Fotoğrafın (locked, no file picker / storage). */}
          <section className="apk-section apk-section--locked">
            <header className="apk-section-head">
              <span className="apk-section-label">Kendi Fotoğrafın</span>
              <span className="apk-badge apk-badge--soon">Yakında</span>
            </header>
            <div className="apk-photo-card" aria-disabled="true">
              <span className="apk-photo-glyph" aria-hidden="true">
                <svg
                  className="apk-ico"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.7}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.4l.9-1.5A1.5 1.5 0 0 1 10.1 3.8h3.8a1.5 1.5 0 0 1 1.3.7l.9 1.5h1.4A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z" />
                  <circle cx="12" cy="12.5" r="3.1" />
                </svg>
              </span>
              <p className="apk-section-note">
                Kendi fotoğrafını profilinde kullanma özelliği yakında.
              </p>
            </div>
          </section>
        </div>

        {error && <div className="apk-error">{error}</div>}

        <div className="apk-actions">
          <button
            type="button"
            className="apk-btn apk-btn--ghost"
            onClick={() => !submitting && onClose()}
            disabled={submitting}
          >
            Vazgeç
          </button>
          <button
            type="button"
            className="apk-btn apk-btn--primary"
            onClick={handleSave}
            disabled={submitting || unchanged}
          >
            {submitting ? "Kaydediliyor…" : "Kaydet"}
          </button>
        </div>
      </div>
    </div>
  );
}
