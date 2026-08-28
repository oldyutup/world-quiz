/**
 * MobileMapDevPage — telefon harita etkileşimi ölçüm harness'i (DEV-ONLY).
 *
 * Gerçek bileşenleri (WorldMap, RouteMapView, RouteDuelPlay) sahte state ile
 * mount eder; ağ yok, Supabase yok. scripts/check-mobile-map-interaction.mjs
 * bu sayfayı bir iframe içinde 390x844 (telefon) ve 1280x800 (masaüstü)
 * boyutlarında açıp sentetik PointerEvent'lerle sürer — useMobileSurface()
 * matchMedia okuduğu için iframe genişliği yüzeyi belirler.
 *
 * `window.__mapTest` üzerinden test tarafına açılan yüzey:
 *   countryClicks / lastCountryId  — WorldMap onCountryClick sayacı
 *   setRoute(keys)                 — RouteMapView'ın mevcut ülkesini değiştir
 *
 * main.tsx'teki import.meta.env.DEV kapısı sayesinde production build'de bu
 * dal ve chunk hiç oluşmaz.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import WorldMap, { RouteMapView } from "../components/WorldMap";
import RouteDuelPlay from "../components/routeDuel/RouteDuelPlay";
import { buildKeyToTopoId } from "../components/RouteGame";
import { useMobileSurface } from "../lib/useIsMobile";
import { TOPOID_TO_DISPLAY } from "../data/countries";
import type { RouteDuelRoom, RouteDuelPlayer } from "../lib/routeDuelShared";
import "../App.css";

declare global {
  interface Window {
    __mapTest?: {
      countryClicks: number;
      lastCountryId: string | null;
      setRoute?: (keys: string[]) => void;
    };
  }
}

function scene(): string {
  return new URLSearchParams(window.location.search).get("scene") ?? "wheel";
}

/* ── Çark 1v1'in harita konfigürasyonu birebir ── */
function WheelScene() {
  // Çark region=world ile tüm ülkeleri tıklanabilir yapar.
  const clickable = useMemo(() => new Set(Object.keys(TOPOID_TO_DISPLAY)), []);
  const onCountryClick = useCallback((topoId: string) => {
    const t = (window.__mapTest ??= { countryClicks: 0, lastCountryId: null });
    t.countryClicks += 1;
    t.lastCountryId = topoId;
  }, []);
  return (
    <div className="wheel-map-area wd-map" style={{ position: "absolute", inset: 0 }}>
      <WorldMap
        guessedISOs={new Set()}
        lastGuessed={null}
        showLabels={false}
        activeIds={clickable}
        resetKey={0}
        region="world"
        onCountryClick={onCountryClick}
        preserveUserView
      />
    </div>
  );
}

/* ── Çark Düello oyun ekranı: ÜRETİMDEKİ DOM birebir ──
   WheelDuelGame'in playing dalının (wd-screen → wd-hud + wd-map → floating
   .wd-player-card + WorldMap) aynısı. Amaç: "hedef ülke telefonda
   tıklanamıyor" iddiasını gerçek hit-test ile ölçmek — bu yüzden WorldMap'e
   üretimdeki DÖRT durum prop'u da geçilir (guessedISOs=used, lastGuessed=son
   doğru, wrongId=kırmızı flash, activeIds=tıklanabilir havuz).
   ?target=<topoId> hedefi, ?used=a,b ve ?last=<topoId> geçmişi seçer. */
function WheelDuelScene() {
  const params = new URLSearchParams(window.location.search);
  const target = params.get("target") ?? "TUR";
  const used = useMemo(
    () => new Set((params.get("used") ?? "").split(",").filter(Boolean)),
    [],
  );
  const last = params.get("last");
  const wrong = params.get("wrong");
  const clickable = useMemo(() => new Set(Object.keys(TOPOID_TO_DISPLAY)), []);
  const onCountryClick = useCallback((topoId: string) => {
    const t = (window.__mapTest ??= { countryClicks: 0, lastCountryId: null });
    t.countryClicks += 1;
    t.lastCountryId = topoId;
  }, []);
  const targetDisplay = TOPOID_TO_DISPLAY[target] ?? target;
  return (
    // Üretimdeki sarmalayıcı: WheelDuelGame kökü `.app.duel-screen`, oyun
    // ekranı onun içindeki `.wd-screen`. Sarmalayıcı olmadan
    // `.map-container-inner`ın height:100%'i çözülmez ve harita ezilir —
    // yani ölçüm kendi düzen hatasını ürün hatası sanardı.
    <div className="app duel-screen">
    <div className="wd-screen">
      <div className="wd-hud wd-hud--duel">
        <div className="wd-hud-left">
          <button className="btn btn-ghost wd-pass-btn">🟡 Pas Geç</button>
        </div>
        <div className="wd-hud-center">
          <div className="wd-hud-label">🎯 Hedef</div>
          <div className="wd-target">{targetDisplay}</div>
        </div>
        <div className="wd-hud-right">
          <div className="wd-hud-label">⏱ Süre</div>
          <div className="wd-timer">42</div>
        </div>
      </div>
      <div className="wheel-map-area wd-map">
        <div className="wd-player-card" aria-label="Oyuncular">
          <div className="wd-player-card-title" aria-hidden="true">Oyuncular</div>
          <div className="wd-player-row wd-player-row--me">
            <span className="wd-player-name">enes1</span>
            <span className="wd-player-score">3</span>
          </div>
          <div className="wd-player-row wd-player-row--opponent">
            <span className="wd-player-name">enes</span>
            <span className="wd-player-score">2</span>
          </div>
        </div>
        <WorldMap
          guessedISOs={used}
          lastGuessed={last}
          showLabels={false}
          activeIds={clickable}
          resetKey={0}
          region="world"
          onCountryClick={onCountryClick}
          wrongId={wrong ?? undefined}
          preserveUserView
        />
      </div>
    </div>
    </div>
  );
}

/* ── Rota haritası; mevcut ülke test tarafından değiştirilebilir ── */
function RouteScene() {
  const keyToTopoId = useMemo(buildKeyToTopoId, []);
  const [routeKeys, setRouteKeys] = useState<string[]>(["Bulgaria"]);
  useEffect(() => {
    const t = (window.__mapTest ??= { countryClicks: 0, lastCountryId: null });
    t.setRoute = keys => setRouteKeys(keys);
  }, []);
  return (
    <div className="route-map-area" style={{ position: "absolute", inset: 0 }}>
      <RouteMapView
        routeKeys={routeKeys}
        startKey="Bulgaria"
        targetKey="Portugal"
        keyToTopoId={keyToTopoId}
      />
    </div>
  );
}

/* ── Rota Duel oyun ekranı: TEK kompakt HUD + harita + giriş ──
   Üretimdeki karar birebir yansıtılır (RouteDuelGame compactPlayHud):
   telefon + oyun → ayrı .duel-header HİÇ mount edilmez, geri düğmesi HUD'un
   içindedir. Masaüstü genişliğinde header geri gelir. Ölçüm scripti
   (check-route-duel-mobile-hud.mjs) bu sayfayı iframe'de sürer. */
function PlayScene() {
  const compact = useMobileSurface();
  const keyToTopoId = useMemo(buildKeyToTopoId, []);
  const now = Date.now();
  const room: RouteDuelRoom = {
    id: "dev-room", code: "TEST", status: "playing",
    total_rounds: 5, route_length: "5", host_player_id: "me",
    game_seq: 1, current_round: 2,
    round_start_key: "Bulgaria", round_target_key: "Portugal", round_pair_key: "BG>PT",
    round_started_at: new Date(now - 5000).toISOString(),
    // Legacy inert alan: yeni istemci OKUMAZ. Geçmişe koyulması bile
    // davranışı değiştirmemeli (harness bunu da kanıtlar).
    round_deadline: new Date(now - 30000).toISOString(),
    round_winner_player_id: null, round_decided_at: null,
    used_pair_keys: [], rematch_requested_by: [], match_seq: 1,
    current_match_id: "m1", room_source: "manual",
    winner_player_id: null, finished_reason: null,
    started_at: new Date(now - 5000).toISOString(), finished_at: null,
    created_at: new Date(now - 60000).toISOString(),
    updated_at: new Date(now).toISOString(),
  };
  const mk = (id: string, name: string, score: number): RouteDuelPlayer => ({
    id, room_id: "dev-room", name, is_host: id === "me", score,
    current_key: "Bulgaria", path: ["Bulgaria"],
    joined_at: new Date(now - 60000).toISOString(),
    last_seen_at: new Date(now).toISOString(),
  });
  return (
    <div className="app duel-screen rd-screen">
      {!compact && (
        <div className="duel-header">
          <button className="back-btn" title="Ana Menü">
            <span>←</span>
            <span className="back-label">Menü</span>
          </button>
          <div className="duel-header-center">
            <span className="duel-mode-label">🧭 Rota · Online 1v1</span>
            <span className="duel-code-badge">#TEST</span>
          </div>
          <div style={{ width: 80 }} />
        </div>
      )}
      <RouteDuelPlay
        room={room}
        me={mk("me", "enes1", 0)}
        opp={mk("opp", "enes", 0)}
        keyToTopoId={keyToTopoId}
        oppStaleSeconds={2}
        onSubmitMove={async () => ({ accepted: true, finished: false, won: false })}
        compact={compact}
        onExit={() => { window.__mapTest && (window.__mapTest.lastCountryId = "EXIT"); }}
      />
    </div>
  );
}

/* ── Header karşılaştırması: ince vs tam (CSS kuralının ölçümü) ── */
function HeaderScene() {
  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--bg)" }}>
      <div className="duel-header" id="full-header">
        <button className="back-btn"><span>←</span><span className="back-label">Menü</span></button>
        <div className="duel-header-center">
          <span className="duel-mode-label">🧭 Rota · Online 1v1</span>
          <span className="duel-code-badge">#TEST</span>
          <span className="duel-region-badge">5 Tur · 5 ara ülke</span>
        </div>
        <div style={{ width: 80 }} />
      </div>
    </div>
  );
}

export default function MobileMapDevPage() {
  useEffect(() => {
    window.__mapTest ??= { countryClicks: 0, lastCountryId: null };
    document.body.style.margin = "0";
  }, []);
  const s = scene();
  if (s === "wheelduel") return <WheelDuelScene />;
  if (s === "route")  return <RouteScene />;
  if (s === "play")   return <PlayScene />;
  if (s === "header") return <HeaderScene />;
  return <WheelScene />;
}
