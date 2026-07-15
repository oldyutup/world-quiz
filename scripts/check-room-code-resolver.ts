/**
 * check-room-code-resolver.ts
 *
 * Merkezî oda-kodu çözümleyicisinin (resolve_torble_room_code +
 * src/lib/roomCode*) SÖZLEŞMESİNİ saf/DB'siz doğrular. Gerçek Supabase GEREKMEZ:
 * SQL'in eşleştirme mantığı burada birebir modellenir (simulateResolve) ve
 * client tarafı normalizasyon/mod kayıt defteri gerçek roomCodeShared.ts'ten
 * import edilerek test edilir.
 *
 * DRIFT UYARISI: simulateResolve, 20260801120000_room_code_resolver.sql'deki
 * aktif-oda kriteri + mod sınıflandırmasının aynasıdır. SQL değişirse burası da
 * güncellenmeli.
 *
 * Çalıştır:  npx tsx scripts/check-room-code-resolver.ts
 */
import {
  normalizeRoomCode,
  isProbablyValidRoomCode,
  isRoomCodeModeKey,
  ROOM_CODE_MODE_LABELS,
  type RoomCodeModeKey,
} from "../src/lib/roomCodeShared";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
  else { failed++; console.log(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}
function eq(a: unknown, b: unknown, label: string) { ok(JSON.stringify(a) === JSON.stringify(b), label, a); }

/* ════════════════════════════════════════════════════════════════════════
   SUNUCU MANTIĞININ AYNASI — resolve_torble_room_code
   Her <mode>_rooms.code kendi tablosunda UNIQUE (tablo başına ≤1 satır);
   modlar arası çakışma birden fazla eşleşme (ambiguous) üretir.
════════════════════════════════════════════════════════════════════════ */
type RoomTable =
  | "duel_rooms"
  | "wheel_duel_rooms"
  | "duel_group_rooms"
  | "wheel_group_rooms"
  | "flag_group_rooms"
  | "tevatur_rooms"
  | "conquest_rooms";

interface FixtureRoom {
  table:        RoomTable;
  code:         string;       // depolanan kod (normalize edilmiş, uppercase)
  status:       string;       // waiting | waiting_rematch | playing | finished | closed
  /** yalnız duel_rooms: SUNUCU-OTORİTER mod discriminator'ı. Create RPC'leri
   *  yazar ('country'/'flag'); null = migration-öncesi legacy satır. */
  roomKind?:    "country" | "flag" | null;
  /** yalnız duel_rooms: CANLI şemada column_default = 10 (nullable YES).
   *  Mod ayrımı için KULLANILMAZ (eski total_rounds-NULL varsayımı canlı
   *  default yüzünden çürüdü) — yalnız kanıtlı legacy backfill'e girer. */
  totalRounds?: number | null;
}

// SQL'deki normalizasyon: trim → yalnız A-Z0-9 → upper (SLICE YOK; uzunluk
// tam 6 değilse invalid). Client normalizeRoomCode ise 6'ya kırpar (input
// maxLength=6 olduğu için pratikte fark oluşmaz).
function serverNormalize(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function roomIsActive(r: FixtureRoom): boolean {
  if (r.table === "conquest_rooms") return r.status !== "finished" && r.status !== "closed";
  return r.status !== "finished";
}

/** SQL'deki union-branch aynası: duel_rooms satırı room_kind'a göre 1 mod
 *  (country→duel, flag→flagDuel) üretir; room_kind NULL (legacy) İKİ branch'e
 *  de düşer → [duel, flagDuel] ⟹ ambiguous (sessiz yanlış yönlendirme yok). */
function roomModes(r: FixtureRoom): RoomCodeModeKey[] {
  switch (r.table) {
    case "duel_rooms":
      if (r.roomKind === "country") return ["duel"];
      if (r.roomKind === "flag")    return ["flagDuel"];
      return ["duel", "flagDuel"];  // legacy: discriminator yok → her ikisi
    case "wheel_duel_rooms":  return ["wheelDuel"];
    case "duel_group_rooms":  return ["duelGroup"];
    case "wheel_group_rooms": return ["wheelGroup"];
    case "flag_group_rooms":  return ["flagGroup"];
    case "tevatur_rooms":     return ["korNokta"];
    case "conquest_rooms":    return ["conquest"];
  }
}

/** Migration'daki KANITLI legacy backfill'in aynası: yalnız room_kind IS NULL
 *  + total_rounds IN (5,15,20) satırlar 'flag' olur (canlı default=10 →
 *  Ülke Yaz asla 5/15/20 taşıyamaz; total_rounds'u yazan tek aile flag_duel_*).
 *  total_rounds=10 AYIRT EDİLEMEZ → dokunulmaz (tahmin backfill'i yasak). */
function backfillRoomKind(r: FixtureRoom): FixtureRoom {
  if (r.table !== "duel_rooms") return r;
  if (r.roomKind != null) return r;
  if (r.totalRounds === 5 || r.totalRounds === 15 || r.totalRounds === 20) {
    return { ...r, roomKind: "flag" };
  }
  return r;
}

type SimResult =
  | { result: "invalid" }
  | { result: "not_found"; code: string }
  | { result: "found"; code: string; mode: RoomCodeModeKey }
  | { result: "ambiguous"; code: string; modes: RoomCodeModeKey[] };

function simulateResolve(raw: string | null | undefined, rooms: FixtureRoom[]): SimResult {
  const norm = serverNormalize(raw);
  if (norm == null || norm.length !== 6) return { result: "invalid" };

  const modes: RoomCodeModeKey[] = [];
  for (const r of rooms) {
    const roomCode = r.code; // conquest room_code dahil hepsi aynı değer alanı
    if (roomCode === norm && roomIsActive(r)) modes.push(...roomModes(r));
  }
  if (modes.length === 0) return { result: "not_found", code: norm };
  if (modes.length === 1) return { result: "found", code: norm, mode: modes[0] };
  return { result: "ambiguous", code: norm, modes };
}

/* ════════════════════════════════════════════════════════════════════════
   CLIENT YÖNLENDİRME SÖZLEŞMESİ — App.routeToResolvedRoom'un aynası.
   Her mod anahtarı → (davet param'ı, açılan ekran). Bunlar MEVCUT invite/join
   akışıyla birebir aynıdır (ONLINE_INVITE_LINKS + conquest/korNokta path).
════════════════════════════════════════════════════════════════════════ */
const ROUTE: Record<RoomCodeModeKey, { param: string; screen: string }> = {
  duel:       { param: "duel",       screen: "duel-game" },
  flagDuel:   { param: "flagDuel",   screen: "flag-duel-game" },
  wheelDuel:  { param: "wheelDuel",  screen: "wheel-duel-game" },
  duelGroup:  { param: "duelGroup",  screen: "duel-group-game" },
  wheelGroup: { param: "wheelGroup", screen: "wheel-group-game" },
  flagGroup:  { param: "flagGroup",  screen: "flag-group-game" },
  korNokta:   { param: "korNokta",   screen: "kornokta-join" },
  conquest:   { param: "conquest",   screen: "conquest-join" },
};

/* ── Fixture'lar ── benzersiz kodlar (aynı kodu iki tabloya koymak ambiguous).
 * KRİTİK: yeni Ülke Yaz odası CANLI default yüzünden totalRounds=10 TAŞIR
 * (create RPC kolonu yazmasa da). Ayrım artık YALNIZ roomKind'dan gelir. */
const F: Record<string, FixtureRoom> = {
  countryDuel: { table: "duel_rooms",        code: "AAA111", status: "waiting", roomKind: "country", totalRounds: 10 },
  flagDuel:    { table: "duel_rooms",        code: "BBB222", status: "waiting", roomKind: "flag",    totalRounds: 10 },
  wheelDuel:   { table: "wheel_duel_rooms",  code: "CCC333", status: "playing" },
  duelGroup:   { table: "duel_group_rooms",  code: "DDD444", status: "waiting" },
  wheelGroup:  { table: "wheel_group_rooms", code: "EEE555", status: "waiting" },
  flagGroup:   { table: "flag_group_rooms",  code: "FFF666", status: "waiting" },
  korNokta:    { table: "tevatur_rooms",     code: "GGG777", status: "waiting" },
  conquest:    { table: "conquest_rooms",    code: "HHH888", status: "waiting" },
  // 'playing' odalar da eşleşir (kapasite/başladı kararı join RPC'nin işi):
  playingCountryDuel: { table: "duel_rooms", code: "PLY333", status: "playing", roomKind: "country", totalRounds: 10 },
  playingFlagDuel:    { table: "duel_rooms", code: "PLY444", status: "playing", roomKind: "flag",    totalRounds: 5 },
  // Kapanmış / bitmiş odalar (eşleşmemeli):
  finishedFlagGroup: { table: "flag_group_rooms", code: "FIN000", status: "finished" },
  closedConquest:    { table: "conquest_rooms",   code: "CLS000", status: "closed" },
  finishedDuel:      { table: "duel_rooms",        code: "FIN111", status: "finished", roomKind: "country", totalRounds: 10 },
  finishedLegacyDuel:{ table: "duel_rooms",        code: "FIN222", status: "finished", roomKind: null,      totalRounds: 10 },
  // Aynı kod iki modda (ambiguous senaryosu): flagGroup + wheelGroup
  ambFlagGroup:  { table: "flag_group_rooms",  code: "DUP999", status: "waiting" },
  ambWheelGroup: { table: "wheel_group_rooms", code: "DUP999", status: "waiting" },
  // Dolu ama aktif oda (kapasiteyi resolver DEĞİL, join RPC reddeder):
  fullFlagGroup: { table: "flag_group_rooms",  code: "FUL222", status: "waiting" },
  // Migration-öncesi LEGACY duel_rooms satırı (roomKind NULL, default 10):
  legacyDuel:    { table: "duel_rooms",        code: "LEG555", status: "waiting", roomKind: null, totalRounds: 10 },
};
const ALL = Object.values(F);

console.log("\n▶ Oda-kodu çözümleyici sözleşmesi\n");

/* 1) Her aktif Torble room-code modu doğru mode'a çözülüyor.
 *    Ülke Yaz fixture'ı CANLI default senaryosunu taşır: totalRounds=10
 *    olmasına rağmen roomKind='country' olduğu için duel'e çözülür (eski
 *    total_rounds-NULL varsayımı bu satırda flagDuel derdi → kök neden). */
console.log("· 1. Her mod doğru anahtara çözülüyor");
eq(simulateResolve("AAA111", ALL), { result: "found", code: "AAA111", mode: "duel" }, "duel_rooms (room_kind='country', total_rounds=10 canlı default) → duel");
eq(simulateResolve("BBB222", ALL), { result: "found", code: "BBB222", mode: "flagDuel" }, "duel_rooms (room_kind='flag') → flagDuel");
eq(simulateResolve("CCC333", ALL), { result: "found", code: "CCC333", mode: "wheelDuel" }, "wheel_duel_rooms → wheelDuel");
eq(simulateResolve("DDD444", ALL), { result: "found", code: "DDD444", mode: "duelGroup" }, "duel_group_rooms → duelGroup");
eq(simulateResolve("EEE555", ALL), { result: "found", code: "EEE555", mode: "wheelGroup" }, "wheel_group_rooms → wheelGroup");
eq(simulateResolve("GGG777", ALL), { result: "found", code: "GGG777", mode: "korNokta" }, "tevatur_rooms → korNokta");
eq(simulateResolve("HHH888", ALL), { result: "found", code: "HHH888", mode: "conquest" }, "conquest_rooms → conquest");

/* 2) Geçerli Bayrak Bilmece (flag group) kodu → doğru join akışına gider. */
console.log("· 2. Bayrak Bilmece (flagGroup) → flag-group join akışı");
{
  const r = simulateResolve("FFF666", ALL);
  ok(r.result === "found" && r.mode === "flagGroup", "flagGroup found");
  ok(ROUTE.flagGroup.param === "flagGroup" && ROUTE.flagGroup.screen === "flag-group-game", "flagGroup → ?flagGroup= / flag-group-game");
}

/* 3) Geçerli Çark kodu → doğru join akışına gider (1v1 & grup ayrık tablolar). */
console.log("· 3. Çark kodları doğru moda (duel/grup ayrımı)");
eq(simulateResolve("CCC333", ALL), { result: "found", code: "CCC333", mode: "wheelDuel" }, "Çark 1v1 kodu → wheelDuel");
eq(simulateResolve("EEE555", ALL), { result: "found", code: "EEE555", mode: "wheelGroup" }, "Çark Grup kodu → wheelGroup");

/* 4) Diğer aktif grup modları doğru join akışına gider. */
console.log("· 4. Diğer grup modları");
ok(simulateResolve("DDD444", ALL).result === "found", "Ülke Yaz Grup found");
ok(ROUTE.duelGroup.screen === "duel-group-game", "duelGroup → duel-group-game");
ok(ROUTE.wheelGroup.screen === "wheel-group-game", "wheelGroup → wheel-group-game");
ok(ROUTE.conquest.screen === "conquest-join", "conquest → conquest-join");
ok(ROUTE.korNokta.screen === "kornokta-join", "korNokta → kornokta-join");

/* 5) Geçersiz karakter/uzunluk → invalid. */
console.log("· 5. Geçersiz karakter/uzunluk → invalid");
eq(simulateResolve("abc", ALL), { result: "invalid" }, "3 karakter → invalid");
eq(simulateResolve("ABCDEFG", ALL), { result: "invalid" }, "7 alfanümerik → invalid (SLICE yok)");
eq(simulateResolve("!!@@##", ALL), { result: "invalid" }, "sembol → strip sonrası boş → invalid");
// Client tarafı: maxLength=6 + normalize aynı sonuca varır.
ok(!isProbablyValidRoomCode("abc"), "client: 'abc' geçersiz");
ok(!isProbablyValidRoomCode(""), "client: boş geçersiz");
ok(isProbablyValidRoomCode(" aaa111 "), "client: ' aaa111 ' (trim+upper) geçerli");

/* 6) Boş kod → invalid. */
console.log("· 6. Boş / null kod → invalid");
eq(simulateResolve("", ALL), { result: "invalid" }, "boş string → invalid");
eq(simulateResolve("   ", ALL), { result: "invalid" }, "yalnız boşluk → invalid");
eq(simulateResolve(null, ALL), { result: "invalid" }, "null → invalid");

/* 7) Var olmayan kod → not_found. */
console.log("· 7. Var olmayan kod → not_found");
eq(simulateResolve("ZZZZZZ", ALL), { result: "not_found", code: "ZZZZZZ" }, "eşleşmeyen kod → not_found");

/* 8) Silinmiş/kapanmış oda eşleşmiyor. */
console.log("· 8. Kapanmış/bitmiş oda 'found' göstermez");
eq(simulateResolve("FIN000", ALL), { result: "not_found", code: "FIN000" }, "finished flag group → not_found");
eq(simulateResolve("CLS000", ALL), { result: "not_found", code: "CLS000" }, "closed conquest → not_found");
eq(simulateResolve("FIN111", ALL), { result: "not_found", code: "FIN111" }, "finished duel → not_found");
eq(simulateResolve("FIN222", ALL), { result: "not_found", code: "FIN222" }, "finished LEGACY duel (room_kind NULL) → not_found (ambiguous bile değil)");
// "Silinmiş oda" = satır yok → doğal olarak not_found (fixture'da hiç yok):
eq(simulateResolve("NOROOM", ALL), { result: "not_found", code: "NOROOM" }, "silinmiş/olmayan oda → not_found");

/* 9) Aynı kod iki modda → ambiguous. */
console.log("· 9. Aynı kod iki tabloda → ambiguous");
{
  const r = simulateResolve("DUP999", ALL);
  ok(r.result === "ambiguous", "iki eşleşme → ambiguous");
  if (r.result === "ambiguous") {
    ok(r.modes.length === 2 && r.modes.includes("flagGroup") && r.modes.includes("wheelGroup"),
      "ambiguous modlar: flagGroup + wheelGroup", r.modes);
  }
}

/* 10) Ambiguous seçiminden sonra doğru mevcut join akışı çağrılıyor. */
console.log("· 10. Ambiguous seçim → o modun mevcut join akışı");
{
  const r = simulateResolve("DUP999", ALL);
  if (r.result === "ambiguous") {
    for (const m of r.modes) {
      ok(!!ROUTE[m], `seçilen mod '${m}' için yönlendirme tanımlı`);
    }
    // Kullanıcı flagGroup seçerse → flag-group-game ekranı + ?flagGroup=DUP999.
    ok(ROUTE.flagGroup.screen === "flag-group-game", "flagGroup seçimi doğru ekrana gider");
  }
}

/* 11) Oda doluysa: resolver yine 'found' der, kapasiteyi join RPC reddeder. */
console.log("· 11. Dolu ama aktif oda → resolver 'found' (kapasite join RPC'nin işi)");
eq(simulateResolve("FUL222", ALL), { result: "found", code: "FUL222", mode: "flagGroup" },
  "dolu 'waiting' oda yine found — nihai karar mod-özel join RPC'de");

/* 11b) 'playing' duel_rooms odaları da room_kind'dan doğru moda çözülür. */
console.log("· 11b. 'playing' oda → yine found + doğru mod");
eq(simulateResolve("PLY333", ALL), { result: "found", code: "PLY333", mode: "duel" },
  "playing Ülke Yaz odası (room_kind='country') → duel");
eq(simulateResolve("PLY444", ALL), { result: "found", code: "PLY444", mode: "flagDuel" },
  "playing Bayrak odası (room_kind='flag') → flagDuel");

/* 11c) LEGACY duel_rooms satırı (migration-öncesi, room_kind NULL):
   SESSİZCE bir moda yönlendirilmez — İKİ eşleşme (duel + flagDuel) üretilir,
   sonuç 'ambiguous' → client seçim modalı gösterir, kullanıcı karar verir.
   Legacy odalar bitince (finished) doğal olarak kaybolur. */
console.log("· 11c. Legacy (room_kind NULL) duel satırı → ambiguous, sessiz yönlendirme yok");
{
  const r = simulateResolve("LEG555", ALL);
  ok(r.result === "ambiguous", "legacy satır → ambiguous (found DEĞİL)");
  if (r.result === "ambiguous") {
    eq(r.modes, ["duel", "flagDuel"], "ambiguous modlar: duel + flagDuel (SQL ord sırası)");
    ok(r.modes.every((m) => !!ROUTE[m]), "iki seçenek de mevcut yönlendirmeye sahip");
  }
}

/* 11d) KANITLI legacy backfill aynası (migration §7):
   total_rounds ∈ {5,15,20} → 'flag' (Ülke Yaz canlı default=10 dışında değer
   taşıyamaz); total_rounds=10 → DOKUNULMAZ (ayırt edilemez, tahmin yasak);
   room_kind zaten dolu satır → değişmez (idempotent). */
console.log("· 11d. Kanıtlı legacy backfill (yalnız total_rounds 5/15/20 → flag)");
{
  const legacy15: FixtureRoom = { table: "duel_rooms", code: "BFL111", status: "waiting", roomKind: null, totalRounds: 15 };
  const legacy10: FixtureRoom = { table: "duel_rooms", code: "BFL222", status: "waiting", roomKind: null, totalRounds: 10 };
  const already: FixtureRoom  = { table: "duel_rooms", code: "BFL333", status: "waiting", roomKind: "country", totalRounds: 10 };
  eq(backfillRoomKind(legacy15).roomKind, "flag", "legacy total_rounds=15 → 'flag' (kanıtlı)");
  eq(backfillRoomKind(legacy10).roomKind, null, "legacy total_rounds=10 → NULL kalır (ayırt edilemez)");
  eq(backfillRoomKind(already).roomKind, "country", "dolu room_kind'a backfill dokunmaz (idempotent)");
  // Backfill sonrası çözümleme: 15'lik legacy artık tek moda (flagDuel) düşer,
  // 10'luk legacy ambiguous kalır.
  const after = [legacy15, legacy10].map(backfillRoomKind);
  eq(simulateResolve("BFL111", after), { result: "found", code: "BFL111", mode: "flagDuel" },
    "backfill sonrası 15'lik legacy → found/flagDuel");
  ok(simulateResolve("BFL222", after).result === "ambiguous",
    "backfill sonrası 10'luk legacy → hâlâ ambiguous");
}

/* 11e) Lowercase / trim / ayraçlı girdi normalize edilip aynı sonuca varır. */
console.log("· 11e. lowercase/trim/ayraç normalizasyonu");
eq(simulateResolve("  aaa111 ", ALL), { result: "found", code: "AAA111", mode: "duel" },
  "'  aaa111 ' → trim+upper → duel");
eq(simulateResolve("leg-555", ALL).result, "ambiguous",
  "'leg-555' → ayraç strip + upper → legacy ambiguous");
eq(simulateResolve("bbb222", ALL), { result: "found", code: "BBB222", mode: "flagDuel" },
  "'bbb222' → upper → flagDuel");

/* 12) Giriş yapmamış kullanıcı: kod login sonrası aynı şekilde çözülür.
   Guest akışında ham kod normalize edilip session'da saklanır; login sonrası
   AYNI değerle çözüm tekrarlanır. normalize idempotent olmalı. */
console.log("· 12. Guest → login sonrası aynı kod (normalize idempotent)");
{
  const typed = "  fff666 ";
  const stored = normalizeRoomCode(typed);        // App guest dalında saklanan değer
  eq(stored, "FFF666", "saklanan kod normalize");
  eq(normalizeRoomCode(stored), stored, "normalize idempotent");
  const r = simulateResolve(stored, ALL);
  ok(r.result === "found" && r.mode === "flagGroup", "login sonrası aynı koda devam → flagGroup");
}

/* 13) Enter yalnız bir submit oluşturuyor + 14) çift submit engelleniyor.
   Bar/sheet'teki busy-guard mantığının küçük durum-makinesi modeli. */
console.log("· 13-14. busy-guard: tek submit / çift-submit engeli");
{
  let busy = false;
  let submits = 0;
  const submit = () => {
    if (busy) return;            // guard: ikinci eşzamanlı submit düşürülür
    if (!isProbablyValidRoomCode("ABC123")) return;
    busy = true;                 // async iş başlar (henüz çözülmedi)
    submits++;
  };
  submit();                      // Enter
  submit();                      // hızlı ikinci Enter/tık (busy iken)
  eq(submits, 1, "iki ardışık submit → yalnız 1 gerçek çağrı");
  busy = false;                  // iş bitti
  submit();                      // artık yeni submit serbest
  eq(submits, 2, "iş bitince yeni submit serbest");
}

/* 15-18) Yapısal UI sözleşmeleri (DOM olmadan doğrulanabilenler). */
console.log("· 15-18. Yapısal sözleşmeler (kayıt defteri / yönlendirme bütünlüğü)");
{
  const keys = Object.keys(ROOM_CODE_MODE_LABELS) as RoomCodeModeKey[];
  eq(keys.length, 8, "8 aktif oda-kodlu mod (Eshle hariç)");
  ok(keys.every(k => typeof ROOM_CODE_MODE_LABELS[k] === "string" && ROOM_CODE_MODE_LABELS[k].length > 0),
    "her modun kullanıcıya gösterilecek adı var");
  ok(keys.every(k => !!ROUTE[k]), "her mod anahtarı için yönlendirme tanımlı (koddan lobiye)");
  ok(!("eshle" in ROOM_CODE_MODE_LABELS) && !("cizim" in ROOM_CODE_MODE_LABELS), "Eshle dahil değil");
  // 15/16/17: input Hızlı Eşleş solunda, Rekorlar Sıralama'nın adı değil, Rekorlar
  // tıklanamaz — bunlar DOM/CSS düzeyinde (App.tsx sırası + <div aria-disabled>).
  // Burada yalnız mod-anahtar kümesinin sohbet/rekor ile karışmadığını doğrularız.
  ok(!keys.some(k => (k as string) === "records" || (k as string) === "leaderboard"),
    "resolver Rekorlar/Sıralama ile karışmıyor (ayrı özellikler)");
}

/* 19) Mevcut invite linkleri bozulmuyor: mod anahtarları = davet param adları. */
console.log("· 19. Davet linki param'ları ile mod anahtarları birebir");
{
  const inviteParams = ["duel", "flagDuel", "wheelDuel", "duelGroup", "wheelGroup", "flagGroup", "korNokta", "conquest"];
  const keys = Object.keys(ROOM_CODE_MODE_LABELS).sort();
  eq(keys, [...inviteParams].sort(), "mod anahtarları = mevcut invite param kümesi");
  ok((Object.keys(ROUTE) as RoomCodeModeKey[]).every(k => ROUTE[k].param === k),
    "her modun param'ı kendi anahtarı (URL ?param=KOD tutarlı)");
}

/* 20) Bayrak/Çark sohbet namespace sistemleri etkilenmiyor: resolver koda göre
   yalnız MOD bulur; sohbet anahtarlaması (flag_group:<code> vs plain) ayrı
   katmandır. Resolver dönüşünde chat/namespace alanı YOK. */
console.log("· 20. Sohbet namespace'i resolver'dan bağımsız");
{
  const r = simulateResolve("FFF666", ALL) as { result: string } & Record<string, unknown>;
  ok(!("chat" in r) && !("namespace" in r) && !("roomKey" in r),
    "resolver dönüşünde sohbet/namespace alanı yok");
}

/* ── Client ⟷ server normalize uyumu (temiz 6-hane girdide fark yok) ── */
console.log("· +. Client ⟷ sunucu normalize uyumu (temiz girdi)");
for (const c of ["AAA111", "bbb222", " ccc333 ", "d-d-d444"]) {
  const cli = normalizeRoomCode(c);
  const srv = serverNormalize(c);
  ok(cli === srv, `'${c}' → client(${cli}) === server(${srv})`);
}
ok(isRoomCodeModeKey("flagGroup") && !isRoomCodeModeKey("nope"), "isRoomCodeModeKey guard");

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
