/**
 * guestSession.ts — MİSAFİR katılım oturumu (tek doğruluk kaynağı).
 *
 * Kapsam: hesabı olmayan bir oyuncunun, kayıtlı birinin kurduğu ÖZEL odaya
 * oda kodu veya davet bağlantısıyla katılması. Masaüstü web, mobil web ve
 * native (Capacitor iOS/Android) kabuğu AYNI modülü kullanır — üç ayrı sistem
 * yoktur.
 *
 * BU MODÜL BİR GÜVENLİK OTORİTESİ DEĞİLDİR.
 * Gerçek yetki her modun `*_join_room` SECURITY DEFINER RPC'sindedir; orada
 * oda kilidi altında kapasite, oda durumu, oda-içi nick çakışması ve
 * `assert_display_name_allowed` (kayıtlı username taklidi + yasaklı kelime)
 * kontrol edilir. Buradaki her şey yalnız anlık UI geri bildirimi ve bağlam
 * taşımadır.
 *
 * NICK DOĞRULAMA — KOPYA YOK:
 * Oyun-içi görünen ad kuralları TEK yerde: `lib/displayName.ts` (3–16 karakter,
 * küçük harf + rakam + alt çizgi + Türkçe karakter, BANNED_USERNAME_WORDS
 * filtresi). auth.ts da aynı modülü re-export eder. Bu modül kuralları YENİDEN
 * TANIMLAMAZ, delege eder — böylece lobi içi ad alanı ile misafir katılma
 * ekranı bit-bit aynı kuralı kullanır.
 */
import { validateUsername, normalizeUsername } from "./displayName";
import type { RoomCodeModeKey } from "./roomCodeShared";

/* ════════════════════════════════════════════════════════════════════════
   1) Hangi modlara misafir katılabilir?
   ════════════════════════════════════════════════════════════════════════
   Kaynak: sunucudaki grant'lar. Aşağıdaki modların `*_join_room` /
   `*_register_player` RPC'si `anon`a açıktır ve misafir kimliğini
   (profile_id NULL + guest_id + claim_token) destekler.

   korNokta (tevatur_*) 20260809120000 ile bu listeye KATILDI. Daha önce
   dışarıdaydı çünkü `tevatur_players.profile_id` NOT NULL idi ve
   `tevatur_authorize_player` yalnız `profile_id = auth.uid()` kabul ediyordu —
   yani misafir kavramı bu modda hiç modellenmemişti. Migration şemayı diğer
   yedi modun kullandığı (profile_id XOR guest_id + claim_token) desenine
   hizaladı; oda KURMA hâlâ yalnız kayıtlı kullanıcıya açıktır. */
const GUEST_JOINABLE: ReadonlySet<RoomCodeModeKey> = new Set<RoomCodeModeKey>([
  "duel",
  "flagDuel",
  "wheelDuel",
  "duelGroup",
  "wheelGroup",
  "flagGroup",
  "routeDuel",
  "conquest",
  "korNokta",
]);

export function isGuestJoinableMode(mode: RoomCodeModeKey): boolean {
  return GUEST_JOINABLE.has(mode);
}

/** Misafirin katılamayacağı (login-only) modlar için kullanıcıya gösterilecek
 *  metin. Tek yerde tutulur ki web/mobil/native aynı cümleyi göstersin. */
export const GUEST_MODE_BLOCKED_MESSAGE =
  "Bu mod yalnızca hesabı olan oyunculara açık. Katılmak için giriş yap.";

/** Misafir "Oda Kur"a bastığında gösterilecek metin. Asıl engel sunucudadır
 *  (*_create_room RPC'lerinden `anon` grant'i geri alındı); bu yalnız net bir
 *  kullanıcı mesajı verir, güvenlik kontrolü DEĞİLDİR. */
export const GUEST_CANNOT_CREATE_MESSAGE =
  "Oda kurmak için giriş yapmalısın. Misafir olarak yalnızca davet edildiğin odalara katılabilirsin.";

/* ════════════════════════════════════════════════════════════════════════
   2) Nick doğrulama — mevcut merkezî kuralın aynısı
   ════════════════════════════════════════════════════════════════════════ */

/** Kullanıcının yazdığı ham metni temizler: baş/son boşluk + iç boşluk
 *  tekilleştirme + görünmez karakterler. Sunucu `btrim` uyguladığı için
 *  baş/son boşluk zaten anlamsızdır; burada erken temizlemek "  Enes  " ile
 *  "Enes"in aynı olduğunu kullanıcıya ANINDA gösterir. */
export function sanitizeGuestName(raw: string): string {
  return (raw ?? "")
    // zero-width / BOM / kontrol karakterleri
    .replace(
      new RegExp(
        "[\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]",
        "g"
      ),
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Oda-içi çakışma karşılaştırması için kanonik biçim.
 * SUNUCUNUN AYNASI: `lower(btrim(name))`. "Enes", "enes" ve "  ENES  " aynı
 * kabul edilir. Otorite sunucudaki `name_taken` kontrolüdür.
 */
export function normalizeGuestName(raw: string): string {
  return normalizeUsername(sanitizeGuestName(raw));
}

/**
 * Misafir nick'ini doğrular. Hata varsa Türkçe mesaj, geçerliyse null döner.
 * Kural seti KAYITLI oyuncuların oyun-içi görünen adıyla aynıdır (displayName.ts).
 */
export function validateGuestName(raw: string): string | null {
  const clean = sanitizeGuestName(raw);
  if (clean.length === 0) return "Bir kullanıcı adı yaz.";
  // Boşluk içeren adlar sunucu regex'ine takılır; net mesaj verelim.
  if (/\s/.test(clean)) return "Kullanıcı adında boşluk olamaz.";
  return validateUsername(clean);
}

/** Kayıtlı bir hesaba ait ad denendiğinde gösterilecek metin (tek kaynak).
 *  Ürün kararı: kayıtlı kullanıcı adları, sahibi odada OLMASA BİLE misafirlere
 *  kapalıdır. */
export const GUEST_NAME_REGISTERED_MESSAGE =
  "Bu kullanıcı adı kayıtlı bir hesaba ait. Başka bir ad seç veya hesabına giriş yap.";

/** Uygunsuz/rezerve ad metni (tek kaynak). */
export const GUEST_NAME_FORBIDDEN_MESSAGE =
  "Bu kullanıcı adı kullanılamaz. Lütfen farklı bir ad seç.";

export type GuestNameCheck =
  | { status: "ok" }
  | { status: "invalid"; message: string }
  | { status: "forbidden"; message: string }
  | { status: "registered"; message: string }
  | { status: "error"; message: string };

/**
 * SUNUCU ÖN KONTROLÜ — `check_guest_display_name` RPC'si.
 *
 * Nick ekranı bir adın kayıtlı bir hesaba ait olup olmadığını tek başına
 * bilemez; bu kontrol o kararı ekranın kendisinde verdirir. Böylece kullanıcı
 * adı yazıp ekranı geçtikten sonra katılma anında anlaşılmaz bir hata almaz.
 *
 * OTORİTE DEĞİLDİR: gerçek karar katılma anındaki
 * `assert_display_name_allowed`'dır (ön kontrol ile katılma arasında ad
 * kaydedilmiş olabilir). Bu yüzden katılma hatası ayrıca ele alınır.
 *
 * Ağ hatasında "error" döner — kullanıcıyı kilitlemeyiz, katılma denenir ve
 * gerçek karar sunucudan gelir.
 */
export async function checkGuestNameOnServer(
  raw: string
): Promise<GuestNameCheck> {
  try {
    const { supabase } = await import("./supabase");
    const { data, error } = await supabase.rpc("check_guest_display_name", {
      p_name: sanitizeGuestName(raw),
    });
    if (error) return { status: "error", message: "Bağlantı hatası." };
    if (data === "ok") return { status: "ok" };
    if (data === "registered") {
      return { status: "registered", message: GUEST_NAME_REGISTERED_MESSAGE };
    }
    if (data === "forbidden") {
      return { status: "forbidden", message: GUEST_NAME_FORBIDDEN_MESSAGE };
    }
    return {
      status: "invalid",
      message: "Bu kullanıcı adı geçersiz. 3-16 karakter kullan.",
    };
  } catch {
    return { status: "error", message: "Bağlantı hatası." };
  }
}

/* ════════════════════════════════════════════════════════════════════════
   3) Misafir oturumu — saklama
   ════════════════════════════════════════════════════════════════════════
   Burada SAKLANAN tek şey misafirin seçtiği görünen addır. Yetki veren
   kimlik (guest_id + claim_token) her modun kendi localStorage oturumunda
   tutulur ve sunucuda `*_authorize_player(player_id, claim_token)` ile
   doğrulanır — istemcideki hiçbir değer tek başına yetki vermez.

   Neden localStorage: sayfa yenileme, sekme kapanması ve iOS uygulamasının
   arka plandan dönmesi arasında ayakta kalması gerekir (yeniden bağlanma).
   Native kabukta da WKWebView localStorage'ı kalıcıdır; ayrı bir Capacitor
   Preferences yoluna gerek yoktur (tek ortak kod yolu korunur).

   Süre: TTL sonunda ad unutulur → "süresi dolduğunda temizlenmeli" kuralı.
   Oyuncu slotunun kendisi sunucu tarafındaki oda temizliğine tabidir. */

const GUEST_NAME_KEY = "torble_guest_display_name";
/** Misafir adının hatırlanma süresi: 12 saat. Aynı gün içinde tekrar davet
 *  linkine tıklayan oyuncu adını yeniden yazmaz; ertesi gün temiz başlar. */
const GUEST_NAME_TTL_MS = 12 * 60 * 60 * 1000;

interface StoredGuestName {
  name: string;
  at: number;
}

/** Hatırlanan misafir adı (varsa ve süresi dolmamışsa). */
export function getGuestName(): string | null {
  try {
    const raw = localStorage.getItem(GUEST_NAME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredGuestName | null;
    if (!parsed?.name || typeof parsed.at !== "number") return null;
    if (Date.now() - parsed.at > GUEST_NAME_TTL_MS) {
      localStorage.removeItem(GUEST_NAME_KEY);
      return null;
    }
    // Kayıttan gelen değeri de doğrula: kural değiştiyse bayat ad kullanılmasın.
    if (validateGuestName(parsed.name)) {
      localStorage.removeItem(GUEST_NAME_KEY);
      return null;
    }
    return parsed.name;
  } catch {
    return null;
  }
}

export function setGuestName(name: string): void {
  try {
    const clean = sanitizeGuestName(name);
    if (!clean) return;
    localStorage.setItem(
      GUEST_NAME_KEY,
      JSON.stringify({ name: clean, at: Date.now() } satisfies StoredGuestName)
    );
  } catch {
    /* localStorage kapalı (private mode) — ad yalnız bu oturumda yaşar */
  }
}

/** Misafir hesap açtığında / odadan tamamen ayrıldığında çağrılır. */
export function clearGuestName(): void {
  try {
    localStorage.removeItem(GUEST_NAME_KEY);
  } catch {
    /* yoksay */
  }
}

/* ════════════════════════════════════════════════════════════════════════
   4) Bekleyen misafir katılımı (bağlam taşıma)
   ════════════════════════════════════════════════════════════════════════
   Davet bağlantısı / oda kodu çözüldükten sonra kullanıcı nick ekranına
   gider. O ekranda iken:
     • uygulama arka plana atılabilir (iOS),
     • sayfa yenilenebilir,
     • kullanıcı "Giriş Yap"a basıp OAuth round-trip'ine girebilir.
   Bu durumların hiçbirinde oda kodu KAYBOLMAMALIDIR.

   sessionStorage DEĞİL localStorage: iOS'ta uygulama tamamen kapatılıp
   yeniden açıldığında (cold start) sessionStorage silinir; kabul kriteri
   "Uygulama tamamen kapalıyken bağlantıya basılırsa oda kodu kaybolmamalı"
   bunu gerektirir. Kısa TTL ile sınırlanır. */

const PENDING_GUEST_JOIN_KEY = "torble_pending_guest_join";
/** Bekleyen katılım bağlamının ömrü: 30 dakika. */
const PENDING_TTL_MS = 30 * 60 * 1000;

export interface PendingGuestJoin {
  mode: RoomCodeModeKey;
  code: string;
  at: number;
}

export function setPendingGuestJoin(mode: RoomCodeModeKey, code: string): void {
  try {
    localStorage.setItem(
      PENDING_GUEST_JOIN_KEY,
      JSON.stringify({ mode, code, at: Date.now() } satisfies PendingGuestJoin)
    );
  } catch {
    /* yoksay */
  }
}

export function readPendingGuestJoin(): PendingGuestJoin | null {
  try {
    const raw = localStorage.getItem(PENDING_GUEST_JOIN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingGuestJoin | null;
    if (!parsed?.code || !parsed?.mode || typeof parsed.at !== "number") return null;
    if (Date.now() - parsed.at > PENDING_TTL_MS) {
      localStorage.removeItem(PENDING_GUEST_JOIN_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingGuestJoin(): void {
  try {
    localStorage.removeItem(PENDING_GUEST_JOIN_KEY);
  } catch {
    /* yoksay */
  }
}

/* ════════════════════════════════════════════════════════════════════════
   5) "Bu MAÇ misafirken oynandı" işareti — MAÇ BAZLI XP koruması
   ════════════════════════════════════════════════════════════════════════
   PROBLEM: Misafir oyun sonu ekranından hesap açtığında `profile` dolar ve
   oyun bileşenlerindeki XP effect'i yeniden koşar. Önlem alınmazsa
   MİSAFİRKEN oynanan maça geriye dönük XP yazılırdı.

   ÖNCEKİ (HATALI) TASARIM: tek bir global "misafir maçı aktif" bayrağı.
   Yan etkisi: oyuncu hesap açtıktan sonra AYNI odada başlayan YENİ tur da
   bastırılıyordu — yani kayıt olan oyuncu haklı olduğu XP'yi alamıyordu.

   DOĞRU TASARIM (bu sürüm): işaret MAÇ KİMLİĞİNE bağlanır.
     • Maç misafirken bittiğinde o maçın id'si işaretlenir.
     • XP yazılmadan önce "bu maç id'si işaretli mi?" diye bakılır.
     • Yeni tur = YENİ maç id'si → işaretli değil → XP normal yazılır.

   Her modun XP idempotency anahtarı olarak kullandığı kimlik burada da
   kullanılır (duel: room.id · flagDuel: matchId · wheel*: current_match_id ·
   conquest: matchKey), böylece "aynı maç" tanımı XP sistemiyle birebir aynıdır.

   Kayıt tutulur çünkü hesap açma bir sayfa yenilemesi (OAuth) içerebilir;
   in-memory bir ref bunu atlatamaz. Liste kısa tutulur ve süresi dolar. */

const GUEST_MATCH_IDS_KEY = "torble_guest_match_ids";
/** İşaretlerin ömrü: 24 saat (bir maç bundan uzun sürmez). */
const GUEST_MATCH_TTL_MS = 24 * 60 * 60 * 1000;
/** En fazla kaç maç kimliği saklanır (sınırsız büyümeyi engeller). */
const GUEST_MATCH_MAX = 20;

interface GuestMatchEntry {
  id: string;
  at: number;
}

function readGuestMatches(): GuestMatchEntry[] {
  try {
    const raw = localStorage.getItem(GUEST_MATCH_IDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter(
      (e): e is GuestMatchEntry =>
        !!e &&
        typeof e.id === "string" &&
        typeof e.at === "number" &&
        now - e.at <= GUEST_MATCH_TTL_MS
    );
  } catch {
    return [];
  }
}

/**
 * Bu maçın MİSAFİR olarak oynandığını işaretler. Modun XP effect'i, oyuncu
 * giriş yapmamışken maç bittiğinde çağırır. İdempotenttir.
 */
export function markGuestMatchId(matchId: string | null | undefined): void {
  if (!matchId) return;
  try {
    const list = readGuestMatches();
    if (list.some((e) => e.id === matchId)) return;
    list.push({ id: matchId, at: Date.now() });
    // En yeniler kalsın.
    const trimmed = list.slice(-GUEST_MATCH_MAX);
    localStorage.setItem(GUEST_MATCH_IDS_KEY, JSON.stringify(trimmed));
  } catch {
    /* localStorage kapalı — koruma in-memory akışta zaten devrede */
  }
}

/**
 * Bu maç misafirken mi oynandı? true ise XP/altın YAZILMAMALIDIR (oyuncu
 * sonradan hesap açmış olsa bile). Yeni maçlar etkilenmez.
 */
export function isGuestMatchId(matchId: string | null | undefined): boolean {
  if (!matchId) return false;
  return readGuestMatches().some((e) => e.id === matchId);
}

/** Tüm işaretleri siler (çıkış yapma / oturum temizliği). */
export function clearGuestMatchIds(): void {
  try {
    localStorage.removeItem(GUEST_MATCH_IDS_KEY);
  } catch {
    /* yoksay */
  }
}

/* ── M3: işareti BİTİŞTE değil, MAÇ BAŞLARKEN koy ───────────────────────────
 * ESKİ DAVRANIŞ (yetersizdi): işaret yalnız maç bitiminde, oyuncu hâlâ misafir
 * ise konuyordu. Oyuncu 4. turda hesap açarsa bitişte `profile` dolu olduğu
 * için işaret HİÇ konmuyor ve MİSAFİRKEN oynanan maçın TAMAMI hesaba XP
 * yazıyordu (ürün kuralı 9 ihlali). Sonuç ekranı dışında CTA olmadığı için
 * pratikte ulaşılamıyordu; Aşama 1 conversion'ı her auth yoluna açtığı için
 * artık ulaşılabilir — bu yüzden burada kapatılıyor.
 *
 * YENİ KURAL: maç GERÇEKTEN başladıysa ve oyuncu O AN misafirse, maç kimliği
 * hemen işaretlenir. Sonrasında hesap açması işareti kaldırmaz → o maça XP
 * yazılmaz.
 *
 * İKİ YANLIŞ İŞARETLEMEYİ BİLİNÇLİ OLARAK ELER:
 *   • `matchStarted` false iken (lobi/kurulum) İŞARETLEMEZ. Misafir LOBİDE
 *     hesap açıp sonra maça girerse maç kayıtlı başlar → XP hak eder (kural 10).
 *   • `isGuest` false iken İŞARETLEMEZ → kayıtlı başlayan maç asla misafir
 *     maçı sayılmaz.
 *
 * Bitişteki mevcut guard KALDIRILMADI: bu ikisi birbirinin yedeği (oyuncu
 * maçın tamamını misafir oynarsa iki yol da aynı sonuca varır, işaret
 * idempotenttir). */
export function shouldMarkGuestOriginMatch(
  matchId: string | null | undefined,
  opts: { matchStarted: boolean; isGuest: boolean }
): boolean {
  if (!matchId) return false;
  if (!opts.matchStarted) return false;
  return opts.isGuest;
}

/** `shouldMarkGuestOriginMatch` + kalıcı işaret. Oyun bileşenleri maç
 *  sürerken her render'da çağırabilir; idempotenttir. */
export function noteGuestOriginMatch(
  matchId: string | null | undefined,
  opts: { matchStarted: boolean; isGuest: boolean }
): void {
  if (!shouldMarkGuestOriginMatch(matchId, opts)) return;
  markGuestMatchId(matchId);
}

/* ════════════════════════════════════════════════════════════════════════
   6) Misafir slotunu hesaba devretme
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Her modun oda oturumunu sakladığı localStorage anahtarları.
 *
 * Modlar tarihsel olarak iki farklı düzen kullanıyor:
 *   (a) claim_token oda oturumunun İÇİNDE  → { roomId, roomCode, playerId, claimToken }
 *   (b) claim_token AYRI bir anahtarda      → room: { roomId, roomCode, playerId }
 * Aşağıdaki tablo ikisini de tarif eder; resolver her iki düzeni de okur.
 * Bu anahtarlar ilgili oyun bileşenlerindeki ROOM_KEY / CLAIM_TOKEN_KEY
 * sabitleriyle BİREBİR aynı olmalıdır (drift = sessiz başarısızlık).
 *
 * conquest KASTEN yok: Kuşatma oturumunu farklı bir claim mekanizmasıyla
 * tutuyor (conquest_player_claims, playerId'ye göre); devri ConquestMode
 * kendi içinde `recallConquestClaim` ile tetikler.
 */
const MODE_SESSION_KEYS: Partial<
  Record<RoomCodeModeKey, { room: string; claim?: string; player?: string }>
> = {
  duel:       { room: "geoquiz_duel_room" },
  flagDuel:   { room: "geoquiz_flagduel_room" },
  duelGroup:  { room: "geoquiz_group_room" },
  flagGroup:  { room: "geoquiz_flaggroup_room" },
  wheelDuel:  { room: "geoquiz_wheel_duel_room",  claim: "geoquiz_wheel_duel_claim_token" },
  wheelGroup: { room: "geoquiz_wheel_group_room", claim: "geoquiz_wheel_group_claim_token" },
  routeDuel:  { room: "torble_route_duel_room",   claim: "torble_route_duel_claim_token" },
  // Kör Nokta: YENİ oturumlar claim_token'ı ROOM_KEY içinde tutar (kanonik);
  // `claim` anahtarı ESKİ oturumlar için geriye dönük yedektir. `player`
  // yalnız temizlikte kullanılır (KorNoktaMode PLAYER_ID_KEY ile aynı olmalı).
  korNokta:   {
    room:   "geoquiz_kornokta_room",
    claim:  "geoquiz_kornokta_claim_token",
    player: "geoquiz_kornokta_player_id",
  },
};

/** Aktif oda oturumu. `roomId`/`roomCode` yalnız oturumu YAZAN modlarda dolar. */
export interface ModeRoomSession {
  roomId: string;
  roomCode: string;
  playerId: string;
  claimToken: string;
}

/**
 * Aktif oda oturumunu okur.
 *
 * CLAIM_TOKEN KAYNAK SIRASI (önemli):
 *   1. ROOM_KEY içindeki `claimToken` — KANONİK. İki ayrı localStorage yazımı
 *      ATOMİK DEĞİLDİR; tek nesne içinde tutulan değer, oda kimliğiyle birlikte
 *      yazıldığı için birbirinden ayrı düşemez.
 *   2. Ayrı `claim` anahtarı — yalnız ESKİ (inline alanı olmayan) oturumlar için.
 *
 * roomId/roomCode boş dönebilir (bazı modlar yazmaz); çağıran kontrol etmeli.
 */
export function readModeRoomSession(
  mode: RoomCodeModeKey
): ModeRoomSession | null {
  const keys = MODE_SESSION_KEYS[mode];
  if (!keys) return null;
  try {
    const raw = localStorage.getItem(keys.room);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const playerId = str(parsed.playerId);
    const inline = str(parsed.claimToken);
    const legacy = keys.claim ? localStorage.getItem(keys.claim) ?? "" : "";
    const claimToken = inline || legacy;   // inline KANONİK, legacy yedek
    if (!playerId || !claimToken) return null;
    return {
      roomId:   str(parsed.roomId),
      roomCode: str(parsed.roomCode),
      playerId,
      claimToken,
    };
  } catch {
    return null;
  }
}

/**
 * Bir modun oda oturumunu TAMAMEN siler (oda + legacy claim + player id).
 * Kısmi temizlik bırakmamak önemlidir: geride kalan tek bir anahtar, bir
 * sonraki açılışta yarım bir oturum gibi okunup restore'u şaşırtabilir.
 *
 * Misafir kimliği (guest_id) KASTEN silinmez — odalar arasında yaşar.
 */
export function clearModeRoomSession(mode: RoomCodeModeKey): void {
  const keys = MODE_SESSION_KEYS[mode];
  if (!keys) return;
  try {
    localStorage.removeItem(keys.room);
    if (keys.claim) localStorage.removeItem(keys.claim);
    if (keys.player) localStorage.removeItem(keys.player);
  } catch {
    /* localStorage kapalı — yoksay */
  }
}

/* ── Devir sonucu ───────────────────────────────────────────────────────────
 * ESKİ SÖZLEŞME `Promise<boolean>` idi ve üç FARKLI durumu tek `false`'a
 * eziyordu: "oturum yok", "sunucu reddetti", "ağ hatası". Çağıran taraf
 * hangisinin olduğunu bilemediği için ne retry edebiliyor ne de teşhis
 * koyabiliyordu (audit m1/m2).
 *
 *   linked     → satır artık bu hesaba ait (yeni devir VEYA zaten devredilmiş;
 *                RPC idempotent `true` döndüğü için ikisi ayrılmaz — ve
 *                çağıran için de farkı yoktur).
 *   no-session → devredilecek yerel oturum yok. Hata DEĞİL.
 *   rejected   → sunucu KESİN olarak hayır dedi (claim_mismatch,
 *                not_a_guest_row, already_in_room…). Tekrar denemek anlamsız.
 *   error      → taşıma/geçici hata. Tek kontrollü retry'dan sonra da
 *                sürüyorsa çağıran DAHA SONRA tekrar deneyebilir. */
export type GuestLinkStatus = "linked" | "no-session" | "rejected" | "error";

export interface GuestLinkOutcome {
  status: GuestLinkStatus;
  /** Sunucu SQLSTATE'i (rejected) veya taşıma hata kodu. */
  code?: string;
  message?: string;
  /** Kaç RPC denemesi yapıldı (1 veya 2). Teşhis içindir. */
  attempts?: number;
}

/** `torble_link_guest_player`'ın KESİN "hayır" cevapları (migration
 *  20260808120000 D + 20260809120000 B6). Bu kodlarda retry YAPILMAZ:
 *    42501 auth_required / not_a_guest_row / claim_mismatch
 *    22023 mode_invalid / claim_token_required
 *    02000 player_not_found
 *    P0001 already_in_room
 *  Listede OLMAYAN her kod (ve kodsuz ağ hatası) geçici sayılır — bilinmeyen
 *  bir kodu geçici saymak, kalıcı saymaktan daha güvenli: en fazla bir fazla
 *  istek atılır, kalıcı saymak ise devri sessizce kaybettirirdi. */
const GUEST_LINK_REJECT_CODES: ReadonlySet<string> = new Set([
  "42501",
  "22023",
  "02000",
  "P0001",
]);

export function isTransientLinkFailure(code: string | null | undefined): boolean {
  if (!code) return true;
  return !GUEST_LINK_REJECT_CODES.has(code);
}

/* ── Teşhis halkası ─────────────────────────────────────────────────────────
 * "Sessiz yutma" yasak: her linked-olmayan sonuç konsola yazılır ve son N
 * sonuç bellekte tutulur. Halka SINIRLI (bellek sızdırmaz) ve yalnız teşhis
 * amaçlıdır — hiçbir akış buna bakarak karar VERMEZ. */
export interface GuestLinkLogEntry extends GuestLinkOutcome {
  mode: RoomCodeModeKey;
  playerId: string;
  at: number;
}

const GUEST_LINK_LOG_MAX = 20;
const guestLinkLog: GuestLinkLogEntry[] = [];

export function getGuestLinkDiagnostics(): readonly GuestLinkLogEntry[] {
  return guestLinkLog;
}

function recordGuestLink(
  mode: RoomCodeModeKey,
  playerId: string,
  outcome: GuestLinkOutcome
): GuestLinkOutcome {
  guestLinkLog.push({ ...outcome, mode, playerId, at: Date.now() });
  if (guestLinkLog.length > GUEST_LINK_LOG_MAX) guestLinkLog.shift();

  if (outcome.status !== "linked" && outcome.status !== "no-session") {
    console.warn(
      `[guestLink] ${mode} ${playerId.slice(0, 8)} → ${outcome.status}` +
        (outcome.code ? ` (${outcome.code})` : "") +
        (outcome.message ? `: ${outcome.message}` : "")
    );
  }
  return outcome;
}

/* DEV'de tarayıcı konsolundan okunabilsin (manuel QA + kısa tarayıcı testi).
 * Prod bundle'ına GİRMEZ. */
if (import.meta.env?.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__torbleGuestLink =
    getGuestLinkDiagnostics;
}

/** Tek RPC denemesi. Throw ETMEZ; her yolu bir outcome'a çevirir. */
async function attemptGuestLink(params: {
  mode: RoomCodeModeKey;
  playerId: string;
  claimToken: string;
}): Promise<GuestLinkOutcome> {
  try {
    const { supabase } = await import("./supabase");
    const { data, error } = await supabase.rpc("torble_link_guest_player", {
      p_mode: params.mode,
      p_player_id: params.playerId,
      p_claim_token: params.claimToken,
    });
    if (error) {
      const code = typeof error.code === "string" ? error.code : undefined;
      return {
        status: isTransientLinkFailure(code) ? "error" : "rejected",
        code,
        message: error.message,
      };
    }
    // RPC ya `true` döner ya da raise eder; `true` olmayan cevap beklenmeyen
    // bir durumdur — retry döngüsüne sokmamak için KESİN sayılır.
    return data === true
      ? { status: "linked" }
      : { status: "rejected", message: "rpc_returned_non_true" };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** `torble_link_guest_player` RPC'sinin istemci sarmalayıcısı.
 *
 *  Odadaki AYNI satır yeni hesaba bağlanır; oyuncu listesinde ikinci bir kişi
 *  OLUŞMAZ. Başarısızlık ÖLÜMCÜL DEĞİLDİR — oyuncu misafir olarak devam eder,
 *  oyun akışı bozulmaz. Bu yüzden hiç throw etmez, outcome döner.
 *
 *  RETRY: yalnız `error` (geçici) sonucunda ve YALNIZ BİR KEZ. Devir idempotent
 *  olduğu için tekrar denemek güvenlidir; `rejected` sonucunda tekrar denemek
 *  ise yalnız gereksiz yük olurdu.
 *
 *  XP/altın/görev AKTARMAZ; yalnız kimlik devri yapar. */
export async function linkGuestPlayerToAccount(params: {
  mode: RoomCodeModeKey;
  playerId: string;
  claimToken: string;
}): Promise<GuestLinkOutcome> {
  let outcome = await attemptGuestLink(params);
  if (outcome.status === "error") {
    await new Promise((r) => setTimeout(r, GUEST_LINK_RETRY_DELAY_MS));
    outcome = { ...(await attemptGuestLink(params)), attempts: 2 };
  } else {
    outcome.attempts = 1;
  }
  return recordGuestLink(params.mode, params.playerId, outcome);
}

/** Tek retry'ın bekleme süresi. Kısa: kullanıcı sonuç ekranında bekliyor. */
const GUEST_LINK_RETRY_DELAY_MS = 600;

/**
 * Misafir hesap açtıktan sonra odadaki slotunu yeni hesabına devreder.
 * Oturum bilgisini kendisi bulur; bulamazsa `no-session` döner (oyuncu misafir
 * olarak kalmaya devam eder, oyun akışı BOZULMAZ).
 */
export async function linkActiveGuestSession(
  mode: RoomCodeModeKey
): Promise<GuestLinkOutcome> {
  const session = readModeRoomSession(mode);
  if (!session) return { status: "no-session" };
  return linkGuestPlayerToAccount({
    mode,
    playerId: session.playerId,
    claimToken: session.claimToken,
  });
}

/* ── Auth-flip uzlaştırması: hangi slotlar devredilecek? ────────────────────
 * Bu SAF fonksiyon, "kullanıcı authenticated oldu" anında devredilmeye aday
 * TÜM yerel oturumları listeler. Ekrana, `authPromptReason`'a veya herhangi bir
 * geçici UI state'ine BAKMAZ — C2'nin kökü buydu: OAuth redirect'i sayfayı
 * baştan yüklediği için React state'i (ve `screen`) yok oluyor, ama
 * localStorage'daki oturum SAĞ KALIYOR. Karar yalnız kalıcı veriye dayanır.
 *
 * KUŞATMA neden burada: kendi oturumunu React state'inde tutuyor, ama
 * claim_token'ı `conquest:claim:<playerId>` altında KALICI olarak saklıyor.
 * Bu anahtarları okuyunca Kuşatma da reload'dan sağ çıkan tek ortak yolu
 * kullanır (audit I: iki sistemin drift etmesi riski). ConquestMode'daki
 * yerinde tetikleyici KALDIRILMADI — o, devirden sonra satırı anında
 * tazeleyip "Misafir" etiketini düşürüyor; bu ise reload sonrası ağdır.
 *
 * FAZLADAN ÇAĞRI ZARARSIZDIR: kayıtlı kullanıcının kendi satırı için RPC
 * idempotent `true` döner; başkasının satırı için `rejected`. Yani liste
 * "kesin misafir" olmak zorunda değil, "aday" olması yeter. */
export interface GuestLinkTarget {
  mode: RoomCodeModeKey;
  playerId: string;
  claimToken: string;
}

/** `conquestClaim.ts` ile PAYLAŞILAN anahtar öneki. Tek yerde durur ki iki
 *  modül birbirinden habersiz kaymasın (drift = sessiz başarısızlık). */
export const CONQUEST_CLAIM_KEY_PREFIX = "conquest:claim:";

/** Aynı anda makul sayıda Kuşatma claim'i tutulabilir; odadan çıkışta
 *  `forgetConquestClaim` siliyor, yine de üst sınır konur. */
const CONQUEST_CLAIM_SCAN_MAX = 8;

export function readStoredConquestClaims(): GuestLinkTarget[] {
  const out: GuestLinkTarget[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(CONQUEST_CLAIM_KEY_PREFIX)) continue;
      const playerId = key.slice(CONQUEST_CLAIM_KEY_PREFIX.length);
      const claimToken = localStorage.getItem(key) ?? "";
      if (!playerId || !claimToken) continue;
      out.push({ mode: "conquest", playerId, claimToken });
      if (out.length >= CONQUEST_CLAIM_SCAN_MAX) break;
    }
  } catch {
    /* localStorage kapalı — aday yok */
  }
  return out;
}

export function resolveGuestLinkTargets(
  readSession: (mode: RoomCodeModeKey) => ModeRoomSession | null =
    readModeRoomSession,
  readConquestClaims: () => GuestLinkTarget[] = readStoredConquestClaims
): GuestLinkTarget[] {
  const out: GuestLinkTarget[] = [];
  const seen = new Set<string>();

  const push = (t: GuestLinkTarget) => {
    if (!t.playerId || !t.claimToken) return;
    const key = `${t.mode}:${t.playerId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };

  for (const mode of Object.keys(MODE_SESSION_KEYS) as RoomCodeModeKey[]) {
    const session = readSession(mode);
    if (!session) continue;
    push({
      mode,
      playerId: session.playerId,
      claimToken: session.claimToken,
    });
  }

  for (const target of readConquestClaims()) push(target);

  return out;
}
