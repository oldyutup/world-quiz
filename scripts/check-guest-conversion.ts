/**
 * check-guest-conversion.ts
 *
 * MİSAFİR → KAYITLI slot devrinin (guest → registered conversion) SÖZLEŞMESİNİ
 * saf/DB'siz doğrular. Gerçek Supabase ve tarayıcı GEREKMEZ.
 *
 * NEDEN VAR: devir eskiden `authPromptReason === "guest-signup"` + `screen`
 * eşlemesine bağlıydı. Bu koşul yalnız modal İÇİNDE biten girişlerde doğruydu;
 * e-posta kaydı (doğrulama maili) ve web OAuth redirect'i sayfayı baştan
 * yüklediği için React state'i siliniyor ve devir HİÇ çalışmıyordu
 * (audit C1/C2/M1). Bu script o regresyonun geri gelmesini engeller.
 *
 * Kapsam:
 *   1. Tetikleyici bağımsızlığı — devir geçici UI state'ine bağlı DEĞİL.
 *   2. resolveGuestLinkTargets — saf aday çözümleyici (8 mod + Kuşatma claim'leri).
 *   3. Retry sınıflandırması — hangi hata tekrar denenir, hangisi kesindir.
 *   4. M3 — misafir-kökenli maç işareti MAÇ BAŞINDA konur (lobide DEĞİL).
 *   5. Drift koruması — paylaşılan önek + 6 XP modunun tamamı bağlı mı?
 *
 * Çalıştır:  npx tsx scripts/check-guest-conversion.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Node'da localStorage yok → minimal bellek-içi taklit. guestSession import
// EDİLMEDEN önce kurulur (modül üst düzeyi localStorage'a dokunmasa da,
// fonksiyonlar ilk çağrıda buna güvenir).
(globalThis as unknown as { localStorage?: Storage }).localStorage ??= (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  } as Storage;
})();

import {
  resolveGuestLinkTargets,
  readStoredConquestClaims,
  isTransientLinkFailure,
  shouldMarkGuestOriginMatch,
  noteGuestOriginMatch,
  isGuestMatchId,
  clearGuestMatchIds,
  CONQUEST_CLAIM_KEY_PREFIX,
  type GuestLinkTarget,
  type ModeRoomSession,
} from "../src/lib/guestSession";
import type { RoomCodeModeKey } from "../src/lib/roomCodeShared";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}
function eq(a: unknown, b: unknown, label: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, a);
}

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), "utf8");

const appSrc          = read("../src/App.tsx");
const guestSessionSrc = read("../src/lib/guestSession.ts");
const conquestClaim   = read("../src/modes/conquest/conquestClaim.ts");
const conquestMode    = read("../src/modes/conquest/ConquestMode.tsx");

/** Test yardımcısı: sahte oturum okuyucu üretir. */
function sessionReader(
  map: Partial<Record<RoomCodeModeKey, Partial<ModeRoomSession>>>
) {
  const seen: RoomCodeModeKey[] = [];
  const fn = (mode: RoomCodeModeKey): ModeRoomSession | null => {
    seen.push(mode);
    const s = map[mode];
    if (!s) return null;
    return {
      roomId: s.roomId ?? "",
      roomCode: s.roomCode ?? "",
      playerId: s.playerId ?? "",
      claimToken: s.claimToken ?? "",
    };
  };
  return { fn, seen };
}
const noConquestClaims = (): GuestLinkTarget[] => [];

/* ════════════════════════════════════════════════════════════════════════
   1) TETİKLEYİCİ BAĞIMSIZLIĞI — asıl regresyon koruması
════════════════════════════════════════════════════════════════════════ */
console.log("\n1) Devir tetikleyicisi geçici UI state'ine bağlı DEĞİL");

ok(!appSrc.includes("SCREEN_TO_ROOM_MODE["),
   "ekran→mod eşlemesi devir için ARTIK kullanılmıyor (OAuth dönüşünde screen='home' oluyordu)");

// `guest-signup` dalı hâlâ var (ekranı değiştirmeme görevi sürüyor) ama artık
// devri O tetiklemiyor. Dalın gövdesinde link çağrısı OLMAMALI.
const guestSignupBranch =
  appSrc.split('authPromptReason === "guest-signup"')[1]?.slice(0, 400) ?? "";
ok(guestSignupBranch.length > 0, "guest-signup dalı hâlâ mevcut (ekran korunuyor)");
ok(!/link(ActiveGuestSession|GuestPlayerToAccount)/.test(guestSignupBranch),
   "guest-signup dalı devri ARTIK tetiklemiyor");

// Uzlaştırma effect'i auth DURUMUNA bağlı olmalı.
ok(/resolveGuestLinkTargets\(\)/.test(appSrc),
   "App aday listesini kalıcı oturumdan çözüyor (resolveGuestLinkTargets)");
const reconcileDeps = appSrc.match(/guestLinkSettledRef[\s\S]{0,1600}?\}, \[([^\]]*)\]\);/);
ok(!!reconcileDeps, "uzlaştırma effect'i bulundu");
ok(!!reconcileDeps && /profile\?\.id/.test(reconcileDeps[1]),
   "uzlaştırma `profile?.id` (auth durumu) ile tetikleniyor", reconcileDeps?.[1]);
ok(!!reconcileDeps && !/authPromptReason|screen/.test(reconcileDeps[1]),
   "uzlaştırma authPromptReason/screen'e BAĞLI DEĞİL", reconcileDeps?.[1]);

// Geçici hata kilitlenmemeli (audit m2).
ok(/outcome\.status !== "error"[\s\S]{0,80}guestLinkSettledRef\.current\.add/.test(appSrc),
   "yalnız KESİN sonuç kilitleniyor; geçici ağ hatası tekrar denenebilir");

/* ── CTA ULAŞILABİLİRLİĞİ — devrin TETİKLENEBİLDİĞİNİ garanti eder ───────
 * Auth modalı ESKİDEN yalnız `screen === "home"` dalında render ediliyordu.
 * Oyun ekranları renderScreen() içinde kendi JSX'leriyle ERKEN return ettiği
 * için, misafirin oyun-sonu "Hesap Oluştur" CTA'sı `authOpen`i true yapıyor
 * ama HİÇBİR modal açılmıyordu → devir hiç başlayamıyordu. Tarayıcı testi bunu
 * yakaladı. Modal artık renderProfileEditModals ile aynı GLOBAL mount
 * deseninde; bu assert geri kaymayı engeller. */
ok(/const renderAuthModals = \(\) =>/.test(appSrc),
   "auth modalları ayrı bir render yardımcısına çıkarıldı");
ok(/\{renderScreen\(\)\}[\s\S]{0,120}\{renderAuthModals\(\)\}/.test(appSrc),
   "auth modalları renderScreen'in YANINDA global mount ediliyor (her ekranda açılabilir)");
const homeBranch = appSrc.split('if (screen === "home")')[1]?.split('if (screen === "duel-game")')[0] ?? "";
ok(homeBranch.length > 0 && !/<AuthModal/.test(homeBranch),
   "AuthModal home dalının İÇİNDE render EDİLMİYOR (oyun ekranlarında da gerekli)");
ok(!/<NicknameModal/.test(homeBranch),
   "NicknameModal da home dalına hapsedilmemiş");

/* ════════════════════════════════════════════════════════════════════════
   2) resolveGuestLinkTargets — saf aday çözümleyici
════════════════════════════════════════════════════════════════════════ */
console.log("\n2) Aday çözümleyici (saf)");

{
  const { fn, seen } = sessionReader({});
  eq(resolveGuestLinkTargets(fn, noConquestClaims), [],
     "oturum yoksa aday YOK → gereksiz hiçbir iş yapılmaz");
  // Devir sözleşmesi olan 8 mod taranmalı (conquest ayrı yoldan gelir).
  const expected: RoomCodeModeKey[] = [
    "duel", "flagDuel", "duelGroup", "flagGroup",
    "wheelDuel", "wheelGroup", "routeDuel", "korNokta",
  ];
  eq([...seen].sort(), [...expected].sort(),
     "oda oturumu tutan 8 modun hepsi taranıyor");
}

{
  const { fn } = sessionReader({
    korNokta: { playerId: "p-kn", claimToken: "t-kn", roomId: "r-kn" },
  });
  eq(resolveGuestLinkTargets(fn, noConquestClaims),
     [{ mode: "korNokta", playerId: "p-kn", claimToken: "t-kn" }],
     "tek aktif oturum → tek aday (doğru playerId + claimToken)");
}

{
  const { fn } = sessionReader({
    korNokta: { playerId: "p-kn", claimToken: "t-kn" },
    wheelGroup: { playerId: "p-wg", claimToken: "t-wg" },
  });
  const targets = resolveGuestLinkTargets(fn, noConquestClaims);
  ok(targets.length === 2, "birden çok mod oturumu → hepsi aday", targets.length);
}

{
  // claimToken'ı olmayan yarım oturum devredilemez.
  const { fn } = sessionReader({ korNokta: { playerId: "p-kn", claimToken: "" } });
  eq(resolveGuestLinkTargets(fn, noConquestClaims), [],
     "claim_token'sız yarım oturum aday DEĞİL (sunucu zaten reddederdi)");
  const { fn: fn2 } = sessionReader({ korNokta: { playerId: "", claimToken: "t" } });
  eq(resolveGuestLinkTargets(fn2, noConquestClaims), [],
     "player_id'siz oturum aday DEĞİL");
}

{
  // KUŞATMA: claim anahtarları localStorage'dan okunur → OAuth reload'undan
  // sağ çıkar. Bu, Kuşatma'yı diğer 8 modla AYNI yola sokar (audit I).
  localStorage.clear();
  localStorage.setItem(CONQUEST_CLAIM_KEY_PREFIX + "cq-player-1", "cq-token-1");
  localStorage.setItem("alakasiz_anahtar", "yoksayilmali");
  const claims = readStoredConquestClaims();
  eq(claims, [{ mode: "conquest", playerId: "cq-player-1", claimToken: "cq-token-1" }],
     "Kuşatma claim anahtarı adaya çevriliyor; ilgisiz anahtarlar yoksayılıyor");

  const { fn } = sessionReader({ korNokta: { playerId: "p-kn", claimToken: "t-kn" } });
  const targets = resolveGuestLinkTargets(fn, readStoredConquestClaims);
  ok(targets.length === 2 && targets.some(t => t.mode === "conquest"),
     "Kör Nokta oturumu + Kuşatma claim'i birlikte aday oluyor", targets);
  localStorage.clear();
}

{
  // Aynı (mod, playerId) iki kaynaktan gelirse tek aday olmalı.
  const dup = (): GuestLinkTarget[] => [
    { mode: "conquest", playerId: "dup", claimToken: "t1" },
    { mode: "conquest", playerId: "dup", claimToken: "t1" },
  ];
  const { fn } = sessionReader({});
  ok(resolveGuestLinkTargets(fn, dup).length === 1,
     "aynı slot iki kez listelenmiyor (tekilleştirme)");
}

/* ════════════════════════════════════════════════════════════════════════
   3) RETRY SINIFLANDIRMASI
════════════════════════════════════════════════════════════════════════ */
console.log("\n3) Hata sınıflandırması (retry kararı)");

// torble_link_guest_player'ın KESİN cevapları — tekrar denemek anlamsız.
for (const [code, why] of [
  ["42501", "auth_required / not_a_guest_row / claim_mismatch"],
  ["22023", "mode_invalid / claim_token_required"],
  ["02000", "player_not_found"],
  ["P0001", "already_in_room"],
] as const) {
  ok(!isTransientLinkFailure(code), `${code} KESİN sonuç → retry YOK (${why})`);
}
ok(isTransientLinkFailure(undefined), "kodsuz (ağ/taşıma) hata → geçici, retry edilir");
ok(isTransientLinkFailure(null), "null kod → geçici sayılır");
ok(isTransientLinkFailure("08006"), "bilinmeyen kod → geçici sayılır (devri sessizce kaybetmemek için)");

ok(/GUEST_LINK_RETRY_DELAY_MS/.test(guestSessionSrc) &&
   /attemptGuestLink\(params\)[\s\S]{0,400}attempts: 2/.test(guestSessionSrc),
   "en fazla 1 kontrollü retry (toplam 2 deneme)");
// İmzalara bakılır (düz metne değil): iki giriş noktası da outcome döndürmeli.
ok(/linkGuestPlayerToAccount\([\s\S]{0,200}?\): Promise<GuestLinkOutcome>/.test(guestSessionSrc),
   "linkGuestPlayerToAccount ayrıştırılabilir outcome döndürüyor (boolean DEĞİL)");
ok(/linkActiveGuestSession\([\s\S]{0,120}?\): Promise<GuestLinkOutcome>/.test(guestSessionSrc),
   "linkActiveGuestSession gerçek sonucu döndürüyor (boolean DEĞİL)");
ok(/console\.warn\(\s*`\[guestLink\]/.test(guestSessionSrc),
   "başarısızlık sessizce yutulmuyor (teşhis kaydı + uyarı)");

/* ════════════════════════════════════════════════════════════════════════
   4) M3 — misafir-kökenli maç işareti
════════════════════════════════════════════════════════════════════════ */
console.log("\n4) M3: retroaktif XP koruması maç BAŞINDA kuruluyor");

const G = (matchStarted: boolean, isGuest: boolean) =>
  shouldMarkGuestOriginMatch("m1", { matchStarted, isGuest });

ok(G(true, true),   "maç başladı + oyuncu misafir → İŞARETLE (asıl düzeltme)");
ok(!G(false, true),  "LOBİDE misafir → işaretleme (lobide hesap açan XP'sini hak eder, kural 10)");
ok(!G(true, false),  "maç başladı + oyuncu kayıtlı → işaretleme (kayıtlı maç misafir sayılmaz)");
ok(!G(false, false), "lobi + kayıtlı → işaretleme");
ok(!shouldMarkGuestOriginMatch(null, { matchStarted: true, isGuest: true }),
   "maç kimliği yoksa işaretleme");
ok(!shouldMarkGuestOriginMatch("", { matchStarted: true, isGuest: true }),
   "boş maç kimliği işaretlenmez");

{
  // ── ASIL SENARYO: maç ORTASINDA hesap açma ──
  clearGuestMatchIds();
  const MATCH = "match-ortasinda-kayit";
  // 1) Misafir olarak maç başlıyor.
  noteGuestOriginMatch(MATCH, { matchStarted: true, isGuest: true });
  ok(isGuestMatchId(MATCH), "misafirken BAŞLAYAN maç anında işaretlendi");
  // 2) Oyuncu maç ortasında hesap açıyor → artık kayıtlı.
  noteGuestOriginMatch(MATCH, { matchStarted: true, isGuest: false });
  ok(isGuestMatchId(MATCH),
     "hesap açmak GEÇMİŞ işareti KALDIRMAZ → o maça retroaktif XP yazılmaz (kural 9)");
  // 3) Sonraki maç yeni kimlik taşır → normal kazanır.
  const NEXT = "match-sonraki";
  noteGuestOriginMatch(NEXT, { matchStarted: true, isGuest: false });
  ok(!isGuestMatchId(NEXT),
     "dönüşüm SONRASI yeni maç işaretli DEĞİL → normal XP yazılır (kural 10)");
  // 4) Lobide dönüşen oyuncunun maçı hiç işaretlenmez.
  const LOBBY = "match-lobide-kayit";
  noteGuestOriginMatch(LOBBY, { matchStarted: false, isGuest: true });
  noteGuestOriginMatch(LOBBY, { matchStarted: true, isGuest: false });
  ok(!isGuestMatchId(LOBBY),
     "lobide hesap açıp maça giren oyuncu XP'sini hak ediyor");
  clearGuestMatchIds();
}

/* ════════════════════════════════════════════════════════════════════════
   5) DRIFT KORUMASI
════════════════════════════════════════════════════════════════════════ */
console.log("\n5) Drift koruması");

ok(/import \{ CONQUEST_CLAIM_KEY_PREFIX as KEY_PREFIX \}/.test(conquestClaim),
   "conquestClaim.ts paylaşılan öneki import ediyor (ikinci literal YOK)");
ok(!/["']conquest:claim:["']/.test(conquestClaim),
   "conquestClaim.ts'te kopya önek literali kalmadı");

// XP yazan ve misafire açık 6 mod: hepsi maç başında işaretlemeli.
const xpModes: Array<[string, string]> = [
  ["DuelGame",       "../src/components/DuelGame.tsx"],
  ["FlagDuelGame",   "../src/components/FlagDuelGame.tsx"],
  ["WheelDuelGame",  "../src/components/WheelDuelGame.tsx"],
  ["WheelGroupGame", "../src/components/WheelGroupGame.tsx"],
  ["ConquestGame",   "../src/modes/conquest/ConquestGame.tsx"],
  ["KorNoktaGame",   "../src/modes/korNokta/KorNoktaGame.tsx"],
];
for (const [name, path] of xpModes) {
  const src = read(path);
  ok(/noteGuestOriginMatch\(/.test(src), `${name} maç başında işaretleme yapıyor`);
  ok(/isGuestMatchId\(/.test(src), `${name} bitişteki guard'ı KORUYOR (iki yol birbirinin yedeği)`);
}

// Kuşatma'nın yerinde tetikleyicisi geçici hatada kalıcı kilit yaratmamalı.
ok(/outcome\.status === "error"[\s\S]{0,160}linkAttemptedRef\.current = null/.test(conquestMode),
   "ConquestMode geçici hatada ref kilidini AÇIYOR (audit m2)");
ok(/outcome\.status !== "linked"/.test(conquestMode),
   "ConquestMode yalnız gerçekten bağlandıysa satırı tazeliyor");

/* ════════════════════════════════════════════════════════════════════════
   6) M2 MIGRATION SÖZLEŞMESİ (20260814120000)
   DRIFT UYARISI: bu bölüm migration'ın aynasıdır. SQL değişirse burası da.
════════════════════════════════════════════════════════════════════════ */
console.log("\n6) M2 migration sözleşmesi (oda bazında serileştirme)");

const raceMig = read("../supabase/migrations/20260814120000_link_guest_player_room_lock.sql");

ok(/perform pg_advisory_xact_lock\(/.test(raceMig),
   "oda bazında advisory lock alınıyor");
ok(/hashtextextended\(\s*v_players_table \|\| ':' \|\| v_room_id::text, 0\s*\)/.test(raceMig),
   "kilit anahtarı (tablo + room_id)'den türetiliyor");
ok(/xact/.test(raceMig) && !/pg_advisory_lock\(/.test(raceMig),
   "transaction kapsamlı kilit (commit/rollback'te otomatik bırakılır, sızdırmaz)");

// Kilit, duplicate kontrolünden ÖNCE alınmalı — asıl düzeltme bu sıradır.
const lockIdx = raceMig.indexOf("pg_advisory_xact_lock");
const dupIdx  = raceMig.indexOf("into v_dup using v_room_id");
ok(lockIdx > 0 && dupIdx > lockIdx,
   "kilit, 'odada başka satırım var mı' kontrolünden ÖNCE alınıyor");

// `for update` ile kanonik okuma kilitten SONRA olmalı. (Başlıktaki açıklama
// metninde de "for update" geçtiği için KOD satırı hedeflenir, düz metin değil.)
const forUpdateIdx = raceMig.indexOf(
  "'select room_id, profile_id, guest_id from public.%I where id = $1 for update'"
);
ok(forUpdateIdx > lockIdx,
   "satır kilidi advisory lock'tan SONRA alınıyor (tek yönlü kilit hiyerarşisi: oda → satır)");

// Kilidi beklerken satır silinmiş olabilir → kontrol tekrarlanmalı.
ok((raceMig.match(/raise exception 'player_not_found'/g) ?? []).length === 2,
   "player_not_found kontrolü kilitten önce VE sonra yapılıyor (satır silinme yarışı)");

// Güvenlik yüzeyi birebir korunmalı.
for (const [needle, label] of [
  ["security definer",                    "SECURITY DEFINER korundu"],
  ["set search_path = public, auth",      "search_path sabitlemesi korundu"],
  ["raise exception 'auth_required'",     "auth_required dalı korundu"],
  ["raise exception 'not_a_guest_row'",   "not_a_guest_row dalı korundu"],
  ["raise exception 'claim_mismatch'",    "claim_mismatch dalı korundu"],
  ["raise exception 'already_in_room'",   "already_in_room dalı korundu"],
  ["raise exception 'mode_invalid'",      "mode_invalid dalı korundu"],
  ["if v_profile_id = v_uid then",        "idempotentlik korundu"],
  ["if v_guest_id is null then",          "tombstone reddi korundu"],
] as const) {
  ok(raceMig.includes(needle), label);
}

// Tablo adı kullanıcı girdisinden TÜREMEZ.
ok(/case p_mode[\s\S]*?when 'korNokta'\s+then v_players_table := 'tevatur_players'/.test(raceMig),
   "sabit CASE tablo eşlemesi korundu (SQL injection yüzeyi yok)");
ok((raceMig.match(/when '(duel|flagDuel|duelGroup|wheelDuel|wheelGroup|flagGroup|routeDuel|conquest|korNokta)'/g) ?? []).length === 9,
   "9 modun hepsi eşlemede");

// Grant'lar: anon KAPALI kalmalı (revoke from public TEK BAŞINA yetmez).
ok(/revoke execute on function public\.torble_link_guest_player\(text, uuid, uuid\) from anon;/.test(raceMig),
   "anon EXECUTE açıkça revoke ediliyor (public revoke tek başına yetmez)");
ok(/grant  execute on function public\.torble_link_guest_player\(text, uuid, uuid\) to   authenticated;/.test(raceMig),
   "authenticated EXECUTE korunuyor");

// İmza değişmemeli → istemci değişikliği gerekmez.
ok(/create or replace function public\.torble_link_guest_player\(\s*p_mode\s+text,\s*p_player_id\s+uuid,\s*p_claim_token uuid\s*\) returns boolean/.test(raceMig),
   "imza (text,uuid,uuid)→boolean AYNI (istemci değişikliği gerekmiyor)");

// Ön koşul + uygulama sonrası doğrulama.
ok(/to_regprocedure\('public\.torble_link_guest_player\(text,uuid,uuid\)'\) is null/.test(raceMig),
   "ön koşul: fonksiyon canlıda beklenen imzayla var mı denetleniyor");
ok(/DOĞRULAMA: anon EXECUTE hâlâ AÇIK/.test(raceMig),
   "uygulama sonrası otomatik doğrulama anon grant'ını denetliyor");

ok("20260814120000" > "20260809120000" && "20260814120000" > "20260813120000",
   "migration bağımlılıklarından SONRA sıralanıyor");

// Eşzamanlılık testi dosyası şemaya uymalı (yanlış sabit = test hiç koşmaz).
const raceTest = read("../supabase/tests/check_link_guest_player_race.sql");
// INSERT'lerin kendisi hedeflenir (açıklama metninde 'lobby' kelimesi geçiyor).
ok((raceTest.match(/, 'waiting'\);/g) ?? []).length === 2 &&
   !/, 'lobby'\);/.test(raceTest),
   "test INSERT'leri tevatur_rooms.status enum'una uyuyor ('waiting')");
ok(/'Silinmiş#' \|\| substr\(md5\(v_p3::text\), 1, 7\)/.test(raceTest),
   "tombstone satırının adı kimlik kısıtının gerektirdiği gibi id'den türetiliyor");
ok(/rollback;/.test(raceTest),
   "TEST A kalıcı iz bırakmadan geri alınıyor");

/* ════════════════════════════════════════════════════════════════════════ */
console.log(
  failed === 0
    ? `\n✅ ${passed} passed, 0 failed\n`
    : `\n❌ ${passed} passed, ${failed} FAILED\n`
);
process.exit(failed === 0 ? 0 : 1);
