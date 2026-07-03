/**
 * ConquestAssetIcon — Kuşatma özel PNG ikonlarını emoji-fallback ile basan ortak
 * bileşenler.
 *
 * Normal durumda PNG (object-fit: contain, oran korunur, kırpılmaz) görünür;
 * asset yüklenemezse (onError) mevcut emoji fallback'ine düşer (kayıpsız). Tüm
 * Kuşatma yüzeyleri bonus/ayar/harita ikonlarını buradan basar — her komponentte
 * ayrı <img>/if-else yazılmaz. Asset path'leri `conquestIcons` manifestinden
 * gelir, URL çözümü `assetUrl` resolver'ı (web=relative, native=web origin) ile
 * yapılır.
 */

import { useState } from "react";
import { EmojiIcon, type EmojiIconName } from "../../components/EmojiIcon";
import { resolveAssetUrl } from "../../lib/assetUrl";
import type { ConquestRegionBonusType } from "./types";
import { getConquestBonusAsset } from "./conquestIcons";

interface ConquestAssetIconProps {
  /** Public asset path (conquestIcons manifestinden). Yoksa doğrudan emoji. */
  src?: string | null;
  /** Erişilebilir/ilgili Türkçe ad — img alt. */
  alt: string;
  className?: string;
  /** Piksel boyutu. Verilmezse kapsayıcıdan miras (1em). */
  size?: number;
  /** Asset yüklenemezse gösterilecek ham emoji. */
  fallbackChar?: string;
  /** Asset yüklenemezse gösterilecek tip-güvenli emoji adı (char yerine). */
  fallbackName?: EmojiIconName;
}

export function ConquestAssetIcon({
  src,
  alt,
  className,
  size,
  fallbackChar,
  fallbackName,
}: ConquestAssetIconProps) {
  const [errored, setErrored] = useState(false);

  if (src && !errored) {
    return (
      <img
        src={resolveAssetUrl(src)}
        alt={alt}
        className={"cq-asset-icon" + (className ? " " + className : "")}
        style={size ? { width: size, height: size } : undefined}
        draggable={false}
        onError={() => setErrored(true)}
      />
    );
  }

  // Emoji fallback — mevcut görsel dili (Fluent SVG) korur, bilinmeyen glyph'te
  // ham emoji'ye düşer.
  if (fallbackName) {
    return (
      <EmojiIcon
        name={fallbackName}
        className={className}
        size={size}
        title={alt || undefined}
      />
    );
  }
  return (
    <EmojiIcon
      char={fallbackChar ?? ""}
      className={className}
      size={size}
      title={alt || undefined}
    />
  );
}

interface ConquestBonusIconProps {
  /** Bonus tipi — PNG asset bu tipe göre çözülür. */
  type: ConquestRegionBonusType;
  /** Asset yoksa/başarısızsa gösterilecek bonus emoji'si (def.icon). */
  fallbackChar: string;
  /** Erişilebilir ad; verilmezse dekoratif (alt=""). */
  alt?: string;
  className?: string;
  size?: number;
}

/** Bonus ikonunu tipe göre çözen kısayol — DOM yüzeyleri için. */
export function ConquestBonusIcon({
  type,
  fallbackChar,
  alt = "",
  className,
  size,
}: ConquestBonusIconProps) {
  return (
    <ConquestAssetIcon
      src={getConquestBonusAsset(type) ?? null}
      alt={alt}
      className={className}
      size={size}
      fallbackChar={fallbackChar}
    />
  );
}

interface ConquestMapBonusGlyphProps {
  /** Bonus tipi — PNG asset bu tipe göre çözülür. */
  type: ConquestRegionBonusType;
  /** Asset yoksa/başarısızsa gösterilecek emoji (SVG <text>). */
  fallbackChar: string;
  /** İkon merkezinin SVG x koordinatı. */
  cx: number;
  /** İkon merkezinin SVG y koordinatı. */
  cy: number;
  /** SVG kenar uzunluğu (kare kutu); preserveAspectRatio ile oran korunur. */
  size: number;
}

/**
 * Harita üzerindeki bonus marker ikonu — SVG bağlamı için `<image>` (PNG) ile
 * `<text>` (emoji) fallback. `<image>` onError'da emoji'ye düşer. SVG olduğu için
 * DOM `ConquestAssetIcon`'dan ayrıdır.
 */
export function ConquestMapBonusGlyph({
  type,
  fallbackChar,
  cx,
  cy,
  size,
}: ConquestMapBonusGlyphProps) {
  const [errored, setErrored] = useState(false);
  const src = getConquestBonusAsset(type);

  if (src && !errored) {
    const half = size / 2;
    return (
      <image
        href={resolveAssetUrl(src)}
        x={cx - half}
        y={cy - half}
        width={size}
        height={size}
        preserveAspectRatio="xMidYMid meet"
        className="cq-map-bonus-img"
        onError={() => setErrored(true)}
      />
    );
  }

  // Emoji fallback boyutu istenen kutuyu izler (sınıftaki sabit px yerine) —
  // büyük bölge-içi emblem de, küçük marker da aynı bileşenden doğru ölçekte
  // çıkar.
  return (
    <text
      x={cx}
      y={cy + 0.5}
      textAnchor="middle"
      dominantBaseline="middle"
      className="cq-map-bonus-icon"
      style={{ fontSize: size * 0.72 }}
    >
      {fallbackChar}
    </text>
  );
}
