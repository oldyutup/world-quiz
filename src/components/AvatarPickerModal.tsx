/**
 * AvatarPickerModal.tsx — choose a curated built-in avatar (Avatar Phase 1B).
 *
 * Shows the curated catalog (src/data/avatars.ts) plus a "Varsayılan" tile that
 * resets to the username-initial fallback (avatar_id = null). Selection is
 * local until "Kaydet"; saving calls updateAvatar(userId, avatarId), which
 * validates the id client-side and writes only avatar_id + updated_at (never
 * username / xp / gold). On success the parent patches profile.avatar_id in
 * React state and closes the modal.
 *
 * Visuals reuse the dark glass modal language; on the native app the same
 * markup becomes a bottom sheet via html.is-native-app overrides in App.css.
 * No leaderboard / friends / gameplay / auth code is touched.
 */
import { useEffect, useState } from "react";
import { AVATARS } from "../data/avatars";
import { updateAvatar, type Profile } from "../lib/auth";
import { Avatar } from "./Avatar";

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

        <h2 className="apk-title">Avatarını Seç</h2>
        <p className="apk-sub">Profilinde görünecek avatarı seç.</p>

        <div className="apk-grid">
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
