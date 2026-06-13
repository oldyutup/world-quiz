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
import { useEffect, useRef, useState } from "react";
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

interface MobileHomeProps {
  onPlay: (target: MobileHomeTarget) => void;
  /** Opens the existing ConquestModeSelectModal (create / join / browse + auth). */
  onOpenConquest: () => void;
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

  useEffect(() => {
    // Page scroll lives on body/html (home-screen grows via min-height),
    // so locking body overflow freezes the background while the sheet is up.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sheetRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

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

export default function MobileHome({ onPlay, onOpenConquest }: MobileHomeProps) {
  const [openId, setOpenId] = useState<Category["id"] | null>(null);

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
    </div>
  );
}
