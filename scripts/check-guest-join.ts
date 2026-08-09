/**
 * check-guest-join.ts
 *
 * "Misafir Olarak Özel Odaya Katılma" sisteminin SÖZLEŞMESİNİ saf/DB'siz
 * doğrular. Gerçek Supabase GEREKMEZ.
 *
 * Kapsam:
 *   1. Misafir nick doğrulaması — kayıtlı oyuncuların oyun-içi ad kuralıyla
 *      AYNI fonksiyonu kullanıyor mu (iki ayrı doğrulama sistemi YOK)?
 *   2. Oda-içi çakışma normalizasyonu sunucunun `lower(btrim(name))`
 *      davranışının aynası mı? ("Enes" / "enes" / "  ENES  " aynı)
 *   3. Misafire açık mod listesi ile sunucu grant'ları tutarlı mı?
 *   4. Davet bağlantısı üretimi + native deep-link ayrıştırması.
 *   5. Migration sözleşmesi: oda kurma anon'a kapatıldı, resolver anon'a
 *      açıldı, oyuncu tablolarında ham INSERT yolu kaldı mı?
 *
 * DRIFT UYARISI: 5. bölüm 20260808120000_guest_room_join.sql'in aynasıdır.
 * SQL değişirse burası da güncellenmeli.
 *
 * Çalıştır:  npx tsx scripts/check-guest-join.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  validateGuestName,
  normalizeGuestName,
  sanitizeGuestName,
  isGuestJoinableMode,
  markGuestMatchId,
  isGuestMatchId,
  clearGuestMatchIds,
} from "../src/lib/guestSession";
import { INVITE_PARAM, modeFromInviteParam } from "../src/lib/inviteLink";
import { parseInviteFromUrl } from "../src/lib/deepLink";
// auth.ts bunu re-export eder; saf modülden import ediyoruz ki Node altında
// supabase/PNG bağımlılık zinciri yüklenmesin.
import { validateUsername } from "../src/lib/displayName";
import { ROOM_CODE_MODE_LABELS, type RoomCodeModeKey } from "../src/lib/roomCodeShared";

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
const migration = readFileSync(
  join(here, "../supabase/migrations/20260808120000_guest_room_join.sql"),
  "utf8"
);

/* ════════════════════════════════════════════════════════════════════════
   1) NICK DOĞRULAMA — tek ortak kural seti
════════════════════════════════════════════════════════════════════════ */
console.log("\n1) Misafir nick doğrulaması (kayıtlı kuralın aynısı)");

ok(validateGuestName("enes") === null, "geçerli nick kabul edilir");
ok(validateGuestName("çağrı_42") === null, "Türkçe karakter + alt çizgi kabul");
ok(validateGuestName("ab") !== null, "2 karakter reddedilir (min 3)");
ok(validateGuestName("a".repeat(17)) !== null, "17 karakter reddedilir (max 16)");
ok(validateGuestName("") !== null, "boş reddedilir");
ok(validateGuestName("   ") !== null, "yalnız boşluk reddedilir");
ok(validateGuestName("iki kelime") !== null, "boşluk içeren ad reddedilir");
ok(validateGuestName("admin") !== null, "yasaklı/otorite adı reddedilir");
ok(validateGuestName("enes.k") !== null, "nokta reddedilir (oyun-içi kural)");

// KRİTİK: misafir ve kayıtlı oyuncu AYNI fonksiyonu kullanmalı.
for (const sample of ["enes", "ab", "admin", "çağrı_42", "a".repeat(17), "enes.k"]) {
  const viaGuest = validateGuestName(sample);
  const viaShared = validateUsername(sanitizeGuestName(sample));
  ok(
    (viaGuest === null) === (viaShared === null),
    `"${sample}" → misafir ve kayıtlı doğrulayıcı AYNI sonucu veriyor`
  );
}

/* ════════════════════════════════════════════════════════════════════════
   2) ODA-İÇİ ÇAKIŞMA NORMALİZASYONU — sunucu aynası: lower(btrim(name))
════════════════════════════════════════════════════════════════════════ */
console.log("\n2) Oda-içi nick çakışma normalizasyonu (sunucu aynası)");

/** Sunucudaki `lower(btrim(name))` karşılaştırmasının birebir modeli. */
function serverNameKey(raw: string): string {
  return raw.replace(/^\s+|\s+$/g, "").toLocaleLowerCase("tr-TR");
}

const collisionSamples: [string, string][] = [
  ["Enes", "enes"],
  ["Enes", "  ENES  "],
  ["enes", "ENES"],
  ["Çağrı", "çağrı"],
];
for (const [a, b] of collisionSamples) {
  eq(normalizeGuestName(a), normalizeGuestName(b), `"${a}" ≡ "${b}" (client)`);
  eq(serverNameKey(a), serverNameKey(b), `"${a}" ≡ "${b}" (sunucu modeli)`);
}
ok(
  normalizeGuestName("Enes") !== normalizeGuestName("Enes2"),
  "farklı adlar çakışmaz"
);

/* ════════════════════════════════════════════════════════════════════════
   3) MİSAFİRE AÇIK MODLAR
════════════════════════════════════════════════════════════════════════ */
console.log("\n3) Misafire açık mod listesi");

const allModes = Object.keys(ROOM_CODE_MODE_LABELS) as RoomCodeModeKey[];
const guestOpen = allModes.filter(isGuestJoinableMode);
const guestClosed = allModes.filter((m) => !isGuestJoinableMode(m));

// 20260809120000: Kör Nokta da misafire açıldı → artık login-only mod YOK.
// Bu, ürün kuralının "oda koduyla/davetle katılma her modda misafire açıktır"
// hâlini kilitler. Yeni bir mod eklenip listeye konmazsa bu test düşer.
eq(guestClosed, [], "misafire kapalı mod KALMADI (Kör Nokta dâhil hepsi açık)");
ok(guestOpen.length === allModes.length,
   `${allModes.length} modun tamamı misafire açık`, guestOpen.length);
ok(isGuestJoinableMode("korNokta"), "korNokta misafire açık");
ok(isGuestJoinableMode("flagGroup"), "flagGroup misafire açık");

/* ════════════════════════════════════════════════════════════════════════
   4) DAVET BAĞLANTISI + DEEP LINK
════════════════════════════════════════════════════════════════════════ */
console.log("\n4) Davet bağlantısı ve deep-link ayrıştırma");

// Her modun bir davet parametresi olmalı ve geri eşleme kayıpsız olmalı.
for (const mode of allModes) {
  const param = INVITE_PARAM[mode];
  ok(!!param, `${mode} için davet parametresi tanımlı`);
  eq(modeFromInviteParam(param), mode, `${param} → ${mode} geri eşleme`);
}

// Native deep-link ayrıştırma (iOS Universal Link → appUrlOpen).
eq(
  parseInviteFromUrl("https://torble.com/?duel=AB12C3"),
  { mode: "duel", code: "AB12C3" },
  "https davet linki ayrıştırılır"
);
eq(
  parseInviteFromUrl("https://torble.com/?flagGroup=ab12c3"),
  { mode: "flagGroup", code: "AB12C3" },
  "küçük harf kod normalize edilir"
);
eq(
  parseInviteFromUrl("com.kavakgames.torble://auth-callback?code=xyz"),
  null,
  "auth callback deep-link'i YOK SAYILIR (googleAuth'a ait)"
);
eq(parseInviteFromUrl("https://torble.com/"), null, "parametresiz adres → null");
eq(parseInviteFromUrl("https://torble.com/?duel=SHORT"), null, "5 haneli kod reddedilir");
eq(parseInviteFromUrl("not a url"), null, "bozuk URL → null (throw etmez)");

/* ════════════════════════════════════════════════════════════════════════
   5) MIGRATION SÖZLEŞMESİ
════════════════════════════════════════════════════════════════════════ */
console.log("\n5) Migration sözleşmesi (20260808120000_guest_room_join.sql)");

ok(
  /grant execute on function public\.resolve_torble_room_code\(text\) to anon, authenticated;/.test(migration),
  "resolver misafire (anon) açılıyor"
);

const createRpcs = [
  "duel_create_room",
  "duel_group_create_room",
  "flag_duel_create_room",
  "flag_group_create_room",
  "route_duel_create_room",
  "wheel_duel_create_room",
  "wheel_group_create_room",
];
for (const fn of createRpcs) {
  const re = new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\)\\s+from anon;`);
  ok(re.test(migration), `${fn} → anon yetkisi geri alınıyor (misafir oda kuramaz)`);
}
ok(
  !/revoke execute on function public\.[a-z_]*create_room\([^)]*\)\s+from (anon, )?authenticated/.test(migration),
  "authenticated yetkisi KORUNUYOR (kayıtlı kullanıcı oda kurabilir)"
);

const playerTables = [
  "duel_players",
  "duel_group_players",
  "wheel_duel_players",
  "wheel_group_players",
  "flag_group_players",
  "conquest_players",
];
for (const t of playerTables) {
  const re = new RegExp(`revoke insert, update, delete on table public\\.${t}\\s+from anon, authenticated;`);
  ok(re.test(migration), `${t} → ham INSERT/UPDATE/DELETE yolu kapatılıyor`);
}
ok(
  !/revoke select/i.test(migration),
  "SELECT yetkisine DOKUNULMUYOR (lobi listesi + realtime çalışmaya devam eder)"
);

ok(
  /create or replace function public\.torble_link_guest_player/.test(migration),
  "slot devri RPC'si tanımlı"
);
ok(
  /grant  execute on function public\.torble_link_guest_player\(text, uuid, uuid\) to authenticated;/.test(migration),
  "slot devri RPC'si YALNIZ authenticated'a açık"
);
ok(
  /raise exception 'claim_mismatch'/.test(migration),
  "başka misafirin slotu devralınamaz (claim_token doğrulaması)"
);
ok(
  /raise exception 'already_in_room'/.test(migration),
  "aynı oyuncu odada iki kez görünemez"
);
ok(
  /raise exception 'not_a_guest_row'/.test(migration),
  "kayıtlı bir oyuncunun satırı devralınamaz"
);
ok(
  !/award_xp|xp_events|gold|profiles\s+set/i.test(
    migration.split("create or replace function public.torble_link_guest_player")[1] ?? ""
  ),
  "slot devri RPC'si XP/altın/ekonomi tablolarına DOKUNMUYOR"
);


/* ════════════════════════════════════════════════════════════════════════
   6) KAYITLI NICK KORUMASI — sunucu normalizasyonu (username_key aynası)
   ------------------------------------------------------------------------
   BULUNAN HATA: assert_display_name_allowed `lower(btrim(ad))` ile
   karşılaştırıyordu ama profiles.username_normalized `username_key()` ile
   üretiliyor (Türkçe/aksan katlamalı). Türkçe karakterli her kayıtlı ad
   misafirler tarafından taklit edilebiliyordu. Bu bölüm düzeltmenin
   sözleşmesini doğrular.
════════════════════════════════════════════════════════════════════════ */
console.log("\n6) Kayıtlı nick koruması (username_key normalizasyonu)");

/** public.username_key() birebir modeli (20260716120000). */
function usernameKey(raw: string): string {
  const FOLD: Record<string, string> = {
    "ç":"c","ğ":"g","ı":"i","ö":"o","ş":"s","ü":"u",
    "à":"a","á":"a","â":"a","ä":"a","ã":"a","å":"a",
    "è":"e","é":"e","ê":"e","ë":"e","ì":"i","í":"i","î":"i","ï":"i",
    "ò":"o","ó":"o","ô":"o","õ":"o","ù":"u","ú":"u","û":"u",
    "ñ":"n","ý":"y","ÿ":"y",
  };
  let v = (raw ?? "").replace(/^@+/, "").trim();
  v = v.replace(/[İIı]/g, "i").toLowerCase();
  return v.replace(/./g, (ch) => FOLD[ch] ?? ch);
}

// Migration, karşılaştırmayı username_key'e geçirmiş olmalı.
ok(
  /v_key\s*:=\s*public\.username_key\(v_trim\)/.test(migration),
  "assert_display_name_allowed artık username_key ile karşılaştırıyor"
);
ok(
  /where username_normalized = v_key/.test(migration),
  "karşılaştırma profiles.username_normalized ile AYNI anahtar üzerinden"
);
ok(
  !/v_norm\s*:=\s*lower\(v_trim\)/.test(migration),
  "eski (hatalı) lower(btrim()) karşılaştırması kaldırıldı"
);

// Kayıtlı "Çağrı" → username_normalized = 'cagri'.
const registeredKey = usernameKey("Çağrı");
eq(registeredKey, "cagri", "Türkçe kayıtlı ad 'cagri' anahtarına katlanıyor");

// Misafir varyasyonlarının HEPSİ aynı anahtarı üretmeli → hepsi engellenir.
for (const attempt of ["Çağrı", "çağrı", "  ÇAĞRI  ", "Cagri", "cagri", "CAGRI"]) {
  eq(usernameKey(attempt), registeredKey,
     `"${attempt}" kayıtlı adla AYNI anahtar → misafire kapalı`);
}
// Gerçekten farklı adlar engellenmemeli (yalnız TAM eşleşme).
for (const other of ["Çağrı41", "cagri_2", "cagriyilmaz"]) {
  ok(usernameKey(other) !== registeredKey,
     `"${other}" farklı anahtar → gereksiz yere engellenmiyor`);
}
// Noktalı/noktasız I.
eq(usernameKey("İbrahim"), usernameKey("ibrahim"),
   "İ/i varyasyonu aynı anahtar");

// Ön kontrol RPC'si sözleşmesi.
ok(
  /create or replace function public\.check_guest_display_name/.test(migration),
  "nick ön kontrol RPC'si tanımlı"
);
ok(
  /grant  execute on function public\.check_guest_display_name\(text\) to anon, authenticated;/.test(migration),
  "ön kontrol RPC'si anon'a açık (misafir nick ekranı çağırabilsin)"
);
for (const st of ["'registered'", "'forbidden'", "'invalid'", "'ok'"]) {
  ok(migration.includes(`return ${st}`), `ön kontrol ${st} durumunu döndürüyor`);
}

/* ════════════════════════════════════════════════════════════════════════
   7) MİSAFİR MAÇI / XP — MAÇ BAZLI işaret
   ------------------------------------------------------------------------
   Regresyon testi: eski global bayrak, kayıt sonrası AYNI odadaki YENİ turu
   da bastırıyordu. İşaret artık maç kimliğine bağlı.
════════════════════════════════════════════════════════════════════════ */
console.log("\n7) Misafir maçı XP koruması (maç bazlı)");

// Node'da localStorage yok → minimal bellek-içi taklit.
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

clearGuestMatchIds();
const MATCH_GUEST = "match-oynanan-misafir";
const MATCH_AFTER = "match-kayit-sonrasi";

ok(!isGuestMatchId(MATCH_GUEST), "başlangıçta hiçbir maç işaretli değil");
markGuestMatchId(MATCH_GUEST);
ok(isGuestMatchId(MATCH_GUEST), "misafirken biten maç işaretlendi → XP yazılmaz");

// ✅ ASIL REGRESYON: kayıt sonrası AYNI odadaki YENİ tur XP kazanmalı.
ok(!isGuestMatchId(MATCH_AFTER),
   "kayıt sonrası YENİ tur işaretli DEĞİL → XP normal yazılır");

markGuestMatchId(MATCH_GUEST);
ok(isGuestMatchId(MATCH_GUEST), "aynı maçı iki kez işaretlemek güvenli (idempotent)");
ok(!isGuestMatchId(null) && !isGuestMatchId(undefined) && !isGuestMatchId(""),
   "boş/eksik maç kimliği asla 'misafir maçı' sayılmaz");

// Her XP yazan mod, misafirken maç kimliğini işaretlemeli ve sonra kontrol etmeli.
const XP_MODES: [string, string][] = [
  ["src/components/DuelGame.tsx", "room.id"],
  ["src/components/FlagDuelGame.tsx", "matchIdRef.current"],
  ["src/components/WheelDuelGame.tsx", "room.current_match_id"],
  ["src/components/WheelGroupGame.tsx", "room.current_match_id"],
  ["src/modes/conquest/ConquestGame.tsx", "matchKey"],
  ["src/modes/korNokta/KorNoktaGame.tsx", "room.id"],
];
for (const [file, id] of XP_MODES) {
  const src = readFileSync(join(here, "..", file), "utf8");
  ok(src.includes(`markGuestMatchId(${id})`), `${file}: misafir maçı işaretleniyor (${id})`);
  ok(src.includes(`isGuestMatchId(${id})`), `${file}: XP öncesi maç bazlı kontrol var`);
  ok(!src.includes("isGuestMatchActive"), `${file}: eski global bayrak KALDIRILDI`);
}

/* ════════════════════════════════════════════════════════════════════════
   8) DEEP LINK GÜVENLİĞİ
════════════════════════════════════════════════════════════════════════ */
console.log("\n8) Deep link güvenliği");

eq(parseInviteFromUrl("https://evil.example.com/?duel=AB12C3"), null,
   "YABANCI host reddedilir (oda kodu enjeksiyonu yok)");
eq(parseInviteFromUrl("https://torble.com.evil.net/?duel=AB12C3"), null,
   "benzer-görünen host reddedilir");
eq(parseInviteFromUrl("javascript:alert(1)//?duel=AB12C3"), null,
   "javascript: şeması reddedilir (JS injection)");
eq(parseInviteFromUrl("file:///etc/passwd?duel=AB12C3"), null,
   "file: şeması reddedilir");
eq(parseInviteFromUrl("https://www.torble.com/?duel=AB12C3"),
   { mode: "duel", code: "AB12C3" }, "www. varyantı kabul edilir");
eq(parseInviteFromUrl("https://torble.com/?duel=AB12C3&redirect=https://evil.com"),
   { mode: "duel", code: "AB12C3" },
   "beklenmeyen query parametreleri YOK SAYILIR (open redirect yok)");
// Kod DAİMA sterilize edilir (A-Z0-9, tam 6). Uygulamanın her yerinde
// kullanılan normalizeRoomCode ile aynı davranış: kullanıcı "AB-12-C3"
// yapıştırabilsin diye ayraçlar atılır. Güvenlik açısından önemli olan
// ÇIKTININ her zaman güvenli karakter kümesinde olmasıdır.
const injected = parseInviteFromUrl("https://torble.com/?duel=<script>x</script>");
ok(injected === null || /^[A-Z0-9]{6}$/.test(injected.code),
   "kod her zaman sterilize edilir (script/işaret karakteri taşınmaz)",
   injected);
ok(
  ["<", ">", "/", "'", '"'].every((c) => !(injected?.code ?? "").includes(c)),
  "sterilize edilmiş kodda HTML/JS işaret karakteri kalmaz"
);
eq(parseInviteFromUrl("https://torble.com/?duel=AB12C3XXXX"),
   { mode: "duel", code: "AB12C3" },
   "6'dan uzun kod ilk 6 karaktere kırpılır (taşma yok)");

const deepLinkSrc = readFileSync(join(here, "../src/lib/deepLink.ts"), "utf8");
ok(/lastHandled/.test(deepLinkSrc),
   "aynı bağlantı iki kez işlenmez (cold-start + appUrlOpen tekilleştirmesi)");
ok(/isTrustedInviteHost/.test(deepLinkSrc), "host allowlist uygulanıyor");

/* ════════════════════════════════════════════════════════════════════════
   9) ODA KURMA / SLOT DEVRİ İSTEMCİ SÖZLEŞMESİ
════════════════════════════════════════════════════════════════════════ */
console.log("\n9) İstemci tarafı ürün kuralları");

const CREATE_GUARDED = [
  "src/components/DuelGame.tsx", "src/components/FlagDuelGame.tsx",
  "src/components/DuelGroupGame.tsx", "src/components/FlagGroupGame.tsx",
  "src/components/WheelDuelGame.tsx", "src/components/WheelGroupGame.tsx",
  "src/components/routeDuel/RouteDuelGame.tsx",
];
for (const f of CREATE_GUARDED) {
  const src = readFileSync(join(here, "..", f), "utf8");
  ok(src.includes("GUEST_CANNOT_CREATE_MESSAGE"), `${f}: misafir oda kuramaz mesajı bağlı`);
}

// Kayıtlı-nick hata metni tüm modlarda AYNI ve net olmalı.
const NICK_MSG = "Bu kullanıcı adı kayıtlı bir hesaba ait.";
// RouteDuelGame kendi hata metnini routeDuelShared.ts'ten alır → listede o var.
// Kuşatma'nın hata metinleri conquestService'ten SAF conquestJoinFlow modülüne
// taşındı (Supabase'siz test edilebilsin diye) — metnin kendisi değişmedi.
const NICK_FILES = [...CREATE_GUARDED.filter((f) => !f.includes("RouteDuelGame")),
                    "src/lib/routeDuelShared.ts",
                    "src/modes/conquest/conquestJoinFlow.ts"];
for (const f of NICK_FILES) {
  const src = readFileSync(join(here, "..", f), "utf8");
  ok(src.includes(NICK_MSG), `${f}: kayıtlı-nick mesajı net ve tek biçim`);
}

// Misafir etiketi tüm misafire-açık modlarda render edilmeli.
const TAG_FILES = [
  "src/components/DuelGame.tsx", "src/components/FlagDuelGame.tsx",
  "src/components/DuelGroupGame.tsx", "src/components/FlagGroupGame.tsx",
  "src/components/WheelDuelGame.tsx", "src/components/WheelGroupGame.tsx",
  "src/components/routeDuel/RouteDuelLobby.tsx",
  "src/modes/conquest/ConquestLobby.tsx",
];
for (const f of TAG_FILES) {
  const src = readFileSync(join(here, "..", f), "utf8");
  ok(/<GuestTag/.test(src), `${f}: "Misafir" etiketi render ediliyor`);
  ok(/!p\.profile_?[Ii]d/.test(src), `${f}: etiket SUNUCU satırından (profile_id) türetiliyor`);
}

// Oyun sonu metni yanıltıcı olmamalı.
const gepSrc = readFileSync(join(here, "../src/components/GuestEndPrompt.tsx"), "utf8");
ok(gepSrc.includes("Torble'a devam etmek için hesap oluştur"), "oyun-sonu başlığı dürüst metin");
ok(!gepSrc.includes("Bu maçtaki ilerlemeni kaydet"),
   "yanıltıcı 'bu maçtaki ilerlemeni kaydet' metni KULLANILMIYOR");
ok(gepSrc.includes("Zaten hesabın var mı? Giriş Yap"), "mevcut hesaba giriş seçeneği var");

// Ön koşul denetimi migration'da olmalı.
ok(/ÖN KOŞUL EKSİK/.test(migration),
   "migration eksik bağımlılıkta net hata verip durur (sessiz bozulma yok)");


/* ════════════════════════════════════════════════════════════════════════
   10) KUŞATMA "ODALARA GÖZ AT" — SUNUCU YETKİSİ
   ------------------------------------------------------------------------
   ÖNCESİ: liste, istemciden doğrudan conquest_rooms tablosuna atılan bir
   PostgREST sorgusuydu; tek engel React'teki isLoggedIn bayrağıydı — yani
   sunucuda HİÇBİR kontrol yoktu. Bu bölüm yeni sözleşmeyi doğrular.

   DRIFT UYARISI: 20260809120000_guest_browse_gate_and_kornokta.sql'in
   aynasıdır. SQL değişirse burası da güncellenmeli.
════════════════════════════════════════════════════════════════════════ */
console.log("\n10) Kuşatma açık oda listesi — sunucu yetkisi");

const mig2 = readFileSync(
  join(here, "../supabase/migrations/20260809120000_guest_browse_gate_and_kornokta.sql"),
  "utf8"
);

ok(/create or replace function public\.conquest_list_public_rooms/.test(mig2),
   "liste RPC'si tanımlı");
ok(/grant  execute on function public\.conquest_list_public_rooms\(\) to authenticated;/.test(mig2),
   "liste RPC'si authenticated'a açık");
ok(!/conquest_list_public_rooms\(\) to anon/.test(mig2),
   "liste RPC'si anon'a AÇILMAMIŞ (misafir listeleyemez)");

// Sessiz boş liste DEĞİL, açık yetki hatası.
const listBody = mig2.split("create or replace function public.conquest_list_public_rooms")[1] ?? "";
ok(/if auth\.uid\(\) is null then[\s\S]{0,120}raise exception 'auth_required'/.test(listBody),
   "misafir çağrısı boş liste değil 'auth_required' alır");

// Tek-oda çözümleyici misafire açık ama havuzu TARAYAMAZ.
ok(/create or replace function public\.conquest_find_room_by_code/.test(mig2),
   "tek-oda çözümleyici tanımlı");
ok(/grant  execute on function public\.conquest_find_room_by_code\(text\) to anon, authenticated;/.test(mig2),
   "tek-oda çözümleyici misafire açık (oda koduyla katılma çalışsın)");
const findBody = mig2.split("create or replace function public.conquest_find_room_by_code")[1] ?? "";
ok(/length\(v_norm\) <> 6/.test(findBody),
   "çözümleyici 6 haneli olmayan kodda satır DÖNDÜRMEZ");
ok(/limit 1/.test(findBody),
   "çözümleyici en fazla TEK satır döndürür (liste değil)");
// PL/pgSQL tuzağı: SELECT INTO satır bulamazsa kayıt "hepsi NULL" olur ve
// `return v_room` PostgREST'e SQL NULL değil {"id":null,...} gönderir.
ok(/if not found then\s+return null;/.test(findBody),
   "oda bulunamayınca SQL NULL döner (alanları NULL olan nesne DEĞİL)");
ok(!/visibility\s*=\s*'public'/.test(findBody),
   "çözümleyici açık oda havuzunu taramıyor");

// İstemci artık tabloyu doğrudan sorgulamamalı.
const svc = readFileSync(join(here, "../src/modes/conquest/conquestService.ts"), "utf8");
ok(svc.includes('supabase.rpc("conquest_list_public_rooms")'),
   "conquestService liste için RPC kullanıyor");
ok(/supabase\.rpc\(\s*"conquest_find_room_by_code"/.test(svc),
   "conquestService oda kodu için RPC kullanıyor");
ok(!/\.eq\("visibility", "public"\)/.test(svc),
   "istemcide ham 'visibility=public' tablo sorgusu KALMADI");
ok(!/\.eq\("room_code", code\)/.test(svc),
   "istemcide ham room_code tablo sorgusu KALMADI");
ok(svc.includes("ConquestAuthRequiredError"),
   "yetki hatası ayrı bir tip ile taşınıyor (boş listeyle karıştırılmaz)");
ok(/!found\?\.id/.test(svc),
   "istemci de .id kontrol ediyor (sözleşme bozulursa sessiz hata olmasın)");

// Menü: üç seçenek de görünür, ikisi giriş kapısına gider.
const menu = readFileSync(
  join(here, "../src/modes/conquest/ConquestModeSelectModal.tsx"), "utf8");
for (const label of ["Oda Kur", "Oda Koduyla Katıl", "Odalara Göz At"]) {
  ok(menu.includes(label), `menüde "${label}" seçeneği DURUYOR (gizlenmedi)`);
}
ok(/setGateIntent\("conquest-create"\)/.test(menu), "misafir 'Oda Kur' → giriş kapısı");
ok(/setGateIntent\("conquest-browse"\)/.test(menu), "misafir 'Odalara Göz At' → giriş kapısı");
ok(!/isLoggedIn[\s\S]{0,80}handleJoinByCode/.test(menu),
   "'Oda Koduyla Katıl' misafire AÇIK (giriş kapısı yok)");

// Giriş kapısı metinleri ürün şartnamesiyle birebir.
const lrm = readFileSync(join(here, "../src/components/LoginRequiredModal.tsx"), "utf8");
for (const t of [
  "Odalara göz atmak için giriş yap",
  "Oda kurmak için giriş yap",
  "Açık odaları görüntülemek için giriş yapman veya hesap oluşturman",
  "Yeni bir oda oluşturmak için giriş yapman veya hesap oluşturman",
  "Davet edildiğin bir odaya oda koduyla kayıt olmadan",
  "Giriş Yap",
  "Hesap Oluştur",
  "Vazgeç",
]) {
  ok(lrm.includes(t), `giriş kapısı metni: "${t.slice(0, 46)}…"`);
}

// Bekleyen işlem: giriş sonrası boş ana sayfaya düşülmemeli, tek sefer koşmalı.
const appSrc = readFileSync(join(here, "../src/App.tsx"), "utf8");
ok(/onConquestAuthRequired/.test(appSrc), "Kuşatma giriş kapısı App'e bağlı");
ok(/intent === "conquest-browse" \? "conquest-rooms" : "conquest-game"/.test(appSrc),
   "bekleyen işlem doğru ekrana çözülüyor (liste / oda kurma)");
ok(/sessionStorage\.setItem\(PENDING_ONLINE_TARGET_KEY, target\)/.test(appSrc),
   "bekleyen işlem OAuth round-trip'ini atlatacak şekilde saklanıyor");
ok(/clearPendingOnlineTarget\(\)/.test(appSrc),
   "bekleyen işlem tüketilince temizleniyor (yalnız BİR KEZ çalışır)");
ok(!/"conquest-join":\s*"kusatma-gate"/.test(appSrc),
   "'Oda Koduyla Katıl' ekranı login kapısından ÇIKARILDI (misafire açık)");
ok(/"conquest-rooms":\s*"kusatma-gate"/.test(appSrc),
   "'Odalara Göz At' ekranı login kapısında KALDI");


/* ════════════════════════════════════════════════════════════════════════
   11) KÖR NOKTA MİSAFİR KATILIMI
   ------------------------------------------------------------------------
   Kör Nokta misafire kapalıydı çünkü tevatur_players.profile_id NOT NULL idi
   ve tevatur_authorize_player yalnız profile_id = auth.uid() kabul ediyordu.
   Bu bölüm modun diğer yedi modun desenine hizalandığını doğrular.
════════════════════════════════════════════════════════════════════════ */
console.log("\n11) Kör Nokta misafir katılımı");

ok(isGuestJoinableMode("korNokta"), "korNokta artık misafire açık modlar listesinde");

// Şema: kimlik XOR'u.
ok(/alter column profile_id drop not null/.test(mig2),
   "tevatur_players.profile_id artık NULL olabilir");
ok(/add column if not exists guest_id text/.test(mig2),
   "tevatur_players.guest_id eklendi");
ok(/tevatur_players_identity_xor/.test(mig2),
   "kimlik XOR kısıtı var (profile_id XOR guest_id)");
ok(/tevatur_players_room_guest_uniq/.test(mig2),
   "aynı misafir oturumu odada iki satır açamaz");

// Yetki helper'ı misafiri tanımalı ama claim_token'ı ZORUNLU tutmalı.
const authBody = mig2.split("create or replace function public.tevatur_authorize_player")[1] ?? "";
ok(/p\.profile_id is null[\s\S]{0,160}p_claim_token is not null/.test(authBody),
   "misafir yolunda claim_token ZORUNLU (player_id bilmek yetmez)");
ok(/p\.profile_id = auth\.uid\(\)/.test(authBody),
   "kayıtlı kullanıcı yolu korunuyor (JWT birincil kanıt)");

// Katılma RPC'si misafire açık; oda kurma DEĞİL.
ok(/grant  execute on function public\.tevatur_join_room\(text, uuid, uuid, text, text\) to anon, authenticated;/.test(mig2),
   "misafir varyantı tevatur_join_room anon'a açık");
ok(!/tevatur_create_room[\s\S]{0,60}to anon/.test(mig2),
   "tevatur_create_room anon'a AÇILMADI (misafir oda kuramaz)");
ok(!/award_kornokta_xp_event[\s\S]{0,60}to anon/.test(mig2),
   "award_kornokta_xp_event anon'a AÇILMADI (misafire XP yok)");

// Misafir adı ortak kapıdan geçmeli.
const joinBody = mig2.split("create or replace function public.tevatur_join_room")[1] ?? "";
ok(/assert_display_name_allowed\(p_name, null, btrim\(p_guest_id\)\)/.test(joinBody),
   "misafir adı ortak assert_display_name_allowed kapısından geçiyor");
ok(/raise exception 'name_taken'/.test(joinBody),
   "oda-içi ad çakışması reddediliyor");
ok(/for update/.test(joinBody),
   "kapasite + ad kontrolleri oda kilidi altında (eşzamanlı aynı nick engellenir)");
ok(/select username into v_name from public\.profiles where id = v_uid/.test(joinBody),
   "kayıtlı kullanıcının adı SUNUCUDA profiles'tan okunur (client adı yok sayılır)");

// Oyun RPC'leri misafire açılmış olmalı (gövdeleri değişmeden).
for (const fn of [
  "tevatur_kn_submit_guess", "tevatur_kn_submit_answer", "tevatur_kn_advance_phase",
  "tevatur_kn_select_questions", "tevatur_kn_return_to_lobby", "tevatur_leave_room",
  "tevatur_send_message", "tevatur_kn_set_team",
]) {
  ok(new RegExp(`${fn}[\\s\\S]{0,220}to anon`).test(mig2),
     `${fn} misafire açıldı`);
}

// Slot devri korNokta'yı tanımalı.
ok(/when 'korNokta'\s+then v_players_table := 'tevatur_players';/.test(mig2),
   "torble_link_guest_player korNokta modunu tanıyor");

// Ham yazma yolu kapalı.
ok(/revoke insert, update, delete on table public\.tevatur_players from anon, authenticated;/.test(mig2),
   "tevatur_players ham INSERT/UPDATE/DELETE yolu kapatıldı");

// İstemci sözleşmesi.
const knMode = readFileSync(join(here, "../src/modes/korNokta/KorNoktaMode.tsx"), "utf8");
ok(/p_guest_id:\s*profile\?\.username \? null : ensureGuestId\(\)/.test(knMode),
   "KorNoktaMode misafir kimliğini gönderiyor");
ok(/<GuestTag/.test(knMode), "Kör Nokta lobisinde 'Misafir' etiketi render ediliyor");
ok(/!p\.profile_id && <GuestTag/.test(knMode),
   "etiket SUNUCU satırından (profile_id) türetiliyor");
ok(/showLoginGuard = !isLoggedInPlayer && initialAction === "create"/.test(knMode),
   "giriş kapısı YALNIZ oda kurmada (katılma misafire açık)");
ok(/validateGuestName/.test(knMode),
   "misafir adı ortak kural setiyle doğrulanıyor (kopya doğrulama yok)");

const knGame = readFileSync(join(here, "../src/modes/korNokta/KorNoktaGame.tsx"), "utf8");
ok(/<GuestEndPrompt/.test(knGame), "Kör Nokta sonuç ekranında hesap oluşturma bölümü var");

// App yönlendirmesi: misafir Kör Nokta davetinde KAYIT ekranına zorlanmamalı.
ok(/setGuestJoin\(\{ mode: "korNokta", code: clean \}\)/.test(appSrc),
   "Kör Nokta davet linki misafiri nick ekranına götürüyor (login zorunlu değil)");
ok(!/setAuthPromptReason\("kornokta-invite"\)/.test(appSrc),
   "eski 'Kör Nokta login zorunlu' davet dalı KALDIRILDI");
// Slot devri artık EKRANDAN türetilmiyor: web OAuth redirect'i sayfayı baştan
// yüklediği için dönüşte `screen` her zaman "home" oluyor ve eski
// SCREEN_TO_ROOM_MODE eşlemesi hiçbir zaman tutmuyordu (audit C2). Aday listesi
// kalıcı oturumdan çözülüyor; ayrıntılı sözleşme:
// scripts/check-guest-conversion.ts
ok(!/SCREEN_TO_ROOM_MODE\[/.test(appSrc),
   "slot devri ekran→mod eşlemesine BAĞLI DEĞİL (kaldırıldı)");
ok(/resolveGuestLinkTargets\(\)/.test(appSrc),
   "kayıt sonrası slot devri kalıcı oturumdan çözülüyor (auth-flip uzlaştırması)");

/* ════════════════════════════════════════════════════════════════════════
   7) KUŞATMA HAM OKUMA KİLİDİ + HOST DEVRİ (20260810120000)
   ════════════════════════════════════════════════════════════════════════
   DRIFT UYARISI: bu bölüm 20260810120000'in aynasıdır. SQL değişirse burası
   da güncellenmeli. */
console.log("\n7) Kuşatma ham okuma kilidi + misafir host yasağı");

const mig3 = readFileSync(
  join(here, "../supabase/migrations/20260810120000_conquest_guest_read_lockdown_and_host_rules.sql"),
  "utf8"
);

// ── A) Ham anon okuması kapalı ────────────────────────────────────────────
for (const table of ["conquest_rooms", "conquest_players"]) {
  ok(new RegExp(`create policy "${table}_select_auth"[\\s\\S]{0,120}to authenticated`).test(mig3),
     `${table} SELECT policy'si yalnız authenticated`);
  ok(new RegExp(`revoke select on table public\\.${table} from anon;`).test(mig3),
     `${table} SELECT grant'i anon'dan geri alındı`);
  ok(!new RegExp(`create policy "${table}_select[\\s\\S]{0,140}to anon`).test(mig3),
     `${table} için anon SELECT policy'si YENİDEN AÇILMADI`);
}
ok(/'anon' = any\(roles\)/.test(mig3),
   "artakalan anon policy'leri süpürülüyor (Studio'dan elle eklenmiş olabilir)");

// ── B) Misafirin tek okuma yolu: üyelik kanıtlı, TEK oda ──────────────────
const stateFn = mig3.split("create or replace function public.conquest_get_room_state")[1] ?? "";
ok(stateFn.length > 0, "conquest_get_room_state tanımlı");
ok(/p\.room_id = p_room_id/.test(stateFn),
   "oyuncu satırının İSTENEN odada olması şart (başka odayı okuyamaz)");
ok(/public\.conquest_authorize_player\(p_player_id, p_claim_token\)/.test(stateFn),
   "üyelik claim_token / auth.uid() ile kanıtlanıyor");
ok(/'not_a_member'/.test(stateFn) && /'room_gone'/.test(stateFn),
   "yetkisiz çağrı sessiz boş liste değil, açık gerekçe döndürüyor");
ok(!/claim_token/.test(stateFn.split("return jsonb_build_object")[1] ?? ""),
   "dönen yükte claim_token YOK");
ok(/grant\s+execute on function public\.conquest_get_room_state\(uuid, uuid, uuid\) to anon, authenticated;/.test(mig3),
   "conquest_get_room_state misafire açık");

// Liste uç noktası misafire KAPALI kalmalı (önceki migration'ın sözleşmesi).
const mig2b = readFileSync(
  join(here, "../supabase/migrations/20260809120000_guest_browse_gate_and_kornokta.sql"),
  "utf8"
);
ok(!/grant\s+execute on function public\.conquest_list_public_rooms\(\) to[^;]*anon/.test(mig2b),
   "conquest_list_public_rooms anon'a AÇILMADI");

// ── C) Kapasite + renk sunucuda (misafir katılmadan önce tablo okumaz) ────
const regFn = mig3.split("create or replace function public.conquest_register_player")[1] ?? "";
ok(/for update/.test(regFn), "kapasite sayımı oda kilidi altında (race-safe)");
ok(/raise exception 'room_full'/.test(regFn), "kapasite SUNUCUDA zorlanıyor");
ok(/v_palette/.test(regFn), "renk paletten SUNUCUDA atanıyor");
ok(/already_in_room/.test(regFn), "misafir guest_id çakışması reddediliyor");
ok(/on conflict \(player_id\) do update set claim_token/.test(regFn),
   "yeniden katılan KAYITLI kullanıcının claim_token'ı tazeleniyor");

// ── D) Canlı güncelleme: kanal VERİ değil SİNYAL taşır ────────────────────
ok(/realtime\.send\(/.test(mig3), "oda değişiklikleri broadcast sinyali gönderiyor");
ok(/jsonb_build_object\('room_id', v_room_id, 'op', TG_OP, 'src', 'rooms'\)/.test(mig3),
   "sinyal yükünde oda verisi YOK (yalnız room_id + işlem)");
ok(/exception when others then\s*\n\s*null;/.test(mig3),
   "yayın hatası oyun yazmalarını BOZAMAZ");
ok(/realtime\.topic\(\) like 'conquest:%'/.test(mig3),
   "realtime.messages politikası yalnız conquest konularını açıyor");

// ── E) Misafir HİÇBİR modda host olamaz ───────────────────────────────────
for (const fn of [
  "conquest_leave_room", "wheel_group_leave_room",
  "duel_group_leave_room", "tevatur_leave_room",
]) {
  const body = mig3.split(`create or replace function public.${fn}`)[1]?.split("revoke all")[0] ?? "";
  ok(body.length > 0, `${fn} bu migration'da yeniden tanımlanıyor`);
  ok(/and profile_id is not null/.test(body),
     `${fn}: host adayı KAYITLI olmak zorunda (misafir aday değil)`);
  // Aday bulunamazsa oda güvenle kapanmalı — hostsuz oda kalmamalı.
  ok(/delete from public\.(wheel_group_rooms|duel_group_rooms|tevatur_rooms) where id = p_room_id|status\s*=\s*'closed'/.test(body),
     `${fn}: kayıtlı aday yoksa oda kapatılıyor (hayalet oda yok)`);
}

// ── F) İstemci sözleşmesi ────────────────────────────────────────────────
const cqService  = readFileSync(join(here, "../src/modes/conquest/conquestService.ts"), "utf8");
const cqRealtime = readFileSync(join(here, "../src/modes/conquest/conquestRealtime.ts"), "utf8");
const cqMode     = readFileSync(join(here, "../src/modes/conquest/ConquestMode.tsx"), "utf8");
const socialSrc  = readFileSync(join(here, "../src/lib/social.ts"), "utf8");

for (const [label, src] of [
  ["conquestService",  cqService],
  ["conquestRealtime", cqRealtime],
  ["ConquestMode",     cqMode],
  ["social",           socialSrc],
] as const) {
  // YALNIZ ham OKUMA aranır: `.from(tablo).select(...)`. Yazma yollarındaki
  // `.insert(...).select("*")` / `.update(...).select("*")` bir RETURNING
  // cümlesidir, enumerasyon yolu değildir ve host (kayıtlı) akışına aittir.
  ok(!/from\(["']conquest_(rooms|players)["']\)\s*\.select\(/.test(src),
     `${label}: Kuşatma tablolarına ham SELECT KALMADI`);
}
ok(/supabase\.rpc\("conquest_get_room_state"/.test(cqService),
   "istemci oda durumunu yetkili RPC'den okuyor");
ok(/supabase\.rpc\("conquest_find_room_by_code"/.test(socialSrc),
   "davet ön-kontrolü tek-oda çözümleyicisinden geçiyor");
ok(/isGuest/.test(cqRealtime) && /config: \{ private: true \}/.test(cqRealtime),
   "misafir private sinyal kanalına abone oluyor");
ok(/POLL_FAST_MS/.test(cqRealtime) && /POLL_SLOW_MS/.test(cqRealtime),
   "sinyal gelmezse yoklama yedeği devreye giriyor (ekran donmaz)");
ok(/p_color:\s*null/.test(cqService),
   "renk seçimi sunucuya bırakıldı (katılmadan önce tablo okunmuyor)");

// Misafire gösterilen kapanma mesajı — dört modda da aynı cümle.
for (const [label, path] of [
  ["Kuşatma",     "../src/modes/conquest/ConquestMode.tsx"],
  ["Kör Nokta",   "../src/modes/korNokta/KorNoktaMode.tsx"],
  ["Çark Grup",   "../src/components/WheelGroupGame.tsx"],
  ["Düello Grup", "../src/components/DuelGroupGame.tsx"],
] as const) {
  const src = readFileSync(join(here, path), "utf8");
  ok(/Oda sahibi ayrıldığı için oda kapatıldı\./.test(src),
     `${label}: "Oda sahibi ayrıldığı için oda kapatıldı." mesajı var`);
}

/* ════════════════════════════════════════════════════════════════════════
   8) KUŞATMA GÖRÜNEN AD KORUYUCUSU (20260812120000)
   ════════════════════════════════════════════════════════════════════════
   REGRESYON: manuel testte bulunan gerçek açık — `conquest_register_player`
   `assert_display_name_allowed`'ı HİÇ çağırmıyordu, dolayısıyla misafirler
   kayıtlı kullanıcı adlarını taklit edebiliyordu. Bu bölüm koruyucunun
   bağlı KALDIĞINI ve düzeltmenin yan etki üretmediğini doğrular.

   DRIFT UYARISI: 20260812120000'in aynasıdır. SQL değişirse burası da
   güncellenmeli. */
console.log("\n8) Kuşatma görünen ad koruyucusu (20260812120000)");

const mig4 = readFileSync(
  join(here, "../supabase/migrations/20260812120000_conquest_display_name_guard.sql"),
  "utf8"
);
const guardFn = mig4.split("create or replace function public.conquest_register_player")[1] ?? "";

// ── A) ASIL DÜZELTME: koruyucu gerçekten çağrılıyor mu ────────────────────
ok(guardFn.length > 0, "conquest_register_player bu migration'da yeniden tanımlanıyor");
ok(/p_name := public\.assert_display_name_allowed\(p_name, p_profile_id, p_guest_id\);/.test(guardFn),
   "görünen ad merkezî koruyucudan geçiyor (diğer 8 modun deseni)");
ok(!/if p_name is null or length\(btrim\(p_name\)\) < 2 then/.test(guardFn),
   "yalnız-uzunluk kontrolü KALDIRILDI (açığın kaynağıydı)");
ok(guardFn.indexOf("assert_display_name_allowed") < guardFn.indexOf("for update"),
   "koruyucu oda kilidinden ÖNCE çalışıyor (kilit süresi uzamıyor)");
ok(guardFn.indexOf("claim_token_required") < guardFn.indexOf("assert_display_name_allowed"),
   "kimlik/claim_token hata önceliği korunuyor (istemci davranışı değişmez)");

// ── B) İMZA DEĞİŞMEDİ — CREATE OR REPLACE ACL'i ancak böyle korur ─────────
const sigOld = (mig3.split("create or replace function public.conquest_register_player")[1] ?? "")
  .split(") returns")[0];
const sigNew = guardFn.split(") returns")[0];
ok(sigOld.length > 0 && sigOld === sigNew,
   "fonksiyon imzası 20260810120000 ile BİREBİR aynı (yeni overload yok)");
ok(/returns public\.conquest_players/.test(guardFn), "dönüş tipi korundu");
ok(/security definer/.test(guardFn) && /set search_path = public, auth/.test(guardFn),
   "SECURITY DEFINER + search_path korundu");

// ── C) ACL / YETKİ DAVRANIŞI DEĞİŞMİYOR ──────────────────────────────────
ok(!/drop function/i.test(mig4),
   "DROP FUNCTION YOK (DROP+CREATE Supabase default privileges'ı yeniden doğururdu)");
ok(!/^\s*(grant|revoke)\b/im.test(mig4),
   "GRANT/REVOKE satırı YOK — mevcut ACL olduğu gibi korunuyor");
ok(/has_function_privilege\('anon', v_oid, 'EXECUTE'\)/.test(mig4),
   "son koşul: misafir katılımı için anon EXECUTE hâlâ var mı denetleniyor");
ok(/v_overload <> 1/.test(mig4), "son koşul: ikinci bir aşırı yükleme doğmadığı denetleniyor");
for (const fn of ["conquest_list_public_rooms", "torble_link_guest_player"]) {
  ok(!new RegExp(`(grant|revoke)[^;\\n]*${fn}`, "i").test(mig4),
     `${fn} hotfix ACL'sine DOKUNULMUYOR`);
}

// ── D) VERİ DEĞİŞMİYOR + ayrı problemler bu migration'a karışmadı ─────────
ok(!/\b(insert into|update|delete from)\s+public\.conquest_(players|rooms)\b/i.test(
     mig4.replace(guardFn, "")),
   "fonksiyon gövdesi DIŞINDA veri yazma/backfill YOK");
ok(!/create\s+(unique\s+)?index/i.test(mig4),
   "aynı-oda duplicate-name konusu bu migration'a KARIŞTIRILMADI (ayrı açık)");
// NOT: düz `name_taken` araması YANILTICI — `registered_username_taken`
// dizesi onu alt dize olarak içerir. Zorlama gerçekten eklendi mi diye
// fırlatma ifadesine bakılır.
ok(!/raise exception 'name_taken'/.test(guardFn),
   "oda-içi name_taken zorlaması EKLENMEDİ (ayrı açık olarak duruyor)");

// ── E) MEVCUT DAVRANIŞLAR KORUNDU (gövdenin geri kalanı aynı) ────────────
for (const [needle, label] of [
  ["profile_mismatch",        "kayıtlı kimlik tutarlılığı"],
  ["guest_id_required",       "misafir kimliği zorunluluğu"],
  ["claim_token_required",    "claim_token zorunluluğu"],
  ["for update",              "oda kilidi (race-safe kapasite)"],
  ["room_full",               "kapasite kontrolü"],
  ["room_in_progress",        "başlamış oda reddi"],
  ["already_in_room",         "misafir guest_id çakışması"],
  ["v_palette",               "sunucu renk ataması"],
  ["on conflict (player_id) do update set claim_token", "yeniden katılan kayıtlı oyuncu"],
] as const) {
  ok(guardFn.includes(needle), `korundu: ${label}`);
}

// ── F) ÖN KOŞUL + SIRALAMA ───────────────────────────────────────────────
ok(/to_regprocedure\('public\.assert_display_name_allowed\(text,uuid,text\)'\)/.test(mig4),
   "ön koşul: koruyucunun canlıda var olduğu denetleniyor");
ok(/to_regprocedure\(\s*'public\.conquest_register_player\(uuid,uuid,uuid,text,text,text,boolean,uuid\)'/.test(mig4),
   "ön koşul: değiştirilecek fonksiyonun beklenen imzayla var olduğu denetleniyor");
ok("20260812120000" > "20260810120000" && "20260812120000" > "20260808120000",
   "migration bağımlılıklarından SONRA sıralanıyor");

// ── G) İSTEMCİ DEĞİŞİKLİĞİ GEREKMİYOR — hata eşlemesi zaten hazır ────────
// Eşleme conquestJoinFlow.ts'te (saf modül); hata dalının EKRAN davranışı
// scripts/check-conquest-join-errors.ts'te ayrıca doğrulanır.
const cqSvcGuard = readFileSync(join(here, "../src/modes/conquest/conquestJoinFlow.ts"), "utf8");
for (const label of ["registered_username_taken", "display_name_forbidden", "name_invalid"]) {
  ok(cqSvcGuard.includes(label),
     `istemci ${label} hatasını zaten karşılıyor (frontend değişikliği gerekmiyor)`);
}

/* ════════════════════════════════════════════════════════════════════════ */
console.log(
  failed === 0
    ? `\n✅ ${passed} passed, 0 failed\n`
    : `\n❌ ${passed} passed, ${failed} FAILED\n`
);
process.exit(failed === 0 ? 0 : 1);
