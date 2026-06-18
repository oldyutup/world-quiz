/**
 * AccountSettingsModal.tsx
 *
 * Profil panelindeki "Kullanıcı adı ve şifre" kartından açılan TEK modal.
 * İki bölüm bir segment (tab) ile değiştirilir:
 *
 *   1) Kullanıcı adı — mevcut sistem AYNEN korunur: ilk değişiklik ücretsiz,
 *      sonrası 500 Gold + 14 gün cooldown, server-side change_username RPC.
 *      Client doğrudan profiles.username / profiles.gold yazmaz.
 *
 *   2) Şifre — TAMAMEN Supabase Auth üzerinden:
 *        • Google-only kullanıcı (şifresi yok) → "Şifre belirle": yeni + tekrar,
 *          updateUser({ password }). Yeni auth user oluşmaz; aynı hesaba şifre
 *          eklenir (OAuth bağlantısı / profil / Gold / XP korunur).
 *        • E-posta+şifre kullanıcısı → "Şifreyi değiştir": mevcut şifre güvenli
 *          reauthentication (signInWithPassword) ile doğrulanır, sonra
 *          updateUser({ password }). Şifre hiçbir yerde saklanmaz.
 *
 *   Bu kapsamda e-posta değiştirme YOKTUR.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  callChangeUsername,
  getAccountAuthInfo,
  updatePassword,
  verifyCurrentPassword,
  PASSWORD_MIN_LENGTH,
  USERNAME_CHANGE_COST,
  USERNAME_CHANGE_COOLDOWN_DAYS,
  type Profile,
} from "../lib/auth";
import {
  validateUsername,
  normalizeUsernameKey,
  sanitizeUsernameInput,
  USERNAME_MAX_LENGTH,
} from "../lib/username";
import { syncGoldFromServer } from "../lib/gold";

interface Props {
  profile: Profile;
  gold: number;
  onClose: () => void;
  /** Kullanıcı adı başarıyla değişince App profili + Gold'u günceller. */
  onUsernameSuccess: (next: { username: string; gold: number }) => void;
}

type Tab = "username" | "password";
type PwMode = "loading" | "set" | "change";

function computeCooldownDaysLeft(
  isFirst: boolean,
  changedAtIso: string | null | undefined
): number {
  if (isFirst) return 0;
  if (!changedAtIso) return 0;
  const changedAt = new Date(changedAtIso).getTime();
  if (!Number.isFinite(changedAt)) return 0;
  const elapsedMs = Date.now() - changedAt;
  const cooldownMs = USERNAME_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  if (elapsedMs >= cooldownMs) return 0;
  return Math.max(1, Math.ceil((cooldownMs - elapsedMs) / (24 * 60 * 60 * 1000)));
}

export function AccountSettingsModal({
  profile,
  gold,
  onClose,
  onUsernameSuccess,
}: Props) {
  const [tab, setTab] = useState<Tab>("username");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* ── Kullanıcı adı bölümü (UsernameChangeModal davranışı birebir) ── */
  const [uValue, setUValue] = useState("");
  const [uSubmitting, setUSubmitting] = useState(false);
  const [uServerError, setUServerError] = useState<string | null>(null);
  const uInputRef = useRef<HTMLInputElement>(null);

  const isFirstChange = (profile.username_change_count ?? 0) === 0;
  const cooldownDaysLeft = computeCooldownDaysLeft(
    isFirstChange,
    profile.username_changed_at ?? null
  );

  const uClientError: string | null = useMemo(() => {
    if (uValue.trim().length === 0) return null;
    return validateUsername(uValue);
  }, [uValue]);

  const normalizedKey = normalizeUsernameKey(uValue);
  const isSameAsCurrent =
    normalizedKey.length > 0 &&
    normalizedKey === normalizeUsernameKey(profile.username ?? "");

  let uButtonDisabled = uSubmitting;
  if (uValue.trim().length === 0) uButtonDisabled = true;
  if (uClientError) uButtonDisabled = true;
  if (isSameAsCurrent) uButtonDisabled = true;
  if (cooldownDaysLeft > 0) uButtonDisabled = true;
  if (!isFirstChange && gold < USERNAME_CHANGE_COST) uButtonDisabled = true;

  const uDisplayError: string | null = uServerError
    ? uServerError
    : isSameAsCurrent
    ? "Bu zaten mevcut kullanıcı adın."
    : uClientError;

  async function handleUsernameSubmit() {
    if (uButtonDisabled) return;
    setUServerError(null);
    setUSubmitting(true);
    try {
      const result = await callChangeUsername(uValue);
      if (!result.ok) {
        setUServerError(result.message || "İşlem gerçekleştirilemedi.");
        return;
      }
      syncGoldFromServer(result.gold);
      onUsernameSuccess({ username: result.username, gold: result.gold });
    } catch {
      setUServerError("Bağlantı hatası, tekrar dene.");
    } finally {
      setUSubmitting(false);
    }
  }

  const usernameActionLabel = isFirstChange
    ? "Ücretsiz Değiştir"
    : `${USERNAME_CHANGE_COST} Gold ile Değiştir`;

  /* ── Şifre bölümü ── */
  const [pwMode, setPwMode] = useState<PwMode>("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [current, setCurrent] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [pwSubmitting, setPwSubmitting] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getAccountAuthInfo().then((info) => {
      if (!alive) return;
      setEmail(info.email);
      setPwMode(info.hasPassword ? "change" : "set");
    });
    return () => {
      alive = false;
    };
  }, []);

  const pwTooShort = newPw.length > 0 && newPw.length < PASSWORD_MIN_LENGTH;
  const pwMismatch = newPw2.length > 0 && newPw !== newPw2;
  const pwValid = newPw.length >= PASSWORD_MIN_LENGTH && newPw === newPw2;
  const pwCanSubmit =
    !pwSubmitting &&
    pwMode !== "loading" &&
    pwValid &&
    (pwMode === "set" || current.length > 0);

  const pwLiveError =
    pwError ??
    (pwTooShort
      ? `Şifre en az ${PASSWORD_MIN_LENGTH} karakter olmalı.`
      : pwMismatch
      ? "Şifreler eşleşmiyor."
      : null);

  async function handlePasswordSubmit() {
    if (!pwCanSubmit) return;
    setPwError(null);
    setPwSuccess(null);
    setPwSubmitting(true);
    try {
      // E-posta+şifre kullanıcısı: yeni şifreden ÖNCE mevcut şifreyi güvenli
      // reauthentication ile doğrula. Şifre uygulama state'inde/kalıcı depoda
      // tutulmaz; yalnız bu çağrı boyunca bellektedir. (Sunucu require-current
      // bayrağı açıksa updatePassword'a verilen current_password de ikinci kez
      // doğrular; bayrak kapalıysa asıl doğrulama buradaki reauth'tur.)
      if (pwMode === "change") {
        if (!email) {
          setPwError("Hesap bilgisi alınamadı, tekrar dene.");
          return;
        }
        const { ok } = await verifyCurrentPassword(email, current);
        if (!ok) {
          setPwError("Mevcut şifre doğrulanamadı.");
          return;
        }
      }

      const { error } = await updatePassword(
        newPw,
        pwMode === "change" ? current : undefined
      );
      if (error) {
        setPwError(
          pwMode === "set"
            ? "Şifre belirlenemedi, tekrar dene."
            : "Şifre güncellenemedi, tekrar dene."
        );
        return;
      }

      if (pwMode === "set") {
        setPwSuccess(
          "Şifren oluşturuldu. Artık e-posta ve şifren ile de giriş yapabilirsin."
        );
        setPwMode("change"); // artık hesabın bir şifresi var
      } else {
        setPwSuccess("Şifren güncellendi.");
      }
      setCurrent("");
      setNewPw("");
      setNewPw2("");
    } catch {
      setPwError("Bağlantı hatası, tekrar dene.");
    } finally {
      setPwSubmitting(false);
    }
  }

  return (
    <div
      className="uc-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Kullanıcı adı ve şifre"
      onClick={() => !uSubmitting && !pwSubmitting && onClose()}
    >
      <div className="uc-modal acc-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="uc-close"
          onClick={() => !uSubmitting && !pwSubmitting && onClose()}
          aria-label="Kapat"
        >
          ×
        </button>

        <h2 className="uc-title">Kullanıcı adı ve şifre</h2>

        <div className="acc-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "username"}
            className={`acc-tab${tab === "username" ? " active" : ""}`}
            onClick={() => setTab("username")}
          >
            Kullanıcı adı
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "password"}
            className={`acc-tab${tab === "password" ? " active" : ""}`}
            onClick={() => setTab("password")}
          >
            Şifre
          </button>
        </div>

        {tab === "username" ? (
          <>
            <div className="uc-info">
              <p>
                {isFirstChange
                  ? "İlk kullanıcı adı seçimi ücretsizdir. Sonraki değişiklikler 500 Gold'dur."
                  : `Kullanıcı adı değişikliği ${USERNAME_CHANGE_COST} Gold'a mâl olur.`}
              </p>
              <p>
                Kullanıcı adını {USERNAME_CHANGE_COOLDOWN_DAYS} günde bir
                değiştirebilirsin.
              </p>
            </div>

            <label className="uc-label" htmlFor="acc-username-input">
              Yeni kullanıcı adı
            </label>
            <div className="uc-input-wrap">
              <span className="uc-input-at">@</span>
              <input
                ref={uInputRef}
                id="acc-username-input"
                type="text"
                className="uc-input"
                placeholder="ornek_ad"
                maxLength={USERNAME_MAX_LENGTH}
                value={uValue}
                disabled={uSubmitting}
                onChange={(e) => {
                  setUServerError(null);
                  setUValue(sanitizeUsernameInput(e.target.value));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleUsernameSubmit();
                  }
                }}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            {cooldownDaysLeft > 0 && (
              <div className="uc-warn">
                Kullanıcı adını tekrar değiştirmek için {cooldownDaysLeft} gün
                beklemelisin.
              </div>
            )}

            {!isFirstChange &&
              gold < USERNAME_CHANGE_COST &&
              cooldownDaysLeft === 0 && (
                <div className="uc-warn">
                  Yetersiz Gold. Bu işlem için {USERNAME_CHANGE_COST} Gold gerekli
                  (mevcut: {gold}).
                </div>
              )}

            {uDisplayError && cooldownDaysLeft === 0 && (
              <div className="uc-error">{uDisplayError}</div>
            )}

            <div className="uc-actions">
              <button
                type="button"
                className={`uc-btn uc-btn--primary${
                  isFirstChange ? " uc-btn--free" : ""
                }`}
                onClick={handleUsernameSubmit}
                disabled={uButtonDisabled}
              >
                {uSubmitting ? "İşleniyor…" : usernameActionLabel}
              </button>
            </div>
          </>
        ) : (
          <>
            {pwMode === "loading" ? (
              <div className="uc-info">
                <p>Hesap bilgisi yükleniyor…</p>
              </div>
            ) : (
              <>
                <div className="uc-info">
                  <p>
                    {pwMode === "set"
                      ? "E-posta ve şifre ile de giriş yapmak için bir şifre belirleyebilirsin."
                      : "Giriş şifreni değiştir. Önce mevcut şifreni doğrulaman gerekir."}
                  </p>
                </div>

                {pwMode === "change" && (
                  <>
                    <label className="uc-label" htmlFor="acc-current-pw">
                      Mevcut şifre
                    </label>
                    <div className="uc-input-wrap">
                      <input
                        id="acc-current-pw"
                        type={showPw ? "text" : "password"}
                        className="uc-input uc-input--pw"
                        value={current}
                        placeholder="Mevcut şifren"
                        disabled={pwSubmitting}
                        onChange={(e) => {
                          setPwError(null);
                          setCurrent(e.target.value);
                        }}
                        autoComplete="current-password"
                      />
                      <button
                        type="button"
                        className="uc-eye"
                        onClick={() => setShowPw((v) => !v)}
                        aria-label={showPw ? "Şifreyi gizle" : "Şifreyi göster"}
                        tabIndex={-1}
                      >
                        {showPw ? "🙈" : "👁️"}
                      </button>
                    </div>
                  </>
                )}

                <label className="uc-label" htmlFor="acc-new-pw">
                  {pwMode === "set" ? "Yeni şifre" : "Yeni şifre"}
                </label>
                <div className="uc-input-wrap">
                  <input
                    id="acc-new-pw"
                    type={showPw ? "text" : "password"}
                    className="uc-input uc-input--pw"
                    value={newPw}
                    placeholder={`En az ${PASSWORD_MIN_LENGTH} karakter`}
                    disabled={pwSubmitting}
                    onChange={(e) => {
                      setPwError(null);
                      setNewPw(e.target.value);
                    }}
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    className="uc-eye"
                    onClick={() => setShowPw((v) => !v)}
                    aria-label={showPw ? "Şifreyi gizle" : "Şifreyi göster"}
                    tabIndex={-1}
                  >
                    {showPw ? "🙈" : "👁️"}
                  </button>
                </div>

                <label className="uc-label" htmlFor="acc-new-pw2">
                  Yeni şifre tekrar
                </label>
                <div className="uc-input-wrap">
                  <input
                    id="acc-new-pw2"
                    type={showPw ? "text" : "password"}
                    className="uc-input uc-input--pw"
                    value={newPw2}
                    placeholder="Yeni şifreyi tekrar yaz"
                    disabled={pwSubmitting}
                    onChange={(e) => {
                      setPwError(null);
                      setNewPw2(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handlePasswordSubmit();
                      }
                    }}
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    className="uc-eye"
                    onClick={() => setShowPw((v) => !v)}
                    aria-label={showPw ? "Şifreyi gizle" : "Şifreyi göster"}
                    tabIndex={-1}
                  >
                    {showPw ? "🙈" : "👁️"}
                  </button>
                </div>

                {pwLiveError && <div className="uc-error">{pwLiveError}</div>}
                {pwSuccess && <div className="uc-ok">{pwSuccess}</div>}

                <div className="uc-actions">
                  <button
                    type="button"
                    className="uc-btn uc-btn--primary"
                    onClick={handlePasswordSubmit}
                    disabled={!pwCanSubmit}
                  >
                    {pwSubmitting
                      ? "İşleniyor…"
                      : pwMode === "set"
                      ? "Şifre belirle"
                      : "Şifreyi değiştir"}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
