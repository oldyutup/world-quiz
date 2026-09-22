import assert from "node:assert/strict";
import { test } from "node:test";
import middleware, { config } from "../middleware";
import { ACCESS_COOKIE, ACCESS_MAX_AGE_SECONDS, partyLabGate, type AccessSettings } from "./partyLabAccess";

const SECRET = "3f9c1e7a5b2d4c6e8f0a1b3c5d7e9f11a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d1";
const settings: AccessSettings = { secret: SECRET, version: undefined };
const NOW = Date.UTC(2026, 8, 22);
const page = (path: string, cookie?: string, method = "GET") =>
  new Request(`https://torble.com${path}`, { method, headers: cookie ? { cookie } : {} });
const setCookie = (response: Response) => response.headers.get("set-cookie") ?? "";
const cookieValue = (response: Response) => /party_lab_access=([^;]*)/.exec(setCookie(response))?.[1] ?? "";

async function grant(path = `/party-lab?access=${SECRET}`, options = settings, now = NOW) {
  const response = await partyLabGate(page(path), options, now);
  assert.equal(response?.status, 303);
  return `${ACCESS_COOKIE}=${cookieValue(response!)}`;
}

async function assertBlocked(response: Response | undefined) {
  assert.ok(response);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(response.headers.get("location"), null);
  assert.match(await response.text(), /Bu test şu anda davetle kullanılabilir\./);
}

test("unauthorized and wrong-secret visits are blocked with a private 404", async () => {
  for (const path of ["/party-lab", "/party-lab/", "/party-lab?room=ABC123", "/party-lab?access=wrong", "/party-lab?access=", `/party-lab?access=${SECRET.slice(0, -1)}`, `/party-lab?access=${SECRET}x`, `/party-lab?access=${SECRET.toUpperCase()}`]) {
    const response = await partyLabGate(page(path), settings, NOW);
    await assertBlocked(response);
    assert.equal(setCookie(response!), "", path);
  }
});

test("the correct secret grants a scoped signed cookie and redirects to the clean URL", async () => {
  const response = (await partyLabGate(page(`/party-lab?access=${SECRET}`), settings, NOW))!;
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/party-lab");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const header = setCookie(response);
  for (const attribute of ["Path=/party-lab", `Max-Age=${ACCESS_MAX_AGE_SECONDS}`, "HttpOnly", "Secure", "SameSite=Lax"])
    assert.ok(header.includes(attribute), attribute);
  assert.ok(!header.includes("Domain="), "host-only cookie");
  assert.ok(!header.includes(SECRET), "cookie never carries the secret");
  assert.match(cookieValue(response), /^\d+\.[A-Za-z0-9_-]{43}$/);
});

test("room and other parameters survive authorization; only access is removed", async () => {
  const cases: Array<[string, string]> = [
    [`/party-lab?room=ABC123&access=${SECRET}`, "/party-lab?room=ABC123"],
    [`/party-lab?access=${SECRET}&room=ABC123`, "/party-lab?room=ABC123"],
    [`/party-lab/?room=ABC123&access=${SECRET}&partyDebug`, "/party-lab?room=ABC123&partyDebug="],
  ];
  for (const [path, location] of cases) {
    const response = await partyLabGate(page(path), settings, NOW);
    assert.equal(response?.status, 303, path);
    assert.equal(response?.headers.get("location"), location, path);
  }
});

test("an authorized browser opens clean Party Lab URLs and room invites directly", async () => {
  const cookie = await grant();
  for (const path of ["/party-lab", "/party-lab/", "/party-lab?room=ABC123"])
    assert.equal(await partyLabGate(page(path, cookie), settings, NOW), undefined, path);
  assert.equal(await partyLabGate(page("/party-lab", `theme=dark; ${cookie}; other=1`), settings, NOW), undefined);
  // Still valid just before expiry, rejected afterwards.
  const almost = NOW + (ACCESS_MAX_AGE_SECONDS - 60) * 1000;
  assert.equal(await partyLabGate(page("/party-lab", cookie), settings, almost), undefined);
  await assertBlocked(await partyLabGate(page("/party-lab", cookie), settings, NOW + (ACCESS_MAX_AGE_SECONDS + 1) * 1000));
});

test("an authorized browser with a stale access link is redirected without a new grant", async () => {
  const cookie = await grant();
  const response = await partyLabGate(page("/party-lab?room=ABC123&access=old-link", cookie), settings, NOW);
  assert.equal(response?.status, 303);
  assert.equal(response?.headers.get("location"), "/party-lab?room=ABC123");
  assert.equal(setCookie(response!), "");
});

test("tampered, forged or malformed cookies are rejected and cleared", async () => {
  const cookie = await grant();
  const [expires, signature] = cookie.split("=")[1].split(".");
  const forged = [
    `${ACCESS_COOKIE}=${Number(expires) + 60}.${signature}`,
    `${ACCESS_COOKIE}=${expires}.${signature.slice(0, 10)}${signature[10] === "A" ? "B" : "A"}${signature.slice(11)}`,
    `${ACCESS_COOKIE}=${SECRET}`,
    `${ACCESS_COOKIE}=1`,
    `${ACCESS_COOKIE}=`,
    `${ACCESS_COOKIE}=${String(10 ** 11)}.${signature}`,
  ];
  for (const value of forged) {
    const response = await partyLabGate(page("/party-lab", value), settings, NOW);
    await assertBlocked(response);
    assert.match(setCookie(response!), /party_lab_access=; Path=\/party-lab; Max-Age=0/, value);
  }
});

test("rotating the secret or bumping the access version revokes every issued cookie", async () => {
  const cookie = await grant();
  const rotated = { secret: SECRET.replace(/^3/, "4"), version: undefined };
  await assertBlocked(await partyLabGate(page("/party-lab", cookie), rotated, NOW));
  await assertBlocked(await partyLabGate(page(`/party-lab?access=${SECRET}`), rotated, NOW));
  const bumped = { secret: SECRET, version: "2" };
  await assertBlocked(await partyLabGate(page("/party-lab", cookie), bumped, NOW));
  // The same invite link still works under the new version and issues a new-version cookie.
  const renewed = await grant(`/party-lab?access=${SECRET}`, bumped);
  assert.equal(await partyLabGate(page("/party-lab", renewed), bumped, NOW), undefined);
  await assertBlocked(await partyLabGate(page("/party-lab", renewed), settings, NOW));
  // An explicit "1" is the default version.
  assert.equal(await partyLabGate(page("/party-lab", cookie), { secret: SECRET, version: "1" }, NOW), undefined);
});

test("a missing or weak secret closes access instead of opening it", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    for (const secret of [undefined, "", "   ", "short", "has spaces but is definitely longer than 32", "a+b/c=".repeat(8)]) {
      const options = { secret, version: undefined };
      await assertBlocked(await partyLabGate(page(`/party-lab?access=${secret ?? ""}`), options, NOW));
      await assertBlocked(await partyLabGate(page("/party-lab"), options, NOW));
    }
  } finally {
    console.error = original;
  }
});

test("non-page paths pass through; HEAD responses are empty", async () => {
  for (const path of ["/", "/party-lab/audio/fall-cat.wav", "/party-lab/maps/rooftop/kit.glb", "/party-labs", "/tr/privacy"])
    assert.equal(await partyLabGate(page(path), settings, NOW), undefined, path);
  const head = await partyLabGate(page("/party-lab", undefined, "HEAD"), settings, NOW);
  assert.equal(head?.status, 404);
  assert.equal(await head?.text(), "");
});

test("the deployed middleware reads only server-side env and matches only the page", async () => {
  assert.deepEqual(config.matcher, ["/party-lab", "/party-lab/"]);
  const previous = { ...process.env };
  try {
    process.env.PARTY_LAB_ACCESS_SECRET = SECRET;
    delete process.env.PARTY_LAB_ACCESS_VERSION;
    const response = await middleware(page(`/party-lab?room=ABC123&access=${SECRET}`));
    assert.equal(response?.status, 303);
    assert.equal(response?.headers.get("location"), "/party-lab?room=ABC123");
    const cookie = `${ACCESS_COOKIE}=${cookieValue(response!)}`;
    assert.equal(await middleware(page("/party-lab?room=ABC123", cookie)), undefined);
    await assertBlocked(await middleware(page("/party-lab")));
  } finally {
    process.env = previous;
  }
});
