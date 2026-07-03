/**
 * screenPolicy.ts — uygulamanın üst-düzey ekranları ve ekran-bazlı politika.
 *
 * TEK KAYNAK: `AppScreen` union'ı burada tanımlıdır (App.tsx buradan import eder).
 * "Şu an aktif bir oyun/round ekranında mıyız?" gibi ekran-bazlı kararlar da
 * buradan geçer; böylece her oyun bileşenine ayrı ayrı kontrol serpiştirmek
 * yerine tek, sürdürülebilir bir katman olur.
 *
 * İlk tüketici: arkadaş DM'i için sağ-alt toast bastırma. Aktif oyunda toast
 * gösterilmez (mesaj/unread yine kaydedilir); ana menü, profil/sosyal ekranlar
 * ve oyun LOBİLERİnde gösterilir. Lobi aktif oyun SAYILMAZ.
 */

export type AppScreen =
  | "home"
  | "map-game"
  | "flag-game"
  | "silhouette-game"
  | "route-game"
  | "duel-game"
  | "duel-group-game"
  | "flag-duel-game"
  | "wheel-game"
  | "wheel-duel-game"
  | "wheel-group-game"
  | "conquest-game"
  | "conquest-rooms"
  | "conquest-join"
  | "cag-dedektifi"
  | "harita-dedektifi"
  | "harita-duel-game"
  | "kornokta-create"
  | "kornokta-join"
  | "cizim-test";

/**
 * Aktif oyun/round ekranları. Bu ekranlarda sosyal DM toast'ı bastırılır.
 *
 * DIŞARIDA BIRAKILANLAR (kasıtlı — aktif oyun DEĞİL):
 *   - "home"                         → ana menü
 *   - "conquest-rooms" / "-join"     → Kuşatma lobileri
 *   - "kornokta-create" / "-join"    → Kör Nokta lobileri
 *   Profil/sosyal ekranlar ayrı bir AppScreen değildir; ana menü / lobi üstünde
 *   modal olarak açılır, yani otomatik olarak "izin verilen" tarafta kalırlar.
 *
 * `Record<AppScreen, boolean>` yerine Set kullanıldı ama union eksiksizliği
 * korunması için yeni bir gameplay ekranı eklendiğinde buraya da eklenmeli.
 */
const GAMEPLAY_SCREENS: ReadonlySet<AppScreen> = new Set<AppScreen>([
  "map-game", // Ülke Yaz (solo)
  "flag-game", // Bayrak (solo)
  "silhouette-game", // Silüet
  "route-game", // Rota
  "duel-game", // Ülke Yaz 1v1
  "duel-group-game", // Ülke Yaz grup
  "flag-duel-game", // Bayrak Bilmece
  "wheel-game", // Çark (solo)
  "wheel-duel-game", // Çark 1v1
  "wheel-group-game", // Çark grup
  "conquest-game", // Kuşatma (savaş)
  "cag-dedektifi", // Çağ Dedektifi
  "harita-dedektifi", // Harita Dedektifi (solo)
  "harita-duel-game", // Kör Nokta (multiplayer)
  "cizim-test", // Çizim Test (prototip; lobi + oyun tek ekranda)
]);

/** Şu an aktif bir oyun/round ekranında mıyız? Lobiler aktif oyun sayılmaz. */
export function isGameplayActive(screen: AppScreen): boolean {
  return GAMEPLAY_SCREENS.has(screen);
}

/** Bu ekranda arkadaş DM'i için sağ-alt toast göstermek uygun mu? */
export function areDmToastsAllowed(screen: AppScreen): boolean {
  return !isGameplayActive(screen);
}
