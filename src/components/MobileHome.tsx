/* ═══════════════════════════════════════════════════════════════
   MOBILE-ONLY APP HOME
   App-style homepage for narrow viewports (≤600px). Rendered next
   to the classic .mode-grid inside HomeScreen; CSS decides which
   tree is visible (.mobile-home is display:none on desktop, and
   .mode-grid is hidden at ≤600px). The desktop homepage markup,
   styling and behaviour stay untouched.

   IA: the first screen shows four equal cards — Tek Oyunculu /
   Düello / Çok Oyunculu / Oda Kodu ile Katıl. Tapping one of the
   first three opens a bottom sheet listing that category's modes
   (Kuşatma is the featured card atop the Çok Oyunculu sheet); the
   fourth opens the RoomCodeSheet directly. Oda Kodu used to be a
   sub-row welded onto the Çok Oyunculu card — it is now its own
   peer card, same surface, same size, same handler.

   Günün Görevi is NOT surfaced on THIS screen: lib/dailyQuest's
   MOBILE_DAILY_QUEST_HOME_VISIBLE gates the home surface only —
   no card/entry and no +1 on the bottom-nav badge, so the four-card
   layout stays exactly as approved. The other two mobile entries
   are separate switches and are ON: the launch intro modal
   (…_INTRO_ENABLED, App.tsx) and the social sheet's "Görev" tab
   (…_SOCIAL_VISIBLE, SocialCenterSheet). Feature, RPCs and rewards
   are untouched; desktop is unaffected.

   Purely presentational: every action routes through the same
   callbacks the desktop mode cards use — onPlay maps to App's
   setScreen via HomeScreen's onSelect, and Kuşatma opens the same
   select modal (with its existing auth handling). No gameplay
   logic, no new AppScreen ids, no invite-link changes.

   Kör Nokta IS surfaced here (Çok Oyunculu sheet): its 360 scenes
   load remotely / on-demand on native (resolveAssetUrl + prune),
   so no heavy panorama ships in the app bundle. Harita/Çağ
   Dedektifi (solo 360) stay desktop-web-only for now.
═══════════════════════════════════════════════════════════════ */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { playSound } from "../lib/sound";
import { Avatar } from "./Avatar";
import { SocialCenterSheet } from "./SocialCenterSheet";
import { useSocialOptional } from "./SocialContext";
import { useDmOptional } from "./DmContext";
import { useToastSurfaceOffset } from "../lib/useToastOffset";
import { useDailyQuestStatus, MOBILE_DAILY_QUEST_HOME_VISIBLE } from "../lib/dailyQuest";
import { RoomCodeSheet, type RoomCodeSubmitOutcome } from "./RoomCodeJoin";
import {
  CONQUEST_QUICK_MATCH_ENABLED,
  QUICK_MATCH_CONQUEST_ROUNDS,
  QUICK_MATCH_COUNTRY_DURATIONS,
  QUICK_MATCH_DEFAULT_REGION,
  QUICK_MATCH_FLAG_ROUNDS,
  QUICK_MATCH_REGIONS,
  QUICK_MATCH_ROUTE_LENGTHS,
  QUICK_MATCH_ROUTE_ROUNDS,
  QUICK_MATCH_WHEEL_DURATIONS,
  type QuickMatchIntent,
  type QuickMatchMode,
} from "../lib/quickMatch";

/** Screens the mobile home can launch directly — a subset of App's AppScreen ids. */
export type MobileHomeTarget =
  | "map-game"
  | "flag-game"
  | "silhouette-game"
  | "route-game"
  | "wheel-game"
  | "duel-game"
  | "flag-duel-game"
  | "wheel-duel-game"
  | "route-duel-game"
  | "duel-group-game"
  | "flag-group-game"
  | "wheel-group-game"
  | "cizim-test";

/** One home background theme — mirrors App's HOME_THEMES entries without
 *  importing the HomeTheme union, so the bottom-nav theme sheet stays a dumb
 *  presenter over the real setHomeTheme logic. */
interface ThemeOption {
  id: string;
  name: string;
  swatch: string;
}

interface MobileHomeProps {
  onPlay: (target: MobileHomeTarget) => void;
  /** Hızlı Eşleş: the sheet hands its intent up; App applies the existing auth
   *  gate then routes into the matching game's quick-match flow. */
  onStartQuickMatch: (intent: QuickMatchIntent) => void;
  /** "Oda Kodu ile Katıl" sheet submit → App merkezî resolver+yönlendirme
   *  (üst bar RoomCodeBar ile AYNI akış). Kullanıcı modu bilmeden koddan
   *  doğrudan ilgili lobiye gider. */
  onSubmitRoomCode: (rawCode: string) => Promise<RoomCodeSubmitOutcome>;
  /** Opens the existing ConquestModeSelectModal (create / join / browse + auth). */
  onOpenConquest: () => void;
  /** Opens the existing KorNoktaSelectModal (create / join + login gate). Same
   *  modal the desktop Kör Nokta card uses; the 360 scenes load remotely /
   *  on-demand on native, so nothing heavy ships in the app bundle. */
  onOpenKorNokta: () => void;
  /** Bottom-nav (native app shell only). Each reuses an App-level handler:
   *  ranking opens the existing LeaderboardModal; profile opens the AuthModal
   *  when logged out or the existing UserProfileDropdown when logged in. */
  onOpenRanking: () => void;
  onOpenProfile: () => void;
  /** Drives the Profil tab's icon/label only; the action lives in onOpenProfile. */
  isLoggedIn: boolean;
  /** Selected profile avatar id (profiles.avatar_id). When logged in the Profil
   *  tab renders this avatar instead of the default person glyph; unknown / null
   *  falls back to the default globe via the shared <Avatar>. */
  avatarId?: string | null;
  /** Username, forwarded to <Avatar> for its alt text only. */
  username?: string | null;
  /** True while the native profile dropdown is open — lifts/glows the Profil
   *  tab avatar so the bottom nav reflects the open panel as the active tab. */
  profileActive?: boolean;
  /** Home themes (App's HOME_THEMES) surfaced by the Tema tab as a bottom
   *  sheet; onSelectTheme is App's setHomeTheme — no new theme logic. */
  themes: ThemeOption[];
  activeTheme: string;
  onSelectTheme: (id: string) => void;
  /** Günün Görevi girişi — App'in desktop üst bar butonuyla AYNI handler'ı:
   *  auth gate + aynı DailyQuestModal (sunucu durumu tek kaynak). */
  onOpenDailyQuest: () => void;
}

/** Shared bottom-sheet chrome: lock background scroll while the sheet is up,
 *  focus the panel, and close on Escape. Used by the category sheet and the
 *  theme sheet so both behave identically. */
function useSheetLock(ref: RefObject<HTMLDivElement>, onClose: () => void) {
  useEffect(() => {
    // Page scroll lives on body/html (home-screen grows via min-height),
    // so locking body overflow freezes the background while the sheet is up.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [ref, onClose]);
}

interface SheetMode {
  icon: string;
  title: string;
  desc: string;
  /** Kuşatma: rendered as the amber hero card at the top of its sheet. */
  featured?: boolean;
  onTap: () => void;
}

interface Category {
  id: "solo" | "duel" | "multi";
  icon: string;
  title: string;
  tagline: string;
  modes: SheetMode[];
}

function MobileSheet({
  category,
  onClose,
  onLaunch,
}: {
  category: Category;
  onClose: () => void;
  onLaunch: (run: () => void) => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useSheetLock(sheetRef, onClose);

  // Portalled to <body> so the sheet escapes .home-screen's `isolation`
  // stacking context and paints above the fixed login/ranking chrome.
  // Desktop never reaches here: the .mh-cat triggers are display:none at
  // >600px, so the sheet can't be opened off mobile.
  return createPortal(
    <>
      <div
        className="mh-sheet-backdrop"
        aria-hidden="true"
        onClick={() => { playSound("click"); onClose(); }}
      />
      <div
        ref={sheetRef}
        className="mh-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mh-sheet-title"
        tabIndex={-1}
      >
        <div className="mh-sheet-grab" aria-hidden="true" />
        <header className="mh-sheet-head">
          <span className="mh-sheet-icon" aria-hidden="true">{category.icon}</span>
          <h3 id="mh-sheet-title" className="mh-sheet-title">{category.title}</h3>
          <button
            type="button"
            className="mh-sheet-close"
            aria-label="Kapat"
            onClick={() => { playSound("click"); onClose(); }}
          >
            ✕
          </button>
        </header>
        <div className="mh-rows">
          {category.modes.map(m =>
            m.featured ? (
              <button
                key={m.title}
                type="button"
                className="mh-feature"
                onClick={() => { playSound("click"); onLaunch(m.onTap); }}
              >
                <span className="mh-feature-badge">Öne Çıkan</span>
                <span className="mh-feature-icon" aria-hidden="true">{m.icon}</span>
                <span className="mh-feature-text">
                  <span className="mh-feature-title">{m.title}</span>
                  <span className="mh-feature-desc">{m.desc}</span>
                </span>
                <span className="mh-feature-cta">Oyna</span>
              </button>
            ) : (
              <button
                key={m.title}
                type="button"
                className="mh-row"
                onClick={() => { playSound("click"); onLaunch(m.onTap); }}
              >
                <span className="mh-row-icon" aria-hidden="true">{m.icon}</span>
                <span className="mh-row-text">
                  <span className="mh-row-title">{m.title}</span>
                  <span className="mh-row-desc">{m.desc}</span>
                </span>
                <span className="mh-row-chevron" aria-hidden="true">›</span>
              </button>
            )
          )}
        </div>
      </div>
    </>,
    document.body
  );
}

/** One option row the selector popover renders. Disabled rows (locked Kuşatma
 *  maps) are non-interactive for pointer and keyboard alike. */
interface QmSelectOption {
  value:     string | number;
  label:     string;
  disabled?: boolean;
}

/** A live selector field for the active mode: its label, the option list, the
 *  current value and how to set it. Each mode contributes exactly two. */
interface QmActiveField {
  id:       "duration" | "rounds" | "region" | "map" | "routeLength";
  label:    string;
  options:  QmSelectOption[];
  value:    string | number;
  onSelect: (v: string | number) => void;
}

/** One mode in the rail. `enabled:false` (Kuşatma until its backend is deployed
 *  + playtested) keeps the card selectable and its config visible, but the
 *  primary CTA stays inert. */
interface QmModeDef {
  mode:    QuickMatchMode;
  icon:    string;
  label:   string;
  desc:    string;
  enabled: boolean;
}

/** Shared duel matchmaking blurb (Ülke Yaz / Çark / Bayrak). */
const DUEL_DESC = "Seviyene yakın bir rakiple birebir eşleş. Bekledikçe seviye penceresi genişler.";

/** Rail order is fixed: Kuşatma first, then the three live duels. The sheet
 *  still OPENS with Ülke Yaz selected (a playable mode) — see the sheet's
 *  initial `mode` state and the auto-center effect that scrolls it into view. */
const QM_MODES: QmModeDef[] = [
  { mode: "conquest", icon: "🛡️", label: "Kuşatma",       desc: "Bölgeleri kuşat, rakibinin başkentini ele geçir.", enabled: CONQUEST_QUICK_MATCH_ENABLED },
  { mode: "wheel",    icon: "🎯", label: "Çark 1v1",      desc: DUEL_DESC, enabled: true },
  { mode: "country",  icon: "🌍", label: "Ülke Yaz 1v1",  desc: DUEL_DESC, enabled: true },
  { mode: "flag",     icon: "🚩", label: "Bayrak 1v1",    desc: DUEL_DESC, enabled: true },
  { mode: "route",    icon: "🧭", label: "Rota Modu 1v1", desc: DUEL_DESC, enabled: true },
];

/** Conquest maps: only Türkiye is live; the rest stay visible-but-locked
 *  "Yakında" rows and never reach a queue parameter. */
const QM_CONQUEST_MAP_OPTIONS: QmSelectOption[] = [
  { value: "turkey",      label: "🇹🇷 Türkiye" },
  { value: "europe",      label: "🇪🇺 Avrupa",    disabled: true },
  { value: "middle-east", label: "🕌 Orta Doğu",  disabled: true },
];

/** One compact selector field (Süre / Tur / Kıta / Harita): a label, the
 *  selected value and a caret. Tapping opens an anchored popover listbox right
 *  under the field — single-open across the sheet, closing on select, outside
 *  tap or Escape. The popover is absolutely positioned, so opening it never
 *  shifts the sheet's layout (no animated layout properties). */
function QmSelect({
  field,
  openField,
  setOpenField,
}: {
  field:        QmActiveField;
  openField:    string | null;
  setOpenField: (id: string | null) => void;
}) {
  const open = openField === field.id;
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef  = useRef<HTMLDivElement>(null);
  // Cap the upward popover to the room above the field inside the sheet so it
  // never spills past the sheet's top edge (and thus the viewport/safe-area);
  // the list scrolls internally past that. `undefined` falls back to the CSS.
  const [popMaxH, setPopMaxH] = useState<number | undefined>(undefined);

  // While open: outside-tap and Escape close the popover. Capture phase so we
  // win before the sheet's own Escape-to-close handler fires.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpenField(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setOpenField(null); }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, setOpenField]);

  // On open, size the popover to the space above the field within the scrollable
  // sheet (bounded by the sheet keeps it inside the viewport + top safe-area).
  // Measured before paint to avoid a flash, and re-measured on resize/rotate.
  useLayoutEffect(() => {
    if (!open) { setPopMaxH(undefined); return; }
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const fieldTop = root.getBoundingClientRect().top;
      const sheet    = root.closest<HTMLElement>(".mh-sheet");
      const topBound = sheet ? sheet.getBoundingClientRect().top : 0;
      const GAP = 6;   // mirrors the CSS gap between popover and field
      const PAD = 8;   // breathing room from the sheet's top edge
      const avail = fieldTop - topBound - GAP - PAD;
      // Keep the 46vh visual cap, never exceed the room above, never collapse.
      setPopMaxH(Math.max(96, Math.min(avail, window.innerHeight * 0.46)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  // On open, drop focus on the selected (or first enabled) option so keyboard
  // users land inside the list.
  useEffect(() => {
    if (!open) return;
    const pop = popRef.current;
    const target = pop?.querySelector<HTMLElement>('[aria-selected="true"]:not([disabled])')
      ?? pop?.querySelector<HTMLElement>(".mh-qm-opt:not([disabled])");
    target?.focus();
  }, [open]);

  const selected = field.options.find(o => o.value === field.value);

  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const opts = Array.from(
      popRef.current?.querySelectorAll<HTMLElement>(".mh-qm-opt:not([disabled])") ?? []
    );
    if (!opts.length) return;
    const cur  = opts.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown"
      ? Math.min(opts.length - 1, cur + 1)
      : Math.max(0, cur < 0 ? 0 : cur - 1);
    opts[next]?.focus();
  };

  return (
    <div className="mh-qm-select" ref={rootRef}>
      <button
        type="button"
        className={"mh-qm-field" + (open ? " mh-qm-field--open" : "")}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => { playSound("click"); setOpenField(open ? null : field.id); }}
      >
        <span className="mh-qm-field-label">{field.label}</span>
        <span className="mh-qm-field-val">{selected?.label ?? "—"}</span>
        <span className="mh-qm-field-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          ref={popRef}
          className="mh-qm-pop"
          role="listbox"
          aria-label={field.label}
          onKeyDown={onListKey}
          style={popMaxH != null ? { maxHeight: popMaxH } : undefined}
        >
          {field.options.map(o => {
            const isSel = o.value === field.value;
            return (
              <button
                key={String(o.value)}
                type="button"
                role="option"
                aria-selected={isSel}
                disabled={o.disabled}
                className={
                  "mh-qm-opt"
                  + (isSel ? " mh-qm-opt--sel" : "")
                  + (o.disabled ? " mh-qm-opt--soon" : "")
                }
                onClick={() => {
                  if (o.disabled) return;
                  playSound("click");
                  field.onSelect(o.value);
                  setOpenField(null);
                }}
              >
                <span className="mh-qm-opt-label">{o.label}</span>
                {o.disabled
                  ? <span className="mh-qm-soon mh-qm-soon--inline">Yakında</span>
                  : isSel && <span className="mh-qm-opt-check" aria-hidden="true">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Quick Match (Eşleş) — real 1v1 matchmaking entry. A horizontal mode rail
 *  (Kuşatma · Çark · Ülke Yaz · Bayrak) drives two mode-specific selector
 *  fields — only the controls that actually reach that mode's queue (Ülke/Çark
 *  = Süre + Kıta, Bayrak = Tur + Kıta, Kuşatma = Tur + Harita). The CTA hands
 *  the intent to App, which applies the existing auth gate and routes into the
 *  canonical quick-match flow. Reuses the .mh-sheet shell; opened from the
 *  native bottom-nav ⚡ tab and the narrow/mobil-web ⚡ card. */
function MobileQuickMatchSheet({
  onClose,
  onStartQuickMatch,
}: {
  onClose: () => void;
  onStartQuickMatch: (intent: QuickMatchIntent) => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useSheetLock(sheetRef, onClose);

  // Opens on a playable mode (Ülke Yaz) even though Kuşatma leads the rail.
  const [mode,            setMode]            = useState<QuickMatchMode>("country");
  const [countryDuration, setCountryDuration] = useState(60);   // Ülke Yaz default 1 dk
  const [wheelDuration,   setWheelDuration]   = useState(60);   // Çark default 1 dk
  const [flagRounds,      setFlagRounds]      = useState(10);   // Bayrak default 10 Tur
  const [routeRounds,     setRouteRounds]     = useState(5);    // Rota default 5 Tur
  const [routeLength,     setRouteLength]     = useState("7");  // Rota default 7 ara ülke
  const [siegeRounds,     setSiegeRounds]     = useState(6);    // Kuşatma default 6 Tur
  const [region,          setRegion]          = useState<string>(QUICK_MATCH_DEFAULT_REGION);
  const [openField,       setOpenField]       = useState<string | null>(null);

  const railRef     = useRef<HTMLDivElement>(null);
  const firstCenter = useRef(true);

  const active = QM_MODES.find(m => m.mode === mode)!;

  const selectMode = (m: QuickMatchMode) => {
    playSound("click");
    setMode(m);
    setOpenField(null);   // mode swap changes the fields; close any open popover
  };

  // Keep the selected card centered in the rail. Instant on first paint (so the
  // sheet opens already showing Ülke Yaz, with Kuşatma/Çark reachable by
  // scrolling left); smooth afterwards, unless the user reduced motion.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const card = rail.querySelector<HTMLElement>(`[data-mode="${mode}"]`);
    if (!card) return;
    const target = card.offsetLeft - (rail.clientWidth - card.clientWidth) / 2;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    rail.scrollTo({
      left: Math.max(0, target),
      behavior: firstCenter.current || reduce ? "auto" : "smooth",
    });
    firstCenter.current = false;
  }, [mode]);

  // ←/→ move selection along the rail (radiogroup roving focus).
  const onRailKey = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const idx = QM_MODES.findIndex(m => m.mode === mode);
    const nextIdx = e.key === "ArrowRight"
      ? Math.min(QM_MODES.length - 1, idx + 1)
      : Math.max(0, idx - 1);
    const nm = QM_MODES[nextIdx].mode;
    if (nm === mode) return;
    selectMode(nm);
    requestAnimationFrame(() =>
      railRef.current?.querySelector<HTMLElement>(`[data-mode="${nm}"]`)?.focus()
    );
  };

  // Exactly the two controls that reach the selected mode's queue. Region is
  // shared across the three duel modes; conquest carries the Türkiye-only map.
  const fields: QmActiveField[] = (() => {
    switch (mode) {
      case "country":
        return [
          { id: "duration", label: "Süre", options: QUICK_MATCH_COUNTRY_DURATIONS, value: countryDuration, onSelect: v => setCountryDuration(v as number) },
          { id: "region",   label: "Kıta", options: QUICK_MATCH_REGIONS,           value: region,          onSelect: v => setRegion(v as string) },
        ];
      case "wheel":
        return [
          { id: "duration", label: "Süre", options: QUICK_MATCH_WHEEL_DURATIONS, value: wheelDuration, onSelect: v => setWheelDuration(v as number) },
          { id: "region",   label: "Kıta", options: QUICK_MATCH_REGIONS,         value: region,        onSelect: v => setRegion(v as string) },
        ];
      case "flag":
        return [
          { id: "rounds", label: "Tur",  options: QUICK_MATCH_FLAG_ROUNDS, value: flagRounds, onSelect: v => setFlagRounds(v as number) },
          { id: "region", label: "Kıta", options: QUICK_MATCH_REGIONS,     value: region,     onSelect: v => setRegion(v as string) },
        ];
      case "route":
        return [
          { id: "rounds",      label: "Tur",           options: QUICK_MATCH_ROUTE_ROUNDS,  value: routeRounds, onSelect: v => setRouteRounds(v as number) },
          { id: "routeLength", label: "Rota Uzunluğu", options: QUICK_MATCH_ROUTE_LENGTHS, value: routeLength, onSelect: v => setRouteLength(v as string) },
        ];
      case "conquest":
        return [
          { id: "rounds", label: "Tur",    options: QUICK_MATCH_CONQUEST_ROUNDS, value: siegeRounds, onSelect: v => setSiegeRounds(v as number) },
          { id: "map",    label: "Harita", options: QM_CONQUEST_MAP_OPTIONS,     value: "turkey",    onSelect: () => {} },
        ];
    }
  })();

  function buildIntent(): QuickMatchIntent {
    switch (mode) {
      case "country": return { mode, duration: countryDuration, region };
      case "wheel":   return { mode, duration: wheelDuration,   region };
      case "flag":    return { mode, rounds: flagRounds,        region };
      case "route":   return { mode, rounds: routeRounds, routeLength };
      case "conquest":return { mode, rounds: siegeRounds, map: "turkey" };
    }
  }

  const handleStart = () => {
    if (!active.enabled) return;
    playSound("click");
    onStartQuickMatch(buildIntent());
    onClose();
  };

  return createPortal(
    <>
      <div
        className="mh-sheet-backdrop"
        aria-hidden="true"
        onClick={() => { playSound("click"); onClose(); }}
      />
      <div
        ref={sheetRef}
        className="mh-sheet mh-sheet--match"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mh-match-title"
        tabIndex={-1}
      >
        <div className="mh-sheet-grab" aria-hidden="true" />
        <header className="mh-sheet-head">
          <span className="mh-sheet-icon" aria-hidden="true">⚡</span>
          <h3 id="mh-match-title" className="mh-sheet-title">Hızlı Eşleş</h3>
          <button
            type="button"
            className="mh-sheet-close"
            aria-label="Kapat"
            onClick={() => { playSound("click"); onClose(); }}
          >
            ✕
          </button>
        </header>

        {/* Mode rail — horizontal scroll-snap carousel; one row, never wraps,
            scales to any number of future modes. */}
        <div className="mh-qm-railwrap">
          <div className="mh-qm-rail" role="radiogroup" aria-label="Mod" ref={railRef}>
            {QM_MODES.map(m => (
              <button
                key={m.mode}
                type="button"
                role="radio"
                aria-checked={m.mode === mode}
                data-mode={m.mode}
                tabIndex={m.mode === mode ? 0 : -1}
                className={"mh-qm-mode" + (m.mode === mode ? " mh-qm-mode--active" : "")}
                onClick={() => selectMode(m.mode)}
                onKeyDown={onRailKey}
              >
                <span className="mh-qm-mode-icon" aria-hidden="true">{m.icon}</span>
                <span className="mh-qm-mode-label">{m.label}</span>
                {!m.enabled && <span className="mh-qm-soon">Yakında</span>}
              </button>
            ))}
          </div>
        </div>

        <p className="mh-qm-desc">{active.desc}</p>

        {/* Two side-by-side compact selectors; tapping one opens its popover. */}
        <div className="mh-qm-fields">
          {fields.map(f => (
            <QmSelect
              key={f.id}
              field={f}
              openField={openField}
              setOpenField={setOpenField}
            />
          ))}
        </div>

        <div className="mh-qm-actions">
          <button
            type="button"
            className="mh-qm-primary"
            aria-disabled={!active.enabled}
            onClick={handleStart}
          >
            {active.enabled ? "Eşleşmeye Başla" : "Kuşatma yakında aktif"}
          </button>
        </div>
      </div>
    </>,
    document.body
  );
}

export default function MobileHome({
  onPlay,
  onStartQuickMatch,
  onSubmitRoomCode,
  onOpenConquest,
  onOpenKorNokta,
  onOpenRanking,
  onOpenProfile,
  isLoggedIn,
  avatarId,
  username,
  profileActive,
  themes,
  activeTheme,
  onSelectTheme,
  onOpenDailyQuest,
}: MobileHomeProps) {
  const [openId, setOpenId] = useState<Category["id"] | null>(null);
  const [socialOpen, setSocialOpen] = useState(false);
  const [matchOpen, setMatchOpen] = useState(false);
  const [roomCodeOpen, setRoomCodeOpen] = useState(false);

  // Arkadaşlar alt-nav badge'i: okunmamış bildirim (arkadaşlık isteği, davet,
  // ödül vs. hepsi bildirim olarak gelir) + okunmamış DM toplamı. Desktop'taki
  // FriendsButton badge'iyle aynı "dikkat" mantığı; native path'te DM unread'i de
  // yüzeye taşır (sosyal merkez bu sekmeden açılır). Provider yoksa 0.
  const social = useSocialOptional();
  const dm = useDmOptional();
  const socialBadge = (social?.unreadCount ?? 0) + (dm?.totalUnread ?? 0);

  // Günün Görevi hatırlatıcısı → Arkadaşlar alt-nav badge'ine +1. dailyQuestPending
  // = giriş yapılmış && bugünkü görev henüz "bitmemiş" (oynanabilir / devam eden /
  // ödül bekleyen). YALNIZ gerçek claim ("claimed") bu +1'i kaldırır — sheet açmak
  // veya modalı kapatmak KALDIRMAZ (tek kaynak: sunucu-otoriter dailyQuest durumu).
  // Misafirde ("unknown" + isLoggedIn false) hiç eklenmez. Sosyal sayaç bundan
  // etkilenmez; iki kaynak ayrı toplanıp gösterimde birleşir (99+ üst sınırı korunur).
  // Bu +1, ANA MENÜ yüzeyine ait olduğu için …_HOME_VISIBLE'a bağlı: kapalıyken
  // ana menüde Günün Görevi'ne dair hiçbir iz kalmaz (rozet +1 dahil) ve onaylanan
  // dört-kart görünümü birebir korunur. Sosyal sayaç bundan etkilenmez; görev
  // yine intro modalı ve Arkadaşlar sheet'indeki "Görev" sekmesinden erişilebilir.
  const dqStatus = useDailyQuestStatus();
  const dailyQuestPending =
    MOBILE_DAILY_QUEST_HOME_VISIBLE &&
    isLoggedIn &&
    (dqStatus === "available" || dqStatus === "active" || dqStatus === "reward_ready");
  const navBadge = socialBadge + (dailyQuestPending ? 1 : 0);

  // Native app ana ekranında alt-nav (.mh-bottom-nav, ~70px) yalnız native'de
  // görünür; global bildirim toast'larını onun üzerine kaldır (çakışma yok).
  const isNativeApp =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("is-native-app");
  useToastSurfaceOffset(isNativeApp, 78);

  const categories: Category[] = [
    {
      id: "solo",
      icon: "🎮",
      title: "Tek Oyunculu",
      tagline: "İnternetsiz oyna, kendini geliştir.",
      modes: [
        { icon: "🌍", title: "Ülke Yaz",    desc: "Sınırlı sürede kaç ülke yazabilirsin?",     onTap: () => onPlay("map-game") },
        { icon: "🚩", title: "Bayrak Bilmece", desc: "Bayrakları ne kadar iyi tanıyorsun? Test et!",    onTap: () => onPlay("flag-game") },
        { icon: "🗺️", title: "Silüet Modu", desc: "Ülkeleri şekillerinden tanıyabilir misin?",  onTap: () => onPlay("silhouette-game") },
        { icon: "🧭", title: "Rota Modu",   desc: "Hedef ülkeye en kısa rotadan ulaş!", onTap: () => onPlay("route-game") },
        { icon: "🎯", title: "Çark Modu",   desc: "Çarkın seçtiği ülkeyi herkesten önce bul!",   onTap: () => onPlay("wheel-game") },
      ],
    },
    {
      id: "duel",
      icon: "⚔️",
      title: "Düello",
      tagline: "Rakibinle bire bir yarış.",
      modes: [
        { icon: "🌍", title: "Ülke Yaz 1v1", desc: "Rakibine karşı ülke yaz.",  onTap: () => onPlay("duel-game") },
        { icon: "🚩", title: "Bayrak 1v1",   desc: "Bayrak bilgisinde düello.", onTap: () => onPlay("flag-duel-game") },
        { icon: "🎯", title: "Çark 1v1",     desc: "Çark düellosunda yarış.",   onTap: () => onPlay("wheel-duel-game") },
        { icon: "🧭", title: "Rota 1v1",     desc: "Aynı rotada hedefe ilk ulaşan kazanır.", onTap: () => onPlay("route-duel-game") },
      ],
    },
    {
      id: "multi",
      icon: "👥",
      title: "Çok Oyunculu",
      tagline: "Oda kur, arkadaşlarınla oyna.",
      modes: [
        { icon: "🛡️", title: "Kuşatma", desc: "Doğru bil, hamle yap, ele geçir!", featured: true, onTap: onOpenConquest },
        { icon: "🕵️", title: "Kör Nokta",     desc: "Takımına güven, raporları çöz, konumu bul.", onTap: onOpenKorNokta },
        { icon: "🌍", title: "Ülke Yaz Grup", desc: "Arkadaşlarınla aynı odada yarış.", onTap: () => onPlay("duel-group-game") },
        { icon: "🚩", title: "Bayrak Grup",   desc: "Aynı bayrağı gör, ilk bilen kazanır.", onTap: () => onPlay("flag-group-game") },
        { icon: "🎯", title: "Çark Grup",     desc: "Grup halinde çark yarışı.",        onTap: () => onPlay("wheel-group-game") },
        /* Eshle — bağımsız oyunumuz; Torble içi ekran DEĞİL, harici link.
           ↗ dışarı çıkışı işaretler; window.open noopener/noreferrer ile güvenli. */
        { icon: "🎨", title: "Eshle ↗",       desc: "Çiz, hatırla, eşle!", onTap: () => window.open("https://eshle.io", "_blank", "noopener,noreferrer") },
      ],
    },
  ];

  const open = categories.find(c => c.id === openId) ?? null;

  return (
    <div className="mobile-home">
      {/* ── Ana menü: DÖRT eşit kart ────────────────────────────────────────
          Tek Oyunculu · Düello · Çok Oyunculu · Oda Kodu ile Katıl. Dördü de
          AYNI .mh-cat yüzeyi, aynı grid (ikon · metin · chevron), aynı
          min-height → aynı genişlik/yükseklik, eşit aralık (.mobile-home gap).
          Oda Kodu artık Çok Oyunculu kartının gömülü alt satırı DEĞİL, bağımsız
          dördüncü kart; tetiklediği akış (RoomCodeSheet → App'in merkezî
          çözümleyicisi, misafir yolu dahil) hiç değişmedi.

          Günün Görevi bu ekranda YOK: lib/dailyQuest → MOBILE_DAILY_QUEST_HOME_VISIBLE
          kapalı (özellik/RPC/ödül duruyor; intro ve sosyal sekme AYRI anahtarlarla
          açık — bu ekrana kart geri EKLENMEZ). */}
      {categories.map(c => (
        <button
          key={c.id}
          type="button"
          className={`mh-cat mh-cat--${c.id}`}
          onClick={() => { playSound("click"); setOpenId(c.id); }}
        >
          <span className="mh-cat-icon" aria-hidden="true">{c.icon}</span>
          <span className="mh-cat-text">
            <span className="mh-cat-titlerow">
              <span className="mh-cat-title">{c.title}</span>
              <span className="mh-cat-count">{c.modes.length} mod</span>
            </span>
            <span className="mh-cat-tagline">{c.tagline}</span>
          </span>
          <span className="mh-cat-chevron" aria-hidden="true">›</span>
        </button>
      ))}

      {/* 4. kart — Oda Kodu ile Katıl. Diğer üçüyle birebir aynı yapı; tek fark
          mod-sayısı rozetinin olmaması (zorlama badge yok, hizayı bozmaz).
          onClick gövdesi eski alt satırdan AYNEN taşındı. */}
      <button
        type="button"
        className="mh-cat mh-cat--roomcode"
        aria-label="Oda koduyla bir odaya katıl"
        onClick={() => { playSound("click"); setOpenId(null); setSocialOpen(false); setMatchOpen(false); setRoomCodeOpen(true); }}
      >
        <span className="mh-cat-icon" aria-hidden="true">🔑</span>
        <span className="mh-cat-text">
          <span className="mh-cat-titlerow">
            <span className="mh-cat-title">Oda Kodu ile Katıl</span>
          </span>
          <span className="mh-cat-tagline">Arkadaşının odasına kodla gir.</span>
        </span>
        <span className="mh-cat-chevron" aria-hidden="true">›</span>
      </button>

      {/* Hızlı Eşleş — yalnız narrow/mobil WEB'de görünür (native'de alt-nav'ın
          ⚡ Eşleş sekmesi var; CSS: html.is-native-app .mh-qm-entry{display:none}).
          Mobil web'de BAŞKA girişi yok (üst bar ≤600px'te gizli), o yüzden
          kaldırılmadı — ama dört kartın ALTINDA ve belirgin şekilde daha sessiz
          bir satır olarak durur, böylece ana grup dört eşit karttan ibaret kalır. */}
      <button
        type="button"
        className="mh-qm-entry"
        onClick={() => { playSound("click"); setOpenId(null); setSocialOpen(false); setMatchOpen(true); }}
      >
        <span className="mh-qm-entry-icon" aria-hidden="true">⚡</span>
        <span className="mh-qm-entry-text">
          <span className="mh-qm-entry-title">Hızlı Eşleş</span>
          <span className="mh-qm-entry-desc">Seviyene yakın rakiple birebir yarış.</span>
        </span>
        <span className="mh-qm-entry-chevron" aria-hidden="true">›</span>
      </button>

      {open && (
        <MobileSheet
          category={open}
          onClose={() => setOpenId(null)}
          onLaunch={run => { setOpenId(null); run(); }}
        />
      )}

      {socialOpen && (
        <SocialCenterSheet
          themes={themes}
          activeTheme={activeTheme}
          onSelectTheme={onSelectTheme}
          onClose={() => setSocialOpen(false)}
          isLoggedIn={isLoggedIn}
          /* "Görev" sekmesi: sheet'i KAPATMADAN Günün Görevi modalını açar
             (App handler'ı yalnız modalı açar, socialOpen'a dokunmaz → modal
             sheet'in ÜSTÜNDE görünür, kapanınca sheet açık kalır). */
          onOpenDailyQuest={onOpenDailyQuest}
        />
      )}

      {matchOpen && (
        <MobileQuickMatchSheet
          onClose={() => setMatchOpen(false)}
          onStartQuickMatch={(intent) => { setMatchOpen(false); onStartQuickMatch(intent); }}
        />
      )}

      {roomCodeOpen && (
        <RoomCodeSheet
          onSubmit={onSubmitRoomCode}
          onClose={() => setRoomCodeOpen(false)}
        />
      )}

      {/* Native-app tab bar. Display:none on desktop + mobile web (only
          html.is-native-app paints it), so the floating top-right login /
          ranking stack, theme picker and social dock are hidden there and
          these five tabs take over: Profil · Sıralama · Ana Menü · Eşleş ·
          Arkadaşlar. Ana Menü is the home tab; Eşleş opens the Quick Match
          sheet; Arkadaşlar opens the social center (friends / requests /
          notifications / theme); the rest delegate to the same App handlers
          the floating chrome used. Tema artık ayrı sekme değil — sosyal
          merkezin içinde. */}
      <nav className="mh-bottom-nav" aria-label="Uygulama menüsü">
        <button
          type="button"
          className={"mh-nav-item mh-nav-item--profile" + (profileActive ? " mh-nav-item--active" : "")}
          aria-expanded={profileActive}
          onClick={() => { playSound("click"); onOpenProfile(); }}
        >
          {isLoggedIn ? (
            // Selected avatar as a small round badge. The fixed-size wrapper keeps
            // the tab height stable while the active lift/glow lives on .mh-nav-avatar.
            <span className="mh-nav-avatar-wrap" aria-hidden="true">
              <Avatar
                avatarId={avatarId}
                username={username}
                className="mh-nav-avatar"
              />
            </span>
          ) : (
            <span className="mh-nav-icon" aria-hidden="true">🔑</span>
          )}
          <span className="mh-nav-label">Profil</span>
        </button>
        <button
          type="button"
          className="mh-nav-item"
          onClick={() => { playSound("click"); onOpenRanking(); }}
        >
          <span className="mh-nav-icon" aria-hidden="true">🏆</span>
          <span className="mh-nav-label">Sıralama</span>
        </button>
        <button
          type="button"
          className="mh-nav-item mh-nav-item--active"
          aria-current="page"
          onClick={() => {
            playSound("click");
            setOpenId(null);
            setSocialOpen(false);
            setMatchOpen(false);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        >
          <span className="mh-nav-icon" aria-hidden="true">🏠</span>
          <span className="mh-nav-label">Ana Menü</span>
        </button>
        <button
          type="button"
          className={"mh-nav-item" + (matchOpen ? " mh-nav-item--active" : "")}
          onClick={() => { playSound("click"); setOpenId(null); setSocialOpen(false); setMatchOpen(true); }}
        >
          <span className="mh-nav-icon" aria-hidden="true">⚡</span>
          <span className="mh-nav-label">Eşleş</span>
        </button>
        <button
          type="button"
          className={"mh-nav-item mh-nav-item--social" + (socialOpen ? " mh-nav-item--active" : "")}
          /* Badge rengi tek bilgi taşıyıcısı olmasın: sayı aria-label'a da yansır
             (screen reader "Arkadaşlar, N yeni" duyar). Görsel badge aria-hidden. */
          aria-label={navBadge > 0 ? `Arkadaşlar, ${navBadge} yeni` : "Arkadaşlar"}
          onClick={() => { playSound("click"); setOpenId(null); setMatchOpen(false); setSocialOpen(true); }}
        >
          <span className="mh-nav-icon-wrap" aria-hidden="true">
            <span className="mh-nav-icon">👥</span>
            {navBadge > 0 && (
              <span className="mh-nav-badge">{navBadge > 99 ? "99+" : navBadge}</span>
            )}
          </span>
          <span className="mh-nav-label">Arkadaşlar</span>
        </button>
      </nav>
    </div>
  );
}
