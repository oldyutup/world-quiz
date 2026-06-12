/**
 * reportValidation — Kör Nokta rapor doğrulama V1 (client tarafı).
 *
 * Server-side validasyon migration'daki tevatur_kn_submit_report /
 * tevatur_kn_text_has_banned ile yapılır; buradaki kontroller kullanıcıya
 * submit'ten ÖNCE hızlı geri bildirim içindir ve server kuralının aynası +
 * iki ek katmandır (sessiz-harf iskeleti, küfür mini listesi). Client server
 * kuralından DAHA SIKI olabilir; daha gevşek olamaz.
 *
 * Uyarı metinleri yakalanan kelimeyi birebir söylemez (spec §6).
 */

export function normalizeReportText(input: string): string {
  return input
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/i̇/g, "i") // "İ".toLowerCase() → i + birleşik nokta
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/â/g, "a")
    .replace(/î/g, "i")
    .replace(/û/g, "u")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactReportText(input: string): string {
  return normalizeReportText(input).replace(/\s+/g, "");
}

/** "t r k" → "trk": ardışık tek-harf token'larını birleştirir. */
function mergeSingleLetterRuns(normalized: string): string {
  const tokens = normalized.split(" ");
  const out: string[] = [];
  let run = "";
  for (const t of tokens) {
    if (t.length === 1) {
      run += t;
      continue;
    }
    if (run) {
      out.push(run);
      run = "";
    }
    out.push(t);
  }
  if (run) out.push(run);
  return out.join(" ");
}

/** Sesli harfleri atılmış iskelet: "turkiye" → "trky". "trky" gibi
 *  sesli-harfsiz kaçakları yakalamak için kullanılır. */
function consonantSkeleton(compact: string): string {
  return compact.replace(/[aeiou]/g, "");
}

/**
 * Yasaklı kelime eşleşmesi (server kuralının aynası + iskelet kontrolü):
 *   • 4+ karakter: compact metinde substring.
 *   • 2–3 karakter: token eşitliği ya da compact tam eşitlik
 *     (tek-harf birleştirme dahil: "t r", "t-r" → "tr").
 *   • Ek (yalnız client): 5+ karakterli yasaklının sessiz-harf iskeleti
 *     (≥3 harf) herhangi bir token iskeletine eşitse → "trky", "turky".
 */
export function reportHasBannedWord(text: string, bannedWords: readonly string[]): boolean {
  const norm = normalizeReportText(text);
  if (!norm) return false;
  const compact = norm.replace(/\s+/g, "");
  const merged = mergeSingleLetterRuns(norm);
  const tokens = new Set([...norm.split(" "), ...merged.split(" ")]);

  for (const raw of bannedWords) {
    const cword = compactReportText(raw);
    if (!cword) continue;

    if (cword.length >= 4) {
      if (compact.includes(cword)) return true;
    } else if (compact === cword || tokens.has(cword)) {
      return true;
    }

    if (cword.length >= 5) {
      const skeleton = consonantSkeleton(cword);
      if (skeleton.length >= 3) {
        for (const t of tokens) {
          if (t.length >= 3 && consonantSkeleton(t) === skeleton) return true;
        }
      }
    }
  }
  return false;
}

/** Küfür/troll mini listesi — tam moderasyon değil (spec §17), kaba filtre.
 *  Kısa olanlar token eşitliği, uzunlar compact substring ile aranır. */
const PROFANITY_WORDS = [
  "amk", "aq", "mk", "oc", "amq",
  "orospu", "piç", "pic", "yarrak", "siktir", "sikik", "amcik", "amcık",
  "gavat", "pezevenk", "ibne", "kahpe",
];

function reportHasProfanity(text: string): boolean {
  const norm = normalizeReportText(text);
  if (!norm) return false;
  const compact = norm.replace(/\s+/g, "");
  const tokens = new Set(mergeSingleLetterRuns(norm).split(" "));
  for (const raw of PROFANITY_WORDS) {
    const cword = compactReportText(raw);
    if (!cword) continue;
    if (cword.length >= 5) {
      if (compact.includes(cword)) return true;
    } else if (tokens.has(cword)) {
      return true;
    }
  }
  return false;
}

export const KN_REPORT_MIN_WORDS = 2;
export const KN_REPORT_MAX_WORDS = 5;
export const KN_REPORT_MAX_CHARS = 60;

export type ReportValidationError =
  | "word_count"
  | "too_long"
  | "banned"
  | "profanity";

export type ReportValidation =
  | { ok: true }
  | { ok: false; code: ReportValidationError; message: string };

export const REPORT_ERROR_MESSAGES: Record<ReportValidationError, string> = {
  word_count: "Rapor 2–5 kelime arasında olmalı.",
  too_long:   "Rapor çok uzun. Daha kısa tarif et.",
  banned:     "Raporun konumu fazla doğrudan ele veriyor. Daha genel tarif et.",
  profanity:  "Bu rapor kategorinin dışına çıkıyor gibi. Daha uygun bir tarif yaz.",
};

export function validateReport(
  raw: string,
  bannedWords: readonly string[],
): ReportValidation {
  const trimmed = raw.trim();
  if (trimmed.length > KN_REPORT_MAX_CHARS) {
    return { ok: false, code: "too_long", message: REPORT_ERROR_MESSAGES.too_long };
  }

  const norm = normalizeReportText(trimmed);
  const wordCount = norm ? norm.split(" ").length : 0;
  if (wordCount < KN_REPORT_MIN_WORDS || wordCount > KN_REPORT_MAX_WORDS) {
    return { ok: false, code: "word_count", message: REPORT_ERROR_MESSAGES.word_count };
  }

  if (reportHasBannedWord(trimmed, bannedWords)) {
    return { ok: false, code: "banned", message: REPORT_ERROR_MESSAGES.banned };
  }

  if (reportHasProfanity(trimmed)) {
    return { ok: false, code: "profanity", message: REPORT_ERROR_MESSAGES.profanity };
  }

  return { ok: true };
}
