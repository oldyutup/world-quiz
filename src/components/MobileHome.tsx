/* ═══════════════════════════════════════════════════════════════
   MOBILE-ONLY APP HOME
   App-style homepage for narrow viewports (≤600px). Rendered next
   to the classic .mode-grid inside HomeScreen; CSS decides which
   tree is visible (.mobile-home is display:none on desktop, and
   .mode-grid is hidden at ≤600px). The desktop homepage markup,
   styling and behaviour stay untouched.

   IA: the first screen shows only three category cards (Tek
   Oyunculu / Düello / Çok Oyunculu). Tapping one opens a bottom
   sheet listing that category's modes; Kuşatma is the featured
   card at the top of the Çok Oyunculu sheet.

   Purely presentational: every action routes through the same
   callbacks the desktop mode cards use — onPlay maps to App's
   setScreen via HomeScreen's onSelect, and Kuşatma opens the same
   select modal (with its existing auth handling). No gameplay
   logic, no new AppScreen ids, no invite-link changes.

   App v1 scope: Kör Nokta, Harita/Çağ Dedektifi and other
   360/panorama modes are intentionally NOT surfaced here — they
   stay desktop-web-only for now (invite links still work; only
   this mobile navigation omits them).
═══════════════════════════════════════════════════════════════ */
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { playSound } from "../lib/sound";

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
  | "duel-group-game"
  | "wheel-group-game";

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
  /** Opens the existing ConquestModeSelectModal (create / join / browse + auth). */
  onOpenConquest: () => void;
  /** Bottom-nav (native app shell only). Each reuses an App-level handler:
   *  ranking opens the existing LeaderboardModal; profile opens the AuthModal
   *  when logged out or the existing UserProfileDropdown when logged in. */
  onOpenRanking: () => void;
  onOpenProfile: () => void;
  /** Drives the Profil tab's icon/label only; the action lives in onOpenProfile. */
  isLoggedIn: boolean;
  /** Home themes (App's HOME_THEMES) surfaced by the Tema tab as a bottom
   *  sheet; onSelectTheme is App's setHomeTheme — no new theme logic. */
  themes: ThemeOption[];
  activeTheme: string;
  onSelectTheme: (id: string) => void;
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

/** Theme picker as a native bottom sheet. Reuses the .mh-sheet shell + the
 *  real setHomeTheme handler (onSelect); only opened from the native-app
 *  bottom-nav Tema tab, so it never appears on desktop or mobile web. */
function MobileThemeSheet({
  themes,
  active,
  onSelect,
  onClose,
}: {
  themes: ThemeOption[];
  active: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useSheetLock(sheetRef, onClose);

  return createPortal(
    <>
      <div
        className="mh-sheet-backdrop"
        aria-hidden="true"
        onClick={() => { playSound("click"); onClose(); }}
      />
      <div
        ref={sheetRef}
        className="mh-sheet mh-sheet--theme"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mh-theme-title"
        tabIndex={-1}
      >
        <div className="mh-sheet-grab" aria-hidden="true" />
        <header className="mh-sheet-head">
          <span className="mh-sheet-icon" aria-hidden="true">🎨</span>
          <h3 id="mh-theme-title" className="mh-sheet-title">Tema</h3>
          <button
            type="button"
            className="mh-sheet-close"
            aria-label="Kapat"
            onClick={() => { playSound("click"); onClose(); }}
          >
            ✕
          </button>
        </header>
        <div className="mh-rows" role="menu" aria-label="Arka plan teması">
          {themes.map(t => (
            <button
              key={t.id}
              type="button"
              className={"mh-theme-row" + (t.id === active ? " mh-theme-row--active" : "")}
              role="menuitemradio"
              aria-checked={t.id === active}
              onClick={() => { playSound("click"); onSelect(t.id); onClose(); }}
            >
              <span className="mh-theme-swatch" style={{ background: t.swatch }} aria-hidden="true" />
              <span className="mh-theme-name">{t.name}</span>
              {t.id === active && <span className="mh-theme-check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      </div>
    </>,
    document.body
  );
}

/** Quick Match (Eşleş tab) — native-only placeholder entry panel for the
 *  future, level-based matchmaking system. NO real matchmaking yet: the mode
 *  cards and süre/tur controls are an inert preview and the primary CTA is
 *  disabled. The only live action reuses the existing Düello mode sheet so a
 *  player can still set up a duel today. Reuses the .mh-sheet shell and is
 *  opened solely from the native-app bottom-nav, so it never reaches desktop
 *  or mobile web. When real matchmaking lands, this panel becomes its home. */
function MobileQuickMatchSheet({
  onClose,
  onCreateDuelRoom,
}: {
  onClose: () => void;
  onCreateDuelRoom: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useSheetLock(sheetRef, onClose);

  // Future duello modes, mirroring the Düello category. Preview-only here.
  const modes = [
    { icon: "🌍", label: "Ülke Yaz Düellosu" },
    { icon: "🚩", label: "Bayrak Düellosu" },
    { icon: "🎯", label: "Çark Düellosu" },
  ];

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
          <span className="mh-qm-soon">Yakında</span>
          <button
            type="button"
            className="mh-sheet-close"
            aria-label="Kapat"
            onClick={() => { playSound("click"); onClose(); }}
          >
            ✕
          </button>
        </header>

        <p className="mh-qm-intro">
          Seviyene uygun rakiplerle hızlıca eşleşmen için hazırlanıyor.
        </p>

        <div className="mh-qm-group">
          <span className="mh-qm-section">Mod</span>
          <div className="mh-qm-modes">
            {modes.map((m, i) => (
              <button
                key={m.label}
                type="button"
                className={"mh-qm-mode" + (i === 0 ? " mh-qm-mode--active" : "")}
                disabled
                aria-disabled="true"
              >
                <span className="mh-qm-mode-icon" aria-hidden="true">{m.icon}</span>
                <span className="mh-qm-mode-label">{m.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Süre / Tur — inert preview readouts of the planned match settings. */}
        <div className="mh-qm-prefs">
          <div className="mh-qm-group">
            <span className="mh-qm-section">Süre</span>
            <div className="mh-qm-chips" aria-hidden="true">
              <span className="mh-qm-chip">60 sn</span>
              <span className="mh-qm-chip mh-qm-chip--active">120 sn</span>
              <span className="mh-qm-chip">180 sn</span>
            </div>
          </div>
          <div className="mh-qm-group">
            <span className="mh-qm-section">Tur</span>
            <div className="mh-qm-chips" aria-hidden="true">
              <span className="mh-qm-chip">5</span>
              <span className="mh-qm-chip mh-qm-chip--active">10</span>
              <span className="mh-qm-chip">15</span>
            </div>
          </div>
        </div>

        <div className="mh-qm-actions">
          <button type="button" className="mh-qm-primary" disabled aria-disabled="true">
            Yakında aktif olacak
          </button>
          <button
            type="button"
            className="mh-qm-secondary"
            onClick={() => { playSound("click"); onCreateDuelRoom(); }}
          >
            Şimdilik düello odası kur
          </button>
        </div>
      </div>
    </>,
    document.body
  );
}

export default function MobileHome({
  onPlay,
  onOpenConquest,
  onOpenRanking,
  onOpenProfile,
  isLoggedIn,
  themes,
  activeTheme,
  onSelectTheme,
}: MobileHomeProps) {
  const [openId, setOpenId] = useState<Category["id"] | null>(null);
  const [themeOpen, setThemeOpen] = useState(false);
  const [matchOpen, setMatchOpen] = useState(false);

  const categories: Category[] = [
    {
      id: "solo",
      icon: "🎮",
      title: "Tek Oyunculu",
      tagline: "İnternetsiz oyna, kendini geliştir.",
      modes: [
        { icon: "🌍", title: "Ülke Yaz",    desc: "Haritadaki ülkeleri yaz.",     onTap: () => onPlay("map-game") },
        { icon: "🚩", title: "Bayrak Modu", desc: "Bayrağı tanı, ülkeyi yaz.",    onTap: () => onPlay("flag-game") },
        { icon: "🗺️", title: "Silüet Modu", desc: "Silüetten ülkeyi tahmin et.",  onTap: () => onPlay("silhouette-game") },
        { icon: "🧭", title: "Rota Modu",   desc: "Komşu ülkelerle hedefe ulaş.", onTap: () => onPlay("route-game") },
        { icon: "🎯", title: "Çark Modu",   desc: "Çarkın seçtiği ülkeyi bul.",   onTap: () => onPlay("wheel-game") },
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
      ],
    },
    {
      id: "multi",
      icon: "👥",
      title: "Çok Oyunculu",
      tagline: "Oda kur, arkadaşlarınla oyna.",
      modes: [
        { icon: "🛡️", title: "Kuşatma", desc: "Bölgeleri kuşat, haritayı ele geçir.", featured: true, onTap: onOpenConquest },
        { icon: "🌍", title: "Ülke Yaz Grup", desc: "Arkadaşlarınla aynı odada yarış.", onTap: () => onPlay("duel-group-game") },
        { icon: "🎯", title: "Çark Grup",     desc: "Grup halinde çark yarışı.",        onTap: () => onPlay("wheel-group-game") },
      ],
    },
  ];

  const open = categories.find(c => c.id === openId) ?? null;

  return (
    <div className="mobile-home">
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

      {open && (
        <MobileSheet
          category={open}
          onClose={() => setOpenId(null)}
          onLaunch={run => { setOpenId(null); run(); }}
        />
      )}

      {themeOpen && (
        <MobileThemeSheet
          themes={themes}
          active={activeTheme}
          onSelect={onSelectTheme}
          onClose={() => setThemeOpen(false)}
        />
      )}

      {matchOpen && (
        <MobileQuickMatchSheet
          onClose={() => setMatchOpen(false)}
          // Reuse the existing Düello mode sheet — the duel flow today.
          onCreateDuelRoom={() => { setMatchOpen(false); setOpenId("duel"); }}
        />
      )}

      {/* Native-app tab bar. Display:none on desktop + mobile web (only
          html.is-native-app paints it), so the floating top-right login /
          ranking stack, theme picker and social dock are hidden there and
          these five tabs take over: Profil · Sıralama · Ana Menü · Eşleş ·
          Tema. Ana Menü is the home tab; Eşleş opens the Quick Match sheet;
          the rest delegate to the same App handlers the floating chrome used. */}
      <nav className="mh-bottom-nav" aria-label="Uygulama menüsü">
        <button
          type="button"
          className="mh-nav-item"
          onClick={() => { playSound("click"); onOpenProfile(); }}
        >
          <span className="mh-nav-icon" aria-hidden="true">{isLoggedIn ? "👤" : "🔑"}</span>
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
            setThemeOpen(false);
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
          onClick={() => { playSound("click"); setOpenId(null); setThemeOpen(false); setMatchOpen(true); }}
        >
          <span className="mh-nav-icon" aria-hidden="true">⚡</span>
          <span className="mh-nav-label">Eşleş</span>
        </button>
        <button
          type="button"
          className={"mh-nav-item" + (themeOpen ? " mh-nav-item--active" : "")}
          onClick={() => { playSound("click"); setOpenId(null); setMatchOpen(false); setThemeOpen(true); }}
        >
          <span className="mh-nav-icon" aria-hidden="true">🎨</span>
          <span className="mh-nav-label">Tema</span>
        </button>
      </nav>
    </div>
  );
}
