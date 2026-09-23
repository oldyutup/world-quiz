#!/usr/bin/env node
/**
 * Local bad-network proxy for Party Lab (development only, no dependencies).
 *
 *   node servers/party-lab/scripts/netem-proxy.mjs --listen 2600 --target 127.0.0.1:2567 --rtt 100 --jitter 30
 *   VITE_PARTY_LAB_SERVER_URL=ws://127.0.0.1:2600 npm run dev
 *
 * TCP-level, so matchmaking and the WebSocket share the same conditions. Each
 * direction is a FIFO: a chunk leaves after rtt/2 + random(0..jitter) ms but never
 * before the previous one, which is how TCP turns jitter into head-of-line bursts.
 *
 * Control (127.0.0.1 only):
 *   curl 'http://127.0.0.1:2601/set?rtt=150&jitter=40'
 *   curl 'http://127.0.0.1:2601/stall?ms=600'   hold both directions, then release in order
 *   curl 'http://127.0.0.1:2601/drop'           reset every proxied connection (brief disconnect)
 *   curl 'http://127.0.0.1:2601/status'
 */
import { createServer, connect } from "node:net";
import { createServer as createHttpServer } from "node:http";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, i, all) => {
    if (value.startsWith("--")) pairs.push([value.slice(2), all[i + 1]]);
    return pairs;
  }, [])
);
const listen = Number(args.listen ?? 2600);
const control = Number(args.control ?? listen + 1);
const [targetHost, targetPort] = (args.target ?? "127.0.0.1:2567").split(":");
const conditions = { rtt: Number(args.rtt ?? 0), jitter: Number(args.jitter ?? 0) };
let stallUntil = 0;
const sockets = new Set();

function lane(destination) {
  let last = 0;
  const queue = [];
  let timer = null;
  const flush = () => {
    timer = null;
    const now = Date.now();
    while (queue.length && queue[0].due <= now) {
      const { chunk } = queue.shift();
      if (!destination.destroyed) destination.write(chunk);
    }
    if (queue.length) timer = setTimeout(flush, Math.max(0, queue[0].due - Date.now()));
  };
  return (chunk) => {
    const now = Date.now();
    const due = Math.max(last, stallUntil, now + conditions.rtt / 2 + Math.random() * conditions.jitter);
    last = due;
    queue.push({ due, chunk });
    if (!timer) timer = setTimeout(flush, Math.max(0, queue[0].due - now));
  };
}

createServer((client) => {
  const upstream = connect(Number(targetPort), targetHost);
  client.setNoDelay(true);
  upstream.setNoDelay(true);
  sockets.add(client);
  sockets.add(upstream);
  const toServer = lane(upstream),
    toClient = lane(client);
  client.on("data", toServer);
  upstream.on("data", toClient);
  const close = () => {
    client.destroy();
    upstream.destroy();
    sockets.delete(client);
    sockets.delete(upstream);
  };
  client.on("error", close).on("close", close);
  upstream.on("error", close).on("close", close);
}).listen(listen, "127.0.0.1", () =>
  console.log(`netem proxy 127.0.0.1:${listen} → ${targetHost}:${targetPort}  rtt=${conditions.rtt} jitter=${conditions.jitter}  control http://127.0.0.1:${control}`)
);

createHttpServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/set") {
    for (const key of ["rtt", "jitter"])
      if (url.searchParams.has(key)) conditions[key] = Math.max(0, Number(url.searchParams.get(key)) || 0);
  } else if (url.pathname === "/stall") {
    stallUntil = Date.now() + Math.max(0, Number(url.searchParams.get("ms")) || 0);
  } else if (url.pathname === "/drop") {
    // A reset, not a FIN: the browser sees an abnormal close (1006) like a real network loss.
    for (const socket of sockets) socket.resetAndDestroy?.() ?? socket.destroy();
    sockets.clear();
  } else if (url.pathname !== "/status") {
    res.writeHead(404).end();
    return;
  }
  const status = { ...conditions, stallRemainingMs: Math.max(0, stallUntil - Date.now()), connections: sockets.size / 2 };
  console.log(`${url.pathname} → ${JSON.stringify(status)}`);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(status));
}).listen(control, "127.0.0.1");
