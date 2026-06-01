/**
 * progression.ts
 *
 * XP / Level ve mod bazlı istatistik yardımcıları.
 *
 * Tasarım notları:
 *   - Level KESİNLİKLE veritabanında tutulmaz, XP'den hesaplanır.
 *   - XP yalnızca giriş yapmış kullanıcılara verilir. Çağrı yapan taraf
 *     `awardXpEvent` öncesinde profile_id'nin gerçek bir auth user'a ait
 *     olduğundan emin olmalıdır. (RPC tarafı da auth.uid() ile doğrular.)
 *   - XP düşmez; her zaman pozitif eklenir.
 *   - Aynı (profile_id, mode_key, room_id) için XP sadece bir kez yazılır.
 *     DB tarafı UNIQUE constraint ile garanti eder; React tarafında ayrıca
 *     useRef koruması kullanılacak (entegrasyon adımında).
 *   - İleride yeni online modlar (örn. "capitals_duel") sadece yeni bir
 *     ModeKey ve yeni bir calculate*Xp fonksiyonu eklenerek genişletilir.
 */

import { supabase } from "./supabase";

/* ────────────────────────────────────────────────
   Type'lar
   ──────────────────────────────────────────────── */

/** Şu an XP destekli online modlar. İleride buraya yeni mod eklenebilir.
 *  Not: RPC tarafı server-side mode_key whitelist'i uygulayabilir; yeni bir
 *  mode eklerken DB'deki check constraint'inin de güncellenmesi gerekebilir.
 *  awardXpEvent hata durumunda fırlatmaz, sadece result.error doldurur. */
export type ModeKey =
  | "country_duel"
  | "flag_duel"
  | "wheel_duel"
  | "wheel_group"
  | "conquest";

/** Maç sonucu. */
export type MatchResult = "win" | "loss" | "draw";

/** Country Duel XP hesaplaması için girdiler. */
export interface CountryDuelXpParams {
  /** Oyuncunun kaptığı doğru ülke sayısı (kendi skoru). */
  correctCount: number;
  /** Maç sonucu. */
  result: MatchResult;
}

/** Flag Duel XP hesaplaması için girdiler. */
export interface FlagDuelXpParams {
  /** Oyuncunun doğru bildiği bayrak sayısı. */
  correctCount: number;
  /** Maç sonucu. */
  result: MatchResult;
}

/** Wheel Duel (Online Çark 1v1) XP hesaplaması için girdiler. */
export interface WheelDuelXpParams {
  /** Oyuncunun haritada ilk bulduğu doğru ülke sayısı (kendi skoru). */
  correctCount: number;
  /** Maç sonucu. */
  result: MatchResult;
}

/** XP breakdown — hem RPC'ye details olarak gider hem UI'da gösterilebilir. */
export interface XpBreakdown {
  participation: number;
  perCorrect: number;
  correctCount: number;
  correctTotal: number;
  resultBonus: number;
  resultBonusLabel: "win" | "draw" | "loss";
  total: number;
  /**
   * Opsiyonel: XpGainBar'ın breakdown satırındaki 3. parçayı (win/draw/loss
   * etiketinin yerine) override eder. Sıra-bazlı modlar (örn. wheel_group)
   * için "Sıra #1 +10" gibi anlamlı bir metin sağlayabilir.
   *
   * undefined ise XpGainBar mevcut resultBonusLabel switch'ini kullanır →
   * country_duel / flag_duel / wheel_duel davranışı değişmez.
   */
  bonusLabelText?: string;
}

/** Bir level'ın ilerleme durumu — UI bar'ı için. */
export interface LevelProgress {
  /** Mevcut level (1+). */
  level: number;
  /** Mevcut level'ın başlangıç XP eşiği. */
  currentLevelXp: number;
  /** Bir sonraki level'ın XP eşiği. */
  nextLevelXp: number;
  /** Toplam XP. */
  xp: number;
  /** Mevcut level içinde kazanılan XP. */
  xpIntoLevel: number;
  /** Sonraki level'a kalan XP. */
  xpForNextLevel: number;
  /** Mevcut level içindeki ilerleme yüzdesi (0–1). */
  progressRatio: number;
}

/** awardXpEvent parametreleri. */
export interface AwardXpParams {
  profileId: string;
  modeKey: ModeKey;
  roomId: string;
  xpEarned: number;
  result: MatchResult;
  /** UI'da göstermek/loglamak için breakdown ve istersen ek alanlar. */
  details?: Record<string, unknown>;
}

/** RPC'nin awarded=false döndürdüğü durumlardaki sebep. */
export type AwardXpReason = "already_claimed";

/**
 * awardXpEvent sonucu.
 *
 * - `awarded`: RPC bu çağrıda yeni bir xp_events satırı yazdı mı?
 *   false = aynı (profile_id, mode_key, room_id) için zaten yazılmış.
 * - `reason`: awarded=false durumlarında doldurulur (örn. "already_claimed").
 * - `xpEarned`: bu çağrıda gerçekten eklenen XP. RPC tarafında 500 cap'i var,
 *   yani gönderdiğin değerden küçük olabilir. already_claimed'de 0 döner.
 * - `totalXp`: kullanıcının güncel genel XP'si (RPC'den, DB'den okunmuş).
 * - `modeXp`: kullanıcının bu mod için güncel XP'si.
 * - `error`: RPC hata fırlattığında doldurulur (auth yok, geçersiz parametre,
 *   network vs.). Hata durumunda diğer alanlar 0/false olur.
 */
export interface AwardXpResult {
  awarded:  boolean;
  reason:   AwardXpReason | null;
  xpEarned: number;
  totalXp:  number;
  modeXp:   number;
  error:    string | null;
}

/* ────────────────────────────────────────────────
   Level hesaplama
   ──────────────────────────────────────────────── */

/**
 * XP'den level hesapla.
 *
 * Formül: level = floor(sqrt(xp / 100)) + 1
 *   xp=0     → level 1
 *   xp=100   → level 2
 *   xp=400   → level 3
 *   xp=900   → level 4
 *   xp=1600  → level 5
 */
export function getLevelFromXp(xp: number): number {
  const safeXp = Math.max(0, Math.floor(xp || 0));
  return Math.floor(Math.sqrt(safeXp / 100)) + 1;
}

/**
 * Verilen level'ın başlangıç XP eşiği.
 *
 * getLevelFromXp(xp) = level → xp aralığı [xpForLevel(level), xpForLevel(level+1))
 *
 * Ters formül: xp = (level - 1)^2 * 100
 */
export function getXpForLevel(level: number): number {
  const safeLevel = Math.max(1, Math.floor(level));
  return (safeLevel - 1) * (safeLevel - 1) * 100;
}

/** Level bar'ı için tam ilerleme bilgisi. */
export function getLevelProgress(xp: number): LevelProgress {
  const safeXp = Math.max(0, Math.floor(xp || 0));
  const level = getLevelFromXp(safeXp);
  const currentLevelXp = getXpForLevel(level);
  const nextLevelXp = getXpForLevel(level + 1);

  const span = Math.max(1, nextLevelXp - currentLevelXp);
  const xpIntoLevel = safeXp - currentLevelXp;
  const xpForNextLevel = Math.max(0, nextLevelXp - safeXp);
  const progressRatio = Math.min(1, Math.max(0, xpIntoLevel / span));

  return {
    level,
    currentLevelXp,
    nextLevelXp,
    xp: safeXp,
    xpIntoLevel,
    xpForNextLevel,
    progressRatio,
  };
}

/* ────────────────────────────────────────────────
   Mod bazlı XP hesaplama
   ──────────────────────────────────────────────── */

/** Maç sonucundan kazanma/beraberlik/kaybetme bonusu. */
function resultBonus(result: MatchResult): number {
  switch (result) {
    case "win":  return 25;
    case "draw": return 10;
    case "loss": return 5;
  }
}

/**
 * Country Duel XP:
 *   - Katılım:        +10
 *   - Her doğru ülke: +3
 *   - Kazanma:        +25
 *   - Beraberlik:     +10
 *   - Kaybetme:       +5
 */
export function calculateCountryDuelXp(
  params: CountryDuelXpParams
): XpBreakdown {
  const participation = 10;
  const perCorrect = 3;
  const correctCount = Math.max(0, Math.floor(params.correctCount || 0));
  const correctTotal = perCorrect * correctCount;
  const bonus = resultBonus(params.result);
  const total = participation + correctTotal + bonus;

  return {
    participation,
    perCorrect,
    correctCount,
    correctTotal,
    resultBonus: bonus,
    resultBonusLabel: params.result === "win"
      ? "win"
      : params.result === "draw"
        ? "draw"
        : "loss",
    total,
  };
}

/**
 * Flag Duel XP:
 *   - Katılım:           +10
 *   - Her doğru bayrak:  +4
 *   - Kazanma:           +25
 *   - Beraberlik:        +10
 *   - Kaybetme:          +5
 */
export function calculateFlagDuelXp(
  params: FlagDuelXpParams
): XpBreakdown {
  const participation = 10;
  const perCorrect = 4;
  const correctCount = Math.max(0, Math.floor(params.correctCount || 0));
  const correctTotal = perCorrect * correctCount;
  const bonus = resultBonus(params.result);
  const total = participation + correctTotal + bonus;

  return {
    participation,
    perCorrect,
    correctCount,
    correctTotal,
    resultBonus: bonus,
    resultBonusLabel: params.result === "win"
      ? "win"
      : params.result === "draw"
        ? "draw"
        : "loss",
    total,
  };
}

/** Wheel Group XP — sıralama bonusu hesabı için input. */
export interface WheelGroupXpParams {
  /** Oyuncunun haritada ilk bulduğu doğru ülke sayısı. */
  correctCount: number;
  /** Toplam puana göre nihai sıralama (1 = ilk). */
  finalRank: number;
  /** Toplam oyuncu sayısı (bilgi amaçlı; bonus hesabı sadece rank'a bağlı). */
  totalPlayers: number;
}

/** Wheel Group breakdown — sıralama bonusu için ekstra alan. */
export interface WheelGroupXpBreakdown extends XpBreakdown {
  rankBonus: number;
  finalRank: number;
}

/**
 * Çark Çok Oyunculu (Wheel Group) XP:
 *   - Katılım:        +5
 *   - Her doğru ülke: +3
 *   - 1. sıra bonusu: +10
 *   - 2. sıra bonusu: +5
 *   - 3. sıra bonusu: +3
 *   - Diğer sıralar:  +0
 *
 * Not: Gold verilmez — bu mod yalnız XP üretir.
 */
export function calculateWheelGroupXp(
  params: WheelGroupXpParams
): WheelGroupXpBreakdown {
  const participation = 5;
  const perCorrect = 3;
  const correctCount = Math.max(0, Math.floor(params.correctCount || 0));
  const correctTotal = perCorrect * correctCount;
  const rank = Math.max(1, Math.floor(params.finalRank || 1));
  let rankBonus = 0;
  if (rank === 1) rankBonus = 10;
  else if (rank === 2) rankBonus = 5;
  else if (rank === 3) rankBonus = 3;
  const total = participation + correctTotal + rankBonus;

  // XpGainBar bu metni 3. breakdown parçası olarak gösterir (Galibiyet/
  // Beraberlik/Mağlubiyet yerine). Rank > 3 için "podyum dışı, bonus yok".
  const bonusLabelText =
    rank === 1 ? `🥇 Sıra #1 +${rankBonus}` :
    rank === 2 ? `🥈 Sıra #2 +${rankBonus}` :
    rank === 3 ? `🥉 Sıra #3 +${rankBonus}` :
                 `#${rank} sıra · bonus yok`;

  return {
    participation,
    perCorrect,
    correctCount,
    correctTotal,
    resultBonus: rankBonus,
    resultBonusLabel: rank === 1 ? "win" : rank <= 3 ? "draw" : "loss",
    bonusLabelText,
    rankBonus,
    finalRank: rank,
    total,
  };
}

/**
 * Wheel Duel (Online Çark 1v1) XP:
 *   - Katılım:        +10
 *   - Her doğru ülke: +5
 *   - Kazanma:        +25
 *   - Beraberlik:     +10
 *   - Kaybetme:       +5
 */
export function calculateWheelDuelXp(
  params: WheelDuelXpParams
): XpBreakdown {
  const participation = 10;
  const perCorrect = 5;
  const correctCount = Math.max(0, Math.floor(params.correctCount || 0));
  const correctTotal = perCorrect * correctCount;
  const bonus = resultBonus(params.result);
  const total = participation + correctTotal + bonus;

  return {
    participation,
    perCorrect,
    correctCount,
    correctTotal,
    resultBonus: bonus,
    resultBonusLabel: params.result === "win"
      ? "win"
      : params.result === "draw"
        ? "draw"
        : "loss",
    total,
  };
}

/** Kuşatma (Conquest) XP hesaplaması için girdiler. */
export interface ConquestXpParams {
  /** 1-based final rank from buildFinalStandings. Eşitlikte ortak rank verilebilir. */
  finalRank:    number;
  /** Maçtaki toplam oyuncu sayısı. */
  totalPlayers: number;
  /** Walkover işaretleri — set edilirse kazanan +40 XP alır. */
  finishReason?: "last_player_standing" | "opponent_left" | null;
  /** Bilinçli ayrılan oyuncuya 0 XP vermek için kullanılır. */
  forfeited?:   boolean;
  /** Tek beraberlikte tüm oyuncular +30 XP alır (rank=1, herkes eşit). */
  isDraw?:      boolean;
}

/** Conquest breakdown — XpGainBar için. Kuşatma'da "doğru sayısı" yok;
 *  XpBreakdown'ı uyumlu doldurmak için correct alanları 0 bırakılır ve
 *  bonusLabelText 3. parça olarak anlamlı bir metin sağlar. */
export interface ConquestXpBreakdown extends XpBreakdown {
  finalRank:    number;
  totalPlayers: number;
}

/**
 * Kuşatma (Conquest) XP — V1 ödül tablosu:
 *
 *   Walkover (finishReason set):
 *     Kazanan         → +40 XP   (rank #1)
 *     Diğer (kalan)   → +20 XP   (mağlubiyet bandı)
 *     Bilinçli ayrılan→  +0 XP   (forfeited=true)
 *
 *   Beraberlik (isDraw=true):
 *     Herkes          → +30 XP
 *
 *   Normal 2 kişilik maç:
 *     1. (kazanan)    → +50 XP
 *     2. (kaybeden)   → +20 XP
 *
 *   Normal 3-4 kişilik maç:
 *     1.              → +50 XP
 *     2.              → +30 XP
 *     3.              → +20 XP
 *     4.              → +10 XP
 *
 * Aynı miktar hem genel XP'ye hem conquest mod XP'sine işlenir (RPC tarafı
 * tek INSERT yapar; toplamlar `xp_events` üzerinden okunur).
 *
 * Level progression: getLevelFromXp / getXpForLevel (Bayrak ile birebir).
 */
export function calculateConquestXp(
  params: ConquestXpParams
): ConquestXpBreakdown {
  const totalPlayers = Math.max(1, Math.floor(params.totalPlayers || 1));
  const finalRank    = Math.max(1, Math.floor(params.finalRank    || 1));
  const finishReason = params.finishReason ?? null;
  const forfeited    = Boolean(params.forfeited);
  const isDraw       = Boolean(params.isDraw);

  let total = 0;
  let bonusLabelText = "";
  let resultBonusLabel: "win" | "draw" | "loss" = "loss";

  if (forfeited) {
    total = 0;
    bonusLabelText = "Maçtan ayrıldın · +0";
    resultBonusLabel = "loss";
  } else if (finishReason === "opponent_left" && finalRank === 1) {
    total = 40;
    bonusLabelText = `Rakip ayrıldı +${total}`;
    resultBonusLabel = "win";
  } else if (finishReason === "last_player_standing" && finalRank === 1) {
    total = 40;
    bonusLabelText = `Son ayakta kalan +${total}`;
    resultBonusLabel = "win";
  } else if (isDraw) {
    total = 30;
    bonusLabelText = `Beraberlik +${total}`;
    resultBonusLabel = "draw";
  } else if (totalPlayers <= 2) {
    if (finalRank === 1) {
      total = 50;
      bonusLabelText = `Galibiyet +${total}`;
      resultBonusLabel = "win";
    } else {
      total = 20;
      bonusLabelText = `Mağlubiyet +${total}`;
      resultBonusLabel = "loss";
    }
  } else {
    // 3-4 kişilik: rank bazlı sabit tablo. 5+ için en alt basamak kullanılır.
    const rankBonus =
      finalRank === 1 ? 50 :
      finalRank === 2 ? 30 :
      finalRank === 3 ? 20 :
      10;
    total = rankBonus;
    bonusLabelText =
      finalRank === 1 ? `🥇 Sıra #1 +${rankBonus}` :
      finalRank === 2 ? `🥈 Sıra #2 +${rankBonus}` :
      finalRank === 3 ? `🥉 Sıra #3 +${rankBonus}` :
                       `#${finalRank} sıra +${rankBonus}`;
    resultBonusLabel = finalRank === 1 ? "win" : finalRank <= 3 ? "draw" : "loss";
  }

  // XpBreakdown şeması: Kuşatma'da "katılım" / "doğru" ayrımı yok; tüm XP
  // resultBonus altında. Bayrak ile aynı UI satırını kullanabilmek için
  // correct alanları 0, participation 0, resultBonus = total.
  return {
    participation: 0,
    perCorrect:    0,
    correctCount:  0,
    correctTotal:  0,
    resultBonus:   total,
    resultBonusLabel,
    bonusLabelText,
    finalRank,
    totalPlayers,
    total,
  };
}

/* ────────────────────────────────────────────────
   Maç sonucu yardımcısı
   ──────────────────────────────────────────────── */

/**
 * İki skordan kendi maç sonucunu çıkarır.
 * Forfeit/disconnect senaryolarında çağıran taraf result'ı kendi
 * mantığıyla belirleyip doğrudan awardXpEvent'a vermelidir.
 */
export function resultFromScores(
  myScore: number,
  opponentScore: number
): MatchResult {
  if (myScore > opponentScore) return "win";
  if (myScore < opponentScore) return "loss";
  return "draw";
}

/* ────────────────────────────────────────────────
   Supabase RPC çağrısı
   ──────────────────────────────────────────────── */

/**
 * XP olayı yazar (RPC: award_xp_event).
 *
 * RPC davranışı:
 *   - Aynı (profile_id, mode_key, room_id) için ikinci çağrı no-op'tur;
 *     awarded=false döner, hata fırlatılmaz.
 *   - auth.uid() profile_id ile eşleşmezse hata döner.
 *
 * Bu fonksiyon hiç throw etmez; her durumda { awarded, error } yapısıyla
 * döner. Çağıran taraf UI'da güvenle if/else yapabilir.
 */
/**
 * RPC'nin döndürdüğü ham jsonb şekli (snake_case).
 * Bu tip helper içindedir, dışarı export edilmez — çağıran tarafa
 * sadece camelCase AwardXpResult döner.
 */
interface RawAwardXpResponse {
  awarded:    boolean;
  reason?:    string;       // sadece awarded=false durumunda
  xp_earned:  number;
  total_xp:   number;
  mode_xp:    number;
}

/** AwardXpResult'un "her şey sıfır" hali — hata/early-return durumları için. */
function emptyAwardResult(error: string | null): AwardXpResult {
  return {
    awarded:  false,
    reason:   null,
    xpEarned: 0,
    totalXp:  0,
    modeXp:   0,
    error,
  };
}

/**
 * XP olayı yazar (RPC: award_xp_event).
 *
 * RPC davranışı:
 *   - Aynı (profile_id, mode_key, room_id) için ikinci çağrı `awarded=false`,
 *     `reason="already_claimed"` döndürür ve mevcut total_xp / mode_xp
 *     değerlerini geri verir. UNIQUE conflict bu yüzden hata olarak gelmez.
 *   - auth.uid() != profile_id, geçersiz mode_key veya geçersiz result
 *     durumlarında RPC `RAISE EXCEPTION` fırlatır → burada error doldurulur.
 *   - p_xp_earned RPC tarafında [0, 500] aralığına clamp edilir; gerçek
 *     yazılan değer dönüşteki xp_earned'dir.
 *
 * Bu fonksiyon hiç throw etmez; her durumda AwardXpResult döner.
 */
export async function awardXpEvent(
  params: AwardXpParams
): Promise<AwardXpResult> {
  // XP düşmesin: negatif değer gönderme.
  const xpEarned = Math.max(0, Math.floor(params.xpEarned || 0));

  if (xpEarned === 0) {
    return emptyAwardResult(null);
  }

  // wheel_group ve conquest için adanmış RPC'ler: mevcut award_xp_event'in
  // mode_key whitelist'i bu modları içermediği için (eski modlar
  // oluşturulduktan sonra eklendiler) kendi SECURITY DEFINER fonksiyonları
  // üzerinden yazıyoruz. Sözleşme aynı; sadece mode_key sabit ve RPC adı farklı.
  //   wheel_group → 20260518130000_wheel_group_xp_rpc.sql
  //   conquest    → 20260602120000_conquest_xp_rpc.sql
  const useDedicatedWheelGroupRpc = params.modeKey === "wheel_group";
  const useDedicatedConquestRpc   = params.modeKey === "conquest";

  try {
    const { data, error } = useDedicatedWheelGroupRpc
      ? await supabase.rpc("award_wheel_group_xp_event", {
          p_profile_id: params.profileId,
          p_room_id:    params.roomId,
          p_xp_earned:  xpEarned,
          p_result:     params.result,
          p_details:    params.details ?? {},
        })
      : useDedicatedConquestRpc
      ? await supabase.rpc("award_conquest_xp_event", {
          p_profile_id: params.profileId,
          p_room_id:    params.roomId,
          p_xp_earned:  xpEarned,
          p_result:     params.result,
          p_details:    params.details ?? {},
        })
      : await supabase.rpc("award_xp_event", {
          p_profile_id: params.profileId,
          p_mode_key:   params.modeKey,
          p_room_id:    params.roomId,
          p_xp_earned:  xpEarned,
          p_result:     params.result,
          p_details:    params.details ?? {},
        });

    if (error) {
      const rpcName = useDedicatedWheelGroupRpc
        ? "award_wheel_group_xp_event"
        : useDedicatedConquestRpc
          ? "award_conquest_xp_event"
          : "award_xp_event";
      console.error(`[progression] ${rpcName} RPC error:`, error);
      return emptyAwardResult(error.message ?? "RPC failed");
    }

    // RPC jsonb döndürüyor → Supabase JS bunu doğrudan JS objesine çevirir.
    // Tip narrowing için runtime check yapıyoruz; RPC sözleşmesi değişirse
    // sessiz hata yerine açık hata vermesi için.
    if (!data || typeof data !== "object") {
      console.error("[progression] award_xp_event unexpected payload:", data);
      return emptyAwardResult("Unexpected RPC payload");
    }

    const raw = data as RawAwardXpResponse;

    return {
      awarded:  Boolean(raw.awarded),
      reason:   raw.reason === "already_claimed" ? "already_claimed" : null,
      xpEarned: Math.max(0, Math.floor(raw.xp_earned ?? 0)),
      totalXp:  Math.max(0, Math.floor(raw.total_xp  ?? 0)),
      modeXp:   Math.max(0, Math.floor(raw.mode_xp   ?? 0)),
      error:    null,
    };
  } catch (err) {
    console.error("[progression] award_xp_event threw:", err);
    return emptyAwardResult(
      err instanceof Error ? err.message : "Unknown error"
    );
  }
}

/* ────────────────────────────────────────────────
   Toplam XP okuma (xp_events üzerinden)
   ────────────────────────────────────────────────
   profiles.xp kolonu RPC tarafından güncellenmiyor — gerçek XP
   xp_events satırlarında tutuluyor. Bu helper kullanıcının tüm
   modlardaki XP'sini toplayıp toplam XP'yi döner. Hata durumunda 0.

   RLS: xp_events için kullanıcının kendi satırlarını okuyabilmesi gerekir.
   ──────────────────────────────────────────────── */
export async function fetchTotalXp(profileId: string): Promise<number> {
  if (!profileId) return 0;
  try {
    const { data, error } = await supabase
      .from("xp_events")
      .select("xp_earned")
      .eq("profile_id", profileId);
    if (error || !data) return 0;
    let sum = 0;
    for (const row of data as Array<{ xp_earned: number | null }>) {
      sum += Number(row.xp_earned ?? 0) || 0;
    }
    return Math.max(0, Math.floor(sum));
  } catch {
    return 0;
  }
}