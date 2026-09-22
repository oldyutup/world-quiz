import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NET } from '../../../shared/party-lab/network/protocol';
import { admissionOptions } from './admission';
import { lobbyError } from './client';

test('create and join admission send the protocol version and selected costume ID', () => {
  assert.deepEqual(admissionOptions('create', 'Enes', '', 'cat'), {
    protocol: NET.version, nickname: 'Enes', intent: 'create', costumeId: 'cat',
  });
  assert.deepEqual(admissionOptions('join', 'Ada', 'ABC234', 'anchovy'), {
    protocol: NET.version, nickname: 'Ada', intent: 'join', code: 'ABC234', costumeId: 'anchovy',
  });
});

test('a server protocol mismatch asks the player to reload instead of a generic rejection', () => {
  assert.match(lobbyError({ code: 400, message: 'PROTOCOL_MISMATCH' }), /yenile/);
});
