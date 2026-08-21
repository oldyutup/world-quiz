/**
 * korNoktaLeaveNotice.ts — "oyuncu ayrıldı, oyun devam ediyor" KARARI.
 *
 * Neden ayrı dosya: karar bir React effect'inin içinde yaşarken test
 * edilemiyordu ve buradaki tek gerçek risk bir YARIŞ durumu (aşağıda) —
 * yani regex'le değil, çalıştırarak doğrulanması gereken bir şey. Karar
 * saf bir fonksiyona alındığında dört senaryo (2v2 / 3v3 ilk / 3v3 ikinci /
 * misafir-kayıtlı) doğrudan sürülebiliyor. (Aynı desen: conquestJoinFlow.ts.)
 *
 * YARIŞ — bu fonksiyonun şekli buna göre
 * ─────────────────────────────────────
 * Kayıtlı kullanıcıda `tevatur_players` ve `tevatur_rooms` AYRI
 * postgres_changes olaylarıyla gelir. Oyuncu satırı silindiği an oda satırı
 * hâlâ ESKİ olabilir; yani 2v2'de bile bir anlığına "status='playing' +
 * kadro küçüldü" görünür. `status`a bakarak karar vermek, maçın BİTTİĞİ
 * 2v2'de "Oyun devam ediyor" yazmak demekti.
 *
 * Bu yüzden tazelik ölçütü `teamIds`tir: sunucu (20260821120000)
 * `game_state.teams`i status ile AYNI update satırında yazar. Ayrılan id
 * teams'ten düşmüşse elimizdeki oda satırı kesinlikle çıkış-SONRASIDIR ve o
 * satırın status'u otoritedir. Hâlâ teams'teyse oda satırı eskidir → karar
 * ERTELENİR (çağıran effect oda güncellenince yeniden koşar).
 *
 * Ad buradan üretilmez: çağıran, çıkıştan ÖNCEKİ sunucu okumasından
 * hatırladığı `tevatur_players.name` değerini verir. O ad sunucuda üretilir
 * (kayıtlıda profiles.username, misafirde assert_display_name_allowed
 * süzgeci) — eş-istemci broadcast'i DEĞİLDİR.
 */

export interface KnLeaveNoticeInput {
  /** Oda satırının durumu (`tevatur_rooms.status`). */
  status: string;
  /** Şu an odada olan oyuncu id'leri (yetkili RPC okumasından). */
  livePlayerIds: readonly string[];
  /** game_state.teams.blue + .red — oda satırının tazelik ölçütü. */
  teamIds: readonly string[];
  /** Daha önceki sunucu okumalarından hatırlanan id → ad. */
  knownRoster: ReadonlyMap<string, string>;
  /** Bu oda için daha önce duyurulmuş (ya da bastırılmış) id'ler. */
  announced: ReadonlySet<string>;
  /** Kendi oyuncu id'm — kendi çıkışım bana toast'lanmaz. */
  myId: string;
}

export interface KnLeaveNotice {
  playerId: string;
  name: string;
}

export interface KnLeaveNoticeResult {
  /** Gösterilecek toast'lar. Terminal maçta HER ZAMAN boştur. */
  notices: KnLeaveNotice[];
  /** Duyurulmuş sayılacak id'ler: toast'lananlar + terminalde bastırılanlar. */
  markAnnounced: string[];
}

const EMPTY: KnLeaveNoticeResult = { notices: [], markAnnounced: [] };

export function resolveKnLeaveNotices(input: KnLeaveNoticeInput): KnLeaveNoticeResult {
  const { status, livePlayerIds, teamIds, knownRoster, announced, myId } = input;

  // Kendi çıkışımda çağıran kadroyu boşaltır — tear-down ayrılma değildir.
  if (livePlayerIds.length === 0) return EMPTY;

  // Maç terminal: konuşan taraf terkediş EKRANIDIR, toast değil. Bekleyen her
  // şey duyurulmuş sayılır ki sonradan geriden bir toast düşmesin.
  if (status !== "playing") {
    return { notices: [], markAnnounced: [...knownRoster.keys()] };
  }

  const live = new Set(livePlayerIds);
  const inTeams = new Set(teamIds);
  const notices: KnLeaveNotice[] = [];

  for (const [playerId, name] of knownRoster) {
    if (live.has(playerId)) continue;          // hâlâ odada
    if (playerId === myId) continue;           // ayrılan benim
    if (inTeams.has(playerId)) continue;       // oda satırı ESKİ → ertele
    if (announced.has(playerId)) continue;     // zaten duyuruldu
    notices.push({ playerId, name });
  }

  return { notices, markAnnounced: notices.map(n => n.playerId) };
}

/** Toast metni — tek yerde, testin de okuduğu kaynak. */
export function knLeaveNoticeText(name: string): string {
  return `${name} oyundan ayrıldı. Oyun devam ediyor.`;
}
