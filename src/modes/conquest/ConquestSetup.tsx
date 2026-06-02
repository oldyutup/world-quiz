/**
 * ConquestSetup — Kuşatma "Oda Kur" form. Frontend-only for Phase 2:
 * submitting calls `onCreate(name, settings)` and the parent flips into
 * the lobby skeleton with a locally-generated room code. No Supabase.
 */

import { useEffect, useState } from "react";
import type { Profile } from "../../lib/auth";
import { playSound } from "../../lib/sound";
import {
  CONQUEST_DEFAULT_SETTINGS,
  CONQUEST_MAPS,
  CONQUEST_PLAYER_COUNTS,
  CONQUEST_ROUND_COUNTS,
  type ConquestMapId,
  type ConquestMaxPlayers,
  type ConquestRoomSettings,
  type ConquestRoundCount,
  type ConquestVisibility,
} from "./types";
import { validateConquestName } from "./utils";

interface Props {
  profile: Profile | null;
  onBack:   () => void;
  onCreate: (playerName: string, settings: ConquestRoomSettings) => void;
}

export default function ConquestSetup({ profile, onBack, onCreate }: Props) {
  const isLoggedInPlayer = !!profile?.username;
  const [playerName, setPlayerName] = useState<string>(profile?.username ?? "");

  useEffect(() => {
    if (profile?.username) setPlayerName(profile.username);
  }, [profile?.username]);

  const [maxPlayers, setMaxPlayers] = useState<ConquestMaxPlayers>(CONQUEST_DEFAULT_SETTINGS.maxPlayers);
  const [map,        setMap]        = useState<ConquestMapId>     (CONQUEST_DEFAULT_SETTINGS.map);
  const [rounds,     setRounds]     = useState<ConquestRoundCount>(CONQUEST_DEFAULT_SETTINGS.rounds);
  const [visibility, setVisibility] = useState<ConquestVisibility>(CONQUEST_DEFAULT_SETTINGS.visibility);
  const [errorMsg,   setErrorMsg]   = useState<string | null>(null);

  function handleSubmit() {
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
    // teamMode varsayılan 'individual'; 2v2 Takımlı lobby'den seçilir.
    onCreate(effectiveName, { map, maxPlayers, rounds, visibility, teamMode: "individual" });
  }

  /* Belt-and-suspenders: modal already blocks guests, but guard here too. */
  if (!isLoggedInPlayer) {
    return (
      <div className="duel-lobby">
        <div className="duel-lobby-card cq-setup-card">
          <h2 className="duel-lobby-title">🛡️ Kuşatma · Oda Kur</h2>
          <p className="duel-error" style={{ textAlign: "left" }}>
            🔒 Kuşatma odası kurmak için giriş yapmalısın.
          </p>
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

  return (
    <div className="duel-lobby">
      <div className="duel-lobby-card cq-setup-card">
        <h2 className="duel-lobby-title">🛡️ Kuşatma · Oda Kur</h2>
        <p className="duel-lobby-desc">
          2–4 oyuncu. Bölgeleri kuşatarak haritayı ele geçir.
        </p>

        <div className="duel-field-row">
          <label className="duel-field-label">Oyuncu Adın</label>
          {isLoggedInPlayer ? (
            <div className="cq-name-readonly" aria-readonly="true" title="Login olduğun için adın profil hesabından alınır">
              <span className="cq-name-chip">
                <span aria-hidden>👤</span>
                <span>@{profile?.username}</span>
              </span>
              <span className="cq-name-readonly-hint">olarak oynuyorsun</span>
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

        <div className="cq-settings-block">
          <p className="duel-settings-title">⚙️ Oda Ayarları</p>

          <div className="cq-settings-selects">
            <div className="duel-select-wrap">
              <label className="duel-select-label">👥 Oyuncu Sayısı</label>
              <div className="duel-select-box">
                <select
                  className="duel-select"
                  value={maxPlayers}
                  onChange={e => setMaxPlayers(Number(e.target.value) as ConquestMaxPlayers)}
                >
                  {CONQUEST_PLAYER_COUNTS.map(n => (
                    <option key={n} value={n}>{n} Kişi</option>
                  ))}
                </select>
                <span className="duel-select-caret">▾</span>
              </div>
            </div>

            <div className="duel-select-wrap">
              <label className="duel-select-label">🗺️ Harita</label>
              <div className="duel-select-box">
                <select
                  className="duel-select"
                  value={map}
                  onChange={e => setMap(e.target.value as ConquestMapId)}
                >
                  {CONQUEST_MAPS.map(m => (
                    <option key={m.id} value={m.id}>{m.icon} {m.label}</option>
                  ))}
                </select>
                <span className="duel-select-caret">▾</span>
              </div>
            </div>

            <div className="duel-select-wrap">
              <label className="duel-select-label">🔄 Tur Sayısı</label>
              <div className="duel-select-box">
                <select
                  className="duel-select"
                  value={rounds}
                  onChange={e => setRounds(Number(e.target.value) as ConquestRoundCount)}
                >
                  {CONQUEST_ROUND_COUNTS.map(r => (
                    <option key={r} value={r}>{r} Tur</option>
                  ))}
                </select>
                <span className="duel-select-caret">▾</span>
              </div>
            </div>

            <div className="duel-select-wrap">
              <label className="duel-select-label">🔓 Oda Görünürlüğü</label>
              <div className="duel-select-box">
                <select
                  className="duel-select"
                  value={visibility}
                  onChange={e => setVisibility(e.target.value as ConquestVisibility)}
                >
                  <option value="public">🌐 Açık Oda</option>
                  <option value="private">🔒 Gizli Oda</option>
                </select>
                <span className="duel-select-caret">▾</span>
              </div>
            </div>
          </div>

          <button
            className="btn btn-accent duel-create-btn"
            onClick={handleSubmit}
            type="button"
          >
            🛡️ Oda Kur
          </button>
        </div>

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
