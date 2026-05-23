/**
 * Turkey province data for the Conquest map layer.
 *
 * 81 provinces, each mapped to one of the 24 conquest regions.
 * SVG path data (d) is left empty — to be populated when the real province
 * geometry is sourced.
 *
 * Province IDs are ASCII-safe kebab identifiers derived from the Turkish name.
 * Plate codes follow the official Turkish license-plate numbering (01–81).
 */

import type { ConquestRegionId } from "../types";

export type ProvinceId = string;

export interface TurkeyProvince {
  id:               ProvinceId;
  name:             string;
  plateCode:        number;
  conquestRegionId: ConquestRegionId;
  d?:               string;
}

// ─── Province list (sorted by plate code) ────────────────────────────────────

export const TURKEY_PROVINCES: TurkeyProvince[] = [
  { id: "adana",           name: "Adana",           plateCode:  1, conquestRegionId: "cukurova",           d: "" },
  { id: "adiyaman",        name: "Adıyaman",         plateCode:  2, conquestRegionId: "firat_hatti",        d: "" },
  { id: "afyonkarahisar",  name: "Afyonkarahisar",   plateCode:  3, conquestRegionId: "ic_bati_anadolu",    d: "" },
  { id: "agri",            name: "Ağrı",             plateCode:  4, conquestRegionId: "kuzeydogu_anadolu",  d: "" },
  { id: "amasya",          name: "Amasya",           plateCode:  5, conquestRegionId: "orta_karadeniz",     d: "" },
  { id: "ankara",          name: "Ankara",           plateCode:  6, conquestRegionId: "ankara_cevre",       d: "" },
  { id: "antalya",         name: "Antalya",          plateCode:  7, conquestRegionId: "bati_akdeniz",       d: "" },
  { id: "artvin",          name: "Artvin",           plateCode:  8, conquestRegionId: "dogu_karadeniz",     d: "" },
  { id: "aydin",           name: "Aydın",            plateCode:  9, conquestRegionId: "guney_ege",          d: "" },
  { id: "balikesir",       name: "Balıkesir",        plateCode: 10, conquestRegionId: "guney_marmara",      d: "" },
  { id: "bilecik",         name: "Bilecik",          plateCode: 11, conquestRegionId: "guney_marmara",      d: "" },
  { id: "bingol",          name: "Bingöl",           plateCode: 12, conquestRegionId: "malatya_elazig",     d: "" },
  { id: "bitlis",          name: "Bitlis",           plateCode: 13, conquestRegionId: "van_hakkari",        d: "" },
  { id: "bolu",            name: "Bolu",             plateCode: 14, conquestRegionId: "bati_karadeniz",     d: "" },
  { id: "burdur",          name: "Burdur",           plateCode: 15, conquestRegionId: "bati_akdeniz",       d: "" },
  { id: "bursa",           name: "Bursa",            plateCode: 16, conquestRegionId: "guney_marmara",      d: "" },
  { id: "canakkale",       name: "Çanakkale",        plateCode: 17, conquestRegionId: "guney_marmara",      d: "" },
  { id: "cankiri",         name: "Çankırı",          plateCode: 18, conquestRegionId: "ankara_cevre",       d: "" },
  { id: "corum",           name: "Çorum",            plateCode: 19, conquestRegionId: "orta_karadeniz",     d: "" },
  { id: "denizli",         name: "Denizli",          plateCode: 20, conquestRegionId: "guney_ege",          d: "" },
  { id: "diyarbakir",      name: "Diyarbakır",       plateCode: 21, conquestRegionId: "dicle_hatti",        d: "" },
  { id: "edirne",          name: "Edirne",           plateCode: 22, conquestRegionId: "trakya",             d: "" },
  { id: "elazig",          name: "Elazığ",           plateCode: 23, conquestRegionId: "malatya_elazig",     d: "" },
  { id: "erzincan",        name: "Erzincan",         plateCode: 24, conquestRegionId: "kuzeydogu_anadolu",  d: "" },
  { id: "erzurum",         name: "Erzurum",          plateCode: 25, conquestRegionId: "erzurum_kars",       d: "" },
  { id: "eskisehir",       name: "Eskişehir",        plateCode: 26, conquestRegionId: "ic_bati_anadolu",    d: "" },
  { id: "gaziantep",       name: "Gaziantep",        plateCode: 27, conquestRegionId: "antep_kilis",        d: "" },
  { id: "giresun",         name: "Giresun",          plateCode: 28, conquestRegionId: "dogu_karadeniz",     d: "" },
  { id: "gumushane",       name: "Gümüşhane",        plateCode: 29, conquestRegionId: "dogu_karadeniz",     d: "" },
  { id: "hakkari",         name: "Hakkari",          plateCode: 30, conquestRegionId: "van_hakkari",        d: "" },
  { id: "hatay",           name: "Hatay",            plateCode: 31, conquestRegionId: "hatay_osmaniye",     d: "" },
  { id: "isparta",         name: "Isparta",          plateCode: 32, conquestRegionId: "bati_akdeniz",       d: "" },
  { id: "mersin",          name: "Mersin",           plateCode: 33, conquestRegionId: "cukurova",           d: "" },
  { id: "istanbul",        name: "İstanbul",         plateCode: 34, conquestRegionId: "istanbul_kocaeli",   d: "" },
  { id: "izmir",           name: "İzmir",            plateCode: 35, conquestRegionId: "kuzey_ege",          d: "" },
  { id: "kars",            name: "Kars",             plateCode: 36, conquestRegionId: "erzurum_kars",       d: "" },
  { id: "kastamonu",       name: "Kastamonu",        plateCode: 37, conquestRegionId: "bati_karadeniz",     d: "" },
  { id: "kayseri",         name: "Kayseri",          plateCode: 38, conquestRegionId: "kapadokya",          d: "" },
  { id: "kirklareli",      name: "Kırklareli",       plateCode: 39, conquestRegionId: "trakya",             d: "" },
  { id: "kirsehir",        name: "Kırşehir",         plateCode: 40, conquestRegionId: "orta_anadolu",       d: "" },
  { id: "kocaeli",         name: "Kocaeli",          plateCode: 41, conquestRegionId: "istanbul_kocaeli",   d: "" },
  { id: "konya",           name: "Konya",            plateCode: 42, conquestRegionId: "konya_karaman",      d: "" },
  { id: "kutahya",         name: "Kütahya",          plateCode: 43, conquestRegionId: "ic_bati_anadolu",    d: "" },
  { id: "malatya",         name: "Malatya",          plateCode: 44, conquestRegionId: "malatya_elazig",     d: "" },
  { id: "manisa",          name: "Manisa",           plateCode: 45, conquestRegionId: "kuzey_ege",          d: "" },
  { id: "kahramanmaras",   name: "Kahramanmaraş",    plateCode: 46, conquestRegionId: "firat_hatti",        d: "" },
  { id: "mardin",          name: "Mardin",           plateCode: 47, conquestRegionId: "mardin_sirnak",      d: "" },
  { id: "mugla",           name: "Muğla",            plateCode: 48, conquestRegionId: "guney_ege",          d: "" },
  { id: "mus",             name: "Muş",              plateCode: 49, conquestRegionId: "van_hakkari",        d: "" },
  { id: "nevsehir",        name: "Nevşehir",         plateCode: 50, conquestRegionId: "kapadokya",          d: "" },
  { id: "nigde",           name: "Niğde",            plateCode: 51, conquestRegionId: "kapadokya",          d: "" },
  { id: "ordu",            name: "Ordu",             plateCode: 52, conquestRegionId: "dogu_karadeniz",     d: "" },
  { id: "rize",            name: "Rize",             plateCode: 53, conquestRegionId: "dogu_karadeniz",     d: "" },
  { id: "sakarya",         name: "Sakarya",          plateCode: 54, conquestRegionId: "istanbul_kocaeli",   d: "" },
  { id: "samsun",          name: "Samsun",           plateCode: 55, conquestRegionId: "orta_karadeniz",     d: "" },
  { id: "siirt",           name: "Siirt",            plateCode: 56, conquestRegionId: "dicle_hatti",        d: "" },
  { id: "sinop",           name: "Sinop",            plateCode: 57, conquestRegionId: "bati_karadeniz",     d: "" },
  { id: "sivas",           name: "Sivas",            plateCode: 58, conquestRegionId: "orta_anadolu",       d: "" },
  { id: "tekirdag",        name: "Tekirdağ",         plateCode: 59, conquestRegionId: "trakya",             d: "" },
  { id: "tokat",           name: "Tokat",            plateCode: 60, conquestRegionId: "orta_karadeniz",     d: "" },
  { id: "trabzon",         name: "Trabzon",          plateCode: 61, conquestRegionId: "dogu_karadeniz",     d: "" },
  { id: "tunceli",         name: "Tunceli",          plateCode: 62, conquestRegionId: "malatya_elazig",     d: "" },
  { id: "sanliurfa",       name: "Şanlıurfa",        plateCode: 63, conquestRegionId: "firat_hatti",        d: "" },
  { id: "usak",            name: "Uşak",             plateCode: 64, conquestRegionId: "kuzey_ege",          d: "" },
  { id: "van",             name: "Van",              plateCode: 65, conquestRegionId: "van_hakkari",        d: "" },
  { id: "yozgat",          name: "Yozgat",           plateCode: 66, conquestRegionId: "orta_anadolu",       d: "" },
  { id: "zonguldak",       name: "Zonguldak",        plateCode: 67, conquestRegionId: "bati_karadeniz",     d: "" },
  { id: "aksaray",         name: "Aksaray",          plateCode: 68, conquestRegionId: "kapadokya",          d: "" },
  { id: "bayburt",         name: "Bayburt",          plateCode: 69, conquestRegionId: "dogu_karadeniz",     d: "" },
  { id: "karaman",         name: "Karaman",          plateCode: 70, conquestRegionId: "konya_karaman",      d: "" },
  { id: "kirikkale",       name: "Kırıkkale",        plateCode: 71, conquestRegionId: "ankara_cevre",       d: "" },
  { id: "batman",          name: "Batman",           plateCode: 72, conquestRegionId: "dicle_hatti",        d: "" },
  { id: "sirnak",          name: "Şırnak",           plateCode: 73, conquestRegionId: "mardin_sirnak",      d: "" },
  { id: "bartin",          name: "Bartın",           plateCode: 74, conquestRegionId: "bati_karadeniz",     d: "" },
  { id: "ardahan",         name: "Ardahan",          plateCode: 75, conquestRegionId: "erzurum_kars",       d: "" },
  { id: "igdir",           name: "Iğdır",            plateCode: 76, conquestRegionId: "erzurum_kars",       d: "" },
  { id: "yalova",          name: "Yalova",           plateCode: 77, conquestRegionId: "istanbul_kocaeli",   d: "" },
  { id: "karabuk",         name: "Karabük",          plateCode: 78, conquestRegionId: "bati_karadeniz",     d: "" },
  { id: "kilis",           name: "Kilis",            plateCode: 79, conquestRegionId: "antep_kilis",        d: "" },
  { id: "osmaniye",        name: "Osmaniye",         plateCode: 80, conquestRegionId: "hatay_osmaniye",     d: "" },
  { id: "duzce",           name: "Düzce",            plateCode: 81, conquestRegionId: "bati_karadeniz",     d: "" },
];

// ─── Province → region lookup ─────────────────────────────────────────────────

export const PROVINCE_TO_REGION: Record<ProvinceId, ConquestRegionId> =
  Object.fromEntries(TURKEY_PROVINCES.map(p => [p.id, p.conquestRegionId]));

// ─── Validation constants ─────────────────────────────────────────────────────

/** Total number of Turkish provinces. Used in tests / build-time assertions. */
export const TURKEY_PROVINCE_COUNT = TURKEY_PROVINCES.length as 81;

/**
 * All 24 conquest region IDs that appear in TURKEY_PROVINCES.
 * Derived at module initialisation — useful for verifying full coverage.
 */
export const TURKEY_COVERED_REGIONS: ReadonlySet<ConquestRegionId> = new Set(
  TURKEY_PROVINCES.map(p => p.conquestRegionId),
);
