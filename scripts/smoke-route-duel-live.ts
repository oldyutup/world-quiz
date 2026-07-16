/**
 * smoke-route-duel-live.ts — Rota Duel CANLI heartbeat/disconnect smoke testi.
 *
 * ⚠ CANLI Supabase'e yazar (.env'deki VITE_SUPABASE_URL/ANON_KEY): iki misafir
 * istemciyle GEÇİCİ bir oda kurar, maçı başlatır, gerçek zaman ilerleterek
 * heartbeat → gösterge → sunucu-otoriter disconnect zincirini uçtan uca
 * doğrular ve odayı SİLEREK çıkar. Yalnız elle çalıştır; CI'ya koyma.
 *
 * Senaryo (~70 sn):
 *   1. Host (misafir, claim-token yolu) oda kurar; guest katılır; maç başlar.
 *   2. 27 sn boyunca iki taraf 3 sn'de bir route_duel_heartbeat atar; host
 *      HİÇ HAMLE YAPMADAN rakip last_seen_at'i poll'layıp gerçek
 *      routeDuelConnection mantığıyla göstergeyi örnekler → hep "connected"
 *      olmalı (eski 6 sn eşiği bu boşta-bekleme senaryosunda kırmızıya
 *      düşebiliyordu).
 *   3. Guest beat'leri durdurulur → yaş büyür: ≥12 sn'de amber "reconnecting"
 *      görünür (sunucu onaysız ASLA kırmızı "disconnected" değil), ≥20 sn'de
 *      handle_disconnect istenir → SUNUCU maçı host lehine bitirir
 *      (finished_reason='disconnect') → ancak O ZAMAN gösterge "disconnected"
 *      olur → kırmızının tek kaynağı sunucu, otorite bozulmamış demektir.
 *   4. Temizlik: guest + host leave_room → oda satırı silinir (doğrulanır).
 *
 * GÜVENLİK: hiçbir secret hardcode edilmez. Bağlantı bilgisi önce process.env
 * (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY), yoksa .env dosyasından okunur
 * — ikisi de yalnız PUBLIC anon client anahtarıdır (service-role/şifre YOK).
 * URL/anahtar değerleri asla konsola yazılmaz.
 *
 * Çalıştır:  npx tsx scripts/smoke-route-duel-live.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { generateRouteDuelRoomCode } from "../src/lib/routeDuelShared";
import {
  ROUTE_DUEL_HEARTBEAT_MS,
  ROUTE_DUEL_OPP_POLL_MS,
  computeOppStaleSeconds,
  deriveOppConnectionView,
  isServerConfirmedDisconnect,
  parseServerTimestampMs,
  shouldRequestDisconnect,
} from "../src/lib/routeDuelConnection";

/** Yalnız PUBLIC anon client bilgileri; önce process.env, yoksa .env dosyası.
 *  Değerler hata mesajı dahil HİÇBİR yerde konsola yazılmaz. */
function env(): { url: string; key: string } {
  let url = process.env.VITE_SUPABASE_URL?.trim();
  let key = process.env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) {
    const envPath = new URL("../.env", import.meta.url);
    if (existsSync(envPath)) {
      const raw = readFileSync(envPath, "utf8");
      const get = (name: string) => raw.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
      url ||= get("VITE_SUPABASE_URL");
      key ||= get("VITE_SUPABASE_ANON_KEY");
    }
  }
  if (!url || !key) {
    throw new Error("VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY bulunamadı (env değişkeni ya da .env)");
  }
  return { url, key };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}

async function main() {
  const { url, key } = env();
  // İki BAĞIMSIZ istemci (iki tarayıcı context'inin ağ eşdeğeri).
  const host  = createClient(url, key, { auth: { persistSession: false } });
  const guest = createClient(url, key, { auth: { persistSession: false } });

  // Uygulamayla aynı sunucu-saat senkronu.
  const t0 = Date.now();
  const { data: serverMs, error: clockErr } = await host.rpc("get_server_time_ms");
  if (clockErr || typeof serverMs !== "number") throw new Error(`get_server_time_ms: ${clockErr?.message}`);
  const offset = serverMs - (t0 + (Date.now() - t0) / 2);
  const syncedNow = () => Date.now() + offset;

  const hostId  = crypto.randomUUID();
  const hostTok = crypto.randomUUID();
  const guestId  = crypto.randomUUID();
  const guestTok = crypto.randomUUID();

  console.log("· 1. Oda kur + katıl + başlat (misafir claim-token kimlik yolu)");
  const { data: roomData, error: createErr } = await host.rpc("route_duel_create_room", {
    p_player_id: hostId, p_profile_id: null, p_guest_id: hostId,
    p_name: "SmokeHostA7", p_code: generateRouteDuelRoomCode(),
    p_total_rounds: 3, p_route_length: "5", p_claim_token: hostTok,
  });
  if (createErr) throw new Error(`create_room: ${createErr.message}`);
  const room = roomData as { id: string; code: string };
  ok(!!room?.id, `oda kuruldu (#${room.code})`);

  const cleanup = async () => {
    await guest.rpc("route_duel_leave_room", { p_room_id: room.id, p_player_id: guestId, p_claim_token: guestTok });
    await host.rpc("route_duel_leave_room", { p_room_id: room.id, p_player_id: hostId, p_claim_token: hostTok });
  };

  try {
    const { error: joinErr } = await guest.rpc("route_duel_join_room", {
      p_code: room.code, p_player_id: guestId, p_profile_id: null,
      p_guest_id: guestId, p_name: "SmokeGuestB7", p_claim_token: guestTok,
    });
    ok(!joinErr, "guest katıldı", joinErr?.message);

    const { data: started, error: startErr } = await host.rpc("route_duel_start_game", {
      p_room_id: room.id, p_host_player_id: hostId, p_claim_token: hostTok,
    });
    ok(!startErr && (started as { status?: string })?.status === "playing", "maç başladı (playing)", startErr?.message);

    // Heartbeat döngüleri — iki istemci birbirinden bağımsız.
    let guestBeating = true;
    const beat = (c: typeof host, pid: string, tok: string) =>
      c.rpc("route_duel_heartbeat", { p_player_id: pid, p_claim_token: tok })
        .then(({ error }) => { if (error) console.error(`    ! heartbeat(${pid.slice(0, 8)}): ${error.message}`); });
    const hostTimer  = setInterval(() => void beat(host, hostId, hostTok), ROUTE_DUEL_HEARTBEAT_MS);
    const guestTimer = setInterval(() => { if (guestBeating) void beat(guest, guestId, guestTok); }, ROUTE_DUEL_HEARTBEAT_MS);
    void beat(host, hostId, hostTok);
    void beat(guest, guestId, guestTok);

    // Client monitörünün birebir aynısı: iki satırı SELECT'le, gerçek modülle hesapla.
    const sample = async () => {
      const { data } = await host
        .from("route_duel_players")
        .select("id, last_seen_at")
        .eq("room_id", room.id);
      const rows = (data ?? []) as { id: string; last_seen_at: string | null }[];
      const oppRow = rows.find(r => r.id !== hostId);
      const myRow  = rows.find(r => r.id === hostId);
      const stale = computeOppStaleSeconds({
        oppLastSeenMs: oppRow ? parseServerTimestampMs(oppRow.last_seen_at) : null,
        myLastSeenMs:  myRow ? parseServerTimestampMs(myRow.last_seen_at) : null,
        syncedNowMs:   syncedNow(),
      });
      return { stale, view: deriveOppConnectionView(stale), disconnect: shouldRequestDisconnect(stale) };
    };

    console.log("· 2. 27 sn boşta (HAMLESİZ) — iki taraf beat atarken gösterge hep 'connected'");
    let worst = 0;
    let everLost = false;
    for (let i = 0; i < 9; i++) {
      await sleep(ROUTE_DUEL_OPP_POLL_MS);
      const s = await sample();
      worst = Math.max(worst, s.stale ?? 0);
      if (s.view !== "connected") everLost = true;
      console.log(`    t+${(i + 1) * 3}s  stale=${s.stale?.toFixed(1)}s  view=${s.view}`);
    }
    ok(!everLost, "27 sn boyunca ne amber ne kırmızı sahte uyarı YOK (eski 6 sn eşiği regresyonu)", worst);
    ok(worst < 12, `en kötü örneklenen yaş ${worst.toFixed(1)}s < 12s`);

    console.log("· 3. Guest beat'leri durdu — amber uyarı → sunucu-onaylı kopuş akışı");
    guestBeating = false;
    let reconnectingAtS: number | null = null;
    let requestedAtS: number | null = null;
    let sawUnconfirmedRed = false;
    let finished: { status?: string; winner_player_id?: string; finished_reason?: string } | null = null;
    for (let i = 0; i < 12 && !finished; i++) {
      await sleep(ROUTE_DUEL_OPP_POLL_MS);
      const s = await sample();
      const tS = (i + 1) * 3;
      console.log(`    t+${tS}s  stale=${s.stale?.toFixed(1)}s  view=${s.view}${s.disconnect ? "  → handle_disconnect istenir" : ""}`);
      if (s.view === "reconnecting" && reconnectingAtS === null) reconnectingAtS = s.stale ?? tS;
      // Sunucu kesinleştirmeden client görünümü asla kırmızı olmamalı —
      // 20 sn aşılıp kontrol İSTENİRKEN bile.
      if (s.view === "disconnected") sawUnconfirmedRed = true;
      if (s.disconnect) {
        requestedAtS ??= s.stale ?? tS;
        const { data: after, error } = await host.rpc("route_duel_handle_disconnect", {
          p_room_id: room.id, p_player_id: hostId, p_claim_token: hostTok,
        });
        if (error) console.error(`    ! handle_disconnect: ${error.message}`);
        const r = after as typeof finished;
        if (r?.status === "finished") finished = r;
      }
    }
    clearInterval(hostTimer);
    clearInterval(guestTimer);

    ok(reconnectingAtS !== null && reconnectingAtS >= 12,
      `amber 'reconnecting' ilk kez ölçülen yaş ${reconnectingAtS?.toFixed(1)}s'de (≥12s) göründü`, reconnectingAtS);
    ok(!sawUnconfirmedRed, "sunucu onayı ÖNCESİ hiçbir örnekte 'disconnected' (kırmızı) görülmedi");
    ok(requestedAtS !== null && requestedAtS >= 20, `kopuş kontrolü ${requestedAtS?.toFixed(1)}s'de (≥20s) istendi`, requestedAtS);
    ok(finished?.status === "finished", "SUNUCU maçı bitirdi (otorite bozulmadı)", finished?.status);
    ok(finished?.winner_player_id === hostId, "kalan oyuncu (host) kazandı");
    ok(finished?.finished_reason === "disconnect", "finished_reason = 'disconnect'", finished?.finished_reason);
    // Onaylı oda satırıyla görünüm ancak ŞİMDİ kırmızıya döner:
    ok(isServerConfirmedDisconnect(finished), "oda satırı sunucu-onaylı kopuş taşıyor");
    ok(deriveOppConnectionView(null, isServerConfirmedDisconnect(finished)) === "disconnected",
      "sunucu onayı geldi → gösterge 'disconnected' (kırmızı) — kırmızının tek kaynağı sunucu");
  } finally {
    console.log("· 4. Temizlik: leave_room × 2 → oda silinmeli");
    await cleanup();
  }

  const { data: gone } = await host.from("route_duel_rooms").select("id").eq("id", room.id).maybeSingle();
  ok(gone === null, "oda satırı canlı DB'den silindi (kalıntı yok)");

  console.log(failed === 0 ? `\n✅ ${passed} passed, 0 failed` : `\n❌ ${passed} passed, ${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(`\n❌ smoke aborted: ${err?.message ?? err}`);
  process.exit(1);
});
