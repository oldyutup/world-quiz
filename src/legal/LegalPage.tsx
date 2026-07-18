/**
 * legal/LegalPage.tsx
 *
 * TEK paylaşılan hukuki/destek sayfa bileşeni. Dil + belge türü verilir, içerik
 * merkezi `content/` yapısından render edilir (dil başına ayrı bileşen YOKTUR).
 *
 * Kapsam:
 *   • Semantik HTML (header/nav/main/section/footer), doğru başlık sırası
 *     (tek h1, bölümler h2, alt başlıklar h3), atlama bağlantısı, klavye erişimi.
 *   • Erişilebilir TR/EN dil değiştirici + içindekiler (TOC) + çapraz bağlantılar.
 *   • <head> yönetimi: title, description, canonical, hreflang, <html lang>.
 *   • Dil ve tür geçişleri SPA içinde (navigate) — tam sayfa yeniden yükleme yok.
 */
import { useEffect, type MouseEvent } from "react";
import type { LegalLocale } from "./locales";
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from "./locales";
import type { LegalBlock, LegalDocKind } from "./content/types";
import { getDoc } from "./content";
import { CHROME, formatLastUpdated, LAST_UPDATED_ISO } from "./content/chrome";
import { legalPath } from "./router";
import { legalAbsoluteUrl } from "./links";

const TORBLE_LOGO = "/assets/brand/torble-logo.png";
const HERO_ART = "/assets/brand/earth-half.png";

/* ── <head> yardımcıları (idempotent upsert) ──────────────────────────── */

function upsertMeta(name: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("name", name);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function upsertLink(
  rel: string,
  href: string,
  hreflang?: string
): HTMLLinkElement {
  const selector = hreflang
    ? `link[rel="${rel}"][hreflang="${hreflang}"]`
    : `link[rel="${rel}"]:not([hreflang])`;
  let el = document.head.querySelector<HTMLLinkElement>(selector);
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    if (hreflang) el.setAttribute("hreflang", hreflang);
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
  return el;
}

/* ── Blok render ──────────────────────────────────────────────────────── */

function Block({ block }: { block: LegalBlock }) {
  switch (block.type) {
    case "p":
      return <p className="tp-p">{block.text}</p>;
    case "subheading":
      return <h3 className="tp-subheading">{block.text}</h3>;
    case "note":
      return (
        <p className="tp-note" role="note">
          {block.text}
        </p>
      );
    case "list":
      return block.ordered ? (
        <ol className="tp-list tp-list--ordered">
          {block.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ol>
      ) : (
        <ul className="tp-list">
          {block.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      );
    case "contact":
      return (
        <p className="tp-contact">
          <span className="tp-contact-label">{block.label}:</span>{" "}
          <a className="tp-link" href={`mailto:${block.email}`}>
            {block.email}
          </a>
        </p>
      );
  }
}

/* ── Sayfa ────────────────────────────────────────────────────────────── */

interface LegalPageProps {
  kind: LegalDocKind;
  locale: LegalLocale;
  navigate: (to: string) => void;
}

export function LegalPage({ kind, locale, navigate }: LegalPageProps) {
  const doc = getDoc(kind, locale);
  const chrome = CHROME[locale];
  const otherKind: LegalDocKind = kind === "privacy" ? "support" : "privacy";
  const year = new Date().getFullYear();

  // <head>: title / description / canonical / hreflang / <html lang>.
  useEffect(() => {
    const prevLang = document.documentElement.getAttribute("lang");
    document.documentElement.setAttribute("lang", chrome.htmlLang);
    document.title = `${doc.title} · Torble`;
    upsertMeta("description", doc.metaDescription);

    upsertLink("canonical", legalAbsoluteUrl(kind, locale));
    for (const loc of SUPPORTED_LOCALES) {
      upsertLink("alternate", legalAbsoluteUrl(kind, loc), loc);
    }
    upsertLink("alternate", legalAbsoluteUrl(kind, DEFAULT_LOCALE), "x-default");

    return () => {
      if (prevLang) document.documentElement.setAttribute("lang", prevLang);
    };
  }, [kind, locale, doc.title, doc.metaDescription, chrome.htmlLang]);

  const goInternal =
    (path: string) => (e: MouseEvent<HTMLAnchorElement>) => {
      // Yeni sekme / orta tık / değiştirici tuş → tarayıcının doğal davranışı.
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return;
      }
      e.preventDefault();
      navigate(path);
    };

  return (
    <div className="tp-root" data-kind={kind} data-locale={locale}>
      <a className="tp-skip" href="#tp-main">
        {locale === "tr" ? "İçeriğe geç" : "Skip to content"}
      </a>

      {/* Üst bar: marka + dil değiştirici */}
      <header className="tp-topbar">
        <div className="tp-topbar-inner">
          <a className="tp-brand" href="/" aria-label={chrome.homeAriaLabel}>
            <img className="tp-brand-logo" src={TORBLE_LOGO} alt="" aria-hidden="true" />
            <span className="tp-brand-name">Torble</span>
          </a>

          <nav className="tp-lang" aria-label={chrome.languageSwitchLabel}>
            {SUPPORTED_LOCALES.map((loc) => {
              const active = loc === locale;
              const path = legalPath(kind, loc);
              return (
                <a
                  key={loc}
                  className={`tp-lang-btn${active ? " is-active" : ""}`}
                  href={path}
                  hrefLang={loc}
                  aria-current={active ? "true" : undefined}
                  onClick={goInternal(path)}
                >
                  {loc.toUpperCase()}
                </a>
              );
            })}
          </nav>
        </div>
      </header>

      {/* Hero */}
      <div className="tp-hero">
        <div className="tp-hero-inner">
          <p className="tp-eyebrow">Torble</p>
          <h1 className="tp-title">{doc.title}</h1>
          <p className="tp-tagline">{doc.tagline}</p>
          <p className="tp-updated">
            {chrome.lastUpdatedLabel}:{" "}
            <time dateTime={LAST_UPDATED_ISO}>
              {formatLastUpdated(LAST_UPDATED_ISO, locale)}
            </time>
          </p>
        </div>
        <img className="tp-hero-art" src={HERO_ART} alt="" aria-hidden="true" />
      </div>

      {/* Gövde: içindekiler + ana içerik */}
      <div className="tp-body">
        <aside className="tp-toc" aria-label={chrome.tocLabel}>
          <p className="tp-toc-title">{chrome.tocLabel}</p>
          <ol className="tp-toc-list">
            {doc.sections.map((s) => (
              <li key={s.id}>
                <a className="tp-toc-link" href={`#${s.id}`}>
                  {s.heading}
                </a>
              </li>
            ))}
          </ol>
        </aside>

        <main id="tp-main" className="tp-main">
          {doc.intro.length > 0 && (
            <div className="tp-intro">
              {doc.intro.map((b, i) => (
                <Block key={i} block={b} />
              ))}
            </div>
          )}

          {doc.sections.map((s) => (
            <section key={s.id} id={s.id} className="tp-section">
              <h2 className="tp-heading">{s.heading}</h2>
              {s.blocks.map((b, i) => (
                <Block key={i} block={b} />
              ))}
            </section>
          ))}
        </main>
      </div>

      {/* Alt bilgi */}
      <footer className="tp-footer">
        <nav className="tp-footer-nav" aria-label={locale === "tr" ? "Sayfalar" : "Pages"}>
          <a
            className="tp-footer-link"
            href={legalPath(otherKind, locale)}
            onClick={goInternal(legalPath(otherKind, locale))}
          >
            {otherKind === "privacy" ? chrome.privacyNav : chrome.supportNav}
          </a>
          <a className="tp-footer-link" href={`mailto:contact@torble.com`}>
            {chrome.contactNav}
          </a>
          <a className="tp-footer-link" href="/">
            {chrome.backToApp}
          </a>
        </nav>
        <p className="tp-footer-meta">{chrome.footerRights(year)}</p>
        <p className="tp-footer-note">{chrome.footerNote}</p>
      </footer>
    </div>
  );
}

/* ── 404 (hukuki namespace fallback) ──────────────────────────────────── */

export function LegalNotFound({
  navigate,
}: {
  navigate: (to: string) => void;
}) {
  const locale = DEFAULT_LOCALE;
  const chrome = CHROME[locale];

  useEffect(() => {
    document.documentElement.setAttribute("lang", chrome.htmlLang);
    document.title = `${chrome.notFoundTitle} · Torble`;
    upsertMeta("robots", "noindex");
  }, [chrome.htmlLang, chrome.notFoundTitle]);

  const goInternal =
    (path: string) => (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      navigate(path);
    };

  return (
    <div className="tp-root tp-root--notfound" data-locale={locale}>
      <header className="tp-topbar">
        <div className="tp-topbar-inner">
          <a className="tp-brand" href="/" aria-label={chrome.homeAriaLabel}>
            <img className="tp-brand-logo" src={TORBLE_LOGO} alt="" aria-hidden="true" />
            <span className="tp-brand-name">Torble</span>
          </a>
        </div>
      </header>
      <div className="tp-notfound">
        <h1 className="tp-title">{chrome.notFoundTitle}</h1>
        <p className="tp-tagline">{chrome.notFoundBody}</p>
        <nav className="tp-notfound-nav" aria-label={chrome.tocLabel}>
          <a
            className="tp-footer-link"
            href={legalPath("privacy", locale)}
            onClick={goInternal(legalPath("privacy", locale))}
          >
            {chrome.privacyNav}
          </a>
          <a
            className="tp-footer-link"
            href={legalPath("support", locale)}
            onClick={goInternal(legalPath("support", locale))}
          >
            {chrome.supportNav}
          </a>
          <a className="tp-footer-link" href="/">
            {chrome.backToApp}
          </a>
        </nav>
      </div>
    </div>
  );
}
