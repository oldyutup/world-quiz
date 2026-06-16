/**
 * KorNoktaSelectModal — centered choice modal opened from the home screen's
 * Kör Nokta card. Visually mirrors ConquestModeSelectModal (`.overlay` +
 * `.modal` + `.modal-btn`).
 *
 * Login restrictions (Kör Nokta is login-only, no guest play):
 *   - "Oda Kur"     → guest: onRequireAuth("create") — App auth modal'ı açar.
 *   - "Odaya Katıl" → guest: onRequireAuth("join")   — App auth modal'ı açar.
 */

import { type CSSProperties } from "react";
import { playSound } from "../../lib/sound";
import { EmojiIcon } from "../../components/EmojiIcon";

interface Props {
  overlayStyle?: CSSProperties;
  themeAttr?:   string;
  /** True when a registered user is logged in (profile.username exists). */
  isLoggedIn:   boolean;
  onCreate:     () => void;
  onJoin:       () => void;
  /** Guest clicked an action — parent opens the auth modal with the
   *  Kör Nokta-specific message and routes after a successful login. */
  onRequireAuth: (action: "create" | "join") => void;
  onClose:      () => void;
}

export default function KorNoktaSelectModal({
  overlayStyle,
  themeAttr,
  isLoggedIn,
  onCreate,
  onJoin,
  onRequireAuth,
  onClose,
}: Props) {
  function handleCreate() {
    playSound("click");
    if (!isLoggedIn) {
      onRequireAuth("create");
      return;
    }
    onCreate();
  }

  function handleJoin() {
    playSound("click");
    if (!isLoggedIn) {
      onRequireAuth("join");
      return;
    }
    onJoin();
  }

  return (
    <div
      className="overlay"
      style={overlayStyle}
      data-theme={themeAttr}
      onClick={onClose}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2><EmojiIcon name="detective" /> Kör Nokta</h2>

        <button className="modal-btn" onClick={handleCreate}>
          <EmojiIcon name="house" /> Oda Kur
        </button>

        <button className="modal-btn" onClick={handleJoin}>
          <EmojiIcon name="key" /> Odaya Katıl
        </button>

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
