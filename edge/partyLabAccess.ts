/**
 * Party Lab private-test gate, executed by Vercel Routing Middleware (/middleware.ts).
 * Uses only Web APIs (Request, Response, crypto.subtle) so the same code runs in Vercel's
 * middleware runtime and in Node tests. Server-only: never import this from src/.
 *
 * /party-lab?access=<PARTY_LAB_ACCESS_SECRET> sets a signed, HttpOnly cookie scoped to
 * /party-lab and redirects to the same URL without `access`. The cookie carries an
 * expiry and an HMAC keyed by the secret, never the secret itself; rotating the secret
 * or changing PARTY_LAB_ACCESS_VERSION invalidates every issued cookie.
 */

export const ACCESS_COOKIE = "party_lab_access";
export const ACCESS_PARAM = "access";
export const ACCESS_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const COOKIE_PATH = "/party-lab";
// URL-safe so the invite link survives chat apps unchanged; long enough to be unguessable.
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const TOKEN_PATTERN = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/;
const PRIVATE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};
const BLOCKED_PAGE = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Torble</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; box-sizing: border-box; display: grid; place-items: center; padding: 24px; background: #f6f5f1; color: #1d1d1b; font: 17px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
@media (prefers-color-scheme: dark) { body { background: #121212; color: #ececec; } }
p { margin: 0; text-align: center; }
</style>
</head>
<body><p>Bu test şu anda davetle kullanılabilir.</p></body>
</html>
`;
const encoder = new TextEncoder();

export interface AccessSettings {
  secret: string | undefined;
  version: string | undefined;
}

/** Only the page URLs that mount Party Lab; its static assets under /party-lab/ pass through. */
export function isGatedPath(pathname: string) {
  return pathname === "/party-lab" || pathname === "/party-lab/";
}

/** Returns a response to send instead of the page, or undefined to serve the page. */
export async function partyLabGate(
  request: Request,
  settings: AccessSettings,
  now = Date.now()
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!isGatedPath(url.pathname)) return undefined;
  const secret = settings.secret?.trim() ?? "";
  if (!SECRET_PATTERN.test(secret)) {
    // Fail closed. The value itself is never logged.
    console.error("Party Lab gate: PARTY_LAB_ACCESS_SECRET is missing or invalid; access is closed.");
    return blocked(request, false);
  }
  const version = settings.version?.trim() || "1";
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const cookie = readCookie(request.headers.get("cookie"), ACCESS_COOKIE);
  const authorized = cookie !== undefined && (await validToken(key, version, cookie, now));
  if (url.searchParams.has(ACCESS_PARAM)) {
    if (await sameSecret(url.searchParams.get(ACCESS_PARAM) ?? "", secret))
      return redirectToPage(url, await issueToken(key, version, now));
    // Already admitted with a stale link: just drop the bad parameter.
    if (authorized) return redirectToPage(url);
    return blocked(request, cookie !== undefined);
  }
  return authorized ? undefined : blocked(request, cookie !== undefined);
}

function message(version: string, expires: number) {
  return encoder.encode(`party-lab-access|${version}|${expires}`);
}

async function issueToken(key: CryptoKey, version: string, now: number) {
  const expires = Math.floor(now / 1000) + ACCESS_MAX_AGE_SECONDS;
  const signature = await crypto.subtle.sign("HMAC", key, message(version, expires));
  return `${expires}.${base64url(new Uint8Array(signature))}`;
}

async function validToken(key: CryptoKey, version: string, token: string, now: number) {
  const match = TOKEN_PATTERN.exec(token);
  if (!match) return false;
  const expires = Number(match[1]);
  const seconds = Math.floor(now / 1000);
  if (expires <= seconds || expires > seconds + ACCESS_MAX_AGE_SECONDS) return false;
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify("HMAC", key, fromBase64url(match[2]), message(version, expires));
}

/** Compares fixed-length digests so timing does not depend on how much of the secret matched. */
async function sameSecret(provided: string, secret: string) {
  const [a, b] = await Promise.all(
    [provided, secret].map(async (value) =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))
    )
  );
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

function readCookie(header: string | null, name: string) {
  for (const part of header?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

function cookie(value: string, maxAge: number) {
  return `${ACCESS_COOKIE}=${value}; Path=${COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

/** Same page without `access`; every other parameter (for example room=ABC123) is kept. */
function redirectToPage(url: URL, token?: string) {
  const params = new URLSearchParams(url.search);
  params.delete(ACCESS_PARAM);
  const query = params.toString();
  const headers = new Headers({ ...PRIVATE_HEADERS, Location: `/party-lab${query ? `?${query}` : ""}` });
  if (token) headers.append("Set-Cookie", cookie(token, ACCESS_MAX_AGE_SECONDS));
  return new Response(null, { status: 303, headers });
}

function blocked(request: Request, clearCookie: boolean) {
  const headers = new Headers({ ...PRIVATE_HEADERS, "Content-Type": "text/html; charset=utf-8" });
  if (clearCookie) headers.append("Set-Cookie", cookie("", 0));
  return new Response(request.method === "HEAD" ? null : BLOCKED_PAGE, { status: 404, headers });
}

function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string) {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
