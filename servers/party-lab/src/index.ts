import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { createPartyServer } from "./server.js";

if (existsSync(".env")) loadEnvFile(".env");
const port = Number(process.env.PORT ?? 2567);
const host = process.env.HOST ?? "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
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
console.log(`Party Lab lobby listening at ws://${host}:${port}`);
