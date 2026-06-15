/**
 * UsernameChangeModal.tsx
 *
 * Profil panelinden açılan "Kullanıcı Adı Değiştir" modalı (V1).
 *
 * Kurallar:
 *   - İlk değişiklik (username_change_count === 0) ücretsiz.
 *   - Sonraki her değişiklik 500 Gold ve 14 gün cooldown'a tabi.
 *   - Server-side change_username RPC bütün kontrolleri yapar; client
 *     buradaki validasyonu sadece canlı feedback için yapar.
 *   - Client doğrudan profiles.username veya profiles.gold yazmaz.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  callChangeUsername,
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
  onSuccess: (next: { username: string; gold: number }) => void;
}

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

export function UsernameChangeModal({ profile, gold, onClose, onSuccess }: Props) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isFirstChange = (profile.username_change_count ?? 0) === 0;
  const cooldownDaysLeft = computeCooldownDaysLeft(
    isFirstChange,
    profile.username_changed_at ?? null
  );

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  // Canlı format validation (client tarafı erken uyarı; otorite RPC'dir).
  const clientValidationError: string | null = useMemo(() => {
    if (value.trim().length === 0) return null;
    return validateUsername(value);
  }, [value]);

  // Aynı kullanıcı adı mı? Türkçe-katlanmış key üzerinden karşılaştır
  // ("Padır" ile "padir" aynı sayılır).
  const normalizedKey = normalizeUsernameKey(value);
  const isSameAsCurrent =
    normalizedKey.length > 0 &&
    normalizedKey === normalizeUsernameKey(profile.username ?? "");

  // Buton enable koşulu — client-side ön kontroller.
  let buttonDisabled = submitting;
  if (value.trim().length === 0) buttonDisabled = true;
  if (clientValidationError) buttonDisabled = true;
  if (isSameAsCurrent) buttonDisabled = true;
  if (cooldownDaysLeft > 0) buttonDisabled = true;
  if (!isFirstChange && gold < USERNAME_CHANGE_COST) buttonDisabled = true;

  // Üstte gösterilecek inline hata (öncelik sırası).
  const displayError: string | null = serverError
    ? serverError
    : isSameAsCurrent
    ? "Bu zaten mevcut kullanıcı adın."
    : clientValidationError;

  async function handleSubmit() {
    if (buttonDisabled) return;
    setServerError(null);
    setSubmitting(true);
    try {
      const result = await callChangeUsername(value);
      if (!result.ok) {
        setServerError(result.message || "İşlem gerçekleştirilemedi.");
        return;
      }
      // Server otoritesi — RPC dönen gold'u cache'e yansıt.
      syncGoldFromServer(result.gold);
      onSuccess({ username: result.username, gold: result.gold });
    } catch (e) {
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

  const actionLabel = isFirstChange
    ? "Ücretsiz Değiştir"
    : `${USERNAME_CHANGE_COST} Gold ile Değiştir`;

  return (
    <div
      className="uc-overlay"
      role="dialog"
      aria-modal="true"
      onClick={() => !submitting && onClose()}
    >
      <div className="uc-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="uc-close"
          onClick={() => !submitting && onClose()}
          aria-label="Kapat"
        >
          ×
        </button>

        <h2 className="uc-title">Kullanıcı Adını Değiştir</h2>

        <div className="uc-info">
          <p>
            {isFirstChange
              ? "İlk kullanıcı adı seçimi ücretsizdir. Sonraki değişiklikler 500 Gold'dur."
              : `Kullanıcı adı değişikliği ${USERNAME_CHANGE_COST} Gold'a mâl olur.`}
          </p>
          <p>Kullanıcı adını {USERNAME_CHANGE_COOLDOWN_DAYS} günde bir değiştirebilirsin.</p>
        </div>

        <label className="uc-label" htmlFor="uc-username-input">
          Yeni kullanıcı adı
        </label>
        <div className="uc-input-wrap">
          <span className="uc-input-at">@</span>
          <input
            ref={inputRef}
            id="uc-username-input"
            type="text"
            className="uc-input"
            placeholder="ornek_ad"
            maxLength={USERNAME_MAX_LENGTH}
            value={value}
            disabled={submitting}
            onChange={(e) => {
              setServerError(null);
              // Baştaki '@'ı temizle; Türkçe + büyük/küçük harfi koru.
              setValue(sanitizeUsernameInput(e.target.value));
            }}
            onKeyDown={handleKey}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {cooldownDaysLeft > 0 && (
          <div className="uc-warn">
            Kullanıcı adını tekrar değiştirmek için {cooldownDaysLeft} gün beklemelisin.
          </div>
        )}

        {!isFirstChange && gold < USERNAME_CHANGE_COST && cooldownDaysLeft === 0 && (
          <div className="uc-warn">
            Yetersiz Gold. Bu işlem için {USERNAME_CHANGE_COST} Gold gerekli (mevcut: {gold}).
          </div>
        )}

        {displayError && cooldownDaysLeft === 0 && (
          <div className="uc-error">{displayError}</div>
        )}

        <div className="uc-actions">
          <button
            type="button"
            className="uc-btn uc-btn--ghost"
            onClick={() => !submitting && onClose()}
            disabled={submitting}
          >
            Vazgeç
          </button>
          <button
            type="button"
            className={`uc-btn uc-btn--primary${
              isFirstChange ? " uc-btn--free" : ""
            }`}
            onClick={handleSubmit}
            disabled={buttonDisabled}
          >
            {submitting ? "İşleniyor…" : actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
