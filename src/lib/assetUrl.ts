/**
 * assetUrl — public asset path'lerini yüklenebilir URL'e çeviren ortak resolver.
 *
 * NEDEN: Kör Nokta'nın büyük 360 panoramaları (public/assets/kor-nokta-real,
 * public/assets/history/kor-nokta) native app bundle'ından ÇIKARILIR
 * (scripts/prune-app-assets.mjs). Kör Nokta ileride native app'e eklendiğinde bu
 * görseller app içinden DEĞİL, Torble web origin'inden (CDN) UZAKTAN yüklenmeli.
 * Bu modül o ayrımı tek noktada yapar; oyun çalışırken Panoramax API'sine canlı
 * istek ATMAZ — yalnız önceden normalize edilmiş WebP asset'leri çeker.
 *
 *  • Web (tarayıcı, Capacitor değil): relative/same-origin path DEĞİŞMEZ —
 *    mevcut web davranışı birebir korunur.
 *  • Native (Capacitor iOS/Android): `${WEB_ORIGIN}${path}` (mutlak HTTPS URL).
 *
 * WEB_ORIGIN tek yapılandırma noktasıdır: `VITE_PUBLIC_WEB_ORIGIN` (build-time);
 * tanımlı değilse "https://torble.com". Domain'i koda dağıtmayın — buradan okuyun.
 *
 * CORS: Web same-origin olduğu için CORS gerekmez. Native'de asset cross-origin
 * (capacitor://localhost → torble.com) olur; WebGL dokusunun "tainted" olmaması
 * için host (torble.com/CDN) `/assets/**` üzerinde `Access-Control-Allow-Origin`
 * göndermelidir ve loader `crossOrigin="anonymous"` ile istemelidir
 * (isCrossOriginUrl + Panorama360). Bkz. README / dağıtım notu.
 */

import { Capacitor } from "@capacitor/core";

const WEB_ORIGIN: string =
  ((import.meta.env?.VITE_PUBLIC_WEB_ORIGIN as string | undefined)
    ?.trim()
    .replace(/\/+$/, "")) || "https://torble.com";

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Asset'lerin uzaktan (Torble web origin) yüklenmesi gereken ortam mı? */
export function isRemoteAssetMode(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/** Yapılandırılmış web origin (uzaktan asset tabanı). */
export function getWebOrigin(): string {
  return WEB_ORIGIN;
}

/**
 * Bir public asset path'ini yüklenebilir URL'e çevirir. Web'de relative path
 * AYNEN döner (same-origin davranışı bozulmaz); native'de mutlak web-origin
 * URL'i üretir. Zaten mutlak / data: / blob: URL'lere dokunmaz.
 */
export function resolveAssetUrl(path: string): string {
  if (!path) return path;
  if (isAbsoluteUrl(path) || path.startsWith("data:") || path.startsWith("blob:")) {
    return path;
  }
  if (!isRemoteAssetMode()) return path; // web: relative / same-origin → DEĞİŞMEZ
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${WEB_ORIGIN}${normalized}`;
}

/**
 * URL mevcut sayfayla farklı origin'de mi (cross-origin)? Web'de relative path
 * için her zaman false → same-origin davranışı korunur. Native'de mutlak
 * web-origin URL'i için true → loader CORS'lu istemeli.
 */
export function isCrossOriginUrl(url: string): boolean {
  if (!url || !isAbsoluteUrl(url)) return false;
  try {
    if (typeof location === "undefined") return true;
    return new URL(url).origin !== location.origin;
  } catch {
    return false;
  }
}

/**
 * Bir asset'i düşük öncelikle ön-yükler (HTTP cache'ini ısıtır). Best-effort:
 * DOM yoksa / hata olursa sessizce geçer; ana sahne yüklemesini engellemez.
 * Cross-origin'de `crossOrigin="anonymous"` set edilir ki WebGL'in sonradan
 * yapacağı CORS'lu istekle aynı cache girdisi kullanılabilsin.
 */
export function prefetchAssetUrl(path: string): void {
  if (typeof document === "undefined") return;
  const url = resolveAssetUrl(path);
  if (!url) return;
  try {
    const img = new Image();
    if (isCrossOriginUrl(url)) img.crossOrigin = "anonymous";
    // Destekleyen tarayıcılarda düşük öncelik (yoksa görmezden gelinir).
    try {
      (img as unknown as { fetchPriority?: string }).fetchPriority = "low";
    } catch {
      /* ignore */
    }
    img.decoding = "async";
    img.src = url;
  } catch {
    /* sessiz: prefetch best-effort */
  }
}
