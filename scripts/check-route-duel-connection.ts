/**
 * check-route-duel-connection.ts — Rota Duel rakip-bağlantı göstergesi sözleşmesi.
 *
 * routeDuelConnection.ts saf mantığının DB'siz testi (check-route-duel-logic
 * yaklaşımı). Kapsam: false-disconnect regresyonu — heartbeat akarken uyarı
 * gösterilmez, tek kaçırılmış beat grace içinde kalır; yaş ≥12 sn EN FAZLA
 * amber "reconnecting" üretir ve KIRMIZI "disconnected" YALNIZ sunucu onayıyla
 * (finished_reason='disconnect') görünür — 20 sn aşılsa bile onaysız kırmızı
 * yok; yeni beat gelince reconnecting otomatik connected'a döner; ilk yükte
 * nötr "Bağlanıyor…"; NaN/parse hatası asla kalıcı uyarıya kilitlemez; lokal
 * saat kayması sahte uyarı üretemez; wakeup listener'ları duplicate bırakmaz.
 *
 * DRIFT UYARISI: eşikler 20260802120000_route_duel_init.sql'deki 20 sn sunucu
 * guard'ı ile hizalıdır; SQL kuralı değişirse burası da güncellenmeli.
 *
 * Çalıştır:  npx tsx scripts/check-route-duel-connection.ts
 */
import {
  ROUTE_DUEL_HEARTBEAT_MS,
  ROUTE_DUEL_OPP_POLL_MS,
  ROUTE_DUEL_OPP_STALE_UI_SECONDS,
  ROUTE_DUEL_DISCONNECT_REQUEST_SECONDS,
  attachHeartbeatWakeups,
  computeOppStaleSeconds,
  deriveOppConnectionView,
  isRouteDuelPresencePhase,
  isServerConfirmedDisconnect,
  parseServerTimestampMs,
  shouldRequestDisconnect,
} from "../src/lib/routeDuelConnection";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}
function eq(a: unknown, b: unknown, label: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, a);
}

/** İki damgadan (sunucu-ms) gösterge durumu üret — testlerin ortak yolu.
 *  serverConfirmed verilmezse sunucu HENÜZ kopuş onaylamamış demektir. */
function viewAt(opts: {
  oppSeenMs: number | null;
  mySeenMs: number | null;
  nowMs: number;
  serverConfirmed?: boolean;
}) {
  const stale = computeOppStaleSeconds({
    oppLastSeenMs: opts.oppSeenMs,
    myLastSeenMs:  opts.mySeenMs,
    syncedNowMs:   opts.nowMs,
  });
  return {
    stale,
    view: deriveOppConnectionView(stale, opts.serverConfirmed ?? false),
    disconnect: shouldRequestDisconnect(stale),
  };
}

/* ── 1. SABİT SÖZLEŞME ── */
console.log("· 1. Eşikler: SQL guard'ı ile hiza + sıralama");
{
  eq(ROUTE_DUEL_DISCONNECT_REQUEST_SECONDS, 20, "kopuş-kontrol isteği eşiği = SQL'deki 20 sn guard");
  ok(ROUTE_DUEL_OPP_STALE_UI_SECONDS >= 4 * (ROUTE_DUEL_HEARTBEAT_MS / 1000),
    "UI 'zayıf' (reconnecting) eşiği ≥ 4 heartbeat periyodu (tek kaçırılmış beat uyarı yapamaz)",
    ROUTE_DUEL_OPP_STALE_UI_SECONDS);
  ok(ROUTE_DUEL_OPP_STALE_UI_SECONDS < ROUTE_DUEL_DISCONNECT_REQUEST_SECONDS,
    "UI eşiği sunucu eşiğinden küçük (amber uyarı sunucu kararından önce gelir)");
  eq(ROUTE_DUEL_HEARTBEAT_MS, 3000, "heartbeat periyodu 3 sn (DuelGame deseni)");
  eq(ROUTE_DUEL_OPP_POLL_MS, 3000, "rakip poll periyodu 3 sn");
}

/* ── 2. İKİ OYUNCU HEARTBEAT ATARKEN ── */
console.log("· 2. Normal akış: iki taraf da beat atarken disconnect görünmez");
{
  // 2 dk'lık maç: rakip 3 sn'de bir beat atıyor; ben 3 sn'de bir poll'luyorum.
  // Beat yazımı + poll okuma gecikmesi için 1.2 sn'ye kadar jitter modellenir.
  const t0 = Date.UTC(2026, 6, 15, 12, 0, 0);
  let worstStale = 0;
  let sawWarning = false;
  for (let pollMs = 500; pollMs <= 120_000; pollMs += ROUTE_DUEL_OPP_POLL_MS) {
    const now = t0 + pollMs;
    const jitter = (pollMs % 3) * 400; // 0 / 400 / 800 ms döngüsel gecikme
    const oppSeen = t0 + Math.floor((pollMs - jitter) / ROUTE_DUEL_HEARTBEAT_MS) * ROUTE_DUEL_HEARTBEAT_MS;
    const mySeen  = t0 + Math.floor(pollMs / ROUTE_DUEL_HEARTBEAT_MS) * ROUTE_DUEL_HEARTBEAT_MS;
    const { stale, view } = viewAt({ oppSeenMs: oppSeen, mySeenMs: mySeen, nowMs: now });
    worstStale = Math.max(worstStale, stale ?? 0);
    if (view !== "connected") sawWarning = true;
  }
  ok(!sawWarning, "120 sn boyunca her poll 'connected' (ne amber ne kırmızı)", worstStale);
  ok(worstStale < ROUTE_DUEL_OPP_STALE_UI_SECONDS, "en kötü örneklenen yaş UI eşiğinin altında", worstStale);
}

/* ── 3. TUR GEÇİŞİ ── */
console.log("· 3. Tur geçişi: banner + geri sayım penceresinde false disconnect yok");
{
  // Tur kararı → 3.2 sn banner → advance → 3 sn geri sayım ≈ 6.5 sn'lik
  // hamlesiz pencere. Heartbeat FAZDAN bağımsız sürdüğü için yaş büyümez.
  const t0 = Date.UTC(2026, 6, 15, 12, 0, 0);
  const decidedMs = t0 + 30_000;
  for (let dt = 0; dt <= 8_000; dt += 1_000) {
    const now = decidedMs + dt;
    const oppSeen = t0 + Math.floor((decidedMs + dt - 900) / ROUTE_DUEL_HEARTBEAT_MS) * ROUTE_DUEL_HEARTBEAT_MS;
    const mySeen  = oppSeen;
    const { view } = viewAt({ oppSeenMs: oppSeen, mySeenMs: mySeen, nowMs: now });
    if (view !== "connected") { ok(false, `geçiş penceresi t+${dt}ms 'connected' değil`, view); }
  }
  ok(true, "tur-sonu banner'ı + sonraki tur geri sayımı boyunca 'connected' kaldı");

  // Heartbeat yaşam döngüsü faz gate'i: lobby→playing→finished kesintisiz.
  eq(isRouteDuelPresencePhase("lobby"), true, "lobby'de heartbeat aktif (playing'e geçişte kesilmez)");
  eq(isRouteDuelPresencePhase("playing"), true, "playing'de heartbeat aktif (tur geçişleri faz değiştirmez)");
  eq(isRouteDuelPresencePhase("finished"), true, "sonuç ekranında heartbeat aktif (rövanş bekleyişi)");
  eq(isRouteDuelPresencePhase("setup"), false, "setup'ta beat yok (oyuncu satırı yok)");
  eq(isRouteDuelPresencePhase("searching"), false, "searching'de beat yok (oyuncu satırı yok)");
  eq(isRouteDuelPresencePhase("creating"), false, "creating'de beat yok");
}

/* ── 4. İLK YÜKLEME ── */
console.log("· 4. İlk yükleme: veri gelmeden kırmızı gösterilmez");
{
  eq(deriveOppConnectionView(null), "unknown", "stale=null → 'unknown' (nötr Bağlanıyor…)");
  eq(shouldRequestDisconnect(null), false, "stale=null → kopuş kontrolü İSTENMEZ");
  const { stale, view } = viewAt({ oppSeenMs: null, mySeenMs: Date.UTC(2026, 6, 15), nowMs: Date.UTC(2026, 6, 15) });
  eq(stale, null, "rakip damgası yoksa yaş=null");
  eq(view, "unknown", "rakip damgası yoksa görünüm 'unknown'");
}

/* ── 5. TEK KAÇIRILMIŞ HEARTBEAT ── */
console.log("· 5. Grace: tek kaçırılmış beat (6-9 sn yaş) disconnect sayılmaz");
{
  const t0 = Date.UTC(2026, 6, 15, 12, 0, 0);
  for (const ageS of [3, 4.5, 6, 7.5, 9, 11.9]) {
    const { view } = viewAt({ oppSeenMs: t0 - ageS * 1000, mySeenMs: t0 - 500, nowMs: t0 });
    eq(view, "connected", `${ageS} sn yaş → hâlâ 'connected'`);
  }
  // ESKİ regresyon: 6 sn eşiği tek gecikmiş beat'te kırmızıya düşüyordu.
  const old6s = viewAt({ oppSeenMs: t0 - 6_500, mySeenMs: t0 - 500, nowMs: t0 });
  eq(old6s.view, "connected", "6.5 sn yaş (eski eşiğin kırmızısı) artık 'connected'");
}

/* ── 6. EŞİK AŞIMI: AMBER UYARI, KIRMIZI DEĞİL ── */
console.log("· 6. Stale eşik: 12+ sn amber 'reconnecting' — sunucu onaysız ASLA 'disconnected'");
{
  const t0 = Date.UTC(2026, 6, 15, 12, 0, 0);
  // 13-19 sn arası (Safari/background throttling penceresi): amber, kırmızı YOK.
  for (const ageS of [13, 14, 15, 16, 17, 18, 19]) {
    const { view } = viewAt({ oppSeenMs: t0 - ageS * 1000, mySeenMs: t0 - 500, nowMs: t0 });
    eq(view, "reconnecting", `${ageS} sn yaş → 'reconnecting' (amber, kırmızı DEĞİL)`);
  }
  const at12 = viewAt({ oppSeenMs: t0 - 12_500, mySeenMs: t0 - 500, nowMs: t0 });
  eq(at12.view, "reconnecting", "12+ sn yaş → 'reconnecting' görünür");
  eq(at12.disconnect, false, "12 sn'de sunucu kontrolü HENÜZ istenmez (20 sn)");
  // 20 sn AŞILDI ama sunucu henüz kopuşu kesinleştirmedi: kontrol İSTENİR,
  // gösterge yine de kırmızıya GEÇMEZ (karar sunucuda).
  const at20 = viewAt({ oppSeenMs: t0 - 21_000, mySeenMs: t0 - 500, nowMs: t0 });
  eq(at20.view, "reconnecting", "21 sn yaş + sunucu onayı YOK → hâlâ 'reconnecting' (kırmızı değil)");
  eq(at20.disconnect, true, "21 sn'de handle_disconnect istenir (karar sunucuda)");
  const at40 = viewAt({ oppSeenMs: t0 - 40_000, mySeenMs: t0 - 500, nowMs: t0 });
  eq(at40.view, "reconnecting", "40 sn yaş bile onaysız 'reconnecting' kalır (yaş kırmızı üretemez)");
}

/* ── 7. HEARTBEAT GERİ GELİNCE ── */
console.log("· 7. Kurtarma: yeni heartbeat gelince 'reconnecting' doğrudan 'connected'a döner");
{
  const t0 = Date.UTC(2026, 6, 15, 12, 0, 0);
  const stale = viewAt({ oppSeenMs: t0 - 15_000, mySeenMs: t0 - 500, nowMs: t0 });
  eq(stale.view, "reconnecting", "15 sn sessizlik → 'reconnecting'");
  // 3 sn sonra rakip beat attı → sonraki poll küçük yaş görür.
  const recovered = viewAt({ oppSeenMs: t0 + 2_600, mySeenMs: t0 + 2_500, nowMs: t0 + 3_000 });
  eq(recovered.view, "connected", "beat geri geldi → 'connected' (ara durum/kilitlenme yok)");
  // 20 sn'i aşıp kontrol istendiği hâlde sunucu no-op dediyse (rakip döndü):
  const lateRecovery = viewAt({ oppSeenMs: t0 + 23_000, mySeenMs: t0 + 22_500, nowMs: t0 + 24_000 });
  eq(lateRecovery.view, "connected", "20 sn+ sonrası dönüş: sunucu bitirmediyse yine 'connected'");
}

/* ── 7b. SUNUCU ONAYI: KIRMIZININ TEK KAYNAĞI ── */
console.log("· 7b. 'disconnected' yalnız sunucu kesinleştirince (finished_reason='disconnect')");
{
  const t0 = Date.UTC(2026, 6, 15, 12, 0, 0);
  // Oda satırı bazlı onay tespiti:
  eq(isServerConfirmedDisconnect({ status: "finished", finished_reason: "disconnect" }), true,
    "finished + finished_reason='disconnect' → sunucu onayı VAR");
  eq(isServerConfirmedDisconnect({ status: "finished", finished_reason: "completed" }), false,
    "normal biten maç → onay YOK");
  eq(isServerConfirmedDisconnect({ status: "finished", finished_reason: "opponent_left" }), false,
    "bilerek ayrılma (opponent_left) → bağlantı-kopuşu onayı DEĞİL");
  eq(isServerConfirmedDisconnect({ status: "playing", finished_reason: null }), false,
    "playing oda → onay YOK");
  eq(isServerConfirmedDisconnect(null), false, "oda yok → onay YOK");

  // Onay geldiğinde kırmızı görünür — stale değeri ne olursa olsun:
  const confirmedStale = viewAt({ oppSeenMs: t0 - 25_000, mySeenMs: t0 - 500, nowMs: t0, serverConfirmed: true });
  eq(confirmedStale.view, "disconnected", "sunucu onayı + büyük yaş → 'disconnected' (kırmızı)");
  eq(deriveOppConnectionView(null, true), "disconnected",
    "onay sonrası monitor temizlense (stale=null) bile kırmızı korunur");
  eq(deriveOppConnectionView(1, true), "disconnected",
    "sunucu kesinleştirdiyse taze görünen damga bile kararı değiştirmez (otorite sunucu)");
}

/* ── 8. SAAT KAYMASI ── */
console.log("· 8. Saat güveni: lokal saat kayması sahte uyarı üretemez");
{
  const server = Date.UTC(2026, 6, 15, 12, 0, 0);
  // Lokal saat 30 sn İLERİ (senkron başarısız → Date.now fallback senaryosu):
  // her iki last_seen de sunucuda taze; çıpa yaşı tavanlar.
  const skewedAhead = viewAt({ oppSeenMs: server - 2_000, mySeenMs: server - 1_000, nowMs: server + 30_000 });
  eq(skewedAhead.view, "connected", "lokal saat +30 sn kaymış ama beat'ler taze → 'connected'");
  eq(skewedAhead.disconnect, false, "kaymış saat sunucu kopuş isteği tetikleyemez");
  // Gerçek kopuş kayma altında YİNE yakalanır: benim beat'lerim sürüyor,
  // rakibinki durdu → çıpalı yaş gerçek yaşla birlikte büyür.
  const realLoss = viewAt({ oppSeenMs: server - 25_000, mySeenMs: server - 1_000, nowMs: server + 30_000 });
  eq(realLoss.view, "reconnecting", "kayma varken gerçek 25 sn sessizlik → amber (kırmızı kararı sunucuda)");
  eq(realLoss.disconnect, true, "kayma varken gerçek kopuşta sunucu kontrolü istenir");
  // Lokal saat GERİ kalmışsa yaş negatife düşer → 0'a kıskaçlanır (yeşil).
  const skewedBehind = viewAt({ oppSeenMs: server - 1_000, mySeenMs: server - 2_000, nowMs: server - 10_000 });
  eq(skewedBehind.view, "connected", "lokal saat geri kalmış → yaş 0'a kıskaçlanır, 'connected'");
}

/* ── 9. TIMESTAMP PARSE SERTLEŞTİRMESİ ── */
console.log("· 9. Parse: NaN asla sızmaz (kalıcı uyarı kilidi imkânsız)");
{
  const iso = "2026-07-15T12:00:00.123456+00:00";
  ok(parseServerTimestampMs(iso) !== null, "PostgREST timestamptz (mikrosaniyeli) parse edilir");
  eq(parseServerTimestampMs(iso), Date.parse("2026-07-15T12:00:00.123Z"), "mikrosaniye ms'e kırpılır");
  ok(parseServerTimestampMs("2026-07-15 12:00:00.123456+00:00") !== null, "boşluklu varyant normalize edilir");
  eq(parseServerTimestampMs("not-a-timestamp"), null, "çöp string → null (NaN değil)");
  eq(parseServerTimestampMs(""), null, "boş string → null");
  eq(parseServerTimestampMs(null), null, "null → null");
  eq(parseServerTimestampMs(undefined), null, "undefined → null");
  // NaN sızsaydı: NaN<eşik=false → kalıcı uyarı + NaN>=20=false → sunucu
  // kontrolü asla istenmezdi (gözlenen false-negative'in kilit deseni).
  const nanStale = computeOppStaleSeconds({ oppLastSeenMs: Number.NaN, myLastSeenMs: 0, syncedNowMs: 0 });
  eq(nanStale, null, "NaN damga → stale=null");
  eq(deriveOppConnectionView(Number.NaN), "unknown", "NaN stale → 'unknown' ('reconnecting' değil)");
  eq(shouldRequestDisconnect(Number.NaN), false, "NaN stale → kopuş isteği yok");
}

/* ── 10. KİMLİK YOLLARI (route_duel_authorize_player aynası) ── */
console.log("· 10. Host/guest kimliği: profil VE claim-token yolları heartbeat'i geçer");
{
  // SQL: (profile_id = auth.uid()) OR (claim_token eşleşir) — iki yol da yeter.
  const authorize = (p: {
    profileId: string | null; authUid: string | null;
    claimToken: string | null; storedClaim: string | null;
  }) =>
    (p.profileId !== null && p.profileId === p.authUid) ||
    (p.claimToken !== null && p.claimToken === p.storedClaim);

  ok(authorize({ profileId: "prof-1", authUid: "prof-1", claimToken: null, storedClaim: "tok-1" }),
    "giriş yapmış oyuncu: profil eşleşmesi tek başına yeter (token'sız)");
  ok(authorize({ profileId: null, authUid: null, claimToken: "tok-2", storedClaim: "tok-2" }),
    "misafir oyuncu: claim token eşleşmesi tek başına yeter");
  ok(authorize({ profileId: "prof-1", authUid: null, claimToken: "tok-1", storedClaim: "tok-1" }),
    "giriş yapmış ama JWT'siz istek: claim token yolu kurtarır");
  ok(!authorize({ profileId: "prof-1", authUid: "prof-2", claimToken: "tok-X", storedClaim: "tok-1" }),
    "yanlış profil + yanlış token → reddedilir");
  ok(!authorize({ profileId: null, authUid: null, claimToken: null, storedClaim: "tok-1" }),
    "kimliksiz istek → reddedilir");
}

/* ── 11. WAKEUP LISTENER'LARI ── */
console.log("· 11. visibility/focus/online: anında beat + duplicate'siz söküm");
{
  class StubTarget {
    listeners = new Map<string, Set<() => void>>();
    visibilityState = "visible";
    addEventListener(type: string, cb: () => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(cb);
    }
    removeEventListener(type: string, cb: () => void) {
      this.listeners.get(type)?.delete(cb);
    }
    dispatch(type: string) {
      for (const cb of this.listeners.get(type) ?? []) cb();
    }
    count() {
      let n = 0;
      for (const set of this.listeners.values()) n += set.size;
      return n;
    }
  }

  let beats = 0;
  const doc = new StubTarget();
  const win = new StubTarget();
  const detach = attachHeartbeatWakeups(() => { beats++; }, doc, win);

  doc.dispatch("visibilitychange");
  eq(beats, 1, "görünür sekmeye dönüş → anında beat");
  doc.visibilityState = "hidden";
  doc.dispatch("visibilitychange");
  eq(beats, 1, "sekme gizlenirken beat atılmaz");
  doc.visibilityState = "visible";
  win.dispatch("focus");
  eq(beats, 2, "focus → anında beat");
  win.dispatch("online");
  eq(beats, 3, "ağ geri geldi → anında beat (Realtime reconnect toparlar)");

  detach();
  eq(doc.count() + win.count(), 0, "cleanup TÜM listener'ları söktü");
  doc.dispatch("visibilitychange");
  win.dispatch("focus");
  win.dispatch("online");
  eq(beats, 3, "söküm sonrası hiçbir olay beat üretmez (duplicate imkânsız)");

  // İkinci kurulum eskisini etkilemez (remount senaryosu): tek set listener.
  const detach2 = attachHeartbeatWakeups(() => { beats++; }, doc, win);
  win.dispatch("focus");
  eq(beats, 4, "yeni kurulum tek beat üretir (eski listener'lar geri gelmez)");
  detach2();
}

/* ── 12. İKİ İSTEMCİ BAĞIMSIZLIĞI ── */
console.log("· 12. Bağımsızlık: bir tarafın beat'i diğerinin göstergesini yönetmez");
{
  const t0 = Date.UTC(2026, 6, 15, 12, 0, 0);
  // BENİM beat'lerim durdu (myLastSeen eski) ama rakibinki taze → rakip
  // 'connected' kalmalı (kendi sorunum rakibe yansıtılmaz).
  const myBeatsStalled = viewAt({ oppSeenMs: t0 - 1_000, mySeenMs: t0 - 40_000, nowMs: t0 });
  eq(myBeatsStalled.view, "connected", "kendi beat'lerim dursa da taze rakip 'connected'");
  // Çıpa yönü: rakip benden DAHA yeni görülmüşse yaş 0'a kıskaçlanır.
  const oppNewer = viewAt({ oppSeenMs: t0 - 500, mySeenMs: t0 - 2_900, nowMs: t0 });
  eq(oppNewer.view, "connected", "rakip damgası benimkinden yeni → 'connected'");
}

console.log(failed === 0 ? `\n✅ ${passed} passed, 0 failed` : `\n❌ ${passed} passed, ${failed} FAILED`);
if (failed > 0) process.exit(1);
