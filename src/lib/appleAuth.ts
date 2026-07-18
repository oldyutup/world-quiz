import { Capacitor } from "@capacitor/core";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./supabase";

/**
 * Native-only "Sign in with Apple" for the Capacitor iOS app.
 *
 * Flow (no browser OAuth redirect — pure native ASAuthorization):
 *   1. Generate a random raw nonce.
 *   2. Hand Apple the SHA-256 *hash* of that nonce; Apple embeds the hash in the
 *      returned identity token's `nonce` claim as-is.
 *   3. Exchange the identity token for a Supabase session via
 *      signInWithIdToken({ provider: "apple", ... }), passing the *raw* nonce —
 *      Supabase re-hashes it with SHA-256 and compares against the token claim.
 *
 * The @capacitor-community/apple-sign-in plugin is dynamically imported so it
 * never lands in the main web bundle and is only evaluated inside the native
 * shell. Web callers get a friendly "native only" error and never reach the
 * plugin. See AuthModal (native branch) for the only caller.
 */

export type AppleSignInResult =
  | { status: "success"; user: User; session: Session | null }
  | { status: "cancelled" }
  | { status: "error"; message: string };

/** App bundle id — this is the audience (`aud`) of the native identity token,
 *  so Supabase's Apple provider must list it as an authorized client id. */
const APPLE_CLIENT_ID = "com.kavakgames.torble";

function generateRawNonce(length = 32): string {
  const charset =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i += 1) out += charset[bytes[i] % charset.length];
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** True when the rejection is the user backing out of the Apple sheet rather
 *  than a real failure. ASAuthorizationError.canceled === 1001; the native
 *  bridge surfaces the NSError's localizedDescription which contains that code
 *  (and "cancel" on some OS versions). Treated as a silent no-op upstream. */
function isUserCancellation(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  return msg.includes("1001") || msg.includes("cancel");
}

export async function signInWithApple(): Promise<AppleSignInResult> {
  // Hard iOS gate. Phase 2A wires native Apple sign-in for iOS only; "ios" also
  // excludes web ("web") and Android, neither of which is configured here.
  if (Capacitor.getPlatform() !== "ios") {
    return {
      status: "error",
      message: "Apple ile giriş yalnızca iOS uygulamasında kullanılabilir.",
    };
  }

  let identityToken = "";
  let rawNonce = "";

  try {
    const { SignInWithApple } = await import(
      "@capacitor-community/apple-sign-in"
    );

    rawNonce = generateRawNonce();
    const hashedNonce = await sha256Hex(rawNonce);

    const result = await SignInWithApple.authorize({
      clientId: APPLE_CLIENT_ID,
      // Ignored by the native iOS flow but required by the typed options.
      redirectURI: "https://torble.app/auth/callback",
      scopes: "name email",
      nonce: hashedNonce,
    });

    identityToken = result.response?.identityToken ?? "";
    if (!identityToken) {
      return { status: "error", message: "Apple kimlik doğrulaması alınamadı." };
    }
  } catch (err) {
    if (isUserCancellation(err)) return { status: "cancelled" };
    return { status: "error", message: "Apple ile giriş tamamlanamadı." };
  }

  const { data, error } = await supabase.auth.signInWithIdToken({
    provider: "apple",
    token: identityToken,
    nonce: rawNonce,
  });

  if (error || !data.user) {
    return {
      status: "error",
      message: error?.message || "Apple ile giriş tamamlanamadı.",
    };
  }

  return { status: "success", user: data.user, session: data.session };
}

/* ── Hesap silme: taze authorizationCode ─────────────────────────────────
 * Apple'ın hesap silme beklentisi (5.1.1(v)): silme anında token revocation
 * denenmeli. Revocation, Apple sheet'ten alınan TAZE authorizationCode'un
 * sunucuda (delete-account Edge Function) token'a çevrilip revoke
 * edilmesiyle yapılır. Bu fonksiyon YALNIZ code toplar — Supabase oturumuna
 * dokunmaz (signInWithIdToken ÇAĞRILMAZ; kullanıcı zaten oturumda).
 * Kullanıcının sheet'i iptal etmesi "cancelled" döner ve silme akışı hiç
 * başlatılmaz; teknik hata ise "error" döner — silme hakkını engellemez,
 * revocation sunucu tarafında atlanmış olur. */

export type AppleDeletionAuthResult =
  | { status: "success"; authorizationCode: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export async function requestAppleAuthorizationForDeletion(): Promise<AppleDeletionAuthResult> {
  if (Capacitor.getPlatform() !== "ios") {
    return {
      status: "error",
      message: "Apple yetkilendirmesi yalnızca iOS uygulamasında alınabilir.",
    };
  }

  try {
    const { SignInWithApple } = await import(
      "@capacitor-community/apple-sign-in"
    );

    const rawNonce = generateRawNonce();
    const hashedNonce = await sha256Hex(rawNonce);

    const result = await SignInWithApple.authorize({
      clientId: APPLE_CLIENT_ID,
      redirectURI: "https://torble.app/auth/callback",
      scopes: "name email",
      nonce: hashedNonce,
    });

    const authorizationCode = result.response?.authorizationCode ?? "";
    if (!authorizationCode) {
      return { status: "error", message: "Apple yetkilendirme kodu alınamadı." };
    }
    return { status: "success", authorizationCode };
  } catch (err) {
    if (isUserCancellation(err)) return { status: "cancelled" };
    return { status: "error", message: "Apple yetkilendirmesi tamamlanamadı." };
  }
}
