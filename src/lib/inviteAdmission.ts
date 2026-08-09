/**
 * inviteAdmission.ts — davet linki KABUL KARARI (saf, yan etkisiz).
 *
 * NEDEN AYRI DOSYA:
 * Karar App.tsx içinde gömülü kalsaydı yalnız gerçek tarayıcı + gerçek Supabase
 * oturumuyla test edilebilirdi. Kural setini (sunucu doğrulaması + aktif oda
 * önceliği) buraya alarak Supabase'siz, React'siz ve ağsız test edilebilir hâle
 * getiriyoruz — `conquestJoinFlow.ts` ile AYNI desen.
 *
 * Bu modül AĞA ÇIKMAZ: `resolveRoomCode`u çağıran taraf çağırır ve sonucu
 * (`RoomCodeResolution`) buraya girdi olarak verir. Böylece doğrulama otoritesi
 * yine tek yerde (sunucudaki `resolve_torble_room_code`) kalır; burada yalnız
 * o cevabın NASIL yorumlanacağı yaşar.
 */
import type { RoomCodeModeKey, RoomCodeResolution } from "./roomCodeShared";
import { roomCodeErrorMessage } from "./roomCodeShared";
import type { RoomExitOutcome } from "./roomExit";

/** Kabul kararı. */
export type InviteAdmission =
  /** Yönlendir — davet geçerli ve kesintiye uğratacağı bir oda yok. */
  | { kind: "route" }
  /** Reddet — oda yok/geçersiz. Ekran DEĞİŞMEZ, yalnız mesaj gösterilir. */
  | { kind: "reject"; message: string }
  /** Onay iste — geçerli davet ama oyuncu başka bir odanın içinde. */
  | { kind: "confirm"; fromMode: RoomCodeModeKey };

export interface InviteAdmissionInput {
  /** Davetin hedef modu (link parametresinden). */
  mode: RoomCodeModeKey;
  /** Normalize edilmiş oda kodu. */
  code: string;
  /** `resolveRoomCode` sonucu — SUNUCU cevabı. */
  resolution: RoomCodeResolution;
  /**
   * Oyuncunun ŞU AN bulunduğu ekranın oda modu (`roomModeForScreen`), yoksa
   * null. Ekranda olmak odada olmayı garanti etmez — `activeModes` ile birlikte
   * değerlendirilir.
   */
  currentRoomMode: RoomCodeModeKey | null;
  /** Kalıcı oturumu bulunan modlar (`resolveGuestLinkTargets` çıktısından). */
  activeModes: readonly RoomCodeModeKey[];
  /** Bulunulan odanın kodu (biliniyorsa) — aynı odanın linki kesinti sayılmaz. */
  currentRoomCode: string | null;
}

/**
 * Davetin kabul edilip edilmeyeceğine karar verir.
 *
 * SIRA BİLİNÇLİ — önce doğrulama, sonra kesinti onayı: var olmayan bir oda için
 * oyuncuya "oyunundan çıkmak ister misin?" diye SORULMAZ. Bu sayede
 * "aktif oyun + geçersiz davet" senaryosunda oyun hiç rahatsız edilmez.
 */
export function decideInviteAdmission(input: InviteAdmissionInput): InviteAdmission {
  const { mode, code, resolution, currentRoomMode, activeModes, currentRoomCode } = input;

  /* ── 1) Sunucu doğrulaması (audit M3) ──────────────────────────────────
   * `error` = ağ/sunucu hatası → durum BİLİNMİYOR. Kullanıcının AÇIK niyetini
   * geçici bir bağlantı hatası yüzünden çöpe atmayız; gerçek karar zaten
   * katılma anında sunucuda verilecek. (GuestJoinScreen'deki nick ön-kontrolü
   * de aynı ilkeyle ağ hatasında ilerlemeye izin verir.)
   */
  if (resolution.result !== "error") {
    const valid =
      (resolution.result === "found" && resolution.match.mode === mode) ||
      (resolution.result === "ambiguous" &&
        resolution.matches.some((m) => m.mode === mode));
    if (!valid) {
      return {
        kind: "reject",
        // `found` ama BAŞKA mod → bu modda bu kodla oda yok; genel mesaj doğru.
        message: roomCodeErrorMessage(resolution) ?? "Bu kodla aktif bir oda bulunamadı.",
      };
    }
  }

  /* ── 2) Aktif oda önceliği (audit M1) ──────────────────────────────────
   * Kesinti YALNIZ oyuncu oda taşıyan bir ekrandayken VE o modun kalıcı
   * oturumu gerçekten varken söz konusudur. Modu menüden açmış ama henüz oda
   * kurmamış/katılmamış oyuncu gereksiz yere sorgulanmaz.
   */
  const inRoom = currentRoomMode !== null && activeModes.includes(currentRoomMode);
  if (!inRoom) return { kind: "route" };

  // Zaten İÇİNDE olduğumuz odanın linki → kesinti yok.
  if (currentRoomMode === mode && currentRoomCode !== null && currentRoomCode === code) {
    return { kind: "route" };
  }

  return { kind: "confirm", fromMode: currentRoomMode };
}

/** Çıkış el sıkışması sonrası ne yapılacağı. */
export type PostExitDecision =
  /** Yeni daveti işle. */
  | { kind: "proceed" }
  /** Daveti İŞLEME; mevcut oda/oyun dokunulmamış sayılır, hata göster. */
  | { kind: "abort"; message: string };

/**
 * `requestRoomExit` sonucunu yönlendirme kararına çevirir.
 *
 * KURAL: yönlendirme YALNIZ çıkış kesin olarak tamamlandığında yapılır.
 * `exit-failed` → oyuncunun odası hâlâ duruyor olabilir; davet işlenmez.
 * `no-active-room` → çıkılacak bir şey yoktu (oyuncu bu arada kendi ayrılmış
 * olabilir); ilerlemek güvenlidir, hata değildir.
 */
export function decideAfterExit(outcome: RoomExitOutcome): PostExitDecision {
  if (outcome.ok) return { kind: "proceed" };
  if (outcome.reason === "no-active-room") return { kind: "proceed" };
  return {
    kind: "abort",
    message: "Mevcut odadan çıkılamadı. Bağlantını kontrol edip tekrar dene.",
  };
}
