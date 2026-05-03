/**
 * DuelGame.tsx — Online 1v1 Ülke Yaz (v3)
 *
 * ⚠️  Supabase setup (gerekli SQL):
 *
 *   ALTER TABLE duel_rooms
 *     ADD COLUMN IF NOT EXISTS duration_seconds int  NOT NULL DEFAULT 60,
 *     ADD COLUMN IF NOT EXISTS region          text NOT NULL DEFAULT 'world';
 *
 *   -- Heartbeat presence column (already applied):
 *   ALTER TABLE duel_players
 *     ADD COLUMN IF NOT EXISTS last_seen_at timestamptz DEFAULT now();
 *
 *   -- RLS: anon users must be able to INSERT into all 3 tables.
 *   -- If INSERT fails with "permission denied", run:
 *   ALTER TABLE duel_rooms   ENABLE ROW LEVEL SECURITY;
 *   ALTER TABLE duel_players ENABLE ROW LEVEL SECURITY;
 *   ALTER TABLE duel_claims  ENABLE ROW LEVEL SECURITY;
 *
 *   CREATE POLICY "anon_insert_rooms"   ON duel_rooms   FOR INSERT TO anon WITH CHECK (true);
 *   CREATE POLICY "anon_select_rooms"   ON duel_rooms   FOR SELECT TO anon USING (true);
 *   CREATE POLICY "anon_update_rooms"   ON duel_rooms   FOR UPDATE TO anon USING (true);
 *   CREATE POLICY "anon_insert_players" ON duel_players FOR INSERT TO anon WITH CHECK (true);
 *   CREATE POLICY "anon_select_players" ON duel_players FOR SELECT TO anon USING (true);
 *   CREATE POLICY "anon_update_players" ON duel_players FOR UPDATE TO anon USING (true);
 *   CREATE POLICY "anon_insert_claims"  ON duel_claims  FOR INSERT TO anon WITH CHECK (true);
 *   CREATE POLICY "anon_select_claims"  ON duel_claims  FOR SELECT TO anon USING (true);
 *
 *   -- Also enable Realtime on all three tables.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { supabase, type DuelRoom, type DuelPlayer, type DuelClaim } from "../lib/supabase";
import { DuelMapView } from "./WorldMap";
import LobbyChat from "./LobbyChat";
import { NAME_TO_TOPOID, normalizeInput, getContinentIds, type Continent } from "../data/countries";

/* ─── options ─── */
const DURATION_OPTS = [
  { label: "30 sn", value: 30  },
  { label: "1 dk",  value: 60  },
  { label: "2 dk",  value: 120 },
  { label: "3 dk",  value: 180 },
  { label: "5 dk",  value: 300 },
];

const REGION_OPTS = [
  { label: "🌍 Dünya",          value: "world"         },
  { label: "🇪🇺 Avrupa",        value: "europe"        },
  { label: "🌏 Asya",           value: "asia"          },
  { label: "🌍 Afrika",         value: "africa"        },
  { label: "🌎 Kuzey Amerika",  value: "north-america" },
  { label: "🌎 Güney Amerika",  value: "south-america" },
  { label: "🌊 Okyanusya",      value: "oceania"       },
];

/**
 * Normalize region value for consistent DB storage and lookup.
 * Supabase LIKE queries are case-sensitive; we always write the same string.
 * UI labels can differ, but DB always stores exactly these values.
 */
const normalizeRegion = (r: string): string => {
  const map: Record<string, string> = {
    "north-america": "north_america",
    "south-america": "south_america",
    // already normalized or other regions pass through
  };
  return map[r] ?? r;
};

const denormalizeRegion = (r: string): string => {
  // Convert DB value back to getContinentIds key
  const map: Record<string, string> = {
    "north_america": "north-america",
    "south_america": "south-america",
  };
  return map[r] ?? r;
};

/* ─── localStorage helpers ─── */
const PLAYER_ID_KEY = "geoquiz_duel_player_id";   // persists across rooms (resume)
const ROOM_KEY      = "geoquiz_duel_room";         // current room session

const DUEL_VERSION = "Online v3";

function makeCode() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

/* ─── debug logger ─── */
function dbg(label: string, obj?: unknown) {
  console.log(`[DuelGame ${DUEL_VERSION}] ${label}`, obj ?? "");
}
function dbgErr(label: string, err?: unknown, ctx?: unknown) {
  console.error(`[DuelGame ${DUEL_VERSION}] ❌ ${label}`, err, ctx ?? "");
}

/**
 * Generate a fresh player UUID for a new room.
 * We intentionally generate a new one each time "Oda Kur" is pressed
 * so old player rows in Supabase never collide.
 * The new ID is written to localStorage so "resume on reload" works
 * for the current room only.
 */
function freshPlayerId(): string {
  const id = crypto.randomUUID();
  localStorage.setItem(PLAYER_ID_KEY, id);
  dbg("freshPlayerId generated", id);
  return id;
}

interface RoomSession { roomId: string; roomCode: string; playerId: string; }

function saveRoomSession(roomId: string, roomCode: string, playerId: string) {
  localStorage.setItem(ROOM_KEY, JSON.stringify({ roomId, roomCode, playerId }));
}
function loadRoomSession(): RoomSession | null {
  try {
    const raw = localStorage.getItem(ROOM_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Validate required fields
    if (!parsed?.roomId || !parsed?.roomCode || !parsed?.playerId) return null;
    return parsed as RoomSession;
  } catch { return null; }
}

/**
 * Full duel session reset — clears ALL duel-related localStorage keys.
 * Call before creating a new room or on explicit logout/menu navigation.
 */
function clearDuelSession() {
  // Remove all keys that start with "geoquiz_duel"
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("geoquiz_duel")) keysToRemove.push(k);
  }
  keysToRemove.forEach(k => localStorage.removeItem(k));
  dbg("clearDuelSession: removed", keysToRemove);
}


/* ─── region allow-list ─── */
function buildAllowedSet(region: string): Set<string> | null {
  if (region === "world") return null;
  // Denormalize DB value (e.g. "north_america" → "north-america") before getContinentIds
  const key = denormalizeRegion(region);
  return getContinentIds(key as Continent);
}

/* ─── phase ─── */
type DuelPhase = "lobby" | "creating" | "waiting" | "playing" | "finished";

interface DuelGameProps { onHome: () => void; }

export default function DuelGame({ onHome }: DuelGameProps) {
  /* identity — set fresh for each new room, loaded from session on resume */
  const myIdRef = useRef<string>("");
  // Convenience getter so we don't change 30+ call sites
  const myId = myIdRef.current;

  /* lobby form */
  const [playerName,   setPlayerName]   = useState("");
  const [joinCode,     setJoinCode]     = useState("");
  const [hostDuration, setHostDuration] = useState(60);
  const [hostRegion,   setHostRegion]   = useState("world");

  /* phase / messages */
  const [phase,     setPhase]     = useState<DuelPhase>("lobby");
  const [errorMsg,  setErrorMsg]  = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  /* game state */
  const [room,        setRoom]        = useState<DuelRoom | null>(null);
  const [players,     setPlayers]     = useState<DuelPlayer[]>([]);
  const [claims,      setClaims]      = useState<DuelClaim[]>([]);
  const [timeLeft,    setTimeLeft]    = useState(60);
  const [isHost,      setIsHost]      = useState(false);
  const [input,       setInput]       = useState("");
  const [feedback,    setFeedback]    = useState<"ok" | "err" | "dup" | "region" | null>(null);
  const [copied,      setCopied]      = useState(false);
  const [isQuickMatch,  setIsQuickMatch]  = useState(false);
  const [showLabels,    setShowLabels]    = useState(true);
  const [quitModal,    setQuitModal]    = useState(false);
  // "idle" = main options, "forfeit" = confirm forfeit, "menu" = confirm menu exit
  type QuitStep = "idle" | "forfeit" | "menu";
  const [quitStep, setQuitStep] = useState<QuitStep>("idle");

  // Rematch state
  type RematchState = "idle" | "requested" | "received" | "declined";
  const [rematch, setRematch] = useState<RematchState>("idle");

  // Frozen scores at game end — prevent late realtime claims from changing result display
  const [finalScores, setFinalScores] = useState<{ my: number; opp: number } | null>(null);

  // Disconnect grace period (manual room only)
  const [oppDisconnected,      setOppDisconnected]      = useState(false);
  const [disconnectCountdown,  setDisconnectCountdown]  = useState(0);
  const disconnectTimerRef    = useRef<ReturnType<typeof setTimeout>  | null>(null);
  const disconnectIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Heartbeat: my own presence tick + opponent monitor (manual room only)
  const heartbeatRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const oppMonitorRef    = useRef<ReturnType<typeof setInterval> | null>(null);

  /* refs */
  const inputRef        = useRef<HTMLInputElement>(null);
  const startTimeRef    = useRef<number | null>(null);
  const rafRef          = useRef<number | null>(null);
  const fbTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gameEndedRef    = useRef(false);
  const lastWriteRef = useRef(0);
  const staleCountRef = useRef(0);
  const timeLeftRef     = useRef<number>(9999);   // mirrors timeLeft; readable in async handlers
  const pollTimerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  // Refs that keep realtime callbacks up-to-date (avoids stale closure bugs)
  const phaseRef        = useRef<DuelPhase>("lobby");
  const isHostRef       = useRef(false);
  const isQuickRef      = useRef(false);
  // Stable identity ref — set on joinRoom/createRoom success AND session restore
  const activePlayerIdRef = useRef<string | null>(null);

  /* derived */
  const gameDuration = room?.duration_seconds ?? hostDuration;
  const gameRegion   = room?.region ?? hostRegion;
  const allowedIds   = useMemo(() => buildAllowedSet(gameRegion), [gameRegion]);
  // gameRegion may be stored as "north_america" (normalized) or "north-america" (UI)
  // Denormalize before looking up label
  const regionLabel  = REGION_OPTS.find(r => r.value === denormalizeRegion(gameRegion))?.label
    ?? REGION_OPTS.find(r => r.value === gameRegion)?.label
    ?? "Dünya";
  const durationLabel = DURATION_OPTS.find(d => d.value === gameDuration)?.label ?? `${gameDuration}sn`;

  const me  = players.find(p => p.id === myId);
  const opp = players.find(p => p.id !== myId);

  // Keep refs in sync so realtime handlers always read fresh values
  phaseRef.current   = phase;
  isHostRef.current  = isHost;
  isQuickRef.current = isQuickMatch;
  timeLeftRef.current = timeLeft;

  // Snapshot helpers used inside async handlers (avoids stale closure)
  const roomIdRef = useRef<string>("");
  if (room) roomIdRef.current = room.id;

  const myTopoIds  = useMemo(() => new Set(claims.filter(c => c.player_id === myId).map(c => c.country_code)), [claims, myId]);
  const oppTopoIds = useMemo(() => new Set(claims.filter(c => c.player_id !== myId).map(c => c.country_code)), [claims, myId]);
  const myScore    = myTopoIds.size;
  const oppScore   = oppTopoIds.size;

  const shareLink  = room ? `${location.origin}${location.pathname}?duel=${room.code}` : "";
  const timerPct   = (timeLeft / gameDuration) * 100;
  const timerColor = timeLeft > gameDuration * 0.33 ? "var(--accent)" : timeLeft > gameDuration * 0.13 ? "#f59e0b" : "#ef4444";
  const gameOver = gameEndedRef.current || timeLeft <= 0 || phase === "finished";
  const inputCls = ["duel-input",
    feedback === "ok"  ? "ok"  : "",
    feedback === "err" || feedback === "dup" || feedback === "region" ? "err" : "",
    gameOver ? "disabled" : "",
  ].filter(Boolean).join(" ");

  /* ── feedback ── */
  const showFeedback = useCallback((type: "ok" | "err" | "dup" | "region") => {
    if (fbTimerRef.current) clearTimeout(fbTimerRef.current);
    setFeedback(type);
    fbTimerRef.current = setTimeout(() => setFeedback(null), 900);
  }, []);

  /* ── Restore session on mount ── */
  useEffect(() => {
    const saved = loadRoomSession();
    if (!saved) return;

    // Restore the stored playerId into the ref FIRST
    myIdRef.current = saved.playerId;
    activePlayerIdRef.current = saved.playerId;
    dbg("session restore: playerId loaded", saved.playerId);

    (async () => {
      const { data: r } = await supabase
        .from("duel_rooms").select("*").eq("id", saved.roomId).single();
      if (!r || r.status === "finished") {
        dbg("session restore: room finished or missing, clearing");
        clearDuelSession(); return;
      }
      const { data: ps } = await supabase
        .from("duel_players").select("*").eq("room_id", r.id);
      const isMe = (ps ?? []).some((p: DuelPlayer) => p.id === saved.playerId);
      if (!isMe) {
        dbg("session restore: playerId not in room, clearing");
        clearDuelSession(); return;
      }
      const room = r as DuelRoom;
      setRoom(room);
      setPlayers(ps ?? []);
      setIsHost((ps ?? [])[0]?.id === saved.playerId);
      setTimeLeft(room.duration_seconds);
      if (r.status === "playing") {
        const { data: cs } = await supabase
          .from("duel_claims").select("*").eq("room_id", r.id);
        setClaims(cs ?? []);
        setPhase("playing");
      } else {
        setPhase("waiting");
      }
      dbg("session restore: success", { roomId: r.id, status: r.status });
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Read ?duel=CODE from URL ── */
  useEffect(() => {
    const code = new URLSearchParams(location.search).get("duel");
    if (code) setJoinCode(code.toUpperCase());
  }, []);

  /* ── Realtime subscriptions ── */

  /* ── handleOppDisconnect ──
   * Called by the opponent monitor when opponent last_seen_at is stale (> 6 s).
   * Starts a 15-second grace countdown. Idempotent: if already running, does nothing.
   * Cancelled by the opponent monitor when heartbeat resumes.
   * Only active in manual room mode (isQuickRef.current === false).
   */
  const handleOppDisconnect = useCallback((_lastSeenAt: string) => {
    if (gameEndedRef.current) return;
    if (disconnectTimerRef.current) return; // grace already in progress

    const GRACE =
  gameDuration <= 60 ? 20 :
  gameDuration <= 120 ? 30 :
  45;
    dbg("handleOppDisconnect: grace countdown start", { grace: GRACE });
    setOppDisconnected(true);
    setDisconnectCountdown(GRACE);

    disconnectIntervalRef.current = setInterval(() => {
      setDisconnectCountdown(prev => {
        if (prev <= 1) {
          if (disconnectIntervalRef.current) clearInterval(disconnectIntervalRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    disconnectTimerRef.current = setTimeout(async () => {
      if (gameEndedRef.current) return;
      const roomId = roomIdRef.current;
      const myId   = myIdRef.current;
      dbg("handleOppDisconnect: grace expired, declaring winner", myId);
      gameEndedRef.current = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
      if (oppMonitorRef.current) { clearInterval(oppMonitorRef.current); oppMonitorRef.current = null; }
      if (heartbeatRef.current)  { clearInterval(heartbeatRef.current);  heartbeatRef.current  = null; }

      try {
        const { data: cs } = await supabase
          .from("duel_claims").select("player_id").eq("room_id", roomId);
        const counts: Record<string, number> = {};
        (cs ?? []).forEach((c: { player_id: string }) => {
          counts[c.player_id] = (counts[c.player_id] ?? 0) + 1;
        });
        setFinalScores({ my: counts[myId] ?? 0, opp: 0 });
      } catch { /* ignore — UI falls back to live score state */ }

      await supabase.from("duel_rooms").update({
        status:              "finished",
        finished_reason:     "disconnect",
        winner_player_id:    myId,
        forfeited_player_id: null,
      }).eq("id", roomId).eq("status", "playing");

      clearDuelSession();
      setOppDisconnected(false);
      setDisconnectCountdown(0);
      setPhase("finished");
    }, GRACE * 1000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!room) return;
    const chan = supabase.channel(`duel:${room.id}`)
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "duel_rooms", filter: `id=eq.${room.id}` },
        async payload => {
          const r = payload.new as DuelRoom;
          setRoom(r);

          // Rematch pointer: opponent created new room and set rematch_room_id
          if (r.rematch_room_id && phaseRef.current === "finished") {
            dbg("RT: rematch_room_id detected, joining", r.rematch_room_id);
            await joinRematchRoom(r.rematch_room_id);
            return;
          }

          if (r.status === "playing" && phaseRef.current !== "playing") {
            dbg("RT: room → playing, started_at:", r.started_at);
            // r already has started_at from DB; setRoom(r) above already merged it
            setPhase("playing");
          }
          if (r.status === "finished" && !gameEndedRef.current) {
            gameEndedRef.current = true;
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
            // FIX: Non-triggerer client arrives here via Realtime UPDATE.
            // finalScores was never set on this client (finishGameByTimeout wasn't called here),
            // so we must fetch claims from DB and freeze scores now, before switching phase.
            // Without this, the non-triggerer falls back to possibly-stale claims state.
            const roomId = roomIdRef.current;
            const myId   = myIdRef.current;
            try {
              const { data: cs } = await supabase
                .from("duel_claims").select("player_id").eq("room_id", roomId);
              const counts: Record<string, number> = {};
              (cs ?? []).forEach((c: { player_id: string }) => {
                counts[c.player_id] = (counts[c.player_id] ?? 0) + 1;
              });
              const myFinal  = counts[myId] ?? 0;
              const oppEntry = Object.entries(counts).find(([id]) => id !== myId);
              const oppFinal = oppEntry ? oppEntry[1] : 0;
              setFinalScores({ my: myFinal, opp: oppFinal });
              dbg("RT finished: froze finalScores for non-triggerer", { myFinal, oppFinal });
            } catch (e) {
              dbgErr("RT finished: could not fetch claims for freeze", e);
              // Fall back to live score state — better than nothing
            }
            clearDuelSession();
            setPhase("finished");
          }
        })
      .on("postgres_changes",
        { event: "*", schema: "public", table: "duel_players", filter: `room_id=eq.${room.id}` },
        () => {
          supabase.from("duel_players").select("*").eq("room_id", room.id)
            .then(({ data }) => {
              if (!data) return;
              setPlayers(data);
              // Quick match auto-start:
              // Only trigger if we're the host, still waiting, and 2nd player just arrived
              if (
                isQuickRef.current &&
                isHostRef.current &&
                phaseRef.current === "waiting" &&
                data.length >= 2
              ) {
                dbg("quickMatch RT: 2nd player arrived, host auto-starting");
                const startedAt = new Date().toISOString();
                supabase.from("duel_rooms")
                  .update({ status: "playing", started_at: startedAt })
                  .eq("id", room.id)
                  .then(({ error }) => {
                    if (error) dbgErr("quickMatch auto-start failed", error);
                    else dbg("quickMatch: room set to playing ✓");
                  });
              }

              // Opponent left → they forfeit, we win
              if (
                phaseRef.current === "playing" &&
                !gameEndedRef.current &&
                data.length < 2
              ) {
                dbg("RT: opponent left — they forfeit, we win");
                gameEndedRef.current = true;
                if (rafRef.current) cancelAnimationFrame(rafRef.current);
                const myId = myIdRef.current;
                const oppLeftUpdates = {
                  status:           "finished" as const,
                  finished_reason:  "forfeit" as const,
                  winner_player_id: myId,
                };
                setRoom(prev => prev ? { ...prev, ...oppLeftUpdates } : prev);
                supabase.from("duel_rooms").update(oppLeftUpdates).eq("id", room.id).then(() => {});
                clearDuelSession();
                setPhase("finished");
              }
            });
        })
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "duel_claims", filter: `room_id=eq.${room.id}` },
        payload => {
          // Do NOT update claims after game has ended — final score must be frozen
          if (gameEndedRef.current || phaseRef.current === "finished") return;
          setClaims(prev => [...prev, payload.new as DuelClaim]);
        })
      // ── Rematch broadcasts ──
      .on("broadcast", { event: "rematch_request" }, () => {
        dbg("RT: rematch_request received");
        setRematch("received");
      })
      .on("broadcast", { event: "rematch_declined" }, () => {
        dbg("RT: rematch_declined received");
        setRematch("declined");
        // Auto-clear after a few seconds
        setTimeout(() => setRematch("idle"), 4000);
      })
      // (rematch_start broadcast replaced by rematch_room_id detection in UPDATE handler above)
      .subscribe();
    return () => { supabase.removeChannel(chan); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id]);

  /* ── finishGameByTimeout ──
   *  Any client can call this when remainingTime <= 0.
   *  Uses conditional update (.eq("status","playing")) so only ONE write wins
   *  even if both clients call simultaneously — Supabase atomic update.
   *  The "loser" write is a no-op (row already has status="finished").
   *
   *  FIX: After writing (or no-op), always freeze scores and set phase="finished"
   *  on THIS client. The non-triggerer client gets the same via Realtime UPDATE.
   *  Previously this function never called setPhase("finished"), causing the
   *  triggerer client to hang waiting for a Realtime event that might be delayed.
   */
  const finishGameByTimeout = useCallback(async () => {
    if (gameEndedRef.current || !room) return;
    gameEndedRef.current = true;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }

    // Fetch freshest claims from DB (not stale local state)
    const { data: cs } = await supabase
      .from("duel_claims").select("player_id").eq("room_id", room.id);
    const counts: Record<string, number> = {};
    (cs ?? []).forEach(c => { counts[c.player_id] = (counts[c.player_id] ?? 0) + 1; });

    // Freeze displayed scores before any more realtime INSERTs arrive
    const myId = myIdRef.current;
    const myFinal  = counts[myId]  ?? 0;
    const oppEntry = Object.entries(counts).find(([id]) => id !== myId);
    const oppFinal = oppEntry ? oppEntry[1] : 0;
    setFinalScores({ my: myFinal, opp: oppFinal });

    const ids = Object.keys(counts);
    let winnerId: string | null = null;
    if (ids.length >= 2) {
      const sorted = ids.sort((a, b) => counts[b] - counts[a]);
      if (counts[sorted[0]] > counts[sorted[1]]) winnerId = sorted[0];
    } else if (ids.length === 1) {
      winnerId = ids[0];
    }

    // Conditional update: only succeeds if room is still "playing"
    // Both clients may race here — only one will actually change the row.
    await supabase.from("duel_rooms")
      .update({
        status: "finished",
        finished_reason: "timeout",
        winner_player_id: winnerId,
      })
      .eq("id", room.id)
      .eq("status", "playing");   // ← prevents double-write

    dbg("finishGameByTimeout: written or no-op", { winnerId, myFinal, oppFinal });

    // FIX: Always transition to finished on THIS client immediately after the DB
    // write (whether it won the race or not). The non-triggerer arrives via the
    // Realtime UPDATE handler below. Without this line the triggerer could hang
    // indefinitely if its own Realtime echo is delayed or dropped.
    setRoom(prev => prev
      ? { ...prev, status: "finished", finished_reason: "timeout", winner_player_id: winnerId }
      : prev
    );
    setPhase("finished");
    clearDuelSession();
  }, [room]);

  /* ── SERVER-AUTHORITATIVE TIMER ──
   *  Source of truth: room.started_at (written by server on game start).
   *  Every client independently computes remainingTime.
   *  When time expires, ANY client calls finishGameByTimeout().
   *  The conditional DB update (.eq("status","playing")) ensures atomicity.
   */
  useEffect(() => {
    if (phase !== "playing") return;
    if (!room?.started_at) {
      dbg("timer: waiting for room.started_at");
      return;
    }
    
    const totalMs = gameDuration * 1000;
    let done = false;

    const tick = () => {
      if (done) return;
      const now = Date.now();

// start güvenli
const safeStart = room.started_at
  ? new Date(room.started_at).getTime()
  : now;

const endMs = safeStart + totalMs;

// kalan süre (ms)
const remainingMs = Math.max(0, endMs - now);

// saniye
const rem = Math.floor(remainingMs / 1000);

// asla gameDuration'ı geçmesin
const safeRem = Math.min(gameDuration, rem);

setTimeLeft(safeRem);
      if (now >= endMs) {
        done = true;
        if (!gameEndedRef.current) {
          // ANY client triggers finish — conditional update prevents double-write
          finishGameByTimeout();
        }
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    const onVisible = () => {
      if (document.visibilityState === "visible" && !done) {
        // Re-check if game already finished while tab was hidden
        if (phaseRef.current !== "playing") { done = true; return; }
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      done = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, gameDuration, room?.started_at]);

  /* auto-focus */
  useEffect(() => {
    if (phase === "playing") setTimeout(() => inputRef.current?.focus(), 100);
  }, [phase]);

  /* ── Realtime fallback: poll room every 1 s while playing ──
   *  If realtime event was missed (network hiccup, tab sleep), polling
   *  catches the status change and triggers the result screen.
   */
  useEffect(() => {
    if (phase !== "playing" || !room?.id) return;
    const roomId = room.id;
    pollTimerRef.current = setInterval(async () => {
      if (phaseRef.current !== "playing") {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        return;
      }
      try {
        const { data } = await supabase
          .from("duel_rooms")
          .select("status, finished_reason, winner_player_id, forfeited_player_id, started_at")
          .eq("id", roomId)
          .single();
        if (!data) return;
        if (data.status === "finished" && !gameEndedRef.current) {
          dbg("poll: detected finished room — applying result");
          gameEndedRef.current = true;
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          // FIX: Freeze finalScores from DB so this fallback path also shows
          // correct scores (same as RT handler fix above).
          const myId = myIdRef.current;
          try {
            const { data: cs } = await supabase
              .from("duel_claims").select("player_id").eq("room_id", roomId);
            const counts: Record<string, number> = {};
            (cs ?? []).forEach((c: { player_id: string }) => {
              counts[c.player_id] = (counts[c.player_id] ?? 0) + 1;
            });
            const myFinal  = counts[myId] ?? 0;
            const oppEntry = Object.entries(counts).find(([id]) => id !== myId);
            const oppFinal = oppEntry ? oppEntry[1] : 0;
            setFinalScores({ my: myFinal, opp: oppFinal });
            dbg("poll finished: froze finalScores", { myFinal, oppFinal });
          } catch { /* ignore — UI falls back to live score state */ }
          // Merge polled data into room state
          setRoom(prev => prev ? { ...prev, ...data } : prev);
          clearDuelSession();
          setPhase("finished");
        }
      } catch { /* network error — ignore, next poll will retry */ }
    }, 1000);
    return () => {
      if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, room?.id]);

  /* ── ESC → toggle quit modal while playing ── */
  useEffect(() => {
    if (phase !== "playing") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setQuitModal(prev => {
        if (prev) setQuitStep("idle"); // reset to main options when closing
        return !prev;
      });
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [phase]);

  /* ── Heartbeat: update my own last_seen_at every 3 s while playing ── */
  useEffect(() => {
    if (phase !== "playing") return;

    const myId   = myIdRef.current;
    const roomId = roomIdRef.current;
    if (!myId || !roomId) return;

    const tick = () => {
      supabase
        .from("duel_players")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", myId)
        .then(({ error }) => {
          if (error) dbgErr("heartbeat update failed", error);
        });
    };

    tick(); // immediate first tick
    heartbeatRef.current = setInterval(tick, 3000);

    return () => {
      if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  /* ── Opponent monitor: poll opponent last_seen_at every 3 s ──
   *
   * Works for both manual room and Quick Match.
   * If opponent last_seen_at is > 6 s old → start 15-s disconnect grace.
   * If opponent heartbeat resumes            → cancel grace.
   * Opponent is always players.find(p => p.id !== myId) — never self.
   */
  useEffect(() => {
    if (phase !== "playing" || !room) return;

    const roomId = room.id;

    const check = async () => {
      if (phaseRef.current !== "playing" || gameEndedRef.current) return;

      const myId = myIdRef.current;
      const { data: ps } = await supabase
        .from("duel_players")
        .select("id, last_seen_at")
        .eq("room_id", roomId);

      if (!ps || ps.length < 2) return; // opponent not yet present

      const opp = ps.find((p: { id: string }) => p.id !== myId);
      if (!opp) return;

      const lastSeen = opp.last_seen_at
  ? new Date(opp.last_seen_at).getTime()
  : 0;

const started = room.started_at
  ? new Date(room.started_at).getTime()
  : Date.now();

const justStarted = Date.now() - started < 10000;

const stale =
  !justStarted &&
  lastSeen > 0 &&
  (Date.now() - lastSeen) > 20000;

      dbg("opp monitor", { oppId: opp.id, lastSeen: opp.last_seen_at, stale });

      if (stale) {
  staleCountRef.current += 1;

  if (staleCountRef.current >= 2) {
    handleOppDisconnect(opp.last_seen_at);
  }
} else {
  staleCountRef.current = 0;
        if (disconnectTimerRef.current || disconnectIntervalRef.current) {
          if (disconnectTimerRef.current)   { clearTimeout(disconnectTimerRef.current);   disconnectTimerRef.current   = null; }
          if (disconnectIntervalRef.current){ clearInterval(disconnectIntervalRef.current); disconnectIntervalRef.current = null; }
          setOppDisconnected(false);
          setDisconnectCountdown(0);
          dbg("opp monitor: opp alive, grace cancelled");
        }
      }
    };

    check(); // immediate first check
    oppMonitorRef.current = setInterval(check, 3000);

    return () => {
      if (oppMonitorRef.current) { clearInterval(oppMonitorRef.current); oppMonitorRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, room?.id]);

  /* ── CREATE ROOM ── */
  const createRoom = async () => {
    const name = playerName.trim();
    if (!name) { setErrorMsg("İsim yazmalısın."); return; }

    setErrorMsg(null);
    setStatusMsg("Oda kuruluyor…");
    setPhase("creating");

    // ── Clear old session and generate a FRESH player ID ──
    // This prevents the 23505 unique-violation: old rows in Supabase
    // from previous rooms will never share this new UUID.
    clearDuelSession();
    const freshId = freshPlayerId();
    myIdRef.current = freshId;

    const code = makeCode();
    dbg("createRoom start", { code, playerId: freshId, hostDuration, hostRegion });

    // ── Step 1: Insert duel_rooms ──
    const { data: roomData, error: roomErr } = await supabase
      .from("duel_rooms")
      .insert({ code, status: "waiting", duration_seconds: hostDuration, region: normalizeRegion(hostRegion) })
      .select("id, code, status, duration_seconds, region, created_at")
      .single();

    dbg("duel_rooms insert result", { roomData, roomErr });

    let room: DuelRoom | null = null;

    if (roomErr || !roomData?.id) {
      dbgErr("duel_rooms insert failed", roomErr, { code });
      // Fallback: maybe insert succeeded but .select failed — try fetching by code
      const { data: fetched, error: fetchErr } = await supabase
        .from("duel_rooms")
        .select("id, code, status, duration_seconds, region, created_at")
        .eq("code", code)
        .single();
      dbg("duel_rooms fallback fetch", { fetched, fetchErr });
      if (!fetched?.id) {
        const msg = roomErr?.code === "42501"
          ? "Veritabanı izin hatası. Yöneticiyle iletişime geç."
          : "Oda oluşturulamadı. Bağlantıyı kontrol et.";
        setErrorMsg(msg);
        setStatusMsg(null); setPhase("lobby"); return;
      }
      room = fetched as DuelRoom;
    } else {
      room = roomData as DuelRoom;
    }

    dbg("room confirmed", { id: room.id, code: room.code });

    // ── Step 2: Insert duel_players with the fresh ID ──
    const { data: playerData, error: playerErr } = await supabase
      .from("duel_players")
      .insert({ id: freshId, room_id: room.id, name, score: 0 })
      .select("id, room_id, name")
      .single();

    dbg("duel_players insert result", { playerData, playerErr });

    if (playerErr) {
      dbgErr("duel_players insert failed", playerErr, { freshId, room_id: room.id });

      // Best-effort: delete the orphan room
      supabase.from("duel_rooms").delete().eq("id", room.id)
        .then(({ error: delErr }) => {
          if (delErr) dbgErr("orphan room cleanup failed", delErr);
          else dbg("orphan room cleaned up", room!.id);
        });

      if (playerErr.code === "23505") {
        // This should no longer happen with fresh IDs, but handle gracefully
        dbgErr("Unexpected 23505 with fresh ID — retrying with another UUID", playerErr);
        clearDuelSession();
        setErrorMsg("Eski oturum temizlendi, tekrar deneyebilirsin.");
      } else if (playerErr.code === "42501") {
        setErrorMsg("Veritabanı izin hatası. RLS politikalarını kontrol et.");
      } else if (playerErr.message?.toLowerCase().includes("network")) {
        setErrorMsg("Bağlantı hatası. Tekrar dene.");
      } else {
        setErrorMsg("Oda oluşturulamadı. Tekrar dene.");
      }
      setStatusMsg(null); setPhase("lobby"); return;
    }

    // ── Step 3: Fetch player list ──
    const { data: players, error: psErr } = await supabase
      .from("duel_players").select("*").eq("room_id", room.id);
    dbg("duel_players fetch", { players, psErr });

    setRoom(room);
    setPlayers(players ?? []);
    setClaims([]);
    setIsHost(true);
    saveRoomSession(room.id, room.code, freshId);
    activePlayerIdRef.current = freshId;
    setTimeLeft(hostDuration);
    setStatusMsg(null);
    setPhase("waiting");
    dbg("createRoom success ✓", { roomId: room.id, code: room.code, playerId: freshId });
  };

  /* ── JOIN ROOM ── */
  const joinRoom = async () => {
    const name = playerName.trim();
    const code = joinCode.trim().toUpperCase();
    if (!name) { setErrorMsg("İsim yazmalısın."); return; }
    if (!code) { setErrorMsg("Oda kodu yazmalısın."); return; }

    setErrorMsg(null); setStatusMsg("Odaya bağlanılıyor…");

    // Determine player ID: reuse stored one ONLY if it matches this room's session
    const savedSession = loadRoomSession();
    const joinId: string = (savedSession?.roomCode === code && savedSession?.playerId)
      ? savedSession.playerId  // resume same room
      : freshPlayerId();       // new join → fresh ID, clear old session
    if (joinId !== savedSession?.playerId) clearDuelSession();
    myIdRef.current = joinId;

    dbg("joinRoom start", { code, joinId, isResume: joinId === savedSession?.playerId });

    // ── Step 1: Fetch room by code ──
    const { data: r, error: re } = await supabase
      .from("duel_rooms")
      .select("id, code, status, duration_seconds, region, created_at")
      .eq("code", code)
      .single();

    dbg("room fetch", { r, re });

    if (re || !r?.id) {
      dbgErr("room fetch failed", re, { code });
      setErrorMsg("Oda bulunamadı. Kodu kontrol et.");
      setStatusMsg(null); return;
    }
    if (r.status === "finished") {
      setErrorMsg("Bu maç zaten bitti."); setStatusMsg(null); return;
    }
    if (r.status === "playing") {
      setErrorMsg("Maç zaten devam ediyor. Katılamazsın."); setStatusMsg(null); return;
    }

    const room = r as DuelRoom;

    // ── Step 2: Check if already in room ──
    const { data: existing } = await supabase
      .from("duel_players").select("id").eq("room_id", room.id).eq("id", joinId);
    dbg("existing player check", { existing });

    if (!existing?.length) {
      // Check capacity
      const { data: allPs } = await supabase
        .from("duel_players").select("id").eq("room_id", room.id);
      if ((allPs?.length ?? 0) >= 2) {
        setErrorMsg("Oda dolu (2 oyuncu mevcut)."); setStatusMsg(null); return;
      }

      // ── Step 3: Insert player ──
      const { data: playerData, error: pe } = await supabase
        .from("duel_players")
        .insert({ id: joinId, room_id: room.id, name, score: 0 })
        .select("id, room_id, name")
        .single();

      dbg("duel_players insert (join)", { playerData, pe });

      if (pe) {
        dbgErr("duel_players insert failed (join)", pe, { joinId, room_id: room.id });
        if (pe.code === "23505") {
          // joinId already in DB for this room — treat as resume
          dbg("23505 on join: treating as resume for this room");
        } else {
          let msg = "Odaya katılınamadı.";
          if (pe.code === "42501") msg = "Veritabanı izin hatası.";
          else if (pe.message?.toLowerCase().includes("network")) msg = "Bağlantı hatası. Tekrar dene.";
          setErrorMsg(msg); setStatusMsg(null); return;
        }
      }
    } else {
      dbg("already in room (session resume), skipping insert");
    }

    // ── Step 4: Fetch full player list ──
    const { data: ps } = await supabase
      .from("duel_players").select("*").eq("room_id", room.id);
    dbg("player list after join", ps);

    setRoom(room); setPlayers(ps ?? []); setClaims([]); setIsHost(false);
    saveRoomSession(room.id, room.code, joinId);
    activePlayerIdRef.current = joinId;
    setTimeLeft(room.duration_seconds ?? 60);
    setStatusMsg(null); setPhase("waiting");
    dbg("joinRoom success ✓", { roomId: room.id, joinId });
  };

  /* ── START GAME (host only) — sets server-authoritative started_at ── */
  const startGame = async () => {
    if (!room || !isHost) return;
    const startedAt = new Date().toISOString();
    const { error } = await supabase
  .from("duel_rooms")
  .update({
    status: "playing",
    started_at: startedAt,
    finished_reason: null,
    winner_player_id: null,
    forfeited_player_id: null,
    disconnected_player_id: null,
    disconnect_at: null,
  })
  .eq("id", room.id);

if (error) { 
  setErrorMsg("Oyun başlatılamadı."); 
  return; 
}

await supabase
  .from("duel_players")
  .update({ last_seen_at: startedAt })
  .eq("room_id", room.id);
    const { data: cs } = await supabase
      .from("duel_claims").select("*").eq("room_id", room.id);
    setClaims(cs ?? []);
    setPhase("playing");
  };

  /* ── GUESS ── */
  const handleGuess = async () => {
    // ── GUARD: must be playing, have a room, and have time left ──
    if (phaseRef.current !== "playing") return;
    if (gameEndedRef.current) return;
    if (activePlayerIdRef.current) {
  const now = Date.now();

  if (now - lastWriteRef.current > 2000) {
    lastWriteRef.current = now;

    await supabase
      .from("duel_players")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", activePlayerIdRef.current);
  }
}
    if (timeLeftRef.current <= 0) return;
    if (!room || room.status !== "playing") return;

    const norm = normalizeInput(input);
    if (!norm) return;
    const topoId = NAME_TO_TOPOID[norm];
    if (!topoId) {
  showFeedback("err");
  setInput("");
  return;
}

if (allowedIds && !allowedIds.has(topoId)) {
  showFeedback("region");
  setInput("");
  return;
}

if (claims.some(c => c.country_code === topoId)) {
  showFeedback("dup");
  setInput("");
  return;
}

    // Final time check right before the DB insert
    if (timeLeftRef.current <= 0 || gameEndedRef.current) return;

    setInput("");
    const { error } = await supabase.from("duel_claims").insert({
      room_id: room.id, player_id: myId, country_code: topoId,
    });
  if (!error) {
  showFeedback("ok");
  return;
}

if (error.code === "23505") {
  showFeedback("dup");
  setInput("");
  return;
}

showFeedback("err");
setInput("");
return;
  showFeedback("ok");
}
  /* ── COPY INVITE MESSAGE ── */
  const inviteMessage = room
    ? `GeoQuiz'te Online 1v1 ülke kapmaca oynayalım! ⚔️
Mod: ${regionLabel} · Süre: ${durationLabel}
En çok ülke yazan kazanır.
Katılmak için tıkla:
${shareLink}`
    : "";

  const copyInvite = () => {
    const text = inviteMessage || shareLink;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }).catch(() => {
      // Fallback: show the link in a prompt if clipboard unavailable
      window.prompt("Linki kopyala:", shareLink);
    });
  };


  /* ── QUICK MATCH ── */
  // findOrCreateQuickMatchRoom:
  //   1. Search Supabase for waiting rooms with matching settings, oldest first.
  //   2. For each candidate, fetch player count (not using head:true to avoid RLS issues).
  //   3. If count === 1, join that room and start the game.
  //   4. If no suitable room found, create a new one and wait.
  //
  // Region normalization: UI uses "north-america"/"south-america" (with hyphen)
  // but DB stores "north_america"/"south_america" (with underscore) for consistent queries.
  const quickMatch = async () => {
    // When called from result screen, playerName may be empty — fall back to last known name
    const name = playerName.trim() || me?.name || "";
    if (!name) { setErrorMsg("İsim yazmalısın."); return; }

    setErrorMsg(null);
    setStatusMsg("Rakip aranıyor…");
    setPhase("creating");
    setRematch("idle");  // reset rematch state

    // Always generate a fresh player ID for quick match
    clearDuelSession();
    const freshId = freshPlayerId();
    myIdRef.current = freshId;

    // Normalize region for DB consistency
    const dbRegion   = normalizeRegion(hostRegion);
    const dbDuration = hostDuration;

    console.log("[QM] normalizedRegion:", dbRegion, "normalizedDuration:", dbDuration, "freshId:", freshId);

    // ─── Step 1: Find a suitable waiting room ───────────────────────────────
    // Fetch all waiting rooms matching our settings, oldest first.
    // We deliberately select full rows (not head:count) to avoid RLS issues.
    const { data: waitingRooms, error: searchErr } = await supabase
      .from("duel_rooms")
      .select("id, code, status, duration_seconds, region, created_at")
      .eq("status",           "waiting")
      .eq("region",           dbRegion)
      .eq("duration_seconds", dbDuration)
      .order("created_at", { ascending: true })
      .limit(20);

    if (searchErr) {
      console.error("[QM] search error:", searchErr);
    }

    console.log("[QM] waiting rooms found:", waitingRooms?.map(r => r.code) ?? []);

    let targetRoom: DuelRoom | null = null;

    if (waitingRooms && waitingRooms.length > 0) {
      // Check each room's player count
      for (const candidate of waitingRooms) {
        console.log("[QM] checking room:", candidate.code, candidate.id);

        const { data: roomPlayers, error: pErr } = await supabase
          .from("duel_players")
          .select("id")
          .eq("room_id", candidate.id);

        const pCount = roomPlayers?.length ?? 0;
        console.log("[QM] player count for", candidate.code, ":", pCount, pErr ? "(error: " + pErr.message + ")" : "");

        if (pErr) continue; // skip on error

        if (pCount === 1) {
          // Perfect: exactly one player waiting
          targetRoom = candidate as DuelRoom;
          console.log("[QM] selected room:", candidate.code);
          break;
        }
        // pCount === 0 → orphan room (skip)
        // pCount >= 2 → full (skip)
      }
    }

    // ─── Step 2a: JOIN existing room ────────────────────────────────────────
    if (targetRoom) {
      console.log("[QM] joining existing room:", targetRoom.code);

      // Final race-condition guard: re-check count right before inserting
      const { data: preCheckPs } = await supabase
        .from("duel_players")
        .select("id")
        .eq("room_id", targetRoom.id);

      const preCount = preCheckPs?.length ?? 0;
      console.log("[QM] pre-insert player count:", preCount);

      if (preCount !== 1) {
        // Room was taken between our search and now — fall through to create
        console.log("[QM] race condition: room taken, will create new one");
        targetRoom = null;
      }
    }

    if (targetRoom) {
      const { error: joinErr } = await supabase
        .from("duel_players")
        .insert({ id: freshId, room_id: targetRoom.id, name, score: 0 });

      if (joinErr && joinErr.code !== "23505") {
        console.error("[QM] join insert failed:", joinErr);
        // Fall through to create
        targetRoom = null;
      }
    }

    if (targetRoom) {
      // Verify we have exactly 2 players after insert
      const { data: afterPs } = await supabase
        .from("duel_players")
        .select("*")
        .eq("room_id", targetRoom.id);

      const afterCount = afterPs?.length ?? 0;
      console.log("[QM] post-insert player count:", afterCount);

      if (afterCount < 2) {
        // Something went wrong — roll back and create our own room
        console.log("[QM] unexpected count after insert, rolling back");
        await supabase.from("duel_players")
          .delete().eq("id", freshId).eq("room_id", targetRoom.id);
        targetRoom = null;
      } else {
        // ── We're player 2 — trigger game start with server-authoritative time ──
        const startedAt = new Date().toISOString();
        const { error: startErr } = await supabase
          .from("duel_rooms")
          .update({ status: "playing", started_at: startedAt })
          .eq("id", targetRoom.id);

        console.log("[QM] status updated to playing:", startErr ? startErr.message : "ok", "started_at:", startedAt);

        const { data: cs } = await supabase
          .from("duel_claims").select("*").eq("room_id", targetRoom.id);

        // Merge started_at into room object so local timer fires immediately
        const playingRoom: DuelRoom = { ...(targetRoom as DuelRoom), status: "playing", started_at: startedAt };
        saveRoomSession(playingRoom.id, playingRoom.code, freshId);
        setRoom(playingRoom);
        setPlayers(afterPs ?? []);
        setClaims(cs ?? []);
        setIsHost(false);
        setIsQuickMatch(true);
        setTimeLeft(playingRoom.duration_seconds);
        setStatusMsg(null);
        setPhase("playing");
        console.log("[QM] joined + started ✓", playingRoom.code, "started_at:", startedAt);
        return;
      }
    }

    // ─── Step 2b: CREATE new room and wait ──────────────────────────────────
    console.log("[QM] creating new room (no suitable room found)");
    const code = makeCode();
    const { data: roomData, error: roomErr } = await supabase
      .from("duel_rooms")
      .insert({ code, status: "waiting", duration_seconds: dbDuration, region: dbRegion })
      .select("id, code, status, duration_seconds, region, created_at")
      .single();

    let newRoom: DuelRoom | null = null;
    if (roomErr || !roomData?.id) {
      // Fallback fetch in case insert succeeded but select failed
      const { data: fetched } = await supabase
        .from("duel_rooms")
        .select("id, code, status, duration_seconds, region, created_at")
        .eq("code", code).single();
      if (!fetched?.id) {
        console.error("[QM] failed to create room:", roomErr);
        setErrorMsg("Eşleşme oluşturulamadı. Tekrar dene.");
        setStatusMsg(null); setPhase("lobby"); return;
      }
      newRoom = fetched as DuelRoom;
    } else {
      newRoom = roomData as DuelRoom;
    }

    const { error: pErr } = await supabase
      .from("duel_players")
      .insert({ id: freshId, room_id: newRoom.id, name, score: 0 });

    if (pErr) {
      console.error("[QM] player insert failed:", pErr);
      await supabase.from("duel_rooms").delete().eq("id", newRoom.id);
      setErrorMsg("Eşleşme oluşturulamadı. Tekrar dene.");
      setStatusMsg(null); setPhase("lobby"); return;
    }

    const { data: initPs } = await supabase
      .from("duel_players").select("*").eq("room_id", newRoom.id);

    saveRoomSession(newRoom.id, newRoom.code, freshId);
    setRoom(newRoom);
    setPlayers(initPs ?? []);
    setClaims([]);
    setIsHost(true);
    setIsQuickMatch(true);
    setTimeLeft(dbDuration);
    setStatusMsg(null);
    setPhase("waiting");
    console.log("[QM] created new room, waiting for opponent:", newRoom.code);
  };

    /* ── CANCEL QUICK MATCH ── */
  const cancelQuickMatch = async () => {
    if (room) {
      // Remove player from room
      await supabase.from("duel_players").delete().eq("id", myIdRef.current).eq("room_id", room.id);
      // If we were the only player, delete the room too
      const { data: remaining } = await supabase
        .from("duel_players").select("id").eq("room_id", room.id);
      if (!remaining?.length) {
        await supabase.from("duel_rooms").delete().eq("id", room.id);
      }
      dbg("cancelQuickMatch: cleaned up room", room.id);
    }
    setIsQuickMatch(false);
    backToLobby();
  };

    /* ── FORFEIT ──
   *  The forfeiting player ALWAYS loses, regardless of score.
   *  Strategy:
   *   1. Snapshot room/players refs (closures)
   *   2. Stop timer immediately
   *   3. Write authoritative finish to DB — rakip realtime alır, "Kazandın" görür
   *   4. THEN navigate — so we don't lose room ref before the DB write
   */
  const forfeit = useCallback(async (thenNavigate: "lobby" | "home") => {
    // Snapshot before any state mutations
    const snapshotRoom    = room;
    const snapshotPlayers = players;
    const myId = myIdRef.current;

    gameEndedRef.current = true;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    if (snapshotRoom) {
      const winnerId = snapshotPlayers.find(p => p.id !== myId)?.id ?? null;
      const updates = {
        status:              "finished"  as const,
        finished_reason:     "forfeit"   as const,
        forfeited_player_id: myId,
        winner_player_id:    winnerId,
      };
      // Optimistic local update — result screen shows correct result immediately
      setRoom({ ...snapshotRoom, ...updates });
      // DB write — triggers realtime on opponent
      await supabase.from("duel_rooms").update(updates).eq("id", snapshotRoom.id);
      dbg("forfeit: written", { forfeitedBy: myId, winnerId, room: snapshotRoom.id });
    }

    clearDuelSession();
    setQuitModal(false);
    setQuitStep("idle");

    if (thenNavigate === "home") {
      setRoom(null); setPlayers([]); setClaims([]);
      setIsQuickMatch(false); setShowLabels(false); setRematch("idle");
      setPhase("lobby"); setErrorMsg(null); setStatusMsg(null);
      myIdRef.current = "";
      onHome();
    } else {
      // Stay on result screen — room state already has updated forfeit fields
      setPhase("finished");
    }
  }, [room, players, onHome]);

  /* ── BACK TO LOBBY ── */
  const backToLobby = () => {
    if (disconnectTimerRef.current)   { clearTimeout(disconnectTimerRef.current);   disconnectTimerRef.current   = null; }
    if (disconnectIntervalRef.current){ clearInterval(disconnectIntervalRef.current); disconnectIntervalRef.current = null; }
    if (heartbeatRef.current)         { clearInterval(heartbeatRef.current);         heartbeatRef.current         = null; }
    if (oppMonitorRef.current)        { clearInterval(oppMonitorRef.current);         oppMonitorRef.current        = null; }
    setOppDisconnected(false);
    setDisconnectCountdown(0);
    clearDuelSession();
    myIdRef.current = "";
    setRoom(null); setPlayers([]); setClaims([]);
    setIsQuickMatch(false); setRematch("idle"); setFinalScores(null);
    gameEndedRef.current = false; startTimeRef.current = null;
    setQuitModal(false); setQuitStep("idle");
    setPhase("lobby"); setErrorMsg(null); setStatusMsg(null);
  };

  /* ── joinRematchRoom — requester follows rematch_room_id pointer ── */
  const joinRematchRoom = useCallback(async (newRoomId: string) => {
    const oldName = me?.name ?? playerName;
    clearDuelSession();
    const freshId = freshPlayerId();
    myIdRef.current = freshId;

    const { data: newRoomData } = await supabase
      .from("duel_rooms").select("*").eq("id", newRoomId).single();
    if (!newRoomData?.id) {
      dbgErr("joinRematchRoom: new room not found");
      return;
    }
    const newRoom = newRoomData as DuelRoom;

    // Add ourselves to new room
    await supabase.from("duel_players")
      .insert({ id: freshId, room_id: newRoom.id, name: oldName, score: 0 });

    // We're the joiner (player 2) — start the match with server-auth time
    const startedAt = new Date().toISOString();
    await supabase.from("duel_rooms")
      .update({ status: "playing", started_at: startedAt })
      .eq("id", newRoom.id);

    const { data: ps } = await supabase
      .from("duel_players").select("*").eq("room_id", newRoom.id);

    const updatedRoom: DuelRoom = { ...newRoom, status: "playing", started_at: startedAt };
    saveRoomSession(updatedRoom.id, updatedRoom.code, freshId);
    setRoom(updatedRoom);
    setPlayers(ps ?? []);
    setClaims([]);
    setIsHost(false);
    setRematch("idle");
    gameEndedRef.current = false;
    setTimeLeft(updatedRoom.duration_seconds);
    setPhase("playing");
    dbg("joinRematchRoom: switched + started ✓", updatedRoom.code);
  }, [me, playerName]);

  /* ── REMATCH (via Realtime broadcast on the finished room's channel) ── */
  const requestRematch = useCallback(() => {
    if (!room) return;
    setRematch("requested");
    // Reuse the existing realtime channel — broadcast a lightweight signal
    const chan = supabase.channel(`duel:${room.id}`);
    chan.send({ type: "broadcast", event: "rematch_request", payload: { from: myIdRef.current } });
    dbg("rematch: request sent", room.id);
  }, [room]);

  const acceptRematch = useCallback(async () => {
    if (!room) return;
    const oldRoomId  = room.id;
    const oldName    = me?.name ?? playerName;
    const dbRegion   = normalizeRegion(room.region);
    const dbDuration = room.duration_seconds;
    setRematch("idle");

    // Fresh player id
    clearDuelSession();
    const freshId = freshPlayerId();
    myIdRef.current = freshId;

    // Create new room with status "waiting_rematch" (won't be picked by Quick Match)
    const code = makeCode();
    const { data: roomData, error: roomErr } = await supabase
      .from("duel_rooms")
      .insert({
        code,
        status: "waiting_rematch",
        duration_seconds: dbDuration,
        region: dbRegion,
      })
      .select("*").single();

    if (roomErr || !roomData?.id) {
      dbgErr("acceptRematch: room create failed", roomErr);
      setErrorMsg("Rövanş odası açılamadı.");
      return;
    }
    const newRoom = roomData as DuelRoom;

    // Add ourselves
    const { error: pErr } = await supabase
      .from("duel_players")
      .insert({ id: freshId, room_id: newRoom.id, name: oldName, score: 0 });
    if (pErr) {
      dbgErr("acceptRematch: player insert failed", pErr);
      await supabase.from("duel_rooms").delete().eq("id", newRoom.id);
      setErrorMsg("Rövanş odası açılamadı.");
      return;
    }

    // Write rematch_room_id pointer on OLD room → requester sees this via realtime
    await supabase.from("duel_rooms")
      .update({ rematch_room_id: newRoom.id })
      .eq("id", oldRoomId);
    dbg("acceptRematch: pointer written", { oldRoomId, newRoomId: newRoom.id });

    // Switch local state to new room
    const { data: ps } = await supabase
      .from("duel_players").select("*").eq("room_id", newRoom.id);
    saveRoomSession(newRoom.id, newRoom.code, freshId);
    setRoom(newRoom);
    setPlayers(ps ?? []);
    setClaims([]);
    setIsHost(true);  // Accepter = host of new room
    gameEndedRef.current = false;
    setTimeLeft(dbDuration);
    setPhase("waiting");
    dbg("acceptRematch: switched to new room", newRoom.code);
  }, [room, me, playerName]);

  const declineRematch = useCallback(() => {
    if (!room) return;
    const chan = supabase.channel(`duel:${room.id}`);
    chan.send({ type: "broadcast", event: "rematch_declined", payload: {} });
    setRematch("idle");
    dbg("rematch: declined");
  }, [room]);

  /* ─────────────────────────────────────────
     RENDER
  ───────────────────────────────────────── */
  /**
   * Result resolution priority (server-authoritative):
   *   1. finished_reason === "forfeit"  → forfeitedBy = loser, winner_player_id = winner
   *   2. winner_player_id present       → that player wins (timeout)
   *   3. winner_player_id null + timeout → draw
   *   4. Legacy fallback                 → score-based
   */
  const resolveResult = (): { emoji: string; title: string; subtitle: string | null } => {
    if (phase !== "finished" || !room) return { emoji: "", title: "", subtitle: null };
    const myId = myIdRef.current;
    const winnerId  = room.winner_player_id;
    const reason    = room.finished_reason;
    const forfeitId = room.forfeited_player_id;

    if (reason === "forfeit") {
      if (forfeitId === myId) return {
        emoji: "🏳️",
        title: "Kaybettin",
        subtitle: "Pes ettin — rakip kazandı.",
      };
      if (winnerId === myId) return {
        emoji: "🏆",
        title: "Kazandın!",
        subtitle: "Rakip pes etti.",
      };
      return { emoji: "🏳️", title: "Maç Bitti", subtitle: "Pes edildi." };
    }

    if (reason === "disconnect") {
      if (winnerId === myId) return {
        emoji: "🏆",
        title: "Kazandın!",
        subtitle: "Rakip bağlantısını kaybetti ve geri dönmedi.",
      };
      return {
        emoji: "📡",
        title: "Bağlantı Kesildi",
        subtitle: "Bağlantın kesildi ve süre doldu.",
      };
    }

    if (winnerId) {
      return winnerId === myId
        ? { emoji: "🏆", title: "Kazandın!", subtitle: null }
        : { emoji: "😔", title: "Kaybettin", subtitle: null };
    }

    if (reason === "timeout") {
      return { emoji: "🤝", title: "Berabere", subtitle: "Eşit skor." };
    }

    // Legacy fallback for old rows without DB fields
    if (myScore > oppScore) return { emoji: "🏆", title: "Kazandın!", subtitle: null };
    if (myScore < oppScore) return { emoji: "😔", title: "Kaybettin", subtitle: null };
    return { emoji: "🤝", title: "Berabere", subtitle: null };
  };
  const result = resolveResult();

  return (
    <div className={"app duel-screen" + (phase === "playing" ? " duel-game-active" : "")}>

      {/* ── HEADER ── */}
      <div className="duel-header">
        <button className="back-btn" onClick={onHome}>
          <span>←</span><span className="back-label">Menü</span>
        </button>
        <div className="duel-header-center">
          <span className="duel-mode-label">⚔️ Online 1v1</span>
          {room && phase !== "lobby" && (
            <>
              <span className="duel-code-badge">#{room.code}</span>
              {phase !== "finished" && (
                <span className="duel-region-badge">{regionLabel}</span>
              )}
            </>
          )}
        </div>
        {/* Version badge — helps identify which deploy is running */}
        <span className="duel-version-badge">{DUEL_VERSION}</span>
        {phase === "playing" ? (
          <div className="timer-ring-wrap" style={{ width: 44, height: 44 }}>
            <svg viewBox="0 0 42 42" className="timer-svg">
              <circle cx="21" cy="21" r="17" fill="none" stroke="var(--border)" strokeWidth="3"/>
              <circle cx="21" cy="21" r="17" fill="none"
                stroke={timerColor} strokeWidth="3" strokeDasharray="106.8"
                strokeDashoffset={106.8 - (timerPct / 100) * 106.8}
                strokeLinecap="round"
                style={{ transform:"rotate(-90deg)", transformOrigin:"50% 50%", transition:"stroke-dashoffset 0.9s linear" }}/>
            </svg>
            <span className="timer-num" style={{ color: timerColor }}>{timeLeft}</span>
          </div>
        ) : (
          <div style={{ width: 44 }}/>
        )}
      </div>

      {/* ════════ LOBBY ════════ */}
      {(phase === "lobby" || phase === "creating") && (
        <div className="duel-lobby">
          <div className="duel-lobby-card">
            <h2 className="duel-lobby-title">⚔️ Online 1v1</h2>
            <p className="duel-lobby-desc">
              Arkadaşınla gerçek zamanlı ülke kapmaca oyna.<br/>
              Daha çok ülke yazan kazanır!
            </p>

            {/* Player name */}
            <div className="duel-field-row">
              <label className="duel-field-label">Oyuncu Adın</label>
              <input
                className="duel-name-input"
                type="text"
                placeholder="Adını gir…"
                value={playerName}
                onChange={e => setPlayerName(e.target.value)}
                maxLength={20}
                autoComplete="off"
                onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
              />
            </div>

            {/* HOST settings block — dropdown version */}
            <div className="duel-settings-block">
              <p className="duel-settings-title">🏠 Oda Kur</p>

              <div className="duel-selects-row">
                {/* Duration select */}
                <div className="duel-select-wrap">
                  <label className="duel-select-label">Süre</label>
                  <div className="duel-select-box">
                    <select
                      className="duel-select"
                      value={hostDuration}
                      onChange={e => setHostDuration(Number(e.target.value))}
                    >
                      {DURATION_OPTS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <span className="duel-select-caret">▾</span>
                  </div>
                </div>

                {/* Region select */}
                <div className="duel-select-wrap">
                  <label className="duel-select-label">Bölge</label>
                  <div className="duel-select-box">
                    <select
                      className="duel-select"
                      value={hostRegion}
                      onChange={e => setHostRegion(e.target.value)}
                    >
                      {REGION_OPTS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <span className="duel-select-caret">▾</span>
                  </div>
                </div>
              </div>

              <button
                className="btn btn-accent duel-create-btn"
                onClick={createRoom}
                disabled={phase === "creating"}
              >
                {phase === "creating" ? "Kuruluyor…" : "🏠 Oda Kur"}
              </button>
            </div>

            {/* Divider */}
            <div className="duel-section-divider">veya mevcut bir odaya katıl</div>

            {/* JOIN block */}
            <div className="duel-join-block">
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
            </div>

            {/* Quick Match */}
            <div className="duel-section-divider">veya hızlı eşleş</div>
            <button
              className="btn duel-quickmatch-btn"
              onClick={quickMatch}
              disabled={phase === "creating"}
            >
              {phase === "creating" && statusMsg?.includes("Rakip")
                ? <><span className="qm-spinner"/>Rakip aranıyor…</>
                : <>⚡ Hızlı Eşleş</>}
            </button>

            {errorMsg  && <p className="duel-error">{errorMsg}</p>}
            {statusMsg && !statusMsg.includes("Rakip") && <p className="duel-status">{statusMsg}</p>}
          </div>
        </div>
      )}

      {/* ════════ WAITING ════════ */}
      {phase === "waiting" && room && (
        <div className="duel-lobby">
            <div className="duel-lobby-with-chat">
            <div className="duel-lobby-card">
            {isQuickMatch ? (
              /* ── Quick match waiting UI ── */
              <div className="qm-waiting">
                <div className="qm-spinner-lg"/>
                <h2 className="duel-lobby-title">Rakip Aranıyor…</h2>
                <p className="duel-lobby-desc">Uygun bir rakip bulunduğunda otomatik başlayacak.</p>
                <div className="duel-settings-summary">
                  <span>⏱ {durationLabel}</span>
                  <span className="duel-sum-dot">·</span>
                  <span>{regionLabel}</span>
                </div>
                <button className="btn btn-ghost" onClick={cancelQuickMatch}>✕ İptal</button>
              </div>
            ) : (
              <>
                <h2 className="duel-lobby-title">Rakip Bekleniyor…</h2>

                {/* Big room code */}
                <div className="duel-room-code-block">
                  <span className="duel-room-code">{room.code}</span>
                  <p className="duel-room-code-hint">6 haneli kod — arkadaşına ver</p>
                </div>

                {/* Invite — copy full message button */}
                <button
                  className={"btn duel-invite-btn" + (copied ? " invited" : "")}
                  onClick={copyInvite}
                >
                  {copied
                    ? "✓ Davet mesajı kopyalandı!"
                    : "📋 Davet Mesajını Kopyala"}
                </button>
                {/* Link preview (read-only, tap to select) */}
                <div className="duel-link-preview" onClick={e => {
                  const el = e.currentTarget.querySelector("input") as HTMLInputElement | null;
                  el?.select();
                }}>
                  <input
                    className="duel-link-input"
                    readOnly
                    value={shareLink}
                    onFocus={e => e.target.select()}
                  />
                </div>

                {/* Settings summary */}
                <div className="duel-settings-summary">
                  <span>⏱ {durationLabel}</span>
                  <span className="duel-sum-dot">·</span>
                  <span>{regionLabel}</span>
                </div>

                {/* Players */}
                <div className="duel-players-list">
                  {players.map(p => (
                    <div
                      key={p.id}
                      className={"duel-player-chip" + (p.id === myId ? " mine" : "")}
                    >
                      <span className="duel-player-dot"/>
                      <span className="duel-player-name">{p.name}</span>
                      <div className="duel-player-tags">
                        {p.id === myId && <span className="duel-tag">Sen</span>}
                        {players[0]?.id === p.id && <span className="duel-tag host">👑</span>}
                      </div>
                    </div>
                  ))}
                  {players.length < 2 && (
                    <div className="duel-player-chip waiting">
                      <span className="duel-player-dot waiting"/>
                      <span>Rakip bekleniyor…</span>
                    </div>
                  )}
                </div>

                {isHost ? (
                  players.length >= 2
                    ? <button className="btn btn-accent duel-start-btn" onClick={startGame}>🚀 Oyunu Başlat</button>
                    : <p className="duel-waiting-msg">Rakip katılmayı bekliyoruz…</p>
                ) : (
                  <p className="duel-waiting-msg">Ev sahibi oyunu başlatacak…</p>
                )}

                {errorMsg && <p className="duel-error">{errorMsg}</p>}

                <button className="btn btn-ghost btn-sm" onClick={backToLobby}>
                  ← Lobiye Dön
                </button>
              </>
            )}
          </div>
          {!isQuickMatch && (
            <LobbyChat roomCode={room.code} playerName={playerName} />
          )}
          </div>
        </div>
      )}

      {/* ════════ PLAYING ════════ */}
      {phase === "playing" && (
        <>
          {/* Score bar — with quit button and label toggle */}
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
            {/* Label toggle */}
            <label className="duel-label-toggle" title="Ülke isimlerini göster">
              <input
                type="checkbox"
                checked={showLabels}
                onChange={e => setShowLabels(e.target.checked)}
                className="toggle-cb"
              />
              <span className="toggle-track"><span className="toggle-thumb"/></span>
              <span className="duel-toggle-text">İsimler</span>
            </label>
            {/* Quit button */}
            <button
              className="duel-quit-btn"
              onClick={() => { setQuitModal(true); setQuitStep("idle"); }}
              title="Oyundan Çık (ESC)"
            >
              ✕ Çık
            </button>
          </div>

          {/* Opponent disconnect grace banner */}
          {oppDisconnected && (
            <div className="duel-disconnect-banner">
              📡 Rakibiniz bağlantısını kaybetti.{" "}
              {disconnectCountdown > 0
                ? <><strong>{disconnectCountdown} saniye</strong> içinde dönmezse kazanacaksınız.</>
                : "Kazandınız!"}
            </div>
          )}

          {/* Map */}
          <div className="map-area">
            <DuelMapView
              myTopoIds={myTopoIds}
              oppTopoIds={oppTopoIds}
              showLabels={showLabels}
              region={denormalizeRegion(gameRegion)}
              activeIds={allowedIds ?? undefined}
            />
          </div>

          {/* Input */}
          <div className="duel-input-bar">
            <input
              ref={inputRef}
              type="text"
              className={inputCls}
              disabled={gameOver}
              placeholder={gameOver
                ? "Süre bitti"
                : allowedIds
                  ? `${regionLabel} ülkesi yaz… (Enter)`
                  : "Ülke adı yaz… (Enter)"}
              value={gameOver ? "" : input}
              onChange={e => { if (!gameOver) setInput(e.target.value); }}
              onKeyDown={e => { if (e.key === "Enter" && !gameOver) handleGuess(); }}
              autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
            />
            <button className="btn btn-accent" onClick={handleGuess} disabled={gameOver}>Gir</button>
            <div className="duel-fb-slot">
              {feedback === "ok"     && <span className="fb fb-ok">✓ Alındı!</span>}
              {feedback === "err"    && <span className="fb fb-no">✗ Bulunamadı</span>}
              {feedback === "dup"    && <span className="fb fb-dup">Zaten alındı</span>}
              {feedback === "region" && <span className="fb fb-no">⚠ Bu bölge dışı</span>}
            </div>
          </div>

          {/* ── Quit modal ── */}
          {quitModal && (
            <div className="duel-quit-backdrop"
              onClick={() => { setQuitModal(false); setQuitStep("idle"); }}>
              <div className="duel-quit-modal" onClick={e => e.stopPropagation()}>

                {quitStep === "idle" && (
                  <>
                    <h3 className="duel-quit-title">Maçtan çıkmak istiyor musun?</h3>
                    <p className="duel-quit-sub">Çıkış yapan oyuncu kaybetmiş sayılır.</p>
                    <div className="duel-quit-actions">
                      <button className="btn duel-quit-action forfeit"
                        onClick={() => setQuitStep("forfeit")}>
                        🏳️ Pes Et
                      </button>
                      <button className="btn duel-quit-action menu"
                        onClick={() => setQuitStep("menu")}>
                        🏠 Ana Menüye Dön
                      </button>
                      <button className="btn duel-quit-action cancel"
                        onClick={() => { setQuitModal(false); setQuitStep("idle"); }}>
                        ↩ İptal
                      </button>
                    </div>
                  </>
                )}

                {quitStep === "forfeit" && (
                  <>
                    <h3 className="duel-quit-title">Pes etmek istediğine emin misin?</h3>
                    <p className="duel-quit-sub">Bu maçı kaybetmiş sayılacaksın.</p>
                    <div className="duel-quit-actions">
                      <button className="btn duel-quit-action forfeit"
                        onClick={() => forfeit("lobby")}>
                        🏳️ Evet, Pes Et
                      </button>
                      <button className="btn duel-quit-action cancel"
                        onClick={() => setQuitStep("idle")}>
                        ↩ Vazgeç
                      </button>
                    </div>
                  </>
                )}

                {quitStep === "menu" && (
                  <>
                    <h3 className="duel-quit-title">Ana Menüye Dön?</h3>
                    <p className="duel-quit-sub">
                      Maç devam ediyor. Ana menüye dönersen kaybetmiş sayılacaksın.
                    </p>
                    <div className="duel-quit-actions">
                      <button className="btn duel-quit-action forfeit"
                        onClick={() => forfeit("home")}>
                        ✓ Evet, çık
                      </button>
                      <button className="btn duel-quit-action cancel"
                        onClick={() => setQuitStep("idle")}>
                        ↩ Geri
                      </button>
                    </div>
                  </>
                )}

              </div>
            </div>
          )}
        </>
      )}

      {/* ════════ FINISHED ════════ */}
      {phase === "finished" && (
        <div className="duel-lobby">
          <div className="duel-lobby-card">
            <div className="duel-result-emoji">{result.emoji}</div>
            <h2 className="duel-result-title">{result.title}</h2>
            {result.subtitle && (
              <p className="duel-result-subtitle">{result.subtitle}</p>
            )}

            {/* Scores */}
            <div className="duel-result-scores">
              <div className="duel-result-col mine">
                <span className="duel-result-name">{me?.name ?? "Ben"}</span>
                <span className="duel-result-num">
                  {finalScores?.my ?? myScore}
                </span>
                <span className="duel-result-sub">ülke</span>
              </div>
              <span className="duel-result-vs">—</span>
              <div className="duel-result-col opp">
                <span className="duel-result-num">
                  {finalScores?.opp ?? oppScore}
                </span>
                <span className="duel-result-name">{opp?.name ?? "Rakip"}</span>
                <span className="duel-result-sub">ülke</span>
              </div>
            </div>

            {/* Meta */}
            <div className="duel-result-meta">
              <span>⏱ {durationLabel}</span>
              <span className="duel-sum-dot">·</span>
              <span>{regionLabel}</span>
              <span className="duel-sum-dot">·</span>
              <span>Toplam {claims.length} ülke</span>
            </div>

            {errorMsg && <p className="duel-error">{errorMsg}</p>}

            {/* ── Rematch section ── */}
            <div className="duel-rematch-area">
              {rematch === "idle" && opp && (
                <button className="btn duel-rematch-btn" onClick={requestRematch}>
                  ⚔️ Rövanş İste
                </button>
              )}
              {rematch === "requested" && (
                <p className="duel-rematch-status waiting">
                  ⏳ Rövanş isteği gönderildi, rakip bekleniyor…
                </p>
              )}
              {rematch === "received" && (
                <div className="duel-rematch-incoming">
                  <p className="duel-rematch-status">⚔️ Rakibin rövanş istiyor!</p>
                  <div className="duel-rematch-btns">
                    <button className="btn btn-accent btn-sm" onClick={acceptRematch}>Kabul Et</button>
                    <button className="btn btn-ghost  btn-sm" onClick={declineRematch}>Reddet</button>
                  </div>
                </div>
              )}
              {rematch === "declined" && (
                <p className="duel-rematch-status declined">😞 Rakip rövanşı reddetti.</p>
              )}
            </div>

            {/* ── Actions ── */}
            <div className="duel-result-actions">
              <button className="btn btn-accent" onClick={quickMatch}>
                ⚡ Hızlı Eşleş
              </button>
              <button className="btn btn-ghost" onClick={onHome}>
                ⌂ Ana Menü
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
