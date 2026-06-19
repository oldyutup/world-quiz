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
import {
  sanitizeUsernameInput as sanitizeAccountUsername,
  normalizeUsernameKey,
  validateUsername as validateAccountUsername,
} from "./username";

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
  /** True once the player has explicitly picked their own handle (onboarding
   *  modal, email-signup form, or a username change). False/missing → the
   *  blocking first-login NicknameModal is shown. Existing users were
   *  backfilled to true (see *_username_key_system.sql). */
  has_chosen_username?: boolean | null;
  /** Diagnostic origin of the current handle: 'signup' | 'onboarding' |
   *  'change' | 'legacy'. Never shown to the user. */
  username_source?: string | null;
};

// Oyun-içi MİSAFİR görünen-ad doğrulaması için (account username DEĞİL).
// Bkz. validateUsername / normalizeUsername aşağıda; bu kurallar (3-16,
// ASCII+Türkçe, nokta/tire yok) değiştirilmedi.
const USERNAME_REGEX = /^[a-z0-9_çğıöşü]{3,16}$/;

export const USERNAME_CHANGE_COST = 500;
export const USERNAME_CHANGE_COOLDOWN_DAYS = 14;

/** Minimum şifre uzunluğu (client tarafı). Supabase password policy daha katıysa
 *  updateUser/signUp hata döndürür ve o mesaj kullanıcıya yansıtılır. */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * Tüm e-posta tabanlı auth çağrıları için tek normalleştirme: baş/son boşlukları
 * kırp ve küçük harfe çevir. Aynı Google hesabının e-postası + sonradan
 * belirlenen şifreyle tutarlı giriş için giriş, kayıt, sıfırlama ve reauth
 * yollarının HEPSİ aynı kanonik formu kullanır.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * E-posta tabanlı auth yönlendirmeleri (kayıt onayı, şifre sıfırlama) için
 * kanonik origin. Production'da gerçek domaine gitmesi gerektiği ve KAYNAKTA
 * localhost/geçici URL hardcode edilmemesi için sıra:
 *   1. VITE_PUBLIC_SITE_URL (production'da .env ile verilir — native shell'de de
 *      doğru web domainine işaret eder, capacitor://localhost'a DEĞİL)
 *   2. window.location.origin (web dev + web prod için doğru çalışır)
 * Sondaki '/' tekilleştirilir.
 */
export function getAuthRedirectOrigin(): string {
  const fromEnv =
    (import.meta.env.VITE_PUBLIC_SITE_URL as string | undefined)?.trim() || "";
  const base =
    fromEnv ||
    (typeof window !== "undefined" ? window.location.origin : "");
  return base.replace(/\/+$/, "");
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
  // Send the sanitized DISPLAY (Türkçe + case preserved). The RPC strips '@',
  // trims, folds to the ASCII key for uniqueness and keeps the display as-is.
  const cleaned = sanitizeAccountUsername(rawUsername);
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
    email: normalizeEmail(email),
    password,
    options: {
      emailRedirectTo: `${getAuthRedirectOrigin()}/`,
      data: {
        username,
      },
    },
  });
}

export async function signInWithEmail(email: string, password: string) {
  return supabase.auth.signInWithPassword({
    email: normalizeEmail(email),
    password,
  });
}

export async function signInWithGoogle() {
  return supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: getAuthRedirectOrigin(),
    },
  });
}

/**
 * Web/desktop "Apple ile devam et" — tam-sayfa Supabase OAuth redirect'i.
 * Yalnız web içindir; native iOS'ta saf ASAuthorization akışı kullanılır
 * (lib/appleAuth.ts#signInWithApple, ayrı bırakıldı). Google web akışıyla
 * birebir aynı redirect mantığını (getAuthRedirectOrigin) paylaşır; dönüşte
 * session loadOrCreateProfile + NicknameModal yoluna düşer (App.tsx auth
 * listener + loadAuth). Supabase Apple provider'ında Web Services ID
 * (com.kavakgames.torble.web) ve redirect URL'leri yapılandırılmış olmalı.
 */
export async function signInWithAppleWeb() {
  return supabase.auth.signInWithOAuth({
    provider: "apple",
    options: {
      redirectTo: getAuthRedirectOrigin(),
    },
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   Şifre yönetimi — TAMAMEN Supabase Auth üzerinden. Şifre hiçbir zaman
   profiles tablosunda, localStorage'da, uygulama state'inde veya ayrı bir DB
   kolonunda tutulmaz. Client'ta service-role key YOKTUR.
   ────────────────────────────────────────────────────────────────────────── */

/**
 * "Şifremi unuttum" — kayıtlı e-postaya şifre yenileme bağlantısı gönderir.
 * Çağıran HER ZAMAN aynı genel başarı mesajını göstermeli (kullanıcı/sağlayıcı
 * enumeration'ı önlemek için hata da başarı gibi ele alınır). redirectTo, e-posta
 * linki açıldığında PASSWORD_RECOVERY akışını tetikleyen kanonik web origin'idir.
 */
export async function requestPasswordReset(email: string) {
  return supabase.auth.resetPasswordForEmail(normalizeEmail(email), {
    redirectTo: `${getAuthRedirectOrigin()}/`,
  });
}

/**
 * Aktif oturumdaki kullanıcının şifresini günceller/belirler (Supabase Auth).
 * Üç yerde kullanılır: onboarding (Google ilk kayıt), profil "Şifre belirle"
 * (Google-only) ve profil "Şifreyi değiştir" (reauth sonrası). Yeni auth user
 * oluşturmaz; aynı hesaba (OAuth bağlantısı, profil, Gold, XP korunur) şifre
 * ekler/değiştirir.
 *
 * `currentPassword` verilirse `current_password` olarak iletilir: bu alan YALNIZ
 * sunucuda GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD açıkken
 * dikkate alınır (varsayılan KAPALI; o durumda yok sayılır). Bu yüzden mevcut
 * şifre doğrulaması tek başına buna BIRAKILMAZ; çağıran ayrıca güvenli reauth
 * (verifyCurrentPassword) yapar. Bu parametre, ileride o bayrak açılırsa şifre
 * değişiminin yine çalışması için ileri-uyumluluk sağlar.
 */
export async function updatePassword(newPassword: string, currentPassword?: string) {
  // `current_password` DOĞRUDAN (spread değil) property olarak veriliyor ki
  // TypeScript anahtar adını SDK'nın UserAttributes tipine göre doğrulasın:
  // kurulu @supabase/auth-js 2.105.1 snake_case `current_password` bekler
  // (`currentPassword` DEĞİL); spread, excess-property kontrolünü atlatır ve
  // yanlış ad sessizce geçerdi. currentPassword undefined ise anahtar JSON
  // serializasyonunda düşer; set/recovery/onboarding yollarında fazladan alan
  // gönderilmez. Cast/any YOK.
  return supabase.auth.updateUser({
    password: newPassword,
    current_password: currentPassword,
  });
}

/**
 * Mevcut şifreyi doğrular (reauthentication). Şifre değiştirmeden ÖNCE mevcut
 * şifreyi güvenli biçimde teyit etmek için kullanılır: aynı kullanıcı için
 * signInWithPassword çağrılır — doğruysa aynı kullanıcının oturumu tazelenir
 * (duplicate user/profil OLUŞMAZ), yanlışsa error döner. Şifre hiçbir yerde
 * saklanmaz; sadece bu çağrı boyunca bellekte kalır.
 */
export async function verifyCurrentPassword(email: string, currentPassword: string) {
  const { error } = await supabase.auth.signInWithPassword({
    email: normalizeEmail(email),
    password: currentPassword,
  });
  return { ok: !error, error };
}

/**
 * Aktif oturumdaki kullanıcının e-posta/şifre kimliğine sahip olup olmadığını
 * döndürür. Google-only kullanıcıda yalnız 'google' identity bulunur → false;
 * şifre belirlendikten (ya da e-posta kayıt) sonra 'email' identity oluşur → true.
 * "Şifre belirle" mi "Şifreyi değiştir" mi gösterileceğini seçmek için kullanılır.
 * Tespitte tereddüt halinde güvenli taraf: false (yeni şifre belirleme akışı).
 */
export async function getAccountAuthInfo(): Promise<{
  email: string | null;
  hasPassword: boolean;
}> {
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) return { email: null, hasPassword: false };
  const providers = new Set<string>();
  for (const idn of user.identities ?? []) {
    if (idn.provider) providers.add(idn.provider);
  }
  const metaProviders = (user.app_metadata?.providers as string[] | undefined) ?? [];
  for (const p of metaProviders) providers.add(p);
  return { email: user.email ?? null, hasPassword: providers.has("email") };
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
 * Username system: a *chosen* username comes only from the email/password
 * signup form (user_metadata.username, mirrored into geoquiz_pending_username).
 * Social logins (Apple / Google) — and web Google — carry NO chosen handle. We
 * never mint a public username from the email local-part, an Apple private-relay
 * address or provider metadata (web or native): if there is no chosen handle we
 * return null (no row created) and the caller shows the blocking NicknameModal,
 * which creates the row via setInitialUsername once a handle is picked. This is
 * what stops the old "email-derived nick" from ever being shown to the user.
 *
 * Existing users already have a profile row, so getProfile() returns it before
 * we get here — they never see the modal.
 */
export async function loadOrCreateProfile(
  user: {
    id: string;
    email?: string | null;
    user_metadata?: { username?: string | null } | null;
  }
): Promise<Profile | null> {
  const { data } = await getProfile(user.id);
  if (data) return data;

  // Explicitly chosen at signup (email/password). Social logins never set this.
  const chosenUsername =
    user.user_metadata?.username ||
    (typeof localStorage !== "undefined"
      ? localStorage.getItem("geoquiz_pending_username")
      : null);

  if (!chosenUsername) {
    // No handle was chosen (social login, web Google, or interrupted signup).
    // Create no row — the NicknameModal collects a username first.
    return null;
  }

  const { data: created } = await createProfile(user.id, chosenUsername, "signup");
  if (created) {
    try {
      localStorage.removeItem("geoquiz_pending_username");
    } catch {
      /* localStorage disabled — best effort */
    }
    return created;
  }

  // INSERT failed (concurrent winner or the chosen username failed validation).
  // Re-fetch so a row created by the racing path is still returned.
  const { data: refetched } = await getProfile(user.id);
  return refetched ?? null;
}

/**
 * Creates the profile row for a player who picked a handle at signup. Uses the
 * account-username system (Türkçe display preserved, ASCII-folded key for
 * uniqueness) so email signup follows the exact same rules as the NicknameModal
 * and the change-username panel. Sets has_chosen_username so the first-login
 * modal is not shown to a user who already chose a name on the signup form.
 * The DB trigger recomputes username_normalized = username_key(username), so the
 * value sent here is authoritative-by-trigger either way.
 */
export async function createProfile(
  userId: string,
  usernameRaw: string,
  source: string = "signup"
) {
  const display = sanitizeAccountUsername(usernameRaw);
  const validationError = validateAccountUsername(display);

  if (validationError) {
    return { data: null, error: { message: validationError } };
  }

  return supabase
    .from("profiles")
    .insert({
      id: userId,
      username: display,
      username_normalized: normalizeUsernameKey(display),
      has_chosen_username: true,
      username_source: source,
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
   First-login username (onboarding NicknameModal — web + native)
   ────────────────────────────────────────────────────────────────────────── */

export type SetInitialUsernameResult =
  | { data: Profile; error: null }
  | {
      data: null;
      error: { code: "validation" | "taken" | "network"; message: string };
    };

/** True for a Postgres unique-constraint violation surfaced by PostgREST. The
 *  case-insensitive index (profiles_username_normalized_uniq) trips this when
 *  the chosen handle's folded key is already taken. */
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
 * Sets a player's *first* public username from the onboarding NicknameModal.
 * Runs on both web and native, for anyone signed in without a chosen handle
 * (social login, web Google, or an interrupted signup).
 *
 * loadOrCreateProfile() returns null when no handle was chosen, so usually there
 * is no profile row yet:
 *   - no row → INSERT (the common case)
 *   - existing row with no chosen handle → UPDATE (interrupted prior signup)
 *
 * The display `username` is kept exactly as typed (Türkçe + case preserved);
 * uniqueness is enforced on the folded `username_normalized` key (the DB trigger
 * also recomputes it from the display), so "padır" and "padir" collide → mapped
 * to { code: "taken" }. Validation uses the shared account-username rules so a
 * handle minted here stays valid for later changes via the panel.
 */
export async function setInitialUsername(
  userId: string,
  usernameRaw: string
): Promise<SetInitialUsernameResult> {
  const display = sanitizeAccountUsername(usernameRaw);
  const validationError = validateAccountUsername(display);
  if (validationError) {
    return { data: null, error: { code: "validation", message: validationError } };
  }

  const row = {
    username: display,
    username_normalized: normalizeUsernameKey(display),
    has_chosen_username: true,
    username_source: "onboarding",
  };

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