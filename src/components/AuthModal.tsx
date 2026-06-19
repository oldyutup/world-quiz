import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import {
  getCurrentUser,
  getProfile,
  loadOrCreateProfile,
  requestPasswordReset,
  signInWithAppleWeb,
  signInWithEmail,
  signInWithGoogle,
  signUpWithEmail,
  type Profile,
} from "../lib/auth";
import {
  validateUsername,
  sanitizeUsernameInput,
  USERNAME_MAX_LENGTH,
} from "../lib/username";
import { signInWithApple } from "../lib/appleAuth";
import { signInWithGoogleNative } from "../lib/googleAuth";

type AuthMode = "login" | "signup";
/** Modal gövdesi: normal giriş/kayıt görünümü ya da "Şifremi unuttum" akışı.
 *  Aynı koyu-lacivert modal kabuğu içinde view değiştirilir (ayrı overlay yok). */
type AuthView = "auth" | "forgot";

/** "Şifremi unuttum" spam'ini önlemek için kısa istemci-tarafı cooldown.
 *  Sunucu tarafında Supabase Auth ayrıca rate-limit uygular. */
const RESET_COOLDOWN_SECONDS = 45;
const RESET_COOLDOWN_KEY = "torble_pwreset_cooldown_until";

function readResetCooldownRemaining(): number {
  try {
    const until = Number(localStorage.getItem(RESET_COOLDOWN_KEY) || 0);
    if (!Number.isFinite(until)) return 0;
    return Math.max(0, Math.ceil((until - Date.now()) / 1000));
  } catch {
    return 0;
  }
}

type AuthModalProps = {
  onClose: () => void;
  onGuest: () => void;
  onAuthSuccess: (profile: Profile | null) => void;
  /** Optional context-aware notice shown above the form (e.g. "Kuşatma moduna
   *  katılmak için giriş yapmalısın."). */
  headerNote?: string;
  /** Hides "Misafir olarak devam et" — for login-only modes (Kör Nokta). */
  hideGuest?: boolean;
  /** True only inside the Capacitor native shell. Switches the modal to the
   *  app-style layout (Apple / Google first, email collapsed). Web stays
   *  byte-for-byte unchanged when this is false/undefined. */
  isNative?: boolean;
  /** Auth Phase 3 (native only): called after a successful social sign-in when
   *  the user has no valid Torble username yet. App hides this modal and shows
   *  the NicknameModal, preserving the pending online target. Web never wires
   *  this and never reaches the native social branch that calls it. */
  onNeedsUsername?: (userId: string) => void;
  /** Modal açılışında doğrudan "Şifremi unuttum" görünümünü göster (geçersiz/
   *  süresi dolmuş recovery bağlantısından "yeni bağlantı iste" akışı için). */
  startInForgot?: boolean;
};

export default function AuthModal({
  onClose,
  onGuest,
  onAuthSuccess,
  headerNote,
  hideGuest,
  isNative = false,
  onNeedsUsername,
  startInForgot = false,
}: AuthModalProps) {
  const [mode, setMode] = useState<AuthMode>("login");
  // "Şifremi unuttum" görünümü — giriş görünümünden link ile geçilir.
  const [view, setView] = useState<AuthView>(startInForgot ? "forgot" : "auth");
  const [resetEmail, setResetEmail] = useState("");
  const [resetSent, setResetSent] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetCooldown, setResetCooldown] = useState(0);
  // Native only: the email/password form starts collapsed behind a disclosure
  // button. On web it's effectively always open (the render gate below never
  // hides it), so this flag has no web-visible effect.
  const [emailExpanded, setEmailExpanded] = useState(!isNative);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [username, setUsername] = useState("");

  const [loading, setLoading] = useState(false);
  // Native-only: tracks the in-flight Apple sign-in so the button can show a
  // spinner and the handler can reject double taps.
  const [appleLoading, setAppleLoading] = useState(false);
  // Native-only counterpart for Google — same purpose (spinner + double-tap
  // guard) while the OAuth browser round-trip is in flight.
  const [googleLoading, setGoogleLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const isSignup = mode === "signup";
  // Real Apple sign-in is iOS-only this phase. On other native platforms
  // (Android) the Apple button keeps its prior "coming soon" stub behavior so
  // we don't trigger a misconfigured flow. Web never renders the button at all.
  const isApplePlatform = isNative && Capacitor.getPlatform() === "ios";

  // Forgot görünümü açıkken cooldown sayacını saniyede bir tazele (timestamp'ten
  // hesaplanır, böylece modal kapanıp açılsa da süre korunur).
  useEffect(() => {
    if (view !== "forgot") return;
    setResetCooldown(readResetCooldownRemaining());
    const id = setInterval(() => setResetCooldown(readResetCooldownRemaining()), 1000);
    return () => clearInterval(id);
  }, [view]);

  function openForgotView() {
    setErrorMsg(null);
    setStatusMsg(null);
    setResetSent(false);
    // Giriş formundaki e-postayı taşı (kullanıcı yeniden yazmasın).
    setResetEmail(email.trim());
    setView("forgot");
  }

  function backToAuthView() {
    setErrorMsg(null);
    setStatusMsg(null);
    setView("auth");
  }

  async function handleForgotSubmit() {
    setErrorMsg(null);
    if (!resetEmail.trim()) {
      setErrorMsg("E-posta adresini yazmalısın.");
      return;
    }
    if (resetCooldown > 0 || resetLoading) return;

    setResetLoading(true);
    try {
      // Sonucu KASITLI yok sayıyoruz: e-posta kayıtlı olsa da olmasa da aynı
      // genel mesajı gösteririz (kullanıcı/sağlayıcı enumeration'ı yok).
      await requestPasswordReset(resetEmail);
    } catch {
      /* ağ hatası bile olsa kullanıcıya enumeration sinyali verme */
    } finally {
      try {
        localStorage.setItem(
          RESET_COOLDOWN_KEY,
          String(Date.now() + RESET_COOLDOWN_SECONDS * 1000)
        );
      } catch {
        /* localStorage kapalı — best effort */
      }
      setResetCooldown(RESET_COOLDOWN_SECONDS);
      setResetSent(true);
      setResetLoading(false);
    }
  }

  async function handleLogin() {
    setErrorMsg(null);
    setStatusMsg(null);

    if (!email.trim()) {
      setErrorMsg("E-posta adresini yazmalısın.");
      return;
    }

    if (!password) {
      setErrorMsg("Şifreni yazmalısın.");
      return;
    }

    setLoading(true);

    try {
      const { data, error } = await signInWithEmail(email, password);

      if (error) {
        setErrorMsg("E-posta veya şifre hatalı.");
        return;
      }

      const userId = data.user?.id;

      if (!userId) {
        setErrorMsg("Giriş yapılamadı.");
        return;
      }

      const { data: profile } = await getProfile(userId);
      onAuthSuccess(profile ?? null);
      onClose();
    } finally {
      setLoading(false);
    }
  }

  async function handleSignup() {
    setErrorMsg(null);
    setStatusMsg(null);

    if (!email.trim()) {
      setErrorMsg("E-posta adresini yazmalısın.");
      return;
    }

    if (!password) {
      setErrorMsg("Şifre yazmalısın.");
      return;
    }

    if (password.length < 6) {
      setErrorMsg("Şifre en az 6 karakter olmalı.");
      return;
    }

    const cleanedUsername = sanitizeUsernameInput(username);
    const usernameError = validateUsername(cleanedUsername);
    if (usernameError) {
      setErrorMsg(usernameError);
      return;
    }

    setLoading(true);

try {
  // Store the chosen DISPLAY (Türkçe + case preserved). loadOrCreateProfile
  // turns this into the profile handle and folds the uniqueness key itself.
  localStorage.setItem("geoquiz_pending_username", cleanedUsername);

  const { error } = await signUpWithEmail(email, password, cleanedUsername);

      if (error) {
        if (error.message.toLowerCase().includes("already")) {
          setErrorMsg("Bu e-posta zaten kayıtlı olabilir.");
        } else {
          setErrorMsg(error.message || "Kayıt oluşturulamadı.");
        }
        return;
      }

      setStatusMsg(
  "Doğrulama bağlantısı e-postana gönderildi. Mailini onayladıktan sonra giriş yapabilirsin."
);
return;
    } finally {
      setLoading(false);
    }
  }

  // Native-only placeholder kept for the Apple button on non-iOS native
  // (Android), where real Apple sign-in isn't wired this phase. Google is wired
  // for real below on all native platforms.
  function handleStubProvider() {
    setErrorMsg(null);
    setStatusMsg("Bu giriş yöntemi yakında aktif olacak.");
  }

  // iOS-only: real "Sign in with Apple". Only wired up for isApplePlatform
  // (native iOS); signInWithApple() additionally hard-gates on platform "ios".
  async function handleApple() {
    if (appleLoading || loading) return; // reject double taps
    setErrorMsg(null);
    setStatusMsg(null);
    setAppleLoading(true);

    try {
      const result = await signInWithApple();

      if (result.status === "cancelled") {
        // User backed out of the Apple sheet — silent no-op, no scary error.
        return;
      }

      if (result.status === "error") {
        setErrorMsg(result.message);
        return;
      }

      // Success. On native, loadOrCreateProfile does NOT mint a username from
      // the Apple email / relay / metadata, so a first-login social user comes
      // back with no profile (null). Hand off to the NicknameModal so the player
      // picks a public handle before any online routing. A returning Apple user
      // already has a username → route immediately via the existing flow.
      const profile = await loadOrCreateProfile(result.user);
      if (profile?.username) {
        onAuthSuccess(profile);
        onClose();
      } else if (onNeedsUsername) {
        onNeedsUsername(result.user.id);
      } else {
        // No nickname handler wired (web/non-native fallback): preserve prior
        // behavior. Online gates still block routing until a username exists.
        onAuthSuccess(profile ?? null);
        onClose();
      }
    } catch {
      setErrorMsg("Apple ile giriş tamamlanamadı.");
    } finally {
      setAppleLoading(false);
    }
  }

  // Native-only: real "Google ile devam et" (Auth Phase 2B). Mirrors handleApple
  // — opens the OAuth browser, then hands a successful login through the exact
  // same path (loadOrCreateProfile → NicknameModal for first-login social users,
  // direct routing for returning users). Web uses handleGoogle() below instead.
  async function handleGoogleNative() {
    if (loading || appleLoading || googleLoading) return; // reject double taps
    setErrorMsg(null);
    setStatusMsg(null);
    setGoogleLoading(true);

    try {
      const result = await signInWithGoogleNative();

      if (result.status === "cancelled") {
        // User backed out of the browser — silent no-op, no scary error.
        return;
      }

      if (result.status === "error") {
        setErrorMsg(result.message);
        return;
      }

      // Success. As with Apple, loadOrCreateProfile does NOT mint a username
      // from the Google email / name on native, so a first-login social user
      // comes back with no profile (null) → hand off to the NicknameModal. A
      // returning Google user already has a username → route immediately.
      const profile = await loadOrCreateProfile(result.user);
      if (profile?.username) {
        onAuthSuccess(profile);
        onClose();
      } else if (onNeedsUsername) {
        onNeedsUsername(result.user.id);
      } else {
        onAuthSuccess(profile ?? null);
        onClose();
      }
    } catch {
      setErrorMsg("Google ile giriş tamamlanamadı.");
    } finally {
      setGoogleLoading(false);
    }
  }

  async function handleGoogle() {
    setErrorMsg(null);
    setStatusMsg(null);
    setLoading(true);

    try {
      const { error } = await signInWithGoogle();

      if (error) {
        setErrorMsg("Google ile giriş başlatılamadı.");
        setLoading(false);
      }
    } catch {
      setErrorMsg("Google ile giriş başlatılamadı.");
      setLoading(false);
    }
  }

  // Web/desktop-only: real "Apple ile devam et". Mirrors handleGoogle — a
  // full-page Supabase OAuth redirect; the return is handled by App.tsx's auth
  // listener / loadAuth (loadOrCreateProfile → NicknameModal). Native iOS uses
  // handleApple() above (pure ASAuthorization) and never reaches this.
  async function handleAppleWeb() {
    setErrorMsg(null);
    setStatusMsg(null);
    setLoading(true);

    try {
      const { error } = await signInWithAppleWeb();

      if (error) {
        setErrorMsg("Apple ile giriş başlatılamadı.");
        setLoading(false);
      }
    } catch {
      setErrorMsg("Apple ile giriş başlatılamadı.");
      setLoading(false);
    }
  }

  async function handleRefreshSession() {
    setErrorMsg(null);
    setStatusMsg(null);
    setLoading(true);

    try {
      const { user, error } = await getCurrentUser();

      if (error || !user) {
        setErrorMsg("Aktif oturum bulunamadı.");
        return;
      }

      const { data: profile } = await getProfile(user.id);
      onAuthSuccess(profile ?? null);
      onClose();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-overlay" onClick={onClose}>
      <div
        className={isNative ? "auth-modal auth-modal--native" : "auth-modal"}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="auth-close" type="button" onClick={onClose}>
          ×
        </button>

        {view === "forgot" ? (
          <div className="auth-forgot">
            <div className="auth-head">
              <div className="auth-icon">🔑</div>
              <h2>Şifreni yenile</h2>
              <p>
                E-posta adresini gir. Hesabın varsa şifre yenileme bağlantısı
                gönderilecektir.
              </p>
            </div>

            <label className="auth-field">
              <span>E-posta adresi</span>
              <input
                value={resetEmail}
                onChange={(e) => setResetEmail(e.target.value)}
                placeholder="ornek@mail.com"
                type="email"
                autoComplete="email"
              />
            </label>

            {errorMsg && <div className="auth-error">{errorMsg}</div>}
            {resetSent && (
              <div className="auth-status">
                Hesabın varsa şifre yenileme bağlantısı e-posta adresine
                gönderildi.
              </div>
            )}

            <button
              className="auth-primary"
              type="button"
              disabled={resetLoading || resetCooldown > 0}
              onClick={handleForgotSubmit}
            >
              {resetLoading
                ? "Gönderiliyor…"
                : resetCooldown > 0
                ? `Tekrar gönder (${resetCooldown}s)`
                : "Yenileme bağlantısı gönder"}
            </button>

            <button className="auth-ghost" type="button" onClick={backToAuthView}>
              Girişe dön
            </button>
          </div>
        ) : (
        <>
        {isNative ? (
          <div className="auth-head">
            <div className="auth-icon">🌍</div>
            <h2>Torble’a giriş yap</h2>
            {headerNote && <p className="auth-note">{headerNote}</p>}
          </div>
        ) : (
          <div className="auth-head">
            <div className="auth-icon">🌍</div>
            <h2>{isSignup ? "Hesap Oluştur" : "Giriş Yap"}</h2>
            <p>
              {isSignup
                ? "XP, level ve ilerlemeni kaydetmek için hesap oluştur."
                : "Profiline, XP seviyene ve ilerlemene devam et."}
            </p>
            {headerNote && <p className="auth-note">{headerNote}</p>}
          </div>
        )}

        {isNative && (
          <>
            <button
              className="auth-apple"
              type="button"
              disabled={loading || appleLoading || googleLoading}
              onClick={isApplePlatform ? handleApple : handleStubProvider}
            >
              {appleLoading ? "Apple’a bağlanılıyor…" : " Apple ile devam et"}
            </button>

            <button
              className="auth-google"
              type="button"
              disabled={loading || appleLoading || googleLoading}
              onClick={handleGoogleNative}
            >
              {googleLoading ? "Google’a bağlanılıyor…" : "Google ile devam et"}
            </button>

            {!emailExpanded && (
              <>
                {/* Native social errors (Apple/Google) surface here; the
                    email-expanded view has its own auth-error slot below. */}
                {errorMsg && <div className="auth-error">{errorMsg}</div>}
                {statusMsg && <div className="auth-status">{statusMsg}</div>}
                <button
                  className="auth-email-toggle"
                  type="button"
                  onClick={() => {
                    setEmailExpanded(true);
                    setErrorMsg(null);
                    setStatusMsg(null);
                  }}
                >
                  E-posta ile devam et
                </button>
              </>
            )}
          </>
        )}

        {(!isNative || emailExpanded) && (
        <>
        <div className="auth-tabs">
          <button
            type="button"
            className={mode === "login" ? "active" : ""}
            onClick={() => {
              setMode("login");
              setErrorMsg(null);
              setStatusMsg(null);
            }}
          >
            Giriş
          </button>

          <button
            type="button"
            className={mode === "signup" ? "active" : ""}
            onClick={() => {
              setMode("signup");
              setErrorMsg(null);
              setStatusMsg(null);
            }}
          >
            Kayıt
          </button>
        </div>

       {isSignup && (
  <label className="auth-field">
    <span>Kullanıcı adı</span>
    <input
      value={username}
      onChange={(e) => setUsername(e.target.value.replace(/^@+/, ""))}
      placeholder="oyuncu_adı"
      maxLength={USERNAME_MAX_LENGTH}
      autoComplete="username"
    />
    <small>3-20 karakter. Harf, rakam, nokta, tire ve alt çizgi (Türkçe karakter olur).</small>
  </label>
)}

<label className="auth-field">
  <span>E-posta</span>
  <input
    value={email}
    onChange={(e) => setEmail(e.target.value)}
    placeholder="ornek@mail.com"
    type="email"
    autoComplete="email"
  />
</label>

<label className="auth-field">
  <span>Şifre</span>

  <div className="password-input-wrap">
    <input
      value={password}
      onChange={(e) => setPassword(e.target.value)}
      placeholder="En az 6 karakter"
      type={showPassword ? "text" : "password"}
      autoComplete={isSignup ? "new-password" : "current-password"}
    />

    <button
      type="button"
      className="password-eye-btn"
      onClick={() => setShowPassword((v) => !v)}
      aria-label={showPassword ? "Şifreyi gizle" : "Şifreyi göster"}
    >
      {showPassword ? "🙈" : "👁️"}
    </button>
  </div>
</label>

{!isSignup && (
  <button
    type="button"
    className="auth-forgot-link"
    onClick={openForgotView}
  >
    Şifremi unuttum
  </button>
)}

        {errorMsg && <div className="auth-error">{errorMsg}</div>}
        {statusMsg && <div className="auth-status">{statusMsg}</div>}

        <button
          className="auth-primary"
          type="button"
          disabled={loading}
          onClick={isSignup ? handleSignup : handleLogin}
        >
          {loading ? "İşleniyor..." : isSignup ? "Hesap Oluştur" : "Giriş Yap"}
        </button>

        {!isNative && (
          <button
            className="auth-apple"
            type="button"
            disabled={loading}
            onClick={handleAppleWeb}
          >
            Apple ile devam et
          </button>
        )}

        {!isNative && (
          <button
            className="auth-google"
            type="button"
            disabled={loading}
            onClick={handleGoogle}
          >
            Google ile devam et
          </button>
        )}

        <button
          className="auth-ghost"
          type="button"
          disabled={loading}
          onClick={handleRefreshSession}
        >
          Oturumu kontrol et
        </button>
        </>
        )}

        {!hideGuest && (
          <button
            className="auth-guest"
            type="button"
            onClick={() => {
              onGuest();
              onClose();
            }}
          >
            Misafir olarak devam et
          </button>
        )}
        </>
        )}
      </div>
    </div>
  );
}