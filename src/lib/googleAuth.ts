import { Capacitor } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./supabase";

/**
 * Native-only "Google ile devam et" for the Capacitor app (Auth Phase 2B).
 *
 * Web keeps its own Supabase full-page OAuth redirect (auth.ts#signInWithGoogle)
 * and never touches this file. A native webview cannot do a full-page redirect,
 * so it follows the documented Capacitor + Supabase PKCE deep-link pattern:
 *
 *   1. signInWithOAuth({ provider:"google", skipBrowserRedirect:true }) builds
 *      the Google consent URL *without* navigating. With the client in PKCE mode
 *      (see supabase.ts, native branch) the code verifier is stashed in the
 *      webview's localStorage at this step.
 *   2. Open that URL in the in-app system browser (@capacitor/browser).
 *   3. Google redirects to com.kavakgames.torble://auth-callback?code=…, which
 *      iOS/Android route back into the app as a Capacitor "appUrlOpen" event.
 *   4. Exchange ?code= for a session via exchangeCodeForSession (it reads the
 *      stored verifier — same webview, same localStorage).
 *
 * The listeners are scoped to a single sign-in attempt: registered immediately
 * before the browser opens and removed the moment the flow settles (success,
 * user-cancel, or browser-dismissed), so there is never a lingering or duplicate
 * global listener and unrelated deep links (invite links) are left alone. The
 * @capacitor/* plugins are dynamically imported so they stay out of the web
 * bundle and only evaluate inside the native shell. See AuthModal (native
 * branch) for the only caller.
 */

export type GoogleSignInResult =
  | { status: "success"; user: User; session: Session | null }
  | { status: "cancelled" }
  | { status: "error"; message: string };

/** Custom-scheme callback. Must EXACTLY match a Supabase Auth "Redirect URLs"
 *  allow-list entry, the iOS CFBundleURLSchemes scheme and the Android
 *  intent-filter scheme/host. */
const REDIRECT_URL = "com.kavakgames.torble://auth-callback";

/** True only for our auth callback deep link; every other appUrlOpen (invite
 *  links, universal links) is ignored so we never hijack existing behavior. */
function isAuthCallbackUrl(url: string): boolean {
  return url.toLowerCase().startsWith(REDIRECT_URL);
}

export async function signInWithGoogleNative(): Promise<GoogleSignInResult> {
  // Browser-based OAuth is identical on iOS and Android; gate on native so the
  // web build can never reach the deep-link flow.
  if (!Capacitor.isNativePlatform()) {
    return {
      status: "error",
      message: "Google ile giriş yalnızca uygulamada kullanılabilir.",
    };
  }

  // 1. Build the provider URL without navigating the webview.
  let providerUrl = "";
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: REDIRECT_URL, skipBrowserRedirect: true },
    });
    if (error || !data?.url) {
      return { status: "error", message: "Google ile giriş başlatılamadı." };
    }
    providerUrl = data.url;
  } catch {
    return { status: "error", message: "Google ile giriş başlatılamadı." };
  }

  const { App } = await import("@capacitor/app");
  const { Browser } = await import("@capacitor/browser");

  // 2 + 3. Open the system browser and wait for either the deep-link callback
  // (auth finished) or the browser being dismissed with no callback (cancel).
  const callbackUrl = await new Promise<string | null>((resolve) => {
    let settled = false;
    let urlSub: PluginListenerHandle | undefined;
    let finishSub: PluginListenerHandle | undefined;

    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      urlSub?.remove();
      finishSub?.remove();
      resolve(value);
    };

    App.addListener("appUrlOpen", ({ url }) => {
      if (!isAuthCallbackUrl(url)) return; // leave unrelated deep links alone
      settle(url);
    }).then((h) => {
      urlSub = h;
      if (settled) h.remove(); // already settled before the handle resolved
    });

    // User tapped Done / swiped the browser away before authenticating.
    Browser.addListener("browserFinished", () => {
      // Grace window so a redirect that also dismisses the browser cannot beat
      // the appUrlOpen event and get misread as a cancel.
      setTimeout(() => settle(null), 150);
    }).then((h) => {
      finishSub = h;
      if (settled) h.remove();
    });

    Browser.open({ url: providerUrl }).catch(() => settle(null));
  });

  // Dismiss the in-app browser (no-op if the user already closed it).
  try {
    await Browser.close();
  } catch {
    /* already closed */
  }

  if (!callbackUrl) return { status: "cancelled" };

  // PKCE returns ?code=…; a denied consent returns ?error=access_denied.
  let code: string | null = null;
  let oauthError: string | null = null;
  try {
    const parsed = new URL(callbackUrl);
    code = parsed.searchParams.get("code");
    oauthError = parsed.searchParams.get("error");
  } catch {
    /* malformed callback url — fall through to the no-code error below */
  }

  if (oauthError) return { status: "cancelled" }; // user declined at Google
  if (!code) {
    return { status: "error", message: "Google ile giriş tamamlanamadı." };
  }

  // 4. Exchange the code for a session (reads the stored PKCE verifier).
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    return { status: "error", message: "Google ile giriş tamamlanamadı." };
  }

  return { status: "success", user: data.user, session: data.session };
}
