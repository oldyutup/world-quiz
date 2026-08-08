/**
 * check-kornokta-restore.ts
 *
 * Kör Nokta REFRESH/RECONNECT restore sözleşmesini saf/DB'siz doğrular.
 * Gerçek Supabase ve tarayıcı GEREKMEZ (localStorage taklit edilir).
 *
 * NEDEN VAR
 * ─────────
 * Guest oda oturumu (ROOM_KEY / CLAIM_TOKEN_KEY / PLAYER_ID_KEY) YAZILIYOR ama
 * hiç OKUNMUYORDU: KorNoktaMode'da mount restore effect'i yoktu ve App boot'ta
 * ekran her zaman "home" ile başlıyordu. Sonuç: sayfa yenileyen misafir odadan
 * düşüyordu. Bu script yeni sözleşmenin değişmezlerini kilitler.
 *
 * KAPSAM
 *   1. Session okuma önceliği: ROOM_KEY.claimToken KANONİK, ayrı key LEGACY.
 *   2. Temizlik BÜTÜNDÜR (üç anahtar birden) — yarım oturum kalmaz.
 *   3. Geriye dönük uyumluluk: inline alanı olmayan ESKİ oturum hâlâ okunur.
 *   4. Kaynak sözleşmesi: App restore tier'ı ve KorNoktaMode resume akışı
 *      doğru otoriteyi kullanıyor (room_id+player_id+claim_token) ve
 *      körlemesine yönlendirmiyor.
 *
 * GÜVENLİK: hiçbir assert bir kontrolü gevşetmez. guest_id/nick'in restore
 * kanıtı OLMADIĞI burada açıkça doğrulanır.
 *
 * Çalıştır:  npx tsx scripts/check-kornokta-restore.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* ── localStorage taklidi: guestSession import'undan ÖNCE kurulmalı ── */
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}
const mem = new MemStorage();
(globalThis as unknown as { localStorage: MemStorage }).localStorage = mem;

const { readModeRoomSession, clearModeRoomSession } = await import(
  "../src/lib/guestSession"
);

let passed = 0, failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}
function eq(a: unknown, b: unknown, label: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, a);
}

const ROOM_KEY   = "geoquiz_kornokta_room";
const CLAIM_KEY  = "geoquiz_kornokta_claim_token";
const PLAYER_KEY = "geoquiz_kornokta_player_id";
const GUEST_KEY  = "geoquiz_kornokta_guest_id";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const PLAYER  = "22222222-2222-4222-8222-222222222222";
const TOKEN   = "33333333-3333-4333-8333-333333333333";
const LEGACY  = "44444444-4444-4444-8444-444444444444";

/* ════════════════════════════════════════════════════════════════════════
   1) YENİ format — inline claimToken KANONİK
   ════════════════════════════════════════════════════════════════════════ */
console.log("\n1) Yeni oturum formatı (claimToken ROOM_KEY içinde)");

mem.clear();
mem.setItem(ROOM_KEY, JSON.stringify({
  roomId: ROOM_ID, roomCode: "NABC12", playerId: PLAYER, claimToken: TOKEN,
}));
mem.setItem(CLAIM_KEY, TOKEN);
mem.setItem(PLAYER_KEY, PLAYER);

const s1 = readModeRoomSession("korNokta");
eq(s1?.roomId, ROOM_ID, "roomId okunuyor (restore için ZORUNLU)");
eq(s1?.roomCode, "NABC12", "roomCode okunuyor (resume-aware join için)");
eq(s1?.playerId, PLAYER, "playerId okunuyor");
eq(s1?.claimToken, TOKEN, "claimToken okunuyor");

// KANONİKLİK: iki key ÇELİŞİRSE inline kazanmalı. İki ayrı localStorage
// yazımı atomik değildir; ayrı key bayat kalabilir.
mem.setItem(CLAIM_KEY, LEGACY);
eq(readModeRoomSession("korNokta")?.claimToken, TOKEN,
   "çelişkide inline claimToken KAZANIR (ayrı key bayat olabilir)");

/* ════════════════════════════════════════════════════════════════════════
   2) ESKİ format — legacy fallback
   ════════════════════════════════════════════════════════════════════════ */
console.log("\n2) Geriye dönük uyumluluk (inline alan YOK)");

mem.clear();
mem.setItem(ROOM_KEY, JSON.stringify({
  roomId: ROOM_ID, roomCode: "NABC12", playerId: PLAYER,   // claimToken YOK
}));
mem.setItem(CLAIM_KEY, LEGACY);

const s2 = readModeRoomSession("korNokta");
ok(s2 !== null, "eski format oturum hâlâ okunabiliyor");
eq(s2?.claimToken, LEGACY, "inline yoksa legacy key kullanılır");
eq(s2?.roomId, ROOM_ID, "eski formatta da roomId gelir");

/* ════════════════════════════════════════════════════════════════════════
   3) Eksik/bozuk oturum → null (yarım kimlikle restore denenmez)
   ════════════════════════════════════════════════════════════════════════ */
console.log("\n3) Eksik / bozuk oturumlar reddedilir");

mem.clear();
ok(readModeRoomSession("korNokta") === null, "hiç oturum yok → null");

mem.setItem(ROOM_KEY, JSON.stringify({ roomId: ROOM_ID, playerId: PLAYER }));
ok(readModeRoomSession("korNokta") === null, "claim_token yok → null (kanıtsız restore YOK)");

mem.clear();
mem.setItem(ROOM_KEY, JSON.stringify({ roomId: ROOM_ID, claimToken: TOKEN }));
ok(readModeRoomSession("korNokta") === null, "playerId yok → null");

mem.clear();
mem.setItem(ROOM_KEY, "{bozuk json");
mem.setItem(CLAIM_KEY, TOKEN);
ok(readModeRoomSession("korNokta") === null, "bozuk JSON → null (throw etmez)");

// roomId'siz oturum okunabilir ama KorNoktaMode.loadKorNoktaSession onu eler.
mem.clear();
mem.setItem(ROOM_KEY, JSON.stringify({ roomCode: "NABC12", playerId: PLAYER, claimToken: TOKEN }));
eq(readModeRoomSession("korNokta")?.roomId, "", "roomId yoksa boş string döner (çağıran eler)");

/* ════════════════════════════════════════════════════════════════════════
   4) Temizlik BÜTÜNDÜR
   ════════════════════════════════════════════════════════════════════════ */
console.log("\n4) clearModeRoomSession üç anahtarı da siler");

mem.clear();
mem.setItem(ROOM_KEY, JSON.stringify({ roomId: ROOM_ID, roomCode: "NABC12", playerId: PLAYER, claimToken: TOKEN }));
mem.setItem(CLAIM_KEY, TOKEN);
mem.setItem(PLAYER_KEY, PLAYER);
mem.setItem(GUEST_KEY, "guest-abc");

clearModeRoomSession("korNokta");
ok(mem.getItem(ROOM_KEY) === null,   "ROOM_KEY silindi");
ok(mem.getItem(CLAIM_KEY) === null,  "legacy CLAIM_TOKEN_KEY silindi");
ok(mem.getItem(PLAYER_KEY) === null, "PLAYER_ID_KEY silindi (yarım oturum kalmaz)");
ok(mem.getItem(GUEST_KEY) === "guest-abc",
   "GUEST_ID_KEY KORUNUR (misafir kimliği odalar arasında yaşar)");
ok(readModeRoomSession("korNokta") === null, "temizlik sonrası oturum okunamaz");

// Diğer modların oturumu etkilenmemeli.
mem.clear();
mem.setItem("geoquiz_duel_room", JSON.stringify({ roomId: "d", playerId: "p", claimToken: "t" }));
clearModeRoomSession("korNokta");
ok(mem.getItem("geoquiz_duel_room") !== null, "başka modun oturumuna DOKUNULMAZ");

/* ════════════════════════════════════════════════════════════════════════
   5) Kaynak sözleşmesi — App restore tier'ı
   ════════════════════════════════════════════════════════════════════════ */
console.log("\n5) App.tsx restore tier sözleşmesi");

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "../src/App.tsx"), "utf8");
const knm = readFileSync(join(here, "../src/modes/korNokta/KorNoktaMode.tsx"), "utf8");

ok(app.includes("korNoktaResumeAttemptedRef"),
   "tek-atış ref var (yönlendirme döngüsü koruması)");
ok(app.includes('supabase.rpc("tevatur_get_room_state"'),
   "App yönlendirmeden ÖNCE sunucuya doğrulatıyor");

// Körlemesine route etmeme: setScreen("kornokta-join") YALNIZ ok dalında.
// Dilim effect'in SONUNDA biter — dosyanın geri kalanına taşarsa başka bir
// yerdeki eşleşme sıralama assert'lerini yanlışlıkla geçirebilirdi.
const tierStart = app.indexOf("korNoktaResumeAttemptedRef.current = true");
const tierEnd = app.indexOf("}, [authLoading", tierStart);
ok(tierStart > 0 && tierEnd > tierStart, "restore tier dilimi sınırlandı");
const tier = app.slice(tierStart, tierEnd);
const okIdx    = tier.indexOf("payload?.ok");
const routeIdx = tier.indexOf('setScreen("kornokta-join")');
ok(okIdx > 0 && routeIdx > okIdx,
   'setScreen("kornokta-join") yalnız payload.ok DOĞRULANDIKTAN sonra çağrılıyor');
ok(tier.includes("if (error) return;"),
   "ağ hatasında oturum SİLİNMİYOR (geçici hata slotu yok etmemeli)");
const clearIdx = tier.indexOf('clearModeRoomSession("korNokta")');
ok(clearIdx > okIdx, "temizlik yalnız KESİN ret (not_a_member/room_gone) dalında");

// guest_id / nick restore kanıtı OLMAMALI: RPC'ye yalnız üç alan gider.
const rpcCall = tier.slice(tier.indexOf("tevatur_get_room_state"), tier.indexOf("if (error)"));
ok(!/guest_id|p_name|nick/i.test(rpcCall),
   "restore RPC'sine guest_id / nick GÖNDERİLMİYOR (tek otorite claim_token)");
for (const p of ["p_room_id", "p_player_id", "p_claim_token"]) {
  ok(rpcCall.includes(p), `restore RPC'si ${p} gönderiyor`);
}

/* ════════════════════════════════════════════════════════════════════════
   6) Kaynak sözleşmesi — KorNoktaMode resume akışı
   ════════════════════════════════════════════════════════════════════════ */
console.log("\n6) KorNoktaMode resume sözleşmesi");

ok(/initialAction:\s*"create"\s*\|\s*"join"\s*\|\s*"resume"/.test(knm),
   '"resume" initialAction tipi eklendi');
ok(knm.includes("resumeAttemptedRef"), "resume tek-atış ref'i var");

const resumeBlock = knm.slice(
  knm.indexOf("const resumeAttemptedRef"),
  knm.indexOf("async function joinRoomByCode"),
);
ok(resumeBlock.length > 0, "resume effect gövdesi bulundu");
// Refs RPC'den ÖNCE kurulmalı: realtime aboneliği ve KorNoktaGame onları okur.
const refIdx = resumeBlock.indexOf("myClaimTokenRef.current = saved.claimToken");
const fetchIdx = resumeBlock.indexOf("fetchKorNoktaRoomState");
ok(refIdx > 0 && fetchIdx > refIdx, "refs RPC çağrısından ÖNCE kuruluyor");
ok(resumeBlock.includes('res.status === "lost"'), '"lost" dalı ayrı ele alınıyor');
ok(!/res\.status === "error"[\s\S]{0,120}clearKorNoktaSession/.test(resumeBlock),
   '"error" dalında oturum SİLİNMİYOR');
ok(!resumeBlock.includes("tevatur_join_room"),
   "resume JOIN RPC'si çağırmıyor (yeni oyuncu satırı OLUŞMAZ)");

// Resume-aware join: aynı oda → stored identity; farklı oda → temiz fresh join.
const joinBlock = knm.slice(
  knm.indexOf("async function joinRoomByCode"),
  knm.indexOf("async function leaveRoom"),
);
ok(joinBlock.includes("saved.roomCode === normalized"),
   "join yalnız AYNI oda kodunda resume deniyor");
ok(joinBlock.indexOf("clearKorNoktaSession()") > joinBlock.indexOf("saved.roomCode === normalized"),
   "farklı odada eski oturum temizlenip taze kimlik üretiliyor");
ok(/saveRoomSession\([^)]*claimToken\s*\)/.test(knm),
   "saveRoomSession claimToken'ı da yazıyor (inline kanonik)");

/* ════════════════════════════════════════════════════════════════════════
   7) Sunucu DEĞİŞMEDİ
   ════════════════════════════════════════════════════════════════════════ */
console.log("\n7) Sunucu sözleşmesi değişmedi");
ok(!/create or replace function/i.test(app + knm),
   "istemci dosyalarında SQL fonksiyon tanımı yok");
ok(!/service_role|supabaseAdmin|SERVICE_ROLE/.test(app + knm),
   "service-role kullanımı yok");

/* ──────────────────────────────────────────────────────────────────────── */
console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} geçti, ${failed} kaldı\n`);
process.exit(failed === 0 ? 0 : 1);
