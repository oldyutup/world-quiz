/**
 * ConquestJoinByCode — paste-a-room-code screen for Kuşatma.
 *
 * Two paths land here:
 *   1. "Oda Koduyla Katıl" from the entry modal (code blank, focus the input).
 *   2. Invite link redirect (code pre-filled; guest may still need to set a
 *      display name).
 *
 * Login state behaviour
 * ─────────────────────
 *   • Logged-in users: name is taken from profile.username; the input is
 *     replaced by a read-only chip.
 *   • Guests: must type a 2–16 char display name in addition to the code.
 *     (Guest direct-join via code is permitted by design so invite links
 *      keep working without an account.)
 *
 * Validation happens here; the actual Supabase lookup + join is performed
 * by the parent (ConquestMode) so this component stays presentation-only.
 */

import { useEffect, useRef, useState } from "react";
import { getGuestName } from "../../lib/guestSession";
import type { Profile } from "../../lib/auth";
import { playSound } from "../../lib/sound";
import { EmojiIcon } from "../../components/EmojiIcon";
import { normalizeConquestRoomCode } from "./conquestService";
import { validateConquestName } from "./utils";

/** Ebeveynden gelen katılma hatası. Her başarısızlıkta YENİ bir nesne üretilir
 *  (`at` alanı) — böylece aynı hata art arda iki kez oluşsa bile effect yeniden
 *  koşar ve odak tekrar ad alanına döner. */
export interface ConquestJoinFormError {
  message:   string;
  focusName: boolean;
  at:        number;
}

interface Props {
  profile:     Profile | null;
  /** Pre-fill the code field (used by invite-link redirects). */
  initialCode?: string;
  /** Pre-fill the name field — başarısız denemeden sonra yazdığı nick geri gelir. */
  initialName?: string;
  /** Sunucudan dönen katılma hatası; formu KAPATMADAN burada gösterilir. */
  joinError?:  ConquestJoinFormError | null;
  /** Katılma isteği uçuşta — yalnız buton kilitlenir, alanlar düzenlenebilir kalır. */
  busy?:       boolean;
  onBack:      () => void;
  onJoin:      (code: string, displayName: string) => void;
}

export default function ConquestJoinByCode({
  profile,
  initialCode = "",
  initialName = "",
  joinError = null,
  busy = false,
  onBack,
  onJoin,
}: Props) {
  const isLoggedInPlayer = !!profile?.username;
  const [code, setCode]           = useState<string>(initialCode);
  // Başarısız denemeden gelen taslak ad, hatırlanan misafir adından ÖNCE gelir.
  const [playerName, setPlayerName] = useState<string>(
    profile?.username ?? initialName ?? getGuestName() ?? ""
  );
  const [errorMsg, setErrorMsg]   = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Keep the username in sync if profile loads after mount.
  useEffect(() => {
    if (profile?.username) setPlayerName(profile.username);
  }, [profile?.username]);

  /* Sunucu reddi → formda göster. Ekran DEĞİŞMEZ, alanlar temizlenmez;
   * ad kaynaklı retlerde odak ad alanına döner ki kullanıcı doğrudan
   * düzeltmeye başlasın (mobilde klavye tekrar açılır). */
  useEffect(() => {
    if (!joinError) return;
    setErrorMsg(joinError.message);
    if (joinError.focusName && !isLoggedInPlayer) {
      nameRef.current?.focus();
      nameRef.current?.select();
    }
  }, [joinError, isLoggedInPlayer]);

  function handleSubmit() {
    if (busy) return;

    const normalised = normalizeConquestRoomCode(code);
    if (normalised.length !== 6) {
      setErrorMsg("Oda kodu 6 karakter olmalı.");
      return;
    }

    const effectiveName = isLoggedInPlayer
      ? (profile?.username ?? "").trim()
      : playerName.trim();

    if (!isLoggedInPlayer) {
      const err = validateConquestName(playerName);
      if (err) { setErrorMsg(err); nameRef.current?.focus(); return; }
    } else if (effectiveName.length < 2) {
      setErrorMsg("Hesabında bir kullanıcı adı yok.");
      return;
    }

    // Yeni deneme başlıyor → eski hata düşer (ebeveyn de kendi hatasını siler).
    setErrorMsg(null);
    playSound("click");
    onJoin(normalised, effectiveName);
  }

  return (
    <div className="duel-lobby">
      <div className="duel-lobby-card cq-setup-card">
        <h2 className="duel-lobby-title"><EmojiIcon name="shield" /> Kuşatma · Oda Koduyla Katıl</h2>
        <p className="duel-lobby-desc">
          Arkadaşının verdiği 6 haneli kuşatma kodunu gir.
        </p>

        <div className="duel-field-row">
          <label className="duel-field-label">Oda Kodu</label>
          <input
            className="duel-name-input cq-code-input"
            type="text"
            value={code}
            onChange={e => {
              setCode(e.target.value.toUpperCase().slice(0, 6));
              if (errorMsg) setErrorMsg(null);
            }}
            aria-invalid={errorMsg ? true : undefined}
            aria-describedby={errorMsg ? "cq-join-error" : undefined}
            placeholder="K_____"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            maxLength={6}
            style={{
              fontFamily: "monospace",
              letterSpacing: "0.18em",
              textTransform: "uppercase",
            }}
          />
        </div>

        <div className="duel-field-row">
          <label className="duel-field-label">Oyuncu Adın</label>
          {isLoggedInPlayer ? (
            <div className="cq-name-readonly" aria-readonly="true">
              <span className="cq-name-chip">
                <span aria-hidden><EmojiIcon name="bust" /></span>
                <span>@{profile?.username}</span>
              </span>
              <span className="cq-name-readonly-hint">olarak katılıyorsun</span>
            </div>
          ) : (
            <input
              ref={nameRef}
              className="duel-name-input"
              type="text"
              value={playerName}
              onChange={e => {
                setPlayerName(e.target.value.slice(0, 16));
                if (errorMsg) setErrorMsg(null);
              }}
              aria-invalid={errorMsg ? true : undefined}
              aria-describedby={errorMsg ? "cq-join-error" : undefined}
              placeholder="Adın..."
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </div>

        <button
          className="btn btn-accent duel-create-btn"
          onClick={handleSubmit}
          type="button"
          disabled={busy}
        >
          <EmojiIcon name="door" /> {busy ? "Katılınıyor…" : "Odaya Katıl"}
        </button>

        {errorMsg && <p className="duel-error" id="cq-join-error" role="alert">{errorMsg}</p>}

        <button
          type="button"
          className="btn btn-ghost cq-back-btn"
          onClick={() => { playSound("click"); onBack(); }}
        >
          ← Geri
        </button>
      </div>
    </div>
  );
}
