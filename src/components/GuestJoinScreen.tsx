/**
 * GuestJoinScreen.tsx — "Odaya Katıl" misafir nick ekranı.
 *
 * Giriş yapmamış bir kullanıcı geçerli bir oda kodu yazdığında ya da davet
 * bağlantısını açtığında gösterilir. Amaç: arkadaşın EN AZ adımda odaya
 * girmesi. Bu ekran bir kayıt formu DEĞİLDİR — tek alan vardır.
 *
 * Tasarım: mevcut auth modal kabuğunu (.auth-overlay/.auth-modal) yeniden
 * kullanır, böylece masaüstü web görünümü hiç değişmeden aynı dile uyar.
 * Mobil/native'de klavye açıldığında alanın ve butonun görünür kalması için
 * odaklanınca scrollIntoView + safe-area dolgusu uygulanır.
 *
 * Bu ekran KATILMA YAPMAZ; yalnız nick toplar. Gerçek katılma, kullanıcının
 * seçtiği modun kendi lobisindeki mevcut join akışıyla (sunucu RPC'si)
 * gerçekleşir — paralel bir katılma sistemi kurulmaz.
 */
import { useEffect, useRef, useState } from "react";
import { playSound } from "../lib/sound";
import {
  sanitizeGuestName,
  validateGuestName,
  getGuestName,
  checkGuestNameOnServer,
} from "../lib/guestSession";
import { ROOM_CODE_MODE_LABELS, type RoomCodeModeKey } from "../lib/roomCode";

interface Props {
  /** Çözümlenmiş oda modu — başlık altındaki bilgi satırında gösterilir. */
  mode: RoomCodeModeKey;
  /** Normalize edilmiş 6 haneli oda kodu. */
  code: string;
  /** Nick onaylandı → App misafir adını saklayıp ilgili mod ekranına yönlendirir. */
  onConfirm: (name: string) => void;
  /** "Hesabın var mı? Giriş Yap" — App auth modalını açar, bağlam korunur. */
  onLogin: () => void;
  /** Geri / vazgeç → ana sayfa. */
  onCancel: () => void;
}

export default function GuestJoinScreen({
  mode,
  code,
  onConfirm,
  onLogin,
  onCancel,
}: Props) {
  // Daha önce misafir olarak oynadıysa adı hazır gelsin (tekrar yazmasın).
  const [name, setName] = useState<string>(() => getGuestName() ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    // Masaüstünde alana odaklan. Mobilde otomatik odak klavyeyi hemen açıp
    // ekranı zıplattığı için KASTEN yapılmaz — kullanıcı dokununca açılır.
    const isCoarse =
      typeof window !== "undefined" &&
      window.matchMedia?.("(pointer: coarse)").matches;
    if (!isCoarse) inputRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  /** Klavye açıldığında (mobil/native) alan + ana buton görünür kalsın. */
  const handleFocus = () => {
    window.setTimeout(() => {
      formRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 250);
  };

  const submit = async () => {
    if (busy) return;
    const clean = sanitizeGuestName(name);

    // 1) Biçim kuralları (anında, ağ beklemeden).
    const err = validateGuestName(clean);
    if (err) {
      setError(err);
      inputRef.current?.focus();
      return;
    }

    setBusy(true);
    setError(null);
    playSound("click");

    // 2) SUNUCU ÖN KONTROLÜ: ad kayıtlı bir hesaba mı ait / yasaklı mı?
    //    Bu olmadan kullanıcı ekranı geçer ve katılma anında anlaşılmaz bir
    //    hata alırdı. Ağ hatasında ilerlemesine izin verilir — gerçek karar
    //    zaten katılma anında sunucuda verilir.
    const check = await checkGuestNameOnServer(clean);
    if (
      check.status === "registered" ||
      check.status === "forbidden" ||
      check.status === "invalid"
    ) {
      setError(check.message);
      setBusy(false);
      inputRef.current?.focus();
      return;
    }

    // Katılmanın kendisi mod lobisinde olur; burada yalnız bağlamı teslim
    // ediyoruz. busy=true bırakılır ki çift gönderim olmasın (ekran zaten
    // yönlendirme sonrası unmount olur).
    onConfirm(clean);
  };

  return (
    <div className="auth-overlay gj-overlay" role="dialog" aria-modal="true">
      <div className="auth-modal gj-modal">
        <button
          type="button"
          className="auth-close"
          aria-label="Kapat"
          onClick={() => {
            playSound("click");
            onCancel();
          }}
        >
          ✕
        </button>

        <div className="auth-head">
          <div className="auth-icon" aria-hidden="true">
            🎮
          </div>
          <h2>Odaya Katıl</h2>
          <p>Arkadaşların seni bekliyor. Oyuna katılmak için bir kullanıcı adı seç.</p>
        </div>

        <div className="gj-room">
          <span className="gj-room-mode">{ROOM_CODE_MODE_LABELS[mode]}</span>
          <span className="gj-room-code">{code}</span>
        </div>

        <form
          ref={formRef}
          className="gj-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="gj-label" htmlFor="gj-name">
            Kullanıcı adı
          </label>
          <input
            id="gj-name"
            ref={inputRef}
            className="gj-input"
            type="text"
            inputMode="text"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="nickname"
            spellCheck={false}
            maxLength={16}
            placeholder="Kullanıcı adı"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "gj-error" : undefined}
            value={name}
            disabled={busy}
            onFocus={handleFocus}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
          />

          {error && (
            <div id="gj-error" className="gj-error" role="alert">
              {error}
            </div>
          )}

          <button type="submit" className="auth-primary gj-submit" disabled={busy}>
            {busy ? "Kontrol ediliyor…" : "Misafir Olarak Katıl"}
          </button>
        </form>

        <button
          type="button"
          className="auth-guest gj-login"
          onClick={() => {
            playSound("click");
            onLogin();
          }}
        >
          Hesabın var mı? Giriş Yap
        </button>

        <p className="gj-note">
          Misafir olarak oyunun tamamını oynayabilirsin. XP, altın ve başarılar
          yalnızca hesabı olan oyunculara işlenir.
        </p>
      </div>
    </div>
  );
}
