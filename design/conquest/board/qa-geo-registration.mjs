/**
 * SUPERSEDED — see qa-geo-registration.ts (run: npx tsx design/conquest/board/qa-geo-registration.ts).
 *
 * Phase 2 moved the geo-context to a shared builder (conquestGeoContextMarkup.ts)
 * that both the runtime component and the harness import, so the harness must run
 * via tsx to import it.  This .mjs (Phase-1 flat hand-built SVG) is kept only as a
 * redirect and intentionally does nothing.
 */
console.log("This harness is superseded. Run:\n  npx tsx design/conquest/board/qa-geo-registration.ts");
process.exit(0);
