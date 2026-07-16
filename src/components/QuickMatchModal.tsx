/**
 * QuickMatchModal.tsx — Hızlı Eşleş masaüstü seçici (desktop-only).
 *
 * Bu modal YENİ bir matchmaking mimarisi kurmaz. Yalnızca mevcut, canlı hızlı
 * eşleşme akışına bir GİRİŞ yüzeyidir: kullanıcı bir mod + o modun gerçek queue
 * parametrelerini seçer, "Eşleşme Ara" der, ve modal `onStartQuickMatch(intent)`
 * ile intent'i App'e taşır. App tarafındaki `startQuickMatch` mevcut auth
 * gate'ini uygular (giriş yapmamışsa AuthModal + intent sessionStorage'a
 * yazılır), doğru oyun ekranına yönlendirir ve o ekranın kendi "searching"
 * fazı (rakip aranıyor + iptal) devreye girer. Backend/RPC/migration YOK.
 *
 * Tüm seçenekler ve mod seti `lib/quickMatch.ts`'ten (tek doğruluk kaynağı)
 * gelir; native MobileHome sheet'iyle aynı intent kontratını paylaşır. Yalnız
 * gerçek 1v1 hızlı eşleşmesi olan modlar gösterilir (Ülke Yaz / Çark / Bayrak /
 * Kuşatma); diğer modların queue'su olmadığı için listede yer almazlar.
 *
 * Masaüstü modal dilini yeniden kullanır (.overlay + panel): role="dialog",
 * aria-modal, Escape ile kapanma, dışarı tıklama, ilk-odak + Tab hapsi ve
 * prefers-reduced-motion desteği.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { playSound } from "../lib/sound";
import {
  QUICK_MATCH_MODE_META,
  QUICK_MATCH_COUNTRY_DURATIONS,
  QUICK_MATCH_WHEEL_DURATIONS,
  QUICK_MATCH_FLAG_ROUNDS,
  QUICK_MATCH_ROUTE_ROUNDS,
  QUICK_MATCH_ROUTE_LENGTHS,
  QUICK_MATCH_CONQUEST_ROUNDS,
  QUICK_MATCH_CONQUEST_MAP_OPTIONS,
  QUICK_MATCH_REGIONS,
  QUICK_MATCH_DEFAULT_REGION,
  type QuickMatchIntent,
  type QuickMatchMode,
  type QmOption,
} from "../lib/quickMatch";

/** Masaüstü mod ikonu — ana menüdeki (App.tsx) HOME kart asset'lerinin BİREBİR
 *  aynısı. Quick Match modalı ile ana ekran aynı görsel dili konuşsun diye
 *  emoji/SVG yerine mevcut home PNG'leri doğrudan reuse edilir; yeni/duplicate
 *  asset üretilmez. `object-fit: contain` ile kesilmeden gösterilir. */
const MODE_ICON: Record<QuickMatchMode, string> = {
  country: "/assets/icons/home/country-write.png",
  wheel: "/assets/icons/home/wheel-mode.png",
  flag: "/assets/icons/home/flag-mode.png",
  route: "/assets/icons/home/route-mode.png",
  conquest: "/assets/icons/home/conquest-mode.png",
};

/** Mod satırı için ortak ikon görseli — trigger (seçili) ve liste satırlarında
 *  aynı asset + aynı ölçü/hizalama. */
function QmModeIcon({ mode }: { mode: QuickMatchMode }) {
  return <img className="qms-mode-img" src={MODE_ICON[mode]} alt="" aria-hidden="true" />;
}

/** Hızlı Eşleş işareti — "hızlı" (şimşek) sembolü; mobil ⚡ Eşleş kimliğini
 *  yankılar. Gerçek mod ikonlarından (PNG/emoji) kasıtlı olarak ayrı, accent
 *  renkli tek-parça bir glyph. Ana ekran giriş kartı da (App.tsx) bunu kullanır. */
export function MatchGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13 2 L4.5 13 h5 l-2 9 L18 10 h-5 z" />
    </svg>
  );
}

/** One selectable row inside a QmSelect listbox. */
interface QmFieldOption {
  label: string;
  value: string | number;
  disabled?: boolean;
  /** Optional leading glyph — mode rows carry an EmojiIcon; region/map rows bake
   *  their flag into the label, so they leave this unset. */
  icon?: ReactNode;
}

/**
 * Tek bir seçim alanı: kapalıyken yalnız seçili değeri + chevron gösteren bir
 * trigger button, açıkken kendi altına (yer yoksa üstüne) açılan özel bir
 * listbox. Native <select> DEĞİL — Torble modal diline oturan, klavye-gezilebilir
 * (button + role="listbox"/"option") sağlam bir yapı.
 *
 * Aynı anda tek liste açık kalır: hangi alanın açık olduğunu üst bileşen
 * (`openField`) tutar; yeni bir alan açılınca öncekinin `open`'ı düşer ve kapanır.
 * Dışarı tıklama ve Escape açık listeyi kapatıp odağı trigger'a döndürür.
 */
function QmSelect({
  id,
  label,
  options,
  value,
  onSelect,
  openField,
  setOpenField,
}: {
  id: string;
  label: string;
  options: QmFieldOption[];
  value: string | number;
  onSelect: (v: string | number) => void;
  openField: string | null;
  setOpenField: (id: string | null) => void;
}) {
  const open = openField === id;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // Aşağı mı yukarı mı açıldığı + liste yüksekliği tavanı; açılışta modal
  // sınırlarına göre ölçülür, böylece liste modal dışına asla taşmaz.
  const [placement, setPlacement] = useState<"down" | "up">("down");
  const [popMaxH, setPopMaxH] = useState<number | undefined>(undefined);

  const selected = options.find((o) => o.value === value);

  // Açıkken: dışarı tıklama + Escape kapatır. Capture fazı, modalın kendi
  // Escape-ile-kapan handler'ından önce kazanmak için (stopPropagation).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpenField(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpenField(null);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, setOpenField]);

  // Açılışta yön + yükseklik tavanını, alanın modal içindeki konumundan hesapla:
  // altta yer varsa aşağı, yoksa yukarı açılır; her iki halde de liste modalın
  // içinde kalır ve gerekirse kendi içinde kayar. Boyamadan önce (layout effect)
  // ölçülür ki sıçrama olmasın; resize/rotate'te yeniden ölçülür.
  useLayoutEffect(() => {
    if (!open) {
      setPopMaxH(undefined);
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const fieldRect = root.getBoundingClientRect();
      const modal = root.closest<HTMLElement>(".qm-modal");
      const bounds = modal
        ? modal.getBoundingClientRect()
        : ({ top: 0, bottom: window.innerHeight } as DOMRect);
      const GAP = 6; // trigger ile liste arasındaki boşluk (CSS ile aynı)
      const PAD = 12; // modal kenarından nefes payı
      const below = bounds.bottom - fieldRect.bottom - GAP - PAD;
      const above = fieldRect.top - bounds.top - GAP - PAD;
      const CAP = 320; // görsel yükseklik tavanı; liste bunun ötesinde kayar
      // Önce aşağıyı dene; yalnız altta yer darsa ve üstte daha genişse yukarı çevir.
      if (below >= Math.min(CAP, 168) || below >= above) {
        setPlacement("down");
        setPopMaxH(Math.max(120, Math.min(CAP, below)));
      } else {
        setPlacement("up");
        setPopMaxH(Math.max(120, Math.min(CAP, above)));
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  // Açılınca odağı seçili (yoksa ilk etkin) seçeneğe bırak — klavye kullanıcısı
  // doğrudan listenin içine iner.
  useEffect(() => {
    if (!open) return;
    const pop = popRef.current;
    const target =
      pop?.querySelector<HTMLElement>('[aria-selected="true"]:not([disabled])') ??
      pop?.querySelector<HTMLElement>(".qms-opt:not([disabled])");
    target?.focus();
  }, [open]);

  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const opts = Array.from(
      popRef.current?.querySelectorAll<HTMLElement>(".qms-opt:not([disabled])") ?? []
    );
    if (!opts.length) return;
    const cur = opts.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "ArrowDown"
        ? Math.min(opts.length - 1, cur + 1)
        : Math.max(0, cur < 0 ? 0 : cur - 1);
    opts[next]?.focus();
  };

  return (
    <div className="qms-field" ref={rootRef}>
      <span className="qms-label" id={`qms-label-${id}`}>{label}</span>
      <button
        ref={triggerRef}
        type="button"
        className={"qms-trigger" + (open ? " is-open" : "")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`qms-label-${id} qms-val-${id}`}
        onClick={() => {
          playSound("click");
          setOpenField(open ? null : id);
        }}
      >
        {selected?.icon != null && (
          <span className="qms-trigger-icon" aria-hidden="true">{selected.icon}</span>
        )}
        <span className="qms-trigger-val" id={`qms-val-${id}`}>{selected?.label ?? "—"}</span>
        <span className="qms-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          ref={popRef}
          className={"qms-pop qms-pop--" + placement}
          role="listbox"
          aria-label={label}
          onKeyDown={onListKey}
          style={popMaxH != null ? { maxHeight: popMaxH } : undefined}
        >
          {options.map((o) => {
            const isSel = o.value === value;
            return (
              <button
                key={String(o.value)}
                type="button"
                role="option"
                aria-selected={isSel}
                disabled={o.disabled}
                className={
                  "qms-opt" + (isSel ? " is-sel" : "") + (o.disabled ? " is-soon" : "")
                }
                onClick={() => {
                  if (o.disabled) return;
                  playSound("click");
                  onSelect(o.value);
                  setOpenField(null);
                  triggerRef.current?.focus();
                }}
              >
                {o.icon != null && (
                  <span className="qms-opt-icon" aria-hidden="true">{o.icon}</span>
                )}
                <span className="qms-opt-label">{o.label}</span>
                {o.disabled ? (
                  <span className="qms-opt-soon">Yakında</span>
                ) : (
                  isSel && <span className="qms-opt-check" aria-hidden="true">✓</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Focusable elemanları (görünür, disabled değil, tabindex≠-1) DOM sırasında
 *  toplar — Tab hapsi için ilk/son elemanı bulmakta kullanılır. */
function getFocusable(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const sel = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter(
    (el) => el.offsetParent !== null && el.getAttribute("tabindex") !== "-1"
  );
}

export function QuickMatchModal({
  onClose,
  onStartQuickMatch,
  themeAttr,
}: {
  onClose: () => void;
  onStartQuickMatch: (intent: QuickMatchIntent) => void;
  /** Aktif ana ekran temasının data-theme değeri (ConquestModeSelectModal
   *  deseni): "dark-space" (Zümrüt Vadi) gelirse panel/CTA'lar CSS'te zümrüt
   *  aileye döner. Eşleşme mantığına dokunmaz — yalnız görsel kanca. */
  themeAttr?: string;
}) {
  const modalRef = useRef<HTMLDivElement>(null);

  // Varsayılan: Ülke Yaz (oynanabilir mod) seçili açılır — böylece kullanıcı
  // birkaç tıkla aramaya geçebilir. Queue YALNIZ "Eşleşme Ara"da başlar.
  const [mode, setMode] = useState<QuickMatchMode>("country");
  const [countryDuration, setCountryDuration] = useState(60); // Ülke Yaz varsayılan 1 dk
  const [wheelDuration, setWheelDuration] = useState(60);     // Çark varsayılan 1 dk
  const [flagRounds, setFlagRounds] = useState(10);           // Bayrak varsayılan 10 Tur
  const [routeRounds, setRouteRounds] = useState(5);          // Rota varsayılan 5 Tur
  const [routeLength, setRouteLength] = useState("7");        // Rota varsayılan 7 ara ülke
  const [siegeRounds, setSiegeRounds] = useState(6);          // Kuşatma varsayılan 6 Tur
  const [region, setRegion] = useState<string>(QUICK_MATCH_DEFAULT_REGION);
  // Aynı anda tek açılır liste: hangi alanın (mode | duration | rounds | region |
  // map) listesinin açık olduğu. Yeni bir alan açılınca öncekini bu state kapatır.
  const [openField, setOpenField] = useState<string | null>(null);

  const active = QUICK_MATCH_MODE_META.find((m) => m.mode === mode)!;

  // İlk açılışta paneli odakla (SR "Hızlı Eşleş dialog" duyurur), sonra Tab
  // içerideki kontrollere iner.
  useEffect(() => {
    const t = window.setTimeout(() => modalRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, []);

  // Escape her yerden kapatır. (Global Escape-pass zaten role="dialog" varken
  // devre dışı kaldığı için çakışma yok.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Tab hapsi — odak modalın dışına kaçmaz.
  const onModalKeyDown = useCallback((e: ReactKeyboardEvent) => {
    if (e.key !== "Tab") return;
    const focusable = getFocusable(modalRef.current);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeEl = document.activeElement;
    if (e.shiftKey && (activeEl === first || activeEl === modalRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && activeEl === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  // Seçili modun queue'suna gerçekten ulaşan İKİ kontrol. Kıta üç düello moduyla
  // ortak; Kuşatma yalnız Türkiye haritasını taşır (bölge orada anlamsız).
  const fields = useMemo(() => {
    switch (mode) {
      case "country":
        return [
          { id: "duration", label: "Süre", options: QUICK_MATCH_COUNTRY_DURATIONS as QmOption[], value: countryDuration, onSelect: (v: string | number) => setCountryDuration(v as number) },
          { id: "region", label: "Kıta", options: QUICK_MATCH_REGIONS, value: region, onSelect: (v: string | number) => setRegion(v as string) },
        ];
      case "wheel":
        return [
          { id: "duration", label: "Süre", options: QUICK_MATCH_WHEEL_DURATIONS as QmOption[], value: wheelDuration, onSelect: (v: string | number) => setWheelDuration(v as number) },
          { id: "region", label: "Kıta", options: QUICK_MATCH_REGIONS, value: region, onSelect: (v: string | number) => setRegion(v as string) },
        ];
      case "flag":
        return [
          { id: "rounds", label: "Tur", options: QUICK_MATCH_FLAG_ROUNDS as QmOption[], value: flagRounds, onSelect: (v: string | number) => setFlagRounds(v as number) },
          { id: "region", label: "Kıta", options: QUICK_MATCH_REGIONS, value: region, onSelect: (v: string | number) => setRegion(v as string) },
        ];
      case "route":
        return [
          { id: "rounds", label: "Tur", options: QUICK_MATCH_ROUTE_ROUNDS as QmOption[], value: routeRounds, onSelect: (v: string | number) => setRouteRounds(v as number) },
          { id: "routeLength", label: "Rota Uzunluğu", options: QUICK_MATCH_ROUTE_LENGTHS, value: routeLength, onSelect: (v: string | number) => setRouteLength(v as string) },
        ];
      case "conquest":
        return [
          { id: "rounds", label: "Tur", options: QUICK_MATCH_CONQUEST_ROUNDS as QmOption[], value: siegeRounds, onSelect: (v: string | number) => setSiegeRounds(v as number) },
          { id: "map", label: "Harita", options: QUICK_MATCH_CONQUEST_MAP_OPTIONS, value: "turkey", onSelect: () => { /* Türkiye tek canlı harita */ } },
        ];
    }
  }, [mode, countryDuration, wheelDuration, flagRounds, routeRounds, routeLength, siegeRounds, region]);

  function buildIntent(): QuickMatchIntent {
    switch (mode) {
      case "country": return { mode, duration: countryDuration, region };
      case "wheel":   return { mode, duration: wheelDuration, region };
      case "flag":    return { mode, rounds: flagRounds, region };
      case "route":   return { mode, rounds: routeRounds, routeLength };
      case "conquest": return { mode, rounds: siegeRounds, map: "turkey" };
    }
  }

  const handleSearch = () => {
    if (!active.enabled) return;
    playSound("click");
    // Intent'i App'e taşı; App mevcut auth gate + queue + yönlendirmeyi yapar.
    onStartQuickMatch(buildIntent());
    // Modalı kapat: giriş yapmamış kullanıcıda AuthModal önü açık kalsın; giriş
    // yapmışta zaten oyun ekranına geçilir (HomeScreen unmount olur).
    onClose();
  };

  return (
    <div
      className="overlay qm-overlay"
      data-theme={themeAttr}
      onClick={() => { playSound("click"); onClose(); }}
    >
      <div
        ref={modalRef}
        className="qm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="qm-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onModalKeyDown}
      >
        <header className="qm-head">
          <span className="qm-head-glyph" aria-hidden="true"><MatchGlyph /></span>
          <div className="qm-head-text">
            <h2 id="qm-title" className="qm-title">Hızlı Eşleş</h2>
            <p className="qm-sub">Bir mod seç, rakip bul, hemen başla.</p>
          </div>
          <button
            type="button"
            className="qm-close"
            aria-label="Kapat"
            onClick={() => { playSound("click"); onClose(); }}
          >
            ✕
          </button>
        </header>

        <div className="qm-form">
          <QmSelect
            id="mode"
            label="Mod"
            value={mode}
            onSelect={(v) => {
              setMode(v as QuickMatchMode);
              setOpenField(null);
            }}
            openField={openField}
            setOpenField={setOpenField}
            options={QUICK_MATCH_MODE_META.map((m) => ({
              label: m.label,
              value: m.mode,
              icon: <QmModeIcon mode={m.mode} />,
            }))}
          />
          {fields.map((f) => (
            <QmSelect
              key={f.id}
              id={f.id}
              label={f.label}
              value={f.value}
              onSelect={f.onSelect}
              openField={openField}
              setOpenField={setOpenField}
              options={f.options}
            />
          ))}
        </div>

        <button
          type="button"
          className="btn btn-accent qm-search"
          disabled={!active.enabled}
          onClick={handleSearch}
        >
          <span className="qm-search-glyph" aria-hidden="true"><MatchGlyph /></span>
          Eşleşme Ara
        </button>
        <p className="qm-foot">Seviyene yakın bir rakip aranır; istediğin an iptal edebilirsin.</p>
      </div>
    </div>
  );
}
