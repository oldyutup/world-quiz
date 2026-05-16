/**
 * FlagDuelGame.tsx — Online 1v1 Bayrak Modu (tur bazlı, jokerli)
 *
 * Tasarım:
 *   - Lobby/Waiting:  DuelGame.tsx ile birebir aynı görsel sınıflar
 *   - Playing ekranı: Offline FlagGame ile birebir aynı görsel sınıflar
 *     (control-bar/TopBar, hint-panel, pas-gec-bar, flag-area, flag-stage…)
 *
 * Bayrak 1v1 ÖZEL:
 *   - Tur bazlı (5/10/15/20)
 *   - Skor eşit → ⚜️ altın tur (ilk doğru bilen kazanır; ikisi de pas → yeni bayrak)
 *   - Bölge filtresi var (Dünya/Avrupa/...)
 *   - Zorluk: hep "Tümü" (tüm bayraklar)
 *   - Jokerler: İlk Harf 15g · Kıta 20g · Harf Sayısı 25g — gold harcanır,
 *     her tur sıfırlanır, sadece kendi gold'undan düşer
 *   - Skor: VS tablosu (Sen ___ : ___ Rakip)
 *
 * Mevcut DuelGame.tsx'e DOKUNULMAMIŞTIR.
 *
 * Gerekli SQL (BİR KEZ çalıştır):
 *   ALTER TABLE duel_rooms
 *     ADD COLUMN IF NOT EXISTS current_flag    text    DEFAULT NULL,
 *     ADD COLUMN IF NOT EXISTS total_rounds    int     DEFAULT 10,
 *     ADD COLUMN IF NOT EXISTS current_round   int     DEFAULT 0,
 *     ADD COLUMN IF NOT EXISTS is_golden_round boolean DEFAULT false;
 */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { supabase, type DuelRoom, type DuelPlayer, type DuelClaim } from "../lib/supabase";
import {
  calculateFlagDuelXp,
  resultFromScores,
  awardXpEvent,
  type XpBreakdown,
} from "../lib/progression";
import XpGainBar from "./XpGainBar";
import LobbyChat from "./LobbyChat";
import { playSound, stopSound } from "../lib/sound";
import {
  NAME_TO_ENTRY,
  normalizeInput,
  getFlagPool,
  type Continent,
  type CountryEntry,
} from "../data/countries";
import { validateUsername, type Profile } from "../lib/auth";

/* ═══════════════════════════════════════════════════════════════
   SEÇENEKLER (offline mod ile aynı isimler)
═══════════════════════════════════════════════════════════════ */
const ROUND_OPTS = [
  { label: "5 Tur",  value: 5  },
  { label: "10 Tur", value: 10 },
  { label: "15 Tur", value: 15 },
  { label: "20 Tur", value: 20 },
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

/* TopBar dropdown için (offline'daki CONTINENT_OPTIONS ile aynı görsel) */
const CONTINENT_OPTIONS_UI: { label: string; short: string; value: string }[] = [
  { label: "🌍 Dünya",     short: "Dünya",     value: "world"         },
  { label: "🇪🇺 Avrupa",   short: "Avrupa",    value: "europe"        },
  { label: "🌏 Asya",      short: "Asya",      value: "asia"          },
  { label: "🌍 Afrika",    short: "Afrika",    value: "africa"        },
  { label: "🌎 K.Amerika", short: "K.Amerika", value: "north-america" },
  { label: "🌎 G.Amerika", short: "G.Amerika", value: "south-america" },
  { label: "🌊 Okyanusya", short: "Okyanusya", value: "oceania"       },
];

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

/* ═══════════════════════════════════════════════════════════════
   GOLD & HINTS (offline ile aynı sabitler — App.tsx'e dokunmadan)
═══════════════════════════════════════════════════════════════ */

const HINT_COSTS = {
  firstLetter: 15,
  continent:   20,
  letterCount: 25,
} as const;
type HintType = keyof typeof HINT_COSTS;

interface HintState {
  firstLetter: boolean;
  continent:   boolean;
  letterCount: boolean;
}
const EMPTY_HINTS: HintState = { firstLetter: false, continent: false, letterCount: false };


/* ═══════════════════════════════════════════════════════════════
   DROPDOWN (offline TopBar ile birebir)
═══════════════════════════════════════════════════════════════ */
interface DropdownProps {
  label: string; disabled: boolean;
  children: React.ReactNode; align?: "left" | "right";
}
function Dropdown({ label, disabled, children, align = "left" }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open]);
  return (
    <div className="dd-wrap" ref={ref}>
      <button
        className={"dd-trigger" + (open ? " open" : "") + (disabled ? " disabled" : "")}
        disabled={disabled} onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox" aria-expanded={open}
      >
        <span className="dd-label">{label}</span>
        <span className={"dd-caret" + (open ? " up" : "")}>▾</span>
      </button>
      {open && <div className={"dd-menu" + (align === "right" ? " dd-right" : "")} role="listbox">{children}</div>}
    </div>
  );
}
interface DDItemProps { active: boolean; onClick: () => void; children: React.ReactNode; }
function DDItem({ active, onClick, children }: DDItemProps) {
  return (
    <button className={"dd-item" + (active ? " active" : "")} role="option" aria-selected={active} onClick={onClick}>
      {children}
    </button>
  );
}

/* ═══════════════════════════════════════════════════════════════
   HINT PANEL (offline ile birebir)
═══════════════════════════════════════════════════════════════ */
interface HintPanelProps {
  gold: number;
  hints: HintState;
  currentEntry: CountryEntry | null;
  isPlaying: boolean;
  onBuyHint: (type: HintType) => void;
}
function HintPanel({ gold, hints, currentEntry, isPlaying, onBuyHint }: HintPanelProps) {
  if (!isPlaying || !currentEntry) return null;

  const display = currentEntry.display;
  const contOpt = CONTINENT_OPTIONS_UI.find(c => c.value === currentEntry.continent);

  const defs: { type: HintType; label: string; cost: number; value: string }[] = [
    { type: "firstLetter", label: "İlk Harf",    cost: HINT_COSTS.firstLetter, value: display.charAt(0).toUpperCase() + "…"        },
    { type: "continent",   label: "Kıta",         cost: HINT_COSTS.continent,   value: contOpt?.label ?? currentEntry.continent      },
    { type: "letterCount", label: "Harf Sayısı",  cost: HINT_COSTS.letterCount, value: display.replace(/\s/g, "").length + " harf"  },
  ];

  return (
    <div className="hint-panel">
      <span className="hint-title">💡 İpucu:</span>
      {defs.map(h => {
        const bought     = hints[h.type];
        const affordable = gold >= h.cost;
        return (
          <div key={h.type} className={"hint-chip" + (bought ? " hint-bought" : "")}>
            {bought ? (
              <span className="hint-value">{h.value}</span>
            ) : (
              <button
                className={"btn-hint" + (affordable ? "" : " hint-broke")}
                disabled={!affordable}
                onClick={() => onBuyHint(h.type)}
                title={affordable ? `${h.cost} gold harca` : `Yetersiz gold (${h.cost} gerekli)`}
              >
                <span className="hint-label">{h.label}</span>
                <span className="hint-cost">🟡{h.cost}</span>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   GOLD BAR (offline ile birebir, ama burada sadece gösterim)
═══════════════════════════════════════════════════════════════ */
interface GoldBarProps {
  gold: number;
  canBonus: boolean;
  onClaimBonus: () => void;
}

function GoldBar({ gold, canBonus, onClaimBonus }: GoldBarProps) {
  return (
    <div className="gold-bar">
      <span className="gold-amount">
        <span className="gold-icon">🟡</span>
        <span className="gold-num">{gold}</span>
        <span className="gold-label">Gold</span>
      </span>

      {canBonus && (
        <button
          className="btn-bonus btn-sm"
          onClick={onClaimBonus}
          title="Günlük bonus al"
        >
          +50 Günlük Bonus
        </button>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   YARDIMCILAR
═══════════════════════════════════════════════════════════════ */
type FlagDuelRoom = DuelRoom & {
  current_flag:    string | null;
  current_flag_at: string | null;
  total_rounds:    number;
  current_round:   number;
  is_golden_round: boolean;
};

function makeCode() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }
function dbgErr(label: string, e?: unknown) { console.error(`[FlagDuel] ❌ ${label}`, e); }

const PLAYER_ID_KEY = "geoquiz_flagduel_player_id";
const ROOM_KEY      = "geoquiz_flagduel_room";

function freshPlayerId(): string {
  const id = crypto.randomUUID();
  localStorage.setItem(PLAYER_ID_KEY, id);
  return id;
}
interface RoomSession { roomId: string; roomCode: string; playerId: string; }
function saveSession(roomId: string, roomCode: string, playerId: string) {
  localStorage.setItem(ROOM_KEY, JSON.stringify({ roomId, roomCode, playerId }));
}
function loadSession(): RoomSession | null {
  try {
    const raw = localStorage.getItem(ROOM_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p?.roomId || !p?.roomCode || !p?.playerId) return null;
    return p as RoomSession;
  } catch { return null; }
}
function clearSession() {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith("geoquiz_flagduel")) localStorage.removeItem(k);
  }
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* online'da hep "all" — zorluk seçimi yok */
function buildFlagPoolForRegion(region: string): CountryEntry[] {
  const denorm = denormalizeRegion(region);
  return getFlagPool(denorm as Continent | "world", "all");
}

/* Ortak pas kotası — tur sayısına göre */
function passQuota(totalRounds: number): number {
  if (totalRounds <= 5)  return 3;
  if (totalRounds <= 10) return 5;
  if (totalRounds <= 15) return 7;
  return 10;
}

/* claim sınıflandırma */
const isPassClaim    = (c: DuelClaim) => c.country_code.startsWith("PASS:");
const isTimeoutClaim = (c: DuelClaim) => c.country_code.startsWith("TIMEOUT:");
const isRealAnswer   = (c: DuelClaim) => !isPassClaim(c) && !isTimeoutClaim(c);

/* faz */
type DuelPhase = "lobby" | "creating" | "waiting" | "playing" | "finished";

/* ─── ZAMAN AYARLARI ─── */
const FLAG_TIMEOUT_SEC   = 10;   // her bayrak için süre
const REVEAL_DELAY_MS    = 2000; // cevaptan/timeouttan sonra cevap gösterim süresi
const PASS_REVEAL_MS     = 700;  // ikisi de pas geçince geçiş süresi

interface FlagDuelGameProps {
  onHome: () => void;
  gold: number;
  canBonus: boolean;
  onClaimBonus: () => void;
  onSpendGold: (amount: number) => boolean;
  profile?: Profile | null;
}

/* ════════════════════════════════════════════════════════════════════
   COMPONENT
═════════════════════════════════════════════════════════════════════ */
export default function FlagDuelGame({
  onHome,
  gold,
  canBonus,
  onClaimBonus,
  onSpendGold,
  profile,
}: FlagDuelGameProps) {
  /* identity */
  const myIdRef = useRef<string>("");
  const myId = myIdRef.current;

  /* lobi formu */
  const [playerName, setPlayerName] = useState("");
  const [joinCode,   setJoinCode]   = useState("");
  const loggedInUsername = profile?.username ?? "";
  const effectivePlayerName = loggedInUsername || playerName;
  const isLoggedInPlayer = !!loggedInUsername;
  const [hostRounds, setHostRounds] = useState(10);
  const [hostRegion, setHostRegion] = useState("world");

  /* faz */
  const [phase,    setPhase]    = useState<DuelPhase>("lobby");
  // ── XP (sadece giriş yapmış kullanıcı için, maç başına 1 kez) ──
const [xpResult, setXpResult] = useState<{
  awarded:     boolean;
  xpEarned:    number;
  prevTotalXp: number;
  totalXp:     number;
  prevModeXp:  number;
  modeXp:      number;
  breakdown:   XpBreakdown;
  roomKey:     string;
  dismissed:   boolean;
} | null>(null);
const xpAwardedRef = useRef(false);

// Synthetic match ID — her yeni maçta (lobby→playing) ve her rematch'ta
// üretilir. FlagDuelGame rematch'larda aynı room.id'yi kullanır, o yüzden
// RPC idempotency için ayrı bir match ID gerekir.
const matchIdRef = useRef<string>("");
/* ── Match ID üretimi: oyun başladığında yeni UUID ── */
useEffect(() => {
  if (phase !== "playing") return;
  // Sadece daha önce üretilmemişse üret. Resume/rejoin'de mevcut kalır,
  // ama XP idempotency için bu yeterli (aynı maç = aynı match ID).
  if (!matchIdRef.current) {
    matchIdRef.current = crypto.randomUUID();
  }
}, [phase]);



  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg,setStatusMsg]= useState<string | null>(null);

  /* oda durumu */
  const [room,    setRoom]    = useState<FlagDuelRoom | null>(null);
  const [players, setPlayers] = useState<DuelPlayer[]>([]);
  const [claims,  setClaims]  = useState<DuelClaim[]>([]);
  const [isHost,  setIsHost]  = useState(false);

  /* oyun durumu */
  const [input,    setInput]    = useState("");
  const [feedback, setFeedback] = useState<"correct" | "wrong" | "dup" | null>(null);
  const [copied,   setCopied]   = useState(false);
  const [imgError, setImgError] = useState(false);

  /* quit modal */
  const [quitModalOpen, setQuitModalOpen] = useState(false);
  /* rematch */
const [rematch, setRematch] = useState<"idle" | "requested" | "received" | "declined">("idle");

  /* her bayrak için kalan saniye (her iki client'ta da senkron çalışır) */
  const [timeLeft, setTimeLeft] = useState(FLAG_TIMEOUT_SEC);
  /* yerel "süre bitti" işareti — client'ta hemen UI kilitlemek için */
  const [timedOut, setTimedOut] = useState(false);

  /* bayrak havuzu */
  const [flagPool, setFlagPool] = useState<CountryEntry[]>([]);

  /* gold (online sadece harcama yapar; günlük bonus offline'da claim ediliyor) */


  /* hints — yerel, her tur sıfırlanır */
  const [hints, setHints] = useState<HintState>(EMPTY_HINTS);

  /* refs */
  const phaseRef         = useRef<DuelPhase>("lobby");
  const roomRef          = useRef<FlagDuelRoom | null>(null);
  const claimsRef        = useRef<DuelClaim[]>([]);
  const isHostRef        = useRef(false);
  const flagPoolRef      = useRef<CountryEntry[]>([]);
  const advancingRef     = useRef(false);
  const inputRef         = useRef<HTMLInputElement>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownPlayedRef = useRef(false);

  useEffect(() => { phaseRef.current   = phase;    }, [phase]);
  useEffect(() => { roomRef.current    = room;     }, [room]);
  useEffect(() => { claimsRef.current  = claims;   }, [claims]);
  useEffect(() => { isHostRef.current  = isHost;   }, [isHost]);
  useEffect(() => { flagPoolRef.current= flagPool; }, [flagPool]);
  useEffect(() => {
  if (phase !== "playing") {
    countdownPlayedRef.current = false;
    stopSound("countdown20");
    return;
  }

  if (FLAG_TIMEOUT_SEC <= 20) {
    countdownPlayedRef.current = false;
    stopSound("countdown20");
    return;
  }

  if (timeLeft >= FLAG_TIMEOUT_SEC - 1) {
    countdownPlayedRef.current = false;
    stopSound("countdown20");
    return;
  }

  if (timeLeft <= 20 && timeLeft > 0 && !countdownPlayedRef.current) {
    countdownPlayedRef.current = true;
    playSound("countdown20", { restart: true });
  }

  if (timeLeft <= 0) {
    stopSound("countdown20");
  }
}, [phase, timeLeft]);
useEffect(() => {
  return () => {
    stopSound("countdown20");
  };
}, []);

  /* türetilmiş veriler */
  const myPlayer  = players.find(p => p.id === myId);
  const oppPlayer = players.find(p => p.id !== myId);

  const realClaims = useMemo(
    () => claims.filter(isRealAnswer),
    [claims]
  );
  const myScore  = useMemo(() => realClaims.filter(c => c.player_id === myId).length, [realClaims, myId]);
  const oppScore = useMemo(() => realClaims.filter(c => c.player_id !== myId).length, [realClaims, myId]);
  /* ── Oyun sonu sesi (win / lose) ── */
const resultSoundPlayedRef = useRef(false);
useEffect(() => {
  if (phase !== "finished") {
    resultSoundPlayedRef.current = false;
    return;
  }
  if (resultSoundPlayedRef.current) return;
  resultSoundPlayedRef.current = true;

  if (myScore > oppScore) {
    playSound("win", { restart: true });
  } else if (myScore < oppScore) {
    playSound("lose", { restart: true });
  }
  // Beraberlikte ses yok (DuelGame ile aynı davranış)
}, [phase, myScore, oppScore]);
  /* ── XP: oyun bitince bir kez yaz (sadece giriş yapmış kullanıcı) ── */
useEffect(() => {
  if (phase !== "finished") return;
  if (xpAwardedRef.current) return;
  if (!isLoggedInPlayer || !profile?.id) return;
  if (!matchIdRef.current) return;

  xpAwardedRef.current = true;

  const myScoreFinal  = myScore;
  const oppScoreFinal = oppScore;

  const matchResult = resultFromScores(myScoreFinal, oppScoreFinal);
  const breakdown = calculateFlagDuelXp({
    correctCount: myScoreFinal,
    result: matchResult,
  });

  const profileId  = profile.id;
  const matchId    = matchIdRef.current;
  const realRoomId = room?.id ?? null;

  (async () => {
    const res = await awardXpEvent({
      profileId,
      modeKey:  "flag_duel",
      roomId:   matchId,
      xpEarned: breakdown.total,
      result:   matchResult,
      details: {
        my_score:     myScoreFinal,
        opp_score:    oppScoreFinal,
        breakdown,
        real_room_id: realRoomId,
      },
    });

    if (res.error) {
      xpAwardedRef.current = false;
      console.error("[FlagDuelGame] XP yazılamadı:", res.error);
      return;
    }

    const prevModeXp  = res.awarded ? Math.max(0, res.modeXp  - res.xpEarned) : res.modeXp;
    const prevTotalXp = res.awarded ? Math.max(0, res.totalXp - res.xpEarned) : res.totalXp;

    setXpResult({
      awarded:     res.awarded,
      xpEarned:    res.xpEarned,
      prevTotalXp,
      totalXp:     res.totalXp,
      prevModeXp,
      modeXp:      res.modeXp,
      breakdown,
      roomKey:     matchId,
      dismissed:   false,
    });
  })();
}, [phase, myScore, oppScore, isLoggedInPlayer, profile?.id, room?.id]);

/* ── XP barı: kazandın/kaybettin sesi başladıktan sonra çık ── */
const [xpFooterVisible, setXpFooterVisible] = useState(false);
useEffect(() => {
  if (!xpResult) {
    setXpFooterVisible(false);
    return;
  }
  const t = setTimeout(() => setXpFooterVisible(true), 1200);
  return () => clearTimeout(t);
}, [xpResult]);

  const currentFlag: CountryEntry | null = useMemo(() => {
    if (!room?.current_flag) return null;
    return flagPool.find(f => f.code === room.current_flag) ?? null;
  }, [room?.current_flag, flagPool]);

  const roundKey = room ? `R${room.current_round}:${room.current_flag ?? ""}` : "";

  const passedThisRound = useMemo(() => {
    if (!room?.current_round || !room?.current_flag) return new Set<string>();
    // Yeni format: PASS:R{round}:{flagCode}:{playerId}
    const prefix = `PASS:R${room.current_round}:${room.current_flag}:`;
    const set = new Set<string>();
    claims.forEach(c => {
      if (c.country_code.startsWith(prefix)) set.add(c.player_id);
    });
    return set;
  }, [claims, room?.current_round, room?.current_flag]);

  const winnerOfThisRound = useMemo(() => {
    if (!room?.current_flag) return null;
    return realClaims.find(c => c.country_code === room.current_flag) ?? null;
  }, [realClaims, room?.current_flag]);

  /* tur "TIMEOUT" ile mi bitti? */
  const timeoutOfThisRound = useMemo(() => {
    if (!room?.current_round || !room?.current_flag) return null;
    const code = `TIMEOUT:R${room.current_round}:${room.current_flag}`;
    return claims.find(c => c.country_code === code) ?? null;
  }, [claims, room?.current_round, room?.current_flag]);

  const myPassed      = passedThisRound.has(myId);
  const oppPassed     = oppPlayer ? passedThisRound.has(oppPlayer.id) : false;

  const roundAnswered = winnerOfThisRound !== null;
  const roundTimedOut = timeoutOfThisRound !== null;
  const roundResolved = roundAnswered || roundTimedOut;
  const iAnswered     = roundAnswered && winnerOfThisRound!.player_id === myId;
  const isPlaying     = phase === "playing" && !roundResolved && !myPassed && !timedOut;

  /* etiketler */
  const gameRegion  = room?.region ?? hostRegion;
  const regionUiVal = denormalizeRegion(gameRegion);
  const continentLabel = CONTINENT_OPTIONS_UI.find(c => c.value === regionUiVal)?.label ?? "🌍 Dünya";
  const totalRounds = room?.total_rounds ?? hostRounds;
  const roundsLabel = `🎯 ${totalRounds} Tur`;

  /* Tamamlanmış ortak pas sayısı ve kalan hak
     Format: PASS:R{round}:{flagCode}:{playerId} → parts[2] = flagCode */
  const completedPasses = useMemo(() => {
    const passByFlag = new Map<string, Set<string>>();
    claims.filter(isPassClaim).forEach(c => {
      const parts = c.country_code.split(":");
      if (parts.length >= 4) {
        const roundNum = parseInt(parts[1].slice(1), 10);
        if (roundNum <= totalRounds) {
          const flagCode = parts[2];
          if (!passByFlag.has(flagCode)) passByFlag.set(flagCode, new Set());
          passByFlag.get(flagCode)!.add(c.player_id);
        }
      }
    });
    let count = 0;
    passByFlag.forEach(players => { if (players.size >= 2) count++; });
    return count;
  }, [claims, totalRounds]);

  const passesRemaining = passQuota(totalRounds) - completedPasses;

  /* davet linki */
  const shareLink = room ? `${location.origin}${location.pathname}?flagDuel=${room.code}` : "";

  /* feedback flash */
  const showFeedback = useCallback((type: "correct" | "wrong" | "dup") => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    setFeedback(type);
    feedbackTimerRef.current = setTimeout(() => setFeedback(null), 700);
  }, []);

  /* her yeni tur → hints + timedOut sıfırla */
  useEffect(() => {
    setHints(EMPTY_HINTS);
    setTimedOut(false);
  }, [roundKey]);

  /* joker satın alma */
 const handleBuyHint = useCallback((type: HintType) => {
  const cost = HINT_COSTS[type];

  if (!onSpendGold(cost)) return;

  setHints(prev => ({ ...prev, [type]: true }));
}, [onSpendGold]);

  /* havuzu hazırla */
  const buildPool = useCallback((region: string) => {
    const pool = shuffle(buildFlagPoolForRegion(region));
    setFlagPool(pool);
    flagPoolRef.current = pool;
    return pool;
  }, []);

  /* ════════════════════════════════════════════════════════════════
     HOST: TURU İLERLET
  ════════════════════════════════════════════════════════════════ */
  const advanceRoundAsHost = useCallback(async (reason: "answered" | "both_passed" | "timeout") => {
    if (advancingRef.current) return;
    if (!isHostRef.current) return;
    const r = roomRef.current;
    if (!r) return;
    advancingRef.current = true;

    try {
      const { data: freshClaims } = await supabase
        .from("duel_claims").select("*").eq("room_id", r.id);
      const cs = (freshClaims ?? []) as DuelClaim[];

      const usedFlagCodes = new Set<string>();
      cs.forEach(c => {
        if (isPassClaim(c) || isTimeoutClaim(c)) {
          // PASS:R{n}:{flagCode}:{playerId} → parts[2] = flagCode
          // TIMEOUT:R{n}:{flagCode}          → parts[2] = flagCode
          const parts = c.country_code.split(":");
          if (parts.length >= 3) usedFlagCodes.add(parts[2]);
        } else {
          usedFlagCodes.add(c.country_code);
        }
      });

      const pool = flagPoolRef.current;
      const inGolden = r.is_golden_round && r.current_round > r.total_rounds;

      // ── BOTH_PASSED: tur sayacı artmaz, sadece bayrak ve timer değişir ──
      if (reason === "both_passed") {
        if (!inGolden) {
          // Normal tur: kotayı fresh claims üzerinden kontrol et
          const passByFlag = new Map<string, Set<string>>();
          cs.filter(isPassClaim).forEach(c => {
            const parts = c.country_code.split(":");
            if (parts.length >= 4) {
              const roundNum = parseInt(parts[1].slice(1), 10);
              if (roundNum <= r.total_rounds) {
                const flagCode = parts[2];
                if (!passByFlag.has(flagCode)) passByFlag.set(flagCode, new Set());
                passByFlag.get(flagCode)!.add(c.player_id);
              }
            }
          });
          const completedPassCount = [...passByFlag.values()].filter(p => p.size >= 2).length;
          if (completedPassCount > passQuota(r.total_rounds)) {
            dbgErr("both_passed: pas kotası aşıldı, atlandı");
            return;
          }
        }
        const nextFlag = pool.find(f => !usedFlagCodes.has(f.code));
        if (!nextFlag) { dbgErr("both_passed: bayrak havuzu tükendi"); return; }
        await supabase.from("duel_rooms").update({
          current_flag: nextFlag.code,
          current_flag_at: new Date().toISOString(),
        } as Partial<FlagDuelRoom>).eq("id", r.id);
        return;
      }

      // ── ANSWERED / TIMEOUT: tur ilerle ──────────────────────────────────
      const nextFlag = pool.find(f => !usedFlagCodes.has(f.code));
      const nextRoundNum = r.current_round + 1;

      if (!inGolden && nextRoundNum > r.total_rounds) {
        const realCs = cs.filter(isRealAnswer);
        const counts: Record<string, number> = {};
        realCs.forEach(c => {
          counts[c.player_id] = (counts[c.player_id] ?? 0) + 1;
        });
        const { data: freshPlayers } = await supabase
          .from("duel_players").select("id").eq("room_id", r.id);
        const ids = (freshPlayers ?? []).map(p => p.id);
        const sA = counts[ids[0]] ?? 0;
        const sB = counts[ids[1]] ?? 0;

        if (sA === sB) {
          await supabase.from("duel_rooms").update({
            current_round: nextRoundNum,
            current_flag: nextFlag?.code ?? null,
            current_flag_at: new Date().toISOString(),
            is_golden_round: true,
            winner_player_id: null,
            finished_reason: null,
          }).eq("id", r.id);
          return;
        }

        const winner = sA > sB ? ids[0] : ids[1];
        await supabase.from("duel_rooms").update({
          status: "finished",
          finished_reason: "score",
          winner_player_id: winner,
        }).eq("id", r.id);
        return;
      }

      if (inGolden && reason === "answered") {
        const goldenClaims = cs.filter(
          c => isRealAnswer(c) && c.country_code === r.current_flag
        );
        const goldenWinnerClaim = goldenClaims[goldenClaims.length - 1];
        await supabase.from("duel_rooms").update({
          status: "finished",
          finished_reason: "score",
          winner_player_id: goldenWinnerClaim?.player_id ?? null,
        }).eq("id", r.id);
        return;
      }

      await supabase.from("duel_rooms").update({
        current_round: nextRoundNum,
        current_flag:  nextFlag!.code,
        current_flag_at: new Date().toISOString(),
        is_golden_round: inGolden,
      } as Partial<FlagDuelRoom>).eq("id", r.id);
    } catch (e) {
      dbgErr("advanceRoundAsHost failed", e);
    } finally {
      setTimeout(() => { advancingRef.current = false; }, 1000);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players]);

  // ─── REMATCH FONKSİYONLARI ───────────────────────────────────────────
  
  const requestRematch = useCallback(() => {
  if (!room) return;
  setRematch("requested");
  supabase.channel(`flagduel:${room.id}`).send({
    type: "broadcast",
    event: "rematch_request",
    payload: { from: myIdRef.current },
  });
}, [room]);

const acceptRematch = useCallback(async () => {
  if (!room) return;
  console.log("REMATCH BAŞLIYOR, room:", room.id, "status:", room.status, "is_golden:", room.is_golden_round);
  // XP idempotency için yeni match ID — rematch aynı odada olduğu için şart.
matchIdRef.current = crypto.randomUUID();
setXpResult(null); xpAwardedRef.current = false;
  setRematch("idle");
  setInput("");
  setFeedback(null);
  setTimedOut(false);
  setImgError(false);
  setClaims([]);
  advancingRef.current = false;

  // Pool'u kur ve ilk bayrağı seç
  const pool = buildPool(room.region);
  const firstFlag = isHostRef.current ? pool[0] : null;

  await supabase.from("duel_claims").delete().eq("room_id", room.id);
  await supabase.from("duel_players").update({ score: 0 }).eq("room_id", room.id);

  // Host ise current_flag'i de set et, böylece golden tur mantığına hiç girmez
  await supabase.from("duel_rooms").update({
    status: "playing",
    current_round: 1,
    current_flag: firstFlag?.code ?? null,
    current_flag_at: firstFlag ? new Date().toISOString() : null,
    is_golden_round: false,
    winner_player_id: null,
    finished_reason: null,
  } as Partial<FlagDuelRoom>).eq("id", room.id);

  // roomRef'i de güncelle ki sonraki advanceRoundAsHost çağrıları temiz state okusun
  if (isHostRef.current && firstFlag) {
    roomRef.current = {
      ...room,
      status: "playing",
      current_round: 1,
      current_flag: firstFlag.code,
      current_flag_at: new Date().toISOString(),
      is_golden_round: false,
      winner_player_id: null,
      finished_reason: null,
    };
  }

  supabase.channel(`flagduel:${room.id}`).send({
    type: "broadcast",
    event: "rematch_accepted",
    payload: {},
  });

  setPhase("playing");
}, [room, buildPool]);

const declineRematch = useCallback(() => {
  if (!room) return;
  supabase.channel(`flagduel:${room.id}`).send({
    type: "broadcast",
    event: "rematch_declined",
    payload: {},
  });
  setRematch("idle");
}, [room]);

  /* ════════════════════════════════════════════════════════════════
     REALTIME
  ════════════════════════════════════════════════════════════════ */
  useEffect(() => {
    if (!room) return;
    const roomId = room.id;

    const chan = supabase.channel(`flagduel:${roomId}`)
      .on("broadcast", { event: "rematch_request" }, (payload) => {
    if (payload.payload?.from !== myIdRef.current) {
      setRematch("received");
    }
  })
  .on("broadcast", { event: "rematch_declined" }, () => {
    setRematch("declined");
  })
.on("broadcast", { event: "rematch_accepted" }, () => {
  // XP idempotency için yeni match ID — bu taraf da rematch'ı kabul etti
  matchIdRef.current = crypto.randomUUID();
  setXpResult(null); xpAwardedRef.current = false;
  setRematch("idle");
  setInput("");
  setFeedback(null);
  setTimedOut(false);
  setImgError(false);
  setClaims([]);
  advancingRef.current = false;
  // Rakip tarafı da kendi pool'unu yeniden kursun
  if (roomRef.current) {
    buildPool(roomRef.current.region);
  }
  setPhase("playing");
})
      .on("postgres_changes",
  { event: "UPDATE", schema: "public", table: "duel_rooms", filter: `id=eq.${roomId}` },
  (payload) => {
    const r = payload.new as FlagDuelRoom;
    setRoom(r);
    setImgError(false);

    if (r.status === "playing") {
      if (flagPoolRef.current.length === 0) buildPool(r.region);
      if (phaseRef.current !== "playing") setPhase("playing");
      if (isHostRef.current && !r.current_flag && r.current_round === 1) {
  roomRef.current = r; // ✅ önce ref'i güncelle
  advanceRoundAsHost("both_passed");
}
    }

    if (r.status === "finished") {
      clearSession();
      setPhase("finished");
    }
  }
)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "duel_players", filter: `room_id=eq.${roomId}` },
        (payload) => {
          setPlayers(prev => {
            if (prev.some(p => p.id === (payload.new as DuelPlayer).id)) return prev;
            return [...prev, payload.new as DuelPlayer];
          });
        }
      )
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "duel_claims", filter: `room_id=eq.${roomId}` },
        async (payload) => {
          const c = payload.new as DuelClaim;
          setClaims(prev => prev.some(x => x.id === c.id) ? prev : [...prev, c]);

          if (!isHostRef.current) return;
          const r = roomRef.current;
          if (!r) return;
          const currentFlagCode = r.current_flag;
          if (!currentFlagCode) return;

          // 1) Doğru cevap geldi → 2 sn göster, ilerlet
          if (isRealAnswer(c) && c.country_code === currentFlagCode) {
            await new Promise(res => setTimeout(res, REVEAL_DELAY_MS));
            await advanceRoundAsHost("answered");
            return;
          }

          // 2) TIMEOUT claim'i geldi (host kendi atmış olur) → cevabı 2 sn
          //    göster, sonra ilerlet
          if (c.country_code === `TIMEOUT:R${r.current_round}:${currentFlagCode}`) {
            await new Promise(res => setTimeout(res, REVEAL_DELAY_MS));
            await advanceRoundAsHost("timeout");
            return;
          }

          // 3) Pas geldi → mevcut bayrak için ikisi de pas mı?
          const currentPassPrefix = `PASS:R${r.current_round}:${currentFlagCode}:`;
          if (c.country_code.startsWith(currentPassPrefix)) {
            const { data: latestClaims } = await supabase
              .from("duel_claims")
              .select("*")
              .eq("room_id", r.id);
            const passers = new Set(
              ((latestClaims ?? []) as DuelClaim[])
                .filter(x => x.country_code.startsWith(currentPassPrefix))
                .map(x => x.player_id)
            );
            if (passers.size >= 2) {
              await new Promise(res => setTimeout(res, PASS_REVEAL_MS));
              await advanceRoundAsHost("both_passed");
            }
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(chan); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id]);

  /* ════════════════════════════════════════════════════════════════
     BAYRAK ZAMANLAYICISI
     - Her iki client da room.current_flag_at'e bakar → senkron sayaç
     - Süre bitince yerel olarak input KİLİTLENİR ama cevap reveal EDİLMEZ
       (rakip hâlâ yazıyor olabilir; cevabı görmek cheat olur)
     - Süre dolunca SADECE host DB'ye "TIMEOUT" claim'i atar.
       Bu claim her iki client'ta da realtime ile görünür → roundResolved=true
       olur ve cevap o zaman gösterilir.
  ════════════════════════════════════════════════════════════════ */
  useEffect(() => {
    if (phase !== "playing") return;
    if (!room?.current_flag_at) {
      setTimeLeft(FLAG_TIMEOUT_SEC);
      return;
    }
    if (roundResolved) return;

    const startMs = new Date(room.current_flag_at).getTime();
    const totalMs = FLAG_TIMEOUT_SEC * 1000;
    let cancelled = false;
    let timeoutClaimSent = false;

    const tick = async () => {
      if (cancelled) return;
      const elapsed   = Date.now() - startMs;
      const remaining = Math.max(0, Math.ceil((totalMs - elapsed) / 1000));
      setTimeLeft(remaining);

      if (elapsed >= totalMs) {
        // Süre doldu: input kilitle (cevap GÖSTERME!)
        if (!timedOut) setTimedOut(true);

        // Sadece host bir kez TIMEOUT claim'i atar — bu claim her iki client'a
        // realtime ile gelir ve cevabı orada açar.
        if (isHostRef.current && !timeoutClaimSent && !roundResolved) {
          const r = roomRef.current;
          if (r && r.current_flag) {
            const alreadyAnswered = claimsRef.current.some(c =>
              c.country_code === r.current_flag &&
              !c.country_code.startsWith("PASS:") &&
              !c.country_code.startsWith("TIMEOUT:")
            );
            const alreadyTimedOut = claimsRef.current.some(c =>
              c.country_code === `TIMEOUT:R${r.current_round}:${r.current_flag}`
            );
            if (!alreadyAnswered && !alreadyTimedOut) {
              timeoutClaimSent = true;
              await supabase.from("duel_claims").insert({
                room_id: r.id,
                player_id: myIdRef.current,
                country_code: `TIMEOUT:R${r.current_round}:${r.current_flag}`,
              });
            }
          }
        }
        return;
      }

      if (!cancelled) setTimeout(tick, 250);
    };

    tick();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, room?.current_flag_at, roundResolved]);

  /* ════════════════════════════════════════════════════════════════
     ODA KUR
  ════════════════════════════════════════════════════════════════ */
  const createRoom = async () => {
    const name = effectivePlayerName.trim();
const usernameError = validateUsername(name);

if (usernameError) {
  setErrorMsg(usernameError);
  setStatusMsg(null);
  setPhase("lobby");
  return;
}
    setErrorMsg(null); setStatusMsg("Oda kuruluyor…"); setPhase("creating");

    clearSession();
    const freshId = freshPlayerId();
    myIdRef.current = freshId;
    const code = makeCode();

    const { data: roomData, error: roomErr } = await supabase
      .from("duel_rooms")
      .insert({
        code, status: "waiting",
        duration_seconds: 60,
        region: normalizeRegion(hostRegion),
        total_rounds: hostRounds,
        current_round: 0,
        is_golden_round: false,
        current_flag: null,
      })
      .select("*").single();

    if (roomErr || !roomData?.id) {
      dbgErr("createRoom failed", roomErr);
      setErrorMsg("Oda oluşturulamadı. Tekrar dene."); setStatusMsg(null); setPhase("lobby"); return;
    }
    const r = roomData as FlagDuelRoom;

    const { error: pErr } = await supabase
      .from("duel_players")
      .insert({ id: freshId, room_id: r.id, name, score: 0 });

    if (pErr) {
      dbgErr("createRoom player insert failed", pErr);
      supabase.from("duel_rooms").delete().eq("id", r.id).then(() => {});
      setErrorMsg("Oda oluşturulamadı. Tekrar dene."); setStatusMsg(null); setPhase("lobby"); return;
    }

    const { data: pls } = await supabase.from("duel_players").select("*").eq("room_id", r.id);
    setRoom(r);
    setPlayers(pls ?? []);
    setClaims([]);
    setIsHost(true); isHostRef.current = true;
    saveSession(r.id, r.code, freshId);
    buildPool(r.region);
    setStatusMsg(null);
    setPhase("waiting");
  };

  /* ════════════════════════════════════════════════════════════════
     ODAYA KATIL
  ════════════════════════════════════════════════════════════════ */
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

    const saved = loadSession();
    const joinId: string = (saved?.roomCode === code && saved?.playerId)
      ? saved.playerId
      : freshPlayerId();
    if (joinId !== saved?.playerId) clearSession();
    myIdRef.current = joinId;

    const { data: roomData } = await supabase
      .from("duel_rooms").select("*").eq("code", code).single();

    if (!roomData?.id) { setErrorMsg("Oda bulunamadı. Kodu kontrol et."); setStatusMsg(null); return; }
    const r = roomData as FlagDuelRoom;
    if (r.status === "finished") { setErrorMsg("Bu oda zaten kapandı."); setStatusMsg(null); return; }

    const { data: existPlayers } = await supabase.from("duel_players").select("*").eq("room_id", r.id);
    const alreadyIn = existPlayers?.some(p => p.id === joinId);
    if (!alreadyIn) {
      if ((existPlayers?.length ?? 0) >= 2) { setErrorMsg("Bu oda dolu."); setStatusMsg(null); return; }
      const { error: pErr } = await supabase.from("duel_players")
        .insert({ id: joinId, room_id: r.id, name, score: 0 });
      if (pErr) { dbgErr("joinRoom player insert failed", pErr); setErrorMsg("Odaya katılınamadı."); setStatusMsg(null); return; }
    }

    const { data: pls } = await supabase.from("duel_players").select("*").eq("room_id", r.id);
    const { data: cs }  = await supabase.from("duel_claims").select("*").eq("room_id", r.id);
    setRoom(r);
    setPlayers(pls ?? []);
    setClaims(cs ?? []);
    setIsHost(false); isHostRef.current = false;
    setXpResult(null); xpAwardedRef.current = false; matchIdRef.current = "";
    saveSession(r.id, r.code, joinId);
    buildPool(r.region);
    setStatusMsg(null);
    setPhase(r.status === "playing" ? "playing" : "waiting");
  };

  /* ════════════════════════════════════════════════════════════════
     OYUNU BAŞLAT
  ════════════════════════════════════════════════════════════════ */
  const startGame = async () => {
    if (!room || !isHost) return;
    const pool = flagPoolRef.current.length > 0 ? flagPoolRef.current : buildPool(room.region);
    const firstFlag = pool[0];
    if (!firstFlag) return;

    await supabase.from("duel_rooms").update({
      status: "playing",
      started_at: new Date().toISOString(),
      current_round: 1,
      current_flag: firstFlag.code,
      current_flag_at: new Date().toISOString(),
      is_golden_round: false,
    } as Partial<FlagDuelRoom>).eq("id", room.id);
  };

  /* ════════════════════════════════════════════════════════════════
     CEVAP / PAS
  ════════════════════════════════════════════════════════════════ */
  const handleGuess = async () => {
    if (phaseRef.current !== "playing") return;
    if (!room || !currentFlag) return;
    if (roundResolved || myPassed) return;

    const norm = normalizeInput(input);
    if (!norm) return;

    const entry = NAME_TO_ENTRY[norm];
    if (!entry || entry.code !== currentFlag.code) {
      showFeedback("wrong"); setInput(""); return;
    }
    setInput("");

    if (claimsRef.current.some(c =>
      c.country_code === currentFlag.code && !c.country_code.startsWith("PASS:")
    )) { showFeedback("dup"); return; }

    const { error } = await supabase.from("duel_claims").insert({
      room_id: room.id,
      player_id: myIdRef.current,
      country_code: currentFlag.code,
    });
    if (error) {
      if (error.code === "23505") showFeedback("dup");
      else { dbgErr("claim insert failed", error); showFeedback("wrong"); }
    } else { showFeedback("correct"); }
  };

  const handlePass = async () => {
    if (phaseRef.current !== "playing") return;
    if (!room || !currentFlag) return;
    if (roundResolved || myPassed) return;
    if (passesRemaining <= 0 && !room.is_golden_round) return;

    const passCode = `PASS:R${room.current_round}:${currentFlag.code}:${myIdRef.current}`;
    const { error } = await supabase.from("duel_claims").insert({
      room_id: room.id, player_id: myIdRef.current, country_code: passCode,
    });
    if (error) dbgErr("pass insert failed", error);
  };

  /* ESC = pas */
  useEffect(() => {
    if (phase !== "playing") return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") handlePass(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, myPassed, roundResolved, currentFlag, room?.current_round, completedPasses]);

  /* her tur değişiminde input'a focus */
  useEffect(() => {
    if (phase === "playing" && !roundResolved && !myPassed) {
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [phase, roundKey, roundResolved, myPassed]);

  /* ayrıl */
  const handleLeave = async () => {
    clearSession();
    if (room && phase === "playing") {
      await supabase.from("duel_rooms").update({
        status: "finished",
        finished_reason: "forfeit",
        forfeited_player_id: myIdRef.current,
        winner_player_id: oppPlayer?.id ?? null,
      }).eq("id", room.id);
    } else if (room && isHost && phase === "waiting") {
      await supabase.from("duel_players").delete().eq("room_id", room.id);
      await supabase.from("duel_rooms").delete().eq("id", room.id);
    } else if (room && !isHost && phase === "waiting") {
      await supabase.from("duel_players").delete().eq("id", myIdRef.current).eq("room_id", room.id);
    }
    onHome();
  };

  const backToLobby = async () => {
    await handleLeave();
    setRoom(null); setPlayers([]); setClaims([]);
    setIsHost(false); isHostRef.current = false;
    setPhase("lobby");
    setErrorMsg(null); setStatusMsg(null);
  };

  /* davet kopyala */
  const copyInvite = async () => {
    if (!room) return;
    const msg = `Torble Bayrak Modu Online 1v1! 🚩
Mod: ${continentLabel} · ${roundsLabel}
Oda kodu: ${room.code}

${shareLink}`;
    try {
      await navigator.clipboard.writeText(msg);
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Linki kopyala:", shareLink);
    }
  };

  /* sonuç */
  const resolveResult = (): { emoji: string; title: string; subtitle: string | null } => {
    if (!room) return { emoji: "🏁", title: "Bitti", subtitle: null };
    const w = room.winner_player_id;
    const reason = room.finished_reason;
    if (reason === "forfeit") {
      if (room.forfeited_player_id === myId) return { emoji: "🏳️", title: "Kaybettin", subtitle: "Pes ettin." };
      return { emoji: "🏆", title: "Kazandın!", subtitle: "Rakip pes etti." };
    }
    if (w === myId) return { emoji: "🏆", title: "Kazandın!", subtitle: room.is_golden_round ? "Altın turda kazandın!" : null };
    if (w && w !== myId) return { emoji: "😔", title: "Kaybettin", subtitle: room.is_golden_round ? "Altın turu rakip aldı." : null };
    return { emoji: "🤝", title: "Berabere", subtitle: "Eşit skor." };
  };
  const result = resolveResult();

  /* render değerleri */
  const flagSrc = currentFlag ? `/assets/flags/${currentFlag.code}.svg` : "";
  const placeholder =
    roundResolved ? "Sıradaki tur…"
    : myPassed    ? "Pas geçildi…"
    :               "Bu bayrağın ülkesi? (Enter)";
  const inputRowClass = ["bar-row bar-input", feedback ?? ""].filter(Boolean).join(" ");

  return (
    <div className={"app duel-screen" + (phase === "playing" ? " duel-game-active" : "")}>

      {/* ════════ HEADER (lobby/waiting için — finished'da playing UI arka planda) ════════ */}
      {phase !== "playing" && phase !== "finished" && (
        <div className="duel-header">
          <button className="back-btn" onClick={handleLeave}>
            <span>←</span><span className="back-label">Menü</span>
          </button>
          <div className="duel-header-center">
            <span className="duel-mode-label">🚩 Bayrak 1v1</span>
            {room && phase !== "lobby" && (
              <>
                <span className="duel-code-badge">#{room.code}</span>
                <span className="duel-region-badge">{continentLabel}</span>
              </>
            )}
          </div>
          <div style={{ width: 44 }}/>
        </div>
      )}

      {/* ════════ LOBBY ════════ */}
      {(phase === "lobby" || phase === "creating") && (
        <div className="duel-lobby">
          <div className="duel-lobby-card">
            <h2 className="duel-lobby-title">🚩 Bayrak 1v1</h2>
            <p className="duel-lobby-desc">
              Aynı bayrağı görürsünüz — ilk doğru yazan turu alır!<br/>
              Skor eşit biterse <strong>altın tur</strong> başlar. ⚜️
            </p>

            <div className="duel-field-row">
              <label className="duel-field-label">Oyuncu Adın</label>
              <input
  className="duel-name-input"
  type="text"
  placeholder="Adını gir..."
  value={isLoggedInPlayer ? loggedInUsername : playerName}
  onChange={(e) => {
    if (isLoggedInPlayer) return;
    setPlayerName(e.target.value);
  }}
  disabled={isLoggedInPlayer}
  maxLength={20}
  autoComplete="off"
  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
/>
            </div>

            <div className="duel-settings-block">
              <p className="duel-settings-title">🏠 Oda Kur</p>
              <div className="duel-selects-row">
                <div className="duel-select-wrap">
                  <label className="duel-select-label">Tur Sayısı</label>
                  <div className="duel-select-box">
                    <select className="duel-select" value={hostRounds}
                      onChange={e => setHostRounds(Number(e.target.value))}>
                      {ROUND_OPTS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <span className="duel-select-caret">▾</span>
                  </div>
                </div>
                <div className="duel-select-wrap">
                  <label className="duel-select-label">Bölge</label>
                  <div className="duel-select-box">
                    <select className="duel-select" value={hostRegion}
                      onChange={e => setHostRegion(e.target.value)}>
                      {REGION_OPTS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <span className="duel-select-caret">▾</span>
                  </div>
                </div>
              </div>
              <button className="btn btn-accent duel-create-btn"
                onClick={createRoom} disabled={phase === "creating"}>
                {phase === "creating" ? "Kuruluyor…" : "🏠 Oda Kur"}
              </button>
            </div>

            <div className="duel-section-divider">veya mevcut bir odaya katıl</div>

            <div className="duel-join-block">
              <div className="duel-join-row">
                <input className="duel-code-input" type="text" placeholder="ODA KODU"
                  value={joinCode}
                  onChange={e => setJoinCode(e.target.value.toUpperCase())}
                  maxLength={6} autoComplete="off"
                  onKeyDown={e => { if (e.key === "Enter") joinRoom(); }}
                />
                <button className="btn btn-danger" onClick={joinRoom}>Katıl</button>
              </div>
            </div>

            {errorMsg  && <p className="duel-error">{errorMsg}</p>}
            {statusMsg && <p className="duel-status">{statusMsg}</p>}
          </div>
        </div>
      )}

      {/* ════════ WAITING ════════ */}
      {phase === "waiting" && room && (
        <div className="duel-lobby">
          <div className="duel-lobby-with-chat">
            <div className="duel-lobby-card">
              <h2 className="duel-lobby-title">Rakip Bekleniyor…</h2>

              <div className="duel-room-code-block">
                <span className="duel-room-code">{room.code}</span>
                <p className="duel-room-code-hint">6 haneli kod — arkadaşına ver</p>
              </div>

              <button className={"btn duel-invite-btn" + (copied ? " invited" : "")}
                onClick={copyInvite}>
                {copied ? "✓ Davet mesajı kopyalandı!" : "📋 Davet Mesajını Kopyala"}
              </button>

              <div className="duel-link-preview" onClick={e => {
                const el = e.currentTarget.querySelector("input") as HTMLInputElement | null;
                el?.select();
              }}>
                <input className="duel-link-input" readOnly value={shareLink}
                  onFocus={e => e.target.select()} />
              </div>

              <div className="duel-settings-summary">
                <span>{roundsLabel}</span>
                <span className="duel-sum-dot">·</span>
                <span>{continentLabel}</span>
              </div>

              <div className="duel-players-list">
                {players.map(p => (
                  <div key={p.id}
                    className={"duel-player-chip" + (p.id === myId ? " mine" : "")}>
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
            </div>

            <LobbyChat roomCode={room.code} playerName={myPlayer?.name ?? effectivePlayerName} />
          </div>
        </div>
      )}

      {/* ════════ PLAYING (finished'da da render — arka plan blur'lansın) ════════ */}
      {(phase === "playing" || phase === "finished") && (
        <>
          {/* ── TopBar (offline kopyası) ── */}
          <div className="control-bar">
            <GoldBar
  gold={gold}
  canBonus={canBonus}
  onClaimBonus={onClaimBonus}
/>
            {/* Row 1 */}
            <div className="bar-row bar-top">
              <button className="back-btn" onClick={() => setQuitModalOpen(true)} title="Çıkış">
                <span>←</span><span className="back-label">Menü</span>
              </button>

              <div className="bar-dropdowns">
                {/* Bölge: oyun başladığı için disabled, sadece görsel */}
                <Dropdown label={continentLabel} disabled={true}>
                  {CONTINENT_OPTIONS_UI.map(opt => (
                    <DDItem key={opt.value} active={regionUiVal === opt.value} onClick={() => {}}>
                      {opt.label}
                    </DDItem>
                  ))}
                </Dropdown>
                {/* Tur bilgisi (durum göstergesi) */}
                <Dropdown
                  label={room?.is_golden_round ? "⚜️ Altın Tur" : `Tur ${room?.current_round}/${room?.total_rounds}`}
                  disabled={true} align="right">
                  <div className="dd-section-label">Maç Bilgisi</div>
                  <DDItem active={false} onClick={() => {}}>
                    {room?.total_rounds} tur · {continentLabel}
                  </DDItem>
                </Dropdown>
              </div>

              <div className="bar-right">
                {/* VS skor pill */}
                <div className="score-pill" title="Skor">
                  <span className="score-n">{myScore}</span>
                  <span className="score-sep">:</span>
                  <span className="score-total">{oppScore}</span>
                  <span className="score-lbl">{oppPlayer?.name ?? "rakip"}</span>
                </div>
                {/* Bayrak süresi sayacı — yeşil → sarı → kırmızı */}
                {(() => {
                  const timerColor =
                    timedOut ? "#ef4444"
                    : timeLeft > FLAG_TIMEOUT_SEC * 0.5 ? "var(--accent)"
                    : timeLeft > FLAG_TIMEOUT_SEC * 0.3 ? "#f59e0b"
                    : "#ef4444";
                  const timerPct = (timeLeft / FLAG_TIMEOUT_SEC) * 100;
                  return (
                    <div className="timer-ring-wrap">
                      <svg viewBox="0 0 42 42" className="timer-svg">
                        <circle cx="21" cy="21" r="17" fill="none" stroke="var(--border)" strokeWidth="3" />
                        <circle cx="21" cy="21" r="17" fill="none"
                          stroke={timerColor} strokeWidth="3" strokeDasharray="106.8"
                          strokeDashoffset={106.8 - (timerPct / 100) * 106.8}
                          strokeLinecap="round"
                          style={{ transform: "rotate(-90deg)", transformOrigin: "50% 50%", transition: "stroke-dashoffset 0.9s linear, stroke 0.4s" }} />
                      </svg>
                      <span className="timer-num" style={{ color: timerColor }}>
                        {timeLeft}
                      </span>
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Row 2: input */}
            <div className={inputRowClass}>
              <input ref={inputRef} type="text" className="guess-input"
                placeholder={placeholder} value={input}
                disabled={!isPlaying}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleGuess(); }}
                autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} />
              {isPlaying && (
                <>
                  <button className="btn btn-accent" onClick={handleGuess}>Gir</button>
                  <button className="btn btn-skip" onClick={handlePass} title="Pas Geç (ESC)">Pas</button>
                </>
              )}
            </div>

            {/* Row 3: feedback + best/info */}
            <div className="bar-row bar-bottom">
              <div className="feedback-slot">
                {feedback === "correct" && <span className="fb fb-ok">✓ Doğru! Turu aldın.</span>}
                {feedback === "wrong"   && <span className="fb fb-no">✗ Yanlış cevap</span>}
                {feedback === "dup"     && <span className="fb fb-dup">Rakip önce bildi</span>}

                {/* Tur kapanmış (cevaplandı veya süre doldu) → cevabı göster */}
                {!feedback && roundResolved && roundAnswered && (
  <span className={iAnswered ? "fb fb-ok" : "fb fb-no"}>
    {iAnswered ? "✓ Sen bildin" : "✕ Rakip bildi"} · {currentFlag?.display}
  </span>
)}

{!feedback && roundResolved && roundTimedOut && (
  <span className="fb fb-timeout">
    ⏰ Süre doldu · Cevap: {currentFlag?.display}
  </span>
)}

                {/* Cevap GELMEDEN, sadece kendi sürem doldu / pas geçtim → cevabı VERME */}
                {!feedback && !roundResolved && timedOut && (
                  <span className="fb fb-hint">⏳ Süren doldu — rakibi bekliyoruz…</span>
                )}
                {!feedback && !roundResolved && !timedOut && myPassed && (
                  <span className="fb fb-hint">Pas geçtin — rakibi bekliyoruz…</span>
                )}
              </div>

              {/* Altın tur rozeti */}
              {room?.is_golden_round && (
                <div className="diff-badge" style={{ borderColor: "#fbbf24", color: "#fbbf24" }}>
                  ⚜️ Altın Tur
                </div>
              )}
            </div>
          </div>

          {/* HintPanel (jokerler) — ancak benim için hala aktif tursa göster */}
          <HintPanel
            gold={gold}
            hints={hints}
            currentEntry={currentFlag}
            isPlaying={isPlaying}
            onBuyHint={handleBuyHint}
          />

          {/* Pas Geç bar */}
          {isPlaying && (
            <div className="pas-gec-bar">
              {room?.is_golden_round ? (
                <button className="btn-pas-gec" onClick={handlePass}>
                  <span>⏭️</span> Pas Geç
                </button>
              ) : passesRemaining > 0 ? (
                <button className="btn-pas-gec" onClick={handlePass}>
                  <span>⏭️</span> Pas Geç ({passesRemaining} kaldı)
                </button>
              ) : (
                <button className="btn-pas-gec" disabled style={{ opacity: 0.4, cursor: "not-allowed" }}>
                  <span>⏭️</span> Pas hakkı bitti
                </button>
              )}
              <span className="pas-gec-hint">ESC</span>
              {oppPassed && (
                <span className="pas-gec-answer" style={{ marginLeft: "auto" }}>
                  ⚠️ Rakip pas geçmek istiyor!
                </span>
              )}
            </div>
          )}
          {!isPlaying && myPassed && !roundResolved && (
            <div className="pas-gec-bar">
              <span className="pas-gec-answer">
                {oppPassed
                  ? "⏭️ Bayrak pas geçildi — yeni bayrak geliyor…"
                  : "⏳ Pas isteğin gönderildi — rakip bekleniyor…"}
              </span>
            </div>
          )}

          {/* Bayrak alanı */}
          <div className="flag-area">
            {currentFlag && (
              <div className="flag-stage">
                <div className="flag-meta-row">
                  <span className="flag-progress">
                    {room?.is_golden_round
                      ? "⚜️ Altın Tur"
                      : `${room?.current_round} / ${room?.total_rounds}`}
                  </span>
                  <span className="flag-diff-pill"
                    style={{ background: "rgba(99,102,241,.13)", borderColor: "var(--accent)", color: "var(--accent)" }}>
                    {continentLabel}
                  </span>
                </div>
                <div className="flag-img-wrap">
                  {imgError ? (
                    <div className="flag-fallback">
                      <span className="flag-fallback-code">{currentFlag.code.toUpperCase()}</span>
                      <span className="flag-fallback-hint">Bayrak yüklenemedi</span>
                    </div>
                  ) : (
                    <img
                      key={currentFlag.code + ":" + room?.current_round}
                      src={flagSrc}
                      alt="Bayrak"
                      className="flag-img"
                      onError={() => setImgError(true)}
                    />
                  )}
                </div>
               {roundResolved ? (
  roundAnswered ? (
    <div
      className={`skip-answer-reveal ${
        iAnswered ? "skip-answer-reveal--ok" : "skip-answer-reveal--no"
      }`}
    >
      <span className="skip-label">
        {iAnswered ? "✓ Sen bildin:" : "✕ Rakip bildi:"}
      </span>
      <span className="skip-country">{currentFlag.display}</span>
    </div>
  ) : (
    <div className="skip-answer-reveal skip-answer-reveal--timeout">
      <span className="skip-label">⏰ Süre doldu! Cevap:</span>
      <span className="skip-country">{currentFlag.display}</span>
    </div>
  )
) : timedOut ? (
                  <p className="flag-prompt">⏳ Süren doldu — rakibi bekliyoruz…</p>
                ) : (
                  <p className="flag-prompt">Bu bayrağın ülkesi nedir?</p>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* ════════ FINISHED — overlay (arka plan = blur'lu playing UI) ════════ */}
      {phase === "finished" && (
        <div className="wheel-result-backdrop">
          <div className="duel-result-card">

            {/* Emoji + başlık */}
            <div className="duel-result-emoji">{result.emoji}</div>
            <h2 className="duel-result-title">{result.title}</h2>
            {result.subtitle && (
              <p className="duel-result-subtitle">{result.subtitle}</p>
            )}

            {/* Skor */}
            <div className="duel-result-scores">
              <div className="duel-result-col mine">
                <span className="duel-result-name">{myPlayer?.name ?? "Ben"}</span>
                <span className="duel-result-num">{myScore}</span>
                <span className="duel-result-sub">tur</span>
              </div>
              <span className="duel-result-vs">—</span>
              <div className="duel-result-col opp">
                <span className="duel-result-num">{oppScore}</span>
                <span className="duel-result-name">{oppPlayer?.name ?? "Rakip"}</span>
                <span className="duel-result-sub">tur</span>
              </div>
            </div>

            {/* Meta */}
            <div className="wheel-result-rows">
              <div className="wheel-result-row">
                <span>Tur</span>
                <strong>{totalRounds}</strong>
              </div>
              <div className="wheel-result-row">
                <span>Bölge</span>
                <strong>{continentLabel}</strong>
              </div>
              <div className="wheel-result-row">
                <span>Toplam bayrak</span>
                <strong>{myScore + oppScore}</strong>
              </div>
            </div>

            {/* Rövanş alanı */}
            <div className="duel-rematch-area">
              {rematch === "idle" && oppPlayer && (
                <button className="btn duel-rematch-btn" onClick={requestRematch}>
                  ⚔️ Rövanş İste
                </button>
              )}
              {rematch === "requested" && (
                <p className="duel-rematch-status waiting">⏳ Rövanş isteği gönderildi, rakip bekleniyor…</p>
              )}
              {rematch === "received" && (
                <div className="duel-rematch-incoming">
                  <p className="duel-rematch-status">⚔️ Rakibin rövanş istiyor!</p>
                  <div className="duel-rematch-btns">
                    <button className="btn btn-accent btn-sm" onClick={acceptRematch}>Kabul Et</button>
                    <button className="btn btn-ghost btn-sm" onClick={declineRematch}>Reddet</button>
                  </div>
                </div>
              )}
              {rematch === "declined" && (
                <p className="duel-rematch-status declined">😞 Rakip rövanşı reddetti.</p>
              )}
            </div>

            {/* Alt butonlar */}
            <div className="duel-result-actions">
              <button className="btn btn-ghost" disabled style={{ opacity: 0.4, cursor: "not-allowed" }}>
                ⚡ Hızlı Eşleş
              </button>
              <button className="btn btn-accent" onClick={() => { playSound("click"); onHome(); }}>
                ⌂ Ana Menü
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ════════ QUIT MODAL — oyun sırasında menü tuşuna basınca ════════ */}
      {quitModalOpen && (
        <div className="duel-quit-backdrop" onClick={() => setQuitModalOpen(false)}>
          <div className="duel-quit-modal" onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: "2.5rem", marginBottom: 8 }}>🚪</div>
            <h2 className="modal-title">Oyundan Çıkmak İstiyor Musun?</h2>
            <p className="duel-waiting-msg" style={{ marginBottom: 16 }}>
              Şu an çıkarsan rakip kazanır (pes etmiş sayılırsın).
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button
                className="btn btn-danger"
                onClick={async () => { setQuitModalOpen(false); await handleLeave(); }}
              >
                🏳️ Pes Et ve Ana Menüye Dön
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => setQuitModalOpen(false)}
              >
                ↩ Oyuna Geri Dön
              </button>
            </div>
          </div>
        </div>
      )}
    {/* ════════ XP KAZANIMI — fixed footer ════════ */}
      {xpResult && xpFooterVisible && !xpResult.dismissed && (
        <XpGainBar
          key={xpResult.roomKey}
          modeLabel="Bayrak"
          prevTotalXp={xpResult.prevTotalXp}
          newTotalXp={xpResult.totalXp}
          prevModeXp={xpResult.prevModeXp}
          newModeXp={xpResult.modeXp}
          xpEarned={xpResult.xpEarned}
          awarded={xpResult.awarded}
          breakdown={xpResult.breakdown}
          onDismiss={() =>
            setXpResult(prev => (prev ? { ...prev, dismissed: true } : null))
          }
        />
      )}
    </div>
  );
}
