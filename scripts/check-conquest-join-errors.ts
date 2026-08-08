/**
 * check-conquest-join-errors.ts
 *
 * Kuşatma KATILMA HATASI sözleşmesini saf/DB'siz doğrular. Gerçek Supabase
 * GEREKMEZ.
 *
 * NEDEN VAR:
 * Sunucu misafir nick'ini reddettiğinde (`registered_username_taken`) oyuncu
 * oda kodu + nick formundan düşüp "Oda Kur" ekranına atılıyordu; yazdığı kod
 * ve nick de siliniyordu. Kök neden `ConquestMode.applyJoinResult` hata
 * dalındaki koşulsuz `setPhase("setup")` idi. Karar saf
 * `conquestJoinFlow.resolveConquestJoinFailure`e taşındı; bu script o
 * fonksiyonun DEĞİŞMEZLERİNİ kilitler:
 *
 *   1. Hata sonrası faz ASLA "setup" değildir (ana menü / oda kurma yok).
 *   2. Denenen oda kodu ve nick taslakta AYNEN korunur.
 *   3. Her sunucu hata kodu kullanıcıya gösterilebilir bir Türkçe metne çevrilir.
 *   4. Ad kaynaklı retlerde odak ad alanına döner.
 *   5. Bu kural HER İKİ katılma yolu için de geçerlidir (form + davet linki).
 *
 * GÜVENLİK: buradaki hiçbir assert bir kontrolü gevşetmez. Kayıtlı-username
 * koruması sunucudadır; test yalnız REDDİN doğru ekranda gösterildiğini
 * doğrular — reddin kendisini değil.
 *
 * Çalıştır:  npx tsx scripts/check-conquest-join-errors.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  mapConquestJoinFailure,
  resolveConquestJoinFailure,
  conquestFail,
  CONQUEST_JOIN_FAIL_MESSAGES,
  type ConquestJoinOrigin,
} from "../src/modes/conquest/conquestJoinFlow";

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

/* ════════════════════════════════════════════════════════════════════════
   1) Sunucu hata kodu → kullanıcı metni
   ════════════════════════════════════════════════════════════════════════ */
console.log("\n1) Sunucu hata kodu → Türkçe kullanıcı metni");

// Postgres hata metninin gerçek biçimi: koda ek olarak gürültü içerir.
const raw = (code: string) =>
  `new row violates ... ${code} ... (SQLSTATE P0001)`;

const registered = mapConquestJoinFailure(raw("registered_username_taken"));
ok(registered.reason === "name", "registered_username_taken → reason 'name'", registered.reason);
eq(
  registered.message,
  "Bu kullanıcı adı kayıtlı bir hesaba ait. Başka bir ad seç veya hesabına giriş yap.",
  "registered_username_taken → doğru metin",
);

const forbidden = mapConquestJoinFailure(raw("display_name_forbidden"));
ok(forbidden.reason === "name", "display_name_forbidden → reason 'name'", forbidden.reason);
eq(forbidden.message, "Bu kullanıcı adı kullanılamaz. Lütfen farklı bir ad seç.",
   "display_name_forbidden → doğru metin");

const nameTaken = mapConquestJoinFailure(raw("name_taken"));
ok(nameTaken.reason === "name", "name_taken → reason 'name'", nameTaken.reason);
eq(nameTaken.message, "Bu kullanıcı adı odada kullanılıyor. Başka bir kullanıcı adı seç.",
   "name_taken → doğru metin");

const nameInvalid = mapConquestJoinFailure(raw("name_invalid"));
ok(nameInvalid.reason === "name", "name_invalid → reason 'name'", nameInvalid.reason);
eq(nameInvalid.message, "Kullanıcı adı 2-16 karakter olmalı.", "name_invalid → doğru metin");

// SIRA TUZAĞI: "registered_username_taken" metni "name_taken" alt dizesini
// İÇERİR. Yanlış sırada denenirse kayıtlı-hesap reddi "odada kullanılıyor"
// diye gösterilir ve kullanıcı neden reddedildiğini anlamaz.
ok(
  raw("registered_username_taken").includes("name_taken"),
  "ön koşul: registered_username_taken metni name_taken içerir",
);
ok(
  mapConquestJoinFailure(raw("registered_username_taken")).message !== nameTaken.message,
  "registered_username_taken, name_taken'dan ÖNCE eşleşir (sıra doğru)",
);

eq(mapConquestJoinFailure(raw("room_full")).reason, "full", "room_full → reason 'full'");
eq(mapConquestJoinFailure(raw("room_in_progress")).reason, "started", "room_in_progress → 'started'");
eq(mapConquestJoinFailure(raw("room_unavailable")).reason, "closed", "room_unavailable → 'closed'");
eq(mapConquestJoinFailure(raw("room_not_found")).reason, "not-found", "room_not_found → 'not-found'");
eq(mapConquestJoinFailure(raw("already_in_room")).message, "Bu odaya zaten katıldın.",
   "already_in_room → doğru metin");

// Bilinmeyen hata: ham metin yedeğe düşer ama mesaj ASLA boş kalmaz.
ok(mapConquestJoinFailure("boom").message.length > 0, "bilinmeyen hata → boş olmayan mesaj");
eq(mapConquestJoinFailure("", "").message, "Odaya katılınamadı.", "boş hata → varsayılan metin");

// Her sebebin bir metni var (sessiz başarısızlık yok).
for (const [reason, msg] of Object.entries(CONQUEST_JOIN_FAIL_MESSAGES)) {
  ok(typeof msg === "string" && msg.length > 0, `"${reason}" sebebinin metni dolu`);
}

/* ════════════════════════════════════════════════════════════════════════
   2) ANA DEĞİŞMEZ — hata sonrası formdan DÜŞÜLMEZ
   ════════════════════════════════════════════════════════════════════════ */
console.log("\n2) Hata sonrası ekran + taslak korunması");

const ATTEMPT = { code: "KX7P2Q", name: "enes" };

/** Kullanıcının karşılaşabileceği tüm sunucu retleri. */
const ALL_FAILURES = [
  "registered_username_taken",
  "display_name_forbidden",
  "name_taken",
  "name_invalid",
  "room_full",
  "room_in_progress",
  "room_unavailable",
  "room_not_found",
  "already_in_room",
] as const;

/** İki Kuşatma katılma yolu + açık oda listesi. */
const ORIGINS: ConquestJoinOrigin[] = ["code", "invite", "public"];

for (const origin of ORIGINS) {
  for (const code of ALL_FAILURES) {
    const outcome = resolveConquestJoinFailure(
      origin,
      ATTEMPT,
      mapConquestJoinFailure(raw(code)),
    );

    // (1) ASLA setup/ana menü.
    ok(
      (outcome.phase as string) !== "setup",
      `[${origin}/${code}] faz "setup" DEĞİL`,
      outcome.phase,
    );
    // (2) Oda kodu korunur.
    eq(outcome.draft.code, ATTEMPT.code, `[${origin}/${code}] oda kodu korunur`);
    // (3) Nick korunur.
    eq(outcome.draft.name, ATTEMPT.name, `[${origin}/${code}] nick korunur`);
    // (4) Mesaj boş değil.
    ok(outcome.message.length > 0, `[${origin}/${code}] hata mesajı dolu`);
  }
}

// Yol bazlı hedef ekran: form yolları formda kalır, liste yolu listede kalır.
for (const code of ALL_FAILURES) {
  const fail = mapConquestJoinFailure(raw(code));
  eq(resolveConquestJoinFailure("code",   ATTEMPT, fail).phase, "join-code",
     `[code/${code}] katılma formunda kalınır`);
  eq(resolveConquestJoinFailure("invite", ATTEMPT, fail).phase, "join-code",
     `[invite/${code}] katılma formuna düşülür (ana menüye DEĞİL)`);
  eq(resolveConquestJoinFailure("public", ATTEMPT, fail).phase, "rooms",
     `[public/${code}] oda listesinde kalınır`);
}

/* ════════════════════════════════════════════════════════════════════════
   3) Odak yönetimi — ad hatalarında ad alanına dön
   ════════════════════════════════════════════════════════════════════════ */
console.log("\n3) Ad kaynaklı retlerde odak ad alanına döner");

for (const code of ["registered_username_taken", "display_name_forbidden", "name_taken", "name_invalid"]) {
  const outcome = resolveConquestJoinFailure("code", ATTEMPT, mapConquestJoinFailure(raw(code)));
  ok(outcome.focusName, `[${code}] focusName = true`);
}
for (const code of ["room_full", "room_in_progress", "room_unavailable", "room_not_found"]) {
  const outcome = resolveConquestJoinFailure("code", ATTEMPT, mapConquestJoinFailure(raw(code)));
  ok(!outcome.focusName, `[${code}] focusName = false (ad sorunu değil)`);
}

/* ════════════════════════════════════════════════════════════════════════
   4) Uç durumlar
   ════════════════════════════════════════════════════════════════════════ */
console.log("\n4) Uç durumlar");

// Sunucu mesajsız bir ret döndürse bile kullanıcı boş bir hata görmez.
const blank = resolveConquestJoinFailure("code", ATTEMPT, { ok: false, reason: "full", message: "" });
eq(blank.message, CONQUEST_JOIN_FAIL_MESSAGES.full, "boş mesaj → sebebin varsayılan metni");

// Boş taslak da olduğu gibi taşınır (uydurma değer üretilmez).
const empty = resolveConquestJoinFailure("invite", { code: "", name: "" }, conquestFail("not-found"));
eq(empty.draft, { code: "", name: "" }, "boş taslak aynen taşınır");

// Taslak KOPYALANIR — çağıranın nesnesi mutasyona uğramaz.
const source = { code: "KAAAAA", name: "ada" };
const copied = resolveConquestJoinFailure("code", source, conquestFail("full"));
ok(copied.draft !== source, "taslak referansı kopyalanır (paylaşılan mutasyon yok)");
eq(copied.draft, source, "kopyalanan taslağın içeriği aynı");

/* ════════════════════════════════════════════════════════════════════════
   5) DRIFT KORUMASI — çağıran taraf hata dalında navigasyon yapmasın
   ════════════════════════════════════════════════════════════════════════
   Saf fonksiyon doğru olsa bile ConquestMode onu ATLAYIP tekrar
   `setPhase("setup")` derse hata geri gelir. Bu bölüm kaynak metnini
   kontrol eder — regresyon buradan sızmasın. */
console.log("\n5) ConquestMode / ConquestJoinByCode bağlantısı");

const modeSrc = read("../src/modes/conquest/ConquestMode.tsx");
const formSrc = read("../src/modes/conquest/ConquestJoinByCode.tsx");

ok(
  modeSrc.includes("resolveConquestJoinFailure"),
  "ConquestMode hata dalında saf karar fonksiyonunu kullanıyor",
);

// applyJoinResult'ın hata dalı: eski koşulsuz setPhase("setup") geri gelmemeli.
const applyBody = modeSrc.slice(
  modeSrc.indexOf("const applyJoinResult"),
  modeSrc.indexOf("const doAutoJoin"),
);
ok(applyBody.length > 0, "applyJoinResult gövdesi bulundu");
ok(
  !applyBody.includes('setPhase("setup")'),
  "applyJoinResult ARTIK setPhase(\"setup\") çağırmıyor (kök neden)",
);
ok(
  applyBody.includes("setPhase(outcome.phase)"),
  "applyJoinResult hedef fazı saf karardan alıyor",
);

// Form yolu "joining" fazına geçmemeli — geçerse form unmount olur ve
// kullanıcının yazdığı kod + nick kaybolur.
const byCodeBody = modeSrc.slice(
  modeSrc.indexOf("const handleJoinByCode"),
  modeSrc.indexOf("const handleJoinFromList"),
);
ok(byCodeBody.length > 0, "handleJoinByCode gövdesi bulundu");
ok(
  !byCodeBody.includes('setPhase("joining")'),
  "handleJoinByCode form fazını DEĞİŞTİRMİYOR (form monte kalır)",
);
ok(byCodeBody.includes("setJoinBusy(true)"), "handleJoinByCode yükleniyor durumunu buton üzerinde taşıyor");

// Form, ebeveynin hatasını ve taslağını gerçekten tüketiyor mu?
ok(formSrc.includes("initialName"), "ConquestJoinByCode nick taslağını alıyor");
ok(formSrc.includes("joinError"),   "ConquestJoinByCode ebeveyn hatasını alıyor");
ok(
  modeSrc.includes("initialName={joinDraft.name}") &&
  modeSrc.includes("initialCode={joinDraft.code}"),
  "ConquestMode taslağı forma geri veriyor (kod + nick)",
);
ok(
  modeSrc.includes("joinError={joinError}"),
  "ConquestMode hatayı forma geçiriyor (inline gösterim)",
);

/* ════════════════════════════════════════════════════════════════════════
   6) Üstteki yüzeyler — mobil sheet ve misafir nick ekranı da düşürmez
   ════════════════════════════════════════════════════════════════════════
   Kuşatma'ya varmadan ÖNCEKİ iki adım (oda kodu sheet'i ve misafir nick
   ekranı) de hata dalında kapanmamalı. Bu davranış zaten doğruydu; buradaki
   assertler geri gitmesini engeller. */
console.log("\n6) Oda kodu sheet'i + misafir nick ekranı hata dalı");

const sheetSrc = read("../src/components/RoomCodeJoin.tsx");
const guestSrc = read("../src/components/GuestJoinScreen.tsx");

// Sheet: hata → setError, yalnız "done" dalında onClose.
const sheetSubmit = sheetSrc.slice(
  sheetSrc.lastIndexOf("const submit = async"),
  sheetSrc.lastIndexOf("return createPortal"),
);
ok(sheetSubmit.length > 0, "RoomCodeSheet submit gövdesi bulundu");
ok(
  /out\.kind === "error"\)\s*\{\s*setError\(out\.message\);\s*\}\s*else\s*\{\s*onClose\(\)/.test(sheetSubmit),
  "mobil sheet: hata → açık kalır + mesaj; yalnız başarıda kapanır",
);
ok(
  !/setValue\(\s*""\s*\)/.test(sheetSubmit),
  "mobil sheet: hata dalında oda kodu SİLİNMİYOR",
);

// Misafir nick ekranı: sunucu reddinde erken return, onConfirm çağrılmaz.
// Bitiş çıpası JSX'in ilk satırı: "return (" kullanılamaz çünkü yukarıdaki
// useEffect temizleyicisi ("return () => …") ondan önce eşleşir.
const guestSubmit = guestSrc.slice(
  guestSrc.indexOf("const submit = async"),
  guestSrc.indexOf('className="auth-overlay'),
);
ok(guestSubmit.length > 0, "GuestJoinScreen submit gövdesi bulundu");
ok(
  guestSubmit.indexOf("setError(check.message)") < guestSubmit.indexOf("onConfirm(clean)"),
  "misafir nick ekranı: sunucu reddi onConfirm'den ÖNCE erken döner",
);
ok(
  !/onCancel\(\)/.test(guestSubmit),
  "misafir nick ekranı: hata dalında ekran KAPATILMIYOR",
);

/* ──────────────────────────────────────────────────────────────────────── */
console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} geçti, ${failed} kaldı\n`);
process.exit(failed === 0 ? 0 : 1);
