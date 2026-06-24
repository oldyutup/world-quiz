/**
 * conquestIcons — Kuşatma (Conquest) için TEK merkezî asset manifesti/resolver'ı.
 *
 * Kuşatma lobby ve oyun-içi yüzeylerinde kullanılan tüm özel PNG ikonlarının
 * (bonuslar, lobby ayarları, harita seçimi, arkadaş daveti) public path'lerini
 * tek noktada toplar. Bileşenler emoji yerine bu manifestten gelen path'i
 * `ConquestAssetIcon` üzerinden basar; her komponentte dağınık sabit string
 * KULLANILMAZ. Asset yüklenemezse mevcut emoji fallback'i devreye girer.
 *
 * Kapsam: YALNIZ Kuşatma. Ana menü, Çark, Duel, Bayrak, Kör Nokta ve diğer
 * lobby türleri bu manifesti kullanmaz.
 *
 * Path'ler relative public path'lerdir; yüklenebilir URL'e çevirmek `assetUrl`
 * resolver'ının (web=relative, native=web origin) görevidir — bu modül URL
 * üretmez, yalnız hangi asset'in hangi anahtara ait olduğunu bilir.
 */

import type {
  ConquestBonusDistribution,
  ConquestMapId,
  ConquestRegionBonusType,
  ConquestTeamMode,
  ConquestVisibility,
} from "./types";

// Public asset kök dizinleri — domain/path tek noktada.
const BONUS_DIR    = "/assets/conquest/bonuses";
const MAP_DIR      = "/assets/conquest/maps";
const SETTINGS_DIR = "/assets/ui/lobby/settings";
const LOBBY_DIR    = "/assets/conquest/lobby";
const OPTIONS_DIR  = "/assets/conquest/options";

// ── Bonuslar ─────────────────────────────────────────────────────────────────
/**
 * Bonus *tipi* → PNG asset. Anahtar bonus tipidir (kanonik), bölge/emoji değil.
 * `Partial`: tip union'ı henüz uygulanmamış (implemented:false) pool girişlerini
 * de taşır; onların asset'i yoktur → resolver `undefined` döner → emoji fallback.
 */
export const CONQUEST_BONUS_ASSETS: Partial<Record<ConquestRegionBonusType, string>> = {
  istanbul_defense:     `${BONUS_DIR}/castle-walls.png`,        // Kale Surları
  mevzi_bekcisi:        `${BONUS_DIR}/watchtower.png`,          // Mevzi Bekçisi
  karadeniz_extra_time: `${BONUS_DIR}/time-boost.png`,          // Zaman Takviyesi
  kocbasi:              `${BONUS_DIR}/battering-ram.png`,       // Koçbaşı
  ankara_hidden_shield: `${BONUS_DIR}/secret-operation.png`,    // Gizli Operasyon
  mancinik:             `${BONUS_DIR}/catapult.png`,            // Mancınık
  eleme_yetkisi:        `${BONUS_DIR}/sealed-decree.png`,       // Eleme Yetkisi
  kahin:                `${BONUS_DIR}/oracle-magic.png`,        // Kâhin Büyüsü
  istihbarat_agi:       `${BONUS_DIR}/intelligence-raven.png`,  // İstihbarat Ağı
  cukurova_score:       `${BONUS_DIR}/fertile-plains.png`,      // Bereketli Ova
  liman:                `${BONUS_DIR}/harbor.png`,              // Liman
};

/** Bonus tipinin PNG path'i (yoksa undefined → emoji fallback). */
export function getConquestBonusAsset(
  type: ConquestRegionBonusType,
): string | undefined {
  return CONQUEST_BONUS_ASSETS[type];
}

// ── Harita seçimi ────────────────────────────────────────────────────────────
/** "Harita" alan başlığı ikonu. */
export const CONQUEST_MAP_SELECTION_ASSET = `${MAP_DIR}/map-selection.png`;

/** Harita id → seçenek/seçili değer PNG'si. */
export const CONQUEST_MAP_ASSETS: Record<ConquestMapId, string> = {
  turkey:        `${MAP_DIR}/map-turkey-conquest.png`,
  europe:        `${MAP_DIR}/map-europe-conquest.png`,
  "middle-east": `${MAP_DIR}/map-middle-east-conquest.png`,
};

/** Harita id'sinin PNG path'i (yoksa undefined → emoji fallback). */
export function getConquestMapAsset(id: ConquestMapId): string | undefined {
  return CONQUEST_MAP_ASSETS[id];
}

// ── Lobby ayar ikonları ──────────────────────────────────────────────────────
/** Kuşatma lobby ayar satırı anahtarları (Harita ayrı; haritanın kendi seti). */
export type ConquestSettingIconKey =
  | "players"
  | "rounds"
  | "visibility"
  | "bonusDistribution"
  | "gameMode";

export const CONQUEST_SETTING_ASSETS: Record<ConquestSettingIconKey, string> = {
  players:           `${SETTINGS_DIR}/setting-players.png`,
  rounds:            `${SETTINGS_DIR}/setting-rounds-cycle.png`,
  visibility:        `${SETTINGS_DIR}/setting-visibility.png`,
  bonusDistribution: `${SETTINGS_DIR}/setting-bonus-distribution.png`,
  gameMode:          `${SETTINGS_DIR}/setting-game-mode.png`,
};

// ── Lobby seçenek (dropdown değer) ikonları ──────────────────────────────────
/**
 * Bu ikonlar dropdown'ın *seçili değer satırında* ve *açık liste seçeneklerinde*
 * görünen kompakt PNG'lerdir. Ayar BAŞLIĞI ikonları (CONQUEST_SETTING_ASSETS)
 * ayrıdır ve korunur — bunlar yalnız seçenek/seçili-değer içindir. Tam Record:
 * her union değerinin asset'i vardır; resolver string döner (emoji fallback yine
 * de ConquestAssetIcon onError ile devreye girer). Yalnız Kuşatma lobby/setup.
 */
export const CONQUEST_VISIBILITY_OPTION_ASSETS: Record<ConquestVisibility, string> = {
  public:  `${OPTIONS_DIR}/option-visibility-open-eye.png`,       // Açık Oda
  private: `${OPTIONS_DIR}/option-visibility-locked-padlock.png`, // Gizli Oda
};

export const CONQUEST_BONUS_DISTRIBUTION_OPTION_ASSETS: Record<ConquestBonusDistribution, string> = {
  random: `${OPTIONS_DIR}/option-bonus-random-dice.png`, // Rastgele
  vote:   `${OPTIONS_DIR}/option-bonus-vote-box.png`,    // Oy ile Seç
};

export const CONQUEST_TEAM_MODE_OPTION_ASSETS: Record<ConquestTeamMode, string> = {
  individual: `${OPTIONS_DIR}/option-game-mode-individual-helmet.png`, // Bireysel
  teams_2v2:  `${OPTIONS_DIR}/option-game-mode-team-two-shields.png`,   // 2v2 Takımlı
};

/** Görünürlük seçeneğinin PNG path'i. */
export function getConquestVisibilityOptionAsset(v: ConquestVisibility): string {
  return CONQUEST_VISIBILITY_OPTION_ASSETS[v];
}
/** Bonus dağıtımı seçeneğinin PNG path'i. */
export function getConquestBonusDistributionOptionAsset(m: ConquestBonusDistribution): string {
  return CONQUEST_BONUS_DISTRIBUTION_OPTION_ASSETS[m];
}
/** Oyun tipi (bireysel/2v2) seçeneğinin PNG path'i. */
export function getConquestTeamModeOptionAsset(m: ConquestTeamMode): string {
  return CONQUEST_TEAM_MODE_OPTION_ASSETS[m];
}

// ── Lobby panel ikonları ─────────────────────────────────────────────────────
/** "Oyuncular" bölüm başlığı ikonu (sol panel + mobil sheet başlığı). */
export const CONQUEST_LOBBY_SECTION_PLAYERS_ASSET = `${LOBBY_DIR}/section-players.png`;
/** "Linki Kopyala" butonu ikonu (orta panel). */
export const CONQUEST_LOBBY_COPY_LINK_ASSET = `${LOBBY_DIR}/action-copy-link-scroll.png`;
/** "Sohbet" bölüm başlığı ikonu (sağ panel + mobil sheet başlığı). */
export const CONQUEST_LOBBY_SECTION_CHAT_ASSET = `${LOBBY_DIR}/section-chat-bubble.png`;
/** "Oyunu Başlat" butonu ikonu (orta panel — yalnız ev sahibi). */
export const CONQUEST_LOBBY_START_ASSET = `${LOBBY_DIR}/action-start-cannon.png`;

// ── Arkadaş daveti ───────────────────────────────────────────────────────────
/** Kuşatma lobby "Arkadaş Davet Et" butonu ikonu (yalnız Kuşatma). */
export const CONQUEST_FRIEND_INVITE_ASSET = `${LOBBY_DIR}/friend-invite-duel.png`;
