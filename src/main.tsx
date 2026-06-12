import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

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

const DevPage = History360TestPage ?? PanoramaTestPage;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {DevPage ? (
      <Suspense fallback={null}>
        <DevPage />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>
);
