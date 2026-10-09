import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { GAME_MODES } from "../../../shared/party-lab/modes";
import type { ChatMessage, LobbyPlayer } from "../network/types";
import { escapeOpensMenu } from "./arenaMenu";
import { CHAT_LAYOUT, CHAT_LEFT_COLOR, CHAT_WIDTH, chatLayoutVars, CHAT_LINES, CHAT_SHOW_MS, ChatArrivals, chatLines, nextFade, opensChat } from "./gameChat";

const msg = (id: string, playerId: string, text = id): ChatMessage => ({ id, playerId, nickname: `n-${playerId}`, text, sentAt: 0 });
const player = (id: string, slot: number, color: string): LobbyPlayer => ({
  id, nickname: `n-${id}`, connected: true, slot, color, costumeId: "cat", ready: false, participating: true,
});

test("arrivals: history present at join is old; later messages are timed when first seen", () => {
  const arrivals = new ChatArrivals();
  arrivals.observe([msg("1", "a"), msg("2", "b")], 1000);
  assert.equal(arrivals.at("1"), -Infinity);
  assert.equal(arrivals.at("2"), -Infinity);
  arrivals.observe([msg("1", "a"), msg("2", "b"), msg("3", "a")], 2000);
  assert.equal(arrivals.at("3"), 2000);
  // Seen again later (every patch is a fresh list): the first time stays.
  arrivals.observe([msg("2", "b"), msg("3", "a"), msg("4", "b")], 5000);
  assert.equal(arrivals.at("3"), 2000);
  assert.equal(arrivals.at("4"), 5000);
  assert.equal(arrivals.at("1"), -Infinity, "dropped from the bounded history");
  // Joining: the code is known before the first state, so the history arrives after an
  // empty list. Until the state is synced nothing is primed, and that history stays old.
  const joining = new ChatArrivals();
  joining.observe([], 100, false);
  joining.observe([msg("old", "a")], 200, true);
  assert.equal(joining.at("old"), -Infinity);
  joining.observe([msg("old", "a"), msg("new", "b")], 300, true);
  assert.equal(joining.at("new"), 300);
  // An empty room at join: the first message after it is fresh.
  const empty = new ChatArrivals();
  empty.observe([], 0);
  empty.observe([msg("x", "a")], 10);
  assert.equal(empty.at("x"), 10);
});

test("lines: last five, sender's slot colour (a leaver's neutral), shown 8 s, all shown while open", () => {
  const players = [player("a", 0, "#f6c773"), player("b", 1, "#e985a2")];
  const messages = ["1", "2", "3", "4", "5", "6", "7"].map((id, i) => msg(id, i === 6 ? "gone" : i % 2 ? "b" : "a"));
  const at = new Map(messages.map((m, i) => [m.id, i * 1000]));
  const arrived = (id: string) => at.get(id) ?? -Infinity;
  const lines = chatLines(messages, players, "a", arrived, 10_500, false);
  assert.equal(lines.length, CHAT_LINES);
  assert.deepEqual(lines.map((l) => l.id), ["3", "4", "5", "6", "7"]);
  assert.deepEqual(lines.map((l) => l.color), ["#f6c773", "#e985a2", "#f6c773", "#e985a2", CHAT_LEFT_COLOR]);
  assert.deepEqual(lines.map((l) => l.self), [true, false, true, false, false]);
  // Arrived at 2,3,4,5,6 s; at 10.5 s the one older than 8 s has faded.
  assert.deepEqual(lines.map((l) => l.shown), [false, true, true, true, true]);
  assert.ok(chatLines(messages, players, "a", arrived, 6000 + CHAT_SHOW_MS, false).every((l) => !l.shown), "8 s after the last: all faded");
  assert.ok(chatLines(messages, players, "a", arrived, 60_000, true).every((l) => l.shown), "open: the recent lines come back");
  assert.ok(chatLines(messages, players, "a", () => -Infinity, 0, false).every((l) => !l.shown), "old history never pops up");
});

test("next fade: the soonest shown line; nothing while open or when all are faded", () => {
  const messages = [msg("1", "a"), msg("2", "a")];
  const at = (id: string) => (id === "1" ? 1000 : 4000);
  const lines = chatLines(messages, [], "a", at, 5000, false);
  assert.equal(nextFade(lines, at, 5000, false), 1000 + CHAT_SHOW_MS - 5000);
  assert.equal(nextFade(lines, at, 5000, true), null);
  const later = chatLines(messages, [], "a", at, 20_000, false);
  assert.equal(nextFade(later, at, 20_000, false), null);
});

test("Enter opens the chat only as a plain press outside controls", () => {
  const press = { key: "Enter", repeat: false, isComposing: false, ctrlKey: false, metaKey: false, altKey: false };
  assert.equal(opensChat(press, false), true);
  assert.equal(opensChat(press, true), false, "a focused button or field keeps its own Enter");
  assert.equal(opensChat({ ...press, repeat: true }, false), false);
  assert.equal(opensChat({ ...press, isComposing: true }, false), false);
  for (const mod of ["ctrlKey", "metaKey", "altKey"] as const) assert.equal(opensChat({ ...press, [mod]: true }, false), false);
  for (const key of [" ", "f", "w", "Escape", "Tab"]) assert.equal(opensChat({ ...press, key }, false), false);
});

test("Esc the chat handled (it closes the field) never opens the menu", () => {
  const esc = { key: "Escape", repeat: false, isComposing: false, defaultPrevented: false };
  assert.equal(escapeOpensMenu(esc), true);
  assert.equal(escapeOpensMenu({ ...esc, defaultPrevented: true }), false);
  assert.equal(escapeOpensMenu({ ...esc, repeat: true }), false);
  assert.equal(escapeOpensMenu({ ...esc, isComposing: true }), false);
  assert.equal(escapeOpensMenu({ ...esc, key: "Enter" }), false);
});

test("every mode and the board has its own chat placement on every screen class", () => {
  for (const place of [...GAME_MODES, "board_game" as const]) {
    const vars = chatLayoutVars(place);
    for (const screen of ["wide", "narrow", "short", "phone"] as const) {
      const bottom = parseFloat(vars[`--pl-chat-bottom-${screen}`]),
        width = parseFloat(vars[`--pl-chat-width-${screen}`]),
        left = parseFloat(vars[`--pl-chat-left-${screen}`]);
      assert.ok(bottom >= 16, `${place} ${screen}: bottom ${bottom}`);
      assert.ok(width >= 170 && width <= CHAT_WIDTH[screen], `${place} ${screen}: width ${width}`);
      assert.ok(left >= 16 && left + width <= 600, `${place} ${screen}: left ${left}`);
      assert.match(vars[`--pl-chat-lines-${screen}`], /^(visible|hidden)$/);
    }
  }
  // A short screen falls back to the narrow spot unless the arena gives its own.
  assert.equal(chatLayoutVars("rooftop_brawl")["--pl-chat-bottom-short"], `${CHAT_LAYOUT.rooftop_brawl.narrow.bottom}px`);
  assert.equal(chatLayoutVars("human_bowling")["--pl-chat-left-short"], "262px");
  // A quiet spot hides the closed lines at once; elsewhere lines come back after a passing HUD fades.
  assert.equal(chatLayoutVars("snowball_fight")["--pl-chat-lines-short"], "hidden");
  assert.equal(chatLayoutVars("snowball_fight")["--pl-chat-lines-wait-short"], "0s");
  assert.equal(chatLayoutVars("snowball_fight")["--pl-chat-lines-wait-wide"], "0.75s");
});

test("contract: every online arena stops its input while the chat is open", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const arenas = [
    ...readdirSync(dir).filter((f) => /^Online.*Arena\.tsx$/.test(f)),
    "board/OnlineBoardArena.tsx",
  ];
  assert.ok(arenas.length >= GAME_MODES.length, `found ${arenas.length} arenas`);
  for (const file of arenas) {
    const source = readFileSync(`${dir}${file}`, "utf8");
    if (!source.includes("useArenaMenu(")) continue;
    assert.match(source, /menu\.chatOpen/, `${file}: OR useArenaMenu().chatOpen into its input-off flag`);
  }
  // The online view switch: every mode has a branch (else it silently falls back to Rooftop).
  const view = readFileSync(`${dir}OnlineArena.tsx`, "utf8");
  for (const mode of GAME_MODES.filter((m) => m !== "rooftop_brawl")) assert.ok(view.includes(`"${mode}"`), mode);
});
