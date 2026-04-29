/**
 * countries.ts  — world-atlas@2 ground truth, zero-padded IDs.
 *
 * NEW in Faz 2:
 *   • continent field on each entry  ("europe"|"asia"|"africa"|"americas"|"oceania"|"other")
 *   • CONTINENT_IDS map exported for fast filtering
 */

export type Continent = "europe" | "asia" | "africa" | "americas" | "oceania" | "other";

export interface CountryEntry {
  topoId:    string;
  display:   string;
  names:     string[];
  continent: Continent;
}

/* ── Normalizer ── */
export function normalizeInput(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\u0131/g, "i")   // dotless-i
    .replace(/\u011f/g, "g")   // g-breve
    .replace(/\xfc/g,   "u")   // u-umlaut
    .replace(/\u015f/g, "s")   // s-cedilla
    .replace(/\xf6/g,   "o")   // o-umlaut
    .replace(/\xe7/g,   "c")   // c-cedilla
    .replace(/\u0130/g, "i")   // capital dotted I
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[-\u2013\u2014_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ── Country list with continents ── */
export const COUNTRIES: CountryEntry[] = [
  // ── EUROPE ──
  { topoId:"008", display:"Arnavutluk",               continent:"europe",   names:["arnavutluk","albania"] },
  { topoId:"040", display:"Avusturya",                continent:"europe",   names:["avusturya","austria"] },
  { topoId:"056", display:"Belçika",                  continent:"europe",   names:["belcika","belgium"] },
  { topoId:"070", display:"Bosna Hersek",              continent:"europe",   names:["bosna hersek","bosna-hersek","bosnia","bosnia and herzegov","bosnia and herzegovina"] },
  { topoId:"100", display:"Bulgaristan",               continent:"europe",   names:["bulgaristan","bulgaria"] },
  { topoId:"191", display:"Hırvatistan",               continent:"europe",   names:["hirvatistan","croatia"] },
  { topoId:"196", display:"Kıbrıs",                   continent:"europe",   names:["kibris","cyprus"] },
  { topoId:"203", display:"Çekya",                    continent:"europe",   names:["cekya","czechia","czech republic","cek cumhuriyeti"] },
  { topoId:"208", display:"Danimarka",                continent:"europe",   names:["danimarka","denmark"] },
  { topoId:"233", display:"Estonya",                  continent:"europe",   names:["estonya","estonia"] },
  { topoId:"246", display:"Finlandiya",               continent:"europe",   names:["finlandiya","finland"] },
  { topoId:"250", display:"Fransa",                   continent:"europe",   names:["fransa","france"] },
  { topoId:"276", display:"Almanya",                  continent:"europe",   names:["almanya","germany"] },
  { topoId:"300", display:"Yunanistan",               continent:"europe",   names:["yunanistan","greece"] },
  { topoId:"348", display:"Macaristan",               continent:"europe",   names:["macaristan","hungary"] },
  { topoId:"352", display:"İzlanda",                  continent:"europe",   names:["izlanda","iceland"] },
  { topoId:"372", display:"İrlanda",                  continent:"europe",   names:["irlanda","ireland"] },
  { topoId:"380", display:"İtalya",                   continent:"europe",   names:["italya","italy"] },
  { topoId:"428", display:"Letonya",                  continent:"europe",   names:["letonya","latvia"] },
  { topoId:"440", display:"Litvanya",                 continent:"europe",   names:["litvanya","lithuania"] },
  { topoId:"442", display:"Lüksemburg",               continent:"europe",   names:["luksemburg","luxembourg"] },
  { topoId:"498", display:"Moldova",                  continent:"europe",   names:["moldova"] },
  { topoId:"499", display:"Karadağ",                  continent:"europe",   names:["karadag","montenegro"] },
  { topoId:"528", display:"Hollanda",                 continent:"europe",   names:["hollanda","netherlands","holland"] },
  { topoId:"807", display:"Kuzey Makedonya",          continent:"europe",   names:["kuzey makedonya","north macedonia","makedonya","macedonia"] },
  { topoId:"578", display:"Norveç",                   continent:"europe",   names:["norvec","norway"] },
  { topoId:"616", display:"Polonya",                  continent:"europe",   names:["polonya","poland"] },
  { topoId:"620", display:"Portekiz",                 continent:"europe",   names:["portekiz","portugal"] },
  { topoId:"642", display:"Romanya",                  continent:"europe",   names:["romanya","romania"] },
  { topoId:"643", display:"Rusya",                    continent:"europe",   names:["rusya","russia","russian federation"] },
  { topoId:"688", display:"Sırbistan",                continent:"europe",   names:["sirbistan","serbia"] },
  { topoId:"703", display:"Slovakya",                 continent:"europe",   names:["slovakya","slovakia"] },
  { topoId:"705", display:"Slovenya",                 continent:"europe",   names:["slovenya","slovenia"] },
  { topoId:"724", display:"İspanya",                  continent:"europe",   names:["ispanya","spain"] },
  { topoId:"752", display:"İsveç",                    continent:"europe",   names:["isvec","sweden"] },
  { topoId:"756", display:"İsviçre",                  continent:"europe",   names:["isvicre","switzerland"] },
  { topoId:"792", display:"Türkiye",                  continent:"europe",   names:["turkiye","turkey"] },
  { topoId:"804", display:"Ukrayna",                  continent:"europe",   names:["ukrayna","ukraine"] },
  { topoId:"826", display:"Birleşik Krallık",         continent:"europe",   names:["birlesik krallik","united kingdom","uk","ingiltere","england","great britain","britain"] },
  { topoId:"112", display:"Belarus",                  continent:"europe",   names:["belarus","beyaz rusya"] },

  // ── ASIA ──
  { topoId:"004", display:"Afganistan",               continent:"asia",     names:["afganistan","afghanistan"] },
  { topoId:"031", display:"Azerbaycan",               continent:"asia",     names:["azerbaycan","azerbaijan"] },
  { topoId:"050", display:"Bangladeş",                continent:"asia",     names:["banglades","bangladesh"] },
  { topoId:"064", display:"Butan",                    continent:"asia",     names:["butan","bhutan"] },
  { topoId:"096", display:"Brunei",                   continent:"asia",     names:["brunei"] },
  { topoId:"116", display:"Kamboçya",                 continent:"asia",     names:["kambocya","cambodia"] },
  { topoId:"156", display:"Çin",                      continent:"asia",     names:["cin","china"] },
  { topoId:"268", display:"Gürcistan",                continent:"asia",     names:["gurcistan","georgia"] },
  { topoId:"356", display:"Hindistan",                continent:"asia",     names:["hindistan","india"] },
  { topoId:"360", display:"Endonezya",                continent:"asia",     names:["endonezya","indonesia"] },
  { topoId:"364", display:"İran",                     continent:"asia",     names:["iran"] },
  { topoId:"368", display:"Irak",                     continent:"asia",     names:["irak","iraq"] },
  { topoId:"376", display:"İsrail",                   continent:"asia",     names:["israil","israel"] },
  { topoId:"392", display:"Japonya",                  continent:"asia",     names:["japonya","japan"] },
  { topoId:"400", display:"Ürdün",                    continent:"asia",     names:["urdun","jordan"] },
  { topoId:"398", display:"Kazakistan",               continent:"asia",     names:["kazakistan","kazakhstan"] },
  { topoId:"414", display:"Kuveyt",                   continent:"asia",     names:["kuveyt","kuwait"] },
  { topoId:"417", display:"Kırgızistan",              continent:"asia",     names:["kirgizistan","kyrgyzstan"] },
  { topoId:"418", display:"Laos",                     continent:"asia",     names:["laos"] },
  { topoId:"422", display:"Lübnan",                   continent:"asia",     names:["lubnan","lebanon"] },
  { topoId:"458", display:"Malezya",                  continent:"asia",     names:["malezya","malaysia"] },
  { topoId:"462", display:"Maldivler",                continent:"asia",     names:["maldivler","maldives"] },
  { topoId:"496", display:"Moğolistan",               continent:"asia",     names:["mogolistan","mongolia"] },
  { topoId:"104", display:"Myanmar",                  continent:"asia",     names:["myanmar","burma"] },
  { topoId:"524", display:"Nepal",                    continent:"asia",     names:["nepal"] },
  { topoId:"408", display:"Kuzey Kore",               continent:"asia",     names:["kuzey kore","north korea"] },
  { topoId:"512", display:"Umman",                    continent:"asia",     names:["umman","oman"] },
  { topoId:"586", display:"Pakistan",                 continent:"asia",     names:["pakistan"] },
  { topoId:"275", display:"Filistin",                 continent:"asia",     names:["filistin","palestine"] },
  { topoId:"608", display:"Filipinler",               continent:"asia",     names:["filipinler","philippines"] },
  { topoId:"634", display:"Katar",                    continent:"asia",     names:["katar","qatar"] },
  { topoId:"682", display:"Suudi Arabistan",          continent:"asia",     names:["suudi arabistan","saudi arabia"] },
  { topoId:"702", display:"Singapur",                 continent:"asia",     names:["singapur","singapore"] },
  { topoId:"410", display:"Güney Kore",               continent:"asia",     names:["guney kore","south korea","korea"] },
  { topoId:"144", display:"Sri Lanka",                continent:"asia",     names:["sri lanka"] },
  { topoId:"760", display:"Suriye",                   continent:"asia",     names:["suriye","syria"] },
  { topoId:"158", display:"Tayvan",                   continent:"asia",     names:["tayvan","taiwan"] },
  { topoId:"762", display:"Tacikistan",               continent:"asia",     names:["tacikistan","tajikistan"] },
  { topoId:"764", display:"Tayland",                  continent:"asia",     names:["tayland","thailand"] },
  { topoId:"626", display:"Doğu Timor",               continent:"asia",     names:["dogu timor","east timor","timor leste","timor-leste"] },
  { topoId:"795", display:"Türkmenistan",             continent:"asia",     names:["turkmenistan"] },
  { topoId:"784", display:"BAE",                      continent:"asia",     names:["birlesik arap emirlikleri","bae","united arab emirates","uae"] },
  { topoId:"860", display:"Özbekistan",               continent:"asia",     names:["ozbekistan","uzbekistan"] },
  { topoId:"704", display:"Vietnam",                  continent:"asia",     names:["vietnam"] },
  { topoId:"887", display:"Yemen",                    continent:"asia",     names:["yemen"] },
  { topoId:"051", display:"Ermenistan",               continent:"asia",     names:["ermenistan","armenia"] },

  // ── AFRICA ──
  { topoId:"012", display:"Cezayir",                  continent:"africa",   names:["cezayir","algeria"] },
  { topoId:"024", display:"Angola",                   continent:"africa",   names:["angola"] },
  { topoId:"204", display:"Benin",                    continent:"africa",   names:["benin"] },
  { topoId:"072", display:"Botsvana",                 continent:"africa",   names:["botsvana","botswana"] },
  { topoId:"854", display:"Burkina Faso",             continent:"africa",   names:["burkina faso"] },
  { topoId:"108", display:"Burundi",                  continent:"africa",   names:["burundi"] },
  { topoId:"120", display:"Kamerun",                  continent:"africa",   names:["kamerun","cameroon"] },
  { topoId:"140", display:"Orta Afrika Cumhuriyeti",  continent:"africa",   names:["orta afrika cumhuriyeti","central african rep","central african republic"] },
  { topoId:"148", display:"Çad",                      continent:"africa",   names:["cad","chad"] },
  { topoId:"178", display:"Kongo Cumhuriyeti",        continent:"africa",   names:["kongo cumhuriyeti","congo","republic of congo"] },
  { topoId:"180", display:"Kongo DR",                 continent:"africa",   names:["kongo dr","demokratik kongo","dr congo","dem rep congo","democratic republic of the congo","drc"] },
  { topoId:"262", display:"Cibuti",                   continent:"africa",   names:["cibuti","djibouti"] },
  { topoId:"818", display:"Mısır",                    continent:"africa",   names:["misir","egypt"] },
  { topoId:"226", display:"Ekvator Ginesi",           continent:"africa",   names:["ekvator ginesi","eq guinea","equatorial guinea"] },
  { topoId:"232", display:"Eritre",                   continent:"africa",   names:["eritre","eritrea"] },
  { topoId:"231", display:"Etiyopya",                 continent:"africa",   names:["etiyopya","ethiopia"] },
  { topoId:"266", display:"Gabon",                    continent:"africa",   names:["gabon"] },
  { topoId:"270", display:"Gambiya",                  continent:"africa",   names:["gambiya","gambia","the gambia"] },
  { topoId:"288", display:"Gana",                     continent:"africa",   names:["gana","ghana"] },
  { topoId:"324", display:"Gine",                     continent:"africa",   names:["gine","guinea"] },
  { topoId:"624", display:"Gine-Bissau",              continent:"africa",   names:["gine bissau","guinea bissau","guinea-bissau"] },
  { topoId:"384", display:"Fildişi Sahili",           continent:"africa",   names:["fildisi sahili","ivory coast","cote d ivoire","cote divoire"] },
  { topoId:"404", display:"Kenya",                    continent:"africa",   names:["kenya"] },
  { topoId:"426", display:"Lesoto",                   continent:"africa",   names:["lesoto","lesotho"] },
  { topoId:"430", display:"Liberya",                  continent:"africa",   names:["liberya","liberia"] },
  { topoId:"434", display:"Libya",                    continent:"africa",   names:["libya"] },
  { topoId:"450", display:"Madagaskar",               continent:"africa",   names:["madagaskar","madagascar"] },
  { topoId:"454", display:"Malavi",                   continent:"africa",   names:["malavi","malawi"] },
  { topoId:"466", display:"Mali",                     continent:"africa",   names:["mali"] },
  { topoId:"478", display:"Moritanya",                continent:"africa",   names:["moritanya","mauritania"] },
  { topoId:"504", display:"Fas",                      continent:"africa",   names:["fas","morocco"] },
  { topoId:"508", display:"Mozambik",                 continent:"africa",   names:["mozambik","mozambique"] },
  { topoId:"516", display:"Namibya",                  continent:"africa",   names:["namibya","namibia"] },
  { topoId:"562", display:"Nijer",                    continent:"africa",   names:["nijer","niger"] },
  { topoId:"566", display:"Nijerya",                  continent:"africa",   names:["nijerya","nigeria"] },
  { topoId:"646", display:"Ruanda",                   continent:"africa",   names:["ruanda","rwanda"] },
  { topoId:"686", display:"Senegal",                  continent:"africa",   names:["senegal"] },
  { topoId:"694", display:"Sierra Leone",             continent:"africa",   names:["sierra leone"] },
  { topoId:"706", display:"Somali",                   continent:"africa",   names:["somali","somalia"] },
  { topoId:"710", display:"Güney Afrika",             continent:"africa",   names:["guney afrika","south africa"] },
  { topoId:"728", display:"Güney Sudan",              continent:"africa",   names:["guney sudan","south sudan","s sudan"] },
  { topoId:"729", display:"Sudan",                    continent:"africa",   names:["sudan"] },
  { topoId:"748", display:"Esvatini",                 continent:"africa",   names:["esvatini","eswatini","swaziland"] },
  { topoId:"834", display:"Tanzanya",                 continent:"africa",   names:["tanzanya","tanzania"] },
  { topoId:"768", display:"Togo",                     continent:"africa",   names:["togo"] },
  { topoId:"788", display:"Tunus",                    continent:"africa",   names:["tunus","tunisia"] },
  { topoId:"800", display:"Uganda",                   continent:"africa",   names:["uganda"] },
  { topoId:"716", display:"Zimbabve",                 continent:"africa",   names:["zimbabve","zimbabwe"] },
  { topoId:"894", display:"Zambiya",                  continent:"africa",   names:["zambiya","zambia"] },

  // ── AMERICAS ──
  { topoId:"032", display:"Arjantin",                 continent:"americas", names:["arjantin","argentina"] },
  { topoId:"044", display:"Bahamalar",                continent:"americas", names:["bahamalar","bahamas","the bahamas"] },
  { topoId:"084", display:"Belize",                   continent:"americas", names:["belize"] },
  { topoId:"068", display:"Bolivya",                  continent:"americas", names:["bolivya","bolivia"] },
  { topoId:"076", display:"Brezilya",                 continent:"americas", names:["brezilya","brazil","brasil"] },
  { topoId:"124", display:"Kanada",                   continent:"americas", names:["kanada","canada"] },
  { topoId:"152", display:"Şili",                     continent:"americas", names:["sili","chile"] },
  { topoId:"170", display:"Kolombiya",                continent:"americas", names:["kolombiya","colombia"] },
  { topoId:"188", display:"Kosta Rika",               continent:"americas", names:["kosta rika","costa rica"] },
  { topoId:"192", display:"Küba",                     continent:"americas", names:["kuba","cuba"] },
  { topoId:"214", display:"Dominik Cumhuriyeti",      continent:"americas", names:["dominik cumhuriyeti","dominican rep","dominican republic"] },
  { topoId:"218", display:"Ekvador",                  continent:"americas", names:["ekvador","ecuador"] },
  { topoId:"222", display:"El Salvador",              continent:"americas", names:["el salvador"] },
  { topoId:"304", display:"Grönland",                 continent:"americas", names:["gronland","greenland"] },
  { topoId:"320", display:"Guatemala",                continent:"americas", names:["guatemala"] },
  { topoId:"328", display:"Guyana",                   continent:"americas", names:["guyana"] },
  { topoId:"332", display:"Haiti",                    continent:"americas", names:["haiti"] },
  { topoId:"340", display:"Honduras",                 continent:"americas", names:["honduras"] },
  { topoId:"388", display:"Jamaika",                  continent:"americas", names:["jamaika","jamaica"] },
  { topoId:"484", display:"Meksika",                  continent:"americas", names:["meksika","mexico"] },
  { topoId:"558", display:"Nikaragua",                continent:"americas", names:["nikaragua","nicaragua"] },
  { topoId:"591", display:"Panama",                   continent:"americas", names:["panama"] },
  { topoId:"600", display:"Paraguay",                 continent:"americas", names:["paraguay"] },
  { topoId:"604", display:"Peru",                     continent:"americas", names:["peru"] },
  { topoId:"740", display:"Surinam",                  continent:"americas", names:["surinam","suriname"] },
  { topoId:"780", display:"Trinidad ve Tobago",       continent:"americas", names:["trinidad ve tobago","trinidad and tobago","trinidad"] },
  { topoId:"840", display:"ABD",                      continent:"americas", names:["abd","usa","us","america","united states","united states of america","amerikan"] },
  { topoId:"858", display:"Uruguay",                  continent:"americas", names:["uruguay"] },
  { topoId:"862", display:"Venezuela",                continent:"americas", names:["venezuela"] },

  // ── OCEANIA ──
  { topoId:"036", display:"Avustralya",               continent:"oceania",  names:["avustralya","australia"] },
  { topoId:"242", display:"Fiji",                     continent:"oceania",  names:["fiji"] },
  { topoId:"540", display:"Yeni Kaledonya",           continent:"oceania",  names:["yeni kaledonya","new caledonia"] },
  { topoId:"554", display:"Yeni Zelanda",             continent:"oceania",  names:["yeni zelanda","new zealand"] },
  { topoId:"598", display:"Papua Yeni Gine",          continent:"oceania",  names:["papua yeni gine","papua new guinea"] },
  { topoId:"090", display:"Solomon Adaları",          continent:"oceania",  names:["solomon adalari","solomon adaları","solomon islands","solomon is"] },
  { topoId:"548", display:"Vanuatu",                  continent:"oceania",  names:["vanuatu"] },
];

/* ── Lookup tables ── */
export const NAME_TO_TOPOID:    Record<string,string>    = {};
export const TOPOID_TO_DISPLAY: Record<string,string>    = {};
export const TOPOID_TO_CONTINENT: Record<string,Continent> = {};

COUNTRIES.forEach(({ topoId, display, names, continent }) => {
  TOPOID_TO_DISPLAY[topoId]   = display;
  TOPOID_TO_CONTINENT[topoId] = continent;
  names.forEach((n) => {
    const key = normalizeInput(n);
    if (key) NAME_TO_TOPOID[key] = topoId;
  });
});

export const TOTAL_COUNTRIES = COUNTRIES.length;

/** IDs that belong to a given continent (or all if "world") */
export function getContinentIds(continent: Continent | "world"): Set<string> {
  if (continent === "world") return new Set(COUNTRIES.map(c => c.topoId));
  return new Set(COUNTRIES.filter(c => c.continent === continent).map(c => c.topoId));
}
