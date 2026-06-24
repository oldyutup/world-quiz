/**
 * useToastOffset.ts — bildirim toast'larının alttan boşluğunu yüzeye göre ayarlar.
 *
 * NotificationToaster kökte (SocialProvider) `position: fixed` ile asılıdır; alt
 * dock'lu yüzeyler (Kuşatma lobisi Oyuncular/Sohbet, ana menü alt-nav vb.) DOM'da
 * onun atası DEĞİLDİR. Bu yüzden offset'i sabit sayıyla hack'lemek yerine, ortak
 * bir CSS değişkeni (`--app-toast-extra-bottom`, <html> üzerinde) üzerinden
 * veriyoruz; toast host'u bu değişkeni `bottom` calc'ında okur.
 *
 * Birden çok yüzey aynı anda offset talep ederse (geçiş anları, StrictMode
 * çift-mount) çakışma olmasın diye kayıtları bir yığında tutar ve EN YÜKSEK
 * talebi uygular (güvenli üst sınır). Yüzey unmount olunca talebini geri çeker.
 *
 * Desktop web, mobil web ve native iOS/app aynı mekanizmayı kullanır; çağıran
 * yüzey `active` bayrağıyla (ör. yalnız mobilde) ne zaman geçerli olduğunu seçer.
 */
import { useEffect } from "react";

interface OffsetReg {
  id: number;
  px: number;
}

let registrations: OffsetReg[] = [];
let seq = 0;

function apply(): void {
  if (typeof document === "undefined") return;
  const px = registrations.reduce((max, r) => Math.max(max, r.px), 0);
  document.documentElement.style.setProperty("--app-toast-extra-bottom", `${px}px`);
}

/**
 * Bu bileşen mount'tayken (ve `active` iken) toast'ların altına `px` kadar ek
 * boşluk ekler. `active=false` ya da `px<=0` ise bir şey yapmaz. Unmount/değişimde
 * geri çekilir.
 */
export function useToastSurfaceOffset(active: boolean, px: number): void {
  useEffect(() => {
    if (!active || px <= 0) return;
    const id = ++seq;
    registrations.push({ id, px });
    apply();
    return () => {
      registrations = registrations.filter((r) => r.id !== id);
      apply();
    };
  }, [active, px]);
}
