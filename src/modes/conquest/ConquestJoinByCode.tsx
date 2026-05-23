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

import { useEffect, useState } from "react";
import type { Profile } from "../../lib/auth";
import { playSound } from "../../lib/sound";
import { normalizeConquestRoomCode } from "./conquestService";
import { validateConquestName } from "./utils";

interface Props {
  profile:     Profile | null;
  /** Pre-fill the code field (used by invite-link redirects). */
  initialCode?: string;
  onBack:      () => void;
  onJoin:      (code: string, displayName: string) => void;
}

export default function ConquestJoinByCode({
  profile,
  initialCode = "",
  onBack,
  onJoin,
}: Props) {
  const isLoggedInPlayer = !!profile?.username;
  const [code, setCode]           = useState<string>(initialCode);
  const [playerName, setPlayerName] = useState<string>(profile?.username ?? "");
  const [errorMsg, setErrorMsg]   = useState<string | null>(null);

  // Keep the username in sync if profile loads after mount.
  useEffect(() => {
    if (profile?.username) setPlayerName(profile.username);
  }, [profile?.username]);

  function handleSubmit() {
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
      if (err) { setErrorMsg(err); return; }
    } else if (effectiveName.length < 2) {
      setErrorMsg("Hesabında bir kullanıcı adı yok.");
      return;
    }

    setErrorMsg(null);
    playSound("click");
    onJoin(normalised, effectiveName);
  }

  return (
    <div className="duel-lobby">
      <div className="duel-lobby-card cq-setup-card">
        <h2 className="duel-lobby-title">🛡️ Kuşatma · Oda Koduyla Katıl</h2>
        <p className="duel-lobby-desc">
          Arkadaşının verdiği 6 haneli kuşatma kodunu gir.
        </p>

        <div className="duel-field-row">
          <label className="duel-field-label">Oda Kodu</label>
          <input
            className="duel-name-input cq-code-input"
            type="text"
            value={code}
            onChange={e => setCode(e.target.value.toUpperCase().slice(0, 6))}
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
                <span aria-hidden>👤</span>
                <span>@{profile?.username}</span>
              </span>
              <span className="cq-name-readonly-hint">olarak katılıyorsun</span>
            </div>
          ) : (
            <input
              className="duel-name-input"
              type="text"
              value={playerName}
              onChange={e => setPlayerName(e.target.value.slice(0, 16))}
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
        >
          🚪 Odaya Katıl
        </button>

        {errorMsg && <p className="duel-error">{errorMsg}</p>}

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
