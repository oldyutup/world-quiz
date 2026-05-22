/**
 * DuelGroupGame.tsx — Online Çok Oyunculu Mod (Ülke Yaz, 3–10 kişi)
 *
 * Bu dosya mevcut 1v1 DuelGame.tsx'e DOKUNMAZ. Tamamen ayrı bir component
 * ve ayrı Supabase tabloları (duel_group_rooms / duel_group_players /
 * duel_group_claims) kullanır.
 *
 * ─────────────────────────────────────────────────────────────────
 * ⚠️  Supabase setup (gerekli SQL — bir defa çalıştır):
 *
 *   CREATE TABLE IF NOT EXISTS duel_group_rooms (
 *     id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 *     code              text UNIQUE NOT NULL,
 *     status            text NOT NULL DEFAULT 'waiting',
 *                       -- 'waiting' | 'playing' | 'finished'
 *     duration_seconds  int  NOT NULL DEFAULT 60,
 *     region            text NOT NULL DEFAULT 'world',
 *     max_players       int  NOT NULL DEFAULT 10,
 *     started_at        timestamptz,
 *     created_at        timestamptz NOT NULL DEFAULT now(),
 *     updated_at        timestamptz NOT NULL DEFAULT now()
 *   );
 *
 *   CREATE TABLE IF NOT EXISTS duel_group_players (
 *     id            uuid PRIMARY KEY,
 *     room_id       uuid NOT NULL REFERENCES duel_group_rooms(id) ON DELETE CASCADE,
 *     name          text NOT NULL,
 *     is_host       boolean NOT NULL DEFAULT false,
 *     joined_at     timestamptz NOT NULL DEFAULT now(),
 *     last_seen_at  timestamptz NOT NULL DEFAULT now()
 *   );
 *   CREATE INDEX IF NOT EXISTS duel_group_players_room_idx ON duel_group_players(room_id);
 *
 *   CREATE TABLE IF NOT EXISTS duel_group_claims (
 *     id            bigserial PRIMARY KEY,
 *     room_id       uuid NOT NULL REFERENCES duel_group_rooms(id) ON DELETE CASCADE,
 *     player_id     uuid NOT NULL,
 *     country_code  text NOT NULL,
 *     created_at    timestamptz NOT NULL DEFAULT now(),
 *     UNIQUE (room_id, country_code)   -- aynı ülkeyi sadece ilk yazan alır
 *   );
 *   CREATE INDEX IF NOT EXISTS duel_group_claims_room_idx ON duel_group_claims(room_id);
 *
 *   ALTER TABLE duel_group_rooms   ENABLE ROW LEVEL SECURITY;
 *   ALTER TABLE duel_group_players ENABLE ROW LEVEL SECURITY;
 *   ALTER TABLE duel_group_claims  ENABLE ROW LEVEL SECURITY;
 *
 *   CREATE POLICY "anon_all_group_rooms"   ON duel_group_rooms   FOR ALL TO anon USING (true) WITH CHECK (true);
 *   CREATE POLICY "anon_all_group_players" ON duel_group_players FOR ALL TO anon USING (true) WITH CHECK (true);
 *   CREATE POLICY "anon_all_group_claims"  ON duel_group_claims  FOR ALL TO anon USING (true) WITH CHECK (true);
 *
 *   -- Auth oturumu olan kullanıcılar (Supabase Auth) authenticated rolüyle
 *   -- istek gönderir. Yukarıdaki politikalar sadece anon'a izin verdiği için
 *   -- logged-in host'un startGame DELETE'i sessizce 0 satır siliyor ve eski
 *   -- maç claim'leri rövanşta UNIQUE(room_id, country_code)'i tetikliyor.
 *   -- Aşağıdaki ek politika 20260522120000_duel_group_claims_auth_policy.sql
 *   -- migration'ı ile uygulanır:
 *   CREATE POLICY "duel_group_claims_all_authenticated"
 *     ON duel_group_claims FOR ALL TO authenticated
 *     USING (true) WITH CHECK (true);
 *
 *   -- Realtime'ı her üç tabloda etkinleştir.
 *   ALTER PUBLICATION supabase_realtime ADD TABLE duel_group_rooms;
 *   ALTER PUBLICATION supabase_realtime ADD TABLE duel_group_players;
 *   ALTER PUBLICATION supabase_realtime ADD TABLE duel_group_claims;
 * ─────────────────────────────────────────────────────────────────
 */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { supabase } from "../lib/supabase";
import { DuelMapView } from "./WorldMap";
import LobbyChat from "./LobbyChat";
import {
  playSound,
  stopSound,
  shouldPlayCountdownSound,
  type CountdownSoundMode,
} from "../lib/sound";
import { NAME_TO_TOPOID, normalizeInput, getContinentIds, type Continent } from "../data/countries";
import { validateUsername, type Profile } from "../lib/auth";
import { readStoredHomeTheme, getThemeBackgroundStyle, getThemeDataAttr } from "../lib/themeBackgrounds";

/* ─── Lokal type'lar (lib/supabase.ts'i kirletmemek için) ─── */
interface GroupRoom {
  id:               string;
  code:             string;
  status:           "waiting" | "playing" | "finished";
  duration_seconds: number;
  region:           string;
  max_players:      number;
  started_at:       string | null;
  created_at:       string;
  updated_at:       string;
}
interface GroupPlayer {
  id:           string;
  room_id:      string;
  name:         string;
  is_host:      boolean;
  joined_at:    string;
  last_seen_at: string;
  status: "waiting" | "playing" | "finished";
}
interface GroupClaim {
  id:           number;
  room_id:      string;
  player_id:    string;
  country_code: string;
  created_at:   string;
}

/* ─── Sabitler ─── */
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;

const DURATION_OPTS = [
  { label: "1 dk",  value: 60  },
  { label: "2 dk",  value: 120 },
  { label: "3 dk",  value: 180 },
  { label: "5 dk",  value: 300 },
  { label: "10 dk", value: 600 },
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

/** DB'de kullanılacak normalize edilmiş region değeri (1v1 ile aynı kuralla) */
const normalizeRegion = (r: string): string => {
  const map: Record<string, string> = {
    "north-america": "north_america",
    "south-america": "south_america",
  };
  return map[r] ?? r;
};
const denormalizeRegion = (r: string): string => {
  const map: Record<string, string> = {
    "north_america": "north-america",
    "south_america": "south-america",
  };
  return map[r] ?? r;
};

/* ─── localStorage helpers (1v1'inkinden ayrı namespace) ─── */
const PLAYER_ID_KEY = "geoquiz_group_player_id";
const ROOM_KEY      = "geoquiz_group_room";

function makeCode() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

function dbg(label: string, obj?: unknown) {
  console.log(`[DuelGroupGame] ${label}`, obj ?? "");
}
function dbgErr(label: string, err?: unknown, ctx?: unknown) {
  console.error(`[DuelGroupGame] ❌ ${label}`, err, ctx ?? "");
}

function freshPlayerId(): string {
  const id = crypto.randomUUID();
  localStorage.setItem(PLAYER_ID_KEY, id);
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
    if (!parsed?.roomId || !parsed?.roomCode || !parsed?.playerId) return null;
    return parsed as RoomSession;
  } catch { return null; }
}
function clearGroupSession() {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("geoquiz_group")) keys.push(k);
  }
  keys.forEach(k => localStorage.removeItem(k));
}

function buildAllowedSet(region: string): Set<string> | null {
  if (region === "world") return null;
  const key = denormalizeRegion(region);
  return getContinentIds(key as Continent);
}

type Phase = "lobby" | "creating" | "waiting" | "playing" | "finished";

interface Props {
  onHome: () => void;
  profile?: Profile | null;
  countdownSoundMode?: CountdownSoundMode;
}

export default function DuelGroupGame({
  onHome,
  profile,
  countdownSoundMode = "last20",
}: Props) {
  /* identity */
  const myIdRef = useRef<string>("");
  const myId = myIdRef.current;

  /* lobby form */
  const [playerName,   setPlayerName]   = useState("");
  const loggedInUsername = profile?.username ?? "";
  const effectivePlayerName = loggedInUsername || playerName;
  const isLoggedInPlayer = !!loggedInUsername;
  const [joinCode,     setJoinCode]     = useState("");
  const [hostDuration, setHostDuration] = useState(120);
  const [hostRegion,   setHostRegion]   = useState("world");
  const [hostMaxPlayers, setHostMaxPlayers] = useState(10);

  /* phase / messages */
  const [phase,     setPhase]     = useState<Phase>("lobby");
  const [errorMsg,  setErrorMsg]  = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [kickedNoticeOpen, setKickedNoticeOpen] = useState(false);
  const [roomClosedNoticeOpen, setRoomClosedNoticeOpen] = useState(false);
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  const [newHostNoticeOpen, setNewHostNoticeOpen] = useState(false);

  /* viewport breakpoint (desktop ≥ 900px) — for end-screen 2-card layout */
  const [isWideViewport, setIsWideViewport] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.innerWidth >= 900 : true,
  );
  useEffect(() => {
    const onResize = () => setIsWideViewport(window.innerWidth >= 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /* game state */
  const [room,     setRoom]     = useState<GroupRoom | null>(null);
  const [players,  setPlayers]  = useState<GroupPlayer[]>([]);
  const [kickTarget, setKickTarget] = useState<GroupPlayer | null>(null);
  const [claims,   setClaims]   = useState<GroupClaim[]>([]);
  const [timeLeft, setTimeLeft] = useState(60);
  const [isHost,   setIsHost]   = useState(false);
  const [input,    setInput]    = useState("");
  const [feedback, setFeedback] = useState<"ok" | "err" | "dup" | "region" | null>(null);
  const [copied,   setCopied]   = useState(false);
  const [showLabels] = useState(true);
  const [quitModal, setQuitModal] = useState(false);

  // Frozen leaderboard at game end
  const [finalLeaderboard, setFinalLeaderboard] =
    useState<Array<{ playerId: string; name: string; score: number }> | null>(null);

  /* refs */
  const inputRef     = useRef<HTMLInputElement>(null);
  const rafRef       = useRef<number | null>(null);
  const fbTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gameEndedRef = useRef(false);
  const phaseRef     = useRef<Phase>("lobby");
  const isHostRef    = useRef(false);
  const roomIdRef    = useRef<string>("");
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeLeftRef  = useRef<number>(9999);
  const countdownPlayedRef = useRef(false);
  const leavingRef   = useRef(false);
  const lastSeenIsHostRef = useRef<boolean | null>(null);

  /* derived */
  const gameDuration = room?.duration_seconds ?? hostDuration;
  const gameRegion   = room?.region ?? hostRegion;
  const allowedIds   = useMemo(() => buildAllowedSet(gameRegion), [gameRegion]);
  const regionLabel  = REGION_OPTS.find(r => r.value === denormalizeRegion(gameRegion))?.label
    ?? REGION_OPTS.find(r => r.value === gameRegion)?.label
    ?? "Dünya";
  const durationLabel = DURATION_OPTS.find(d => d.value === gameDuration)?.label ?? `${gameDuration}sn`;
  useEffect(() => {
  if (phase !== "playing") {
    countdownPlayedRef.current = false;
    stopSound("countdown20");
    return;
  }

  const countdownLimit =
    countdownSoundMode === "last20"
      ? 20
      : countdownSoundMode === "last10"
        ? 10
        : 0;

  if (countdownLimit === 0 || gameDuration <= countdownLimit) {
    countdownPlayedRef.current = false;
    stopSound("countdown20");
    return;
  }

  if (!shouldPlayCountdownSound(timeLeft, countdownSoundMode)) {
    countdownPlayedRef.current = false;
    stopSound("countdown20");
    return;
  }

  if (timeLeft > 0 && !countdownPlayedRef.current) {
    countdownPlayedRef.current = true;
    playSound("countdown20");
  }

  if (timeLeft <= 0) {
    stopSound("countdown20");
  }
}, [phase, timeLeft, gameDuration, countdownSoundMode]);

useEffect(() => {
  return () => {
    stopSound("countdown20");
  };
}, []);

  /* sync refs */
  phaseRef.current  = phase;
  isHostRef.current = isHost;
  timeLeftRef.current = timeLeft;
  if (room) roomIdRef.current = room.id;

  /* skor hesabı: claims tablosundan canlı */
  const scoreMap = useMemo(() => {
    const m: Record<string, number> = {};
    claims.forEach(c => { m[c.player_id] = (m[c.player_id] ?? 0) + 1; });
    return m;
  }, [claims]);

  const myScore = scoreMap[myId] ?? 0;
  
  const waitingPlayers = useMemo(
  () => players.filter((p) => p.status === "waiting"),
  [players]
);
 
/* leaderboard: tüm oyuncular skora göre sıralı */
  const leaderboard = useMemo(() => {
    return players
      .map(p => ({
        playerId: p.id,
        name:     p.name,
        score:    scoreMap[p.id] ?? 0,
        isMe:     p.id === myId,
        isHost:   p.is_host,
      }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }, [players, scoreMap, myId]);

  /* harita için: benim claim'lerim ve diğerlerinin */
  const myTopoIds  = useMemo(
    () => new Set(claims.filter(c => c.player_id === myId).map(c => c.country_code)),
    [claims, myId],
  );
  const otherTopoIds = useMemo(
    () => new Set(claims.filter(c => c.player_id !== myId).map(c => c.country_code)),
    [claims, myId],
  );

  const shareLink = room ? `${location.origin}${location.pathname}?duelGroup=${room.code}` : "";
  const timerPct  = gameDuration > 0 ? (timeLeft / gameDuration) * 100 : 0;
  const timerColor =
    timeLeft > gameDuration * 0.33 ? "var(--accent)" :
    timeLeft > gameDuration * 0.13 ? "#f59e0b" : "#ef4444";
  const gameOver = gameEndedRef.current || timeLeft <= 0 || phase === "finished";
  const inputCls = ["duel-input",
    feedback === "ok"  ? "ok"  : "",
    feedback === "err" || feedback === "dup" || feedback === "region" ? "err" : "",
    gameOver ? "disabled" : "",
  ].filter(Boolean).join(" ");

  /* ── feedback helper ── */
  const showFeedback = useCallback((type: "ok" | "err" | "dup" | "region") => {
    if (fbTimerRef.current) clearTimeout(fbTimerRef.current);
    setFeedback(type);
    fbTimerRef.current = setTimeout(() => setFeedback(null), 900);
  }, []);

  /* ── ?duelGroup=CODE URL paramı ── */
  useEffect(() => {
    const code = new URLSearchParams(location.search).get("duelGroup");
    if (code) setJoinCode(code.toUpperCase());
  }, []);

  /* ── Session restore ── */
  useEffect(() => {
    const saved = loadRoomSession();
    if (!saved) return;

    myIdRef.current = saved.playerId;

    (async () => {
      const { data: r } = await supabase
        .from("duel_group_rooms").select("*").eq("id", saved.roomId).single();
      if (!r || r.status === "finished") {
        clearGroupSession();
        return;
      }
      const { data: ps } = await supabase
        .from("duel_group_players").select("*").eq("room_id", r.id);
      const isMe = (ps ?? []).some((p: GroupPlayer) => p.id === saved.playerId);
      if (!isMe) {
        clearGroupSession();
        return;
      }
      const room = r as GroupRoom;
      const myRow = (ps ?? []).find((p: GroupPlayer) => p.id === saved.playerId);
      setRoom(room);
      setPlayers(ps ?? []);
      setIsHost(!!myRow?.is_host);
      setTimeLeft(room.duration_seconds);
      if (r.status === "playing") {
        const { data: cs } = await supabase
          .from("duel_group_claims").select("*").eq("room_id", r.id);
        setClaims(cs ?? []);
        setPhase("playing");
      } else {
        setPhase("waiting");
      }
      dbg("session restore ✓", { roomId: r.id, status: r.status });
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Realtime ── */
  useEffect(() => {
    if (!room) return;

    const chan = supabase.channel(`duel-group:${room.id}`)
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "duel_group_rooms", filter: `id=eq.${room.id}` },
        async (payload: { new: GroupRoom }) => {
          const r = payload.new as GroupRoom;
          setRoom(r);

          if (r.status === "playing" && phaseRef.current !== "playing") {
            dbg("RT room → playing", r.started_at);
            // Yeni maç başladı — önceki maçtan kalan yerel state'i temizle.
            // Host duel_group_claims tablosunu siliyor ama realtime sadece INSERT
            // dinlediği için diğer client'lar stale claims taşıyor; burada düşürüyoruz.
            setClaims([]);
            setFinalLeaderboard(null);
            gameEndedRef.current = false;
            setPhase("playing");
          }
          if (r.status === "finished" && !gameEndedRef.current) {
            gameEndedRef.current = true;
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
            await freezeLeaderboard(r.id, r.started_at);
            clearGroupSession();
            setPhase("finished");
          }
        })
      .on("postgres_changes",
        { event: "DELETE", schema: "public", table: "duel_group_rooms", filter: `id=eq.${room.id}` },
        () => {
          if (leavingRef.current) return;
          if (phaseRef.current !== "waiting" && phaseRef.current !== "playing") return;
          if (gameEndedRef.current) return;
          leavingRef.current = true;
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
          clearGroupSession();
          setRoom(null);
          setPlayers([]);
          setClaims([]);
          setIsHost(false);
          setFinalLeaderboard(null);
          setErrorMsg(null);
          setStatusMsg(null);
          setQuitModal(false);
          setNewHostNoticeOpen(false);
          gameEndedRef.current = false;
          lastSeenIsHostRef.current = null;
          setRoomClosedNoticeOpen(true);
          setPhase("lobby");
          leavingRef.current = false;
        })
      .on("postgres_changes",
        { event: "*", schema: "public", table: "duel_group_players", filter: `room_id=eq.${room.id}` },
        () => {
          // Tüm değişikliklerde listeyi yeniden çek (basit, doğru)
          supabase.from("duel_group_players")
            .select("*").eq("room_id", room.id)
            .then(({ data }: { data: GroupPlayer[] | null }) => {
              if (!data) return;
              setPlayers(data as GroupPlayer[]);
            });
        })
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "duel_group_claims", filter: `room_id=eq.${room.id}` },
        (payload: { new: GroupClaim }) => {
          if (gameEndedRef.current || phaseRef.current === "finished") return;
          setClaims(prev => {
            const c = payload.new as GroupClaim;
            if (prev.some(x => x.id === c.id)) return prev;
            return [...prev, c];
          });
        })
      .subscribe();

    return () => { supabase.removeChannel(chan); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id]);

  /* ── Realtime fallback poll (waiting fazı için player listesi) ── */
  useEffect(() => {
    if (phase !== "waiting" || !room?.id) return;
    const roomId = room.id;
    const t = setInterval(async () => {
      const { data } = await supabase
        .from("duel_group_players").select("*").eq("room_id", roomId);
      if (data) setPlayers(data as GroupPlayer[]);
      // status değişti mi kontrol et (host başlattı vs.)
      const { data: r } = await supabase
        .from("duel_group_rooms").select("*").eq("id", roomId).single();
      if (r && r.status === "playing" && phaseRef.current === "waiting") {
        setRoom(r as GroupRoom);
        // Realtime kaçırılmış olabilir; yeni maçta önceki claim state'i hayatta kalmasın.
        setClaims([]);
        setFinalLeaderboard(null);
        gameEndedRef.current = false;
        setPhase("playing");
      }
    }, 2000);
    return () => clearInterval(t);
  }, [phase, room?.id]);

  /* ── Realtime fallback poll (playing fazı için bitiş tespiti) ── */
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
          .from("duel_group_rooms")
          .select("status, started_at")
          .eq("id", roomId).single();
        if (!data) return;
        if (data.status === "finished" && !gameEndedRef.current) {
          gameEndedRef.current = true;
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          await freezeLeaderboard(roomId, data.started_at);
          setRoom(prev => prev ? { ...prev, status: "finished" } : prev);
          clearGroupSession();
          setPhase("finished");
        }
      } catch { /* ignore */ }
    }, 1500);
    return () => {
      if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, room?.id]);

  /* ── Server-authoritative timer (1v1 ile aynı mantık) ── */
  useEffect(() => {
    if (phase !== "playing") return;
    if (!room?.started_at) return;

    const totalMs = gameDuration * 1000;
    let done = false;

    const tick = () => {
      if (done) return;
      const now      = Date.now();
      const startMs  = room.started_at ? new Date(room.started_at).getTime() : now;
      const endMs    = startMs + totalMs;
      const remMs    = Math.max(0, endMs - now);
      const remSec   = Math.floor(remMs / 1000);
      const safeRem  = Math.min(gameDuration, remSec);
      setTimeLeft(safeRem);

      if (now >= endMs) {
        done = true;
        if (!gameEndedRef.current) finishGameByTimeout();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    const onVis = () => {
      if (document.visibilityState === "visible" && !done) {
        if (phaseRef.current !== "playing") { done = true; return; }
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      done = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      document.removeEventListener("visibilitychange", onVis);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, gameDuration, room?.started_at]);

  /* ── auto-focus oyun başlayınca ── */
  useEffect(() => {
    if (phase === "playing") setTimeout(() => inputRef.current?.focus(), 100);
  }, [phase]);

  /* — oyun bitince bu oyuncuyu finished işaretle — */
useEffect(() => {
  if (phase !== "finished" || !room || !myIdRef.current) return;

  supabase
    .from("duel_group_players")
    .update({
      status: "finished",
      last_seen_at: new Date().toISOString(),
    })
    .eq("room_id", room.id)
    .eq("id", myIdRef.current);
}, [phase, room]);

  /* ── ESC → quit modal ── */
  useEffect(() => {
    if (phase !== "playing") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setQuitModal(prev => !prev);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [phase]);

  /* ── Lightweight heartbeat: sadece guess ya da focus event'inde last_seen güncelle ──
   *    (saniyelik DB write yok; ölçeklenebilirlik kuralı)
   */
  const heartbeatThrottleRef = useRef(0);
  const touchHeartbeat = useCallback(() => {
    if (!myIdRef.current) return;
    const now = Date.now();
    if (now - heartbeatThrottleRef.current < 5000) return;
    heartbeatThrottleRef.current = now;
    supabase.from("duel_group_players")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", myIdRef.current)
      .then(({ error }: { error: unknown }) => {
        if (error) dbgErr("heartbeat update failed", error);
      });
  }, []);

  /* ── Final leaderboard'u dondur ── */
  const freezeLeaderboard = useCallback(async (roomId: string, matchStartedAt: string | null | undefined) => {
    // Önceki maçtan kalmış olabilecek claim satırlarını saymamak için yalnızca
    // mevcut maçın started_at değerinden sonra oluşturulan claim'leri sayıyoruz.
    // Live scoreboard zaten yalnızca bu maçta gelen realtime INSERT'leri tutuyor;
    // burada DB sorgusunu da aynı pencereye sıkıştırıyoruz ki iki kaynak tutarlı olsun.
    const sinceTs = matchStartedAt ?? "1970-01-01T00:00:00Z";
    const [csRes, psRes] = await Promise.all([
      supabase.from("duel_group_claims")
        .select("player_id")
        .eq("room_id", roomId)
        .gte("created_at", sinceTs),
      supabase.from("duel_group_players").select("id, name").eq("room_id", roomId),
    ]);
    const cs: Array<{ player_id: string }> = csRes?.data ?? [];
    const ps: Array<{ id: string; name: string }> = psRes?.data ?? [];

    const counts: Record<string, number> = {};
    cs.forEach(c => { counts[c.player_id] = (counts[c.player_id] ?? 0) + 1; });

    const board: Array<{ playerId: string; name: string; score: number }> =
      ps.map(p => ({
        playerId: p.id,
        name:     p.name,
        score:    counts[p.id] ?? 0,
      }));

    board.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    setFinalLeaderboard(board);
    dbg("final leaderboard frozen", board);
  }, []);

  /* ── Süre dolunca finish (her client çağırabilir, atomic update kazanır) ── */
  const finishGameByTimeout = useCallback(async () => {
    if (gameEndedRef.current || !room) return;
    gameEndedRef.current = true;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }

    await freezeLeaderboard(room.id, room.started_at);

    // Conditional update — yalnız "playing" iken set'lensin (race-safe)
    await supabase.from("duel_group_rooms")
      .update({ status: "finished", updated_at: new Date().toISOString() })
      .eq("id", room.id)
      .eq("status", "playing");

    setRoom(prev => prev ? { ...prev, status: "finished" } : prev);
    setPhase("finished");
    clearGroupSession();
  }, [room, freezeLeaderboard]);

  /* — KICKED CHECK: odadan silinen oyuncuyu lobby ekranına düşür — */
useEffect(() => {
  if (!room) return;
  if (phase !== "waiting") return;
  if (!myIdRef.current) return;
  if (!players.length) return;
  if (leavingRef.current) return; // kendi rızasıyla ayrılıyorsak kick modal'ı tetikleme

  const stillInRoom = players.some((p) => p.id === myIdRef.current);

  if (!stillInRoom) {
    clearGroupSession();
    setRoom(null);
    setPlayers([]);
    setClaims([]);
    setIsHost(false);
    setFinalLeaderboard(null);
    setErrorMsg(null);
    setStatusMsg(null);
    setKickedNoticeOpen(true);
    setPhase("lobby");
  }
}, [room, phase, players]);

  /* — HOST TRANSFER DETECTION: yerel is_host değişimini izle, yeni hosta modal göster — */
  useEffect(() => {
    if (!room) {
      lastSeenIsHostRef.current = null;
      return;
    }
    if (!myIdRef.current || !players.length) return;

    const me = players.find((p) => p.id === myIdRef.current);
    if (!me) return;

    const nowHost = !!me.is_host;
    const prev = lastSeenIsHostRef.current;

    if (prev === null) {
      // İlk gözlem: sadece seed et, modal tetikleme
      lastSeenIsHostRef.current = nowHost;
      if (nowHost !== isHostRef.current) setIsHost(nowHost);
      return;
    }

    if (nowHost !== prev) {
      lastSeenIsHostRef.current = nowHost;
      setIsHost(nowHost);
      if (nowHost && !prev && phaseRef.current === "waiting") {
        setNewHostNoticeOpen(true);
      }
    }
  }, [room, players]);

  /* ── CREATE ROOM ── */
  const createRoom = async () => {
    const name = effectivePlayerName.trim();
const usernameError = validateUsername(name);

if (usernameError) {
  setErrorMsg(usernameError);
  setStatusMsg(null);
  setPhase("lobby");
  return;
}

    const safeMax = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, hostMaxPlayers));

    setErrorMsg(null);
    setStatusMsg("Oda kuruluyor…");
    setPhase("creating");

    clearGroupSession();
    const freshId = freshPlayerId();
    myIdRef.current = freshId;

    const code = makeCode();

    const { data: roomData, error: roomErr } = await supabase
      .from("duel_group_rooms")
      .insert({
        code,
        status:           "waiting",
        duration_seconds: hostDuration,
        region:           normalizeRegion(hostRegion),
        max_players:      safeMax,
      })
      .select("*")
      .single();

    if (roomErr || !roomData?.id) {
      dbgErr("room insert failed", roomErr);
      setErrorMsg("Oda oluşturulamadı. Tekrar dene.");
      setStatusMsg(null); setPhase("lobby"); return;
    }

    const newRoom = roomData as GroupRoom;

    const { error: pErr } = await supabase
      .from("duel_group_players")
      .insert({
  id: freshId,
  room_id: newRoom.id,
  name,
  is_host: true,
  status: "waiting",
});

    if (pErr) {
      dbgErr("host insert failed", pErr);
      // best-effort cleanup
      await supabase.from("duel_group_rooms").delete().eq("id", newRoom.id);
      setErrorMsg("Oda oluşturulamadı. Tekrar dene.");
      setStatusMsg(null); setPhase("lobby"); return;
    }

    const { data: ps } = await supabase
      .from("duel_group_players").select("*").eq("room_id", newRoom.id);

    setRoom(newRoom);
    setPlayers((ps as GroupPlayer[]) ?? []);
    setClaims([]);
    setIsHost(true);
    saveRoomSession(newRoom.id, newRoom.code, freshId);
    setTimeLeft(hostDuration);
    setStatusMsg(null);
    setPhase("waiting");
    dbg("createRoom ✓", { roomId: newRoom.id, code: newRoom.code });
  };

  /* ── JOIN ROOM ── */
  const joinRoom = async () => {
    const name = effectivePlayerName.trim();
const code = joinCode.trim().toUpperCase();

const usernameError = validateUsername(name);

if (usernameError) {
  setErrorMsg(usernameError);
  setStatusMsg(null);
  setPhase("lobby");
  return;
}

if (!code) {
  setErrorMsg("Oda kodu yazmalısın.");
  return;
}

    setErrorMsg(null); setStatusMsg("Odaya bağlanılıyor…");

    const { data: r, error: re } = await supabase
      .from("duel_group_rooms").select("*").eq("code", code).single();

    if (re || !r?.id) {
      setErrorMsg("Oda bulunamadı. Kodu kontrol et."); setStatusMsg(null); return;
    }
    if (r.status === "finished") {
      setErrorMsg("Bu oyun zaten bitti."); setStatusMsg(null); return;
    }
    if (r.status === "playing") {
      setErrorMsg("Oyun başladı, katılamazsın."); setStatusMsg(null); return;
    }

    const targetRoom = r as GroupRoom;

    // Kapasite + aynı isim kontrolü
const { data: ps0 } = await supabase
  .from("duel_group_players")
  .select("id, name")
  .eq("room_id", targetRoom.id);

const cleanName = playerName.trim();

const sameNameExists = (ps0 ?? []).some((p: any) =>
  String(p.name ?? "").trim().toLocaleLowerCase("tr-TR") ===
  cleanName.toLocaleLowerCase("tr-TR")
);

if (sameNameExists) {
  setErrorMsg("Bu isim bu odada kullanılıyor. Farklı bir isim seç.");
  setStatusMsg(null);
  return;
}

if ((ps0?.length ?? 0) >= targetRoom.max_players) {
  setErrorMsg(`Oda dolu (${targetRoom.max_players} kişi).`);
  setStatusMsg(null);
  return;
}

    // Önceki session bu odadaysa devam et, değilse yeni id
    const saved = loadRoomSession();
    const joinId = (saved?.roomCode === code && saved?.playerId) ? saved.playerId : freshPlayerId();
    if (joinId !== saved?.playerId) clearGroupSession();
    myIdRef.current = joinId;

    // Bu id zaten odada mı?
    const { data: existing } = await supabase
      .from("duel_group_players").select("id").eq("room_id", targetRoom.id).eq("id", joinId);

    if (!existing?.length) {
      const { error: pErr } = await supabase
        .from("duel_group_players")
        .insert({
  id: joinId,
  room_id: targetRoom.id,
  name,
  is_host: false,
  status: "waiting",
});
      if (pErr && pErr.code !== "23505") {
        dbgErr("join insert failed", pErr);
        setErrorMsg("Odaya katılınamadı."); setStatusMsg(null); return;
      }
    }

    const { data: ps } = await supabase
      .from("duel_group_players").select("*").eq("room_id", targetRoom.id);

    setRoom(targetRoom);
    setPlayers((ps as GroupPlayer[]) ?? []);
    setClaims([]);
    setIsHost(false);
    saveRoomSession(targetRoom.id, targetRoom.code, joinId);
    setTimeLeft(targetRoom.duration_seconds);
    setStatusMsg(null); setPhase("waiting");
    dbg("joinRoom ✓", { roomId: targetRoom.id });
  };


  const updateRoomSettings = useCallback(
  async (patch: Partial<Pick<GroupRoom, "duration_seconds" | "region" | "max_players">>) => {
    if (!room || !isHostRef.current || phase !== "waiting") return;

    const nextMaxPlayers = patch.max_players ?? room.max_players;

    if (nextMaxPlayers < waitingPlayers.length) {
      setErrorMsg(`Maksimum oyuncu sayısı şu an odada olan kişi sayısından düşük olamaz. Şu an ${waitingPlayers.length} kişi var.`);
      return;
    }

    const { error } = await supabase
      .from("duel_group_rooms")
      .update({
        ...patch,
        updated_at: new Date().toISOString(),
      })
      .eq("id", room.id);

    if (error) {
      dbgErr("updateRoomSettings failed", error);
      setErrorMsg("Oda ayarları güncellenemedi.");
      return;
    }

    setErrorMsg(null);
  },
  [room, phase, waitingPlayers.length]
);
  /* ── START GAME (sadece host) ── */
  const startGame = async () => {
    if (!room || !isHost) return;
    if (players.length < MIN_PLAYERS) {
      setErrorMsg(`En az ${MIN_PLAYERS} oyuncu gerekli.`); return;
    }
    const startedAt = new Date().toISOString();

const { error: clearClaimsError } = await supabase
  .from("duel_group_claims")
  .delete()
  .eq("room_id", room.id);

if (clearClaimsError) {
  dbgErr("startGame clear claims failed", clearClaimsError);
  setErrorMsg("Eski cevaplar temizlenemedi. Oyunu başlatamadık.");
  return;
}

setClaims([]);

    await supabase
  .from("duel_group_players")
  .update({
    status: "playing",
    last_seen_at: startedAt,
  })
  .eq("room_id", room.id);
    const { error } = await supabase
      .from("duel_group_rooms")
      .update({ status: "playing", started_at: startedAt, updated_at: startedAt })
      .eq("id", room.id);
    if (error) { setErrorMsg("Oyun başlatılamadı."); return; }
    // Realtime ile zaten gelecek; ama yine de hızlı geçiş için yerel set
    setRoom(prev => prev ? { ...prev, status: "playing", started_at: startedAt } : prev);
    setPhase("playing");
  };

  /* ── GUESS ── */
  const handleGuess = async () => {
    if (phaseRef.current !== "playing") return;
    if (gameEndedRef.current) return;
    if (timeLeftRef.current <= 0) return;
    if (!room || room.status !== "playing") return;

    touchHeartbeat();

    const norm = normalizeInput(input);
    if (!norm) return;
    const topoId = NAME_TO_TOPOID[norm];
    if (!topoId) { showFeedback("err"); setInput(""); return; }
    if (allowedIds && !allowedIds.has(topoId)) { showFeedback("region"); setInput(""); return; }
    if (claims.some(c => c.country_code === topoId)) { showFeedback("dup"); setInput(""); return; }

    if (timeLeftRef.current <= 0 || gameEndedRef.current) return;

    setInput("");
    const insertClaim = () => supabase.from("duel_group_claims").insert({
      room_id:      room.id,
      player_id:    myIdRef.current,
      country_code: topoId,
    });

    const first = await insertClaim();
    if (!first.error) { showFeedback("ok"); return; }
    if (first.error.code !== "23505") { showFeedback("err"); return; }

    // 23505: (room_id, country_code) çakıştı. Önceki maçtan kalmış stale bir
    // satır olabilir (host'un startGame DELETE'i geç gelen bir INSERT ile
    // yarışı kaybetmiş ya da prod'da temizlik tam çalışmamış olabilir). Mevcut
    // maçın started_at değerinden önce oluşturulmuş satırı sil ve tekrar dene;
    // aksi halde gerçekten bu maçta yazılmış demektir.
    const startedAt = room.started_at;
    if (startedAt) {
      const { data: existing } = await supabase
        .from("duel_group_claims")
        .select("id, created_at")
        .eq("room_id", room.id)
        .eq("country_code", topoId)
        .maybeSingle();

      if (existing && existing.created_at < startedAt) {
        const { error: delErr } = await supabase
          .from("duel_group_claims")
          .delete()
          .eq("id", existing.id);
        if (delErr) {
          dbgErr("stale claim delete failed", delErr);
          showFeedback("err");
          return;
        }
        const retry = await insertClaim();
        if (!retry.error) { showFeedback("ok"); return; }
        if (retry.error.code === "23505") { showFeedback("dup"); return; }
        showFeedback("err");
        return;
      }
    }

    showFeedback("dup"); // başkası daha hızlı yazdı (bu maçta)
  };

  /* ── COPY INVITE ── */
  const inviteMessage = room
    ? `🏆 Çok Oyunculu – Ülke Yaz

Oda Kodu: ${room.code}
Bölge: ${regionLabel}
Süre: ${durationLabel}

Arkadaşlarınla aynı odada yarış:
Süre bitmeden en çok ülkeyi yazan kazanır.

Oyuna katıl:
${shareLink}`
    : "";
  const copyInvite = () => {
    const text = inviteMessage || shareLink;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }).catch(() => {
      window.prompt("Linki kopyala:", shareLink);
    });
  };

  /* ── Room reconciliation after a player leaves ──
   *  - Kalan oyuncu yoksa odayı sil (DB trigger da safety-net olarak aynısını
   *    yapıyor; client tarafında da yapmak diğer client'lara realtime DELETE
   *    olayını daha hızlı ulaştırıyor).
   *  - Host kalmadıysa en eski joined_at oyuncusunu host yap. Race durumunda
   *    iki client ayrı ayrı promote etmeye çalışırsa, ikisi de aynı en eski
   *    oyuncuyu seçeceği için tek host kalır.
   */
  const reconcileRoomAfterLeave = useCallback(async (roomId: string) => {
    try {
      const { data: ps } = await supabase
        .from("duel_group_players")
        .select("id, is_host, joined_at, status")
        .eq("room_id", roomId)
        .order("joined_at", { ascending: true });
      const remaining = (ps ?? []) as Array<Pick<GroupPlayer, "id" | "is_host" | "joined_at" | "status">>;

      if (remaining.length === 0) {
        await supabase.from("duel_group_rooms").delete().eq("id", roomId);
        return;
      }

      const hasHost = remaining.some((p) => p.is_host);
      if (!hasHost) {
        const candidate = remaining.find((p) => p.status === "waiting") ?? remaining[0];
        if (candidate) {
          const { error: promoteErr } = await supabase
            .from("duel_group_players")
            .update({
              is_host: true,
              last_seen_at: new Date().toISOString(),
            })
            .eq("id", candidate.id)
            .eq("room_id", roomId);
          if (promoteErr) dbgErr("host promote failed", promoteErr);
        }
      }
    } catch (e) {
      dbgErr("reconcileRoomAfterLeave failed", e);
    }
  }, []);

  /* — KICK PLAYER (sadece host, sadece bekleme odası) — */
const kickPlayer = useCallback(
  async (playerId: string) => {
    if (!room || !isHostRef.current) return;
    if (phaseRef.current !== "waiting") return;
    if (playerId === myIdRef.current) return;

    const roomId = room.id;
    const { error } = await supabase
      .from("duel_group_players")
      .delete()
      .eq("room_id", roomId)
      .eq("id", playerId);

    if (error) {
      dbgErr("kickPlayer failed", error);
      setErrorMsg("Oyuncu odadan çıkarılamadı.");
      return;
    }

    setPlayers((prev) => prev.filter((p) => p.id !== playerId));
    setKickTarget(null);
    // Defensive: ensure host invariant after kicking (host is still here, so
    // reconcile is essentially a no-op, but it keeps the cleanup path uniform).
    await reconcileRoomAfterLeave(roomId);
  },
  [room, reconcileRoomAfterLeave]
);

  /* ── BACK TO LOBBY ── */
  const backToLobby = useCallback(async () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    try {
      // Eğer waiting'deyiz ve oyuncuysak → kendimi sil, sonra odayı reconcile et
      if (room && phaseRef.current === "waiting") {
        try {
          const roomId = room.id;
          const { error: leaveErr } = await supabase
            .from("duel_group_players")
            .delete()
            .eq("id", myIdRef.current)
            .eq("room_id", roomId);
          if (leaveErr) dbgErr("self leave failed", leaveErr);
          await reconcileRoomAfterLeave(roomId);
        } catch (e) { dbgErr("backToLobby cleanup failed", e); }
      }
      clearGroupSession();
      setRoom(null);
      setPlayers([]);
      setClaims([]);
      setIsHost(false);
      setFinalLeaderboard(null);
      setErrorMsg(null);
      setStatusMsg(null);
      setQuitModal(false);
      setNewHostNoticeOpen(false);
      gameEndedRef.current = false;
      lastSeenIsHostRef.current = null;
      setPhase("lobby");
    } finally {
      leavingRef.current = false;
    }
  }, [room, reconcileRoomAfterLeave]);

/* — RETURN TO SAME ROOM (oyun sonu -> aynı odaya dön) — */
const returnToRoom = useCallback(async () => {
  if (!room) return;

  try {
    // Sadece host odayı tekrar waiting durumuna çeksin
    if (isHostRef.current) {
      await supabase
        .from("duel_group_rooms")
        .update({
          status: "waiting",
          started_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", room.id);
    }
  } catch (e) {
    dbgErr("returnToRoom failed", e);
  }

  // Oyunun geçici state'lerini temizle ama ODAYI ve OYUNCULARI KORU
  setClaims([]);
  setFinalLeaderboard(null);
  setErrorMsg(null);
  setStatusMsg(null);
  setQuitModal(false);
  gameEndedRef.current = false;

  setClaims([]);
setFinalLeaderboard(null);
setErrorMsg(null);
setStatusMsg(null);
setQuitModal(false);
gameEndedRef.current = false;

await supabase
  .from("duel_group_players")
  .update({
    status: "waiting",
    last_seen_at: new Date().toISOString(),
  })
  .eq("room_id", room.id)
  .eq("id", myIdRef.current);

setPhase("waiting");
  // Aynı odanın bekleme ekranına dön
  setPhase("waiting");
}, [room]);

  /* ── FORFEIT (oyun sırasında çık) ── */
  const forfeit = useCallback(async (target: "lobby" | "home") => {
    // Skor zaten claim sayısına göre olduğu için "kaybetmek" davranışı:
    // sadece odadan ayrıl. Geri kalanlar kendi aralarında yarışmaya devam eder.
    if (room) {
      try {
        const roomId = room.id;
        await supabase.from("duel_group_players")
          .delete()
          .eq("id", myIdRef.current)
          .eq("room_id", roomId);
        await reconcileRoomAfterLeave(roomId);
      } catch (e) { dbgErr("forfeit cleanup failed", e); }
    }
    clearGroupSession();
    setQuitModal(false);
    if (target === "home") onHome();
    else backToLobby();
  }, [room, backToLobby, onHome, reconcileRoomAfterLeave]);

  /* ─────────── RENDER ─────────── */

  const homeTheme = readStoredHomeTheme();
  const isPreGamePhase = phase !== "playing" && phase !== "finished";
  const themeBgStyle = isPreGamePhase ? getThemeBackgroundStyle(homeTheme) : undefined;
  const themeDataAttr = isPreGamePhase ? getThemeDataAttr(homeTheme) : undefined;

  return (
    <div className="duel-app" style={themeBgStyle} data-theme={themeDataAttr}>
      {/* ════════ LOBBY ════════ */}
      {phase === "lobby" && (
        <div className="duel-lobby">
          <div className="duel-lobby-card">
            <button
  className="btn btn-ghost btn-sm"
  onClick={() => {
    playSound("click");
    onHome();
  }}
  style={{ alignSelf: "flex-start" }}
>
              ← Ana Menü
            </button>

            <h2 className="duel-lobby-title">🏆 Çok Oyunculu</h2>
            <p className="duel-lobby-desc">3–10 kişilik arkadaş grubunla oyna • En çok ülke yazan kazanır.</p>

            <input
  className="duel-name-input"
  type="text"
  placeholder="İsmin"
  value={isLoggedInPlayer ? loggedInUsername : playerName}
  onChange={(e) => {
    if (isLoggedInPlayer) return;
    setPlayerName(e.target.value.slice(0, 20));
  }}
  disabled={isLoggedInPlayer}
  maxLength={20}
  autoComplete="off"
/>

            {/* CREATE block */}
<div className="duel-create-block duel-create-polished">
  <div className="duel-create-fields">
    <div className="duel-host-settings">
      <div className="duel-select-wrap">
        <label className="duel-select-label">Süre</label>
        <div className="duel-select-box">
          <select
            className="duel-select"
            value={hostDuration}
            onChange={(e) => setHostDuration(Number(e.target.value))}
          >
            {DURATION_OPTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="duel-select-caret">⌄</span>
        </div>
      </div>

      <div className="duel-select-wrap">
        <label className="duel-select-label">Bölge</label>
        <div className="duel-select-box">
          <select
            className="duel-select"
            value={hostRegion}
            onChange={(e) => setHostRegion(e.target.value)}
          >
            {REGION_OPTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="duel-select-caret">⌄</span>
        </div>
      </div>

      <div className="duel-select-wrap">
        <label className="duel-select-label">Maks Oyuncu</label>
        <div className="duel-select-box">
          <select
            className="duel-select"
            value={hostMaxPlayers}
            onChange={(e) => setHostMaxPlayers(Number(e.target.value))}
          >
            {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <option key={n} value={n}>
                {n} kişi
              </option>
            ))}
          </select>
          <span className="duel-select-caret">⌄</span>
        </div>
      </div>
    </div>

    <button
      className="btn btn-accent duel-create-btn"
      onClick={createRoom}
      disabled={phase !== "lobby"}
    >
      {(phase as Phase) === "creating" ? "Kuruluyor..." : "🏠 Grup Odası Kur"}
    </button>
  </div>

  <div className="dgg-join-divider">
  <span>veya mevcut bir odaya katıl</span>
</div>

  <div className="duel-join-block">
    <div className="duel-join-row">
      <input
        className="duel-code-input"
        type="text"
        placeholder="ODA KODU"
        value={joinCode}
        onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
        maxLength={6}
        autoComplete="off"
      />
      <button className="btn btn-danger duel-join-btn" onClick={joinRoom}>
        Katıl
      </button>
    </div>
  </div>

    {errorMsg && <p className="duel-error">{errorMsg}</p>}
  {statusMsg && <p className="duel-status">{statusMsg}</p>}
</div>
</div>
</div>
)}

      {/* ════════ WAITING ════════ */}
      {/* ======== WAITING ======== */}
{phase === "waiting" && room && (
  <div className="dgg-wait-page">
    <div className="dgg-wait-shell">
      <div className="dgg-wait-main-card">
        <div className="dgg-wait-head">
          <h2 className="duel-lobby-title">Oyuncular Bekleniyor...</h2>

          <div className="duel-room-code-block">
            <span className="duel-room-code">{room.code}</span>
            <p className="duel-room-code-hint">6 haneli kod — arkadaşlarına ver</p>
          </div>

          <button
            className={"btn duel-invite-btn" + (copied ? " invited" : "")}
            onClick={copyInvite}
          >
            {copied ? "✓ Davet mesajı kopyalandı!" : "📋 Davet Mesajını Kopyala"}
          </button>

          <div
            className="duel-link-preview"
            onClick={(e) => {
              const el = e.currentTarget.querySelector("input") as HTMLInputElement | null;
              el?.select();
            }}
          >
            <input
              className="duel-link-input"
              readOnly
              value={shareLink}
              onFocus={(e) => e.target.select()}
            />
          </div>

          <div className="duel-settings-summary">
            <span>⏱ {durationLabel}</span>
            <span className="duel-sum-dot">·</span>
            <span>{regionLabel}</span>
            <span className="duel-sum-dot">·</span>
            <span>👥 {waitingPlayers.length}/{room.max_players}</span>
          </div>
        </div>

        <div className="dgg-wait-body">
          <div className="dgg-wait-left dgg-panel">
            <div className="dgg-panel-head">
  <div>
    <h3>Oyuncular</h3>
    <span className="dgg-panel-sub">
      En az {MIN_PLAYERS} oyuncu gerekli
    </span>
  </div>

  <span className="dgg-panel-count">
    {waitingPlayers.length}/{room.max_players}
  </span>
</div>
            <div className="duel-players-list">
              {waitingPlayers.map((p) => (
                <div
                  key={p.id}
                  className={"duel-player-chip" + (p.id === myId ? " mine" : "")}
                >
                  <span className="duel-player-dot" />
                  <span className="duel-player-name">{p.name}</span>
                  <div className="duel-player-tags">
  {p.id === myId && <span className="duel-tag">Sen</span>}
  {p.is_host && <span className="duel-tag host">👑</span>}
</div>

{isHost && phase === "waiting" && p.id !== myId && (
  <button
    type="button"
    className="dgg-kick-btn"
    onClick={() => setKickTarget(p)}
  >
    At
  </button>
)}
</div>
))}

              {waitingPlayers.length < MIN_PLAYERS && (
                <div className="duel-player-chip waiting">
                  <span className="duel-player-dot waiting" />
                  <span>
                    En az {MIN_PLAYERS} oyuncu gerekli ({MIN_PLAYERS - waitingPlayers.length} bekleniyor)...
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="dgg-wait-right">
           <button
  type="button"
  className="dgg-settings-toggle"
  onClick={() => setMobileSettingsOpen((v) => !v)}
>
  <span>⚙️ Oda Ayarları</span>
  <span className="dgg-settings-chevron">
    {mobileSettingsOpen ? "⌃" : "⌄"}
  </span>
</button>

{!isHost && (
  <span className="dgg-room-settings-note">
    Sadece oda sahibi değiştirebilir
  </span>
)}

<div className={"dgg-settings-content" + (mobileSettingsOpen ? " open" : "")}>
              <div className="dgg-room-settings-grid">
                <label className="dgg-setting-field">
                  <span>Süre</span>
                  <select
                    value={room.duration_seconds}
                    disabled={!isHost}
                    onChange={(e) =>
                      updateRoomSettings({ duration_seconds: Number(e.target.value) })
                    }
                  >
                    <option value={60}>1 dk</option>
                    <option value={120}>2 dk</option>
                    <option value={180}>3 dk</option>
                    <option value={300}>5 dk</option>
                  </select>
                </label>

                <label className="dgg-setting-field">
                  <span>Bölge</span>
                  <select
                    value={room.region}
                    disabled={!isHost}
                    onChange={(e) =>
                      updateRoomSettings({ region: e.target.value })
                    }
                  >
                    <option value="world">Dünya</option>
                    <option value="europe">Avrupa</option>
                    <option value="asia">Asya</option>
                    <option value="africa">Afrika</option>
                    <option value="north_america">Kuzey Amerika</option>
                    <option value="south_america">Güney Amerika</option>
                    <option value="oceania">Okyanusya</option>
                  </select>
                </label>

                <label className="dgg-setting-field">
                  <span>Maks. Oyuncu</span>
                  <select
                    value={room.max_players}
                    disabled={!isHost}
                    onChange={(e) =>
                      updateRoomSettings({ max_players: Number(e.target.value) })
                    }
                  >
                    {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                      <option key={n} value={n}>
                        {n} kişi
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            {isHost ? (
              waitingPlayers.length >= MIN_PLAYERS ? (
                <button className="btn btn-accent duel-start-btn" onClick={startGame}>
                  🚀 Oyunu Başlat ({waitingPlayers.length} kişi)
                </button>
              ) : (
                <p className="duel-waiting-msg">En az {MIN_PLAYERS} kişi gerekli...</p>
              )
            ) : (
              <p className="duel-waiting-msg">Ev sahibi oyunu başlatacak...</p>
            )}

            {errorMsg && <p className="duel-error">{errorMsg}</p>}

            <button className="btn btn-ghost btn-sm" onClick={backToLobby}>
              ← Lobiye Dön
            </button>
          </div>
        </div>
      </div>

      <div className="dgg-wait-chat-card">
        <LobbyChat roomCode={room.code} playerName={effectivePlayerName} />
      </div>
    </div>
  </div>
)}

      {/* ════════ PLAYING (finished'da da arka plan render kalsın) ════════ */}
      {(phase === "playing" || phase === "finished") && room && (
  <div className="dgg-game">
        <>
          {/* Üst bar: skor + timer + leaderboard pill */}
          <div className="duel-score-bar">
            <div className="duel-score-mine">
              <span className="duel-score-label">Senin Skorun</span>
              <span className="duel-score-value">{myScore}</span>
            </div>

            <div className="dgg-timer-wrap">
              <div className="dgg-timer-bar">
                <div className="dgg-timer-fill" style={{
                  width: `${timerPct}%`,
                  background: timerColor,
                }}/>
              </div>
              <span className="dgg-timer-text" style={{ color: timerColor }}>
                {Math.floor(timeLeft / 60)}:{String(timeLeft % 60).padStart(2, "0")}
              </span>
            </div>

            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setQuitModal(true)}
              aria-label="Çıkış"
            >
              ✕ Çık
            </button>
          </div>

          {/* Live leaderboard */}
          <div className="dgg-leaderboard">
            {leaderboard.map((entry, idx) => (
              <div
                key={entry.playerId}
                className={"dgg-lb-row" + (entry.isMe ? " mine" : "")}
              >
                <span className="dgg-lb-rank">#{idx + 1}</span>
                <span className="dgg-lb-name">
                  {entry.name}
                  {entry.isHost && <span className="dgg-lb-host"> 👑</span>}
                  {entry.isMe   && <span className="dgg-lb-you"> (Sen)</span>}
                </span>
                <span className="dgg-lb-score">{entry.score}</span>
              </div>
            ))}
          </div>

          {/* Map */}
          <div className="dgg-map-wrap map-area">
            <DuelMapView
              myTopoIds={myTopoIds}
              oppTopoIds={otherTopoIds}
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
              {feedback === "ok"     && <span className="fb fb-ok">✓ +1!</span>}
              {feedback === "err"    && <span className="fb fb-no">✗ Bulunamadı</span>}
              {feedback === "dup"    && <span className="fb fb-dup">Zaten alındı</span>}
              {feedback === "region" && <span className="fb fb-no">⚠ Bölge dışı</span>}
            </div>
          </div>

          {/* Quit modal */}
          {quitModal && (
            <div className="duel-quit-backdrop" onClick={() => setQuitModal(false)}>
              <div className="duel-quit-modal" onClick={e => e.stopPropagation()}>
                <h3 className="duel-quit-title">Oyundan çıkmak istiyor musun?</h3>
                <p className="duel-quit-sub">Çıkarsan diğerleri yarışmaya devam eder; senin skorun donar.</p>
                <div className="duel-quit-actions">
                  <button className="btn duel-quit-action forfeit" onClick={() => forfeit("lobby")}>
                    🚪 Lobiye Dön
                  </button>
                  <button className="btn duel-quit-action menu" onClick={() => forfeit("home")}>
                    🏠 Ana Menü
                  </button>
                  <button className="btn duel-quit-action cancel" onClick={() => setQuitModal(false)}>
                    ↩ Vazgeç
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
        </div>
)}

      {/* ════════ FINISHED — overlay (Çark Grup ile aynı görsel düzen) ════════ */}
      {phase === "finished" && room && (() => {
        const board = finalLeaderboard ?? leaderboard.map(b => ({
          playerId: b.playerId, name: b.name, score: b.score,
        }));
        const myRank = board.findIndex(b => b.playerId === myIdRef.current) + 1;
        const me = board.find(b => b.playerId === myIdRef.current);
        const myFinalScore = me?.score ?? 0;
        const top = board[0]?.score ?? 0;
        const iWon = myFinalScore > 0 && myFinalScore === top;
        const titleText = iWon ? "KAZANDIN!" : "OYUN BİTTİ";
        const emoji = iWon ? "🏆" : "🏁";
        const reasonText = "Süre doldu.";
        const podium = board.slice(0, 3);
        const totalClaims = board.reduce((s, b) => s + b.score, 0);

        const scoreboardCardStyle: React.CSSProperties = {
          width: isWideViewport ? 320 : "100%",
          maxWidth: "96vw",
          maxHeight: isWideViewport ? "min(640px, 88vh)" : 360,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          background: "rgba(15, 18, 28, 0.86)",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
          border: "1px solid rgba(255,255,255,0.10)",
          borderRadius: 16,
          padding: 14,
          boxSizing: "border-box",
          boxShadow: "0 10px 28px rgba(0,0,0,0.45)",
          order: isWideViewport ? 0 : 1,
        };

        const resultCardOverrides: React.CSSProperties = {
          maxWidth: "min(560px, 96vw)",
          width: "100%",
          maxHeight: isWideViewport ? "min(720px, 92vh)" : "none",
          overflowY: isWideViewport ? "auto" : "visible",
          padding: "20px 22px",
          boxSizing: "border-box",
          order: isWideViewport ? 1 : 0,
        };

        return (
          <div
            className="wheel-result-backdrop"
            style={{
              overflowY: "auto",
              padding: isWideViewport ? "24px" : "16px 12px",
              boxSizing: "border-box",
              alignItems: isWideViewport ? "center" : "flex-start",
            }}
          >
            <div
              className="dgg-result-layout"
              style={{
                display: "flex",
                flexDirection: isWideViewport ? "row" : "column",
                alignItems: isWideViewport ? "flex-start" : "stretch",
                justifyContent: "center",
                gap: isWideViewport ? 22 : 14,
                width: "100%",
                maxWidth: isWideViewport ? 940 : 600,
                margin: "0 auto",
              }}
            >
              {/* ─── Kart 1: Tam Puan Tablosu (sol/desktop · alt/mobil) ─── */}
              <aside style={scoreboardCardStyle} aria-label="Tam Puan Tablosu">
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 10,
                    paddingBottom: 8,
                    borderBottom: "1px solid rgba(255,255,255,0.08)",
                  }}
                >
                  <h3
                    style={{
                      margin: 0,
                      fontSize: 14,
                      fontWeight: 800,
                      letterSpacing: "0.02em",
                    }}
                  >
                    📋 Tam Puan Tablosu
                  </h3>
                  <span style={{ fontSize: 11, opacity: 0.7, fontWeight: 600 }}>
                    {board.length} oyuncu
                  </span>
                </div>

                <div
                  style={{
                    overflowY: "auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    paddingRight: 4,
                    flex: 1,
                    minHeight: 0,
                  }}
                >
                  {board.map((entry, idx) => {
                    const isMe = entry.playerId === myIdRef.current;
                    const medal =
                      idx === 0 ? "🥇"
                      : idx === 1 ? "🥈"
                      : idx === 2 ? "🥉"
                      : `#${idx + 1}`;
                    return (
                      <div
                        key={entry.playerId}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "36px 1fr auto",
                          alignItems: "center",
                          gap: 8,
                          padding: "6px 8px",
                          borderRadius: 8,
                          background: isMe
                            ? "rgba(79,139,255,0.18)"
                            : idx < 3
                              ? "rgba(255,255,255,0.04)"
                              : "transparent",
                          border: isMe
                            ? "1px solid rgba(79,139,255,0.55)"
                            : "1px solid transparent",
                          fontSize: 13,
                          lineHeight: 1.25,
                        }}
                      >
                        <span
                          style={{
                            fontWeight: 800,
                            fontSize: idx < 3 ? 18 : 13,
                            textAlign: "center",
                            opacity: idx < 3 ? 1 : 0.7,
                          }}
                        >
                          {medal}
                        </span>
                        <span
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            minWidth: 0,
                            fontWeight: isMe ? 800 : 600,
                          }}
                        >
                          <span
                            style={{
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              flex: 1,
                              minWidth: 0,
                            }}
                          >
                            {entry.name}
                          </span>
                          {isMe && (
                            <span
                              style={{
                                fontSize: 10,
                                padding: "1px 6px",
                                borderRadius: 999,
                                background: "rgba(79,139,255,0.55)",
                                color: "#fff",
                                fontWeight: 700,
                                letterSpacing: "0.03em",
                                flexShrink: 0,
                              }}
                            >
                              Sen
                            </span>
                          )}
                        </span>
                        <span
                          style={{
                            fontWeight: 800,
                            fontVariantNumeric: "tabular-nums",
                            minWidth: 22,
                            textAlign: "right",
                          }}
                          title="Doğru sayısı"
                        >
                          {entry.score}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <div
                  style={{
                    marginTop: 8,
                    paddingTop: 8,
                    borderTop: "1px solid rgba(255,255,255,0.08)",
                    fontSize: 11,
                    opacity: 0.6,
                    textAlign: "center",
                  }}
                >
                  Toplam {totalClaims} doğru claim
                </div>
              </aside>

              {/* ─── Kart 2: Sonuç (orta/desktop · üst/mobil) ─── */}
              <div
                className="wheel-result-panel dgg-result-panel"
                style={resultCardOverrides}
              >
                <div className="wheel-result-emoji">{emoji}</div>
                <h2 className="wheel-result-title">{titleText}</h2>
                <p
                  className="duel-lobby-desc"
                  style={{ margin: "0 0 10px", fontSize: "0.95rem" }}
                >
                  {reasonText}
                </p>

                {/* Top 3 podium */}
                {podium.length > 0 && (
                  <div
                    className="dgg-final-board"
                    style={{
                      marginTop: 4,
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    {podium.map((entry, idx) => {
                      const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : "🥉";
                      const isMe = entry.playerId === myIdRef.current;
                      return (
                        <div
                          key={entry.playerId}
                          className={
                            "dgg-final-row" +
                            (isMe ? " mine" : "") +
                            (idx === 0 ? " winner" : "")
                          }
                        >
                          <span className="dgg-final-rank">{medal}</span>
                          <span className="dgg-final-name">
                            {entry.name}
                            {isMe && <span className="dgg-lb-you"> (Sen)</span>}
                          </span>
                          <span className="dgg-final-score">{entry.score}</span>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="duel-result-meta" style={{ marginTop: 10 }}>
                  <span>⏱ {durationLabel}</span>
                  <span className="duel-sum-dot">·</span>
                  <span>{regionLabel}</span>
                  <span className="duel-sum-dot">·</span>
                  <span>Toplam {totalClaims} ülke</span>
                  <span className="duel-sum-dot">·</span>
                  <span>Sıra #{Math.max(1, myRank)}</span>
                </div>

                {errorMsg && <p className="duel-error" style={{ marginTop: 8 }}>{errorMsg}</p>}

                <div className="wheel-result-actions">
                  <button
                    type="button"
                    className="wheel-primary-btn"
                    onClick={returnToRoom}
                  >
                    ↩ Lobiye Dön
                  </button>
                  <button
                    type="button"
                    className="wheel-ghost-btn"
                    onClick={backToLobby}
                  >
                    ↻ Yeni Oyun
                  </button>
                  <button
                    type="button"
                    className="wheel-ghost-btn"
                    onClick={onHome}
                  >
                    ⌂ Ana Menü
                  </button>
                </div>
              </div>
              {/* /Kart 2 — sonuç */}
            </div>
          </div>
        );
      })()}

          {kickTarget && (
  <div className="dgg-confirm-backdrop" onClick={() => setKickTarget(null)}>
    <div className="dgg-confirm-modal" onClick={(e) => e.stopPropagation()}>
      <div className="dgg-confirm-icon">⚠️</div>

      <h3>Oyuncuyu odadan çıkar</h3>

      <p>
        <strong>{kickTarget.name}</strong> adlı oyuncuyu odadan çıkarmak
        istediğine emin misin?
      </p>

      <div className="dgg-confirm-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setKickTarget(null)}
        >
          Vazgeç
        </button>

        <button
          type="button"
          className="dgg-confirm-danger"
          onClick={() => kickPlayer(kickTarget.id)}
        >
          Odadan At
        </button>
      </div>
    </div>
  </div>
)}

{kickedNoticeOpen && (
  <div
    className="dgg-confirm-backdrop"
    onClick={() => setKickedNoticeOpen(false)}
  >
    <div
      className="dgg-confirm-modal"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="dgg-confirm-icon">🚪</div>

      <h3>Odadan Çıkarıldın</h3>

      <p>Oda sahibi seni odadan çıkardı.</p>

      <div className="dgg-confirm-actions single">
        <button
          type="button"
          className="btn btn-accent"
          onClick={() => setKickedNoticeOpen(false)}
        >
          Tamam
        </button>
      </div>
    </div>
  </div>
)}

{roomClosedNoticeOpen && (
  <div
    className="dgg-confirm-backdrop"
    onClick={() => setRoomClosedNoticeOpen(false)}
  >
    <div
      className="dgg-confirm-modal"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="dgg-confirm-icon">🚪</div>

      <h3>Oda Kapatıldı</h3>

      <p>Oda artık aktif değil. Yeni bir oda kurabilir veya başka bir odaya katılabilirsin.</p>

      <div className="dgg-confirm-actions single">
        <button
          type="button"
          className="btn btn-accent"
          onClick={() => setRoomClosedNoticeOpen(false)}
        >
          Tamam
        </button>
      </div>
    </div>
  </div>
)}

{newHostNoticeOpen && (
  <div
    className="dgg-confirm-backdrop"
    onClick={() => setNewHostNoticeOpen(false)}
  >
    <div
      className="dgg-confirm-modal"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="dgg-confirm-icon">👑</div>

      <h3>YENİ ODA SAHİBİ SİZSİNİZ</h3>

      <p>Oda sahibi ayrıldı. Odayı artık siz yönetiyorsunuz.</p>

      <div className="dgg-confirm-actions single">
        <button
          type="button"
          className="btn btn-accent"
          onClick={() => setNewHostNoticeOpen(false)}
        >
          Tamam
        </button>
      </div>
    </div>
  </div>
)}
    </div>
  );
}
