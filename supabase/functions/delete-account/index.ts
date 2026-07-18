import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// POST /functions/v1/delete-account
// Body: { appleAuthorizationCode?: string }
//
// App Store hesap silme uç noktası. Akış:
//   1. Authorization: Bearer <JWT> zorunlu — sunucu tarafında doğrulanır.
//      Hedef HER ZAMAN JWT sahibinin id'sidir; body'den user_id ALINMAZ.
//   2. Kullanıcının Apple identity'si varsa ve istemci taze bir
//      authorizationCode gönderdiyse Apple token revocation denenir
//      (best-effort: teknik hata silmeyi ENGELLEMEZ, sonuç yanıtla döner).
//   3. auth.admin.deleteUser(user.id, false) → hard delete. auth.users
//      silinirken public.profiles ON DELETE CASCADE ile silinir ve
//      profiles üzerindeki trg_account_deletion_cleanup BEFORE DELETE
//      trigger'ı FK'sız oyun verilerini AYNI transaction içinde
//      temizler/anonimleştirir. Trigger hatası → deleteUser hata döner ve
//      HİÇBİR veri değişmez (atomiklik DB tarafında).
//   4. Aynı istek tekrarlanırsa "user not found" idempotent başarı sayılır.
//
// GÜVENLİK MODELİ
// ---------------
// SUPABASE_SERVICE_ROLE_KEY yalnız bu fonksiyon ortamında yaşar ve iki iş
// için kullanılır: JWT'yi admin.auth.getUser ile doğrulamak ve doğrulanan
// kullanıcıyı silmek. İstemci girdisinden gelen HİÇBİR kimlik değeri hedef
// seçiminde kullanılmaz. Hassas değerler (JWT, Apple code/token/secret,
// private key, e-posta) ASLA loglanmaz — loglar yalnız jenerik hata
// etiketi + HTTP status taşır. CORS başlıkları tarayıcı kolaylığıdır,
// güvenlik sınırı değildir (disconnect/index.ts ile aynı model).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
} as const;

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

/* ── Apple token revocation (best-effort) ─────────────────────────────── */

type AppleRevocation =
  | "revoked"          // token exchange + revoke başarılı
  | "failed"           // teknik hata — silme yine de devam eder
  | "skipped_no_code"  // Apple identity var ama istemci code göndermedi
  | "skipped_config"   // Apple secret'ları eksik — manuel kurulum gerekiyor
  | "not_applicable";  // hesapta Apple identity yok

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

/** Apple client secret: ES256 imzalı, ≤6 ay ömürlü JWT (burada 5 dk yeter).
 *  Secrets dashboard'da tek satır saklanırken PEM gövdesindeki satır sonları
 *  "\n" kaçışına dönüşebilir — ikisi de kabul edilir. */
async function makeAppleClientSecret(
  teamId: string,
  keyId: string,
  clientId: string,
  privateKeyPem: string,
): Promise<string> {
  const pem = privateKeyPem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = {
    iss: teamId,
    iat: now,
    exp: now + 300,
    aud: "https://appleid.apple.com",
    sub: clientId,
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;

  // WebCrypto ECDSA çıktısı ham r||s (IEEE P1363) — JWS ES256'nın beklediği
  // format tam olarak bu; ekstra DER dönüşümü gerekmez.
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

async function revokeAppleTokens(authorizationCode: string): Promise<AppleRevocation> {
  const teamId = Deno.env.get("APPLE_TEAM_ID") ?? "";
  const keyId = Deno.env.get("APPLE_KEY_ID") ?? "";
  const clientId = Deno.env.get("APPLE_CLIENT_ID") ?? "";
  const privateKey = Deno.env.get("APPLE_PRIVATE_KEY") ?? "";

  if (!teamId || !keyId || !clientId || !privateKey) {
    console.error("[delete-account] apple revocation skipped: missing secrets");
    return "skipped_config";
  }

  try {
    const clientSecret = await makeAppleClientSecret(teamId, keyId, clientId, privateKey);

    // 1) authorizationCode → token exchange
    const tokenRes = await fetch("https://appleid.apple.com/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: authorizationCode,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      console.error(`[delete-account] apple token exchange failed: HTTP ${tokenRes.status}`);
      return "failed";
    }
    const tokens = (await tokenRes.json()) as {
      refresh_token?: string;
      access_token?: string;
    };
    const token = tokens.refresh_token ?? tokens.access_token ?? "";
    const tokenTypeHint = tokens.refresh_token ? "refresh_token" : "access_token";
    if (!token) {
      console.error("[delete-account] apple token exchange returned no token");
      return "failed";
    }

    // 2) revoke — 200 dönerse kullanıcının Apple yetkilendirmesi düşer.
    const revokeRes = await fetch("https://appleid.apple.com/auth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        token,
        token_type_hint: tokenTypeHint,
      }),
    });
    if (!revokeRes.ok) {
      console.error(`[delete-account] apple revoke failed: HTTP ${revokeRes.status}`);
      return "failed";
    }
    return "revoked";
  } catch (_err) {
    // Hata nesnesi token/secret parçası taşıyabilir — içeriğini loglama.
    console.error("[delete-account] apple revocation threw (details withheld)");
    return "failed";
  }
}

/* ── Handler ──────────────────────────────────────────────────────────── */

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!jwt) {
    return json({ error: "missing_authorization" }, 401);
  }

  // Body opsiyonel — yalnız appleAuthorizationCode okunur, başka hiçbir alan
  // (özellikle bir user_id) dikkate alınmaz.
  let appleAuthorizationCode = "";
  try {
    const body = await req.json();
    if (typeof body?.appleAuthorizationCode === "string") {
      appleAuthorizationCode = body.appleAuthorizationCode;
    }
  } catch {
    /* boş body kabul */
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // 1) JWT sahibini sunucu tarafında çöz — hedef YALNIZ bu kullanıcıdır.
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const user = userData?.user;
  if (userErr || !user?.id) {
    return json({ error: "not_authorized" }, 401);
  }

  // 2) Apple revocation (best-effort, silmeyi asla bloklamaz).
  const hasAppleIdentity = (user.identities ?? []).some(
    (i) => i.provider === "apple",
  );
  let appleRevocation: AppleRevocation = "not_applicable";
  if (hasAppleIdentity) {
    appleRevocation = appleAuthorizationCode
      ? await revokeAppleTokens(appleAuthorizationCode)
      : "skipped_no_code";
  }

  // 3) Hard delete. profiles cascade + trg_account_deletion_cleanup aynı
  //    DB transaction'ında koşar; trigger hatası buradan hata döndürür ve
  //    hiçbir şey silinmez.
  const { error: delErr } = await admin.auth.admin.deleteUser(user.id, false);
  if (delErr) {
    const status = (delErr as { status?: number }).status;
    const msg = (delErr.message ?? "").toLowerCase();
    // İdempotent tekrar: kullanıcı zaten silinmiş → başarı.
    if (status === 404 || msg.includes("not found")) {
      return json({ ok: true, appleRevocation }, 200);
    }
    console.error(`[delete-account] deleteUser failed: HTTP ${status ?? "?"}`);
    return json({ error: "delete_failed" }, 500);
  }

  return json({ ok: true, appleRevocation }, 200);
});
