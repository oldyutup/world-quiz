/**
 * PasswordRecoveryScreen.tsx
 *
 * "Şifremi unuttum" e-postasındaki bağlantı açıldığında gösterilen güvenli yeni
 * şifre belirleme ekranı. Yalnızca GEÇERLİ bir recovery session bağlamında
 * çalışır: App, Supabase'in PASSWORD_RECOVERY auth event'ini (ve recovery URL
 * hash'ini) algılayıp bu ekranı normal giriş ekranı yerine açar.
 *
 * Şifre güncelleme TAMAMEN Supabase Auth üzerinden (updateUser) yapılır; şifre
 * hiçbir yerde saklanmaz. Geçersiz/süresi dolmuş bağlantıda form yerine bilgi
 * mesajı + "yeni bağlantı iste" gösterilir.
 */
import { useState } from "react";
import { updatePassword, PASSWORD_MIN_LENGTH } from "../lib/auth";

interface Props {
  /** Geçerli bir recovery session var mı? false → süresi dolmuş/geçersiz bağlantı. */
  valid: boolean;
  /** Şifre başarıyla güncellendi → çıkış yap + giriş ekranına dön. */
  onDone: () => void;
  /** Geçersiz/süresi dolmuş bağlantı → "Şifremi unuttum" akışını yeniden aç. */
  onRequestNew: () => void;
  /** Ekranı kapat (recovery URL'i temizlenir, ana ekrana döner). */
  onClose: () => void;
}

export default function PasswordRecoveryScreen({
  valid,
  onDone,
  onRequestNew,
  onClose,
}: Props) {
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const tooShort = password.length > 0 && password.length < PASSWORD_MIN_LENGTH;
  const mismatch = password2.length > 0 && password !== password2;
  const canSubmit =
    !submitting &&
    password.length >= PASSWORD_MIN_LENGTH &&
    password === password2;

  const liveError =
    error ??
    (tooShort
      ? `Şifre en az ${PASSWORD_MIN_LENGTH} karakter olmalı.`
      : mismatch
      ? "Şifreler eşleşmiyor."
      : null);

  async function handleSubmit() {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const { error: updErr } = await updatePassword(password);
      if (updErr) {
        setError(
          "Bu şifre yenileme bağlantısı geçersiz veya süresi dolmuş olabilir. Yeni bir bağlantı iste."
        );
        return;
      }
      setSuccess(true);
    } catch {
      setError("Bağlantı hatası, tekrar dene.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleSubmit();
    }
  }

  // Geçersiz/süresi dolmuş bağlantı.
  if (!valid) {
    return (
      <div className="nick-overlay pwr-overlay" role="dialog" aria-modal="true">
        <div className="nick-modal">
          <div className="nick-emoji" aria-hidden="true">⏳</div>
          <h2 className="nick-title">Bağlantı geçersiz</h2>
          <p className="nick-sub">
            Bu şifre yenileme bağlantısı geçersiz veya süresi dolmuş olabilir.
            Yeni bir bağlantı iste.
          </p>
          <button type="button" className="nick-primary" onClick={onRequestNew}>
            Yeni bağlantı iste
          </button>
          <button type="button" className="nick-cancel" onClick={onClose}>
            Kapat
          </button>
        </div>
      </div>
    );
  }

  // Başarı.
  if (success) {
    return (
      <div className="nick-overlay pwr-overlay" role="dialog" aria-modal="true">
        <div className="nick-modal">
          <div className="nick-emoji" aria-hidden="true">✅</div>
          <h2 className="nick-title">Şifren güncellendi</h2>
          <p className="nick-sub">
            Şifren güncellendi. Artık yeni şifrenle giriş yapabilirsin.
          </p>
          <button type="button" className="nick-primary" onClick={onDone}>
            Giriş yap
          </button>
        </div>
      </div>
    );
  }

  // Yeni şifre belirleme formu.
  return (
    <div className="nick-overlay pwr-overlay" role="dialog" aria-modal="true" aria-labelledby="pwr-title">
      <div className="nick-modal">
        <div className="nick-emoji" aria-hidden="true">🔐</div>
        <h2 className="nick-title" id="pwr-title">Yeni şifre belirle</h2>
        <p className="nick-sub">Hesabın için yeni bir şifre belirle.</p>

        <label className="nick-label" htmlFor="pwr-pw">YENİ ŞİFRE</label>
        <div className="nick-input-wrap">
          <input
            id="pwr-pw"
            type={showPassword ? "text" : "password"}
            className="nick-input nick-input--pw"
            value={password}
            placeholder={`En az ${PASSWORD_MIN_LENGTH} karakter`}
            disabled={submitting}
            onChange={(e) => {
              setError(null);
              setPassword(e.target.value);
            }}
            onKeyDown={handleKey}
            autoComplete="new-password"
          />
          <button
            type="button"
            className="nick-eye"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Şifreyi gizle" : "Şifreyi göster"}
            tabIndex={-1}
          >
            {showPassword ? "🙈" : "👁️"}
          </button>
        </div>

        <label className="nick-label nick-label--gap" htmlFor="pwr-pw2">YENİ ŞİFRE TEKRAR</label>
        <div className="nick-input-wrap">
          <input
            id="pwr-pw2"
            type={showPassword ? "text" : "password"}
            className="nick-input nick-input--pw"
            value={password2}
            placeholder="Şifreyi tekrar yaz"
            disabled={submitting}
            onChange={(e) => {
              setError(null);
              setPassword2(e.target.value);
            }}
            onKeyDown={handleKey}
            autoComplete="new-password"
          />
          <button
            type="button"
            className="nick-eye"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Şifreyi gizle" : "Şifreyi göster"}
            tabIndex={-1}
          >
            {showPassword ? "🙈" : "👁️"}
          </button>
        </div>

        {liveError && <div className="nick-error">{liveError}</div>}

        <button
          type="button"
          className="nick-primary"
          onClick={handleSubmit}
          disabled={!canSubmit}
        >
          {submitting ? "Güncelleniyor…" : "Şifreyi güncelle"}
        </button>
      </div>
    </div>
  );
}
