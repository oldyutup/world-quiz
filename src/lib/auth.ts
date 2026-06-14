import { Capacitor } from "@capacitor/core";
import { supabase } from "./supabase";
import {
  BANNED_USERNAME_WORDS,
} from "../data/bannedUsernames";
import { isValidAvatarId } from "../data/avatars";
import {
  isAchievementAvatarId,
  isAchievementAvatarUnlockedFor,
  getAchievementStats,
} from "./achievementStats";

export type Profile = {
  id: string;
  username: string | null;
  xp: number;
  level: number;
  gold: number;
  avatar_id: string | null;
  created_at: string;
  updated_at: string;
  username_changed_at?: string | null;
  username_change_count?: number | null;
};

const USERNAME_REGEX = /^[a-z0-9_çğıöşü]{3,16}$/;

// V1 strict username regex — kullanıcı adı değiştirme akışı için
// server-side regex ile birebir aynı: sadece a-z, 0-9, alt çizgi.
const USERNAME_V1_REGEX = /^[a-z0-9_]{3,16}$/;

export const USERNAME_CHANGE_COST = 500;
export const USERNAME_CHANGE_COOLDOWN_DAYS = 14;

// V1'de yasaklı sabit isim listesi. Server da aynı listeyi kontrol eder;
// burada client tarafında erken uyarı için tutuyoruz.
const USERNAME_RESERVED: ReadonlySet<string> = new Set([
  "admin",
  "administrator",
  "moderator",
  "mod",
  "system",
  "sistem",
  "torble",
  "bot",
  "npc",
  "test",
  "support",
  "destek",
  "official",
  "owner",
  "root",
  "staff",
  "null",
  "undefined",
  "geoquiz",
  "geo_quiz",
  "developer",
  "dev",
  "yetkili",
  "kurucu",
  "yonetici",
  "help",
  "helper",
]);

export function normalizeUsernameV1(raw: string): string {
  let v = (raw ?? "").trim();
  if (v.startsWith("@")) v = v.slice(1);
  return v.toLowerCase();
}

/**
 * Yeni kullanıcı adı değiştirme akışı için V1 client validation.
 * Server-side change_username RPC ile birebir aynı kuralları uygular;
 * UI'da canlı feedback için kullanılır. Asıl otorite RPC'dir.
 */
export function validateUsernameV1(raw: string): string | null {
  const v = normalizeUsernameV1(raw);

  if (v.length === 0) {
    return "Kullanıcı adı boş olamaz.";
  }
  if (v.length < 3) {
    return "Kullanıcı adı en az 3 karakter olmalı.";
  }
  if (v.length > 16) {
    return "Kullanıcı adı en fazla 16 karakter olabilir.";
  }
  if (!USERNAME_V1_REGEX.test(v)) {
    return "Sadece küçük harf (a-z), rakam ve alt çizgi (_) kullanılabilir.";
  }
  if (USERNAME_RESERVED.has(v)) {
    return "Bu kullanıcı adı kullanılamaz.";
  }

  const lowerBanned = BANNED_USERNAME_WORDS.some((w) => v.includes(w));
  if (lowerBanned) {
    return "Bu kullanıcı adı kullanılamaz.";
  }

  return null;
}

export type ChangeUsernameResult =
  | {
      ok: true;
      username: string;
      gold: number;
      was_first: boolean;
      cost: number;
    }
  | {
      ok: false;
      code: string;
      message: string;
      days_left?: number;
      cost?: number;
      gold?: number;
    };

/**
 * Server-side change_username RPC wrapper.
 * Client doğrudan profiles tablosunu UPDATE etmez — Gold düşmesi ve username
 * değiştirilmesi tek transaction içinde server'da yapılır.
 */
export async function callChangeUsername(
  rawUsername: string
): Promise<ChangeUsernameResult> {
  const cleaned = normalizeUsernameV1(rawUsername);
  const { data, error } = await supabase.rpc("change_username", {
    p_new_username: cleaned,
  });

  if (error) {
    return {
      ok: false,
      code: "network",
      message: error.message || "Bir hata oluştu, tekrar dene.",
    };
  }
  if (!data || typeof data !== "object") {
    return {
      ok: false,
      code: "bad_response",
      message: "Sunucu beklenmeyen bir cevap döndü.",
    };
  }
  return data as ChangeUsernameResult;
}


export function normalizeUsername(username: string) {
  return username.trim().toLocaleLowerCase("tr-TR");
}

export function validateUsername(usernameRaw: string): string | null {
  const username = normalizeUsername(usernameRaw);

  if (username.length < 3) {
    return "Kullanıcı adı en az 3 karakter olmalı.";
  }

  if (username.length > 16) {
    return "Kullanıcı adı en fazla 16 karakter olabilir.";
  }

  if (!USERNAME_REGEX.test(username)) {
    return "Sadece küçük harf, rakam, alt çizgi ve Türkçe karakter kullanabilirsin.";
  }

  const hasBannedWord = BANNED_USERNAME_WORDS.some((word) =>
    username.includes(word)
  );

  if (hasBannedWord) {
    return "Bu kullanıcı adı kullanılamaz.";
  }

  return null;
}

export async function signUpWithEmail(
  email: string,
  password: string,
  username: string
) {
  return supabase.auth.signUp({
    email: email.trim(),
    password,
    options: {
      emailRedirectTo: `${window.location.origin}/`,
      data: {
        username,
      },
    },
  });
}

export async function signInWithEmail(email: string, password: string) {
  return supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });
}

export async function signInWithGoogle() {
  return supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: window.location.origin,
    },
  });
}

export async function signOut() {
  return supabase.auth.signOut();
}

export async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser();
  return { user: data.user, error };
}

export async function getProfile(userId: string) {
  return supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle<Profile>();
}

/**
 * Loads the signed-in user's profile, creating one from auth metadata / email
 * on first login. Idempotent and race-safe: if two auth paths run this
 * concurrently for a brand-new user, one INSERT wins and the other loses the
 * primary-key (id) race, after which we re-fetch the winning row instead of
 * dropping the user to a null profile.
 *
 * Shared by the mount auth-load, the onAuthStateChange listener and the native
 * Apple sign-in handler so first-login profile creation behaves identically
 * regardless of entry point.
 *
 * Auth Phase 3: a *chosen* username comes only from the email/password signup
 * path (user_metadata.username, mirrored into geoquiz_pending_username). Social
 * login (Apple, later Google) carries no chosen handle, so on native we must
 * NOT mint a public username from the email local-part, an Apple private-relay
 * address or provider metadata — we return null (no row created) and the caller
 * shows the NicknameModal. On web the historical email-local-part/"oyuncu"
 * fallback is preserved byte-for-byte (the suppression branch is dead code
 * there), so existing web Google / legacy behavior is unchanged.
 */
export async function loadOrCreateProfile(
  user: {
    id: string;
    email?: string | null;
    user_metadata?: { username?: string | null } | null;
  },
  opts?: { allowDerivedUsername?: boolean }
): Promise<Profile | null> {
  const { data } = await getProfile(user.id);
  if (data) return data;

  // Explicitly chosen at signup (email/password). Social logins never set this.
  const chosenUsername =
    user.user_metadata?.username ||
    (typeof localStorage !== "undefined"
      ? localStorage.getItem("geoquiz_pending_username")
      : null);

  // Web keeps the legacy fallback; native social login suppresses it so the
  // player picks a handle via the NicknameModal instead of leaking their email.
  const allowDerived =
    opts?.allowDerivedUsername ?? !Capacitor.isNativePlatform();

  const pendingUsername =
    chosenUsername || (allowDerived ? user.email?.split("@")[0] || "oyuncu" : null);

  if (!pendingUsername) {
    // First-login social user on native — no row created yet. The NicknameModal
    // will create it (see setInitialUsername) once a username is picked.
    return null;
  }

  const { data: created } = await createProfile(user.id, pendingUsername);
  if (created) {
    try {
      localStorage.removeItem("geoquiz_pending_username");
    } catch {
      /* localStorage disabled — best effort */
    }
    return created;
  }

  // INSERT failed (concurrent winner or generated username failed validation).
  // Re-fetch so a row created by the racing path is still returned.
  const { data: refetched } = await getProfile(user.id);
  return refetched ?? null;
}

export async function createProfile(userId: string, usernameRaw: string) {
  const username = normalizeUsername(usernameRaw);
  const validationError = validateUsername(username);

  if (validationError) {
    return { data: null, error: { message: validationError } };
  }

  return supabase
    .from("profiles")
    .insert({
      id: userId,
      username,
    })
    .select("*")
    .single<Profile>();
}

export async function updateUsername(userId: string, usernameRaw: string) {
  const username = normalizeUsername(usernameRaw);
  const validationError = validateUsername(username);

  if (validationError) {
    return { data: null, error: { message: validationError } };
  }

  return supabase
    .from("profiles")
    .update({
      username,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId)
    .select("*")
    .single<Profile>();
}

/**
 * Updates the profile's built-in avatar (Avatar Phase 1A). Mirrors
 * updateUsername: client-side validation, single-column update, returns the
 * fresh row. `avatarId` must be a known curated avatar (see isValidAvatarId) or
 * null to reset to the default (no avatar). Only avatar_id + updated_at are
 * written — username, xp, level and gold are never touched. No RPC in this
 * phase; the format CHECK on profiles.avatar_id is the DB-side backstop.
 */
export async function updateAvatar(userId: string, avatarId: string | null) {
  if (avatarId !== null && !isValidAvatarId(avatarId)) {
    return { data: null, error: { message: "Geçersiz avatar." } };
  }

  // Achievement avatars are only selectable once their achievement is unlocked.
  // The picker already hides locked tiles; this is the persistence-layer backstop.
  if (
    avatarId !== null &&
    isAchievementAvatarId(avatarId) &&
    !isAchievementAvatarUnlockedFor(avatarId, getAchievementStats())
  ) {
    return { data: null, error: { message: "Bu avatar başarımla açılır." } };
  }

  return supabase
    .from("profiles")
    .update({
      avatar_id: avatarId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId)
    .select("*")
    .single<Profile>();
}

/* ──────────────────────────────────────────────────────────────────────────
   Auth Phase 3 — first-login username for native social sign-in
   ────────────────────────────────────────────────────────────────────────── */

export type SetInitialUsernameResult =
  | { data: Profile; error: null }
  | {
      data: null;
      error: { code: "validation" | "taken" | "network"; message: string };
    };

/** True for a Postgres unique-constraint violation surfaced by PostgREST. The
 *  case-insensitive index (profiles_username_normalized_uniq) trips this when
 *  the chosen handle is already taken. */
function isUniqueViolation(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const code = err.code ?? "";
  const msg = (err.message ?? "").toLowerCase();
  return (
    code === "23505" ||
    msg.includes("duplicate") ||
    msg.includes("unique") ||
    msg.includes("already exists")
  );
}

/**
 * Sets a social-login player's *first* public username (Auth Phase 3).
 *
 * loadOrCreateProfile() returns null on native for a chosen-username-less social
 * user, so usually there is no profile row yet:
 *   - no row   → INSERT (the common Apple case)
 *   - row with a blank/invalid username → UPDATE (interrupted prior signup)
 * Both write username_normalized so the case-insensitive unique index enforces
 * uniqueness; a collision is mapped to { code: "taken" } for a Turkish error.
 *
 * Validation uses the strict V1 rules (a-z0-9_), matching the change_username
 * RPC, so a handle minted here stays valid for later username changes. This is a
 * native-only path; it never touches the shared createProfile used by web email
 * signup, so web behavior is unchanged.
 */
export async function setInitialUsername(
  userId: string,
  usernameRaw: string
): Promise<SetInitialUsernameResult> {
  const username = normalizeUsernameV1(usernameRaw);
  const validationError = validateUsernameV1(username);
  if (validationError) {
    return { data: null, error: { code: "validation", message: validationError } };
  }

  // ascii lowercase — the V1 regex guarantees normalized === username here.
  const row = { username, username_normalized: username };

  const { data: existing } = await getProfile(userId);

  const { data, error } = existing
    ? await supabase
        .from("profiles")
        .update({ ...row, updated_at: new Date().toISOString() })
        .eq("id", userId)
        .select("*")
        .single<Profile>()
    : await supabase
        .from("profiles")
        .insert({ id: userId, ...row })
        .select("*")
        .single<Profile>();

  if (error) {
    if (isUniqueViolation(error)) {
      return {
        data: null,
        error: {
          code: "taken",
          message: "Bu kullanıcı adı zaten alınmış. Başka bir ad dene.",
        },
      };
    }
    return {
      data: null,
      error: {
        code: "network",
        message: error.message || "Bir hata oluştu, tekrar dene.",
      },
    };
  }

  if (!data) {
    return {
      data: null,
      error: { code: "network", message: "Profil oluşturulamadı, tekrar dene." },
    };
  }

  return { data, error: null };
}

// ascii-only, no reserved/banned stems — kept lowercase so the V1 regex passes.
const NICKNAME_STEMS = [
  "gezgin",
  "kasif",
  "pusula",
  "atlas",
  "rota",
  "kuzey",
  "patika",
  "seyyah",
  "kervan",
  "harita",
];

/**
 * A safe, validation-passing nickname suggestion (e.g. "gezgin742"). Never
 * derived from email or real name; guaranteed to satisfy validateUsernameV1 so
 * it can be offered as a one-tap default in the NicknameModal.
 */
export function suggestNickname(): string {
  for (let i = 0; i < 16; i += 1) {
    const stem = NICKNAME_STEMS[Math.floor(Math.random() * NICKNAME_STEMS.length)];
    const num = Math.floor(100 + Math.random() * 9900); // 100–9999
    const candidate = `${stem}${num}`;
    if (candidate.length <= 16 && validateUsernameV1(candidate) === null) {
      return candidate;
    }
  }
  return `gezgin${Math.floor(1000 + Math.random() * 9000)}`;
}