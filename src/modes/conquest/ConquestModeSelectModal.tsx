/**
 * ConquestModeSelectModal — centered choice modal opened from the home
 * screen's Kuşatma card. Visually mirrors the existing wheel/flag/country
 * choice modals (`.overlay` + `.modal` + `.modal-btn`), but only offers
 * Kuşatma-specific entry points. No "Tek Oyuncu" or "Online 1v1".
 *
 * ÜÇ SEÇENEK HER KULLANICIYA GÖRÜNÜR — buton gizlenmez, yerleşim değişmez.
 * Misafir bir butona bastığında ne olduğunu ANLAR:
 *   - "Oda Kur"           → giriş/kayıt ekranı (LoginRequiredModal).
 *   - "Odalara Göz At"    → giriş/kayıt ekranı (LoginRequiredModal).
 *   - "Oda Koduyla Katıl" → MİSAFİRE AÇIK; doğrudan katılma akışına gider.
 *
 * Buradaki kapı yalnız açıklayıcıdır. Gerçek yetki sunucudadır: liste
 * `conquest_list_public_rooms()` (authenticated-only), oda kurma ise
 * `conquest_rooms` INSERT policy'si (authenticated-only).
 */

import { useState, type CSSProperties } from "react";
import { playSound } from "../../lib/sound";
import { EmojiIcon } from "../../components/EmojiIcon";
import LoginRequiredModal, {
  type LoginRequiredChoice,
  type LoginRequiredIntent,
} from "../../components/LoginRequiredModal";

interface Props {
  overlayStyle?: CSSProperties;
  themeAttr?:   string;
  /** True when a registered user is logged in (profile.username exists). */
  isLoggedIn:   boolean;
  onCreate:     () => void;
  onJoinByCode: () => void;
  onBrowse:     () => void;
  /** Misafir kapalı bir seçeneği seçti → App auth modalını açar ve bekleyen
   *  işlemi saklar (giriş sonrası oyuncu boş ana sayfaya DÜŞMEZ). */
  onAuthRequired: (intent: LoginRequiredIntent, choice: LoginRequiredChoice) => void;
  onClose:      () => void;
}

export default function ConquestModeSelectModal({
  overlayStyle,
  themeAttr,
  isLoggedIn,
  onCreate,
  onJoinByCode,
  onBrowse,
  onAuthRequired,
  onClose,
}: Props) {
  /** Misafir kapalı bir seçeneğe bastı → hangi işlem için giriş isteniyor? */
  const [gateIntent, setGateIntent] = useState<LoginRequiredIntent | null>(null);

  function handleCreate() {
    playSound("click");
    if (!isLoggedIn) {
      setGateIntent("conquest-create");
      return;
    }
    onCreate();
  }

  function handleBrowse() {
    playSound("click");
    if (!isLoggedIn) {
      setGateIntent("conquest-browse");
      return;
    }
    onBrowse();
  }

  function handleJoinByCode() {
    playSound("click");
    onJoinByCode();
  }

  // Giriş kapısı açıkken menünün yerine O gösterilir (üst üste iki overlay
  // yığılmasın; mobilde de tek yüzey kalır).
  if (gateIntent) {
    return (
      <LoginRequiredModal
        intent={gateIntent}
        overlayStyle={overlayStyle}
        themeAttr={themeAttr}
        onChoose={(choice) => onAuthRequired(gateIntent, choice)}
        onCancel={() => setGateIntent(null)}
      />
    );
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
