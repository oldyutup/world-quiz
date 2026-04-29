/**
 * DuelGame.tsx — Online 1v1 Ülke Yaz
 *
 * Flow:
 *   lobby → (create room | join room) → waiting → playing → finished
 *
 * Realtime subscriptions:
 *   duel_rooms   — status changes (waiting → playing → finished)
 *   duel_players — player list updates
 *   duel_claims  — new country claims (scored on both sides)
 */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { supabase, type DuelRoom, type DuelPlayer, type DuelClaim } from "../lib/supabase";
import { DuelMapView } from "./WorldMap";
import { NAME_TO_TOPOID, normalizeInput } from "../data/countries";

/* ─── constants ─── */
const GAME_DURATION = 60;         // seconds
const PLAYER_ID_KEY = "geoquiz_duel_player_id";
const ROOM_KEY      = "geoquiz_duel_room";

/* ─── helpers ─── */
function makeCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
function getOrCreatePlayerId(): string {
  let id = localStorage.getItem(PLAYER_ID_KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(PLAYER_ID_KEY, id); }
  return id;
}
function saveRoomSession(roomId: string, roomCode: string) {
  localStorage.setItem(ROOM_KEY, JSON.stringify({ roomId, roomCode }));
}
function loadRoomSession(): { roomId: string; roomCode: string } | null {
  try {
    const raw = localStorage.getItem(ROOM_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function clearRoomSession() { localStorage.removeItem(ROOM_KEY); }

type DuelPhase = "lobby" | "waiting" | "playing" | "finished";

interface DuelGameProps { onHome: () => void; }

export default function DuelGame({ onHome }: DuelGameProps) {
  /* ── identity ── */
  const myId   = useMemo(getOrCreatePlayerId, []);

  /* ── UI state ── */
  const [phase,       setPhase]      = useState<DuelPhase>("lobby");
  const [playerName,  setPlayerName] = useState("");
  const [joinCode,    setJoinCode]   = useState("");
  const [errorMsg,    setErrorMsg]   = useState<string | null>(null);
  const [statusMsg,   setStatusMsg]  = useState<string | null>(null);
  const [input,       setInput]      = useState("");
  const [feedback,    setFeedback]   = useState<"ok" | "err" | "dup" | null>(null);

  /* ── room state ── */
  const [room,       setRoom]       = useState<DuelRoom | null>(null);
  const [players,    setPlayers]    = useState<DuelPlayer[]>([]);
  const [claims,     setClaims]     = useState<DuelClaim[]>([]);
  const [timeLeft,   setTimeLeft]   = useState(GAME_DURATION);
  const [isHost,     setIsHost]     = useState(false);

  /* ── refs ── */
  const inputRef      = useRef<HTMLInputElement>(null);
  const startTimeRef  = useRef<number | null>(null);
  const rafRef        = useRef<number | null>(null);
  const feedbackRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gameEndedRef  = useRef(false);

  /* ── derived scores ── */
  const me  = players.find(p => p.id === myId);
  const opp = players.find(p => p.id !== myId);
  const myTopoIds  = useMemo(() => new Set(claims.filter(c => c.player_id === myId).map(c => c.country_code)),  [claims, myId]);
  const oppTopoIds = useMemo(() => new Set(claims.filter(c => c.player_id !== myId).map(c => c.country_code)), [claims, myId]);
  const myScore    = myTopoIds.size;
  const oppScore   = oppTopoIds.size;

  /* ── feedback helper ── */
  const showFeedback = useCallback((type: "ok"|"err"|"dup") => {
    if (feedbackRef.current) clearTimeout(feedbackRef.current);
    setFeedback(type);
    feedbackRef.current = setTimeout(() => setFeedback(null), 800);
  }, []);

  /* ── Try resuming a previous session ── */
  useEffect(() => {
    const saved = loadRoomSession();
    if (!saved) return;
    (async () => {
      const { data: r } = await supabase.from("duel_rooms").select("*").eq("id", saved.roomId).single();
      if (!r || r.status === "finished") { clearRoomSession(); return; }
      const { data: ps } = await supabase.from("duel_players").select("*").eq("room_id", r.id);
      const isMe = (ps ?? []).some((p: DuelPlayer) => p.id === myId);
      if (!isMe) { clearRoomSession(); return; }
      setRoom(r);
      setPlayers(ps ?? []);
      setIsHost((ps ?? [])[0]?.id === myId);
      if (r.status === "playing") {
        const { data: cs } = await supabase.from("duel_claims").select("*").eq("room_id", r.id);
        setClaims(cs ?? []);
        setPhase("playing");
      } else {
        setPhase("waiting");
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Realtime subscriptions (attach when room is known) ── */
  useEffect(() => {
    if (!room) return;
    const chan = supabase.channel(`room:${room.id}`)
      // room status
      .on("postgres_changes", { event:"UPDATE", schema:"public", table:"duel_rooms", filter:`id=eq.${room.id}` },
        payload => {
          const r = payload.new as DuelRoom;
          setRoom(r);
          if (r.status === "playing" && phase !== "playing") setPhase("playing");
          if (r.status === "finished" && !gameEndedRef.current) endGame();
        })
      // player list
      .on("postgres_changes", { event:"*", schema:"public", table:"duel_players", filter:`room_id=eq.${room.id}` },
        () => {
          supabase.from("duel_players").select("*").eq("room_id", room.id)
            .then(({ data }) => { if (data) setPlayers(data); });
        })
      // claims
      .on("postgres_changes", { event:"INSERT", schema:"public", table:"duel_claims", filter:`room_id=eq.${room.id}` },
        payload => {
          setClaims(prev => [...prev, payload.new as DuelClaim]);
        })
      .subscribe();
    return () => { supabase.removeChannel(chan); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id]);

  /* ── Wall-clock timer (starts when phase=playing) ── */
  useEffect(() => {
    if (phase !== "playing") return;
    if (!startTimeRef.current) startTimeRef.current = Date.now();
    const start = startTimeRef.current;
    const totalMs = GAME_DURATION * 1000;
    let done = false;

    const tick = () => {
      if (done) return;
      const elapsed = Date.now() - start;
      const rem = Math.max(0, Math.ceil((totalMs - elapsed) / 1000));
      setTimeLeft(rem);
      if (elapsed >= totalMs) { done = true; endGame(); return; }
      rafRef.current = requestAnimationFrame(tick);
    };

    const onVis = () => { if (document.visibilityState === "visible" && !done) tick(); };
    document.addEventListener("visibilitychange", onVis);
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      done = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      document.removeEventListener("visibilitychange", onVis);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  /* ── Focus input when playing starts ── */
  useEffect(() => {
    if (phase === "playing") setTimeout(() => inputRef.current?.focus(), 100);
  }, [phase]);

  /* ── endGame ── */
  const endGame = useCallback(async () => {
    if (gameEndedRef.current) return;
    gameEndedRef.current = true;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (room) {
      await supabase.from("duel_rooms").update({ status: "finished" }).eq("id", room.id);
    }
    clearRoomSession();
    setPhase("finished");
  }, [room]);

  /* ── CREATE ROOM ── */
  const createRoom = async () => {
    const name = playerName.trim();
    if (!name) { setErrorMsg("İsim girin."); return; }
    setErrorMsg(null); setStatusMsg("Oda kuruluyor…");
    const code = makeCode();
    const { data: r, error: re } = await supabase.from("duel_rooms").insert({ code, status: "waiting" }).select().single();
    if (re || !r) { setErrorMsg("Oda oluşturulamadı: " + (re?.message ?? "hata")); setStatusMsg(null); return; }
    const { data: p, error: pe } = await supabase.from("duel_players").insert({ id: myId, room_id: r.id, name, score: 0 }).select().single();
    if (pe || !p) { setErrorMsg("Oyuncuya eklenemedi."); setStatusMsg(null); return; }
    setRoom(r); setPlayers([p]); setIsHost(true);
    saveRoomSession(r.id, r.code);
    setStatusMsg(null); setPhase("waiting");
  };

  /* ── JOIN ROOM ── */
  const joinRoom = async () => {
    const name = playerName.trim();
    const code = joinCode.trim().toUpperCase();
    if (!name) { setErrorMsg("İsim girin."); return; }
    if (!code) { setErrorMsg("Oda kodu girin."); return; }
    setErrorMsg(null); setStatusMsg("Odaya bağlanılıyor…");
    const { data: r, error: re } = await supabase.from("duel_rooms").select("*").eq("code", code).single();
    if (re || !r) { setErrorMsg("Oda bulunamadı. Kodu kontrol edin."); setStatusMsg(null); return; }
    if (r.status === "finished") { setErrorMsg("Bu oyun zaten bitti."); setStatusMsg(null); return; }
    const { data: existing } = await supabase.from("duel_players").select("id").eq("room_id", r.id).eq("id", myId);
    if (!existing?.length) {
      const { error: pe } = await supabase.from("duel_players").insert({ id: myId, room_id: r.id, name, score: 0 });
      if (pe) { setErrorMsg("Odaya katılınamadı: " + pe.message); setStatusMsg(null); return; }
    }
    const { data: ps } = await supabase.from("duel_players").select("*").eq("room_id", r.id);
    setRoom(r); setPlayers(ps ?? []); setIsHost(false);
    saveRoomSession(r.id, r.code);
    setStatusMsg(null); setPhase("waiting");
  };

  /* ── START GAME (host only) ── */
  const startGame = async () => {
    if (!room || !isHost) return;
    const { error } = await supabase.from("duel_rooms").update({ status: "playing" }).eq("id", room.id);
    if (error) { setErrorMsg("Oyun başlatılamadı."); return; }
    // Fetch existing claims (resume scenario)
    const { data: cs } = await supabase.from("duel_claims").select("*").eq("room_id", room.id);
    setClaims(cs ?? []);
    startTimeRef.current = Date.now();
    setPhase("playing");
  };

  /* ── GUESS ── */
  const handleGuess = async () => {
    if (phase !== "playing" || !room || !me) return;
    const norm = normalizeInput(input);
    if (!norm) return;
    const topoId = NAME_TO_TOPOID[norm];
    if (!topoId) { showFeedback("err"); return; }

    // Check already claimed (client-side fast check)
    if (claims.some(c => c.country_code === topoId)) {
      showFeedback("dup"); return;
    }

    setInput("");
    const { error } = await supabase.from("duel_claims").insert({
      room_id:      room.id,
      player_id:    myId,
      country_code: topoId,
    });
    if (error) {
      if (error.code === "23505") { showFeedback("dup"); } // unique violation
      else showFeedback("err");
    } else {
      showFeedback("ok");
    }
  };

  /* ── URL join shortcut (read ?duel=CODE from URL) ── */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("duel");
    if (code) setJoinCode(code.toUpperCase());
  }, []);

  /* ─── derived UI ─── */
  const shareLink = room ? `${window.location.origin}${window.location.pathname}?duel=${room.code}` : "";
  const timerPct  = (timeLeft / GAME_DURATION) * 100;
  const timerColor = timeLeft > 20 ? "var(--accent)" : timeLeft > 8 ? "#f59e0b" : "#ef4444";
  const inputClass = ["duel-input", feedback === "ok" ? "ok" : feedback === "err" || feedback === "dup" ? "err" : ""].filter(Boolean).join(" ");

  const winText = phase === "finished"
    ? myScore > oppScore ? "🏆 Kazandın!"
    : myScore < oppScore ? "😔 Kaybettin"
    : "🤝 Beraberlik"
    : "";

  /* ─────────────────────────────────────────────────────────────
     RENDER
  ───────────────────────────────────────────────────────────── */
  return (
    <div className={"app duel-screen" + (phase === "playing" || phase === "finished" ? " duel-game-active" : "")}>
      {/* ── Header ── */}
      <div className="duel-header">
        <button className="back-btn" onClick={onHome}>← Menü</button>
        <div className="duel-header-center">
          <span className="duel-mode-label">⚔️ Online 1v1</span>
          {room && <span className="duel-code-badge">#{room.code}</span>}
        </div>
        {phase === "playing" && (
          <div className="timer-ring-wrap" style={{ width: 44, height: 44 }}>
            <svg viewBox="0 0 42 42" className="timer-svg">
              <circle cx="21" cy="21" r="17" fill="none" stroke="var(--border)" strokeWidth="3"/>
              <circle cx="21" cy="21" r="17" fill="none"
                stroke={timerColor} strokeWidth="3"
                strokeDasharray="106.8"
                strokeDashoffset={106.8 - (timerPct / 100) * 106.8}
                strokeLinecap="round"
                style={{ transform: "rotate(-90deg)", transformOrigin: "50% 50%", transition: "stroke-dashoffset 0.9s linear" }}
              />
            </svg>
            <span className="timer-num" style={{ color: timerColor }}>{timeLeft}</span>
          </div>
        )}
        {phase !== "playing" && <div style={{ width: 44 }}/>}
      </div>

      {/* ══════════════ LOBBY ══════════════ */}
      {phase === "lobby" && (
        <div className="duel-lobby">
          <div className="duel-lobby-card">
            <h2 className="duel-lobby-title">⚔️ Online 1v1</h2>
            <p className="duel-lobby-desc">Arkadaşınla ülke kapmaca oyna. Aynı anda ülke yazın, daha çok ülke yazan kazanır!</p>

            <input
              className="duel-name-input"
              type="text"
              placeholder="Oyuncu adın"
              value={playerName}
              onChange={e => setPlayerName(e.target.value)}
              maxLength={20}
              autoComplete="off"
            />

            {errorMsg && <p className="duel-error">{errorMsg}</p>}
            {statusMsg && <p className="duel-status">{statusMsg}</p>}

            <div className="duel-lobby-actions">
              <div className="duel-action-block">
                <button className="btn btn-accent" onClick={createRoom}>🏠 Oda Kur</button>
                <p className="duel-action-desc">Sen ev sahibi ol, arkadaşın katılsın.</p>
              </div>
              <div className="duel-divider">veya</div>
              <div className="duel-action-block">
                <div className="duel-join-row">
                  <input
                    className="duel-code-input"
                    type="text"
                    placeholder="ODA KODU"
                    value={joinCode}
                    onChange={e => setJoinCode(e.target.value.toUpperCase())}
                    maxLength={6}
                    autoComplete="off"
                  />
                  <button className="btn btn-danger" onClick={joinRoom}>Katıl</button>
                </div>
                <p className="duel-action-desc">Arkadaşının verdiği 6 karakterlik kodu gir.</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════ WAITING ══════════════ */}
      {phase === "waiting" && room && (
        <div className="duel-lobby">
          <div className="duel-lobby-card">
            <h2 className="duel-lobby-title">Oda Bekleniyor</h2>

            <div className="duel-room-code-block">
              <span className="duel-room-code">{room.code}</span>
              <p className="duel-room-code-hint">Bu kodu arkadaşınla paylaş</p>
            </div>

            <div className="duel-share-row">
              <input className="duel-link-input" readOnly value={shareLink} onFocus={e=>e.target.select()}/>
              <button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard.writeText(shareLink)}>Kopyala</button>
            </div>

            <div className="duel-players-list">
              {players.map(p => (
                <div key={p.id} className={"duel-player-chip" + (p.id === myId ? " mine" : "")}>
                  <span className="duel-player-dot"/>
                  {p.name} {p.id === myId ? "(Sen)" : ""}
                  {players[0]?.id === p.id ? " 👑" : ""}
                </div>
              ))}
              {players.length < 2 && (
                <div className="duel-player-chip waiting">
                  <span className="duel-player-dot waiting"/>
                  Rakip bekleniyor…
                </div>
              )}
            </div>

            {isHost && players.length >= 2 && (
              <button className="btn btn-accent duel-start-btn" onClick={startGame}>
                🚀 Oyunu Başlat
              </button>
            )}
            {!isHost && (
              <p className="duel-waiting-msg">Ev sahibi oyunu başlatacak…</p>
            )}

            <button className="btn btn-ghost btn-sm" onClick={() => { clearRoomSession(); setRoom(null); setPlayers([]); setPhase("lobby"); }}>
              ← Lobiye Dön
            </button>
          </div>
        </div>
      )}

      {/* ══════════════ PLAYING ══════════════ */}
      {phase === "playing" && (
        <>
          {/* Score bar */}
          <div className="duel-score-bar">
            <div className="duel-score-mine">
              <span className="duel-score-name">{me?.name ?? "Ben"}</span>
              <span className="duel-score-num mine">{myScore}</span>
            </div>
            <span className="duel-score-vs">vs</span>
            <div className="duel-score-opp">
              <span className="duel-score-num opp">{oppScore}</span>
              <span className="duel-score-name">{opp?.name ?? "Rakip"}</span>
            </div>
          </div>

          {/* Map */}
          <div className="map-area">
            <DuelMapView myTopoIds={myTopoIds} oppTopoIds={oppTopoIds}/>
          </div>

          {/* Input */}
          <div className="duel-input-bar">
            <input
              ref={inputRef}
              type="text"
              className={inputClass}
              placeholder="Ülke adı yaz… (Enter)"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleGuess(); }}
              autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
            />
            <button className="btn btn-accent" onClick={handleGuess}>Gir</button>
            <div className="duel-fb-slot">
              {feedback === "ok"  && <span className="fb fb-ok">✓ Alındı!</span>}
              {feedback === "err" && <span className="fb fb-no">✗ Bulunamadı</span>}
              {feedback === "dup" && <span className="fb fb-dup">Zaten alındı</span>}
            </div>
          </div>
        </>
      )}

      {/* ══════════════ FINISHED ══════════════ */}
      {phase === "finished" && (
        <div className="duel-lobby">
          <div className="duel-lobby-card">
            <div className="duel-result-emoji">{myScore > oppScore ? "🏆" : myScore < oppScore ? "😔" : "🤝"}</div>
            <h2 className="duel-result-title">{winText}</h2>

            <div className="duel-result-scores">
              <div className="duel-result-col mine">
                <span className="duel-result-name">{me?.name ?? "Ben"}</span>
                <span className="duel-result-num">{myScore}</span>
              </div>
              <span className="duel-result-vs">—</span>
              <div className="duel-result-col opp">
                <span className="duel-result-num">{oppScore}</span>
                <span className="duel-result-name">{opp?.name ?? "Rakip"}</span>
              </div>
            </div>

            <p className="duel-result-sub">Toplam {claims.length} ülke yazıldı.</p>

            <div className="duel-result-actions">
              <button className="btn btn-accent" onClick={() => { clearRoomSession(); setRoom(null); setPlayers([]); setClaims([]); gameEndedRef.current = false; startTimeRef.current = null; setPhase("lobby"); }}>
                🔄 Tekrar Oyna
              </button>
              <button className="btn btn-ghost" onClick={onHome}>⌂ Ana Menü</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
