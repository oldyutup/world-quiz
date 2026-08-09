/**
 * check-invite-admission.ts — davet linki yönlendirme sertleştirmesi (audit M1/M2/M3).
 *
 * KAPSAM:
 *   M1  aktif oda önceliği   → decideInviteAdmission
 *   M2  açılış tekilleştirme → createLaunchDedupe
 *   M3  sunucu doğrulaması   → decideInviteAdmission
 *   m1  normalizasyon        → parseInviteFromUrl + normalizeRoomCode
 *   +   deep-link güvenliği  → parseInviteFromUrl (host/şema/biçim)
 *
 * Hepsi SAF modüller: Supabase, React, tarayıcı ve ağ GEREKMEZ.
 *   npx tsx scripts/check-invite-admission.ts
 */
import { parseInviteFromUrl, createLaunchDedupe } from "../src/lib/deepLink";
import { decideInviteAdmission, decideAfterExit } from "../src/lib/inviteAdmission";
import { roomModeForScreen, type AppScreen } from "../src/lib/screenPolicy";
import { normalizeRoomCode, type RoomCodeModeKey, type RoomCodeResolution } from "../src/lib/roomCodeShared";
import { INVITE_PARAM } from "../src/lib/inviteLink";

let pass = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string) {
  if (cond) pass++;
  else fails.push(label);
}
function eq<T>(actual: T, expected: T, label: string) {
  ok(Object.is(actual, expected), `${label} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/* ══════════════════════════════════════════════════════════════════════
   BÖLÜM 0 — deep-link parser güvenliği KORUNDU MU? (regression kalkanı)
   ══════════════════════════════════════════════════════════════════════ */
const expectNull = (url: string, why: string) => ok(parseInviteFromUrl(url) === null, `parser reject: ${why} (${url})`);
const expectInvite = (url: string, mode: string, code: string, why: string) => {
  const r = parseInviteFromUrl(url);
  ok(!!r && r.mode === mode && r.code === code, `parser accept: ${why} (${url}) -> ${JSON.stringify(r)}`);
};

expectInvite("https://torble.com/?duel=AB12CD", "duel", "AB12CD", "apex");
expectInvite("https://www.torble.com/?duel=AB12CD", "duel", "AB12CD", "www");
expectInvite("http://localhost/?duel=AB12CD", "duel", "AB12CD", "native webview host");
expectInvite("https://TORBLE.COM/?duel=AB12CD", "duel", "AB12CD", "host case-insensitive");

for (const h of ["evil.com", "torble.com.evil.com", "eviltorble.com", "torble.co", "notlocalhost", "torble.com.attacker.io", "xn--torble-x0a.com"])
  expectNull(`https://${h}/?duel=AB12CD`, `untrusted host ${h}`);
expectNull("https://staging.torble.com/?duel=AB12CD", "subdomain not allowlisted");
expectNull("https://torble.com@evil.com/?duel=AB12CD", "userinfo spoof");
expectNull("https://www.torble.com.evil.com/?duel=AB12CD", "www prefix spoof");

expectNull("javascript:alert(1)//?duel=AB12CD", "javascript scheme");
expectNull("data:text/html,<script>1</script>?duel=AB12CD", "data scheme");
expectNull("file:///etc/passwd?duel=AB12CD", "file scheme");
expectNull("com.kavakgames.torble://auth-callback?duel=AB12CD", "custom scheme not hijacked");
expectNull("capacitor://localhost/?duel=AB12CD", "capacitor scheme rejected");
expectNull("com.kavakgames.torble://auth-callback#access_token=xyz", "auth callback untouched");

expectNull("https://torble.com/?duel=AB12C", "5 chars too short");
expectNull("https://torble.com/?duel=", "empty code");
expectNull("https://torble.com/?duel=!!!!!!", "all punctuation strips to 0");
expectInvite("https://torble.com/?duel=ab12cd", "duel", "AB12CD", "lowercase normalized");
expectInvite("https://torble.com/?duel=AB12CDEF", "duel", "AB12CD", "over-length truncated");
expectInvite("https://torble.com/?duel=A-B1 2C D", "duel", "AB12CD", "punctuation stripped");

expectNull("https://torble.com/?foo=AB12CD", "unknown param ignored");
expectNull("https://torble.com/?redirect=https://evil.com", "no redirect param honored");
expectNull("https://torble.com/", "no params at all");
for (const bad of ["", "not a url", "://", "https://", "%%%%"]) expectNull(bad, `malformed: ${bad}`);

const ALL_MODES: RoomCodeModeKey[] = ["duel", "flagDuel", "wheelDuel", "routeDuel", "duelGroup", "wheelGroup", "flagGroup", "conquest", "korNokta"];
for (const m of ALL_MODES) expectInvite(`https://torble.com/?${INVITE_PARAM[m]}=ZZ99YY`, m, "ZZ99YY", `mode ${m}`);

// Path bağımsızlığı PARSER tarafında kasıtlı: yol filtresi iOS'ta AASA'nın işi
// (`{"/": "/"}`), parser yalnız host + şema + kod biçimini zorlar.
expectInvite("https://torble.com/tr/privacy?duel=AB12CD", "duel", "AB12CD", "parser ignores path");
expectInvite("https://torble.com/anything/deep?conquest=AB12CD", "conquest", "AB12CD", "parser ignores deep path");

/* ══════════════════════════════════════════════════════════════════════
   BÖLÜM 1 — M2: açılış teslimatı tekilleştirme
   ══════════════════════════════════════════════════════════════════════ */
const URL_A = "https://torble.com/?duel=AB12CD";
const URL_B = "https://torble.com/?conquest=XY99ZZ";

// Cold start çift teslimat → yalnız 1 işlem.
{
  const d = createLaunchDedupe();
  d.noteLaunch(URL_A);                                    // getLaunchUrl işledi
  eq(d.shouldHandleEvent(URL_A), false, "M2 cold-start echo swallowed");
}

// Cold start + SONRADAN gerçek ikinci dokunuş (arka plana düştükten sonra).
{
  const d = createLaunchDedupe();
  d.noteLaunch(URL_A);
  eq(d.shouldHandleEvent(URL_A), false, "M2 echo swallowed (before re-tap)");
  d.noteBackgrounded();
  eq(d.shouldHandleEvent(URL_A), true, "M2 same link re-tap AFTER background is handled");
}

// Echo hiç gelmese bile arka plan sonrası aynı link işlenir (eski bug'ın özü).
{
  const d = createLaunchDedupe();
  d.noteLaunch(URL_A);
  d.noteBackgrounded();
  eq(d.shouldHandleEvent(URL_A), true, "M2 no-echo path: same link still handled after background");
}

// Koruma tek atışlık — ikinci olaya sarkmaz.
{
  const d = createLaunchDedupe();
  d.noteLaunch(URL_A);
  eq(d.shouldHandleEvent(URL_A), false, "M2 first event consumed");
  eq(d.shouldHandleEvent(URL_A), true, "M2 guard does NOT persist to second event");
}

// Cold start URL'inden FARKLI bir link hemen işlenir.
{
  const d = createLaunchDedupe();
  d.noteLaunch(URL_A);
  eq(d.shouldHandleEvent(URL_B), true, "M2 different link during launch window handled");
}

// Launch olmadan (warm start) her olay işlenir.
{
  const d = createLaunchDedupe();
  eq(d.shouldHandleEvent(URL_A), true, "M2 warm start first tap");
  eq(d.shouldHandleEvent(URL_A), true, "M2 warm start same link twice");
}

/* ══════════════════════════════════════════════════════════════════════
   BÖLÜM 2 — ekran → oda modu eşlemesi (M1 girdisi)
   ══════════════════════════════════════════════════════════════════════ */
const ROOM_SCREENS: [AppScreen, RoomCodeModeKey][] = [
  ["duel-game", "duel"], ["flag-duel-game", "flagDuel"], ["wheel-duel-game", "wheelDuel"],
  ["route-duel-game", "routeDuel"], ["duel-group-game", "duelGroup"], ["wheel-group-game", "wheelGroup"],
  ["flag-group-game", "flagGroup"], ["conquest-game", "conquest"], ["conquest-join", "conquest"],
  ["kornokta-create", "korNokta"], ["kornokta-join", "korNokta"],
];
for (const [s, m] of ROOM_SCREENS) eq(roomModeForScreen(s), m, `roomModeForScreen(${s})`);
for (const s of ["home", "map-game", "flag-game", "wheel-game", "route-game", "cag-dedektifi", "harita-dedektifi", "harita-duel-game", "conquest-rooms", "daily-quest-game"] as AppScreen[])
  eq(roomModeForScreen(s), null, `roomModeForScreen(${s}) is null`);

// Her davet modunun en az bir oda ekranı olmalı — aksi hâlde M1 o modda kör kalır.
for (const m of ALL_MODES)
  ok(ROOM_SCREENS.some(([, mm]) => mm === m), `M1 coverage: mode ${m} has a room screen`);

/* ══════════════════════════════════════════════════════════════════════
   BÖLÜM 3 — M3: sunucu doğrulaması
   ══════════════════════════════════════════════════════════════════════ */
const found = (mode: RoomCodeModeKey, code = "AB12CD"): RoomCodeResolution =>
  ({ result: "found", code, match: { mode, label: mode } });
const notFound = (code = "AB12CD"): RoomCodeResolution => ({ result: "not_found", code });
const invalid = (): RoomCodeResolution => ({ result: "invalid" });
const netErr = (): RoomCodeResolution => ({ result: "error" });
const ambiguous = (modes: RoomCodeModeKey[], code = "AB12CD"): RoomCodeResolution =>
  ({ result: "ambiguous", code, matches: modes.map((m) => ({ mode: m, label: m })) });

const base = { currentRoomMode: null, activeModes: [] as RoomCodeModeKey[], currentRoomCode: null };

eq(decideInviteAdmission({ mode: "duel", code: "AB12CD", resolution: found("duel"), ...base }).kind,
   "route", "M3 valid room routes");

{
  const d = decideInviteAdmission({ mode: "duel", code: "AB12CD", resolution: notFound(), ...base });
  eq(d.kind, "reject", "M3 not_found rejected");
  ok(d.kind === "reject" && d.message === "Bu kodla aktif bir oda bulunamadı.", "M3 not_found message");
}
{
  const d = decideInviteAdmission({ mode: "duel", code: "AB12CD", resolution: invalid(), ...base });
  eq(d.kind, "reject", "M3 invalid rejected");
  ok(d.kind === "reject" && d.message === "Geçersiz oda kodu.", "M3 invalid message");
}
// Kod BAŞKA modda var → bu davetin modu için oda yok.
eq(decideInviteAdmission({ mode: "duel", code: "AB12CD", resolution: found("conquest"), ...base }).kind,
   "reject", "M3 code exists in a DIFFERENT mode is rejected");
// Ambiguous: davet modu listede varsa geçerli, yoksa reddedilir.
eq(decideInviteAdmission({ mode: "duel", code: "AB12CD", resolution: ambiguous(["duel", "conquest"]), ...base }).kind,
   "route", "M3 ambiguous containing invite mode routes");
eq(decideInviteAdmission({ mode: "duel", code: "AB12CD", resolution: ambiguous(["flagGroup", "conquest"]), ...base }).kind,
   "reject", "M3 ambiguous without invite mode rejected");
// Ağ hatası → niyet korunur (fail-open), oyuncu ölü ekranda bırakılmaz.
eq(decideInviteAdmission({ mode: "duel", code: "AB12CD", resolution: netErr(), ...base }).kind,
   "route", "M3 network error falls through (fail-open)");

/* ══════════════════════════════════════════════════════════════════════
   BÖLÜM 4 — M1: aktif oda önceliği
   ══════════════════════════════════════════════════════════════════════ */
// Oda ekranında + o modun oturumu var + BAŞKA odanın daveti → onay.
{
  const d = decideInviteAdmission({
    mode: "conquest", code: "XY99ZZ", resolution: found("conquest", "XY99ZZ"),
    currentRoomMode: "duel", activeModes: ["duel"], currentRoomCode: "AB12CD",
  });
  eq(d.kind, "confirm", "M1 active room + different invite asks for confirm");
  ok(d.kind === "confirm" && d.fromMode === "duel", "M1 confirm reports the mode being left");
}
// Oda ekranında ama o modun OTURUMU YOK (modu menüden açmış) → onay sorulmaz.
eq(decideInviteAdmission({
     mode: "conquest", code: "XY99ZZ", resolution: found("conquest", "XY99ZZ"),
     currentRoomMode: "duel", activeModes: [], currentRoomCode: null,
   }).kind, "route", "M1 on room screen WITHOUT session routes directly");
// Ana menüde → onay sorulmaz.
eq(decideInviteAdmission({
     mode: "conquest", code: "XY99ZZ", resolution: found("conquest", "XY99ZZ"),
     currentRoomMode: null, activeModes: ["duel"], currentRoomCode: null,
   }).kind, "route", "M1 stale session but not on a room screen routes directly");
// ZATEN İÇİNDE olunan odanın linki → kesinti yok.
eq(decideInviteAdmission({
     mode: "duel", code: "AB12CD", resolution: found("duel"),
     currentRoomMode: "duel", activeModes: ["duel"], currentRoomCode: "AB12CD",
   }).kind, "route", "M1 same-room invite does not interrupt");
// Aynı mod ama BAŞKA oda → onay.
eq(decideInviteAdmission({
     mode: "duel", code: "ZZ0000", resolution: found("duel", "ZZ0000"),
     currentRoomMode: "duel", activeModes: ["duel"], currentRoomCode: "AB12CD",
   }).kind, "confirm", "M1 same mode DIFFERENT room asks for confirm");
// Oda kodu bilinmiyorsa (conquest claim) güvenli taraf: onay sor.
eq(decideInviteAdmission({
     mode: "conquest", code: "XY99ZZ", resolution: found("conquest", "XY99ZZ"),
     currentRoomMode: "conquest", activeModes: ["conquest"], currentRoomCode: null,
   }).kind, "confirm", "M1 unknown current room code errs toward confirm");

/* ── SIRA: geçersiz davet, aktif oyunu RAHATSIZ ETMEZ (onay sorulmaz) ── */
{
  const d = decideInviteAdmission({
    mode: "conquest", code: "XY99ZZ", resolution: notFound("XY99ZZ"),
    currentRoomMode: "duel", activeModes: ["duel"], currentRoomCode: "AB12CD",
  });
  eq(d.kind, "reject", "ORDER: invalid invite while in a room rejects, never confirms");
}
{
  const d = decideInviteAdmission({
    mode: "conquest", code: "XY99ZZ", resolution: invalid(),
    currentRoomMode: "duel", activeModes: ["duel"], currentRoomCode: "AB12CD",
  });
  eq(d.kind, "reject", "ORDER: malformed invite while in a room rejects, never confirms");
}

/* ══════════════════════════════════════════════════════════════════════
   BÖLÜM 5 — m1: conquest dâhil tüm modlar aynı normalizasyondan geçer
   ══════════════════════════════════════════════════════════════════════ */
for (const m of ALL_MODES) {
  eq(normalizeRoomCode(" ab-12 cd "), "AB12CD", `m1 normalizeRoomCode punctuation (${m})`);
  const parsed = parseInviteFromUrl(`https://torble.com/?${INVITE_PARAM[m]}=a-b1%202c%20d`);
  ok(parsed?.code === "AB12CD", `m1 deep-link normalization for ${m} -> ${parsed?.code}`);
}
eq(normalizeRoomCode("AB12CDEF"), "AB12CD", "m1 truncation to 6");
eq(normalizeRoomCode("ab12cd"), "AB12CD", "m1 uppercase");

/* ══════════════════════════════════════════════════════════════════════
   BÖLÜM 6 — çıkış el sıkışması sonrası yönlendirme kapısı (M1)
   ══════════════════════════════════════════════════════════════════════ */
eq(decideAfterExit({ ok: true }).kind, "proceed", "GATE: successful exit → proceed");
eq(decideAfterExit({ ok: false, reason: "no-active-room" }).kind, "proceed",
   "GATE: nothing to leave → proceed");
{
  const d = decideAfterExit({ ok: false, reason: "exit-failed", error: new Error("net") });
  eq(d.kind, "abort", "GATE: failed exit → ABORT (davet işlenmez)");
  ok(d.kind === "abort" && d.message.length > 0, "GATE: abort taşır bir hata mesajı");
}

/* ═══════════════════════════════════════════════════════════════════ */
console.log(`PASS ${pass}  FAIL ${fails.length}`);
fails.forEach((f) => console.log("  ✗", f));
process.exit(fails.length === 0 ? 0 : 1);
