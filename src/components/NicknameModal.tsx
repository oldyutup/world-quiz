/**
 * NicknameModal.tsx
 *
 * İlk-giriş hesap tamamlama modalı (web + native).
 *
 * Kendi kullanıcı adını HENÜZ seçmemiş (has_chosen_username=false) her oturum
 * için ana menü ÜSTÜNDE zorunlu olarak gösterilir: sosyal/Google girişi fark
 * etmez. Kullanıcı geçerli ve müsait bir ad seçmeden oyun/profil akışına devam
 * edemez. Tek çıkış "Vazgeç" — bu da kullanıcıyı tekrar çıkış yaptırır (asla
 * adsız şekilde online akışa sokmaz).
 *
 * ŞİFRE BELİRLEME: Bu modala yalnızca e-posta/şifre kimliği OLMAYAN (Google ilk
 * kayıt) kullanıcılar düşer, bu yüzden aynı ekranda kullanıcı adının yanında bir
 * giriş şifresi de belirletilir. Böylece sonraki girişlerde hem Google ile hem de
 * aynı Google hesabının e-postası + bu şifre ile giriş yapılabilir. Şifre AKTİF
 * OAuth oturumu içinde supabase.auth.updateUser({ password }) ile aynı hesaba
 * eklenir — yeni auth user oluşmaz, profil/Gold/XP/arkadaş/DM/OAuth bağlantısı
 * korunur. Şifre belirlenemezse onboarding tamamlanmaz (profil satırı oluşmaz),
 * kullanıcı tekrar dener; OAuth oturumu yanlışlıkla kapatılmaz.
 *
 * İlk kullanıcı adı seçimi ücretsiz ve sınırsızdır (14 gün / 500 Gold kuralı
 * YOK); o kural sonradan değiştirme için profil panelindeki AccountSettingsModal'da
 * geçerli. Validasyon + benzersizlik (Türkçe-katlanmış key) merkezî
 * lib/username.ts ve setInitialUsername üzerinden, server unique index'iyle
 * güvence altına alınır.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  getAccountAuthInfo,
  setInitialUsername,
  updatePassword,
  PASSWORD_MIN_LENGTH,
  type Profile,
} from "../lib/auth";
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

  // Şifre belirleme — yalnızca e-posta/şifre kimliği olmayan (Google ilk kayıt)
  // kullanıcı için gösterilir. Zaten şifresi olan nadir bir kullanıcı (legacy)
  // bu modala düşerse şifre alanları gizlenir ve eski davranış korunur.
  const [needsPasswordSetup, setNeedsPasswordSetup] = useState(false);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // Şifre eklendi ama username adımı (örn. "ad alınmış") henüz tamamlanmadıysa
  // tekrar updateUser çağırmamak için.
  const [passwordSet, setPasswordSet] = useState(false);

  useEffect(() => {
    let alive = true;
    getAccountAuthInfo().then((info) => {
      if (alive) setNeedsPasswordSetup(!info.hasPassword);
    });
    return () => {
      alive = false;
    };
  }, []);

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

  // Şifre alanları için canlı doğrulama (yalnız gerektiğinde).
  const passwordError = useMemo<string | null>(() => {
    if (!needsPasswordSetup) return null;
    if (password.length === 0) return null;
    if (password.length < PASSWORD_MIN_LENGTH) {
      return `Şifre en az ${PASSWORD_MIN_LENGTH} karakter olmalı.`;
    }
    if (password2.length > 0 && password !== password2) {
      return "Şifreler eşleşmiyor.";
    }
    return null;
  }, [needsPasswordSetup, password, password2]);

  // Şifre adımı tamamlanmaya hazır mı? (gerekmiyorsa ya da zaten set edildiyse ok)
  const passwordReady =
    !needsPasswordSetup ||
    passwordSet ||
    (password.length >= PASSWORD_MIN_LENGTH && password === password2);

  const canSubmit =
    !submitting &&
    value.trim().length > 0 &&
    !clientError &&
    availability !== "taken" &&
    passwordReady;

  const displayError =
    serverError ??
    clientError ??
    passwordError ??
    (availability === "taken" ? "Bu kullanıcı adı zaten alınmış." : null);

  async function handleSubmit() {
    if (!canSubmit) return;
    setServerError(null);
    setSubmitting(true);
    try {
      // 1) Kullanıcı adı benzersizliğini ŞİFREDEN ÖNCE doğrula: ad alınmışsa
      //    boşuna şifre belirlenmesin. Otorite yine setInitialUsername'deki
      //    unique index'tir; bu erken kontrol yalnız sırayı iyileştirir. Ağ
      //    hatasında (avail.error) bloke etmeyiz — setInitialUsername son sözü
      //    söyler.
      const avail = await checkUsernameAvailability(value);
      if (!avail.available && !avail.error) {
        setAvailability("taken");
        setServerError("Bu kullanıcı adı zaten alınmış. Başka bir ad dene.");
        return;
      }

      // 2) Şifreyi belirle (gerekiyorsa). Başarısızsa onboarding tamamlanmaz:
      //    profil satırı oluşturulmaz, kullanıcı tekrar deneyebilir. OAuth oturumu
      //    bozulmaz (signOut çağrılmaz). passwordSet, username adımı sonradan
      //    başarısız olsa bile tekrar denemede şifrenin yeniden set edilmesini
      //    önler.
      if (needsPasswordSetup && !passwordSet) {
        const { error } = await updatePassword(password);
        if (error) {
          setServerError("Şifre belirlenemedi, tekrar dene.");
          return;
        }
        setPasswordSet(true);
      }

      // 3) Kullanıcı adını oluştur (profil satırı, otoriter uniqueness).
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
        <h2 className="nick-title" id="nick-title">
          {needsPasswordSetup ? "Hesabını tamamla" : "Kullanıcı Adını Seç"}
        </h2>
        <p className="nick-sub">
          {needsPasswordSetup
            ? "Kullanıcı adını ve şifreni belirle. Sonraki girişlerinde Google ile veya e-posta ve şifrenle devam edebilirsin."
            : "Oyunda görünecek kullanıcı adını seç. Bunu daha sonra profilinden değiştirebilirsin."}
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
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
          />
        </div>
        <p className="nick-hint">
          3-20 karakter. Harf, rakam, nokta, tire ve alt çizgi.
        </p>

        {needsPasswordSetup && (
          <div className="nick-pw-group">
            <label className="nick-label" htmlFor="nick-pw">ŞİFRE BELİRLE</label>
            <div className="nick-input-wrap">
              <input
                id="nick-pw"
                type={showPassword ? "text" : "password"}
                className="nick-input nick-input--pw"
                value={password}
                placeholder={`En az ${PASSWORD_MIN_LENGTH} karakter`}
                disabled={submitting}
                onChange={(e) => {
                  setServerError(null);
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

            <label className="nick-label nick-label--gap" htmlFor="nick-pw2">ŞİFRE TEKRAR</label>
            <div className="nick-input-wrap">
              <input
                id="nick-pw2"
                type={showPassword ? "text" : "password"}
                className="nick-input nick-input--pw"
                value={password2}
                placeholder="Şifreyi tekrar yaz"
                disabled={submitting}
                onChange={(e) => {
                  setServerError(null);
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
          </div>
        )}

        {displayError && <div className="nick-error">{displayError}</div>}
        {!displayError && availability === "available" && !needsPasswordSetup && (
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
