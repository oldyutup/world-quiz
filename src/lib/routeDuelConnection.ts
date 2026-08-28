/**
 * routeDuelConnection.ts — Rota Duel rakip-bağlantı göstergesi SAF mantığı.
 *
 * Neden ayrı modül: RouteDuelGame'deki heartbeat/monitor effect'leri ağ+React
 * bağımlı; buradaki fonksiyonlar yan etkisiz ve scripts/check-route-duel-
 * connection.ts tarafından DB'siz test edilir.
 *
 * SÖZLEŞME (20260802120000_route_duel_init.sql ile hizalı; otorite SUNUCU):
 *   • Heartbeat 3 sn'de bir route_duel_heartbeat ile last_seen_at = now()
 *     yazar (sunucu saati; client saati asla yazılmaz). BAĞLANTI SAĞLIĞI
 *     GAMEPLAY'DEN AYRIDIR: hiç ülke göndermeyen ama açık/bağlı oyuncunun
 *     damgası da her beat'te tazelenir → boşta durmak ASLA kopuş sayılmaz.
 *     (Build 9 hatası: beat `void supabase.rpc(...)` ile yazılmıştı ve hiç
 *     gönderilmiyordu; geriye tek sinyal olarak submit_move kalıyordu.)
 *   • Sunucu kopuş kararı İKİ KANITLIDIR (20260827120000): rakibin
 *     last_seen_at'i ≥ 20 sn bayat OLACAK **ve** bu bayatlık ≥ 10 sn
 *     KESİNTİSİZ gözlenmiş olacak. Rakipten gelen tek bir heartbeat pencereyi
 *     siler → grace içinde reconnect maçı kaybettirmez. Client yalnız
 *     "kontrol et" der; erken çağrı sunucuda sessiz no-op.
 *   • Gösterge DÖRT durumlu: unknown ("Bağlanıyor…", nötr) → connected
 *     ("Bağlı", yeşil) → reconnecting ("Bağlantı zayıf…", amber, yaş ≥ 12 sn
 *     = 4 kaçırılmış heartbeat) → disconnected ("Bağlantı koptu", kırmızı).
 *   • KIRMIZI YALNIZ SUNUCU ONAYIYLA: last_seen_at yaşı tek başına ASLA
 *     "disconnected" üretmez (Safari/background throttling 12-20 sn arasını
 *     sahte kırmızıya düşürüyordu). Onay = oda satırı status='finished' +
 *     finished_reason='disconnect' (realtime UPDATE ya da handle_disconnect
 *     RPC dönüşü). 20 sn aşımı yalnız sunucu KONTROLÜNÜ tetikler.
 *   • Yeni heartbeat gelince yaş küçülür → reconnecting kendiliğinden
 *     connected'a döner; sunucu onayı yokken kırmızıya kilitlenme imkânsız.
 *   • Hiç veri yokken durum "unknown"dur ("Bağlanıyor…") — kırmızı DEĞİL.
 *
 * Saat güveni: yaş hesabı getSyncedNowMs (sunucu-senkron saat) + KENDİ
 * last_seen_at çıpasıyla tavanlanır. Kendi satırım sunucuda now() ile
 * yazıldığı ve en fazla ~1 heartbeat periyodu eski olduğu için
 * "my + periyot" sunucu-şimdisinin üst sınırıdır; lokal saat ileri kaysa
 * bile rakip yaşı şişip sahte kırmızı üretemez.
 */

/** Heartbeat gönderim periyodu (ms) — DuelGame deseniyle aynı. */
export const ROUTE_DUEL_HEARTBEAT_MS = 3000;

/** Rakip last_seen_at poll periyodu (ms). */
export const ROUTE_DUEL_OPP_POLL_MS = 3000;

/** UI "Bağlantı zayıf…" (reconnecting) eşiği (sn) — 4 kaçırılmış heartbeat.
 *  KIRMIZI eşiği DEĞİL: kırmızı yalnız sunucu onayıyla gösterilir. */
export const ROUTE_DUEL_OPP_STALE_UI_SECONDS = 12;

/** Client'ın sunucudan kopuş KONTROLÜ istediği eşik (sn) — kararı sunucu
 *  verir (RPC içindeki 20 sn guard ile birebir aynı değer). */
export const ROUTE_DUEL_DISCONNECT_REQUEST_SECONDS = 20;

/** Sunucunun kopuşu KESİNLEŞTİRMEK için istediği KESİNTİSİZ gözlem penceresi
 *  (sn) — 20260827120000'deki `c_confirm` ile birebir. Yalnız belgeleme/UI
 *  metni için; kararı hâlâ SUNUCU verir. Tek bir handle_disconnect çağrısı
 *  ARTIK MAÇ BİTİREMEZ: pencereyi açar, rakipten gelen ilk heartbeat kapatır.
 *  → 20 sn bayatlık + 10 sn kesintisiz sessizlik = ~30 sn gerçek yokluk. */
export const ROUTE_DUEL_DISCONNECT_CONFIRM_SECONDS = 10;

/** Rakip bağlantı göstergesinin dört durumu:
 *  unknown = veri yok (nötr) · connected = yaş < 12 sn (yeşil) ·
 *  reconnecting = yaş ≥ 12 sn ama sunucu onaylamadı (amber) ·
 *  disconnected = SUNUCU kopuşu kesinleştirdi (kırmızı). */
export type RouteDuelOppConnectionView = "unknown" | "connected" | "reconnecting" | "disconnected";

/**
 * PostgREST timestamptz → epoch ms; parse edilemezse null (ASLA NaN sızmaz —
 * NaN karşılaştırmaları sessizce false verip göstergeyi kalıcı kırmızıya ve
 * disconnect isteğini kalıcı kapalıya kilitlerdi).
 */
export function parseServerTimestampMs(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return direct;
  // Katı parser'lar (ör. eski Safari) için: 'YYYY-MM-DD hh:mm:ss.ssssss+00:00'
  // → boşluğu T yap, saniye kesrini 3 haneye indir.
  const normalized = raw.trim().replace(" ", "T").replace(/(\.\d{1,3})\d*/, "$1");
  const retry = Date.parse(normalized);
  return Number.isFinite(retry) ? retry : null;
}

/**
 * Rakibin son sunucu-heartbeat yaşı (sn). null = bilinmiyor (veri yok /
 * parse edilemedi) — çağıran "unknown" gösterir, kırmızı GÖSTERMEZ.
 *
 * Yaş = min(senkron-saat yaşı, kendi-last_seen çıpalı yaş):
 *   • syncedAge  = (syncedNow − oppSeen)          — normal yol.
 *   • anchoredAge= (mySeen + periyot − oppSeen)   — her iki damga da sunucu
 *     now()'u olduğundan lokal saatten bağımsız üst sınır. Lokal saat ileri
 *     kaymışsa syncedAge şişer; çıpa tavanlar → sahte kırmızı yok.
 * Kendi beat'lerim durmuşsa çıpa yaşlanmayı dondurur (rakibi suçlamayız);
 * gerçek kopuşta kendi beat'lerim sürer, çıpa gerçek yaşla birlikte büyür.
 */
export function computeOppStaleSeconds(input: {
  oppLastSeenMs: number | null;
  myLastSeenMs:  number | null;
  syncedNowMs:   number;
}): number | null {
  const { oppLastSeenMs, myLastSeenMs, syncedNowMs } = input;
  if (oppLastSeenMs === null || !Number.isFinite(oppLastSeenMs)) return null;
  if (!Number.isFinite(syncedNowMs)) return null;

  const syncedAgeS = (syncedNowMs - oppLastSeenMs) / 1000;
  if (myLastSeenMs !== null && Number.isFinite(myLastSeenMs)) {
    const anchoredAgeS = (myLastSeenMs + ROUTE_DUEL_HEARTBEAT_MS - oppLastSeenMs) / 1000;
    return Math.max(0, Math.min(syncedAgeS, anchoredAgeS));
  }
  return Math.max(0, syncedAgeS);
}

/**
 * Sunucu kopuşu kesinleştirdi mi? Tek güvenilir kanıt oda satırıdır:
 * status='finished' + finished_reason='disconnect' (handle_disconnect RPC'si
 * ya da realtime room UPDATE ile gelir). last_seen_at yaşı ne kadar büyürse
 * büyüsün bu onay olmadan "disconnected" gösterilmez.
 */
export function isServerConfirmedDisconnect(
  room: { status?: string | null; finished_reason?: string | null } | null | undefined,
): boolean {
  return !!room && room.status === "finished" && room.finished_reason === "disconnect";
}

/**
 * Yaş + sunucu onayı → gösterge durumu.
 *   • Sunucu onayı her şeyi ezer → "disconnected" (kırmızı).
 *   • Onay yokken yaş ≥ 12 sn EN FAZLA "reconnecting" (amber) üretir —
 *     20 sn aşılsa bile sunucu kesinleştirmeden kırmızı YOK.
 *   • Yeni heartbeat gelince yaş küçülür ve reconnecting otomatik
 *     "connected"a döner (kalıcı kilitlenme yok).
 */
export function deriveOppConnectionView(
  staleSeconds: number | null,
  serverConfirmedDisconnect = false,
): RouteDuelOppConnectionView {
  if (serverConfirmedDisconnect) return "disconnected";
  if (staleSeconds === null || !Number.isFinite(staleSeconds)) return "unknown";
  return staleSeconds >= ROUTE_DUEL_OPP_STALE_UI_SECONDS ? "reconnecting" : "connected";
}

/**
 * Sunucudan kopuş kontrolü istensin mi? (Karar yine sunucuda — erken çağrı
 * no-op.) unknown/NaN'da ASLA istenmez.
 *
 * `myHeartbeatHealthy` — KENDİ heartbeat'imin sunucuya ULAŞTIĞININ kanıtı
 * (son route_duel_heartbeat çağrısı hatasız döndü mü). Kanıt yoksa rakibi
 * suçlamayız: build 9'da heartbeat RPC'si `void supabase.rpc(...)` ile
 * yazıldığı için HİÇ GÖNDERİLMİYORDU (PostgrestBuilder fetch'i yalnız
 * `then()` çağrılınca başlatır) ve last_seen_at'i tazeleyen tek yol hamle
 * göndermekti — boşta duran ama bağlı olan oyuncu kopuk sanılıp maçı
 * kaybediyordu. Bu bayrak aynı sınıftan sessiz bir arıza (yetki hatası, ağ
 * kesintisi) tekrar ederse kopuş İDDİASINI da susturur.
 */
export function shouldRequestDisconnect(
  staleSeconds: number | null,
  myHeartbeatHealthy = true,
): boolean {
  if (!myHeartbeatHealthy) return false;
  if (staleSeconds === null || !Number.isFinite(staleSeconds)) return false;
  return staleSeconds >= ROUTE_DUEL_DISCONNECT_REQUEST_SECONDS;
}

/**
 * Heartbeat'in AKTİF olduğu fazlar: oda üyeliği süresince kesintisiz —
 * lobby → playing geçişinde, tur-sonu banner'ında ve sonuç ekranında
 * (rövanş bekleyişi) beat sürer. setup/searching'de oyuncu satırı yok.
 */
export function isRouteDuelPresencePhase(phase: string): boolean {
  return phase === "lobby" || phase === "playing" || phase === "finished";
}

/* ── Görünürlük/odak/ağ dönüşünde ANINDA beat (interval'i beklemeden) ── */

interface WakeupListenerTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * visibilitychange(→visible) / focus / online olaylarında beat'i hemen
 * tetikler. Dönen cleanup TÜM listener'ları söker — effect cleanup'ında
 * çağrılmazsa duplicate beat kaynağı olur (test: check-route-duel-connection).
 */
export function attachHeartbeatWakeups(
  beat: () => void,
  doc: WakeupListenerTarget & { visibilityState?: string },
  win: WakeupListenerTarget,
): () => void {
  const onVisibility = () => {
    if (doc.visibilityState !== "hidden") beat();
  };
  const onWake = () => beat();
  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("focus", onWake);
  win.addEventListener("online", onWake);
  return () => {
    doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("focus", onWake);
    win.removeEventListener("online", onWake);
  };
}
