// ── Kuşatma masaüstü harita yuvası (desktop map slot) geometrisi ──────────
//
// YENİ MİMARİ — gerçek in-flow komuta güvertesi (command deck):
//
// Eski model alt tarafta SABİT 210px'lik bir "dock rezervi" ayırıp faz panelini
// (`.cq-game-phase-panel`) onun ÜZERİNDE `position:fixed` yüzdürüyordu.  Rezerv
// haritanın yükseklik bütçesinden kesildiği ve harita yükseklik-kısıtlı
// (1005/490 en-boy) olduğu için kısa viewport'ta (1366×768 + Chrome ≈ 640px)
// harita ~600px'e çöküyordu.  Rezervin altı da çoğunlukla boş kaldığından
// "sahipsiz siyah boşluk" gibi okunuyordu.
//
// Artık komuta güvertesi GERÇEK bir in-flow flex kardeşidir (`.cq-command-deck`,
// yüksekliği CSS `--cq-deck-h` clamp'iyle SABİT ve FAZ-BAĞIMSIZ).  Harita ise
// `.cq-battlefield` (flex:1) bölgesinde yaşar.  Bu hook YALNIZCA battlefield'ın
// gerçek yüksekliğini ölçer → `--cq-stage-h`.
//
//   battlefield yüksekliği = viewport − header − komuta güvertesi − footer
//
// Üç bileşen de faz-bağımsız olduğundan stageH da faz-bağımsızdır: AYNI
// viewport'ta question/reveal/action/round_result fazlarının hepsinde harita
// rect'i (w/h/top/left) birebir sabit kalır.  Faz içeriği güvertenin İÇİNDE
// sabit-yükseklikli yuvada değişir (taşarsa güverte içinde nazik scroll),
// battlefield'ı asla yeniden boyutlamaz → ölçüm değişmez.  Yalnız gerçek
// pencere/viewport resize battlefield yüksekliğini (ve dolayısıyla stageH'i)
// değiştirir → farklı monitörlerde harita akışkan biçimde büyür/küçülür.
//
// Harita GENİŞLİĞİ tamamen CSS'te türetilir (battlefield yüksekliği × en-boy,
// kullanılabilir merkez genişliği `100%` ve viewport genişliğine bağlı akışkan
// tavan `--cq-map-width-cap`'in `min()`'i).  Hook yalnız yüksekliği yazar.
//
// Kapsam: yalnız desktop (≥601px) `.cq-game-screen`.  Mobil (≤600px)
// MobileConquestLayout kullanır → bu modül `null` döner, mobil etkilenmez.

/** Harita ile battlefield kenarları (board-wrap dikey padding'i) arası nefes payı. */
export const CQ_STAGE_GAP_TOP = 8;
export const CQ_STAGE_GAP_BOTTOM = 8;

export interface ConquestStageGeometry {
  /** Haritaya kalan dikey alan (px); CSS bunu `--cq-stage-h` olarak okur. */
  stageH: number;
}

/**
 * Masaüstü harita yuvasının yüksekliğini YALNIZCA `.cq-battlefield`'ın canlı
 * yüksekliğinden ölçer.  Aktif faz panelini ya da güverteyi KASITEN okumaz →
 * dönüş değeri faz-bağımsızdır; aynı viewport'ta tüm gameplay fazlarında aynı
 * sonucu verir.
 *
 * @param root `.cq-game-screen` kök elemanı (stageRootRef).
 * @returns desktop'ta geometri; mobilde (≤600px) veya alan yokken `null`.
 */
export function measureConquestStageGeometry(
  root: HTMLElement,
): ConquestStageGeometry | null {
  if (typeof window === "undefined") return null;
  // Desktop-only guard: ≤600px'te mobil kabuk layout'u sahiplenir.
  if (window.innerWidth <= 600) return null;

  const battlefield = root.querySelector<HTMLElement>(".cq-battlefield");
  if (!battlefield) return null;

  // Haritaya kalan dikey alan = battlefield yüksekliği − küçük dikey nefes payı.
  // Floor (140) aşırı kısa viewport'ta okunaklı kalmasını sağlar (o patolojik
  // durumda board-wrap `safe center` + `overflow-y:auto` ile nazikçe kaydırır).
  const stageH = Math.max(
    140,
    Math.round(
      battlefield.getBoundingClientRect().height
        - CQ_STAGE_GAP_TOP
        - CQ_STAGE_GAP_BOTTOM,
    ),
  );

  return { stageH };
}
