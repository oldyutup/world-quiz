/**
 * CizimTestDevPage.tsx — DEV-only Çizim Test prova sayfası.
 *
 * Amaç: modu login akışına girmeden görsel/akış QA'dan geçirmek. Her sayfa
 * yüklemesi RASTGELE sahte profil üretir; iki tarayıcı context'i açıp aynı
 * oda koduyla gerçek 1v1/2v2 akışı (realtime kanal dahil) uçtan uca test
 * edilebilir. Diğer dev sayfaları gibi yalnız `import.meta.env.DEV`'de ve
 * `/cizim-test-dev` path'inde yüklenir — production build'e hiç girmez.
 */
import CizimTestMode from "../modes/cizimTest/CizimTestMode";
import type { Profile } from "../lib/auth";

const suffix = Math.floor(Math.random() * 900 + 100);
const fakeProfile: Profile = {
  id:
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `dev-${Math.random().toString(36).slice(2)}`,
  username: `Test${suffix}`,
  xp: 0,
  level: 1,
  gold: 0,
  avatar_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export default function CizimTestDevPage() {
  return (
    <CizimTestMode
      profile={fakeProfile}
      onHome={() => window.location.assign("/")}
    />
  );
}
