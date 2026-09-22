/** DEV follows the page host, including LAN IPs; explicit configuration always wins. */
export function serverEndpoint(
  override: string | undefined,
  dev: boolean,
  page: { hostname: string; protocol: string }
) {
  const endpoint =
    override ||
    (dev
      ? `${page.protocol === "https:" ? "wss" : "ws"}://${page.hostname}:2567`
      : "");
  if (!endpoint) throw new Error("SERVER_NOT_CONFIGURED");
  const url = new URL(endpoint);
  if (
    !["ws:", "wss:", "http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("SERVER_NOT_CONFIGURED");
  // A deployed HTTPS page cannot open ws:// or http:// (mixed content); require wss:// or https://.
  if (!dev && page.protocol === "https:" && !["wss:", "https:"].includes(url.protocol))
    throw new Error("SERVER_NOT_CONFIGURED");
  return endpoint;
}
