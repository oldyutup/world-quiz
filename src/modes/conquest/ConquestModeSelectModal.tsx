/**
 * ConquestModeSelectModal — centered choice modal opened from the home
 * screen's Kuşatma card. Visually mirrors the existing wheel/flag/country
 * choice modals (`.overlay` + `.modal` + `.modal-btn`), but only offers
 * Kuşatma-specific entry points. No "Tek Oyuncu" or "Online 1v1".
 *
 * Guest restrictions (Kuşatma-only):
 *   - "Oda Kur"        → blocked for guests; inline warning shown.
 *   - "Odalara Göz At" → blocked for guests; inline warning shown.
 *   - "Oda Koduyla Katıl" → no inline block here; the host's online auth gate
 *       (navigateOnline) prompts login for guests before routing.
 */

import { useState, type CSSProperties } from "react";
import { playSound } from "../../lib/sound";
import { EmojiIcon } from "../../components/EmojiIcon";

interface Props {
  overlayStyle?: CSSProperties;
  themeAttr?:   string;
  /** True when a registered user is logged in (profile.username exists). */
  isLoggedIn:   boolean;
  onCreate:     () => void;
  onJoinByCode: () => void;
  onBrowse:     () => void;
  onClose:      () => void;
}

export default function ConquestModeSelectModal({
  overlayStyle,
  themeAttr,
  isLoggedIn,
  onCreate,
  onJoinByCode,
  onBrowse,
  onClose,
}: Props) {
  const [warnMsg, setWarnMsg] = useState<string | null>(null);

  function handleCreate() {
    if (!isLoggedIn) {
      setWarnMsg("Kuşatma odası kurmak için giriş yapmalısın.");
      return;
    }
    playSound("click");
    onCreate();
  }

  function handleBrowse() {
    if (!isLoggedIn) {
      setWarnMsg("Açık Kuşatma odalarına katılmak için giriş yapmalısın.");
      return;
    }
    playSound("click");
    onBrowse();
  }

  function handleJoinByCode() {
    playSound("click");
    onJoinByCode();
  }

  return (
    <div
      className="overlay"
      style={overlayStyle}
      data-theme={themeAttr}
      onClick={onClose}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2><EmojiIcon name="shield" /> Kuşatma</h2>

        <button className="modal-btn" onClick={handleCreate}>
          <EmojiIcon name="house" /> Oda Kur
        </button>

        <button className="modal-btn" onClick={handleJoinByCode}>
          <EmojiIcon name="key" /> Oda Koduyla Katıl
        </button>

        <button className="modal-btn" onClick={handleBrowse}>
          <EmojiIcon name="search" /> Odalara Göz At
        </button>

        {warnMsg && (
          <p className="duel-error" style={{ marginTop: 8, marginBottom: 0 }}>
            <EmojiIcon name="lock" /> {warnMsg}
          </p>
        )}

        <button
          className="modal-close"
          onClick={() => {
            playSound("click");
            onClose();
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
