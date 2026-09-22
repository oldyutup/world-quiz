// Explicit .js: Vercel emits this file unbundled for the Node.js runtime, where ESM needs extensions.
import { partyLabGate } from "./edge/partyLabAccess.js";

// Vercel Routing Middleware. The matcher limits it to the private Party Lab page;
// every other Torble route never invokes it. Delete this file to make /party-lab public.
export const config = {
  matcher: ["/party-lab", "/party-lab/"],
  runtime: "nodejs",
};

export default function middleware(request: Request) {
  // Server-side environment only. Never expose these through a VITE_ variable.
  return partyLabGate(request, {
    secret: process.env.PARTY_LAB_ACCESS_SECRET,
    version: process.env.PARTY_LAB_ACCESS_VERSION,
  });
}
