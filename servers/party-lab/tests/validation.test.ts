import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_MAX_LENGTH, ChatLimiter, chatText, nickname } from "../src/validation.js";

test("nicknames normalize Unicode and are display data, not identifiers", () => {
  assert.equal(nickname("  Çağrı_2  "), "Çağrı_2");
  assert.equal(nickname("I\u0307rem"), "İrem");
  for (const name of [null, {}, 123, "ab", "x".repeat(17), "a b", "<b>", "abc\u200B"]) {
    assert.throws(() => nickname(name), /INVALID_NICKNAME/);
  }
});
test("chat is bounded plain text, with no empty, non-text, or control-character messages", () => {
  assert.equal(chatText("  selam\ndünya  "), "selam dünya");
  assert.equal(chatText("<b>selam</b>"), "<b>selam</b>");
  assert.equal(chatText("a".repeat(CHAT_MAX_LENGTH)).length, CHAT_MAX_LENGTH);
  for (const value of [null, {}, ["hi"], " ", "a".repeat(CHAT_MAX_LENGTH + 1), "abc\u0000", "abc\u202E"]) {
    assert.throws(() => chatText(value), /INVALID_CHAT/);
  }
});
test("chat rate limit is four attempts per five seconds with a bounded sliding window", () => {
  const limiter = new ChatLimiter();
  for (let i = 0; i < 4; i++) assert.equal(limiter.take(i * 100), true);
  for (let i = 0; i < 100; i++) assert.equal(limiter.take(4999), false);
  assert.equal(limiter.take(5000), true);
  assert.equal(limiter.take(5000), false);
  assert.equal(limiter.take(5100), true);
});
