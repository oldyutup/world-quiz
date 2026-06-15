/**
 * NicknameModal.tsx
 *
 * İlk-giriş kullanıcı adı seçme modalı (web + native).
 *
 * Kendi kullanıcı adını HENÜZ seçmemiş (has_chosen_username=false) her oturum
 * için ana menü ÜSTÜNDE zorunlu olarak gösterilir: email-derived/sosyal/Google
 * girişi fark etmez. Kullanıcı geçerli ve müsait bir ad seçmeden oyun/profil
 * akışına devam edemez. Tek çıkış "Vazgeç" — bu da kullanıcıyı tekrar çıkış
 * yaptırır (asla adsız şekilde online akışa sokmaz).
 *
 * İlk seçim ücretsiz ve sınırsızdır (14 gün / 500 Gold kuralı YOK); o kural
 * sonradan değiştirme için profil panelindeki UsernameChangeModal'da geçerli.
 * Validasyon + benzersizlik (Türkçe-katlanmış key) merkezî lib/username.ts ve
 * setInitialUsername üzerinden, server unique index'iyle güvence altında.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { setInitialUsername, type Profile } from "../lib/auth";
import {
  sanitizeUsernameInput,
  validateUsername,
  checkUsernameAvailability,
  USERNAME_MAX_LENGTH,
} from "../lib/username";

interface Props {
  /** Signed-in user's id. Email / real name are intentionally omitted so they
   *  cannot leak into the public username. */
  userId: string;
  onSuccess: (profile: Profile) => void;
  /** Abort: signs the user back out and returns to the logged-out home. */
  onCancel: () => void;
}

export default function NicknameModal({ userId, onSuccess, onCancel }: Props) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // Debounced availability result for the currently-valid input.
  const [availability, setAvailability] = useState<
    "idle" | "checking" | "available" | "taken"
  >("idle");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);

  const clientError = useMemo<string | null>(() => {
    if (value.trim().length === 0) return null;
    return validateUsername(value);
  }, [value]);

  // Live availability check (debounced) once the input passes format validation.
  // Authoritative uniqueness is still enforced on submit by setInitialUsername.
  useEffect(() => {
    if (value.trim().length === 0 || clientError) {
      setAvailability("idle");
      return;
    }
    let alive = true;
    setAvailability("checking");
    const t = setTimeout(async () => {
      const result = await checkUsernameAvailability(value);
      if (!alive) return;
      setAvailability(result.available ? "available" : "taken");
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [value, clientError]);

  const canSubmit =
    !submitting &&
    value.trim().length > 0 &&
    !clientError &&
    availability !== "taken";

  const displayError =
    serverError ??
    clientError ??
    (availability === "taken" ? "Bu kullanıcı adı zaten alınmış." : null);

  async function handleSubmit() {
    if (!canSubmit) return;
    setServerError(null);
    setSubmitting(true);
    try {
      const result = await setInitialUsername(userId, value);
      if (result.error) {
        if (result.error.code === "taken") setAvailability("taken");
        setServerError(result.error.message);
        return;
      }
      onSuccess(result.data);
    } catch {
      setServerError("Bağlantı hatası, tekrar dene.");
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

  return (
    <div className="nick-overlay" role="dialog" aria-modal="true" aria-labelledby="nick-title">
      <div className="nick-modal">
        <div className="nick-emoji" aria-hidden="true">🧭</div>
        <h2 className="nick-title" id="nick-title">Kullanıcı Adını Seç</h2>
        <p className="nick-sub">
          Oyunda görünecek kullanıcı adını seç. Bunu daha sonra profilinden
          değiştirebilirsin.
        </p>

        <label className="nick-label" htmlFor="nick-input">KULLANICI ADI</label>
        <div className="nick-input-wrap">
          <span className="nick-input-at" aria-hidden="true">@</span>
          <input
            ref={inputRef}
            id="nick-input"
            type="text"
            className="nick-input"
            value={value}
            placeholder="kullanici_adi"
            maxLength={USERNAME_MAX_LENGTH}
            disabled={submitting}
            onChange={(e) => {
              setServerError(null);
              // Strip a leading '@' the user may type; keep Türkçe + case as-is.
              setValue(sanitizeUsernameInput(e.target.value));
            }}
            onKeyDown={handleKey}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
          />
        </div>
        <p className="nick-hint">
          3-20 karakter. Harf, rakam, nokta, tire ve alt çizgi.
        </p>

        {displayError && <div className="nick-error">{displayError}</div>}
        {!displayError && availability === "available" && (
          <div className="nick-ok">Bu kullanıcı adı uygun.</div>
        )}

        <button
          type="button"
          className="nick-primary"
          onClick={handleSubmit}
          disabled={!canSubmit}
        >
          {submitting ? "Kaydediliyor…" : "Devam Et"}
        </button>

        <button
          type="button"
          className="nick-cancel"
          onClick={() => !submitting && onCancel()}
          disabled={submitting}
        >
          Vazgeç
        </button>
      </div>
    </div>
  );
}
