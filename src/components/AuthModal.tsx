import { useState } from "react";
import {
  getCurrentUser,
  getProfile,
  signInWithEmail,
  signInWithGoogle,
  signUpWithEmail,
  validateUsername,
  type Profile,
} from "../lib/auth";

type AuthMode = "login" | "signup";

type AuthModalProps = {
  onClose: () => void;
  onGuest: () => void;
  onAuthSuccess: (profile: Profile | null) => void;
};

export default function AuthModal({
  onClose,
  onGuest,
  onAuthSuccess,
}: AuthModalProps) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [username, setUsername] = useState("");

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const isSignup = mode === "signup";

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

    const usernameError = validateUsername(username);
    if (usernameError) {
      setErrorMsg(usernameError);
      return;
    }

    setLoading(true);

try {
  localStorage.setItem(
    "geoquiz_pending_username",
    username.trim().toLocaleLowerCase("tr-TR")
  );

  const { error } = await signUpWithEmail(email, password, username);

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
      <div className="auth-modal" onClick={(e) => e.stopPropagation()}>
        <button className="auth-close" type="button" onClick={onClose}>
          ×
        </button>

        <div className="auth-head">
          <div className="auth-icon">🌍</div>
          <h2>{isSignup ? "Hesap Oluştur" : "Giriş Yap"}</h2>
          <p>
            {isSignup
              ? "XP, level ve ilerlemeni kaydetmek için hesap oluştur."
              : "Profiline, XP seviyene ve ilerlemene devam et."}
          </p>
        </div>

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
      onChange={(e) => setUsername(e.target.value.toLocaleLowerCase("tr-TR"))}
      placeholder="oyuncu_adı"
      maxLength={16}
      autoComplete="username"
    />
    <small>3-16 karakter. Küçük harf, rakam, alt çizgi ve Türkçe karakter.</small>
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

        <button
          className="auth-google"
          type="button"
          disabled={loading}
          onClick={handleGoogle}
        >
          Google ile devam et
        </button>

        <button
          className="auth-ghost"
          type="button"
          disabled={loading}
          onClick={handleRefreshSession}
        >
          Oturumu kontrol et
        </button>

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
      </div>
    </div>
  );
}