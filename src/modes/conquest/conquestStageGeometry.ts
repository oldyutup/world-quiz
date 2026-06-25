// ── Kuşatma masaüstü harita yuvası (desktop map slot) geometrisi ──────────
//
// KÖK NEDEN (bu modülün varlık sebebi): Eski "safe-stage" ölçüm hook'u, aktif
// faz panelinin (`.cq-game-phase-panel`) GERÇEK yüksekliğini ölçüp harita
// boyutuna bağlıyordu (`--cq-stage-h` → `min(..., stageH × 1005/490)`).  Panel
// `position: fixed` olduğu için akışı (flex flow) İTMEZ; harita yuvasını
// yalnızca bu ölçüm değiştiriyordu.  Sonuç: AYNI viewport'ta faz değişince
// (question → answered → reveal → action → round_result) panel yüksekliği
// değiştiğinden harita büyüyor/küçülüyor/yer değiştiriyordu.
//
// ÇÖZÜM: Harita yuvası YALNIZCA viewport/kök geometriden hesaplanır — sticky
// header'ın alt kenarı + in-flow footer'ın üst kenarı + sabit alt rezerv.  Faz
// paneli ölçüme HİÇ girmez, dolayısıyla faz değişimi yuvayı değiştiremez.  Yuva
// yalnızca gerçek pencere/viewport resize'ında (header/footer/viewport değişince)
// yeniden hesaplanır → farklı monitörlerde doğal responsive fit korunur.
//
// Kapsam: yalnızca desktop (≥601px) `.cq-game-screen`.  Mobil (≤600px)
// MobileConquestLayout kullanır → bu modül `null` döner, mobil etkilenmez.

/** Harita ile üst (header) ve alt (rezerv) komşuları arasındaki nefes payı. */
export const CQ_STAGE_GAP_TOP = 10;
export const CQ_STAGE_GAP_BOTTOM = 14;

// Alt dock faz paneli için ayrılan SABİT bant.  TASARIM GEREĞİ SABİT: panel
// `position: fixed; bottom: 60px` ile board'u örter (akışı itmez) ve içeriğine
// göre yüksekliği faza göre değişir.  Bu yüksekliği yuvaya katmak, haritayı
// fazlar arası kaydıran tam da o hataydı.  Bunun yerine en uzun dock panelini
// temizleyecek kadar büyük, SABİT bir bant ayırıyoruz → yuva viewport/kök
// geometrinin saf fonksiyonu kalır, panelin altında güney bölgeleri panel
// altında ezilmeden harita ortalanır.
export const CQ_STAGE_DOCK_RESERVE = 210;

export interface ConquestStageGeometry {
  /** Haritaya kalan dikey alan (px); CSS bunu `--cq-stage-h` olarak okur. */
  stageH: number;
  /** board-wrap'in alt padding'i (px); CSS `--cq-stage-dock-reserve`. */
  dockReserve: number;
}

/**
 * Masaüstü harita yuvasının yüksekliğini ve alt rezervini, YALNIZCA kök
 * geometriden (header alt kenarı + footer üst kenarı + viewport) ölçer.  Aktif
 * faz panelini KASITEN okumaz → dönüş değeri faz-bağımsızdır; aynı viewport'ta
 * tüm gameplay fazlarında aynı sonucu verir.
 *
 * @param root `.cq-game-screen` kök elemanı (stageRootRef).
 * @returns desktop'ta geometri; mobilde (≤600px) veya pencere yokken `null`.
 */
export function measureConquestStageGeometry(
  root: HTMLElement,
): ConquestStageGeometry | null {
  if (typeof window === "undefined") return null;
  // Desktop-only guard: ≤600px'te mobil kabuk layout'u sahiplenir.
  if (window.innerWidth <= 600) return null;

  const header = root.querySelector<HTMLElement>(".cq-game-header");
  const footer = root.querySelector<HTMLElement>(".cq-game-footer");

  // Üst sınır = sticky header'ın alt kenarı.  Alt sınır = in-flow footer'ın üst
  // kenarı (footer yoksa viewport tabanı).  Faz paneli BİLİNÇLİ olarak ölçüm
  // dışı — yuvanın faz-değişmez kalmasının anahtarı budur.
  const topBound = header ? header.getBoundingClientRect().bottom : 0;
  const footerTop = footer
    ? footer.getBoundingClientRect().top
    : window.innerHeight;

  // Haritaya kalan dikey alan: header→footer bandından üst/alt nefes payı ve
  // sabit dock rezervi düşülür.  Floor (140) aşırı kısa viewport'ta okunaklı
  // kalmasını sağlar (o patolojik durumda board-wrap `safe center` +
  // `overflow-y:auto` nazik scroll'a düşer, kırpmaz).
  const stageH = Math.max(
    140,
    Math.round(
      footerTop
        - topBound
        - CQ_STAGE_GAP_TOP
        - CQ_STAGE_GAP_BOTTOM
        - CQ_STAGE_DOCK_RESERVE,
    ),
  );

  // board-wrap alt padding'i: harita, dock bandının ÜZERİNDE ortalanır.  Sabit
  // (panel ölçülmez) → faz değişince merkez kaymaz.
  const dockReserve = CQ_STAGE_DOCK_RESERVE + CQ_STAGE_GAP_BOTTOM;

  return { stageH, dockReserve };
}
