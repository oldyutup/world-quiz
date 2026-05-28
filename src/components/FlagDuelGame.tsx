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
  type MatchResult,
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
import { readStoredHomeTheme, getThemeBackgroundStyle, getThemeDataAttr } from "../lib/themeBackgrounds";

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
// Duel 1v1 ile paylaşımlı: aynı tarayıcı = aynı misafir kimliği. M1
// duel_authorize_player guest_id eşleşmesini bu key üzerinden yapar.
const GUEST_ID_KEY  = "geoquiz_duel_guest_id";

function freshPlayerId(): string {
  const id = crypto.randomUUID();
  localStorage.setItem(PLAYER_ID_KEY, id);
  return id;
}

/** Fresh claim_token: M1'de eklenen duel_player_claims tablosuna her yeni
 *  player satırı için bir tane yazılır. Session ile birlikte persist edilir;
 *  reload sonrasında aynı player_id ile resume için kritik. QM-flag akışında
 *  RPC bu kaydı atmaz; auth fallback flag_duel_queue üzerinden yürür → o
 *  yolda token boş string olabilir (saklanır ama kullanılmaz). */
function freshClaimToken(): string {
  return crypto.randomUUID();
}

interface RoomSession {
  roomId:     string;
  roomCode:   string;
  playerId:   string;
  /** Manuel akışta dolu; QM-flag akışında boş string olabilir. */
  claimToken: string;
}
function saveSession(roomId: string, roomCode: string, playerId: string, claimToken: string) {
  localStorage.setItem(
    ROOM_KEY,
    JSON.stringify({ roomId, roomCode, playerId, claimToken }),
  );
}
function loadSession(): RoomSession | null {
  try {
    const raw = localStorage.getItem(ROOM_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p?.roomId || !p?.roomCode || !p?.playerId) return null;
    return { ...p, claimToken: typeof p.claimToken === "string" ? p.claimToken : "" } as RoomSession;
  } catch { return null; }
}
function clearSession() {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    // GUEST_ID_KEY ("geoquiz_duel_guest_id") prefix uyuşmaz → korunur.
    if (k && k.startsWith("geoquiz_flagduel")) localStorage.removeItem(k);
  }
}

/** Misafir kullanıcılar için stabil guest_id. Logged-in için profile.id
 *  kullanılır; bu fonksiyon yalnız profile yokken çağrılır. */
function ensureGuestId(): string {
  let g = localStorage.getItem(GUEST_ID_KEY);
  if (!g) {
    g = crypto.randomUUID();
    localStorage.setItem(GUEST_ID_KEY, g);
  }
  return g;
}

/* ─── Flag Duel RPC error mapper ──────────────────────────────────────
 *  M3 RPC'leri PG raise exception ile business hatalar döner. Mevcut
 *  Duel 1v1 mapper'ı ile büyük ölçüde aynı; Flag Duel'e özgü
 *  total_rounds_invalid / winner_mismatch / first_flag_required cases
 *  eklendi. */
interface FlagDuelRpcError { code?: string; message?: string; details?: string }
function describeFlagDuelRpcError(err: FlagDuelRpcError | null | undefined): string {
  if (!err) return "İşlem başarısız.";
  const m = (err.message ?? "") + " " + (err.details ?? "");
  if (m.includes("code_taken"))               return "Bu kod kullanımda. Tekrar dene.";
  if (m.includes("name_taken"))               return "Bu odada bu isim zaten kullanılıyor.";
  if (m.includes("room_full"))                return "Oda dolu (2 oyuncu mevcut).";
  if (m.includes("room_not_found"))           return "Oda bulunamadı. Kodu kontrol et.";
  if (m.includes("room_finished"))            return "Bu oda zaten kapandı.";
  if (m.includes("room_in_progress"))         return "Maç zaten devam ediyor. Katılamazsın.";
  if (m.includes("room_not_waiting"))         return "Oda artık bekleme aşamasında değil.";
  if (m.includes("room_not_playing"))         return "Oda artık oyunda değil.";
  if (m.includes("room_not_rematchable"))     return "Bu oda rövanşa uygun değil.";
  if (m.includes("not_enough_players"))       return "Yeterli oyuncu yok.";
  if (m.includes("name_invalid"))             return "Geçersiz isim.";
  if (m.includes("total_rounds_invalid"))     return "Geçersiz tur sayısı.";
  if (m.includes("region_invalid"))           return "Geçersiz bölge.";
  if (m.includes("first_flag_required"))      return "Bayrak seçilemedi. Tekrar dene.";
  if (m.includes("next_flag_required"))       return "Sıradaki bayrak seçilemedi.";
  if (m.includes("winner_mismatch"))          return "Kazanan doğrulanamadı.";
  if (m.includes("profile_mismatch"))         return "Oturum doğrulaması başarısız.";
  if (m.includes("player_room_mismatch"))     return "Bu odada oyuncun yok.";
  if (m.includes("unauthorized"))             return "Bu işlem için yetkin yok.";
  if (err.code === "42501")                   return "Veritabanı izin hatası.";
  return err.message || "İşlem başarısız.";
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
type DuelPhase = "lobby" | "creating" | "searching" | "waiting" | "playing" | "finished";

/* ─── ZAMAN AYARLARI ─── */
const FLAG_TIMEOUT_SEC   = 10;   // her bayrak için süre
const REVEAL_DELAY_MS    = 2000; // cevaptan/timeouttan sonra cevap gösterim süresi
const PASS_REVEAL_MS     = 700;  // ikisi de pas geçince geçiş süresi

/* ─── HIZLI EŞLEŞ ─── */
/** Polling tick aralığı. RPC tarafı 45 sn expires_at kullanıyor. */
const QUICK_MATCH_TICK_MS = 3000;

/** Bekleme süresine göre kabul edilen flag_duel mod level farkı.
 *  RPC simetrik LEAST(caller, candidate) uygular; iki taraf da
 *  birbirinin level'ını kabul ediyor olmalı. */
function quickMatchBracket(searchSeconds: number): number {
  if (searchSeconds < 10) return 0;
  if (searchSeconds < 20) return 2;
  if (searchSeconds < 30) return 5;
  if (searchSeconds < 60) return 15;
  return 9999;
}

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

  /* claim-token ref — manuel akışta freshClaimToken ile set edilir;
   * QM-flag akışında boş string kalır, auth fallback flag_duel_queue
   * üzerinden çalışır. */
  const claimTokenRef = useRef<string>("");

  /** RPC'lere profile_id / guest_id paramını üreten helper. M1 identity
   *  XOR'u: profile.id varsa onu kullan, yoksa stabil guest_id. */
  const getIdentityArgs = useCallback((): { profileId: string | null; guestId: string | null } => {
    if (profile?.id) return { profileId: profile.id, guestId: null };
    return { profileId: null, guestId: ensureGuestId() };
  }, [profile?.id]);

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
  /* host odayı kapattığında guest'e gösterilen modal */
  const [roomClosed, setRoomClosed] = useState(false);
  /* rematch */
const [rematch, setRematch] = useState<"idle" | "requested" | "received" | "declined">("idle");

  /* ── Hızlı Eşleş state + ref'ler ─────────────────────────────────────
   *  searching → polling RPC ile rakip arar; bracket genişler.
   *  Eşleşince RPC matched_room_id UPDATE yapar (bekleyen client realtime
   *  ile yakalar) veya RPC dönüşünden caller direkt joinQuickMatchRoom çağırır.
   *  Sonra phase 'playing' olur ve room.room_source==='quick_match' +
   *  started_at gelecekte iken countdown overlay gösterilir.
   */
  const [searchSeconds,    setSearchSeconds]    = useState(0);
  const [countdownSeconds, setCountdownSeconds] = useState(0);
  const quickMatchTickRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const quickMatchSecondsRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const quickMatchStartMsRef   = useRef<number>(0);
  const quickMatchAbortRef     = useRef(false);
  const quickMatchJoinedRef    = useRef(false);
  const quickMatchCountdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  /** Rövanş RPC çağrısı, yalnız HOST tarafında ve maç başına BİR kez atılmalı.
   *  Senaryolar:
   *    (a) Host "Kabul Et"e tıklıyorsa → acceptRematch direkt RPC'yi çağırır.
   *    (b) Non-host "Kabul Et"e tıklayıp Host "Rövanş İste"yi başlatmışsa →
   *        non-host acceptRematch çalıştığında isHost=false (RPC atmaz);
   *        non-host'un rematch_accepted broadcast'i host'a gelir, host'un
   *        broadcast handler'ı bu ref'i kontrol ederek RPC'yi atar.
   *  ref true → 2. tetikleyici (acceptRematch + broadcast handler) RPC'yi
   *  yeniden atmaz. Maç finished'a düşünce realtime UPDATE handler sıfırlar. */
  const rematchRpcSentRef = useRef(false);

  /** runHostRematchReset: yalnız host tarafında çalışır; flag_duel_accept_rematch
   *  RPC'sini idempotent guard ile çağırır ve UI'nın realtime UPDATE'i
   *  beklemeden taze duruma geçmesi için roomRef + room state'i optimistik
   *  günceller. */
  const runHostRematchResetRef = useRef<(() => Promise<void>) | null>(null);

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

  // Forfeit takes precedence over raw scores: the forfeiting side is the loser
  // regardless of who led on the scoreboard when they quit.
  const forfeit    = room?.finished_reason === "forfeit";
  const forfeiterId = room?.forfeited_player_id ?? null;

  if (forfeit && forfeiterId !== null) {
    if (forfeiterId !== myId) {
      playSound("win", { restart: true });
    } else {
      playSound("lose", { restart: true });
    }
    return;
  }

  if (myScore > oppScore) {
    playSound("win", { restart: true });
  } else if (myScore < oppScore) {
    playSound("lose", { restart: true });
  }
  // Beraberlikte ses yok (DuelGame ile aynı davranış)
}, [phase, myScore, oppScore, room?.finished_reason, room?.forfeited_player_id, myId]);
  /* ── XP: oyun bitince bir kez yaz (sadece giriş yapmış kullanıcı) ── */
useEffect(() => {
  if (phase !== "finished") return;
  if (xpAwardedRef.current) return;
  if (!isLoggedInPlayer || !profile?.id) return;
  if (!matchIdRef.current) return;

  xpAwardedRef.current = true;

  const myScoreFinal  = myScore;
  const oppScoreFinal = oppScore;

  // Forfeit override: handleLeave only marks finished_reason="forfeit" when
  // phase === "playing" (i.e. the match actually started — current_round is
  // already ≥ 1 by then), so a forfeit here is never a pre-start abandon.
  // The remaining player must get win XP, not the score-derived draw that
  // resultFromScores(0, 0) would otherwise produce.
  const forfeit = room?.finished_reason === "forfeit";
  const forfeiterId = room?.forfeited_player_id ?? null;
  const opponentForfeited = forfeit && forfeiterId !== null && forfeiterId !== myId;
  const iForfeited        = forfeit && forfeiterId === myId;

  const matchResult: MatchResult = opponentForfeited
    ? "win"
    : iForfeited
      ? "loss"
      : resultFromScores(myScoreFinal, oppScoreFinal);

  const breakdown = calculateFlagDuelXp({
    correctCount: myScoreFinal,
    result: matchResult,
  });

  if (opponentForfeited) {
    breakdown.bonusLabelText = `Hükmen Galibiyet +${breakdown.resultBonus}`;
  } else if (iForfeited) {
    breakdown.bonusLabelText = `Hükmen Mağlubiyet +${breakdown.resultBonus}`;
  }

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
        // RPC: round değişmez, yalnız flag yenilenir
        const { error: setErr } = await supabase.rpc("flag_duel_set_next_round", {
          p_room_id:         r.id,
          p_host_player_id:  myIdRef.current,
          p_claim_token:     claimTokenRef.current,
          p_next_round:      r.current_round,
          p_next_flag:       nextFlag.code,
          p_is_golden_round: r.is_golden_round,
        });
        if (setErr) dbgErr("flag_duel_set_next_round (both_passed) failed", setErr);
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
          // Skor eşit → altın tura geç (round+1, is_golden=true)
          if (!nextFlag) { dbgErr("enter_golden: bayrak havuzu tükendi"); return; }
          const { error: setErr } = await supabase.rpc("flag_duel_set_next_round", {
            p_room_id:         r.id,
            p_host_player_id:  myIdRef.current,
            p_claim_token:     claimTokenRef.current,
            p_next_round:      nextRoundNum,
            p_next_flag:       nextFlag.code,
            p_is_golden_round: true,
          });
          if (setErr) dbgErr("flag_duel_set_next_round (enter_golden) failed", setErr);
          return;
        }

        const winner = sA > sB ? ids[0] : ids[1];
        const { error: finErr } = await supabase.rpc("flag_duel_finalize_game", {
          p_room_id:          r.id,
          p_host_player_id:   myIdRef.current,
          p_claim_token:      claimTokenRef.current,
          p_winner_player_id: winner,
        });
        if (finErr) dbgErr("flag_duel_finalize_game (final_score) failed", finErr);
        return;
      }

      if (inGolden && reason === "answered") {
        const goldenClaims = cs.filter(
          c => isRealAnswer(c) && c.country_code === r.current_flag
        );
        const goldenWinnerClaim = goldenClaims[goldenClaims.length - 1];
        const { error: finErr } = await supabase.rpc("flag_duel_finalize_game", {
          p_room_id:          r.id,
          p_host_player_id:   myIdRef.current,
          p_claim_token:      claimTokenRef.current,
          p_winner_player_id: goldenWinnerClaim?.player_id ?? null,
        });
        if (finErr) dbgErr("flag_duel_finalize_game (golden_answered) failed", finErr);
        return;
      }

      if (!nextFlag) { dbgErr("normal_advance: bayrak havuzu tükendi"); return; }
      const { error: setErr } = await supabase.rpc("flag_duel_set_next_round", {
        p_room_id:         r.id,
        p_host_player_id:  myIdRef.current,
        p_claim_token:     claimTokenRef.current,
        p_next_round:      nextRoundNum,
        p_next_flag:       nextFlag.code,
        p_is_golden_round: inGolden,
      });
      if (setErr) dbgErr("flag_duel_set_next_round (normal_advance) failed", setErr);
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

/** Host-only RPC + optimistic local reset. Hem acceptRematch (host kabul
 *  ediyorsa) hem rematch_accepted broadcast handler (host requester ise)
 *  tarafından çağrılır. rematchRpcSentRef ile çift çağrı engellenir. */
const runHostRematchReset = useCallback(async () => {
  if (!isHostRef.current) return;
  if (rematchRpcSentRef.current) return;
  const currentRoom = roomRef.current;
  if (!currentRoom) return;

  const pool = flagPoolRef.current.length > 0
    ? flagPoolRef.current
    : buildPool(currentRoom.region);
  const firstFlag = pool[0];
  if (!firstFlag) {
    dbgErr("rematch: bayrak havuzu boş, açılamadı");
    return;
  }

  rematchRpcSentRef.current = true;
  const { error } = await supabase.rpc("flag_duel_accept_rematch", {
    p_room_id:        currentRoom.id,
    p_host_player_id: myIdRef.current,
    p_claim_token:    claimTokenRef.current,
    p_first_flag:     firstFlag.code,
  });
  if (error) {
    dbgErr("flag_duel_accept_rematch failed", error);
    setErrorMsg(describeFlagDuelRpcError(error));
    rematchRpcSentRef.current = false;  // hata → tekrar denenebilir
    return;
  }

  // Optimistic: realtime UPDATE'i beklemeden host'un UI'sı taze tura geçsin.
  // Non-host'un room state'i realtime UPDATE ile aynı değerlere oturacak.
  const optimistic: FlagDuelRoom = {
    ...currentRoom,
    status:              "playing",
    started_at:          new Date().toISOString(),
    current_round:       1,
    current_flag:        firstFlag.code,
    current_flag_at:     new Date().toISOString(),
    is_golden_round:     false,
    finished_reason:     null,
    winner_player_id:    null,
    forfeited_player_id: null,
  };
  roomRef.current = optimistic;
  setRoom(optimistic);
}, [buildPool]);

useEffect(() => {
  runHostRematchResetRef.current = runHostRematchReset;
}, [runHostRematchReset]);

const acceptRematch = useCallback(async () => {
  if (!room) return;
  // XP idempotency için yeni match ID — rematch aynı odada olduğu için şart.
  matchIdRef.current = crypto.randomUUID();
  setXpResult(null); xpAwardedRef.current = false;
  setRematch("idle");
  setInput("");
  setFeedback(null);
  setTimedOut(false);
  setImgError(false);
  setClaims([]);
  setHints(EMPTY_HINTS);
  advancingRef.current = false;

  // Pool'u kur (host olmayan da kendi pool'unu hazırlasın; yeni bayrak için)
  buildPool(room.region);

  // Host (kabul eden host olsa da olmasa da) RPC'yi atar.
  // Host = acceptor senaryosu: bu çağrı RPC'yi tetikler.
  // Host = requester senaryosu: bu noktada isHost=false → RPC atılmaz,
  //   rematch_accepted broadcast handler'ı host tarafında RPC'yi atar.
  if (isHostRef.current) {
    await runHostRematchReset();
  }

  supabase.channel(`flagduel:${room.id}`).send({
    type: "broadcast",
    event: "rematch_accepted",
    payload: {},
  });

  setPhase("playing");
}, [room, buildPool, runHostRematchReset]);

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
     HIZLI EŞLEŞ — startQuickMatch / cancelQuickMatch / join
  ════════════════════════════════════════════════════════════════ */

  /** RPC dönüşünden veya realtime UPDATE'inden sonra çağrılır.
   *  Odayı + iki player'ı yükler, lokal state'i set eder, phase 'playing'.
   *  Tek seferlik: quickMatchJoinedRef ile guard'lı. */
  const joinQuickMatchRoom = useCallback(
    async (roomId: string, playerId: string, opponentName?: string) => {
      if (quickMatchJoinedRef.current) return;

      // VALIDATE BEFORE COMMITTING. We must check the room is a real, fresh
      // match before we stop the polling/seconds intervals or flip any
      // commit flags — otherwise a stale matched_room_id (left over from a
      // previous finished game, because flag_duel_cancel_quick_match keeps
      // matched rows by design) would tear down our search state and strand
      // the user. The previous version erred to lobby on stale; that is too
      // aggressive — a no-opponent fresh search would surface the same error
      // path whenever the reset RPC hadn't yet been applied to the DB.
      const { data: roomData, error: roomErr } = await supabase
        .from("duel_rooms")
        .select("*")
        .eq("id", roomId)
        .maybeSingle();

      if (roomErr || !roomData) {
        dbgErr("joinQuickMatchRoom: room fetch failed, will retry on next tick", roomErr);
        // Don't surface to UI; polling continues and may succeed next tick.
        return;
      }

      const r = roomData as FlagDuelRoom;

      // Stale-room guard. A "fresh" quick-match room is created by the RPC
      // with status='playing' and started_at = now()+3s, so for any real
      // match Date.now() - startedAtMs is in [-3000, +small] ms. Anything
      // older than 30s OR with a non-playing status is leftover from a
      // previous game — silently ignore and keep polling so a real match
      // can still come through (or the user can cancel from the UI).
      const startedAtMs = r.started_at ? new Date(r.started_at).getTime() : 0;
      const isStaleRoom =
        r.status !== "playing" ||
        !startedAtMs ||
        Date.now() - startedAtMs > 30_000;
      if (isStaleRoom) {
        dbgErr("joinQuickMatchRoom: stale matched_room_id, skipping silently", {
          status: r.status,
          started_at: r.started_at,
        });
        // No setErrorMsg, no setPhase. Search state is untouched, polling
        // continues, the cancel button in the searching UI still works.
        return;
      }

      // OK, this is a real fresh match — commit to join.
      quickMatchJoinedRef.current = true;

      // Polling/heartbeat'i durdur
      if (quickMatchTickRef.current) {
        clearInterval(quickMatchTickRef.current);
        quickMatchTickRef.current = null;
      }
      if (quickMatchSecondsRef.current) {
        clearInterval(quickMatchSecondsRef.current);
        quickMatchSecondsRef.current = null;
      }
      quickMatchAbortRef.current = true; // dönmemiş RPC response'larını yut

      myIdRef.current = playerId;

      const { data: ps } = await supabase
        .from("duel_players")
        .select("*")
        .eq("room_id", roomId)
        .order("joined_at", { ascending: true });

      const players = (ps ?? []) as DuelPlayer[];
      const isMeHost = (players[0]?.id ?? "") === playerId;

      // XP idempotency için fresh state
      setXpResult(null);
      xpAwardedRef.current = false;
      matchIdRef.current = "";

      setRoom(r);
      setPlayers(players);
      setClaims([]);
      setIsHost(isMeHost);
      isHostRef.current = isMeHost;
      // QM-flag: flag_duel_quick_match RPC duel_player_claims kaydı atmaz;
      // claim_token boş kalır. Auth fallback flag_duel_queue üzerinden çalışır
      // (flag_duel_authorize_player helper'ı bu durumu handle eder).
      claimTokenRef.current = "";
      saveSession(r.id, r.code, playerId, "");
      buildPool(r.region);

      // Quick match countdown başlat (started_at - now() farkı)
      const startMs = r.started_at ? new Date(r.started_at).getTime() : 0;
      const now = Date.now();
      const remainMs = Math.max(0, startMs - now);
      setCountdownSeconds(Math.ceil(remainMs / 1000));

      if (quickMatchCountdownRef.current) {
        clearInterval(quickMatchCountdownRef.current);
        quickMatchCountdownRef.current = null;
      }
      if (remainMs > 0) {
        const tick = () => {
          const remaining = Math.max(0, startMs - Date.now());
          setCountdownSeconds(Math.ceil(remaining / 1000));
          if (remaining <= 0 && quickMatchCountdownRef.current) {
            clearInterval(quickMatchCountdownRef.current);
            quickMatchCountdownRef.current = null;
          }
        };
        quickMatchCountdownRef.current = setInterval(tick, 200);
      }

      if (opponentName) {
        setStatusMsg(`Rakip bulundu: ${opponentName}`);
      } else {
        setStatusMsg(null);
      }
      setErrorMsg(null);
      setPhase("playing");
    },
    [buildPool],
  );

  // Forward ref pattern: quickMatchTick içinden cancel'a erişim için
  const cancelQuickMatchRef = useRef<(() => void) | null>(null);

  /** Polling tick — SELECT-first guard sonra RPC. */
  const quickMatchTick = useCallback(async () => {
    if (quickMatchAbortRef.current) return;
    if (!profile?.id) return;

    const myProfileId = profile.id;

    // ── SELECT-first guard ──────────────────────────────────────
    // Realtime UPDATE jitter olabilir VE RPC UPSERT'ü matched_room_id'yi
    // NULL'a çekiyor (caller path için doğru, bekleyen için yan etki).
    // RPC'den önce kendi queue satırımı SELECT edip matched_room_id
    // doluysa UPSERT'e hiç girmeden join'e geçiyoruz.
    const { data: selfRow } = await supabase
      .from("flag_duel_queue")
      .select("matched_room_id, player_id")
      .eq("profile_id", myProfileId)
      .maybeSingle();

    if (quickMatchAbortRef.current) return;

    if (selfRow?.matched_room_id && selfRow.player_id) {
      await joinQuickMatchRoom(selfRow.matched_room_id, selfRow.player_id);
      // Only short-circuit the tick if the join actually committed. If
      // joinQuickMatchRoom silently skipped because the matched_room_id
      // points at a stale (no-longer-playing or long-ago-created) room,
      // we MUST fall through to the RPC below — that RPC is the only path
      // that clears the stale matched_room_id (self-heal block) AND
      // refreshes our queue row's expires_at so other players can still
      // find us as a candidate. Without this fall-through, two stuck
      // players will never become visible to each other's candidate
      // searches because every tick's matched_room_id IS NULL filter
      // excludes them.
      if (quickMatchJoinedRef.current) return;
    }
    // ────────────────────────────────────────────────────────────

    const elapsed = Math.floor((Date.now() - quickMatchStartMsRef.current) / 1000);
    const bracket = quickMatchBracket(elapsed);
    const myPlayerId = myIdRef.current;
    const myName     = (profile.username ?? "").trim();
    const code       = makeCode();
    const pool       = flagPoolRef.current.length > 0
      ? flagPoolRef.current
      : buildPool(normalizeRegion(hostRegion));
    if (pool.length === 0) {
      setErrorMsg("Bu bölge için bayrak havuzu boş.");
      cancelQuickMatchRef.current?.();
      return;
    }
    const firstFlag = pool[Math.floor(Math.random() * pool.length)];

    const { data, error } = await supabase.rpc("flag_duel_quick_match", {
      p_profile_id:     myProfileId,
      p_player_id:      myPlayerId,
      p_player_name:    myName,
      p_total_rounds:   hostRounds,
      p_region:         normalizeRegion(hostRegion),
      p_max_level_diff: bracket,
      p_room_code:      code,
      p_first_flag:     firstFlag.code,
    });

    if (quickMatchAbortRef.current) return;

    if (error) {
      dbgErr("quick_match RPC error", error);
      setErrorMsg("Hızlı eşleş hatası: " + (error.message ?? "Bilinmeyen"));
      cancelQuickMatchRef.current?.();
      return;
    }

    const res = data as {
      matched:             boolean;
      room_id?:            string;
      my_player_id?:       string;
      opponent_name?:      string | null;
      search_age_seconds?: number;
    };

    if (res?.matched && res.room_id && res.my_player_id) {
      await joinQuickMatchRoom(res.room_id, res.my_player_id, res.opponent_name ?? undefined);
      return;
    }

    // Henüz eşleşme yok — searchSeconds zaten ayrı interval ile artıyor
  }, [profile?.id, profile?.username, hostRounds, hostRegion, buildPool, joinQuickMatchRoom]);

  const cancelQuickMatch = useCallback(async () => {
    quickMatchAbortRef.current = true;

    if (quickMatchTickRef.current) {
      clearInterval(quickMatchTickRef.current);
      quickMatchTickRef.current = null;
    }
    if (quickMatchSecondsRef.current) {
      clearInterval(quickMatchSecondsRef.current);
      quickMatchSecondsRef.current = null;
    }

    setSearchSeconds(0);
    setStatusMsg(null);
    setPhase("lobby");

    if (profile?.id) {
      try {
        await supabase.rpc("flag_duel_cancel_quick_match", {
          p_profile_id: profile.id,
        });
      } catch (e) {
        console.warn("[FlagDuel] cancel_quick_match RPC failed", e);
      }
    }
  }, [profile?.id]);

  useEffect(() => {
    cancelQuickMatchRef.current = cancelQuickMatch;
  }, [cancelQuickMatch]);

  const startQuickMatch = useCallback(async () => {
    playSound("click");
    setErrorMsg(null);

    if (!profile?.id || !profile.username) {
      setErrorMsg("Hızlı eşleş için giriş gerekli.");
      return;
    }

    // Quick match identity: her aramada fresh player UUID
    clearSession();
    const freshId = freshPlayerId();
    myIdRef.current = freshId;

    // Önceki maç state'ini temizle (sonuç ekranından gelinmiş olabilir)
    setRoom(null);
    setPlayers([]);
    setClaims([]);
    setIsHost(false);
    isHostRef.current = false;
    setRematch("idle");
    setXpResult(null);
    xpAwardedRef.current = false;
    matchIdRef.current = "";

    // Reset guards & timers
    quickMatchAbortRef.current  = false;
    quickMatchJoinedRef.current = false;
    quickMatchStartMsRef.current = Date.now();
    setSearchSeconds(0);
    setCountdownSeconds(0);
    setPhase("searching");

    // Önceki maçtan kalan flag_duel_queue satırını sil. cancel RPC yalnızca
    // matched_room_id=NULL satırları siliyor (canlı eşleşmede candidate'ın
    // realtime UPDATE'ini bozmamak için). Önceki tamamlanmış bir maç ise
    // matched_room_id'yi dolu bırakıyor → SELECT-first guard ve RPC'nin
    // erken-dönüş bloğu o stale room_id'yi "match" sanıp eski (bitmiş) odaya
    // bağlanıyor; flag zaten kayıtlı, current_flag_at çok geçmişte → timer
    // 0'da başlayıp anında TIMEOUT/draw'a düşüyor. Fresh row için reset şart.
    //
    // supabase.rpc returns { error } in-band rather than throwing on RPC
    // errors (e.g., function-not-found if migration not yet applied), so we
    // explicitly inspect the error field. If the reset can't run, the silent
    // stale-room guard inside joinQuickMatchRoom keeps the user safely in
    // the searching state instead of crashing into a stale match.
    try {
      const { error: resetErr } = await supabase.rpc(
        "flag_duel_reset_quick_match",
        { p_profile_id: profile.id },
      );
      if (resetErr) {
        console.warn("[FlagDuel] reset_quick_match RPC error:", resetErr);
      }
    } catch (e) {
      console.warn("[FlagDuel] reset_quick_match RPC threw:", e);
    }

    // Saniye sayacı (UI display + bracket)
    quickMatchSecondsRef.current = setInterval(() => {
      const s = Math.floor((Date.now() - quickMatchStartMsRef.current) / 1000);
      setSearchSeconds(s);
    }, 1000);

    // İlk RPC çağrısı + polling
    await quickMatchTick();
    quickMatchTickRef.current = setInterval(() => {
      quickMatchTick();
    }, QUICK_MATCH_TICK_MS);
  }, [profile?.id, profile?.username, quickMatchTick]);

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
  setHints(EMPTY_HINTS);
  advancingRef.current = false;
  // Rakip tarafı da kendi pool'unu yeniden kursun
  if (roomRef.current) {
    buildPool(roomRef.current.region);
  }
  // Host = requester senaryosu: acceptor non-host RPC atmadı; host bu broadcast'i
  // alınca RPC'yi atar (rematchRpcSentRef idempotent guard).
  if (isHostRef.current) {
    void runHostRematchResetRef.current?.();
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
      // Bir sonraki rövanşa hazırlık: önceki maçın RPC guard'ını çöz.
      rematchRpcSentRef.current = false;
      setPhase("finished");
    }
  }
)
      .on("postgres_changes",
        { event: "DELETE", schema: "public", table: "duel_rooms", filter: `id=eq.${roomId}` },
        () => {
          // Host "Lobiden Çık" in waiting → handleLeave deletes the duel_rooms row
          // (line ~1611). Guest must react: drop the room, return to the Flag Duel
          // menu, and surface a focused modal so they're not stuck in a hostless
          // lobby. Filter is on PK (id), so this works under default REPLICA
          // IDENTITY without a migration.
          if (isHostRef.current) return;  // host themselves navigates via handleLeave/onHome
          clearSession();
          setRoom(null);
          setPlayers([]);
          setClaims([]);
          setIsHost(false); isHostRef.current = false;
          setStatusMsg(null);
          setErrorMsg(null);
          setPhase("lobby");
          setRoomClosed(true);
        }
      )
      .on("postgres_changes",
        { event: "*", schema: "public", table: "duel_players", filter: `room_id=eq.${roomId}` },
        () => {
          // Any change (INSERT/UPDATE/DELETE) → re-fetch the full list. This mirrors
          // WheelDuelGame's pattern and keeps the host's "Oyuncular" view consistent
          // when a guest hits "Lobiden Çık": the DB row is deleted in handleLeave
          // but without this re-fetch the host's local state would retain the stale
          // entry, and a rejoin would appear as a duplicate.
          // Requires `alter table duel_players replica identity full;` so DELETE
          // events match the room_id filter server-side (see migration).
          supabase
            .from("duel_players")
            .select("*")
            .eq("room_id", roomId)
            .order("joined_at", { ascending: true })
            .then(({ data }) => {
              if (data) setPlayers(data as DuelPlayer[]);
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

  /* Realtime: bekleyen oyuncu kendi queue satırının matched_room_id
     UPDATE'ini dinler. Caller RPC dönüşünde direkt join eder; listener
     yine de güvenlik ağı olarak çalışır (no-op çünkü join guard'lı). */
  useEffect(() => {
    if (phase !== "searching") return;
    if (!profile?.id) return;

    const myProfileId = profile.id;
    const chan = supabase
      .channel(`flag-duel-queue:${myProfileId}`)
      .on(
        "postgres_changes",
        {
          event:  "UPDATE",
          schema: "public",
          table:  "flag_duel_queue",
          filter: `profile_id=eq.${myProfileId}`,
        },
        (payload) => {
          const row = payload.new as {
            matched_room_id: string | null;
            player_id:       string;
          };
          if (!row.matched_room_id) return;
          if (quickMatchJoinedRef.current) return;
          joinQuickMatchRoom(row.matched_room_id, row.player_id);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(chan);
    };
  }, [phase, profile?.id, joinQuickMatchRoom]);

  /* Component unmount'ta searching state'inde isek queue satırını temizle. */
  useEffect(() => {
    return () => {
      if (quickMatchTickRef.current)      clearInterval(quickMatchTickRef.current);
      if (quickMatchSecondsRef.current)   clearInterval(quickMatchSecondsRef.current);
      if (quickMatchCountdownRef.current) clearInterval(quickMatchCountdownRef.current);
      if (profile?.id && !quickMatchJoinedRef.current) {
        supabase.rpc("flag_duel_cancel_quick_match", {
          p_profile_id: profile.id,
        }).then(() => {});
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // Rematch sonrası realtime UPDATE gelene kadar room.status='finished' kalabilir;
    // o boşlukta eski current_flag_at ile timer çalıştırma → eski "Süren doldu"
    // state'i yeni tura sızar ve host eski tur için flag_duel_submit_claim
    // (TIMEOUT) çağırır → 'room_not_playing' (400). Status playing olana kadar
    // ölçüm yapmıyoruz.
    if (room?.status !== "playing") return;
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
          // Belt-and-suspenders: room state stale ise (rematch gap, finished maç)
          // TIMEOUT claim atma — RPC zaten 'room_not_playing' raise eder.
          if (r && r.current_flag && r.status === "playing") {
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
              const { error: tErr } = await supabase.rpc("flag_duel_submit_claim", {
                p_room_id:      r.id,
                p_player_id:    myIdRef.current,
                p_claim_token:  claimTokenRef.current,
                p_country_code: `TIMEOUT:R${r.current_round}:${r.current_flag}`,
              });
              if (tErr) dbgErr("flag_duel_submit_claim (TIMEOUT) failed", tErr);
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
    const freshId    = freshPlayerId();
    const freshToken = freshClaimToken();
    myIdRef.current        = freshId;
    claimTokenRef.current  = freshToken;
    const code = makeCode();

    const { profileId, guestId } = getIdentityArgs();

    // flag_duel_create_room RPC: duel_rooms + duel_players + duel_player_claims
    // atomik insert. host_player_id = freshId. room_source='manual'.
    const { data: roomData, error: roomErr } = await supabase.rpc("flag_duel_create_room", {
      p_player_id:    freshId,
      p_profile_id:   profileId,
      p_guest_id:     guestId,
      p_name:         name,
      p_code:         code,
      p_region:       normalizeRegion(hostRegion),
      p_total_rounds: hostRounds,
      p_claim_token:  freshToken,
    });

    if (roomErr || !roomData) {
      dbgErr("flag_duel_create_room failed", roomErr);
      setErrorMsg(describeFlagDuelRpcError(roomErr)); setStatusMsg(null); setPhase("lobby"); return;
    }
    const r = roomData as FlagDuelRoom;

    const { data: pls } = await supabase.from("duel_players").select("*").eq("room_id", r.id);
    setRoom(r);
    setPlayers(pls ?? []);
    setClaims([]);
    setIsHost(true); isHostRef.current = true;
    saveSession(r.id, r.code, freshId, freshToken);
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
    // Resume: aynı oda kodu + saved playerId + saved claimToken varsa eski kimliği
    // kullan (player satırı DB'de duruyorsa RPC çağırma; alreadyIn ile algılarız).
    const isResume = !!(saved?.roomCode === code && saved?.playerId && saved?.claimToken);
    const joinId    = isResume ? saved!.playerId   : freshPlayerId();
    const joinToken = isResume ? saved!.claimToken : freshClaimToken();
    if (!isResume) clearSession();
    myIdRef.current        = joinId;
    claimTokenRef.current  = joinToken;

    const { data: roomData } = await supabase
      .from("duel_rooms").select("*").eq("code", code).single();

    if (!roomData?.id) { setErrorMsg("Oda bulunamadı. Kodu kontrol et."); setStatusMsg(null); return; }
    const r = roomData as FlagDuelRoom;
    if (r.status === "finished") { setErrorMsg("Bu oda zaten kapandı."); setStatusMsg(null); return; }

    const { data: existPlayers } = await supabase.from("duel_players").select("*").eq("room_id", r.id);
    const alreadyIn = existPlayers?.some(p => p.id === joinId);
    if (!alreadyIn) {
      if ((existPlayers?.length ?? 0) >= 2) { setErrorMsg("Bu oda dolu."); setStatusMsg(null); return; }
      // duel_join_room RPC (Duel 1v1 M2 reuse): kapasite + isim çakışması + status
      // guard'ı server-side. duel_player_claims kaydını da bu RPC atar.
      const { profileId, guestId } = getIdentityArgs();
      const { error: joinErr } = await supabase.rpc("duel_join_room", {
        p_code:         code,
        p_player_id:    joinId,
        p_profile_id:   profileId,
        p_guest_id:     guestId,
        p_name:         name,
        p_claim_token:  joinToken,
      });
      if (joinErr) {
        dbgErr("duel_join_room failed", joinErr);
        setErrorMsg(describeFlagDuelRpcError(joinErr));
        setStatusMsg(null);
        return;
      }
    }

    const { data: pls } = await supabase.from("duel_players").select("*").eq("room_id", r.id);
    const { data: cs }  = await supabase.from("duel_claims").select("*").eq("room_id", r.id);
    setRoom(r);
    setPlayers(pls ?? []);
    setClaims(cs ?? []);
    setIsHost(false); isHostRef.current = false;
    setXpResult(null); xpAwardedRef.current = false; matchIdRef.current = "";
    saveSession(r.id, r.code, joinId, joinToken);
    buildPool(r.region);
    setStatusMsg(null);
    setPhase(r.status === "playing" ? "playing" : "waiting");
  };

  /* ════════════════════════════════════════════════════════════════
     HOST LOBBY AYARLARI (Tur + Bölge) — realtime
  ════════════════════════════════════════════════════════════════ */
  const updateHostSetting = async (
    next: { total_rounds?: number; region?: string },
  ) => {
    if (!room || !isHost) return;

    setRoom(prev => (prev ? { ...prev, ...next } : prev));
    if (next.region) buildPool(next.region);

    const { error } = await supabase.rpc("flag_duel_update_settings", {
      p_room_id:        room.id,
      p_host_player_id: myIdRef.current,
      p_claim_token:    claimTokenRef.current,
      p_total_rounds:   next.total_rounds ?? null,
      p_region:         next.region       ?? null,
    });

    if (error) dbgErr("flag_duel_update_settings failed", error);
  };

  /* ════════════════════════════════════════════════════════════════
     OYUNU BAŞLAT
  ════════════════════════════════════════════════════════════════ */
  const startGame = async () => {
    if (!room || !isHost) return;
    const pool = flagPoolRef.current.length > 0 ? flagPoolRef.current : buildPool(room.region);
    const firstFlag = pool[0];
    if (!firstFlag) return;

    const { error } = await supabase.rpc("flag_duel_start_game", {
      p_room_id:        room.id,
      p_host_player_id: myIdRef.current,
      p_claim_token:    claimTokenRef.current,
      p_first_flag:     firstFlag.code,
    });
    if (error) {
      dbgErr("flag_duel_start_game failed", error);
      setErrorMsg(describeFlagDuelRpcError(error));
    }
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
      playSound("wrong"); showFeedback("wrong"); setInput(""); return;
    }
    setInput("");

    if (claimsRef.current.some(c =>
      c.country_code === currentFlag.code && !c.country_code.startsWith("PASS:")
    )) { showFeedback("dup"); return; }

    const { data, error } = await supabase.rpc("flag_duel_submit_claim", {
      p_room_id:      room.id,
      p_player_id:    myIdRef.current,
      p_claim_token:  claimTokenRef.current,
      p_country_code: currentFlag.code,
    });
    if (error) {
      dbgErr("flag_duel_submit_claim (guess) failed", error);
      playSound("wrong"); showFeedback("wrong");
      return;
    }
    const res = data as { claimed: boolean; reason?: string } | null;
    if (res?.claimed) { playSound("correct"); showFeedback("correct"); }
    else if (res?.reason === "dup") { showFeedback("dup"); }
    else { playSound("wrong"); showFeedback("wrong"); }
  };

  const handlePass = async () => {
    if (phaseRef.current !== "playing") return;
    if (!room || !currentFlag) return;
    if (roundResolved || myPassed) return;
    if (passesRemaining <= 0 && !room.is_golden_round) return;

    const passCode = `PASS:R${room.current_round}:${currentFlag.code}:${myIdRef.current}`;
    const { error } = await supabase.rpc("flag_duel_submit_claim", {
      p_room_id:      room.id,
      p_player_id:    myIdRef.current,
      p_claim_token:  claimTokenRef.current,
      p_country_code: passCode,
    });
    if (error) dbgErr("flag_duel_submit_claim (pass) failed", error);
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
    // flag_duel_leave_room RPC phase-aware (status'tan türetir):
    //   status='playing'  → caller=loser, opp=winner, finished+forfeit
    //   status='waiting'  + caller host     → oda komple silinir (FK cascade)
    //   status='waiting'  + caller non-host → kendi player satırı silinir,
    //                                          oda boşaldıysa oda da silinir
    //   status='finished' → no-op
    if (room && myIdRef.current) {
      const { error } = await supabase.rpc("flag_duel_leave_room", {
        p_room_id:     room.id,
        p_player_id:   myIdRef.current,
        p_claim_token: claimTokenRef.current,
      });
      if (error) dbgErr("flag_duel_leave_room failed", error);
    }
    clearSession();
    claimTokenRef.current = "";
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

  const homeTheme = readStoredHomeTheme();
  const isPreGamePhase = phase !== "playing" && phase !== "finished";
  const themeBgStyle = isPreGamePhase ? getThemeBackgroundStyle(homeTheme) : undefined;
  const themeDataAttr = isPreGamePhase ? getThemeDataAttr(homeTheme) : undefined;

  return (
    <div
      className={"app duel-screen" + (phase === "playing" ? " duel-game-active" : "")}
      style={themeBgStyle}
      data-theme={themeDataAttr}
    >

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

            <div className="duel-section-divider">veya hızlı eşleş</div>
            {!profile?.username ? (
              <button
                className="btn duel-quickmatch-btn"
                disabled
                title="Hızlı eşleş için giriş gerekli"
              >
                ⚡ Hızlı Eşleş{" "}
                <span style={{ opacity: 0.65 }}>(Giriş Gerekli)</span>
              </button>
            ) : (
              <button
                className="btn btn-accent duel-quickmatch-btn"
                onClick={startQuickMatch}
                disabled={phase === "creating"}
                title="Aynı tur sayısı + bölge seçen biriyle otomatik eşleş"
              >
                ⚡ Hızlı Eşleş
              </button>
            )}

            {errorMsg  && <p className="duel-error">{errorMsg}</p>}
            {statusMsg && <p className="duel-status">{statusMsg}</p>}
          </div>
        </div>
      )}

      {/* ════════ SEARCHING (Quick Match) ════════ */}
      {phase === "searching" && (
        <div className="duel-lobby">
          <div className="duel-lobby-card" style={{ textAlign: "center" }}>
            <h2 className="duel-lobby-title">⚡ Hızlı Eşleş</h2>
            <p className="duel-lobby-desc">
              Aynı tur sayısı ve bölgeyi seçen, seviyene yakın bir rakip aranıyor…
            </p>

            <div style={{
              display: "flex", flexDirection: "column",
              gap: 6, margin: "16px 0", fontSize: 14,
            }}>
              <div>
                <strong>Tur:</strong> {hostRounds}{" "}
                <span style={{ opacity: 0.5 }}>·</span>{" "}
                <strong>Bölge:</strong>{" "}
                {CONTINENT_OPTIONS_UI.find(c => c.value === hostRegion)?.label ?? "🌍 Dünya"}
              </div>
              <div style={{ opacity: 0.85 }}>
                Bekleme: {Math.floor(searchSeconds / 60)}:
                {String(searchSeconds % 60).padStart(2, "0")}
                <span style={{ opacity: 0.5 }}> · </span>
                Aralık:{" "}
                {(() => {
                  const b = quickMatchBracket(searchSeconds);
                  return b >= 9999 ? "her seviye" : `±${b} lv`;
                })()}
              </div>
            </div>

            <div style={{
              fontSize: 36, margin: "8px 0 16px",
              animation: "wd-spin 1.4s linear infinite",
              display: "inline-block",
            }}>
              🚩
            </div>

            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => { playSound("click"); cancelQuickMatch(); }}
            >
              ✕ Aramayı İptal Et
            </button>

            {errorMsg && (
              <p className="duel-error" style={{ marginTop: 12 }}>{errorMsg}</p>
            )}
          </div>
        </div>
      )}

      {/* ════════ WAITING ════════ */}
      {phase === "waiting" && room && (
        <div className="duel-lobby">
          <div className="duel-lobby-with-chat flag-duel-with-chat">
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

              <div className="flag-duel-lobby-row">
                <div className="flag-duel-players-col">
                  <div className="duel-room-settings-title">👥 Oyuncular</div>
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
                </div>

                <div className="duel-room-settings-box flag-duel-settings">
                  <div className="duel-room-settings-title">⚙️ Oda Ayarları</div>
                  <div className="duel-room-settings-grid">
                    <label className="duel-room-setting-field">
                      <span>Tur</span>
                      <select
                        value={room?.total_rounds ?? hostRounds}
                        disabled={!isHost}
                        onChange={e =>
                          updateHostSetting({ total_rounds: Number(e.target.value) })
                        }
                      >
                        {ROUND_OPTS.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </label>

                    <label className="duel-room-setting-field">
                      <span>Bölge</span>
                      <select
                        value={denormalizeRegion(room?.region ?? hostRegion)}
                        disabled={!isHost}
                        onChange={e =>
                          updateHostSetting({ region: normalizeRegion(e.target.value) })
                        }
                      >
                        {REGION_OPTS.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {!isHost && (
                    <p className="duel-room-settings-note">
                      Yalnızca oda sahibi değiştirebilir.
                    </p>
                  )}
                </div>
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

            <LobbyChat
              roomCode={room.code}
              playerName={myPlayer?.name ?? effectivePlayerName}
              sendMode="flag_duel"
              playerId={myIdRef.current}
              claimToken={claimTokenRef.current}
            />
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

      {/* ════════ QUICK MATCH COUNTDOWN — playing UI'ın üstüne overlay ════════ */}
      {phase === "playing"
        && room
        && room.room_source === "quick_match"
        && countdownSeconds > 0 && (() => {
          const opp = players.find(p => p.id !== myId);
          return (
            <div className="wheel-result-backdrop">
              <div className="duel-result-card" style={{ textAlign: "center" }}>
                <div className="duel-result-emoji">⚡</div>
                <h2 className="duel-result-title">Rakip bulundu!</h2>
                {opp && (
                  <p className="duel-lobby-desc"
                     style={{ margin: "0 0 4px", fontSize: "0.95rem" }}>
                    {opp.name}
                  </p>
                )}
                <p className="duel-lobby-desc"
                   style={{ margin: "8px 0 0", fontSize: "0.9rem" }}>
                  Oyun başlıyor…
                </p>
                <div style={{
                  fontSize: 56, fontWeight: 800,
                  margin: "10px 0 4px",
                  color: "var(--accent, #4f8bff)",
                  fontVariantNumeric: "tabular-nums",
                }}>
                  {countdownSeconds}
                </div>
              </div>
            </div>
          );
        })()}

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
              {!profile?.username ? (
                <button
                  className="btn btn-ghost"
                  disabled
                  style={{ opacity: 0.4, cursor: "not-allowed" }}
                  title="Hızlı eşleş için giriş gerekli"
                >
                  ⚡ Hızlı Eşleş
                </button>
              ) : (
                <button
                  className="btn btn-accent"
                  onClick={() => {
                    playSound("click");
                    // setState batch'inden sonra startQuickMatch tetiklensin
                    Promise.resolve().then(() => startQuickMatch());
                  }}
                  title="Aynı tur sayısı + bölge seçen biriyle otomatik eşleş"
                >
                  ⚡ Hızlı Eşleş
                </button>
              )}
              <button className="btn btn-accent" onClick={() => { playSound("click"); onHome(); }}>
                ⌂ Ana Menü
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ════════ ROOM CLOSED MODAL — host lobiden çıktığında guest'e ════════ */}
      {roomClosed && (
        <div
          className="fd-room-closed-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="fd-room-closed-title"
        >
          <div className="fd-room-closed-modal">
            <div className="fd-room-closed-icon" aria-hidden="true">🚪</div>
            <h2 id="fd-room-closed-title" className="fd-room-closed-title">
              ODA KAPATILDI
            </h2>
            <p className="fd-room-closed-sub">
              Oda sahibi odadan ayrıldı ve oturumu sonlandırdı.
            </p>
            <button
              className="btn btn-accent fd-room-closed-action"
              autoFocus
              onClick={() => setRoomClosed(false)}
            >
              ← Lobiye Dön
            </button>
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
