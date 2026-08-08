/**
 * inviteLink.ts — davet bağlantısı üretimi (tek doğruluk kaynağı).
 *
 * NEDEN GEREKLİ:
 * Lobiler bugüne kadar davet linkini `${location.origin}${location.pathname}`
 * ile kuruyordu. Bu WEB'de doğrudur ama NATIVE kabukta (Capacitor iOS/Android)
 * `location.origin` → `capacitor://localhost` olur; yani iOS uygulamasından
 * paylaşılan davet linki hiçbir yerde açılmaz. Bu modül o farkı tek noktada
 * kapatır.
 *
 * SÖZLEŞME:
 *   • Web (tarayıcı)  : mevcut davranış BİREBİR korunur —
 *                       `${location.origin}${location.pathname}?<param>=<KOD>`
 *                       (alt dizinde barındırma / preview deploy'ları çalışmaya
 *                        devam eder).
 *   • Native (Capacitor): `${getSiteOrigin()}/?<param>=<KOD>` — paylaşılabilir
 *                       gerçek HTTPS adresi (varsayılan https://torble.com).
 *
 * Paylaşılan bağlantı HER ZAMAN normal bir HTTPS adresidir. Kullanıcıya asla
 * özel URL şeması (com.kavakgames.torble://) gönderilmez; iOS'ta uygulamanın
 * açılması Universal Links'in işidir ve uygulama kurulu değilse aynı adres
 * mobil webde çalışmaya devam eder.
 */
import { getSiteOrigin, isNativeApp } from "../legal/links";
import type { RoomCodeModeKey } from "./roomCodeShared";

/** Mod → davet linki query parametre anahtarı.
 *  Değerler mevcut linklerle BİREBİR aynıdır; değiştirilirse eski paylaşılmış
 *  bağlantılar kırılır. */
export const INVITE_PARAM: Record<RoomCodeModeKey, string> = {
  duel:       "duel",
  flagDuel:   "flagDuel",
  wheelDuel:  "wheelDuel",
  duelGroup:  "duelGroup",
  wheelGroup: "wheelGroup",
  flagGroup:  "flagGroup",
  routeDuel:  "routeDuel",
  korNokta:   "korNokta",
  conquest:   "conquest",
};

/** Query parametre anahtarından moda geri eşleme (deep link okuma yolu). */
export function modeFromInviteParam(param: string): RoomCodeModeKey | null {
  const entry = (Object.keys(INVITE_PARAM) as RoomCodeModeKey[]).find(
    (m) => INVITE_PARAM[m] === param
  );
  return entry ?? null;
}

/**
 * Paylaşılabilir davet bağlantısı.
 *
 * @param mode Oda modu (link parametresini belirler)
 * @param code 6 haneli oda kodu
 */
export function buildInviteUrl(mode: RoomCodeModeKey, code: string): string {
  const param = INVITE_PARAM[mode];
  const query = `?${param}=${encodeURIComponent(code)}`;

  // Native: paylaşılabilir mutlak HTTPS adresi (capacitor://localhost DEĞİL).
  if (isNativeApp()) {
    return `${getSiteOrigin()}/${query}`;
  }

  // Web: mevcut davranış aynen korunur.
  if (typeof location === "undefined") return `${getSiteOrigin()}/${query}`;
  return `${location.origin}${location.pathname}${query}`;
}

/** Uygulama içi göreli oda yolu (send_room_invite RPC + bildirim aksiyonları
 *  bunu bekler; allowlist'e takılmaması için origin İÇERMEZ). */
export function buildRoomPath(mode: RoomCodeModeKey, code: string): string {
  return `/?${INVITE_PARAM[mode]}=${encodeURIComponent(code)}`;
}
