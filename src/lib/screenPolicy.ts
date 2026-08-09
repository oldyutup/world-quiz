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
 *
 * İkinci tüketici: gelen davet linki mevcut odayı ezecek mi? (`roomModeForScreen`)
 */
import type { RoomCodeModeKey } from "./roomCodeShared";

export type AppScreen =
  | "home"
  | "map-game"
  | "flag-game"
  | "silhouette-game"
  | "route-game"
  | "route-duel-game"
  | "duel-game"
  | "duel-group-game"
  | "flag-duel-game"
  | "flag-group-game"
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
  | "cizim-test"
  | "daily-quest-game";

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
  "route-duel-game", // Rota 1v1 (lobi + oyun tek ekranda; oyun fazı baskın)
  "duel-game", // Ülke Yaz 1v1
  "duel-group-game", // Ülke Yaz grup
  "flag-duel-game", // Bayrak Bilmece
  "flag-group-game", // Bayrak Bilmece grup
  "wheel-game", // Çark (solo)
  "wheel-duel-game", // Çark 1v1
  "wheel-group-game", // Çark grup
  "conquest-game", // Kuşatma (savaş)
  "cag-dedektifi", // Çağ Dedektifi
  "harita-dedektifi", // Harita Dedektifi (solo)
  "harita-duel-game", // Kör Nokta (multiplayer)
  "cizim-test", // Çizim Test (prototip; lobi + oyun tek ekranda)
  "daily-quest-game", // Günün Görevi oturumu (4 mod tek yüzeyde)
]);

/** Şu an aktif bir oyun/round ekranında mıyız? Lobiler aktif oyun sayılmaz. */
export function isGameplayActive(screen: AppScreen): boolean {
  return GAMEPLAY_SCREENS.has(screen);
}

/**
 * ODA TAŞIYAN ekran → mod eşlemesi.
 *
 * `GAMEPLAY_SCREENS`ten AYRI bir liste, çünkü sorulan soru farklı: orada "round
 * oynanıyor mu?" (DM toast'ı bastırılsın mı), burada "bu ekranda kaybedilecek
 * bir ODA var mı?". Lobiler round DEĞİLDİR ama oda taşırlar — davet linki bir
 * lobiyi de sessizce ezmemeli, o yüzden lobiler bu haritada VARDIR.
 *
 * Tek oyunculu ekranlar ve `harita-duel-game` (Harita Dedektifi düellosu; oda
 * kodu / davet linki sistemi yoktur) KASTEN dışarıdadır.
 *
 * Yeni bir oda modu eklenirse buraya da eklenmeli; aksi hâlde o modun odası
 * gelen bir davetle onaysız terk edilir.
 */
const ROOM_SCREEN_MODE: Partial<Record<AppScreen, RoomCodeModeKey>> = {
  "duel-game":        "duel",
  "flag-duel-game":   "flagDuel",
  "wheel-duel-game":  "wheelDuel",
  "route-duel-game":  "routeDuel",
  "duel-group-game":  "duelGroup",
  "wheel-group-game": "wheelGroup",
  "flag-group-game":  "flagGroup",
  "conquest-game":    "conquest",
  "conquest-join":    "conquest",
  "kornokta-create":  "korNokta",
  "kornokta-join":    "korNokta",
};

/**
 * Bu ekran bir oda taşıyor mu, taşıyorsa hangi modun odası?
 *
 * `null` → ekranda kaybedilecek oda yok (ana menü, tek oyunculu, oda listesi).
 * Ekranda OLMAK odada olmayı garanti etmez (ör. oyuncu modu açtı ama henüz oda
 * kurmadı); çağıran ayrıca kalıcı oturumu kontrol etmelidir.
 */
export function roomModeForScreen(screen: AppScreen): RoomCodeModeKey | null {
  return ROOM_SCREEN_MODE[screen] ?? null;
}

/** Bu ekranda arkadaş DM'i için sağ-alt toast göstermek uygun mu? */
export function areDmToastsAllowed(screen: AppScreen): boolean {
  return !isGameplayActive(screen);
}
