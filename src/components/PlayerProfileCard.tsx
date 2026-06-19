/**
 * PlayerProfileCard.tsx — "Torble Keşif İzni" oyuncu profil yüzeyi.
 *
 * Salt sunum bileşeni: veriyi PlayerProfileTrigger çeker (get_public_profile),
 * bu bileşen yalnızca gösterir + aksiyon callback'lerini tetikler.
 *
 * Estetik: koyu lacivert bir "kasa/cilt" içinde sergilenen sıcak PARŞÖMEN bir
 * keşif belgesi. Kasanın koyu/mavi dili Torble global kimliğini taşır; parşömen
 * yüzey ise koleksiyonluk/premium hissi verir. Gerçek pasaport/devlet belgesi
 * DEĞİL (pasaport no / MRZ / arma / resmî mühür YOK); yalnız belge hissiyatı.
 *
 * Yapı (.ppc-* sınıfları):
 *   - KÜNYE ŞERİDİ (kasa üstü, foil aksanlı): pusula motifi + "TORBLE /
 *       GEZGİN KİMLİK BELGESİ" lockup'ı; sağda "KEŞİF İZNİ" + ince dalga çizgileri.
 *   - BELGE (.ppc-doc, parşömen yüzey) — iki sütun:
 *       · KONTUR: inline SVG topografik watermark (çok düşük opaklık, dekoratif).
 *       · SOL (kimlik): köşe montajlı foto penceresi + üstüne soluk pusula mührü;
 *           @kullanıcı adı (kozmetik isim rengi), unvan (varsa), "Seviye N" rozeti,
 *           XP etiketi + barı (mevcut-level içi ilerleme / span). Semantik korunur.
 *       · SAĞ (kayıt defteri): KAYITLAR ledger satırları
 *           (🏆 Galibiyet / 🎮 Maç / 🔥 Seri / 🎖 Başarım — etiketler birebir,
 *           NATIVE EMOJI bilerek SVG'ye çevrilmez; rakamlar Bebas, isimler DM Sans)
 *           + DAMGALAR mühür rayı (rozet vitrini).
 *   - DAMGALAR (vize/keşif mührü rayı = rozet vitrini):
 *       · Kendi profilim → 5 yuvarlak slot (boşlar hayalet "+" mühür, tıkla→editör)
 *       · Başka oyuncu   → yalnız sergilenen rozetler (boş slot gösterilmez)
 *       Rozetler GERÇEK kazanılmış başarımlardır; kozmetikleşen yalnız damganın
 *       GÖRÜNÜMÜ (çerçeve/mürekkep/foil), başarımın anlamı değil.
 *   - AKSİYONLAR (kasa altı bandı): sade product UI — primary mavi, tehlike kırmızı,
 *       diğerleri nötr; foil/altın YOK. Mevcut buton seti ve mantığı korunur:
 *       · Kendi profilim → Profili Düzenle
 *       · Başka oyuncu   → Arkadaş Ekle (duruma göre) / Davet Et /
 *                          Arkadaşlıktan Çıkar / Engelle (veya Engeli Kaldır)
 *
 * GOLD GÖSTERİLMEZ (public kart). Kozmetik dikiş KORUNUR: kart teması
 * (data-theme → parşömen/kasa/foil/damga token'larını ezebilir), efekt
 * (data-effect), isim rengi, unvan, çerçeve — şu an yalnız default değerler aktif
 * (bkz. lib/cosmetics.ts); yeni satın-alma akışı YOK. Rozet ipuçları CSS tooltip
 * (data-tip). Desktop/mobil/native ortak; mobilde iki sütun tek sütuna akar.
 */
import { getAvatar } from "../data/avatars";
import { getLevelProgress } from "../lib/progression";
import {
  resolveCardEffectKey,
  resolveCardThemeKey,
  resolveFrameId,
  resolveNameColor,
  resolveTitleText,
} from "../lib/cosmetics";
import { PlayerAvatar } from "./PlayerAvatar";
import type { RelationshipStatus } from "../lib/social";

const BADGE_SLOTS = 5;

interface PlayerProfileCardProps {
  username: string | null;
  avatarId: string | null;
  level: number;
  /** Toplam XP — XP barı için. null/undefined → bar gizlenir (graceful fallback). */
  xp?: number | null;
  /** Mini istatistikler — null/undefined → "—" gösterilir (uydurma veri yok). */
  winsCount?: number | null;
  matchesCount?: number | null;
  currentStreak?: number | null;
  achievementsCount?: number | null;
  /** En fazla 5 sergilenen rozet/achievement tier id'si. */
  showcasedBadgeIds: string[];

  /** Kozmetik seçimleri (default null → default görünüm). */
  frameId?: string | null;
  cardThemeId?: string | null;
  nameColorId?: string | null;
  titleId?: string | null;
  effectId?: string | null;

  isSelf: boolean;
  relationshipStatus: RelationshipStatus;

  /** Başka oyuncu aksiyonları. */
  onAddFriend?: () => void;
  onInvite?: () => void;
  onBlock?: () => void;
  /** Arkadaşlıktan çıkar (yalnız status === "friends"). */
  onRemoveFriend?: () => void;
  /** Engeli kaldır (yalnız status === "blocked"). */
  onUnblock?: () => void;
  /** Davet edilebilir mi (aktif oda context'i var mı). */
  canInvite?: boolean;

  /** Kendi profil aksiyonları. */
  onEditProfile?: () => void;
  /** Rozet slotuna tıklayınca doğrudan sergileme editörünü açar (yalnız self). */
  onEditBadges?: () => void;
}

function friendButtonLabel(status: RelationshipStatus): { label: string; disabled: boolean } {
  switch (status) {
    case "friends":
      return { label: "Arkadaşsınız", disabled: true };
    case "request_sent":
      return { label: "İstek Gönderildi", disabled: true };
    case "request_received":
      return { label: "Yanıt Bekliyor", disabled: true };
    default:
      return { label: "Arkadaş Ekle", disabled: false };
  }
}

/** İstatistik değerini biçimler; veri yoksa "—" (uydurma sayı gösterilmez). */
function statValue(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.max(0, Math.floor(n)).toLocaleString("tr-TR");
}

interface RecordCellProps {
  /** NATIVE emoji — SVG değil (kasıtlı). */
  emoji: string;
  value: number | null | undefined;
  label: string;
}

/** Tek bir ölçüm kaydı (kayıt defteri satırı: işaret · etiket · ayraç · rakam). */
function RecordCell({ emoji, value, label }: RecordCellProps) {
  return (
    <div className="ppc-record">
      <span className="ppc-record-mark" aria-hidden="true">
        {emoji}
      </span>
      <span className="ppc-record-name">{label}</span>
      <span className="ppc-record-leader" aria-hidden="true" />
      <span className="ppc-record-fig">{statValue(value)}</span>
    </div>
  );
}

/** Soluk pusula mührü — foto penceresine "basılmış" gibi oturan dekoratif
 *  damga. Resmî mühür değil; yalnız koleksiyonluk belge hissi. Rengi/opaklığı
 *  ileride data-theme (--ppc-foil) üzerinden değişebilir. */
function PassportSeal() {
  return (
    <svg className="ppc-seal" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <circle cx="24" cy="24" r="22" />
      <circle cx="24" cy="24" r="17.5" />
      <path
        className="ppc-seal-star"
        d="M24 9 L26.4 21.6 L39 24 L26.4 26.4 L24 39 L21.6 26.4 L9 24 L21.6 21.6 Z"
      />
    </svg>
  );
}

/** Soluk topografik kontur gravürü (zemin dekoru). Tamamen dekoratif; gerçek
 *  harita/belge değil. Tek bir organik eşyükselti döngüsü, içe doğru ölçeklenen
 *  kopyalarla "kontur" hissi verir. data-theme ileride rengi/yoğunluğu değiştirir. */
function ContourWatermark() {
  return (
    <svg
      className="ppc-contour"
      viewBox="0 0 600 400"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <path
          id="ppc-iso"
          d="M556 168 C548 96 470 56 392 64 C300 73 232 128 224 206 C217 280 268 340 358 350 C448 360 528 322 552 252 C560 226 561 196 556 168 Z"
        />
      </defs>
      <g className="ppc-contour-lines">
        <use href="#ppc-iso" transform="translate(400 200) scale(1.18) translate(-400 -200)" />
        <use href="#ppc-iso" transform="translate(400 200) scale(0.97) translate(-400 -200)" />
        <use href="#ppc-iso" transform="translate(400 200) scale(0.76) translate(-400 -200)" />
        <use href="#ppc-iso" transform="translate(400 200) scale(0.56) translate(-400 -200)" />
        <use href="#ppc-iso" transform="translate(400 200) scale(0.37) translate(-400 -200)" />
        <use href="#ppc-iso" transform="translate(400 200) scale(0.20) translate(-400 -200)" />
      </g>
    </svg>
  );
}

export function PlayerProfileCard({
  username,
  avatarId,
  level,
  xp,
  winsCount,
  matchesCount,
  currentStreak,
  achievementsCount,
  showcasedBadgeIds,
  frameId,
  cardThemeId,
  nameColorId,
  titleId,
  effectId,
  isSelf,
  relationshipStatus,
  onAddFriend,
  onInvite,
  onBlock,
  onRemoveFriend,
  onUnblock,
  canInvite,
  onEditProfile,
  onEditBadges,
}: PlayerProfileCardProps) {
  const friendBtn = friendButtonLabel(relationshipStatus);
  const isBlocked = relationshipStatus === "blocked";
  const isFriend = relationshipStatus === "friends";

  // Başka oyuncu: yalnız gerçek (çözülebilen) rozetleri göster — boş slot yok.
  const otherBadges = showcasedBadgeIds.filter((id) => getAvatar(id));
  // Kendi profilim: 5 slot (dolu rozetler + boş "+" placeholder'lar).
  const selfSlots = Array.from({ length: BADGE_SLOTS }, (_, i) => showcasedBadgeIds[i] ?? null);
  const showBadges = isSelf || otherBadges.length > 0;

  // XP barı: yalnızca gerçek XP verisi varsa. getLevelProgress level-içi ilerlemeyi verir.
  const hasXp = xp != null && Number.isFinite(xp);
  const prog = hasXp ? getLevelProgress(xp as number) : null;
  const xpSpan = prog ? Math.max(0, prog.nextLevelXp - prog.currentLevelXp) : 0;

  // Kozmetik çözümleme (default null → default görünüm).
  const themeKey = resolveCardThemeKey(cardThemeId);
  const effectKey = resolveCardEffectKey(effectId);
  const nameColor = resolveNameColor(nameColorId);
  const titleText = resolveTitleText(titleId);
  const resolvedFrame = resolveFrameId(frameId);

  return (
    <div
      className="ppc-card"
      data-theme={themeKey}
      data-effect={effectKey}
      role="dialog"
      aria-label="Oyuncu profili"
    >
      {/* KÜNYE ŞERİDİ (kasa üstü, foil aksanlı) */}
      <div className="ppc-strip">
        <span className="ppc-strip-lockup">
          <svg className="ppc-strip-compass" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path
              d="M12 1 L13.7 10.3 L23 12 L13.7 13.7 L12 23 L10.3 13.7 L1 12 L10.3 10.3 Z"
              fill="currentColor"
            />
            <circle cx="12" cy="12" r="1.4" fill="var(--ppc-frame, #11192b)" />
          </svg>
          <span className="ppc-strip-titles">
            <span className="ppc-strip-brand">TORBLE</span>
            <span className="ppc-strip-sub">Gezgin Kimlik Belgesi</span>
          </span>
        </span>
        <span className="ppc-strip-mark">
          <span className="ppc-strip-pass">Keşif İzni</span>
          <svg className="ppc-strip-waves" viewBox="0 0 40 14" aria-hidden="true" focusable="false">
            <path d="M1 4 q5 -3 10 0 t10 0 t10 0 t8 0" />
            <path d="M1 8 q5 -3 10 0 t10 0 t10 0 t8 0" />
            <path d="M1 12 q5 -3 10 0 t10 0 t10 0 t8 0" />
          </svg>
        </span>
      </div>

      {/* BELGE — parşömen yüzey (kontur watermark + iki sütun) */}
      <div className="ppc-doc">
        <ContourWatermark />

        <div className="ppc-doc-grid">
          {/* SOL: foto penceresi + kimlik */}
          <div className="ppc-hero">
            <div className="ppc-photo">
              <PassportSeal />
              <PlayerAvatar avatarId={avatarId} username={username} size="lg" frameId={resolvedFrame} />
            </div>
            <div className="ppc-identity">
              <span className="ppc-uname" style={nameColor ? { color: nameColor } : undefined}>
                @{username ?? "—"}
              </span>
              {titleText && <span className="ppc-title-tag">{titleText}</span>}

              <div className="ppc-level-row">
                <span className="ppc-level">Seviye {level}</span>
                {prog && (
                  <span className="ppc-xp-label">
                    {prog.xpIntoLevel.toLocaleString("tr-TR")} / {xpSpan.toLocaleString("tr-TR")} XP
                  </span>
                )}
              </div>

              {prog && (
                <div
                  className="ppc-xp-track"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={xpSpan}
                  aria-valuenow={prog.xpIntoLevel}
                  aria-label="Seviye ilerlemesi"
                >
                  <div className="ppc-xp-fill" style={{ width: `${Math.round(prog.progressRatio * 100)}%` }} />
                </div>
              )}
            </div>
          </div>

          {/* SAĞ: kayıt defteri + damga rayı */}
          <div className="ppc-log">
            {/* KAYITLAR (kayıt defteri satırları — native emoji) */}
            <div className="ppc-records">
              <span className="ppc-section-label">Kayıtlar</span>
              <div className="ppc-record-strip">
                <RecordCell emoji="🏆" value={winsCount} label="Galibiyet" />
                <RecordCell emoji="🎮" value={matchesCount} label="Maç" />
                <RecordCell emoji="🔥" value={currentStreak} label="Seri" />
                <RecordCell emoji="🎖️" value={achievementsCount} label="Başarım" />
              </div>
            </div>

            {/* DAMGALAR (vize/keşif mührü rayı) */}
            {showBadges && (
              <div className="ppc-section">
                <span className="ppc-section-label">Damgalar</span>
                {isSelf ? (
                  <div className="ppc-badges ppc-badges--self" aria-label="Sergilenen rozetler">
                    {selfSlots.map((badgeId, i) => {
                      const def = badgeId ? getAvatar(badgeId) : null;
                      return (
                        <button
                          key={i}
                          type="button"
                          className={`ppc-badge-slot ppc-badge-slot--btn${
                            def ? " ppc-badge-slot--filled" : " ppc-badge-slot--empty"
                          }`}
                          onClick={onEditBadges}
                          data-tip={def?.label ?? "Rozet ekle"}
                          aria-label={def?.label ?? "Rozet ekle"}
                        >
                          {def ? (
                            <img src={def.image} alt={def.label} className="ppc-badge-img" />
                          ) : (
                            <span className="ppc-badge-plus" aria-hidden="true">
                              +
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="ppc-badges" aria-label="Sergilenen rozetler">
                    {otherBadges.map((badgeId, i) => {
                      const def = getAvatar(badgeId);
                      return (
                        <span
                          key={i}
                          className="ppc-badge-slot ppc-badge-slot--filled"
                          data-tip={def?.label}
                        >
                          {def ? <img src={def.image} alt={def.label} className="ppc-badge-img" /> : null}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* AKSİYONLAR (kasa altı bandı — sade product UI, foil YOK) */}
      <div className="ppc-actions">
        {isSelf ? (
          <button type="button" className="ppc-btn ppc-btn--primary" onClick={onEditProfile}>
            Profili Düzenle
          </button>
        ) : isBlocked ? (
          <>
            <button type="button" className="ppc-btn" disabled>
              Engellendi
            </button>
            <button type="button" className="ppc-btn ppc-btn--primary" onClick={onUnblock}>
              Engeli Kaldır
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="ppc-btn ppc-btn--primary"
              onClick={onAddFriend}
              disabled={friendBtn.disabled}
            >
              {friendBtn.label}
            </button>
            <button
              type="button"
              className="ppc-btn"
              onClick={onInvite}
              disabled={!canInvite}
              title={canInvite ? undefined : "Bir odadayken davet gönderebilirsin."}
            >
              Davet Et
            </button>
            {isFriend && (
              <button type="button" className="ppc-btn" onClick={onRemoveFriend}>
                Arkadaşlıktan Çıkar
              </button>
            )}
            <button type="button" className="ppc-btn ppc-btn--danger" onClick={onBlock}>
              Engelle
            </button>
          </>
        )}
      </div>
    </div>
  );
}
