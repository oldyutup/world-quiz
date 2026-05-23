/**
 * ConquestModeSelectModal — centered choice modal opened from the home
 * screen's Kuşatma card. Visually mirrors the existing wheel/flag/country
 * choice modals (`.overlay` + `.modal` + `.modal-btn`), but only offers
 * the two Kuşatma-specific entry points. No "Tek Oyuncu" or "Online 1v1".
 *
 * Guest restrictions (Kuşatma-only):
 *   - "Oda Kur"       → blocked for guests; inline warning shown.
 *   - "Odalara Göz At" → blocked for guests; inline warning shown.
 */

import { useState, type CSSProperties } from "react";
import { playSound } from "../../lib/sound";

interface Props {
  overlayStyle?: CSSProperties;
  themeAttr?:   string;
  /** True when a registered user is logged in (profile.username exists). */
  isLoggedIn:   boolean;
  onCreate:     () => void;
  onBrowse:     () => void;
  onClose:      () => void;
}

export default function ConquestModeSelectModal({
  overlayStyle,
  themeAttr,
  isLoggedIn,
  onCreate,
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

  return (
    <div
      className="overlay"
      style={overlayStyle}
      data-theme={themeAttr}
      onClick={onClose}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>🛡️ Kuşatma</h2>

        <button className="modal-btn" onClick={handleCreate}>
          🏠 Oda Kur
        </button>

        <button className="modal-btn" onClick={handleBrowse}>
          🔎 Odalara Göz At
        </button>

        {warnMsg && (
          <p className="duel-error" style={{ marginTop: 8, marginBottom: 0 }}>
            🔒 {warnMsg}
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
