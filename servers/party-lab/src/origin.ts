/** Browser origins are checked at matchmaking and WS upgrade. SDK tests have no Origin. */
export function allowedOrigin(
  origin: string | null | undefined,
  host: string | null | undefined,
  allowlist = process.env.PARTY_LAB_ALLOWED_ORIGINS ?? ""
) {
  if (!origin) return true; // Native/CLI SDKs still require valid Colyseus reservations/tokens.
  try {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin)
      return false;
    if (allowlist)
      return allowlist
        .split(",")
        .map((s) => s.trim())
        .includes(origin);
    if (process.env.NODE_ENV === "production") return false;
    const requestHost = new URL(`http://${host}`).hostname;
    const local = (name: string) =>
      name === "localhost" || name === "127.0.0.1" || name === "[::1]";
    return (
      (url.hostname === requestHost ||
        (local(url.hostname) && local(requestHost))) &&
      ["5173", "5174", "5175", "4173"].includes(url.port)
    );
  } catch {
    return false;
  }
}
