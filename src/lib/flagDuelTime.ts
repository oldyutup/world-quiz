/**
 * flagDuelTime.ts — Bayrak Düello sunucu zaman damgası ayrıştırma.
 *
 * NEDEN VAR: `duel_*` tabloları KARIŞIK kolon tipleri taşıyor (canlıda
 * doğrulandı, 2026-08-13):
 *
 *   duel_rooms.started_at       timestamptz  → "…+00:00" EKLİ
 *   duel_rooms.current_flag_at  timestamptz  → "…+00:00" EKLİ
 *   duel_players.last_seen_at   timestamptz  → "…+00:00" EKLİ
 *   duel_rooms.created_at       timestamp    → EK YOK   ⚠
 *   duel_players.joined_at      timestamp    → EK YOK   ⚠
 *   duel_claims.created_at      timestamp    → EK YOK   ⚠
 *
 * PostgREST, ek TAŞIMAYAN kolonu `2026-08-13T18:19:47.347412` diye döner.
 * JavaScript, saat dilimi eki olmayan ISO metnini **cihazın YEREL saati**
 * sayar (ECMA-262: date-time forms without offset = local time), oysa
 * depolanan değer UTC'dir. Sonuç: epoch, cihazın UTC farkı kadar kayar —
 * UTC+3'te 3 sa geri, New York'ta 4 sa İLERİ.
 *
 * Bu, host-SPOF düzeltmesinde (20260813130000) gerçek bir regresyondu:
 * `watchdogDueAtMs`, turun çözülme anını `duel_claims.created_at`'ten
 * hesaplıyor. Damga saatlerce ileri kayınca reveal→advance watchdog'u HİÇ
 * tetiklenmiyor ve iki oyuncu da UTC batısındaysa maç reveal ekranında
 * DONUYOR — yani düzeltmenin kaldırdığı SPOF geri geliyordu. (AŞAMA 1,
 * TIMEOUT yazma, `current_flag_at` = timestamptz kullandığı için sağlamdı;
 * kırılan yalnız AŞAMA 2 idi.) Canlı smoke testi bu farkı yakaladı.
 *
 * `lib/routeDuelConnection.parseServerTimestampMs` BİLEREK kullanılmadı:
 * sözleşmesi "PostgREST timestamptz → epoch ms" ve `route_duel_*` tablolarının
 * TAMAMI timestamptz (20260802120000). Ek-yokluğu durumunu ele almaz; oraya
 * dokunmak Bayrak Düello'yu ilgilendirmeyen bir modun davranışını değiştirirdi.
 */

/** Saat dilimi eki var mı? — SONA çıpalı: `Z`, `+03`, `+0300`, `+03:00`.
 *  Çıpa şart: çıpasız bir kalıp tarih kısmındaki `-` ile eşleşmeye çalışır. */
const TZ_SUFFIX = /(?:[Zz]|[+-]\d{2}(?::?\d{2})?)$/;

/** Saat bileşeni var mı? Yalnız-tarih ("2026-08-13") metinlere `Z` EKLENMEZ:
 *  o form zaten UTC sayılır ve `Z` eklemek geçersiz metin üretirdi. */
const HAS_TIME = /\d{2}:\d{2}/;

/**
 * Sunucudan gelen zaman damgasını epoch ms'ye çevirir.
 *
 * `new Date(x).getTime()` yerine BİREBİR geçer (aynı dönüş tipi, ayrıştırılamaz
 * girdide aynı `NaN`), tek farkı: eki olmayan damgayı UTC sayar.
 *
 *   "2026-08-13T18:19:47.347412"        → UTC olarak ayrıştırılır (Z eklenir)
 *   "2026-08-13T18:19:47.347412+00:00"  → aynen ayrıştırılır
 *   "2026-08-13T18:19:47.347412-04:00"  → aynen ayrıştırılır
 *   "2026-08-13T18:19:47.347412Z"       → aynen ayrıştırılır
 *
 * Saniye kesri KORUNUR; yalnız katı ayrıştırıcı yedeğinde (eski Safari 3
 * haneden fazlasını reddedebiliyor) 3 haneye indirilir.
 */
export function flagDuelServerTimeMs(raw: string | null | undefined): number {
  if (!raw) return NaN;
  const trimmed = raw.trim();
  const iso = TZ_SUFFIX.test(trimmed) || !HAS_TIME.test(trimmed) ? trimmed : `${trimmed}Z`;

  const direct = Date.parse(iso);
  if (Number.isFinite(direct)) return direct;

  // Katı ayrıştırıcı yedeği: boşluk ayracını T yap, saniye kesrini 3 haneye
  // indir. `\d*` ek karakterinde durur, yani "Z"/"+00:00" korunur.
  const retry = Date.parse(iso.replace(" ", "T").replace(/(\.\d{1,3})\d*/, "$1"));
  return Number.isFinite(retry) ? retry : NaN;
}
