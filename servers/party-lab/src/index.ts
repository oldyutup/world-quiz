import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { invalidAllowlistEntries } from "./origin.js";
import { createPartyServer } from "./server.js";

if (existsSync(".env")) loadEnvFile(".env");
// Hosts such as Railway assign PORT; 2567 remains the local/LAN default.
const port = Number(process.env.PORT ?? 2567);
const host = process.env.HOST ?? "0.0.0.0";
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const origins = process.env.PARTY_LAB_ALLOWED_ORIGINS ?? "";
const invalid = invalidAllowlistEntries(origins);
if (invalid.length)
  throw new Error(`PARTY_LAB_ALLOWED_ORIGINS entries must be exact origins such as https://torble.com: ${invalid.join(", ")}`);
// Production rejects every browser origin without an allowlist; fail the deploy instead of running unusable.
if (process.env.NODE_ENV === "production" && !origins.trim())
  throw new Error("PARTY_LAB_ALLOWED_ORIGINS is required when NODE_ENV=production");
const { server } = createPartyServer();
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.gracefullyShutdown(false);
};
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
await server.listen(port, host);
console.log(`Party Lab authoritative server listening at ws://${host}:${port}`);
console.log(`Party Lab browser origins: ${origins.trim() ? origins.split(",").map((s) => s.trim()).filter(Boolean).join(", ") : "development same-host policy"}`);
