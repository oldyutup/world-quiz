/**
 * NicknameModal.tsx
 *
 * Auth Phase 3 — first-login nickname selection for native social sign-in.
 *
 * Shown only inside the Capacitor native shell, after a social login (Apple,
 * later Google) when the player has no valid Torble username yet. The player
 * MUST pick a public handle before being routed into any online / profil /
 * sıralama flow — the email and real name are deliberately never accepted as
 * props, so they cannot leak into the public username.
 *
 * Required step: there is no close/skip affordance. The only way out without a
 * username is "Vazgeç", which signs the user back out (it never lets them into
 * an online flow handle-less). Uniqueness and validation are enforced by
 * setInitialUsername; the strict V1 rules match the change_username RPC.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  setInitialUsername,
  suggestNickname,
  validateUsernameV1,
  type Profile,
} from "../lib/auth";

interface Props {
  /** Signed-in social user's id. Email / real name are intentionally omitted. */
  userId: string;
  onSuccess: (profile: Profile) => void;
  /** Abort: signs the user back out and returns to the logged-out home. */
  onCancel: () => void;
}

export default function NicknameModal({ userId, onSuccess, onCancel }: Props) {
  // Prefill a safe, valid suggestion so "Devam et" works in one tap; the input
  // is selected on mount so typing immediately replaces it.
  const [value, setValue] = useState(() => suggestNickname());
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.select(), 60);
    return () => clearTimeout(t);
  }, []);

  const clientError = useMemo<string | null>(() => {
    if (value.trim().length === 0) return null;
    return validateUsernameV1(value);
  }, [value]);

  const canSubmit = !submitting && value.trim().length > 0 && !clientError;
  const displayError = serverError ?? clientError;

  async function handleSubmit() {
    if (!canSubmit) return;
    setServerError(null);
    setSubmitting(true);
    try {
      const result = await setInitialUsername(userId, value);
      if (result.error) {
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
        <h2 className="nick-title" id="nick-title">Oyuncu adını seç</h2>
        <p className="nick-sub">Bu ad sıralamada ve online oyunlarda görünecek.</p>

        <label className="nick-label" htmlFor="nick-input">Kullanıcı adı</label>
        <div className="nick-input-wrap">
          <span className="nick-input-at" aria-hidden="true">@</span>
          <input
            ref={inputRef}
            id="nick-input"
            type="text"
            className="nick-input"
            value={value}
            placeholder="gezgin123"
            maxLength={16}
            disabled={submitting}
            onChange={(e) => {
              setServerError(null);
              setValue(e.target.value.toLowerCase());
            }}
            onKeyDown={handleKey}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
          />
        </div>
        <p className="nick-hint">3-16 karakter. Küçük harf (a-z), rakam ve alt çizgi.</p>

        {displayError && <div className="nick-error">{displayError}</div>}

        <button
          type="button"
          className="nick-primary"
          onClick={handleSubmit}
          disabled={!canSubmit}
        >
          {submitting ? "Kaydediliyor…" : "Devam et"}
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
