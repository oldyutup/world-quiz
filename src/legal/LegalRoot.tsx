/**
 * legal/LegalRoot.tsx
 *
 * Hukuki/destek sayfalarının kök bileşeni. main.tsx bunu YALNIZ pathname bir
 * hukuki route ise lazy yükler; böylece ağır içerik + stil, uygulama ana
 * yüklemesine girmez (App tamamen ayrı chunk).
 *
 * Sorumluluklar:
 *   • Path state + SPA gezinme (pushState/popstate) → dil/tür geçişi reload'suz.
 *   • /privacy ve /support için tarayıcı diline göre kanonik URL'e yumuşak
 *     yönlendirme (replaceState) + doğru dildeki içeriği anında gösterme.
 *   • Bozuk hukuki route → 404 bileşeni.
 *   • Dev'de TR/EN içerik paritesi doğrulaması.
 */
import { useCallback, useEffect, useState } from "react";
import { matchLegalRoute } from "./router";
import { LegalPage, LegalNotFound } from "./LegalPage";
import { assertParallelDocs } from "./content";
import "./legal.css";

export default function LegalRoot() {
  const [path, setPath] = useState(() => window.location.pathname);

  // Dev-zamanı içerik paritesi kontrolü (üretimde çalışmaz).
  useEffect(() => {
    if (import.meta.env.DEV) assertParallelDocs();
  }, []);

  // Geri/İleri düğmeleri.
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    if (to !== window.location.pathname) {
      window.history.pushState(null, "", to);
    }
    setPath(to);
    if (typeof window.scrollTo === "function") window.scrollTo(0, 0);
  }, []);

  const match = matchLegalRoute(path) ?? { type: "notfound" as const };

  // /privacy · /support → kanonik /<dil>/<tür> adresine yumuşak yönlendir.
  useEffect(() => {
    if (
      match.type === "redirect" &&
      window.location.pathname !== match.canonicalPath
    ) {
      window.history.replaceState(null, "", match.canonicalPath);
      setPath(match.canonicalPath);
    }
    // match nesnesi her render'da yeniden üretilir; ilgili primitifleri izle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    match.type,
    match.type === "redirect" ? match.canonicalPath : "",
  ]);

  if (match.type === "notfound") {
    return <LegalNotFound navigate={navigate} />;
  }

  // page ve redirect: ikisinde de kind + locale bilinir → içeriği hemen göster.
  return <LegalPage kind={match.kind} locale={match.locale} navigate={navigate} />;
}
