/**
 * HaritaDuelMatch — Harita Dedektifi Online 1v1 maç (round) ekranı.
 *
 * Mimari:
 *   - Lobby (HaritaDuelGame) host "Oyunu Başlat" dediğinde matchId + karışık
 *     sahne sırasını lobby kanalındaki "start" broadcast'iyle yayar; bu
 *     component o payload'la mount olur. Sahne sırası bu yüzden iki client'ta
 *     birebir aynıdır.
 *   - Maç eventleri ayrı bir realtime kanalda akar:
 *       channel: `harita-duel-match-<matchId>`  (broadcast self: true →
 *       host kendi yayınını da alır, host + joiner aynı kod yolunu işler)
 *       events : request_state / state_snapshot / guess_submitted /
 *                countdown_started / round_resolved / next_round /
 *                match_finished
 *   - Host authoritative: tahminler host'a gider, mesafe/puan host'ta
 *     geoUtils ile hesaplanır, round sonucu ve maç bitişi yalnızca host
 *     tarafından broadcast edilir. Joiner sadece kendi tahminini gönderir.
 *   - Zaman kuralı: round başında süre yok; ilk tahmin host'a ulaştığında
 *     host 15 sn'lik mutlak deadline (server-synced epoch ms) yayınlar.
 *     İki client de geri sayımı getSyncedNowMs() ile aynı ana göre çizer.
 *   - Panorama + Leaflet panel tek oyunculu HaritaDedektifiGame'den birebir
 *     uyarlanmıştır (o dosyaya dokunulmaz).
 *   - DB yok: round state tamamen broadcast + mount'ta snapshot ile yürür.
 *     Gold mevcut award_gameplay_gold RPC'si (map_match_reward) üzerinden,
 *     XP award_harita_duel_xp_event RPC'si üzerinden (migration uygulanana
 *     kadar XP yazımı sessizce başarısız olur, oyun etkilenmez).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import { supabase } from "../../lib/supabase";
import GoldIcon from "../../components/GoldIcon";
import {
  HARITA_DEDEKTIFI_SCENES,
  type HaritaDedektifiScene,
} from "./haritaDedektifiScenes";
import { getMapTileProvider } from "./mapTileProvider";
import { calculateDistanceKm, calculateLocationScore } from "./geoUtils";
import { getSyncedNowMs, initServerClockSync } from "../../lib/serverClock";
import { addGold } from "../../lib/gold";
import {
  awardXpEvent,
  calculateHaritaDuelXp,
  type MatchResult,
  type XpBreakdown,
} from "../../lib/progression";
import { recordOnlineMatchResult, recordGameComplete } from "../../lib/achievementStats";
import XpGainBar from "../../components/XpGainBar";
import { playSound, stopSound } from "../../lib/sound";
import type { Profile } from "../../lib/auth";
import "./CagDedektifiGame.css";

// Leaflet's default marker assets break under bundlers — re-point them at the
// imported URLs so the pin shows up. (Aynı patch HaritaDedektifiGame'de de
// var; mergeOptions idempotent olduğu için iki kez çalışması sorun değil.)
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});

/* ── Maç başlangıç verisi (lobby "start" payload'ı) ── */
export interface HaritaDuelMatchPlayer {
  playerId: string;
  name: string;
  isHost: boolean;
}

export interface HaritaDuelMatchInit {
  matchId: string;
  rounds: number;
  sceneIds: string[];
  hostId: string;
  players: HaritaDuelMatchPlayer[];
}

/* ── Realtime payload tipleri ── */
interface GuessSubmittedPayload {
  playerId: string;
  roundIndex: number;
  lat: number;
  lng: number;
}

interface CountdownStartedPayload {
  roundIndex: number;
  deadlineMs: number;
}

interface PlayerRoundResult {
  lat: number;
  lng: number;
  distanceKm: number;
  score: number;
}

interface RoundResolvedPayload {
  roundIndex: number;
  isLast: boolean;
  /** playerId → sonuç; submit etmeyen oyuncu için null (0 puan). */
  results: Record<string, PlayerRoundResult | null>;
  totals: Record<string, number>;
  roundWins: Record<string, number>;
  roundWinnerId: string | null;
}

interface TransitionStartedPayload {
  roundIndex: number;
  deadlineMs: number;
  /** true → son round; geçiş bitince maç finali yayınlanır. */
  isLast: boolean;
}

interface NextRoundPayload {
  roundIndex: number;
}

interface MatchFinishedPayload {
  totals: Record<string, number>;
  roundWins: Record<string, number>;
  winnerId: string | null;
  roundsPlayed: number;
}

interface StateSnapshotPayload {
  roundIndex: number;
  countdownDeadlineMs: number | null;
  transitionDeadlineMs: number | null;
  submittedIds: string[];
  resolved: RoundResolvedPayload | null;
  finished: MatchFinishedPayload | null;
  totals: Record<string, number>;
  roundWins: Record<string, number>;
}

interface HaritaDuelMatchProps {
  myId: string;
  myName: string;
  isHost: boolean;
  matchInit: HaritaDuelMatchInit;
  profile?: Profile | null;
  /** Final ekranındaki "Lobiye Dön" — oda bekleme ekranına geri döner. */
  onExitToLobby: () => void;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

const MIN_PITCH_DEG = -85;
const MAX_PITCH_DEG = 85;
const MIN_FOV = 65;
const MAX_FOV = 90;
const DEFAULT_FOV = 80;
const SPHERE_RADIUS = 500;

const MAP_DEFAULT_CENTER: [number, number] = [25, 20];
const MAP_DEFAULT_ZOOM = 3;

/** İlk tahmin geldikten sonra rakibe tanınan süre. */
const COUNTDOWN_MS = 15_000;
/** Round sonucu gösterildikten sonra otomatik sıradaki round/final geçişinin
 *  toplam süresi. İlk (TRANSITION_MS − TRANSITION_OVERLAY_MS) ms okuma için,
 *  son TRANSITION_OVERLAY_MS ms büyük geçiş kartı + geri sayım için. */
const TRANSITION_MS = 10_000;
/** Geçişin son bölümü: deadline'a bu kadar kala ortadaki büyük geçiş kartı
 *  belirir ve 3→2→1 sayar. Önceki süre boyunca sadece sonuç paneli okunur. */
const TRANSITION_OVERLAY_MS = 3_000;
/** Maç kazananına verilen Gold. Beraberlikte / kaybedene verilmez. */
const WINNER_GOLD = 50;

function normalizeYawDeg(deg: number) {
  let v = deg % 360;
  if (v > 180) v -= 360;
  if (v <= -180) v += 360;
  return v;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function yawPitchDegToDirection(yawDeg: number, pitchDeg: number, out: THREE.Vector3) {
  const yaw = yawDeg * DEG2RAD;
  const pitch = pitchDeg * DEG2RAD;
  const cp = Math.cos(pitch);
  out.set(cp * Math.cos(yaw), Math.sin(pitch), -cp * Math.sin(yaw));
  return out;
}

function formatDistance(distanceKm: number): string {
  return distanceKm >= 10
    ? `${Math.round(distanceKm).toLocaleString("tr-TR")} km`
    : `${distanceKm.toFixed(1)} km`;
}

interface XpResultState {
  awarded: boolean;
  xpEarned: number;
  prevTotalXp: number;
  totalXp: number;
  prevModeXp: number;
  modeXp: number;
  breakdown: XpBreakdown;
  dismissed: boolean;
}

export default function HaritaDuelMatch({
  myId,
  myName,
  isHost,
  matchInit,
  profile,
  onExitToLobby,
}: HaritaDuelMatchProps) {
  /* ── Sahne sırası (id → sahne çözümü; iki client'ta aynı) ── */
  const scenes: HaritaDedektifiScene[] = useMemo(() => {
    const byId = new Map(HARITA_DEDEKTIFI_SCENES.map((s) => [s.id, s]));
    return matchInit.sceneIds
      .map((id) => byId.get(id))
      .filter((s): s is HaritaDedektifiScene => !!s);
  }, [matchInit.sceneIds]);

  const totalRounds = scenes.length;
  const opponent = useMemo(
    () => matchInit.players.find((p) => p.playerId !== myId) ?? null,
    [matchInit.players, myId],
  );

  /* ── Maç state ── */
  const [roundIndex, setRoundIndex] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [opponentSubmitted, setOpponentSubmitted] = useState(false);
  const [countdownDeadline, setCountdownDeadline] = useState<number | null>(null);
  /** Round sonucu → sıradaki round/final arası 10 sn'lik otomatik geçişin
   *  mutlak deadline'ı (server-synced epoch ms). Overlay son 3 sn'de açılır. */
  const [transitionDeadline, setTransitionDeadline] = useState<number | null>(null);
  const [roundResult, setRoundResult] = useState<RoundResolvedPayload | null>(null);
  const [finished, setFinished] = useState<MatchFinishedPayload | null>(null);
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [opponentLeft, setOpponentLeft] = useState(false);

  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [guess, setGuess] = useState<{ lat: number; lng: number } | null>(null);
  const [mapPanelExpanded, setMapPanelExpanded] = useState(false);

  const sceneIdx = Math.min(roundIndex, Math.max(0, totalRounds - 1));
  const scene: HaritaDedektifiScene | undefined = scenes[sceneIdx];

  /* ── Refs (realtime handler'lar resubscribe olmadan güncel state okusun) ── */
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const roundIndexRef = useRef(0);
  roundIndexRef.current = roundIndex;
  const submittedRef = useRef(false);
  submittedRef.current = submitted;
  const roundResultRef = useRef<RoundResolvedPayload | null>(null);
  roundResultRef.current = roundResult;
  const finishedRef = useRef<MatchFinishedPayload | null>(null);
  finishedRef.current = finished;
  const countdownDeadlineRef = useRef<number | null>(null);
  countdownDeadlineRef.current = countdownDeadline;
  const transitionDeadlineRef = useRef<number | null>(null);
  transitionDeadlineRef.current = transitionDeadline;

  /* Host-authoritative maç defteri (sadece host yazar) */
  const hostGuessesRef = useRef<Map<string, { lat: number; lng: number }>>(new Map());
  const hostTotalsRef = useRef<Record<string, number>>({});
  const hostRoundWinsRef = useRef<Record<string, number>>({});
  const hostResolvedRef = useRef<RoundResolvedPayload | null>(null);
  const hostFinishedRef = useRef<MatchFinishedPayload | null>(null);
  const hostCountdownTimerRef = useRef<number | null>(null);
  const hostSubmittedIdsRef = useRef<string[]>([]);
  /* Otomatik geçiş: 10 sn timer + "bu round için ilerletildi" guard'ı.
     hostAdvancedRoundRef monoton artar → çift next_round / round atlama olmaz. */
  const hostTransitionTimerRef = useRef<number | null>(null);
  const hostAdvancedRoundRef = useRef<number>(-1);

  /* Leaflet / Three refs */
  const viewerContainerRef = useRef<HTMLDivElement | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const oppMarkerRef = useRef<L.Marker | null>(null);
  const answerMarkerRef = useRef<L.Marker | null>(null);
  const answerLineRef = useRef<L.Polyline | null>(null);
  const oppLineRef = useRef<L.Polyline | null>(null);

  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const fovRef = useRef(DEFAULT_FOV);

  /* Ödül tek-sefer guard'ları */
  const xpAwardedRef = useRef(false);
  const goldAwardedRef = useRef(false);
  const resultSoundPlayedRef = useRef(false);
  const [goldAwarded, setGoldAwarded] = useState(false);
  const [xpResult, setXpResult] = useState<XpResultState | null>(null);

  /* ── Server clock sync (countdown iki client'ta aynı görünsün) ── */
  useEffect(() => {
    const handle = initServerClockSync();
    return () => handle.dispose();
  }, []);

  /* ── 360 panorama viewer (tek oyunculu ile birebir) ───────── */
  useEffect(() => {
    const container = viewerContainerRef.current;
    if (!container || !scene) return;

    setIsLoaded(false);
    setLoadError(null);

    const initialWidth = container.clientWidth || 1;
    const initialHeight = container.clientHeight || 1;

    const threeScene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(
      DEFAULT_FOV,
      initialWidth / initialHeight,
      0.1,
      1100,
    );
    camera.position.set(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(initialWidth, initialHeight, false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outputColorSpace = (THREE as any).SRGBColorSpace;
    if (outputColorSpace !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (renderer as any).outputColorSpace = outputColorSpace;
    }
    const maxAnisotropy = renderer.capabilities.getMaxAnisotropy?.() ?? 1;
    container.appendChild(renderer.domElement);

    const geometry = new THREE.SphereGeometry(SPHERE_RADIUS, 64, 32);
    const material = new THREE.MeshBasicMaterial({ side: THREE.BackSide });
    const mesh = new THREE.Mesh(geometry, material);
    threeScene.add(mesh);

    const forward = new THREE.Vector3();
    const target = new THREE.Vector3();

    yawRef.current = 0;
    pitchRef.current = 0;
    fovRef.current = DEFAULT_FOV;

    let texture: THREE.Texture | null = null;
    let disposed = false;
    let rafId = 0;

    function updateCamera() {
      yawPitchDegToDirection(yawRef.current, pitchRef.current, forward);
      target.copy(camera.position).add(forward);
      camera.lookAt(target);
      camera.fov = fovRef.current;
      camera.updateProjectionMatrix();
    }

    function renderLoop() {
      if (disposed) return;
      renderer.render(threeScene, camera);
      rafId = window.requestAnimationFrame(renderLoop);
    }

    updateCamera();
    renderLoop();

    const loader = new THREE.TextureLoader();
    loader.load(
      scene.panorama,
      (loaded) => {
        if (disposed) {
          loaded.dispose();
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const colorSpace = (THREE as any).SRGBColorSpace;
        if (colorSpace !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (loaded as any).colorSpace = colorSpace;
        }
        loaded.mapping = THREE.EquirectangularReflectionMapping;
        loaded.anisotropy = maxAnisotropy;
        loaded.minFilter = THREE.LinearMipmapLinearFilter;
        loaded.magFilter = THREE.LinearFilter;
        loaded.generateMipmaps = true;
        loaded.needsUpdate = true;
        material.map = loaded;
        material.needsUpdate = true;
        texture = loaded;
        setIsLoaded(true);
      },
      undefined,
      (err) => {
        if (disposed) return;
        const message = err instanceof Error ? err.message : "Bilinmeyen hata";
        setLoadError(message);
      },
    );

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let activePointerId: number | null = null;

    function getSensitivity() {
      return (fovRef.current * DEG2RAD) / Math.max(1, container?.clientHeight || 1);
    }

    function onPointerDown(e: PointerEvent) {
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true;
      activePointerId = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
      try {
        renderer.domElement.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }

    function onPointerMove(e: PointerEvent) {
      if (!dragging) return;
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;

      const sens = getSensitivity();
      yawRef.current = normalizeYawDeg(yawRef.current + dx * sens * RAD2DEG);
      pitchRef.current = clamp(
        pitchRef.current + dy * sens * RAD2DEG,
        MIN_PITCH_DEG,
        MAX_PITCH_DEG,
      );
      updateCamera();
    }

    function onPointerUp(e: PointerEvent) {
      if (!dragging) return;
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      dragging = false;
      activePointerId = null;
      try {
        renderer.domElement.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }

    function onPointerCancel() {
      dragging = false;
      activePointerId = null;
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const next = clamp(fovRef.current + e.deltaY * 0.05, MIN_FOV, MAX_FOV);
      fovRef.current = next;
      updateCamera();
    }

    function onResize() {
      if (!container) return;
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    const canvas = renderer.domElement;
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);
    window.addEventListener("resize", onResize);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("wheel", onWheel);

      if (texture) texture.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (canvas.parentElement === container) {
        container.removeChild(canvas);
      }
    };
  }, [scene?.panorama]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Leaflet mini map (tek oyunculu ile birebir + submit kilidi) ── */
  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el) return;

    const map = L.map(el, {
      center: MAP_DEFAULT_CENTER,
      zoom: MAP_DEFAULT_ZOOM,
      minZoom: 2,
      maxZoom: 18,
      zoomSnap: 1,
      zoomDelta: 1,
      wheelPxPerZoomLevel: 40,
      wheelDebounceTime: 10,
      zoomAnimation: true,
      fadeAnimation: true,
      markerZoomAnimation: true,
      worldCopyJump: true,
      zoomControl: true,
      attributionControl: true,
      dragging: true,
      touchZoom: true,
      scrollWheelZoom: true,
      doubleClickZoom: true,
      boxZoom: false,
      keyboard: false,
    });

    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);

    const provider = getMapTileProvider();
    L.tileLayer(provider.url, {
      attribution: provider.attribution,
      maxZoom: provider.maxZoom,
      ...(provider.subdomains ? { subdomains: provider.subdomains } : {}),
      ...(provider.tileSize ? { tileSize: provider.tileSize } : {}),
      ...(provider.zoomOffset !== undefined ? { zoomOffset: provider.zoomOffset } : {}),
    }).addTo(map);

    function placeOrMoveMarker(latlng: L.LatLng) {
      if (markerRef.current) {
        markerRef.current.setLatLng(latlng);
      } else {
        const marker = L.marker(latlng, { draggable: true }).addTo(map);
        marker.on("drag", (e) => {
          const ll = (e.target as L.Marker).getLatLng();
          setGuess({ lat: ll.lat, lng: ll.lng });
        });
        marker.on("dragend", (e) => {
          const ll = (e.target as L.Marker).getLatLng();
          setGuess({ lat: ll.lat, lng: ll.lng });
        });
        markerRef.current = marker;
      }
      setGuess({ lat: latlng.lat, lng: latlng.lng });
    }

    map.on("click", (e) => {
      // Submit sonrası / round çözüldükten sonra / maç bittiğinde pin kilitli.
      if (submittedRef.current || roundResultRef.current || finishedRef.current) return;
      placeOrMoveMarker(e.latlng);
    });

    mapRef.current = map;

    const raf = window.requestAnimationFrame(() => {
      map.invalidateSize();
    });

    const resizeObserver = new ResizeObserver(() => {
      map.invalidateSize();
    });
    resizeObserver.observe(el);

    return () => {
      window.cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      oppMarkerRef.current = null;
      answerMarkerRef.current = null;
      answerLineRef.current = null;
      oppLineRef.current = null;
    };
  }, []);

  /* Panel expand/collapse sonrası Leaflet boyutu tazele */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const t = window.setTimeout(() => {
      map.invalidateSize();
    }, 260);
    return () => window.clearTimeout(t);
  }, [mapPanelExpanded, roundResult, finished]);

  /* ── Round sonucu haritaya çiz ── */
  function drawRoundResult(payload: RoundResolvedPayload) {
    const map = mapRef.current;
    const resolvedScene = scenes[payload.roundIndex];
    if (!map || !resolvedScene) return;

    const answerLatLng = L.latLng(resolvedScene.location.lat, resolvedScene.location.lng);
    const boundsPoints: L.LatLng[] = [answerLatLng];

    // Doğru yer — amber marker (tek oyunculu ile aynı görsel dil).
    if (!answerMarkerRef.current) {
      const answerIcon = L.divIcon({
        className: "harita-answer-marker",
        html: '<span class="harita-answer-marker__dot" aria-hidden="true"></span>',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      answerMarkerRef.current = L.marker(answerLatLng, {
        icon: answerIcon,
        interactive: false,
        keyboard: false,
      }).addTo(map);
    }

    // Benim tahminim — mavi default pin (varsa payload koordinatına sabitle).
    const myResult = payload.results[myId] ?? null;
    if (myResult) {
      const myLatLng = L.latLng(myResult.lat, myResult.lng);
      if (markerRef.current) {
        markerRef.current.setLatLng(myLatLng);
        if (markerRef.current.dragging) markerRef.current.dragging.disable();
      } else {
        markerRef.current = L.marker(myLatLng, { draggable: false }).addTo(map);
      }
      boundsPoints.push(myLatLng);
      if (!answerLineRef.current) {
        answerLineRef.current = L.polyline([myLatLng, answerLatLng], {
          color: "#f59e0b",
          weight: 2,
          opacity: 0.85,
          dashArray: "6 6",
          interactive: false,
        }).addTo(map);
      }
    } else if (markerRef.current) {
      // Süre doldu, tahminim gönderilmedi — havada kalan pini kaldır.
      map.removeLayer(markerRef.current);
      markerRef.current = null;
    }

    // Rakip tahmini — mor nokta marker.
    const oppId = opponent?.playerId ?? null;
    const oppResult = oppId ? payload.results[oppId] ?? null : null;
    if (oppResult) {
      const oppLatLng = L.latLng(oppResult.lat, oppResult.lng);
      if (!oppMarkerRef.current) {
        const oppIcon = L.divIcon({
          className: "harita-opp-marker",
          html: '<span class="harita-opp-marker__dot" aria-hidden="true"></span>',
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        });
        oppMarkerRef.current = L.marker(oppLatLng, {
          icon: oppIcon,
          interactive: false,
          keyboard: false,
        }).addTo(map);
      }
      boundsPoints.push(oppLatLng);
      if (!oppLineRef.current) {
        oppLineRef.current = L.polyline([oppLatLng, answerLatLng], {
          color: "#a78bfa",
          weight: 2,
          opacity: 0.8,
          dashArray: "2 7",
          interactive: false,
        }).addTo(map);
      }
    }

    map.fitBounds(L.latLngBounds(boundsPoints), {
      padding: [40, 40],
      maxZoom: 8,
      animate: true,
    });
  }

  /* ── Yeni round için harita/round state temizliği ── */
  function resetForNextRound() {
    const map = mapRef.current;
    for (const ref of [answerLineRef, oppLineRef] as const) {
      if (ref.current && map) map.removeLayer(ref.current);
      ref.current = null;
    }
    for (const ref of [answerMarkerRef, oppMarkerRef, markerRef] as const) {
      if (ref.current && map) map.removeLayer(ref.current);
      ref.current = null;
    }
    if (map) {
      map.setView(MAP_DEFAULT_CENTER, MAP_DEFAULT_ZOOM, { animate: false });
    }
    setGuess(null);
    setSubmitted(false);
    setOpponentSubmitted(false);
    setCountdownDeadline(null);
    setTransitionDeadline(null);
    setRoundResult(null);
  }

  /* ── Realtime kanal: maç eventleri ─────────────────────────── */
  useEffect(() => {
    const initialTotals: Record<string, number> = {};
    const initialWins: Record<string, number> = {};
    matchInit.players.forEach((p) => {
      initialTotals[p.playerId] = 0;
      initialWins[p.playerId] = 0;
    });
    setTotals(initialTotals);
    if (isHost) {
      hostTotalsRef.current = { ...initialTotals };
      hostRoundWinsRef.current = { ...initialWins };
    }

    const channel = supabase.channel(`harita-duel-match-${matchInit.matchId}`, {
      config: {
        presence: { key: myId },
        // self: true → host kendi broadcast'ini de alır; host ve joiner round
        // sonuçlarını aynı handler üzerinden uygular (tek state yolu).
        broadcast: { self: true },
      },
    });
    channelRef.current = channel;

    const send = (event: string, payload: unknown) => {
      void channel.send({ type: "broadcast", event, payload });
    };

    /* ---- Host: round çözümü ---- */
    const hostResolveRound = () => {
      if (!isHost) return;
      if (hostFinishedRef.current) return;
      if (hostResolvedRef.current?.roundIndex === roundIndexRef.current) return;
      if (hostCountdownTimerRef.current !== null) {
        window.clearTimeout(hostCountdownTimerRef.current);
        hostCountdownTimerRef.current = null;
      }

      const rIdx = roundIndexRef.current;
      const resolvedScene = scenes[rIdx];
      if (!resolvedScene) return;

      const results: Record<string, PlayerRoundResult | null> = {};
      let bestScore = -1;
      let winnerId: string | null = null;
      let tie = false;

      matchInit.players.forEach((p) => {
        const g = hostGuessesRef.current.get(p.playerId);
        if (!g) {
          results[p.playerId] = null;
          return;
        }
        const distanceKm = calculateDistanceKm(g, resolvedScene.location);
        const score = calculateLocationScore(distanceKm, resolvedScene.scoreCurve);
        results[p.playerId] = { lat: g.lat, lng: g.lng, distanceKm, score };
      });

      matchInit.players.forEach((p) => {
        const score = results[p.playerId]?.score ?? 0;
        hostTotalsRef.current[p.playerId] =
          (hostTotalsRef.current[p.playerId] ?? 0) + score;
        if (score > bestScore) {
          bestScore = score;
          winnerId = p.playerId;
          tie = false;
        } else if (score === bestScore) {
          tie = true;
        }
      });
      if (tie || bestScore <= 0) winnerId = null;
      if (winnerId) {
        hostRoundWinsRef.current[winnerId] =
          (hostRoundWinsRef.current[winnerId] ?? 0) + 1;
      }

      const payload: RoundResolvedPayload = {
        roundIndex: rIdx,
        isLast: rIdx >= totalRounds - 1,
        results,
        totals: { ...hostTotalsRef.current },
        roundWins: { ...hostRoundWinsRef.current },
        roundWinnerId: winnerId,
      };
      hostResolvedRef.current = payload;
      send("round_resolved", payload);

      // Otomatik geçiş: round sonucu yayınlanır yayınlanmaz host 10 sn'lik
      // geçiş deadline'ını yayar (iki client aynı deadline'a bakar). İlk 7 sn
      // sonuç okunur, son 3 sn ortada geri sayım kartı belirir. Süre dolunca
      // host tek sefer next_round / match_finished yayınlar — buton yok.
      const transitionDeadlineMs = getSyncedNowMs() + TRANSITION_MS;
      send("transition_started", {
        roundIndex: rIdx,
        deadlineMs: transitionDeadlineMs,
        isLast: payload.isLast,
      } satisfies TransitionStartedPayload);
      if (hostTransitionTimerRef.current !== null) {
        window.clearTimeout(hostTransitionTimerRef.current);
      }
      hostTransitionTimerRef.current = window.setTimeout(() => {
        hostTransitionTimerRef.current = null;
        hostAdvance(rIdx, payload.isLast);
      }, TRANSITION_MS);
    };

    /* ---- Host: otomatik ilerleme (sıradaki round / maç finali) ---- */
    const hostAdvance = (resolvedRoundIndex: number, isLast: boolean) => {
      if (!isHost) return;
      if (hostFinishedRef.current) return;
      // Monoton guard: bu round (veya öncesi) için zaten ilerletildiyse çık.
      if (hostAdvancedRoundRef.current >= resolvedRoundIndex) return;
      hostAdvancedRoundRef.current = resolvedRoundIndex;

      if (isLast) {
        let winnerId: string | null = null;
        let best = -1;
        let tie = false;
        matchInit.players.forEach((p) => {
          const t = hostTotalsRef.current[p.playerId] ?? 0;
          if (t > best) {
            best = t;
            winnerId = p.playerId;
            tie = false;
          } else if (t === best) {
            tie = true;
          }
        });
        if (tie) winnerId = null;
        const payload: MatchFinishedPayload = {
          totals: { ...hostTotalsRef.current },
          roundWins: { ...hostRoundWinsRef.current },
          winnerId,
          roundsPlayed: totalRounds,
        };
        hostFinishedRef.current = payload;
        send("match_finished", payload);
      } else {
        send("next_round", {
          roundIndex: resolvedRoundIndex + 1,
        } satisfies NextRoundPayload);
      }
    };

    /* ---- Handler'lar ---- */
    channel.on("broadcast", { event: "guess_submitted" }, ({ payload }) => {
      const p = payload as GuessSubmittedPayload | undefined;
      if (!p || typeof p.lat !== "number" || typeof p.lng !== "number") return;
      if (p.roundIndex !== roundIndexRef.current) return;
      if (roundResultRef.current || finishedRef.current) return;

      if (p.playerId !== myId) setOpponentSubmitted(true);

      if (!isHost) return;
      /* Host defteri: oyuncu başına round'da tek tahmin. */
      if (hostGuessesRef.current.has(p.playerId)) return;
      if (!matchInit.players.some((mp) => mp.playerId === p.playerId)) return;
      hostGuessesRef.current.set(p.playerId, { lat: p.lat, lng: p.lng });
      hostSubmittedIdsRef.current = [...hostGuessesRef.current.keys()];

      if (hostGuessesRef.current.size >= matchInit.players.length) {
        hostResolveRound();
        return;
      }
      if (hostGuessesRef.current.size === 1) {
        const deadlineMs = getSyncedNowMs() + COUNTDOWN_MS;
        send("countdown_started", {
          roundIndex: roundIndexRef.current,
          deadlineMs,
        } satisfies CountdownStartedPayload);
        hostCountdownTimerRef.current = window.setTimeout(() => {
          hostCountdownTimerRef.current = null;
          hostResolveRound();
        }, COUNTDOWN_MS);
      }
    });

    channel.on("broadcast", { event: "countdown_started" }, ({ payload }) => {
      const p = payload as CountdownStartedPayload | undefined;
      if (!p || typeof p.deadlineMs !== "number") return;
      if (p.roundIndex !== roundIndexRef.current) return;
      if (roundResultRef.current || finishedRef.current) return;
      setCountdownDeadline(p.deadlineMs);
    });

    channel.on("broadcast", { event: "round_resolved" }, ({ payload }) => {
      const p = payload as RoundResolvedPayload | undefined;
      if (!p || typeof p.roundIndex !== "number" || !p.results) return;
      if (finishedRef.current) return;
      if (p.roundIndex !== roundIndexRef.current) return;
      setCountdownDeadline(null);
      setRoundResult(p);
      setTotals(p.totals);
      drawRoundResult(p);
    });

    channel.on("broadcast", { event: "transition_started" }, ({ payload }) => {
      const p = payload as TransitionStartedPayload | undefined;
      if (!p || typeof p.deadlineMs !== "number") return;
      if (p.roundIndex !== roundIndexRef.current) return;
      if (finishedRef.current) return;
      setTransitionDeadline(p.deadlineMs);
    });

    channel.on("broadcast", { event: "next_round" }, ({ payload }) => {
      const p = payload as NextRoundPayload | undefined;
      if (!p || typeof p.roundIndex !== "number") return;
      if (finishedRef.current) return;
      if (p.roundIndex <= roundIndexRef.current) return;
      if (isHost) {
        hostGuessesRef.current.clear();
        hostSubmittedIdsRef.current = [];
        hostResolvedRef.current = null;
      }
      resetForNextRound();
      setRoundIndex(p.roundIndex);
    });

    channel.on("broadcast", { event: "match_finished" }, ({ payload }) => {
      const p = payload as MatchFinishedPayload | undefined;
      if (!p || !p.totals) return;
      if (finishedRef.current) return;
      setCountdownDeadline(null);
      setTransitionDeadline(null);
      setTotals(p.totals);
      setFinished(p);
    });

    /* Joiner geç mount / kısa kopukluk: host'tan güncel round snapshot'ı al. */
    channel.on("broadcast", { event: "request_state" }, ({ payload }) => {
      if (!isHost) return;
      const from = (payload as { from?: string } | undefined)?.from;
      if (!from || from === myId) return;
      const snapshot: StateSnapshotPayload = {
        roundIndex: roundIndexRef.current,
        countdownDeadlineMs:
          hostCountdownTimerRef.current !== null
            ? countdownDeadlineRef.current
            : null,
        transitionDeadlineMs:
          hostTransitionTimerRef.current !== null
            ? transitionDeadlineRef.current
            : null,
        submittedIds: hostSubmittedIdsRef.current,
        resolved:
          hostResolvedRef.current?.roundIndex === roundIndexRef.current
            ? hostResolvedRef.current
            : null,
        finished: hostFinishedRef.current,
        totals: { ...hostTotalsRef.current },
        roundWins: { ...hostRoundWinsRef.current },
      };
      send("state_snapshot", snapshot);
    });

    channel.on("broadcast", { event: "state_snapshot" }, ({ payload }) => {
      if (isHost) return;
      const p = payload as StateSnapshotPayload | undefined;
      if (!p || typeof p.roundIndex !== "number") return;
      if (p.finished) {
        setTotals(p.finished.totals);
        setFinished(p.finished);
        return;
      }
      if (p.roundIndex > roundIndexRef.current) {
        resetForNextRound();
        setRoundIndex(p.roundIndex);
      }
      setTotals(p.totals);
      if (p.submittedIds.includes(myId)) setSubmitted(true);
      if (p.submittedIds.some((id) => id !== myId)) setOpponentSubmitted(true);
      if (p.resolved) {
        setCountdownDeadline(null);
        setRoundResult(p.resolved);
        setTotals(p.resolved.totals);
        drawRoundResult(p.resolved);
        // Geçiş sayacı süren bir round'a sonradan bağlanan client de aynı
        // otomatik geçişi görsün.
        if (
          typeof p.transitionDeadlineMs === "number" &&
          p.transitionDeadlineMs > getSyncedNowMs()
        ) {
          setTransitionDeadline(p.transitionDeadlineMs);
        }
      } else if (
        typeof p.countdownDeadlineMs === "number" &&
        p.countdownDeadlineMs > getSyncedNowMs()
      ) {
        setCountdownDeadline(p.countdownDeadlineMs);
      }
    });

    /* Rakip kanaldan düştü mü? (MVP: banner; otomatik hükmen yok) */
    let sawOpponent = false;
    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState();
      const ids = Object.keys(state);
      const oppHere = ids.some((id) => id !== myId);
      if (oppHere) {
        sawOpponent = true;
        setOpponentLeft(false);
      } else if (sawOpponent && !finishedRef.current) {
        setOpponentLeft(true);
      }
    });

    channel.subscribe(async (status) => {
      if (status !== "SUBSCRIBED") return;
      await channel.track({ playerId: myId, name: myName });
      if (!isHost) {
        send("request_state", { from: myId });
      }
    });

    return () => {
      if (hostCountdownTimerRef.current !== null) {
        window.clearTimeout(hostCountdownTimerRef.current);
        hostCountdownTimerRef.current = null;
      }
      if (hostTransitionTimerRef.current !== null) {
        window.clearTimeout(hostTransitionTimerRef.current);
        hostTransitionTimerRef.current = null;
      }
      void supabase.removeChannel(channel);
      channelRef.current = null;
    };
    // Kanal maç başına bir kez kurulur; handler'lar güncel state'i ref'lerden okur.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchInit.matchId]);

  /* ── Countdown UI tick (round içi 15 sn + tur arası 5 sn geçiş) ── */
  const [, setCountdownTick] = useState(0);
  useEffect(() => {
    if (countdownDeadline === null && transitionDeadline === null) return;
    const id = window.setInterval(() => setCountdownTick((t) => t + 1), 200);
    return () => window.clearInterval(id);
  }, [countdownDeadline, transitionDeadline]);

  /* ── Countdown sesi ──
     Yalnız HENÜZ tahmin yapmamış oyuncuda, countdown aktifken çalar.
     - countdown başladığı an çalar (rakip ilk tahmini gönderince).
     - ben submit edersem / round çözülürse / sıradaki round / maç biterse:
       effect yeniden çalışır, koşul düşer ve ses durup başa sarılır.
     - unmount'ta (lobiye dönüş dahil) cleanup ses durdurur.
     countdown20 tek cache instance kullandığı için ses üst üste binmez. */
  useEffect(() => {
    const countdownAudible =
      countdownDeadline !== null && !submitted && !roundResult && !finished;
    if (countdownAudible) {
      playSound("countdown20", { restart: true });
    } else {
      stopSound("countdown20");
    }
    return () => stopSound("countdown20");
  }, [countdownDeadline, submitted, roundResult, finished]);

  const countdownSeconds =
    countdownDeadline !== null && !roundResult && !finished
      ? Math.max(0, Math.ceil((countdownDeadline - getSyncedNowMs()) / 1000))
      : null;

  /* Tur arası otomatik geçiş — toplam 10 sn, iki fazlı:
       • Faz 1 (ilk 7 sn): sadece sonuç paneli okunur, ortada kart yok.
       • Faz 2 (son 3 sn): ortada büyük geçiş kartı belirir, 3→2→1 sayar.
     İki client de aynı deadline'a baktığı için overlay aynı anda açılır. */
  const transitionActive = transitionDeadline !== null && !finished;
  const transitionRemainingMs = transitionActive
    ? Math.max(0, transitionDeadline! - getSyncedNowMs())
    : null;
  /* Overlay (büyük kart) yalnız son TRANSITION_OVERLAY_MS'de görünür. */
  const transitionOverlayActive =
    transitionRemainingMs !== null && transitionRemainingMs <= TRANSITION_OVERLAY_MS;
  const transitionOverlaySeconds = transitionOverlayActive
    ? Math.min(
        TRANSITION_OVERLAY_MS / 1000,
        Math.max(1, Math.ceil(transitionRemainingMs! / 1000)),
      )
    : null;
  const transitionIsLast = roundResult?.isLast ?? false;

  /* ── Aksiyonlar ── */
  const handleSubmitGuess = () => {
    if (!guess || submitted || roundResult || finished) return;
    const ch = channelRef.current;
    if (!ch) return;
    setSubmitted(true);
    // Tahmin gerçekten gönderildi (sadece pin bırakınca değil) — kendi
    // aksiyonumda onay sesi. Round'da tek submit olduğu için tek kez çalar;
    // rakibin tahmini bana broadcast olarak gelir, orada ses çalınmaz.
    playSound("correct");
    if (markerRef.current?.dragging) {
      markerRef.current.dragging.disable();
    }
    void ch.send({
      type: "broadcast",
      event: "guess_submitted",
      payload: {
        playerId: myId,
        roundIndex,
        lat: guess.lat,
        lng: guess.lng,
      } satisfies GuessSubmittedPayload,
    });
  };

  /* Round sonucundan sıradaki round/final'e geçiş artık otomatik (host'ta
     hostResolveRound → transition timer → hostAdvance). Manuel buton yok. */

  /* ── Maç sonu: ses ── */
  useEffect(() => {
    if (!finished || resultSoundPlayedRef.current) return;
    resultSoundPlayedRef.current = true;
    if (finished.winnerId === myId) {
      playSound("win", { restart: true });
    } else if (finished.winnerId !== null) {
      playSound("lose", { restart: true });
    }
    // Beraberlikte ses yok (diğer 1v1 modlarla aynı davranış).
  }, [finished, myId]);

  /* ── Maç sonu: Gold (sadece kazanan, sadece bir kez) ── */
  useEffect(() => {
    if (!finished) return;
    if (finished.winnerId !== myId) return;
    if (goldAwardedRef.current) return;
    const guardKey = `harita_duel_gold_${matchInit.matchId}`;
    try {
      if (localStorage.getItem(guardKey)) return;
    } catch {
      /* ignore */
    }
    goldAwardedRef.current = true;
    try {
      localStorage.setItem(guardKey, "1");
    } catch {
      /* ignore */
    }
    // Server-otoriteli RPC (award_gameplay_gold) — reason whitelist'te,
    // misafirlerde gold.ts local fallback'i devreye girer.
    addGold(WINNER_GOLD, "map_match_reward", {
      mode: "harita_duel_1v1",
      match_id: matchInit.matchId,
    });
    setGoldAwarded(true);
  }, [finished, myId, matchInit.matchId]);

  /* ── Maç sonu: XP (her iki oyuncu, idempotent RPC) ── */
  useEffect(() => {
    if (!finished) return;
    if (xpAwardedRef.current) return;
    if (!profile?.id) return;
    xpAwardedRef.current = true;

    const result: MatchResult =
      finished.winnerId === myId
        ? "win"
        : finished.winnerId === null
          ? "draw"
          : "loss";
    const breakdown = calculateHaritaDuelXp({
      roundsWon: finished.roundWins[myId] ?? 0,
      result,
    });
    breakdown.bonusLabelText = undefined;

    // Achievement stats: online win streak + daily streak / distinct-mode count.
    // Logged-in-only, once-guarded above → exactly once per match.
    recordOnlineMatchResult(result);
    recordGameComplete({ modeFamily: "blindspot" });

    const profileId = profile.id;
    (async () => {
      const res = await awardXpEvent({
        profileId,
        modeKey: "harita_duel",
        roomId: matchInit.matchId,
        xpEarned: breakdown.total,
        result,
        details: {
          my_total: finished.totals[myId] ?? 0,
          rounds_won: finished.roundWins[myId] ?? 0,
          rounds_played: finished.roundsPlayed,
          breakdown,
        },
      });
      if (res.error) {
        // Migration uygulanmadıysa RPC bulunamaz — oyun akışını bozma.
        console.error("[HaritaDuelMatch] XP yazılamadı:", res.error);
        return;
      }
      const prevModeXp = res.awarded ? Math.max(0, res.modeXp - res.xpEarned) : res.modeXp;
      const prevTotalXp = res.awarded ? Math.max(0, res.totalXp - res.xpEarned) : res.totalXp;
      setXpResult({
        awarded: res.awarded,
        xpEarned: res.xpEarned,
        prevTotalXp,
        totalXp: res.totalXp,
        prevModeXp,
        modeXp: res.modeXp,
        breakdown,
        dismissed: false,
      });
    })();
  }, [finished, myId, profile?.id, matchInit.matchId]);

  /* ── Render yardımcıları ── */
  const myTotal = totals[myId] ?? 0;
  const oppTotal = opponent ? totals[opponent.playerId] ?? 0 : 0;
  const oppName = opponent?.name ?? "Rakip";

  const myRoundResult = roundResult ? roundResult.results[myId] ?? null : null;
  const oppRoundResult =
    roundResult && opponent ? roundResult.results[opponent.playerId] ?? null : null;

  const roundWinnerLabel = roundResult
    ? roundResult.roundWinnerId === null
      ? "Berabere"
      : roundResult.roundWinnerId === myId
        ? "Sen kazandın!"
        : `${oppName} kazandı`
    : "";

  const finalWinnerLabel = finished
    ? finished.winnerId === null
      ? "🤝 Beraberlik"
      : finished.winnerId === myId
        ? "🏆 Kazandın!"
        : `🏆 ${oppName} kazandı`
    : "";

  // Sadece click + wheel durdurulur; pointer/touch move Leaflet'in document
  // listener'larına ulaşmalı (tek oyunculu moddaki mobil pan/pinch fix'i).
  const stopBubble = useMemo(
    () => ({
      onWheel: (e: React.WheelEvent) => e.stopPropagation(),
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
    }),
    [],
  );

  /* ── Sahne listesi çözülemedi (sürüm uyuşmazlığı vs.) — güvenli çıkış ── */
  if (!scene) {
    return (
      <div className="cag-screen">
        <div className="cag-loading-overlay cag-loading-overlay--error">
          <strong>Maç başlatılamadı</strong>
          <div className="cag-loading-text">
            Sahne listesi yüklenemedi. Lobiye dönüp tekrar deneyin.
          </div>
          <button
            type="button"
            className="harita-map-panel__submit"
            onClick={onExitToLobby}
            style={{ marginTop: 12, minWidth: 160 }}
          >
            ← Lobiye Dön
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="cag-screen">
      <div ref={viewerContainerRef} className="cag-viewer" />

      {!isLoaded && !loadError && (
        <div className="cag-loading-overlay">
          <div className="cag-loading-spinner" />
          <div className="cag-loading-text">Sahne yükleniyor...</div>
        </div>
      )}

      {loadError && (
        <div className="cag-loading-overlay cag-loading-overlay--error">
          <strong>Sahne yüklenemedi</strong>
          <div className="cag-loading-text">{loadError}</div>
        </div>
      )}

      <div className="cag-overlay cag-overlay--top-left">
        <button
          className="cag-back"
          onClick={onExitToLobby}
          aria-label="Lobiye dön"
        >
          <span aria-hidden="true">←</span>
          <span className="cag-back-label">Lobi</span>
        </button>
        <span className="cag-brand" aria-hidden="true">Harita Dedektifi 1v1</span>
      </div>

      {/* Üstte yalnızca yıl — eventLabel gösterilmez (spoiler). */}
      <div className="cag-overlay cag-overlay--top-center">
        <div className="cag-info-chip">
          <span className="cag-info-year">{scene.yearLabel}</span>
        </div>
      </div>

      {/* Round sayacı + skorlar + countdown */}
      <div className="cag-overlay cag-overlay--top-right">
        <div className="cag-chip" title="Round">
          <span className="cag-chip-icon" aria-hidden="true">🎯</span>
          <span className="cag-chip-value">
            {Math.min(roundIndex + 1, totalRounds)} / {totalRounds}
          </span>
        </div>
        <div className="cag-chip harita-duel-chip--me" title={myName}>
          <span className="cag-chip-value">
            Sen {myTotal.toLocaleString("tr-TR")}
          </span>
        </div>
        <div className="cag-chip harita-duel-chip--opp" title={oppName}>
          <span className="cag-chip-value">
            {oppName} {oppTotal.toLocaleString("tr-TR")}
          </span>
        </div>
        {countdownSeconds !== null && (
          <div
            className="cag-chip harita-duel-countdown"
            role="timer"
            aria-label={`Kalan süre ${countdownSeconds} saniye`}
          >
            <span className="cag-chip-icon" aria-hidden="true">⏱</span>
            <span className="cag-chip-value">{countdownSeconds}s</span>
          </div>
        )}
      </div>

      {/* Rakip ayrıldı banner'ı (MVP: bilgi + çıkış; otomatik hükmen yok) */}
      {opponentLeft && !finished && (
        <div className="harita-duel-leftbanner" role="alert">
          <span>⚠️ Rakibin bağlantısı koptu.</span>
          <button
            type="button"
            className="harita-duel-leftbanner__btn"
            onClick={onExitToLobby}
          >
            ← Lobiye Dön
          </button>
        </div>
      )}

      <div
        className={`harita-map-panel${
          mapPanelExpanded || roundResult ? " is-expanded" : ""
        }${roundResult ? " has-result" : ""}${
          finished ? " harita-map-panel--hidden" : ""
        }${transitionOverlayActive ? " harita-map-panel--lift" : ""}`}
        onMouseEnter={() => setMapPanelExpanded(true)}
        onMouseLeave={() => setMapPanelExpanded(false)}
        {...stopBubble}
      >
        <div ref={mapContainerRef} className="harita-map-panel__map" />

        {roundResult ? (
          /* ── Round sonucu ── */
          <div className="harita-result" role="status" aria-live="polite">
            <div className="harita-result__head">
              <span className="harita-result__eyebrow">{scene.eventLabel}</span>
              <h2 className="harita-result__place">{scene.location.placeLabel}</h2>
            </div>

            <div className="harita-duel-rows">
              <div
                className={
                  "harita-duel-row" +
                  (roundResult.roundWinnerId === myId ? " is-winner" : "")
                }
              >
                <span className="harita-duel-row__name">Sen</span>
                <span className="harita-duel-row__dist">
                  {myRoundResult ? formatDistance(myRoundResult.distanceKm) : "—"}
                </span>
                <span className="harita-duel-row__score">
                  {(myRoundResult?.score ?? 0).toLocaleString("tr-TR")}
                </span>
              </div>
              <div
                className={
                  "harita-duel-row harita-duel-row--opp" +
                  (opponent && roundResult.roundWinnerId === opponent.playerId
                    ? " is-winner"
                    : "")
                }
              >
                <span className="harita-duel-row__name">{oppName}</span>
                <span className="harita-duel-row__dist">
                  {oppRoundResult ? formatDistance(oppRoundResult.distanceKm) : "—"}
                </span>
                <span className="harita-duel-row__score">
                  {(oppRoundResult?.score ?? 0).toLocaleString("tr-TR")}
                </span>
              </div>
            </div>

            <p className="harita-duel-roundwinner">{roundWinnerLabel}</p>

            <p className="harita-result__explanation">{scene.explanation}</p>
            {/* Geçiş otomatik: buton yok. Sıradaki round/final ortadaki
                geçiş kartındaki sayaç sıfırlanınca host tarafından yayınlanır. */}
          </div>
        ) : (
          /* ── Tahmin aşaması ── */
          <>
            {guess && !submitted && (
              <div className="harita-map-panel__debug">
                {guess.lat.toFixed(3)}, {guess.lng.toFixed(3)}
              </div>
            )}
            {submitted ? (
              <p className="harita-duel-waitnote">
                ✓ Tahminin kilitlendi — {oppName} bekleniyor...
              </p>
            ) : opponentSubmitted ? (
              <p className="harita-duel-waitnote harita-duel-waitnote--urgent">
                {oppName} tahminini gönderdi
                {countdownSeconds !== null ? ` — ${countdownSeconds} saniyen var!` : "!"}
              </p>
            ) : null}
            {!submitted && (
              <button
                type="button"
                className="harita-map-panel__submit"
                onClick={handleSubmitGuess}
                disabled={!guess}
              >
                Tahmini Gönder
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Tur arası otomatik geçiş kartı (yalnız son 3 sn) ──
          İlk 7 sn boyunca bu overlay hiç render edilmez; sonuç paneli rahatça
          okunur. Son 3 sn'de kart belirir, yan panel öne alınır (--lift) ve
          panorama arkada hafif blur+karartma alır. Backdrop tıklaması iş yapmaz. */}
      {transitionOverlayActive && transitionOverlaySeconds !== null && (
        <div className="harita-transition-overlay" role="status" aria-live="polite">
          <div className="harita-transition-overlay__backdrop" aria-hidden="true" />
          <div className="harita-transition-card">
            <span className="harita-transition-card__label">
              {transitionIsLast
                ? "Maç sonucu hazırlanıyor"
                : "Yeni tura geçiliyor"}
            </span>
            <span
              key={transitionOverlaySeconds}
              className="harita-transition-card__count"
            >
              {transitionOverlaySeconds}
            </span>
          </div>
        </div>
      )}

      {/* ── Maç sonu modalı ──
          Panorama arkada blur+karartma overlay ile kalır; panel ortalanır.
          Backdrop'a tıklamak maçı kapatmaz — çıkış yalnız butonla. */}
      {finished && (
        <div
          className="harita-final-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="harita-final-title"
        >
          <div className="harita-final-overlay__backdrop" aria-hidden="true" />
          <div className="harita-final-modal" role="status" aria-live="polite">
            <span className="harita-final-modal__eyebrow">Maç Bitti</span>
            <h2 id="harita-final-title" className="harita-final-modal__title">
              {finalWinnerLabel}
            </h2>

            <div className="harita-final-modal__rows">
              <div
                className={
                  "harita-final-modal__row" +
                  (finished.winnerId === myId ? " is-winner" : "")
                }
              >
                <span className="harita-final-modal__row-name">Sen</span>
                <span className="harita-final-modal__row-score">
                  {(finished.totals[myId] ?? 0).toLocaleString("tr-TR")}
                </span>
              </div>
              <div
                className={
                  "harita-final-modal__row" +
                  (opponent && finished.winnerId === opponent.playerId
                    ? " is-winner"
                    : "")
                }
              >
                <span className="harita-final-modal__row-name">{oppName}</span>
                <span className="harita-final-modal__row-score">
                  {(opponent
                    ? finished.totals[opponent.playerId] ?? 0
                    : 0
                  ).toLocaleString("tr-TR")}
                </span>
              </div>
            </div>

            <div className="harita-final-modal__meta">
              <span>Oynanan Tur</span>
              <span className="harita-final-modal__meta-value">
                {finished.roundsPlayed}
              </span>
            </div>

            {goldAwarded && (
              <p className="harita-final-modal__gold" role="status">
                <GoldIcon /> +{WINNER_GOLD} Gold
              </p>
            )}

            <button
              type="button"
              className="harita-final-modal__exit"
              onClick={onExitToLobby}
            >
              ← Lobiye Dön
            </button>
          </div>
        </div>
      )}

      {/* XP barı — final ekranında, kapatılana dek */}
      {finished && xpResult && !xpResult.dismissed && (
        <XpGainBar
          key={matchInit.matchId}
          modeLabel="Harita Dedektifi"
          prevTotalXp={xpResult.prevTotalXp}
          newTotalXp={xpResult.totalXp}
          prevModeXp={xpResult.prevModeXp}
          newModeXp={xpResult.modeXp}
          xpEarned={xpResult.xpEarned}
          awarded={xpResult.awarded}
          breakdown={xpResult.breakdown}
          onDismiss={() =>
            setXpResult((r) => (r ? { ...r, dismissed: true } : r))
          }
        />
      )}
    </div>
  );
}
