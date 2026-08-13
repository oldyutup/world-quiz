import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { matchLegalRoute } from "./legal/router";

// App'i LAZY yükle. Böylece App.tsx (ve devasa App.css) YALNIZ gerçek uygulama
// açıldığında yüklenir; herkese açık hukuki/destek sayfaları (aşağıda) kendi
// izole stiliyle, App.css'in global body/#root kurallarından etkilenmeden
// render olur. Native + normal web akışında App yine anında yüklenir (Suspense
// fallback null; dev sayfalarıyla aynı desen).
const App = lazy(() => import("./App"));

// Native-shell detection (Capacitor iOS / Android). When — and only when — the
// app runs inside the native webview, tag <html> so CSS can opt safe-area rules
// in for the native app alone. Desktop web and mobile browsers never receive
// these classes, so their layout stays byte-for-byte unchanged. Runs at module
// eval, before render, so the first paint already has the correct insets.
try {
  if (Capacitor.isNativePlatform()) {
    const root = document.documentElement;
    root.classList.add("is-native-app");
    root.classList.add(`is-${Capacitor.getPlatform()}`); // is-ios / is-android
  }
} catch {
  // @capacitor/core is bundled in every build; guard defensively anyway so a
  // missing native bridge in dev/SSR can never break the web render.
}

// Dev-only panorama viewer comparison page. import.meta.env.DEV is statically
// false in production builds, so this branch (and its chunk) never ships.
const PanoramaTestPage =
  import.meta.env.DEV && window.location.pathname === "/panorama-test"
    ? lazy(() => import("./dev/PanoramaTestPage"))
    : null;

// Dev-only Harita Dedektifi 360 kalite test simülasyonu (yeni asset pipeline
// denemesi). Aynı koruma: production build'de bu dal ve chunk hiç oluşmaz.
const History360TestPage =
  import.meta.env.DEV && window.location.pathname === "/history-360-test"
    ? lazy(() => import("./dev/History360TestPage"))
    : null;

// Dev-only Kör Nokta gerçek dünya 360 sahne testi (Panoramax pipeline çıktısı +
// atıf badge). Aynı koruma: production build'de bu dal ve chunk hiç oluşmaz.
const KorNoktaRealTestPage =
  import.meta.env.DEV && window.location.pathname === "/kor-nokta-real-test"
    ? lazy(() => import("./dev/KorNoktaRealTestPage"))
    : null;

// Dev-only Çizim Test prova sayfası (login'siz sahte profil; iki context ile
// gerçek realtime 1v1 akışı denenebilir). Aynı koruma: prod'a girmez.
const CizimTestDevPage =
  import.meta.env.DEV && window.location.pathname === "/cizim-test-dev"
    ? lazy(() => import("./dev/CizimTestDevPage"))
    : null;

// Dev-only Kuşatma MOBİL gameplay ölçüm harness'i (sahte maç state'i; ağ yok).
// Gerçek mobil shell bileşenlerini mount eder, böylece layout iterasyonu canlı
// oda gerektirmez. Aynı koruma: prod build'de bu dal ve chunk hiç oluşmaz.
const ConquestMobileDevPage =
  import.meta.env.DEV && window.location.pathname === "/conquest-mobile-dev"
    ? lazy(() => import("./dev/ConquestMobileDevPage"))
    : null;

const DevPage =
  History360TestPage ?? KorNoktaRealTestPage ?? PanoramaTestPage
  ?? CizimTestDevPage ?? ConquestMobileDevPage;

// Herkese açık hukuki/destek sayfaları (/tr/privacy, /en/support, /privacy …).
// Üretimde de çalışır (dev sayfalarının aksine env-gate YOK). Eşleşme yoksa
// null → uygulama normal açılır. Ağır içerik + stil yalnız bu chunk'ta yüklenir.
const isLegalRoute = matchLegalRoute(window.location.pathname) !== null;
const LegalRoot = isLegalRoute
  ? lazy(() => import("./legal/LegalRoot"))
  : null;

// Öncelik: dev test sayfası (yalnız dev) → hukuki sayfa → uygulama.
const RootComponent = DevPage ?? LegalRoot ?? App;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <RootComponent />
    </Suspense>
  </StrictMode>
);
