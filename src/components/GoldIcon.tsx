/**
 * GoldIcon — uygulama genelinde "Gold" para birimini temsil eden TEK ortak ikon.
 *
 * Tüm Gold sayaçları, ödülleri, günlük bonus, mağaza/ipucu maliyetleri ve oyun-içi
 * Gold rozetleri bu bileşeni kullanır; böylece coin görseli her yerde birebir aynıdır.
 * Tek kaynak asset PNG'dir ve PNG olarak kalır (public/assets/ui/gold/gold-coin.png).
 *
 * Boyut: `size` verilmezse ikon 1em'dir; yani onu saran kabın `font-size`'ına göre
 * ölçeklenir. Eski emoji/SVG coin'ler de kabın font boyutuyla render olduğundan bu
 * yaklaşım mevcut layout'ları DEĞİŞTİRMEDEN birebir korur. Çok küçük sayaçlarda da
 * coin okunabilir kalır (yalnız boyut değişir, görsel farklılaşmaz).
 *
 * `object-fit: contain` + sabit en-boy oranı → coin asla bozulmaz.
 * Dekoratif kullanımda `alt=""` (varsayılan) ile ekran okuyuculardan gizlenir.
 */

/** Ortak Gold coin asset'inin uygulama-içi URL'i (public klasöründen servis edilir). */
export const GOLD_COIN_SRC = "/assets/ui/gold/gold-coin.png";

interface GoldIconProps {
  /** İkon kenar uzunluğu (px). Verilmezse 1em (kabın font-size'ı) kullanılır. */
  size?: number;
  /** Ek CSS sınıfı (mevcut sınıflarla uyum için). */
  className?: string;
  /** Erişilebilirlik metni. Dekoratif kullanımda boş bırakılır (varsayılan). */
  alt?: string;
}

export default function GoldIcon({ size, className, alt = "" }: GoldIconProps) {
  return (
    <img
      src={GOLD_COIN_SRC}
      alt={alt}
      className={"gold-coin-icon" + (className ? " " + className : "")}
      style={size != null ? { width: size, height: size } : undefined}
      draggable={false}
      aria-hidden={alt === "" ? true : undefined}
    />
  );
}
