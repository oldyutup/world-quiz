import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import WorldMap, { SilhouetteView } from "./components/WorldMap";
import RouteGame from "./components/RouteGame";
import DuelGame from "./components/DuelGame";
import FlagDuelGame from "./components/FlagDuelGame";
import DuelGroupGame from "./components/DuelGroupGame";
import WheelGame from "./components/WheelGame";
import WheelDuelGame from "./components/WheelDuelGame";
import WheelGroupGame from "./components/WheelGroupGame";
import ConquestMode from "./modes/conquest/ConquestMode";
import ConquestModeSelectModal from "./modes/conquest/ConquestModeSelectModal";
// Çağ Dedektifi ekranları menüden kaldırıldı (yerini Kör Nokta aldı) ama kod
// pasif olarak duruyor; render branch'leri aşağıda korunuyor.
import CagDedektifiGame from "./modes/cagDedektifi/CagDedektifiGame";
import HaritaDedektifiGame from "./modes/cagDedektifi/HaritaDedektifiGame";
import HaritaDuelGame from "./modes/cagDedektifi/HaritaDuelGame";
import KorNoktaMode from "./modes/korNokta/KorNoktaMode";
import KorNoktaSelectModal from "./modes/korNokta/KorNoktaSelectModal";
import MobileHome from "./components/MobileHome";
import { Capacitor } from "@capacitor/core";
import {
  type HomeTheme,
  HOME_THEME_KEY,
  readStoredHomeTheme,
  getThemeBackgroundStyle,
  getThemeDataAttr,
} from "./lib/themeBackgrounds";
import {
  NAME_TO_TOPOID,
  NAME_TO_ENTRY,
  TOPOID_TO_DISPLAY,
  normalizeInput,
  getContinentIds,
  getFlagPool,
  getSilhouettePool,
  getSilhouetteRegion,
  isLandlocked,
  getNeighborCount,
  type Continent,
  type CountryEntry,
  type Difficulty,
} from "./data/countries";
import "./App.css";
import {
  playSound,
  stopSound,
  isSoundEnabled,
  setSoundEnabled,
  preloadSounds,
  getCountdownSoundMode,
  setCountdownSoundMode,
  shouldPlayCountdownSound,
  type CountdownSoundMode,
} from "./lib/sound";
import AuthModal from "./components/AuthModal";
import NicknameModal from "./components/NicknameModal";
import { UserProfileDropdown } from "./components/UserProfileDropdown";
import { LeaderboardModal } from "./components/LeaderboardModal";
import { SocialProvider } from "./components/SocialContext";
import { NotificationCenter } from "./components/NotificationCenter";
import { FriendsButton } from "./components/FriendsButton";
import { EmojiIcon, type EmojiIconName } from "./components/EmojiIcon";
import { UsernameChangeModal } from "./components/UsernameChangeModal";
import { AvatarPickerModal } from "./components/AvatarPickerModal";
import { ProfileEditModal } from "./components/ProfileEditModal";
import { BadgeShowcaseEditor } from "./components/BadgeShowcaseEditor";
import { BlockedUsersModal } from "./components/BlockedUsersModal";
import {
  getCurrentUser,
  loadOrCreateProfile,
  signOut,
  type Profile,
} from "./lib/auth";
import { supabase } from "./lib/supabase";
import {
  useGold,
  addGold,
  spendGold as spendGoldStore,
  canClaimDailyBonus,
  claimDailyBonus,
  setActiveProfile as setActiveGoldProfile,
  DAILY_BONUS,
} from "./lib/gold";
import {
  setActiveAchievementProfile,
  recordGameComplete,
  recordCorrectFlag,
} from "./lib/achievementStats";

/* ═══════════════════════════════════════════════════════════════
   TYPES
═══════════════════════════════════════════════════════════════ */
type AppScreen = "home" | "map-game" | "flag-game" | "silhouette-game" | "route-game" | "duel-game" | "duel-group-game" | "flag-duel-game" | "wheel-game" | "wheel-duel-game" | "wheel-group-game" | "conquest-game" | "conquest-rooms" | "conquest-join" | "cag-dedektifi" | "harita-dedektifi" | "harita-duel-game" | "kornokta-create" | "kornokta-join";

/** Why the auth modal was opened. Single-player modes never trigger it; the
 *  online gates below ("duel-gate" / "multi-gate" / "kusatma-gate") hide the
 *  guest button and route to the intended screen after a successful login. */
type AuthPromptReason =
  | "welcome"
  | "conquest-invite"
  | "kornokta-invite" | "kornokta-create" | "kornokta-join"
  | "duel-gate" | "multi-gate" | "kusatma-gate";

/** Online modes that require login (Düello + Çok Oyunculu). Maps each gated
 *  AppScreen to the auth-prompt reason driving the modal copy. Single-player
 *  and Kör Nokta (its own gating) screens are intentionally absent — they pass
 *  straight through navigateOnline() to setScreen. */
const ONLINE_GATED_SCREENS: Partial<Record<AppScreen, AuthPromptReason>> = {
  "duel-game":        "duel-gate",
  "flag-duel-game":   "duel-gate",
  "wheel-duel-game":  "duel-gate",
  "duel-group-game":  "multi-gate",
  "wheel-group-game": "multi-gate",
  "conquest-game":    "kusatma-gate",
  "conquest-join":    "kusatma-gate",
  "conquest-rooms":   "kusatma-gate",
};

/** Düello / Çok Oyunculu davet linkleri. Hepsi login gerektirir. OAuth redirect
 *  query string'i sildiği için kod sessionStorage'a yazılır ve dönüşte URL'e
 *  geri konur (conquest pattern) — böylece useInviteJoin auto-join'i okur. */
const ONLINE_INVITE_LINKS: {
  param: string;
  storageKey: string;
  screen: AppScreen;
  reason: AuthPromptReason;
}[] = [
  { param: "duel",       storageKey: "pending_invite_duel",       screen: "duel-game",        reason: "duel-gate" },
  { param: "flagDuel",   storageKey: "pending_invite_flagDuel",   screen: "flag-duel-game",   reason: "duel-gate" },
  { param: "wheelDuel",  storageKey: "pending_invite_wheelDuel",  screen: "wheel-duel-game",  reason: "duel-gate" },
  { param: "duelGroup",  storageKey: "pending_invite_duelGroup",  screen: "duel-group-game",  reason: "multi-gate" },
  { param: "wheelGroup", storageKey: "pending_invite_wheelGroup", screen: "wheel-group-game", reason: "multi-gate" },
];

/** Drops every Düello/Çok Oyunculu pending-invite anchor so a dismissed login
 *  prompt doesn't re-pester the user on the next reload. */
function clearPendingOnlineInvites() {
  try {
    for (const link of ONLINE_INVITE_LINKS) sessionStorage.removeItem(link.storageKey);
  } catch { /* sessionStorage disabled — best effort */ }
}

/** sessionStorage key mirroring the in-memory pendingOnlineTarget for a *normal*
 *  (non-invite) menu tap on a gated online mode. A Google OAuth round-trip
 *  reloads the app and wipes React state, so the target is persisted here and
 *  consumed once after auth settles (invite links use their own anchors above). */
const PENDING_ONLINE_TARGET_KEY = "pending_online_target";

/** Drops the persisted normal-menu online target — on dismiss, on guest, or
 *  once it has been consumed — so a later reload doesn't re-route the user. */
function clearPendingOnlineTarget() {
  try { sessionStorage.removeItem(PENDING_ONLINE_TARGET_KEY); }
  catch { /* sessionStorage disabled — best effort */ }
}
type GameMode        = "idle" | "timed" | "free" | "finished";
type ContinentFilter = Continent | "world";

interface BestScore {
  score: number; total: number;
  continent: ContinentFilter; duration: number;
  gameType: AppScreen; date: string;
}

/* ═══════════════════════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════════════════════ */
const DURATION_OPTIONS = [
  { label: "15 sn", value: 15  },
  { label: "30 sn", value: 30  },
  { label: "1 dk",  value: 60  },
  { label: "2 dk",  value: 120 },
  { label: "3 dk",  value: 180 },
  { label: "5 dk",  value: 300 },
];

const CONTINENT_OPTIONS: { label: string; short: string; value: ContinentFilter }[] = [
  { label: "🌍 Dünya",     short: "Dünya",     value: "world"         },
  { label: "🇪🇺 Avrupa",   short: "Avrupa",    value: "europe"        },
  { label: "🌏 Asya",      short: "Asya",      value: "asia"          },
  { label: "🌍 Afrika",    short: "Afrika",    value: "africa"        },
  { label: "🌎 K.Amerika", short: "K.Amerika", value: "north-america" },
  { label: "🌎 G.Amerika", short: "G.Amerika", value: "south-america" },
  { label: "🌊 Okyanusya", short: "Okyanusya", value: "oceania"       },
];

const DIFFICULTY_OPTIONS: { label: string; value: Difficulty; color: string }[] = [
  { label: "🧩 Kolay",  value: "easy",   color: "var(--green)"  },
  { label: "🔸 Normal", value: "normal", color: "var(--amber)"  },
  { label: "👑 Zor",    value: "hard",   color: "var(--red)"    },
  { label: "🗺️ Tümü",   value: "all",    color: "var(--muted)"  },
];

/** Per-correct-answer gold, awarded in bulk at game end.
 *  flag-game uses value=1 as a correct-answer counter; real gold is computed at flush via calcFlagGold. */
const GOLD_RATES: Record<AppScreen, number> = {
  "home": 0,
  "map-game": 2,
  "flag-game": 1,       // counts correct answers; banded reward applied at end
  "silhouette-game": 8,
  "route-game": 0,
  "duel-game": 0,
  "duel-group-game": 0,
  "flag-duel-game": 0,
  "wheel-game": 0,
  "wheel-duel-game": 0,
  "wheel-group-game": 0,
  "conquest-game": 0,
  "conquest-rooms": 0,
  "conquest-join": 0,
  "cag-dedektifi": 0,
  "harita-dedektifi": 0,
  "harita-duel-game": 0,
  "kornokta-create": 0,
  "kornokta-join": 0,
};

/** Band + duration-cap based gold for solo Flag Game. */
function calcFlagGold(correctCount: number, durationSec: number): number {
  const band =
    correctCount >= 25 ? 25 :
    correctCount >= 20 ? 20 :
    correctCount >= 15 ? 15 :
    correctCount >= 10 ? 10 :
    correctCount >=  5 ?  5 : 0;
  const cap =
    durationSec >= 300 ? 70 :
    durationSec >= 120 ? 40 :
    durationSec >=  60 ? 25 : 10;
  return Math.min(band, cap);
}

/** Hint costs */
const HINT_COSTS = {
  firstLetter: 15,
  continent:   20,
  letterCount: 25,
  region:      25,
  coast:       20,
  neighbors:   30,
} as const;
type HintType = keyof typeof HINT_COSTS;

const HINT_REASON: Record<HintType,
  "hint_first_letter" | "hint_letter_count" | "hint_continent" |
  "hint_region" | "hint_coast" | "hint_neighbors"
> = {
  firstLetter: "hint_first_letter",
  continent:   "hint_continent",
  letterCount: "hint_letter_count",
  region:      "hint_region",
  coast:       "hint_coast",
  neighbors:   "hint_neighbors",
};

const MATCH_REWARD_REASON: Partial<Record<AppScreen,
  "map_match_reward" | "silhouette_match_reward" | "flag_match_reward"
>> = {
  "map-game":        "map_match_reward",
  "silhouette-game": "silhouette_match_reward",
  "flag-game":       "flag_match_reward",
};

type HintState = Record<HintType, boolean>;
const EMPTY_HINTS: HintState = {
  firstLetter: false,
  continent:   false,
  letterCount: false,
  region:      false,
  coast:       false,
  neighbors:   false,
};

/* ─── BestScore localStorage helpers ─── */
const LS_KEY = "geoquiz_best_scores_v2";
function loadBests(): BestScore[] {
  try { const r = localStorage.getItem(LS_KEY); return r ? (JSON.parse(r) as BestScore[]) : []; }
  catch { return []; }
}
function saveBest(e: BestScore): BestScore[] {
  const all = loadBests();
  const key = e.gameType + "_" + e.continent + "_" + e.duration;
  const idx = all.findIndex(b => b.gameType + "_" + b.continent + "_" + b.duration === key);
  if (idx >= 0) { if (e.score > all[idx].score) all[idx] = e; } else all.push(e);
  try { localStorage.setItem(LS_KEY, JSON.stringify(all)); } catch {}
  return all;
}
function getBestForMode(gt: AppScreen, c: ContinentFilter, d: number): BestScore | null {
  return loadBests().find(b => b.gameType === gt && b.continent === c && b.duration === d) ?? null;
}

/* ─── Share helper ─── */
async function shareScore(
  score: number, total: number,
  continent: ContinentFilter, duration: number,
  gameType: AppScreen, difficulty?: Difficulty
): Promise<"shared" | "copied" | "failed"> {
  const pct     = Math.round((score / total) * 100);
  const cName   = CONTINENT_OPTIONS.find(c => c.value === continent)?.short ?? "Dünya";
  const dur     = DURATION_OPTIONS.find(d => d.value === duration)?.label ?? `${duration}sn`;
  const modeName =
    gameType === "flag-game"
      ? `Bayrak Modu${difficulty && difficulty !== "all" ? " (" + (DIFFICULTY_OPTIONS.find(d => d.value === difficulty)?.label ?? "") + ")" : ""}`
      : gameType === "silhouette-game"
      ? `Silüet Modu${difficulty && difficulty !== "all" ? " (" + (DIFFICULTY_OPTIONS.find(d => d.value === difficulty)?.label ?? "") + ")" : ""}`
      : "Ülke Yaz";
  const text = `Torble ${modeName} — ${cName} (${dur}): ${score}/${total} ülke — %${pct}. Sen geçebilir misin? 🌍`;
  if (typeof navigator.share === "function") {
    try { await navigator.share({ text }); return "shared"; } catch {}
  }
  try { await navigator.clipboard.writeText(text); return "copied"; }
  catch { return "failed"; }
}

/* ─── Shuffle ─── */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ═══════════════════════════════════════════════════════════════
   DROPDOWN
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
        disabled={disabled} onClick={() => {
  playSound("click");
  setOpen((o) => !o);
}}
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
    <button
  className={"dd-item" + (active ? " active" : "")}
  role="option"
  aria-selected={active}
  onClick={() => {
    playSound("click");
    onClick();
  }}
>
      {children}
    </button>
  );
}

/* ═══════════════════════════════════════════════════════════════
   HOME SCREEN
═══════════════════════════════════════════════════════════════ */

interface HomeProps {
  onSelect: (screen: AppScreen) => void;
  profile: Profile | null;
  /** Kör Nokta login-only: guest bir aksiyon seçince App auth modal'ı açar
   *  ve login sonrası ilgili ekrana yönlendirir. */
  onKorNoktaAuthRequired: (action: "create" | "join") => void;
  /** Native-app bottom nav: ranking ve profil App seviyesindeki mevcut
   *  chrome'a (LeaderboardModal / AuthModal / UserProfileDropdown) bağlanır. */
  onOpenRanking: () => void;
  onOpenProfile: () => void;
  /** Native-app only: true while the profile dropdown is open, so the bottom-nav
   *  Profil avatar can show its active (lifted/glowing) state. */
  profileOpen?: boolean;
}
function HomeScreen({ onSelect, profile, onKorNoktaAuthRequired, onOpenRanking, onOpenProfile, profileOpen }: HomeProps) {
const [showCountryMenu, setShowCountryMenu] = useState(false);
const [showFlagMenu, setShowFlagMenu] = useState(false);
const [showWheelMenu, setShowWheelMenu] = useState(false);
const [showConquestMenu, setShowConquestMenu] = useState(false);
const [showKorNoktaMenu, setShowKorNoktaMenu] = useState(false);
const [homeTheme, setHomeTheme] = useState<HomeTheme>(readStoredHomeTheme);
useEffect(() => {
  try { localStorage.setItem(HOME_THEME_KEY, homeTheme); } catch { /* ignore */ }
}, [homeTheme]);
  const modes: { id: AppScreen; icon: EmojiIconName; title: string; desc: string; available: boolean }[] = [
  { id: "map-game", icon: "globe", title: "Ülke Yaz", desc: "Tek oyuncu veya online oyna.", available: true },
  { id: "flag-game", icon: "flag", title: "Bayrak Modu", desc: "Bayrakları tanı! Her bayrak için ülke adını yaz.", available: true },
  { id: "silhouette-game", icon: "map", title: "Silüet Modu", desc: "Ülke şekillerini tanı! Silüetten tahmin et.", available: true },
  { id: "route-game", icon: "compass", title: "Rota Modu", desc: "Komşu ülkelerle hedefe ulaş.", available: true },
  { id: "wheel-game", icon: "target", title: "ÇARK MODU", desc: "Çarkın seçtiği ülkeyi haritada bul.", available: true },
  { id: "conquest-game", icon: "shield", title: "KUŞATMA", desc: "Bölgeleri kuşat, haritayı ele geçir.", available: true },
  { id: "kornokta-create", icon: "detective", title: "KÖR NOKTA", desc: "Raporlara güven, konumu bul.", available: true },
];
  return (
    <div className={"home-screen" + (homeTheme === "earth" ? " home-screen--earth" : homeTheme === "adventure" ? " home-screen--adventure" : homeTheme === "dark-space" ? " home-screen--dark-space" : "")}>
      <div className="home-hero">
        <img
          src="/assets/brand/torble-logo.png"
          alt="Torble"
          className="home-logo"
        />
        <p className="home-subtitle">Dünya bilginizi test edin.</p>
      </div>
      <div className="mode-grid">
        {modes.map((m, i) => (
          <div key={i} className={"mode-card" + (m.available ? "" : " mode-card--soon")}>
            {!m.available && <span className="soon-badge">Yakında</span>}
            <div className="mode-card-icon"><EmojiIcon name={m.icon} /></div>
            <div className="mode-card-content">
              <h2 className="mode-card-title">{m.title}</h2>
              <p className="mode-card-desc">{m.desc}</p>
            </div>
            <button
              className={"btn btn-accent mode-card-btn" + (m.available ? "" : " disabled")}
              disabled={!m.available}
              onClick={() => {
  if (!m.available) return;

  playSound("click");

  if (m.id === "map-game") {
    setShowCountryMenu(true);
  } else if (m.id === "flag-game") {
    setShowFlagMenu(true);
  } else if (m.id === "wheel-game") {
    setShowWheelMenu(true);
  } else if (m.id === "conquest-game") {
    setShowConquestMenu(true);
  } else if (m.id === "kornokta-create") {
    setShowKorNoktaMenu(true);
  } else {
    onSelect(m.id);
  }
}}
            >{m.available ? "Oyna" : "Yakında"}</button>
          </div>
        ))}
      </div>
      {/* Mobile-only app-style home (≤600px) — hidden on desktop via CSS.
          Routes through the same onSelect / select-modal flows as the
          desktop mode cards above; see components/MobileHome.tsx.
          App v1: Kör Nokta / panorama modes are desktop-web-only and
          intentionally absent from this mobile navigation. */}
      <MobileHome
        onPlay={onSelect}
        onOpenConquest={() => setShowConquestMenu(true)}
        onOpenRanking={onOpenRanking}
        onOpenProfile={onOpenProfile}
        isLoggedIn={!!profile?.username}
        avatarId={profile?.avatar_id}
        username={profile?.username}
        profileActive={profileOpen}
        themes={HOME_THEMES}
        activeTheme={homeTheme}
        onSelectTheme={(id) => setHomeTheme(id as HomeTheme)}
      />
      {showCountryMenu && (
  <div
    className="overlay"
    style={homeTheme !== "default" ? getThemeBackgroundStyle(homeTheme) : undefined}
    data-theme={getThemeDataAttr(homeTheme)}
    onClick={() => setShowCountryMenu(false)}
  >
    <div className="modal" onClick={(e) => e.stopPropagation()}>

      <h2><EmojiIcon name="globe" /> Ülke Yaz</h2>

      <button
        className="modal-btn"
        onClick={() => {
          playSound("click");
          setShowCountryMenu(false);
          onSelect("map-game");
        }}
      >
        <EmojiIcon name="gamepad" /> Tek Oyuncu
      </button>

      <button
        className="modal-btn"
        onClick={() => {
          playSound("click");
          setShowCountryMenu(false);
          onSelect("duel-game");
        }}
      >
        <EmojiIcon name="swords" /> Online 1v1
      </button>

      <button
        className="modal-btn"
        onClick={() => {
          playSound("click");
          setShowCountryMenu(false);
          onSelect("duel-group-game");
        }}
      >
        <EmojiIcon name="trophy" /> Çok Oyunculu
      </button>

      <button
        className="modal-close"
        onClick={() => {
  playSound("click");
  setShowCountryMenu(false);
}}
      >
        ✕
      </button>

    </div>
  </div>
)}

{showFlagMenu && (
  <div
    className="overlay"
    style={homeTheme !== "default" ? getThemeBackgroundStyle(homeTheme) : undefined}
    data-theme={getThemeDataAttr(homeTheme)}
    onClick={() => setShowFlagMenu(false)}
  >
    <div className="modal" onClick={(e) => e.stopPropagation()}>

      <h2><EmojiIcon name="flag" /> Bayrak Modu</h2>

      <button
        className="modal-btn"
        onClick={() => {
          playSound("click");
          setShowFlagMenu(false);
          onSelect("flag-game");
        }}
      >
        <EmojiIcon name="gamepad" /> Tek Oyuncu
      </button>

      <button
        className="modal-btn"
        onClick={() => {
          playSound("click");
          setShowFlagMenu(false);
          onSelect("flag-duel-game");
        }}
      >
        <EmojiIcon name="swords" /> Online 1v1
      </button>

      <button
        className="modal-close"
        onClick={() => {
  playSound("click");
  setShowFlagMenu(false);
}}
      >
        ✕
      </button>

    </div>
  </div>
)}

{showWheelMenu && (
  <div
    className="overlay"
    style={homeTheme !== "default" ? getThemeBackgroundStyle(homeTheme) : undefined}
    data-theme={getThemeDataAttr(homeTheme)}
    onClick={() => setShowWheelMenu(false)}
  >
    <div className="modal" onClick={(e) => e.stopPropagation()}>

      <h2><EmojiIcon name="target" /> Çark Modu</h2>

      <button
        className="modal-btn"
        onClick={() => {
          playSound("click");
          setShowWheelMenu(false);
          onSelect("wheel-game");
        }}
      >
        <EmojiIcon name="gamepad" /> Tek Oyuncu
      </button>

      <button
        className="modal-btn"
        onClick={() => {
          playSound("click");
          setShowWheelMenu(false);
          onSelect("wheel-duel-game");
        }}
      >
        <EmojiIcon name="swords" /> Online 1v1
      </button>

      <button
        className="modal-btn"
        onClick={() => {
          playSound("click");
          setShowWheelMenu(false);
          onSelect("wheel-group-game");
        }}
      >
        <EmojiIcon name="trophy" /> Çok Oyunculu
      </button>

      <button
        className="modal-close"
        onClick={() => {
          playSound("click");
          setShowWheelMenu(false);
        }}
      >
        ✕
      </button>

    </div>
  </div>
)}

{showKorNoktaMenu && (
  <KorNoktaSelectModal
    overlayStyle={homeTheme !== "default" ? getThemeBackgroundStyle(homeTheme) : undefined}
    themeAttr={getThemeDataAttr(homeTheme)}
    isLoggedIn={!!profile?.username}
    onCreate={() => {
      setShowKorNoktaMenu(false);
      onSelect("kornokta-create");
    }}
    onJoin={() => {
      setShowKorNoktaMenu(false);
      onSelect("kornokta-join");
    }}
    onRequireAuth={(action) => {
      setShowKorNoktaMenu(false);
      onKorNoktaAuthRequired(action);
    }}
    onClose={() => {
      playSound("click");
      setShowKorNoktaMenu(false);
    }}
  />
)}

{showConquestMenu && (
  <ConquestModeSelectModal
    overlayStyle={homeTheme !== "default" ? getThemeBackgroundStyle(homeTheme) : undefined}
    themeAttr={getThemeDataAttr(homeTheme)}
    isLoggedIn={!!profile?.username}
    onCreate={() => {
      setShowConquestMenu(false);
      onSelect("conquest-game");
    }}
    onJoinByCode={() => {
      setShowConquestMenu(false);
      onSelect("conquest-join");
    }}
    onBrowse={() => {
      setShowConquestMenu(false);
      onSelect("conquest-rooms");
    }}
    onClose={() => {
      playSound("click");
      setShowConquestMenu(false);
    }}
  />
)}

      {homeTheme === "earth" && <BlueEarthDecor />}

      <div className="home-studio-credit" aria-label="Yayıncı: Kavak Games">Kavak Games</div>
      <HomeSocialDock />
      <HomeThemePicker active={homeTheme} onChange={setHomeTheme} />
    </div>
  );
}

/* ─── Social dock: anchored bottom-left, mirrors the theme picker ─── */
const SOCIAL_LINKS: { id: string; label: string; href: string; path: JSX.Element }[] = [
  {
    id: "instagram",
    label: "Instagram",
    href: "https://instagram.com/playtorble",
    path: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <circle cx="12" cy="12" r="4" />
        <circle cx="17.2" cy="6.8" r="1.1" fill="currentColor" stroke="none" />
      </>
    ),
  },
  {
    id: "x",
    label: "X",
    href: "https://x.com/playtorble",
    // Solid wordmark glyph — uses fill, not stroke.
    path: (
      <path
        d="M18.244 2H21.5l-7.5 8.57L23 22h-6.93l-5.42-7.08L4.4 22H1.14l8.03-9.18L1 2h7.08l4.9 6.48L18.244 2zm-1.22 18h1.93L7.06 4H5.04l11.98 16z"
        fill="currentColor"
        stroke="none"
      />
    ),
  },
  {
    id: "tiktok",
    label: "TikTok",
    href: "https://tiktok.com/@playtorble",
    // Solid glyph — uses fill, not stroke.
    path: (
      <path
        d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43V8.71a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1.84-.14z"
        fill="currentColor"
        stroke="none"
      />
    ),
  },
];

function HomeSocialDock() {
  return (
    <nav className="home-social-dock" aria-label="Sosyal medya">
      {SOCIAL_LINKS.map(s => (
        <a
          key={s.id}
          href={s.href}
          target="_blank"
          rel="noreferrer noopener"
          className="home-social-link"
          aria-label={s.label}
          title={s.label}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            {s.path}
          </svg>
        </a>
      ))}
    </nav>
  );
}

const HOME_THEMES: { id: HomeTheme; name: string; swatch: string }[] = [
  { id: "default",    name: "Varsayılan",   swatch: "linear-gradient(135deg, #0a101d 0%, #1c3358 100%)" },
  { id: "earth",      name: "Mavi Dünya",   swatch: "linear-gradient(135deg, #1e6bd9 0%, #5fb3ff 100%)" },
  { id: "adventure",  name: "Adventure",    swatch: "linear-gradient(135deg, #0ea5e9 0%, #22c55e 100%)" },
  { id: "dark-space", name: "Karanlık Uzay", swatch: "linear-gradient(135deg, #050810 0%, #0d1b3e 100%)" },
];

function HomeThemePicker({ active, onChange }: { active: HomeTheme; onChange: (t: HomeTheme) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("touchstart", onDown, { passive: true });
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("touchstart", onDown);
    };
  }, [open]);
  return (
    <div ref={rootRef} className="home-theme-picker">
      {open && (
        <div className="map-theme-panel" role="menu" aria-label="Arka plan teması">
          {HOME_THEMES.map(t => (
            <button
              key={t.id}
              type="button"
              className={"map-theme-option" + (t.id === active ? " active" : "")}
              onClick={() => { playSound("click"); onChange(t.id); setOpen(false); }}
              role="menuitemradio"
              aria-checked={t.id === active}
            >
              <span className="map-theme-swatch" style={{ background: t.swatch }} />
              <span className="map-theme-name">{t.name}</span>
              {t.id === active && <span className="home-theme-check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className={"map-theme-toggle" + (open ? " open" : "")}
        onClick={() => { playSound("click"); setOpen(o => !o); }}
        aria-label="Arka plan teması"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Arka plan teması"
      >
        {/* layers icon — matches the in-game map theme picker */}
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 22 8 12 14 2 8 12 2" />
          <polyline points="2 14 12 20 22 14" />
        </svg>
      </button>
    </div>
  );
}

/* ─── Blue Earth decorative layer: half-earth img + CSS cartoon eyes ─── */
function BlueEarthDecor() {
  const leftEyeRef   = useRef<HTMLDivElement>(null);
  const rightEyeRef  = useRef<HTMLDivElement>(null);
  const leftPupilRef  = useRef<HTMLDivElement>(null);
  const rightPupilRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Touch/no-hover devices: keep pupils centered, skip listeners entirely.
    if (typeof window === "undefined") return;
    if (!window.matchMedia("(hover: hover)").matches) return;

    const MAX_OFFSET = 5; // px — pupil never leaves the white eye
    const target = { x: 0, y: 0, active: false };
    let rafId: number | null = null;

    const applyOne = (eye: HTMLDivElement | null, pupil: HTMLDivElement | null) => {
      if (!eye || !pupil) return;
      if (!target.active) {
        pupil.style.transform = "translate(-50%, -50%)";
        return;
      }
      const r = eye.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = target.x - cx;
      const dy = target.y - cy;
      const d = Math.hypot(dx, dy);
      const k = d > 0 ? Math.min(MAX_OFFSET, d) / d : 0;
      pupil.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;
    };

    const tick = () => {
      applyOne(leftEyeRef.current, leftPupilRef.current);
      applyOne(rightEyeRef.current, rightPupilRef.current);
      rafId = null;
    };
    const schedule = () => { if (rafId == null) rafId = requestAnimationFrame(tick); };

    const onMove = (e: MouseEvent) => {
      target.x = e.clientX; target.y = e.clientY; target.active = true;
      schedule();
    };
    const onLeave = () => { target.active = false; schedule(); };

    window.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("mouseleave", onLeave);
    window.addEventListener("blur", onLeave);

    return () => {
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("blur", onLeave);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, []);

  return (
    <div className="home-earth" aria-hidden="true">
      <img
        src="/assets/brand/earth-half.png"
        alt=""
        className="home-earth-img"
        draggable={false}
      />
      <div className="home-earth-eyes">
        <div ref={leftEyeRef} className="ee-eye">
          <div ref={leftPupilRef} className="ee-pupil">
            <span className="ee-highlight" />
          </div>
        </div>
        <div ref={rightEyeRef} className="ee-eye">
          <div ref={rightPupilRef} className="ee-pupil">
            <span className="ee-highlight" />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   GOLD BAR
═══════════════════════════════════════════════════════════════ */
interface GoldBarProps {
  gold: number; canBonus: boolean; onClaimBonus: () => void;
}
function GoldBar({ gold, canBonus, onClaimBonus }: GoldBarProps) {
  return (
    <div className="gold-bar">
      <span className="gold-amount">
        <span className="gold-icon"><EmojiIcon name="yellow-circle" /></span>
        <span className="gold-num">{gold}</span>
        <span className="gold-label">Gold</span>
      </span>
      {canBonus && (
        <button className="btn-bonus btn-sm" onClick={onClaimBonus} title="Günlük bonus al">
          +{DAILY_BONUS} Günlük Bonus
        </button>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   HINT PANEL
═══════════════════════════════════════════════════════════════ */
interface HintPanelProps {
  gold: number;
  hints: HintState;
  currentEntry: CountryEntry | null;
  isPlaying: boolean;
  mode?: "flag" | "silhouette";
  onBuyHint: (type: HintType) => void;
}
function HintPanel({ gold, hints, currentEntry, isPlaying, mode = "flag", onBuyHint }: HintPanelProps) {
  if (!isPlaying || !currentEntry) return null;

  const display = currentEntry.display;
  const contOpt = CONTINENT_OPTIONS.find(c => c.value === currentEntry.continent);

  const defs: { type: HintType; label: string; cost: number; value: string }[] = [
    { type: "firstLetter", label: "İlk Harf",    cost: HINT_COSTS.firstLetter, value: display.charAt(0).toUpperCase() + "…"        },
    { type: "continent",   label: "Kıta",         cost: HINT_COSTS.continent,   value: contOpt?.label ?? currentEntry.continent      },
    { type: "letterCount", label: "Harf Sayısı",  cost: HINT_COSTS.letterCount, value: display.replace(/\s/g, "").length + " harf"  },
  ];

  if (mode === "silhouette") {
    const region = getSilhouetteRegion(currentEntry.code);
    if (region) defs.push({ type: "region", label: "Bölge", cost: HINT_COSTS.region, value: region });
    defs.push({
      type: "coast",
      label: "Denize Kıyı",
      cost: HINT_COSTS.coast,
      value: isLandlocked(currentEntry.code) ? "Kıyısı yok" : "Kıyısı var",
    });
    const nbCount = getNeighborCount(currentEntry);
    if (nbCount !== null) {
      defs.push({
        type: "neighbors",
        label: "Komşu Sayısı",
        cost: HINT_COSTS.neighbors,
        value: nbCount + " komşu",
      });
    }
  }

  return (
    <div className="hint-panel">
      <span className="hint-title"><EmojiIcon name="bulb" /> İpucu:</span>
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
                <span className="hint-cost"><EmojiIcon name="yellow-circle" />{h.cost}</span>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   RESULT MODAL
═══════════════════════════════════════════════════════════════ */
interface ModalProps {
  score: number; total: number; pct: number;
  continent: ContinentFilter; selectedDuration: number;
  lastMode: "timed" | "free"; gameType: AppScreen;
  difficulty?: Difficulty;
  currentBest: BestScore | null;
  missedCountries: string[]; missedFilter: string; filteredMissed: string[];
  shareState: "idle" | "shared" | "copied" | "failed";
  earnedGold: number;    // gold earned this session — shown in modal
  onMissedFilter: (v: string) => void;
  onClose: () => void; onReplay: () => void; onShare: () => void; onHome: () => void;
}
function ResultModal(p: ModalProps) {
  const isAllFound = p.score >= p.total && p.total > 0;
  const shareLabel = p.shareState === "shared" ? "✓ Paylaşıldı!" : p.shareState === "copied" ? "✓ Kopyalandı!" : p.shareState === "failed" ? "✗ Hata" : "📋 Sonucu Paylaş";
  const diffLabel  = p.difficulty && p.difficulty !== "all" ? DIFFICULTY_OPTIONS.find(d => d.value === p.difficulty)?.label : null;
  return (
    <div className="modal-backdrop" onClick={p.onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-emoji"><EmojiIcon name={isAllFound ? "trophy" : "alarm"} /></div>
        <h2 className="modal-title">{isAllFound ? "Tebrikler!" : "Süre Doldu"}</h2>
        <div className="modal-score-wrap">
          <div className="modal-score-big">
            <span className="ms-num">{p.score}</span>
            <span className="ms-sep">/</span>
            <span className="ms-tot">{p.total}</span>
          </div>
          <div className="modal-pct-block">
            <span className="modal-pct">{p.pct}</span>
            <span className="modal-pct-sign">%</span>
          </div>
        </div>
        <div className="modal-bar-bg"><div className="modal-bar-fg" style={{ width: p.pct + "%" }} /></div>
        <p className="modal-context">
          {p.gameType === "flag-game" ? <><EmojiIcon name="flag" /> Bayrak</> : p.gameType === "silhouette-game" ? <><EmojiIcon name="map" /> Silüet</> : <><EmojiIcon name="globe" /> Ülke Yaz</>}
          {" · "}{CONTINENT_OPTIONS.find(c => c.value === p.continent)?.label}
          {diffLabel && <> · <span className="modal-diff">{diffLabel}</span></>}
          {" · "}{DURATION_OPTIONS.find(d => d.value === p.selectedDuration)?.label ?? p.selectedDuration + "sn"}
        </p>
        {/* Gold earned */}
        {p.earnedGold > 0 && (
          <div className="modal-gold-earned">
            <span className="modal-gold-icon"><EmojiIcon name="yellow-circle" /></span>
            <span className="modal-gold-text">+{p.earnedGold} Gold kazandın!</span>
          </div>
        )}
        {p.currentBest && (
          <p className="modal-best">
            {p.score > p.currentBest.score
              ? <><EmojiIcon name="party" /> Yeni rekor!</>
              : `En iyi: ${p.currentBest.score}/${p.currentBest.total} — ${DURATION_OPTIONS.find(d => d.value === p.currentBest!.duration)?.label} (${p.currentBest.date})`}
          </p>
        )}
        {p.missedCountries.length > 0 && (
          <div className="modal-missed">
            <div className="missed-header">
              <span className="missed-title">Bulunamayan <strong>{p.missedCountries.length}</strong> ülke</span>
              <input type="text" className="missed-search" placeholder="Filtrele…"
                value={p.missedFilter} onChange={e => p.onMissedFilter(e.target.value)} />
            </div>
            <div className="missed-list">
              {p.filteredMissed.length > 0
                ? p.filteredMissed.map(c => <span key={c} className="missed-chip">{c}</span>)
                : <span className="missed-empty">Sonuç yok</span>}
            </div>
          </div>
        )}
        <div className="modal-actions">
          <button className="btn btn-ghost"  onClick={p.onHome}>⌂ Ana Menü</button>
          <button className="btn btn-accent" onClick={p.onReplay}>↺ Tekrar</button>
          <button className={"btn btn-share" + (p.shareState !== "idle" ? " share-done" : "")} onClick={p.onShare}>{shareLabel}</button>
        </div>
        <button className="modal-close" onClick={p.onClose} aria-label="Kapat">✕</button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   TOP BAR
═══════════════════════════════════════════════════════════════ */
interface TopBarProps {
  gameType: AppScreen;
  score: number; total: number;
  mode: GameMode; isPlaying: boolean;
  continent: ContinentFilter; selectedDuration: number;
  timeLeft: number; timerPct: number; timerColor: string;
  lastMode: "timed" | "free";
  continentLabel: string; durationLabel: string; modeLabel: string;
  currentBest: BestScore | null;
  showLabels?: boolean;
  feedback: "correct" | "wrong" | "dup" | null;
  inputRef: React.RefObject<HTMLInputElement>;
  input: string; placeholder: string;
  difficulty?: Difficulty;
  onDifficultyChange?: (d: Difficulty) => void;
  onInput: (v: string) => void;
  onGuess: () => void;
  onSkip?: () => void;
  onReset: () => void; onHome: () => void;
  onStartGame: (m: "timed" | "free") => void;
  onContinentChange: (c: ContinentFilter) => void;
  onDurationChange: (d: number) => void;
  onToggleLabels?: (v: boolean) => void;
  gold: number; canBonus: boolean; onClaimBonus: () => void;
}
function TopBar(p: TopBarProps) {
  const inputRowClass = ["bar-row bar-input", p.feedback ?? ""].filter(Boolean).join(" ");
  const diffOpt = p.difficulty ? DIFFICULTY_OPTIONS.find(d => d.value === p.difficulty) : null;
  // State classes drive the mobile-only compact HUD via CSS (see .control-bar.is-playing rules).
  const barClass = [
    "control-bar",
    `gt-${p.gameType}`,
    p.isPlaying ? "is-playing" : "",
  ].filter(Boolean).join(" ");
  const modeShort = p.mode === "timed" ? "Süreli" : "Serbest";

  // Mobile settings panel — the gear button below opens a panel that re-renders
  // the same Dropdowns from the desktop layout. State (continent, difficulty,
  // duration, mode) lives in the parent component, so this is purely a UI
  // surface: every change still goes through the same onChange callbacks and
  // inherits the same disabled-during-play behaviour as the desktop bar.
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  const settingsRootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!mobileSettingsOpen) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (settingsRootRef.current && !settingsRootRef.current.contains(e.target as Node)) {
        setMobileSettingsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileSettingsOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown, { passive: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [mobileSettingsOpen]);
  // Auto-close panel when crossing into desktop width, so reopening a small
  // window won't leave a stale-open panel offscreen.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 601px)");
    const onChange = () => { if (mq.matches) setMobileSettingsOpen(false); };
    if (mq.matches) setMobileSettingsOpen(false);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return (
    <div className={barClass}>
      <GoldBar gold={p.gold} canBonus={p.canBonus} onClaimBonus={p.onClaimBonus} />
      {/* Mobile-only compact info chip — non-interactive, shown during active map play */}
      <div className="bar-mobile-info" aria-hidden="true">
        <span className="bar-mobile-info-text">
          <EmojiIcon name="globe" /> {p.continentLabel.replace(/^[^\p{L}]+/u, "")}
          {diffOpt && p.difficulty && p.difficulty !== "all" ? ` • ${diffOpt.label.replace(/^[^\p{L}]+/u, "")}` : ""}
          {" • "}{p.durationLabel.replace(/^[^\p{L}\d]+/u, "")}
          {" • "}{modeShort}
        </span>
      </div>
      {/* Row 1 */}
      <div className="bar-row bar-top">
        <button
  className="back-btn"
  onClick={() => {
    playSound("click");
    p.onHome();
  }}
  title="Ana Menü"
>
          <span>←</span><span className="back-label">Menü</span>
        </button>
        <div className="bar-dropdowns">
          <Dropdown label={p.continentLabel} disabled={p.isPlaying}>
            {CONTINENT_OPTIONS.map(opt => (
              <DDItem key={opt.value} active={p.continent === opt.value}
                onClick={() => p.onContinentChange(opt.value)}>{opt.label}</DDItem>
            ))}
          </Dropdown>
          {(p.gameType === "flag-game" || p.gameType === "silhouette-game") && p.onDifficultyChange && (
            <Dropdown label={diffOpt?.label ?? "🟡 Normal"} disabled={p.isPlaying} align="right">
              <div className="dd-section-label">Zorluk</div>
              {DIFFICULTY_OPTIONS.map(opt => (
                <DDItem key={opt.value} active={p.difficulty === opt.value}
                  onClick={() => p.onDifficultyChange!(opt.value)}>{opt.label}</DDItem>
              ))}
            </Dropdown>
          )}
          <Dropdown label={"⏱ " + p.durationLabel} disabled={p.isPlaying} align="right">
            <div className="dd-section-label">Süre</div>
            {DURATION_OPTIONS.map(opt => (
              <DDItem key={opt.value} active={p.selectedDuration === opt.value}
                onClick={() => p.onDurationChange(opt.value)}>{opt.label}</DDItem>
            ))}
            <div className="dd-divider" />
            <div className="dd-section-label">Mod</div>
            <DDItem active={!p.isPlaying && p.lastMode === "free"}  onClick={() => { if (!p.isPlaying) p.onStartGame("free");  }}>∞ Serbest</DDItem>
            <DDItem active={!p.isPlaying && p.lastMode === "timed"} onClick={() => { if (!p.isPlaying) p.onStartGame("timed"); }}>⏱ Süreli</DDItem>
          </Dropdown>
        </div>
        <div className="bar-right">
          <div className="score-pill">
            <span className="score-n">{p.score}</span>
            <span className="score-sep">/</span>
            <span className="score-total">{p.total}</span>
            <span className="score-lbl">ülke</span>
          </div>
          {p.mode === "timed" && (
            <div className="timer-ring-wrap">
              <svg viewBox="0 0 42 42" className="timer-svg">
                <circle cx="21" cy="21" r="17" fill="none" stroke="var(--border)" strokeWidth="3" />
                <circle cx="21" cy="21" r="17" fill="none"
                  stroke={p.timerColor} strokeWidth="3"
                  strokeDasharray="106.8"
                  strokeDashoffset={106.8 - (p.timerPct / 100) * 106.8}
                  strokeLinecap="round"
                  style={{ transform: "rotate(-90deg)", transformOrigin: "50% 50%", transition: "stroke-dashoffset 0.9s linear, stroke 0.4s" }} />
              </svg>
              <span className="timer-num" style={{ color: p.timerColor }}>{p.timeLeft}</span>
            </div>
          )}
          {/* Mobile-only gear button — opens the compact settings panel.
              Hidden on desktop and on non-map game types via CSS. */}
          <div className="bar-settings-wrap" ref={settingsRootRef}>
            <button
              type="button"
              className={"bar-settings-btn" + (mobileSettingsOpen ? " open" : "")}
              onClick={() => { playSound("click"); setMobileSettingsOpen(o => !o); }}
              aria-haspopup="menu"
              aria-expanded={mobileSettingsOpen}
              aria-label="Ayarlar"
              title="Ayarlar"
            >
              <span aria-hidden="true">⚙️</span>
            </button>
            {mobileSettingsOpen && (
              <div className="bar-settings-panel" role="menu" aria-label="Oyun ayarları">
                <div className="bar-settings-header">
                  <span className="bar-settings-title">⚙️ Ayarlar</span>
                  <button
                    type="button"
                    className="bar-settings-close"
                    onClick={() => { playSound("click"); setMobileSettingsOpen(false); }}
                    aria-label="Kapat"
                  >✕</button>
                </div>
                <div className="bar-settings-row">
                  <span className="bar-settings-lbl">🌍 Bölge</span>
                  <Dropdown label={p.continentLabel} disabled={p.isPlaying}>
                    {CONTINENT_OPTIONS.map(opt => (
                      <DDItem key={opt.value} active={p.continent === opt.value}
                        onClick={() => p.onContinentChange(opt.value)}>{opt.label}</DDItem>
                    ))}
                  </Dropdown>
                </div>
                {(p.gameType === "flag-game" || p.gameType === "silhouette-game") && p.onDifficultyChange && (
                  <div className="bar-settings-row">
                    <span className="bar-settings-lbl">🔶 Zorluk</span>
                    <Dropdown label={diffOpt?.label ?? "🟡 Normal"} disabled={p.isPlaying} align="right">
                      {DIFFICULTY_OPTIONS.map(opt => (
                        <DDItem key={opt.value} active={p.difficulty === opt.value}
                          onClick={() => p.onDifficultyChange!(opt.value)}>{opt.label}</DDItem>
                      ))}
                    </Dropdown>
                  </div>
                )}
                <div className="bar-settings-row">
                  <span className="bar-settings-lbl">⏱ Süre</span>
                  <Dropdown label={p.durationLabel} disabled={p.isPlaying} align="right">
                    {DURATION_OPTIONS.map(opt => (
                      <DDItem key={opt.value} active={p.selectedDuration === opt.value}
                        onClick={() => p.onDurationChange(opt.value)}>{opt.label}</DDItem>
                    ))}
                  </Dropdown>
                </div>
                <div className="bar-settings-row">
                  <span className="bar-settings-lbl">🎮 Mod</span>
                  <Dropdown label={p.mode === "timed" ? "⏱ Süreli" : "∞ Serbest"} disabled={p.isPlaying} align="right">
                    <DDItem active={!p.isPlaying && p.lastMode === "free"}
                      onClick={() => { if (!p.isPlaying) p.onStartGame("free"); }}>∞ Serbest</DDItem>
                    <DDItem active={!p.isPlaying && p.lastMode === "timed"}
                      onClick={() => { if (!p.isPlaying) p.onStartGame("timed"); }}>⏱ Süreli</DDItem>
                  </Dropdown>
                </div>
                {p.gameType === "map-game" && p.onToggleLabels && (
                  <div className="bar-settings-row">
                    <span className="bar-settings-lbl">🏷️ İsimler</span>
                    <label className="toggle-label">
                      <input type="checkbox" className="toggle-cb"
                        checked={p.showLabels ?? false}
                        onChange={e => p.onToggleLabels!(e.target.checked)} />
                      <span className="toggle-track"><span className="toggle-thumb" /></span>
                    </label>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {/* Row 2: input */}
      <div className={inputRowClass}>
        <input ref={p.inputRef} type="text" className="guess-input"
          placeholder={p.placeholder} value={p.input} disabled={!p.isPlaying}
          onChange={e => p.onInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") p.onGuess(); }}
          autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} />
        {p.isPlaying && (
          <>
            <button className="btn btn-accent" onClick={p.onGuess}>Gir</button>
            {p.onSkip && (
              <button className="btn btn-skip" onClick={p.onSkip} title="Pas Geç (ESC)">Pas</button>
            )}
            <button className="btn btn-ghost" onClick={p.onReset} title="Sıfırla">✕</button>
          </>
        )}
        {!p.isPlaying && p.mode !== "finished" && (
          <div className="start-btns">
            <button className="btn btn-accent btn-sm" onClick={() => p.onStartGame("free")}>∞ Serbest</button>
            <button className="btn btn-danger btn-sm" onClick={() => p.onStartGame("timed")}>⏱ Süreli</button>
          </div>
        )}
        {p.mode === "finished" && (
          <button className="btn btn-ghost" onClick={p.onReset}>✕</button>
        )}
      </div>
      {/* Row 3: feedback | best | toggle | diff badge */}
      <div className="bar-row bar-bottom">
        <div className="feedback-slot">
          {p.feedback === "correct" && <span className="fb fb-ok">✓ Doğru!</span>}
          {p.feedback === "wrong"   && <span className="fb fb-no">✗ Bulunamadı</span>}
          {p.feedback === "dup"     && <span className="fb fb-dup">Zaten bulundu</span>}
          {!p.isPlaying && p.mode !== "finished" && !p.feedback && (
            <span className="fb fb-hint">{p.continentLabel} · {p.durationLabel} · {p.modeLabel}</span>
          )}
        </div>
        {p.currentBest && (
          <div className="best-badge" title={"Tarih: " + p.currentBest.date}>
            <span className="best-icon"><EmojiIcon name="trophy" /></span>
            <span className="best-val">{p.currentBest.score}/{p.currentBest.total}</span>
            <span className="best-meta">
              {DURATION_OPTIONS.find(d => d.value === p.currentBest!.duration)?.label}
              {" · "}{CONTINENT_OPTIONS.find(c => c.value === p.currentBest!.continent)?.short}
            </span>
          </div>
        )}
        {p.gameType === "map-game" && p.onToggleLabels && (
          <label className="toggle-label">
            <input type="checkbox" className="toggle-cb"
              checked={p.showLabels ?? false} onChange={e => p.onToggleLabels!(e.target.checked)} />
            <span className="toggle-track"><span className="toggle-thumb" /></span>
            <span className="toggle-text">İsimler</span>
          </label>
        )}
        {(p.gameType === "flag-game" || p.gameType === "silhouette-game") && p.isPlaying && p.difficulty && p.difficulty !== "all" && (
          <div className="diff-badge" style={{ borderColor: diffOpt?.color, color: diffOpt?.color }}>
            {diffOpt?.label}
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   GAME CORE HOOK
   Gold is tracked via refs during gameplay and only flushed to
   localStorage at game-end — this prevents the "re-adding reward
   on every render" bug and keeps hints properly scoped.
═══════════════════════════════════════════════════════════════ */
function useGameCore(
  gameType: AppScreen,
  continent: ContinentFilter,
  selectedDuration: number,
  countdownSoundMode: CountdownSoundMode
) {
  const [mode,         setMode]        = useState<GameMode>("idle");
  const [guessedISOs,  setGuessedISOs] = useState<Set<string>>(new Set());
  const [lastGuessed,  setLastGuessed] = useState<string | null>(null);
  const [input,        setInput]       = useState("");
  const [feedback,     setFeedback]    = useState<"correct" | "wrong" | "dup" | null>(null);
  const [timeLeft,     setTimeLeft]    = useState(selectedDuration);
  const countdownPlayedRef = useRef(false);
  // Wall-clock start time — set when timed game begins, null otherwise.
  // Using Date.now() means the timer keeps running even when the tab is hidden.
  const gameStartTimeRef = useRef<number | null>(null);
  const rafRef           = useRef<number | null>(null);
  const [showModal,    setShowModal]   = useState(false);
  const [shareState,   setShareState]  = useState<"idle" | "shared" | "copied" | "failed">("idle");
  const [lastMode,     setLastMode]    = useState<"timed" | "free">("free");
  const [bests,        setBests]       = useState<BestScore[]>(() => loadBests());
  const [missedFilter, setMissedFilter] = useState("");

  // Gold: shared module (Supabase for logged-in users, localStorage for guests)
  const gold = useGold();
  const [canBonus,     setCanBonus]    = useState<boolean>(() => canClaimDailyBonus());

  // Per-session gold tracking (not stored until game ends)
  const pendingGoldRef   = useRef(0);   // gold to be awarded this session
  const goldRewardedRef  = useRef(false); // prevent double-awarding per game

  const inputRef    = useRef<HTMLInputElement>(null);
  const timerRef    = useRef<ReturnType<typeof setInterval> | null>(null); // kept for legacy cleanup
  const feedbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isPlaying    = mode === "free" || mode === "timed";
  const activeIds    = useMemo(() => getContinentIds(continent), [continent]);
  const totalInScope = activeIds.size;
  const scoreInScope = useMemo(() => [...guessedISOs].filter(id => activeIds.has(id)).length, [guessedISOs, activeIds]);

  useEffect(() => {
  if (mode !== "timed") {
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

  if (countdownLimit === 0 || selectedDuration <= countdownLimit) {
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
}, [mode, timeLeft, selectedDuration, countdownSoundMode]);

  const missedCountries = useMemo(() => {
    if (mode !== "finished") return [];
    return [...activeIds]
      .filter(id => !guessedISOs.has(id) && TOPOID_TO_DISPLAY[id])
      .map(id => TOPOID_TO_DISPLAY[id])
      .sort((a, b) => a.localeCompare(b, "tr"));
  }, [mode, activeIds, guessedISOs]);

  const filteredMissed = useMemo(() => {
    const q = missedFilter.trim().toLowerCase();
    return q ? missedCountries.filter(c => c.toLowerCase().includes(q)) : missedCountries;
  }, [missedCountries, missedFilter]);

  const currentBest = useMemo(
    () => getBestForMode(gameType, continent, selectedDuration),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bests, continent, selectedDuration, gameType]
  );

  const triggerFeedback = useCallback((type: "correct" | "wrong" | "dup") => {
    if (feedbackRef.current) clearTimeout(feedbackRef.current);
    setFeedback(type);
    feedbackRef.current = setTimeout(() => setFeedback(null), 700);
  }, []);

  /** Accumulate pending gold for ONE correct answer (call from game components) */
  const addPendingGold = useCallback((hintUsed: boolean) => {
    const base = GOLD_RATES[gameType] ?? 0;
    // flag-game: base=1 acts as a counter; banding is applied at flush, so no hint penalty here
    const reward = (gameType === "flag-game") ? base : (hintUsed ? Math.floor(base * 0.5) : base);
    pendingGoldRef.current += reward;
  }, [gameType]);

  /** Flush pending gold to persistent store (Supabase for logged-in, localStorage for guests). */
  const flushGold = useCallback(() => {
    if (goldRewardedRef.current) return; // already flushed this session
    goldRewardedRef.current = true;
    let pending = pendingGoldRef.current;
    // flag-game: pendingGoldRef holds correct-answer count; convert to banded reward
    if (gameType === "flag-game") {
      pending = calcFlagGold(pendingGoldRef.current, selectedDuration);
      pendingGoldRef.current = pending; // update so modal shows the real earned amount
    }
    if (pending > 0) {
      addGold(pending, MATCH_REWARD_REASON[gameType] ?? "gameplay_award");
    }
  }, [gameType, selectedDuration]);

  const endGame = useCallback((won?: boolean) => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    gameStartTimeRef.current = null;
    void won;
    flushGold(); // award gold when game ends
    setMode("finished");
    setShowModal(true);
    setMissedFilter("");
  }, [flushGold]);

  // Save best score when mode becomes "finished"
  useEffect(() => {
    if (mode !== "finished") return;
    setBests(saveBest({
      score: scoreInScope, total: totalInScope,
      continent, duration: selectedDuration, gameType,
      date: new Date().toLocaleDateString("tr-TR"),
    }));

    // Achievement stats: this single-player (OFFLINE) game just completed.
    //   map-game        → country mode completion ONLY. Offline Ülke Yaz must
    //                     NOT feed Dünya Gezgini (uniqueCorrectCountryIds) — that
    //                     achievement is online-only to prevent farming.
    //   flag-game       → flag mode completion + Bayrak Ustası (offline allowed).
    //   silhouette-game → silhouette mode (completion only)
    // Runs once per game (mode flips to "finished" exactly once).
    if (gameType === "map-game") {
      recordGameComplete({ modeFamily: "country" });
    } else if (gameType === "flag-game") {
      recordCorrectFlag("flag_offline", guessedISOs.size);
      recordGameComplete({ modeFamily: "flag" });
    } else if (gameType === "silhouette-game") {
      recordGameComplete({ modeFamily: "silhouette" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ── Real-time wall-clock timer ──
  // Uses Date.now() so it stays accurate even when the tab is hidden or
  // the browser throttles setInterval. A rAF loop checks the elapsed time
  // on every visible frame; visibilitychange re-checks on tab focus.
  useEffect(() => {
    if (mode !== "timed") return;

    // Record start time (or resume time if we re-enter this effect)
    if (!gameStartTimeRef.current) {
      gameStartTimeRef.current = Date.now();
    }
    const startTime    = gameStartTimeRef.current;
    const totalMs      = selectedDuration * 1000;
    let   ended        = false;

    const tick = () => {
      if (ended) return;
      const elapsed  = Date.now() - startTime;
      const remaining = Math.max(0, Math.ceil((totalMs - elapsed) / 1000));
      setTimeLeft(remaining);
      if (elapsed >= totalMs) {
        ended = true;
        endGame();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    // Also fire on visibility restore so display snaps immediately
    const onVisible = () => {
      if (document.visibilityState === "visible" && !ended) tick();
    };
    document.addEventListener("visibilitychange", onVisible);

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      ended = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [mode, endGame, selectedDuration]);

  const startGame = useCallback((m: "timed" | "free") => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    gameStartTimeRef.current = null; // will be set fresh when timed effect runs
    // Reset per-session gold tracking
    pendingGoldRef.current  = 0;
    goldRewardedRef.current = false;
    setLastMode(m);
    setGuessedISOs(new Set());
    setLastGuessed(null);
    setInput("");
    setFeedback(null);
    setTimeLeft(selectedDuration);
    setMode(m);
    setShowModal(false);
    setShareState("idle");
    setTimeout(() => inputRef.current?.focus(), 80);
  }, [selectedDuration]);

  const resetGame = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    gameStartTimeRef.current = null;
    pendingGoldRef.current  = 0;
    goldRewardedRef.current = false;
    setMode("idle");
    setGuessedISOs(new Set());
    setLastGuessed(null);
    setInput("");
    setFeedback(null);
    setTimeLeft(selectedDuration);
    setShowModal(false);
    setShareState("idle");
  }, [selectedDuration]);

  const handleClaimBonus = useCallback(() => {
    const result = claimDailyBonus();
    if (result === null) {
      setCanBonus(false);
      return;
    }
    setCanBonus(false);
  }, []);

  /** Spend gold for a hint (immediate deduction) */
  const spendGold = useCallback(
    (amount: number, reason?: Parameters<typeof spendGoldStore>[1]) => {
      spendGoldStore(amount, reason);
    },
    []
  );

  const handleShare = useCallback(async (difficulty?: Difficulty) => {
    const result = await shareScore(scoreInScope, totalInScope, continent, selectedDuration, gameType, difficulty);
    setShareState(result);
    if (result !== "failed") setTimeout(() => setShareState("idle"), 2500);
  }, [scoreInScope, totalInScope, continent, selectedDuration, gameType]);

  return {
    mode, setMode, guessedISOs, setGuessedISOs, lastGuessed, setLastGuessed,
    input, setInput, feedback, triggerFeedback,
    timeLeft, showModal, setShowModal,
    shareState, lastMode, missedFilter, setMissedFilter,
    isPlaying, activeIds, totalInScope, scoreInScope, missedCountries, filteredMissed,
    currentBest, bests, inputRef, timerRef,
    gold, canBonus, spendGold, handleClaimBonus, addPendingGold,
    pendingGoldRef,
    startGame, resetGame, endGame, handleShare,
  };
}

/* ═══════════════════════════════════════════════════════════════
   MAP GAME
═══════════════════════════════════════════════════════════════ */
interface MapGameProps {
  continent: ContinentFilter;
  selectedDuration: number;
  countdownSoundMode: CountdownSoundMode;
  onContinentChange: (c: ContinentFilter) => void;
  onDurationChange: (d: number) => void;
  onHome: () => void;
}
function MapGame({
  continent,
  selectedDuration,
  countdownSoundMode,
  onContinentChange,
  onDurationChange,
  onHome,
}: MapGameProps) {
  const g = useGameCore("map-game", continent, selectedDuration, countdownSoundMode);
  const [showLabels, setShowLabels] = useState(false);
  const [mapResetKey, setMapResetKey] = useState(0);

  const handleGuess = () => {
    if (!g.isPlaying) return;
    const norm = normalizeInput(g.input);
    if (!norm) return;
    const topoId = NAME_TO_TOPOID[norm];
    if (!topoId || !g.activeIds.has(topoId)) {
  g.triggerFeedback("wrong");
  g.setInput(""); // 🔥 input temizlenir
  return;
}
    if (g.guessedISOs.has(topoId)) { g.triggerFeedback("dup"); g.setInput(""); return; }
    const next = new Set(g.guessedISOs);
    next.add(topoId);
    g.setGuessedISOs(next);
    g.setLastGuessed(topoId);
    g.setInput("");
    g.triggerFeedback("correct");
    g.addPendingGold(false); // map mode: no hints, no reduction
    if ([...next].filter(id => g.activeIds.has(id)).length >= g.totalInScope) g.endGame(true);
  };

  const handleContinentChange = (c: ContinentFilter) => {
    if (g.isPlaying) return;
    onContinentChange(c);
    setMapResetKey(k => k + 1);
  };
  const handleStartGame = (m: "timed" | "free") => { setMapResetKey(k => k + 1); g.startGame(m); };
  const handleReset = () => { setMapResetKey(k => k + 1); g.resetGame(); };

  const timerPct   = (g.timeLeft / selectedDuration) * 100;
  const timerColor = g.timeLeft > selectedDuration * 0.33 ? "var(--accent)" : g.timeLeft > selectedDuration * 0.13 ? "#f59e0b" : "#ef4444";
  const pct        = g.totalInScope > 0 ? Math.round((g.scoreInScope / g.totalInScope) * 100) : 0;
  const continentLabel = CONTINENT_OPTIONS.find(c => c.value === continent)?.label ?? "Dünya";
  const durationLabel  = DURATION_OPTIONS.find(d => d.value === selectedDuration)?.label ?? "1 dk";
  const modeLabel      = g.lastMode === "timed" ? "⏱ Süreli" : "∞ Serbest";
  const placeholder    = g.mode === "idle" ? "Önce bir mod seç" : g.mode === "finished" ? "Oyun bitti" : "Ülke adı yaz… (Enter)";

  return (
    <div className="app">
      <TopBar
        gameType="map-game" score={g.scoreInScope} total={g.totalInScope}
        mode={g.mode} isPlaying={g.isPlaying}
        continent={continent} selectedDuration={selectedDuration}
        timeLeft={g.timeLeft} timerPct={timerPct} timerColor={timerColor}
        lastMode={g.lastMode}
        continentLabel={continentLabel} durationLabel={durationLabel} modeLabel={modeLabel}
        currentBest={g.currentBest} showLabels={showLabels} feedback={g.feedback}
        inputRef={g.inputRef} input={g.input} placeholder={placeholder}
        onInput={g.setInput} onGuess={handleGuess} onReset={handleReset} onHome={onHome}
        onStartGame={handleStartGame} onContinentChange={handleContinentChange}
        onDurationChange={onDurationChange} onToggleLabels={setShowLabels}
        gold={g.gold} canBonus={g.canBonus} onClaimBonus={g.handleClaimBonus}
      />
      <div className="map-area">
        <WorldMap guessedISOs={g.guessedISOs} lastGuessed={g.lastGuessed}
          showLabels={showLabels} activeIds={g.activeIds} resetKey={mapResetKey}
          region={continent} />
      </div>
      {g.showModal && g.mode === "finished" && (
        <ResultModal
          score={g.scoreInScope} total={g.totalInScope} pct={pct}
          continent={continent} selectedDuration={selectedDuration}
          lastMode={g.lastMode} gameType="map-game"
          currentBest={g.currentBest}
          missedCountries={g.missedCountries} missedFilter={g.missedFilter}
          filteredMissed={g.filteredMissed} shareState={g.shareState}
          earnedGold={g.pendingGoldRef.current}
          onMissedFilter={g.setMissedFilter}
          onClose={() => g.setShowModal(false)}
          onReplay={() => handleStartGame(g.lastMode)}
          onShare={() => g.handleShare()}
          onHome={onHome}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   FLAG GAME
═══════════════════════════════════════════════════════════════ */
interface FlagGameProps {
  continent: ContinentFilter;
  selectedDuration: number;
  countdownSoundMode: CountdownSoundMode;
  onContinentChange: (c: ContinentFilter) => void;
  onDurationChange: (d: number) => void;
  onHome: () => void;
}
function FlagGame({
  continent,
  selectedDuration,
  countdownSoundMode,
  onContinentChange,
  onDurationChange,
  onHome,
}: FlagGameProps) {
  const g = useGameCore("flag-game", continent, selectedDuration, countdownSoundMode);
  const [difficulty,  setDifficulty]  = useState<Difficulty>("normal");
  const [flagQueue,   setFlagQueue]   = useState<CountryEntry[]>([]);
  const [currentFlag, setCurrentFlag] = useState<CountryEntry | null>(null);
  const [flagIndex,   setFlagIndex]   = useState(0);
  const [imgError,    setImgError]    = useState(false);
  const [skipAnswer,  setSkipAnswer]  = useState<string | null>(null);
  const skipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hints are LOCAL to this component and strictly per-question.
  // We use a ref for the "key" so the state is always fresh when a new question arrives.
  const [hints, setHints] = useState<HintState>(EMPTY_HINTS);
  // Track whether ANY hint was used for the current question (for gold reduction)
  const hintUsedThisQRef = useRef(false);

  const resetHints = useCallback(() => {
    setHints(EMPTY_HINTS);
    hintUsedThisQRef.current = false;
  }, []);

  const handleBuyHint = useCallback((type: HintType) => {
    const cost = HINT_COSTS[type];
    if (g.gold < cost) return;
    g.spendGold(cost, HINT_REASON[type]);
    setHints(prev => ({ ...prev, [type]: true }));
    hintUsedThisQRef.current = true;
  }, [g]);

  const flagPool  = useMemo(() => getFlagPool(continent, difficulty), [continent, difficulty]);
  const flagTotal = flagPool.length;
  const flagScore = useMemo(() => {
    const ids = new Set(flagPool.map(c => c.topoId).filter(Boolean));
    return [...g.guessedISOs].filter(id => ids.has(id)).length;
  }, [g.guessedISOs, flagPool]);

  const buildQueue = useCallback(() => {
    const q = shuffle([...flagPool]);
    setFlagQueue(q);
    setCurrentFlag(q[0] ?? null);
    setFlagIndex(0);
    setImgError(false);
    setSkipAnswer(null);
    resetHints();
  }, [flagPool, resetHints]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (g.isPlaying) buildQueue(); }, [g.mode]);

  const advanceTo = useCallback((pool: CountryEntry[], idx: number) => {
    const next = idx + 1;
    if (next < pool.length) {
      setCurrentFlag(pool[next]);
      setFlagIndex(next);
      setImgError(false);
    } else {
      g.endGame(false);
    }
    setSkipAnswer(null);
    resetHints(); // ← always reset hints when question changes
  }, [g, resetHints]);

  const handleSkip = useCallback(() => {
    if (!g.isPlaying || !currentFlag) return;
    if (skipTimerRef.current) clearTimeout(skipTimerRef.current);
    setSkipAnswer(currentFlag.display);
    g.setInput("");
    skipTimerRef.current = setTimeout(() => advanceTo(flagQueue, flagIndex), 1500);
  }, [g, currentFlag, flagQueue, flagIndex, advanceTo]);

  useEffect(() => {
    if (!g.isPlaying) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") handleSkip(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [g.isPlaying, handleSkip]);

  const handleGuess = () => {
    if (!g.isPlaying || !currentFlag || skipAnswer !== null) return;
    const norm = normalizeInput(g.input);
    if (!norm) return;
    const entry = NAME_TO_ENTRY[norm];
    if (!entry || entry.code !== currentFlag.code) {
      playSound("wrong");
      g.triggerFeedback("wrong");
      g.setInput("");
      return;
    }
    const topoId = currentFlag.topoId;
    if (topoId && g.guessedISOs.has(topoId)) {
      g.triggerFeedback("dup"); g.setInput(""); advanceTo(flagQueue, flagIndex); return;
    }
    const next = new Set(g.guessedISOs);
    if (topoId) next.add(topoId);
    g.setGuessedISOs(next); g.setLastGuessed(topoId || null); g.setInput("");
    playSound("correct");
    g.triggerFeedback("correct");
    g.addPendingGold(hintUsedThisQRef.current);
    advanceTo(flagQueue, flagIndex);
    const ids = new Set(flagPool.map(c => c.topoId).filter(Boolean));
    if ([...next].filter(id => ids.has(id)).length >= flagTotal) g.endGame(true);
  };

  const handleStartGame = (m: "timed" | "free") => { resetHints(); g.startGame(m); };

  const timerPct   = (g.timeLeft / selectedDuration) * 100;
  const timerColor = g.timeLeft > selectedDuration * 0.33 ? "var(--accent)" : g.timeLeft > selectedDuration * 0.13 ? "#f59e0b" : "#ef4444";
  const pct        = flagTotal > 0 ? Math.round((flagScore / flagTotal) * 100) : 0;
  const continentLabel = CONTINENT_OPTIONS.find(c => c.value === continent)?.label ?? "Dünya";
  const durationLabel  = DURATION_OPTIONS.find(d => d.value === selectedDuration)?.label ?? "1 dk";
  const modeLabel      = g.lastMode === "timed" ? "⏱ Süreli" : "∞ Serbest";
  const placeholder    = g.mode === "idle" ? "Önce bir mod seç" : g.mode === "finished" ? "Oyun bitti" : skipAnswer !== null ? "Geçildi…" : "Bu bayrağın ülkesi? (Enter)";
  const flagSrc        = currentFlag ? `/assets/flags/${currentFlag.code}.svg` : "";
  const diffOpt        = DIFFICULTY_OPTIONS.find(d => d.value === difficulty);

  return (
    <div className="app">
      <TopBar
        gameType="flag-game" score={flagScore} total={flagTotal}
        mode={g.mode} isPlaying={g.isPlaying}
        continent={continent} selectedDuration={selectedDuration}
        timeLeft={g.timeLeft} timerPct={timerPct} timerColor={timerColor}
        lastMode={g.lastMode}
        continentLabel={continentLabel} durationLabel={durationLabel} modeLabel={modeLabel}
        currentBest={g.currentBest} feedback={g.feedback}
        difficulty={difficulty} onDifficultyChange={d => { if (!g.isPlaying) setDifficulty(d); }}
        inputRef={g.inputRef} input={g.input} placeholder={placeholder}
        onInput={g.setInput} onGuess={handleGuess} onSkip={handleSkip}
        onReset={g.resetGame} onHome={onHome}
        onStartGame={handleStartGame}
        onContinentChange={c => { if (!g.isPlaying) onContinentChange(c); }}
        onDurationChange={onDurationChange}
        gold={g.gold} canBonus={g.canBonus} onClaimBonus={g.handleClaimBonus}
      />
      <HintPanel gold={g.gold} hints={hints} currentEntry={currentFlag} isPlaying={g.isPlaying} onBuyHint={handleBuyHint} />

      {/* Pas Geç bar — full-width, below hints, above flag display */}
      {g.isPlaying && (
        <div className="pas-gec-bar">
          {skipAnswer ? (
            <span className="pas-gec-answer">
              Doğru cevap: <strong>{skipAnswer}</strong>
            </span>
          ) : (
            <button className="btn-pas-gec" onClick={handleSkip}>
              <span>⏭️</span> Pas Geç
            </button>
          )}
          <span className="pas-gec-hint">ESC</span>
        </div>
      )}

      <div className="flag-area">
        {g.mode === "idle" && (
          <div className="flag-idle">
            <div className="flag-idle-icon"><EmojiIcon name="flag" /></div>
            <p className="flag-idle-text">Bayrak Modu</p>
            <p className="flag-idle-sub">{diffOpt?.label} · {continentLabel} · {flagTotal} bayrak</p>
            <p className="flag-idle-sub" style={{ marginTop: "4px", fontSize: ".78rem", opacity: .6 }}>Başlamak için bir mod seç</p>
          </div>
        )}
        {g.isPlaying && currentFlag && (
          <div className="flag-stage">
            <div className="flag-meta-row">
              <span className="flag-progress">{flagIndex + 1} / {flagQueue.length}</span>
              <span className="flag-diff-pill" style={{ background: diffOpt?.color + "22", borderColor: diffOpt?.color, color: diffOpt?.color }}>{diffOpt?.label}</span>
            </div>
            <div className="flag-img-wrap">
              {imgError ? (
                <div className="flag-fallback">
                  <span className="flag-fallback-code">{currentFlag.code.toUpperCase()}</span>
                  <span className="flag-fallback-hint">Bayrak yüklenemedi</span>
                </div>
              ) : (
                <img key={currentFlag.code} src={flagSrc} alt="Bayrak" className="flag-img" onError={() => setImgError(true)} />
              )}
            </div>
            {skipAnswer ? (
              <div className="skip-answer-reveal">
                <span className="skip-label">Cevap:</span>
                <span className="skip-country">{skipAnswer}</span>
              </div>
            ) : (
              <p className="flag-prompt">Bu bayrağın ülkesi nedir?</p>
            )}
          </div>
        )}
        {g.mode === "finished" && (
          <div className="flag-idle">
            <div className="flag-idle-icon"><EmojiIcon name={flagScore >= flagTotal ? "trophy" : "alarm"} /></div>
            <p className="flag-idle-text">{flagScore >= flagTotal ? "Tebrikler!" : "Süre Doldu"}</p>
          </div>
        )}
      </div>

      {g.showModal && g.mode === "finished" && (
        <ResultModal
          score={flagScore} total={flagTotal} pct={pct}
          continent={continent} selectedDuration={selectedDuration}
          lastMode={g.lastMode} gameType="flag-game"
          difficulty={difficulty} currentBest={g.currentBest}
          missedCountries={g.missedCountries} missedFilter={g.missedFilter}
          filteredMissed={g.filteredMissed} shareState={g.shareState}
          earnedGold={g.pendingGoldRef.current}
          onMissedFilter={g.setMissedFilter}
          onClose={() => g.setShowModal(false)}
          onReplay={() => handleStartGame(g.lastMode)}
          onShare={() => g.handleShare(difficulty)}
          onHome={onHome}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   SILHOUETTE GAME
═══════════════════════════════════════════════════════════════ */
interface SilhouetteGameProps {
  continent: ContinentFilter;
  selectedDuration: number;
  countdownSoundMode: CountdownSoundMode;
  onContinentChange: (c: ContinentFilter) => void;
  onDurationChange: (d: number) => void;
  onHome: () => void;
}
function SilhouetteGame({
  continent,
  selectedDuration,
  countdownSoundMode,
  onContinentChange,
  onDurationChange,
  onHome,
}: SilhouetteGameProps) {
  const g = useGameCore("silhouette-game", continent, selectedDuration, countdownSoundMode);
  const [difficulty,  setDifficulty]  = useState<Difficulty>("normal");
  const [silQueue,    setSilQueue]    = useState<CountryEntry[]>([]);
  const [currentSil,  setCurrentSil]  = useState<CountryEntry | null>(null);
  const [silIndex,    setSilIndex]    = useState(0);
  const [flash,       setFlash]       = useState<"correct" | "wrong" | null>(null);
  const [skipAnswer,  setSkipAnswer]  = useState<string | null>(null);
  const skipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Strictly per-question hint state
  const [hints, setHints] = useState<HintState>(EMPTY_HINTS);
  const hintUsedThisQRef  = useRef(false);

  const resetHints = useCallback(() => {
    setHints(EMPTY_HINTS);
    hintUsedThisQRef.current = false;
  }, []);

  const handleBuyHint = useCallback((type: HintType) => {
    const cost = HINT_COSTS[type];
    if (g.gold < cost) return;
    g.spendGold(cost, HINT_REASON[type]);
    setHints(prev => ({ ...prev, [type]: true }));
    hintUsedThisQRef.current = true;
  }, [g]);

  const silPool  = useMemo(() => getSilhouettePool(continent, difficulty), [continent, difficulty]);
  const silTotal = silPool.length;
  const silScore = useMemo(() => {
    const ids = new Set(silPool.map(c => c.topoId).filter(Boolean));
    return [...g.guessedISOs].filter(id => ids.has(id)).length;
  }, [g.guessedISOs, silPool]);

  const buildQueue = useCallback(() => {
    const q = shuffle([...silPool]);
    setSilQueue(q);
    setCurrentSil(q[0] ?? null);
    setSilIndex(0);
    setFlash(null);
    setSkipAnswer(null);
    resetHints();
  }, [silPool, resetHints]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (g.isPlaying) buildQueue(); }, [g.mode]);

  const advanceTo = useCallback((pool: CountryEntry[], idx: number) => {
    const next = idx + 1;
    if (next < pool.length) {
      setCurrentSil(pool[next]);
      setSilIndex(next);
      setFlash(null);
    } else {
      g.endGame(false);
    }
    setSkipAnswer(null);
    resetHints(); // ← always reset hints when question changes
  }, [g, resetHints]);

  const handleSkip = useCallback(() => {
    if (!g.isPlaying || !currentSil) return;
    if (skipTimerRef.current) clearTimeout(skipTimerRef.current);
    setSkipAnswer(currentSil.display);
    setFlash("wrong");
    g.setInput("");
    skipTimerRef.current = setTimeout(() => {
      setFlash(null);
      advanceTo(silQueue, silIndex);
    }, 1500);
  }, [g, currentSil, silQueue, silIndex, advanceTo]);

  useEffect(() => {
    if (!g.isPlaying) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") handleSkip(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [g.isPlaying, handleSkip]);

  const handleGuess = () => {
    if (!g.isPlaying || !currentSil || skipAnswer !== null) return;
    const norm = normalizeInput(g.input);
    if (!norm) return;
    const topoId = NAME_TO_TOPOID[norm];
    const entry  = NAME_TO_ENTRY[norm];
    const isMatch = (topoId && topoId === currentSil.topoId) || (entry && entry.code === currentSil.code);
    if (!isMatch) {
  playSound("wrong");
  g.triggerFeedback("wrong");
  g.setInput("");
  setFlash("wrong");
  setTimeout(() => setFlash(null), 500);
  return;
}
    const tid = currentSil.topoId;
    if (tid && g.guessedISOs.has(tid)) {
      g.triggerFeedback("dup"); g.setInput(""); advanceTo(silQueue, silIndex); return;
    }
    const next = new Set(g.guessedISOs);
    if (tid) next.add(tid);
    g.setGuessedISOs(next); g.setLastGuessed(tid || null); g.setInput("");
    playSound("correct");
    g.triggerFeedback("correct");
    g.addPendingGold(hintUsedThisQRef.current);
    setFlash("correct");
    setTimeout(() => { setFlash(null); advanceTo(silQueue, silIndex); }, 600);
    const ids = new Set(silPool.map(c => c.topoId).filter(Boolean));
    if ([...next].filter(id => ids.has(id)).length >= silTotal) g.endGame(true);
  };

  const handleStartGame = (m: "timed" | "free") => { resetHints(); g.startGame(m); };

  const timerPct   = (g.timeLeft / selectedDuration) * 100;
  const timerColor = g.timeLeft > selectedDuration * 0.33 ? "var(--accent)" : g.timeLeft > selectedDuration * 0.13 ? "#f59e0b" : "#ef4444";
  const pct        = silTotal > 0 ? Math.round((silScore / silTotal) * 100) : 0;
  const continentLabel = CONTINENT_OPTIONS.find(c => c.value === continent)?.label ?? "Dünya";
  const durationLabel  = DURATION_OPTIONS.find(d => d.value === selectedDuration)?.label ?? "1 dk";
  const modeLabel      = g.lastMode === "timed" ? "⏱ Süreli" : "∞ Serbest";
  const placeholder    = g.mode === "idle" ? "Önce bir mod seç" : g.mode === "finished" ? "Oyun bitti" : skipAnswer ? "Geçildi…" : "Hangi ülke? (Enter)";
  const diffOpt        = DIFFICULTY_OPTIONS.find(d => d.value === difficulty);

  return (
    <div className="app">
      <TopBar
        gameType={"silhouette-game" as AppScreen}
        score={silScore} total={silTotal}
        mode={g.mode} isPlaying={g.isPlaying}
        continent={continent} selectedDuration={selectedDuration}
        timeLeft={g.timeLeft} timerPct={timerPct} timerColor={timerColor}
        lastMode={g.lastMode}
        continentLabel={continentLabel} durationLabel={durationLabel} modeLabel={modeLabel}
        currentBest={g.currentBest} feedback={g.feedback}
        difficulty={difficulty} onDifficultyChange={d => { if (!g.isPlaying) setDifficulty(d); }}
        inputRef={g.inputRef} input={g.input} placeholder={placeholder}
        onInput={g.setInput} onGuess={handleGuess} onSkip={handleSkip}
        onReset={g.resetGame} onHome={onHome}
        onStartGame={handleStartGame}
        onContinentChange={c => { if (!g.isPlaying) onContinentChange(c); }}
        onDurationChange={onDurationChange}
        gold={g.gold} canBonus={g.canBonus} onClaimBonus={g.handleClaimBonus}
      />
      <HintPanel gold={g.gold} hints={hints} currentEntry={currentSil} isPlaying={g.isPlaying} mode="silhouette" onBuyHint={handleBuyHint} />

      {/* Pas Geç bar */}
      {g.isPlaying && (
        <div className="pas-gec-bar">
          {skipAnswer ? (
            <span className="pas-gec-answer">
              Doğru cevap: <strong>{skipAnswer}</strong>
            </span>
          ) : (
            <button className="btn-pas-gec" onClick={handleSkip}>
              <span>⏭️</span> Pas Geç
            </button>
          )}
          <span className="pas-gec-hint">ESC</span>
        </div>
      )}

      <div className="sil-area">
        {g.mode === "idle" && (
          <div className="flag-idle">
            <div className="flag-idle-icon"><EmojiIcon name="map" /></div>
            <p className="flag-idle-text">Silüet Modu</p>
            <p className="flag-idle-sub">{diffOpt?.label} · {continentLabel} · {silTotal} ülke</p>
            <p className="flag-idle-sub" style={{ marginTop: "4px", fontSize: ".78rem", opacity: .6 }}>Başlamak için bir mod seç</p>
          </div>
        )}
        {g.isPlaying && currentSil && (
          <div className="sil-stage">
            <div className="flag-meta-row">
              <span className="flag-progress">{silIndex + 1} / {silQueue.length}</span>
              <span className="flag-diff-pill" style={{ background: diffOpt?.color + "22", borderColor: diffOpt?.color, color: diffOpt?.color }}>{diffOpt?.label}</span>
            </div>
            <div className="sil-card">
              <SilhouetteView topoId={currentSil.topoId} flash={flash} />
            </div>
            {skipAnswer ? (
              <div className="skip-answer-reveal">
                <span className="skip-label">Cevap:</span>
                <span className="skip-country">{skipAnswer}</span>
              </div>
            ) : (
              <p className="flag-prompt">Bu ülkenin adı nedir?</p>
            )}
          </div>
        )}
        {g.mode === "finished" && (
          <div className="flag-idle">
            <div className="flag-idle-icon"><EmojiIcon name={silScore >= silTotal ? "trophy" : "alarm"} /></div>
            <p className="flag-idle-text">{silScore >= silTotal ? "Tebrikler!" : "Süre Doldu"}</p>
          </div>
        )}
      </div>

      {g.showModal && g.mode === "finished" && (
        <ResultModal
          score={silScore} total={silTotal} pct={pct}
          continent={continent} selectedDuration={selectedDuration}
          lastMode={g.lastMode} gameType={"silhouette-game" as AppScreen}
          difficulty={difficulty} currentBest={g.currentBest}
          missedCountries={g.missedCountries} missedFilter={g.missedFilter}
          filteredMissed={g.filteredMissed} shareState={g.shareState}
          earnedGold={g.pendingGoldRef.current}
          onMissedFilter={g.setMissedFilter}
          onClose={() => g.setShowModal(false)}
          onReplay={() => handleStartGame(g.lastMode)}
          onShare={() => g.handleShare(difficulty)}
          onHome={onHome}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   ROOT APP
═══════════════════════════════════════════════════════════════ */
// True only inside the Capacitor native shell (matches html.is-native-app in
// main.tsx). Used to hand the home profile dropdown its open state to the
// native bottom-nav Profil tab; web + mobile browser keep the dropdown's own
// internal toggle. Guarded so a missing bridge in dev/SSR can't throw.
const IS_NATIVE_APP = (() => {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
})();

/** True when a signed-in user must pick their own handle via the blocking
 *  NicknameModal: no profile row yet, no username, or has_chosen_username has
 *  not been set (email-derived legacy / interrupted signup). Existing users
 *  were backfilled to has_chosen_username=true, so they pass straight through. */
function needsUsernameSelection(p: Profile | null): boolean {
  if (!p) return true;
  if (!p.username || p.username.trim().length === 0) return true;
  return p.has_chosen_username !== true;
}

export default function App() {
  const [screen, setScreen] = useState<AppScreen>("home");
  const [continent, setContinent] = useState<ContinentFilter>("world");
  const [selectedDuration, setSelectedDuration] = useState(60);
  const gold = useGold();
  const [canBonus, setCanBonus] = useState<boolean>(() => canClaimDailyBonus());
  const [authOpen, setAuthOpen] = useState(false);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  // Native app only: the bottom-nav Profil tab drives the (otherwise
  // top-right) UserProfileDropdown open state. On web this stays undefined
  // and the dropdown keeps its own internal open state.
  const [profileNavOpen, setProfileNavOpen] = useState(false);
  const [usernameModalOpen, setUsernameModalOpen] = useState(false);
  const [avatarModalOpen, setAvatarModalOpen] = useState(false);
  // Merkezi "Profili Düzenle" hub'ı + rozet sergileme editörü (profil kartı akışı).
  const [profileEditOpen, setProfileEditOpen] = useState(false);
  const [badgeShowcaseOpen, setBadgeShowcaseOpen] = useState(false);
  const [blockedUsersOpen, setBlockedUsersOpen] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  /* Why the auth modal was opened. "conquest-invite" swaps the header copy to
   * "Kuşatma moduna katılmak için giriş yapmalısın." and triggers an auto-join
   * once login completes. "kornokta-*" variants show the Kör Nokta copy, hide
   * the guest button (login-only mode) and route after a successful login. The
   * "*-gate" variants gate the Düello / Çok Oyunculu / Kuşatma online modes. */
  const [authPromptReason, setAuthPromptReason] = useState<AuthPromptReason | null>(null);
  /* Screen a logged-out user tried to open through an online gate. After a
   * successful login navigateOnline()/the auth modal routes here. */
  const [pendingOnlineTarget, setPendingOnlineTarget] = useState<AppScreen | null>(null);
  /* Auth Phase 3 (native only): a freshly signed-in social user (Apple/Google)
   * who has no valid Torble username yet. When set, the NicknameModal blocks
   * routing until the player picks a handle. Never set on web (gated on
   * IS_NATIVE_APP) — desktop/web social login is unchanged. */
  const [pendingNicknameUserId, setPendingNicknameUserId] = useState<string | null>(null);
  const [soundEnabled, setSoundEnabledState] = useState(() => isSoundEnabled());
  const [countdownSoundMode, setCountdownSoundModeState] =
  useState<CountdownSoundMode>(() => getCountdownSoundMode());

  /* Navigation gate for every mode launched from the home screen. Online modes
   * (Düello / Çok Oyunculu / Kuşatma) require login: a logged-out tap opens the
   * AuthModal (guest button hidden) and stashes the target so login routes there.
   * Single-player and Kör Nokta screens are not gated and pass straight through.
   * Wired as HomeScreen's onSelect, so desktop mode-cards, the choice modals and
   * the mobile bottom-sheet all funnel through here. */
  const navigateOnline = (target: AppScreen) => {
    const reason = ONLINE_GATED_SCREENS[target];
    if (reason && !profile?.username) {
      setPendingOnlineTarget(target);
      // Mirror into sessionStorage so a Google OAuth redirect — which reloads
      // the app and wipes the in-memory pendingOnlineTarget — still routes the
      // user to the mode they picked once their session is restored.
      try { sessionStorage.setItem(PENDING_ONLINE_TARGET_KEY, target); }
      catch { /* sessionStorage disabled — best effort */ }
      setAuthPromptReason(reason);
      setAuthOpen(true);
      return;
    }
    setScreen(target);
  };

  /* Shared post-auth routing for both the AuthModal success handler and the
   * NicknameModal success handler (native first-login). Once the user has a
   * valid username, routes them to the online target / Kör Nokta action they
   * originally picked, then clears the pending-auth bookkeeping. Kept in one
   * place so the nickname path preserves the exact same pending navigation. */
  const completeAuthRouting = (nextProfile: Profile | null) => {
    if (nextProfile?.username && authPromptReason === "kornokta-create") {
      setScreen("kornokta-create");
    } else if (nextProfile?.username && authPromptReason === "kornokta-join") {
      setScreen("kornokta-join");
    } else if (
      nextProfile?.username &&
      pendingOnlineTarget &&
      (authPromptReason === "duel-gate" ||
        authPromptReason === "multi-gate" ||
        authPromptReason === "kusatma-gate")
    ) {
      setScreen(pendingOnlineTarget);
    }
    // In-modal login (no OAuth redirect) routed via the in-memory target above;
    // drop the sessionStorage mirror so the effect can't re-consume it.
    clearPendingOnlineTarget();
    setPendingOnlineTarget(null);
    setAuthPromptReason(null);
    localStorage.setItem("torble_welcome_seen", "true");
  };

  const handleAppClaimBonus = () => {
  const result = claimDailyBonus();
  if (result === null) {
    setCanBonus(false);
    return;
  }
  setCanBonus(false);
};
const handleSpendGold = (amount: number): boolean => {
  return spendGoldStore(amount);
};
const handleSetSoundEnabled = (enabled: boolean) => {
  setSoundEnabled(enabled);
  setSoundEnabledState(enabled);
};

const handleSetCountdownSoundMode = (mode: CountdownSoundMode) => {
  setCountdownSoundMode(mode);
  setCountdownSoundModeState(mode);
};
useEffect(() => {
  const handleFirstInteraction = () => {
    preloadSounds();
    window.removeEventListener("pointerdown", handleFirstInteraction);
    window.removeEventListener("keydown", handleFirstInteraction);
  };

  window.addEventListener("pointerdown", handleFirstInteraction);
  window.addEventListener("keydown", handleFirstInteraction);

  return () => {
    window.removeEventListener("pointerdown", handleFirstInteraction);
    window.removeEventListener("keydown", handleFirstInteraction);
  };
}, []);

// Refresh daily-bonus availability when returning to home (date may have rolled over
// during a long session, or user might have claimed via another path).
useEffect(() => {
  if (screen === "home") setCanBonus(canClaimDailyBonus());
}, [screen]);

// Tell the gold module who the active user is. Triggered only when profile.id changes
// (login/logout) so a stale profile.gold cannot overwrite a live cached value mid-session.
useEffect(() => {
  if (authLoading) return;
  setActiveGoldProfile(profile?.id ?? null, profile?.gold);
  // Achievement stats are persisted per-profile too (localStorage in V1); keep
  // them switched in lockstep with gold so a login/logout loads the right data.
  setActiveAchievementProfile(profile?.id ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [profile?.id, authLoading]);

useEffect(() => {
  let alive = true;

  async function loadAuth() {
    setAuthLoading(true);

    const { user } = await getCurrentUser();

    if (!alive) return;

    if (!user) {
      setProfile(null);
      setAuthLoading(false);
      return;
    }

    const nextProfile = await loadOrCreateProfile(user);

    if (!alive) return;

    setProfile(nextProfile);
    // First-login (web + native): signed in but hasn't picked their own handle
    // yet (social login, web Google, email-derived legacy, or interrupted
    // signup). Show the blocking NicknameModal. Existing users were backfilled
    // to has_chosen_username=true, so they never reach this.
    if (needsUsernameSelection(nextProfile)) {
      setPendingNicknameUserId(user.id);
    }
    setAuthLoading(false);
  }

  loadAuth();

  // Keep the React profile in sync with Supabase auth for explicit sign-in /
  // sign-out events that don't already flow through the modal's own success
  // handler — most importantly the native Apple sign-in, where
  // signInWithIdToken fires SIGNED_IN. The initial session is handled by
  // loadAuth() above, so INITIAL_SESSION is ignored; TOKEN_REFRESHED is ignored
  // too so a periodic token refresh can't clobber live in-session profile state
  // (gold / xp / username) with a stale row. Web behavior is unchanged: email
  // and Google logins set the same profile they already did, just idempotently.
  const { data: authSub } = supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") {
      if (alive) setProfile(null);
      return;
    }
    if (event !== "SIGNED_IN") return;

    const user = session?.user;
    if (!user) return;

    // Defer the profile DB calls out of the callback — awaiting other supabase
    // methods synchronously inside onAuthStateChange can deadlock the client.
    setTimeout(() => {
      if (!alive) return;
      loadOrCreateProfile(user).then((p) => {
        if (!alive) return;
        setProfile(p);
        // Backstop for the SIGNED_IN path (native Apple/Google via
        // signInWithIdToken, and web Google after its OAuth redirect). The
        // AuthModal handler also opens the NicknameModal directly for snappier
        // UX on native; both set the same id.
        if (needsUsernameSelection(p)) {
          setPendingNicknameUserId(user.id);
        }
      });
    }, 0);
  });

  return () => {
    alive = false;
    authSub.subscription.unsubscribe();
  };
}, []);

async function handleLogout() {
  await signOut();
  setProfile(null);
}

function clearPendingConquestInvite() {
  try { sessionStorage.removeItem("pending_conquest_invite_code"); }
  catch { /* sessionStorage disabled — best effort */ }
  if (typeof window === "undefined") return;
  const cleaned = new URL(window.location.href);
  if (cleaned.searchParams.has("conquest")) {
    cleaned.searchParams.delete("conquest");
    window.history.replaceState({}, "", cleaned.toString());
  }
}

/** Kör Nokta davet auth promptu kapatılınca ?korNokta= param'ını temizle ki
 *  reload aynı login modal'ıyla kullanıcıyı rahatsız etmesin. */
function clearPendingKorNoktaInvite() {
  if (typeof window === "undefined") return;
  const cleaned = new URL(window.location.href);
  if (cleaned.searchParams.has("korNokta")) {
    cleaned.searchParams.delete("korNokta");
    window.history.replaceState({}, "", cleaned.toString());
  }
}

  /* ── Invite-link routing ──────────────────────────────────────────────────
   * Conquest is the only mode that requires login, so it has to wait for the
   * auth-load to settle before routing. Re-runs when authLoading / profile
   * flips so a guest who logs in via the conquest auth prompt is routed into
   * the lobby on the same mount. The conquest invite code is mirrored into
   * sessionStorage too — an OAuth round-trip (e.g. Google) replaces the URL,
   * so we'd otherwise lose it; we write it back into the URL once we resume.
   */
  useEffect(() => {
    if (authLoading) return;

    const params = new URLSearchParams(window.location.search);
    const korNoktaCode = params.get("korNokta");

    const conquestFromUrl = params.get("conquest")?.trim().toUpperCase() || null;
    const conquestFromStorage = (() => {
      try { return sessionStorage.getItem("pending_conquest_invite_code"); }
      catch { return null; }
    })();
    const conquestCode = conquestFromUrl ?? conquestFromStorage;

    if (conquestCode) {
      // Persist so we survive an OAuth redirect.
      try { sessionStorage.setItem("pending_conquest_invite_code", conquestCode); }
      catch { /* sessionStorage disabled — best effort */ }

      // After OAuth the URL no longer carries ?conquest=, restore it so
      // ConquestMode's own auto-join effect can pick it up.
      if (!conquestFromUrl && typeof window !== "undefined") {
        const restored = new URL(window.location.href);
        restored.searchParams.set("conquest", conquestCode);
        window.history.replaceState({}, "", restored.toString());
      }

      if (profile?.username) {
        // Hand off to ConquestMode — it strips ?conquest= and joins.
        try { sessionStorage.removeItem("pending_conquest_invite_code"); }
        catch { /* ignore */ }
        if (screen !== "conquest-join") setScreen("conquest-join");
      } else {
        // Guest: prompt login. The effect re-runs after onAuthSuccess
        // sets the profile, which is when the join actually happens.
        if (!authOpen) {
          setAuthPromptReason("conquest-invite");
          setAuthOpen(true);
        }
      }
      return;
    }

    if (korNoktaCode) {
      // Kör Nokta login-only: misafire önce auth modal'ı açılır; login sonrası
      // bu effect profile?.id flip'iyle yeniden koşar ve join ekranına geçer.
      // KorNoktaMode içindeki useInviteJoin ?korNokta= param'ını okuyup
      // auto-join tetikler ve URL'den temizler.
      if (profile?.username) {
        if (screen !== "kornokta-join") setScreen("kornokta-join");
      } else if (!authOpen) {
        setAuthPromptReason("kornokta-invite");
        setAuthOpen(true);
      }
      return;
    }

    // Düello / Çok Oyunculu davet linkleri — hepsi login gerektirir. Misafire
    // önce auth modal açılır; login sonrası bu effect profile?.id flip'iyle
    // yeniden koşar. Conquest gibi kod sessionStorage'a yazılır ve OAuth
    // redirect URL'i sildiyse geri konur ki ilgili modun useInviteJoin'i
    // ?param=KOD'u okuyup auto-join tetiklesin.
    for (const link of ONLINE_INVITE_LINKS) {
      const fromUrl = params.get(link.param)?.trim() || null;
      let fromStorage: string | null = null;
      try { fromStorage = sessionStorage.getItem(link.storageKey); }
      catch { /* sessionStorage disabled — best effort */ }
      const code = fromUrl ?? fromStorage;
      if (!code) continue;

      if (profile?.username) {
        // Giriş yapılmış: modu aç. OAuth URL'i sildiyse param'ı geri yaz
        // (useInviteJoin okuyup auto-join eder), sonra anchor'ı temizle.
        try { sessionStorage.removeItem(link.storageKey); } catch { /* ignore */ }
        if (!fromUrl && typeof window !== "undefined") {
          const restored = new URL(window.location.href);
          restored.searchParams.set(link.param, code);
          window.history.replaceState({}, "", restored.toString());
        }
        if (screen !== link.screen) setScreen(link.screen);
      } else {
        // Misafir: kodu OAuth redirect'e dayanması için sakla, login iste.
        try { sessionStorage.setItem(link.storageKey, code); } catch { /* ignore */ }
        if (!fromUrl && typeof window !== "undefined") {
          const restored = new URL(window.location.href);
          restored.searchParams.set(link.param, code);
          window.history.replaceState({}, "", restored.toString());
        }
        if (!authOpen) {
          setPendingOnlineTarget(link.screen);
          setAuthPromptReason(link.reason);
          setAuthOpen(true);
        }
      }
      return;
    }

    // Normal menu tap on a gated online mode (no invite link in the URL): the
    // in-memory pendingOnlineTarget is wiped by a Google OAuth redirect, so
    // navigateOnline() mirrors it into sessionStorage. Consume it once here —
    // after auth settles — then clear it. The redirect lands on home, this is
    // what routes the user onward. Invite links handled above take priority.
    let storedTarget: string | null = null;
    try { storedTarget = sessionStorage.getItem(PENDING_ONLINE_TARGET_KEY); }
    catch { /* sessionStorage disabled — best effort */ }
    if (storedTarget) {
      const stillGated = !!ONLINE_GATED_SCREENS[storedTarget as AppScreen];
      if (!stillGated) {
        // Unknown screen or no longer gated — drop it so it can't linger.
        clearPendingOnlineTarget();
      } else if (profile?.username) {
        // Logged in: route once, clearing first so setScreen can't loop us
        // back through this effect (setScreen doesn't change the deps anyway).
        clearPendingOnlineTarget();
        if (screen !== storedTarget) setScreen(storedTarget as AppScreen);
      }
      // Still gated but no session (e.g. OAuth dismissed/failed): leave it so a
      // later in-modal login can still route; onClose/onGuest clear it.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, profile?.id]);
  /* ── Hoş geldin: misafir kullanıcıya giriş davet modal'ı (bir kez) ── */
useEffect(() => {
  // Auth check henüz bitmediyse bekle
  if (authLoading) return;
  // Native app (Capacitor): doğrudan ana ekrana açılsın — zorunlu hoş geldin
  // login modal'ı gösterme. Giriş yalnızca Profil/Sıralama veya auth isteyen
  // bir online moda dokunulduğunda açılır. Web davranışı değişmez.
  if (IS_NATIVE_APP) return;
  // Zaten giriş yapmışsa gerek yok
  if (profile) return;
  // Daha önce göstermişsek bir daha çıkma
  if (localStorage.getItem("torble_welcome_seen") === "true") return;

  // Davet linkiyle gelmişse modal'ı atla — arkadaş odasına direkt geçsin.
  // Conquest davetinde de modal'ı atla; conquest-invite effect kendi auth
  // promptunu açıyor (farklı header mesajıyla).
  const params = new URLSearchParams(window.location.search);
  if (params.get("duel") || params.get("duelGroup") || params.get("flagDuel") || params.get("wheelDuel") || params.get("wheelGroup") || params.get("conquest") || params.get("korNokta")) {
    return;
  }
  let pendingConquest: string | null = null;
  try { pendingConquest = sessionStorage.getItem("pending_conquest_invite_code"); }
  catch { /* ignore */ }
  if (pendingConquest) return;

  // OAuth redirect query'yi siler; online davet anchor'ı duruyorsa davet
  // effect'i kendi login promptunu açacak — welcome modalını gösterme.
  let pendingOnlineInvite = false;
  try {
    pendingOnlineInvite = ONLINE_INVITE_LINKS.some(
      (link) => sessionStorage.getItem(link.storageKey)
    );
  } catch { /* ignore */ }
  if (pendingOnlineInvite) return;

  setAuthPromptReason("welcome");
  setAuthOpen(true);
}, [authLoading, profile]);

  const renderScreen = () => {
  if (screen === "home")
  return (
    <>
      <div className="top-right-stack">
        {/* Sağ üst sosyal blok (desktop + mobil web). Dikey ve hizalı:
              1. Profil pill
              2. Sıralama
              3. Bildirimler + Arkadaşlar (eşit genişlikte iki buton)
            Native app'te bu blok gizlenir (pointer-events:none + display:none
            kuralları); sosyal erişim alt-nav'daki Arkadaşlar sekmesindedir. */}
        <div className="social-bar">
          <UserProfileDropdown
            profile={profile}
            authLoading={authLoading}
            gold={gold}
            canBonus={canBonus}
            soundEnabled={soundEnabled}
            countdownSoundMode={countdownSoundMode}
            onClaimBonus={handleAppClaimBonus}
            onSetSoundEnabled={handleSetSoundEnabled}
            onSetCountdownSoundMode={handleSetCountdownSoundMode}
            onLogout={handleLogout}
            onLogin={() => setAuthOpen(true)}
            controlledOpen={IS_NATIVE_APP ? profileNavOpen : undefined}
            onOpenChange={(o) => { setProfileMenuOpen(o); setProfileNavOpen(o); }}
            onRequestEditProfile={
              profile ? () => setProfileEditOpen(true) : undefined
            }
          />
        </div>

        {/* Profil dropdown açıkken alttaki Sıralama + sosyal satır görsel
            olarak panelle çakışmasın diye gizlenir; kapanınca geri gelir.
            Native app'te tüm blok zaten alt-nav lehine gizli. */}
        {!profileMenuOpen && (
          <>
            <button
              type="button"
              className="lb-trigger"
              onClick={() => setLeaderboardOpen(true)}
              aria-label="Sıralamayı aç"
            >
              <span className="lb-trigger-icon"><EmojiIcon name="trophy" /></span>
              <span className="lb-trigger-label">Sıralama</span>
            </button>

            {/* Bildirimler + Arkadaşlar — eşit genişlikte ikinci satır.
                İkisi de oturum yoksa null döndürür; satırı yine de profile
                gate'liyoruz ki misafirde boş flex kalmasın. */}
            {profile && (
              <div className="social-row">
                <NotificationCenter />
                <FriendsButton />
              </div>
            )}
          </>
        )}
      </div>

      <HomeScreen
        onSelect={navigateOnline}
        profile={profile}
        onKorNoktaAuthRequired={(action) => {
          setAuthPromptReason(action === "create" ? "kornokta-create" : "kornokta-join");
          setAuthOpen(true);
        }}
        onOpenRanking={() => setLeaderboardOpen(true)}
        onOpenProfile={() => {
          // Reuse the existing chrome: logged-in opens the profile dropdown
          // (native: anchored above the bottom nav), logged-out opens AuthModal.
          if (profile) setProfileNavOpen(true);
          else setAuthOpen(true);
        }}
        profileOpen={IS_NATIVE_APP ? profileNavOpen : false}
      />

      {leaderboardOpen && (
        <LeaderboardModal onClose={() => setLeaderboardOpen(false)} />
      )}

      {usernameModalOpen && profile && (
        <UsernameChangeModal
          profile={profile}
          gold={gold}
          onClose={() => setUsernameModalOpen(false)}
          onSuccess={({ username, gold: newGold }) => {
            setProfile((prev) =>
              prev
                ? {
                    ...prev,
                    username,
                    gold: newGold,
                    username_changed_at: new Date().toISOString(),
                    username_change_count:
                      (prev.username_change_count ?? 0) + 1,
                  }
                : prev
            );
            setUsernameModalOpen(false);
          }}
        />
      )}

      {avatarModalOpen && profile && (
        <AvatarPickerModal
          profile={profile}
          onClose={() => setAvatarModalOpen(false)}
          onSuccess={(avatarId) => {
            setProfile((prev) =>
              prev ? { ...prev, avatar_id: avatarId } : prev
            );
            setAvatarModalOpen(false);
          }}
        />
      )}

      {/* Merkezi profil düzenleme hub'ı — yalnız yönlendirir, mevcut akışları
          tetikler (username / avatar / rozet). */}
      {profileEditOpen && profile && (
        <ProfileEditModal
          profile={profile}
          onClose={() => setProfileEditOpen(false)}
          onChooseName={() => {
            setProfileEditOpen(false);
            setUsernameModalOpen(true);
          }}
          onChooseAvatar={() => {
            setProfileEditOpen(false);
            setAvatarModalOpen(true);
          }}
          onChooseBadges={() => {
            setProfileEditOpen(false);
            setBadgeShowcaseOpen(true);
          }}
          onChooseBlocked={() => {
            setProfileEditOpen(false);
            setBlockedUsersOpen(true);
          }}
        />
      )}

      {badgeShowcaseOpen && profile && (
        <BadgeShowcaseEditor
          profile={profile}
          onClose={() => setBadgeShowcaseOpen(false)}
          onSaved={() => setBadgeShowcaseOpen(false)}
        />
      )}

      {blockedUsersOpen && profile && (
        <BlockedUsersModal onClose={() => setBlockedUsersOpen(false)} />
      )}

      {authOpen && (
  <AuthModal
    isNative={IS_NATIVE_APP}
    onNeedsUsername={(userId) => {
      // Native first-login social user with no handle. Hide the auth modal and
      // hand off to the NicknameModal, KEEPING pendingOnlineTarget +
      // authPromptReason so the nickname success routes them onward.
      setPendingNicknameUserId(userId);
      setAuthOpen(false);
    }}
    headerNote={
      authPromptReason === "conquest-invite"
        ? "Kuşatma moduna katılmak için giriş yapmalısın."
        : authPromptReason === "kornokta-invite" || authPromptReason === "kornokta-join"
        ? "Kör Nokta moduna katılmak için giriş yapmalısın."
        : authPromptReason === "kornokta-create"
        ? "Kör Nokta odası kurmak için giriş yapmalısın."
        : authPromptReason === "duel-gate"
        ? "Düello oynamak için giriş yapmalısın."
        : authPromptReason === "multi-gate"
        ? "Çok oyunculu modlara katılmak için giriş yapmalısın."
        : authPromptReason === "kusatma-gate"
        ? "Kuşatma oynamak için giriş yapmalısın."
        : undefined
    }
    hideGuest={
      authPromptReason === "kornokta-invite" ||
      authPromptReason === "kornokta-create" ||
      authPromptReason === "kornokta-join" ||
      authPromptReason === "duel-gate" ||
      authPromptReason === "multi-gate" ||
      authPromptReason === "kusatma-gate"
    }
    onClose={() => {
      setAuthOpen(false);
      // Dismissing the conquest auth prompt drops the pending invite so
      // a reload doesn't pester the user with the same login modal.
      if (authPromptReason === "conquest-invite") {
        clearPendingConquestInvite();
      }
      if (authPromptReason === "kornokta-invite") {
        clearPendingKorNoktaInvite();
      }
      if (
        authPromptReason === "duel-gate" ||
        authPromptReason === "multi-gate" ||
        authPromptReason === "kusatma-gate"
      ) {
        clearPendingOnlineInvites();
        clearPendingOnlineTarget();
      }
      setPendingOnlineTarget(null);
      setAuthPromptReason(null);
      localStorage.setItem("torble_welcome_seen", "true");
    }}
    onGuest={() => {
      setProfile(null);
      if (authPromptReason === "conquest-invite") {
        clearPendingConquestInvite();
      }
      if (authPromptReason === "kornokta-invite") {
        clearPendingKorNoktaInvite();
      }
      // Online gate'lerde "Misafir" butonu zaten gizli (hideGuest); yine de
      // temiz kalsın diye pending hedef ve davet anchor'ları düşürülür.
      if (
        authPromptReason === "duel-gate" ||
        authPromptReason === "multi-gate" ||
        authPromptReason === "kusatma-gate"
      ) {
        clearPendingOnlineInvites();
        clearPendingOnlineTarget();
      }
      setPendingOnlineTarget(null);
      setAuthPromptReason(null);
      localStorage.setItem("torble_welcome_seen", "true");
    }}
    onAuthSuccess={(nextProfile) => {
      // Menüden "Oda Kur / Odaya Katıl" seçip login olan kullanıcıyı
      // hedeflediği Kör Nokta ekranına / online moduna taşı. Davet linki
      // ("kornokta-invite") burada ele alınmaz: invite-link effect'i
      // profile?.id flip'iyle yeniden koşar ve auto-join'i kendisi tetikler.
      setProfile(nextProfile);
      completeAuthRouting(nextProfile);
    }}
  />
)}

      {pendingNicknameUserId && (
        <NicknameModal
          userId={pendingNicknameUserId}
          onSuccess={(nextProfile) => {
            // Handle chosen → set profile, close, and continue the SAME pending
            // online / Kör Nokta routing the AuthModal success path would run.
            setProfile(nextProfile);
            setPendingNicknameUserId(null);
            completeAuthRouting(nextProfile);
          }}
          onCancel={() => {
            // Abort (not "skip"): sign back out and return to logged-out home.
            // Never routes into an online flow without a handle.
            void handleLogout();
            setPendingNicknameUserId(null);
            clearPendingOnlineInvites();
            clearPendingOnlineTarget();
            setPendingOnlineTarget(null);
            setAuthPromptReason(null);
          }}
        />
      )}
    </>
  );
  if (screen === "duel-game") {
  return (
   <DuelGame
  onHome={() => setScreen("home")}
  profile={profile}
/>
  );
}
  if (screen === "duel-group-game") {
  return (
    <DuelGroupGame
      onHome={() => setScreen("home")}
      profile={profile}
    />
  );
}
  if (screen === "flag-duel-game") return (
  <FlagDuelGame
  onHome={() => setScreen("home")}
  gold={gold}
  canBonus={canBonus}
  onClaimBonus={handleAppClaimBonus}
  onSpendGold={handleSpendGold}
  profile={profile}
/>
);
  if (screen === "kornokta-create") return (
    <KorNoktaMode
      initialAction="create"
      onHome={() => setScreen("home")}
      profile={profile}
    />
  );
  if (screen === "kornokta-join") return (
    <KorNoktaMode
      initialAction="join"
      onHome={() => setScreen("home")}
      profile={profile}
    />
  );
  if (screen === "cag-dedektifi") return <CagDedektifiGame onHome={() => setScreen("home")} />;
  if (screen === "harita-dedektifi") return <HaritaDedektifiGame onHome={() => setScreen("home")} />;
  if (screen === "harita-duel-game") return (
    <HaritaDuelGame
      onHome={() => setScreen("home")}
      profile={profile}
    />
  );
  if (screen === "route-game") return <RouteGame onHome={() => setScreen("home")} />;
  if (screen === "wheel-game") return <WheelGame onHome={() => setScreen("home")} />;
  if (screen === "wheel-duel-game") return (
    <WheelDuelGame
      onHome={() => setScreen("home")}
      profile={profile}
    />
  );
  if (screen === "wheel-group-game") return (
    <WheelGroupGame
      onHome={() => setScreen("home")}
      profile={profile}
    />
  );
  if (screen === "conquest-game") return (
    <ConquestMode
      initialPhase="create"
      onHome={() => setScreen("home")}
      profile={profile}
    />
  );
  if (screen === "conquest-rooms") return (
    <ConquestMode
      initialPhase="rooms"
      onHome={() => setScreen("home")}
      profile={profile}
    />
  );
  if (screen === "conquest-join") return (
    <ConquestMode
      initialPhase="join-code"
      onHome={() => setScreen("home")}
      profile={profile}
    />
  );
  if (screen === "silhouette-game") return (
    <SilhouetteGame
  continent={continent}
  selectedDuration={selectedDuration}
  countdownSoundMode={countdownSoundMode}
  onContinentChange={setContinent}
  onDurationChange={setSelectedDuration}
  onHome={() => setScreen("home")}
/>
  );
  if (screen === "flag-game") return (
    <FlagGame
  continent={continent}
  selectedDuration={selectedDuration}
  countdownSoundMode={countdownSoundMode}
  onContinentChange={setContinent}
  onDurationChange={setSelectedDuration}
  onHome={() => setScreen("home")}
/>
  );
  return (
   <MapGame
  continent={continent}
  selectedDuration={selectedDuration}
  countdownSoundMode={countdownSoundMode}
  onContinentChange={setContinent}
  onDurationChange={setSelectedDuration}
  onHome={() => setScreen("home")}
/>
  );
  };

  // Sosyal sistem (bildirim + profil kartı + davet) tüm ekranları sarar; böylece
  // leaderboard, lobiler ve oyun ekranlarında PlayerProfileTrigger/NotificationCenter
  // ortak bağlamı paylaşır. Web/mobil/native aynı provider.
  return (
    <SocialProvider
      profile={profile}
      onEditProfile={profile ? () => setProfileEditOpen(true) : undefined}
      onChangeAvatar={profile ? () => setAvatarModalOpen(true) : undefined}
      onShowcaseBadges={profile ? () => setBadgeShowcaseOpen(true) : undefined}
      onOpenRewards={profile ? () => setAvatarModalOpen(true) : undefined}
      onJoinRoom={(roomUrl) => { window.location.href = roomUrl; }}
    >
      {renderScreen()}
    </SocialProvider>
  );
}
