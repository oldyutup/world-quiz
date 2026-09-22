import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRoomCode, ROOM_ALPHABET, RoomCodes } from "../src/roomCodes.js";

test("codes are six unambiguous characters and live codes never repeat", () => {
  const codes = new RoomCodes();
  const generated = new Set(Array.from({ length: 2000 }, () => codes.claim()));
  assert.equal(generated.size, 2000);
  for (const code of generated) {
    assert.equal(code.length, 6);
    assert.ok([...code].every(letter => ROOM_ALPHABET.includes(letter)));
  }
});
test("normalization accepts lowercase and outer whitespace, rejects malformed codes", () => {
  assert.equal(normalizeRoomCode(" abC234 "), "ABC234");
  for (const code of [null, {}, "", "ABCDE", "ABCDEFG", "ABC123", "ABC0OO", "AB C23", "ＡBC234"]) {
    assert.throws(() => normalizeRoomCode(code), /INVALID_CODE/);
  }
});
test("collisions cannot overwrite a live code; disposal releases it", () => {
  const codes = new RoomCodes(() => 0);
  assert.equal(codes.claim(), "AAAAAA");
  assert.throws(() => codes.claim(), /ROOM_CODE_EXHAUSTED/);
  codes.release("AAAAAA");
  assert.equal(codes.claim(), "AAAAAA");
});
