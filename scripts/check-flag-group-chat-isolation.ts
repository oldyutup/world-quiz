/**
 * check-flag-group-chat-isolation.ts
 *
 * Bayrak Grup sohbetinin MODLAR ARASI mesaj izolasyonunu SÖZLEŞME (contract)
 * testiyle kesin olarak doğrular. Paylaşımlı `duel_messages` tablosu yalnız
 * `room_code` ile ayrılır ve oda kodları modlar arası GLOBAL UNIQUE DEĞİLDİR
 * (her <mode>_rooms.code yalnız kendi tablosunda unique). Çözüm: Bayrak Grup
 * mesajları "flag_group:<code>" namespaced anahtarıyla izole edilir.
 *
 * Bu betik, client (FlagGroupGame.chatRoomKey + LobbyChat keying) ve server
 * (flag_group_send_message v_room_key) SÖZLEŞMESİNİ birebir modelleyip aşağıdaki
 * değişmezleri ispatlar. Gerçek DB/Realtime GEREKMEZ — saf string invariant'ı.
 *
 * Çalıştır:  npx tsx scripts/check-flag-group-chat-isolation.ts
 */

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, got?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
  else { failed++; console.log(`  ✗ ${label}${got !== undefined ? `  (got ${JSON.stringify(got)})` : ""}`); }
}

/* ── CLIENT sözleşmesi ───────────────────────────────────────────────────────
   FlagGroupGame: chatRoomKey(code) = `flag_group:${code}` → LobbyChat.roomCode.
   Diğer modlar (wheel_group/duel_group/conquest): LobbyChat.roomCode = plain code
   (WheelGroupGame/DuelGroupGame roomCode={room.code}).                          */
const FLAG_NS = "flag_group";
const clientFlagGroupKey = (code: string) => `${FLAG_NS}:${code}`;
const clientPlainKey = (code: string) => code; // wheel_group / duel_group / conquest / …

/* LobbyChat davranışı (roomCode opak): geçmiş sorgusu .eq("room_code", key),
   Realtime kanalı `chat-${key}`, postgres_changes filter room_code=eq.${key}. */
const historyVisible = (rowRoomCode: string, readerKey: string) => rowRoomCode === readerKey;
const channelName = (key: string) => `chat-${key}`;

/* ── SERVER sözleşmesi (flag_group_send_message) ─────────────────────────────
   v_room_key = 'flag_group:' || <GERÇEK oda kodu>; p_room_code != v_room_key
   ise 'room_code_mismatch'. Depolanan room_code = v_room_key.                    */
const serverStoredKey = (realCode: string) => `${FLAG_NS}:${realCode}`;
function serverAccepts(pRoomCode: string, realCode: string): boolean {
  return pRoomCode === serverStoredKey(realCode); // aksi → room_code_mismatch
}
/* Diğer modların RPC'si (referans: wheel_group_send_message): stored = plain
   real code; p_room_code != real plain code ise mismatch.                        */
const otherModeStoredKey = (realCode: string) => realCode;
const otherModeAccepts = (pRoomCode: string, realCode: string) => pRoomCode === realCode;

console.log("\n▶ Bayrak Grup sohbet — modlar arası izolasyon sözleşmesi\n");

const CODE = "ABC123"; // flag_group ve wheel_group AYNI kodu üretmiş senaryo

console.log("1) Aynı kod farklı mod → farklı mantıksal anahtar");
{
  const flagKey  = clientFlagGroupKey(CODE);
  const wheelKey = clientPlainKey(CODE);
  ok(flagKey !== wheelKey, "flag_group:ABC123 ≠ ABC123", [flagKey, wheelKey]);
  ok(flagKey === "flag_group:ABC123", "flag anahtarı beklenen biçimde", flagKey);
}

console.log("2) Flag mesajı Wheel'de GÖRÜNMEZ (anlık + geçmiş)");
{
  // Server flag mesajını namespaced saklar:
  const flagRow = serverStoredKey(CODE);            // "flag_group:ABC123"
  const wheelReader = clientPlainKey(CODE);          // "ABC123"
  ok(!historyVisible(flagRow, wheelReader), "geçmiş: flag satırı wheel okuyucusuna görünmez");
  ok(channelName(flagRow) !== channelName(wheelReader), "kanal: flag kanalı ≠ wheel kanalı",
    [channelName(flagRow), channelName(wheelReader)]);
}

console.log("3) Wheel mesajı Flag'ta GÖRÜNMEZ (anlık + geçmiş)");
{
  const wheelRow = otherModeStoredKey(CODE);          // "ABC123"
  const flagReader = clientFlagGroupKey(CODE);         // "flag_group:ABC123"
  ok(!historyVisible(wheelRow, flagReader), "geçmiş: wheel satırı flag okuyucusuna görünmez");
  ok(channelName(wheelRow) !== channelName(flagReader), "kanal: wheel kanalı ≠ flag kanalı");
}

console.log("4) Geçmiş sorgusu da modlar arası karışmıyor (aynı kod)");
{
  const rows = [
    { room_code: serverStoredKey(CODE),   who: "flag"  },
    { room_code: otherModeStoredKey(CODE), who: "wheel" },
  ];
  const flagReader = clientFlagGroupKey(CODE);
  const visibleToFlag = rows.filter(r => historyVisible(r.room_code, flagReader)).map(r => r.who);
  ok(visibleToFlag.length === 1 && visibleToFlag[0] === "flag", "flag okuyucusu yalnız flag satırını görür", visibleToFlag);
}

console.log("5) İki farklı Flag odası birbirine karışmıyor");
{
  const a = serverStoredKey("ABC123");
  const b = serverStoredKey("XYZ789");
  ok(a !== b, "flag_group:ABC123 ≠ flag_group:XYZ789", [a, b]);
  ok(!historyVisible(a, b), "A odası mesajı B okuyucusuna görünmez");
  ok(channelName(a) !== channelName(b), "iki flag odası ayrı kanal");
}

console.log("7) RPC yanlış mode/room kombinasyonunu reddediyor (server-authoritative)");
{
  const realCode = CODE; // oyuncunun GERÇEK flag odası
  // Legit: client namespaced kendi kodunu gönderir
  ok(serverAccepts(clientFlagGroupKey(realCode), realCode), "legit: flag_group:ABC123 kabul");
  // Spoof: plain kod (wheel namespace'ine yazma denemesi)
  ok(!serverAccepts(clientPlainKey(realCode), realCode), "reddet: plain 'ABC123' (wheel'e sızma) → mismatch");
  // Spoof: başka flag odası
  ok(!serverAccepts(clientFlagGroupKey("XYZ789"), realCode), "reddet: başka oda flag_group:XYZ789 → mismatch");
  // Spoof: başka mod öneki
  ok(!serverAccepts(`wheel_group:${realCode}`, realCode), "reddet: wheel_group:ABC123 → mismatch");
  // Çift yön: wheel RPC ASLA flag namespace'ine yazamaz (kendi kodu plain)
  ok(!otherModeAccepts(clientFlagGroupKey(realCode), realCode), "wheel RPC 'flag_group:ABC123' yazamaz → mismatch");
  // Depolanan anahtar her zaman namespaced (plain kod DB'ye düşmez)
  ok(serverStoredKey(realCode).startsWith(`${FLAG_NS}:`), "depolanan anahtar namespaced", serverStoredKey(realCode));
}

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
