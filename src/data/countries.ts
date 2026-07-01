/**
 * countries.ts — world-atlas@2 ground truth + 195-country dataset
 *
 * CountryEntry now includes:
 *   code    — ISO 3166-1 alpha-2 (used for flag SVG paths: /assets/flags/{code}.svg)
 *   topoId  — zero-padded ISO numeric matching world-atlas feature.id
 *   display — canonical Turkish name shown on map/UI
 *   names   — all accepted aliases (Turkish + English + alternates)
 *   continent
 *   counted    — false = bonus entry, not counted toward 195 total
 *   difficulty — "easy" | "normal" | "hard" (used by Flag Mode filter)
 */

// Auto-generated multilingual aliases (Intl.DisplayNames, build-time only).
// Regenerate with: node scripts/build-country-locale-aliases.mjs
import { COUNTRY_LOCALE_ALIASES } from "./countryLocaleAliases.generated";

export type Continent =
  | "europe"
  | "asia"
  | "africa"
  | "north-america"
  | "south-america"
  | "oceania";

export interface CountryEntry {
  code:      string;   // ISO 3166-1 alpha-2 (lowercase) — flag SVG key
  topoId:    string;   // zero-padded 3-digit ISO numeric (world-atlas feature.id)
  display:   string;   // canonical Turkish display name
  names:     string[]; // accepted aliases (raw, normalised at build time)
  continent: Continent;
  counted:    boolean;  // false = bonus (Greenland etc.) — not in 195 total
  difficulty: "easy" | "normal" | "hard";
}

/* ─────────────────────────────────────────────────
   NORMALIZER
───────────────────────────────────────────────── */
/**
 * Central, script-aware country answer canonicaliser.
 *
 * Goal: a player who types a country name in their own language *and* writing
 * system resolves to the same canonical country. Latin, Cyrillic, Arabic,
 * Chinese (Hans/Hant), Japanese, Korean and Devanagari are all preserved in
 * their own script \u2014 we never romanise them and never fuzzy-match.
 *
 * Rules:
 *   1) Unicode NFKC (folds full-width / compatibility / ligature forms, e.g.
 *      Japanese full-width Latin \u2192 ASCII). This is the form the spec asks for.
 *   2) Arabic tidy-up (script preserved, only ambiguity removed):
 *        \u2022 strip tatweel (\u0640) + harakat (\u064b\u2013\u065f, \u0670)
 *        \u2022 fold alef variants \u0622\u0623\u0625\u0671 \u2192 \u0627, alef maqsura \u0649 \u2192 ya \u064a
 *   3) Lowercase (no-op for scripts without case).
 *   4) Map Latin letters with no canonical decomposition (\u0131 especially) plus
 *      Turkish/German safety nets in case NFD is bypassed.
 *   5) NFD + strip combining marks \u2192 tolerates Latin accent differences
 *      (Devanagari matras / Arabic marks are handled above/kept below).
 *   6) Apostrophes / dashes / dots / slashes become word breaks \u2192 spaces.
 *      Lets "Cote d'Ivoire", "Bosnia-Herzegovina", "Washington D.C." match.
 *   7) Strip noise (emoji, symbols, regional indicators, stray punctuation) but
 *      KEEP letters of every script, digits and combining marks (\p{L}\p{N}\p{M}).
 *   8) Collapse whitespace runs, trim.
 *
 * Idempotent \u2014 deterministic and safe on already-normalised text.
 */
export function normalizeCountryAnswer(raw: string): string {
  if (!raw) return "";
  let s = String(raw);
  s = s.normalize("NFKC");
  // Arabic: drop tatweel + harakat, then fold safe alef / ya variants.
  s = s.replace(/[\u0640\u064b-\u065f\u0670]/g, "");
  s = s.replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627"); // \u0622\u0623\u0625\u0671 \u2192 \u0627
  s = s.replace(/\u0649/g, "\u064a");                     // \u0649 (alef maqsura) \u2192 \u064a
  s = s.toLowerCase();
  s = s
    .replace(/\u0131/g, "i")   // \u0131 (dotless small i)
    .replace(/\u0130/g, "i")   // \u0130 \u2014 covered by NFD but kept as safety net
    .replace(/\u015f/g, "s")   // \u015f
    .replace(/\u011f/g, "g")   // \u011f
    .replace(/\xfc/g,   "u")   // \u00fc
    .replace(/\xf6/g,   "o")   // \u00f6
    .replace(/\xe7/g,   "c")   // \u00e7
    .replace(/\xe2/g,   "a")   // \u00e2
    .replace(/\xee/g,   "i")   // \u00ee
    .replace(/\xfb/g,   "u")   // \u00fb
    .replace(/\xdf/g,   "ss"); // \u00df \u2192 ss
  s = s.normalize("NFD");
  s = s.replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/['\u2018\u2019\u02bc\u2032`\xb4.,;:!?&]/g, " ");
  s = s.replace(/[-\u2013\u2014_/\\]/g, " ");
  // Keep letters of any script + digits + combining marks (Devanagari matras,
  // nukta); drop everything else (emoji, symbols, leftover punctuation).
  s = s.replace(/[^\p{L}\p{N}\p{M} ]/gu, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Back-compat alias \u2014 historic name used across the codebase. */
export const normalizeInput = normalizeCountryAnswer;

/* ─────────────────────────────────────────────────
   COUNTRY LIST  (195 counted + bonus)
───────────────────────────────────────────────── */
export const COUNTRIES: CountryEntry[] = [

  // ══════════════ EUROPE — 45 (44 UN + Vatican) ══════════════
  { code:"al", topoId:"008", display:"Arnavutluk",       counted:true,  difficulty:"easy",  continent:"europe", names:["arnavutluk","albania"] },
  { code:"ad", topoId:"020", display:"Andorra",           counted:true,  difficulty:"hard",  continent:"europe", names:["andorra"] },
  { code:"at", topoId:"040", display:"Avusturya",         counted:true,  difficulty:"easy",  continent:"europe", names:["avusturya","austria"] },
  { code:"by", topoId:"112", display:"Belarus",           counted:true,  difficulty:"easy",  continent:"europe", names:["belarus","beyaz rusya"] },
  { code:"be", topoId:"056", display:"Belçika",           counted:true,  difficulty:"easy",  continent:"europe", names:["belcika","belgium"] },
  { code:"ba", topoId:"070", display:"Bosna Hersek",      counted:true,  difficulty:"easy",  continent:"europe", names:["bosna hersek","bosna-hersek","bosna","bosnia","bosnia and herzegovina","bosnia and herzegov"] },
  { code:"bg", topoId:"100", display:"Bulgaristan",       counted:true,  difficulty:"easy",  continent:"europe", names:["bulgaristan","bulgaria"] },
  { code:"hr", topoId:"191", display:"Hırvatistan",       counted:true,  difficulty:"easy",  continent:"europe", names:["hirvatistan","croatia"] },
  { code:"cy", topoId:"196", display:"Kıbrıs",            counted:true,  difficulty:"easy",  continent:"europe", names:["kibris","cyprus","republic of cyprus"] },
  { code:"cz", topoId:"203", display:"Çekya",             counted:true,  difficulty:"easy",  continent:"europe", names:["cekya","czechia","czech republic","cek cumhuriyeti"] },
  { code:"dk", topoId:"208", display:"Danimarka",         counted:true,  difficulty:"easy",  continent:"europe", names:["danimarka","denmark"] },
  { code:"ee", topoId:"233", display:"Estonya",           counted:true,  difficulty:"normal",  continent:"europe", names:["estonya","estonia"] },
  { code:"fi", topoId:"246", display:"Finlandiya",        counted:true,  difficulty:"easy",  continent:"europe", names:["finlandiya","finland"] },
  { code:"fr", topoId:"250", display:"Fransa",            counted:true,  difficulty:"easy",  continent:"europe", names:["fransa","france"] },
  { code:"de", topoId:"276", display:"Almanya",           counted:true,  difficulty:"easy",  continent:"europe", names:["almanya","germany"] },
  { code:"gr", topoId:"300", display:"Yunanistan",        counted:true,  difficulty:"easy",  continent:"europe", names:["yunanistan","greece"] },
  { code:"hu", topoId:"348", display:"Macaristan",        counted:true,  difficulty:"easy",  continent:"europe", names:["macaristan","hungary"] },
  { code:"is", topoId:"352", display:"İzlanda",           counted:true,  difficulty:"easy",  continent:"europe", names:["izlanda","iceland"] },
  { code:"ie", topoId:"372", display:"İrlanda",           counted:true,  difficulty:"easy",  continent:"europe", names:["irlanda","ireland"] },
  { code:"it", topoId:"380", display:"İtalya",            counted:true,  difficulty:"easy",  continent:"europe", names:["italya","italy"] },
  { code:"lv", topoId:"428", display:"Letonya",           counted:true,  difficulty:"easy",  continent:"europe", names:["letonya","latvia"] },
  { code:"li", topoId:"438", display:"Lihtenştayn",       counted:true,  difficulty:"hard",  continent:"europe", names:["lihtenstayn","liechtenstein"] },
  { code:"lt", topoId:"440", display:"Litvanya",          counted:true,  difficulty:"easy",  continent:"europe", names:["litvanya","lithuania"] },
  { code:"lu", topoId:"442", display:"Lüksemburg",        counted:true,  difficulty:"easy",  continent:"europe", names:["luksemburg","luxembourg"] },
  { code:"mt", topoId:"470", display:"Malta",             counted:true,  difficulty:"hard",  continent:"europe", names:["malta"] },
  { code:"md", topoId:"498", display:"Moldova",           counted:true,  difficulty:"normal",  continent:"europe", names:["moldova"] },
  { code:"mc", topoId:"492", display:"Monako",            counted:true,  difficulty:"hard",  continent:"europe", names:["monako","monaco"] },
  { code:"me", topoId:"499", display:"Karadağ",           counted:true,  difficulty:"normal",  continent:"europe", names:["karadag","montenegro"] },
  { code:"nl", topoId:"528", display:"Hollanda",          counted:true,  difficulty:"easy",  continent:"europe", names:["hollanda","netherlands","holland"] },
  { code:"mk", topoId:"807", display:"Kuzey Makedonya",   counted:true,  difficulty:"easy",  continent:"europe", names:["kuzey makedonya","north macedonia","makedonya","macedonia"] },
  { code:"no", topoId:"578", display:"Norveç",            counted:true,  difficulty:"easy",  continent:"europe", names:["norvec","norway"] },
  { code:"pl", topoId:"616", display:"Polonya",           counted:true,  difficulty:"easy",  continent:"europe", names:["polonya","poland"] },
  { code:"pt", topoId:"620", display:"Portekiz",          counted:true,  difficulty:"easy",  continent:"europe", names:["portekiz","portugal"] },
  { code:"ro", topoId:"642", display:"Romanya",           counted:true,  difficulty:"easy",  continent:"europe", names:["romanya","romania"] },
  { code:"ru", topoId:"643", display:"Rusya",             counted:true,  difficulty:"easy",  continent:"europe", names:["rusya","russia","russian federation"] },
  { code:"sm", topoId:"674", display:"San Marino",        counted:true,  difficulty:"hard",  continent:"europe", names:["san marino"] },
  { code:"rs", topoId:"688", display:"Sırbistan",         counted:true,  difficulty:"easy",  continent:"europe", names:["sirbistan","serbia"] },
  { code:"sk", topoId:"703", display:"Slovakya",          counted:true,  difficulty:"easy",  continent:"europe", names:["slovakya","slovakia"] },
  { code:"si", topoId:"705", display:"Slovenya",          counted:true,  difficulty:"easy",  continent:"europe", names:["slovenya","slovenia"] },
  { code:"es", topoId:"724", display:"İspanya",           counted:true,  difficulty:"easy",  continent:"europe", names:["ispanya","spain"] },
  { code:"se", topoId:"752", display:"İsveç",             counted:true,  difficulty:"easy",  continent:"europe", names:["isvec","sweden"] },
  { code:"ch", topoId:"756", display:"İsviçre",           counted:true,  difficulty:"easy",  continent:"europe", names:["isvicre","switzerland"] },
  { code:"ua", topoId:"804", display:"Ukrayna",           counted:true,  difficulty:"easy",  continent:"europe", names:["ukrayna","ukraine"] },
  { code:"gb", topoId:"826", display:"Birleşik Krallık",  counted:true,  difficulty:"easy",  continent:"europe", names:["birlesik krallik","united kingdom","uk","ingiltere","england","great britain","britain"] },
  { code:"va", topoId:"336", display:"Vatikan",           counted:true,  difficulty:"hard",  continent:"europe", names:["vatikan","vatican","holy see","vatikan sehri","vatican city"] },
  { code:"xk", topoId:"XK",  display:"Kosova",           counted:true,  difficulty:"hard",  continent:"europe", names:["kosova","kosovo","kosova cumhuriyeti","kosova cumh","republic of kosovo"] },

  // ══════════════ ASIA — 47 (Türkiye dahil, Tayvan uncounted) ══════════════
  { code:"af", topoId:"004", display:"Afganistan",                counted:true,  difficulty:"easy",  continent:"asia", names:["afganistan","afghanistan"] },
  { code:"am", topoId:"051", display:"Ermenistan",                counted:true,  difficulty:"easy",  continent:"asia", names:["ermenistan","armenia"] },
  { code:"az", topoId:"031", display:"Azerbaycan",                counted:true,  difficulty:"easy",  continent:"asia", names:["azerbaycan","azerbaijan"] },
  { code:"bh", topoId:"048", display:"Bahreyn",                   counted:true,  difficulty:"hard",  continent:"asia", names:["bahreyn","bahrain"] },
  { code:"bd", topoId:"050", display:"Bangladeş",                 counted:true,  difficulty:"easy",  continent:"asia", names:["banglades","bangladesh"] },
  { code:"bt", topoId:"064", display:"Butan",                     counted:true,  difficulty:"hard",  continent:"asia", names:["butan","bhutan"] },
  { code:"bn", topoId:"096", display:"Brunei",                    counted:true,  difficulty:"hard",  continent:"asia", names:["brunei"] },
  { code:"kh", topoId:"116", display:"Kamboçya",                  counted:true,  difficulty:"normal",  continent:"asia", names:["kambocya","cambodia"] },
  { code:"cn", topoId:"156", display:"Çin",                       counted:true,  difficulty:"easy",  continent:"asia", names:["cin","china"] },
  { code:"ge", topoId:"268", display:"Gürcistan",                 counted:true,  difficulty:"normal",  continent:"asia", names:["gurcistan","georgia"] },
  { code:"in", topoId:"356", display:"Hindistan",                 counted:true,  difficulty:"easy",  continent:"asia", names:["hindistan","india"] },
  { code:"id", topoId:"360", display:"Endonezya",                 counted:true,  difficulty:"easy",  continent:"asia", names:["endonezya","indonesia"] },
  { code:"ir", topoId:"364", display:"İran",                      counted:true,  difficulty:"easy",  continent:"asia", names:["iran"] },
  { code:"iq", topoId:"368", display:"Irak",                      counted:true,  difficulty:"easy",  continent:"asia", names:["irak","iraq"] },
  { code:"il", topoId:"376", display:"İsrail",                    counted:true,  difficulty:"easy",  continent:"asia", names:["israil","israel"] },
  { code:"jp", topoId:"392", display:"Japonya",                   counted:true,  difficulty:"easy",  continent:"asia", names:["japonya","japan"] },
  { code:"jo", topoId:"400", display:"Ürdün",                     counted:true,  difficulty:"normal",  continent:"asia", names:["urdun","jordan"] },
  { code:"kz", topoId:"398", display:"Kazakistan",                counted:true,  difficulty:"easy",  continent:"asia", names:["kazakistan","kazakhstan"] },
  { code:"kw", topoId:"414", display:"Kuveyt",                    counted:true,  difficulty:"easy",  continent:"asia", names:["kuveyt","kuwait"] },
  { code:"kg", topoId:"417", display:"Kırgızistan",               counted:true,  difficulty:"normal",  continent:"asia", names:["kirgizistan","kyrgyzstan"] },
  { code:"la", topoId:"418", display:"Laos",                      counted:true,  difficulty:"normal",  continent:"asia", names:["laos"] },
  { code:"lb", topoId:"422", display:"Lübnan",                    counted:true,  difficulty:"easy",  continent:"asia", names:["lubnan","lebanon"] },
  { code:"my", topoId:"458", display:"Malezya",                   counted:true,  difficulty:"easy",  continent:"asia", names:["malezya","malaysia"] },
  { code:"mv", topoId:"462", display:"Maldivler",                 counted:true,  difficulty:"hard",  continent:"asia", names:["maldivler","maldives"] },
  { code:"mn", topoId:"496", display:"Moğolistan",                counted:true,  difficulty:"easy",  continent:"asia", names:["mogolistan","mongolia"] },
  { code:"mm", topoId:"104", display:"Myanmar",                   counted:true,  difficulty:"easy",  continent:"asia", names:["myanmar","burma"] },
  { code:"np", topoId:"524", display:"Nepal",                     counted:true,  difficulty:"easy",  continent:"asia", names:["nepal"] },
  { code:"kp", topoId:"408", display:"Kuzey Kore",                counted:true,  difficulty:"easy",  continent:"asia", names:["kuzey kore","north korea","kore demokratik halk cumhuriyeti"] },
  { code:"om", topoId:"512", display:"Umman",                     counted:true,  difficulty:"normal",  continent:"asia", names:["umman","oman"] },
  { code:"pk", topoId:"586", display:"Pakistan",                  counted:true,  difficulty:"easy",  continent:"asia", names:["pakistan"] },
  { code:"ps", topoId:"275", display:"Filistin",                  counted:true,  difficulty:"normal",  continent:"asia", names:["filistin","palestine","state of palestine"] },
  { code:"ph", topoId:"608", display:"Filipinler",                counted:true,  difficulty:"easy",  continent:"asia", names:["filipinler","philippines"] },
  { code:"qa", topoId:"634", display:"Katar",                     counted:true,  difficulty:"normal",  continent:"asia", names:["katar","qatar"] },
  { code:"sa", topoId:"682", display:"Suudi Arabistan",           counted:true,  difficulty:"easy",  continent:"asia", names:["suudi arabistan","saudi arabia"] },
  { code:"sg", topoId:"702", display:"Singapur",                  counted:true,  difficulty:"easy",  continent:"asia", names:["singapur","singapore"] },
  { code:"kr", topoId:"410", display:"Güney Kore",                counted:true,  difficulty:"easy",  continent:"asia", names:["guney kore","south korea","korea","kore"] },
  { code:"lk", topoId:"144", display:"Sri Lanka",                 counted:true,  difficulty:"easy",  continent:"asia", names:["sri lanka","seylan","ceylon"] },
  { code:"sy", topoId:"760", display:"Suriye",                    counted:true,  difficulty:"easy",  continent:"asia", names:["suriye","syria"] },
  { code:"tj", topoId:"762", display:"Tacikistan",                counted:true,  difficulty:"normal",  continent:"asia", names:["tacikistan","tajikistan"] },
  { code:"th", topoId:"764", display:"Tayland",                   counted:true,  difficulty:"easy",  continent:"asia", names:["tayland","thailand"] },
  { code:"tl", topoId:"626", display:"Doğu Timor",                counted:true,  difficulty:"hard",  continent:"asia", names:["dogu timor","east timor","timor leste","timor-leste"] },
  { code:"tr", topoId:"792", display:"Türkiye",                   counted:true,  difficulty:"easy",  continent:"asia", names:["turkiye","turkey","turk","turkiye cumhuriyeti"] },
  { code:"tm", topoId:"795", display:"Türkmenistan",              counted:true,  difficulty:"normal",  continent:"asia", names:["turkmenistan"] },
  { code:"ae", topoId:"784", display:"BAE",                       counted:true,  difficulty:"easy",  continent:"asia", names:["birlesik arap emirlikleri","bae","united arab emirates","uae"] },
  { code:"uz", topoId:"860", display:"Özbekistan",                counted:true,  difficulty:"normal",  continent:"asia", names:["ozbekistan","uzbekistan"] },
  { code:"vn", topoId:"704", display:"Vietnam",                   counted:true,  difficulty:"easy",  continent:"asia", names:["vietnam"] },
  { code:"ye", topoId:"887", display:"Yemen",                     counted:true,  difficulty:"easy",  continent:"asia", names:["yemen"] },
  // Taiwan — bonus (not UN member)
  { code:"tw", topoId:"158", display:"Tayvan",                    counted:false, difficulty:"normal",  continent:"asia", names:["tayvan","taiwan"] },

  // ══════════════ AFRICA — 54 ══════════════
  { code:"dz", topoId:"012", display:"Cezayir",                   counted:true,  difficulty:"easy",  continent:"africa", names:["cezayir","algeria"] },
  { code:"ao", topoId:"024", display:"Angola",                    counted:true,  difficulty:"easy",  continent:"africa", names:["angola"] },
  { code:"bj", topoId:"204", display:"Benin",                     counted:true,  difficulty:"hard",  continent:"africa", names:["benin"] },
  { code:"bw", topoId:"072", display:"Botsvana",                  counted:true,  difficulty:"normal",  continent:"africa", names:["botsvana","botswana"] },
  { code:"bf", topoId:"854", display:"Burkina Faso",              counted:true,  difficulty:"hard",  continent:"africa", names:["burkina faso"] },
  { code:"bi", topoId:"108", display:"Burundi",                   counted:true,  difficulty:"hard",  continent:"africa", names:["burundi"] },
  { code:"cv", topoId:"132", display:"Cabo Verde",                counted:true,  difficulty:"hard",  continent:"africa", names:["cabo verde","yesil burun adalari","cape verde","cap vert"] },
  { code:"cm", topoId:"120", display:"Kamerun",                   counted:true,  difficulty:"easy",  continent:"africa", names:["kamerun","cameroon"] },
  { code:"cf", topoId:"140", display:"Orta Afrika Cumhuriyeti",   counted:true,  difficulty:"normal",  continent:"africa", names:["orta afrika cumhuriyeti","central african rep","central african republic","car"] },
  { code:"td", topoId:"148", display:"Çad",                       counted:true,  difficulty:"easy",  continent:"africa", names:["cad","chad"] },
  { code:"km", topoId:"174", display:"Komorlar",                  counted:true,  difficulty:"hard",  continent:"africa", names:["komorlar","comoros","comores"] },
  { code:"cg", topoId:"178", display:"Kongo Cumhuriyeti",         counted:true,  difficulty:"normal",  continent:"africa", names:["kongo cumhuriyeti","kongo","congo","republic of the congo","congo republic"] },
  { code:"cd", topoId:"180", display:"Kongo DR",                  counted:true,  difficulty:"easy",  continent:"africa", names:["kongo dr","demokratik kongo cumhuriyeti","demokratik kongo","kongo demokratik cumhuriyeti","kongo dc","kongo d c","dkc","dr kongo","demokratik kongo cumh","kongo kinsasa","kongo kinshasa","dr congo","dem rep congo","democratic republic of the congo","drc"] },
  { code:"ci", topoId:"384", display:"Fildişi Sahili",            counted:true,  difficulty:"easy",  continent:"africa", names:["fildisi sahili","ivory coast","cote d ivoire","cote divoire","cote d'ivoire"] },
  { code:"dj", topoId:"262", display:"Cibuti",                    counted:true,  difficulty:"hard",  continent:"africa", names:["cibuti","djibouti"] },
  { code:"eg", topoId:"818", display:"Mısır",                     counted:true,  difficulty:"easy",  continent:"africa", names:["misir","egypt"] },
  { code:"gq", topoId:"226", display:"Ekvator Ginesi",            counted:true,  difficulty:"hard",  continent:"africa", names:["ekvator ginesi","equatorial guinea","guinea ecuatorial"] },
  { code:"er", topoId:"232", display:"Eritre",                    counted:true,  difficulty:"hard",  continent:"africa", names:["eritre","eritrea"] },
  { code:"et", topoId:"231", display:"Etiyopya",                  counted:true,  difficulty:"easy",  continent:"africa", names:["etiyopya","ethiopia"] },
  { code:"ga", topoId:"266", display:"Gabon",                     counted:true,  difficulty:"hard",  continent:"africa", names:["gabon"] },
  { code:"gm", topoId:"270", display:"Gambiya",                   counted:true,  difficulty:"hard",  continent:"africa", names:["gambiya","gambia","the gambia"] },
  { code:"gh", topoId:"288", display:"Gana",                      counted:true,  difficulty:"easy",  continent:"africa", names:["gana","ghana"] },
  { code:"gn", topoId:"324", display:"Gine",                      counted:true,  difficulty:"hard",  continent:"africa", names:["gine","guinea"] },
  { code:"gw", topoId:"624", display:"Gine-Bissau",               counted:true,  difficulty:"hard",  continent:"africa", names:["gine bissau","guinea-bissau","guinea bissau"] },
  { code:"ke", topoId:"404", display:"Kenya",                     counted:true,  difficulty:"easy",  continent:"africa", names:["kenya"] },
  { code:"ls", topoId:"426", display:"Lesoto",                    counted:true,  difficulty:"hard",  continent:"africa", names:["lesoto","lesotho"] },
  { code:"lr", topoId:"430", display:"Liberya",                   counted:true,  difficulty:"hard",  continent:"africa", names:["liberya","liberia"] },
  { code:"ly", topoId:"434", display:"Libya",                     counted:true,  difficulty:"easy",  continent:"africa", names:["libya"] },
  { code:"mg", topoId:"450", display:"Madagaskar",                counted:true,  difficulty:"easy",  continent:"africa", names:["madagaskar","madagascar"] },
  { code:"mw", topoId:"454", display:"Malavi",                    counted:true,  difficulty:"normal",  continent:"africa", names:["malavi","malawi"] },
  { code:"ml", topoId:"466", display:"Mali",                      counted:true,  difficulty:"easy",  continent:"africa", names:["mali"] },
  { code:"mr", topoId:"478", display:"Moritanya",                 counted:true,  difficulty:"hard",  continent:"africa", names:["moritanya","mauritania"] },
  { code:"mu", topoId:"480", display:"Mauritius",                 counted:true,  difficulty:"hard",  continent:"africa", names:["morityus","mauritius"] },
  { code:"ma", topoId:"504", display:"Fas",                       counted:true,  difficulty:"easy",  continent:"africa", names:["fas","morocco","maroc","bati sahra","western sahara","sadr"] },
  { code:"mz", topoId:"508", display:"Mozambik",                  counted:true,  difficulty:"easy",  continent:"africa", names:["mozambik","mozambique"] },
  { code:"na", topoId:"516", display:"Namibya",                   counted:true,  difficulty:"easy",  continent:"africa", names:["namibya","namibia"] },
  { code:"ne", topoId:"562", display:"Nijer",                     counted:true,  difficulty:"hard",  continent:"africa", names:["nijer","niger"] },
  { code:"ng", topoId:"566", display:"Nijerya",                   counted:true,  difficulty:"easy",  continent:"africa", names:["nijerya","nigeria"] },
  { code:"rw", topoId:"646", display:"Ruanda",                    counted:true,  difficulty:"easy",  continent:"africa", names:["ruanda","rwanda"] },
  { code:"st", topoId:"678", display:"Sao Tome ve Principe",      counted:true,  difficulty:"hard",  continent:"africa", names:["sao tome ve principe","sao tome","sao tome and principe","sao tome & principe"] },
  { code:"sn", topoId:"686", display:"Senegal",                   counted:true,  difficulty:"easy",  continent:"africa", names:["senegal"] },
  { code:"sc", topoId:"690", display:"Seyşeller",                 counted:true,  difficulty:"hard",  continent:"africa", names:["seyseller","seychelles"] },
  { code:"sl", topoId:"694", display:"Sierra Leone",              counted:true,  difficulty:"hard",  continent:"africa", names:["sierra leone"] },
  { code:"so", topoId:"706", display:"Somali",                    counted:true,  difficulty:"easy",  continent:"africa", names:["somali","somalia","somaliland"] },
  { code:"za", topoId:"710", display:"Güney Afrika",              counted:true,  difficulty:"easy",  continent:"africa", names:["guney afrika","south africa"] },
  { code:"ss", topoId:"728", display:"Güney Sudan",               counted:true,  difficulty:"easy",  continent:"africa", names:["guney sudan","south sudan","s sudan"] },
  { code:"sd", topoId:"729", display:"Sudan",                     counted:true,  difficulty:"easy",  continent:"africa", names:["sudan"] },
  { code:"sz", topoId:"748", display:"Esvatini",                  counted:true,  difficulty:"hard",  continent:"africa", names:["esvatini","eswatini","swaziland"] },
  { code:"tz", topoId:"834", display:"Tanzanya",                  counted:true,  difficulty:"easy",  continent:"africa", names:["tanzanya","tanzania"] },
  { code:"tg", topoId:"768", display:"Togo",                      counted:true,  difficulty:"hard",  continent:"africa", names:["togo"] },
  { code:"tn", topoId:"788", display:"Tunus",                     counted:true,  difficulty:"easy",  continent:"africa", names:["tunus","tunisia"] },
  { code:"ug", topoId:"800", display:"Uganda",                    counted:true,  difficulty:"easy",  continent:"africa", names:["uganda"] },
  { code:"zm", topoId:"894", display:"Zambiya",                   counted:true,  difficulty:"easy",  continent:"africa", names:["zambiya","zambia"] },
  { code:"zw", topoId:"716", display:"Zimbabve",                  counted:true,  difficulty:"easy",  continent:"africa", names:["zimbabve","zimbabwe"] },

  // ══════════════ NORTH AMERICA — 23 ══════════════
  { code:"ag", topoId:"028", display:"Antigua ve Barbuda",        counted:true,  difficulty:"hard",  continent:"north-america", names:["antigua ve barbuda","antigua and barbuda","antigua"] },
  { code:"bs", topoId:"044", display:"Bahamalar",                 counted:true,  difficulty:"normal",  continent:"north-america", names:["bahamalar","bahamas","the bahamas"] },
  { code:"bb", topoId:"052", display:"Barbados",                  counted:true,  difficulty:"hard",  continent:"north-america", names:["barbados"] },
  { code:"bz", topoId:"084", display:"Belize",                    counted:true,  difficulty:"hard",  continent:"north-america", names:["belize"] },
  { code:"ca", topoId:"124", display:"Kanada",                    counted:true,  difficulty:"easy",  continent:"north-america", names:["kanada","canada"] },
  { code:"cr", topoId:"188", display:"Kosta Rika",                counted:true,  difficulty:"normal",  continent:"north-america", names:["kosta rika","costa rica"] },
  { code:"cu", topoId:"192", display:"Küba",                      counted:true,  difficulty:"easy",  continent:"north-america", names:["kuba","cuba"] },
  { code:"dm", topoId:"212", display:"Dominika",                  counted:true,  difficulty:"hard",  continent:"north-america", names:["dominika","dominica"] },
  { code:"do", topoId:"214", display:"Dominik Cumhuriyeti",       counted:true,  difficulty:"easy",  continent:"north-america", names:["dominik cumhuriyeti","dominican rep","dominican republic"] },
  { code:"sv", topoId:"222", display:"El Salvador",               counted:true,  difficulty:"normal",  continent:"north-america", names:["el salvador"] },
  { code:"gd", topoId:"308", display:"Grenada",                   counted:true,  difficulty:"hard",  continent:"north-america", names:["grenada"] },
  { code:"gt", topoId:"320", display:"Guatemala",                 counted:true,  difficulty:"easy",  continent:"north-america", names:["guatemala"] },
  { code:"ht", topoId:"332", display:"Haiti",                     counted:true,  difficulty:"easy",  continent:"north-america", names:["haiti"] },
  { code:"hn", topoId:"340", display:"Honduras",                  counted:true,  difficulty:"easy",  continent:"north-america", names:["honduras"] },
  { code:"jm", topoId:"388", display:"Jamaika",                   counted:true,  difficulty:"normal",  continent:"north-america", names:["jamaika","jamaica"] },
  { code:"mx", topoId:"484", display:"Meksika",                   counted:true,  difficulty:"easy",  continent:"north-america", names:["meksika","mexico"] },
  { code:"ni", topoId:"558", display:"Nikaragua",                 counted:true,  difficulty:"normal",  continent:"north-america", names:["nikaragua","nicaragua"] },
  { code:"pa", topoId:"591", display:"Panama",                    counted:true,  difficulty:"easy",  continent:"north-america", names:["panama"] },
  { code:"kn", topoId:"659", display:"Saint Kitts ve Nevis",      counted:true,  difficulty:"hard",  continent:"north-america", names:["saint kitts ve nevis","saint kitts and nevis","st kitts","st. kitts"] },
  { code:"lc", topoId:"662", display:"Saint Lucia",               counted:true,  difficulty:"hard",  continent:"north-america", names:["saint lucia","st lucia","st. lucia"] },
  { code:"vc", topoId:"670", display:"Saint Vincent ve Grenadinler", counted:true, difficulty:"hard",  continent:"north-america", names:["saint vincent ve grenadinler","saint vincent and the grenadines","st vincent","saint vincent"] },
  { code:"tt", topoId:"780", display:"Trinidad ve Tobago",        counted:true,  difficulty:"normal",  continent:"north-america", names:["trinidad ve tobago","trinidad and tobago","trinidad"] },
  { code:"us", topoId:"840", display:"ABD",                       counted:true,  difficulty:"easy",  continent:"north-america", names:["abd","usa","us","america","amerika","united states","united states of america","amerikan","birlesik devletler","amerika birlesik devletleri"] },

  // ══════════════ SOUTH AMERICA — 12 ══════════════
  { code:"ar", topoId:"032", display:"Arjantin",                  counted:true,  difficulty:"easy",  continent:"south-america", names:["arjantin","argentina"] },
  { code:"bo", topoId:"068", display:"Bolivya",                   counted:true,  difficulty:"normal",  continent:"south-america", names:["bolivya","bolivia"] },
  { code:"br", topoId:"076", display:"Brezilya",                  counted:true,  difficulty:"easy",  continent:"south-america", names:["brezilya","brazil","brasil"] },
  { code:"cl", topoId:"152", display:"Şili",                      counted:true,  difficulty:"easy",  continent:"south-america", names:["sili","chile"] },
  { code:"co", topoId:"170", display:"Kolombiya",                 counted:true,  difficulty:"easy",  continent:"south-america", names:["kolombiya","colombia"] },
  { code:"ec", topoId:"218", display:"Ekvador",                   counted:true,  difficulty:"easy",  continent:"south-america", names:["ekvador","ecuador"] },
  { code:"gy", topoId:"328", display:"Guyana",                    counted:true,  difficulty:"hard",  continent:"south-america", names:["guyana"] },
  { code:"py", topoId:"600", display:"Paraguay",                  counted:true,  difficulty:"hard",  continent:"south-america", names:["paraguay"] },
  { code:"pe", topoId:"604", display:"Peru",                      counted:true,  difficulty:"easy",  continent:"south-america", names:["peru"] },
  { code:"sr", topoId:"740", display:"Surinam",                   counted:true,  difficulty:"hard",  continent:"south-america", names:["surinam","suriname"] },
  { code:"uy", topoId:"858", display:"Uruguay",                   counted:true,  difficulty:"hard",  continent:"south-america", names:["uruguay"] },
  { code:"ve", topoId:"862", display:"Venezuela",                 counted:true,  difficulty:"easy",  continent:"south-america", names:["venezuela"] },

  // ══════════════ OCEANIA — 14 ══════════════
  { code:"au", topoId:"036", display:"Avustralya",                counted:true,  difficulty:"easy",  continent:"oceania", names:["avustralya","australia"] },
  { code:"fj", topoId:"242", display:"Fiji",                      counted:true,  difficulty:"hard",  continent:"oceania", names:["fiji"] },
  { code:"ki", topoId:"296", display:"Kiribati",                  counted:true,  difficulty:"hard",  continent:"oceania", names:["kiribati"] },
  { code:"mh", topoId:"584", display:"Marshall Adaları",          counted:true,  difficulty:"hard",  continent:"oceania", names:["marshall adalari","marshall adaları","marshall islands"] },
  { code:"fm", topoId:"583", display:"Mikronezya",                counted:true,  difficulty:"hard",  continent:"oceania", names:["mikronezya","micronesia","federated states of micronesia"] },
  { code:"nr", topoId:"520", display:"Nauru",                     counted:true,  difficulty:"hard",  continent:"oceania", names:["nauru"] },
  { code:"nz", topoId:"554", display:"Yeni Zelanda",              counted:true,  difficulty:"easy",  continent:"oceania", names:["yeni zelanda","new zealand"] },
  { code:"pw", topoId:"585", display:"Palau",                     counted:true,  difficulty:"hard",  continent:"oceania", names:["palau"] },
  { code:"pg", topoId:"598", display:"Papua Yeni Gine",           counted:true,  difficulty:"normal",  continent:"oceania", names:["papua yeni gine","papua new guinea","png"] },
  { code:"ws", topoId:"882", display:"Samoa",                     counted:true,  difficulty:"hard",  continent:"oceania", names:["samoa","western samoa"] },
  { code:"sb", topoId:"090", display:"Solomon Adaları",           counted:true,  difficulty:"hard",  continent:"oceania", names:["solomon adalari","solomon adaları","solomon islands"] },
  { code:"to", topoId:"776", display:"Tonga",                     counted:true,  difficulty:"hard",  continent:"oceania", names:["tonga"] },
  { code:"tv", topoId:"798", display:"Tuvalu",                    counted:true,  difficulty:"hard",  continent:"oceania", names:["tuvalu"] },
  { code:"vu", topoId:"548", display:"Vanuatu",                   counted:true,  difficulty:"hard",  continent:"oceania", names:["vanuatu"] },

  // ══════════════ BONUS (counted:false) ══════════════
  { code:"gl", topoId:"304", display:"Grönland",                  counted:false, difficulty:"normal",  continent:"north-america", names:["gronland","greenland"] },
  { code:"nc", topoId:"540", display:"Yeni Kaledonya",            counted:false, difficulty:"normal",  continent:"oceania",       names:["yeni kaledonya","new caledonia"] },
];

/* ─────────────────────────────────────────────────
   EXTRA (CURATED) ALIASES
   Hand-maintained multilingual / colloquial names that aren't in
   `COUNTRIES[i].names` but should still resolve to the right country in every
   text-input mode. These are PRIMARY (curated) — they take precedence over the
   auto-generated locale aliases and can never be shadowed by them.

   The specially-requested aliases (ABD/USA/Amerika, Türkiye/Turkey/Turkiye,
   Çekya/Czechia/Czech Republic, Güney Kore/South Korea/Republic of Korea,
   Fildişi Sahili/Ivory Coast/Côte d'Ivoire) are guaranteed here or in the
   corresponding COUNTRIES[i].names entry.
───────────────────────────────────────────────── */
const EXTRA_COUNTRY_ALIASES: Record<string, string[]> = {
  // ISO alpha-2 code → additional accepted answers
  de: ["deutschland"],                              // Germany
  gr: ["hellas", "ellada", "ελλαδα"],               // Greece
  ru: ["russian federation"],                       // Russia
  kr: ["republic of korea", "korea republic", "rok", "güney kore"], // South Korea
  kp: ["dprk", "democratic people's republic of korea", "kuzey kore cumhuriyeti"],
  cz: ["czech rep", "czech republic", "çekya", "czechia"], // Czechia
  gb: ["great britain", "britanya"],                // United Kingdom
  us: ["amerika birleşik devletleri", "abd", "usa", "amerika"], // USA
  tr: ["türkiye", "turkiye", "turkey"],             // Türkiye
  cy: ["kıbrıs cumhuriyeti", "kibris cumhuriyeti"], // Cyprus
  ge: ["sakartvelo"],                               // Georgia
  ba: ["bosna ve hersek", "bosnia & herzegovina"],  // Bosnia
  ci: ["ivory coast", "côte d'ivoire", "republic of cote d'ivoire", "fildişi sahili"], // Côte d’Ivoire
  nl: ["niderlanda", "the netherlands"],            // Netherlands
  va: ["holy see"],                                 // Vatican
  mm: ["birmanya"],                                 // Myanmar
  mk: ["makedonya", "north macedonia"],             // N. Macedonia
  cd: ["zaire"],                                    // DR Congo
};

/* ─────────────────────────────────────────────────
   LOOKUP TABLES  +  CONFLICT-AWARE ALIAS RESOLUTION
───────────────────────────────────────────────── */
export const NAME_TO_TOPOID:      Record<string, string>      = {};
export const TOPOID_TO_DISPLAY:   Record<string, string>      = {};
export const TOPOID_TO_CONTINENT: Record<string, Continent>   = {};
export const CODE_TO_ENTRY:       Record<string, CountryEntry> = {};
export const TOPOID_TO_ENTRY:     Record<string, CountryEntry> = {};
/** Normalised accepted-answer string → the single canonical country it resolves to. */
export const NAME_TO_ENTRY:       Record<string, CountryEntry> = {};

/** Every normalised accepted-answer string that RESOLVES to a given country. */
const ENTRY_TO_ACCEPTED: WeakMap<CountryEntry, Set<string>> = new WeakMap();

/**
 * Alias-resolution report, populated once at module load.
 *
 *  • ALIAS_CONFLICTS — a normalised alias claimed by ≥2 countries at the same
 *    priority tier. It is DROPPED from every lookup table so we never silently
 *    accept a random country; typing it resolves to nothing.
 *  • ALIAS_SHADOWED  — an auto-generated locale alias that collides with
 *    another country's curated (primary) name. It resolves safely to the
 *    curated winner and is recorded here for auditing only.
 *
 * Consumed by scripts/check-country-answer-resolver.mjs.
 */
export interface AliasConflict { key: string; codes: string[]; tier: "primary" | "locale"; }
export interface AliasShadow   { key: string; winner: string; shadowed: string[]; }
export const ALIAS_CONFLICTS: AliasConflict[] = [];
export const ALIAS_SHADOWED:  AliasShadow[]   = [];

/** Curated (primary) accepted answers: display + names[] + EXTRA_COUNTRY_ALIASES. */
function buildPrimaryAcceptedFor(entry: CountryEntry): Set<string> {
  const set = new Set<string>();
  const add = (s: string | undefined) => {
    if (!s) return;
    const k = normalizeCountryAnswer(s);
    if (k) set.add(k);
  };
  add(entry.display);
  entry.names.forEach(add);
  (EXTRA_COUNTRY_ALIASES[entry.code] ?? []).forEach(add);
  return set;
}

/** Auto-generated locale (secondary) accepted answers for a country. */
function buildLocaleAcceptedFor(entry: CountryEntry): Set<string> {
  const set = new Set<string>();
  (COUNTRY_LOCALE_ALIASES[entry.code] ?? []).forEach(s => {
    const k = normalizeCountryAnswer(s);
    if (k) set.add(k);
  });
  return set;
}

// Unique-id maps first (no ambiguity — keyed by code / topoId).
COUNTRIES.forEach(entry => {
  const { code, topoId, display, continent } = entry;
  if (topoId) {
    TOPOID_TO_DISPLAY[topoId]   = display;
    TOPOID_TO_CONTINENT[topoId] = continent;
    TOPOID_TO_ENTRY[topoId]     = entry;
  }
  CODE_TO_ENTRY[code] = entry;
});

// Two-tier alias claim map → resolve winners, detect conflicts / shadows.
{
  const primaryClaims = new Map<string, Set<string>>();
  const localeClaims  = new Map<string, Set<string>>();
  const entryByCode   = new Map<string, CountryEntry>();
  const acceptedByCode = new Map<string, Set<string>>();

  const claim = (map: Map<string, Set<string>>, key: string, code: string) => {
    let s = map.get(key);
    if (!s) { s = new Set(); map.set(key, s); }
    s.add(code);
  };
  const acceptedFor = (code: string) => {
    let s = acceptedByCode.get(code);
    if (!s) { s = new Set(); acceptedByCode.set(code, s); }
    return s;
  };

  COUNTRIES.forEach(entry => {
    entryByCode.set(entry.code, entry);
    buildPrimaryAcceptedFor(entry).forEach(k => claim(primaryClaims, k, entry.code));
    buildLocaleAcceptedFor(entry).forEach(k  => claim(localeClaims,  k, entry.code));
  });

  const allKeys = new Set<string>([...primaryClaims.keys(), ...localeClaims.keys()]);
  allKeys.forEach(key => {
    const pCodes = primaryClaims.get(key) ? [...primaryClaims.get(key)!] : [];
    const lCodes = localeClaims.get(key)  ? [...localeClaims.get(key)!]  : [];

    let winner: string | null = null;
    if (pCodes.length === 1) {
      // Curated name wins; any locale alias of a *different* country is shadowed.
      winner = pCodes[0];
      const shadowed = lCodes.filter(c => c !== winner);
      if (shadowed.length) ALIAS_SHADOWED.push({ key, winner, shadowed: shadowed.sort() });
    } else if (pCodes.length >= 2) {
      ALIAS_CONFLICTS.push({ key, codes: pCodes.sort(), tier: "primary" });
    } else if (lCodes.length === 1) {
      winner = lCodes[0];
    } else if (lCodes.length >= 2) {
      ALIAS_CONFLICTS.push({ key, codes: lCodes.sort(), tier: "locale" });
    }

    if (!winner) return; // conflicting → resolves to nothing, on purpose.
    const entry = entryByCode.get(winner)!;
    NAME_TO_ENTRY[key] = entry;
    CODE_TO_ENTRY[key] = entry;                 // legacy: lookup by normalised name too
    if (entry.topoId) NAME_TO_TOPOID[key] = entry.topoId;
    acceptedFor(winner).add(key);
  });

  COUNTRIES.forEach(entry => {
    ENTRY_TO_ACCEPTED.set(entry, acceptedFor(entry.code));
  });
}

/* ─────────────────────────────────────────────────
   PUBLIC COUNTRY-ANSWER HELPERS
   Every mode that asks the player to type a country name should
   route through these — keep the validation logic in one place.
───────────────────────────────────────────────── */

/** All normalised accepted answers that RESOLVE to a country (curated + locale, minus conflicts). */
export function getCountryAcceptedAnswers(entry: CountryEntry): string[] {
  const cached = ENTRY_TO_ACCEPTED.get(entry);
  if (cached) return [...cached];
  // Fallback (cache miss): union of curated + locale, best-effort.
  return [...new Set([...buildPrimaryAcceptedFor(entry), ...buildLocaleAcceptedFor(entry)])];
}

/** Resolve any raw user input to a CountryEntry, or undefined for no match. */
export function findCountryByAnswer(raw: string): CountryEntry | undefined {
  const key = normalizeCountryAnswer(raw);
  if (!key) return undefined;
  return NAME_TO_ENTRY[key];
}

/**
 * THE central country-answer resolver.
 *
 * Normalises any raw user input — in any language and writing system of the
 * supported locale pack — and returns the single canonical country ID (the
 * ISO 3166-1 alpha-2 `code`), or null when nothing resolves.
 *
 * Every "type the country name" mode should key validation and de-duplication
 * off this canonical ID (or its entry-returning sibling `findCountryByAnswer`),
 * never off the raw text. That guarantees e.g. "Germany", "Almanya", "Германия"
 * and "ドイツ" all collapse to the same country and can't be counted twice.
 */
export function resolveCountryAnswer(input: string): string | null {
  const entry = findCountryByAnswer(input);
  return entry ? entry.code : null;
}

/** True iff the player's raw input matches the given country (any alias). */
export function isCountryAnswerCorrect(raw: string, entry: CountryEntry): boolean {
  if (!entry) return false;
  const key = normalizeCountryAnswer(raw);
  if (!key) return false;
  const accepted = ENTRY_TO_ACCEPTED.get(entry);
  return accepted ? accepted.has(key) : false;
}

/**
 * True iff `raw` and `acceptedAnswer` resolve to the same country.
 * Useful for the Conquest free-text bank where `acceptedAnswers` is a list
 * of country names — calling this lets every alias of those countries pass.
 * Falls back to plain normalised string equality when neither side maps to
 * a known country (capitals, mountains, "Nile", etc.).
 */
export function areCountryAnswersEquivalent(raw: string, acceptedAnswer: string): boolean {
  const a = normalizeCountryAnswer(raw);
  const b = normalizeCountryAnswer(acceptedAnswer);
  if (!a || !b) return false;
  if (a === b) return true;
  const ea = NAME_TO_ENTRY[a];
  const eb = NAME_TO_ENTRY[b];
  return !!ea && !!eb && ea.code === eb.code;
}

export const TOTAL_COUNTRIES = COUNTRIES.filter(c => c.counted).length;

const MULTI_CONTINENT: Record<string, Continent[]> = {
  "792": ["europe", "asia"], // Türkiye
  "643": ["europe", "asia"], // Rusya
};

export function getContinentIds(continent: Continent | "world"): Set<string> {
  const base = COUNTRIES.filter(c => c.counted && c.topoId);
  if (continent === "world") return new Set(base.map(c => c.topoId));
  const ids = new Set(base.filter(c => c.continent === continent).map(c => c.topoId));
  for (const [topoId, continents] of Object.entries(MULTI_CONTINENT)) {
    if (continents.includes(continent)) ids.add(topoId);
  }
  return ids;
}

export type Difficulty = "easy" | "normal" | "hard" | "all";

/**
 * All countries eligible for flag mode, continent + difficulty filtered.
 *
 * Difficulty is interpreted as a FAME-TIER BAND (see DIFFICULTY_TIER_POLICY
 * below), NOT the raw `difficulty` field, so Kolay/Orta/Zor map to clear tier
 * ranges and the progression curve can ramp easy→hard WITHIN the chosen band.
 * "all" applies no band filter (online modes + when the player hasn't narrowed
 * the difficulty). The raw `difficulty` field still feeds getFameTier.
 */
export function getFlagPool(
  continent: Continent | "world",
  difficulty: Difficulty = "all"
): CountryEntry[] {
  let pool = COUNTRIES.filter(c => c.counted && c.code);
  if (continent !== "world") pool = pool.filter(c => c.continent === continent);
  if (difficulty !== "all")  pool = pool.filter(c => isInDifficultyBand(c, difficulty));
  return pool;
}

/* ═══════════════════════════════════════════════════════════════
   ÇARK & BAYRAK — DIFFICULTY PROGRESSION + WHEEL ELIGIBILITY

   Two central, data-driven rules shared by EVERY Çark (Wheel) and
   Bayrak (Flag) surface — solo + multiplayer. The goal is a single
   readable source of truth so neither mode grows scattered, hard-coded
   country lists or `if` chains.

     1) FAME TIER  → orders questions easy→hard (both modes).
     2) WHEEL ELIGIBILITY → removes micro / unclickable countries from
        Çark ENTIRELY; Bayrak is never filtered.

   Neither rule touches the existing `difficulty` field, the round/score/
   XP flow, or repeat-prevention; they only decide pool membership and
   ordering.
═══════════════════════════════════════════════════════════════ */

/**
 * Recognizability ladder, 1 (most familiar) → 4 (most obscure).
 * Built ON TOP of the existing `difficulty` field, not as a replacement:
 *   • Tier 1 = curated "iconic giants" almost every Turkish player knows.
 *   • Tier 4 = micro-states (WHEEL_INELIGIBLE_CODES) + difficulty="hard".
 *   • Tier 2/3   = difficulty easy / normal (non-iconic, non-micro).
 * Early game pulls from low tiers; later questions climb to higher ones.
 */
export type FameTier = 1 | 2 | 3 | 4;

/**
 * Tier-1 "Tanıdık Devler" — instantly recognised in Turkey: world powers,
 * popular travel/culture countries, and Türkiye's best-known neighbours.
 * Keyed by ISO alpha-2 (stable, language-independent). Edit freely.
 */
const ICONIC_CODES = new Set<string>([
  // Dünya güçleri & en bilinenler
  "tr","us","gb","de","fr","it","es","pt","nl","ru",
  "cn","jp","kr","in","br","ar","mx","ca","au",
  // Türkiye'nin çok bilinen komşuları / bölge devleri
  "gr","eg","sa","ir","iq","ua","az",
]);

/** Fame tier for a country. Pure function of curated sets + difficulty.
 *  (WHEEL_INELIGIBLE_CODES is declared below; this fn only runs at call time,
 *   long after module init, so the forward reference is safe.) */
export function getFameTier(entry: CountryEntry): FameTier {
  // Mikro-devlet → obscure flag tier. So a tiny island that's unclickable on
  // the map ALSO counts as an obscure flag → surfaces only in the hard band.
  if (WHEEL_INELIGIBLE_CODES.has(entry.code)) return 4;
  if (ICONIC_CODES.has(entry.code)) return 1;
  if (entry.difficulty === "easy")   return 2;
  if (entry.difficulty === "normal") return 3;
  return 4; // hard
}

/* ───────────────────────────────────────────────
   DIFFICULTY TIER POLICY — manual offline difficulty ⇄ allowed fame tiers.

   Manuel zorluk (Kolay/Orta/Zor) ile online ortak progression UYUMLU ama AYRI
   kavramlardır:
     • manuel zorluk = hangi tier'lar HAVUZDA olabilir (band üyeliği)
     • progression   = band'in İÇİNDE kolaydan zora sıralama/pacing
   Online modlar "all" geçer (tüm band) ve pacing'i yalnız progression yapar.

     Kolay → T1-T2      tanıdık; T3/T4 (ve mikro bayraklar) YOK
     Orta  → T1-T2-T3   T1 başlar, T2 ağırlık, sınırlı T3; T4 YOK
     Zor   → T2-T3-T4   devler/T1 YOK → belirgin daha zor; T4 (mikro bayraklar) DAHİL
     Tümü  → 1-2-3-4    online + zorluk seçilmemiş
─────────────────────────────────────────────── */
export const DIFFICULTY_TIER_POLICY: Record<Difficulty, ReadonlySet<FameTier>> = {
  easy:   new Set<FameTier>([1, 2]),
  normal: new Set<FameTier>([1, 2, 3]),
  hard:   new Set<FameTier>([2, 3, 4]),
  all:    new Set<FameTier>([1, 2, 3, 4]),
};

/** True iff `entry`'s fame tier is allowed by the manual difficulty band. */
export function isInDifficultyBand(entry: CountryEntry, difficulty: Difficulty): boolean {
  return DIFFICULTY_TIER_POLICY[difficulty].has(getFameTier(entry));
}

/**
 * Çark uygunluk listesi — countries too small / unclickable on the map to
 * be fair as a "find it on the map" target. Excluded from Çark at EVERY
 * difficulty; fully available in Bayrak. Keyed by ISO alpha-2.
 *
 * Supersedes the former per-component WHEEL_DUEL_EXCLUDED_TOPOIDS /
 * WHEEL_GROUP_EXCLUDED_TOPOIDS sets (now a single source of truth, and
 * Brunei — previously missing from duel — is included here).
 */
export const WHEEL_INELIGIBLE_CODES = new Set<string>([
  // ── Avrupa mikro-devletleri ──
  "ad", // Andorra
  "li", // Lihtenştayn
  "mt", // Malta
  "mc", // Monako
  "sm", // San Marino
  "va", // Vatikan
  // ── Asya küçük / ada ülkeleri ──
  "bh", // Bahreyn
  "bn", // Brunei
  "mv", // Maldivler
  "sg", // Singapur (difficulty=easy ama haritada tıklanamaz → yine de dışarıda)
  // ── Afrika ada ülkeleri ──
  "cv", // Cabo Verde
  "km", // Komorlar
  "mu", // Mauritius
  "st", // Sao Tome ve Principe
  "sc", // Seyşeller
  // ── Karayipler / Amerika mikro adaları ──
  "ag", // Antigua ve Barbuda
  "bb", // Barbados
  "dm", // Dominika
  "gd", // Grenada
  "kn", // Saint Kitts ve Nevis
  "lc", // Saint Lucia
  "vc", // Saint Vincent ve Grenadinler
  // ── Okyanusya mikro adaları ──
  "fj", // Fiji
  "ki", // Kiribati
  "fm", // Mikronezya
  "mh", // Marshall Adaları
  "nr", // Nauru
  "pw", // Palau
  "to", // Tonga
  "tv", // Tuvalu
  "ws", // Samoa
]);

/** True iff the country may appear as a Çark (Wheel) map target. */
export function isWheelEligible(entry: CountryEntry): boolean {
  return Boolean(entry.code && entry.topoId) && !WHEEL_INELIGIBLE_CODES.has(entry.code);
}

/**
 * Çark target pool: flag pool minus micro/unclickable countries.
 * `difficulty` still works as an explicit user filter (solo dropdown);
 * multiplayer always passes "all" and relies on tier progression instead.
 */
export function getWheelPool(
  continent: Continent | "world",
  difficulty: Difficulty = "all"
): CountryEntry[] {
  return getFlagPool(continent, difficulty).filter(isWheelEligible);
}

/** In-place Fisher–Yates shuffle. */
function shuffleInPlace<T>(arr: T[], rng: () => number = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ───────────────────────────────────────────────
   PROGRESSION CURVE — the single source of difficulty pacing.

   Earlier we ordered by tier in solid BLOCKS (all T1, then all T2…), so a
   short match never left T1 (there are 26 T1 countries alone). Instead we
   now spread the four tiers across the ACTUAL game length with a weighted
   draw: each question samples a tier by weight, then a random country from
   it. Tiers interleave, within-tier shuffle/variety is preserved, and the
   ramp completes within the game's own length.

   `p` is the game's progress fraction (0 = first question, 1 = last). It is
   ALWAYS derived from a completed-question/target INDEX, never from the clock:
     • Bayrak duel (round-based) → queue walked in round order (pos = round-1)
     • Bayrak solo (queue)       → queue walked in question order
     • Çark solo/duel/grup       → completedTargets / expectedTargets
                                    (expectedTargets is a STATIC span from the
                                     duration; the live clock is NOT read here)
   Each mode computes its own `p`; the curve below is shared by all.

   Target shape — matches the brief's 10-target example (1-4 T1, 5-7 T2,
   8-9 T3, 10 T4), applied PROPORTIONALLY to the real game length:
     first  ~40%  → mostly Tier 1            (familiar giants, easy start)
     ~40-70%      → Tier 2 heavy, limited T3 (T4 still absent)
     ~70-90%      → Tier 3 heavy, T4 appears
     final ~10%   → mostly Tier 4            (so even short games top out)
   Within a band that excludes a tier (offline Kolay/Zor), chooseTier zeroes
   the empty bucket's weight and the ramp redistributes into the allowed tiers.
─────────────────────────────────────────────── */

/** Relative tier weights [T1,T2,T3,T4] for a progress fraction p ∈ [0,1]. */
export function progressionTierWeights(p: number): [number, number, number, number] {
  const x = p <= 0 ? 0 : p >= 1 ? 1 : p;
  if (x < 0.40) return [10, 3, 0, 0]; // erken (~ilk %40): ağırlıkla T1 — zor YOK
  if (x < 0.70) return [2,  8, 2, 0]; // orta (~%40-70): T2 ağırlık, sınırlı T3 — T4 YOK
  if (x < 0.90) return [0,  2, 7, 2]; // geç (~%70-90): T3 ağırlık, T4 belirir
  return            [0,  0, 2, 8];    // final (~son %10): ağırlıkla T4
}

/** Weighted tier choice over four shuffled buckets, skipping empties.
 *  Returns the chosen tier index (0-3), or -1 when every bucket is empty. */
function chooseTier(buckets: CountryEntry[][], p: number, rng: () => number): number {
  const w = progressionTierWeights(p);
  const avail = w.map((wt, t) => (buckets[t].length > 0 ? wt : 0));
  const sum = avail.reduce((a, b) => a + b, 0);
  if (sum > 0) {
    let r = rng() * sum;
    for (let t = 0; t < 4; t++) {
      r -= avail[t];
      if (r < 0) return t;
    }
    for (let t = 3; t >= 0; t--) if (avail[t] > 0) return t; // FP guard
  }
  // No weighted tier has stock — the curve has moved past this band's tiers
  // (e.g. Kolay {T1,T2} at p≈1, where the curve points at T3/T4). Clamp to the
  // non-empty tier NEAREST the curve's intended (weighted-mean) tier so a low
  // band stays at its TOP near the end instead of dipping back to T1.
  const totW = w.reduce((a, b) => a + b, 0);
  const meanTier = totW > 0 ? w.reduce((acc, wt, t) => acc + wt * t, 0) / totW : 0;
  let best = -1, bestDist = Infinity;
  for (let t = 0; t < 4; t++) {
    if (buckets[t].length === 0) continue;
    const dist = Math.abs(t - meanTier);
    if (dist < bestDist) { bestDist = dist; best = t; }
  }
  return best;
}

function bucketByTier(entries: CountryEntry[], rng: () => number): CountryEntry[][] {
  const buckets: CountryEntry[][] = [[], [], [], []];
  for (const e of entries) buckets[getFameTier(e) - 1].push(e);
  for (const b of buckets) shuffleInPlace(b, rng); // within-tier variety
  return buckets;
}

/**
 * Build one ordered, no-repeat question queue whose difficulty ramps across
 * `span` questions following the shared progression curve. Used by the
 * queue-based modes (Bayrak solo + Bayrak duel host) — callers walk it in
 * order, so the order IS the pacing and stays fair/shared in multiplayer.
 *
 * The queue covers the WHOLE pool: positions 0..span-1 follow the ramp;
 * anything past `span` (a very fast player, or duel golden-rounds) keeps
 * drawing at p=1, i.e. hardest-first.
 */
export function buildProgressionQueue(
  entries: CountryEntry[],
  span: number,
  rng: () => number = Math.random
): CountryEntry[] {
  const buckets = bucketByTier(entries, rng);
  const out: CountryEntry[] = [];
  const denom = Math.max(span - 1, 1);
  for (let i = 0; i < entries.length; i++) {
    const p = Math.min(i / denom, 1);
    const t = chooseTier(buckets, p, rng);
    if (t < 0) break;
    out.push(buckets[t].pop()!);
  }
  return out;
}

/**
 * Reactive single pick for the wheel modes: choose the next country from the
 * remaining pool using the progression curve at the current progress `p`.
 * Returns null only when `remaining` is empty.
 */
export function pickProgressionEntry(
  remaining: CountryEntry[],
  p: number,
  rng: () => number = Math.random
): CountryEntry | null {
  if (remaining.length === 0) return null;
  const buckets = bucketByTier(remaining, rng);
  const t = chooseTier(buckets, p, rng);
  if (t < 0) return null;
  const b = buckets[t];
  return b[Math.floor(rng() * b.length)];
}

/**
 * Çark duel/grup host helper: pick the next target topoId from the remaining
 * (unused) topoIds using the progression curve at progress `p`. Host stays
 * the single authority; `used_target_topoids` keeps the order shared/fair.
 */
export function pickProgressionTopoId(
  remainingTopoIds: string[],
  p: number,
  rng: () => number = Math.random
): string | null {
  if (remainingTopoIds.length === 0) return null;
  const entries = remainingTopoIds
    .map(id => TOPOID_TO_ENTRY[id])
    .filter((e): e is CountryEntry => Boolean(e));
  const pick = pickProgressionEntry(entries, p, rng);
  return pick ? pick.topoId : remainingTopoIds[0];
}

/* ───────────────────────────────────────────────
   TIME-BASED ÇARK — TARGET-INDEX PROGRESS (no clock in the difficulty calc)

   Çark online/solo süre ile BİTER, ama zorluk SÜREYLE değil, tamamlanan ortak
   hedef SAYISIYLA artar. `duration` yalnız rampanın kaç hedefe yayılacağını
   (beklenen hedef sayısı) belirler — saat okunmaz. Böylece aynı hedef sırası
   herkeste aynı tier dağılımını verir; hızlı/yavaş oynamak zorluğu değiştirmez.
─────────────────────────────────────────────── */

/** Kabaca saniye/hedef — beklenen hedef sayısını süreden türetmek için. */
export const WHEEL_SECONDS_PER_TARGET = 6;

/** A time-based Çark game's expected target count = the ramp length. */
export function expectedWheelTargets(durationSec: number): number {
  return Math.max(6, Math.round((durationSec || 0) / WHEEL_SECONDS_PER_TARGET));
}

/** Progress fraction (0..1) for the 0-based index of the target about to show. */
export function targetIndexProgress(completedCount: number, expectedTotal: number): number {
  const denom = Math.max(expectedTotal - 1, 1);
  return Math.min(Math.max(completedCount / denom, 0), 1);
}

/* ═══════════════════════════════════════════════════════════════
   ROUTE MODE — clean, symmetric, validated dataset
   
   Rules:
   • Only universally recognised sovereign states
   • Only land borders (no sea crossings, no Kaliningrad oddities)
   • Every edge A→B also has B→A (enforced programmatically below)
   • Micro-states (Monaco, Vatican, San Marino, Andorra, Liechtenstein)
     are EXCLUDED because they make trivial routes and are rarely known
   • Kosovo, Northern Cyprus, Greenland, territories excluded
   • Islands with no land border are excluded
═══════════════════════════════════════════════════════════════ */

/**
 * Directed adjacency list — intentionally duplicated both ways so
 * reading either direction is O(1).  Validated for symmetry below.
 */
const ROUTE_GRAPH_RAW: Record<string, string[]> = {
  // ── EUROPE ──
  "Albania":                ["Greece","North Macedonia","Montenegro","Serbia"],
  "Austria":                ["Germany","Czech Republic","Slovakia","Hungary","Slovenia","Italy","Switzerland"],
  "Belarus":                ["Russia","Ukraine","Poland","Lithuania","Latvia"],
  "Belgium":                ["France","Germany","Netherlands","Luxembourg"],
  "Bosnia and Herzegovina": ["Croatia","Serbia","Montenegro"],
  "Bulgaria":               ["Turkey","Greece","Romania","Serbia","North Macedonia"],
  "Croatia":                ["Slovenia","Hungary","Serbia","Bosnia and Herzegovina","Montenegro"],
  "Czech Republic":         ["Germany","Poland","Slovakia","Austria"],
  "Denmark":                ["Germany"],
  "Estonia":                ["Latvia","Russia"],
  "Finland":                ["Norway","Sweden","Russia"],
  "France":                 ["Belgium","Luxembourg","Germany","Switzerland","Italy","Spain"],
  "Germany":                ["Denmark","Poland","Czech Republic","Austria","Switzerland","France","Belgium","Netherlands","Luxembourg"],
  "Greece":                 ["Albania","North Macedonia","Bulgaria","Turkey"],
  "Hungary":                ["Austria","Slovakia","Ukraine","Romania","Serbia","Croatia","Slovenia"],
  "Italy":                  ["France","Switzerland","Austria","Slovenia"],
  "Kosovo":                 ["Albania","North Macedonia","Montenegro","Serbia"],
  "Latvia":                 ["Estonia","Lithuania","Belarus","Russia"],
  "Lithuania":              ["Latvia","Belarus","Poland","Russia"],
  "Luxembourg":             ["Belgium","France","Germany"],
  "Moldova":                ["Romania","Ukraine"],
  "Montenegro":             ["Croatia","Bosnia and Herzegovina","Serbia","Albania","North Macedonia"],
  "Netherlands":            ["Belgium","Germany"],
  "North Macedonia":        ["Albania","Bulgaria","Serbia","Greece","Montenegro"],
  "Norway":                 ["Sweden","Finland","Russia"],
  "Poland":                 ["Germany","Czech Republic","Slovakia","Ukraine","Belarus","Lithuania","Russia"],
  "Portugal":               ["Spain"],
  "Romania":                ["Moldova","Ukraine","Hungary","Serbia","Bulgaria"],
  "Russia":                 ["Norway","Finland","Estonia","Latvia","Lithuania","Belarus","Ukraine","Poland","Georgia","Azerbaijan","Kazakhstan"],
  "Serbia":                 ["Hungary","Romania","Bulgaria","North Macedonia","Croatia","Bosnia and Herzegovina","Montenegro","Albania"],
  "Slovakia":               ["Czech Republic","Poland","Ukraine","Hungary","Austria"],
  "Slovenia":               ["Austria","Italy","Hungary","Croatia"],
  "Spain":                  ["France","Portugal"],
  "Sweden":                 ["Norway","Finland"],
  "Switzerland":            ["Germany","Austria","France","Italy"],
  "Turkey":                 ["Greece","Bulgaria","Georgia","Armenia","Azerbaijan","Iran","Iraq","Syria"],
  "Ukraine":                ["Russia","Belarus","Poland","Slovakia","Hungary","Romania","Moldova"],

  // ── ASIA ──
  "Afghanistan":            ["Iran","Pakistan","Tajikistan","Uzbekistan","Turkmenistan","China"],
  "Armenia":                ["Georgia","Azerbaijan","Iran","Turkey"],
  "Azerbaijan":             ["Russia","Georgia","Armenia","Iran","Turkey"],
  "Bangladesh":             ["India","Myanmar"],
  "Bhutan":                 ["India","China"],
  "Cambodia":               ["Thailand","Laos","Vietnam"],
  "China":                  ["Russia","Mongolia","Kazakhstan","Kyrgyzstan","Tajikistan","Afghanistan","Pakistan","India","Bhutan","Nepal","Myanmar","Laos","Vietnam"],
  "Georgia":                ["Russia","Azerbaijan","Armenia","Turkey"],
  "India":                  ["Pakistan","China","Nepal","Bhutan","Bangladesh","Myanmar"],
  "Iran":                   ["Turkey","Armenia","Azerbaijan","Turkmenistan","Afghanistan","Pakistan","Iraq"],
  "Iraq":                   ["Turkey","Syria","Jordan","Saudi Arabia","Kuwait","Iran"],
  "Israel":                 ["Lebanon","Syria","Jordan"],
  "Jordan":                 ["Israel","Syria","Iraq","Saudi Arabia"],
  "Kazakhstan":             ["Russia","China","Kyrgyzstan","Uzbekistan","Turkmenistan"],
  "Kuwait":                 ["Iraq","Saudi Arabia"],
  "Kyrgyzstan":             ["Kazakhstan","China","Tajikistan","Uzbekistan"],
  "Laos":                   ["China","Vietnam","Cambodia","Thailand","Myanmar"],
  "Lebanon":                ["Syria","Israel"],
  "Malaysia":               ["Thailand","Indonesia","Brunei"],
  "Mongolia":               ["Russia","China"],
  "Myanmar":                ["China","India","Bangladesh","Laos","Thailand"],
  "Nepal":                  ["India","China"],
  "North Korea":            ["China","Russia","South Korea"],
  "Oman":                   ["Saudi Arabia","UAE","Yemen"],
  "Pakistan":               ["Iran","Afghanistan","India","China"],
  "Qatar":                  ["Saudi Arabia"],
  "Saudi Arabia":           ["Jordan","Iraq","Kuwait","Qatar","UAE","Oman","Yemen"],
  "South Korea":            ["North Korea"],
  "Syria":                  ["Turkey","Lebanon","Israel","Jordan","Iraq"],
  "Tajikistan":             ["Kazakhstan","Kyrgyzstan","China","Afghanistan","Uzbekistan"],
  "Thailand":               ["Myanmar","Laos","Cambodia","Malaysia"],
  "Turkmenistan":           ["Kazakhstan","Uzbekistan","Afghanistan","Iran"],
  "UAE":                    ["Saudi Arabia","Oman","Qatar"],
  "Uzbekistan":             ["Kazakhstan","Kyrgyzstan","Tajikistan","Afghanistan","Turkmenistan"],
  "Vietnam":                ["China","Laos","Cambodia"],
  "Yemen":                  ["Saudi Arabia","Oman"],

  // ── AFRICA ──
  "Algeria":                ["Morocco","Mauritania","Mali","Niger","Libya","Tunisia"],
  "Angola":                 ["Democratic Republic of Congo","Republic of Congo","Zambia","Namibia"],
  "Benin":                  ["Burkina Faso","Niger","Nigeria","Togo"],
  "Botswana":               ["Namibia","Zambia","Zimbabwe","South Africa"],
  "Burkina Faso":           ["Mali","Niger","Benin","Togo","Ghana","Ivory Coast"],
  "Burundi":                ["Democratic Republic of Congo","Rwanda","Tanzania"],
  "Cameroon":               ["Nigeria","Chad","Central African Republic","Republic of Congo","Gabon","Equatorial Guinea"],
  "Central African Republic": ["Chad","Sudan","South Sudan","Democratic Republic of Congo","Republic of Congo","Cameroon"],
  "Chad":                   ["Libya","Sudan","Central African Republic","Cameroon","Nigeria","Niger","Algeria"],
  "Democratic Republic of Congo": ["Republic of Congo","Central African Republic","South Sudan","Uganda","Rwanda","Burundi","Tanzania","Zambia","Angola"],
  "Djibouti":               ["Eritrea","Ethiopia","Somalia"],
  "Egypt":                  ["Libya","Sudan","Israel"],
  "Equatorial Guinea":      ["Cameroon","Gabon"],
  "Eritrea":                ["Sudan","Ethiopia","Djibouti"],
  "Ethiopia":               ["Eritrea","Djibouti","Somalia","Kenya","South Sudan","Sudan"],
  "Gabon":                  ["Cameroon","Equatorial Guinea","Republic of Congo"],
  "Ghana":                  ["Ivory Coast","Burkina Faso","Togo"],
  "Guinea":                 ["Guinea-Bissau","Senegal","Mali","Sierra Leone","Liberia","Ivory Coast"],
  "Guinea-Bissau":          ["Senegal","Guinea"],
  "Ivory Coast":            ["Guinea","Liberia","Ghana","Burkina Faso","Mali"],
  "Kenya":                  ["Ethiopia","Somalia","Tanzania","Uganda","South Sudan"],
  "Liberia":                ["Guinea","Sierra Leone","Ivory Coast"],
  "Libya":                  ["Tunisia","Algeria","Niger","Chad","Sudan","Egypt"],
  "Malawi":                 ["Tanzania","Zambia","Mozambique"],
  "Mali":                   ["Algeria","Mauritania","Senegal","Guinea","Ivory Coast","Burkina Faso","Niger"],
  "Mauritania":             ["Morocco","Algeria","Mali","Senegal"],
  "Morocco":                ["Algeria","Mauritania","Spain"],
  "Mozambique":             ["Tanzania","Malawi","Zambia","Zimbabwe","South Africa","Eswatini"],
  "Namibia":                ["Angola","Zambia","Botswana","South Africa"],
  "Niger":                  ["Algeria","Libya","Chad","Nigeria","Benin","Burkina Faso","Mali"],
  "Nigeria":                ["Benin","Niger","Chad","Cameroon"],
  "Republic of Congo":      ["Gabon","Cameroon","Central African Republic","Democratic Republic of Congo","Angola"],
  "Rwanda":                 ["Democratic Republic of Congo","Uganda","Tanzania","Burundi"],
  "Senegal":                ["Mauritania","Mali","Guinea","Guinea-Bissau"],
  "Sierra Leone":           ["Guinea","Liberia"],
  "Somalia":                ["Djibouti","Ethiopia","Kenya"],
  "South Africa":           ["Namibia","Botswana","Zimbabwe","Mozambique","Eswatini","Lesotho"],
  "South Sudan":            ["Sudan","Ethiopia","Kenya","Uganda","Democratic Republic of Congo","Central African Republic"],
  "Sudan":                  ["Egypt","Libya","Chad","Central African Republic","South Sudan","Ethiopia","Eritrea"],
  "Tanzania":               ["Uganda","Kenya","Rwanda","Burundi","Democratic Republic of Congo","Zambia","Malawi","Mozambique"],
  "Togo":                   ["Benin","Burkina Faso","Ghana"],
  "Tunisia":                ["Algeria","Libya"],
  "Uganda":                 ["South Sudan","Kenya","Tanzania","Rwanda","Democratic Republic of Congo"],
  "Zambia":                 ["Democratic Republic of Congo","Tanzania","Malawi","Mozambique","Zimbabwe","Botswana","Namibia","Angola"],
  "Zimbabwe":               ["Zambia","Mozambique","South Africa","Botswana"],
  "Eswatini":               ["South Africa","Mozambique"],
  "Lesotho":                ["South Africa"],

  // ── AMERICAS ──
  "Argentina":              ["Chile","Bolivia","Paraguay","Brazil","Uruguay"],
  "Bolivia":                ["Peru","Chile","Argentina","Paraguay","Brazil"],
  "Brazil":                 ["Venezuela","Guyana","Suriname","Colombia","Peru","Bolivia","Paraguay","Argentina","Uruguay"],
  "Chile":                  ["Peru","Bolivia","Argentina"],
  "Colombia":               ["Venezuela","Brazil","Peru","Ecuador","Panama"],
  "Costa Rica":             ["Nicaragua","Panama"],
  "Ecuador":                ["Colombia","Peru"],
  "El Salvador":            ["Guatemala","Honduras"],
  "Guatemala":              ["Mexico","Belize","Honduras","El Salvador"],
  "Guyana":                 ["Venezuela","Brazil","Suriname"],
  "Honduras":               ["Guatemala","El Salvador","Nicaragua"],
  "Mexico":                 ["USA","Guatemala","Belize"],
  "Nicaragua":              ["Honduras","Costa Rica"],
  "Panama":                 ["Costa Rica","Colombia"],
  "Paraguay":               ["Bolivia","Brazil","Argentina"],
  "Peru":                   ["Ecuador","Colombia","Brazil","Bolivia","Chile"],
  "Suriname":               ["Guyana","Brazil"],
  "Uruguay":                ["Brazil","Argentina"],
  "USA":                    ["Canada","Mexico"],
  "Canada":                 ["USA"],
  "Venezuela":              ["Colombia","Brazil","Guyana"],
  "Belize":                 ["Mexico","Guatemala"],
};

// ── Symmetry enforcement ──
// Remove countries with no neighbours (islands that slipped in)
// and ensure every edge is bidirectional.
function buildSymmetricGraph(raw: Record<string, string[]>): Record<string, string[]> {
  // Step 1: collect only keys that are present in raw AND have ≥1 neighbour
  const validKeys = new Set(
    Object.entries(raw)
      .filter(([, nbs]) => nbs.length > 0)
      .map(([k]) => k)
  );

  // Step 2: rebuild — only include neighbours that are also valid keys
  const graph: Record<string, string[]> = {};
  for (const key of validKeys) {
    graph[key] = (raw[key] ?? []).filter(nb => validKeys.has(nb));
  }

  // Step 3: add reverse edges where missing
  for (const [key, nbs] of Object.entries(graph)) {
    for (const nb of nbs) {
      if (!graph[nb].includes(key)) {
        graph[nb].push(key);
      }
    }
  }

  return graph;
}

/** The validated, symmetric neighbour graph for Route Mode */
export const NEIGHBOR_GRAPH: Record<string, string[]> = buildSymmetricGraph(ROUTE_GRAPH_RAW);

/** All keys usable as start/end in Route Mode (have ≥1 neighbour) */
export const GRAPH_KEYS: string[] = Object.keys(NEIGHBOR_GRAPH).sort();

/**
 * Normalised-name → canonical route key map.
 * Seeded from NEIGHBOR_GRAPH keys + COUNTRIES Turkish aliases.
 */
export const NORM_TO_ROUTE_KEY: Record<string, string> = {};

// From graph keys themselves
Object.keys(NEIGHBOR_GRAPH).forEach(key => {
  NORM_TO_ROUTE_KEY[normalizeInput(key)] = key;
});

// Additional aliases from COUNTRIES (Turkish names, English variants)
const EXTRA_ALIASES: Record<string, string[]> = {
  "Turkey":                   ["turkiye","turkey","turk","turkiye cumhuriyeti"],
  "Germany":                  ["almanya","germany"],
  "France":                   ["fransa","france"],
  "Italy":                    ["italya","italy"],
  "Spain":                    ["ispanya","spain"],
  "Poland":                   ["polonya","poland"],
  "Romania":                  ["romanya","romania"],
  "Netherlands":              ["hollanda","netherlands","holland"],
  "Belgium":                  ["belcika","belgium"],
  "Czech Republic":           ["cekya","czechia","czech republic","cek cumhuriyeti"],
  "Greece":                   ["yunanistan","greece"],
  "Hungary":                  ["macaristan","hungary"],
  "Bulgaria":                 ["bulgaristan","bulgaria"],
  "Serbia":                   ["sirbistan","serbia"],
  "Croatia":                  ["hirvatistan","croatia"],
  "Slovakia":                 ["slovakya","slovakia"],
  "Denmark":                  ["danimarka","denmark"],
  "Finland":                  ["finlandiya","finland"],
  "Norway":                   ["norvec","norway"],
  "Sweden":                   ["isvec","sweden"],
  "Switzerland":              ["isvicre","switzerland"],
  "Austria":                  ["avusturya","austria"],
  "Portugal":                 ["portekiz","portugal"],
  "Bosnia and Herzegovina":   ["bosna hersek","bosna-hersek","bosna","bosnia","bosnia and herzegovina","bosna ve hersek"],
  "North Macedonia":          ["kuzey makedonya","north macedonia","makedonya","macedonia"],
  "Albania":                  ["arnavutluk","albania"],
  "Montenegro":               ["karadag","montenegro"],
  "Moldova":                  ["moldova"],
  "Slovenia":                 ["slovenya","slovenia"],
  "Belarus":                  ["belarus","beyaz rusya"],
  "Ukraine":                  ["ukrayna","ukraine"],
  "Russia":                   ["rusya","russia","russian federation"],
  "Estonia":                  ["estonya","estonia"],
  "Latvia":                   ["letonya","latvia"],
  "Lithuania":                ["litvanya","lithuania"],
  "Luxembourg":               ["luksemburg","luxembourg"],
  "Georgia":                  ["gurcistan","georgia"],
  "Armenia":                  ["ermenistan","armenia"],
  "Azerbaijan":               ["azerbaycan","azerbaijan"],
  "Iran":                     ["iran"],
  "Iraq":                     ["irak","iraq"],
  "Syria":                    ["suriye","syria"],
  "Lebanon":                  ["lubnan","lebanon"],
  "Israel":                   ["israil","israel"],
  "Jordan":                   ["urdun","jordan"],
  "Saudi Arabia":             ["suudi arabistan","saudi arabia"],
  "Kuwait":                   ["kuveyt","kuwait"],
  "UAE":                      ["birlesik arap emirlikleri","bae","united arab emirates","uae"],
  "Qatar":                    ["katar","qatar"],
  "Oman":                     ["umman","oman"],
  "Yemen":                    ["yemen"],
  "Pakistan":                 ["pakistan"],
  "Afghanistan":              ["afganistan","afghanistan"],
  "India":                    ["hindistan","india"],
  "China":                    ["cin","china"],
  "Mongolia":                 ["mogolistan","mongolia"],
  "Kazakhstan":               ["kazakistan","kazakhstan"],
  "Uzbekistan":               ["ozbekistan","uzbekistan"],
  "Kyrgyzstan":               ["kirgizistan","kyrgyzstan"],
  "Tajikistan":               ["tacikistan","tajikistan"],
  "Turkmenistan":             ["turkmenistan"],
  "Myanmar":                  ["myanmar","burma"],
  "Thailand":                 ["tayland","thailand"],
  "Vietnam":                  ["vietnam"],
  "Laos":                     ["laos"],
  "Cambodia":                 ["kambocya","cambodia"],
  "Malaysia":                 ["malezya","malaysia"],
  "Bangladesh":               ["banglades","bangladesh"],
  "Nepal":                    ["nepal"],
  "Bhutan":                   ["butan","bhutan"],
  "North Korea":              ["kuzey kore","north korea"],
  "South Korea":              ["guney kore","south korea","korea","kore"],
  "Egypt":                    ["misir","egypt"],
  "Libya":                    ["libya"],
  "Tunisia":                  ["tunus","tunisia"],
  "Algeria":                  ["cezayir","algeria"],
  "Morocco":                  ["fas","morocco","maroc"],
  "Mauritania":               ["moritanya","mauritania"],
  "Mali":                     ["mali"],
  "Niger":                    ["nijer","niger"],
  "Chad":                     ["cad","chad"],
  "Sudan":                    ["sudan"],
  "South Sudan":              ["guney sudan","south sudan"],
  "Ethiopia":                 ["etiyopya","ethiopia"],
  "Eritrea":                  ["eritre","eritrea"],
  "Djibouti":                 ["cibuti","djibouti"],
  "Somalia":                  ["somali","somalia"],
  "Kenya":                    ["kenya"],
  "Uganda":                   ["uganda"],
  "Rwanda":                   ["ruanda","rwanda"],
  "Burundi":                  ["burundi"],
  "Tanzania":                 ["tanzanya","tanzania"],
  "Democratic Republic of Congo": ["kongo dr","demokratik kongo cumhuriyeti","demokratik kongo","kongo demokratik cumhuriyeti","kongo dc","kongo d c","dkc","dr kongo","demokratik kongo cumh","kongo kinsasa","kongo kinshasa","dr congo","dem rep congo","democratic republic of the congo","drc"],
  "Republic of Congo":        ["kongo cumhuriyeti","kongo","congo","republic of the congo","congo republic"],
  "Central African Republic": ["orta afrika cumhuriyeti","central african rep","central african republic","car"],
  "Cameroon":                 ["kamerun","cameroon"],
  "Nigeria":                  ["nijerya","nigeria"],
  "Benin":                    ["benin"],
  "Togo":                     ["togo"],
  "Ghana":                    ["gana","ghana"],
  "Ivory Coast":              ["fildisi sahili","ivory coast","cote d ivoire","cote divoire","cote d'ivoire"],
  "Burkina Faso":             ["burkina faso"],
  "Guinea":                   ["gine","guinea"],
  "Guinea-Bissau":            ["gine bissau","guinea-bissau","guinea bissau"],
  "Senegal":                  ["senegal"],
  "Liberia":                  ["liberya","liberia"],
  "Sierra Leone":             ["sierra leone"],
  "Angola":                   ["angola"],
  "Zambia":                   ["zambiya","zambia"],
  "Malawi":                   ["malavi","malawi"],
  "Mozambique":               ["mozambik","mozambique"],
  "Zimbabwe":                 ["zimbabve","zimbabwe"],
  "Botswana":                 ["botsvana","botswana"],
  "Namibia":                  ["namibya","namibia"],
  "South Africa":             ["guney afrika","south africa"],
  "Eswatini":                 ["esvatini","eswatini","swaziland"],
  "Lesotho":                  ["lesoto","lesotho"],
  "Gabon":                    ["gabon"],
  "Equatorial Guinea":        ["ekvator ginesi","equatorial guinea","guinea ecuatorial"],
  "Argentina":                ["arjantin","argentina"],
  "Bolivia":                  ["bolivya","bolivia"],
  "Brazil":                   ["brezilya","brazil","brasil"],
  "Chile":                    ["sili","chile"],
  "Colombia":                 ["kolombiya","colombia"],
  "Ecuador":                  ["ekvador","ecuador"],
  "Guyana":                   ["guyana"],
  "Paraguay":                 ["paraguay"],
  "Peru":                     ["peru"],
  "Suriname":                 ["surinam","suriname"],
  "Uruguay":                  ["uruguay"],
  "Venezuela":                ["venezuela"],
  "USA":                      ["abd","usa","us","america","amerika","united states","united states of america","amerikan","birlesik devletler","amerika birlesik devletleri"],
  "Canada":                   ["kanada","canada"],
  "Mexico":                   ["meksika","mexico"],
  "Guatemala":                ["guatemala"],
  "Belize":                   ["belize"],
  "Honduras":                 ["honduras"],
  "El Salvador":              ["el salvador"],
  "Nicaragua":                ["nikaragua","nicaragua"],
  "Costa Rica":               ["kosta rika","costa rica"],
  "Panama":                   ["panama"],
};

Object.entries(EXTRA_ALIASES).forEach(([routeKey, aliases]) => {
  aliases.forEach(alias => {
    const norm = normalizeInput(alias);
    if (norm && !NORM_TO_ROUTE_KEY[norm]) NORM_TO_ROUTE_KEY[norm] = routeKey;
  });
});

// Also keep existing COUNTRIES array aliases working
COUNTRIES.forEach(entry => {
  const matchKey = Object.keys(NEIGHBOR_GRAPH).find(k =>
    normalizeInput(k) === normalizeInput(entry.display) ||
    entry.names.some(n => normalizeInput(n) === normalizeInput(k))
  );
  if (!matchKey) return;
  entry.names.forEach(n => {
    const norm = normalizeInput(n);
    if (norm && !NORM_TO_ROUTE_KEY[norm]) NORM_TO_ROUTE_KEY[norm] = matchKey;
  });
});

/** Return canonical English neighbours, or [] */
export function getNeighbors(routeKey: string): string[] {
  return NEIGHBOR_GRAPH[routeKey] ?? [];
}

/** Canonical route key → Turkish display name */
export function routeKeyToDisplay(key: string): string {
  const norm = normalizeInput(key);
  for (const entry of COUNTRIES) {
    if (entry.names.some(n => normalizeInput(n) === norm) || normalizeInput(entry.display) === norm)
      return entry.display;
  }
  return key; // fallback: return English key
}

/* ── Country metadata for scoring ── */

/** Countries that are universally famous — bonus for Easy selection */
const FAMOUS_COUNTRIES = new Set([
  "Turkey","Germany","France","Italy","Spain","Poland","Romania","Netherlands",
  "Belgium","Czech Republic","Greece","Hungary","Bulgaria","Serbia","Croatia",
  "Slovakia","Denmark","Finland","Norway","Sweden","Switzerland","Austria",
  "Portugal","Russia","Ukraine","Belarus","Georgia","Armenia","Azerbaijan",
  "Iran","Iraq","Syria","Israel","Jordan","Saudi Arabia","Egypt","Morocco",
  "Algeria","Tunisia","Libya","China","India","Pakistan","Afghanistan",
  "Kazakhstan","Turkey","USA","Canada","Mexico","Brazil","Argentina","Colombia",
  "Venezuela","Chile","Peru","Bolivia","South Africa","Nigeria","Kenya",
  "Ethiopia","Sudan","Angola","Tanzania","Uganda","Cameroon","Ghana",
  "Mozambique","Zambia","Zimbabwe","Thailand","Vietnam","Myanmar","Laos","Cambodia",
  "Malaysia","Bangladesh","Nepal","Mongolia","North Korea","South Korea",
  "Kuwait","UAE","Qatar","Oman","Yemen","Uzbekistan","Turkmenistan","Kyrgyzstan",
  "Tajikistan","Belarus","Latvia","Lithuania","Estonia",
]);

/** Countries considered obscure/remote for routing purposes — penalised in Easy/Normal */
const REMOTE_COUNTRIES = new Set([
  "Lesotho","Eswatini","Djibouti","Eritrea","Burundi","Sierra Leone",
  "Guinea-Bissau","Liberia","Togo","Benin","Equatorial Guinea","Gabon",
  "Republic of Congo","Central African Republic","South Sudan",
  "Suriname","Guyana","Belize","El Salvador","Costa Rica","Nicaragua",
  "Honduras","Panama","Paraguay","Uruguay","Bolivia",
  "Moldova","Montenegro","Kosovo","North Macedonia","Albania",
  "Bhutan","Laos","Brunei","Cambodia","Tajikistan","Kyrgyzstan","Turkmenistan",
]);

/**
 * Broad geographic region — used to detect "far region" pairs.
 * Finer than continent, coarser than country.
 */
const REGION: Record<string, string> = {
  // Western Europe
  "France":"w-europe","Germany":"w-europe","Netherlands":"w-europe","Belgium":"w-europe",
  "Switzerland":"w-europe","Austria":"w-europe","Luxembourg":"w-europe","Denmark":"w-europe",
  "Portugal":"w-europe","Spain":"w-europe","Italy":"w-europe","Sweden":"w-europe",
  "Norway":"w-europe","Finland":"w-europe",
  // Eastern Europe
  "Poland":"e-europe","Czech Republic":"e-europe","Slovakia":"e-europe","Hungary":"e-europe",
  "Romania":"e-europe","Bulgaria":"e-europe","Serbia":"e-europe","Croatia":"e-europe",
  "Slovenia":"e-europe","Bosnia and Herzegovina":"e-europe","Montenegro":"e-europe",
  "North Macedonia":"e-europe","Albania":"e-europe","Greece":"e-europe",
  "Moldova":"e-europe","Ukraine":"e-europe","Belarus":"e-europe",
  "Estonia":"e-europe","Latvia":"e-europe","Lithuania":"e-europe",
  // Eurasia / former Soviet
  "Russia":"eurasia","Turkey":"eurasia","Georgia":"eurasia","Armenia":"eurasia",
  "Azerbaijan":"eurasia","Kazakhstan":"eurasia","Uzbekistan":"eurasia",
  "Kyrgyzstan":"eurasia","Tajikistan":"eurasia","Turkmenistan":"eurasia","Mongolia":"eurasia",
  // Middle East
  "Iran":"mideast","Iraq":"mideast","Syria":"mideast","Lebanon":"mideast","Israel":"mideast",
  "Jordan":"mideast","Saudi Arabia":"mideast","Kuwait":"mideast","UAE":"mideast",
  "Qatar":"mideast","Oman":"mideast","Yemen":"mideast",
  // South Asia
  "Pakistan":"s-asia","India":"s-asia","Afghanistan":"s-asia","Nepal":"s-asia",
  "Bhutan":"s-asia","Bangladesh":"s-asia",
  // Southeast Asia
  "Myanmar":"se-asia","Thailand":"se-asia","Laos":"se-asia","Vietnam":"se-asia",
  "Cambodia":"se-asia","Malaysia":"se-asia",
  // East Asia
  "China":"e-asia","North Korea":"e-asia","South Korea":"e-asia",
  // North Africa
  "Morocco":"n-africa","Algeria":"n-africa","Tunisia":"n-africa","Libya":"n-africa","Egypt":"n-africa",
  // West Africa
  "Mauritania":"w-africa","Senegal":"w-africa","Guinea-Bissau":"w-africa","Guinea":"w-africa",
  "Sierra Leone":"w-africa","Liberia":"w-africa","Ivory Coast":"w-africa","Ghana":"w-africa",
  "Togo":"w-africa","Benin":"w-africa","Nigeria":"w-africa","Burkina Faso":"w-africa","Mali":"w-africa","Niger":"w-africa",
  // Central Africa
  "Chad":"c-africa","Cameroon":"c-africa","Central African Republic":"c-africa",
  "Equatorial Guinea":"c-africa","Gabon":"c-africa","Republic of Congo":"c-africa",
  "Democratic Republic of Congo":"c-africa","Rwanda":"c-africa","Burundi":"c-africa",
  // East Africa
  "Sudan":"e-africa","South Sudan":"e-africa","Ethiopia":"e-africa","Eritrea":"e-africa",
  "Djibouti":"e-africa","Somalia":"e-africa","Kenya":"e-africa","Uganda":"e-africa",
  "Tanzania":"e-africa","Malawi":"e-africa",
  // Southern Africa
  "Angola":"s-africa","Zambia":"s-africa","Mozambique":"s-africa","Zimbabwe":"s-africa",
  "Botswana":"s-africa","Namibia":"s-africa","South Africa":"s-africa",
  "Eswatini":"s-africa","Lesotho":"s-africa",
  // Americas
  "USA":"n-america","Canada":"n-america","Mexico":"n-america",
  "Guatemala":"c-america","Belize":"c-america","Honduras":"c-america",
  "El Salvador":"c-america","Nicaragua":"c-america","Costa Rica":"c-america","Panama":"c-america",
  "Colombia":"n-s-america","Venezuela":"n-s-america","Guyana":"n-s-america",
  "Suriname":"n-s-america","Brazil":"n-s-america","Ecuador":"n-s-america","Peru":"n-s-america",
  "Bolivia":"s-america","Paraguay":"s-america","Chile":"s-america",
  "Argentina":"s-america","Uruguay":"s-america",
};

/**
 * Composite difficulty score for a (start→end) pair.
 * Higher = harder.
 *
 * Components:
 *   base     = BFS distance × 10
 *   +cross   = +20 if different region groups, +35 if very far regions
 *   +remote  = +15 per remote country (start or end)
 *   −famous  = −8 per famous country (start or end)
 */
function scorePair(start: string, end: string, dist: number): number {
  let score = dist * 10;

  const rs = REGION[start] ?? "unknown";
  const re = REGION[end]   ?? "unknown";

  if (rs !== re) {
    // Penalise cross-region pairs proportionally to how "far apart" regions are
    const farPairs = new Set([
      "w-europe|se-asia","w-europe|e-asia","w-europe|s-asia",
      "e-europe|se-asia","e-europe|e-asia","e-europe|s-asia",
      "w-europe|s-africa","w-europe|c-africa","w-europe|e-africa",
      "eurasia|se-asia","eurasia|e-asia","eurasia|s-africa",
      "n-america|e-africa","n-america|c-africa","n-america|s-africa",
      "n-america|se-asia","n-america|mideast",
      "s-america|n-africa","s-america|e-africa","s-america|mideast",
      "s-america|se-asia","s-america|e-asia","s-america|s-asia",
    ]);
    const pair1 = rs + "|" + re;
    const pair2 = re + "|" + rs;
    score += farPairs.has(pair1) || farPairs.has(pair2) ? 35 : 20;
  }

  if (REMOTE_COUNTRIES.has(start)) score += 15;
  if (REMOTE_COUNTRIES.has(end))   score += 15;
  if (FAMOUS_COUNTRIES.has(start)) score -= 8;
  if (FAMOUS_COUNTRIES.has(end))   score -= 8;

  return Math.max(0, score);
}

/**
 * Score thresholds that map to Easy / Normal / Hard.
 *
 * Calibrated by testing known pairs:
 *   Turkey→Germany    dist=4, same region → score≈40−16=24  → Easy (border Easy/Normal)
 *   France→Poland     dist=2, same region → score≈20−16=4   → Easy
 *   Turkey→Iran       dist=1              → score≈10−16=0   → Easy (too simple; filtered by minDist)
 *   Slovenia→Myanmar  dist=6, far regions → score≈60+35=95  → Hard
 *   Germany→China     dist=5, far regions → score≈50+35=85  → Hard
 *   Turkey→Russia     dist=2, same region → score≈20−16=4   → Easy
 *   Egypt→Nigeria     dist=3, same region → score≈30−8=22   → Easy
 *   Brazil→Colombia   dist=1              → Easy (filtered)
 *   Brazil→Argentina  dist=1              → Easy (filtered)
 *   USA→Mexico        dist=1              → Easy (filtered)
 */
export type RouteDifficulty = "easy" | "normal" | "hard";

interface DiffBand {
  minScore: number;
  maxScore: number;
  minDist:  number;
  maxDist:  number;
}

// dist = edge count (BFS path length - 1).
// With neighbor-win rule, player can finish in dist-1 steps.
// "ara ülke" = intermediate countries written = dist - 1 (optimal).
// To guarantee ≥N ara ülke, require dist ≥ N+1.
const DIFF_BAND: Record<RouteDifficulty, DiffBand> = {
  easy:   { minScore:  0, maxScore: 45, minDist: 3, maxDist:  4 },
  normal: { minScore: 35, maxScore: 72, minDist: 5, maxDist:  6 },
  hard:   { minScore: 65, maxScore: 999, minDist: 7, maxDist: 20 },
};

/* ── Fallbacks ── */
const FALLBACKS: Record<RouteDifficulty, { start: string; end: string }> = {
  easy:   { start: "Germany",    end: "Romania"  },  // dist=3, score≈34
  normal: { start: "Kazakhstan", end: "France"   },  // dist=5, score≈54
  hard:   { start: "Slovenia",   end: "Myanmar"  },  // dist=8+
};

/* ── BFS ── */
export function bfsPath(start: string, end: string): string[] | null {
  if (start === end) return [start];
  const visited = new Set<string>([start]);
  const queue: string[][] = [[start]];
  while (queue.length) {
    const path = queue.shift()!;
    const cur  = path[path.length - 1];
    for (const nb of (NEIGHBOR_GRAPH[cur] ?? [])) {
      if (visited.has(nb)) continue;
      const next = [...path, nb];
      if (nb === end) return next;
      visited.add(nb);
      queue.push(next);
    }
  }
  return null;
}

export function bfsDist(start: string, end: string): number {
  const p = bfsPath(start, end);
  return p ? p.length - 1 : Infinity;
}

/**
 * Pick a random (start, end) pair whose composite difficulty score
 * falls within the target band.
 */
export function randomRouteTask(
  difficulty: RouteDifficulty,
  maxAttempts = 400
): { start: string; end: string } {
  const band = DIFF_BAND[difficulty];
  const keys = GRAPH_KEYS.slice();
  const n    = keys.length;

  for (let i = 0; i < maxAttempts; i++) {
    const si    = Math.floor(Math.random() * n);
    const ei    = Math.floor(Math.random() * (n - 1));
    const start = keys[si];
    const end   = keys[ei < si ? ei : ei + 1];

    const dist = bfsDist(start, end);
    if (dist < band.minDist || dist > band.maxDist) continue;

    const score = scorePair(start, end, dist);
    if (score >= band.minScore && score <= band.maxScore) {
      return { start, end };
    }
  }

  return FALLBACKS[difficulty];
}

/* ═══════════════════════════════════════════════════════════════
   SILHOUETTE MODE — curated metadata
   Pools, subregions, landlocked status, neighbor lookup.
═══════════════════════════════════════════════════════════════ */

/**
 * Silhouette-mode difficulty overrides, keyed by ISO alpha-2 code.
 * These tune pool composition to shape recognizability rather than
 * the more general fame-based difficulty used in flag mode.
 *
 * - easy/normal/hard pools below are EXACT lists; countries outside
 *   any pool only appear when the user picks "Tümü" (all).
 */
const SIL_EASY_CODES = new Set<string>([
  "tr","us","ca","br","ar","cl","mx","ru","cn","in","jp","au",
  "it","fr","de","es","gb","no","se","fi","eg","za","sa","ir","kz",
]);
const SIL_NORMAL_CODES = new Set<string>([
  "pl","ua","ro","gr","bg","rs","hu","at","pt","nl","be","ch",
  "ma","dz","ly","et","ke","tz","co","pe","ve","pk","th","vn",
  "ph","my","id","kr","kp",
]);
const SIL_HARD_CODES = new Set<string>([
  "bt","np","la","kh","bn","tl","lk","mv","bh","qa","kw","lb",
  "jo","am","ge","md","si","sk","hr","ba","me","xk","al","mk",
  "ee","lv","lt","is","ie","mt","cy","lu","ad","mc","sm","li",
  "bz","sv","hn","ni","cr","pa","jm","ht","do","tt","fj","ws",
  "to","vu","sb",
]);

function silhouetteBucket(entry: CountryEntry): "easy" | "normal" | "hard" | null {
  if (SIL_EASY_CODES.has(entry.code))   return "easy";
  if (SIL_NORMAL_CODES.has(entry.code)) return "normal";
  if (SIL_HARD_CODES.has(entry.code))   return "hard";
  return null;
}

/**
 * Silhouette-mode pool builder.
 * - difficulty="all": all counted countries (with topoId), continent-filtered
 * - difficulty="easy"|"normal"|"hard": ONLY countries listed in the matching
 *   curated set above (continent-filtered)
 */
export function getSilhouettePool(
  continent: Continent | "world",
  difficulty: Difficulty = "all"
): CountryEntry[] {
  let pool = COUNTRIES.filter(c => c.counted && c.code && c.topoId);
  if (continent !== "world") pool = pool.filter(c => c.continent === continent);
  if (difficulty === "all") return pool;
  return pool.filter(c => silhouetteBucket(c) === difficulty);
}

/**
 * Sub-region (Turkish) for silhouette region hint.
 * Returns null when the code is not mapped — caller should hide the hint chip.
 */
const SIL_SUBREGION: Record<string, string> = {
  // ── EUROPE ──
  // Balkanlar
  "al":"Balkanlar","ba":"Balkanlar","hr":"Balkanlar","me":"Balkanlar",
  "mk":"Balkanlar","rs":"Balkanlar","si":"Balkanlar","xk":"Balkanlar",
  // Batı Avrupa
  "fr":"Batı Avrupa","de":"Batı Avrupa","nl":"Batı Avrupa","be":"Batı Avrupa",
  "ch":"Batı Avrupa","at":"Batı Avrupa","lu":"Batı Avrupa","gb":"Batı Avrupa",
  "ie":"Batı Avrupa","mc":"Batı Avrupa","li":"Batı Avrupa",
  // Kuzey Avrupa
  "dk":"Kuzey Avrupa","se":"Kuzey Avrupa","no":"Kuzey Avrupa",
  "fi":"Kuzey Avrupa","is":"Kuzey Avrupa","ee":"Kuzey Avrupa",
  "lv":"Kuzey Avrupa","lt":"Kuzey Avrupa",
  // Güney Avrupa
  "it":"Güney Avrupa","es":"Güney Avrupa","pt":"Güney Avrupa","gr":"Güney Avrupa",
  "mt":"Güney Avrupa","cy":"Güney Avrupa","ad":"Güney Avrupa",
  "sm":"Güney Avrupa","va":"Güney Avrupa",
  // Doğu Avrupa
  "pl":"Doğu Avrupa","cz":"Doğu Avrupa","sk":"Doğu Avrupa","hu":"Doğu Avrupa",
  "ro":"Doğu Avrupa","bg":"Doğu Avrupa","by":"Doğu Avrupa","ua":"Doğu Avrupa",
  "md":"Doğu Avrupa","ru":"Doğu Avrupa",

  // ── ASIA ──
  // Orta Doğu
  "tr":"Orta Doğu","ir":"Orta Doğu","iq":"Orta Doğu","il":"Orta Doğu",
  "sy":"Orta Doğu","lb":"Orta Doğu","jo":"Orta Doğu","sa":"Orta Doğu",
  "ye":"Orta Doğu","om":"Orta Doğu","ae":"Orta Doğu","qa":"Orta Doğu",
  "kw":"Orta Doğu","bh":"Orta Doğu","ps":"Orta Doğu",
  // Kafkaslar
  "am":"Kafkaslar","az":"Kafkaslar","ge":"Kafkaslar",
  // Orta Asya
  "kz":"Orta Asya","uz":"Orta Asya","tm":"Orta Asya","tj":"Orta Asya",
  "kg":"Orta Asya","mn":"Orta Asya","af":"Orta Asya",
  // Güney Asya
  "in":"Güney Asya","pk":"Güney Asya","bd":"Güney Asya","lk":"Güney Asya",
  "mv":"Güney Asya","np":"Güney Asya","bt":"Güney Asya",
  // Güneydoğu Asya
  "id":"Güneydoğu Asya","my":"Güneydoğu Asya","sg":"Güneydoğu Asya",
  "th":"Güneydoğu Asya","vn":"Güneydoğu Asya","ph":"Güneydoğu Asya",
  "mm":"Güneydoğu Asya","kh":"Güneydoğu Asya","la":"Güneydoğu Asya",
  "bn":"Güneydoğu Asya","tl":"Güneydoğu Asya",
  // Doğu Asya
  "cn":"Doğu Asya","jp":"Doğu Asya","kr":"Doğu Asya","kp":"Doğu Asya",
  "tw":"Doğu Asya",

  // ── AFRICA ──
  // Kuzey Afrika
  "eg":"Kuzey Afrika","ly":"Kuzey Afrika","tn":"Kuzey Afrika","dz":"Kuzey Afrika",
  "ma":"Kuzey Afrika","sd":"Kuzey Afrika",
  // Batı Afrika
  "mr":"Batı Afrika","ml":"Batı Afrika","ne":"Batı Afrika","ng":"Batı Afrika",
  "sn":"Batı Afrika","gm":"Batı Afrika","gn":"Batı Afrika","gw":"Batı Afrika",
  "sl":"Batı Afrika","lr":"Batı Afrika","ci":"Batı Afrika","gh":"Batı Afrika",
  "tg":"Batı Afrika","bj":"Batı Afrika","bf":"Batı Afrika","cv":"Batı Afrika",
  // Doğu Afrika
  "et":"Doğu Afrika","er":"Doğu Afrika","dj":"Doğu Afrika","so":"Doğu Afrika",
  "ke":"Doğu Afrika","tz":"Doğu Afrika","ug":"Doğu Afrika","rw":"Doğu Afrika",
  "bi":"Doğu Afrika","ss":"Doğu Afrika","mw":"Doğu Afrika","mz":"Doğu Afrika",
  "mg":"Doğu Afrika","mu":"Doğu Afrika","km":"Doğu Afrika","sc":"Doğu Afrika",
  // Orta Afrika
  "td":"Orta Afrika","cm":"Orta Afrika","cf":"Orta Afrika","gq":"Orta Afrika",
  "ga":"Orta Afrika","cg":"Orta Afrika","cd":"Orta Afrika","st":"Orta Afrika",
  // Güney Afrika
  "za":"Güney Afrika","na":"Güney Afrika","bw":"Güney Afrika","zw":"Güney Afrika",
  "zm":"Güney Afrika","ao":"Güney Afrika","ls":"Güney Afrika","sz":"Güney Afrika",

  // ── AMERICAS ──
  "us":"Kuzey Amerika","ca":"Kuzey Amerika","mx":"Kuzey Amerika",
  "bz":"Orta Amerika","gt":"Orta Amerika","hn":"Orta Amerika",
  "sv":"Orta Amerika","ni":"Orta Amerika","cr":"Orta Amerika","pa":"Orta Amerika",
  "cu":"Karayipler","jm":"Karayipler","ht":"Karayipler","do":"Karayipler",
  "tt":"Karayipler","bs":"Karayipler","bb":"Karayipler","ag":"Karayipler",
  "dm":"Karayipler","gd":"Karayipler","kn":"Karayipler","lc":"Karayipler",
  "vc":"Karayipler",
  "ar":"Güney Amerika","br":"Güney Amerika","cl":"Güney Amerika","co":"Güney Amerika",
  "pe":"Güney Amerika","ve":"Güney Amerika","ec":"Güney Amerika","bo":"Güney Amerika",
  "py":"Güney Amerika","uy":"Güney Amerika","gy":"Güney Amerika","sr":"Güney Amerika",

  // ── OCEANIA ──
  "au":"Okyanusya","nz":"Okyanusya","fj":"Okyanusya","vu":"Okyanusya",
  "sb":"Okyanusya","pg":"Okyanusya","ws":"Okyanusya","to":"Okyanusya",
  "tv":"Okyanusya","ki":"Okyanusya","mh":"Okyanusya","fm":"Okyanusya",
  "nr":"Okyanusya","pw":"Okyanusya",
};

export function getSilhouetteRegion(code: string): string | null {
  return SIL_SUBREGION[code] ?? null;
}

/**
 * Landlocked countries (no sea/ocean coastline).
 * Caspian-bordering states are treated as landlocked, following UN usage.
 */
const SIL_LANDLOCKED = new Set<string>([
  // Europe
  "ad","at","by","cz","hu","li","lu","md","mk","sm","rs","sk","ch","va","xk",
  // Asia
  "af","am","az","bt","kz","kg","la","mn","np","tj","tm","uz",
  // Africa
  "bw","bf","bi","cf","td","sz","et","ls","mw","ml","ne","rw","ss","ug","zm","zw",
  // South America
  "bo","py",
]);

export function isLandlocked(code: string): boolean {
  return SIL_LANDLOCKED.has(code);
}

/**
 * Land-border neighbor count derived from the Route Mode graph.
 * Returns null when the country is not represented in NEIGHBOR_GRAPH
 * (mostly islands / micro-states) — caller should hide the hint chip.
 */
export function getNeighborCount(entry: CountryEntry): number | null {
  const candidates = [entry.display, ...entry.names];
  for (const cand of candidates) {
    const key = NORM_TO_ROUTE_KEY[normalizeInput(cand)];
    if (key && NEIGHBOR_GRAPH[key]) return NEIGHBOR_GRAPH[key].length;
  }
  return null;
}
